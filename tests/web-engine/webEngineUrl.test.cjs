const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

// The function is pure TS with no imports — transpile the real source to CommonJS
// so the test exercises the actual implementation, not a copy.
const srcPath = path.join(__dirname, "..", "..", "src", "utils", "webEngineUrl.ts");
const src = fs.readFileSync(srcPath, "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

const moduleObj = { exports: {} };
const factory = new Function("exports", "module", `${js}\nreturn module.exports;`);
const { normalizeUrl } = factory(moduleObj.exports, moduleObj);

test("normalizeUrl accepts and normalizes dev + public urls", () => {
  assert.equal(normalizeUrl("localhost:3000"), "http://localhost:3000");
  assert.equal(normalizeUrl("127.0.0.1:5173"), "http://127.0.0.1:5173");
  assert.equal(normalizeUrl("localhost"), "http://localhost");
  assert.equal(normalizeUrl("http://localhost:3000/app"), "http://localhost:3000/app");
  assert.equal(normalizeUrl("https://example.com"), "https://example.com");
  assert.equal(normalizeUrl("example.com"), "https://example.com");
  assert.equal(normalizeUrl("example.com:8080"), "http://example.com:8080");
  assert.equal(normalizeUrl("//localhost:3000"), "http://localhost:3000");
});

test("normalizeUrl rejects invalid input", () => {
  assert.equal(normalizeUrl(""), null);
  assert.equal(normalizeUrl("   "), null);
  assert.equal(normalizeUrl("not a url with spaces"), null);
  assert.equal(normalizeUrl("javascript:alert(1)"), null);
  assert.equal(normalizeUrl("file:///etc/passwd"), null);
});
