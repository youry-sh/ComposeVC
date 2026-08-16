const crypto = require("crypto");
const { LineSocket } = require("./linesocket.cjs");

const READ_CHUNK = 192 * 1024;
const WRITE_CHUNK = 192 * 1024;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function decodeB64(value) {
  if (!value) return "";
  return Buffer.from(String(value), "base64").toString("utf8");
}

/** Turn one command line into the {path, arg} pair guest-exec wants. */
function buildShell(command, { shell = "auto", os = "linux", cwd = "" } = {}) {
  const wanted = String(shell || "auto").toLowerCase();
  const windows = os === "windows";
  if (wanted === "powershell" || wanted === "pwsh" || (windows && wanted === "auto" && /\$\w|Get-|Set-/.test(command))) {
    const script = cwd ? `Set-Location -LiteralPath ${JSON.stringify(cwd)}; ${command}` : command;
    return { path: wanted === "pwsh" ? "pwsh.exe" : "powershell.exe", arg: ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script] };
  }
  if (windows || wanted === "cmd") {
    const script = cwd ? `cd /d ${JSON.stringify(cwd)} && ${command}` : command;
    return { path: "cmd.exe", arg: ["/d", "/s", "/c", script] };
  }
  const binary = wanted === "bash" ? "/bin/bash" : "/bin/sh";
  const script = cwd ? `cd '${String(cwd).replace(/'/g, "'\\''")}' && ${command}` : command;
  return { path: binary, arg: ["-lc", script] };
}

/**
 * QEMU Guest Agent client — the text channel into a running guest.
 * The protocol has no request ids, so commands are serialized through a queue.
 */
class QgaClient {
  constructor(socket, { os = "linux" } = {}) {
    this.socket = socket;
    this.os = os;
    this.queue = Promise.resolve();
    this.dirty = false;
  }

  static async open(port, { timeoutMs = 4000, syncTimeoutMs = 6000, os = "linux" } = {}) {
    const socket = await LineSocket.connect(port, { timeoutMs });
    const client = new QgaClient(socket, { os });
    try {
      await client.sync(syncTimeoutMs);
    } catch (err) {
      socket.close();
      throw new Error(
        `qemu-guest-agent is not answering (port ${port}): ${err.message}. ` +
          "The VM may still be booting, or the agent is not installed/started inside the guest."
      );
    }
    return client;
  }

  /**
   * guest-sync-delimited: the agent replies to a random id, and everything that
   * arrived before it is a leftover from an earlier client — dropping it is what
   * keeps replies aligned with requests (the protocol has no request ids).
   */
  async sync(timeoutMs = 6000) {
    const id = crypto.randomInt(1, 2 ** 31 - 1);
    this.socket.drain();
    this.socket.writeRaw(Buffer.from([0xff]));
    this.socket.write({ execute: "guest-sync-delimited", arguments: { id } });
    await this.socket.expect((msg) => msg && msg.return === id, timeoutMs, "guest agent sync");
    this.socket.drain();
    this.dirty = false;
    return true;
  }

  command(name, args, timeoutMs = 20_000) {
    const run = async () => {
      if (this.dirty) await this.sync(6000);
      this.socket.drain(); // anything pending now is stale by definition
      this.socket.write({ execute: name, ...(args && Object.keys(args).length ? { arguments: args } : {}) });
      let message;
      try {
        message = await this.socket.expect(
          (msg) => msg && (Object.prototype.hasOwnProperty.call(msg, "return") || msg.error),
          timeoutMs,
          `QGA ${name}`
        );
      } catch (err) {
        // A late reply would answer the *next* command; force a resync first.
        this.dirty = true;
        throw err;
      }
      if (message.error) {
        const detail = message.error.desc || message.error.class || "unknown error";
        throw new Error(`QGA ${name} failed: ${detail}`);
      }
      return message.return;
    };
    const result = this.queue.then(run, run);
    this.queue = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /** Fire-and-forget: the agent dies mid-command, so no reply is expected. */
  async fireAndForget(name, args, waitMs = 1200) {
    try {
      this.socket.write({ execute: name, ...(args && Object.keys(args).length ? { arguments: args } : {}) });
    } catch {
      return false;
    }
    await sleep(waitMs);
    return true;
  }

  ping(timeoutMs = 4000) {
    return this.command("guest-ping", {}, timeoutMs);
  }

  async exec(command, { shell = "auto", timeoutMs = 300_000, cwd = "", env = [], input = "", pollMs = 250 } = {}) {
    const { path: binary, arg } = buildShell(command, { shell, os: this.os, cwd });
    const started = Date.now();
    const spawned = await this.command(
      "guest-exec",
      {
        path: binary,
        arg,
        env: Array.isArray(env) ? env : [],
        "capture-output": true,
        ...(input ? { "input-data": Buffer.from(String(input), "utf8").toString("base64") } : {}),
      },
      20_000
    );
    const pid = spawned?.pid;
    if (!pid) {
      this.dirty = true;
      throw new Error(`guest-exec did not return a pid (got ${JSON.stringify(spawned)}) — the agent channel was out of step, retry`);
    }
    const deadline = started + Math.max(1000, timeoutMs);
    let wait = Math.max(50, pollMs);
    for (;;) {
      const status = await this.command("guest-exec-status", { pid }, 20_000);
      if (status.exited) {
        return {
          ok: (status.exitcode ?? 0) === 0,
          pid,
          exitCode: status.exitcode ?? null,
          signal: status.signal ?? null,
          stdout: decodeB64(status["out-data"]),
          stderr: decodeB64(status["err-data"]),
          truncated: Boolean(status["out-truncated"] || status["err-truncated"]),
          durationMs: Date.now() - started,
          timedOut: false,
        };
      }
      if (Date.now() > deadline) {
        return {
          ok: false,
          pid,
          exitCode: null,
          stdout: "",
          stderr: "",
          timedOut: true,
          durationMs: Date.now() - started,
          note: `still running in the guest after ${timeoutMs}ms (guest pid ${pid})`,
        };
      }
      await sleep(wait);
      wait = Math.min(1000, Math.round(wait * 1.4));
    }
  }

  /** guest-file-open answers with a bare integer handle, not an object. */
  async openFile(path, mode) {
    const result = await this.command("guest-file-open", { path, mode }, 15_000);
    const handle = typeof result === "number" ? result : result?.handle;
    if (typeof handle !== "number") throw new Error(`guest-file-open returned no handle for ${path} (got ${JSON.stringify(result)})`);
    return handle;
  }

  async readFile(path, { maxBytes = 4 * 1024 * 1024, binary = false } = {}) {
    const handle = await this.openFile(path, binary ? "rb" : "r");
    const parts = [];
    let total = 0;
    let eof = false;
    try {
      while (!eof && total < maxBytes) {
        const chunk = await this.command(
          "guest-file-read",
          { handle, count: Math.min(READ_CHUNK, maxBytes - total) },
          30_000
        );
        const data = Buffer.from(String(chunk["buf-b64"] || ""), "base64");
        parts.push(data);
        total += data.length;
        eof = Boolean(chunk.eof);
        if (!data.length && !eof) break;
      }
    } finally {
      await this.command("guest-file-close", { handle }, 10_000).catch(() => {});
    }
    const buffer = Buffer.concat(parts);
    return { buffer, bytes: buffer.length, eof, truncated: !eof && total >= maxBytes };
  }

  async writeFile(path, content, { append = false, binary = false } = {}) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(String(content ?? ""), "utf8");
    const mode = append ? (binary ? "ab" : "a") : binary ? "wb" : "w";
    const handle = await this.openFile(path, mode);
    let written = 0;
    try {
      if (!data.length) {
        await this.command("guest-file-write", { handle, "buf-b64": "", count: 0 }, 15_000);
      }
      while (written < data.length) {
        const slice = data.subarray(written, written + WRITE_CHUNK);
        const result = await this.command(
          "guest-file-write",
          { handle, "buf-b64": slice.toString("base64"), count: slice.length },
          60_000
        );
        written += result.count ?? slice.length;
      }
      await this.command("guest-file-flush", { handle }, 15_000).catch(() => {});
    } finally {
      await this.command("guest-file-close", { handle }, 10_000).catch(() => {});
    }
    return { bytes: written, path };
  }

  async info() {
    const safe = async (name, args) => {
      try {
        return await this.command(name, args, 8000);
      } catch {
        return null;
      }
    };
    const [agent, osInfo, hostname, users, time, interfaces, fsinfo] = await Promise.all([
      safe("guest-info"),
      safe("guest-get-osinfo"),
      safe("guest-get-host-name"),
      safe("guest-get-users"),
      safe("guest-get-time"),
      safe("guest-network-get-interfaces"),
      safe("guest-get-fsinfo"),
    ]);
    return { agent, osInfo, hostname, users, time, interfaces, fsinfo };
  }

  async addresses() {
    const interfaces = await this.command("guest-network-get-interfaces", {}, 10_000).catch(() => []);
    const list = [];
    for (const item of interfaces || []) {
      for (const address of item["ip-addresses"] || []) {
        if (address["ip-address"] === "127.0.0.1" || address["ip-address"] === "::1") continue;
        list.push({ iface: item.name, address: address["ip-address"], type: address["ip-address-type"] });
      }
    }
    return list;
  }

  shutdown(mode = "powerdown") {
    return this.fireAndForget("guest-shutdown", { mode });
  }

  close() {
    this.socket.close();
  }
}

/** Alive/not-alive in one call — no exceptions, just the bit. */
async function probeAgent(port, { timeoutMs = 3000, os = "linux" } = {}) {
  if (!port) return false;
  let client = null;
  try {
    client = await QgaClient.open(port, { timeoutMs, syncTimeoutMs: timeoutMs, os });
    await client.ping(timeoutMs);
    return true;
  } catch {
    return false;
  } finally {
    client?.close();
  }
}

module.exports = { QgaClient, probeAgent, buildShell, decodeB64 };
