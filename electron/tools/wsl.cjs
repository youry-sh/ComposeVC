const { execFile, spawnSync } = require("child_process");
const path = require("path");
const bashTool = require("./bash.cjs");

const DEFAULT_TIMEOUT_MS = 300_000;
const MAX_OUTPUT_CHARS = 20_000;
const liveChildren = new Set();

function decode(buffer) {
  if (!buffer) return "";
  const raw = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
  // wsl.exe management commands use UTF-16LE on many localized Windows builds.
  const text = raw.includes(0) ? raw.toString("utf16le") : raw.toString("utf8");
  return text.replace(/^\uFEFF/, "").replace(/\0/g, "").trim();
}

function truncate(value) {
  const text = String(value || "");
  return text.length <= MAX_OUTPUT_CHARS
    ? text
    : `${text.slice(0, MAX_OUTPUT_CHARS)}\n... (truncated, ${text.length} chars total)`;
}

function validateDistro(value) {
  const distro = String(value || "").trim();
  if (!distro) return "";
  if (distro.startsWith("-") || /[\r\n\0]/.test(distro)) throw new Error("Invalid WSL distribution name");
  return distro;
}

function wslUnavailable(error) {
  return error?.code === "ENOENT" || /not recognized|cannot find|not found/i.test(String(error?.message || ""));
}

function runWsl(args, { cwd, timeout, signal } = {}) {
  if (process.platform !== "win32") {
    throw new Error("The wsl tool is available only on Windows hosts. Use bash on Linux.");
  }
  if (signal?.aborted) throw Object.assign(new Error("Stopped by user"), { name: "AbortError" });
  return new Promise((resolve, reject) => {
    let child;
    const done = (error, stdout, stderr) => {
      liveChildren.delete(child);
      if (signal) signal.removeEventListener("abort", abort);
      if (wslUnavailable(error)) {
        reject(new Error("WSL is not installed or wsl.exe is unavailable. Ask the user to install WSL and a Linux distribution first."));
        return;
      }
      if (error?.killed || signal?.aborted) {
        reject(Object.assign(new Error(signal?.aborted ? "Stopped by user" : `WSL command timed out after ${timeout}ms`), { name: signal?.aborted ? "AbortError" : "TimeoutError" }));
        return;
      }
      resolve({ exitCode: error ? error.code ?? 1 : 0, stdout: truncate(decode(stdout)), stderr: truncate(decode(stderr)) });
    };
    child = execFile("wsl.exe", args, {
      cwd: cwd && path.isAbsolute(cwd) ? cwd : undefined,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      encoding: "buffer",
      windowsHide: true,
    }, done);
    liveChildren.add(child);
    const abort = () => {
      if (child?.pid) spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      liveChildren.delete(child);
    };
    if (signal) signal.addEventListener("abort", abort, { once: true });
  });
}

function disposeAll() {
  let killed = 0;
  for (const child of [...liveChildren]) {
    if (child?.pid) {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killed += 1;
    }
    liveChildren.delete(child);
  }
  return { killed };
}

module.exports = {
  name: "wsl",
  description:
    "Manage and use Windows Subsystem for Linux as a real terminal. Use when the user asks for WSL/Linux-on-Windows work or when Linux tooling is genuinely needed. Actions: status checks installation/configuration, list shows distributions and running state, start boots a distribution, run executes a bash command inside it, terminate stops one distribution, shutdown stops all WSL instances. Never install WSL or a distribution automatically: if unavailable, clearly tell the user. run supports pipes, redirects, package managers, builds, tests, scripts, and long timeouts like bash. Dangerous Linux disk/root wipes and host shutdown commands are blocked before execution. Prefer read_file/grep for reading project sources.",
  isReadOnly: false,
  disposeAll,
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["status", "list", "start", "run", "terminate", "shutdown"] },
      command: { type: "string", description: "Linux bash command; required for run." },
      distro: { type: "string", description: "Optional WSL distribution name; default distribution when omitted." },
      cwd: { type: "string", description: "Optional Windows project working directory inherited and mapped by WSL." },
      timeout_ms: { type: "number", description: "Timeout in milliseconds; default 300000, with no hard maximum." },
    },
    required: ["action"],
  },
  async execute(input = {}, context = {}) {
    const action = String(input.action || "").toLowerCase();
    const distro = validateDistro(input.distro);
    const timeout = bashTool.resolveTimeoutMs(input.timeout_ms || DEFAULT_TIMEOUT_MS);
    const common = { cwd: input.cwd || context.rootPath || process.cwd(), timeout, signal: context.signal };
    let args;
    if (action === "status") args = ["--status"];
    else if (action === "list") args = ["--list", "--verbose"];
    else if (action === "start") args = [...(distro ? ["--distribution", distro] : []), "--exec", "/bin/true"];
    else if (action === "terminate") {
      if (!distro) throw new Error("wsl action=terminate requires distro");
      args = ["--terminate", distro];
    } else if (action === "shutdown") args = ["--shutdown"];
    else if (action === "run") {
      const command = String(input.command || "").trim();
      if (!command) throw new Error("wsl action=run requires command");
      const hit = bashTool.checkLinuxCommandBlacklist(command);
      if (hit.blocked) throw new Error(`BLOCKED by WSL safety policy (${hit.id}): ${hit.why}. Command was not executed.`);
      args = [...(distro ? ["--distribution", distro] : []), "--exec", "/bin/bash", "-lc", command];
    } else throw new Error("action must be status, list, start, run, terminate, or shutdown");

    const result = await runWsl(args, common);
    const combined = `${result.stdout}\n${result.stderr}`;
    if (/no installed distributions|there are no distributions|WSL_E_DEFAULT_DISTRO_NOT_FOUND/i.test(combined)) {
      return { ...result, action, installed: true, distroInstalled: false, message: "WSL is installed, but no Linux distribution is available. Ask the user to install a distribution first." };
    }
    return { ...result, action, distro: distro || undefined, installed: true, distroInstalled: true };
  },
};
