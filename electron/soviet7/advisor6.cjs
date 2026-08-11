/**
 * soviet-7 advisor unit file #6
 * Prompt content is SHARED (identical) — no specialty role.
 */
const {
  SOVIET7_ADVISOR_SYSTEM_PROMPT,
  buildAdvisorUserPrompt,
} = require("./sharedPrompt.cjs");

module.exports = {
  id: "soviet7-advisor-6",
  index: 5,
  label: "Advisor 6",
  systemPrompt: SOVIET7_ADVISOR_SYSTEM_PROMPT,
  buildUserPrompt: buildAdvisorUserPrompt,
};
