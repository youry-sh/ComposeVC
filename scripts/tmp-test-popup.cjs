const { app, BrowserWindow } = require("electron");
const path = require("path");

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await win.loadFile(path.join(__dirname, "..", "dist", "index.html"), {
      query: { proxyPopup: "usage" },
    });
    await new Promise((r) => setTimeout(r, 2500));
    const info = await win.webContents.executeJavaScript(
      "JSON.stringify({ search: window.location.search, href: window.location.href, popupTitlebar: !!document.querySelector('.proxy-popup-titlebar'), proxyWorkspace: !!document.querySelector('.proxy-workspace'), activityBar: !!document.querySelector('.activity-bar'), bodyHead: (document.body.innerText || '').replace(/\\s+/g,' ').slice(0, 160) })"
    );
    console.log("POPUP_TEST " + info);
  } catch (e) {
    console.log("POPUP_TEST_ERROR " + (e && e.message ? e.message : String(e)));
  }
  app.exit(0);
});
