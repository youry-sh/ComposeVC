/**
 * soviet-7 advisor unit file #5
 * Prompt content is SHARED (identical) — no specialty role.
 */
const {
  SOVIET7_ADVISOR_SYSTEM_PROMPT,
  buildAdvisorUserPrompt,
} = require("./sharedPrompt.cjs");

module.exports = {
  id: "soviet7-advisor-5",
  index: 4,
  label: "Advisor 5",
  systemPrompt: SOVIET7_ADVISOR_SYSTEM_PROMPT,
  buildUserPrompt: buildAdvisorUserPrompt,
};
