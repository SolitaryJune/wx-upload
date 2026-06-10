# wx-upload.gushao.bond

Static GitHub Pages host for the WeChat Mini Program WebView file picker.

Production entry:

```text
https://wx-upload.gushao.bond/static/upload.html
```

The page only bridges selected browser files back to the Mini Program through
`wx.miniProgram.postMessage`; actual validation and upload handling stay in the
Mini Program.
