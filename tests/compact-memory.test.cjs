const assert = require("node:assert/strict");

const {
  DEFAULT_KEEP_RECENT,
  CHAT_COMPACTION_SYSTEM_PROMPT,
  COMPACTION_SECTIONS,
  truncateForCompaction,
  buildCompactionTranscript,
  compactionWordTarget,
  assessCompactionSummary,
  ensureLastUserPreserved,
} = require("../electron/compact.cjs");

function testPromptIsDurableCheckpoint() {
  assert.equal(DEFAULT_KEEP_RECENT, 12);
  assert.match(CHAT_COMPACTION_SYSTEM_PROMPT, /NOT a brief conversational summary/);
  assert.match(CHAT_COMPACTION_SYSTEM_PROMPT, /latest real intent/);
  assert.match(CHAT_COMPACTION_SYSTEM_PROMPT, /inherited memory/);
  assert.match(CHAT_COMPACTION_SYSTEM_PROMPT, /dirty\/untracked user changes/);
  assert.match(CHAT_COMPACTION_SYSTEM_PROMPT, /without guessing, repeating completed work/);
  assert.doesNotMatch(CHAT_COMPACTION_SYSTEM_PROMPT, /Max\s*~?\s*800 words/i);
  for (const section of COMPACTION_SECTIONS) {
    assert.ok(
      CHAT_COMPACTION_SYSTEM_PROMPT.includes(`## ${section}`),
      `missing compaction section: ${section}`
    );
  }
}

function testAdaptiveBudget() {
  assert.equal(compactionWordTarget(0), 900);
  assert.equal(compactionWordTarget(10_000), 1_800);
  assert.equal(compactionWordTarget(100_000), 2_600);
}

function testLongRowsKeepBeginningAndOutcome() {
  const source = `BEGIN:${"a".repeat(20_000)}:END`;
  const result = truncateForCompaction(source, 2_000);
  assert.ok(result.omittedChars > 0);
  assert.ok(result.text.startsWith("BEGIN:"));
  assert.ok(result.text.endsWith(":END"));
  assert.match(result.text, /COMPACTION SOURCE TRUNCATED/);
}

function testTranscriptCarriesToolAndInheritedMemory() {
  const longToolResult = `tool-start\n${"z".repeat(25_000)}\ntool-final-error`;
  const built = buildCompactionTranscript([
    {
      role: "assistant",
      content: "[Conversation summary — prior checkpoint]\nOld decision: keep SQLite.",
    },
    {
      role: "assistant",
      content: "Applying the change.",
      toolCalls: [{ id: "call-17", name: "edit_file", input: { path: "electron/compact.cjs" } }],
    },
    {
      role: "tool",
      toolName: "read_file",
      toolCallId: "call-18",
      content: longToolResult,
    },
  ]);

  assert.match(built.transcript, /inherited-memory=true/);
  assert.match(built.transcript, /TOOL CALL 1: edit_file id=call-17/);
  assert.match(built.transcript, /electron\/compact\.cjs/);
  assert.match(built.transcript, /tool=read_file/);
  assert.match(built.transcript, /toolCallId=call-18/);
  assert.match(built.transcript, /tool-start/);
  assert.match(built.transcript, /tool-final-error/);
  assert.equal(built.truncatedMessages, 1);
  assert.ok(built.omittedChars > 0);
}

function testQualityGateAndLatestUserPreservation() {
  const richSummary = `${COMPACTION_SECTIONS.map((section) => `## ${section}\n- precise state`).join("\n\n")}\n${"evidence ".repeat(150)}`;
  assert.equal(assessCompactionSummary(richSummary, 20_000).ok, true);
  assert.equal(assessCompactionSummary("Tiny summary", 20_000).ok, false);

  const lastUser = { role: "user", content: "Implement the exact final requirement" };
  const messages = [
    lastUser,
    ...Array.from({ length: 20 }, (_, index) => ({
      role: index % 2 ? "tool" : "assistant",
      content: `row-${index}`,
    })),
  ];
  const recent = ensureLastUserPreserved(messages, messages.slice(-12));
  assert.equal(recent[0].content, lastUser.content);
}

testPromptIsDurableCheckpoint();
testAdaptiveBudget();
testLongRowsKeepBeginningAndOutcome();
testTranscriptCarriesToolAndInheritedMemory();
testQualityGateAndLatestUserPreservation();

console.log("compact-memory tests passed");
