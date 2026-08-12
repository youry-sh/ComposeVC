/**
 * telegram — управление Telegram аккаунтами через MTProto (tdata-сессии).
 *
 * Хранит сессии в userData/tdata/<phone>.session как StringSession.
 * Агент сам вызывает ask_otp для OTP/2FA кодов, затем передаёт их в тулу.
 *
 * Требует api_id + api_hash из my.telegram.org.
 * Сохраняет конфиг в userData/tdata/config.json через action=config.
 *
 * Login flow (3 шага):
 *   1. telegram action=login phone=+1234567890
 *      → отправляет код, возвращает { status:"code_sent", phoneCodeHash:"xxx" }
 *   2. ask_otp action=wait kind=sms destination=+1234567890 → получает код
 *   3. telegram action=verify phone=+1234567890 code=12345
 *      → если нужна 2FA → { status:"2fa_required", ... }
 *   4. ask_otp action=wait kind=totp → получает пароль
 *   5. telegram action=login_password phone=+1234567890 password=xxx
 *      → финальная авторизация
 *
 * Actions:
 *   login <phone>            — шаг 1: отправить код
 *   verify <phone> <code>    — шаг 2: ввести OTP код
 *   login_password <phone> <password> — шаг 3: 2FA пароль
 *   logout <phone>           — удалить аккаунт
 *   list_accounts            — список сохранённых аккаунтов
 *   list_chats <phone>       — список диалогов (+ archived)
 *   get_dialog <phone> <chat> [limit] [offsetId] — сообщения из чата (с пагинацией)
 *   send <phone> <chat> <text> [replyTo=<id>] — отправить / ответить на сообщение
 *   forward <phone> <target> fromChat=<source> ids=[1,2,3] — переслать сообщения
 *   pin <phone> <chat> [id=123] — закрепить сообщение
 *   unpin <phone> <chat> [id=123|all=true] — открепить сообщение(я)
 *   reaction <phone> <chat> id=123 emoji=👍 [remove=true] — поставить/убрать реакцию
 *   click_inline <phone> <chat> id=123 button="текст" — нажать inline-кнопку
 *   delete_messages <phone> <chat> ids=[1,2,3] [delete_all=true] — удалить сообщения
 *   search <phone> <query>   — поиск чатов/каналов/пользователей
 *   get_me <phone>           — инфо о пользователе
 *   status                   — статус тулы
 *   config [apiId] [apiHash] — настройка API
 */

const fs = require("fs");
const path = require("path");
const { TelegramClient, sessions, Api, Logger, errors } = require("teleproto");
const { computeCheck } = require("teleproto/Password");

const TDATA_DIR = "tdata";
const CONFIG_FILE = "config.json";
const LOGIN_TIMEOUT = 120000;

/* In-memory clients for pending logins (kept connected between steps) */
const pendingClients = new Map();
const uploadJobs = new Map();
const MAX_FREE_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_PREMIUM_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;

/* ------------------------------------------------------------------ */
/*  Storage helpers                                                    */
/* ------------------------------------------------------------------ */

function tdataDir(userDataPath) {
  return path.join(userDataPath, TDATA_DIR);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function configPath(userDataPath) {
  return path.join(tdataDir(userDataPath), CONFIG_FILE);
}

function readConfig(userDataPath) {
  try {
    const raw = fs.readFileSync(configPath(userDataPath), "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function writeConfig(userDataPath, cfg) {
  ensureDir(tdataDir(userDataPath));
  fs.writeFileSync(configPath(userDataPath), JSON.stringify(cfg, null, 2), "utf8");
}

function sessionPath(userDataPath, phone) {
  const safe = String(phone || "").replace(/[^0-9]/g, "");
  return path.join(tdataDir(userDataPath), `${safe}.session`);
}

function listSessions(userDataPath) {
  ensureDir(tdataDir(userDataPath));
  const files = fs.readdirSync(tdataDir(userDataPath));
  const sessions = [];
  for (const f of files) {
    if (!f.endsWith(".session")) continue;
    const phone = f.replace(".session", "");
    const metaPath = path.join(tdataDir(userDataPath), `${phone}.meta.json`);
    let meta = {};
    try {
      meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    } catch { /* ok */ }
    sessions.push({
      phone: meta.phone || phone,
      name: meta.name || "",
      username: meta.username || "",
      lastActive: meta.lastActive || 0,
      sessionFile: f,
    });
  }
  return sessions;
}

function saveMeta(userDataPath, phone, data) {
  const safe = String(phone || "").replace(/[^0-9]/g, "");
  const metaPath = path.join(tdataDir(userDataPath), `${safe}.meta.json`);
  ensureDir(tdataDir(userDataPath));
  let existing = {};
  try {
    existing = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch { /* ok */ }
  Object.assign(existing, data, { lastActive: Date.now() });
  fs.writeFileSync(metaPath, JSON.stringify(existing, null, 2), "utf8");
}

function readSessionString(userDataPath, phone) {
  const sp = sessionPath(userDataPath, phone);
  try {
    return fs.readFileSync(sp, "utf8").trim();
  } catch {
    return null;
  }
}

function saveSessionString(userDataPath, phone, sessionStr) {
  const sp = sessionPath(userDataPath, phone);
  ensureDir(tdataDir(userDataPath));
  fs.writeFileSync(sp, sessionStr, "utf8");
}

function isAuthorizationKeyInvalidError(error) {
  const value = [error?.errorMessage, error?.message, error?.code].filter(Boolean).join(" ").toUpperCase();
  return value.includes("AUTH_KEY_UNREGISTERED") || value.includes("AUTHORIZATION KEY IS NOT REGISTERED") || value.includes("AUTH_KEY_INVALID");
}

function quarantineInvalidSession(userDataPath, phone) {
  const source = sessionPath(userDataPath, phone);
  if (!fs.existsSync(source)) return null;
  const safePhone = String(phone || "").replace(/[^0-9]/g, "") || "unknown";
  const target = path.join(tdataDir(userDataPath), `${safePhone}.invalid-${Date.now()}.session`);
  try {
    fs.renameSync(source, target);
    const metaPath = path.join(tdataDir(userDataPath), `${safePhone}.meta.json`);
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(metaPath, "utf8")); } catch {}
    meta.sessionStatus = "authorization_key_invalid";
    meta.sessionQuarantinedAt = Date.now();
    meta.sessionBackup = path.basename(target);
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), "utf8");
    return target;
  } catch {
    return null;
  }
}

function authorizationKeyRecoveryError(phone, backupPath) {
  const backup = backupPath ? ` A preserved backup was created at ${backupPath}.` : "";
  const error = new Error(`Telegram authorization key for ${phone} is no longer registered. The old session was quarantined instead of deleted; run telegram action=login phone=\"${phone}\" to create a fresh session.${backup}`);
  error.code = "AUTH_KEY_UNREGISTERED";
  error.authorizationKeyInvalid = true;
  return error;
}

function isAuthorizationRecoveryError(error) {
  return Boolean(error?.authorizationKeyInvalid) || /authorization key.*no longer registered/i.test(String(error?.message || ""));
}

function deleteSession(userDataPath, phone) {
  const safe = String(phone || "").replace(/[^0-9]/g, "");
  const sp = sessionPath(userDataPath, phone);
  const mp = path.join(tdataDir(userDataPath), `${safe}.meta.json`);
  try { fs.unlinkSync(sp); } catch { /* ok */ }
  try { fs.unlinkSync(mp); } catch { /* ok */ }
}

function pendingMapPath(userDataPath) {
  return path.join(tdataDir(userDataPath), "pending.json");
}

function getPendingMap(userDataPath) {
  try {
    const raw = fs.readFileSync(pendingMapPath(userDataPath), "utf8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function savePendingMap(userDataPath, pm) {
  ensureDir(tdataDir(userDataPath));
  fs.writeFileSync(pendingMapPath(userDataPath), JSON.stringify(pm, null, 2), "utf8");
}

/* ------------------------------------------------------------------ */
/*  Client connection                                                  */
/* ------------------------------------------------------------------ */

async function createClient(userDataPath, phone, opts = {}) {
  const cfg = readConfig(userDataPath);
  if (!cfg.apiId || !cfg.apiHash) {
    throw new Error(
      "Telegram API id/hash not configured. Call action=config with apiId and apiHash " +
      "from https://my.telegram.org/apps"
    );
  }

  const sessionStr = readSessionString(userDataPath, phone);
  const stringSession = sessionStr
    ? new sessions.StringSession(sessionStr)
    : new sessions.StringSession("");

  const client = new TelegramClient(stringSession, Number(cfg.apiId), cfg.apiHash, {
    connectionRetries: Infinity,
    keepAliveInterval: 60000,
    deviceModel: "ComposeVC Desktop",
    systemVersion: "Windows 11",
    appVersion: "1.0.0",
    langCode: "en",
    systemLangCode: "en",
    ...opts,
  });

  try {
    await client.connect();
    if (sessionStr) await client.getMe();
    return { client, stringSession };
  } catch (error) {
    if (!isAuthorizationKeyInvalidError(error) || !sessionStr) throw error;
    try { await client.disconnect().catch(() => {}); } catch {}
    const backupPath = quarantineInvalidSession(userDataPath, phone);
    throw authorizationKeyRecoveryError(phone, backupPath);
  }
}

/* ------------------------------------------------------------------ */
/*  Action handlers                                                    */
/* ------------------------------------------------------------------ */

/** Clean stale pending clients (older than 5 min) */
function cleanStaleClients() {
  const now = Date.now();
  for (const [phone, entry] of pendingClients) {
    if (now - entry.createdAt > 300000) {
      try { entry.client.disconnect().catch(() => {}); } catch {}
      pendingClients.delete(phone);
    }
  }
}

/** Шаг 1: Отправить код на телефон */
async function actionSendCode(input, context) {
  const phone = String(input.phone || input.number || "").trim();
  if (!phone) throw new Error("phone required: +1234567890");

  const userDataPath = context?.userDataPath;
  if (!userDataPath) throw new Error("context.userDataPath required");

  const cfg = readConfig(userDataPath);
  if (!cfg.apiId || !cfg.apiHash) {
    throw new Error(
      "Telegram API id/hash not configured. First run: action=config apiId=12345 apiHash=abc123"
    );
  }

  // Check if already logged in
  const existingSession = readSessionString(userDataPath, phone);
  if (existingSession) {
    try {
      const { client } = await createClient(userDataPath, phone);
      try {
        const me = await client.getMe();
        if (me && me.id) {
          const name = [me.firstName, me.lastName].filter(Boolean).join(" ");
          const username = me.username || "";
          saveMeta(userDataPath, phone, { phone: me.phone || phone, name, username, sessionStatus: "active" });
          await client.disconnect();
          return { ok: true, message: `Already logged in as ${name} (@${username})` };
        }
      } catch { }
      await client.disconnect();
    } catch (error) {
      if (!isAuthorizationKeyInvalidError(error)) throw error;
    }
  }

  // Clean old pending first
  cleanStaleClients();

  // Keep the original pending request. Re-sending can exhaust Telegram's delivery options.
  const existing = pendingClients.get(phone);
  if (existing) {
    return {
      ok: true,
      status: "code_pending",
      phone,
      message: `A code is already pending for ${phone}. Enter the code from Telegram using telegram action=verify phone="${phone}" code=<code>`,
      next_step: { action: "verify", phone },
    };
  }

  const { client } = await createClient(userDataPath, phone);
  try {
    const sendResult = await client.invoke(new Api.auth.SendCode({
      phoneNumber: phone,
      apiId: Number(cfg.apiId),
      apiHash: cfg.apiHash,
      settings: new Api.CodeSettings({
        allowFlashCall: false,
        allowMissedCall: false,
        allowAppHash: false,
      }),
    }));
    if (sendResult instanceof Api.auth.SentCodeSuccess) {
      const me = sendResult.authorization?.user;
      const name = [me?.firstName, me?.lastName].filter(Boolean).join(" ");
      const username = me?.username || "";
      const savedSession = client.session.save();
      saveSessionString(userDataPath, phone, savedSession);
      saveMeta(userDataPath, phone, { phone: me?.phone || phone, name, username });
      await client.disconnect();
      return { ok: true, status: "already_authorized", phone, message: `Already authorized as ${name} (@${username})` };
    }
    if (!(sendResult instanceof Api.auth.SentCode)) {
      throw new Error(`Unexpected Telegram auth response: ${sendResult?.className || typeof sendResult}`);
    }

    const type = sendResult.type;
    const typeName = type?.className || type?.constructor?.name || "unknown";
    const nextTypeName = sendResult.nextType?.className || sendResult.nextType?.constructor?.name || null;
    const typeMap = {
      "auth.SentCodeTypeApp": { delivery: "telegram_app", otpKind: "app" },
      "auth.SentCodeTypeSms": { delivery: "sms", otpKind: "sms" },
      "auth.SentCodeTypeCall": { delivery: "phone_call", otpKind: "sms" },
      "auth.SentCodeTypeFlashCall": { delivery: "flash_call", otpKind: "sms" },
      "auth.SentCodeTypeMissedCall": { delivery: "missed_call", otpKind: "sms" },
      "auth.SentCodeTypeEmailCode": { delivery: "email", otpKind: "email" },
      "auth.SentCodeTypeSetUpEmailRequired": { delivery: "email_setup_required", otpKind: "email" },
    };
    const deliveryInfo = typeMap[typeName] || { delivery: "unknown", otpKind: "sms" };
    const phoneCodeHash = sendResult.phoneCodeHash;

    // Extract code length: the type object has a length property for SMS/App/Call types
    // Teleproto SentCodeType stores it as type.length
    let codeLength = null;
    if (type && typeof type.length === "number") {
      codeLength = type.length;
    } else if (sendResult.type && typeof sendResult.type.length === "number") {
      codeLength = sendResult.type.length;
    }

    // Persist to in-memory pending client
    pendingClients.set(phone, {
      client,
      phoneCodeHash,
      createdAt: Date.now(),
    });

    // Persist phoneCodeHash to disk (survives restart)
    const pm = getPendingMap(userDataPath);
    pm[phone] = {
      phoneCodeHash,
      createdAt: Date.now(),
    };
    savePendingMap(userDataPath, pm);

    return {
      ok: true,
      status: "code_sent",
      phone,
      delivery: deliveryInfo.delivery,
      otp_kind: deliveryInfo.otpKind,
      code_type: typeName,
      next_code_type: nextTypeName,
      code_length: codeLength,
      timeout: sendResult.timeout || null,
      message: `Telegram selected ${deliveryInfo.delivery} for ${phone} (${typeName}). Check that channel and call telegram action=verify phone="${phone}" code=<code>.`,
      next_step: { action: "verify", phone, otp_kind: deliveryInfo.otpKind },
    };
  } catch (err) {
    try { await client.disconnect().catch(() => {}); } catch {}
    throw new Error(`Failed to send code: ${err.message || err}`);
  }
}

/** Шаг 2: Подтвердить OTP код */
async function actionVerify(input, context) {
  const phone = String(input.phone || "").trim();
  const code = String(input.code || input.otp || "").trim();
  if (!phone) throw new Error("phone required");
  if (!code) throw new Error("code (OTP) required");

  const userDataPath = context?.userDataPath;
  if (!userDataPath) throw new Error("context.userDataPath required");

  const cfg = readConfig(userDataPath);
  if (!cfg.apiId || !cfg.apiHash) throw new Error("API not configured");

  // Get pending client from memory
  const pending = pendingClients.get(phone);
  if (!pending) {
    // Try connecting fresh with pending file (backward compat)
    const pm = getPendingMap(userDataPath);
    const old = pm[phone];
    if (old && old.phoneCodeHash) {
      const { client } = await createClient(userDataPath, phone);
      try {
        let signInResult;
        try {
          signInResult = await client.invoke(new Api.auth.SignIn({
            phoneNumber: phone,
            phoneCodeHash: old.phoneCodeHash,
            phoneCode: code,
          }));
        } catch (err2) {
          if (
            err2.errorMessage === "SESSION_PASSWORD_NEEDED" ||
            /password|2fa|2fa/i.test(String(err2.message || err2.errorMessage || ""))
          ) {
            pm[phone] = { ...old, code };
            savePendingMap(userDataPath, pm);
            return {
              ok: true, status: "2fa_required", phone,
              message: `2FA password required for ${phone}. Call telegram action=login_password phone="${phone}" password=<2FA-password>`,
              next_step: { action: "login_password", phone },
            };
          }
          throw err2;
        }

        if (signInResult instanceof Api.auth.AuthorizationSignUpRequired) {
          throw new Error("Signup required — phone number not registered on Telegram");
        }

        const signedIn = signInResult.user;
        if (!signedIn || !signedIn.id) throw new Error("Login failed");
        const savedSession = client.session.save();
        saveSessionString(userDataPath, phone, savedSession);
        const name = [signedIn.firstName, signedIn.lastName].filter(Boolean).join(" ");
        const username = signedIn.username || "";
        saveMeta(userDataPath, phone, { phone: signedIn.phone || phone, name, username });
        delete pm[phone];
        savePendingMap(userDataPath, pm);
        return { ok: true, message: `✓ Authenticated as ${name} (@${username})`, account: { phone: signedIn.phone || phone, name, username } };
      } finally {
        await client.disconnect().catch(() => {});
      }
    }
    throw new Error(`No pending login for ${phone}. Run action=login first.`);
  }

  const { client, phoneCodeHash } = pending;
  try {
    let signInResult;
    try {
      signInResult = await client.invoke(new Api.auth.SignIn({
        phoneNumber: phone,
        phoneCodeHash,
        phoneCode: code,
      }));
    } catch (err) {
      if (
        err.errorMessage === "SESSION_PASSWORD_NEEDED" ||
        /password|2fa|2fa/i.test(String(err.message || err.errorMessage || ""))
      ) {
        return {
          ok: true, status: "2fa_required", phone,
          message: `2FA password required. Call telegram action=login_password phone="${phone}" password=<2FA-password>`,
          next_step: { action: "login_password", phone },
        };
      }
      throw err;
    }

    if (signInResult instanceof Api.auth.AuthorizationSignUpRequired) {
      throw new Error("Signup required — phone number not registered on Telegram");
    }

    const signedIn = signInResult.user;
    if (!signedIn || !signedIn.id) throw new Error("Login failed");

    const savedSession = client.session.save();
    saveSessionString(userDataPath, phone, savedSession);

    const name = [signedIn.firstName, signedIn.lastName].filter(Boolean).join(" ");
    const username = signedIn.username || "";
    saveMeta(userDataPath, phone, {
      phone: signedIn.phone || phone, name, username,
    });

    // Clean up pending client
    pendingClients.delete(phone);

    return {
      ok: true,
      message: `✓ Authenticated as ${name} (@${username})`,
      account: { phone: signedIn.phone || phone, name, username },
    };
  } catch (err) {
    // On error, keep client alive for potential retry
    throw new Error(`Verify failed: ${err.message || err}`);
  }
}

/** Шаг 3: 2FA пароль */
async function actionLoginPassword(input, context) {
  const phone = String(input.phone || "").trim();
  const password = String(input.password || input.pass || "").trim();
  if (!phone) throw new Error("phone required");
  if (!password) throw new Error("password (2FA) required");

  const userDataPath = context?.userDataPath;
  if (!userDataPath) throw new Error("context.userDataPath required");

  const cfg = readConfig(userDataPath);
  if (!cfg.apiId || !cfg.apiHash) throw new Error("API not configured");

  // Try in-memory client first
  const pending = pendingClients.get(phone);
  if (pending) {
    const { client, phoneCodeHash } = pending;
    try {
      const passwordSrpResult = await client.invoke(new Api.account.GetPassword());
      const passwordSrpCheck = await computeCheck(passwordSrpResult, password);
      const signInResult = await client.invoke(new Api.auth.CheckPassword({
        password: passwordSrpCheck,
      }));
      const signedIn = signInResult.user;
      if (!signedIn || !signedIn.id) throw new Error("2FA login failed");
      const savedSession = client.session.save();
      saveSessionString(userDataPath, phone, savedSession);
      const name = [signedIn.firstName, signedIn.lastName].filter(Boolean).join(" ");
      const username = signedIn.username || "";
      saveMeta(userDataPath, phone, { phone: signedIn.phone || phone, name, username });
      pendingClients.delete(phone);
      return { ok: true, message: `✓ Authenticated as ${name} (@${username})`, account: { phone: signedIn.phone || phone, name, username } };
    } catch (err) {
      throw new Error(`2FA failed: ${err.message || err}`);
    }
  }

  // Fallback to pending file
  const pm = getPendingMap(userDataPath);
  const old = pm[phone];
  if (!old || !old.phoneCodeHash || !old.code) {
    throw new Error(`No pending 2FA login for ${phone}. Run action=login then verify first.`);
  }
  const { client } = await createClient(userDataPath, phone);
  try {
    const passwordSrpResult = await client.invoke(new Api.account.GetPassword());
    const passwordSrpCheck = await computeCheck(passwordSrpResult, password);
    const signInResult = await client.invoke(new Api.auth.CheckPassword({
      password: passwordSrpCheck,
    }));
    const signedIn = signInResult.user;
    if (!signedIn || !signedIn.id) throw new Error("2FA login failed");
    const savedSession = client.session.save();
    saveSessionString(userDataPath, phone, savedSession);
    const name = [signedIn.firstName, signedIn.lastName].filter(Boolean).join(" ");
    const username = signedIn.username || "";
    saveMeta(userDataPath, phone, { phone: signedIn.phone || phone, name, username });
    delete pm[phone];
    savePendingMap(userDataPath, pm);
    return { ok: true, message: `✓ Authenticated as ${name} (@${username})`, account: { phone: signedIn.phone || phone, name, username } };
  } catch (err) {
    throw new Error(`2FA failed: ${err.message || err}`);
  } finally {
    await client.disconnect().catch(() => {});
  }
}

/** Logout: remove session */
async function actionLogout(input, context) {
  const phone = String(input.phone || input.account || "").trim();
  if (!phone) throw new Error("phone or account required");

  const userDataPath = context?.userDataPath;
  if (!userDataPath) throw new Error("context.userDataPath required");

  // Try to disconnect properly
  const sessionStr = readSessionString(userDataPath, phone);
  if (sessionStr) {
    try {
      const { client } = await createClient(userDataPath, phone);
      await client.logOut();
      await client.disconnect();
    } catch { /* session invalid, just delete */ }
  }

  deleteSession(userDataPath, phone);
  return { ok: true, message: `Account ${phone} logged out and session deleted` };
}

/** List all saved accounts */
async function actionListAccounts(input, context) {
  const userDataPath = context?.userDataPath;
  if (!userDataPath) throw new Error("context.userDataPath required");

  const accounts = listSessions(userDataPath);
  if (!accounts.length) {
    return { ok: true, accounts: [], message: "No saved accounts. Use action=login phone=+1234567890" };
  }

  let text = "📱 **Telegram Accounts:**\n";
  for (let i = 0; i < accounts.length; i++) {
    const a = accounts[i];
    const lastSeen = a.lastActive
      ? new Date(a.lastActive).toLocaleString()
      : "unknown";
    text += `\n${i + 1}. ${a.name || "Unnamed"} (@${a.username || "—"})\n`;
    text += `   📞 ${a.phone}\n`;
    text += `   🕐 Last active: ${lastSeen}\n`;
  }

  return { ok: true, accounts, count: accounts.length, __toolText: text };
}

/** List chats (dialogs) for an account */
async function actionListChats(input, context) {
  const phone = String(input.phone || input.account || "").trim();
  if (!phone) throw new Error("phone required");

  const includeArchived = input.archived === true || input.all === true;
  const limit = Math.min(Number(input.limit) || 100, 500);
  const userDataPath = context?.userDataPath;
  if (!userDataPath) throw new Error("context.userDataPath required");

  const { client } = await createClient(userDataPath, phone);
  try {
    const dialogs = await client.getDialogs({
      limit,
      archived: includeArchived,
    });

    const chats = dialogs.map((d) => ({
      id: d.id?.value !== undefined ? d.id.value.toString() : String(d.id || ""),
      name: d.name || d.title || "Unknown",
      type: d.isUser ? "user" : d.isGroup ? "group" : d.isChannel ? "channel" : d.isChat ? "chat" : "unknown",
      unreadCount: d.unreadCount || 0,
      archived: Boolean(d.archived),
      pinned: Boolean(d.pinned),
    }));

    let text = `💬 **Chats for ${phone}** (${chats.length}):\n`;
    for (const c of chats) {
      const icon = c.type === "user" ? "👤" : c.type === "channel" ? "📢" : "👥";
      const archive = c.archived ? " 📦" : "";
      const pin = c.pinned ? " 📌" : "";
      text += `\n${icon}${archive}${pin} **${c.name}**\n   ID: ${c.id} | Unread: ${c.unreadCount}\n`;
    }

    return { ok: true, chats, count: chats.length, __toolText: text };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

function bareChatId(chat) {
  const s = String(chat ?? "").trim();
  if (/^-100\d+$/.test(s)) return s.slice(4);
  const m = s.match(/^-?(\d+)$/);
  return m ? m[1] : null;
}

function chatIdCandidates(chat) {
  const raw = String(chat ?? "").trim();
  const out = [raw];
  if (/^\d{6,}$/.test(raw)) {
    out.push(`-100${raw}`);
    out.push(`-${raw}`);
  } else if (/^-\d{6,}$/.test(raw) && !raw.startsWith("-100")) {
    out.push(`-100${raw.slice(1)}`);
  }
  return [...new Set(out)];
}

async function resolveChatEntity(client, chat) {
  if (["me", "self", "saved messages", "избранное"].includes(String(chat || "").trim().toLowerCase())) {
    const me = await client.getMe();
    return client.getInputEntity(me);
  }
  for (const candidate of chatIdCandidates(chat)) {
    try {
      return await client.getInputEntity(candidate);
    } catch { /* try next form */ }
  }
  const dialogs = await client.getDialogs({ limit: 1000, archived: true });
  const bare = bareChatId(chat);
  const found = dialogs.find((d) => {
    const id = d.id?.value !== undefined ? d.id.value : d.id;
    const idStr = String(id);
    return d.name === chat || d.title === chat || idStr === chat || (bare && idStr === bare);
  });
  if (!found) throw new Error(`Chat "${chat}" not found`);
  const candidate = found.inputEntity || found.entity || found;
  try {
    return await client.getInputEntity(candidate);
  } catch {
    return candidate;
  }
}

async function resolveForumPeer(client, chat) {
  const entity = await resolveChatEntity(client, chat);
  if (!entity || entity.className !== "InputPeerChannel") {
    throw new Error("Forum topics require a supergroup or channel peer");
  }
  return entity;
}

async function actionListTopics(input, context) {
  const phone = String(input.phone || input.account || "").trim();
  const chat = String(input.chat || input.chatId || input.chat_id || input.chat_name || "").trim();
  const limit = Math.min(Number(input.limit) || 100, 100);
  if (!phone) throw new Error("phone required");
  if (!chat) throw new Error("chat required");
  const userDataPath = context?.userDataPath;
  if (!userDataPath) throw new Error("context.userDataPath required");
  const { client } = await createClient(userDataPath, phone);
  try {
    const peer = await resolveForumPeer(client, chat);
    const result = await client.invoke(new Api.messages.GetForumTopics({
      peer,
      q: String(input.query || input.text || ""),
      offsetDate: Number(input.offsetDate) || 0,
      offsetId: Number(input.offsetId) || 0,
      offsetTopic: Number(input.offsetTopic) || 0,
      limit,
    }));
    const topics = Array.isArray(result?.topics) ? result.topics.map((topic) => ({
      id: topic.id,
      title: topic.title || "",
      closed: Boolean(topic.closed),
      hidden: Boolean(topic.hidden),
      pinned: Boolean(topic.pinned),
      unreadCount: topic.unreadCount || 0,
    })) : [];
    return { ok: true, chat, topics, count: topics.length };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

async function actionCreateTopic(input, context) {
  const phone = String(input.phone || input.account || "").trim();
  const chat = String(input.chat || input.chatId || input.chat_id || input.chat_name || "").trim();
  const title = String(input.title || input.topic || input.text || "").trim();
  if (!phone) throw new Error("phone required");
  if (!chat) throw new Error("chat required");
  if (!title) throw new Error("title required");
  const userDataPath = context?.userDataPath;
  if (!userDataPath) throw new Error("context.userDataPath required");
  const { client } = await createClient(userDataPath, phone);
  try {
    const peer = await resolveForumPeer(client, chat);
    const randomId = String(input.randomId || `${Date.now()}${Math.floor(Math.random() * 1000000)}`);
    const result = await client.invoke(new Api.messages.CreateForumTopic({ peer, title, randomId: BigInt(randomId) }));
    const topic = Array.isArray(result?.updates) ? result.updates.find((item) => item.className === "UpdateNewMessage")?.message : null;
    return { ok: true, chat, title, topicId: topic?.id || null, resultClass: result?.className || "" };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

async function actionEditTopic(input, context) {
  const phone = String(input.phone || input.account || "").trim();
  const chat = String(input.chat || input.chatId || input.chat_id || input.chat_name || "").trim();
  const topicId = Number(input.topicId !== undefined ? input.topicId : input.topMsgId);
  const title = input.title !== undefined ? String(input.title).trim() : undefined;
  const iconEmojiId = input.iconEmojiId !== undefined ? BigInt(String(input.iconEmojiId)) : undefined;
  const closed = input.closed !== undefined ? Boolean(input.closed) : undefined;
  const hidden = input.hidden !== undefined ? Boolean(input.hidden) : undefined;
  if (!phone) throw new Error("phone required");
  if (!chat) throw new Error("chat required");
  if (!Number.isInteger(topicId) || topicId <= 0) throw new Error("topicId required");
  if (title === undefined && iconEmojiId === undefined && closed === undefined && hidden === undefined) throw new Error("one topic field required");
  const userDataPath = context?.userDataPath;
  if (!userDataPath) throw new Error("context.userDataPath required");
  const { client } = await createClient(userDataPath, phone);
  try {
    const peer = await resolveForumPeer(client, chat);
    const result = await client.invoke(new Api.messages.EditForumTopic({ peer, topicId, title, iconEmojiId, closed, hidden }));
    return { ok: true, chat, topicId, title: title ?? null, closed: closed ?? null, hidden: hidden ?? null, resultClass: result?.className || "" };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

async function actionDeleteTopic(input, context) {
  const phone = String(input.phone || input.account || "").trim();
  const chat = String(input.chat || input.chatId || input.chat_id || input.chat_name || "").trim();
  const topicId = Number(input.topicId !== undefined ? input.topicId : input.topMsgId);
  if (!phone) throw new Error("phone required");
  if (!chat) throw new Error("chat required");
  if (!Number.isInteger(topicId) || topicId <= 0) throw new Error("topicId required");
  const userDataPath = context?.userDataPath;
  if (!userDataPath) throw new Error("context.userDataPath required");
  const { client } = await createClient(userDataPath, phone);
  try {
    const peer = await resolveForumPeer(client, chat);
    await client.invoke(new Api.messages.DeleteTopicHistory({ peer, topMsgId: topicId }));
    return { ok: true, chat, topicId, deleted: true };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

/** Get messages from a chat (with offsetId pagination, optional forum topic filter) */
async function actionGetDialog(input, context) {
  const phone = String(input.phone || input.account || "").trim();
  const chat = String(input.chat || input.chatId || input.chat_id || input.chat_name || "").trim();
  const limit = Math.min(Number(input.limit) || 20, 200);
  const offsetId = input.offsetId !== undefined ? Number(input.offsetId) : undefined;
  const topicRaw = input.topicId !== undefined ? input.topicId : input.topic !== undefined ? input.topic : input.topMsgId;
  const topicId = topicRaw !== undefined && topicRaw !== null && topicRaw !== "" ? Number(topicRaw) : undefined;

  if (!phone) throw new Error("phone required");
  if (!chat) throw new Error("chat (id, username, or title) required");

  const userDataPath = context?.userDataPath;
  if (!userDataPath) throw new Error("context.userDataPath required");

  const { client } = await createClient(userDataPath, phone);
  try {
    const entity = await resolveChatEntity(client, chat);

    let rawMessages;
    if (topicId !== undefined && !isNaN(topicId) && topicId > 0) {
      // messages.GetHistory has no top_msg_id field in this MTProto layer,
      // so a forum topic history is read via messages.Search with topMsgId
      // (empty query + empty filter = all messages of that topic).
      const result = await client.invoke(new Api.messages.Search({
        peer: entity,
        q: "",
        filter: new Api.InputMessagesFilterEmpty(),
        topMsgId: topicId,
        offsetId: !isNaN(offsetId) ? offsetId : 0,
        limit,
      }));
      rawMessages = Array.isArray(result?.messages) ? result.messages : [];
    } else {
      const opts = { limit };
      if (offsetId !== undefined && !isNaN(offsetId)) {
        opts.offsetId = offsetId;
      }
      rawMessages = await client.getMessages(entity, opts);
    }

    const msgs = rawMessages.map((m) => ({
      id: m.id,
      date: m.date ? new Date(m.date * 1000).toISOString() : "",
      from: m.sender?.firstName || m.sender?.username || m.sender?.title || fromIdLabel(m) || "unknown",
      text: m.message || "[non-text message / media]",
    }));

    // Provide last message ID for next page
    const lastId = msgs.length > 0 ? msgs[msgs.length - 1].id : null;
    const nextOffsetId = msgs.length >= limit && lastId !== null ? lastId : null;

    let text = `💬 **Dialog: ${entity.name || entity.title || chat}**${topicId ? ` (topic #${topicId})` : ""}\n\n`;
    for (const m of msgs) {
      text += `[${m.date.slice(0, 19).replace("T", " ")}] ${m.from}: ${m.text.slice(0, 300)}\n`;
    }
    if (!msgs.length) text += "(empty)\n";
    if (nextOffsetId) {
      text += `\n📄 Next page: offsetId=${nextOffsetId}\n`;
    }

    return {
      ok: true,
      messages: msgs,
      count: msgs.length,
      chatName: entity.name || entity.title || chat,
      topicId: topicId !== undefined && !isNaN(topicId) ? topicId : null,
      nextOffsetId,
      __toolText: text,
    };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

function fromIdLabel(m) {
  const from = m?.fromId;
  if (!from) return "";
  const id = from.userId?.value ?? from.chatId?.value ?? from.channelId?.value;
  return id !== undefined ? String(id) : from.toString();
}

/** Delete messages from a chat */
async function actionDeleteMessages(input, context) {
  const phone = String(input.phone || input.account || "").trim();
  const chat = String(input.chat || input.chatId || input.chat_id || input.chat_name || "").trim();
  const ids = input.ids || input.message_ids || input.messageIds || [];
  const deleteAll = input.delete_all === true || input.deleteAll === true;
  const revoke = input.revoke !== false; // default true

  if (!phone) throw new Error("phone required");
  if (!chat) throw new Error("chat (id, username, or title) required");
  if (!deleteAll && (!Array.isArray(ids) || ids.length === 0)) {
    throw new Error("ids (array of message IDs) or delete_all=true required");
  }

  const userDataPath = context?.userDataPath;
  if (!userDataPath) throw new Error("context.userDataPath required");

  const { client } = await createClient(userDataPath, phone);
  try {
    const entity = await resolveChatEntity(client, chat);

    if (deleteAll) {
      // Fetch all messages and delete them in batches
      let totalDeleted = 0;
      const batchSize = 100;
      let allIds = [];

      // Collect all message IDs
      let offsetId = 0;
      while (true) {
        const messages = await client.getMessages(entity, {
          limit: batchSize,
          ...(offsetId ? { offsetId } : {}),
        });
        if (!messages || messages.length === 0) break;
        const batchIds = messages.map((m) => m.id).filter(Boolean);
        if (batchIds.length === 0) break;
        allIds.push(...batchIds);
        offsetId = Math.min(...batchIds);
      }

      // Delete in batches of 100
      for (let i = 0; i < allIds.length; i += 100) {
        const batch = allIds.slice(i, i + 100);
        await client.invoke(new Api.messages.DeleteMessages({
          id: batch,
          revoke,
        }));
        totalDeleted += batch.length;
      }

      return {
        ok: true,
        deleted: totalDeleted,
        message: `✓ Deleted ${totalDeleted} messages from ${entity.name || entity.title || chat}`,
      };
    }

    // Delete specific IDs
    const idArray = Array.isArray(ids) ? ids.map(Number).filter((n) => !isNaN(n)) : [Number(ids)].filter((n) => !isNaN(n));
    if (idArray.length === 0) throw new Error("No valid message IDs provided");

    await client.invoke(new Api.messages.DeleteMessages({
      id: idArray,
      revoke,
    }));

    return {
      ok: true,
      deleted: idArray.length,
      message: `✓ Deleted ${idArray.length} messages from ${entity.name || entity.title || chat}`,
    };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

/** Provide replyTo + topMsgId params for teleproto sendMessage/sendFile/forwardMessages.
 *  teleproto builds InputReplyToMessage itself:
 *    - replyTo + topMsgId  → InputReplyToMessage({ replyToMsgId, topMsgId })  (reply inside topic)
 *    - topMsgId only       → InputReplyToMessage({ replyToMsgId: topicId })  (reply to topic header → lands in topic)
 *    - replyTo only        → InputReplyToMessage({ replyToMsgId })
 *  Do NOT pass replyTo=1 for a topic-only send: that replies to message #1
 *  (which lives in the General/main topic) and drops the message into the main chat. */
function topicReference(input) {
  const value = input.topicId !== undefined ? input.topicId : input.topic !== undefined ? input.topic : input.topMsgId;
  if (value === undefined || value === null || value === "") return null;
  const numericValue = Number(value);
  if (Number.isSafeInteger(numericValue) && numericValue > 0) return numericValue;
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error("topicId must be a positive topic ID or topic title");
}

async function resolveTopicId(client, chat, input) {
  const reference = topicReference(input);
  if (reference === null || typeof reference === "number") return reference;
  const peer = await resolveForumPeer(client, chat);
  const result = await client.invoke(new Api.messages.GetForumTopics({
    peer,
    q: reference,
    offsetDate: 0,
    offsetId: 0,
    offsetTopic: 0,
    limit: 100,
  }));
  const matches = (result?.topics || []).filter((topic) => topic.title?.trim().toLocaleLowerCase() === reference.toLocaleLowerCase());
  if (matches.length !== 1) {
    throw new Error(matches.length ? `Multiple forum topics match "${reference}"; call list_topics and pass its numeric topicId` : `Forum topic "${reference}" not found; call list_topics and pass its numeric topicId`);
  }
  return Number(matches[0].id);
}

function buildReplyParams(replyTo, topicId) {
  const params = {};
  const hasReply = replyTo !== undefined && replyTo !== null && replyTo !== "";
  if (topicId !== null) {
    if (hasReply) params.replyTo = Number(replyTo);
    params.topMsgId = topicId;
  } else if (hasReply) {
    params.replyTo = Number(replyTo);
  }
  return params;
}

function messageTopicId(message) {
  const reply = message?.replyTo || message?.reply_to;
  const value = reply?.replyToTopId ?? reply?.replyToMsgId;
  return Number.isSafeInteger(Number(value)) ? Number(value) : null;
}

async function verifyTopicDelivery(client, entity, resultId, topicId) {
  if (!resultId) return false;
  const messages = await client.getMessages(entity, { ids: [resultId] });
  const message = Array.isArray(messages) ? messages[0] : messages;
  return messageTopicId(message) === topicId;
}

/** Send a message with replyTo support (reply to a specific message) / forum topic support */
async function actionSend(input, context) {
  const phone = String(input.phone || input.account || "").trim();
  const chat = String(input.chat || input.chatId || input.chat_id || input.chat_name || "").trim();
  const text = String(input.text || input.message || input.msg || "").trim();
  const replyTo = input.replyTo;

  if (!phone) throw new Error("phone required");
  if (!chat) throw new Error("chat (id, username, or title) required");
  if (!text) throw new Error("text required");

  const userDataPath = context?.userDataPath;
  if (!userDataPath) throw new Error("context.userDataPath required");

  const { client } = await createClient(userDataPath, phone);
  try {
    const topicId = await resolveTopicId(client, chat, input);
    const entity = topicId !== null ? await resolveForumPeer(client, chat) : await resolveChatEntity(client, chat);
    const result = await client.sendMessage(entity, { message: text, ...buildReplyParams(replyTo, topicId) });
    const topicVerified = topicId !== null ? await verifyTopicDelivery(client, entity, result?.id, topicId) : null;
    if (topicId !== null && !topicVerified) {
      return {
        ok: false,
        resultId: result?.id || null,
        topicId,
        topicVerified: false,
        message: `Message #${result?.id || "unknown"} could not be verified in topic #${topicId}; it was not reported as delivered to that topic.`,
      };
    }
    return {
      ok: true,
      message: `✓ Sent to ${entity.name || entity.title || chat}` + (topicId !== null ? ` (topic #${topicId}, verified)` : replyTo ? ` (reply to #${replyTo})` : ""),
      resultId: result?.id || null,
      replyTo: replyTo || null,
      topicId,
      topicVerified,
    };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

/** Forward messages between chats */
async function actionForward(input, context) {
  const phone = String(input.phone || input.account || "").trim();
  const chat = String(input.chat || input.chatId || input.chat_id || input.chat_name || "").trim();
  const fromChat = String(input.fromChat || input.from_chat || input.from || "").trim();
  let msgIds = input.ids || input.message_ids || input.messageIds || [];
  const text = String(input.text || "").trim();

  if (!phone) throw new Error("phone required");
  if (!chat) throw new Error("chat (target chat id, username, or title) required");
  if (!fromChat) throw new Error("fromChat (source chat id, username, or title) required");
  if (!Array.isArray(msgIds) || msgIds.length === 0) {
    throw new Error("ids (array of message IDs from source chat) required");
  }

  const userDataPath = context?.userDataPath;
  if (!userDataPath) throw new Error("context.userDataPath required");

  msgIds = msgIds.map(Number).filter((n) => !isNaN(n));
  if (msgIds.length === 0) throw new Error("No valid message IDs provided");

  const { client } = await createClient(userDataPath, phone);
  try {
    const targetEntity = await resolveChatEntity(client, chat);
    const fromEntity = await resolveChatEntity(client, fromChat);
    const topicId = input.topicId !== undefined ? input.topicId : input.topic !== undefined ? input.topic : input.topMsgId;
    const topicMsgId = topicId !== undefined && topicId !== null && topicId !== "" ? Number(topicId) : undefined;

    // Forward via raw API so we can target a forum topic (topMsgId)
    const fwdResult = await client.invoke(new Api.messages.ForwardMessages({
      fromPeer: fromEntity,
      id: msgIds,
      toPeer: targetEntity,
      ...(topicMsgId !== undefined ? { topMsgId: topicMsgId } : {}),
      silent: input.silent === true,
      noforwards: input.noforwards === true,
      randomId: msgIds.map(() => BigInt(Math.floor(Math.random() * Number.MAX_SAFE_INTEGER))),
    }));

    let forwardedIds = [];
    const updates = fwdResult?.updates || [];
    for (const up of updates) {
      if (up?.className === "UpdateNewMessage" || up?.className === "UpdateNewChannelMessage") {
        const id = up?.message?.id;
        if (id) forwardedIds.push(id);
      }
    }
    if (!forwardedIds.length && fwdResult?.id) forwardedIds = [fwdResult.id];

    let extra = null;
    if (text) {
      const msgResult = await client.sendMessage(targetEntity, { message: text, ...buildReplyParams(input.replyTo, topicId) });
      extra = { id: msgResult?.id || null };
    }

    return {
      ok: true,
      forwardedIds,
      count: forwardedIds.length,
      message: `✓ Forwarded ${forwardedIds.length} message(s) to ${targetEntity.name || targetEntity.title || chat}`,
      extraMessage: extra,
    };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

/** Pin a message in a chat */
async function actionPin(input, context) {
  const phone = String(input.phone || input.account || "").trim();
  const chat = String(input.chat || input.chatId || input.chat_id || input.chat_name || "").trim();
  const msgId = input.id !== undefined ? Number(input.id) : undefined;
  const notify = input.notify !== false; // default true

  if (!phone) throw new Error("phone required");
  if (!chat) throw new Error("chat required");

  const userDataPath = context?.userDataPath;
  if (!userDataPath) throw new Error("context.userDataPath required");

  const { client } = await createClient(userDataPath, phone);
  try {
    const entity = await resolveChatEntity(client, chat);
    if (msgId === undefined || isNaN(msgId)) {
      // Pin latest message — get the last message first
      const msgs = await client.getMessages(entity, { limit: 1 });
      if (!msgs || msgs.length === 0) {
        throw new Error("No messages in chat to pin");
      }
      const lastMsg = msgs[0];
      await client.pinMessage(entity, lastMsg.id, { notify });
      return {
        ok: true,
        message: `✓ Pinned message #${lastMsg.id} in ${entity.name || entity.title || chat}`,
        pinnedId: lastMsg.id,
      };
    }
    await client.pinMessage(entity, msgId, { notify });
    return {
      ok: true,
      message: `✓ Pinned message #${msgId} in ${entity.name || entity.title || chat}`,
      pinnedId: msgId,
    };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

/** Unpin message(s) in a chat */
async function actionUnpin(input, context) {
  const phone = String(input.phone || input.account || "").trim();
  const chat = String(input.chat || input.chatId || input.chat_id || input.chat_name || "").trim();
  const msgId = input.id !== undefined ? Number(input.id) : undefined;
  const unpinAll = input.all === true || input.unpinAll === true;

  if (!phone) throw new Error("phone required");
  if (!chat) throw new Error("chat required");

  const userDataPath = context?.userDataPath;
  if (!userDataPath) throw new Error("context.userDataPath required");

  const { client } = await createClient(userDataPath, phone);
  try {
    const entity = await resolveChatEntity(client, chat);
    if (unpinAll) {
      await client.unpinMessage(entity, 0); // 0 = unpin all
      return {
        ok: true,
        message: `✓ Unpinned all messages in ${entity.name || entity.title || chat}`,
        unpinnedAll: true,
      };
    }
    if (msgId === undefined || isNaN(msgId)) {
      throw new Error("id (message ID to unpin) or all=true required");
    }
    await client.unpinMessage(entity, msgId);
    return {
      ok: true,
      message: `✓ Unpinned message #${msgId} in ${entity.name || entity.title || chat}`,
      unpinnedId: msgId,
    };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

/** Add/remove reactions on messages */
async function actionReaction(input, context) {
  const phone = String(input.phone || input.account || "").trim();
  const chat = String(input.chat || input.chatId || input.chat_id || input.chat_name || "").trim();
  const msgId = input.id !== undefined ? Number(input.id) : (input.msgId !== undefined ? Number(input.msgId) : undefined);
  const emoji = input.emoji || input.reaction || input.text || "";
  const remove = input.remove === true || input.action === "remove";

  if (!phone) throw new Error("phone required");
  if (!chat) throw new Error("chat required");
  if (msgId === undefined || isNaN(msgId)) throw new Error("id (message ID) required");
  if (!remove && !emoji) throw new Error("emoji (reaction emoji, e.g. 👍) required");

  const userDataPath = context?.userDataPath;
  if (!userDataPath) throw new Error("context.userDataPath required");

  const { client, stringSession } = await createClient(userDataPath, phone);
  try {
    const entity = await resolveChatEntity(client, chat);

    let reaction;
    if (remove) {
      // Empty array = remove reaction
      reaction = [];
    } else {
      reaction = [new Api.ReactionEmoji({ emoticon: emoji })];
    }

    const result = await client.sendReaction(entity, msgId, reaction, input.big === true);
    return {
      ok: true,
      action: remove ? "removed" : "added",
      emoji: remove ? null : emoji,
      msgId,
      message: remove
        ? `✓ Removed reaction from message #${msgId}`
        : `✓ Added ${emoji} reaction to message #${msgId}`,
    };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

/** Click inline button in a bot message */
async function actionClickInline(input, context) {
  const phone = String(input.phone || input.account || "").trim();
  const chat = String(input.chat || input.chatId || input.chat_id || input.chat_name || "").trim();
  const msgId = input.id !== undefined ? Number(input.id) : (input.msgId !== undefined ? Number(input.msgId) : undefined);
  const buttonText = String(input.button || input.button_text || input.text || "").trim();
  const buttonIndex = input.index !== undefined ? Number(input.index) : undefined;

  if (!phone) throw new Error("phone required");
  if (!chat) throw new Error("chat required");
  if (msgId === undefined || isNaN(msgId)) throw new Error("id (message ID with inline keyboard) required");
  if (!buttonText && buttonIndex === undefined) throw new Error("button text or index required");

  const userDataPath = context?.userDataPath;
  if (!userDataPath) throw new Error("context.userDataPath required");

  const { client } = await createClient(userDataPath, phone);
  try {
    const entity = await resolveChatEntity(client, chat);

    // Get the message to read its inline keyboard
    const msgs = await client.getMessages(entity, { ids: [msgId] });
    const message = Array.isArray(msgs) ? msgs[0] : msgs;
    if (!message) throw new Error(`Message #${msgId} not found`);

    // Get the keyboard markup
    const replyMarkup = message.replyMarkup || message.reply_markup;
    if (!replyMarkup) throw new Error(`Message #${msgId} has no inline keyboard`);

    // Collect all buttons
    const buttons = [];
    const rows = replyMarkup.rows || (replyMarkup.constructor?.name === "ReplyInlineMarkup" ? replyMarkup.originalArgs?.rows : null) || [];
    if (!rows.length) {
      // Try flat access
      if (replyMarkup.buttons) {
        rows.push({ buttons: replyMarkup.buttons });
      }
    }
    for (const row of rows) {
      const rowButtons = row.buttons || row;
      for (const btn of rowButtons) {
        if (btn) buttons.push(btn);
      }
    }

    if (buttons.length === 0) throw new Error("No inline buttons found in message");

    // Resolve bot entity
    const bot = message.sender || message.fromId || message.inputChat;
    const msgIdValue = message.id;

    // Find button by text or index
    let selectedBtn;
    if (buttonIndex !== undefined) {
      selectedBtn = buttons[buttonIndex];
      if (!selectedBtn) throw new Error(`Button at index ${buttonIndex} not found (have ${buttons.length} buttons)`);
    } else {
      selectedBtn = buttons.find((b) => {
        const txt = b.text || b.label || "";
        return txt.toLowerCase() === buttonText.toLowerCase();
      });
      if (!selectedBtn) {
        // Try partial match
        selectedBtn = buttons.find((b) => {
          const txt = b.text || b.label || "";
          return txt.toLowerCase().includes(buttonText.toLowerCase());
        });
      }
      if (!selectedBtn) {
        const allLabels = buttons.map((b) => b.text || b.label || "?").join(", ");
        throw new Error(`Button "${buttonText}" not found. Available: [${allLabels}]`);
      }
    }

    // Click the button using MessageButton or direct API call
    const { MessageButton } = require("teleproto/tl/custom/messageButton");
    const btnWrapper = new MessageButton(client, selectedBtn, entity, bot, msgIdValue);
    const result = await btnWrapper.click({});

    return {
      ok: true,
      button: selectedBtn.text || selectedBtn.label || "(unnamed)",
      result: typeof result === "object" ? (result.message || "clicked") : result,
      message: `✓ Clicked inline button "${selectedBtn.text || selectedBtn.label || "(unnamed)"}" on message #${msgIdValue}`,
    };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

function messageText(message) {
  return String(message?.message || message?.text || "").trim();
}

function normalizeDuplicateText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactMessage(message, chat) {
  return {
    id: message?.id || null,
    chat: chat || null,
    date: message?.date ? new Date(Number(message.date) * 1000).toISOString() : "",
    from: message?.sender?.username || message?.sender?.firstName || message?.fromId?.toString() || "",
    text: messageText(message).slice(0, 500),
    hasMedia: Boolean(message?.media),
  };
}

async function invokeMessageSearch(client, input, query, limit) {
  const chat = String(input.chat || input.chatId || input.chat_id || input.chat_name || "").trim();
  if (chat) {
    const entity = await resolveChatEntity(client, chat);
    const topicRaw = input.topicId !== undefined ? input.topicId : input.topic !== undefined ? input.topic : input.topMsgId;
    const topicId = topicRaw !== undefined && topicRaw !== null && topicRaw !== "" ? Number(topicRaw) : undefined;
    const result = await client.invoke(new Api.messages.Search({
      peer: entity,
      q: query,
      filter: new Api.InputMessagesFilterEmpty(),
      offsetId: Number(input.offsetId) || 0,
      limit,
      ...(topicId !== undefined && !isNaN(topicId) && topicId > 0 ? { topMsgId: topicId } : {}),
    }));
    return { messages: Array.isArray(result?.messages) ? result.messages : [], chats: Array.isArray(result?.chats) ? result.chats : [], entity, chat, total: Number(result?.count || 0) };
  }
  const result = await client.invoke(new Api.messages.SearchGlobal({
    q: query,
    filter: new Api.InputMessagesFilterEmpty(),
    offsetRate: Number(input.offsetRate) || 0,
    offsetPeer: new Api.InputPeerEmpty(),
    offsetId: Number(input.offsetId) || 0,
    limit,
  }));
  return { messages: Array.isArray(result?.messages) ? result.messages : [], chats: Array.isArray(result?.chats) ? result.chats : [], entity: null, chat: "", total: Number(result?.count || 0) };
}

function compactChatEntity(c) {
  const type = c.broadcast === true || c.isChannel === true || c.className === "Channel"
    ? "channel"
    : c.megagroup === true || c.isGroup === true || c.className === "Chat"
      ? "group"
      : "chat";
  return {
    id: c.id?.value !== undefined ? String(c.id.value) : String(c.id ?? ""),
    title: c.title || "",
    username: c.username || "",
    type,
    participants: c.participantsCount ?? c.participants_count ?? null,
  };
}

function messageChatLabel(message, foundChat, chatEntities) {
  const peer = message?.peerId;
  const peerId = peer?.channelId?.value ?? peer?.chatId?.value ?? peer?.userId?.value ?? null;
  if (peerId != null) {
    const match = chatEntities.find((c) => String(c.id) === String(peerId));
    if (match && match.title) {
      return match.username ? `@${match.username} | ${match.title}` : `${match.title}`;
    }
  }
  return foundChat || "";
}

async function actionSearchMessages(input, context) {
  const phone = String(input.phone || input.account || "").trim();
  const query = String(input.query || input.q || input.text || input.search || "").trim();
  const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 100);
  if (!phone) throw new Error("phone required");
  if (!query) throw new Error("query required");
  const userDataPath = context?.userDataPath;
  if (!userDataPath) throw new Error("context.userDataPath required");
  const { client } = await createClient(userDataPath, phone);
  try {
    const found = await invokeMessageSearch(client, input, query, limit);
    const chatEntities = (found.chats || []).map(compactChatEntity);
    const messages = found.messages.map((message) =>
      compactMessage(message, messageChatLabel(message, found.chat, chatEntities))
    );
    return {
      ok: true,
      query,
      chat: found.chat || null,
      chats: chatEntities,
      messages,
      count: messages.length,
      total: found.total,
      nextOffsetId: messages.length === limit ? messages[messages.length - 1].id : null,
      message: `Found ${messages.length} message(s) matching the query without loading chat history`,
    };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

async function actionCheckDuplicates(input, context) {
  const query = String(input.query || input.text || input.message || "").trim();
  if (!query) throw new Error("query or text required");
  const result = await actionSearchMessages({ ...input, query, limit: Math.min(Number(input.limit) || 20, 100) }, context);
  const normalized = normalizeDuplicateText(query);
  const matches = result.messages.filter((message) => {
    const candidate = normalizeDuplicateText(message.text);
    return candidate === normalized || candidate.includes(normalized) || normalized.includes(candidate);
  });
  return {
    ok: true,
    duplicate: matches.length > 0,
    query,
    normalizedQuery: normalized,
    matches,
    count: matches.length,
    message: matches.length ? `Duplicate found: ${matches.length} matching message(s)` : "No duplicate message found",
  };
}

async function actionSendFile(input, context) {
  const phone = String(input.phone || input.account || "").trim();
  const chat = String(input.chat || input.chatId || input.chat_id || input.chat_name || "").trim();
  const filePath = String(input.path || input.filePath || input.file_path || input.file || "").trim();
  if (!phone) throw new Error("phone required");
  if (!chat) throw new Error("chat required");
  if (!filePath) throw new Error("path required");
  const userDataPath = context?.userDataPath;
  if (!userDataPath) throw new Error("context.userDataPath required");
  const fileInfo = await fs.promises.stat(filePath).catch(() => null);
  if (!fileInfo?.isFile()) throw new Error(`File not found: ${filePath}`);
  const premium = input.premium === true || input.isPremium === true;
  const maxBytes = premium ? MAX_PREMIUM_UPLOAD_BYTES : MAX_FREE_UPLOAD_BYTES;
  if (fileInfo.size > maxBytes) throw new Error(`File exceeds the ${premium ? "4 GB premium" : "2 GB free"} Telegram upload limit`);
  const jobId = `tg-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  uploadJobs.set(jobId, { status: "queued", path: filePath, size: fileInfo.size, createdAt: Date.now() });
  const job = (async () => {
    let client;
    uploadJobs.set(jobId, { status: "uploading", path: filePath, size: fileInfo.size, startedAt: Date.now() });
    try {
      ({ client } = await createClient(userDataPath, phone));
      const topicId = await resolveTopicId(client, chat, input);
      const entity = topicId !== null ? await resolveForumPeer(client, chat) : await resolveChatEntity(client, chat);
      const options = { file: filePath };
      options.progressCallback = (progress) => {
        const value = typeof progress === "number"
          ? progress
          : Number(progress?.progress ?? progress?.uploaded / progress?.total);
        const ratio = Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0;
        uploadJobs.set(jobId, {
          status: "uploading",
          path: filePath,
          size: fileInfo.size,
          progress: ratio,
          uploaded: Math.round(fileInfo.size * ratio),
          startedAt: uploadJobs.get(jobId)?.startedAt || Date.now(),
        });
      };
      if (input.caption || input.text) options.caption = String(input.caption || input.text);
      Object.assign(options, buildReplyParams(input.replyTo, topicId));
      const result = await client.sendFile(entity, options);
      const topicVerified = topicId !== null ? await verifyTopicDelivery(client, entity, result?.id, topicId) : null;
      if (topicId !== null && !topicVerified) {
        throw new Error(`File message #${result?.id || "unknown"} could not be verified in topic #${topicId}`);
      }
      uploadJobs.set(jobId, { status: "completed", resultId: result?.id || null, topicId, topicVerified, completedAt: Date.now() });
    } catch (error) {
      uploadJobs.set(jobId, { status: "failed", error: error?.message || String(error), completedAt: Date.now() });
    } finally {
      if (client) await client.disconnect().catch(() => {});
    }
  })();
  job.catch(() => {});
  return { ok: true, queued: true, jobId, path: filePath, size: fileInfo.size, message: `Upload queued for ${filePath}. Telegram upload continues in background.` };
}

async function actionUploadStatus(input) {
  const jobId = String(input.jobId || input.job_id || input.id || "").trim();
  if (!jobId) throw new Error("jobId required");
  const job = uploadJobs.get(jobId);
  if (!job) throw new Error(`Upload job not found: ${jobId}`);
  return { ok: true, jobId, ...job };
}

/** Search for chats/users/channels */
async function actionSearch(input, context) {
  const phone = String(input.phone || input.account || "").trim();
  const query = String(input.query || input.q || input.search || "").trim();
  const limit = Math.min(Number(input.limit) || 20, 100);

  if (!phone) throw new Error("phone required");
  if (!query) throw new Error("query required");

  const userDataPath = context?.userDataPath;
  if (!userDataPath) throw new Error("context.userDataPath required");

  const { client } = await createClient(userDataPath, phone);
  try {
    const results = await client.invoke(
      new Api.contacts.Search({
        q: query,
        limit,
      })
    );

    const users = (results.users || []).map((u) => ({
      id: u.id?.toString(),
      firstName: u.firstName || "",
      lastName: u.lastName || "",
      username: u.username || "",
      phone: u.phone || "",
      type: "user",
    }));

    const chats = (results.chats || []).map((c) => ({
      id: c.id?.toString(),
      title: c.title || "",
      username: c.username || "",
      type: c.isChannel ? "channel" : c.isGroup ? "group" : "chat",
    }));

    let text = `🔍 **Search results for "${query}"** (for ${phone}):\n`;
    if (users.length) {
      text += "\n👤 **Users:**\n";
      for (const u of users) {
        text += `  • ${[u.firstName, u.lastName].filter(Boolean).join(" ")} (@${u.username || "—"})\n`;
      }
    }
    if (chats.length) {
      text += "\n💬 **Chats/Channels:**\n";
      for (const c of chats) {
        text += `  • ${c.title} (@${c.username || "—"}) [${c.type}]\n`;
      }
    }
    if (!users.length && !chats.length) text += "\n  No results found.\n";

    return { ok: true, users, chats, count: users.length + chats.length, __toolText: text };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

/** Get current user info */
async function actionGetMe(input, context) {
  const phone = String(input.phone || input.account || "").trim();
  if (!phone) throw new Error("phone required");

  const userDataPath = context?.userDataPath;
  if (!userDataPath) throw new Error("context.userDataPath required");

  const { client } = await createClient(userDataPath, phone);
  try {
    const me = await client.getMe();
    const name = [me.firstName, me.lastName].filter(Boolean).join(" ");
    const info = {
      id: me.id?.toString(),
      phone: me.phone || phone,
      name,
      username: me.username || "",
      isPremium: Boolean(me.premium),
      photo: Boolean(me.photo),
    };

    saveMeta(userDataPath, phone, { phone: info.phone, name, username: info.username });

    let text = `👤 **Account Info:**\n`;
    text += `  Name: ${name}\n`;
    text += `  @${me.username || "—"}\n`;
    text += `  📞 ${me.phone || phone}\n`;
    text += `  ID: ${info.id}\n`;
    text += `  Premium: ${info.isPremium ? "✅ Yes" : "❌ No"}\n`;

    return { ok: true, ...info, __toolText: text };
  } finally {
    await client.disconnect().catch(() => {});
  }
}

/** Config: get or set api_id / api_hash */
async function actionConfig(input, context) {
  const userDataPath = context?.userDataPath;
  if (!userDataPath) throw new Error("context.userDataPath required");

  const apiId = input.apiId || input.api_id || input.apiId;
  const apiHash = input.apiHash || input.api_hash || input.apiHash;

  if (apiId && apiHash) {
    writeConfig(userDataPath, { apiId: Number(apiId), apiHash: String(apiHash) });
    return { ok: true, message: "Telegram API config saved" };
  }

  const cfg = readConfig(userDataPath);
  if (!cfg.apiId || !cfg.apiHash) {
    return {
      ok: true,
      configured: false,
      message:
        "Telegram API not configured. Get api_id and api_hash from https://my.telegram.org/apps " +
        "then call: telegram action=config apiId=12345 apiHash=abc123",
    };
  }

  return {
    ok: true,
    configured: true,
    apiId: cfg.apiId,
    apiHash: cfg.apiHash ? `${String(cfg.apiHash).slice(0, 4)}…` : "",
  };
}

/* ------------------------------------------------------------------ */
/*  Tool status                                                        */
/* ------------------------------------------------------------------ */

async function actionStatus(input, context) {
  const userDataPath = context?.userDataPath;
  if (!userDataPath) throw new Error("context.userDataPath required");

  const cfg = readConfig(userDataPath);
  const accounts = listSessions(userDataPath);

  let text = "📡 **Telegram Tool Status**\n\n";
  text += `Configured: ${cfg.apiId ? "✅ Yes" : "❌ No (action=config first)"}\n`;
  text += `Accounts: ${accounts.length}\n\n`;

  if (accounts.length) {
    text += "📱 **Saved Accounts:**\n";
    for (const a of accounts) {
      const lastSeen = a.lastActive
        ? new Date(a.lastActive).toLocaleString()
        : "never";
      text += `  • ${a.name || "Unnamed"} (@${a.username || "—"}) — ${a.phone}\n`;
      text += `    Last active: ${lastSeen}\n`;
    }
  }

  text += "\n**Login flow (3 шага):**\n";
  text += "  1. login phone=+1234567890 → code sent\n";
  text += "  2. ask_otp → verify phone=+1234567890 code=12345\n";
  text += "  3. (if 2FA) ask_otp → login_password phone=+1234567890 password=xxx\n";
  text += "\n**Available actions:**\n";
  text += "  • login phone=+1234567890 (отправить код)\n";
  text += "  • verify phone=+1234567890 code=12345 (OTP)\n";
  text += "  • login_password phone=+1234567890 password=xxx (2FA)\n";
  text += "  • logout phone=+1234567890\n";
  text += "  • list_accounts\n";
  text += "  • list_chats phone=+1234567890 [all=true|archived=true]\n";
  text += "  • get_dialog phone=+1234567890 chat=@username [limit=20] [offsetId=<last_id>] [topicId=<topic_id>]\n";
  text += "  • delete_messages phone=+1234567890 chat=@username ids=[1,2,3] (or delete_all=true)\n";
  text += "  • send phone=+1234567890 chat=@forum text=\"Hello!\" [replyTo=123] [topicId=456|topic=\"Exact topic title\"]\n";
  text += "  • send_file phone=+1234567890 chat=@forum path=\"C:/file.pdf\" [caption=...] [topicId=456|topic=\"Exact topic title\"]\n";
  text += "  • forward phone=+1234567890 chat=@target fromChat=@source ids=[1,2,3] [topicId=456]\n";
  text += "  • pin phone=+1234567890 chat=@username id=123\n";
  text += "  • unpin phone=+1234567890 chat=@username id=123 (or all=true)\n";
  text += "  • reaction phone=+1234567890 chat=@username id=123 emoji=👍 (or remove=true)\n";
  text += "  • list_topics phone=+1234567890 chat=@forum\n";
  text += "  • create_topic phone=+1234567890 chat=@forum title=\"Topic title\"\n";
  text += "  • edit_topic phone=+1234567890 chat=@forum topicId=123 title=\"New title\" [closed=true|hidden=true]\n";
  text += "  • delete_topic phone=+1234567890 chat=@forum topicId=123\n";
  text += "  • click_inline phone=+1234567890 chat=@username id=123 button=\"Button text\"\n";
  text += "  • search phone=+1234567890 query=username\n";
  text += "  • get_me phone=+1234567890\n";
  text += "  • config apiId=12345 apiHash=abc\n";

  return { ok: true, configured: Boolean(cfg.apiId), accounts, count: accounts.length, __toolText: text };
}

/* ------------------------------------------------------------------ */
/*  Main handler                                                       */
/* ------------------------------------------------------------------ */

async function execute(input = {}, context = {}) {
  const action = String(input.action || input.command || "").trim().toLowerCase();
  if (!action) throw new Error("action required: login, verify, login_password, logout, list_accounts, list_chats, get_dialog, search_messages, check_duplicates, send, send_file, upload_status, forward, pin, unpin, reaction, list_topics, create_topic, edit_topic, delete_topic, click_inline, delete_messages, search, get_me, config, status");

  const handlers = {
    login: actionSendCode,
    wait: actionVerify,
    wait_otp: actionVerify,
    verify: actionVerify,
    verify_code: actionVerify,
    verifycode: actionVerify,
    login_password: actionLoginPassword,
    loginpassword: actionLoginPassword,
    password: actionLoginPassword,
    logout: actionLogout,
    list_accounts: actionListAccounts,
    listaccounts: actionListAccounts,
    list_chats: actionListChats,
    listchats: actionListChats,
    get_dialog: actionGetDialog,
    getdialog: actionGetDialog,
    dialog: actionGetDialog,
    delete_messages: actionDeleteMessages,
    deletemessages: actionDeleteMessages,
    deleteMessages: actionDeleteMessages,
    delete: actionDeleteMessages,
    send: actionSend,
    forward: actionForward,
    forward_messages: actionForward,
    forwardMessages: actionForward,
    pin: actionPin,
    pin_message: actionPin,
    pinMessage: actionPin,
    unpin: actionUnpin,
    unpin_message: actionUnpin,
    unpinMessage: actionUnpin,
    reaction: actionReaction,
    add_reaction: actionReaction,
    remove_reaction: actionReaction,
    list_topics: actionListTopics,
    listtopics: actionListTopics,
    topics: actionListTopics,
    create_topic: actionCreateTopic,
    createtopic: actionCreateTopic,
    edit_topic: actionEditTopic,
    edittopic: actionEditTopic,
    rename_topic: actionEditTopic,
    delete_topic: actionDeleteTopic,
    deletetopic: actionDeleteTopic,
    click_inline: actionClickInline,
    clickInline: actionClickInline,
    search: actionSearch,
    search_messages: actionSearchMessages,
    find_posts: actionSearchMessages,
    searchmessages: actionSearchMessages,
    find_messages: actionSearchMessages,
    check_duplicates: actionCheckDuplicates,
    checkduplicates: actionCheckDuplicates,
    duplicate_check: actionCheckDuplicates,
    send_file: actionSendFile,
    sendfile: actionSendFile,
    upload_file: actionSendFile,
    upload_status: actionUploadStatus,
    uploadstatus: actionUploadStatus,
    get_me: actionGetMe,
    getme: actionGetMe,
    me: actionGetMe,
    config: actionConfig,
    status: actionStatus,
  };

  const handler = handlers[action];
  if (!handler) {
    throw new Error(
      `Unknown action "${action}". Available: login, wait, verify, login_password, logout, list_accounts, list_chats, get_dialog, search_messages, check_duplicates, send, send_file, upload_status, forward, pin, unpin, reaction, list_topics, create_topic, edit_topic, delete_topic, click_inline, delete_messages, search, get_me, config, status`
    );
  }

  return handler(input, context);
}

/* ------------------------------------------------------------------ */
/*  Module exports                                                     */
/* ------------------------------------------------------------------ */

module.exports = {
  name: "telegram",
  description:
    "Telegram MTProto client (teleproto) for accounts and chats. " +
    "Sessions are stored as tdata in userData/tdata/. " +
    "Login flow: 1) login phone (send code), 2) verify phone code (OTP), 3) login_password phone password (2FA). " +
    "Actions: send (or reply with replyTo), forward, pin/unpin, reaction, " +
    "list_topics/create_topic/edit_topic/delete_topic (forum topics), click_inline, " +
    "delete_messages, get_dialog (read a paginated dialog with offsetId), " +
    "list_chats, list_accounts, search/search_messages/find_posts, check_duplicates, send_file/upload_status, get_me, config, and status. " +
    "Call ask_otp between authentication steps. Requires api_id/api_hash from my.telegram.org.",
  isReadOnly: false,
  inputSchema: {
    type: "object",
    properties: {
      action: {
        type: "string",
        description:
          "login (send code), verify (OTP), login_password (2FA), logout, list_accounts, list_chats (including archive), " +
          "get_dialog (paginated messages via offsetId), send (or reply with replyTo), forward, pin, unpin, reaction, " +
          "list_topics/create_topic/edit_topic/delete_topic (forum topics), click_inline, delete_messages, " +
          "search/search_messages/find_posts, check_duplicates, send_file (background upload), upload_status, get_me, config, status",
      },
      phone: { type: "string", description: "Phone number in international format, for example +1234567890." },
      account: { type: "string", description: "Alias for phone: a number or account name." },
      code: { type: "string", description: "SMS OTP for verify." },
      otp: { type: "string", description: "Alias for code." },
      password: { type: "string", description: "2FA password for login_password." },
      pass: { type: "string", description: "Alias for password." },
      chat: { type: "string", description: "Chat @username, numeric ID, or a name returned by list_chats." },
      chatId: { type: "string", description: "Alias for chat." },
      chat_id: { type: "string", description: "Alias for chat." },
      chat_name: { type: "string", description: "Alias for chat." },
      text: { type: "string", description: "Message text for send, search_messages, or check_duplicates." },
      message: { type: "string", description: "Alias for text." },
      replyTo: { type: "number", description: "send/send_file: ID of the message to reply to." },
      topicId: { type: "string", description: "Forum topic for send/send_file/forward: numeric ID from list_topics or an exact topic name. Reading and editing require the numeric ID. Aliases: topic, topMsgId." },
      topic: { type: "string", description: "Alias for topicId; exact topic name is allowed for send/send_file." },
      topMsgId: { type: "number", description: "Alias for topicId when using a numeric forum-topic ID." },
      path: { type: "string", description: "send_file: absolute path to a supported Telegram file." },
      filePath: { type: "string", description: "Alias for path." },
      file_path: { type: "string", description: "Alias for path." },
      file: { type: "string", description: "Alias for path." },
      caption: { type: "string", description: "Caption for the uploaded file." },
      premium: { type: "boolean", description: "send_file: true for a Telegram Premium account; otherwise the limit is 2 GB." },
      isPremium: { type: "boolean", description: "Alias for premium." },
      jobId: { type: "string", description: "Background-upload ID for upload_status." },
      job_id: { type: "string", description: "Alias for jobId." },
      offsetRate: { type: "number", description: "Continuation offset for global search_messages." },
      query: { type: "string", description: "Search query for search, search_messages, or check_duplicates." },
      q: { type: "string", description: "Alias for query." },
      limit: { type: "number", description: "Result limit: chats up to 500, messages up to 200, search up to 100." },
      archived: { type: "boolean", description: "list_chats: show archived chats; all=true includes every chat." },
      all: { type: "boolean", description: "list_chats: show all chats including the archive." },
      apiId: { type: "number", description: "api_id from my.telegram.org for action=config." },
      api_id: { type: "number", description: "Alias for apiId." },
      apiHash: { type: "string", description: "api_hash from my.telegram.org for action=config." },
      api_hash: { type: "string", description: "Alias for apiHash." },
      ids: { type: "array", items: { type: "number" }, description: "Message IDs for delete_messages." },
      message_ids: { type: "array", items: { type: "number" }, description: "Alias for ids." },
      messageIds: { type: "array", items: { type: "number" }, description: "Alias for ids." },
      delete_all: { type: "boolean", description: "delete_messages: delete every message in the chat." },
      deleteAll: { type: "boolean", description: "Alias for delete_all." },
      revoke: { type: "boolean", description: "delete_messages: revoke for everyone; defaults to true." },
      fromChat: { type: "string", description: "forward: source chat ID, @username, or name." },
      from_chat: { type: "string", description: "Alias for fromChat." },
      from: { type: "string", description: "Alias for fromChat." },
      id: { type: "number", description: "Message ID for pin, unpin, reaction, or click_inline." },
      msgId: { type: "number", description: "Alias for id." },
      notify: { type: "boolean", description: "pin: notify members; defaults to true." },
      unpinAll: { type: "boolean", description: "unpin: remove all pins; alias for all." },
      emoji: { type: "string", description: "reaction emoji, for example 👍." },
      reaction: { type: "string", description: "Alias for emoji." },
      remove: { type: "boolean", description: "reaction: remove the reaction." },
      big: { type: "boolean", description: "reaction: use an animated or large reaction." },
      button: { type: "string", description: "click_inline: button text to click." },
      button_text: { type: "string", description: "Alias for button." },
      index: { type: "number", description: "click_inline: zero-based button index; alternative to button." },
      offsetId: { type: "number", description: "get_dialog: return messages before this ID for pagination." },
      title: { type: "string", description: "Forum-topic title." },
      offsetDate: { type: "number", description: "list_topics pagination: Unix timestamp." },
      offsetTopic: { type: "number", description: "list_topics pagination: topic ID." },
      iconEmojiId: { type: "string", description: "Forum-topic icon emoji ID." },
      closed: { type: "boolean", description: "Close or reopen a topic." },
      hidden: { type: "boolean", description: "Hide or show a topic." },
      randomId: { type: "string", description: "Unique topic-creation ID." },
    },
    required: [],
  },

  execute,
};
