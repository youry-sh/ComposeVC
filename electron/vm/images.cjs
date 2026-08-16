const fs = require("fs");
const https = require("https");
const http = require("http");
const path = require("path");
const { URL } = require("url");
const { layout, ensureDir, readJson, writeJson } = require("./paths.cjs");

/**
 * Base images. Linux entries are cloud images: they already contain cloud-init,
 * so a seed ISO is all that is needed for a zero-touch first boot.
 * Windows has no freely redistributable image — the user supplies an ISO url or path.
 */
const CATALOG = [
  {
    id: "debian-12",
    os: "linux",
    kind: "cloud",
    label: "Debian 12 (bookworm) cloud image",
    file: "debian-12-genericcloud-amd64.qcow2",
    url: "https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2",
    mirrors: ["https://laotzu.ftp.acc.umu.se/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2"],
    approxMb: 400,
    defaultUser: "vc",
  },
  {
    id: "debian-13",
    os: "linux",
    kind: "cloud",
    label: "Debian 13 (trixie) cloud image",
    file: "debian-13-genericcloud-amd64.qcow2",
    url: "https://cloud.debian.org/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2",
    mirrors: ["https://laotzu.ftp.acc.umu.se/images/cloud/trixie/latest/debian-13-genericcloud-amd64.qcow2"],
    approxMb: 450,
    defaultUser: "vc",
  },
  {
    id: "ubuntu-24.04",
    os: "linux",
    kind: "cloud",
    label: "Ubuntu 24.04 LTS server cloud image",
    file: "ubuntu-24.04-server-cloudimg-amd64.img",
    url: "https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-amd64.img",
    approxMb: 600,
    defaultUser: "vc",
  },
  {
    id: "ubuntu-22.04",
    os: "linux",
    kind: "cloud",
    label: "Ubuntu 22.04 LTS server cloud image",
    file: "ubuntu-22.04-server-cloudimg-amd64.img",
    url: "https://cloud-images.ubuntu.com/releases/22.04/release/ubuntu-22.04-server-cloudimg-amd64.img",
    approxMb: 650,
    defaultUser: "vc",
  },
  {
    id: "almalinux-9",
    os: "linux",
    kind: "cloud",
    label: "AlmaLinux 9 GenericCloud",
    file: "AlmaLinux-9-GenericCloud-latest.x86_64.qcow2",
    url: "https://repo.almalinux.org/almalinux/9/cloud/x86_64/images/AlmaLinux-9-GenericCloud-latest.x86_64.qcow2",
    approxMb: 600,
    defaultUser: "vc",
  },
  {
    id: "rocky-9",
    os: "linux",
    kind: "cloud",
    label: "Rocky Linux 9 GenericCloud",
    file: "Rocky-9-GenericCloud-Base.latest.x86_64.qcow2",
    url: "https://dl.rockylinux.org/pub/rocky/9/images/x86_64/Rocky-9-GenericCloud-Base.latest.x86_64.qcow2",
    approxMb: 700,
    defaultUser: "vc",
  },
  {
    id: "alpine",
    os: "linux",
    kind: "cloud",
    label: "Alpine Linux (cloud-init, latest stable)",
    file: "alpine-cloudinit-x86_64.qcow2",
    // Filenames carry the point release, so the exact url is resolved from the index page.
    index: "https://dl-cdn.alpinelinux.org/alpine/latest-stable/releases/cloud/",
    indexPattern: /href="(generic_alpine-[\d.]+-x86_64-(?:bios|uefi)-cloudinit-r\d+\.qcow2)"/g,
    approxMb: 200,
    defaultUser: "vc",
  },
  {
    id: "virtio-win",
    os: "windows",
    kind: "iso",
    label: "virtio-win guest drivers + qemu-guest-agent installer (attach to Windows VMs)",
    file: "virtio-win.iso",
    url: "https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/virtio-win.iso",
    approxMb: 700,
  },
  {
    id: "windows",
    os: "windows",
    kind: "iso",
    label: "Windows installation ISO — pass url=<iso url> or iso=<local path>; Microsoft does not allow redistribution",
    file: "windows.iso",
    url: null,
    requiresUrl: true,
    approxMb: 5000,
  },
];

const jobs = new Map(); // file -> download job (per process)

function catalogEntry(id) {
  const key = String(id || "").trim().toLowerCase();
  return CATALOG.find((item) => item.id.toLowerCase() === key) || null;
}

function statePath(userDataPath) {
  return path.join(layout.images(userDataPath), ".state.json");
}

function readState(userDataPath) {
  return readJson(statePath(userDataPath), { downloads: {} });
}

function writeState(userDataPath, state) {
  writeJson(statePath(userDataPath), state);
}

function localPath(userDataPath, file) {
  return path.join(layout.images(userDataPath), file);
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function request(url, options = {}) {
  const target = new URL(url);
  const client = target.protocol === "http:" ? http : https;
  return new Promise((resolve, reject) => {
    const req = client.request(
      target,
      {
        method: options.method || "GET",
        headers: { "user-agent": "ComposeVC-VM/1.0", ...(options.headers || {}) },
        timeout: options.timeoutMs || 60_000,
      },
      resolve
    );
    req.on("timeout", () => req.destroy(new Error(`request timeout: ${url}`)));
    req.on("error", reject);
    if (options.signal) options.signal.addEventListener("abort", () => req.destroy(new Error("Stopped by user")), { once: true });
    req.end();
  });
}

async function fetchText(url, { timeoutMs = 30_000, redirects = 5 } = {}) {
  const response = await request(url, { timeoutMs });
  if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && redirects > 0) {
    response.resume();
    return fetchText(new URL(response.headers.location, url).toString(), { timeoutMs, redirects: redirects - 1 });
  }
  if (response.statusCode !== 200) {
    response.resume();
    throw new Error(`HTTP ${response.statusCode} for ${url}`);
  }
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

/** Alpine-style indexes: pick the newest matching filename from the directory listing. */
async function resolveEntryUrl(entry) {
  if (entry.url) return entry.url;
  if (!entry.index) throw new Error(`image ${entry.id} has no url — pass url=<direct link>`);
  const html = await fetchText(entry.index);
  const names = [...html.matchAll(entry.indexPattern)].map((match) => match[1]);
  if (!names.length) throw new Error(`could not resolve a download url from ${entry.index} — pass url=<direct link>`);
  names.sort();
  return new URL(names[names.length - 1], entry.index).toString();
}

/** Network errors from happy-eyeballs arrive as an AggregateError with an empty message. */
function describeError(error, url) {
  const host = (() => {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  })();
  const detail = error?.message || error?.code || (error?.errors || []).map((item) => item.code || item.message).join(", ");
  return `${host}: ${detail || "connection failed"}`;
}

/** Streamed download with resume and mirror fallback; returns a job updated in place. */
function startDownload(userDataPath, { url, mirrors = [], file, label, signal }) {
  const target = localPath(userDataPath, file);
  const partial = path.join(ensureDir(layout.downloads(userDataPath)), file);
  const candidates = [url, ...mirrors].filter(Boolean);
  const job = {
    file,
    label: label || file,
    url,
    target,
    state: "running",
    bytes: fileSize(partial),
    total: null,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    error: null,
  };
  jobs.set(file, job);

  const downloadFrom = async (source) => {
    let redirects = 0;
    let current = source;
    for (;;) {
      const offset = fileSize(partial);
      const response = await request(current, {
        headers: offset ? { range: `bytes=${offset}-` } : {},
        timeoutMs: 60_000,
        signal,
      });
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume();
        if ((redirects += 1) > 10) throw new Error("too many redirects");
        current = new URL(response.headers.location, current).toString();
        continue;
      }
      if (response.statusCode === 416) {
        response.resume();
        return; // already complete
      }
      if (response.statusCode !== 200 && response.statusCode !== 206) {
        response.resume();
        throw new Error(`HTTP ${response.statusCode} downloading ${current}`);
      }
      const append = response.statusCode === 206 && offset > 0;
      const length = Number(response.headers["content-length"] || 0);
      job.total = append ? offset + length : length || null;
      job.bytes = append ? offset : 0;
      job.url = current;
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(partial, { flags: append ? "a" : "w" });
        response.on("data", (chunk) => {
          job.bytes += chunk.length;
          job.updatedAt = Date.now();
        });
        response.on("error", reject);
        out.on("error", reject);
        out.on("finish", resolve);
        response.pipe(out);
      });
      return;
    }
  };

  job.promise = (async () => {
    const failures = [];
    for (const candidate of candidates) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await downloadFrom(candidate);
        failures.length = 0;
        break;
      } catch (err) {
        failures.push(describeError(err, candidate));
        if (candidate === candidates[candidates.length - 1]) {
          throw new Error(`download failed — ${failures.join(" | ")}`);
        }
      }
    }
    fs.renameSync(partial, target);
    job.state = "done";
    job.bytes = fileSize(target);
    job.total = job.bytes;
    job.updatedAt = Date.now();
    const state = readState(userDataPath);
    state.downloads[file] = { url, bytes: job.bytes, completedAt: Date.now() };
    writeState(userDataPath, state);
    return target;
  })().catch((err) => {
    job.state = "error";
    job.error = err instanceof Error ? err.message : String(err);
    job.updatedAt = Date.now();
    throw err;
  });

  return job;
}

function jobView(job) {
  if (!job) return null;
  const percent = job.total ? Math.min(100, Math.round((job.bytes / job.total) * 1000) / 10) : null;
  const seconds = Math.max(1, (job.updatedAt - job.startedAt) / 1000);
  return {
    file: job.file,
    state: job.state,
    downloadedMb: Math.round(job.bytes / (1024 * 1024)),
    totalMb: job.total ? Math.round(job.total / (1024 * 1024)) : null,
    percent,
    mbPerSec: Math.round((job.bytes / (1024 * 1024) / seconds) * 10) / 10,
    error: job.error,
  };
}

async function pull(userDataPath, { image, url, wait = false, signal } = {}) {
  ensureDir(layout.images(userDataPath));
  const entry = catalogEntry(image);
  const file = entry ? entry.file : path.basename(new URL(url).pathname) || `image-${Date.now()}.img`;
  const target = localPath(userDataPath, file);
  const existing = jobs.get(file);
  if (existing && existing.state === "running") {
    if (wait) await existing.promise;
    return { started: false, running: true, progress: jobView(jobs.get(file)), path: target };
  }
  if (fs.existsSync(target) && !url) {
    return { started: false, alreadyPresent: true, path: target, sizeMb: Math.round(fileSize(target) / (1024 * 1024)) };
  }
  let downloadUrl = url || null;
  if (!downloadUrl) {
    if (!entry) throw new Error(`unknown image "${image}" — pass url=<direct link> or use one of: ${CATALOG.map((i) => i.id).join(", ")}`);
    if (entry.requiresUrl) throw new Error(`image ${entry.id} requires an explicit url= (or iso=<local path>): ${entry.label}`);
    downloadUrl = await resolveEntryUrl(entry);
  }
  const job = startDownload(userDataPath, {
    url: downloadUrl,
    mirrors: url ? [] : entry?.mirrors || [],
    file,
    label: entry?.label,
    signal,
  });
  if (wait) {
    await job.promise;
    return { started: true, done: true, path: target, sizeMb: Math.round(fileSize(target) / (1024 * 1024)) };
  }
  return {
    started: true,
    done: false,
    path: target,
    url: downloadUrl,
    progress: jobView(job),
    note: "Download runs in the background — poll with action=images.",
  };
}

function listImages(userDataPath) {
  ensureDir(layout.images(userDataPath));
  const dir = layout.images(userDataPath);
  const files = fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => ({
      file: entry.name,
      sizeMb: Math.round(fileSize(path.join(dir, entry.name)) / (1024 * 1024)),
      path: path.join(dir, entry.name),
    }));
  const byFile = new Map(files.map((item) => [item.file, item]));
  return {
    dir,
    catalog: CATALOG.map((entry) => ({
      id: entry.id,
      os: entry.os,
      kind: entry.kind,
      label: entry.label,
      approxMb: entry.approxMb,
      downloaded: byFile.has(entry.file),
      sizeMb: byFile.get(entry.file)?.sizeMb ?? null,
      requiresUrl: Boolean(entry.requiresUrl),
    })),
    local: files,
    downloads: [...jobs.values()].map(jobView),
  };
}

/** Accept a catalog id, an absolute path, or a url; return a local file path. */
async function resolveBaseImage(userDataPath, spec, { autoPull = true, wait = true, signal } = {}) {
  const raw = String(spec || "").trim();
  if (!raw) throw new Error("image is required (catalog id, local path, or url)");
  if (/^https?:\/\//i.test(raw)) {
    const result = await pull(userDataPath, { url: raw, wait, signal });
    return result.path;
  }
  if (path.isAbsolute(raw)) {
    if (!fs.existsSync(raw)) throw new Error(`image file not found: ${raw}`);
    return raw;
  }
  const entry = catalogEntry(raw);
  if (!entry) {
    const direct = localPath(userDataPath, raw);
    if (fs.existsSync(direct)) return direct;
    throw new Error(`unknown image "${raw}". Catalog: ${CATALOG.map((item) => item.id).join(", ")}. Or pass an absolute path / url.`);
  }
  const target = localPath(userDataPath, entry.file);
  if (fs.existsSync(target)) return target;
  if (!autoPull) throw new Error(`image ${entry.id} is not downloaded yet — run action=image_pull image=${entry.id}`);
  const result = await pull(userDataPath, { image: entry.id, wait, signal });
  if (!wait && !result.done) {
    throw new Error(
      `image ${entry.id} is downloading in the background (${jobView(jobs.get(entry.file))?.percent ?? 0}%) — retry create once action=images shows it done`
    );
  }
  return target;
}

function deleteImage(userDataPath, file) {
  const entry = catalogEntry(file);
  const name = entry ? entry.file : path.basename(String(file || ""));
  const target = localPath(userDataPath, name);
  if (!fs.existsSync(target)) return { deleted: false, path: target };
  fs.rmSync(target, { force: true });
  const state = readState(userDataPath);
  delete state.downloads[name];
  writeState(userDataPath, state);
  return { deleted: true, path: target };
}

module.exports = { CATALOG, catalogEntry, pull, listImages, resolveBaseImage, deleteImage, jobView, jobs, localPath };
