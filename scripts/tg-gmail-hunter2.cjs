const fs = require("fs");
const path = require("path");
const { TelegramClient, sessions, Api } = require("teleproto");

const TDATA = process.argv[2] || "C:\\Users\\youry\\AppData\\Roaming\\lopster-ide-copy-lopster1-4-copy\\tdata";
const PHONE = process.argv[3] || "380992585188";
const OUT = process.argv[4] || path.join(__dirname, "..", "docs", "tg-gmail-channels");
const PREV = path.join(OUT, "channels.json");

const QUERIES = [
  "gmail:pass", "gmail pass", "gmail password", "gmail passwords", "gmail pwd",
  "email:pass", "email pass", "email password", "email passwords", "mail pass",
  "mail:pass", "mail password", "email combo", "email combos", "mail combo",
  "mail combos", "gmail combo", "gmail combos", "combo list", "combolist",
  "combo lists", "combo gmail", "email dump", "email dumps", "mail dump",
  "mail dumps", "gmail dump", "gmail dumps", "gmail logs", "email logs",
  "mail logs", "email log", "gmail log", "gmail cookies", "gmail cookie",
  "google cookies", "google cookie", "cookies gmail", "cookies accounts",
  "accounts with cookies", "accs with cookies", "gmail accs", "gmail acc",
  "google accs", "google acc", "gmail checker", "gmail checkers", "checker gmail",
  "email checker", "mail checker", "gmail hits", "email hits", "gmail leaks",
  "gmail leak", "email leaks", "mail leaks", "gmail db", "gmail database",
  "email database", "gmail paste", "email paste", "gmail smtp", "email smtp",
  "gmail imap", "gmail pop3", "smtp accounts", "smtp gmail", "smtp email",
  "gmail shop", "gmail store", "gmail market", "gmail seller", "gmail sellers",
  "gmail vendor", "gmail dealer", "gmail reseller", "gmail buy", "gmail sell",
  "gmail trade", "gmail swap", "sell gmail", "buy gmail", "sell google accounts",
  "buy google accounts", "google accounts shop", "google accounts seller",
  "google accounts store", "google accounts for sale", "google accs for sale",
  "gmail accounts for sale", "gmail accounts shop", "gmail accounts store",
  "gmail accounts seller", "gmail accounts trade", "accounts shop", "account shop",
  "accounts store", "accounts market", "accounts seller", "accounts vendor",
  "accounts trade", "accounts swap", "accounts sale", "accounts for sale",
  "accs shop", "accs for sale", "sell accounts", "buy accounts", "trade accounts",
  "accounts telegram", "accs telegram", "gmail bot", "gmail bots", "email bot",
  "email bots", "mail bot", "account bot", "accounts bot", "acc bot",
  "gmail checker bot", "email checker bot", "checker bot", "checker bots",
  "gmail generator", "gmail gen", "email generator", "email gen", "acc gen",
  "acc generator", "account generator", "gmail creator", "email creator",
  "gmail register", "email register", "gmail registration", "email registration",
  "gmail auto register", "gmail autoreg", "auto reg gmail", "bulk gmail",
  "mass gmail", "gmail mass", "gmail bulk", "bulk email accounts",
  "bulk google accounts", "mass accounts", "mass accs", "batch accounts",
  "gmail pva", "gmail pva accounts", "pva gmail", "pva accounts", "pva accs",
  "pva shop", "pva seller", "google pva", "google pva accounts", "gmail aged",
  "gmail aged accounts", "aged gmail", "aged accounts", "aged accs", "old gmail",
  "old gmail accounts", "old accounts", "old accs", "gmail og", "og gmail",
  "og accounts", "gmail 2004", "gmail 2005", "gmail 2006", "gmail 2007",
  "gmail 2008", "gmail 2009", "gmail 2010", "gmail 2011", "gmail 2012",
  "gmail 2013", "gmail 2014", "gmail 2015", "gmail 2016", "gmail 2017",
  "gmail 2018", "gmail 2019", "gmail 2020", "gmail 2021", "gmail 2022",
  "gmail 2023", "gmail 2024", "gmail 2025", "gmail 2026", "gmail fresh",
  "fresh gmail", "fresh gmail accounts", "fresh accounts", "fresh accs",
  "fresh combos", "fresh email", "fresh emails", "gmail fresh accounts",
  "gmail fresh combos", "gmail new accounts", "new gmail", "new email accounts",
  "gmail full access", "full access accounts", "gmail recovery",
  "google account recovery", "gmail verified", "verified gmail", "gmail verified accounts",
  "verified accounts", "gmail phone verified", "phone verified gmail",
  "gmail sms verified", "sms verified accounts", "gmail phone", "gmail number",
  "gmail phone number", "google phone verified", "gmail 2fa", "gmail two step",
  "gmail no 2fa", "no 2fa accounts", "gmail clean", "clean gmail",
  "clean accounts", "gmail original", "gmail real", "gmail user pass",
  "gmail login", "gmail login pass", "google login", "google pass",
  "gmail.com pass", "gmail.com:", "gmail.com login", "gmail.com password",
  "@gmail.com", "@gmail", "gmail mail", "google mail accounts", "google mail",
  "google email accounts", "google email", "gmail email accounts",
  "email accounts", "mail accounts", "email accs", "mail accs",
  "email accounts for sale", "mail accounts for sale", "email accounts shop",
  "mail accounts shop", "email accounts seller", "email vendor", "email dealer",
  "email shop", "email store", "email market", "email trade", "email swap",
  "sell email accounts", "buy email accounts", "email accounts trade",
  "email accounts bulk", "bulk email", "bulk mail", "email lists", "mail lists",
  "email list", "email base", "email bases", "mail base", "email db",
  "email database", "email dump", "email dumps", "email paste", "email leaks",
  "email leak", "email hacked", "gmail hacked", "gmail compromised",
  "gmail breached", "gmail cracked", "gmail account hack", "gmail steal",
  "gmail stolen", "stolen gmail", "stolen accounts", "hacked accounts",
  "hacked gmail", "leaked gmail", "leaked accounts", "leaked emails",
  "cracked accounts", "cracked gmail", "combo emails", "email combolist",
  "combolist email", "gmail combolist", "gmail combo list", "email combo list",
  "mail combo list", "email pass list", "gmail pass list", "email password list",
  "gmail password list", "combo telegram", "combo channel", "combos channel",
  "leaks channel", "leak channel", "leaks telegram", "dump channel",
  "dump telegram", "logs channel", "logs telegram", "cookies channel",
  "cookies telegram", "accounts channel", "accounts telegram channel",
  "акки гмайл", "гмайл акки", "гмайл", "гугл акки", "гугл аккаунты",
  "акки гугл", "аккаунты гугл", "гугл аккаунт", "google акки", "google аккаунты",
  "gmail акки", "gmail аккаунты", "gmail акк", "gmail базы", "gmail база",
  "база гмайл", "базы гмайл", "гмайл база", "слив гмайл", "слив гугл",
  "слив почт", "слив почты", "слив email", "слив акков", "слив аккаунтов",
  "сливы акков", "сливы аккаунтов", "свежие акки", "свежие аккаунты",
  "свежие гмайл", "свежие гугл", "свежая база", "свежие базы", "свежие комбо",
  "комбо почт", "комбо email", "email комбо", "почты пасс", "email пасс",
  "gmail пасс", "почта пасс", "куки акков", "куки аккаунтов", "куки гмайл",
  "куки гугл", "куки google", "акки с куками", "аккаунты с куками",
  "gmail с куками", "гугл с куками", "чекер акков", "чекер гмайл",
  "чекер гугл", "чекер google", "чекер email", "проверка акков",
  "проверка гмайл", "генератор акков", "генератор гмайл", "генератор гугл",
  "рег акков", "авторег", "авторег акков", "авторег гмайл", "авторег гугл",
  "регистратор акков", "регистратор гмайл", "регистратор гугл", "регалка",
  "регалка гмайл", "регалка гугл", "регалка акков", "магазин акков",
  "магазин гмайл", "магазин гугл", "магазин аккаунтов", "шоп акков",
  "шоп гмайл", "шоп гугл", "шоп аккаунтов", "автопродажа акков",
  "автопродажа гмайл", "автовыдача акков", "бот акков", "бот гмайл",
  "бот гугл", "бот аккаунтов", "акки оптом", "аккаунты оптом", "гмайл оптом",
  "гугл оптом", "акки бот", "продажа акков", "продажа гмайл", "продажа гугл",
  "продажа аккаунтов", "куплю акки", "купить акки", "купить гмайл",
  "купить гугл акки", "продам акки", "продам гмайл", "продам гугл акки",
  "обмен акков", "обмен гмайл", "трейд акков", "трейд гмайл", "трейд гугл",
  "акки с почтой", "почтовые акки", "почтовые аккаунты", "email акки",
  "email аккаунты", "mail акки", "акки 2025", "акки 2026", "свежие 2026",
  "слив 2026", "база 2026", "гмайл 2026", "гугл 2026", "акки 2024",
  "пасс акки", "пасс гмайл", "пасс гугл", "логин пасс", "user pass",
  "логин пароль", "пароли почт", "пароли гмайл", "пароли гугл",
  "пароли email", "почты с паролями", "gmail с паролем", "база паролей",
  "谷歌邮箱密码", "谷歌邮箱账号密码", "谷歌邮箱出售", "谷歌邮箱批发",
  "谷歌邮箱购买", "谷歌邮箱卡密", "谷歌邮箱号", "谷歌邮箱成品", "谷歌邮箱自助",
  "谷歌邮箱自动发卡", "谷歌邮箱号商", "谷歌邮箱资源", "谷歌邮箱接码",
  "谷歌邮箱注册", "谷歌邮箱注册机", "谷歌邮箱代注册", "谷歌邮箱批量注册",
  "谷歌邮箱群发", "谷歌邮箱工具", "谷歌邮箱面板", "谷歌邮箱API",
  "谷歌邮箱密钥", "谷歌邮箱登录", "谷歌邮箱账号", "谷歌邮箱账号出售",
  "谷歌邮箱账号批发", "谷歌邮箱账号购买", "谷歌邮箱小号", "谷歌邮箱老号",
  "谷歌邮箱养号", "谷歌邮箱交易", "谷歌邮箱买卖", "谷歌邮箱出售群",
  "谷歌账号密码", "谷歌账号出售", "谷歌账号批发", "谷歌账号购买",
  "谷歌账号卡密", "谷歌账号成品", "谷歌账号自助", "谷歌账号自动发卡",
  "谷歌账号号商", "谷歌账号资源", "谷歌账号接码", "谷歌账号注册机",
  "谷歌账号批量注册", "谷歌账号代注册", "谷歌账号工具", "谷歌账号面板",
  "谷歌账号登录", "谷歌账号交易", "谷歌账号买卖", "谷歌账号出售群",
  "谷歌账号群", "谷歌号出售", "谷歌号批发", "谷歌号购买", "谷歌号卡密",
  "谷歌号成品", "谷歌号号商", "谷歌号资源", "谷歌号接码", "谷歌号注册机",
  "谷歌号工具", "谷歌号交易", "谷歌号买卖", "谷歌小号出售", "谷歌小号批发",
  "谷歌老号出售", "谷歌老号批发", "谷歌邮箱密码出售", "谷歌邮箱密码批发",
  "gmail密码", "gmail密码出售", "gmail密码批发", "gmail账号密码",
  "gmail账号出售", "gmail账号批发", "gmail账号购买", "gmail账号卡密",
  "gmail账号成品", "gmail账号号商", "gmail账号资源", "gmail账号接码",
  "gmail账号注册机", "gmail账号工具", "gmail账号交易", "gmail账号买卖",
  "gmail账号群", "gmail号出售", "gmail号批发", "gmail号购买", "gmail号卡密",
  "gmail号成品", "gmail号号商", "gmail号资源", "gmail号接码", "gmail号注册机",
  "gmail号交易", "gmail号买卖", "gmail小号", "gmail老号", "gmail养号",
  "邮箱密码", "邮箱密码出售", "邮箱密码批发", "邮箱账号密码", "邮箱出售",
  "邮箱批发", "邮箱购买", "邮箱卡密", "邮箱成品", "邮箱号商", "邮箱资源",
  "邮箱接码", "邮箱注册机", "邮箱批量注册", "邮箱代注册", "邮箱工具",
  "邮箱面板", "邮箱登录", "邮箱交易", "邮箱买卖", "邮箱出售群", "邮箱账号出售",
  "邮箱账号批发", "邮箱账号购买", "邮箱号出售", "邮箱号批发", "邮箱号购买",
  "邮箱小号", "邮箱老号", "邮箱养号", "邮箱账号", "邮箱号", "邮箱自动发卡",
  "邮箱自助", "邮箱账号密码出售", "邮箱密码群", "邮箱出售群", "邮箱卡密群",
  "邮箱资源群", "邮箱号群", "邮箱账号群", "邮箱群", "邮箱频道", "邮箱网",
  "邮箱平台", "邮箱站", "邮箱商店", "邮箱店铺", "邮箱货源", "邮箱库存",
  "邮箱稳定", "邮箱秒发", "邮箱自动发货", "邮箱发货", "邮箱在线",
  "邮箱独享", "邮箱实名", "邮箱未实名", "邮箱免实名", "邮箱新号",
  "邮箱满月", "邮箱半年", "邮箱一年", "邮箱两年", "邮箱三年", "邮箱五年",
  "邮箱十年", "邮箱08", "邮箱09", "邮箱10", "邮箱11", "邮箱12", "邮箱13",
  "邮箱14", "邮箱15", "邮箱16", "邮箱17", "邮箱18", "邮箱19", "邮箱20",
  "邮箱21", "邮箱22", "邮箱23", "邮箱24", "邮箱25", "邮箱26",
  "谷歌08", "谷歌09", "谷歌10", "谷歌11", "谷歌12", "谷歌13", "谷歌14",
  "谷歌15", "谷歌16", "谷歌17", "谷歌18", "谷歌19", "谷歌20", "谷歌21",
  "谷歌22", "谷歌23", "谷歌24", "谷歌25", "谷歌26",
  "gmail08", "gmail09", "gmail10", "gmail11", "gmail12", "gmail13", "gmail14",
  "gmail15", "gmail16", "gmail17", "gmail18", "gmail19", "gmail20", "gmail21",
  "gmail22", "gmail23", "gmail24", "gmail25", "gmail26", "gmail2004", "gmail2005",
  "gmail2006", "gmail2007", "gmail2008", "gmail2009", "gmail2010", "gmail2011",
  "gmail2012", "gmail2013", "gmail2014", "gmail2015", "gmail2016", "gmail2017",
  "gmail2018", "gmail2019", "gmail2020", "gmail2021", "gmail2022", "gmail2023",
  "gmail2024", "gmail2025", "gmail2026", "谷歌账号2024", "谷歌账号2025",
  "谷歌账号2026", "邮箱2024", "邮箱2025", "邮箱2026", "谷歌号2024",
  "谷歌号2025", "谷歌号2026", "gmail账号2024", "gmail账号2025", "gmail账号2026",
  "卡密购买", "卡密出售", "卡密批发", "卡密群", "卡密商", "卡密网", "卡密平台",
  "发卡网", "发卡平台", "发卡系统", "自动发卡", "自助发卡", "发卡群", "发卡频道",
  "号商", "号商群", "号商资源", "号商频道", "号源", "号源群", "号源商",
  "号源频道", "账号商", "账号商群", "邮箱商", "邮箱商群", "邮箱货源群",
  "接码平台", "接码群", "接码频道", "收码群", "代收群", "验证码群",
  "注册机", "批量注册", "自动注册", "群控注册", "自动注册机", "注册机群",
  "注册机频道", "注册机商", "注册软件", "注册工具", "批量注册工具",
  "自动注册工具", "账号自动注册", "邮箱自动注册", "谷歌自动注册",
  "邮件账号", "邮件号", "邮件出售", "邮件批发", "邮件购买", "邮件卡密",
  "邮件号商", "邮件成品", "邮件资源", "邮件接码", "邮件注册机", "邮件工具",
  "邮件账号出售", "邮件账号批发", "邮件账号购买", "邮件账号密码", "邮件密码",
  "邮件出售群", "邮件群", "邮件频道", "邮件网", "邮件平台", "邮件站",
  "邮件账号资源", "邮件号群", "邮件账号群", "email出售", "email批发",
  "email购买", "email卡密", "email号商", "email成品", "email资源",
  "email接码", "email注册机", "email工具", "email账号出售", "email账号批发",
  "email账号购买", "email账号密码", "email密码", "email出售群", "email群",
  "email频道", "email平台", "email号群", "email账号群", "email号",
  "email账号", "email小号", "email老号", "email养号", "邮箱代收", "邮箱验证",
  "邮箱短信", "邮箱手机", "邮箱绑定", "邮箱解绑", "邮箱换绑", "邮箱重置",
  "邮箱恢复", "邮箱申诉", "邮箱找回", "邮箱解锁", "邮箱可用", "邮箱有效",
  "邮箱在线", "邮箱存活", "邮箱死号", "邮箱活号", "邮箱检测", "邮箱质量",
  "邮箱等级", "邮箱信誉", "邮箱权重", "邮箱降权", "邮箱风控", "邮箱限制",
  "邮箱封禁", "邮箱解封", "邮箱申诉群", "邮箱教程", "邮箱教学", "邮箱技术",
  "邮箱干货", "邮箱经验", "邮箱交流", "邮箱讨论", "邮箱分享", "邮箱情报",
  "邮箱情报群", "邮箱更新", "邮箱日报", "邮箱每日", "邮箱每日更新",
];

const JUNK_TITLES = /^(a user|user|deleted|channel|group|new channel|new group|Messages|Комментарии|Обсуждение)$/i;
const JUNK_PAT = /(verify bot|verification bot|кликер|кликни|мем|meme|юмор|humor|порно|porn|анекдот|погода|weather|новости дня|фильм|кино|music|музыка|игры|games|знакомств|dating|ваканси|jobs|курс|курсы|обучение|скидки|пеппер)/i;

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
  console.log(`[gmail-hunter2] connected as @${me.username || me.firstName || ""} (${PHONE})`);

  const known = new Set();
  if (fs.existsSync(PREV)) {
    try {
      const prev = JSON.parse(fs.readFileSync(PREV, "utf8"));
      (prev.channels || []).forEach((c) => known.add(c.id));
    } catch {}
  }
  console.log(`[gmail-hunter2] skipping ${known.size} known ids`);

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
          if (!key || known.has(key) || channels.has(key)) continue;
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
            info.lastMsgText = (m.message || "").slice(0, 260);
          }
        }
        totalMsgs += freshMsgs.length;
        if (page === 0 && freshMsgs.length) {
          const texts = freshMsgs.slice(0, 6).map((m) => {
            const peer = m?.peerId;
            const pid = peer?.channelId?.value ?? peer?.chatId?.value ?? peer?.userId?.value ?? null;
            const label = pid != null && channels.has(String(pid)) ? channels.get(String(pid)).title : "";
            return { chat: label, id: m.id, date: m.date ? new Date(Number(m.date) * 1000).toISOString() : "", text: (m.message || "").slice(0, 200) };
          });
          samples.set(q, texts);
        }
        page++;
        const canPaginate = msgs.length >= 100 && res?.nextRate !== undefined && res?.nextRate !== null;
        if (!canPaginate || page >= PAGINATE_MAX) break;
        offsetRate = res.nextRate;
        offsetId = Number(res.nextOffsetId) || 0;
        offsetPeer = res.nextOffsetPeer || new Api.InputPeerEmpty();
        await sleep(280);
      }
      console.log(`[gmail-hunter2] "${q}" -> pages=${page} msgs=${totalMsgs} uniqueTotal=${channels.size}`);
      if (floodHits > 0 && floodHits % 3 === 0) await sleep(2000);
      await sleep(280);
    } catch (e) {
      const msg = String(e?.message || e);
      const flood = msg.match(/FLOOD_WAIT_(\d+)/);
      if (flood) {
        floodHits++;
        const wait = Math.min(Number(flood[1]) + 1, 30);
        console.log(`[gmail-hunter2] flood on "${q}" -> wait ${wait}s`);
        await sleep(wait * 1000);
      } else {
        console.log(`[gmail-hunter2] error on "${q}": ${msg.slice(0, 160)}`);
      }
    }
    if ((QUERIES.indexOf(q) + 1) % 40 === 0) {
      try {
        fs.mkdirSync(OUT, { recursive: true });
        const list = [...channels.values()];
        fs.writeFileSync(path.join(OUT, "checkpoint2.json"), JSON.stringify({ label: QUERIES.indexOf(q) + 1, generatedAt: new Date().toISOString(), total: list.length, channels: list, samples: Object.fromEntries(samples) }, null, 2), "utf8");
      } catch {}
    }
  }

  const entities = [...channels.values()].filter((c) => c.title && !JUNK_TITLES.test(c.title) && !JUNK_PAT.test(c.title));
  console.log(`[gmail-hunter2] enriching ${entities.length} entities...`);
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
    await sleep(200);
  }
  console.log(`[gmail-hunter2] enriched ${enriched}/${entities.length}`);

  const list = [...channels.values()]
    .map((c) => ({ ...c, lastMsgDate: c.lastMsgDate ? new Date(c.lastMsgDate * 1000).toISOString() : null }))
    .sort((a, b) => (b.lastMsgDate || "") > (a.lastMsgDate || "") ? 1 : (b.lastMsgDate || "") < (a.lastMsgDate || "") ? -1 : 0);

  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, "wave2.json"), JSON.stringify({ generatedAt: new Date().toISOString(), total: list.length, queries: QUERIES.length, channels: list }, null, 2), "utf8");
  fs.writeFileSync(path.join(OUT, "samples2.json"), JSON.stringify(Object.fromEntries(samples), null, 2), "utf8");

  console.log(`\n[gmail-hunter2] DONE. channels=${list.length}`);
  console.log(`  JSON: ${path.join(OUT, "wave2.json")}`);
  console.log(`  samples: ${path.join(OUT, "samples2.json")}`);
  await client.disconnect().catch(() => {});
  process.exit(0);
}

main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
