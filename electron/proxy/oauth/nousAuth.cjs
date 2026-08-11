const creds = require("./nousCreds.cjs");

async function refreshAccessToken(refreshToken) {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: creds.CLIENT_ID,
    refresh_token: refreshToken,
  });
  const res = await fetch(creds.TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error("nous refresh failed " + res.status + " " + (await res.text()).slice(0, 200));
  const j = await res.json();
  if (!j.access_token) throw new Error("nous refresh: no access_token");
  return { access_token: j.access_token, expires_in: j.expires_in || 3600 };
}

async function enrichWithBackend(accessToken) {
  try {
    const r = await fetch("https://inference-api.nousresearch.com/v1/models", {
      headers: { Authorization: "Bearer " + accessToken },
      signal: AbortSignal.timeout(8000),
    });
    if (r.ok) return { ok: true };
  } catch {}
  return { ok: false };
}

module.exports = { refreshAccessToken, enrichWithBackend };
