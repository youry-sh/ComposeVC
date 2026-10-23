const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const store = require("../../electron/labIn/knowledgeStore.cjs");
const archive = require("../../electron/labIn/knowledgeArchive.cjs");

async function write(file, content) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  await fs.promises.writeFile(file, content, "utf8");
}

async function main() {
  const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), "composevc-kg-archive-"));
  const sourceData = path.join(base, "userdata-source");
  const targetData = path.join(base, "userdata-target");
  const desktop = path.join(base, "desktop");
  const project = path.join(base, "project");

  try {
    await assert.rejects(
      () => archive.exportKnowledgeArchive(sourceData, { desktopPath: desktop, rootPath: project }),
      /empty/i,
      "an empty knowledge base must not produce an archive"
    );

    const alpha = await store.addKnowledge(sourceData, {
      title: "Alpha chunk",
      content: "Alpha body: preserve user edits and verify the build.",
      tags: ["alpha", "quality"],
      source: "archive-test",
    });
    const beta = await store.addKnowledge(sourceData, {
      title: "Beta chunk",
      content: "Beta body: links must survive a ZIP round trip.",
      tags: ["beta"],
      links: [alpha.created[0].id],
      source: "archive-test",
    });
    assert.equal(alpha.created.length, 1);
    assert.equal(beta.created.length, 1);

    const exported = await archive.exportKnowledgeArchive(sourceData, {
      desktopPath: desktop,
      rootPath: project,
    });
    assert.equal(exported.chunkCount, 2);
    assert.equal(exported.copies.length, 2, "archive is copied to the desktop and the project folder");
    assert.ok(fs.existsSync(path.join(desktop, exported.archiveName)));
    assert.ok(fs.existsSync(path.join(project, exported.archiveName)));
    assert.ok(exported.bytes > 0);

    const zipPath = path.join(desktop, exported.archiveName);
    const imported = await archive.importKnowledgeArchive(targetData, zipPath);
    assert.equal(imported.imported, 2);
    assert.equal(imported.duplicates, 0);
    assert.equal(imported.totalChunks, 2);
    assert.equal(imported.skipped, 0);

    const alphaId = imported.created.find((entry) => entry.title === "Alpha chunk")?.id;
    const betaId = imported.created.find((entry) => entry.title === "Beta chunk")?.id;
    assert.ok(alphaId && betaId, "both chunks are restored with their titles");

    const restoredAlpha = await store.getKnowledgeChunk(targetData, alphaId);
    assert.match(restoredAlpha.content, /Alpha body/);
    assert.equal(restoredAlpha.content.includes("LAB-IN"), false, "the storage header is stripped from content");
    assert.deepEqual(restoredAlpha.tags, ["alpha", "quality"]);

    const restoredBeta = await store.getKnowledgeChunk(targetData, betaId);
    assert.match(restoredBeta.content, /Beta body/);
    assert.deepEqual(restoredBeta.links, [alphaId], "links are remapped onto the restored ids");

    const second = await archive.importKnowledgeArchive(targetData, zipPath);
    assert.equal(second.imported, 0);
    assert.equal(second.duplicates, 2, "a repeated import is idempotent");

    // A hand-made archive without manifest.json: plain Markdown must be understood.
    const manual = path.join(base, "manual");
    await write(
      path.join(manual, "kb-manual-note.md"),
      "# Manual note\n\nTags: manual\nLinks: (none)\n\nHand-written knowledge survives.\n"
    );
    const manualImport = await store.importKnowledgeSnapshot(targetData, manual);
    assert.equal(manualImport.imported, 1);
    assert.equal(manualImport.created[0].title, "Manual note");
    assert.deepEqual(manualImport.created[0].tags, ["manual"]);
    assert.deepEqual(manualImport.created[0].links, []);
    const manualChunk = await store.getKnowledgeChunk(targetData, manualImport.created[0].id);
    assert.match(manualChunk.content, /Hand-written knowledge/);

    // Colliding ids with different content are regenerated, not overwritten.
    const collision = path.join(base, "collision");
    await write(
      path.join(collision, `${alphaId}.md`),
      `<!-- LAB-IN ${JSON.stringify({ id: alphaId, title: "Collision", tags: ["collision"] })} -->\n# Collision\n\nKnowledge-ID: ${alphaId}\nTags: collision\nLinks: (none)\nSource: manual\n\nDifferent content under the same id.\n`
    );
    const collisionImport = await store.importKnowledgeSnapshot(targetData, collision);
    assert.equal(collisionImport.imported, 1);
    assert.notEqual(collisionImport.created[0].id, alphaId);
    assert.match((await store.getKnowledgeChunk(targetData, collisionImport.created[0].id)).content, /Different content/);
    assert.match((await store.getKnowledgeChunk(targetData, alphaId)).content, /Alpha body/, "the original chunk is untouched");

    await assert.rejects(
      () => archive.importKnowledgeArchive(targetData, path.join(base, "missing.zip")),
      /not found/i
    );
    const textFile = path.join(base, "notes.txt");
    await fs.promises.writeFile(textFile, "not a zip", "utf8");
    await assert.rejects(
      () => archive.importKnowledgeArchive(targetData, textFile),
      /\.zip/i
    );

    console.log("knowledge archive: export + import + dedupe + links + collisions OK");
  } finally {
    await fs.promises.rm(base, { recursive: true, force: true }).catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
