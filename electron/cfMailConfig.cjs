/**
 * cfMailConfig — CF Worker temp-mail credentials store (single source of truth).
 *
 * Reads/writes the SAME file the cf_mail tool and the Runtime companion use:
 *   <app>/runtime-app/data/config.json
 *
 * Fields:
 *   cfworker_api_url       — CF Worker HTTP(S) endpoint (e.g. https://…workers.dev)
 *   cfworker_admin_token   — admin token sent as `x-admin-auth`
 *   cfworker_domain        — default mailbox domain used by create
 *   cfworker_fingerprint   — optional `x-fingerprint` header value
 *   enable_prefix          — default enablePrefix for new addresses
 *
 * Writes are atomic (tmp + rename) so a crash never leaves a half-written JSON.
 */

const fs = require("fs");
const path = require("path");

const CONFIG_REL = path.join("runtime-app", "data", "config.json");

/** Absolute path of the shared config file (<app>/runtime-app/data/config.json). */
function configPath() {
  return path.join(__dirname, "..", CONFIG_REL);
}

function defaultConfig() {
  return {
    cfworker_api_url: "",
    cfworker_admin_token: "",
    cfworker_domain: "",
    cfworker_fingerprint: "",
    enable_prefix: true,
  };
}

function normalizeConfig(data = {}) {
  return {
    ...defaultConfig(),
    ...data,
    cfworker_api_url: String(data?.cfworker_api_url || "").trim(),
    cfworker_admin_token: String(data?.cfworker_admin_token || "").trim(),
    cfworker_domain: String(data?.cfworker_domain || "").trim(),
    cfworker_fingerprint: String(data?.cfworker_fingerprint || "").trim(),
    enable_prefix: data?.enable_prefix !== false,
  };
}

/** Read the shared config; never throws — returns defaults when absent/corrupt. */
async function readConfig() {
  try {
    const raw = await fs.promises.readFile(configPath(), "utf8");
    return normalizeConfig(JSON.parse(raw));
  } catch {
    return defaultConfig();
  }
}

/**
 * Merge a patch into the shared config and persist it atomically.
 * `null`/`undefined` fields keep their current value (partial saves are safe).
 */
async function writeConfig(patch = {}) {
  const current = await readConfig();
  const next = normalizeConfig({
    cfworker_api_url: patch.cfworker_api_url ?? current.cfworker_api_url,
    cfworker_admin_token: patch.cfworker_admin_token ?? current.cfworker_admin_token,
    cfworker_domain: patch.cfworker_domain ?? current.cfworker_domain,
    cfworker_fingerprint: patch.cfworker_fingerprint ?? current.cfworker_fingerprint,
    enable_prefix: patch.enable_prefix ?? current.enable_prefix,
  });
  const file = configPath();
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fs.promises.writeFile(tmp, JSON.stringify(next, null, 2), "utf8");
  await fs.promises.rename(tmp, file);
  return next;
}

/**
 * Lightweight connectivity probe: GET /admin/mails?limit=1 with the admin token.
 * Returns a structured result so the Settings UI can show a precise reason.
 */
async function testConfig(cfg, timeoutMs = 8000) {
  const base = String(cfg?.cfworker_api_url || "").replace(/\/+$/, "");
  const token = String(cfg?.cfworker_admin_token || "");
  if (!base || !token) {
    return { ok: false, configured: false, reason: "missing_credentials" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/admin/mails?limit=1`, {
      method: "GET",
      headers: {
        accept: "application/json",
        "x-admin-auth": token,
      },
      signal: controller.signal,
    });
    if (res.status < 400) {
      return { ok: true, configured: true, status: res.status };
    }
    return {
      ok: false,
      configured: true,
      status: res.status,
      reason: res.status === 401 || res.status === 403 ? "bad_token" : "http_error",
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      return { ok: false, configured: true, reason: "timeout" };
    }
    return { ok: false, configured: true, reason: "unreachable" };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  configPath,
  defaultConfig,
  normalizeConfig,
  readConfig,
  writeConfig,
  testConfig,
};
