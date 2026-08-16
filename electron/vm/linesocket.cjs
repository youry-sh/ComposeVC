const net = require("net");

const SEPARATORS = new Set([0x0a, 0x0d, 0xff]); // \n, \r and the QGA 0xFF sync delimiter

/**
 * Line-delimited JSON socket shared by the QMP monitor and the guest agent.
 * 0xFF never occurs in valid UTF-8, so splitting raw bytes is safe.
 */
class LineSocket {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.pending = [];
    this.waiters = [];
    this.closed = false;
    this.error = null;
    socket.on("data", (chunk) => this._feed(chunk));
    socket.on("error", (err) => this._fail(err));
    socket.on("close", () => this._fail(this.error || new Error("socket closed")));
  }

  static connect(port, { host = "127.0.0.1", timeoutMs = 4000 } = {}) {
    return new Promise((resolve, reject) => {
      const socket = net.connect({ port, host });
      const timer = setTimeout(() => {
        socket.destroy();
        reject(new Error(`connect timeout after ${timeoutMs}ms on ${host}:${port}`));
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        socket.setNoDelay(true);
        resolve(new LineSocket(socket));
      });
      socket.once("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  _feed(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let start = 0;
    for (let i = 0; i < this.buffer.length; i += 1) {
      if (!SEPARATORS.has(this.buffer[i])) continue;
      const slice = this.buffer.subarray(start, i);
      start = i + 1;
      const text = slice.toString("utf8").trim();
      if (!text) continue;
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        continue; // non-JSON noise on the channel is ignored, not fatal
      }
      this._emit(parsed);
    }
    this.buffer = this.buffer.subarray(start);
    if (this.buffer.length > 8 * 1024 * 1024) this.buffer = Buffer.alloc(0);
  }

  _emit(message) {
    for (let i = 0; i < this.waiters.length; i += 1) {
      const waiter = this.waiters[i];
      if (!waiter.predicate(message)) continue;
      this.waiters.splice(i, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
      return;
    }
    this.pending.push(message);
    if (this.pending.length > 500) this.pending.shift();
  }

  _fail(err) {
    if (this.closed) return;
    this.closed = true;
    this.error = err;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
  }

  write(payload) {
    if (this.closed) throw this.error || new Error("socket closed");
    const text = typeof payload === "string" ? payload : `${JSON.stringify(payload)}\n`;
    this.socket.write(text);
  }

  writeRaw(buffer) {
    if (this.closed) throw this.error || new Error("socket closed");
    this.socket.write(buffer);
  }

  /** Resolve with the first message matching `predicate` (already-buffered ones included). */
  expect(predicate, timeoutMs = 10_000, label = "response") {
    for (let i = 0; i < this.pending.length; i += 1) {
      if (predicate(this.pending[i])) return Promise.resolve(this.pending.splice(i, 1)[0]);
    }
    if (this.closed) return Promise.reject(this.error || new Error("socket closed"));
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`timeout after ${timeoutMs}ms waiting for ${label}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  drain() {
    return this.pending.splice(0);
  }

  close() {
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("socket closed"));
    }
    try {
      this.socket.destroy();
    } catch {
      /* already gone */
    }
  }
}

module.exports = { LineSocket };
