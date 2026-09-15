const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const store = require("../../electron/labIn/knowledgeStore.cjs");
const knowledgeTool = require("../../electron/tools/knowledge.cjs");

async function main() {
  const userDataPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "composevc-lab-in-store-"));
  try {
    const initial = await store.knowledgeStats(userDataPath);
    assert.equal(initial.chunkCount, 0);
    assert.ok(initial.root.endsWith(path.join("lab-in", "knowledge")));

    const first = await store.addKnowledge(userDataPath, {
      title: "Compose rules",
      content: "Always inspect the existing architecture before editing. Verify the build after implementation.",
      tags: ["coding", "quality"],
      source: "test",
    });
    assert.equal(first.created.length, 1);
    const firstId = first.created[0].id;

    const duplicate = await store.addKnowledge(userDataPath, {
      title: "Duplicate",
      content: "Always inspect the existing architecture before editing. Verify the build after implementation.",
    });
    assert.equal(duplicate.created.length, 0);
    assert.equal(duplicate.duplicates[0].id, firstId);

    const second = await store.addKnowledge(userDataPath, {
      title: "LAB-IN workflow",
      content: "The search agent must inspect relations and contradictory guidance before handing context to the main agent.",
      tags: ["lab-in", "quality"],
      links: [firstId],
      source: "test",
    });
    const secondId = second.created[0].id;

    const relation = await store.knowledgeLinks(userDataPath, firstId);
    assert.ok(relation.incoming.some((entry) => entry.id === secondId));
    assert.ok(relation.related.some((entry) => entry.id === secondId) === false, "explicit links are not duplicated as tag-only relations");

    const found = await store.searchKnowledge(userDataPath, "contradictory guidance");
    assert.equal(found[0].id, secondId);

    await store.updateKnowledge(userDataPath, {
      id: firstId,
      content: "Inspect architecture, preserve user changes, and run focused regression tests after implementation.",
      tags: ["coding", "regression"],
    });
    const updated = await store.getKnowledgeChunk(userDataPath, firstId);
    assert.match(updated.content, /focused regression tests/);
    assert.deepEqual(updated.tags, ["coding", "regression"]);

    const long = Array.from({ length: 12 }, (_, i) => `Section ${i + 1}\n${"x".repeat(180)}`).join("\n\n");
    const chunked = await store.addKnowledge(userDataPath, {
      title: "Large guide",
      content: long,
      chunkChars: 800,
      tags: ["large"],
    });
    assert.ok(chunked.created.length >= 2, "large knowledge is chunked");

    const deleted = await store.deleteKnowledge(userDataPath, firstId);
    assert.equal(deleted.deleted.id, firstId);
    assert.ok(deleted.trashPath.includes(path.join("knowledge", "trash")));
    assert.ok(fs.existsSync(deleted.trashPath), "deleted Markdown is recoverable from trash");
    await assert.rejects(() => store.getKnowledgeChunk(userDataPath, firstId), /not found/);
    const secondAfterDelete = await store.getKnowledgeChunk(userDataPath, secondId);
    assert.equal(secondAfterDelete.links.includes(firstId), false, "incoming links are cleaned up");
    assert.doesNotMatch(secondAfterDelete.content, /Knowledge-ID:/, "stored metadata is not mixed into content");

    await assert.rejects(
      () => knowledgeTool.execute(
        { action: "add", title: "Forbidden", content: "must not write" },
        { userDataPath, knowledgeReadOnly: true }
      ),
      /read-only/
    );

    const finalStats = await store.knowledgeStats(userDataPath);
    assert.equal(finalStats.chunkCount, 1 + chunked.created.length);
    console.log("LAB-IN knowledge store tests passed");
  } finally {
    await fs.promises.rm(userDataPath, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
