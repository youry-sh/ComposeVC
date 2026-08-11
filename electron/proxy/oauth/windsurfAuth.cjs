const crypto = require("crypto");

const AUTH_BASE_URL = "https://www.windsurf.com";
const REGISTER_API_BASE_URL = "https://register.windsurf.com";
const DEFAULT_API_SERVER_URL = "https://server.codeium.com";
const CLIENT_ID = "3GUryQ7ldAeKEuD2obYnppsnmj58eP5u";
const FIREBASE_API_KEY = "AIzaSyDsOl-1XpT5err0Tcnx8FFod1H8gVGIycY";
const FIREBASE_SIGN_IN_URL = "https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword";
const USER_AGENT = "antigravity-cockpit-tools";

function token() { return crypto.randomBytes(24).toString("base64url"); }
function buildAuthUrl(redirectUri, state) {
  const p = new URLSearchParams({ response_type: "token", client_id: CLIENT_ID, redirect_uri: redirectUri, state, prompt: "login", redirect_parameters_type: "query", workflow: "onboarding" });
  return `${AUTH_BASE_URL}/windsurf/signin?${p}`;
}
async function responseData(response) {
  const text = await response.text().catch(() => "");
  let data; try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!response.ok) throw new Error(`Windsurf request failed (${response.status}): ${text.slice(0, 300)}`);
  return data;
}
async function postSeat(baseUrl, method, body) {
  const response = await fetch(`${String(baseUrl).replace(/\/$/, "")}/exa.seat_management_pb.SeatManagementService/${method}`, { method: "POST", headers: { "User-Agent": USER_AGENT, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
  return responseData(response);
}
async function registerUser(firebaseIdToken) {
  const data = await postSeat(REGISTER_API_BASE_URL, "RegisterUser", { firebase_id_token: firebaseIdToken });
  return { apiKey: data.apiKey || data.api_key, apiServerUrl: data.apiServerUrl || data.api_server_url || DEFAULT_API_SERVER_URL, name: data.name || null };
}
async function getOneTimeAuthToken(apiServerUrl, firebaseIdToken) {
  const data = await postSeat(apiServerUrl, "GetOneTimeAuthToken", { firebaseIdToken });
  return data.authToken || data.auth_token || null;
}
async function getUserStatus(apiServerUrl, apiKey) {
  return postSeat(apiServerUrl, "GetUserStatus", { metadata: { apiKey, ideName: "Windsurf", ideVersion: "1.0.0", extensionName: "codeium.windsurf", extensionVersion: "1.0.0", locale: "en-US", os: process.platform === "darwin" ? "darwin" : process.platform, disableTelemetry: false, sessionId: `composevc-${Date.now()}`, requestId: String(Date.now()) } });
}
async function signInWithPassword(email, password) {
  const response = await fetch(`${FIREBASE_SIGN_IN_URL}?key=${FIREBASE_API_KEY}`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json", "X-Client-Version": "Chrome/JsCore/11.0.0/FirebaseCore-web", Referer: "https://windsurf.com/" }, body: JSON.stringify({ email, password, returnSecureToken: true, clientType: "CLIENT_TYPE_WEB" }), signal: AbortSignal.timeout(20000) });
  const data = await responseData(response);
  if (!data.idToken) throw new Error("Firebase response missing idToken");
  return data.idToken;
}
function pickUser(data) {
  const root = data && typeof data === "object" ? data : {};
  const user = root.user || root.userStatus || root;
  return { email: user.email || root.email || null, name: user.name || root.name || null, username: user.username || root.username || null, id: user.id || root.id || null };
}
async function buildPayloadFromFirebaseToken(firebaseIdToken, extra = {}) {
  const registration = await registerUser(firebaseIdToken);
  const authToken = await getOneTimeAuthToken(registration.apiServerUrl, firebaseIdToken).catch(() => null);
  const userStatus = await getUserStatus(registration.apiServerUrl, registration.apiKey).catch(() => null);
  const user = pickUser(userStatus);
  const email = user.email || extra.email || null;
  const name = user.name || registration.name || extra.name || null;
  return toAccountPayload({ accessToken: firebaseIdToken, tokenType: "Bearer", apiKey: registration.apiKey, apiServerUrl: registration.apiServerUrl, authToken, email, name, userStatus }, { source: "windsurf_firebase_oauth", authStatusRaw: { apiKey: registration.apiKey, apiServerUrl: registration.apiServerUrl, email, name } });
}
function toAccountPayload(data, extra = {}) {
  const email = data.email || extra.email || "windsurf";
  const accessToken = data.accessToken || data.access_token;
  if (!accessToken) throw new Error("Windsurf access token missing");
  return { providerId: "windsurf", authType: "oauth", name: data.name || extra.name || email, email, planType: data.planType || "unknown", accessToken, refreshToken: data.refreshToken || null, idToken: data.idToken || null, expiresAt: Date.now() + (Number(data.expiresIn) || 3600) * 1000, apiKey: data.apiKey || "", baseUrl: data.apiServerUrl || DEFAULT_API_SERVER_URL, defaultModel: "swe-1", enabled: true, usage: data.userStatus || null, usageError: null, usageUpdatedAt: null, createdAt: Date.now(), providerMeta: { source: extra.source || "windsurf_oauth", apiKey: data.apiKey || null, apiServerUrl: data.apiServerUrl || DEFAULT_API_SERVER_URL, authToken: data.authToken || null, authStatusRaw: extra.authStatusRaw || null, userStatus: data.userStatus || null } };
}
async function buildPayloadFromToken(value) {
  const trimmed = String(value || "").trim();
  if (!trimmed) throw new Error("Token required");
  if (trimmed.startsWith("sk-ws-")) return toAccountPayload({ accessToken: trimmed, apiKey: trimmed }, { source: "windsurf_api_key" });
  if (trimmed.startsWith("eyJ")) return buildPayloadFromFirebaseToken(trimmed);
  throw new Error("Unsupported Windsurf token format");
}
async function buildPayloadFromPassword(email, password) { return buildPayloadFromFirebaseToken(await signInWithPassword(email, password), { email }); }
async function refreshPayloadForAccount(account) { return buildPayloadFromToken(account.apiKey || account.accessToken); }
module.exports = { AUTH_BASE_URL, REGISTER_API_BASE_URL, DEFAULT_API_SERVER_URL, CLIENT_ID, token, buildAuthUrl, registerUser, getOneTimeAuthToken, getUserStatus, signInWithPassword, buildPayloadFromFirebaseToken, buildPayloadFromToken, buildPayloadFromPassword, refreshPayloadForAccount, toAccountPayload };
