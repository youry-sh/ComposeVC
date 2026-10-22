const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const store = require("../../electron/webEngineStore.cjs");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "webengine-store-"));
}

test("get returns { url: null } for a missing key", () => {
  const dir = tempDir();
  try {
    assert.deepEqual(store.get(dir, "session:nope"), { url: null });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("set then get round-trips a valid http url", async () => {
  const dir = tempDir();
  try {
    await store.set(dir, "session:a", "http://localhost:5173");
    const got = store.get(dir, "session:a");
    assert.equal(got.url, "http://localhost:5173");
    assert.equal(typeof got.updatedAt, "number");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("different chat keys do not share a url", async () => {
  const dir = tempDir();
  try {
    await store.set(dir, "session:a", "http://localhost:3000");
    await store.set(dir, "session:b", "http://localhost:5173");
    assert.equal(store.get(dir, "session:a").url, "http://localhost:3000");
    assert.equal(store.get(dir, "session:b").url, "http://localhost:5173");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("get drops a non-http(s) scheme on read", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "webengine", "bindings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      JSON.stringify(
        { v: 1, bindings: { "session:x": { url: "javascript:alert(1)", updatedAt: 1 } } },
        null,
        2
      )
    );
    assert.deepEqual(store.get(dir, "session:x"), { url: null });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("get survives a corrupt bindings file", () => {
  const dir = tempDir();
  try {
    const file = path.join(dir, "webengine", "bindings.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not json");
    assert.deepEqual(store.get(dir, "any"), { url: null });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("set rejects an empty key or url", async () => {
  const dir = tempDir();
  try {
    const r1 = await store.set(dir, "", "http://x");
    assert.equal(r1.ok, false);
    const r2 = await store.set(dir, "k", "");
    assert.equal(r2.ok, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
