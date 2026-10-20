/**
 * Benchmark: proxy request conversion cost on huge chats (200k / 500k tokens).
 * Measures CPU per pipeline stage (normalize → convert → wire stringify) for
 * the main upstream formats. Run: node tests/proxy/large-context.bench.cjs
 */
const { normalizeOpenAIRequest, ensureToolCallIds, wireJsonStringify } = require("../../electron/proxy/openaiFormat.cjs");
const { openaiToResponsesRequest } = require("../../electron/proxy/convert/openai-to-responses.cjs");
const { openaiToAnthropicRequest } = require("../../electron/proxy/convert/openai-to-anthropic.cjs");
const { openaiToOpenAIRequest } = require("../../electron/proxy/convert/openai-passthrough.cjs");
const { openaiToAntigravityRequest } = require("../../electron/proxy/convert/openai-to-antigravity.cjs");

function makeChat(approxTokens) {
  // ~4 chars per token
  const targetChars = approxTokens * 4;
  const messages = [{ role: "system", content: "You are a coding agent. ".repeat(400) }];
  let chars = 0;
  let i = 0;
  const filler = "const value = computeSomething(alpha, beta); // line of code\n";
  while (chars < targetChars) {
    messages.push({ role: "user", content: `Step ${i}: ` + filler.repeat(20) });
    messages.push({
      role: "assistant",
      content: "Reading file",
      tool_calls: [{ id: `call_${i}`, type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: `src/f${i}.ts` }) } }],
    });
    const out = filler.repeat(120);
    messages.push({ role: "tool", tool_call_id: `call_${i}`, content: out });
    chars += out.length + filler.length * 20 + 60;
    i++;
  }
  const tools = Array.from({ length: 30 }, (_, k) => ({
    type: "function",
    function: { name: `tool_${k}`, description: "d".repeat(200), parameters: { type: "object", properties: { a: { type: "string" } } } },
  }));
  return { model: "gpt-5", stream: true, messages, tools };
}

function time(label, fn, runs = 5) {
  fn(); // warm
  const t0 = process.hrtime.bigint();
  let r;
  for (let k = 0; k < runs; k++) r = fn();
  const ms = Number(process.hrtime.bigint() - t0) / 1e6 / runs;
  console.log(`  ${label.padEnd(34)} ${ms.toFixed(1).padStart(8)} ms`);
  return r;
}

for (const tokens of [200_000, 500_000]) {
  const raw = makeChat(tokens);
  const rawText = JSON.stringify(raw);
  console.log(`\n== ~${tokens / 1000}k tokens, body ${(rawText.length / 1e6).toFixed(1)} MB, ${raw.messages.length} messages`);
  time("JSON.parse (server readBody)", () => JSON.parse(rawText));
  const body = time("normalize+ensureToolCallIds", () => ensureToolCallIds(normalizeOpenAIRequest(JSON.parse(rawText))));
  time("codex: toResponses + wire", () => wireJsonStringify(openaiToResponsesRequest(body, { upstreamModel: "gpt-5" })));
  time("anthropic: convert + wire", () => wireJsonStringify(openaiToAnthropicRequest(body, { upstreamModel: "claude-sonnet-4-5" })));
  time("openai passthrough + wire", () => wireJsonStringify(openaiToOpenAIRequest(body, { upstreamModel: "gpt-5", supportImages: true })));
  time("antigravity: convert + wire", () => wireJsonStringify(openaiToAntigravityRequest(body, { upstreamModel: "gemini-3-pro", projectId: "p" }).body));
}
