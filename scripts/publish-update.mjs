/**
 * publish-update.mjs — ship a new ComposeVC build to installed users.
 *
 * What it does
 *   1. bumps the version (patch by default)
 *   2. builds the hardened NSIS installer + latest.yml (scripts/package-dist.mjs)
 *   3. creates a GitHub Release (v<version>) and uploads the installer + latest.yml
 *   4. commits the change and pushes the tag (unless --no-git)
 *
 * Installed apps poll that release feed and update themselves in the background
 * (electron/updater.cjs → electron-updater).
 *
 * Usage
 *   npm run publish:update                 # patch bump + build + release + push
 *   npm run publish:update:minor
 *   npm run publish:update:major
 *   node scripts/publish-update.mjs --set 1.4.0
 *   node scripts/publish-update.mjs --no-git        # release only, no commit/push
 *   node scripts/publish-update.mjs --no-publish    # build only
 *   node scripts/publish-update.mjs --draft --notes "fixes …"
 *
 * Private repo auth
 *   - publishing: `gh auth login` (repo scope) or GH_TOKEN in the environment
 *   - installed app: LOPSTER_UPDATE_TOKEN=github_pat_… at build time, or a token
 *     written to %APPDATA%/composevc/updater.json as {"token":"…"}
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const valueOf = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};

const help = has("--help") || has("-h");
if (help) {
  console.log(`publish-update.mjs — build + publish a ComposeVC update

Options:
  --bump patch|minor|major   version bump (default: patch)
  --set X.Y.Z                explicit version
  --notes "text"             release notes
  --draft                    create a draft release
  --prerelease               mark the release as prerelease
  --no-build                 reuse the existing release/ artefacts
  --no-publish               build only (no GitHub release)
  --no-git                   do not commit/tag/push
  --allow-same-version       publish even if the version did not change
  --help                     this text
`);
  process.exit(0);
}

const noBuild = has("--no-build");
const noPublish = has("--no-publish");
const noGit = has("--no-git");
const draft = has("--draft");
const prerelease = has("--prerelease");
const allowSame = has("--allow-same-version");
const explicitVersion = valueOf("--set");
const bumpKind = (valueOf("--bump") || "patch").toLowerCase();
const notes = valueOf("--notes") || "";

function log(message) {
  console.log(`[publish] ${message}`);
}

function fail(message, code = 1) {
  console.error(`[publish] ERROR: ${message}`);
  process.exit(code);
}

function run(cmd, args, opts = {}) {
  log(`$ ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, {
    cwd: opts.cwd || root,
    stdio: "inherit",
    shell: opts.shell ?? false,
    env: { ...process.env, ...(opts.env || {}) },
  });
  if (result.error) fail(`${cmd}: ${result.error.message}`);
  if (result.status !== 0) fail(`${cmd} exited ${result.status}`, result.status || 1);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, data) {
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function parseVersion(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version || ""));
  if (!m) fail(`invalid version "${version}"`);
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

function nextVersion(current, kind) {
  const v = parseVersion(current);
  if (kind === "major") return `${v.major + 1}.0.0`;
  if (kind === "minor") return `${v.major}.${v.minor + 1}.0`;
  if (kind === "patch") return `${v.major}.${v.minor}.${v.patch + 1}`;
  fail(`unknown --bump value "${kind}" (patch|minor|major)`);
}

const pkgFile = path.join(root, "package.json");
const lockFile = path.join(root, "package-lock.json");
const pkg = readJson(pkgFile);
const currentVersion = String(pkg.version || "0.0.0");
const version = explicitVersion ? String(explicitVersion).trim() : nextVersion(currentVersion, bumpKind);

if (version === currentVersion && !allowSame) {
  fail(`version is still ${version} — pass --allow-same-version to republish it`);
}

log(`version ${currentVersion} → ${version}`);
pkg.version = version;
writeJson(pkgFile, pkg);

if (fs.existsSync(lockFile)) {
  try {
    const lock = readJson(lockFile);
    lock.version = version;
    if (lock.packages && lock.packages[""]) lock.packages[""].version = version;
    writeJson(lockFile, lock);
  } catch (error) {
    log(`package-lock.json update skipped: ${error.message}`);
  }
}

if (!noBuild) {
  log("building installer (package-dist.mjs)…");
  run(process.execPath, [path.join("scripts", "package-dist.mjs")]);
}

const installer = path.join(root, "release", `ComposeVC-Setup-${version}-x64.exe`);
const latestYml = path.join(root, "release", "latest.yml");
if (!fs.existsSync(installer)) fail(`installer not found: ${installer}`);
if (!fs.existsSync(latestYml)) fail(`latest.yml not found: ${latestYml}`);
const sizeMb = (fs.statSync(installer).size / (1024 * 1024)).toFixed(1);
log(`installer ready: ${path.relative(root, installer)} (${sizeMb} MB)`);

const tag = `v${version}`;
const releaseTitle = `ComposeVC ${version}`;
const releaseNotes =
  notes ||
  `ComposeVC ${version}\n\nAutomatic update: installed apps pick this release up in the background and install it on the next restart.`;

if (!noPublish) {
  log(`creating GitHub release ${tag}…`);
  const ghArgs = [
    "release",
    "create",
    tag,
    installer,
    latestYml,
    "--title",
    releaseTitle,
    "--notes",
    releaseNotes,
  ];
  if (draft) ghArgs.push("--draft");
  if (prerelease) ghArgs.push("--prerelease");
  run("gh", ghArgs, { shell: process.platform === "win32" });
}

if (!noGit) {
  log("committing + tagging + pushing…");
  run("git", ["add", "-A"]);
  const commit = spawnSync("git", ["commit", "-m", `release ${tag}`], { cwd: root, stdio: "inherit" });
  if (commit.status !== 0) log("nothing to commit (continuing)");
  run("git", ["tag", "-f", tag]);
  run("git", ["push", "origin", "HEAD"]);
  run("git", ["push", "origin", tag, "--force"]);
}

log(`
Done.
  version:   ${version}
  installer: ${path.relative(root, installer)}
  feed:      latest.yml (uploaded to the ${tag} release)

Installed clients check GitHub Releases ~15 s after launch and every 4 h,
download in the background and install on the next restart.
If the repo stays private, build with LOPSTER_UPDATE_TOKEN=… so the shipped
app can read its own release feed.
`);
