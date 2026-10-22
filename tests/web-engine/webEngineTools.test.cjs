const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const path = require("node:path");
const ts = require("typescript");

// The helpers are pure TS with no imports — transpile the real source so the
// test exercises the actual implementation, not a copy.
const srcPath = path.join(__dirname, "..", "..", "src", "utils", "webEngineTools.ts");
const src = fs.readFileSync(srcPath, "utf8");
const js = ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

const moduleObj = { exports: {} };
const factory = new Function("exports", "module", `${js}\nreturn module.exports;`);
const { nextDeviceWidth, clampZoomFactor } = factory(moduleObj.exports, moduleObj);

test("nextDeviceWidth cycles desktop → mobile → tablet → desktop", () => {
  assert.equal(nextDeviceWidth(null), 375, "desktop goes to mobile");
  assert.equal(nextDeviceWidth(375), 768, "mobile goes to tablet");
  assert.equal(nextDeviceWidth(768), null, "tablet returns to desktop");
  assert.equal(nextDeviceWidth(999), null, "unknown width resets to desktop");
});

test("clampZoomFactor bounds and sanitizes", () => {
  assert.equal(clampZoomFactor(1), 1);
  assert.equal(clampZoomFactor(0.1), 0.25, "clamps to the 25% floor");
  assert.equal(clampZoomFactor(9), 4, "clamps to the 400% ceiling");
  assert.equal(clampZoomFactor(0), 1, "non-positive falls back to 100%");
  assert.equal(clampZoomFactor(Number.NaN), 1, "NaN falls back to 100%");
});
