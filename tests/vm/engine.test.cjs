const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const userData = fs.mkdtempSync(path.join(os.tmpdir(), "cvc-vm-test-"));
process.env.COMPOSEVC_USER_DATA = userData;

const { layout, readConfig, writeConfig } = require("../../electron/vm/paths.cjs");
const store = require("../../electron/vm/store.cjs");
const engine = require("../../electron/vm/engine.cjs");
const registry = require("../../electron/tools/registry.cjs");
const vmTool = require("../../electron/tools/vmTool.cjs");
const { buildShell } = require("../../electron/vm/qga.cjs");
const cloudinit = require("../../electron/vm/cloudinit.cjs");

/* ------------------------------------------------------------- registry */

assert.equal(registry.normalizeToolName("vm"), "vm");
for (const alias of ["create_vm", "list_vms", "qemu", "virtual_machine", "vm_exec", "machines"]) {
  assert.equal(registry.normalizeToolName(alias), "vm", `alias ${alias}`);
}
assert.ok(registry.getTool("vm"), "vm tool is registered");
assert.ok(
  registry.getToolSchemas().some((tool) => tool.name === "vm"),
  "vm tool is exposed to the model"
);

/* ---------------------------------------------------------------- store */

assert.deepEqual(store.readAll(userData), []);
const name = store.validateName("dev-box", userData);
assert.equal(name, "dev-box");
assert.throws(() => store.validateName("bad name!", userData), /letters, digits/);
assert.throws(() => store.validateName("", userData), /required/);

const record = { id: store.newId(), name: "dev-box", os: "linux", state: "created", createdAt: Date.now() };
store.insert(userData, record);
assert.equal(store.find(userData, "dev-box").id, record.id);
assert.equal(store.find(userData, "DEV-BOX").id, record.id, "name lookup is case-insensitive");
assert.equal(store.find(userData, record.id).name, "dev-box");
assert.throws(() => store.validateName("dev-box", userData), /already exists/);
assert.throws(() => store.requireVm(userData, "nope"), /VM not found.*dev-box/s);
store.update(userData, record.id, { state: "running", pid: 4242 });
assert.equal(store.readAll(userData)[0].state, "running");
assert.equal(store.remove(userData, record.id), true);
assert.deepEqual(store.readAll(userData), []);

/* ------------------------------------------------------------- forwards */

const forwards = engine.normalizeForwards(["8080:80", "udp:5353-53", { host: 15432, guest: 5432 }, "garbage"], "linux", 2222);
assert.deepEqual(forwards, [
  { host: 2222, guest: 22, proto: "tcp" },
  { host: 8080, guest: 80, proto: "tcp" },
  { host: 5353, guest: 53, proto: "udp" },
  { host: 15432, guest: 5432, proto: "tcp" },
]);
assert.equal(engine.normalizeForwards(null, "windows", 3390)[0].guest, 3389, "windows forwards RDP by default");

/* ------------------------------------------------------------- qemu args */

const dir = path.join(layout.machines(userData), "vm-args-test");
fs.mkdirSync(dir, { recursive: true });
const seed = path.join(dir, "seed.iso");
fs.writeFileSync(seed, "seed");

const linuxVm = {
  id: "vm-args-test",
  name: "dev-box",
  os: "linux",
  dir,
  diskPath: path.join(dir, "disk.qcow2"),
  serialLog: path.join(dir, "serial.log"),
  cpus: 4,
  memoryMb: 4096,
  firmware: "bios",
  display: "none",
  cdroms: [seed],
  ports: { qmp: 11111, qga: 22222, console: 33333 },
  forwards: [{ host: 2222, guest: 22, proto: "tcp" }],
};
const args = engine.buildArgs(linuxVm, { dir: "C:/qemu" }, { accel: "whpx", cpuModel: "max" });
const joined = args.join(" ");
assert.ok(joined.includes("-accel whpx,kernel-irqchip=off"), "whpx needs kernel-irqchip=off");
assert.ok(joined.includes("-smp 4") && joined.includes("-m 4096"));
assert.ok(joined.includes("if=virtio"), "linux boots off virtio");
assert.ok(joined.includes("virtio-net-pci"), "linux uses the virtio NIC");
assert.ok(joined.includes("hostfwd=tcp:127.0.0.1:2222-:22"), "ssh is forwarded");
assert.ok(joined.includes("org.qemu.guest_agent.0"), "guest agent port is wired");
assert.ok(joined.includes("tcp:127.0.0.1:11111,server=on,wait=off"), "QMP listens");
assert.ok(joined.includes(`logfile=${linuxVm.serialLog}`), "serial output is always logged");
assert.ok(joined.includes("-display none"), "headless by default");
assert.ok(joined.includes("-boot order=c"), "linux boots from disk");

const windowsVm = {
  ...linuxVm,
  os: "windows",
  display: "vnc",
  boot: "dc",
  cdroms: [seed, seed],
  ports: { ...linuxVm.ports, vncDisplay: 3 },
  forwards: [{ host: 33890, guest: 3389, proto: "tcp" }],
};
const winArgs = engine.buildArgs(windowsVm, { dir: "C:/qemu" }, { accel: "tcg", cpuModel: "qemu64" }).join(" ");
assert.ok(winArgs.includes("-accel tcg,thread=multi"), "tcg runs multi-threaded");
assert.ok(winArgs.includes("ide-hd,drive=hd0,bus=ahci0.0"), "windows disk hangs off AHCI, not virtio");
assert.ok(winArgs.includes("e1000e"), "windows gets a NIC it has drivers for");
assert.ok(winArgs.includes("ide-cd,drive=cd0,bus=ahci0.1") && winArgs.includes("ide-cd,drive=cd1,bus=ahci0.2"), "both ISOs attach");
assert.ok(winArgs.includes("-vnc 127.0.0.1:3,to=99"), "vnc display is allocated");
assert.ok(winArgs.includes("-boot order=dc"), "windows boots the installer first");
assert.ok(winArgs.includes("base=localtime"), "windows expects a localtime RTC");

/* --------------------------------------------------------- guest shells */

assert.deepEqual(buildShell("ls -la", { os: "linux" }), { path: "/bin/sh", arg: ["-lc", "ls -la"] });
assert.deepEqual(buildShell("ls", { os: "linux", shell: "bash", cwd: "/srv/app" }), {
  path: "/bin/bash",
  arg: ["-lc", "cd '/srv/app' && ls"],
});
assert.deepEqual(buildShell("dir", { os: "windows", shell: "cmd" }), { path: "cmd.exe", arg: ["/d", "/s", "/c", "dir"] });
assert.equal(buildShell("Get-Process", { os: "windows" }).path, "powershell.exe");
assert.ok(buildShell("echo x", { os: "linux", cwd: "/tmp/it's" }).arg[1].includes("'/tmp/it'\\''s'"), "cwd quoting is escaped");

/* ------------------------------------------------------------ cloud-init */

const seedResult = cloudinit.writeSeedIso(dir, { hostname: "dev-box", user: "vc", password: "s3cret", instanceId: "vm-1" });
assert.ok(fs.existsSync(seedResult.path));
assert.ok(seedResult.userData.startsWith("#cloud-config"));
assert.ok(seedResult.userData.includes("vc:s3cret"), "the login password is set");
assert.ok(seedResult.userData.includes("qemu-guest-agent"), "the agent is installed on first boot");
assert.ok(seedResult.userData.includes(cloudinit.READY_TOKEN), "cloud-init prints the readiness token");
assert.ok(seedResult.metaData.includes("instance-id: vm-1"));

/* ----------------------------------------------------------- tool surface */

assert.equal(vmTool.name, "vm");
assert.ok(vmTool.inputSchema.properties.action.enum.includes("exec"));

/* -------------------------------------------------------------- config */

const config = writeConfig(userData, { defaultCpus: 8, qemuDir: "C:/qemu" });
assert.equal(config.defaultCpus, 8);
assert.equal(readConfig(userData).qemuDir, "C:/qemu");

(async () => {
  await assert.rejects(() => vmTool.execute({ action: "nonsense" }, { userDataPath: userData }), /unknown action/);
  await assert.rejects(() => vmTool.execute({ action: "info" }, { userDataPath: userData }), /name \(or id\) of the VM is required/);

  const status = await vmTool.execute({ action: "host_status" }, { userDataPath: userData });
  assert.equal(typeof status.bit, "number");
  assert.equal(status.bit, status.ok ? 1 : 0, "bit mirrors ok");
  assert.ok(typeof status.text === "string" && status.text.length > 0, "there is always text");

  const list = await vmTool.execute({ action: "list" }, { userDataPath: userData });
  assert.equal(list.bit, 1);
  assert.equal(list.count, 0);
  assert.equal(list.text, "no machines yet — action=create");

  const imagesResult = await vmTool.execute({ action: "images" }, { userDataPath: userData });
  assert.ok(imagesResult.catalog.some((entry) => entry.id === "debian-12"));
  assert.ok(imagesResult.catalog.every((entry) => entry.downloaded === false));
  assert.ok(imagesResult.text.startsWith("0 debian-12"));

  fs.rmSync(userData, { recursive: true, force: true });
  console.log("vm/engine: ok");
})();
