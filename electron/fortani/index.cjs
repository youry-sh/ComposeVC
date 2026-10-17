const { execFile } = require("child_process");
const { getToolSchemas } = require("../tools/registry.cjs");

const FORTANI_MODE_ID = "fortani";
const DIFF_CHAR_CAP = 70000;

function modelLabel(model) {
  return String(model?.name || model?.id || "main");
}

function resolveFortaniModel(config, mainModel, mainProvider) {
  const raw = String(config?.aiRuntime?.fortaniModelId || "").trim();
  const models = Array.isArray(config?.models) ? config.models : [];
  const providers = Array.isArray(config?.providers) ? config.providers : [];
  const wanted = raw.toLowerCase();
  const found = raw
    ? models.find((item) => String(item?.id || "").toLowerCase() === wanted) ||
      models.find((item) => String(item?.name || "").toLowerCase() === wanted)
    : null;
  const model = found || mainModel;
  const provider = providers.find((item) => item?.id === model?.providerId) || mainProvider;
  return {
    model,
    provider,
    source: found ? "fortani" : "main",
    warning: raw && !found ? `FoRtani model "${raw}" is missing; using ${modelLabel(mainModel)}` : null,
  };
}

function gitText(args, cwd) {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: 12000, maxBuffer: 6 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error && !stdout) {
        resolve("");
        return;
      }
      resolve(String(stdout || ""));
    });
  });
}

function cap(text, max) {
  const value = String(text || "");
  if (value.length <= max) return value.trim();
  return `${value.slice(0, max)}\n\n…[FoRtani host truncated the diff. Treat the omitted tail as unread and inspect those files yourself.]`;
}

async function collectChangePacket(rootPath) {
  if (!rootPath) {
    return "No project folder is open, so there is no diff. Inspect whatever the conversation says was edited.";
  }
  const [stat, diff, names] = await Promise.all([
    gitText(["diff", "--stat", "HEAD"], rootPath),
    gitText(["diff", "--no-color", "HEAD"], rootPath),
    gitText(["status", "--short"], rootPath),
  ]);
  const body = [names && `Status:\n${names.trim()}`, stat && `Stat:\n${stat.trim()}`, diff && `Diff:\n${diff.trim()}`]
    .filter(Boolean)
    .join("\n\n");
  if (!body.trim()) {
    return "Git reports no uncommitted changes. The previous agent may have changed nothing, or the folder is not a repository. Read the files the task names and confirm the work is actually done.";
  }
  return cap(body, DIFF_CHAR_CAP);
}

const REVIEW_TOOLS = new Set(["read_file", "grep", "list_dir", "think"]);

function reviewExclusions() {
  return getToolSchemas()
    .map((tool) => tool.name)
    .filter((name) => !REVIEW_TOOLS.has(name));
}

function buildReviewMessage(task, agentReport, changes) {
  return [
    "You are FoRtani, a review pass. You do not edit files, create files, or run commands that change the project. Read only.",
    "",
    "You can see two things: the task the user sent, and what the coding agent already did (its report and the diff). Compare them.",
    "Write a correction brief the same agent will follow when it comes back. Be concrete. Any language, any size of change.",
    "",
    "For each real problem write:",
    "- where it is (file, symbol, or the missing connection);",
    "- what the user asked versus what was actually done;",
    "- what is wrong: unfinished, wrong approach, not wired together, a codebase mechanism that should have been used and was not, a regression, or a claim that the files do not support;",
    "- the exact change to make instead.",
    "",
    "Cover the whole task, not one file. If two parts were written but never connected, say so. If an existing helper, type, or API in the project was ignored, name it.",
    "Do not ask for new features. Do not rewrite the task. If the work already matches the task, answer with CLEAR and list what you checked.",
    "No preamble. The brief is the whole answer.",
    "",
    "## Task the user sent",
    String(task || "").trim() || "(no task text)",
    "",
    "## What the agent reported",
    cap(agentReport, 12000) || "(no report)",
    "",
    "## What the agent changed",
    changes,
  ].join("\n");
}

function buildFixMessage(task, review) {
  return [
    "FoRtani reviewed your work against the user's task. Go back and fix what the review names. Do not start the task over and do not revert edits that the review did not reject.",
    "This is the last pass. When every listed problem is fixed, stop. If the review says CLEAR, do not change files; confirm that and stop.",
    "",
    "## Task the user sent",
    String(task || "").trim() || "(no task text)",
    "",
    "## FoRtani review — fix these",
    String(review || "").trim() || "(empty review — re-read the task and the files you changed, fix anything still wrong, then stop)",
  ].join("\n");
}

module.exports = {
  FORTANI_MODE_ID,
  resolveFortaniModel,
  collectChangePacket,
  reviewExclusions,
  buildReviewMessage,
  buildFixMessage,
};
