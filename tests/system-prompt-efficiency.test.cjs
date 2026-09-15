const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { buildSystemPrompt } = require("../electron/context.cjs");
const { THINKING_MAX_PROMPT } = require("../electron/thinkingMaxPrompt.cjs");

async function main() {
  const userDataPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), "composevc-system-prompt-"));
  try {
    const prompt = await buildSystemPrompt({
      rootPath: null,
      projectName: "Prompt test",
      userDataPath,
    });

    assert.match(prompt, /EXECUTION EFFICIENCY \/ COHERENT CHANGE SETS/);
    assert.match(prompt, /one bounded discovery pass before the first write/);
    assert.match(prompt, /form one internal change set covering all foreseeable work/);
    assert.match(prompt, /prepare every known hunk before the first edit/);
    assert.match(prompt, /NEVER parallel-write the same file/);
    assert.match(prompt, /Do not follow edit_file with read_file merely to confirm/);
    assert.match(prompt, /Verify by coherent phase, not after every line or every file/);
    assert.match(prompt, /A second edit pass requires new evidence/);
    assert.match(prompt, /Every tool call must do at least one of three things/);
    assert.match(prompt, /If two attempts fail for the same underlying reason/);
    assert.ok(
      prompt.indexOf("FILE WRITE RULE") < prompt.indexOf("EXECUTION EFFICIENCY / COHERENT CHANGE SETS") &&
      prompt.indexOf("EXECUTION EFFICIENCY / COHERENT CHANGE SETS") < prompt.indexOf("CODE IMPACT / RELATIONS"),
      "efficiency protocol must refine the write workflow without overriding safety and impact checks"
    );
    assert.match(prompt, /CORE OPERATING CONTRACT/);
    assert.match(prompt, /answer\/review\/report means inspect and explain without mutating/);
    assert.match(prompt, /Treat every pre-existing modified\/untracked file as owned by the user/);
    assert.match(prompt, /Separate evidence from inference/);
    assert.match(prompt, /Authority is not transferable between categories/);
    assert.match(prompt, /ENGINEERING REASONING \/ ROOT-CAUSE PROTOCOL/);
    assert.match(prompt, /earliest incorrect state transition/);
    assert.match(prompt, /cancellation, retry, timeout, duplicate delivery/);
    assert.match(prompt, /VERIFICATION \/ FINAL REPORT CONTRACT/);
    assert.match(prompt, /never translate 'not run' into 'passed'/);
    assert.match(prompt, /CUSTOM TOOL REUSE \/ CREATION POLICY/);
    assert.match(prompt, /Three related calls alone are NOT sufficient justification/);
    assert.doesNotMatch(prompt, /PREFLIGHT every non-trivial task/);
    assert.doesNotMatch(prompt, /PROACTIVE USE IS REQUIRED/);
    assert.match(prompt, /do not impose these product-specific choices on unrelated projects/);
    assert.match(prompt, /when the relevant path\/area is already known, read_file it directly/);
    assert.match(THINKING_MAX_PROMPT, /COHERENT EDIT PASSES/);
    assert.match(THINKING_MAX_PROMPT, /prepare the complete affected-file\/change/);
    console.log("System prompt efficiency tests passed");
  } finally {
    await fs.promises.rm(userDataPath, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
