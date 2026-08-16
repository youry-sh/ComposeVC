const fs = require("fs");
const path = require("path");
const { buildIso } = require("./iso.cjs");

/** Printed by cloud-init on the serial console — the single 0/1 "guest is up" signal. */
const READY_TOKEN = "COMPOSEVC_READY";

function yamlString(value) {
  return `"${String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function indentBlock(text, indent) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => `${indent}${line}`)
    .join("\n");
}

/**
 * cloud-config for a Linux guest: one login, a guest agent, and a readiness marker.
 * Everything else the caller wants is appended verbatim through extraUserData.
 */
function buildUserData({
  hostname,
  user = "vc",
  password = "composevc",
  sshKeys = [],
  packages = ["qemu-guest-agent"],
  runcmd = [],
  writeFiles = [],
  extraUserData = "",
  installAgent = true,
} = {}) {
  const lines = ["#cloud-config", `hostname: ${hostname}`, `preserve_hostname: false`, "ssh_pwauth: true", "disable_root: false"];
  lines.push("users:");
  lines.push(`  - name: ${user}`);
  lines.push("    sudo: ALL=(ALL) NOPASSWD:ALL");
  lines.push("    shell: /bin/bash");
  lines.push("    lock_passwd: false");
  lines.push("    groups: [sudo, adm]");
  if (sshKeys.length) {
    lines.push("    ssh_authorized_keys:");
    for (const key of sshKeys) lines.push(`      - ${yamlString(key)}`);
  }
  lines.push("chpasswd:");
  lines.push("  expire: false");
  lines.push("  list: |");
  lines.push(`    ${user}:${password}`);
  lines.push(`    root:${password}`);

  const allPackages = installAgent ? Array.from(new Set([...packages, "qemu-guest-agent"])) : packages;
  if (allPackages.length) {
    lines.push("package_update: true");
    lines.push("packages:");
    for (const pkg of allPackages) lines.push(`  - ${pkg}`);
  }

  const files = [
    { path: "/etc/composevc-vm", content: `${hostname}\n` },
    ...writeFiles,
  ];
  lines.push("write_files:");
  for (const file of files) {
    lines.push(`  - path: ${file.path}`);
    lines.push(`    permissions: ${yamlString(file.permissions || "0644")}`);
    lines.push("    content: |");
    lines.push(indentBlock(file.content ?? "", "      "));
  }

  const bootCommands = [
    ...(installAgent
      ? [
          "systemctl enable --now qemu-guest-agent 2>/dev/null || rc-service qemu-guest-agent start 2>/dev/null || true",
          "systemctl enable --now serial-getty@ttyS0.service 2>/dev/null || true",
        ]
      : []),
    ...runcmd.map((cmd) => (Array.isArray(cmd) ? cmd.join(" ") : String(cmd))),
  ];
  if (bootCommands.length) {
    lines.push("runcmd:");
    for (const cmd of bootCommands) lines.push(`  - ${yamlString(cmd)}`);
  }
  lines.push(`final_message: ${yamlString(`${READY_TOKEN} ${hostname} uptime=$UPTIME`)}`);
  const extra = String(extraUserData || "").trim();
  if (extra) lines.push(extra.replace(/^#cloud-config\s*/i, ""));
  return `${lines.join("\n")}\n`;
}

function buildMetaData({ hostname, instanceId }) {
  return `instance-id: ${instanceId}\nlocal-hostname: ${hostname}\n`;
}

/** Write <dir>/seed.iso (NoCloud CIDATA) and return its path. */
function writeSeedIso(dir, options = {}) {
  const hostname = String(options.hostname || "composevc").toLowerCase();
  const instanceId = options.instanceId || `${hostname}-${Date.now().toString(36)}`;
  const userData = options.userData || buildUserData({ ...options, hostname });
  const metaData = options.metaData || buildMetaData({ hostname, instanceId });
  const files = [
    { name: "user-data", data: userData },
    { name: "meta-data", data: metaData },
  ];
  if (options.networkConfig) files.push({ name: "network-config", data: options.networkConfig });
  if (options.vendorData) files.push({ name: "vendor-data", data: options.vendorData });
  const image = buildIso(files, { label: "CIDATA" });
  const target = path.join(dir, "seed.iso");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(target, image);
  fs.writeFileSync(path.join(dir, "user-data.yaml"), userData, "utf8");
  return { path: target, userData, metaData, instanceId };
}

module.exports = { READY_TOKEN, buildUserData, buildMetaData, writeSeedIso };
