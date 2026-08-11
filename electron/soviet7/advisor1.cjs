/**
 * soviet-7 advisor unit file #1
 * Separate file so each seat can be swapped/versioned later without orchestrator copy-paste.
 * Prompt content is SHARED (identical) — do not invent a specialty role here.
 */
const {
  SOVIET7_ADVISOR_SYSTEM_PROMPT,
  buildAdvisorUserPrompt,
} = require("./sharedPrompt.cjs");

module.exports = {
  id: "soviet7-advisor-1",
  index: 0,
  label: "Advisor 1",
  systemPrompt: SOVIET7_ADVISOR_SYSTEM_PROMPT,
  buildUserPrompt: buildAdvisorUserPrompt,
};
