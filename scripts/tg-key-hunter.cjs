const fs = require("fs");
const path = require("path");
const { TelegramClient, sessions, Api } = require("teleproto");

const TDATA = process.argv[2] || "C:\\Users\\youry\\AppData\\Roaming\\lopster-ide-copy-lopster1-4-copy\\tdata";
const PHONE = process.argv[3] || "380992585188";
const OUT = process.argv[4] || path.join(__dirname, "..", "docs", "tg-leaked-keys");

const QUERIES = [
  /* ================= WAVE 1: ключевые токены / мета (EN) ================= */
  "sk-", "sk-ant-", "sk-or-", "sk-proj-", "sk-svcacct-",
  "api key leak", "api key leaks", "leaked api key", "leaked api keys",
  "api keys leaked", "leaked keys", "key leak", "keys leak",
  "openai api key", "openai key", "chatgpt api key", "chatgpt key",
  "claude api key", "anthropic key", "grok api key", "grok key",
  "deepseek api key", "deepseek key", "gemini api key", "gemini key",
  "api key dump", "key dumps", "keys dump", "api key dumps",
  "api key checker", "key checker", "checker keys", "api checker",
  "sk leak", "sk keys", "sk key", "api keys free", "free api keys",
  "api key share", "shared api key", "api key channel", "keys channel",
  "openai keys", "claude keys", "grok keys", "deepseek keys", "gemini keys",
  "api keys", "apikey", "api key", "keys", "token leak", "leaked tokens",
  /* ================= WAVE 2: RU ================= */
  "ключи api", "апи ключи", "ключи апи", "api ключ", "апи ключ",
  "слив ключей", "слитые ключи", "слив api", "слитые api",
  "ключи openai", "ключи chatgpt", "ключи claude", "ключи gpt",
  "ключи grok", "ключи deepseek", "ключи gemini",
  "бесплатные ключи", "халявные ключи", "халява ключи", "ключи бесплатно",
  "чекер ключей", "чекер api", "апи чекер", "проверка ключей",
  "ключ api", "api key бесплатно", "ключ бесплатно", "токен api",
  "ключи ск", "ск ключи", "sk ключи", "ключи sk-", "ск-",
  "слитый ключ", "сломанный api", "апи слив", "абуз ключей",
  /* ================= WAVE 3: CN 卡密/密钥/发卡 жаргон ================= */
  "密钥", "密钥出售", "密钥批发", "密钥购买", "API密钥",
  "卡密", "卡密购买", "卡密批发", "卡密出售", "卡密群",
  "API卡密", "key卡密", "卡密key", "密钥群", "密钥频道",
  "key出售", "key批发", "key购买", "key群", "key渠道",
  "api key免费", "免费key", "key免费", "免费密钥", "密钥免费",
  "key共享", "密钥共享", "key中转", "密钥中转", "key代理",
  "sk-密钥", "sk密钥", "sk key", "openai密钥", "chatgpt密钥",
  "claude密钥", "grok密钥", "deepseek密钥", "gemini密钥",
  "API key", "api key", "apikey", "key leak", "泄露密钥",
  "密钥泄露", "key泄露", "key泄漏", "密钥泄漏", "免费API key",
  "GPT密钥", "GPT key", "Plus卡密", "Team卡密", "兑换码密钥",
  /* ================= WAVE 4: JP/KR ================= */
  "APIキー", "APIキー 無料", "無料APIキー", "APIキー 配布", "キー配布",
  "APIキー 共有", "APIキー 流出", "流出キー", "キー リーク",
  "OpenAI キー", "Claude キー", "Grok キー", "DeepSeek キー", "Gemini キー",
  "API 키", "무료 API 키", "API 키 무료", "API 키 공유", "키 공유",
  "API 키 유출", "유출 키", "키 리크", "OpenAI 키", "Claude 키",
  "Grok 키", "DeepSeek 키", "Gemini 키",
  /* ================= WAVE 5: ES/PT/DE/FR/IT ================= */
  "clave api", "claves api", "clave api gratis", "api key gratis", "claves gratis",
  "clave openai", "clave chatgpt", "clave claude", "clave grok",
  "chave api", "chaves api", "chave api grátis", "api key grátis", "chaves grátis",
  "chave openai", "chave chatgpt", "chave claude",
  "api schlüssel", "api schlüssel kostenlos", "kostenlose api schlüssel", "schlüssel",
  "openai schlüssel", "chatgpt schlüssel", "claude schlüssel",
  "clé api", "clés api", "clé api gratuite", "clés api gratuites",
  "clé openai", "clé chatgpt", "clé claude",
  "chiave api", "chiavi api", "chiave api gratis", "chiavi gratis",
  "chiave openai", "chiave chatgpt",
  /* ================= WAVE 6: другие языки (ID/VI/TR/AR-попытка/HI-попытка) ================= */
  "api key gratis", "kunci api", "kunci api gratis", "key gratis",
  "kunci openai", "kunci chatgpt",
  "khóa api", "key api", "key miễn phí", "khóa api miễn phí",
  "api anahtarı", "ücretsiz api anahtarı", "anahtar", "api key ücretsiz",
  "openai anahtarı", "chatgpt anahtarı",
  "مفتاح API", "مفاتيح API", "API مجاني", "مفتاح API مجاني",
  "API कुंजी", "API कुंजी मुफ्त", "मुफ्त कुंजी", "फ्री की",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chatType(c) {
  if (c.broadcast === true || c.className === "Channel") return "channel";
  if (c.megagroup === true || c.className === "Chat") return "group";
  return "chat";
}

function chatKey(c) {
  const raw = c.id?.value !== undefined ? String(c.id.value) : String(c.id ?? "");
  if (/^\d{6,}$/.test(raw)) return `-100${raw}`;
  if (/^-\d{6,}$/.test(raw) && !raw.startsWith("-100")) return `-100${raw.slice(1)}`;
  return raw;
}

async function main() {
  const cfg = JSON.parse(fs.readFileSync(path.join(TDATA, "config.json"), "utf8"));
  const sessionStr = fs.readFileSync(path.join(TDATA, `${PHONE}.session`), "utf8").trim();
  const client = new TelegramClient(
    new sessions.StringSession(sessionStr),
    Number(cfg.apiId),
    cfg.apiHash,
    { connectionRetries: Infinity, deviceModel: "ComposeVC Desktop", systemVersion: "Windows 11", appVersion: "1.0.0" }
  );
  await client.connect();
  const me = await client.getMe();
  console.log(`[keyhunter] connected as @${me.username || me.firstName || ""} (${PHONE})`);

  const channels = new Map();
  const samples = new Map();
  const PAGINATE_MAX = 3;
  let floodHits = 0;

  for (const q of QUERIES) {
    let offsetRate = 0;
    let offsetPeer = new Api.InputPeerEmpty();
    let offsetId = 0;
    let page = 0;
    let totalMsgs = 0;
    const seenMsgIds = new Set();
    try {
      while (page < PAGINATE_MAX) {
        const res = await client.invoke(new Api.messages.SearchGlobal({
          q,
          filter: new Api.InputMessagesFilterEmpty(),
          offsetRate,
          offsetPeer,
          offsetId,
          limit: 100,
        }));
        const chats = Array.isArray(res?.chats) ? res.chats : [];
        const msgs = Array.isArray(res?.messages) ? res.messages : [];
        for (const c of chats) {
          const key = chatKey(c);
          if (!key || channels.has(key)) continue;
          channels.set(key, {
            id: key,
            title: c.title || "",
            username: c.username || "",
            type: chatType(c),
            megagroup: Boolean(c.megagroup),
            participants: c.participantsCount ?? c.participants_count ?? null,
            foundIn: [q],
          });
        }
        for (const c of chats) {
          const key = chatKey(c);
          const info = channels.get(key);
          if (info && !info.foundIn.includes(q)) info.foundIn.push(q);
        }
        const freshMsgs = msgs.filter((m) => !seenMsgIds.has(m.id));
        msgs.forEach((m) => seenMsgIds.add(m.id));
        totalMsgs += freshMsgs.length;
        if (page === 0 && freshMsgs.length) {
          const texts = freshMsgs.slice(0, 8).map((m) => {
            const peer = m?.peerId;
            const pid = peer?.channelId?.value ?? peer?.chatId?.value ?? peer?.userId?.value ?? null;
            const label = pid != null && channels.has(String(pid)) ? channels.get(String(pid)).title : "";
            return { chat: label, id: m.id, date: m.date ? new Date(Number(m.date) * 1000).toISOString() : "", text: (m.message || "").slice(0, 220) };
          });
          samples.set(q, texts);
        }
        page++;
        const canPaginate = msgs.length >= 100 && res?.nextRate !== undefined && res?.nextRate !== null;
        if (!canPaginate || page >= PAGINATE_MAX) break;
        offsetRate = res.nextRate;
        offsetId = Number(res.nextOffsetId) || 0;
        offsetPeer = res.nextOffsetPeer || new Api.InputPeerEmpty();
        await sleep(300);
      }
      console.log(`[keyhunter] "${q}" -> pages=${page} msgs=${totalMsgs} uniqueTotal=${channels.size}`);
      if (floodHits > 0 && floodHits % 3 === 0) await sleep(2000);
      await sleep(350);
    } catch (e) {
      const msg = String(e?.message || e);
      const flood = msg.match(/FLOOD_WAIT_(\d+)/);
      if (flood) {
        floodHits++;
        const wait = Math.min(Number(flood[1]) + 1, 30);
        console.log(`[keyhunter] flood on "${q}" -> wait ${wait}s`);
        await sleep(wait * 1000);
      } else {
        console.log(`[keyhunter] error on "${q}": ${msg.slice(0, 160)}`);
      }
    }
  }

  const JUNK_TITLES = /^(a user|user|deleted|channel|group)$/i;
  const entities = [...channels.values()].filter((c) => c.title && !JUNK_TITLES.test(c.title));
  console.log(`[keyhunter] enriching ${entities.length} entities...`);
  let enriched = 0;
  for (const info of entities) {
    try {
      const input = await client.getInputEntity(info.id);
      if (!input) continue;
      let full = null;
      if (input.className === "InputPeerChannel") {
        full = await client.invoke(new Api.channels.GetFullChannel({ channel: input }));
      }
      if (full?.fullChat) {
        const fc = full.fullChat;
        if (info.participants == null) info.participants = fc.participantsCount ?? fc.participants_count ?? null;
        if (!info.about) info.about = fc.about || "";
        const linked = fc.linkedChatId?.value ?? fc.linked_chat_id?.value ?? fc.linkedChatId ?? fc.linked_chat_id;
        if (linked) info.linkedId = String(linked);
      }
      if (Array.isArray(full?.chats)) {
        const self = full.chats.find((c) => String(c.id?.value ?? c.id) === String(info.id).replace(/^-100/, ""));
        if (self) {
          if (!info.username && self.username) info.username = self.username;
          const t = chatType(self);
          if (t !== "chat") info.type = t;
          if (info.participants == null) info.participants = self.participantsCount ?? self.participants_count ?? null;
        }
      }
      enriched++;
    } catch {
      /* private / no access — keep base info */
    }
    await sleep(250);
  }
  console.log(`[keyhunter] enriched ${enriched}/${entities.length}`);

  const list = [...channels.values()]
    .filter((c) => c.title && !JUNK_TITLES.test(c.title))
    .sort((a, b) => (b.participants || 0) - (a.participants || 0));

  const byId = new Map(list.map((c) => [c.id, c]));
  for (const c of list) {
    if (c.linkedId && byId.has(c.linkedId)) {
      byId.get(c.linkedId).linkedTo = c.title;
      c.linkedGroup = byId.get(c.linkedId).title;
    }
  }

  /* extract invite links from abouts */
  for (const c of list) {
    const invites = String(c.about || "").match(/t\.me\/(\+[A-Za-z0-9_-]{10,}|joinchat\/[A-Za-z0-9_-]+|[\w\d_]{4,32})/g) || [];
    if (invites.length) c.invites = [...new Set(invites)].slice(0, 5);
  }

  fs.mkdirSync(OUT, { recursive: true });
  const jsonPath = path.join(OUT, "channels.json");
  const mdPath = path.join(OUT, "channels.md");
  const samplesPath = path.join(OUT, "samples.json");
  fs.writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), total: list.length, queries: QUERIES.length, channels: list }, null, 2), "utf8");
  fs.writeFileSync(samplesPath, JSON.stringify(Object.fromEntries(samples), null, 2), "utf8");

  const md = [];
  md.push(`# TG каналы: слитые API ключи (OpenAI / Grok / DeepSeek / Claude / Gemini и др.)`);
  md.push(``);
  md.push(`Собрано: ${new Date().toISOString()} | каналов: ${list.length} | запросов: ${QUERIES.length}`);
  md.push(``);
  md.push(`| # | Канал | Username | Тип | Участники | Связано | Инвайты | Описание |`);
  md.push(`|---|-------|----------|-----|-----------|---------|---------|----------|`);
  list.forEach((c, i) => {
    const link = c.username ? `[@${c.username}](https://t.me/${c.username})` : c.title;
    const about = (c.about || "").replace(/\s+/g, " ").slice(0, 80);
    const inv = c.invites?.length ? c.invites.slice(0, 2).join(" ") : "";
    md.push(`| ${i + 1} | ${link} | @${c.username || "—"} | ${c.type}${c.megagroup ? "/super" : ""} | ${c.participants ?? "?"} | ${c.linkedTo ? `→ ${c.linkedTo}` : ""} | ${inv} | ${about} |`);
  });
  fs.writeFileSync(mdPath, md.join("\n"), "utf8");

  console.log(`\n[keyhunter] DONE. channels=${list.length}`);
  console.log(`  JSON: ${jsonPath}`);
  console.log(`  MD:   ${mdPath}`);
  console.log(`  samples: ${samplesPath}`);
  await client.disconnect().catch(() => {});
  process.exit(0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
