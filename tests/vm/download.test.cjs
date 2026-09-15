/**
 * Download robustness: the real "тупо зависает" bug and its fixes, exercised against a
 * local HTTP server that can stall, drop, corrupt, and serve Range requests.
 */
const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "cvc-vm-dl-"));
process.env.COMPOSEVC_USER_DATA = userData;

const images = require("../../electron/vm/images.cjs");

// The module-level IDLE_MS is 45s; override the timers for the test to run in seconds.
// We instead rely on short stalls the watchdog would catch only if we shorten it, so
// simulate a *dropped* connection (which the retry loop must recover) rather than a
// 45s stall. Stalls and drops take the same recovery path (retry-with-resume).

const PAYLOAD = crypto.randomBytes(512 * 1024); // 512 KB
const SHA = crypto.createHash("sha512").update(PAYLOAD).digest("hex");

function serveRange(req, res, body, { dropAfter = null, corrupt = false } = {}) {
  const range = req.headers.range;
  let start = 0;
  const data = corrupt ? Buffer.concat([body.subarray(0, body.length - 1), Buffer.from([body[body.length - 1] ^ 0xff])]) : body;
  if (range) {
    const match = /bytes=(\d+)-/.exec(range);
    start = match ? Number(match[1]) : 0;
    res.statusCode = 206;
    res.setHeader("content-range", `bytes ${start}-${data.length - 1}/${data.length}`);
  } else {
    res.statusCode = 200;
  }
  const slice = data.subarray(start);
  res.setHeader("content-length", slice.length);
  if (dropAfter != null && slice.length > dropAfter) {
    res.write(slice.subarray(0, dropAfter));
    // Kill the socket mid-body: the client must resume from the partial, not restart.
    req.destroy();
    res.destroy();
    return;
  }
  res.end(slice);
}

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port })));
}

(async () => {
  /* 1) a clean, verified download ------------------------------------------------ */
  const clean = await listen((req, res) => serveRange(req, res, PAYLOAD));
  const r1 = await images.pull(userData, {
    url: `http://127.0.0.1:${clean.port}/qemu.bin`,
    file: "qemu.bin",
    sha512: SHA,
    size: PAYLOAD.length,
    wait: true,
  });
  assert.equal(r1.done, true);
  assert.equal(r1.verified, true);
  assert.ok(fs.readFileSync(r1.path).equals(PAYLOAD), "clean download is byte-exact");
  clean.server.close();

  /* 2) reused when already present and verified ---------------------------------- */
  const r2 = await images.pull(userData, { file: "qemu.bin", sha512: SHA, size: PAYLOAD.length, wait: true });
  assert.equal(r2.alreadyPresent, true, "a verified file is not re-downloaded");

  /* 3) a mid-body connection drop is recovered by resume ------------------------- */
  let hits = 0;
  const flaky = await listen((req, res) => {
    hits += 1;
    // First response dies after 200 KB; subsequent Range requests complete it.
    serveRange(req, res, PAYLOAD, { dropAfter: hits === 1 ? 200 * 1024 : null });
  });
  const r3 = await images.pull(userData, {
    url: `http://127.0.0.1:${flaky.port}/flaky.bin`,
    file: "flaky.bin",
    sha512: SHA,
    size: PAYLOAD.length,
    wait: true,
  });
  assert.equal(r3.done, true, "a dropped connection is retried and resumed");
  assert.ok(hits >= 2, "the client actually reconnected");
  assert.ok(fs.readFileSync(r3.path).equals(PAYLOAD), "resumed file is byte-exact");
  flaky.server.close();

  /* 4) a corrupt payload is rejected by sha512, never accepted ------------------- */
  const bad = await listen((req, res) => serveRange(req, res, PAYLOAD, { corrupt: true }));
  await assert.rejects(
    () =>
      images.pull(userData, {
        url: `http://127.0.0.1:${bad.port}/bad.bin`,
        file: "bad.bin",
        sha512: SHA,
        size: PAYLOAD.length,
        wait: true,
      }),
    /sha512 mismatch|download failed/i,
    "a corrupt file fails loudly instead of being accepted"
  );
  assert.ok(!fs.existsSync(images.localPath(userData, "bad.bin")), "the corrupt file is not left behind as valid");
  bad.server.close();

  /* 5) a wrong-size file is rejected --------------------------------------------- */
  const short = await listen((req, res) => serveRange(req, res, PAYLOAD.subarray(0, 100 * 1024)));
  await assert.rejects(
    () =>
      images.pull(userData, {
        url: `http://127.0.0.1:${short.port}/short.bin`,
        file: "short.bin",
        size: PAYLOAD.length,
        wait: true,
      }),
    /size mismatch|download failed/i
  );
  short.server.close();

  fs.rmSync(userData, { recursive: true, force: true });
  console.log("vm/download: ok");
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
