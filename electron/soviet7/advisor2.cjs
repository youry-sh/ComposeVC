/**
 * soviet-7 advisor unit file #2
 * Prompt content is SHARED (identical) — no specialty role.
 */
const {
  SOVIET7_ADVISOR_SYSTEM_PROMPT,
  buildAdvisorUserPrompt,
} = require("./sharedPrompt.cjs");

module.exports = {
  id: "soviet7-advisor-2",
  index: 1,
  label: "Advisor 2",
  systemPrompt: SOVIET7_ADVISOR_SYSTEM_PROMPT,
  buildUserPrompt: buildAdvisorUserPrompt,
};
