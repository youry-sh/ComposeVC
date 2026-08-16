/**
 * Protocol-level tests: fake QMP / guest-agent / serial servers stand in for QEMU,
 * so the text channels are verified without booting anything.
 */
const assert = require("assert");
const fs = require("fs");
const net = require("net");
const os = require("os");
const path = require("path");

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "cvc-vm-proto-"));
process.env.COMPOSEVC_USER_DATA = userData;

const { QmpClient, withQmp, probeStatus } = require("../../electron/vm/qmp.cjs");
const { QgaClient, probeAgent } = require("../../electron/vm/qga.cjs");
const engine = require("../../electron/vm/engine.cjs");

function listen(handler) {
  const server = net.createServer(handler);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

/** Split incoming bytes on \n and the 0xFF guest-agent delimiter. */
function onMessages(socket, handle) {
  let buffer = Buffer.alloc(0);
  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    let start = 0;
    for (let i = 0; i < buffer.length; i += 1) {
      if (buffer[i] !== 0x0a && buffer[i] !== 0xff) continue;
      const text = buffer.subarray(start, i).toString("utf8").trim();
      start = i + 1;
      if (!text) continue;
      try {
        handle(JSON.parse(text));
      } catch {
        /* ignore non-JSON */
      }
    }
    buffer = buffer.subarray(start);
  });
}

async function fakeQmp() {
  return listen((socket) => {
    socket.write(`${JSON.stringify({ QMP: { version: { qemu: { major: 9 } }, capabilities: [] } })}\n`);
    onMessages(socket, (message) => {
      const reply = (value) => socket.write(`${JSON.stringify({ return: value, id: message.id })}\n`);
      if (message.execute === "qmp_capabilities") reply({});
      else if (message.execute === "query-status") reply({ status: "running", running: true });
      else if (message.execute === "human-monitor-command") reply(`ran: ${message.arguments["command-line"]}`);
      else if (message.execute === "boom") socket.write(`${JSON.stringify({ error: { class: "GenericError", desc: "no such thing" }, id: message.id })}\n`);
      else reply(null);
    });
  });
}

async function fakeQga({ files = {} } = {}) {
  const handles = new Map();
  let nextHandle = 1;
  let execPolls = 0;
  return listen((socket) => {
    // A leftover reply from an earlier client: the agent protocol has no request
    // ids, so this must be flushed by the sync or every later reply is off by one.
    socket.write(`${JSON.stringify({ return: { pid: 999 } })}\n`);
    onMessages(socket, (message) => {
      const reply = (value) => socket.write(`${JSON.stringify({ return: value })}\n`);
      switch (message.execute) {
        case "guest-sync-delimited":
          socket.write(Buffer.from([0xff]));
          socket.write(`${JSON.stringify({ return: message.arguments.id })}\n`);
          break;
        case "guest-ping":
          reply({});
          break;
        case "guest-exec":
          execPolls = 0;
          reply({ pid: 777 });
          break;
        case "guest-exec-status":
          execPolls += 1;
          if (execPolls < 2) reply({ exited: false });
          else
            reply({
              exited: true,
              exitcode: 0,
              "out-data": Buffer.from("hello from the guest\n").toString("base64"),
              "err-data": Buffer.from("warn\n").toString("base64"),
            });
          break;
        case "guest-file-open": {
          const handle = nextHandle++;
          handles.set(handle, { path: message.arguments.path, mode: message.arguments.mode, offset: 0 });
          if (/^w/.test(message.arguments.mode)) files[message.arguments.path] = Buffer.alloc(0);
          reply(handle); // the real agent answers with a bare integer, not an object
          break;
        }
        case "guest-file-read": {
          const state = handles.get(message.arguments.handle);
          const data = files[state.path] || Buffer.alloc(0);
          const slice = data.subarray(state.offset, state.offset + message.arguments.count);
          state.offset += slice.length;
          reply({ count: slice.length, "buf-b64": slice.toString("base64"), eof: state.offset >= data.length });
          break;
        }
        case "guest-file-write": {
          const state = handles.get(message.arguments.handle);
          const data = Buffer.from(message.arguments["buf-b64"] || "", "base64");
          files[state.path] = Buffer.concat([files[state.path] || Buffer.alloc(0), data]);
          reply({ count: data.length, eof: false });
          break;
        }
        case "guest-file-close":
          handles.delete(message.arguments.handle);
          reply({});
          break;
        case "guest-network-get-interfaces":
          reply([
            { name: "lo", "ip-addresses": [{ "ip-address": "127.0.0.1", "ip-address-type": "ipv4" }] },
            { name: "eth0", "ip-addresses": [{ "ip-address": "10.0.2.15", "ip-address-type": "ipv4" }] },
          ]);
          break;
        case "guest-get-osinfo":
          reply({ "pretty-name": "Debian GNU/Linux 12 (bookworm)", "kernel-release": "6.1.0" });
          break;
        case "guest-file-flush":
          reply({});
          break;
        default:
          socket.write(`${JSON.stringify({ error: { class: "CommandNotFound", desc: `no ${message.execute}` } })}\n`);
      }
    });
  }).then((result) => ({ ...result, files }));
}

(async () => {
  /* ------------------------------------------------------------- QMP */
  const qmp = await fakeQmp();
  const status = await probeStatus(qmp.port);
  assert.deepEqual(status, { status: "running", running: true }, "monitor reports the machine state");

  await withQmp(qmp.port, async (client) => {
    assert.equal(await client.hmp("info snapshots"), "ran: info snapshots");
    await assert.rejects(() => client.command("boom", {}, 3000), /no such thing/, "QMP errors surface as errors");
  });

  // Two concurrent commands must not cross their replies.
  await withQmp(qmp.port, async (client) => {
    const [a, b] = await Promise.all([client.command("query-status"), client.hmp("info block")]);
    assert.equal(a.status, "running");
    assert.equal(b, "ran: info block");
  });

  assert.equal(await probeStatus(1), null, "an unreachable monitor is simply 0");
  qmp.server.close();

  /* ------------------------------------------------------------- QGA */
  const qga = await fakeQga({ files: { "/etc/hostname": Buffer.from("dev-box\n") } });
  assert.equal(await probeAgent(qga.port, { timeoutMs: 2000 }), true, "agent answers the sync ping");

  const agent = await QgaClient.open(qga.port, { os: "linux" });
  const exec = await agent.exec("echo hi", { timeoutMs: 10_000, pollMs: 20 });
  assert.equal(exec.ok, true);
  assert.equal(exec.exitCode, 0);
  assert.equal(exec.stdout, "hello from the guest\n", "stdout is base64-decoded");
  assert.equal(exec.stderr, "warn\n");

  const read = await agent.readFile("/etc/hostname");
  assert.equal(read.buffer.toString(), "dev-box\n");
  assert.equal(read.eof, true);

  const payload = Buffer.alloc(400 * 1024, 0x7a); // forces chunked writes
  await agent.writeFile("/tmp/big", payload);
  assert.ok(qga.files["/tmp/big"].equals(payload), "large writes are chunked and reassembled");

  const addresses = await agent.addresses();
  assert.deepEqual(addresses, [{ iface: "eth0", address: "10.0.2.15", type: "ipv4" }], "loopback is filtered out");

  const info = await agent.info();
  assert.equal(info.osInfo["pretty-name"], "Debian GNU/Linux 12 (bookworm)");
  assert.equal(info.users, null, "unsupported agent commands degrade to null instead of throwing");
  agent.close();

  assert.equal(await probeAgent(1, { timeoutMs: 800 }), false, "a dead agent port is 0, not an exception");

  // A port that accepts but never answers must time out rather than hang forever.
  const silent = await listen(() => {});
  const startedAt = Date.now();
  assert.equal(await probeAgent(silent.port, { timeoutMs: 700 }), false);
  assert.ok(Date.now() - startedAt < 5000, "sync timeout is honoured");
  silent.server.close();
  qga.server.close();

  /* --------------------------------------------------------- console */
  const dir = fs.mkdtempSync(path.join(userData, "console-"));
  const serialLog = path.join(dir, "serial.log");
  fs.writeFileSync(serialLog, "");
  const append = (text) => fs.appendFileSync(serialLog, text);

  /**
   * A serial line that behaves like a real tty: it echoes what is typed and then
   * prints the output. `state` starts at "shell" or at "login" to exercise the
   * getty handshake.
   */
  function fakeConsole({ state = "shell", user = "vc", password = "pw" } = {}) {
    return listen((socket) => {
      let line = "";
      socket.on("data", (chunk) => {
        line += chunk.toString();
        let index = line.indexOf("\r");
        while (index >= 0) {
          const typed = line.slice(0, index);
          line = line.slice(index + 1);
          if (state === "login") {
            append(`${typed}\r\n`);
            if (typed.trim()) {
              state = typed.trim() === user ? "password" : "password-bad";
              append("Password: ");
            } else append("login: ");
          } else if (state === "password" || state === "password-bad") {
            const good = state === "password" && typed === password;
            state = good ? "shell" : "login";
            append(good ? "\r\nLinux dev-box\r\nroot@dev-box:~# " : "\r\nLogin incorrect\r\nlogin: ");
          } else if (!typed.trim()) {
            append("root@dev-box:~# ");
          } else {
            append(`${typed}\r\n`); // terminal echo
            const marker = typed.match(/echo (CVC\w+BEGIN); \{ (.*) ; \} 2>&1; echo (CVC\w+END)\$\?/);
            const echoed = typed.match(/^echo (\S+)$/);
            if (marker) append(`${marker[1]}\r\nsimulated output of: ${marker[2]}\r\n${marker[3]}0\r\n`);
            else if (echoed) append(`${echoed[1]}\r\n`);
            append("root@dev-box:~# ");
          }
          index = line.indexOf("\r");
        }
      });
    });
  }

  const console_ = await fakeConsole();

  const vm = { id: "vm-console", name: "dev-box", os: "linux", user: "vc", password: "pw", dir, serialLog, ports: { console: console_.port } };

  const before = engine.serialSize(vm);
  await engine.writeSerial(vm, "uname -a");
  const seen = await engine.expectSerial(vm, /uname -a/, { timeoutMs: 4000, fromOffset: before });
  assert.equal(seen.matched, true, "typing into the console lands in the serial log");

  const result = await engine.consoleExec(vm, "cat /etc/os-release", { timeoutMs: 8000 });
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.channel, "console");
  assert.ok(result.stdout.includes("simulated output of: cat /etc/os-release"), "output is captured between markers");
  assert.ok(!result.stdout.includes("BEGIN"), "the markers themselves are stripped");

  const miss = await engine.expectSerial(vm, /this-never-appears/, { timeoutMs: 600, fromOffset: 0 });
  assert.equal(miss.matched, false);
  assert.equal(miss.timedOut, true, "a missing pattern is a clean 0, not a hang");

  const window = engine.readSerial(vm, { fromOffset: 0, maxChars: 100_000 });
  assert.ok(window.text.includes("root@dev-box"), "the whole log is readable from any offset");
  assert.equal(window.offset, window.size);

  console_.server.close();

  /* ----------------------------------------------- console login handshake */
  const loginLog = path.join(dir, "serial-login.log");
  fs.writeFileSync(loginLog, "Debian GNU/Linux 12 dev-box ttyS0\r\n\r\nlogin: ");
  const loginConsole = await (async () => {
    let state = "login";
    const server = net.createServer((socket) => {
      let line = "";
      socket.on("data", (chunk) => {
        line += chunk.toString();
        let index = line.indexOf("\r");
        while (index >= 0) {
          const typed = line.slice(0, index);
          line = line.slice(index + 1);
          const out = (text) => fs.appendFileSync(loginLog, text);
          if (state === "login") {
            out(`${typed}\r\n`);
            if (typed.trim()) {
              state = typed.trim() === "vc" ? "password" : "password-bad";
              out("Password: ");
            } else out("login: ");
          } else if (state.startsWith("password")) {
            const good = state === "password" && typed === "s3cret";
            state = good ? "shell" : "login";
            out(good ? "\r\nLinux dev-box\r\nvc@dev-box:~$ " : "\r\nLogin incorrect\r\nlogin: ");
          } else if (!typed.trim()) out("vc@dev-box:~$ ");
          else {
            out(`${typed}\r\n`);
            const marker = typed.match(/echo (CVC\w+BEGIN); \{ (.*) ; \} 2>&1; echo (CVC\w+END)\$\?/);
            const echoed = typed.match(/^echo (\S+)$/);
            if (marker) out(`${marker[1]}\r\nuid=1000(vc)\r\n${marker[3]}0\r\n`);
            else if (echoed) out(`${echoed[1]}\r\n`);
            out("vc@dev-box:~$ ");
          }
          index = line.indexOf("\r");
        }
      });
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
  })();

  const loginVm = { ...vm, id: "vm-login", serialLog: loginLog, password: "s3cret", ports: { console: loginConsole.port } };
  const logged = await engine.consoleExec(loginVm, "id", { timeoutMs: 30_000 });
  assert.equal(logged.ok, true, "the console logs in by itself and runs the command");
  assert.ok(logged.stdout.includes("uid=1000(vc)"));
  assert.ok(fs.readFileSync(loginLog, "utf8").includes("Password:"), "the password prompt really happened");

  const badVm = { ...loginVm, id: "vm-bad", serialLog: path.join(dir, "serial-bad.log"), password: "wrong" };
  fs.writeFileSync(badVm.serialLog, "login: ");
  const badServer = await (async () => {
    let state = "login";
    const server = net.createServer((socket) => {
      let line = "";
      socket.on("data", (chunk) => {
        line += chunk.toString();
        let index = line.indexOf("\r");
        while (index >= 0) {
          const typed = line.slice(0, index);
          line = line.slice(index + 1);
          const out = (text) => fs.appendFileSync(badVm.serialLog, text);
          if (state === "login") {
            out(`${typed}\r\n`);
            state = "password";
            out("Password: ");
          } else {
            state = "login";
            out("\r\nLogin incorrect\r\nlogin: ");
          }
          index = line.indexOf("\r");
        }
      });
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
  })();
  badVm.ports = { console: badServer.port };
  await assert.rejects(() => engine.consoleExec(badVm, "id", { timeoutMs: 20_000 }), /did not reach a shell|login failed/i, "a rejected password is a clean 0");
  badServer.server.close();
  loginConsole.server.close();

  fs.rmSync(userData, { recursive: true, force: true });
  console.log("vm/protocol: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
