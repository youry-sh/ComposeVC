const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const store = require("../../electron/labIn/knowledgeStore.cjs");
const { runLabInPipeline } = require("../../electron/labIn/index.cjs");

async function main() {
  const userDataPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "composevc-lab-in-pipeline-"));
  try {
    await store.addKnowledge(userDataPath, {
      title: "Test guide",
      content: "Preserve existing behavior and verify the final build.",
      tags: ["guide"],
    });

    const mainModel = { id: "main", name: "main-api", providerId: "p", contextLimit: 64000 };
    const promptModel = { id: "prompt", name: "prompt-api", providerId: "p", contextLimit: 32000 };
    const searchModel = { id: "search", name: "search-api", providerId: "p", contextLimit: 48000 };
    const provider = { id: "p", name: "Provider", type: "openai", baseUrl: "http://test", apiKey: "key" };
    const config = {
      providers: [provider],
      models: [mainModel, promptModel, searchModel],
      aiRuntime: { labInPromptModelId: "prompt", labInSearchModelId: "search" },
    };
    const calls = [];
    const fakeRunAgentLoop = async (options) => {
      calls.push(options);
      if (options.disableTools) {
        return { text: "Implement the feature completely and verify the build.", messages: [] };
      }
      const emit = (toolCallId, name, input) => {
        options.onProgress?.({ type: "tool_start", toolCallId, name, input });
        options.onProgress?.({ type: "tool_end", toolCallId, name, ok: true, result: "ok" });
      };
      emit("g1", "grep", { pattern: "verify|behavior", path: options.rootPath });
      emit("r1", "read_file", { path: path.join(options.rootPath, "chunks", "example.md") });
      emit("l1", "knowledge", { action: "links", id: "example" });
      return {
        text: "Chunk guide applies: preserve behavior and verify the build. No contradictions found.",
        messages: [{ role: "assistant", content: "searched" }],
      };
    };

    const result = await runLabInPipeline({
      runAgentLoop: fakeRunAgentLoop,
      config,
      mainModel,
      mainProvider: provider,
      originalTask: "add the feature",
      conversationContext: "USER: use the existing architecture",
      projectName: "ComposeVC",
      userDataPath,
      signal: new AbortController().signal,
      tokenCountingMode: "auto",
      sessionId: "test-session",
    });

    assert.equal(calls.length, 2, "refiner and one sufficiently-covered search pass run");
    assert.equal(calls[0].model.id, "prompt");
    assert.equal(calls[1].model.id, "search");
    assert.equal(calls[1].toolContext.knowledgeReadOnly, true);
    assert.equal(result.meta.coverage, true);
    assert.deepEqual(result.meta.counts, { search: 1, read: 1, links: 1, total: 3 });
    assert.match(result.handoffUserMessage, /LAB-IN EXECUTION PACKAGE/);
    assert.match(result.handoffUserMessage, /Implement the feature completely/);
    assert.match(result.handoffUserMessage, /preserve behavior and verify the build/);
    console.log("LAB-IN pipeline tests passed");
  } finally {
    await fs.promises.rm(userDataPath, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
