/**
 * soviet-7 advisor unit file #3
 * Prompt content is SHARED (identical) — no specialty role.
 */
const {
  SOVIET7_ADVISOR_SYSTEM_PROMPT,
  buildAdvisorUserPrompt,
} = require("./sharedPrompt.cjs");

module.exports = {
  id: "soviet7-advisor-3",
  index: 2,
  label: "Advisor 3",
  systemPrompt: SOVIET7_ADVISOR_SYSTEM_PROMPT,
  buildUserPrompt: buildAdvisorUserPrompt,
};
