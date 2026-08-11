const fs = require("fs");
const path = require("path");

const PROMPTS_FILE = "agent-prompts.json";

function getPromptsPath(userDataPath) {
  return path.join(userDataPath, PROMPTS_FILE);
}

/**
 * Read all tool & system prompt overrides from userData.
 * Returns { system: string|undefined, tools: { [toolName]: string } }
 */
async function readPromptOverrides(userDataPath) {
  try {
    const raw = await fs.promises.readFile(getPromptsPath(userDataPath), "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      return {
        system: typeof parsed.system === "string" ? parsed.system : undefined,
        tools: parsed.tools && typeof parsed.tools === "object" ? parsed.tools : {},
      };
    }
  } catch {
    /* file missing or invalid */
  }
  return { system: undefined, tools: {} };
}

/**
 * Save a single tool prompt override.
 */
async function saveToolPrompt(userDataPath, toolName, content) {
  const overrides = await readPromptOverrides(userDataPath);
  if (content && content.trim()) {
    overrides.tools[toolName] = content;
  } else {
    delete overrides.tools[toolName];
  }
  await writeOverrides(userDataPath, overrides);
  return true;
}

/**
 * Save the system prompt override.
 */
async function saveSystemPrompt(userDataPath, content) {
  const overrides = await readPromptOverrides(userDataPath);
  if (content && content.trim()) {
    overrides.system = content;
  } else {
    overrides.system = undefined;
  }
  await writeOverrides(userDataPath, overrides);
  return true;
}

/**
 * Reset a single tool prompt to default (remove override).
 */
async function resetToolPrompt(userDataPath, toolName) {
  const overrides = await readPromptOverrides(userDataPath);
  delete overrides.tools[toolName];
  await writeOverrides(userDataPath, overrides);
  return true;
}

/**
 * Reset system prompt to default.
 */
async function resetSystemPrompt(userDataPath) {
  const overrides = await readPromptOverrides(userDataPath);
  overrides.system = undefined;
  await writeOverrides(userDataPath, overrides);
  return true;
}

async function writeOverrides(userDataPath, overrides) {
  await fs.promises.writeFile(
    getPromptsPath(userDataPath),
    JSON.stringify(overrides, null, 2),
    "utf8"
  );
}

module.exports = {
  readPromptOverrides,
  saveToolPrompt,
  saveSystemPrompt,
  resetToolPrompt,
  resetSystemPrompt,
};
