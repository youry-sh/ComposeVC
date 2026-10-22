const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { UsageStore } = require("../../electron/usageStore.cjs");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "usage-store-"));
}

function makeStore(dir) {
  const store = new UsageStore();
  store.init(dir);
  return store;
}

let pass = 0;
function ok(name) {
  pass += 1;
  console.log(`  ok ${pass} - ${name}`);
}

(async () => {
  // 1. counters increment and persist, then reload restores them
  {
    const dir = tmpDir();
    const store = makeStore(dir);
    store.recordToolCall("read_file");
    store.recordToolCall("edit_file");
    store.recordToolCall("read_file", { error: true });
    store.recordFileCreate(12);
    store.recordLineChange(4, 2);
    store.recordTerminalOpen();
    store.recordUserPrompt(7);
    store.flushSync();

    const file = path.join(dir, "usage.json");
    assert.ok(fs.existsSync(file), "usage.json written");
    assert.ok(!fs.existsSync(`${file}.tmp`), "no tmp file left behind");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.strictEqual(raw.v, 1, "schema version 1");

    const reloaded = makeStore(dir);
    const snap = reloaded.snapshot();
    assert.strictEqual(snap.counters.toolCalls, 3);
    assert.strictEqual(snap.counters.toolErrors, 1);
    assert.strictEqual(snap.counters.filesCreated, 1);
    assert.strictEqual(snap.counters.linesAdded, 16);
    assert.strictEqual(snap.counters.linesRemoved, 2);
    assert.strictEqual(snap.counters.terminalsOpened, 1);
    assert.strictEqual(snap.counters.userPrompts, 1);
    assert.strictEqual(snap.counters.userPromptChars, 7);
    const read = snap.tools.find((t) => t.name === "read_file");
    assert.strictEqual(read.calls, 2);
    assert.strictEqual(read.errors, 1);
    reloaded.dispose();
    store.dispose();
    ok("counters persist and reload, per-tool breakdown correct");
  }

  // 2. corrupt file → backup written + safe fresh start
  {
    const dir = tmpDir();
    const file = path.join(dir, "usage.json");
    fs.writeFileSync(file, "{ this is not json", "utf8");
    const store = makeStore(dir);
    const backups = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith("usage.json.corrupt-"));
    assert.strictEqual(backups.length, 1, "corrupt file backed up");
    assert.strictEqual(store.snapshot().counters.toolCalls, 0, "starts fresh");
    store.dispose();
    ok("corrupt JSON backed up and reset without throwing");
  }

  // 3. missing file → valid initial structure
  {
    const dir = tmpDir();
    const store = makeStore(dir);
    const snap = store.snapshot();
    assert.strictEqual(snap.v, 1);
    assert.strictEqual(snap.counters.filesCreated, 0);
    assert.deepStrictEqual(snap.tools, []);
    store.dispose();
    ok("missing file yields valid empty state");
  }

  // 4. daily buckets are keyed by local date and low-cardinality
  {
    const dir = tmpDir();
    const store = makeStore(dir);
    store.recordToolCall("bash");
    store.recordUserPrompt(5);
    const snap = store.snapshot();
    assert.strictEqual(snap.daily.length, 1, "one daily bucket");
    assert.strictEqual(snap.daily[0].toolCalls, 1);
    assert.strictEqual(snap.daily[0].promptChars, 5);
    store.dispose();
    ok("daily time-series buckets populated");
  }

  // 5. newer schema is handled explicitly: known-shape counters preserved, unknown fields dropped
  {
    const dir = tmpDir();
    const file = path.join(dir, "usage.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ v: 999, counters: { toolCalls: 42, futureField: 7 }, tools: {}, daily: {} }),
      "utf8"
    );
    const store = makeStore(dir);
    const snap = store.snapshot();
    assert.strictEqual(snap.counters.toolCalls, 42, "known counter preserved from newer schema");
    assert.ok(!("futureField" in snap.counters), "unknown field dropped");
    store.dispose();
    ok("newer schema handled explicitly (compatible subset + no unknown fields)");
  }

  console.log(`\nusageStore: ${pass} tests passed`);
})().catch((err) => {
  console.error("\nusageStore test failed:", err);
  process.exit(1);
});
