const { LineSocket } = require("./linesocket.cjs");

/** QEMU Machine Protocol client — machine-level truth: is it running, paused, gone. */
class QmpClient {
  constructor(socket) {
    this.socket = socket;
    this.seq = 0;
    this.events = [];
  }

  static async open(port, { timeoutMs = 4000 } = {}) {
    const socket = await LineSocket.connect(port, { timeoutMs });
    const client = new QmpClient(socket);
    try {
      await socket.expect((msg) => msg && msg.QMP, timeoutMs, "QMP greeting");
      await client.command("qmp_capabilities", {}, timeoutMs);
    } catch (err) {
      socket.close();
      throw err;
    }
    return client;
  }

  async command(name, args, timeoutMs = 15_000) {
    const id = `cvc-${(this.seq += 1)}`;
    this.socket.write({ execute: name, ...(args && Object.keys(args).length ? { arguments: args } : {}), id });
    const message = await this.socket.expect((msg) => msg && msg.id === id, timeoutMs, `QMP ${name}`);
    if (message.error) {
      throw new Error(`QMP ${name} failed: ${message.error.desc || message.error.class || "unknown error"}`);
    }
    return message.return;
  }

  /** Human monitor passthrough — used for savevm/loadvm/hostfwd which have no QMP command. */
  async hmp(commandLine, timeoutMs = 30_000) {
    const out = await this.command("human-monitor-command", { "command-line": commandLine }, timeoutMs);
    return String(out ?? "");
  }

  drainEvents() {
    return this.socket.drain().filter((msg) => msg && msg.event);
  }

  close() {
    this.socket.close();
  }
}

/** Open, run, always close. */
async function withQmp(port, fn, options = {}) {
  const client = await QmpClient.open(port, options);
  try {
    return await fn(client);
  } finally {
    client.close();
  }
}

/**
 * Machine status without throwing: null means "the monitor did not answer",
 * which for the caller is the same 0 as "not running".
 */
async function probeStatus(port, { timeoutMs = 2500 } = {}) {
  if (!port) return null;
  try {
    return await withQmp(port, (client) => client.command("query-status", {}, timeoutMs), { timeoutMs });
  } catch {
    return null;
  }
}

module.exports = { QmpClient, withQmp, probeStatus };
