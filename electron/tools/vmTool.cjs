const engine = require("../vm/engine.cjs");

const ACTIONS = [
  "host_status",
  "host_install",
  "host_config",
  "images",
  "image_pull",
  "image_delete",
  "create",
  "list",
  "info",
  "start",
  "stop",
  "restart",
  "kill",
  "pause",
  "resume",
  "delete",
  "wait_ready",
  "exec",
  "read_file",
  "write_file",
  "upload",
  "download",
  "guest_info",
  "console",
  "console_write",
  "console_expect",
  "snapshot",
  "port_forward",
  "screenshot",
  "qmp",
  "qga",
];

/** Every answer carries one bit: 1 = it happened / it is true, 0 = it did not. */
function truth(ok, text, payload = {}) {
  return { bit: ok ? 1 : 0, ok: Boolean(ok), text, ...payload };
}

function resolveUserData(context) {
  return require("../vm/paths.cjs").resolveUserData(context?.userDataPath);
}

function pick(input, ...keys) {
  for (const key of keys) {
    const value = input[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function vmKey(input) {
  const key = pick(input, "name", "id", "vm", "vm_name", "machine", "target");
  if (!key) throw new Error("name (or id) of the VM is required");
  return String(key);
}

function timeoutOf(input, fallback) {
  const value = Number(pick(input, "timeout_ms", "timeoutMs", "timeout"));
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return value < 1000 ? value * 1000 : value; // seconds are accepted too
}

function machineLine(vm) {
  const marks = [
    vm.running ? "RUNNING" : vm.state.toUpperCase(),
    vm.os,
    `${vm.cpus}cpu`,
    `${vm.memoryMb}MB`,
    `${vm.diskGb}GB`,
    vm.accel || "",
    vm.ssh || vm.rdp || "",
    vm.vnc ? `vnc ${vm.vnc}` : "",
  ].filter(Boolean);
  return `${vm.running ? "1" : "0"} ${vm.name} [${vm.id}] ${marks.join(" ")}`;
}

async function run(action, input, context) {
  const userDataPath = resolveUserData(context);

  switch (action) {
    case "host_status": {
      const status = engine.hostStatus(userDataPath);
      const text = status.qemuInstalled
        ? `QEMU ${status.qemu.version || "?"} at ${status.qemu.dir} — accel ${status.qemu.preferredAccel}${
            status.qemu.hardwareAccel ? " (hardware)" : " (software, slow)"
          }; ${status.machinesRunning}/${status.machines} machines running; ${status.diskFreeGb}GB free`
        : `QEMU is NOT installed — ${status.reason || "no binary found"}. Run action=host_install.`;
      return truth(status.qemuInstalled, text, status);
    }
    case "host_install": {
      const result = await engine.hostInstall(userDataPath, { wait: input.wait === true });
      const installed = Boolean(result.installed || result.qemu);
      const text = installed
        ? `QEMU ready at ${result.qemu?.dir || "(host path)"}`
        : result.running
          ? "Installing QEMU in the background — poll with action=host_status."
          : `Install did not finish: ${result.job?.error || "unknown"}`;
      return truth(installed || Boolean(result.running), text, result);
    }
    case "host_config": {
      const patch = {};
      const qemuDir = pick(input, "qemu_dir", "qemuDir", "path");
      if (qemuDir) patch.qemuDir = String(qemuDir);
      if (input.cpus) patch.defaultCpus = Number(input.cpus);
      if (input.memory_mb) patch.defaultMemoryMb = Number(input.memory_mb);
      if (input.disk_gb) patch.defaultDiskGb = Number(input.disk_gb);
      if (input.user) patch.defaultUser = String(input.user);
      if (input.password) patch.defaultPassword = String(input.password);
      if (input.accel) patch.accel = String(input.accel);
      const result = engine.hostConfig(userDataPath, patch);
      return truth(result.qemuInstalled, result.qemuInstalled ? `config saved; QEMU at ${result.qemu.dir}` : "config saved; QEMU still not found", result);
    }
    case "images": {
      const list = engine.images.listImages(userDataPath);
      const lines = list.catalog.map((item) => `${item.downloaded ? "1" : "0"} ${item.id} (${item.os}, ~${item.approxMb}MB) ${item.label}`);
      const active = list.downloads.filter((job) => job && job.state === "running");
      if (active.length) lines.push(...active.map((job) => `… downloading ${job.file}: ${job.percent ?? "?"}% (${job.downloadedMb}/${job.totalMb ?? "?"}MB, ${job.mbPerSec}MB/s)`));
      return truth(true, lines.join("\n"), list);
    }
    case "image_pull": {
      const result = await engine.images.pull(userDataPath, {
        image: pick(input, "image", "name", "id"),
        url: pick(input, "url"),
        wait: input.wait === true,
        signal: context?.signal,
      });
      const text = result.alreadyPresent
        ? `already downloaded: ${result.path}`
        : result.done
          ? `downloaded ${result.sizeMb}MB → ${result.path}`
          : `download started → ${result.path} (poll action=images)`;
      return truth(true, text, result);
    }
    case "image_delete": {
      const result = engine.images.deleteImage(userDataPath, pick(input, "image", "file", "name"));
      return truth(result.deleted, result.deleted ? `deleted ${result.path}` : `nothing to delete at ${result.path}`, result);
    }
    case "create": {
      const result = await engine.createVm(
        userDataPath,
        {
          ...input,
          name: pick(input, "name", "vm_name"),
          image: pick(input, "image", "distro", "os_image"),
          iso: pick(input, "iso", "iso_path", "iso_url"),
          memory_mb: pick(input, "memory_mb", "memoryMb", "ram_mb", "memory"),
          disk_gb: pick(input, "disk_gb", "diskGb", "disk"),
        },
        context
      );
      const vm = result.vm;
      const text = [
        `${result.started ? "1" : "0"} created ${vm.name} [${vm.id}] ${vm.os} ${vm.cpus}cpu ${vm.memoryMb}MB ${vm.diskGb}GB`,
        result.started ? `running, accel ${result.start?.accel}` : "created but not started",
        vm.ssh ? `ssh: ${vm.ssh} (password ${vm.password})` : "",
        vm.vnc ? `vnc: ${vm.vnc}` : "",
        result.start?.hint || "",
      ]
        .filter(Boolean)
        .join("\n");
      return truth(true, text, result);
    }
    case "list": {
      const result = await engine.listVms(userDataPath, { probe: input.probe !== false });
      const text = result.count
        ? `${result.running}/${result.count} running\n${result.machines.map(machineLine).join("\n")}`
        : "no machines yet — action=create";
      return truth(true, text, result);
    }
    case "info": {
      const result = await engine.infoVm(userDataPath, vmKey(input));
      const vm = result.vm;
      const text = [
        machineLine(vm),
        `agent: ${result.agent ? "1 (guest agent answering)" : "0 (no guest agent)"}`,
        result.readySignal ? "cloud-init: finished" : "",
        vm.lastError ? `last error: ${vm.lastError}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return truth(vm.running, text, result);
    }
    case "start": {
      const result = await engine.startVm(userDataPath, vmKey(input), { display: pick(input, "display"), accel: pick(input, "accel") }, context);
      return truth(result.ok, result.alreadyRunning ? `${result.vm.name} was already running` : `${result.vm.name} started (accel ${result.accel})\n${result.hint || ""}`, result);
    }
    case "stop": {
      const result = await engine.stopVm(userDataPath, vmKey(input), {
        timeoutMs: timeoutOf(input, 90_000),
        force: input.force === true,
      });
      return truth(result.ok, `${result.vm.name}: ${result.alreadyStopped ? "already stopped" : result.graceful ? "stopped gracefully" : "stopped (forced)"}`, result);
    }
    case "kill": {
      const result = await engine.stopVm(userDataPath, vmKey(input), { force: true, timeoutMs: 5000 });
      return truth(result.ok, `${result.vm.name}: killed`, result);
    }
    case "restart": {
      const result = await engine.restartVm(userDataPath, vmKey(input), { force: input.force === true }, context);
      return truth(result.ok, `${result.vm.name} restarted (accel ${result.accel})`, result);
    }
    case "pause":
    case "resume": {
      const result = await engine.pauseVm(userDataPath, vmKey(input), action === "resume");
      return truth(result.ok, `${result.vm.name} ${action === "resume" ? "resumed" : "paused"}`, result);
    }
    case "delete": {
      const result = await engine.deleteVm(userDataPath, vmKey(input), { keepFiles: input.keep_files === true });
      return truth(result.deleted, `deleted ${result.name} [${result.id}]${result.filesRemoved ? " with its disk" : " (files kept)"}`, result);
    }
    case "wait_ready": {
      const result = await engine.waitReady(userDataPath, vmKey(input), { timeoutMs: timeoutOf(input, 300_000) });
      return truth(
        result.ready,
        result.ready
          ? `ready via ${result.via} after ${Math.round(result.waitedMs / 1000)}s`
          : `not ready after ${Math.round(result.waitedMs / 1000)}s: ${result.reason}`,
        result
      );
    }
    case "exec": {
      const command = pick(input, "command", "cmd", "script", "text");
      const result = await engine.execGuest(userDataPath, vmKey(input), command, {
        shell: pick(input, "shell"),
        cwd: pick(input, "cwd", "workdir"),
        channel: pick(input, "channel"),
        timeoutMs: timeoutOf(input, 300_000),
        input: pick(input, "stdin", "input"),
      });
      const body = [result.stdout, result.stderr ? `--- stderr ---\n${result.stderr}` : ""].filter(Boolean).join("\n");
      const text = `exit=${result.exitCode ?? "n/a"} via ${result.channel}\n${body || "(no output)"}`;
      return truth(result.ok, text, result);
    }
    case "read_file": {
      const result = await engine.readGuestFile(userDataPath, vmKey(input), pick(input, "path", "file", "guest_path"), {
        binary: input.binary === true || input.encoding === "base64",
        max_bytes: pick(input, "max_bytes"),
      });
      return truth(true, result.content, result);
    }
    case "write_file": {
      const result = await engine.writeGuestFile(
        userDataPath,
        vmKey(input),
        pick(input, "path", "file", "guest_path"),
        pick(input, "content", "text", "data") ?? "",
        { append: input.append === true, encoding: pick(input, "encoding") }
      );
      return truth(result.ok, `wrote ${result.bytes} bytes to ${result.path} via ${result.channel}`, result);
    }
    case "upload": {
      const result = await engine.copyToGuest(
        userDataPath,
        vmKey(input),
        pick(input, "host_path", "from", "source", "path"),
        pick(input, "guest_path", "to", "target", "dest")
      );
      return truth(result.ok, `uploaded ${result.bytes} bytes: ${result.from} → ${result.to}`, result);
    }
    case "download": {
      const result = await engine.copyFromGuest(
        userDataPath,
        vmKey(input),
        pick(input, "guest_path", "from", "source", "path"),
        pick(input, "host_path", "to", "target", "dest")
      );
      return truth(result.ok, `downloaded ${result.bytes} bytes: ${result.from} → ${result.to}`, result);
    }
    case "guest_info": {
      const result = await engine.guestInfo(userDataPath, vmKey(input));
      const osInfo = result.osInfo ? `${result.osInfo["pretty-name"] || result.osInfo.name || "?"} ${result.osInfo["kernel-release"] || ""}` : "unknown";
      const text = [`os: ${osInfo}`, `hostname: ${result.hostname?.["host-name"] || "?"}`, `addresses: ${result.addresses.map((a) => `${a.iface}=${a.address}`).join(", ") || "none"}`].join("\n");
      return truth(true, text, result);
    }
    case "console": {
      const vm = require("../vm/store.cjs").requireVm(userDataPath, vmKey(input));
      const result = engine.readSerial(vm, {
        fromOffset: pick(input, "offset") == null ? null : Number(pick(input, "offset")),
        maxChars: Number(pick(input, "max_chars")) || 20_000,
      });
      return truth(true, result.text || "(console log is empty)", { ...result, vm: vm.name });
    }
    case "console_write": {
      const vm = require("../vm/store.cjs").requireVm(userDataPath, vmKey(input));
      const before = engine.serialSize(vm);
      await engine.writeSerial(vm, String(pick(input, "text", "command", "cmd", "keys") ?? ""), { enter: input.enter !== false });
      const wait = Number(pick(input, "wait_ms")) || 800;
      await new Promise((resolve) => setTimeout(resolve, wait));
      const after = engine.readSerial(vm, { fromOffset: before, maxChars: 20_000 });
      return truth(true, after.text || "(no new console output)", { ...after, vm: vm.name });
    }
    case "console_expect": {
      const vm = require("../vm/store.cjs").requireVm(userDataPath, vmKey(input));
      const before = engine.serialSize(vm);
      const send = pick(input, "text", "command", "cmd");
      if (send != null) await engine.writeSerial(vm, String(send), { enter: input.enter !== false });
      const result = await engine.expectSerial(vm, String(pick(input, "pattern", "expect", "regex") || "\\$"), {
        timeoutMs: timeoutOf(input, 60_000),
        fromOffset: before,
      });
      return truth(result.matched, `${result.matched ? `matched: ${result.match}` : "no match (timeout)"}\n${engine.clip(result.text, 8000)}`, {
        ...result,
        text: engine.clip(result.text, 8000),
        vm: vm.name,
      });
    }
    case "snapshot": {
      const result = await engine.snapshot(
        userDataPath,
        vmKey(input),
        String(pick(input, "snapshot_action", "operation", "mode") || "list").toLowerCase(),
        pick(input, "snapshot", "snapshot_name", "label")
      );
      return truth(result.ok, result.error || result.snapshots || result.output || "done", result);
    }
    case "port_forward": {
      const result = await engine.addPortForward(userDataPath, vmKey(input), {
        host: pick(input, "host_port", "host"),
        guest: pick(input, "guest_port", "guest", "port"),
        proto: pick(input, "proto") || "tcp",
      });
      return truth(result.ok, `127.0.0.1:${result.host} → guest ${result.proto}/${result.guest}`, result);
    }
    case "screenshot": {
      const result = await engine.screenshot(userDataPath, vmKey(input), pick(input, "host_path", "path", "to"));
      return truth(result.ok, `screen saved to ${result.path}`, result);
    }
    case "qmp": {
      const result = await engine.qmpRaw(userDataPath, vmKey(input), pick(input, "qmp_command", "command", "cmd"), input.args || input.arguments);
      return truth(true, JSON.stringify(result.result, null, 2), result);
    }
    case "qga": {
      const result = await engine.qgaRaw(userDataPath, vmKey(input), pick(input, "qga_command", "command", "cmd"), input.args || input.arguments);
      return truth(true, JSON.stringify(result.result, null, 2), result);
    }
    default:
      throw new Error(`unknown action "${action}". Valid: ${ACTIONS.join(", ")}`);
  }
}

module.exports = {
  name: "vm",
  description:
    "Full virtual machine control: create, run and text-drive real Linux and Windows guests on this host with QEMU. " +
    "Use it whenever the user wants a VM, a sandbox, a clean OS, or work done inside another operating system. " +
    "Host: host_status (is QEMU installed, accel, disk), host_install (installs QEMU), host_config (paths/defaults), images, image_pull, image_delete. " +
    "Lifecycle: create (image=debian-12|debian-13|ubuntu-24.04|ubuntu-22.04|almalinux-9|rocky-9|alpine, or os=windows with iso=<path|url>), " +
    "list (every machine with running=1/0), info, start, stop, restart, kill, pause, resume, delete, wait_ready. " +
    "Text control of the guest OS: exec (runs a command inside the guest and returns stdout/stderr/exit code), read_file, write_file, upload, download, guest_info. " +
    "Raw console: console (read serial output), console_write (type into it), console_expect (send + wait for a regex — works even with no guest agent). " +
    "Extras: snapshot, port_forward, screenshot, qmp, qga. " +
    "Linux guests are provisioned with cloud-init and qemu-guest-agent, so exec works after wait_ready. " +
    "Windows guests need interactive setup over VNC and virtio-win guest tools before exec works. " +
    "Every result carries bit=1 (true/done) or bit=0 (false/failed) plus the raw text.",
  isReadOnly: false,
  disposeAll() {
    // Machines deliberately outlive a stopped agent run — stopping them is an explicit action.
    return { kept: true };
  },
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ACTIONS, description: ACTIONS.join(" | ") },
      name: { type: "string", description: "VM name (create) or the VM to act on (any other action). Ids also work." },
      id: { type: "string", description: "VM id, alternative to name" },
      os: { type: "string", enum: ["linux", "windows"], description: "create: guest family, default linux" },
      image: { type: "string", description: "create/image_pull: catalog id (debian-12, ubuntu-24.04, alpine, …), absolute path, or url" },
      iso: { type: "string", description: "create os=windows: installation ISO path or url" },
      url: { type: "string", description: "image_pull: direct download url" },
      cpus: { type: "number", description: "create: vCPU count (default 2)" },
      memory_mb: { type: "number", description: "create: RAM in MB (default 2048)" },
      disk_gb: { type: "number", description: "create: virtual disk size in GB (default 20)" },
      user: { type: "string", description: "create: login user for the guest (default vc)" },
      password: { type: "string", description: "create: password for that user (default composevc)" },
      ssh_key: { type: "string", description: "create: public SSH key authorized inside the guest" },
      packages: { type: "array", items: { type: "string" }, description: "create: extra packages installed on first boot" },
      cloud_init: { type: "string", description: "create: extra cloud-config YAML appended to the generated user-data" },
      ports: {
        type: "array",
        items: { type: "string" },
        description: 'create: extra forwards as "hostPort:guestPort" (SSH/RDP is forwarded automatically)',
      },
      display: { type: "string", enum: ["none", "window", "vnc"], description: "create/start: headless (default), a QEMU window, or VNC" },
      firmware: { type: "string", enum: ["bios", "uefi"], description: "create: UEFI is required by Windows 11" },
      start: { type: "boolean", description: "create: start immediately (default true)" },
      accel: { type: "string", description: "start: whpx|kvm|hvf|tcg — default is the best available" },
      command: { type: "string", description: "exec/console_write/qmp/qga: the command line to run or send" },
      shell: { type: "string", enum: ["auto", "sh", "bash", "cmd", "powershell"], description: "exec: shell used inside the guest" },
      cwd: { type: "string", description: "exec: working directory inside the guest" },
      channel: { type: "string", enum: ["auto", "agent", "console"], description: "exec: guest agent, serial console, or auto (agent first)" },
      stdin: { type: "string", description: "exec: data piped to the command" },
      path: { type: "string", description: "read_file/write_file: path inside the guest" },
      content: { type: "string", description: "write_file: content to write" },
      encoding: { type: "string", enum: ["utf8", "base64"], description: "read_file/write_file: base64 for binary" },
      append: { type: "boolean", description: "write_file: append instead of overwrite" },
      host_path: { type: "string", description: "upload/download/screenshot: path on this host" },
      guest_path: { type: "string", description: "upload/download: path inside the guest" },
      text: { type: "string", description: "console_write/console_expect: text typed into the serial console" },
      pattern: { type: "string", description: "console_expect: regex to wait for" },
      offset: { type: "number", description: "console: byte offset to read from (0 = whole log)" },
      max_chars: { type: "number", description: "console: how much text to return (default 20000)" },
      wait_ms: { type: "number", description: "console_write: how long to collect output after typing (default 800)" },
      enter: { type: "boolean", description: "console_write/console_expect: press Enter after the text (default true)" },
      snapshot_action: { type: "string", enum: ["save", "restore", "delete", "list"], description: "snapshot: what to do" },
      snapshot: { type: "string", description: "snapshot: snapshot name" },
      host_port: { type: "number", description: "port_forward: port on 127.0.0.1 (auto when omitted)" },
      guest_port: { type: "number", description: "port_forward: port inside the guest" },
      args: { type: "object", description: "qmp/qga: raw arguments object" },
      timeout_ms: { type: "number", description: "exec/stop/wait_ready/console_expect timeout in milliseconds" },
      force: { type: "boolean", description: "stop/restart: skip the graceful shutdown" },
      keep_files: { type: "boolean", description: "delete: keep the disk image on disk" },
      wait: { type: "boolean", description: "host_install/image_pull: block until finished instead of running in the background" },
      probe: { type: "boolean", description: "list: verify each machine over its monitor socket (default true)" },
      qemu_dir: { type: "string", description: "host_config: folder containing qemu-system-x86_64" },
    },
    required: ["action"],
    additionalProperties: true,
  },

  async execute(input = {}, context = {}) {
    const raw = String(context.originalToolName || context.rawToolName || "").toLowerCase().replace(/[^a-z0-9_]/g, "");
    let action = String(pick(input, "action", "command_type", "operation") || "").trim().toLowerCase();
    if (!action && /list/.test(raw)) action = "list";
    if (!action && /create|new/.test(raw)) action = "create";
    if (!action && input.command) action = "exec";
    if (!action) action = "list";
    const aliases = {
      status: "host_status",
      host: "host_status",
      install: "host_install",
      setup: "host_install",
      config: "host_config",
      ls: "list",
      machines: "list",
      show: "info",
      get: "info",
      run: "exec",
      shell: "exec",
      remove: "delete",
      destroy: "delete",
      rm: "delete",
      halt: "stop",
      poweroff: "stop",
      reboot: "restart",
      cat: "read_file",
      put: "upload",
      pull_image: "image_pull",
      serial: "console",
      expect: "console_expect",
      type: "console_write",
    };
    if (aliases[action]) action = aliases[action];
    if (!ACTIONS.includes(action)) throw new Error(`unknown action "${action}". Valid: ${ACTIONS.join(", ")}`);
    return run(action, input, context);
  },
};
