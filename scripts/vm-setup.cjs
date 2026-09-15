#!/usr/bin/env node
/**
 * One-shot VM setup: install the pinned QEMU 11.1.0 (verified) and, by default, the
 * Debian 12 base image — with live progress so the console never looks frozen, and a
 * hard overall timeout so a dead mirror can never hang the run forever.
 *
 *   node scripts/vm-setup.cjs                 install QEMU + debian-12 base image
 *   node scripts/vm-setup.cjs --no-image      QEMU only
 *   node scripts/vm-setup.cjs --image=ubuntu-24.04
 *   node scripts/vm-setup.cjs --timeout=45    overall budget in minutes (default 40)
 */
const engine = require("../electron/vm/engine.cjs");
const installer = require("../electron/vm/install.cjs");
const images = require("../electron/vm/images.cjs");
const { resolveUserData } = require("../electron/vm/paths.cjs");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function parseArgs(argv) {
  const opts = { image: "debian-12", timeoutMin: 40, pullImage: true };
  for (const token of argv) {
    if (token === "--no-image") opts.pullImage = false;
    else if (token.startsWith("--image=")) opts.image = token.slice(8);
    else if (token.startsWith("--timeout=")) opts.timeoutMin = Math.max(5, Number(token.slice(10)) || 40);
  }
  return opts;
}

function bar(percent) {
  const width = 28;
  const filled = percent == null ? 0 : Math.round((percent / 100) * width);
  return `[${"#".repeat(filled)}${"-".repeat(width - filled)}]`;
}

function line(text) {
  process.stdout.write(`\r${text.padEnd(78).slice(0, 78)}`);
}

function done(text) {
  process.stdout.write(`\r${text.padEnd(78)}\n`);
}

/** Poll the shared image-download jobs and render the active one as a moving bar. */
async function trackDownload(userDataPath, file, label, deadline) {
  let lastStall = 0;
  for (;;) {
    const job = images.listImages(userDataPath).downloads.find((d) => d.file === file);
    if (job) {
      if (job.state === "done") return { ok: true };
      if (job.state === "error") return { ok: false, error: job.error };
      const pct = job.percent == null ? null : job.percent;
      const retry = job.attempt > 1 ? ` retry#${job.attempt}` : "";
      line(`${label} ${bar(pct)} ${pct == null ? "?" : pct}%  ${job.downloadedMb}/${job.totalMb ?? "?"}MB ${job.mbPerSec}MB/s${retry}`);
      lastStall = 0;
    } else if (++lastStall > 6) {
      // No visible job yet — still print a heartbeat so the window shows life.
      line(`${label} preparing…`);
    }
    if (Date.now() > deadline) return { ok: false, error: "overall timeout reached" };
    await sleep(1000);
  }
}

async function ensureQemu(userDataPath, deadline) {
  const status = engine.hostStatus(userDataPath);
  const want = installer.PINNED_QEMU.version;
  if (status.qemuInstalled) {
    const v = status.qemu.version;
    done(`[1/2] QEMU already installed: ${v} at ${status.qemu.dir}  (accel ${status.qemu.preferredAccel})`);
    if (v !== want) console.log(`      note: found ${v}, ComposeVC targets ${want} — usually fine.`);
    return true;
  }

  console.log(`[1/2] Installing QEMU ${want} (pinned, sha512-verified)…`);
  const kickoff = await engine.hostInstall(userDataPath, { wait: false });
  if (kickoff.installed) {
    done(`[1/2] QEMU ready: ${kickoff.qemu?.version} at ${kickoff.qemu?.dir}`);
    return true;
  }

  let lastStep = "";
  const file = installer.PINNED_QEMU.file;
  for (;;) {
    const view = installer.jobView();
    const dl = images.listImages(userDataPath).downloads.find((d) => d.file === file);
    if (dl && dl.state === "running") {
      const retry = dl.attempt > 1 ? ` retry#${dl.attempt}` : "";
      line(`      download ${bar(dl.percent)} ${dl.percent ?? "?"}%  ${dl.downloadedMb}/${dl.totalMb ?? "?"}MB ${dl.mbPerSec}MB/s${retry}`);
    } else if (view && view.step && view.step !== lastStep) {
      lastStep = view.step;
      done(`      ${view.step}`);
    }
    if (view && (view.state === "done" || view.state === "error")) {
      const found = engine.hostStatus(userDataPath);
      if (found.qemuInstalled) {
        done(`[1/2] QEMU ready: ${found.qemu.version} at ${found.qemu.dir}  (accel ${found.qemu.preferredAccel})`);
        return true;
      }
      done(`[1/2] QEMU install FAILED`);
      console.error(`      ${view.error || "unknown error"}`);
      if (view.log) console.error(view.log.slice(-8).map((l) => `      ${l}`).join("\n"));
      return false;
    }
    if (Date.now() > deadline) {
      done(`[1/2] QEMU install TIMED OUT`);
      return false;
    }
    await sleep(1000);
  }
}

async function ensureImage(userDataPath, image, deadline) {
  const catalog = images.listImages(userDataPath).catalog.find((c) => c.id === image);
  if (catalog && catalog.downloaded) {
    done(`[2/2] Base image already present: ${image} (${catalog.sizeMb}MB)`);
    return true;
  }
  console.log(`[2/2] Downloading base image ${image} (resumable, verified size)…`);
  const started = images.pull(userDataPath, { image, wait: false }).catch((err) => ({ error: err.message }));
  const kickoff = await started;
  if (kickoff && kickoff.error) {
    done(`[2/2] Image download could not start`);
    console.error(`      ${kickoff.error}`);
    return false;
  }
  if (kickoff && kickoff.alreadyPresent) {
    done(`[2/2] Base image already present: ${kickoff.path}`);
    return true;
  }
  const fileName = images.CATALOG.find((c) => c.id === image)?.file;
  const result = await trackDownload(userDataPath, fileName, `      ${image}`, deadline);
  if (result.ok) {
    const sizeMb = images.listImages(userDataPath).catalog.find((c) => c.id === image)?.sizeMb;
    done(`[2/2] Base image ready: ${image} (${sizeMb}MB)`);
    return true;
  }
  done(`[2/2] Base image download FAILED`);
  console.error(`      ${result.error || "unknown error"}`);
  return false;
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  const userDataPath = resolveUserData(process.env.COMPOSEVC_USER_DATA || null);
  const deadline = Date.now() + opts.timeoutMin * 60_000;

  console.log("============================================================");
  console.log("  ComposeVC — VM engine setup");
  console.log(`  data dir : ${userDataPath}`);
  console.log(`  target   : QEMU ${installer.PINNED_QEMU.version}${opts.pullImage ? ` + ${opts.image}` : " (no base image)"}`);
  console.log(`  budget   : ${opts.timeoutMin} min`);
  console.log("============================================================");

  const qemuOk = await ensureQemu(userDataPath, deadline);
  if (!qemuOk) {
    console.error("\nSetup incomplete: QEMU is not installed. The IDE runs, but VMs are disabled.");
    process.exit(1);
  }

  let imageOk = true;
  if (opts.pullImage) imageOk = await ensureImage(userDataPath, opts.image, deadline);

  const status = engine.hostStatus(userDataPath);
  console.log("------------------------------------------------------------");
  console.log(`  QEMU     : ${status.qemu.version}  (accel ${status.qemu.preferredAccel}${status.qemu.hardwareAccel ? ", hardware" : ", software"})`);
  console.log(`  disk free: ${status.diskFreeGb}GB   used by VMs: ${status.storageUsedGb}GB`);
  console.log(`  machines : ${status.machinesRunning}/${status.machines} running`);
  console.log("------------------------------------------------------------");

  if (qemuOk && imageOk) {
    console.log("Setup OK. The vm tool is ready — create a machine with:");
    console.log(`  node scripts/vm-cli.cjs create name=dev image=${opts.image}`);
    process.exit(0);
  }
  console.log("Setup finished with warnings — QEMU works, base image did not download.");
  console.log("Retry later with:  node scripts/vm-setup.cjs");
  process.exit(imageOk ? 0 : 2);
})().catch((err) => {
  console.error("\nSetup crashed:", err instanceof Error ? err.stack : String(err));
  process.exit(1);
});
