const fs = require("fs");
const path = require("path");
const { TelegramClient, sessions, Api } = require("teleproto");

const TDATA = process.argv[2] || "C:\\Users\\youry\\AppData\\Roaming\\lopster-ide-copy-lopster1-4-copy\\tdata";
const PHONE = process.argv[3] || "380992585188";
const OUT = process.argv[4] || path.join(__dirname, "..", "docs", "tg-ai-channels");

const QUERIES = [
  /* ---- Chinese core ---- */
  "AI白嫖", "白嫖AI", "AI白嫖教程", "白嫖",
  "免费API", "免费AI API", "免费api key", "免费API中转",
  "AI中转", "中转站", "API中转", "api中转站",
  "免费模型", "免费AI模型", "大模型免费", "免费大模型",
  "AI福利", "AI羊毛", "AI薅羊毛", "薅羊毛",
  "免费GPT", "gpt免费", "claude免费", "免费claude",
  "AI资源", "AI分享", "AI工具分享", "免费AI工具",
  "AI密钥", "免费key", "免费接口",
  "AI越狱", "AI破限", "越狱", "AI提示词",
  "AI漏洞", "AI白嫖群", "AI频道",
  "免费ai", "ai free", "free ai", "chatgpt free", "chatgpt免费",
  "grok免费", "grok free", "gemini免费", "gemini free",
  "deepseek免费", "deepseek free", "kimi免费", "kimi free",
  "qwen免费", "通义免费", "智谱免费", "混元免费", "豆包免费",
  "文心免费", "讯飞免费", "免费api key", "api key free",
  "共享账号", "共享号", "账号共享", "GPT账号", "chatgpt账号",
  "claude账号", "plus免费", "pro免费", "会员免费", "免费会员",
  "零成本AI", "ai福利群", "api共享", "key共享", "免费号",
  "midjourney免费", "suno免费", "ai绘画免费", "免费ai绘画",
  "AI交流群", "AI工具", "AI工具群", "免费API群", "AI资源群",
  "ChatGPT共享", "chatgpt共享", "AI公益", "公益AI", "公益API", "公益频道",
  "AI公益频道", "免费AI频道", "白嫖频道", "APIKEY免费", "api key免费",
  "零撸", "AI零撸", "免费key群", "免费模型群", "APIKEY",
  "免费gpt4", "gpt4免费", "免费gpt5", "gpt5免费", "claude4免费", "免费claude4",
  "免费pro", "chatgpt plus免费", "会员共享", "plus共享", "team共享",
  "chatgpt team", "openai免费", "免费openai", "anthropic免费", "免费anthropic",
  "google ai免费", "blackbox免费", "poe免费", "AI分享群", "免费AI交流",
  "AI资源分享群", "免费接口群", "中转群", "AI中转群",
  /* ---- Chinese extended ---- */
  "API白嫖", "免费额度", "白嫖GPT", "白嫖Claude", "白嫖claude",
  "AI群", "AI交流", "AI教程", "API批发", "中转api",
  "GPT4免费", "免费GPT4", "claude免费额度", "免费模型API",
  "AI工具集", "免费AI工具集", "大模型API", "国产大模型",
  "AI薅羊毛群", "AI福利站", "共享GPT", "GPT共享", "共享Claude", "claude共享",
  "API共享群", "免费会员群", "AI机器人", "AI破解", "破限群",
  "提示词分享", "白嫖站", "AI关键词", "免费白嫖",
  /* ---- English ---- */
  "free ai api", "free api", "free gpt", "free llm api",
  "ai abuse", "ai jailbreak", "free claude api", "free gemini api",
  /* ---- Arabic ---- */
  "AI مجاني", "ذكاء اصطناعي مجاني", "AI مجانا", "مجاني AI",
  "واجهة برمجة مجانية", "API مجاني", "نماذج AI مجانية", "نموذج مجاني",
  "ChatGPT مجاني", "شات جي بي تي", "GPT مجاني", "Claude مجاني",
  "Grok مجاني", "كسر حماية AI", "AI كسر الحماية", "بوت AI مجاني",
  "بوتات مجانية", "اشتراكات مجانية", "عروض AI", "خدع AI",
  "اختراق ChatGPT", "AI بالعربي", "مفتاح API", "مفاتيح API",
  "بالمجان", "AI مجانية", "بوت ذكاء اصطناعي", "كوبونات AI",
  "اكسس مجاني", "بوتات AI", "قنوات AI", "جروبات AI",
  "AI بالمجان", "نماذج مجانية AI", "واجهات برمجة مجانية",
  /* ---- Hindi ---- */
  "AI मुफ्त", "मुफ्त AI", "फ्री AI", "AI फ्री",
  "मुफ्त API", "फ्री API", "मुफ्त मॉडल", "ChatGPT मुफ्त",
  "फ्री ChatGPT", "AI हैक", "जेलब्रेक AI", "AI टूल्स",
  "मुफ्त टूल्स", "AI ट्रिक्स", "फ्री की", "AI कुंजी",
  "मुफ्त सब्सक्रिप्शन", "AI समूह", "AI ग्रुप", "AI चैनल",
  "मुफ्त मॉडल API", "क्लॉड मुफ्त", "जीपीटी मुफ्त", "फ्री मॉडल",
  "मुफ्त जीपीटी", "AI टिप्स", "फ्री टूल्स",
  /* ---- Urdu ---- */
  "AI مفت", "مفت AI", "مفت API", "مفت ماڈل",
  "ChatGPT مفت", "AI ٹولز", "AI گروپ", "مفت سبسکرپشن",
  /* ---- Bengali ---- */
  "AI ফ্রি", "ফ্রি AI", "ফ্রি API", "মডেল ফ্রি", "মুক্ত AI",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function chatType(c) {
  if (c.broadcast === true || c.isChannel === true || c.className === "Channel") return "channel";
  if (c.megagroup === true || c.isGroup === true || c.className === "Chat") return "group";
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
  console.log(`[hunter] connected as @${me.username || me.firstName || ""} (${PHONE})`);

  const channels = new Map(); // key -> info
  const samples = new Map(); // query -> top messages
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
        let added = 0;
        for (const c of chats) {
          const key = chatKey(c);
          if (!key || channels.has(key)) continue;
          const info = {
            id: key,
            title: c.title || "",
            username: c.username || "",
            type: chatType(c),
            megagroup: Boolean(c.megagroup),
            participants: c.participantsCount ?? c.participants_count ?? null,
            foundIn: [q],
          };
          channels.set(key, info);
          added++;
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
      console.log(`[hunter] "${q}" -> pages=${page} msgs=${totalMsgs} uniqueTotal=${channels.size}`);
      if (floodHits > 0 && floodHits % 3 === 0) await sleep(2000);
      await sleep(350);
    } catch (e) {
      const msg = String(e?.message || e);
      const flood = msg.match(/FLOOD_WAIT_(\d+)/);
      if (flood) {
        floodHits++;
        const wait = Math.min(Number(flood[1]) + 1, 30);
        console.log(`[hunter] flood on "${q}" -> wait ${wait}s`);
        await sleep(wait * 1000);
      } else {
        console.log(`[hunter] error on "${q}": ${msg.slice(0, 160)}`);
      }
    }
  }

  /* ---- enrichment: full channel info (participants, about, linked group) ---- */
  const JUNK_TITLES = /^(a user|user|deleted|channel|group)$/i;
  const entities = [...channels.values()].filter((c) => c.title && !JUNK_TITLES.test(c.title));
  console.log(`[hunter] enriching ${entities.length} entities...`);
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
  console.log(`[hunter] enriched ${enriched}/${entities.length}`);

  const list = [...channels.values()]
    .filter((c) => c.title && !JUNK_TITLES.test(c.title))
    .sort((a, b) => (b.participants || 0) - (a.participants || 0));

  /* mark linked discussion groups of channels */
  const byId = new Map(list.map((c) => [c.id, c]));
  for (const c of list) {
    if (c.linkedId && byId.has(c.linkedId)) {
      byId.get(c.linkedId).linkedTo = c.title;
      c.linkedGroup = byId.get(c.linkedId).title;
    }
  }
  fs.mkdirSync(OUT, { recursive: true });
  const jsonPath = path.join(OUT, "channels.json");
  const mdPath = path.join(OUT, "channels.md");
  const samplesPath = path.join(OUT, "samples.json");
  fs.writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), total: list.length, queries: QUERIES.length, channels: list }, null, 2), "utf8");
  fs.writeFileSync(samplesPath, JSON.stringify(Object.fromEntries(samples), null, 2), "utf8");

  const md = [];
  md.push(`# TG AI-каналы (бесплатные AI / провайдеры / модели / абуз)`);
  md.push(``);
  md.push(`Собрано: ${new Date().toISOString()} | каналов: ${list.length} | запросов: ${QUERIES.length}`);
  md.push(``);
  md.push(`| # | Канал | Username | Тип | Участники | Связано | Описание |`);
  md.push(`|---|-------|----------|-----|-----------|---------|----------|`);
  list.forEach((c, i) => {
    const link = c.username ? `[@${c.username}](https://t.me/${c.username})` : c.title;
    const about = (c.about || "").replace(/\s+/g, " ").slice(0, 90);
    md.push(`| ${i + 1} | ${link} | @${c.username || "—"} | ${c.type}${c.megagroup ? "/super" : ""} | ${c.participants ?? "?"} | ${c.linkedTo ? `→ ${c.linkedTo}` : ""} | ${about} |`);
  });
  fs.writeFileSync(mdPath, md.join("\n"), "utf8");

  console.log(`\n[hunter] DONE. channels=${list.length}`);
  console.log(`  JSON: ${jsonPath}`);
  console.log(`  MD:   ${mdPath}`);
  console.log(`  samples: ${samplesPath}`);
  await client.disconnect().catch(() => {});
  process.exit(0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
