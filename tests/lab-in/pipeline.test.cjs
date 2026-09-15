const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const store = require("../../electron/labIn/knowledgeStore.cjs");
const { runLabInPipeline } = require("../../electron/labIn/index.cjs");
const { buildHandoffSequence } = require("../../electron/labIn/prompts.cjs");

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
    let activeResearchers = 0;
    let maxConcurrentResearchers = 0;
    const fakeRunAgentLoop = async (options) => {
      calls.push(options);
      if (options.disableTools) {
        return { text: "Implement the feature completely and verify the build.", messages: [] };
      }
      const prompt = String(options.messages?.[0]?.content || "");
      const isSynthesis = prompt.includes("## LAB-IN Search Team synthesis");
      if (!isSynthesis) {
        activeResearchers += 1;
        maxConcurrentResearchers = Math.max(maxConcurrentResearchers, activeResearchers);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const emit = (toolCallId, name, input) => {
        options.onProgress?.({ type: "tool_start", toolCallId, name, input });
        options.onProgress?.({ type: "tool_end", toolCallId, name, ok: true, result: "ok" });
      };
      emit("g1", "grep", { pattern: "verify|behavior", path: options.rootPath });
      emit("r1", "read_file", { path: path.join(options.rootPath, "chunks", "example.md") });
      emit("l1", "knowledge", { action: "links", id: "example" });
      if (!isSynthesis) activeResearchers -= 1;
      return {
        text: isSynthesis
          ? "Consolidated team package: preserve behavior and verify the build. No contradictions found."
          : `Independent report: ${prompt.includes("Specialist:") ? "helper" : "lead"} found the applicable chunk guide.`,
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

    assert.equal(calls.length, 6, "refiner, four parallel researchers, and Search Lead synthesis run");
    assert.equal(calls[0].model.id, "prompt");
    const researchCalls = calls.slice(1, 5);
    assert.equal(researchCalls.length, 4);
    assert.ok(researchCalls.every((call) => call.model.id === "search"));
    assert.ok(researchCalls.every((call) => call.toolContext.knowledgeReadOnly === true));
    assert.equal(maxConcurrentResearchers, 4, "Search Lead and three helpers run concurrently");
    assert.equal(researchCalls.filter((call) => call.messages[0].content.includes("Specialist:")).length, 3);
    assert.match(researchCalls[0].messages[0].content, /You are the Search Lead/);
    assert.match(researchCalls[0].systemPrompt, /reusable prompt, prompt template/);
    assert.ok(researchCalls.some((call) => /connection\/setup procedures/.test(call.messages[0].content)));
    assert.match(calls[5].messages[0].content, /Research report 4/);
    assert.match(calls[5].messages[0].content, /reusable prompts\/templates, complete methodologies/);
    assert.equal(result.meta.coverage, true);
    assert.deepEqual(result.meta.counts, { search: 5, read: 5, links: 5, total: 15 });
    assert.equal(result.meta.searchPasses, 5);
    assert.equal(result.meta.searchTeam.researcherCount, 4);
    assert.equal(result.meta.searchTeam.helperCount, 3);
    assert.match(result.handoffUserMessage, /LAB-IN EXECUTION PACKAGE/);
    assert.match(result.handoffUserMessage, /Implement the feature completely/);
    assert.match(result.handoffUserMessage, /preserve behavior and verify the build/);
    assert.equal(result.handoffMessages.length, 1, "small packages stay in one execution message");

    const largeKnowledge = [
      `## Guide A\n${"A".repeat(15000)}`,
      `## Prompt template\n${"B".repeat(15000)}`,
      `## Verification methodology\n${"C".repeat(15000)}`,
    ].join("\n\n");
    const staged = buildHandoffSequence({
      originalTask: "implement the system",
      refinedPrompt: "Implement the system and verify it.",
      knowledgePackage: largeKnowledge,
      knowledgeMeta: { chunkCount: 12 },
      maxPartChars: 12000,
    });
    assert.equal(staged.segmented, true);
    assert.ok(staged.partCount >= 4);
    assert.equal(staged.messages.length, staged.partCount * 2 + 1);
    for (let index = 0; index < staged.partCount; index += 1) {
      assert.equal(staged.messages[index * 2].role, "user");
      assert.match(staged.messages[index * 2].content, new RegExp(`LAB-IN KNOWLEDGE PART ${index + 1}/${staged.partCount}`));
      assert.equal(staged.messages[index * 2 + 1].role, "assistant");
      assert.match(staged.messages[index * 2 + 1].content, new RegExp(`LAB-IN PART ACK ${index + 1}/${staged.partCount}`));
    }
    assert.match(staged.messages.at(-1).content, /LAB-IN EXECUTE AFTER KNOWLEDGE PARTS/);
    assert.equal(
      staged.parts.join("").replace(/\s+/g, ""),
      largeKnowledge.replace(/\s+/g, ""),
      "segmentation preserves the full knowledge payload"
    );
    console.log("LAB-IN pipeline tests passed");
  } finally {
    await fs.promises.rm(userDataPath, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
