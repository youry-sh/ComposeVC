const os = require("os");
const pty = require("node-pty");

const sessions = new Map();

function shellConfig() {
  if (process.platform === "win32") {
    return { command: process.env.COMSPEC || "powershell.exe", args: ["-NoLogo"] };
  }
  return { command: process.env.SHELL || "/bin/bash", args: ["-l"] };
}

function send(session, channel, payload) {
  const owner = session.owner;
  if (!owner || owner.isDestroyed()) return;
  owner.send(channel, payload);
}

function ensure(id, owner, cwd) {
  const key = String(id || "");
  if (!/^[12]$/.test(key)) throw new Error("Unknown terminal session");
  const current = sessions.get(key);
  if (current) {
    current.owner = owner;
    return { id: key, pid: current.process.pid, cwd: current.cwd };
  }

  const shell = shellConfig();
  const terminal = pty.spawn(shell.command, shell.args, {
    name: "xterm-256color",
    cols: 100,
    rows: 30,
    cwd,
    env: { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor" },
    useConpty: process.platform === "win32",
  });
  const session = { process: terminal, owner, cwd };
  sessions.set(key, session);
  terminal.onData((data) => send(session, "terminal:data", { id: key, data }));
  terminal.onExit(({ exitCode }) => {
    send(session, "terminal:exit", { id: key, exitCode });
    sessions.delete(key);
  });
  return { id: key, pid: terminal.pid, cwd };
}

function register(ipcMain, app) {
  ipcMain.handle("terminal:ensure", (event, id) => ensure(id, event.sender, app.getPath("desktop")));
  ipcMain.on("terminal:input", (_event, payload = {}) => {
    const session = sessions.get(String(payload.id || ""));
    if (session && typeof payload.data === "string") session.process.write(payload.data);
  });
  ipcMain.on("terminal:resize", (_event, payload = {}) => {
    const session = sessions.get(String(payload.id || ""));
    const cols = Math.max(2, Math.min(1000, Math.floor(Number(payload.cols) || 0)));
    const rows = Math.max(1, Math.min(500, Math.floor(Number(payload.rows) || 0)));
    if (session) {
      try { session.process.resize(cols, rows); } catch { /* process may be exiting */ }
    }
  });
}

function dispose() {
  for (const session of sessions.values()) {
    try { session.process.kill(); } catch { /* already stopped */ }
  }
  sessions.clear();
}

module.exports = { register, dispose };
