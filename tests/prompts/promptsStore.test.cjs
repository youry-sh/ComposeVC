const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const store = require("../../electron/promptsStore.cjs");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "prompts-store-"));
}

function storeFile(dir) {
  return path.join(dir, "prompts", "prompts.json");
}

test("missing file → creates an empty store", async () => {
  const dir = tempDir();
  try {
    const result = await store.readAll(dir);
    assert.equal(result.version, 1);
    assert.deepEqual(result.prompts, []);
    assert.ok(fs.existsSync(storeFile(dir)));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("create → readAll round-trips a prompt", async () => {
  const dir = tempDir();
  try {
    const created = await store.create(dir, { title: "Review", text: "line1\nline2" });
    assert.equal(typeof created.id, "string");
    assert.ok(created.id.startsWith("pr-"));
    const result = await store.readAll(dir);
    assert.equal(result.prompts.length, 1);
    assert.equal(result.prompts[0].title, "Review");
    assert.equal(result.prompts[0].text, "line1\nline2");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("create normalizes CRLF and trims", async () => {
  const dir = tempDir();
  try {
    const created = await store.create(dir, { title: "  T  ", text: "a\r\nb\r\n" });
    assert.equal(created.title, "T");
    assert.equal(created.text, "a\nb");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("create rejects empty title or text", async () => {
  const dir = tempDir();
  try {
    await assert.rejects(() => store.create(dir, { title: "  ", text: "x" }));
    await assert.rejects(() => store.create(dir, { title: "x", text: "   " }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("update mutates title/text and keeps the id", async () => {
  const dir = tempDir();
  try {
    const created = await store.create(dir, { title: "A", text: "one" });
    const updated = await store.update(dir, created.id, { title: "B", text: "two" });
    assert.equal(updated.id, created.id);
    assert.equal(updated.title, "B");
    assert.equal(updated.text, "two");
    const result = await store.readAll(dir);
    assert.equal(result.prompts.length, 1);
    assert.equal(result.prompts[0].title, "B");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("update rejects a missing id", async () => {
  const dir = tempDir();
  try {
    await assert.rejects(() => store.update(dir, "pr-missing", { title: "X", text: "Y" }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("remove deletes only the target prompt", async () => {
  const dir = tempDir();
  try {
    const a = await store.create(dir, { title: "A", text: "1" });
    const b = await store.create(dir, { title: "B", text: "2" });
    const result = await store.remove(dir, a.id);
    assert.equal(result.deleted, true);
    const after = await store.readAll(dir);
    assert.equal(after.prompts.length, 1);
    assert.equal(after.prompts[0].id, b.id);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt JSON → readAll throws and never overwrites the file", async () => {
  const dir = tempDir();
  try {
    fs.mkdirSync(path.dirname(storeFile(dir)), { recursive: true });
    fs.writeFileSync(storeFile(dir), "{ this is not json", "utf8");
    const before = fs.readFileSync(storeFile(dir), "utf8");

    await assert.rejects(() => store.readAll(dir), /повреждён/);
    await assert.rejects(() => store.create(dir, { title: "x", text: "y" }), /повреждён/);

    const after = fs.readFileSync(storeFile(dir), "utf8");
    assert.equal(after, before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("corrupt JSON → update and remove also refuse to write", async () => {
  const dir = tempDir();
  try {
    fs.mkdirSync(path.dirname(storeFile(dir)), { recursive: true });
    fs.writeFileSync(storeFile(dir), "[1,2,3]", "utf8");
    const before = fs.readFileSync(storeFile(dir), "utf8");

    await assert.rejects(() => store.update(dir, "pr-x", { title: "x", text: "y" }), /повреждён/);
    await assert.rejects(() => store.remove(dir, "pr-x"), /повреждён/);

    assert.equal(fs.readFileSync(storeFile(dir), "utf8"), before);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("readAll drops malformed entries but keeps valid ones", async () => {
  const dir = tempDir();
  try {
    fs.mkdirSync(path.dirname(storeFile(dir)), { recursive: true });
    fs.writeFileSync(
      storeFile(dir),
      JSON.stringify({
        version: 1,
        prompts: [
          { id: "ok", title: "Valid", text: "body", createdAt: 1, updatedAt: 1 },
          { noId: true, title: "No id" },
          null,
        ],
      }),
      "utf8"
    );
    const result = await store.readAll(dir);
    assert.equal(result.prompts.length, 1);
    assert.equal(result.prompts[0].id, "ok");
    assert.equal(result.prompts[0].text, "body");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
