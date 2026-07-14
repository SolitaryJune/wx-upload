(() => {
  'use strict';

  const HTTP_522_STATUS = 522;
  const HTTP_522_RETRY_BASE_DELAY_MS = 800;
  const HTTP_522_RETRY_MAX_DELAY_MS = 8000;
  const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
  const AUDIO_PROCESS_MAX_BYTES = 24 * 1024 * 1024;
  const FONT_WORKER_URL = './vendor/font-marker.worker.js?v=1';
  // 与小程序 api.ts 共用的算法兼容值会随客户端公开下发，不作为鉴权密钥使用。
  const FONT_STEGO_KEY = '24';
  const ARCHIVE_EXTENSIONS = new Set(['zip', 'bdi', 'bds', 'it', 'dibao']);
  const INNER_PACKAGE_EXTENSIONS = new Set(['bdi', 'bds', 'it']);
  const AUDIO_EXTENSIONS = new Set(['aiff', 'ogg', 'm4a', 'mp3', 'wav', 'flac']);
  const FONT_EXTENSIONS = new Set(['ttf', 'otf', 'ott', 'ttc', 'otc']);
  const SYSTEM_NAMES = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);
  const SKIP_RENAME_EXTS = new Set(['.aiff', '.ogg']);
  const ITXT_KEYWORD = 'HiddenText';
  const TBW_CHR0 = '\u2060';
  const TBW_CHR1 = '\uFEFF';
  const textEncoder = new TextEncoder();
  const state = {
    apiBase: '',
    sessionToken: '',
    manifest: null,
    sequence: 0,
    currentLeaseId: '',
    currentReleaseUrl: '',
    finished: false,
  };

  const summaryEl = document.getElementById('summary');
  const statusEl = document.getElementById('status');
  const overallProgressEl = document.getElementById('overallProgress');
  const filesEl = document.getElementById('files');

  class LocalUnsupportedError extends Error {
    constructor(message) {
      super(message || '当前文件不支持浏览器本地构建');
      this.name = 'LocalUnsupportedError';
      this.code = 'LOCAL_UNSUPPORTED';
    }
  }

  class DownloadSlotBusyError extends Error {
    constructor(detail, retryAfter) {
      super(String(detail && detail.message || '当前下载人数较多，正在等待空闲通道'));
      this.name = 'DownloadSlotBusyError';
      this.active = Number(detail && detail.active || 0);
      this.limit = Number(detail && detail.limit || 0);
      this.retryAfterSeconds = Math.max(1, Number(detail && detail.retryAfterSeconds || retryAfter || 2));
    }
  }

  class UnauthorizedCredentialError extends Error {
    constructor(message) {
      super(message || '服务器下发凭据已失效');
      this.name = 'UnauthorizedCredentialError';
    }
  }

  function parseHash() {
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    const result = {};
    params.forEach((value, key) => { result[key] = value; });
    // sessionToken 只留在当前脚本内存中，不能进入后续资源请求 Referer、历史记录或截图地址栏。
    history.replaceState(null, document.title, location.pathname + location.search);
    return result;
  }

  function wait(delayMs) {
    return new Promise(resolve => setTimeout(resolve, delayMs));
  }

  function retry522Delay(retryCount) {
    return Math.min(
      HTTP_522_RETRY_BASE_DELAY_MS * Math.pow(2, Math.min(Math.max(retryCount - 1, 0), 4)),
      HTTP_522_RETRY_MAX_DELAY_MS
    );
  }

  function retry522Text(label, retryCount, delayMs) {
    return `${label}连接超时，${Math.max(1, Math.ceil(delayMs / 1000))} 秒后重试（第 ${retryCount} 次）`;
  }

  async function fetchUntilNon522(url, options, onRetry) {
    let retryCount = 0;
    while (true) {
      let response;
      try {
        response = await fetch(url, options);
      } catch (error) {
        // CDN 522 错误页缺少 CORS 头时浏览器只能看到 TypeError。控制面和上传节点
        // 均按同一退避规则重放，页面离开后浏览器会销毁等待任务。
        retryCount += 1;
        const delayMs = retry522Delay(retryCount);
        onRetry?.(retryCount, delayMs, error);
        await wait(delayMs);
        continue;
      }
      if (response.status !== HTTP_522_STATUS) return response;
      retryCount += 1;
      const delayMs = retry522Delay(retryCount);
      try { await response.body?.cancel?.(); } catch (_) {}
      onRetry?.(retryCount, delayMs);
      await wait(delayMs);
    }
  }

  function formatBytes(size) {
    const value = Math.max(0, Number(size || 0));
    if (value < 1024) return `${value} B`;
    if (value < 1024 * 1024) return `${(value / 1024).toFixed(2)} KB`;
    if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(2)} MB`;
    return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`;
  }

  function extension(name) {
    const base = String(name || '').replace(/\\/g, '/').split('/').pop() || '';
    const index = base.lastIndexOf('.');
    return index >= 0 ? base.slice(index + 1).toLowerCase() : '';
  }

  function baseName(path) {
    return String(path || '').replace(/\\/g, '/').split('/').pop() || '';
  }

  function setStatus(text, error = false) {
    statusEl.textContent = String(text || '');
    statusEl.className = error ? 'status error' : 'status';
  }

  function setOverallProgress(progress) {
    const value = Math.max(0, Math.min(100, Number(progress || 0)));
    overallProgressEl.style.width = `${value}%`;
  }

  function postMessage(data) {
    wx.miniProgram.postMessage({
      data: {
        ...data,
        sequence: state.sequence++,
        sentAt: Date.now(),
      }
    });
  }

  function navigateBack() {
    setTimeout(() => {
      try { wx.miniProgram.navigateBack({ delta: 1 }); }
      catch (_) { setStatus('处理已结束，请手动返回小程序。'); }
    }, 180);
  }

  function unwrapApiData(payload, fallbackMessage) {
    if (!payload || typeof payload !== 'object') throw new Error(fallbackMessage || '服务器响应格式无效');
    const code = payload.code;
    if (payload.success === false || ![undefined, null, 0, '0', 200, '200'].includes(code)) {
      const detail = payload.detail;
      const message = typeof detail === 'object'
        ? detail.message
        : (detail || payload.message || payload.msg || payload.error || fallbackMessage);
      const error = new Error(String(message || '服务器响应异常'));
      if (typeof detail === 'object' && detail.code) error.code = detail.code;
      throw error;
    }
    return payload.data && typeof payload.data === 'object' ? payload.data : payload;
  }

  async function apiPost(path, data, onRetry) {
    const response = await fetchUntilNon522(
      `${state.apiBase}${path}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        cache: 'no-store',
        credentials: 'omit',
      },
      onRetry
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = payload && payload.detail;
      const message = typeof detail === 'object'
        ? detail.message
        : (detail || payload.message || `接口响应异常(${response.status})`);
      const error = new Error(String(message));
      error.statusCode = response.status;
      if (typeof detail === 'object' && detail.code) error.code = detail.code;
      throw error;
    }
    return unwrapApiData(payload, `接口响应异常(${response.status})`);
  }

  function renderFiles(files) {
    filesEl.innerHTML = '';
    (files || []).forEach(item => {
      const row = document.createElement('div');
      row.className = 'file';
      row.dataset.fileKey = item.fileKey;
      row.innerHTML = '<div class="file-name"></div><div class="file-meta">等待处理</div><div class="file-progress"><i></i></div>';
      row.querySelector('.file-name').textContent = item.outputFileName || item.sourceFileName;
      filesEl.appendChild(row);
    });
  }

  function updateFileProgress(fileKey, text, progress, overallProgress) {
    const row = filesEl.querySelector(`[data-file-key="${CSS.escape(String(fileKey || ''))}"]`);
    if (row) {
      row.querySelector('.file-meta').textContent = String(text || '正在处理');
      if (Number.isFinite(Number(progress))) {
        row.querySelector('.file-progress i').style.width = `${Math.max(0, Math.min(100, Number(progress)))}%`;
      }
    }
    if (Number.isFinite(Number(overallProgress))) setOverallProgress(overallProgress);
    setStatus(text || '正在处理服务器下发文件...');
    postMessage({
      type: 'memberLocalBuildProgress',
      fileKey: String(fileKey || ''),
      text: String(text || '正在处理文件'),
      progress: Number.isFinite(Number(progress)) ? Number(progress) : -1,
      overallProgress: Number.isFinite(Number(overallProgress)) ? Number(overallProgress) : -1,
    });
  }

  function overallForFile(fileIndex, fileCount, fileProgress) {
    if (!fileCount) return 0;
    return Math.round(((fileIndex + Math.max(0, Math.min(100, fileProgress)) / 100) / fileCount) * 100);
  }

  async function exchangeCredential(url, ticket, retryAfterUnauthorized, signal) {
    const response = await fetchUntilNon522(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket, retryAfterUnauthorized: !!retryAfterUnauthorized }),
        cache: 'no-store',
        credentials: 'omit',
        signal,
      }
    );
    const payload = await response.json().catch(() => ({}));
    if (response.status === 429) {
      throw new DownloadSlotBusyError(
        payload && typeof payload.detail === 'object' ? payload.detail : {},
        response.headers.get('retry-after')
      );
    }
    if (!response.ok) throw new Error(`服务器下发凭据响应异常(${response.status})`);
    const data = unwrapApiData(payload, '服务器下发凭据响应异常');
    const accessToken = String(data.accessToken || '').trim();
    const downloadInfoUrl = String(data.downloadInfoUrl || '').trim();
    const fileId = Number(data.fileId || 0);
    const leaseId = String(data.downloadSlotLeaseId || '').trim();
    if (!accessToken || !/^https:\/\//i.test(downloadInfoUrl) || !Number.isFinite(fileId) || fileId <= 0 || !leaseId) {
      throw new Error('服务器下发凭据信息不完整');
    }
    return {
      accessToken,
      downloadInfoUrl,
      fileId: Math.floor(fileId),
      filename: String(data.filename || 'download.bin'),
      size: Math.max(0, Number(data.size || 0)),
      leaseId,
      releaseUrl: new URL('/api/cloud-download/pan123-h5-download-slot/release', url).toString(),
    };
  }

  async function exchangeCredentialWhenAvailable(url, ticket, retryAfterUnauthorized, signal, onWait) {
    while (true) {
      try {
        return await exchangeCredential(url, ticket, retryAfterUnauthorized, signal);
      } catch (error) {
        if (!(error instanceof DownloadSlotBusyError)) throw error;
        const capacity = error.active > 0 ? `（${error.active}/${error.limit}）` : '';
        onWait?.(`当前下载人数较多，正在等待空闲通道${capacity}...`);
        await wait(error.retryAfterSeconds * 1000);
      }
    }
  }

  async function releaseDownloadSlot(keepalive = false) {
    const leaseId = state.currentLeaseId;
    const releaseUrl = state.currentReleaseUrl;
    state.currentLeaseId = '';
    state.currentReleaseUrl = '';
    if (!leaseId || !/^https:\/\//i.test(releaseUrl)) return;
    try {
      await fetch(releaseUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leaseId }),
        cache: 'no-store',
        credentials: 'omit',
        keepalive,
      });
    } catch (_) {
      // Server 租约带 TTL；页面退出时释放失败会自动回收，不能反向覆盖已完成文件。
    }
  }

  async function fetchDownloadInfo(credential, signal) {
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const separator = credential.downloadInfoUrl.includes('?') ? '&' : '?';
        const response = await fetch(
          `${credential.downloadInfoUrl}${separator}fileId=${encodeURIComponent(credential.fileId)}`,
          {
            headers: {
              Authorization: `Bearer ${credential.accessToken}`,
              Platform: 'open_platform',
            },
            cache: 'no-store',
            credentials: 'omit',
            signal,
          }
        );
        if (response.status === 401) throw new UnauthorizedCredentialError();
        if (!response.ok) throw new Error(`下载信息响应异常(${response.status})`);
        const data = unwrapApiData(await response.json(), '下载信息响应异常');
        const downloadUrl = String(data.downloadUrl || data.download_url || data.url || '').trim();
        if (!/^https:\/\//i.test(downloadUrl)) throw new Error('服务器未返回有效下载地址');
        return { downloadUrl, size: Math.max(0, Number(data.size || credential.size || 0)) };
      } catch (error) {
        lastError = error;
        if (error && error.name === 'UnauthorizedCredentialError') throw error;
        if (error && error.name === 'AbortError') throw error;
        if (attempt < 2) await wait(300 * (attempt + 1));
      }
    }
    throw lastError || new Error('下载信息获取失败');
  }

  async function responseToBlob(response, expectedSize, onProgress, signal) {
    if (!response.body || typeof response.body.getReader !== 'function') {
      const blob = await response.blob();
      if (expectedSize > 0 && blob.size !== expectedSize) {
        throw new Error(`服务器下发文件大小校验失败：预期 ${expectedSize}，实际 ${blob.size}`);
      }
      onProgress?.(100, blob.size, expectedSize || blob.size);
      return blob;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const item = await reader.read();
      if (item.done) break;
      if (item.value && item.value.length) {
        received += item.value.length;
        if (expectedSize > 0 && received > expectedSize) throw new Error('服务器下发文件超过预期大小');
        chunks.push(item.value);
        onProgress?.(expectedSize > 0 ? Math.round(received / expectedSize * 100) : 0, received, expectedSize);
      }
    }
    if (expectedSize > 0 && received !== expectedSize) {
      throw new Error(`服务器下发文件大小校验失败：预期 ${expectedSize}，实际 ${received}`);
    }
    return new Blob(chunks, { type: 'application/octet-stream' });
  }

  async function downloadSourceFile(plan, onProgress) {
    const ticket = await apiPost(
      '/api/member/local-build-h5/download-ticket',
      { sessionToken: state.sessionToken, fileKey: plan.fileKey },
      (count, delay) => onProgress(retry522Text('文件计划服务', count, delay), 0)
    );
    const credentialUrl = String(ticket.credentialUrl || '').trim();
    const credentialTicket = String(ticket.credentialTicket || '').trim();
    if (!/^https:\/\//i.test(credentialUrl) || !credentialTicket) throw new Error('服务器下发文件参数无效');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      let credential = await exchangeCredentialWhenAvailable(
        credentialUrl,
        credentialTicket,
        false,
        controller.signal,
        text => onProgress(text, 0)
      );
      state.currentLeaseId = credential.leaseId;
      state.currentReleaseUrl = credential.releaseUrl;
      let downloadInfo;
      try {
        downloadInfo = await fetchDownloadInfo(credential, controller.signal);
      } catch (error) {
        if (!(error instanceof UnauthorizedCredentialError)) throw error;
        credential = await exchangeCredentialWhenAvailable(
          credentialUrl,
          credentialTicket,
          true,
          controller.signal,
          text => onProgress(text, 0)
        );
        state.currentLeaseId = credential.leaseId;
        state.currentReleaseUrl = credential.releaseUrl;
        downloadInfo = await fetchDownloadInfo(credential, controller.signal);
      }
      credential.accessToken = '';
      onProgress('正在连接服务器下发文件...', 1);
      const response = await fetch(downloadInfo.downloadUrl, {
        cache: 'no-store',
        credentials: 'omit',
        redirect: 'follow',
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`服务器下发文件响应异常(${response.status})`);
      const headerSize = Math.max(0, Number(response.headers.get('content-length') || 0));
      const totalSize = downloadInfo.size || Number(plan.size || 0) || headerSize;
      const blob = await responseToBlob(
        response,
        totalSize,
        (percent, received, total) => onProgress(
          total > 0 ? `正在接收服务器下发文件 ${percent}%（${formatBytes(received)}/${formatBytes(total)}）` : `正在接收服务器下发文件（${formatBytes(received)}）`,
          percent
        ),
        controller.signal
      );
      await releaseDownloadSlot();
      return blob;
    } finally {
      clearTimeout(timer);
      await releaseDownloadSlot();
    }
  }

  function exactArrayBuffer(bytes) {
    const output = new Uint8Array(bytes.byteLength);
    output.set(bytes);
    return output.buffer;
  }

  function inspectFontContainer(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 4) throw new LocalUnsupportedError('字体文件头不完整');
    const signature = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
    const isTrueType = (bytes[0] === 0 && bytes[1] === 1 && bytes[2] === 0 && bytes[3] === 0) || signature === 'true';
    if (isTrueType) return 'truetype';
    if (signature === 'OTTO') return 'cff';
    if (signature === 'ttcf') {
      if (bytes.length < 12) throw new LocalUnsupportedError('字体集合头不完整');
      const view = new DataView(buffer);
      const version = view.getUint32(4, false);
      const count = view.getUint32(8, false);
      if (![0x00010000, 0x00020000].includes(version) || count <= 0 || 12 + count * 4 > bytes.length) {
        throw new LocalUnsupportedError('字体集合结构无效');
      }
      return 'collection';
    }
    throw new LocalUnsupportedError('字体内容不是受支持的 TrueType/OpenType/TTC 容器');
  }

  function markFontBuffer(buffer, filename, message) {
    inspectFontContainer(buffer);
    return new Promise((resolve, reject) => {
      let settled = false;
      const worker = new Worker(FONT_WORKER_URL);
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        worker.terminate();
        callback();
      };
      worker.onerror = event => finish(() => reject(new LocalUnsupportedError(event.message || '浏览器字体处理 Worker 失败')));
      worker.onmessage = event => {
        const response = event.data || {};
        if (!response.ok || !(response.output instanceof ArrayBuffer)) {
          finish(() => reject(new LocalUnsupportedError(response.error || '字体本地处理失败')));
          return;
        }
        finish(() => resolve(response.output));
      };
      const transferable = buffer.slice(0);
      worker.postMessage({
        id: `font_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        bytes: transferable,
        filename,
        metadata: { message, marker: 'GuShao' },
        keyText: FONT_STEGO_KEY,
      }, [transferable]);
    });
  }

  function bytesToBase64(bytes) {
    let binary = '';
    const chunk = 0x8000;
    for (let offset = 0; offset < bytes.length; offset += chunk) {
      binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunk)));
    }
    return btoa(binary);
  }

  function utf8Base64(text) {
    return bytesToBase64(textEncoder.encode(String(text || '')));
  }

  function decodeUtf8Strict(buffer) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
    catch (_) { return null; }
  }

  function isXmlPlistBuffer(buffer) {
    const bytes = new Uint8Array(buffer);
    if (bytes.length >= 6 && String.fromCharCode(...bytes.slice(0, 6)) === 'bplist') return false;
    const text = new TextDecoder('utf-8').decode(bytes.slice(0, Math.min(bytes.length, 256)));
    return text.includes('<?xml') || text.includes('<plist');
  }

  function findMatchingDictClose(content, searchStart) {
    const pattern = /<\s*dict\s*>|<\s*\/\s*dict\s*>/g;
    pattern.lastIndex = searchStart;
    let depth = 1;
    let match;
    while ((match = pattern.exec(content))) {
      if (/^<\s*dict\s*>$/i.test(match[0])) depth += 1;
      else if (--depth === 0) return match.index;
    }
    return -1;
  }

  function findKeyedDictRange(content, keyName, start, end) {
    const pattern = new RegExp(`<key>\\s*${keyName}\\s*<\\/key>\\s*<dict>`, 'ig');
    pattern.lastIndex = start;
    let match;
    while ((match = pattern.exec(content))) {
      const openEnd = match.index + match[0].length;
      if (match.index >= end || openEnd > end) return null;
      const closeIndex = findMatchingDictClose(content, openEnd);
      if (closeIndex >= 0 && closeIndex <= end) return { openEnd, closeIndex };
    }
    return null;
  }

  function plistHasWatermark(content) {
    const hasFields = range => {
      const body = content.slice(range.openEnd, range.closeIndex);
      return /<key>\s*Src\s*<\/key>/i.test(body) && /<key>\s*Ref\s*<\/key>/i.test(body);
    };
    const marks = findKeyedDictRange(content, 'Marks', 0, content.length);
    const watermark = marks ? findKeyedDictRange(content, 'Watermark', marks.openEnd, marks.closeIndex) : null;
    if (watermark && hasFields(watermark)) return true;
    const meta = findKeyedDictRange(content, '_Meta', 0, content.length);
    return !!(meta && hasFields(meta));
  }

  function plistInjectWatermark(content, message) {
    if (!(content.includes('<?xml') || content.includes('<plist')) || plistHasWatermark(content)) return content;
    const ts = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
    const fields = `<key>Src</key><string>${utf8Base64('GuShao')}</string>` +
      `<key>Ref</key><string>${utf8Base64(message)}</string>` +
      `<key>Ts</key><string>${utf8Base64(ts)}</string>`;
    if (/<plist[^>]*>\s*<array>/.test(content)) {
      const item = `\n\t<dict>\n\t\t<key>_Meta</key>\n\t\t<dict>${fields}</dict>\n\t</dict>\n`;
      return content.replace(/(\s*<\/array>\s*<\/plist>)/, `${item}$1`);
    }
    const marks = findKeyedDictRange(content, 'Marks', 0, content.length);
    if (marks) {
      const watermark = findKeyedDictRange(content, 'Watermark', marks.openEnd, marks.closeIndex);
      if (watermark) return `${content.slice(0, watermark.closeIndex)}${fields}${content.slice(watermark.closeIndex)}`;
      return `${content.slice(0, marks.closeIndex)}<key>Watermark</key><dict>${fields}</dict>${content.slice(marks.closeIndex)}`;
    }
    const block = `<key>Marks</key><dict><key>Watermark</key><dict>${fields}</dict></dict>`;
    const rootDict = content.replace(/(<\/dict>\s*<\/plist>)/, `${block}$1`);
    return rootDict !== content ? rootDict : content.replace(/(<\/plist>)/, `${block}$1`);
  }

  const INI_KEYS = ['H_INFO', 'G_INFO', 'I_INFO', 'J_INFO', 'K_INFO', 'L_INFO', 'M_INFO', 'N_INFO', 'O_INFO', 'P_INFO'];
  const INI_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const INI_MAP = Object.fromEntries(Array.from(INI_B64).map((char, index) => [char, String(index).padStart(2, '0')]));
  const KEY_SECTION_PATTERN = /^\s*\[KEY\d+\]\s*$/i;

  function encodeIniNumeric(text) {
    const b64 = utf8Base64(text);
    const padding = (b64.match(/=/g) || []).length;
    return Array.from(b64.replace(/=/g, '')).map(char => INI_MAP[char] || '').join('') + String(padding);
  }

  function isInjectedIniLine(line) {
    return new RegExp(`^\\s*(?:${INI_KEYS.join('|')})\\s*=`).test(String(line || '').replace(/^\uFEFF/, ''));
  }

  function hasIniTextStructure(content, fileName) {
    const lines = String(content || '').split(/\r?\n/);
    if (String(fileName || '').toLowerCase().endsWith('.til')) {
      return lines.some(line => KEY_SECTION_PATTERN.test(line.replace(/^\uFEFF/, '').trim()));
    }
    return lines.some(line => {
      const normalized = line.replace(/^\uFEFF/, '').trim();
      return KEY_SECTION_PATTERN.test(normalized) || /^\[[^\]\r\n]+\]$/.test(normalized) || /^[^#;=\s][^=\r\n]{0,120}=/.test(normalized);
    });
  }

  function iniInjectWatermark(content, message) {
    const formatted = encodeIniNumeric(String(message || '').trim()).match(/.{1,3}/g)?.join(',') || '';
    const chunks = formatted.match(/.{1,11}/g) || [formatted];
    const result = [];
    let infoIndex = 0;
    const append = () => {
      if (infoIndex < chunks.length) result.push(`${INI_KEYS[infoIndex++ % INI_KEYS.length]}=${chunks[infoIndex - 1]}`);
    };
    String(content || '').split(/\r?\n/).forEach(line => {
      if (isInjectedIniLine(line)) return;
      result.push(line);
      if (KEY_SECTION_PATTERN.test(line.replace(/^\uFEFF/, '').trim())) {
        append(); append(); append();
      }
    });
    while (infoIndex < chunks.length) append();
    return result.join('\n');
  }

  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c;
    }
    return table;
  })();

  function crc32(bytes) {
    let crc = 0xffffffff;
    for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  }

  function parsePngChunks(bytes) {
    const signature = [137, 80, 78, 71, 13, 10, 26, 10];
    if (bytes.length < 8 || signature.some((value, index) => bytes[index] !== value)) throw new Error('invalid png signature');
    const chunks = [];
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 8;
    while (offset + 12 <= bytes.length) {
      const length = view.getUint32(offset, false);
      const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
      const dataStart = offset + 8;
      const dataEnd = dataStart + length;
      if (!/^[A-Za-z]{4}$/.test(type) || dataEnd + 4 > bytes.length) throw new Error('invalid png chunk');
      chunks.push({ type, data: bytes.slice(dataStart, dataEnd) });
      offset = dataEnd + 4;
      if (type === 'IEND') return chunks;
    }
    throw new Error('missing png iend');
  }

  function buildPngChunk(type, data) {
    const typeBytes = Uint8Array.from(Array.from(type).map(char => char.charCodeAt(0)));
    const crcInput = new Uint8Array(4 + data.length);
    crcInput.set(typeBytes); crcInput.set(data, 4);
    const output = new Uint8Array(12 + data.length);
    const view = new DataView(output.buffer);
    view.setUint32(0, data.length, false);
    output.set(typeBytes, 4); output.set(data, 8);
    view.setUint32(8 + data.length, crc32(crcInput), false);
    return output;
  }

  function buildItxtData(message) {
    const key = textEncoder.encode(ITXT_KEYWORD);
    const payload = textEncoder.encode(String(message || ''));
    const data = new Uint8Array(key.length + 5 + payload.length);
    data.set(key, 0);
    let offset = key.length;
    data[offset++] = 0; // keyword terminator
    data[offset++] = 0; // uncompressed UTF-8 text
    data[offset++] = 0; // compression method
    data[offset++] = 0; // empty language tag
    data[offset++] = 0; // empty translated keyword
    data.set(payload, offset);
    return data;
  }

  function injectPngItxt(bytes, message) {
    const chunks = parsePngChunks(bytes).filter(chunk => {
      if (chunk.type !== 'iTXt') return true;
      const zero = chunk.data.indexOf(0);
      return zero < 0 || new TextDecoder().decode(chunk.data.slice(0, zero)) !== ITXT_KEYWORD;
    });
    const insertAt = Math.max(1, chunks.findIndex(chunk => chunk.type === 'IDAT'));
    chunks.splice(insertAt, 0, { type: 'iTXt', data: buildItxtData(message) });
    const parts = [Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]), ...chunks.map(chunk => buildPngChunk(chunk.type, chunk.data))];
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const output = new Uint8Array(total);
    let offset = 0;
    parts.forEach(part => { output.set(part, offset); offset += part.length; });
    return output;
  }

  async function imageBlobToPng(blob) {
    if (!('createImageBitmap' in window)) return null;
    const bitmap = await createImageBitmap(blob);
    try {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d', { alpha: true }).drawImage(bitmap, 0, 0);
      return await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    } finally {
      bitmap.close();
    }
  }

  async function processPngCandidate(blob, message) {
    const first = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
    const isPng = first.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => first[index] === value);
    if (isPng) return new Blob([injectPngItxt(new Uint8Array(await blob.arrayBuffer()), message)], { type: 'image/png' });
    const isJpeg = first.length >= 3 && first[0] === 0xff && first[1] === 0xd8 && first[2] === 0xff;
    if (!isJpeg) return blob;
    const png = await imageBlobToPng(blob);
    if (!png) return blob;
    return new Blob([injectPngItxt(new Uint8Array(await png.arrayBuffer()), message)], { type: 'image/png' });
  }

  function lcgState(passwordBytes) {
    let value = 0;
    for (const byte of passwordBytes) value = ((value * 31 + byte) & 0xffffffff) >>> 0;
    return value;
  }

  function lcgNext(value) {
    const next = ((1664525 * value + 1013904223) & ((2 << 30) - 1)) >>> 0;
    return { state: next, u8: next % 256 };
  }

  function tbwEncode(message) {
    let random = lcgState(textEncoder.encode(FONT_STEGO_KEY));
    const output = [];
    for (const byte of textEncoder.encode(message)) {
      const next = lcgNext(random); random = next.state;
      const encrypted = byte ^ next.u8;
      for (let bit = 7; bit >= 0; bit--) output.push((encrypted >> bit) & 1 ? TBW_CHR1 : TBW_CHR0);
    }
    return output.join('');
  }

  function tbwExtract(text) {
    const bits = [];
    let found = false;
    for (const char of String(text || '')) {
      if (char === TBW_CHR0 || char === TBW_CHR1) { found = true; bits.push(char === TBW_CHR1 ? 1 : 0); }
      else if (found) break;
    }
    const encrypted = [];
    for (let index = 0; index + 7 < bits.length; index += 8) {
      let byte = 0;
      for (let bit = 0; bit < 8; bit++) byte = (byte << 1) | bits[index + bit];
      encrypted.push(byte);
    }
    let random = lcgState(textEncoder.encode(FONT_STEGO_KEY));
    const output = new Uint8Array(encrypted.length);
    encrypted.forEach((byte, index) => { const next = lcgNext(random); random = next.state; output[index] = byte ^ next.u8; });
    return new TextDecoder().decode(output);
  }

  function buildCopyrightJson(message, existingJson) {
    const year = new Date().getFullYear();
    let base = `GSCopyright = CL - EULA | Copyright (c) 2021 - ${year} GuShao's Beautify Organization`;
    if (existingJson) {
      try { base = JSON.parse(existingJson).copyright || base; } catch (_) {}
    }
    const existing = tbwExtract(base);
    const clean = Array.from(base).filter(char => char !== TBW_CHR0 && char !== TBW_CHR1).join('');
    const copyright = clean + tbwEncode(existing ? existing + message : message);
    return textEncoder.encode(JSON.stringify({
      embed_time: new Date().toISOString().replace('T', ' ').slice(0, 19),
      copyright,
    }, null, 4));
  }

  function normalizeResourcePath(path) {
    return String(path || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/');
  }

  function splitPath(path) {
    const normalized = normalizeResourcePath(path);
    const index = normalized.lastIndexOf('/');
    return index < 0 ? { dir: '', base: normalized } : { dir: normalized.slice(0, index + 1), base: normalized.slice(index + 1) };
  }

  const KNOWN_RESOURCE_EXTS = new Set(['.png', '.webp', '.jpg', '.jpeg', '.bmp', '.gif', '.til']);

  function splitReference(path) {
    const item = splitPath(path);
    const dot = item.base.lastIndexOf('.');
    const ext = dot > 0 && KNOWN_RESOURCE_EXTS.has(item.base.slice(dot).toLowerCase()) ? item.base.slice(dot) : '';
    return { dir: item.dir, stem: ext ? item.base.slice(0, -ext.length) : item.base, ext };
  }

  function splitResourceFile(path) {
    const item = splitPath(path);
    const dot = item.base.lastIndexOf('.');
    return { dir: item.dir, stem: dot > 0 ? item.base.slice(0, dot) : item.base, ext: dot > 0 ? item.base.slice(dot) : '' };
  }

  function parseCssResourceLine(line) {
    const match = String(line || '').match(/^(\s*)(NM_IMG|HL_IMG)(\s*=\s*)(.*)$/i);
    if (!match) return null;
    const raw = match[4] || '';
    const comma = raw.indexOf(',');
    const token = comma >= 0 ? raw.slice(0, comma) : raw;
    const tail = comma >= 0 ? raw.slice(comma) : '';
    const leading = token.match(/^\s*/)?.[0] || '';
    const trailing = token.match(/\s*$/)?.[0] || '';
    let core = token.trim();
    let quote = '';
    if (core.length >= 2 && ['"', "'"].includes(core[0]) && core.at(-1) === core[0]) {
      quote = core[0]; core = core.slice(1, -1);
    }
    core = normalizeResourcePath(core.trim());
    return core ? { prefix: `${match[1]}${match[2]}${match[3]}`, leading, trailing, core, quote, tail } : null;
  }

  function collectCssReferences(content) {
    return Array.from(new Set(String(content || '').split(/\r?\n/).map(line => parseCssResourceLine(line)?.core).filter(Boolean)));
  }

  function findResourceFiles(reference, files) {
    const ref = splitReference(reference);
    return files.filter(path => {
      const file = splitResourceFile(path);
      return file.stem && !SKIP_RENAME_EXTS.has(file.ext.toLowerCase()) && (!ref.dir || ref.dir === file.dir) &&
        (!ref.ext || ref.ext.toLowerCase() === file.ext.toLowerCase()) && ref.stem === file.stem;
    });
  }

  function rewriteCss(content, replacements) {
    return String(content || '').split(/\r?\n/).filter(line => {
      const trimmed = line.trim();
      const hasChinese = /[\u4e00-\u9fa5]/.test(line);
      return !(hasChinese && !parseCssResourceLine(line) && trimmed && !/^\[[^\]]+\]$/.test(trimmed) && !trimmed.includes('='));
    }).map(line => {
      const parsed = parseCssResourceLine(line);
      if (!parsed || !replacements[parsed.core]) return line;
      const next = parsed.quote ? `${parsed.quote}${replacements[parsed.core]}${parsed.quote}` : replacements[parsed.core];
      return `${parsed.prefix}${parsed.leading}${next}${parsed.trailing}${parsed.tail}`;
    }).join('\n');
  }

  const HEX_CHARS = '0123456789ABCDEF';
  const V2_CHARSET = '0123456789abcdefghijklmnopqrstuvwxyz@_()-.+';
  const V2_MAP = Object.fromEntries(Array.from(V2_CHARSET).map((char, index) => [char, index]));
  const V2_MASK = Uint8Array.from([0x3A,0x7F,0x2B,0x9C,0x4E,0x1D,0x5A,0x8F,0x6B,0x0C,0x7D,0x3E,0x9A,0x4F,0x5B,0x2C]);
  const GF_EXP = new Uint8Array(512);
  const GF_LOG = new Uint8Array(256);
  let hiddenChunksCache = Object.create(null);
  {
    let value = 1;
    for (let index = 0; index < 255; index++) {
      GF_EXP[index] = value; GF_LOG[value] = index;
      const doubled = (value << 1) ^ (value & 0x80 ? 0x11B : 0);
      value = doubled ^ value;
    }
    GF_EXP[255] = GF_EXP[0];
    for (let index = 256; index < 512; index++) GF_EXP[index] = GF_EXP[index - 255];
  }

  function randomHex(length = 32) {
    const values = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(values, value => HEX_CHARS[value & 15]).join('');
  }

  function encodeV2Chars(text) {
    let bits = 0, bitCount = 0;
    const output = [];
    for (const char of text) {
      bits = (bits << 6) | (V2_MAP[char] || 0); bitCount += 6;
      while (bitCount >= 8) { bitCount -= 8; output.push((bits >> bitCount) & 0xff); bits &= (1 << bitCount) - 1; }
    }
    if (bitCount > 0) output.push((bits << (8 - bitCount)) & 0xff);
    return Uint8Array.from(output);
  }

  function gfMul(left, right) {
    return left === 0 || right === 0 ? 0 : GF_EXP[GF_LOG[left] + GF_LOG[right]];
  }

  function padded12(bytes) {
    const output = new Uint8Array(12); output.set(bytes.slice(0, 12)); return output;
  }

  function buildHiddenChunks(message, count = 30) {
    const cleaned = Array.from(String(message || '').toLowerCase()).filter(char => char in V2_MAP).join('').slice(-32);
    if (!cleaned) return Array.from({ length: count }, () => randomHex());
    const middle = Math.ceil(cleaned.length / 2);
    const left = padded12(encodeV2Chars(cleaned.slice(0, middle)));
    const right = padded12(encodeV2Chars(cleaned.slice(middle)));
    return Array.from({ length: count }, (_, offset) => {
      const shareIndex = offset + 1;
      const raw = new Uint8Array(16);
      raw[0] = 0xB5; raw[1] = shareIndex; raw[2] = cleaned.length;
      for (let index = 0; index < 12; index++) raw[index + 3] = left[index] ^ gfMul(shareIndex, right[index]);
      for (let index = 0; index < 15; index++) raw[15] ^= raw[index];
      return Array.from(raw, (value, index) => (value ^ V2_MASK[index]).toString(16).padStart(2, '0').toUpperCase()).join('');
    });
  }

  function nextHiddenStem(message, index) {
    if (!hiddenChunksCache[message]) hiddenChunksCache[message] = buildHiddenChunks(message);
    return hiddenChunksCache[message][index] || randomHex();
  }

  async function modifyMaterials(zip, message) {
    const cssPaths = Object.keys(zip.files).filter(path => !zip.files[path].dir && path.endsWith('res/default.css'));
    let counter = 0;
    for (const cssPath of cssPaths) {
      const resPrefix = cssPath.slice(0, cssPath.lastIndexOf('/') + 1);
      let css = await zip.file(cssPath).async('string');
      const resourceFiles = Object.keys(zip.files)
        .filter(path => !zip.files[path].dir && path.startsWith(resPrefix) && path !== cssPath)
        .map(path => path.slice(resPrefix.length));
      const usedStems = new Set(resourceFiles.map(path => splitResourceFile(path).stem.toLowerCase()).filter(Boolean));
      const replacements = {};
      for (const reference of collectCssReferences(css)) {
        const matches = findResourceFiles(reference, resourceFiles);
        if (!matches.length) continue;
        let stem = '';
        for (let attempt = 0; attempt < 64; attempt++) {
          const candidate = nextHiddenStem(message, counter++);
          if (!usedStems.has(candidate.toLowerCase())) { stem = candidate; usedStems.add(candidate.toLowerCase()); break; }
        }
        if (!stem) continue;
        const ref = splitReference(reference);
        replacements[reference] = `${ref.dir}${stem}${ref.ext}`;
        for (const relativePath of matches) {
          const sourcePath = `${resPrefix}${relativePath}`;
          const file = splitResourceFile(relativePath);
          const targetPath = `${resPrefix}${file.dir}${stem}${file.ext}`;
          const data = await zip.file(sourcePath).async('uint8array');
          zip.file(targetPath, data, { binary: true });
          zip.remove(sourcePath);
          const index = resourceFiles.indexOf(relativePath);
          if (index >= 0) resourceFiles[index] = `${file.dir}${stem}${file.ext}`;
        }
      }
      zip.file(cssPath, rewriteCss(css, replacements));
    }
  }

  function isSystemEntry(path) {
    const parts = String(path || '').replace(/\\/g, '/').split('/').filter(Boolean);
    return parts.some(part => part.toLowerCase() === '__macosx' || part.startsWith('.')) ||
      (parts.length > 0 && SYSTEM_NAMES.has(parts.at(-1).toLowerCase()));
  }

  function validateArchiveEntries(zip) {
    const normalized = new Set();
    Object.entries(zip.files).forEach(([name, entry]) => {
      // JSZip 3 会把 ../ 从 entry.name 中净化，并把原始名称放在
      // unsafeOriginalName。安全检查必须优先看原始值，否则 ZipSlip 只会被悄悄改名。
      const originalName = entry.unsafeOriginalName || name;
      const clean = String(originalName || '').replace(/\\/g, '/');
      const parts = clean.split('/').filter(Boolean);
      if (clean.startsWith('/') || parts.some(part => part === '..' || part.includes('\0'))) {
        throw new LocalUnsupportedError(`压缩包包含不安全路径：${name}`);
      }
      const key = parts.join('/').toLowerCase();
      if (key && normalized.has(key)) throw new LocalUnsupportedError(`压缩包包含重复路径：${name}`);
      if (key) normalized.add(key);
    });
  }

  function isEncryptedArchiveError(error) {
    return /encrypt|password|密码|加密/i.test(String(error && error.message || error || ''));
  }

  async function loadArchive(blob, label) {
    try {
      const zip = await JSZip.loadAsync(blob, { checkCRC32: true, createFolders: true });
      validateArchiveEntries(zip);
      return zip;
    } catch (error) {
      if (isEncryptedArchiveError(error)) throw new LocalUnsupportedError(`压缩包已加密，无法本地处理：${label}`);
      throw new LocalUnsupportedError(`压缩包结构不兼容浏览器本地构建：${label}`);
    }
  }

  async function processAudio(blob, relativeName, plan) {
    if (blob.size > AUDIO_PROCESS_MAX_BYTES) {
      throw new LocalUnsupportedError(`包内音频超过本地处理范围：${relativeName}`);
    }
    const body = new FormData();
    body.append('sessionToken', state.sessionToken);
    body.append('fileKey', plan.fileKey);
    body.append('originalFilename', relativeName);
    body.append('file', blob, baseName(relativeName) || 'audio.bin');
    const response = await fetchUntilNon522(
      `${state.apiBase}/api/member/local-build-h5/repair-audio`,
      { method: 'POST', body, cache: 'no-store', credentials: 'omit' }
    );
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = payload && payload.detail;
      if (response.status === 422 || (typeof detail === 'object' && detail.code === 'LOCAL_UNSUPPORTED')) {
        throw new LocalUnsupportedError(typeof detail === 'object' ? detail.message : '包内音频无法在浏览器链路处理');
      }
      throw new Error(typeof detail === 'string' ? detail : `音频处理失败(${response.status})`);
    }
    const data = unwrapApiData(payload, '音频处理失败');
    const downloadUrl = String(data.download_url || data.url || '').trim();
    if (!downloadUrl) return blob;
    const result = await fetchUntilNon522(new URL(downloadUrl, state.apiBase).toString(), { cache: 'no-store', credentials: 'omit' });
    if (!result.ok) throw new Error(`音频处理结果下载失败(${result.status})`);
    return result.blob();
  }

  function hasBytes(data, offset, pattern) {
    return offset >= 0 && offset + pattern.length <= data.length && pattern.every((value, index) => data[offset + index] === value);
  }

  function readUint16LE(data, offset) { return data[offset] | (data[offset + 1] << 8); }
  function readUint32LE(data, offset) { return (data[offset] | data[offset + 1] << 8 | data[offset + 2] << 16 | data[offset + 3] << 24) >>> 0; }

  function centralDirectoryRange(data) {
    for (let eocd = data.length - 22; eocd >= 0; eocd--) {
      if (!hasBytes(data, eocd, [0x50, 0x4b, 0x05, 0x06])) continue;
      const commentLength = readUint16LE(data, eocd + 20);
      const size = readUint32LE(data, eocd + 12);
      const offset = readUint32LE(data, eocd + 16);
      if (eocd + 22 + commentLength <= data.length && offset + size <= eocd && (!size || hasBytes(data, offset, [0x50,0x4b,0x01,0x02]))) {
        return { offset, end: offset + size };
      }
    }
    return null;
  }

  function forEachCentralHeader(data, visitor) {
    const range = centralDirectoryRange(data);
    if (!range) throw new LocalUnsupportedError('重新打包结果缺少有效 ZIP 中央目录');
    let offset = range.offset;
    while (offset + 46 <= range.end && hasBytes(data, offset, [0x50,0x4b,0x01,0x02])) {
      visitor(offset);
      const next = offset + 46 + readUint16LE(data, offset + 28) + readUint16LE(data, offset + 30) + readUint16LE(data, offset + 32);
      if (next <= offset || next > range.end) break;
      offset = next;
    }
  }

  function applyDefaultArchiveEncryption(buffer, outputName) {
    const lower = String(outputName || '').toLowerCase();
    if (lower.endsWith('.zip') || lower.endsWith('.dibao')) return buffer;
    const data = new Uint8Array(buffer.slice(0));
    if (lower.endsWith('.bds')) {
      const view = new DataView(data.buffer);
      forEachCentralHeader(data, offset => {
        data[offset + 8] |= 0x01;
        view.setUint32(offset + 20, 0xffffffff, true);
        view.setUint32(offset + 24, 0xffffffff, true);
        view.setUint32(offset + 42, 0xffffffff, true);
      });
      return data.buffer;
    }
    forEachCentralHeader(data, offset => { data[offset + 8] |= 0x01; });
    if (lower.endsWith('.it') || lower.endsWith('.bdi')) return data.buffer;
    const base = Uint8Array.from([0x50,0x4b,0x05,0x06,0,0,0,0,0xa4,0,0xa4,0,0x56,0x2a,0,0,0x07,0x3d,0xa4,0,0,0]);
    const length = 24 + crypto.getRandomValues(new Uint16Array(1))[0] % (1024 - 24 + 1);
    const extra = crypto.getRandomValues(new Uint8Array(length));
    extra.set(base);
    const output = new Uint8Array(data.length + extra.length);
    output.set(data); output.set(extra, data.length);
    return output.buffer;
  }

  async function sha256Hex(buffer) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', buffer));
    return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function base64ToBytes(text) {
    const binary = atob(String(text || ''));
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  }

  async function appendArchiveProtection(buffer, plan) {
    if (!['bdi', 'bds', 'it'].includes(extension(plan.outputFileName))) return buffer;
    const response = await apiPost('/api/member/local-build-h5/archive-protection/sign', {
      sessionToken: state.sessionToken,
      fileKey: plan.fileKey,
      fileName: plan.outputFileName,
      fileSize: buffer.byteLength,
      sha256: await sha256Hex(buffer),
    });
    const trailer = base64ToBytes(response.trailerBase64);
    if (trailer.length !== 96) throw new Error('文件保护标记长度无效');
    const output = new Uint8Array(buffer.byteLength + trailer.length);
    output.set(new Uint8Array(buffer)); output.set(trailer, buffer.byteLength);
    return output.buffer;
  }

  async function processSkinArchiveBlob(sourceBlob, plan, options = {}) {
    const zip = await loadArchive(sourceBlob, plan.sourceFileName);
    Object.keys(zip.files).forEach(path => { if (isSystemEntry(path)) zip.remove(path); });
    if (options.modifyMaterials !== false) await modifyMaterials(zip, state.manifest.watermarkMessage);

    const entries = Object.values(zip.files).filter(entry => !entry.dir);
    const directories = new Set(['']);
    entries.forEach(entry => {
      const index = entry.name.lastIndexOf('/');
      directories.add(index >= 0 ? entry.name.slice(0, index + 1) : '');
    });

    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      const ext = extension(entry.name);
      const progress = Math.round((index / Math.max(1, entries.length)) * 70) + 10;
      options.onProgress?.(`正在处理包内文件 ${index + 1}/${entries.length}：${baseName(entry.name)}`, progress);
      if (ext === 'png') {
        zip.file(entry.name, await processPngCandidate(await entry.async('blob'), state.manifest.watermarkMessage), { binary: true });
      } else if (ext === 'plist') {
        const buffer = await entry.async('arraybuffer');
        if (isXmlPlistBuffer(buffer)) {
          const text = decodeUtf8Strict(buffer);
          if (text !== null) zip.file(entry.name, plistInjectWatermark(text, state.manifest.watermarkMessage));
        }
      } else if (ext === 'ini' || ext === 'til') {
        const buffer = await entry.async('arraybuffer');
        const text = decodeUtf8Strict(buffer);
        if (text !== null && hasIniTextStructure(text, entry.name)) zip.file(entry.name, iniInjectWatermark(text, state.manifest.watermarkMessage));
      } else if (AUDIO_EXTENSIONS.has(ext)) {
        zip.file(entry.name, await processAudio(await entry.async('blob'), entry.name, plan), { binary: true });
      } else if (FONT_EXTENSIONS.has(ext)) {
        const marked = await markFontBuffer(await entry.async('arraybuffer'), entry.name, state.manifest.watermarkMessage);
        zip.file(entry.name, marked, { binary: true });
      }
      if (index % 8 === 7) await wait(0);
    }

    for (const directory of directories) {
      const path = `${directory}GSCopyright.json`;
      const existing = zip.file(path) ? await zip.file(path).async('string').catch(() => '') : '';
      zip.file(path, buildCopyrightJson(state.manifest.watermarkMessage, existing), { binary: true });
    }

    options.onProgress?.('正在重新打包...', 85);
    const rebuilt = await zip.generateAsync(
      { type: 'arraybuffer', compression: 'DEFLATE', compressionOptions: { level: 6 }, streamFiles: true },
      metadata => options.onProgress?.(`正在重新打包 ${Math.round(metadata.percent || 0)}%`, 85 + Math.round((metadata.percent || 0) * 0.1))
    );
    if (options.skipArchiveEncryption) return new Blob([rebuilt], { type: 'application/octet-stream' });
    let protectedBuffer = applyDefaultArchiveEncryption(rebuilt, plan.outputFileName);
    protectedBuffer = await appendArchiveProtection(protectedBuffer, plan);
    return new Blob([protectedBuffer], { type: 'application/octet-stream' });
  }

  async function processBaseArchive(sourceBlob, plan, onProgress) {
    const outer = await loadArchive(sourceBlob, plan.sourceFileName);
    Object.keys(outer.files).forEach(path => { if (isSystemEntry(path)) outer.remove(path); });
    const innerEntries = Object.values(outer.files).filter(entry => !entry.dir && INNER_PACKAGE_EXTENSIONS.has(extension(entry.name)));
    if (!innerEntries.length) {
      // 与小程序本地构建一致：只有后缀像底包但实际没有内层包时，按普通皮肤包处理。
      return processSkinArchiveBlob(sourceBlob, plan, { onProgress });
    }
    for (let index = 0; index < innerEntries.length; index++) {
      const entry = innerEntries[index];
      onProgress(`正在处理底包内层 ${index + 1}/${innerEntries.length}：${baseName(entry.name)}`, Math.round(index / innerEntries.length * 80));
      const innerPlan = { ...plan, sourceFileName: entry.name, outputFileName: baseName(entry.name) };
      const processed = await processSkinArchiveBlob(await entry.async('blob'), innerPlan, {
        skipArchiveEncryption: true,
        modifyMaterials: false,
        onProgress: text => onProgress(text, Math.round((index + 0.5) / innerEntries.length * 80)),
      });
      outer.file(entry.name, processed, { binary: true });
    }
    onProgress('正在完成底包打包...', 85);
    return outer.generateAsync(
      { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 }, streamFiles: true },
      metadata => onProgress(`正在完成底包打包 ${Math.round(metadata.percent || 0)}%`, 85 + Math.round((metadata.percent || 0) * 0.15))
    );
  }

  async function processDownloadedBlob(sourceBlob, plan, onProgress) {
    if (plan.packageMode === 'font') {
      onProgress('正在校验字体文件...', 5);
      const marked = await markFontBuffer(await sourceBlob.arrayBuffer(), plan.sourceFileName, state.manifest.watermarkMessage);
      onProgress('字体本地处理完成', 100);
      return new Blob([marked], { type: 'application/octet-stream' });
    }
    if (!ARCHIVE_EXTENSIONS.has(extension(plan.sourceFileName))) {
      throw new LocalUnsupportedError(`文件类型不支持浏览器本地构建：${plan.sourceFileName}`);
    }
    if (plan.packageMode === 'base-archive') return processBaseArchive(sourceBlob, plan, onProgress);
    return processSkinArchiveBlob(sourceBlob, plan, {
      skipArchiveEncryption: plan.packageMode === 'base-inner',
      modifyMaterials: plan.packageMode !== 'base-inner',
      onProgress,
    });
  }

  async function md5Blob(blob, onProgress) {
    const chunkSize = 4 * 1024 * 1024;
    const chunks = Math.max(1, Math.ceil(blob.size / chunkSize));
    const spark = new SparkMD5.ArrayBuffer();
    for (let index = 0; index < chunks; index++) {
      spark.append(await blob.slice(index * chunkSize, Math.min(blob.size, (index + 1) * chunkSize)).arrayBuffer());
      onProgress?.(`正在校验成品 ${index + 1}/${chunks}`, Math.round((index + 1) / chunks * 100));
      if (index % 4 === 3) await wait(0);
    }
    return spark.end();
  }

  function uploadOfficial(blob, params, onProgress) {
    return new Promise((resolve, reject) => {
      let retryCount = 0;
      const startAttempt = () => {
        const xhr = new XMLHttpRequest();
        let finished = false;
        const retryNetwork = () => {
          if (finished) return;
          finished = true;
          retryCount += 1;
          const delay = retry522Delay(retryCount);
          onProgress(retry522Text('网盘上传节点', retryCount, delay), 0);
          setTimeout(startAttempt, delay);
        };
        xhr.open('POST', params.uploadUrl, true);
        xhr.setRequestHeader('Authorization', `Bearer ${params.accessToken}`);
        xhr.setRequestHeader('Platform', 'open_platform');
        xhr.upload.onprogress = event => {
          if (event.lengthComputable) onProgress(`正在保存到您的网盘 ${Math.round(event.loaded / event.total * 100)}%`, Math.round(event.loaded / event.total * 100));
        };
        xhr.onerror = retryNetwork;
        xhr.ontimeout = retryNetwork;
        xhr.onload = () => {
          if (finished) return;
          if (xhr.status === HTTP_522_STATUS || xhr.status === 0) { retryNetwork(); return; }
          finished = true;
          let payload = {};
          try { payload = JSON.parse(xhr.responseText || '{}'); } catch (_) {}
          if (xhr.status < 200 || xhr.status >= 300 || ![undefined, null, 0, '0', 200, '200'].includes(payload.code)) {
            reject(new Error(payload.message || payload.msg || `网盘上传失败(${xhr.status})`));
            return;
          }
          const data = payload.data || payload;
          const fileId = Number(data.fileID || data.fileId || data.file_id || 0);
          if (!Number.isFinite(fileId) || fileId <= 0) { reject(new Error('网盘上传响应缺少文件编号')); return; }
          resolve(Math.floor(fileId));
        };
        const form = new FormData();
        form.append('parentFileID', String(params.parentFileID));
        form.append('filename', params.filename);
        form.append('etag', params.etag);
        form.append('size', String(params.size));
        form.append('duplicate', String(params.duplicate || 2));
        form.append('file', blob, params.filename);
        xhr.timeout = Math.min(Math.max(120000, Math.ceil(blob.size / 1024 / 1024) * 10000), 30 * 60 * 1000);
        xhr.send(form);
      };
      startAttempt();
    });
  }

  async function processOne(plan, fileIndex, fileCount) {
    const progress = (text, value) => updateFileProgress(plan.fileKey, text, value, overallForFile(fileIndex, fileCount, value));
    progress('正在获取服务器下发文件计划...', 0);
    const source = await downloadSourceFile(plan, (text, value) => progress(text, Math.round(Number(value || 0) * 0.3)));
    progress('正在浏览器本地处理...', 32);
    const processed = await processDownloadedBlob(source, plan, (text, value) => progress(text, 32 + Math.round(Number(value || 0) * 0.38)));
    const md5 = await md5Blob(processed, (text, value) => progress(text, 70 + Math.round(Number(value || 0) * 0.05)));
    const upload = await apiPost(
      '/api/member/local-build-h5/prepare-upload',
      { sessionToken: state.sessionToken, fileKey: plan.fileKey, fileSize: processed.size, fileMd5: md5 },
      (count, delay) => progress(retry522Text('上传准备服务', count, delay), 75)
    );
    let fileId = 0;
    try {
      fileId = await uploadOfficial(processed, upload, (text, value) => progress(text, 75 + Math.round(Number(value || 0) * 0.2)));
    } finally {
      upload.accessToken = '';
    }
    await apiPost(
      '/api/member/local-build-h5/complete-upload',
      { sessionToken: state.sessionToken, fileKey: plan.fileKey, pan123FileId: fileId },
      (count, delay) => progress(retry522Text('上传结果服务', count, delay), 96)
    );
    progress('文件处理完成', 100);
  }

  async function abortSession() {
    return apiPost('/api/member/local-build-h5/abort', { sessionToken: state.sessionToken });
  }

  async function fail(error) {
    const message = error instanceof Error ? error.message : String(error || '处理失败');
    let fallbackAllowed = false;
    const isLocalUnsupported = error instanceof LocalUnsupportedError || (error && error.code === 'LOCAL_UNSUPPORTED');
    try {
      const aborted = await abortSession();
      fallbackAllowed = isLocalUnsupported && aborted.cleaned === true;
    } catch (_) {
      fallbackAllowed = false;
    }
    state.finished = true;
    setStatus(message, true);
    postMessage({
      type: 'memberLocalBuildResult',
      complete: true,
      success: false,
      code: error && error.code || (isLocalUnsupported ? 'LOCAL_UNSUPPORTED' : 'PROCESS_FAILED'),
      fallbackAllowed,
      error: message,
    });
    navigateBack();
  }

  async function start() {
    const params = parseHash();
    state.sessionToken = String(params.sessionToken || '').trim();
    state.apiBase = String(params.apiBase || '').trim().replace(/\/+$/, '');
    if (params.mode !== 'memberLocalBuild' || !state.sessionToken || !/^https:\/\//i.test(state.apiBase)) {
      throw new Error('服务器下发文件会话参数无效');
    }

    const manifest = await apiPost(
      '/api/member/local-build-h5/status',
      { sessionToken: state.sessionToken },
      (count, delay) => setStatus(retry522Text('文件会话服务', count, delay))
    );
    state.manifest = manifest;
    const completed = (manifest.files || []).filter(item => item.status === 'completed');
    const plans = (manifest.files || []).filter(item => item.status !== 'completed');
    const fallbackCount = Math.max(0, Number(manifest.fallbackCount || 0));
    summaryEl.textContent = fallbackCount > 0
      ? `本地构建 ${manifest.files.length} 个文件；另有 ${fallbackCount} 个不支持文件将在返回小程序后单独提交服务器处理。`
      : `共 ${manifest.files.length} 个文件，浏览器将依次处理并保存到您的网盘。`;
    renderFiles(manifest.files || []);
    completed.forEach(item => updateFileProgress(item.fileKey, '已完成', 100, 0));

    for (let index = 0; index < plans.length; index++) {
      await processOne(plans[index], completed.length + index, manifest.files.length);
    }
    setStatus('正在整理交付目录...');
    const result = await apiPost(
      '/api/member/local-build-h5/finalize',
      { sessionToken: state.sessionToken },
      (count, delay) => setStatus(retry522Text('交付目录服务', count, delay))
    );
    state.finished = true;
    setOverallProgress(100);
    setStatus('服务器下发文件处理完成，正在返回会员专区...');
    postMessage({
      type: 'memberLocalBuildResult',
      complete: true,
      success: true,
      taskId: result.taskId,
      folderId: result.folderId,
      folderPath: result.folderPath,
      fileCount: result.fileCount,
    });
    navigateBack();
  }

  window.addEventListener('pagehide', () => {
    void releaseDownloadSlot(true);
    if (!state.finished && state.sessionToken && state.apiBase) {
      // 用户手动关闭 WebView 时尽力回收隐藏临时目录。keepalive 只发送小 JSON，
      // 真正的网盘回收由 Server 接管，不在 pagehide 阶段等待外部 HTTP 完成。
      void fetch(`${state.apiBase}/api/member/local-build-h5/abort`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionToken: state.sessionToken }),
        cache: 'no-store',
        credentials: 'omit',
        keepalive: true,
      }).catch(() => {});
    }
  });

  start().catch(error => fail(error));
})();
