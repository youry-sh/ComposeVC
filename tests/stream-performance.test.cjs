const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { performance } = require("node:perf_hooks");
const ts = require("typescript");
const { createEventStreamParser } = require("../electron/adapters/utils.cjs");

function loadTypeScriptModule(file) {
  const source = fs.readFileSync(file, "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
    },
  }).outputText;
  const loaded = { exports: {} };
  Function("require", "module", "exports", output)(require, loaded, loaded.exports);
  return loaded.exports;
}

function decodeFast(payload, chunkSize = payload.length) {
  let count = 0;
  let checksum = 0;
  const parser = createEventStreamParser(
    (event) => {
      count += 1;
      checksum += event.n || 0;
    },
    { collectEvents: false }
  );
  for (let offset = 0; offset < payload.length; offset += chunkSize) {
    parser.push(payload.slice(offset, offset + chunkSize));
  }
  const retained = parser.finish();
  assert.deepEqual(retained, []);
  return { count, checksum };
}

function decodeLegacy(payload) {
  let buffer = payload.replace(/\r\n/g, "\n");
  let count = 0;
  let checksum = 0;
  const emit = (frame) => {
    const dataLines = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());
    const data = (dataLines.length ? dataLines.join("\n") : frame).trim();
    if (!data || data === "[DONE]") return;
    const event = JSON.parse(data);
    count += 1;
    checksum += event.n || 0;
  };
  let boundary;
  while ((boundary = buffer.indexOf("\n\n")) !== -1) {
    emit(buffer.slice(0, boundary));
    buffer = buffer.slice(boundary + 2);
  }
  if (buffer.trim()) emit(buffer);
  return { count, checksum };
}

function testArbitraryChunkBoundaries() {
  const payload = [
    ": keep-alive\r\n",
    "data: {\"n\":1,\"text\":\"alpha\"}\r\n\r\n",
    "data: {\"n\":2,\"text\":\"beta\"}\n\n",
    "{\"n\":3,\"text\":\"bare-json\"}\n",
    "data: [DONE]\n\n",
  ].join("");
  const expected = { count: 3, checksum: 6 };
  assert.deepEqual(decodeFast(payload, 1), expected);
  assert.deepEqual(decodeFast(payload, 7), expected);
  assert.deepEqual(decodeFast(payload, 64), expected);
}

function testLargeChunkSpeed() {
  const eventCount = 20_000;
  let payload = "";
  for (let i = 0; i < eventCount; i += 1) {
    payload += `data: {\"n\":${i},\"choices\":[{\"delta\":{\"content\":\"token-${i}\"}}]}\n\n`;
  }
  const expectedChecksum = ((eventCount - 1) * eventCount) / 2;

  // Warm up JIT before measuring.
  decodeFast(payload);
  const fastStart = performance.now();
  const fast = decodeFast(payload);
  const fastMs = performance.now() - fastStart;

  const legacyStart = performance.now();
  const legacy = decodeLegacy(payload);
  const legacyMs = performance.now() - legacyStart;

  assert.deepEqual(fast, { count: eventCount, checksum: expectedChecksum });
  assert.deepEqual(legacy, fast);
  const speedup = legacyMs / Math.max(fastMs, 0.01);
  assert.ok(speedup >= 1, `optimized SSE parser regressed: ${speedup.toFixed(2)}x`);
  console.log(
    `SSE scan: ${speedup.toFixed(1)}x faster (${legacyMs.toFixed(1)}ms -> ${fastMs.toFixed(1)}ms)`
  );
}

function testIncrementalMarkdownSpeed() {
  const markdown = loadTypeScriptModule(
    path.join(__dirname, "..", "src", "components", "markdown", "parseMarkdown.ts")
  );
  const updates = [];
  let content = "";
  for (let i = 0; i < 1_200; i += 1) {
    content +=
      `## Stream section ${i}\n\n` +
      `- exact item ${i} with **formatting** and \`symbol_${i}\`\n` +
      `- verification result ${i}\n\n`;
    updates.push(content);
  }

  // Warm both paths before measuring.
  markdown.parseMarkdown(updates[20]);
  let warmState = markdown.EMPTY_INCREMENTAL_MARKDOWN;
  for (let i = 0; i < 20; i += 1) {
    warmState = markdown.updateIncrementalMarkdown(warmState, updates[i]);
  }

  const legacyStart = performance.now();
  let legacyBlocks = [];
  for (const value of updates) legacyBlocks = markdown.parseMarkdown(value);
  const legacyMs = performance.now() - legacyStart;

  const fastStart = performance.now();
  let state = markdown.EMPTY_INCREMENTAL_MARKDOWN;
  for (const value of updates) state = markdown.updateIncrementalMarkdown(state, value);
  const fastMs = performance.now() - fastStart;

  assert.deepEqual(state.blocks, legacyBlocks, "incremental Markdown must equal a final full parse");
  const speedup = legacyMs / Math.max(fastMs, 0.01);
  assert.ok(speedup >= 5, `expected at least 5x Markdown speedup, measured ${speedup.toFixed(2)}x`);
  console.log(
    `stream Markdown: ${speedup.toFixed(1)}x faster (${legacyMs.toFixed(1)}ms -> ${fastMs.toFixed(1)}ms)`
  );
}

function testIncrementalMarkdownSemantics() {
  const markdown = loadTypeScriptModule(
    path.join(__dirname, "..", "src", "components", "markdown", "parseMarkdown.ts")
  );
  const content = [
    "# Result",
    "",
    "Paragraph with **bold**, `code`, and https://example.com.",
    "",
    "| File | State |",
    "|:-----|------:|",
    "| a.ts | done |",
    "",
    "> Evidence",
    "> preserved",
    "",
    "```ts",
    "const value = 42;",
    "```",
    "",
    "- [x] tested",
    "- [ ] release",
  ].join("\n");

  let state = markdown.EMPTY_INCREMENTAL_MARKDOWN;
  for (let end = 1; end <= content.length; end += 7) {
    state = markdown.updateIncrementalMarkdown(state, content.slice(0, end));
  }
  state = markdown.updateIncrementalMarkdown(state, content);
  assert.deepEqual(state.blocks, markdown.parseMarkdown(content));

  const firstStableBlock = state.stableBlocks[0];
  const appended = markdown.updateIncrementalMarkdown(state, `${content}\n\nFinal tail`);
  assert.equal(appended.stableBlocks[0], firstStableBlock, "stable blocks must retain identity");
}

testArbitraryChunkBoundaries();
testLargeChunkSpeed();
testIncrementalMarkdownSpeed();
testIncrementalMarkdownSemantics();
console.log("stream-performance tests passed");
