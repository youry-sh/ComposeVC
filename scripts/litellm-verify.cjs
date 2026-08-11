#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, '..', 'docs', 'litellm-hunt', 'verify.json');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/126.0 Safari/537.36';
const REQ_TIMEOUT = 20000;
const SMOKE_TOKENS = 48;

// NEW models first — old ones (gpt-4, claude-3-*, gemini-2.0) nobody runs anymore.
// Each entry: display name + candidate ids to try (matched against /v1/models and also
// sent directly even if absent from the list — some proxies accept model_name not in /v1/models).
const NEW_MODELS = [
  { name: 'GPT-5.5 Instant', ids: ['gpt-5.5-instant', 'gpt-5.5-i', 'gpt-5.5i', 'chatgpt-5.5-instant', 'openai/gpt-5.5-instant'] },
  { name: 'GPT-5.6 Terra', ids: ['gpt-5.6-terra', 'gpt-5.6-t', 'gpt-5.6terra', 'openai/gpt-5.6-terra'] },
  { name: 'GPT-5.6 Luna', ids: ['gpt-5.6-luna', 'gpt-5.6-l', 'gpt-5.6luna', 'openai/gpt-5.6-luna'] },
  { name: 'Claude Sonnet 5', ids: ['claude-sonnet-5', 'claude-5-sonnet', 'sonnet-5', 'claude-sonnet-5-2026', 'anthropic/claude-sonnet-5'] },
  { name: 'Claude Opus 5', ids: ['claude-opus-5', 'claude-5-opus', 'opus-5', 'anthropic/claude-opus-5'] },
  { name: 'Claude Opus 4.8', ids: ['claude-opus-4-8', 'claude-opus-4.8', 'opus-4-8', 'anthropic/claude-opus-4-8'] },
  { name: 'Gemini 2.5 Flash', ids: ['gemini-2.5-flash', 'google/gemini-2.5-flash', 'gemini/gemini-2.5-flash'] },
  { name: 'Gemini 2.5 Pro', ids: ['gemini-2.5-pro', 'google/gemini-2.5-pro', 'gemini/gemini-2.5-pro'] },
  { name: 'Gemini 2.5 Flash Lite', ids: ['gemini-2.5-flash-lite', 'google/gemini-2.5-flash-lite'] },
  { name: 'Gemini 3 Flash', ids: ['gemini-3-flash', 'google/gemini-3-flash', 'gemini/gemini-3-flash'] },
  { name: 'Gemini 3.1 Flash', ids: ['gemini-3.1-flash', 'google/gemini-3.1-flash', 'gemini-3.1-flash-001'] },
  { name: 'Gemini 3.6 Flash', ids: ['gemini-3.6-flash', 'google/gemini-3.6-flash', 'gemini-3.6-flash-001'] },
  { name: 'Grok 4', ids: ['grok-4', 'grok-4-fast', 'xai/grok-4'] },
  { name: 'Grok 4 Heavy', ids: ['grok-4-heavy', 'grok-4.5-heavy', 'xai/grok-4-heavy'] },
  { name: 'Grok 4.5', ids: ['grok-4.5', 'grok-4.5-fast', 'xai/grok-4.5'] },
  { name: 'GLM-5.1-Air', ids: ['glm-5.1-air', 'glm-5.1', 'glm-4.7-air', 'zhipu/glm-5.1-air'] },
  { name: 'GLM-5.2', ids: ['glm-5.2', 'glm-5.2-fp8', 'zhipu/glm-5.2'] },
  { name: 'GLM-5.2-Air', ids: ['glm-5.2-air', 'glm-5.2-fp8-air', 'zhipu/glm-5.2-air'] },
  { name: 'DeepSeek-V4-Flash', ids: ['deepseek-v4-flash', 'deepseek/v4-flash', 'deepseek-chat-v4', 'deepseek/deepseek-v4-flash'] },
  { name: 'DeepSeek-V4-Pro', ids: ['deepseek-v4-pro', 'deepseek/v4-pro', 'deepseek-reasoner-v4', 'deepseek/deepseek-v4-pro'] },
];

// Old model id substrings to deprioritize — smoke them only after all NEW_MODELS tried.
const OLD_ID_HINTS = ['gpt-4', 'gpt-3.5', 'claude-3-', 'claude-3.', 'claude-haiku', 'gemini-2.0', 'gemini-1.', 'glm-4.', 'deepseek-v3', 'deepseek-chat', 'deepseek-coder', 'llama-3', 'llama-2', 'mistral-7b', 'mistral-large', 'command-r', 'command-nightly', 'qwen2.5', 'qwen2-', 'davinci', 'curie', 'babbage', 'ada-'];

function matchNewModel(availableIds) {
  // returns ordered list of { display, id } — pick first available candidate for each new model
  const hit = [];
  const availLower = availableIds.map(id => String(id).toLowerCase());
  for (const nm of NEW_MODELS) {
    let best = null;
    for (const cand of nm.ids) {
      const cl = cand.toLowerCase();
      if (availLower.includes(cl)) { best = cand; break; }
      const partial = availLower.find(a => a.includes(cl) || cl.includes(a.replace(/^[a-z0-9-]+\//, '')));
      if (partial && !best) best = partial;
    }
    if (best) hit.push({ display: nm.name, id: best });
  }
  return hit;
}

const TARGETS = [
  { host: '51.84.218.27', port: 3000, key: 'sk-1234', note: 'IL 14 моделей' },
  { host: '34.204.120.143', port: 80, key: 'sk-1234', note: 'AWS Bedrock Claude' },
  { host: '52.54.130.116', port: 80, key: 'sk-1234', note: 'AWS Bedrock Claude' },
  { host: '20.115.208.7', port: 4000, key: null, note: 'Azure OpenAI open' },
  { host: '133.186.146.224', port: 8081, key: null, note: 'NHN GLM open' },
  { host: '119.45.115.224', port: 4000, key: 'sk-1234', note: 'CN Tencent gpt-5.5' },
  { host: '213.171.186.119', port: 8000, key: null, note: 'IT chat open' },
  { host: '213.171.186.119', port: 4000, key: 'sk-1234', note: 'IT chat' },
];

async function req(host, port, method, urlPath, auth, body) {
  const scheme = [443, 2443, 4433, 8443, 9443, 9840].includes(port) ? 'https' : 'http';
  const h = host.includes(':') ? `[${host}]` : host;
  const headers = { 'user-agent': UA, accept: '*/*' };
  if (auth) headers.authorization = 'Bearer ' + auth;
  if (body) headers['content-type'] = 'application/json';
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), REQ_TIMEOUT);
  try {
    const r = await fetch(`${scheme}://${h}:${port}${urlPath}`, {
      method, headers, body: body ? JSON.stringify(body) : undefined, signal: c.signal,
    });
    const text = await r.text();
    return { status: r.status, body: text.slice(0, 4000) };
  } catch (e) {
    return { status: 0, body: String(e.name || e) };
  } finally {
    clearTimeout(t);
  }
}

function modelList(body) {
  try {
    const j = JSON.parse(body);
    const arr = Array.isArray(j.data) ? j.data : [];
    return arr.map(m => (typeof m === 'string' ? m : m.id)).filter(Boolean);
  } catch {
    return [];
  }
}

function chatReply(body) {
  try {
    const j = JSON.parse(body);
    if (j.choices && j.choices[0] && j.choices[0].message) {
      const c = j.choices[0].message.content;
      return { ok: true, reply: (Array.isArray(c) ? c.map(x => x.text || '').join('') : c || '').slice(0, 80), model: j.model || '' };
    }
    return { ok: false, error: (j.error && (j.error.message || JSON.stringify(j.error)) || body).slice(0, 140) };
  } catch {
    return { ok: false, error: body.slice(0, 140) };
  }
}

async function checkTarget(t) {
  const rec = { host: t.host, port: t.port, key: t.key, note: t.note, models: [] };
  const list = await req(t.host, t.port, 'GET', '/v1/models', t.key);
  const ids = modelList(list.body);
  rec.modelsListStatus = list.status;
  const smoke = async (id, display) => {
    const r = await req(t.host, t.port, 'POST', '/v1/chat/completions', t.key, {
      model: id,
      messages: [{ role: 'user', content: 'reply with the single word: ok' }],
      max_tokens: SMOKE_TOKENS,
    });
    const rr = chatReply(r.body);
    return { id, display: display || null, status: r.status, ok: rr.ok, reply: rr.reply, error: rr.error };
  };

  // 1) NEW models first (matched against live list OR sent directly even if absent)
  const newHits = matchNewModel(ids);
  const newDirect = NEW_MODELS.filter(nm => !newHits.some(h => h.display === nm.name));
  const order = [];
  for (const h of newHits) order.push({ id: h.id, display: h.display });
  for (const nm of newDirect) order.push({ id: nm.ids[0], display: nm.name });
  // 2) remaining live ids, old ones deprioritized
  const remaining = ids.filter(id => !order.some(o => o.id === id));
  const isOld = id => OLD_ID_HINTS.some(hint => String(id).toLowerCase().includes(hint));
  const liveNew = remaining.filter(id => !isOld(id));
  const liveOld = remaining.filter(id => isOld(id));
  for (const id of [...liveNew, ...liveOld].slice(0, 10)) order.push({ id, display: null });

  for (const o of order.slice(0, 20)) {
    const r = await smoke(o.id, o.display);
    rec.models.push(r);
  }
  return rec;
}

async function main() {
  const out = [];
  for (const t of TARGETS) {
    const rec = await checkTarget(t);
    out.push(rec);
    const ok = rec.models.filter(m => m.ok).map(m => m.id);
    const bad = rec.models.filter(m => !m.ok && m.status).map(m => `${m.id}(${m.status})`);
    process.stderr.write(`${t.host}:${t.port} OK=[${ok.join(', ') || '-'}] BAD=[${bad.join(', ') || '-'}]\n`);
  }
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log('saved ' + OUT);
}

main().catch(e => { console.error(e); process.exit(1); });
