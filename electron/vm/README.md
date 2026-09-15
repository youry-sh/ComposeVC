# VM engine — real virtual machines driven as text

The `vm` tool boots real Linux and Windows guests on this host with QEMU and controls
them through text channels only. Every answer carries one bit: `bit=1` (true / it
happened) or `bit=0` (false / it did not), plus the raw text of whatever the OS said.

No hypervisor GUI, no admin rights required, no cloud. Machines survive app restarts —
QEMU is spawned detached and the registry records the pid and the ports.

## Layout

```
<userData>/vm/
  config.json          qemu path + defaults
  registry.json        every machine ever created
  images/              downloaded base images and ISOs
  qemu/                managed QEMU install (when installed by host_install)
  machines/<id>/
    disk.qcow2         overlay on the base image (Linux) or a fresh disk (Windows)
    seed.iso           cloud-init NoCloud seed (CIDATA)
    serial.log         every byte the guest ever printed on its serial console
    qemu.log           the QEMU command line and its own stderr
    user-data.yaml     the generated cloud-config, for inspection
```

| module | job |
| --- | --- |
| `paths.cjs` | where everything lives, config read/write, disk accounting |
| `store.cjs` | machine registry: insert / find / update / remove, name validation |
| `detect.cjs` | finds `qemu-system-x86_64` + `qemu-img`, version, accelerators |
| `install.cjs` | installs QEMU (7-Zip extract → silent installer → winget/choco → apt/brew/dnf) |
| `images.cjs` | image catalog, resumable downloads, url/path resolution |
| `iso.cjs` | ISO 9660 + Joliet writer (no genisoimage on Windows) |
| `cloudinit.cjs` | generates user-data / meta-data and the seed ISO |
| `qmp.cjs` | QEMU monitor: is it running, paused, gone; snapshots, port forwards |
| `qga.cjs` | guest agent: exec, file read/write, network, shutdown |
| `linesocket.cjs` | line-delimited JSON socket (handles the 0xFF QGA delimiter) |
| `engine.cjs` | everything above, composed into machine lifecycle + guest access |

## The three text channels

1. **Guest agent (`qemu-guest-agent`)** — `exec`, `read_file`, `write_file`, `upload`,
   `download`, `guest_info`. Structured, exit codes included. Installed automatically on
   Linux by cloud-init; on Windows it comes with virtio-win.
2. **Serial console** — `console`, `console_write`, `console_expect`. Works from the
   first millisecond of boot, before any OS is even installed. `serial.log` is written by
   QEMU itself, so nothing is lost when the app is closed. `exec` falls back to this
   channel automatically on Linux when the agent is not up (it logs in for you).
3. **QMP monitor** — machine-level truth (`info`, `pause`, `snapshot`, `port_forward`,
   `screenshot`) and the answer to "is this thing actually alive".

`list` reports `running=1/0` per machine by checking the pid *and* the monitor socket, so
a stale pid never reads as running.

## Typical Linux session

```
vm host_status                                    # is QEMU here, which accelerator
vm host_install                                   # if it is not
vm create name=dev image=debian-12 memory_mb=4096 disk_gb=40
vm wait_ready name=dev                            # cloud-init + agent up
vm exec name=dev command="apt-get update && apt-get install -y nginx"
vm write_file name=dev path=/etc/nginx/sites-enabled/app content="server { ... }"
vm exec name=dev command="systemctl restart nginx"
vm port_forward name=dev guest_port=80            # → 127.0.0.1:<auto>
vm stop name=dev
```

## Windows guests

Windows has no redistributable image, so `create os=windows iso=<path|url>` is required.
The VM comes up with VNC on `127.0.0.1:590x`; run setup there. `exec` starts working once
virtio-win guest tools (`image_pull image=virtio-win`, attached as a second CD) install
`qemu-guest-agent` inside the guest. Windows 11 additionally needs `firmware=uefi`.

## Notes

- Linux disks are qcow2 overlays on the shared base image: a new VM costs seconds and
  megabytes, not minutes and gigabytes. Deleting a base image breaks its overlays.
- The cloud-init seed is attached as a **virtio disk**, not a CD-ROM: cloud kernels
  (`*-genericcloud`, `*-cloudimg`) contain virtio drivers only and never see an ATAPI
  device, so an ISO on the AHCI bus would silently leave the guest unprovisioned.
- Acceleration: WHPX on Windows, KVM on Linux, HVF on macOS. If the accelerator refuses
  the machine, `start` retries with a plainer CPU model and finally with TCG (software —
  correct, but slow).
- Snapshots: a running machine is saved through the monitor (RAM included), a stopped one
  through `qemu-img` (disk only). WHPX cannot track dirty memory, so a live save there
  returns `bit=0` with the reason — stop the VM first, or run it with `accel=tcg`.
- The guest agent protocol has no request ids, so every session starts with
  `guest-sync-delimited` and drops whatever was queued before it; a timed-out command
  marks the channel dirty and forces a resync before the next one.
- `disposeAll` deliberately keeps machines running when an agent run is stopped; stopping
  a VM is always an explicit action.

## Install (one shot)

`Setup-VM.bat` on Windows does the whole thing and never hangs:

```
Setup-VM.bat            npm deps + QEMU 11.1.0 + Debian 12 base image
Setup-VM.bat noimage    deps + QEMU only
Setup-VM.bat run        everything, then launch the IDE
Setup-VM.bat ubuntu     use ubuntu-24.04 as the base image
```

It calls `scripts/vm-setup.cjs`, which you can also run directly:

```
node scripts/vm-setup.cjs                 QEMU 11.1.0 + debian-12
node scripts/vm-setup.cjs --no-image      QEMU only
node scripts/vm-setup.cjs --timeout=45    overall budget in minutes (default 40)
```

**QEMU is pinned to 11.1.0.** The exact installer (url, size, sha512) lives in
`install.cjs → PINNED_QEMU`; every download is sha512-verified before it is extracted, so
a truncated or tampered installer never runs. The build comes from the permanent weilnetz
archive first, its rotating index second, and only if both 404 does it scrape the index
for the newest build.

**Downloads never hang.** `images.cjs` gives every download a 45s idle watchdog (a stalled
stream is aborted, not waited on forever), resume-from-partial with a `Range` request, up
to 4 retries per source before the next mirror, and size + sha512 verification. A corrupt
file is deleted and restarted; a good one is reused without re-downloading. `vm-setup.cjs`
renders a live progress bar so the console shows movement the whole time, and enforces an
overall time budget so a dead network fails loudly instead of freezing.

## Tests

```
npm run test:vm      # ISO writer; registry/args/store; the QMP/QGA/console protocols;
                     # and download robustness (idle-abort, resume, sha512, wrong-size)
                     # — all against simulated servers, no QEMU needed
node scripts/vm-cli.cjs host_status    # same tool, from a terminal
```
