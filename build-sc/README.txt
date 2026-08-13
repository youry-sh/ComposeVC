ComposeVC - run from source on any Windows PC
=============================================

STEP 1 - one time only:
  Right-click  build-sc\install.bat  and it will self-elevate to admin.
  It installs aria2 (fast multi-connection downloader), Node.js + Go,
  then all project libraries (web search included).
  Large files are pulled with aria2 (16 connections) or curl.exe —
  never PowerShell Invoke-WebRequest.
  Needs an internet connection. Takes a few minutes.

STEP 2 - every time you want to use the app:
  Double-click  build-sc\start.bat
  A "ComposeVC Proxy" window opens (leave it running), then the app starts.
  To stop everything: close the app, then press Ctrl+C in the proxy window.

Notes:
  - Keep the whole project folder together; do not move build-sc out of it.
  - Go is only needed if you ever want to rebuild the anti engine; the
    prebuilt anti.exe shipped in the folder is used as-is otherwise.
