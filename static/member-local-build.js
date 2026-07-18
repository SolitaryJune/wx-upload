(() => {
  'use strict';

  const HTTP_522_STATUS = 522;
  const HTTP_522_RETRY_BASE_DELAY_MS = 800;
  const HTTP_522_RETRY_MAX_DELAY_MS = 8000;
  const CONTROL_REQUEST_MAX_RETRIES = 8;
  const INVALID_SERVER_RESPONSE_MAX_RETRIES = 3;
  const PAN123_UPLOAD_MAX_ATTEMPTS = 3;
  const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
  const BAIDU_TMP_UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;
  const BAIDU_TMP_UPLOAD_MAX_ATTEMPTS = 3;
  const BAIDU_UPLOAD_CONFIRM_MAX_CYCLES = 3;
  const FILE_WORKER_CONCURRENCY = 2;
  const DOWNLOAD_CONCURRENCY = 2;
  const HEAVY_PROCESS_CONCURRENCY = 1;
  const PAN123_UPLOAD_CONCURRENCY = 2;
  const BAIDU_UPLOAD_CONCURRENCY = 1;
  const LEASE_RENEW_INTERVAL_MS = 60 * 1000;
  const SESSION_HEARTBEAT_INTERVAL_MS = 5 * 60 * 1000;
  const BAIDU_UPLOAD_BLOCK_SIZE = 4 * 1024 * 1024;
  const AUDIO_PROCESS_MAX_BYTES = 24 * 1024 * 1024;
  const ARCHIVE_MAX_ENTRIES = 20000;
  const ARCHIVE_MAX_UNCOMPRESSED_BYTES = 2 * 1024 * 1024 * 1024;
  const ARCHIVE_MAX_COMPRESSION_RATIO = 300;
  const MAX_FONT_WORKER_SOURCE_CHARS = 2 * 1024 * 1024;
  // 自研 Worker 由独立资产网关解密返回；wx-upload 公开仓不再保存另一份明文副本。
  // Worker 会从同一 Gateway 目录加载公开的 font-marker.vendor.js。
  const FONT_WORKER_URL = 'https://tools.beautify.mp.juneover24.cn/font-marker-local/marker.worker.js';
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
    tasks: new Map(),
    downloadLeases: new Map(),
    uploadLeases: new Map(),
    abortControllers: new Set(),
    xhrs: new Set(),
    workers: new Set(),
    fontWorkerScriptPromise: null,
    fontWorkerBlobUrl: '',
    failedFileKeys: new Set(),
    paused: false,
    cancelled: false,
    processing: false,
    overallProgress: 0,
    sessionHeartbeat: 0,
    finished: false,
  };

  const summaryEl = document.getElementById('summary');
  const statusEl = document.getElementById('status');
  const overallProgressEl = document.getElementById('overallProgress');
  const filesEl = document.getElementById('files');
  const statsEl = document.getElementById('stats');
  const retryButtonEl = document.getElementById('retryButton');
  const cancelButtonEl = document.getElementById('cancelButton');

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

  function createSemaphore(limit) {
    let active = 0;
    const waiters = [];
    const acquire = () => new Promise(resolve => {
      if (active < limit) {
        active += 1;
        resolve();
        return;
      }
      waiters.push(resolve);
    });
    const release = () => {
      const next = waiters.shift();
      if (next) next();
      else active = Math.max(0, active - 1);
    };
    return {
      async run(callback) {
        await acquire();
        try { return await callback(); }
        finally { release(); }
      },
    };
  }

  const downloadSemaphore = createSemaphore(DOWNLOAD_CONCURRENCY);
  const processSemaphore = createSemaphore(HEAVY_PROCESS_CONCURRENCY);
  const pan123UploadSemaphore = createSemaphore(PAN123_UPLOAD_CONCURRENCY);
  const baiduUploadSemaphore = createSemaphore(BAIDU_UPLOAD_CONCURRENCY);

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

  function createDiagnosticEventId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return `h5_${Date.now()}_${crypto.getRandomValues(new Uint32Array(2)).join('_')}`;
  }

  function sanitizeDiagnosticMessage(value) {
    return String(value || '')
      .replace(/https?:\/\/\S+\?\S+/gi, '[REDACTED_URL]')
      .replace(/(access[_-]?token|authorization|session[_-]?token|upload[_-]?url)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
      .slice(0, 500);
  }

  /**
   * 诊断上报是旁路能力，绝不能成为文件流程的新失败点。只发送白名单元数据，
   * Server 会从 sessionToken/fileKey 对应会话补齐可信 QQ、群和文件名。
   */
  function reportUploadError(plan, details) {
    if (!state.sessionToken || !plan?.fileKey || !state.apiBase) return Promise.resolve();
    const payload = {
      sessionToken: state.sessionToken,
      fileKey: plan.fileKey,
      eventId: String(details.eventId || createDiagnosticEventId()),
      stage: String(details.stage || 'upload').slice(0, 80),
      errorCode: String(details.errorCode || 'H5_UPLOAD_ERROR').slice(0, 100),
      provider: String(details.provider || 'pan123').slice(0, 20),
      message: sanitizeDiagnosticMessage(details.message),
      httpStatus: Number.isFinite(Number(details.httpStatus)) ? Number(details.httpStatus) : null,
      readyState: Number.isFinite(Number(details.readyState)) ? Number(details.readyState) : null,
      responseLength: Number.isFinite(Number(details.responseLength)) ? Number(details.responseLength) : null,
      contentType: String(details.contentType || '').slice(0, 120),
      jsonParseSucceeded: typeof details.jsonParseSucceeded === 'boolean' ? details.jsonParseSucceeded : null,
      payloadCode: String(details.payloadCode ?? '').slice(0, 80),
      dataKeys: Array.isArray(details.dataKeys) ? details.dataKeys.slice(0, 20).map(key => String(key).slice(0, 40)) : [],
      uploadAttempt: Number.isFinite(Number(details.uploadAttempt)) ? Number(details.uploadAttempt) : null,
      networkRetryCount: Number.isFinite(Number(details.networkRetryCount)) ? Number(details.networkRetryCount) : null,
      elapsedMs: Number.isFinite(Number(details.elapsedMs)) ? Number(details.elapsedMs) : null,
      timeoutMs: Number.isFinite(Number(details.timeoutMs)) ? Number(details.timeoutMs) : null,
      fallbackAttempted: typeof details.fallbackAttempted === 'boolean' ? details.fallbackAttempted : null,
      fallbackSucceeded: typeof details.fallbackSucceeded === 'boolean' ? details.fallbackSucceeded : null,
    };
    const url = `${state.apiBase}/api/member/local-build-h5/report-error`;
    const body = JSON.stringify(payload);
    return fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
      cache: 'no-store', credentials: 'omit', keepalive: true,
    }).catch(() => {
      try { navigator.sendBeacon?.(url, new Blob([body], { type: 'application/json' })); } catch (_) {}
    }).then(() => undefined);
  }

  async function fetchUntilNon522(url, options, onRetry) {
    let retryCount = 0;
    while (true) {
      let response;
      try {
        response = await fetch(url, options);
      } catch (error) {
        if (state.cancelled || (error && error.name === 'AbortError')) throw error;
        // CDN 522 错误页缺少 CORS 头时浏览器只能看到 TypeError。控制面使用有限
        // 退避重放；达到上限后显式失败并进入诊断上报，避免页面永久等待。
        retryCount += 1;
        if (retryCount > CONTROL_REQUEST_MAX_RETRIES) {
          const exhausted = new Error('服务连接多次失败，请稍后重试');
          exhausted.code = 'CONTROL_REQUEST_RETRY_EXHAUSTED';
          throw exhausted;
        }
        const delayMs = retry522Delay(retryCount);
        onRetry?.(retryCount, delayMs, error);
        await wait(delayMs);
        continue;
      }
      if (response.status !== HTTP_522_STATUS) return response;
      retryCount += 1;
      if (retryCount > CONTROL_REQUEST_MAX_RETRIES) {
        const exhausted = new Error('服务节点持续超时，请稍后重试');
        exhausted.code = 'CONTROL_REQUEST_RETRY_EXHAUSTED';
        throw exhausted;
      }
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

  function normalizeProgress(progress) {
    if (progress === null || progress === undefined || progress === '') return null;
    const value = Number(progress);
    return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
  }

  function monotonicProgress(previous, progress) {
    const next = normalizeProgress(progress);
    const current = normalizeProgress(previous) ?? 0;
    return next === null ? current : Math.max(current, next);
  }

  function setOverallProgress(progress) {
    const next = normalizeProgress(progress);
    if (next === null) return;
    // 多文件会并发上报、上传也可能重试。总体进度只允许向前，避免较慢任务或
    // Pan123 第二次上传把已经显示的进度从 96% 拉回 75%。
    const value = monotonicProgress(state.overallProgress, next);
    state.overallProgress = value;
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
    const explicitSuccess = payload.success === true || [0, '0', 200, '200'].includes(code);
    if (payload.success === false || !explicitSuccess) {
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
    const responseText = await response.text();
    let payload;
    try { payload = JSON.parse(responseText); }
    catch (_) {
      const error = new Error(`服务响应格式异常(${response.status})`);
      error.statusCode = response.status;
      error.code = 'SERVER_RESPONSE_INVALID';
      error.diagnostic = {
        eventId: createDiagnosticEventId(), stage: 'server_response', errorCode: 'SERVER_RESPONSE_INVALID',
        message: error.message, httpStatus: response.status, responseLength: responseText.length,
        contentType: response.headers.get('content-type') || '', jsonParseSucceeded: false, dataKeys: [],
      };
      throw error;
    }
    if (!response.ok) {
      const detail = payload && payload.detail;
      const message = typeof detail === 'object'
        ? detail.message
        : (detail || payload.message || `接口响应异常(${response.status})`);
      const error = new Error(String(message));
      error.statusCode = response.status;
      error.retryAfterSeconds = Math.max(
        1,
        Number(typeof detail === 'object' && detail.retryAfterSeconds || response.headers.get('retry-after') || 2)
      );
      if (typeof detail === 'object' && detail.code) error.code = detail.code;
      error.retryable = Boolean(typeof detail === 'object' && detail.retryable);
      throw error;
    }
    return unwrapApiData(payload, `接口响应异常(${response.status})`);
  }

  async function apiPostWhenReady(path, data, onWait) {
    let invalidResponseRetries = 0;
    while (true) {
      if (state.cancelled) throw new DOMException('Aborted', 'AbortError');
      try {
        const result = await apiPost(path, data, (count, delay) => onWait?.(retry522Text('服务', count, delay)));
        if (!result.pending) return result;
        const delaySeconds = Math.max(1, Number(result.retryAfterSeconds || 2));
        onWait?.('同一文件正在由服务器确认，稍后继续...');
        await wait(delaySeconds * 1000);
      } catch (error) {
        if (error && error.code === 'SERVER_RESPONSE_INVALID' && invalidResponseRetries < INVALID_SERVER_RESPONSE_MAX_RETRIES) {
          invalidResponseRetries += 1;
          const delay = retry522Delay(invalidResponseRetries);
          onWait?.(`服务响应不完整，${Math.ceil(delay / 1000)} 秒后重新确认`);
          await wait(delay);
          continue;
        }
        if (Number(error && error.statusCode || 0) !== 429) throw error;
        const delaySeconds = Math.max(1, Number(error.retryAfterSeconds || 2));
        onWait?.(error.message || '当前任务较多，正在等待空闲通道...');
        await wait(delaySeconds * 1000);
      }
    }
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

  function updateStats() {
    const tasks = Array.from(state.tasks.values());
    const completed = tasks.filter(task => task.status === 'completed').length;
    const delegated = tasks.filter(task => task.status === 'delegated').length;
    const failed = tasks.filter(task => task.status === 'failed').length;
    const active = tasks.filter(task => ['downloading', 'processing', 'uploading'].includes(task.status)).length;
    if (statsEl) statsEl.textContent = `完成 ${completed} · 转服务器 ${delegated} · 处理中 ${active} · 失败 ${failed}`;
    if (retryButtonEl) retryButtonEl.hidden = failed === 0 || state.processing;
  }

  function taskOverallProgress() {
    const tasks = Array.from(state.tasks.values());
    if (!tasks.length) return 0;
    return Math.round(tasks.reduce((sum, task) => sum + Math.max(0, Math.min(100, Number(task.progress || 0))), 0) / tasks.length);
  }

  function updateFileProgress(fileKey, text, progress, overallProgress) {
    const task = state.tasks.get(String(fileKey || ''));
    const requestedProgress = normalizeProgress(progress);
    const displayedProgress = task && requestedProgress !== null
      ? monotonicProgress(task.progress, requestedProgress)
      : requestedProgress;
    if (task && requestedProgress !== null) task.progress = displayedProgress;
    const row = filesEl.querySelector(`[data-file-key="${CSS.escape(String(fileKey || ''))}"]`);
    if (row) {
      row.querySelector('.file-meta').textContent = String(text || '正在处理');
      if (displayedProgress !== null) {
        row.querySelector('.file-progress i').style.width = `${displayedProgress}%`;
      }
    }
    const requestedOverall = normalizeProgress(overallProgress);
    setOverallProgress(requestedOverall === null ? taskOverallProgress() : requestedOverall);
    setStatus(text || '正在处理服务器下发文件...');
    updateStats();
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
      renewUrl: new URL('/api/cloud-download/pan123-h5-download-slot/renew', url).toString(),
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
        if (signal && signal.aborted) throw new DOMException('Aborted', 'AbortError');
      }
    }
  }

  function registerController(controller) {
    state.abortControllers.add(controller);
    return controller;
  }

  function unregisterController(controller) {
    state.abortControllers.delete(controller);
  }

  function trackDownloadLease(fileKey, credential) {
    const key = String(fileKey || '');
    const current = state.downloadLeases.get(key);
    if (current && current.leaseId === credential.leaseId) return;
    if (current) void releaseDownloadSlot(key);
    const lease = {
      leaseId: credential.leaseId,
      releaseUrl: credential.releaseUrl,
      renewUrl: credential.renewUrl,
      timer: 0,
    };
    lease.timer = setInterval(() => {
      void fetch(lease.renewUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ leaseId: lease.leaseId }),
        cache: 'no-store',
        credentials: 'omit',
      }).catch(() => {});
    }, LEASE_RENEW_INTERVAL_MS);
    state.downloadLeases.set(key, lease);
  }

  async function releaseDownloadSlot(fileKey, keepalive = false) {
    const key = String(fileKey || '');
    const lease = state.downloadLeases.get(key);
    state.downloadLeases.delete(key);
    if (lease && lease.timer) clearInterval(lease.timer);
    const leaseId = String(lease && lease.leaseId || '');
    const releaseUrl = String(lease && lease.releaseUrl || '');
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

  function trackUploadLease(fileKey, leaseId) {
    const key = String(fileKey || '');
    if (!leaseId) return;
    const current = state.uploadLeases.get(key);
    if (current && current.leaseId === leaseId) return;
    if (current) void releaseUploadSlot(key);
    const lease = { leaseId: String(leaseId), timer: 0 };
    lease.timer = setInterval(() => {
      void fetch(`${state.apiBase}/api/member/local-build-h5/renew-upload-slot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionToken: state.sessionToken, fileKey: key, leaseId: lease.leaseId }),
        cache: 'no-store',
        credentials: 'omit',
      }).catch(() => {});
    }, LEASE_RENEW_INTERVAL_MS);
    state.uploadLeases.set(key, lease);
  }

  async function releaseUploadSlot(fileKey, keepalive = false) {
    const key = String(fileKey || '');
    const lease = state.uploadLeases.get(key);
    state.uploadLeases.delete(key);
    if (lease && lease.timer) clearInterval(lease.timer);
    if (!lease || !state.apiBase || !state.sessionToken) return;
    try {
      await fetch(`${state.apiBase}/api/member/local-build-h5/release-upload-slot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionToken: state.sessionToken, fileKey: key, leaseId: lease.leaseId }),
        cache: 'no-store',
        credentials: 'omit',
        keepalive,
      });
    } catch (_) {}
  }

  async function releaseAllLeases(keepalive = false) {
    await Promise.all([
      ...Array.from(state.downloadLeases.keys()).map(key => releaseDownloadSlot(key, keepalive)),
      ...Array.from(state.uploadLeases.keys()).map(key => releaseUploadSlot(key, keepalive)),
    ]);
  }

  function startSessionHeartbeat() {
    if (state.sessionHeartbeat) clearInterval(state.sessionHeartbeat);
    state.sessionHeartbeat = setInterval(() => {
      if (state.finished || state.cancelled || state.paused) return;
      void fetch(`${state.apiBase}/api/member/local-build-h5/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionToken: state.sessionToken }),
        cache: 'no-store',
        credentials: 'omit',
      }).catch(() => {});
    }, SESSION_HEARTBEAT_INTERVAL_MS);
  }

  function stopSessionHeartbeat() {
    if (state.sessionHeartbeat) clearInterval(state.sessionHeartbeat);
    state.sessionHeartbeat = 0;
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
      if (signal.aborted) {
        try { await reader.cancel(); } catch (_) {}
        throw new DOMException('Aborted', 'AbortError');
      }
      const item = await reader.read();
      if (item.done) break;
      if (item.value && item.value.length) {
        received += item.value.length;
        if (expectedSize > 0 && received > expectedSize) {
          try { await reader.cancel(); } catch (_) {}
          throw new Error('服务器下发文件超过预期大小');
        }
        chunks.push(item.value);
        // 未知总长度时只能报告已接收字节数，不能持续上报一个虚假的 0%。调用方
        // 收到 null 后保留当前进度条，仅更新“已接收 xx MB”的阶段文案。
        onProgress?.(expectedSize > 0 ? Math.round(received / expectedSize * 100) : null, received, expectedSize);
      }
    }
    if (expectedSize > 0 && received !== expectedSize) {
      throw new Error(`服务器下发文件大小校验失败：预期 ${expectedSize}，实际 ${received}`);
    }
    return new Blob(chunks, { type: 'application/octet-stream' });
  }

  async function downloadSourceFile(plan, onProgress) {
    return downloadSemaphore.run(() => downloadSourceFileWithSlot(plan, onProgress));
  }

  async function downloadSourceFileWithSlot(plan, onProgress) {
    const ticket = await apiPost(
      '/api/member/local-build-h5/download-ticket',
      { sessionToken: state.sessionToken, fileKey: plan.fileKey },
      (count, delay) => onProgress(retry522Text('文件计划服务', count, delay), 0)
    );
    const credentialUrl = String(ticket.credentialUrl || '').trim();
    const credentialTicket = String(ticket.credentialTicket || '').trim();
    if (!/^https:\/\//i.test(credentialUrl) || !credentialTicket) throw new Error('服务器下发文件参数无效');

    const controller = registerController(new AbortController());
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      let credential = await exchangeCredentialWhenAvailable(
        credentialUrl,
        credentialTicket,
        false,
        controller.signal,
        text => onProgress(text, 0)
      );
      trackDownloadLease(plan.fileKey, credential);
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
        trackDownloadLease(plan.fileKey, credential);
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
      await releaseDownloadSlot(plan.fileKey);
      return blob;
    } finally {
      clearTimeout(timer);
      unregisterController(controller);
      await releaseDownloadSlot(plan.fileKey);
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

  async function getFontWorkerScriptUrl() {
    if (state.fontWorkerScriptPromise) return state.fontWorkerScriptPromise;
    state.fontWorkerScriptPromise = (async () => {
      const workerUrl = new URL(FONT_WORKER_URL, window.location.href);
      if (workerUrl.origin === window.location.origin) return workerUrl.href;

      // 浏览器禁止 Worker() 直接执行跨域 URL。分别通过 CORS 获取公开 vendor 和由
      // Gateway 解密的自研段，再在当前页面创建 Blob Worker，避免把自研明文放回
      // wx-upload 公开仓库。Worker 启动壳检测到 vendor 全局后不会再解析 blob: 相对路径。
      const vendorUrl = new URL('./font-marker.vendor.js', workerUrl).href;
      const controller = new AbortController();
      state.abortControllers.add(controller);
      try {
        const responses = await Promise.all([vendorUrl, workerUrl.href].map(url => fetch(url, {
          method: 'GET',
          credentials: 'omit',
          cache: 'no-cache',
          redirect: 'follow',
          signal: controller.signal,
        })));
        for (const response of responses) {
          if (!response.ok) throw new LocalUnsupportedError(`字体 Worker 资源加载失败（HTTP ${response.status}）`);
          const contentLength = Number(response.headers.get('content-length') || 0);
          if (contentLength > MAX_FONT_WORKER_SOURCE_CHARS) {
            throw new LocalUnsupportedError('字体 Worker 资源过大');
          }
        }
        const sources = await Promise.all(responses.map(response => response.text()));
        if (sources.some(source => source.length > MAX_FONT_WORKER_SOURCE_CHARS)) {
          throw new LocalUnsupportedError('字体 Worker 资源过大');
        }
        state.fontWorkerBlobUrl = URL.createObjectURL(new Blob([
          sources[0],
          '\n',
          sources[1],
        ], { type: 'text/javascript' }));
        return state.fontWorkerBlobUrl;
      } finally {
        state.abortControllers.delete(controller);
      }
    })().catch(error => {
      state.fontWorkerScriptPromise = null;
      throw error;
    });
    return state.fontWorkerScriptPromise;
  }

  async function markFontBuffer(buffer, filename, message) {
    inspectFontContainer(buffer);
    const workerScriptUrl = await getFontWorkerScriptUrl();
    return new Promise((resolve, reject) => {
      let settled = false;
      const worker = new Worker(workerScriptUrl);
      state.workers.add(worker);
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        state.workers.delete(worker);
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
      worker.postMessage({
        id: `font_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        bytes: buffer,
        filename,
        metadata: { message, marker: 'GuShao' },
        keyText: FONT_STEGO_KEY,
      }, [buffer]);
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
    // 微信 WebView 的部分内核没有 Array/String.prototype.at；这里使用传统下标，
    // 否则处理带引号的 archive comment 时会直接抛出 ``parts.at is not a function``。
    if (core.length >= 2 && ['"', "'"].includes(core[0]) && core[core.length - 1] === core[0]) {
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
      (parts.length > 0 && SYSTEM_NAMES.has(parts[parts.length - 1].toLowerCase()));
  }

  function validateArchiveEntries(zip, compressedSize) {
    const normalized = new Set();
    let fileCount = 0;
    let totalUncompressed = 0;
    Object.entries(zip.files).forEach(([name, entry]) => {
      // JSZip 3 会把 ../ 从 entry.name 中净化，并把原始名称放在
      // unsafeOriginalName。安全检查必须优先看原始值，否则 ZipSlip 只会被悄悄改名。
      const originalName = entry.unsafeOriginalName || name;
      const clean = String(originalName || '').replace(/\\/g, '/');
      const parts = clean.split('/').filter(Boolean);
      if (clean.startsWith('/') || /^[A-Za-z]:\//.test(clean) || parts.some(part => part === '..' || part.includes('\0'))) {
        throw new LocalUnsupportedError(`压缩包包含不安全路径：${name}`);
      }
      const key = parts.join('/').toLowerCase();
      if (key && normalized.has(key)) throw new LocalUnsupportedError(`压缩包包含重复路径：${name}`);
      if (key) normalized.add(key);
      if (!entry.dir) {
        fileCount += 1;
        const entrySize = Math.max(0, Number(entry._data && entry._data.uncompressedSize || 0));
        totalUncompressed += entrySize;
      }
    });
    if (fileCount > ARCHIVE_MAX_ENTRIES) {
      throw new LocalUnsupportedError(`压缩包文件数量过多：${fileCount}`);
    }
    if (totalUncompressed > ARCHIVE_MAX_UNCOMPRESSED_BYTES) {
      throw new LocalUnsupportedError(`压缩包解压后体积过大：${formatBytes(totalUncompressed)}`);
    }
    if (compressedSize > 0 && totalUncompressed / compressedSize > ARCHIVE_MAX_COMPRESSION_RATIO) {
      throw new LocalUnsupportedError('压缩包压缩比异常，无法安全在浏览器处理');
    }
  }

  function isEncryptedArchiveError(error) {
    return /encrypt|password|密码|加密/i.test(String(error && error.message || error || ''));
  }

  async function loadArchive(blob, label) {
    try {
      // checkCRC32 会在 load 阶段预解压所有条目，随后业务处理又解压一次，既慢又会让
      // 压缩炸弹在中央目录预检前展开。这里先只读取目录并完成路径/体积/压缩比校验。
      const zip = await JSZip.loadAsync(blob, { checkCRC32: false, createFolders: true });
      validateArchiveEntries(zip, blob.size);
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

  function mapBaseArchiveInnerProgress(index, innerCount, innerProgress) {
    const count = Math.max(1, Number(innerCount || 0));
    const safeIndex = Math.max(0, Math.min(count - 1, Number(index || 0)));
    const safeInnerProgress = Math.max(0, Math.min(100, Number(innerProgress || 0)));
    // 内层处理总共占外层进度的 0~80%。每个内层按自己的真实 PNG/字体/音效/
    // 重打包进度占用一段，不能再用固定的 index + 0.5；单内层底包过去因此会在
    // 整个重处理阶段长期停在 40%，映射到小程序总进度后表现为“卡 45/47”。
    return Math.round(((safeIndex + safeInnerProgress / 100) / count) * 80);
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
        onProgress: (text, innerProgress) => onProgress(
          text,
          mapBaseArchiveInnerProgress(index, innerEntries.length, innerProgress)
        ),
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

  async function digestBlobForUpload(blob, onProgress) {
    const chunks = Math.max(1, Math.ceil(blob.size / BAIDU_UPLOAD_BLOCK_SIZE));
    const wholeSpark = new SparkMD5.ArrayBuffer();
    const blockMd5List = [];
    for (let index = 0; index < chunks; index++) {
      const buffer = await blob.slice(
        index * BAIDU_UPLOAD_BLOCK_SIZE,
        Math.min(blob.size, (index + 1) * BAIDU_UPLOAD_BLOCK_SIZE)
      ).arrayBuffer();
      wholeSpark.append(buffer);
      const blockSpark = new SparkMD5.ArrayBuffer();
      blockSpark.append(buffer);
      blockMd5List.push(blockSpark.end());
      onProgress?.(`正在校验成品 ${index + 1}/${chunks}`, Math.round((index + 1) / chunks * 100));
      if (index % 4 === 3) await wait(0);
    }
    return { fileMd5: wholeSpark.end(), blockMd5List };
  }

  function normalizeOfficialFileId(payload, responseText) {
    const data = payload && payload.data && typeof payload.data === 'object' ? payload.data : payload;
    const value = data && (data.fileID ?? data.fileId ?? data.file_id);
    let text = String(value ?? '').trim();
    if (typeof value === 'number' && !Number.isSafeInteger(value)) {
      const match = String(responseText || '').match(/"(?:fileID|fileId|file_id)"\s*:\s*"?(\d+)"?/);
      if (match) text = match[1];
    }
    if (!/^\d+$/.test(text)) return '';
    text = text.replace(/^0+(?=\d)/, '');
    return text !== '0' ? text : '';
  }

  function uploadPan123Official(fileKey, blob, params, onProgress, uploadAttempt) {
    return pan123UploadSemaphore.run(() => new Promise((resolve, reject) => {
      if (state.cancelled) { reject(new DOMException('Aborted', 'AbortError')); return; }
      const xhr = new XMLHttpRequest();
      const startedAt = Date.now();
      state.xhrs.add(xhr);
      let finished = false;
      const settle = callback => {
        if (finished) return;
        finished = true;
        state.xhrs.delete(xhr);
        callback();
      };
      const ambiguous = (errorCode, message) => settle(() => resolve({
        fileId: '',
        ambiguous: true,
        diagnostic: {
          eventId: createDiagnosticEventId(), stage: 'official_upload', errorCode, message,
          httpStatus: xhr.status, readyState: xhr.readyState, responseLength: String(xhr.responseText || '').length,
          contentType: xhr.getResponseHeader('content-type') || '', jsonParseSucceeded: null,
          payloadCode: '', dataKeys: [], uploadAttempt, networkRetryCount: Math.max(0, uploadAttempt - 1),
          elapsedMs: Date.now() - startedAt, timeoutMs: xhr.timeout,
        },
      }));
        xhr.open('POST', params.uploadUrl, true);
        xhr.setRequestHeader('Authorization', `Bearer ${params.accessToken}`);
        xhr.setRequestHeader('Platform', 'open_platform');
        xhr.upload.onprogress = event => {
          if (event.lengthComputable) onProgress(`正在保存到您的网盘 ${Math.round(event.loaded / event.total * 100)}%`, Math.round(event.loaded / event.total * 100));
        };
        xhr.onabort = () => settle(() => reject(new DOMException('Aborted', 'AbortError')));
        xhr.onerror = () => ambiguous('OFFICIAL_UPLOAD_NETWORK_ERROR', '网盘上传连接中断，正在由服务器确认结果');
        xhr.ontimeout = () => ambiguous('OFFICIAL_UPLOAD_TIMEOUT', '网盘上传等待超时，正在由服务器确认结果');
        xhr.onload = () => {
          if (finished) return;
          if (xhr.status === HTTP_522_STATUS || xhr.status === 0 || xhr.status >= 500) {
            ambiguous(`OFFICIAL_UPLOAD_HTTP_${xhr.status || 0}`, `网盘上传节点响应异常(${xhr.status || 0})，正在由服务器确认结果`);
            return;
          }
          let payload;
          let jsonParseSucceeded = true;
          try { payload = JSON.parse(xhr.responseText); }
          catch (_) { payload = {}; jsonParseSucceeded = false; }
          if (xhr.status < 200 || xhr.status >= 300 || ![undefined, null, 0, '0', 200, '200'].includes(payload.code)) {
            const error = new Error(payload.message || payload.msg || `网盘上传失败(${xhr.status})`);
            error.code = `OFFICIAL_UPLOAD_HTTP_${xhr.status}`;
            error.diagnostic = {
              eventId: createDiagnosticEventId(), stage: 'official_upload_response', errorCode: error.code, message: error.message,
              httpStatus: xhr.status, readyState: xhr.readyState, responseLength: String(xhr.responseText || '').length,
              contentType: xhr.getResponseHeader('content-type') || '', jsonParseSucceeded,
              payloadCode: String((payload && payload.code) ?? ''),
              dataKeys: Object.keys(payload && payload.data && typeof payload.data === 'object' ? payload.data : payload || {}),
              uploadAttempt, networkRetryCount: Math.max(0, uploadAttempt - 1),
              elapsedMs: Date.now() - startedAt, timeoutMs: xhr.timeout,
            };
            settle(() => reject(error));
            return;
          }
          const fileId = normalizeOfficialFileId(payload, xhr.responseText);
          if (!fileId) {
            settle(() => resolve({
              fileId: '', ambiguous: true,
              diagnostic: {
                eventId: createDiagnosticEventId(), stage: 'official_upload_response',
                errorCode: jsonParseSucceeded ? 'OFFICIAL_UPLOAD_FILE_ID_MISSING' : 'OFFICIAL_UPLOAD_JSON_INVALID',
                message: jsonParseSucceeded ? '网盘上传响应缺少文件编号' : '网盘上传响应为空或JSON被截断',
                httpStatus: xhr.status, readyState: xhr.readyState, responseLength: String(xhr.responseText || '').length,
                contentType: xhr.getResponseHeader('content-type') || '', jsonParseSucceeded,
                payloadCode: String((payload && payload.code) ?? ''),
                dataKeys: Object.keys(payload && payload.data && typeof payload.data === 'object' ? payload.data : payload || {}),
                uploadAttempt, networkRetryCount: Math.max(0, uploadAttempt - 1),
                elapsedMs: Date.now() - startedAt, timeoutMs: xhr.timeout,
              },
            }));
            return;
          }
          settle(() => resolve({ fileId, ambiguous: false, diagnostic: null }));
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
    }));
  }

  function isRetryableUploadConfirmError(error) {
    const statusCode = Number(error && error.statusCode || 0);
    return statusCode === 0 || statusCode === 408 || statusCode === 429 || statusCode >= 500;
  }

  async function uploadBaiduPart(blob, filename, part, completedBytes, totalUploadBytes, onProgress) {
    let lastError = null;
    for (let attempt = 1; attempt <= BAIDU_TMP_UPLOAD_MAX_ATTEMPTS; attempt++) {
      const controller = window.AbortController ? registerController(new AbortController()) : null;
      const timeoutId = controller ? setTimeout(() => controller.abort(), BAIDU_TMP_UPLOAD_TIMEOUT_MS) : 0;
      try {
        // no-cors 响应是 opaque，浏览器无法读取百度返回的 HTTP 状态。每个 4MB 分片
        // 完成发送后仍需 Server create 才能成为成功事实。
        const form = new FormData();
        form.append('file', blob, filename);
        const percent = Math.round(completedBytes / Math.max(1, totalUploadBytes) * 100);
        onProgress(`正在保存到百度网盘（分片 ${Number(part.partseq) + 1}，尝试 ${attempt}）`, percent);
        await fetch(part.uploadUrl, {
          method: 'POST',
          mode: 'no-cors',
          body: form,
          ...(controller ? { signal: controller.signal } : {}),
        });
        return;
      } catch (error) {
        lastError = error;
        if (state.cancelled || (error && error.name === 'AbortError' && !timeoutId)) throw error;
        if (attempt >= BAIDU_TMP_UPLOAD_MAX_ATTEMPTS) break;
        const delay = Math.min(8000, 1500 * Math.pow(2, attempt - 1));
        onProgress(`百度网盘分片上传中断，${Math.ceil(delay / 1000)} 秒后重试`, 0);
        await wait(delay);
      } finally {
        if (timeoutId) clearTimeout(timeoutId);
        if (controller) unregisterController(controller);
      }
    }
    if (lastError && lastError.name === 'AbortError') throw new Error('百度网盘分片上传超时');
    throw lastError || new Error('百度网盘分片上传失败');
  }

  async function uploadBaiduTmp(blob, filename, uploadParts, onProgress) {
    return baiduUploadSemaphore.run(async () => {
      const parts = Array.isArray(uploadParts) ? uploadParts : [];
      if (!parts.length) throw new Error('百度网盘预上传响应缺少分片地址');
      const totalUploadBytes = parts.reduce((sum, part) => {
        const offset = Math.max(0, Number(part.partseq || 0)) * BAIDU_UPLOAD_BLOCK_SIZE;
        return sum + Math.max(0, Math.min(blob.size, offset + BAIDU_UPLOAD_BLOCK_SIZE) - offset);
      }, 0);
      let completedBytes = 0;
      for (const part of parts) {
        const partseq = Math.max(0, Number(part.partseq || 0));
        const start = partseq * BAIDU_UPLOAD_BLOCK_SIZE;
        const end = Math.min(blob.size, start + BAIDU_UPLOAD_BLOCK_SIZE);
        if (start >= end || !part.uploadUrl) throw new Error('百度网盘分片参数无效');
        const partBlob = blob.slice(start, end);
        await uploadBaiduPart(partBlob, filename, part, completedBytes, totalUploadBytes, onProgress);
        completedBytes += partBlob.size;
        onProgress(`正在保存到百度网盘 ${Math.round(completedBytes / Math.max(1, totalUploadBytes) * 100)}%`, Math.round(completedBytes / Math.max(1, totalUploadBytes) * 100));
      }
    });
  }

  async function completeBaiduUpload(blob, plan, upload, onProgress) {
    const complete = () => apiPostWhenReady(
      '/api/member/local-build-h5/complete-upload',
      { sessionToken: state.sessionToken, fileKey: plan.fileKey },
      text => onProgress(text, 96)
    );

    if (upload.reuse && Number(upload.fsId || 0) > 0) {
      onProgress('正在确认百度网盘秒传结果...', 96);
      return complete();
    }
    if (!Array.isArray(upload.uploadParts) || upload.uploadParts.length === 0) {
      throw new Error('百度网盘预上传响应缺少分片地址');
    }

    let lastError = null;
    for (let cycle = 1; cycle <= BAIDU_UPLOAD_CONFIRM_MAX_CYCLES; cycle++) {
      await uploadBaiduTmp(blob, upload.filename || plan.outputFileName, upload.uploadParts, (text, value) => {
        onProgress(text, 75 + Math.round(Number(value || 0) * 0.2));
      });
      try {
        onProgress('正在确认百度网盘保存结果...', 96);
        return await complete();
      } catch (error) {
        lastError = error;
        // opaque 请求可能隐藏百度数据面 4xx/5xx。只有控制面返回可重试错误时才重放
        // 同一 uploadId 的完整文件体；会话错误、参数错误等 4xx 必须立即停止。
        if (!isRetryableUploadConfirmError(error) || cycle >= BAIDU_UPLOAD_CONFIRM_MAX_CYCLES) {
          throw error;
        }
        const delay = Math.min(8000, 1500 * Math.pow(2, cycle - 1));
        onProgress(`百度网盘保存确认失败，${Math.ceil(delay / 1000)} 秒后重新上传文件体`, 82);
        await wait(delay);
      }
    }
    throw lastError || new Error('百度网盘上传确认失败');
  }

  async function deferUnsupportedFile(task, error) {
    const plan = task.plan;
    const result = await apiPostWhenReady(
      '/api/member/local-build-h5/defer-file',
      {
        sessionToken: state.sessionToken,
        fileKey: plan.fileKey,
        reason: String(error && error.code || 'local_unsupported').toLowerCase(),
        message: String(error && error.message || '浏览器无法处理当前文件'),
      },
      text => updateFileProgress(plan.fileKey, text, task.progress)
    );
    task.status = 'delegated';
    task.error = '';
    task.progress = 100;
    state.failedFileKeys.delete(plan.fileKey);
    updateFileProgress(plan.fileKey, `已转服务器处理：${result.message || error.message}`, 100);
  }

  async function processOne(task) {
    const plan = task.plan;
    const progress = (text, value, stage) => {
      if (stage) task.status = stage;
      updateFileProgress(plan.fileKey, text, value);
    };
    try {
      task.error = '';
      state.failedFileKeys.delete(plan.fileKey);
      progress('正在获取服务器下发文件计划...', 0, 'downloading');
      const source = await downloadSourceFile(plan, (text, value) => {
        const downloadProgress = normalizeProgress(value);
        progress(text, downloadProgress === null ? null : Math.round(downloadProgress * 0.3), 'downloading');
      });
      progress('正在浏览器本地处理...', 32, 'processing');
      const processed = await processSemaphore.run(() => processDownloadedBlob(
        source,
        plan,
        (text, value) => progress(text, 32 + Math.round(Number(value || 0) * 0.38), 'processing')
      ));
      const digest = await digestBlobForUpload(
        processed,
        (text, value) => progress(text, 70 + Math.round(Number(value || 0) * 0.05), 'processing')
      );
      const prepareUpload = () => apiPostWhenReady(
        '/api/member/local-build-h5/prepare-upload', {
          sessionToken: state.sessionToken,
          fileKey: plan.fileKey,
          fileSize: processed.size,
          fileMd5: digest.fileMd5,
          blockMd5List: digest.blockMd5List,
        }, text => progress(text, 75, 'uploading')
      );
      const upload = await prepareUpload();
      if (upload.alreadyCompleted) {
        task.status = 'completed';
        task.progress = 100;
        progress('文件处理完成', 100, 'completed');
        return;
      }
      trackUploadLease(plan.fileKey, upload.uploadLeaseId);
      const provider = String(upload.provider || state.manifest.destinationProvider || '').trim();
      progress('正在等待网盘上传通道...', 75, 'uploading');
      if (provider === 'baidu') {
        await completeBaiduUpload(processed, plan, upload, (text, value) => progress(text, value, 'uploading'));
      } else if (provider === 'pan123') {
        let currentUpload = upload;
        let lastConfirmationError = null;
        for (let uploadAttempt = 1; uploadAttempt <= PAN123_UPLOAD_MAX_ATTEMPTS; uploadAttempt++) {
          let outcome;
          try {
            outcome = await uploadPan123Official(
              plan.fileKey,
              processed,
              currentUpload,
              (text, value) => progress(text, 75 + Math.round(Number(value || 0) * 0.2), 'uploading'),
              uploadAttempt
            );
          } catch (error) {
            void reportUploadError(plan, {
              ...(error && error.diagnostic || {}),
              stage: error && error.diagnostic && error.diagnostic.stage || 'official_upload',
              errorCode: error && error.code || 'OFFICIAL_UPLOAD_FAILED',
              message: error && error.message, uploadAttempt, networkRetryCount: uploadAttempt - 1,
            });
            throw error;
          } finally {
            // 每次 prepare 返回的 AT 只服务当前上传尝试，结束后立即清空引用。
            currentUpload.accessToken = '';
          }

          try {
            await apiPostWhenReady(
              '/api/member/local-build-h5/complete-upload',
              { sessionToken: state.sessionToken, fileKey: plan.fileKey, pan123FileId: outcome.fileId || null },
              text => progress(text, 96, 'uploading')
            );
            if (outcome.diagnostic) {
              void reportUploadError(plan, { ...outcome.diagnostic, fallbackAttempted: true, fallbackSucceeded: true });
            }
            lastConfirmationError = null;
            break;
          } catch (error) {
            lastConfirmationError = error;
            if (outcome.diagnostic) {
              void reportUploadError(plan, {
                ...outcome.diagnostic,
                message: `${outcome.diagnostic.message}；Server确认：${error && error.message || '失败'}`,
                fallbackAttempted: true,
                fallbackSucceeded: false,
              });
            }
            const retryableConfirmation = Boolean(error && error.retryable) || [
              'PAN123_UPLOAD_NOT_VISIBLE', 'PAN123_UPLOAD_METADATA_MISMATCH'
            ].includes(String(error && error.code || ''));
            if (!outcome.ambiguous || !retryableConfirmation || uploadAttempt >= PAN123_UPLOAD_MAX_ATTEMPTS) {
              throw error;
            }
            const delay = retry522Delay(uploadAttempt);
            progress(
              `服务器尚未确认远端文件，${Math.ceil(delay / 1000)} 秒后重新获取上传参数（第 ${uploadAttempt + 1} 次）`,
              75,
              'uploading'
            );
            await wait(delay);
            currentUpload = await prepareUpload();
            if (currentUpload.alreadyCompleted) {
              lastConfirmationError = null;
              break;
            }
            trackUploadLease(plan.fileKey, currentUpload.uploadLeaseId);
          }
        }
        if (lastConfirmationError) throw lastConfirmationError;
      } else {
        throw new Error('本地构建目标网盘无效');
      }
      task.status = 'completed';
      task.progress = 100;
      progress('文件处理完成', 100, 'completed');
    } catch (error) {
      if (state.cancelled) throw error;
      const isLocalUnsupported = error instanceof LocalUnsupportedError || (error && error.code === 'LOCAL_UNSUPPORTED');
      if (isLocalUnsupported) {
        try {
          await deferUnsupportedFile(task, error);
          return;
        } catch (deferError) {
          error = deferError;
        }
      }
      task.status = 'failed';
      task.error = String(error && error.message || '文件处理失败');
      void reportUploadError(plan, {
        ...(error && error.diagnostic || {}),
        stage: error && error.diagnostic && error.diagnostic.stage || String(task.status || 'upload_flow'),
        errorCode: error && error.code || 'MEMBER_UPLOAD_FLOW_FAILED',
        provider: String(state.manifest && state.manifest.destinationProvider || 'pan123'),
        message: task.error,
      });
      state.failedFileKeys.add(plan.fileKey);
      updateFileProgress(plan.fileKey, `处理失败：${task.error}`, task.progress);
      const row = filesEl.querySelector(`[data-file-key="${CSS.escape(String(plan.fileKey || ''))}"]`);
      if (row) row.classList.add('failed');
    } finally {
      await releaseDownloadSlot(plan.fileKey);
      await releaseUploadSlot(plan.fileKey);
      updateStats();
    }
  }

  const resumeWaiters = [];

  function setPaused(paused) {
    if (state.cancelled || state.finished) return;
    const next = !!paused;
    if (state.paused === next) return;
    state.paused = next;
    if (next) {
      setStatus('页面已进入后台，当前任务可继续收尾，暂不领取新文件。');
      return;
    }
    while (resumeWaiters.length) resumeWaiters.shift()();
    if (state.sessionToken && state.apiBase && !state.finished) startSessionHeartbeat();
    setStatus('页面已恢复，继续处理服务器下发文件...');
  }

  async function waitUntilActive() {
    while (state.paused && !state.cancelled) {
      await new Promise(resolve => resumeWaiters.push(resolve));
    }
    if (state.cancelled) throw new DOMException('Aborted', 'AbortError');
  }

  async function finalizeWhenReady() {
    setStatus('正在整理交付目录...');
    const result = await apiPostWhenReady(
      '/api/member/local-build-h5/finalize',
      { sessionToken: state.sessionToken },
      text => setStatus(text)
    );
    state.finished = true;
    stopSessionHeartbeat();
    setOverallProgress(100);
    setStatus('服务器下发文件处理完成，正在返回会员专区...');
    postMessage({
      type: 'memberLocalBuildResult',
      complete: true,
      success: true,
      taskId: result.taskId,
      provider: result.provider || state.manifest.destinationProvider,
      folderId: result.folderId,
      remoteFolderId: result.remoteFolderId,
      folderPath: result.folderPath,
      fileCount: result.fileCount,
      fallbackFiles: Array.isArray(result.fallbackFiles) ? result.fallbackFiles : [],
    });
    navigateBack();
  }

  async function runTasks(fileKeys) {
    if (state.processing || state.finished || state.cancelled) return;
    const queue = (fileKeys || []).map(key => state.tasks.get(String(key))).filter(Boolean);
    if (!queue.length) {
      await finalizeWhenReady();
      return;
    }
    state.processing = true;
    if (retryButtonEl) retryButtonEl.hidden = true;
    let cursor = 0;
    try {
      const workerCount = Math.min(FILE_WORKER_CONCURRENCY, queue.length);
      await Promise.all(Array.from({ length: workerCount }, async () => {
        while (true) {
          await waitUntilActive();
          const index = cursor;
          cursor += 1;
          if (index >= queue.length) return;
          await processOne(queue[index]);
        }
      }));
    } finally {
      state.processing = false;
      updateStats();
    }
    if (state.cancelled) return;
    if (state.failedFileKeys.size > 0) {
      setStatus(`有 ${state.failedFileKeys.size} 个文件处理失败，可点击“重试失败项”继续。`, true);
      if (retryButtonEl) retryButtonEl.hidden = false;
      return;
    }
    await finalizeWhenReady();
  }

  function abortActiveResources() {
    state.abortControllers.forEach(controller => { try { controller.abort(); } catch (_) {} });
    state.xhrs.forEach(xhr => { try { xhr.abort(); } catch (_) {} });
    state.workers.forEach(worker => { try { worker.terminate(); } catch (_) {} });
    state.abortControllers.clear();
    state.xhrs.clear();
    state.workers.clear();
    if (state.fontWorkerBlobUrl) {
      URL.revokeObjectURL(state.fontWorkerBlobUrl);
      state.fontWorkerBlobUrl = '';
      state.fontWorkerScriptPromise = null;
    }
  }

  async function cancelSession() {
    if (state.finished || state.cancelled) return;
    state.cancelled = true;
    stopSessionHeartbeat();
    setStatus('正在取消并清理临时文件...');
    abortActiveResources();
    while (resumeWaiters.length) resumeWaiters.shift()();
    await releaseAllLeases(true);
    try {
      // state.cancelled 会阻止普通控制面重试继续占用资源，因此取消接口使用独立的
      // keepalive 小请求；失败时 Server 仍会按会话 hard TTL 回收。
      await fetch(`${state.apiBase}/api/member/local-build-h5/abort`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionToken: state.sessionToken }),
        cache: 'no-store',
        credentials: 'omit',
        keepalive: true,
      });
    } catch (_) {}
    state.finished = true;
    postMessage({
      type: 'memberLocalBuildResult',
      complete: true,
      success: false,
      code: 'CANCELLED',
      fallbackAllowed: false,
      error: '服务器下发文件处理已取消',
    });
    navigateBack();
  }

  async function failStartup(error) {
    // cancelSession 已经拥有取消态的状态文案、结果消息和返回流程。主动 abort
    // 产生的 AbortError（或并发任务随后抛出的错误）不能再由顶层 catch 覆盖它。
    if (state.cancelled) return;
    const message = error instanceof Error ? error.message : String(error || '处理失败');
    stopSessionHeartbeat();
    setStatus(message, true);
    if (cancelButtonEl) cancelButtonEl.disabled = false;
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
    startSessionHeartbeat();
    if (String(manifest.status || '') === 'aborted') throw new Error('服务器下发文件会话已取消，请重新发起');
    const destinationProvider = String(manifest.destinationProvider || '').trim();
    if (!['pan123', 'baidu'].includes(destinationProvider)) throw new Error('服务器下发文件目标网盘无效');

    const files = Array.isArray(manifest.files) ? manifest.files : [];
    renderFiles(files);
    files.forEach(plan => {
      const status = plan.status === 'completed' ? 'completed' : (plan.status === 'delegated' ? 'delegated' : 'pending');
      const task = { plan, status, progress: status === 'pending' ? 0 : 100, error: '' };
      state.tasks.set(String(plan.fileKey), task);
      if (status === 'completed') updateFileProgress(plan.fileKey, '已完成', 100);
      else if (status === 'delegated') updateFileProgress(plan.fileKey, '已转服务器处理', 100);
    });
    const fallbackCount = Math.max(0, Number(manifest.fallbackCount || 0));
    summaryEl.textContent = fallbackCount > 0
      ? `本地处理 ${files.length} 个文件；另有 ${fallbackCount} 个文件将在返回小程序后交给服务器。`
      : `共 ${files.length} 个文件，将分阶段并发处理并保存到您的目标网盘。`;
    updateStats();
    await runTasks(
      files.filter(item => !['completed', 'delegated'].includes(String(item.status || ''))).map(item => item.fileKey)
    );
  }

  document.addEventListener('visibilitychange', () => setPaused(document.visibilityState !== 'visible'));
  document.addEventListener('WeixinJSBridgeReady', () => {
    try {
      WeixinJSBridge.on('onPageStateChange', event => setPaused(String(event && event.active || '') === 'false'));
    } catch (_) {}
  });
  retryButtonEl?.addEventListener('click', () => {
    const keys = Array.from(state.failedFileKeys);
    keys.forEach(key => {
      const task = state.tasks.get(key);
      if (task) {
        task.status = 'pending';
        task.error = '';
        // 重试会重新执行下载/处理阶段，但已展示的任务进度必须作为下限保留。
        // updateFileProgress 会继续按单调规则推进，避免 96% 回到 0%/75%。
        const row = filesEl.querySelector(`[data-file-key="${CSS.escape(String(key))}"]`);
        if (row) row.classList.remove('failed');
      }
    });
    void runTasks(keys).catch(failStartup);
  });
  cancelButtonEl?.addEventListener('click', () => { void cancelSession(); });

  window.addEventListener('pagehide', () => {
    // pagehide 可能只是微信把 WebView 暂时放入后台。这里只停止本页资源并释放租约，
    // 不删除已上传成果；只有用户点击“取消处理”才调用 Server abort。
    stopSessionHeartbeat();
    void releaseAllLeases(true);
  });

  window.addEventListener('unload', () => {
    if (state.fontWorkerBlobUrl) URL.revokeObjectURL(state.fontWorkerBlobUrl);
  });

  start().catch(error => failStartup(error));
})();
