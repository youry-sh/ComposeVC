const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");
const { URL } = require("url");
const { layout, ensureDir, writeConfig } = require("./paths.cjs");
const { detect } = require("./detect.cjs");
const images = require("./images.cjs");

const WEILNETZ_INDEX = "https://qemu.weilnetz.de/w64/";

/**
 * The exact QEMU build ComposeVC is tested against. Pinned so every install is the same
 * 11.1.0, not "whatever weilnetz calls latest today". The archive url is permanent; the
 * bare index url is a faster mirror that rotates, and the index scrape is the last resort.
 * sha512 is verified before anything is extracted — a truncated installer never runs.
 */
const PINNED_QEMU = {
  version: "11.1.0",
  file: "qemu-w64-setup-20260811.exe",
  size: 206_615_928,
  sha512:
    "5bcf9eed634e8575a37b74f445af41a2fe4106da512d0c30c368301d4c105037fdfab40a5287367a28a957624cddebbc8c07e16c88ab6634f554cdf3d16bf543",
  urls: [
    "https://qemu.weilnetz.de/w64/2026/qemu-w64-setup-20260811.exe",
    "https://qemu.weilnetz.de/w64/qemu-w64-setup-20260811.exe",
  ],
};

let job = null;

function which(binary) {
  try {
    const out = execFileSync(process.platform === "win32" ? "where" : "which", [binary], {
      windowsHide: true,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const first = String(out).split(/\r?\n/).find(Boolean);
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

function sevenZip() {
  const candidates = [
    which("7z"),
    which("7za"),
    "C:\\Program Files\\7-Zip\\7z.exe",
    "C:\\Program Files (x86)\\7-Zip\\7z.exe",
  ];
  return candidates.find((file) => file && fs.existsSync(file)) || null;
}

function runStep(command, args, { timeoutMs = 20 * 60_000, cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true, cwd, shell: false });
    let out = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout?.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      out += chunk.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, code: -1, output: `${out}\n${err.message}` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code, output: out.slice(-4000) });
    });
  });
}

async function latestWindowsInstallerUrl() {
  const https = require("https");
  const html = await new Promise((resolve, reject) => {
    https
      .get(WEILNETZ_INDEX, { headers: { "user-agent": "ComposeVC-VM/1.0" }, timeout: 30_000 }, (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode} for ${WEILNETZ_INDEX}`));
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve(body));
      })
      .on("error", reject);
  });
  const names = [...html.matchAll(/href="(qemu-w64-setup-[\d]+\.exe)"/g)].map((match) => match[1]);
  if (!names.length) throw new Error(`no qemu-w64-setup-*.exe link found at ${WEILNETZ_INDEX}`);
  names.sort();
  return new URL(names[names.length - 1], WEILNETZ_INDEX).toString();
}

function jobView() {
  if (!job) return null;
  return {
    state: job.state,
    step: job.step,
    log: job.log.slice(-25),
    error: job.error,
    startedAt: job.startedAt,
    finishedAt: job.finishedAt || null,
  };
}

/** Download the pinned installer (verified), falling back to the index only if it 404s. */
async function fetchInstaller(userDataPath, log) {
  const [primary, ...mirrors] = PINNED_QEMU.urls;
  log(`downloading QEMU ${PINNED_QEMU.version} (${Math.round(PINNED_QEMU.size / (1024 * 1024))} MB, verified)`);
  try {
    const pulled = await images.pull(userDataPath, {
      url: primary,
      mirrors,
      file: PINNED_QEMU.file,
      sha512: PINNED_QEMU.sha512,
      size: PINNED_QEMU.size,
      wait: true,
    });
    log(pulled.alreadyPresent ? "installer already downloaded and verified" : "installer downloaded and sha512-verified");
    return pulled.path;
  } catch (err) {
    log(`pinned build unavailable (${err.message}); falling back to the newest build on the index`);
    const url = await latestWindowsInstallerUrl();
    const pulled = await images.pull(userDataPath, { url, wait: true });
    return pulled.path;
  }
}

async function installWindows(userDataPath, log) {
  const targetDir = ensureDir(layout.qemu(userDataPath));
  const installer = await fetchInstaller(userDataPath, log);
  log(`installer: ${installer}`);

  const zip = sevenZip();
  if (zip) {
    log(`extracting with 7-Zip (${zip}) — no administrator rights needed`);
    const result = await runStep(zip, ["x", "-y", `-o${targetDir}`, installer]);
    log(result.ok ? "extraction finished" : `extraction failed (code ${result.code})`);
    if (fs.existsSync(path.join(targetDir, "qemu-system-x86_64.exe"))) return { method: "7zip-extract", dir: targetDir };
  }

  log("running the installer silently into the managed folder");
  // NSIS: /S must come first and /D last, unquoted, or it is ignored.
  const silent = await runStep(installer, ["/S", `/D=${targetDir}`], { timeoutMs: 15 * 60_000 });
  log(`installer exit code ${silent.code}`);
  if (fs.existsSync(path.join(targetDir, "qemu-system-x86_64.exe"))) return { method: "silent-installer", dir: targetDir };

  if (which("winget")) {
    log("trying winget");
    const winget = await runStep("winget", [
      "install",
      "-e",
      "--id",
      "SoftwareFreedomConservancy.QEMU",
      "--accept-source-agreements",
      "--accept-package-agreements",
      "--silent",
    ]);
    log(`winget exit code ${winget.code}`);
  }
  if (which("choco")) {
    log("trying chocolatey");
    const choco = await runStep("choco", ["install", "qemu", "-y", "--no-progress"]);
    log(`choco exit code ${choco.code}`);
  }
  return { method: "package-manager", dir: null, installerPath: installer };
}

async function installPosix(userDataPath, log) {
  const managers = [
    { bin: "brew", args: ["install", "qemu"] },
    { bin: "apt-get", args: ["install", "-y", "qemu-system-x86", "qemu-utils"], sudo: true },
    { bin: "dnf", args: ["install", "-y", "qemu-system-x86", "qemu-img"], sudo: true },
    { bin: "pacman", args: ["-S", "--noconfirm", "qemu-full"], sudo: true },
    { bin: "zypper", args: ["install", "-y", "qemu", "qemu-tools"], sudo: true },
  ];
  for (const manager of managers) {
    if (!which(manager.bin)) continue;
    log(`installing with ${manager.bin}`);
    const result = manager.sudo
      ? await runStep("sudo", ["-n", manager.bin, ...manager.args])
      : await runStep(manager.bin, manager.args);
    log(`${manager.bin} exit code ${result.code}`);
    if (result.ok) return { method: manager.bin, dir: null };
    if (manager.sudo) {
      log(`sudo was refused — run manually: sudo ${manager.bin} ${manager.args.join(" ")}`);
    }
  }
  return { method: "none", dir: null };
}

/**
 * Install QEMU on this host. Long-running: returns a job unless wait=true.
 * Never requires the caller to be elevated; if elevation is unavoidable the
 * exact manual command is reported back instead of failing silently.
 */
function install(userDataPath, { wait = false } = {}) {
  const already = detect(userDataPath, { force: true });
  if (already.installed) {
    return Promise.resolve({ installed: true, alreadyPresent: true, qemu: already.qemu });
  }
  if (job && job.state === "running") {
    return wait ? job.promise.then(() => ({ installed: detect(userDataPath, { force: true }).installed, job: jobView() })) : Promise.resolve({ running: true, job: jobView() });
  }
  job = { state: "running", step: "start", log: [], error: null, startedAt: Date.now(), finishedAt: null };
  const log = (line) => {
    job.step = line;
    job.log.push(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
  };
  job.promise = (async () => {
    const outcome = process.platform === "win32" ? await installWindows(userDataPath, log) : await installPosix(userDataPath, log);
    const found = detect(userDataPath, { force: true });
    if (found.installed) {
      if (outcome.dir && found.qemu?.dir === outcome.dir) writeConfig(userDataPath, { qemuDir: outcome.dir });
      const version = found.qemu.version || "?";
      if (version !== PINNED_QEMU.version) {
        log(`note: installed QEMU ${version}, expected ${PINNED_QEMU.version} (found on PATH). It should still work.`);
      }
      log(`QEMU ${version} ready at ${found.qemu.dir}`);
      job.state = "done";
    } else {
      job.state = "error";
      job.error =
        process.platform === "win32"
          ? `Automatic install did not complete. Run the downloaded installer manually (${outcome.installerPath || "qemu.weilnetz.de/w64"}), then call action=host_config qemu_dir=<install folder>.`
          : "Automatic install did not complete — install QEMU with your package manager, then call action=host_config qemu_dir=<folder>.";
      log(job.error);
    }
    job.finishedAt = Date.now();
    return found;
  })().catch((err) => {
    job.state = "error";
    job.error = err instanceof Error ? err.message : String(err);
    job.finishedAt = Date.now();
    log(`failed: ${job.error}`);
    return detect(userDataPath, { force: true });
  });

  if (!wait) return Promise.resolve({ running: true, job: jobView(), note: "Installing in the background — poll with action=host_status." });
  return job.promise.then((found) => ({ installed: found.installed, qemu: found.qemu, job: jobView() }));
}

module.exports = { install, jobView, which, sevenZip, PINNED_QEMU };
