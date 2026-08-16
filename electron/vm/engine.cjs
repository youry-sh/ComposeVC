const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn, execFile } = require("child_process");
const { layout, ensureLayout, ensureDir, readConfig, writeConfig, diskFree, dirSize } = require("./paths.cjs");
const store = require("./store.cjs");
const detectHost = require("./detect.cjs");
const images = require("./images.cjs");
const installer = require("./install.cjs");
const cloudinit = require("./cloudinit.cjs");
const { withQmp, probeStatus } = require("./qmp.cjs");
const { QgaClient, probeAgent } = require("./qga.cjs");

const IS_WIN = process.platform === "win32";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_TEXT = 60_000;

function clip(text, max = MAX_TEXT) {
  const value = String(text ?? "");
  return value.length <= max ? value : `${value.slice(0, max)}\n… (truncated, ${value.length} chars total)`;
}

/** QEMU option values are comma-separated; a literal comma is escaped by doubling it. */
function qopt(value) {
  return String(value).replace(/,/g, ",,");
}

function isPortFree(port, host = "127.0.0.1") {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen(port, host, () => server.close(() => resolve(true)));
  });
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function allocatePorts(count) {
  const held = [];
  const ports = [];
  for (let i = 0; i < count; i += 1) {
    const server = net.createServer();
    // eslint-disable-next-line no-await-in-loop
    const port = await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve(server.address().port));
    });
    held.push(server);
    ports.push(port);
  }
  await Promise.all(held.map((server) => new Promise((resolve) => server.close(resolve))));
  return ports;
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM";
  }
}

function killPid(pid, { force = true } = {}) {
  if (!pidAlive(pid)) return false;
  try {
    if (IS_WIN) {
      require("child_process").spawnSync("taskkill", ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], {
        windowsHide: true,
        stdio: "ignore",
      });
    } else {
      process.kill(pid, force ? "SIGKILL" : "SIGTERM");
    }
  } catch {
    return false;
  }
  return true;
}

function runQemuImg(imgBin, args, timeout = 20 * 60_000) {
  return new Promise((resolve, reject) => {
    execFile(imgBin, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`qemu-img ${args[0]} failed: ${String(stderr || error.message).trim()}`));
        return;
      }
      resolve(String(stdout || ""));
    });
  });
}

function machinePaths(userDataPath, id) {
  const dir = layout.machine(userDataPath, id);
  return {
    dir,
    disk: path.join(dir, "disk.qcow2"),
    seed: path.join(dir, "seed.iso"),
    serial: path.join(dir, "serial.log"),
    qemuLog: path.join(dir, "qemu.log"),
    pidFile: path.join(dir, "qemu.pid"),
  };
}

function firmwareFiles(qemuDir) {
  const roots = [path.join(qemuDir, "share"), qemuDir, "/usr/share/qemu", "/usr/share/OVMF", "/usr/share/edk2/ovmf", "/opt/homebrew/share/qemu"];
  const codeNames = ["edk2-x86_64-code.fd", "OVMF_CODE.fd", "OVMF_CODE_4M.fd", "edk2-x86_64-secure-code.fd"];
  const varNames = ["edk2-i386-vars.fd", "OVMF_VARS.fd", "OVMF_VARS_4M.fd"];
  const find = (names) => {
    for (const root of roots) {
      for (const name of names) {
        const file = path.join(root, name);
        if (fs.existsSync(file)) return file;
      }
    }
    return null;
  };
  return { code: find(codeNames), vars: find(varNames) };
}

/* ------------------------------------------------------------------ host */

function hostStatus(userDataPath) {
  ensureLayout(userDataPath);
  const info = detectHost.detect(userDataPath, { force: true });
  const config = readConfig(userDataPath);
  const machines = store.readAll(userDataPath);
  const running = machines.filter((vm) => pidAlive(vm.pid)).length;
  const free = diskFree(layout.base(userDataPath));
  return {
    ok: info.installed,
    qemuInstalled: info.installed,
    qemu: info.qemu,
    reason: info.reason || null,
    platform: info.platform,
    hostCpus: info.hostCpus,
    hostMemoryMb: info.hostMemoryMb,
    baseDir: layout.base(userDataPath),
    diskFreeGb: free.freeBytes == null ? null : Math.round((free.freeBytes / 1024 ** 3) * 10) / 10,
    storageUsedGb: Math.round((dirSize(layout.base(userDataPath)) / 1024 ** 3) * 10) / 10,
    machines: machines.length,
    machinesRunning: running,
    defaults: {
      cpus: config.defaultCpus,
      memoryMb: config.defaultMemoryMb,
      diskGb: config.defaultDiskGb,
      user: config.defaultUser,
      accel: config.accel,
    },
    install: installer.jobView(),
  };
}

function hostConfig(userDataPath, patch) {
  const next = writeConfig(userDataPath, patch);
  const info = detectHost.detect(userDataPath, { force: true });
  return { ok: true, config: next, qemu: info.qemu, qemuInstalled: info.installed };
}

/* ---------------------------------------------------------------- create */

async function createVm(userDataPath, input = {}, context = {}) {
  ensureLayout(userDataPath);
  const config = readConfig(userDataPath);
  const qemu = detectHost.requireQemu(userDataPath);
  if (!qemu.img) throw new Error(`qemu-img was not found next to ${qemu.system} — reinstall QEMU or set qemu_dir`);

  const osType = String(input.os || (input.iso ? "windows" : "linux")).toLowerCase() === "windows" ? "windows" : "linux";
  const name = store.validateName(input.name || `${osType}-${Date.now().toString(36).slice(-4)}`, userDataPath);
  const id = store.newId();
  const paths = machinePaths(userDataPath, id);
  ensureDir(paths.dir);

  const cpus = Math.max(1, Math.min(64, Number(input.cpus) || config.defaultCpus));
  const memoryMb = Math.max(256, Math.min(1024 * 512, Number(input.memory_mb || input.memoryMb) || config.defaultMemoryMb));
  const diskGb = Math.max(2, Math.min(4096, Number(input.disk_gb || input.diskGb) || config.defaultDiskGb));
  const user = String(input.user || config.defaultUser).trim();
  const password = String(input.password || config.defaultPassword);

  const record = {
    id,
    name,
    os: osType,
    dir: paths.dir,
    diskPath: paths.disk,
    serialLog: paths.serial,
    cpus,
    memoryMb,
    diskGb,
    user,
    password,
    firmware: String(input.firmware || "bios").toLowerCase() === "uefi" ? "uefi" : "bios",
    display: ["none", "window", "vnc"].includes(String(input.display || "none")) ? String(input.display || "none") : "none",
    cpuModel: input.cpu_model || null,
    accel: input.accel || config.accel || "auto",
    state: "created",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    notes: input.notes || null,
  };

  try {
    if (osType === "linux") {
      const baseImage = await images.resolveBaseImage(userDataPath, input.image || "debian-12", {
        wait: input.wait_download !== false,
        signal: context.signal,
      });
      record.baseImage = baseImage;
      record.image = String(input.image || "debian-12");
      if (input.copy_image) {
        await runQemuImg(qemu.img, ["convert", "-O", "qcow2", baseImage, paths.disk]);
        await runQemuImg(qemu.img, ["resize", paths.disk, `${diskGb}G`]);
        record.backing = null;
      } else {
        await runQemuImg(qemu.img, ["create", "-f", "qcow2", "-b", baseImage, "-F", "qcow2", paths.disk, `${diskGb}G`]);
        record.backing = baseImage;
      }
      const seed = cloudinit.writeSeedIso(paths.dir, {
        hostname: name.replace(/[^a-zA-Z0-9-]/g, "-").toLowerCase(),
        user,
        password,
        sshKeys: [].concat(input.ssh_key || input.ssh_keys || []).filter(Boolean),
        packages: [].concat(input.packages || []).filter(Boolean),
        runcmd: [].concat(input.runcmd || []).filter(Boolean),
        extraUserData: input.cloud_init || "",
        instanceId: id,
      });
      record.seedIso = seed.path;
      record.cdroms = [];
    } else {
      const iso = input.iso || input.image;
      if (!iso) {
        throw new Error(
          "A Windows VM needs an installation ISO: pass iso=<absolute path> or iso=<https url>. " +
            "Microsoft evaluation ISOs work; nothing is bundled."
        );
      }
      const isoPath = /^https?:\/\//i.test(String(iso))
        ? (await images.pull(userDataPath, { url: String(iso), wait: true, signal: context.signal })).path
        : path.resolve(String(iso));
      if (!fs.existsSync(isoPath)) throw new Error(`ISO not found: ${isoPath}`);
      record.iso = isoPath;
      record.image = path.basename(isoPath);
      await runQemuImg(qemu.img, ["create", "-f", "qcow2", paths.disk, `${diskGb}G`]);
      const cdroms = [isoPath];
      if (input.virtio !== false) {
        const virtio = images.localPath(userDataPath, "virtio-win.iso");
        if (fs.existsSync(virtio)) cdroms.push(virtio);
        else record.virtioHint = "Run action=image_pull image=virtio-win to get drivers + qemu-guest-agent for Windows guests.";
      }
      record.cdroms = cdroms;
      record.boot = "dc";
      record.display = record.display === "none" && input.display == null ? "vnc" : record.display;
    }

    const [qmpPort, qgaPort, consolePort, sshPort] = await allocatePorts(4);
    record.ports = { qmp: qmpPort, qga: qgaPort, console: consolePort, ssh: sshPort, vnc: null };
    record.forwards = normalizeForwards(input.ports || input.forwards, osType, sshPort);
    store.insert(userDataPath, record);
  } catch (err) {
    store.destroyDir(userDataPath, id);
    throw err;
  }

  if (input.start === false) {
    return { ok: true, created: true, started: false, vm: view(record) };
  }
  const started = await startVm(userDataPath, id, { display: record.display }, context);
  return { ok: true, created: true, started: started.ok, vm: started.vm, start: started };
}

function normalizeForwards(spec, osType, sshPort) {
  const forwards = [];
  const push = (hostPort, guestPort, proto = "tcp") => {
    if (!hostPort || !guestPort) return;
    forwards.push({ host: Number(hostPort), guest: Number(guestPort), proto });
  };
  push(sshPort, osType === "windows" ? 3389 : 22);
  const list = Array.isArray(spec) ? spec : spec ? [spec] : [];
  for (const item of list) {
    if (typeof item === "string") {
      const match = item.match(/^(?:(tcp|udp):)?(\d+)[:\-](\d+)$/i);
      if (match) push(match[2], match[3], (match[1] || "tcp").toLowerCase());
    } else if (item && typeof item === "object") {
      push(item.host || item.hostPort, item.guest || item.guestPort, (item.proto || "tcp").toLowerCase());
    }
  }
  return forwards;
}

/* ----------------------------------------------------------------- start */

function buildArgs(vm, qemu, { accel, cpuModel }) {
  const paths = { serial: vm.serialLog, pidFile: path.join(vm.dir, "qemu.pid") };
  const args = [
    "-name",
    // process= renames the host process, which only QEMU's POSIX backend implements.
    IS_WIN ? qopt(vm.name) : `${qopt(vm.name)},process=cvc-${vm.id}`,
    "-machine",
    "q35",
    "-accel",
    accel === "whpx" ? "whpx,kernel-irqchip=off" : accel === "tcg" ? "tcg,thread=multi" : accel,
    "-cpu",
    cpuModel,
    "-smp",
    String(vm.cpus),
    "-m",
    String(vm.memoryMb),
    "-rtc",
    vm.os === "windows" ? "base=localtime" : "base=utc",
    "-pidfile",
    qopt(paths.pidFile),
  ];

  if (vm.firmware === "uefi") {
    const fw = firmwareFiles(qemu.dir);
    if (!fw.code) throw new Error("UEFI firmware (edk2/OVMF) was not found next to QEMU — use firmware=bios");
    const varsCopy = path.join(vm.dir, "efivars.fd");
    if (!fs.existsSync(varsCopy) && fw.vars) fs.copyFileSync(fw.vars, varsCopy);
    args.push("-drive", `if=pflash,format=raw,unit=0,readonly=on,file=${qopt(fw.code)}`);
    if (fs.existsSync(varsCopy)) args.push("-drive", `if=pflash,format=raw,unit=1,file=${qopt(varsCopy)}`);
  }

  args.push("-device", "ahci,id=ahci0");
  if (vm.os === "windows") {
    args.push("-drive", `file=${qopt(vm.diskPath)},if=none,id=hd0,format=qcow2,cache=writeback`);
    args.push("-device", "ide-hd,drive=hd0,bus=ahci0.0");
  } else {
    args.push("-drive", `file=${qopt(vm.diskPath)},if=virtio,format=qcow2,cache=writeback,discard=unmap`);
  }
  // Cloud kernels (debian-*-genericcloud, ubuntu-cloudimg) ship virtio drivers only —
  // an ATAPI CD-ROM is invisible to them, so the cloud-init seed rides on virtio-blk.
  if (vm.seedIso && fs.existsSync(vm.seedIso)) {
    args.push("-drive", `file=${qopt(vm.seedIso)},if=virtio,format=raw,readonly=on`);
  }
  (vm.cdroms || []).forEach((iso, index) => {
    if (!iso || !fs.existsSync(iso)) return;
    args.push("-drive", `file=${qopt(iso)},if=none,id=cd${index},format=raw,media=cdrom,readonly=on`);
    args.push("-device", `ide-cd,drive=cd${index},bus=ahci0.${index + 1}`);
  });

  const hostfwd = (vm.forwards || [])
    .map((rule) => `,hostfwd=${rule.proto}:127.0.0.1:${rule.host}-:${rule.guest}`)
    .join("");
  args.push("-netdev", `user,id=net0${hostfwd}`);
  args.push("-device", `${vm.os === "windows" ? "e1000e" : "virtio-net-pci"},netdev=net0`);

  args.push("-device", "virtio-serial-pci,id=vserial0");
  args.push("-chardev", `socket,id=qga0,host=127.0.0.1,port=${vm.ports.qga},server=on,wait=off`);
  args.push("-device", "virtserialport,chardev=qga0,name=org.qemu.guest_agent.0");
  args.push(
    "-chardev",
    `socket,id=cons0,host=127.0.0.1,port=${vm.ports.console},server=on,wait=off,logfile=${qopt(paths.serial)},logappend=on`
  );
  args.push("-serial", "chardev:cons0");
  args.push("-qmp", `tcp:127.0.0.1:${vm.ports.qmp},server=on,wait=off`);
  args.push("-boot", `order=${vm.boot || (vm.os === "windows" ? "dc" : "c")},menu=off`);

  if (vm.display === "vnc") {
    args.push("-display", "none");
    args.push("-vnc", `127.0.0.1:${vm.ports.vncDisplay ?? 0},to=99`);
  } else if (vm.display === "window") {
    args.push("-device", "usb-ehci,id=usb0", "-device", "usb-tablet,bus=usb0.0");
  } else {
    args.push("-display", "none");
  }
  if (vm.extraArgs && Array.isArray(vm.extraArgs)) args.push(...vm.extraArgs);
  return args;
}

async function waitForMonitor(port, timeoutMs, isDead) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await probeStatus(port, { timeoutMs: 1200 });
    if (status) return status;
    if (isDead && isDead()) return null;
    await sleep(300);
  }
  return null;
}

function tail(file, chars = 4000) {
  try {
    const size = fs.statSync(file).size;
    const start = Math.max(0, size - chars);
    const fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    return buffer.toString("utf8");
  } catch {
    return "";
  }
}

async function spawnQemu(userDataPath, vm, { accel, cpuModel }) {
  const qemu = detectHost.requireQemu(userDataPath);
  const args = buildArgs(vm, qemu, { accel, cpuModel });
  const logFd = fs.openSync(path.join(vm.dir, "qemu.log"), "a");
  fs.writeSync(logFd, `\n=== ${new Date().toISOString()} ${qemu.system} ${args.join(" ")}\n`);
  const child = spawn(qemu.system, args, {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
    cwd: vm.dir,
  });
  let exited = false;
  let exitCode = null;
  child.on("exit", (code) => {
    exited = true;
    exitCode = code;
  });
  child.unref();
  const status = await waitForMonitor(vm.ports.qmp, 30_000, () => exited);
  try {
    fs.closeSync(logFd);
  } catch {
    /* already closed */
  }
  if (!status) {
    killPid(child.pid);
    return { ok: false, pid: child.pid, exitCode, log: tail(path.join(vm.dir, "qemu.log"), 3000), args };
  }
  return { ok: true, pid: child.pid, status, args };
}

async function startVm(userDataPath, key, options = {}, context = {}) {
  const vm = store.requireVm(userDataPath, key);
  const live = await liveState(vm);
  if (live.running) return { ok: true, alreadyRunning: true, vm: view({ ...vm, ...live.patch }) };

  // Ports may have been taken by something else while the VM was stopped.
  const ports = { ...vm.ports };
  for (const key2 of ["qmp", "qga", "console"]) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await isPortFree(ports[key2]))) ports[key2] = await pickFreePort();
  }
  const forwards = [...(vm.forwards || [])];
  for (let i = 0; i < forwards.length; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (!(await isPortFree(forwards[i].host))) forwards[i] = { ...forwards[i], host: await pickFreePort() };
  }
  if (options.display) vm.display = options.display;
  if (vm.display === "vnc") ports.vncDisplay = await pickVncDisplay();
  const patched = { ...vm, ports, forwards };

  const qemu = detectHost.requireQemu(userDataPath);
  const requested = String(options.accel || vm.accel || "auto").toLowerCase();
  const preferred = requested === "auto" ? qemu.preferredAccel : requested;
  // Hardware accelerators are picky about CPU models, so fall back model-first, then to TCG.
  const attempts = [{ accel: preferred, cpuModel: vm.cpuModel || "max" }];
  if (preferred !== "tcg") {
    attempts.push({ accel: preferred, cpuModel: "qemu64" });
    attempts.push({ accel: "tcg", cpuModel: "max" });
  }

  let last = null;
  for (const attempt of attempts) {
    // eslint-disable-next-line no-await-in-loop
    last = await spawnQemu(userDataPath, patched, attempt);
    if (last.ok) {
      const updated = store.update(userDataPath, vm.id, {
        ports,
        forwards,
        display: vm.display,
        pid: last.pid,
        state: "running",
        accelUsed: attempt.accel,
        cpuModelUsed: attempt.cpuModel,
        startedAt: Date.now(),
        lastError: null,
        lastArgs: last.args,
      });
      return {
        ok: true,
        started: true,
        accel: attempt.accel,
        hardwareAccel: attempt.accel !== "tcg",
        vm: view(updated),
        hint:
          patched.os === "linux"
            ? "First boot runs cloud-init (installs qemu-guest-agent). Use action=wait_ready before action=exec."
            : "Windows needs interactive setup: action=info shows the VNC address; install virtio-win guest tools for action=exec.",
      };
    }
  }
  const failure = last || { log: "" };
  store.update(userDataPath, vm.id, { state: "error", lastError: clip(failure.log, 2000), pid: null });
  throw new Error(
    `QEMU did not start (exit code ${failure.exitCode ?? "n/a"}). Last output:\n${clip(failure.log, 2000) || "(empty)"}`
  );
}

async function pickVncDisplay() {
  for (let display = 0; display < 64; display += 1) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(5900 + display)) return display;
  }
  return 0;
}

/* ------------------------------------------------------------------ state */

async function liveState(vm) {
  const alive = pidAlive(vm.pid);
  if (!alive) return { running: false, patch: { state: vm.state === "error" ? "error" : "stopped", pid: null } };
  const status = await probeStatus(vm.ports?.qmp, { timeoutMs: 1500 });
  if (!status) return { running: false, patch: { state: "stopped", pid: null }, staleProcess: true };
  return {
    running: true,
    status: status.status,
    patch: { state: status.status === "paused" ? "paused" : "running" },
  };
}

function view(vm) {
  if (!vm) return null;
  return {
    id: vm.id,
    name: vm.name,
    os: vm.os,
    state: vm.state,
    running: vm.state === "running" || vm.state === "paused",
    image: vm.image || null,
    cpus: vm.cpus,
    memoryMb: vm.memoryMb,
    diskGb: vm.diskGb,
    user: vm.user,
    password: vm.password,
    display: vm.display,
    accel: vm.accelUsed || vm.accel,
    pid: vm.pid || null,
    ports: vm.ports || null,
    forwards: vm.forwards || [],
    ssh:
      vm.os === "linux" && vm.forwards?.length
        ? `ssh -p ${vm.forwards[0].host} ${vm.user}@127.0.0.1`
        : null,
    rdp: vm.os === "windows" && vm.forwards?.length ? `127.0.0.1:${vm.forwards[0].host}` : null,
    vnc: vm.display === "vnc" && vm.ports?.vncDisplay != null ? `127.0.0.1:${5900 + vm.ports.vncDisplay}` : null,
    dir: vm.dir,
    serialLog: vm.serialLog,
    createdAt: vm.createdAt,
    startedAt: vm.startedAt || null,
    lastError: vm.lastError || null,
    notes: vm.notes || null,
  };
}

async function listVms(userDataPath, { probe = true } = {}) {
  ensureLayout(userDataPath);
  const machines = store.readAll(userDataPath);
  const rows = await Promise.all(
    machines.map(async (vm) => {
      if (!probe) return view(vm);
      const live = await liveState(vm);
      const next = { ...vm, ...live.patch };
      if (next.state !== vm.state || next.pid !== vm.pid) store.update(userDataPath, vm.id, live.patch);
      return { ...view(next), agentPortOpen: undefined };
    })
  );
  return {
    ok: true,
    count: rows.length,
    running: rows.filter((row) => row.running).length,
    machines: rows,
    baseDir: layout.base(userDataPath),
  };
}

async function infoVm(userDataPath, key) {
  const vm = store.requireVm(userDataPath, key);
  const live = await liveState(vm);
  const merged = { ...vm, ...live.patch };
  store.update(userDataPath, vm.id, live.patch);
  const result = { ok: true, vm: view(merged), qmpStatus: live.status || null, agent: false };
  if (live.running) {
    result.agent = await probeAgent(vm.ports.qga, { timeoutMs: 2500, os: vm.os });
    result.consoleTail = clip(tail(vm.serialLog, 1500), 1500);
    result.readySignal = fs.existsSync(vm.serialLog) && tail(vm.serialLog, 200_000).includes(cloudinit.READY_TOKEN);
  }
  result.diskUsedMb = Math.round(dirSize(vm.dir) / (1024 * 1024));
  return result;
}

/* ------------------------------------------------------------- stop/delete */

async function waitForStop(vm, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!pidAlive(vm.pid)) return true;
    await sleep(400);
  }
  return !pidAlive(vm.pid);
}

async function stopVm(userDataPath, key, { timeoutMs = 90_000, force = false } = {}) {
  const vm = store.requireVm(userDataPath, key);
  const live = await liveState(vm);
  if (!live.running) {
    store.update(userDataPath, vm.id, live.patch);
    return { ok: true, alreadyStopped: true, vm: view({ ...vm, ...live.patch }) };
  }
  const steps = [];
  if (!force) {
    let agent = null;
    try {
      agent = await QgaClient.open(vm.ports.qga, { timeoutMs: 2500, syncTimeoutMs: 2500, os: vm.os });
      await agent.shutdown("powerdown");
      steps.push("guest-agent shutdown");
    } catch {
      steps.push("guest agent unavailable");
    } finally {
      agent?.close();
    }
    if (!steps.includes("guest-agent shutdown")) {
      try {
        await withQmp(vm.ports.qmp, (client) => client.command("system_powerdown", {}, 5000));
        steps.push("ACPI powerdown");
      } catch {
        steps.push("ACPI powerdown failed");
      }
    }
    if (await waitForStop(vm, timeoutMs)) {
      const updated = store.update(userDataPath, vm.id, { state: "stopped", pid: null, stoppedAt: Date.now() });
      return { ok: true, stopped: true, graceful: true, steps, vm: view(updated) };
    }
    steps.push(`still running after ${timeoutMs}ms`);
  }
  try {
    await withQmp(vm.ports.qmp, (client) => client.command("quit", {}, 3000));
    steps.push("QMP quit");
  } catch {
    steps.push("QMP quit failed");
  }
  await waitForStop(vm, 5000);
  if (pidAlive(vm.pid)) {
    killPid(vm.pid);
    steps.push("process killed");
    await waitForStop(vm, 5000);
  }
  const updated = store.update(userDataPath, vm.id, { state: "stopped", pid: null, stoppedAt: Date.now() });
  return { ok: !pidAlive(vm.pid), stopped: !pidAlive(vm.pid), graceful: false, steps, vm: view(updated) };
}

async function deleteVm(userDataPath, key, { keepFiles = false } = {}) {
  const vm = store.requireVm(userDataPath, key);
  const live = await liveState(vm);
  if (live.running) await stopVm(userDataPath, vm.id, { force: true, timeoutMs: 5000 });
  const filesRemoved = keepFiles ? false : store.destroyDir(userDataPath, vm.id);
  store.remove(userDataPath, vm.id);
  return { ok: true, deleted: true, id: vm.id, name: vm.name, filesRemoved, dir: vm.dir };
}

async function restartVm(userDataPath, key, options = {}, context = {}) {
  const vm = store.requireVm(userDataPath, key);
  const live = await liveState(vm);
  if (live.running) await stopVm(userDataPath, vm.id, { timeoutMs: options.timeoutMs || 60_000, force: options.force });
  return startVm(userDataPath, vm.id, options, context);
}

async function pauseVm(userDataPath, key, resume = false) {
  const vm = store.requireVm(userDataPath, key);
  await withQmp(vm.ports.qmp, (client) => client.command(resume ? "cont" : "stop", {}, 8000));
  const updated = store.update(userDataPath, vm.id, { state: resume ? "running" : "paused" });
  return { ok: true, paused: !resume, vm: view(updated) };
}

/* --------------------------------------------------------- serial console */

function serialSize(vm) {
  try {
    return fs.statSync(vm.serialLog).size;
  } catch {
    return 0;
  }
}

function readSerial(vm, { fromOffset = null, maxChars = 20_000 } = {}) {
  let size = 0;
  try {
    size = fs.statSync(vm.serialLog).size;
  } catch {
    return { text: "", offset: 0, size: 0 };
  }
  const start = fromOffset == null ? Math.max(0, size - maxChars) : Math.max(0, Math.min(fromOffset, size));
  const length = Math.min(size - start, maxChars);
  if (length <= 0) return { text: "", offset: size, size };
  const fd = fs.openSync(vm.serialLog, "r");
  const buffer = Buffer.alloc(length);
  fs.readSync(fd, buffer, 0, length, start);
  fs.closeSync(fd);
  return { text: buffer.toString("utf8"), offset: start + length, size };
}

/** Write raw bytes into the guest's serial line. */
function writeSerial(vm, text, { enter = true, delayMs = 120 } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ port: vm.ports.console, host: "127.0.0.1" });
    const fail = (err) => {
      socket.destroy();
      reject(new Error(`serial console is not reachable on 127.0.0.1:${vm.ports.console}: ${err.message}`));
    };
    socket.once("error", fail);
    socket.once("connect", () => {
      socket.write(`${text}${enter ? "\r" : ""}`, () => {
        setTimeout(() => {
          socket.end();
          resolve(true);
        }, delayMs);
      });
    });
  });
}

/** Poll the serial log until `pattern` shows up — the console equivalent of a yes/no answer. */
async function expectSerial(vm, pattern, { timeoutMs = 30_000, fromOffset = 0, pollMs = 200 } = {}) {
  const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern);
  const deadline = Date.now() + timeoutMs;
  let offset = fromOffset;
  let collected = "";
  for (;;) {
    const chunk = readSerial(vm, { fromOffset: offset, maxChars: 200_000 });
    if (chunk.text) {
      collected += chunk.text;
      offset = chunk.offset;
      const match = collected.match(regex);
      if (match) return { matched: true, match: match[0], groups: match.slice(1), text: collected, offset };
    }
    if (Date.now() >= deadline) return { matched: false, text: collected, offset, timedOut: true };
    await sleep(pollMs);
  }
}

/**
 * Is a shell sitting on the console? A shell echoes the typed line *and* its output,
 * so the tag shows up twice; a login prompt echoes it once. Two states, one bit.
 */
async function consolePing(vm, timeoutMs = 6000, attempts = 2) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const tag = `CVC${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
    const mark = serialSize(vm);
    // eslint-disable-next-line no-await-in-loop
    await writeSerial(vm, `echo ${tag}_OK`);
    // eslint-disable-next-line no-await-in-loop
    const seen = await expectSerial(vm, new RegExp(`${tag}_OK[\\s\\S]*${tag}_OK`), {
      timeoutMs: Math.max(1500, Math.round(timeoutMs / attempts)),
      fromOffset: mark,
    });
    if (seen.matched) return true;
  }
  return false;
}

/** Log in on the serial console if a login prompt is waiting. */
async function ensureConsoleLogin(vm, { timeoutMs = 60_000 } = {}) {
  if (await consolePing(vm, 6000)) return { loggedIn: true, already: true };

  let mark = serialSize(vm);
  await writeSerial(vm, "");
  const prompt = await expectSerial(vm, /(login:|Password:)\s*$/m, { timeoutMs: 12_000, fromOffset: mark });
  if (!prompt.matched) return { loggedIn: false, reason: "no login prompt on the serial console — the guest may still be booting" };

  if (/Password:/.test(prompt.match)) {
    // A half-finished login is waiting; clear it and let getty redraw the prompt.
    mark = serialSize(vm);
    await writeSerial(vm, "");
    const again = await expectSerial(vm, /login:\s*$/m, { timeoutMs: 70_000, fromOffset: mark });
    if (!again.matched) return { loggedIn: false, reason: "the console is stuck at a password prompt" };
  }

  mark = serialSize(vm);
  await writeSerial(vm, vm.user);
  const password = await expectSerial(vm, /Password:\s*$/m, { timeoutMs: 15_000, fromOffset: mark });
  if (!password.matched) return { loggedIn: false, reason: `the console never asked for a password after user "${vm.user}"` };
  await writeSerial(vm, vm.password);

  if (await consolePing(vm, Math.max(12_000, timeoutMs / 4), 3)) return { loggedIn: true };
  return { loggedIn: false, reason: `login as "${vm.user}" did not reach a shell — wrong password, or the user does not exist` };
}

/** Run a command through the serial console — works with no guest agent at all. */
async function consoleExec(vm, command, { timeoutMs = 120_000, login = true } = {}) {
  if (vm.os === "windows") throw new Error("console exec is Linux-only; Windows guests need qemu-guest-agent (virtio-win)");
  if (login) {
    const session = await ensureConsoleLogin(vm);
    if (!session.loggedIn) throw new Error(`serial console login failed: ${session.reason}`);
  }
  const tag = Math.random().toString(36).slice(2, 8).toUpperCase();
  const begin = `CVC${tag}BEGIN`;
  const end = `CVC${tag}END`;
  const offset = serialSize(vm);
  await writeSerial(vm, `echo ${begin}; { ${command} ; } 2>&1; echo ${end}$?`);
  const result = await expectSerial(vm, new RegExp(`${end}(\\d+)`), { timeoutMs, fromOffset: offset });
  if (!result.matched) {
    return { ok: false, timedOut: true, exitCode: null, stdout: clip(result.text), channel: "console" };
  }
  // The tty echoes the whole command line first, so both markers appear twice:
  // the real output sits between the LAST begin and the LAST end.
  const body = result.text;
  const endIndex = body.lastIndexOf(end);
  const startIndex = endIndex > 0 ? body.lastIndexOf(begin, endIndex) : body.indexOf(begin);
  const between = startIndex >= 0 && endIndex > startIndex ? body.slice(startIndex + begin.length, endIndex) : body;
  const exitCode = Number(result.groups[0]);
  return {
    ok: exitCode === 0,
    exitCode,
    stdout: clip(between.replace(/^\r?\n/, "").replace(/\r/g, "")),
    stderr: "",
    channel: "console",
  };
}

/* ------------------------------------------------------------ guest access */

async function openAgent(vm, { timeoutMs = 4000 } = {}) {
  const live = await liveState(vm);
  if (!live.running) throw new Error(`VM "${vm.name}" is not running — start it first (action=start)`);
  return QgaClient.open(vm.ports.qga, { timeoutMs, syncTimeoutMs: timeoutMs, os: vm.os });
}

async function execGuest(userDataPath, key, command, options = {}) {
  const vm = store.requireVm(userDataPath, key);
  if (!command || !String(command).trim()) throw new Error("command is required");
  const channel = String(options.channel || "auto").toLowerCase();
  if (channel !== "console") {
    let agent = null;
    try {
      agent = await openAgent(vm, { timeoutMs: options.agentTimeoutMs || 4000 });
      const result = await agent.exec(String(command), {
        shell: options.shell || "auto",
        timeoutMs: options.timeoutMs || 300_000,
        cwd: options.cwd || "",
        env: options.env || [],
        input: options.input || "",
      });
      return { ...result, channel: "agent", vm: vm.name, stdout: clip(result.stdout), stderr: clip(result.stderr) };
    } catch (err) {
      agent?.close();
      if (channel === "agent") throw err;
      if (vm.os === "windows") throw err;
      const fallback = await consoleExec(vm, String(command), { timeoutMs: options.timeoutMs || 120_000 });
      return { ...fallback, vm: vm.name, agentError: err.message };
    } finally {
      agent?.close();
    }
  }
  const result = await consoleExec(vm, String(command), { timeoutMs: options.timeoutMs || 120_000 });
  return { ...result, vm: vm.name };
}

async function readGuestFile(userDataPath, key, filePath, options = {}) {
  const vm = store.requireVm(userDataPath, key);
  if (!filePath) throw new Error("path is required");
  let agent = null;
  try {
    agent = await openAgent(vm);
    const { buffer, truncated } = await agent.readFile(String(filePath), {
      maxBytes: Math.min(Number(options.max_bytes) || 4 * 1024 * 1024, 64 * 1024 * 1024),
      binary: Boolean(options.binary),
    });
    return {
      ok: true,
      channel: "agent",
      path: filePath,
      bytes: buffer.length,
      truncated,
      content: options.binary ? buffer.toString("base64") : clip(buffer.toString("utf8")),
      encoding: options.binary ? "base64" : "utf8",
    };
  } catch (err) {
    agent?.close();
    if (vm.os === "windows") throw err;
    const result = await consoleExec(vm, `cat ${JSON.stringify(String(filePath))}`, { timeoutMs: 60_000 });
    if (!result.ok) throw new Error(`could not read ${filePath}: ${result.stdout || err.message}`);
    return { ok: true, channel: "console", path: filePath, content: result.stdout, encoding: "utf8", agentError: err.message };
  } finally {
    agent?.close();
  }
}

async function writeGuestFile(userDataPath, key, filePath, content, options = {}) {
  const vm = store.requireVm(userDataPath, key);
  if (!filePath) throw new Error("path is required");
  const data = options.encoding === "base64" ? Buffer.from(String(content || ""), "base64") : Buffer.from(String(content ?? ""), "utf8");
  let agent = null;
  try {
    agent = await openAgent(vm);
    const result = await agent.writeFile(String(filePath), data, {
      append: Boolean(options.append),
      binary: options.encoding === "base64",
    });
    return { ok: true, channel: "agent", ...result };
  } catch (err) {
    agent?.close();
    if (vm.os === "windows" || data.length > 256 * 1024) throw err;
    const b64 = data.toString("base64");
    const command = `printf '%s' '${b64}' | base64 -d ${options.append ? ">>" : ">"} ${JSON.stringify(String(filePath))} && echo written`;
    const result = await consoleExec(vm, command, { timeoutMs: 120_000 });
    if (!result.ok) throw new Error(`could not write ${filePath}: ${result.stdout || err.message}`);
    return { ok: true, channel: "console", path: filePath, bytes: data.length, agentError: err.message };
  } finally {
    agent?.close();
  }
}

async function copyToGuest(userDataPath, key, hostPath, guestPath) {
  const source = path.resolve(String(hostPath || ""));
  if (!fs.existsSync(source)) throw new Error(`host file not found: ${source}`);
  const data = fs.readFileSync(source);
  const result = await writeGuestFile(userDataPath, key, guestPath, data.toString("base64"), { encoding: "base64" });
  return { ...result, from: source, to: guestPath, bytes: data.length };
}

async function copyFromGuest(userDataPath, key, guestPath, hostPath) {
  const vm = store.requireVm(userDataPath, key);
  const agent = await openAgent(vm);
  try {
    const { buffer } = await agent.readFile(String(guestPath), { maxBytes: 256 * 1024 * 1024, binary: true });
    const target = path.resolve(String(hostPath || path.join(vm.dir, "downloads", path.basename(String(guestPath)))));
    ensureDir(path.dirname(target));
    fs.writeFileSync(target, buffer);
    return { ok: true, from: guestPath, to: target, bytes: buffer.length };
  } finally {
    agent.close();
  }
}

async function waitReady(userDataPath, key, { timeoutMs = 300_000, pollMs = 3000 } = {}) {
  const vm = store.requireVm(userDataPath, key);
  const deadline = Date.now() + timeoutMs;
  const started = Date.now();
  let lastReason = "";
  for (;;) {
    const live = await liveState(vm);
    if (!live.running) return { ok: false, ready: false, reason: "VM is not running", waitedMs: Date.now() - started };
    if (await probeAgent(vm.ports.qga, { timeoutMs: 2500, os: vm.os })) {
      store.update(userDataPath, vm.id, { agentReadyAt: Date.now() });
      return { ok: true, ready: true, via: "guest-agent", waitedMs: Date.now() - started };
    }
    const log = tail(vm.serialLog, 300_000);
    if (log.includes(cloudinit.READY_TOKEN)) {
      lastReason = "cloud-init finished, guest agent still starting";
      if (Date.now() - started > 30_000) {
        return { ok: true, ready: true, via: "cloud-init", note: lastReason, waitedMs: Date.now() - started };
      }
    } else if (/login:\s*$/m.test(log)) {
      lastReason = "login prompt on serial console, no guest agent yet";
    } else {
      lastReason = "booting";
    }
    if (Date.now() >= deadline) {
      return {
        ok: false,
        ready: false,
        reason: lastReason,
        waitedMs: Date.now() - started,
        consoleTail: clip(tail(vm.serialLog, 2000), 2000),
      };
    }
    await sleep(pollMs);
  }
}

async function guestInfo(userDataPath, key) {
  const vm = store.requireVm(userDataPath, key);
  const agent = await openAgent(vm);
  try {
    const info = await agent.info();
    const addresses = await agent.addresses();
    return { ok: true, vm: vm.name, addresses, ...info };
  } finally {
    agent.close();
  }
}

/* ---------------------------------------------------------------- extras */

async function qmpRaw(userDataPath, key, command, args) {
  const vm = store.requireVm(userDataPath, key);
  return withQmp(vm.ports.qmp, async (client) => ({
    ok: true,
    command,
    result: await client.command(String(command), args || {}, 30_000),
  }));
}

async function qgaRaw(userDataPath, key, command, args) {
  const vm = store.requireVm(userDataPath, key);
  const agent = await openAgent(vm);
  try {
    return { ok: true, command, result: await agent.command(String(command), args || {}, 60_000) };
  } finally {
    agent.close();
  }
}

/**
 * Snapshots. A running machine is snapshotted through the monitor (RAM included),
 * a stopped one through qemu-img (disk only) — the offline path is the one that
 * always works, because WHPX cannot track dirty memory for a live save.
 */
async function snapshot(userDataPath, key, action, name) {
  const vm = store.requireVm(userDataPath, key);
  const label = String(name || "").trim();
  const live = await liveState(vm);
  const needsLabel = () => {
    if (!label) throw new Error(`snapshot ${action} requires a snapshot name`);
  };

  if (!live.running) {
    const qemu = detectHost.requireQemu(userDataPath);
    if (action === "list") {
      const out = await runQemuImg(qemu.img, ["snapshot", "-l", vm.diskPath]);
      return { ok: true, mode: "offline", snapshots: out.trim() || "no snapshots on this disk" };
    }
    needsLabel();
    const flag = { save: "-c", restore: "-a", delete: "-d" }[action];
    if (!flag) throw new Error("snapshot action must be save, restore, delete or list");
    const output = await runQemuImg(qemu.img, ["snapshot", flag, label, vm.diskPath], 20 * 60_000);
    return { ok: true, mode: "offline", [`${action}d`]: label, output: output.trim() || `${action} ok (VM stopped)` };
  }

  return withQmp(vm.ports.qmp, async (client) => {
    if (action === "list") {
      const out = await client.hmp("info snapshots");
      return { ok: true, mode: "live", snapshots: out.trim() };
    }
    needsLabel();
    const command = { save: `savevm ${label}`, restore: `loadvm ${label}`, delete: `delvm ${label}` }[action];
    if (!command) throw new Error("snapshot action must be save, restore, delete or list");
    const output = (await client.hmp(command, 300_000)).trim();
    if (/^error|error:|blocked/i.test(output)) {
      const hint = /dirty memory tracking/i.test(output)
        ? " — this accelerator cannot save live RAM. Stop the VM (action=stop) and snapshot its disk instead, or start it with accel=tcg."
        : "";
      return { ok: false, mode: "live", error: `${output}${hint}`, output };
    }
    return { ok: true, mode: "live", [`${action}d`]: label, output: output || `${action} ok` };
  });
}

async function addPortForward(userDataPath, key, { host, guest, proto = "tcp" }) {
  const vm = store.requireVm(userDataPath, key);
  const hostPort = Number(host) || (await pickFreePort());
  const guestPort = Number(guest);
  if (!guestPort) throw new Error("guest port is required");
  const output = await withQmp(vm.ports.qmp, (client) =>
    client.hmp(`hostfwd_add net0 ${proto}:127.0.0.1:${hostPort}-:${guestPort}`)
  );
  const forwards = [...(vm.forwards || []), { host: hostPort, guest: guestPort, proto }];
  store.update(userDataPath, vm.id, { forwards });
  return { ok: !/error|not found/i.test(output), host: hostPort, guest: guestPort, proto, output: output.trim() };
}

async function screenshot(userDataPath, key, target) {
  const vm = store.requireVm(userDataPath, key);
  const file = path.resolve(String(target || path.join(vm.dir, `screen-${Date.now()}.png`)));
  ensureDir(path.dirname(file));
  return withQmp(vm.ports.qmp, async (client) => {
    try {
      await client.command("screendump", { filename: file, format: "png" }, 30_000);
      return { ok: true, path: file, format: "png" };
    } catch {
      const ppm = file.replace(/\.png$/i, ".ppm");
      await client.command("screendump", { filename: ppm }, 30_000);
      return { ok: true, path: ppm, format: "ppm", note: "this QEMU build has no png screendump support" };
    }
  });
}

module.exports = {
  hostStatus,
  hostConfig,
  hostInstall: (userDataPath, options) => installer.install(userDataPath, options),
  createVm,
  listVms,
  infoVm,
  startVm,
  stopVm,
  restartVm,
  pauseVm,
  deleteVm,
  execGuest,
  readGuestFile,
  writeGuestFile,
  copyToGuest,
  copyFromGuest,
  waitReady,
  guestInfo,
  readSerial,
  writeSerial,
  expectSerial,
  consoleExec,
  serialSize,
  qmpRaw,
  qgaRaw,
  snapshot,
  addPortForward,
  screenshot,
  images,
  view,
  liveState,
  clip,
  buildArgs,
  normalizeForwards,
  machinePaths,
};
