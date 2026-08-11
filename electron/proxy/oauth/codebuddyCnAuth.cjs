const auth = require("./codebuddyAuth.cjs");
const API_ENDPOINT = "https://www.codebuddy.cn";
const API_PREFIX = "/v2/plugin";
const STATE_ENDPOINT = `${API_ENDPOINT}${API_PREFIX}/auth/state`;
const TOKEN_ENDPOINT = `${API_ENDPOINT}${API_PREFIX}/auth/token`;
const REFRESH_ENDPOINT = `${API_ENDPOINT}${API_PREFIX}/auth/token/refresh`;
const ACCOUNT_ENDPOINT = `${API_ENDPOINT}${API_PREFIX}/login/account`;
function withCn(value) { return { ...value, providerId: "codebuddy-cn", baseUrl: API_ENDPOINT, source: "codebuddy_cn_oauth" }; }
async function startDeviceAuth(options = {}) { const result = await auth.startDeviceAuth({ ...options, platform: options.platform || "ide" }); return { ...result, providerId: "codebuddy-cn" }; }
async function pollDeviceAuth(state, options = {}) { return auth.pollDeviceAuth(state, options); }
async function refreshAccessToken(accessToken, refreshToken, options = {}) { return auth.refreshAccessToken(accessToken, refreshToken, options); }
async function fetchAccountInfo(accessToken, state, domain) { return auth.fetchAccountInfo(accessToken, state, domain); }
async function buildAccountPayload(tokens, extra = {}) { return auth.buildAccountPayload(tokens, withCn(extra)); }
async function buildPayloadFromToken(value, extra = {}) { return auth.buildPayloadFromToken(value, withCn(extra)); }
async function refreshPayloadForAccount(account) { return auth.refreshPayloadForAccount({ ...account, providerId: "codebuddy-cn" }); }
async function startLogin(options = {}) { return startDeviceAuth(options); }
async function completeLogin(state, options = {}) { const tokens = await pollDeviceAuth(state, options); return buildAccountPayload(tokens, { ...options, state, source: options.source || "codebuddy_cn_oauth" }); }
function cancelLogin() { return true; }
module.exports = { ...auth, API_ENDPOINT, API_PREFIX, STATE_ENDPOINT, TOKEN_ENDPOINT, REFRESH_ENDPOINT, ACCOUNT_ENDPOINT, startDeviceAuth, pollDeviceAuth, startLogin, completeLogin, cancelLogin, refreshAccessToken, fetchAccountInfo, buildAccountPayload, buildPayloadFromToken, refreshPayloadForAccount };
