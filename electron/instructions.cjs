const fs = require("fs");
const path = require("path");

const GLOBAL_INSTRUCTIONS_FILE = "instructions.md";
const PROJECT_DIR_NAME = ".lopster";
const PROJECT_INSTRUCTIONS_FILE = "instructions.md";

function getGlobalInstructionsPath(userDataPath) {
  return path.join(userDataPath, GLOBAL_INSTRUCTIONS_FILE);
}

function getProjectInstructionsPath(rootPath) {
  return path.join(rootPath, PROJECT_DIR_NAME, PROJECT_INSTRUCTIONS_FILE);
}

async function readGlobalInstructions(userDataPath) {
  try {
    return await fs.promises.readFile(getGlobalInstructionsPath(userDataPath), "utf8");
  } catch {
    return "";
  }
}

async function saveGlobalInstructions(userDataPath, content) {
  await fs.promises.writeFile(getGlobalInstructionsPath(userDataPath), content || "", "utf8");
  return content || "";
}

async function readProjectInstructions(rootPath) {
  if (!rootPath) return "";
  try {
    return await fs.promises.readFile(getProjectInstructionsPath(rootPath), "utf8");
  } catch {
    return "";
  }
}

async function saveProjectInstructions(rootPath, content) {
  if (!rootPath) {
    throw new Error("No project folder is open — project instructions require an open folder");
  }
  const dir = path.join(rootPath, PROJECT_DIR_NAME);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(getProjectInstructionsPath(rootPath), content || "", "utf8");
  return content || "";
}

async function readAllInstructions(userDataPath, rootPath) {
  const [globalText, projectText] = await Promise.all([
    readGlobalInstructions(userDataPath),
    readProjectInstructions(rootPath),
  ]);
  return { global: globalText, project: projectText };
}

module.exports = {
  readGlobalInstructions,
  saveGlobalInstructions,
  readProjectInstructions,
  saveProjectInstructions,
  readAllInstructions,
};
