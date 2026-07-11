# wxview.upload.beautify.mp.juneover24.cn

Static GitHub Pages host for the WeChat Mini Program WebView file picker.

Production entry:

```text
https://wxview.upload.beautify.mp.juneover24.cn/static/upload.html
```

The page only bridges selected browser files back to the Mini Program through
`wx.miniProgram.postMessage`; actual validation and upload handling stay in the
Mini Program.
