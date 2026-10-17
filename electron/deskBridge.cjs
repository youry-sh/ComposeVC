const http = require("http");

const state = { pending: false, text: "", context: "" };

function send(res, code, body) {
  const raw = JSON.stringify(body);
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(raw);
}

function start(getWindow) {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/state") {
      send(res, 200, state);
      return;
    }
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
    });
    req.on("end", () => {
      let data = {};
      try { data = raw ? JSON.parse(raw) : {}; } catch { data = {}; }
      const win = getWindow();
      if (req.method === "POST" && req.url === "/prompt") {
        if (!win) {
          send(res, 503, { ok: false, error: "IDE is closed" });
          return;
        }
        state.pending = true;
        state.text = "";
        win.webContents.send("desk:prompt", { text: String(data.text || "") });
        send(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && req.url === "/clear") {
        if (win) win.webContents.send("desk:clear", {});
        state.pending = false;
        state.text = "";
        state.context = "";
        send(res, 200, { ok: true });
        return;
      }
      if (req.method === "POST" && req.url === "/reply") {
        state.pending = false;
        state.text = String(data.text || "");
        state.context = String(data.context || "");
        send(res, 200, { ok: true });
        return;
      }
      send(res, 404, { ok: false });
    });
  });
  server.on("error", () => {});
  server.listen(47741, "127.0.0.1");
}

module.exports = { start };
