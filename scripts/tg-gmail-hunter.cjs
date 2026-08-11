const fs = require("fs");
const path = require("path");
const { TelegramClient, sessions, Api } = require("teleproto");

const TDATA = process.argv[2] || "C:\\Users\\youry\\AppData\\Roaming\\lopster-ide-copy-lopster1-4-copy\\tdata";
const PHONE = process.argv[3] || "380992585188";
const OUT = process.argv[4] || path.join(__dirname, "..", "docs", "tg-gmail-channels");

const QUERIES = [
  "gmail账号", "gmail号", "gmail出售", "gmail购买", "gmail卡密", "gmail批发",
  "gmail成品", "gmail号商", "gmail独享", "gmail自动发卡", "gmail邮箱", "gmail邮箱账号",
  "gmail邮箱出售", "gmail邮箱卡密", "gmail邮箱批发", "gmail邮箱号商", "gmail邮箱号",
  "gmail邮箱自动", "gmail交易", "gmail号交易", "gmail自助", "gmail发卡", "gmail代购",
  "gmail代注册", "gmail群发", "gmail接码", "gmail收码", "gmail群", "gmail账号群",
  "gmail资源", "gmail面板", "gmail工具", "gmail密钥", "gmail号批发", "gmail号出售",
  "gmail号购买", "gmail号成品", "gmail号卡密", "gmail号商群", "gmail号群", "gmail号资源",
  "gmail号注册", "gmail号自助", "gmail号自动", "gmail号接码", "gmail号交易群",
  "gmail账号出售", "gmail账号购买", "gmail账号批发", "gmail账号卡密", "gmail账号成品",
  "gmail账号自助", "gmail账号交易", "gmail账号资源", "gmail账号接码", "gmail账号注册",
  "gmail账号工具", "gmail账号面板", "gmail账号群组", "gmail邮箱账号出售", "gmail邮箱账号批发",
  "gmail邮箱号批发", "gmail邮箱号出售", "gmail邮箱号购买", "gmail邮箱号卡密",
  "谷歌邮箱", "谷歌邮箱出售", "谷歌邮箱批发", "谷歌邮箱购买", "谷歌邮箱卡密",
  "谷歌邮箱号", "谷歌邮箱号商", "谷歌邮箱号批发", "谷歌邮箱号出售", "谷歌邮箱号购买",
  "谷歌邮箱号卡密", "谷歌邮箱小号", "谷歌邮箱成品", "谷歌邮箱成品号", "谷歌邮箱自动发卡",
  "谷歌邮箱自助", "谷歌邮箱交易", "谷歌邮箱接码", "谷歌邮箱收码", "谷歌邮箱群发",
  "谷歌邮箱注册", "谷歌邮箱批量", "谷歌邮箱养号", "谷歌邮箱老号", "谷歌邮箱面板",
  "谷歌邮箱工具", "谷歌邮箱API", "谷歌邮箱密钥", "谷歌邮箱资源", "谷歌邮箱渠道",
  "谷歌邮箱账号", "谷歌邮箱账号出售", "谷歌邮箱账号批发", "谷歌邮箱账号购买",
  "谷歌账号", "谷歌账号出售", "谷歌账号批发", "谷歌账号购买", "谷歌账号卡密",
  "谷歌账号成品", "谷歌账号自助", "谷歌账号交易", "谷歌账号资源", "谷歌账号接码",
  "谷歌账号注册", "谷歌账号工具", "谷歌账号面板", "谷歌账号群", "谷歌账号群组",
  "谷歌账号渠道", "谷歌号", "谷歌号商", "谷歌号批发", "谷歌号出售", "谷歌号购买",
  "谷歌号卡密", "谷歌号成品", "谷歌号自助", "谷歌号交易", "谷歌号资源", "谷歌号接码",
  "谷歌号注册", "谷歌号自动", "谷歌号群", "谷歌号商群", "谷歌小号", "谷歌老号",
  "谷歌养号", "谷歌发卡", "谷歌代注册", "谷歌接码", "谷歌注册", "谷歌批量注册",
  "谷歌批量", "谷歌API", "谷歌密钥", "谷歌面板", "谷歌工具", "谷歌资源", "谷歌渠道",
  "邮箱账号", "邮箱号", "邮箱出售", "邮箱购买", "邮箱批发", "邮箱卡密", "邮箱号商",
  "邮箱成品", "邮箱小号", "邮箱注册机", "邮箱接码", "邮箱代收", "邮箱验证",
  "邮箱自动发卡", "邮箱账号出售", "邮箱账号批发", "邮箱账号购买", "邮箱账号卡密",
  "邮箱账号自助", "邮箱号批发", "邮箱号出售", "邮箱号购买", "邮箱号卡密",
  "邮箱发卡", "邮箱群发", "邮箱自助", "邮箱代注册", "邮箱资源", "邮箱面板",
  "邮箱工具", "邮箱渠道", "邮箱交易", "邮箱群", "邮箱收码", "邮箱老号", "邮箱养号",
  "账号自助", "账号出售", "账号批发", "账号卡密", "账号成品", "账号商", "账号资源",
  "账号交易", "账号接码", "账号自动", "自动发卡", "自助发卡", "发卡网", "发卡平台",
  "发卡系统", "发卡渠道", "号商", "号商群", "号商资源", "卡密", "卡密购买",
  "卡密出售", "卡密批发", "卡密平台", "卡密群", "卡密网", "卡密自动", "卡密商",
  "卡密货源", "卡密频道", "号源", "号源群", "号源商", "号源资源", "号源渠道",
  "卖号群", "卖号", "买号", "买号群", "出售账号", "出售号", "出售卡密", "批发账号",
  "批发号", "注册机", "批量注册", "批量注册机", "自动注册", "群控注册", "接码平台",
  "接码群", "接码频道", "收码群", "代收群", "验证码群", "短信接码", "手机接码",
  "gmail accounts", "gmail account", "gmail combos", "gmail combo", "gmail dumps",
  "gmail dump", "gmail cookies", "gmail cookie", "gmail checker", "gmail checkers",
  "gmail logs", "gmail fresh", "fresh gmail", "gmail aged", "aged gmail", "gmail pva",
  "gmail pva accounts", "gmail shop", "gmail seller", "gmail sellers", "google accounts",
  "google combos", "google cookies", "google dumps", "google shop", "google seller",
  "gmail accounts with cookies", "google accounts with cookies", "gmail accs", "google accs",
  "gmail accounts for sale", "gmail accounts seller", "gmail buy", "gmail sale",
  "gmail trade", "gmail swap", "gmail exchange", "gmail market", "gmail store",
  "google store", "gmail wholesale", "gmail bulk", "gmail autoshop", "gmail autobuy",
  "google autoshop", "gmail bot", "google bot", "gmail panel", "google panel",
  "gmail api key", "google api key", "gmail key", "google key", "gmail token",
  "google token", "gmail auth", "google auth", "gmail recovery", "google recovery",
  "gmail accounts 2026", "gmail 2026", "google accounts 2026", "gmail og accounts",
  "og gmail", "gmail 2004", "gmail 2005", "gmail 2006", "gmail 2007", "gmail 2008",
  "gmail 2009", "gmail 2010", "gmail 2011", "gmail 2012", "gmail 2013", "gmail 2014",
  "gmail 2015", "gmail 2016", "gmail 2017", "gmail 2018", "gmail 2019", "gmail 2020",
  "gmail 2021", "gmail 2022", "gmail 2023", "gmail 2024", "gmail 2025",
  "google accounts 2015", "google accounts 2010", "gmail aged accounts", "gmail old accounts",
  "google old accounts", "gmail full access", "gmail combo list", "gmail combolist",
  "gmail account dump", "gmail leak", "gmail leaks", "google leak", "google leaks",
  "gmail leaked", "gmail breach", "gmail hacked", "google hacked", "gmail stolen",
  "gmail database", "gmail db", "gmail base", "gmail list", "gmail lists",
  "gmail combo shop", "gmail account shop", "google account shop", "gmail accounts shop",
  "accounts with cookies", "cookies accounts", "gmail cookies accounts", "gmail login",
  "gmail password", "gmail passwords", "gmail mail pass", "gmail user pass",
  "google user pass", "gmail check", "gmail checker bot", "gmail gen", "gmail generator",
  "gmail method", "gmail method 2026", "google method", "gmail tutorial", "google tutorial",
  "gmail tricks", "google tricks", "gmail hack", "gmail hacking", "gmail crack",
  "gmail cracked", "google cracked", "gmail email accounts", "google email accounts",
  "gmail mail accounts", "gmail pva shop", "google pva shop", "gmail bulk accounts",
  "google bulk accounts", "gmail verified", "verified gmail", "gmail verified accounts",
  "gmail unlocked", "google unlocked", "gmail phone verified", "gmail sms verify",
  "gmail account checker", "gmail account generator", "gmail account seller",
  "gmail seller channel", "gmail buy accounts", "gmail sell accounts", "gmail trade channel",
  "gmail market channel", "gmail reseller", "google reseller", "gmail dealer", "google dealer",
  "gmail vendor", "google vendor", "gmail supply", "google supply", "gmail in stock",
  "gmail ready", "gmail instant delivery", "gmail auto delivery", "gmail live accounts",
  "gmail working", "gmail fresh accounts", "gmail fresh stock", "gmail daily accounts",
  "gmail telegram", "google telegram", "gmail tg", "google tg", "email accounts for sale",
  "email combos", "email dumps", "email dump", "email accounts", "mail accounts",
  "mail combos", "mail dump", "mail logs", "mail accounts for sale", "email seller",
  "email shop", "email market", "email vendor", "email wholesale", "email checker",
  "google mail accounts", "google email accounts", "google mail", "google email",
  "email account shop", "accounts shop", "account shop", "accounts seller", "accounts vendor",
  "accounts with cookies for sale", "cookies shop", "cookie accounts", "cookie dumps",
  "cookie combos", "cookies for sale", "cookie shop", "cookies market",
  "слив gmail", "сливы gmail", "gmail акки", "gmail аккаунты", "гугл акки",
  "гугл аккаунты", "google акки", "google аккаунты", "gmail базы", "gmail база",
  "gmail комбо", "gmail комболист", "gmail куки", "gmail кука", "gmail чекер",
  "gmail лог", "gmail логи", "акки gmail", "аккаунты gmail", "почта gmail акки",
  "гугл почта акки", "свежие gmail", "свежие гугл", "акк gmail", "акк гугл",
  "куки google", "куки гугл", "гугл аккаунт куки", "gmail аккаунт с куками",
  "google аккаунт с куками", "аккаунты с куками", "акки с куками", "гугл pva",
  "старые gmail", "старые гугл акки", "возрастные gmail", "gmail старые акки",
  "магазин gmail акков", "шоп gmail", "gmail шоп", "магазин google акков",
  "гугл акки купить", "gmail акки купить", "google акки купить", "gmail продажа",
  "gmail обмен", "gmail трейд", "слив акков", "слив аккаунтов", "слив баз",
  "слив куки", "слив куков", "сливы аккаунтов", "акки оптом", "аккаунты оптом",
  "акки автоматом", "автопродажа акков", "бот акков", "акк бот", "автовыдача акков",
  "базы почт", "базы email", "email базы", "свежая база", "свежие комбо",
  "чекер gmail", "чекер google", "google чекер", "база2026", "слив2026", "акки2026",
  "gmail акки 2026", "слив баз почт", "почты слив", "слив почт", "база почт",
  "gmail канал", "google канал", "гугл канал", "аккаунт канал", "канал сливов",
  "канал акков", "канал аккаунтов", "канал баз", "канал куки", "канал gmail",
];

const JUNK_TITLES = /^(a user|user|deleted|channel|group|new channel|new group)$/i;
const JUNK_PAT = /(verify bot|verification bot|кликер|кликни|мем|meme|юмор|humor|порно|porn|анекдот|погода|weather|новости дня|фильм|кино|music|музыка|игры|games|знакомств|dating|ваканси|jobs|курс|курсы|обучение)/i;

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

function peerChatId(peer) {
  if (!peer) return null;
  const v = peer.channelId?.value ?? peer.chatId?.value ?? peer.userId?.value;
  if (v == null) return null;
  const raw = String(v);
  if (peer.channelId?.value != null) return /^\d{6,}$/.test(raw) ? `-100${raw}` : raw;
  return raw;
}

function checkpoint(channels, samples, label) {
  try {
    fs.mkdirSync(OUT, { recursive: true });
    const list = [...channels.values()].filter((c) => c.title && !JUNK_TITLES.test(c.title));
    fs.writeFileSync(path.join(OUT, "checkpoint.json"), JSON.stringify({ label, generatedAt: new Date().toISOString(), total: list.length, queries: QUERIES.length, channels: list, samples }, null, 2), "utf8");
  } catch {}
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
  console.log(`[gmail-hunter] connected as @${me.username || me.firstName || ""} (${PHONE})`);

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
        const res = await client.invoke(new Api.messages.SearchGlobal({ q, filter: new Api.InputMessagesFilterEmpty(), offsetRate, offsetPeer, offsetId, limit: 100 }));
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
        for (const m of freshMsgs) {
          const pid = peerChatId(m.peerId);
          if (!pid || !channels.has(pid)) continue;
          const info = channels.get(pid);
          const md = m.date ? Number(m.date) : 0;
          if (!info.lastMsgDate || md > info.lastMsgDate) {
            info.lastMsgDate = md;
            info.lastMsgText = (m.message || "").slice(0, 200);
          }
        }
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
      console.log(`[gmail-hunter] "${q}" -> pages=${page} msgs=${totalMsgs} uniqueTotal=${channels.size}`);
      if (floodHits > 0 && floodHits % 3 === 0) await sleep(2000);
      await sleep(300);
    } catch (e) {
      const msg = String(e?.message || e);
      const flood = msg.match(/FLOOD_WAIT_(\d+)/);
      if (flood) {
        floodHits++;
        const wait = Math.min(Number(flood[1]) + 1, 30);
        console.log(`[gmail-hunter] flood on "${q}" -> wait ${wait}s`);
        await sleep(wait * 1000);
      } else {
        console.log(`[gmail-hunter] error on "${q}": ${msg.slice(0, 160)}`);
      }
    }
    if ((QUERIES.indexOf(q) + 1) % 25 === 0) checkpoint(channels, Object.fromEntries(samples), QUERIES.indexOf(q) + 1);
  }

  const entities = [...channels.values()].filter((c) => c.title && !JUNK_TITLES.test(c.title) && !JUNK_PAT.test(c.title));
  console.log(`[gmail-hunter] enriching ${entities.length} entities...`);
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
          if (self.broadcast === true) info.type = "channel";
        }
      }
      enriched++;
    } catch {}
    await sleep(220);
  }
  console.log(`[gmail-hunter] enriched ${enriched}/${entities.length}`);

  const list = [...channels.values()]
    .filter((c) => c.title && !JUNK_TITLES.test(c.title))
    .map((c) => ({ ...c, lastMsgDate: c.lastMsgDate ? new Date(c.lastMsgDate * 1000).toISOString() : null }))
    .sort((a, b) => (b.lastMsgDate || "") > (a.lastMsgDate || "") ? 1 : (b.lastMsgDate || "") < (a.lastMsgDate || "") ? -1 : 0);

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
  md.push(`# TG Gmail-каналы (акки / сливы / куки / комбо / магазины)`);
  md.push(``);
  md.push(`Собрано: ${new Date().toISOString()} | каналов: ${list.length} | запросов: ${QUERIES.length}`);
  md.push(``);
  md.push(`| # | Канал | Username | Тип | Участники | Активность | Описание |`);
  md.push(`|---|-------|----------|-----|-----------|------------|----------|`);
  list.forEach((c, i) => {
    const link = c.username ? `[@${c.username}](https://t.me/${c.username})` : c.title;
    const about = (c.about || "").replace(/\s+/g, " ").slice(0, 90);
    const act = c.lastMsgDate ? c.lastMsgDate.slice(0, 10) : "—";
    md.push(`| ${i + 1} | ${link} | @${c.username || "—"} | ${c.type}${c.megagroup ? "/super" : ""} | ${c.participants ?? "?"} | ${act} | ${about} |`);
  });
  fs.writeFileSync(mdPath, md.join("\n"), "utf8");

  console.log(`\n[gmail-hunter] DONE. channels=${list.length}`);
  console.log(`  JSON: ${jsonPath}`);
  console.log(`  MD:   ${mdPath}`);
  console.log(`  samples: ${samplesPath}`);
  await client.disconnect().catch(() => {});
  process.exit(0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
