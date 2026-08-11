const TELEGRAM_LIMIT = 4096;
const SAFE_CHUNK_SIZE = 3800;

function normalizeTelegramConfig(config) {
  const source = config && typeof config === "object" ? config : {};
  const allowedChatIds = Array.isArray(source.allowedChatIds)
    ? source.allowedChatIds.map((id) => String(id).trim()).filter(Boolean)
    : [];
  const botToken = typeof source.botToken === "string" ? source.botToken.trim() : "";
  return {
    enabled: Boolean(source.enabled),
    botToken,
    allowedChatIds,
  };
}

function splitTelegramText(text) {
  const value = String(text || "").trim() || "[empty]";
  if (value.length <= TELEGRAM_LIMIT) return [value];
  const chunks = [];
  let rest = value;
  while (rest.length > SAFE_CHUNK_SIZE) {
    let cut = rest.lastIndexOf("\n", SAFE_CHUNK_SIZE);
    if (cut < SAFE_CHUNK_SIZE * 0.6) cut = rest.lastIndexOf(" ", SAFE_CHUNK_SIZE);
    if (cut < SAFE_CHUNK_SIZE * 0.6) cut = SAFE_CHUNK_SIZE;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).trimStart();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

function truncateOneLine(value, max = 120) {
  const text = String(value ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** Short 1-line hint for tool input — never dump full payloads. */
function summarizeToolInput(name, input) {
  const data = input && typeof input === "object" ? input : {};
  const pick =
    data.path ||
    data.file_path ||
    data.filePath ||
    data.command ||
    data.query ||
    data.pattern ||
    data.url ||
    data.question ||
    data.id ||
    data.title ||
    "";
  if (name === "bash" && data.command) return truncateOneLine(data.command, 100);
  if (name === "ask_user" && data.question) return truncateOneLine(data.question, 100);
  if (name === "ask_otp") {
    const kind = data.kind || data.action || "otp";
    const dest = data.destination || data.email || data.phone || data.site || "";
    return truncateOneLine(dest ? `${kind} · ${dest}` : String(kind), 100);
  }
  if (pick) return truncateOneLine(pick, 100);
  const keys = Object.keys(data);
  if (!keys.length) return "";
  return truncateOneLine(keys.slice(0, 4).join(", "), 80);
}

/** Short 1-line hint for tool result — never wall-of-text dumps. */
function summarizeToolResult(name, result, ok) {
  if (!ok) {
    const err =
      typeof result === "string"
        ? result
        : result?.error || result?.message || JSON.stringify(result ?? "");
    return truncateOneLine(err, 140);
  }
  if (result == null) return "ok";
  if (typeof result === "string") return truncateOneLine(result, 100) || "ok";
  if (typeof result === "object") {
    if (name === "ask_user") {
      const selected = Array.isArray(result.selected) ? result.selected.join(", ") : "";
      const answer = result.answer || selected;
      return answer ? truncateOneLine(answer, 100) : "answered";
    }
    if (name === "ask_otp") {
      if (result.code) return truncateOneLine(`code · ${String(result.code).slice(0, 4)}…`, 80);
      if (result.email) return truncateOneLine(result.email, 100);
      if (result.phone) return truncateOneLine(result.phone, 100);
      if (result.identity?.email) return truncateOneLine(result.identity.email, 100);
      if (result.action) return truncateOneLine(String(result.action), 80);
      return "ok";
    }
    if (typeof result.content === "string") return truncateOneLine(result.content, 80);
    if (typeof result.text === "string") return truncateOneLine(result.text, 80);
    if (typeof result.path === "string") return truncateOneLine(result.path, 100);
    if (Array.isArray(result.files)) return `${result.files.length} files`;
    if (Array.isArray(result.entries)) return `${result.entries.length} entries`;
    if (typeof result.count === "number") return `count ${result.count}`;
    if (result.ok === true) return "ok";
  }
  return "ok";
}

function buildAskUserKeyboard(options, multiSelect) {
  const rows = [];
  for (let i = 0; i < options.length; i += 1) {
    const label = truncateOneLine(options[i], 40) || `Option ${i + 1}`;
    rows.push([{ text: label, callback_data: `ask:${i}` }]);
  }
  if (multiSelect && options.length > 0) {
    rows.push([{ text: "✓ Confirm selection", callback_data: "ask:ok" }]);
  }
  return rows.length ? { inline_keyboard: rows } : undefined;
}

/** Reply keyboard for Telegram bot control. */
function buildMainKeyboard() {
  return {
    keyboard: [[{ text: "🆕 New session" }, { text: "⏹ Stop" }]],
    resize_keyboard: true,
    is_persistent: true,
    input_field_placeholder: "Type a task for the ComposeVC agent…",
  };
}

function normalizeCommandText(text) {
  const value = String(text || "").trim();
  const normalized = value.toLowerCase();
  if (["/start", "/help", "help"].includes(normalized)) return "/help";
  if (["/new", "🆕 new session", "new session", "new"].includes(normalized)) return "/new";
  if (["/stop", "⏹ stop", "stop"].includes(normalized)) return "/stop";
  return value;
}

function withMainKeyboard(options = {}) {
  return { reply_markup: buildMainKeyboard(), ...options };
}

function createTelegramBot({
  onUserMessage,
  onNewSession,
  onStop,
  onAskUserAnswer,
}) {
  let state = {
    config: normalizeTelegramConfig({}),
    running: false,
    offset: 0,
    pollTimer: null,
    busyChats: new Set(),
    botUsername: "",
    lastError: null,
    lastOkAt: 0,
    /** chatId -> pending ask_user|ask_otp { toolCallId, mode, question, options, multiSelect, allowFreeText, selected:Set, answered, digits } */
    pendingAsks: new Map(),
  };

  const api = async (method, payload) => {
    const token = state.config.botToken;
    if (!token) throw new Error("Telegram bot token is empty");
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload || {}),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data?.ok) throw new Error(data?.description || `Telegram API ${method} failed`);
    return data.result;
  };

  const getStatus = () => {
    let reason = null;
    if (state.running) reason = null;
    else if (!state.config.botToken) reason = "no_token";
    else if (!state.config.enabled) reason = "disabled";
    else if (state.lastError) reason = "error";
    else reason = "stopped";
    return {
      ...state.config,
      running: state.running,
      botUsername: state.botUsername || "",
      lastError: state.lastError,
      lastOkAt: state.lastOkAt || 0,
      reason,
    };
  };

  const isAllowed = (chatId) => {
    const allowed = state.config.allowedChatIds;
    return allowed.length === 0 || allowed.includes(String(chatId));
  };

  const mainKeyboard = () => buildMainKeyboard();

  const sendMessage = async (chatId, text, options = {}) => {
    // Progress/status lines: do not re-attach main reply keyboard every time (spammy).
    // Only attach main keyboard when caller did not pass reply_markup.
    // Explicit `reply_markup: undefined` means "no keyboard" (omit field — Telegram rejects null/undefined).
    const hasMarkupKey = Object.prototype.hasOwnProperty.call(options, "reply_markup");
    const { reply_markup: markupOpt, ...restOptions } = options;
    const replyMarkup = hasMarkupKey
      ? markupOpt === undefined || markupOpt === null
        ? undefined
        : markupOpt
      : mainKeyboard();
    for (const chunk of splitTelegramText(text)) {
      const payload = {
        chat_id: chatId,
        text: chunk,
        disable_web_page_preview: true,
        ...restOptions,
      };
      if (replyMarkup !== undefined) payload.reply_markup = replyMarkup;
      await api("sendMessage", payload);
    }
  };

  const answerCallback = async (callbackQueryId, text) => {
    try {
      await api("answerCallbackQuery", {
        callback_query_id: callbackQueryId,
        text: text ? truncateOneLine(text, 180) : undefined,
        show_alert: false,
      });
    } catch (error) {
      console.error("Telegram answerCallbackQuery failed:", error?.message || error);
    }
  };

  const clearPendingAsk = (chatId) => {
    state.pendingAsks.delete(String(chatId));
  };

  const deliverAskAnswer = async (chatId, pending, { answer = "", selected = [] } = {}) => {
    if (!pending || pending.answered) return { ok: false, error: "already answered" };
    pending.answered = true;
    clearPendingAsk(chatId);
    const isOtp = pending.mode === "otp";
    const payload = {
      toolCallId: pending.toolCallId,
      answer: String(answer || "").trim(),
      selected: Array.isArray(selected) ? selected.map(String) : [],
    };
    if (!payload.answer && payload.selected.length) {
      payload.answer = payload.selected.join(", ");
    }
    if (isOtp && !payload.answer) {
      pending.answered = false;
      state.pendingAsks.set(String(chatId), pending);
      await sendMessage(chatId, "Empty code. Paste the OTP and send again.", {
        reply_markup: {
          force_reply: true,
          selective: true,
          input_field_placeholder: pending.digits > 0 ? `${pending.digits}-digit code` : "OTP code",
        },
      });
      return { ok: false, error: "empty otp" };
    }
    try {
      if (typeof onAskUserAnswer === "function") {
        const result = await onAskUserAnswer(payload);
        if (result && result.ok === false) {
          pending.answered = false;
          state.pendingAsks.set(String(chatId), pending);
          await sendMessage(chatId, `Could not deliver answer: ${result.error || "unknown"}`, {
            reply_markup: mainKeyboard(),
          });
          return result;
        }
      }
      if (isOtp) {
        const code = payload.answer;
        const masked =
          code.length <= 4 ? "•".repeat(Math.min(code.length, 4)) : `${code.slice(0, 2)}${"•".repeat(Math.min(6, code.length - 2))}`;
        await sendMessage(chatId, `✓ OTP sent to agent (${masked})`, {
          reply_markup: mainKeyboard(),
        });
      } else {
        const shown = payload.selected.length
          ? payload.selected.join(", ")
          : payload.answer || "(empty)";
        await sendMessage(chatId, `✓ answer sent: ${truncateOneLine(shown, 160)}`, {
          reply_markup: mainKeyboard(),
        });
      }
      return { ok: true };
    } catch (error) {
      console.error("Telegram ask deliver failed:", error?.message || error);
      pending.answered = false;
      state.pendingAsks.set(String(chatId), pending);
      await sendMessage(chatId, `Answer failed: ${error?.message || error}`, {
        reply_markup: mainKeyboard(),
      }).catch(() => {});
      return { ok: false, error: error?.message || String(error) };
    }
  };

  const sendAskUserPrompt = async (chatId, progress) => {
    const input = progress.input && typeof progress.input === "object" ? progress.input : {};
    const question = String(input.question || "").trim() || "Choose an option:";
    const options = Array.isArray(input.options)
      ? input.options.map((o) => String(o || "").trim()).filter(Boolean).slice(0, 6)
      : [];
    const multiSelect = input.multi_select === true;
    const allowFreeText = input.allow_free_text !== false;
    const toolCallId = progress.toolCallId || progress.id || `ask-${Date.now()}`;

    // Replace any previous pending ask for this chat.
    state.pendingAsks.set(String(chatId), {
      toolCallId: String(toolCallId),
      mode: "ask",
      question,
      options,
      multiSelect,
      allowFreeText,
      selected: new Set(),
      answered: false,
      digits: 0,
    });

    const lines = ["❓ ask_user", question];
    if (options.length) {
      lines.push("");
      options.forEach((opt, i) => lines.push(`${i + 1}. ${opt}`));
      if (multiSelect) lines.push("", "Multi-select: tap options, then Confirm.");
      else lines.push("", "Tap a button, or type the answer.");
    } else {
      lines.push("", "Type your answer in chat.");
    }
    if (allowFreeText && options.length) lines.push("Free text is also accepted.");

    const keyboard = buildAskUserKeyboard(options, multiSelect);
    try {
      await sendMessage(chatId, lines.join("\n"), {
        reply_markup: keyboard || {
          force_reply: true,
          selective: true,
          input_field_placeholder: "Your answer…",
        },
      });
    } catch (error) {
      clearPendingAsk(chatId);
      console.error("Telegram ask_user send failed:", error?.message || error);
      try {
        if (typeof onAskUserAnswer === "function") {
          await onAskUserAnswer({
            toolCallId: String(toolCallId),
            answer: `Telegram delivery failed: ${error?.message || error}`,
            selected: [],
          });
        }
      } catch (deliverErr) {
        console.error("Telegram ask_user fail-deliver:", deliverErr?.message || deliverErr);
      }
      throw error;
    }
  };

  const sendAskOtpPrompt = async (chatId, progress) => {
    const input = progress.input && typeof progress.input === "object" ? progress.input : {};
    const kind = String(input.kind || "otp").toLowerCase();
    const dest = String(input.destination || input.email || input.phone || "").trim();
    const site = String(input.site || input.service || "").trim();
    const digits = Math.max(0, Math.min(12, Number(input.digits) || 0));
    const custom = String(input.message || input.context || "").trim();
    const hint = String(input.hint || "").trim();
    const toolCallId = progress.toolCallId || progress.id || `otp-${Date.now()}`;

    const title =
      kind === "email" || kind === "mail"
        ? "📧 Email code"
        : kind === "sms" || kind === "phone"
          ? "📱 SMS code"
          : kind === "app" || kind === "totp"
            ? "🔐 App / 2FA"
            : "🔑 Verification code";

    const question =
      custom ||
      [title, site ? `· ${site}` : "", dest ? `\nSent to: ${dest}` : "", "\n\nReply with the code to continue."]
        .filter(Boolean)
        .join(" ");

    state.pendingAsks.set(String(chatId), {
      toolCallId: String(toolCallId),
      mode: "otp",
      question,
      options: [],
      multiSelect: false,
      allowFreeText: true,
      selected: new Set(),
      answered: false,
      digits,
      kind,
      destination: dest,
      site,
    });

    const lines = ["🔑 ask_otp — agent paused", title + (site ? ` · ${site}` : "")];
    if (dest) lines.push(`To: ${dest}`);
    if (digits > 0) lines.push(`Expect ~${digits} digits`);
    if (hint) lines.push(hint);
    if (custom) lines.push("", custom);
    lines.push("", "Paste the code here and send. /stop cancels.");

    try {
      await sendMessage(chatId, lines.join("\n"), {
        reply_markup: {
          force_reply: true,
          selective: true,
          input_field_placeholder: digits > 0 ? `${digits}-digit code` : "OTP / verification code",
        },
      });
    } catch (error) {
      clearPendingAsk(chatId);
      console.error("Telegram ask_otp send failed:", error?.message || error);
      try {
        if (typeof onAskUserAnswer === "function") {
          await onAskUserAnswer({
            toolCallId: String(toolCallId),
            answer: `Telegram delivery failed: ${error?.message || error}`,
            selected: [],
          });
        }
      } catch (deliverErr) {
        console.error("Telegram ask_otp fail-deliver:", deliverErr?.message || deliverErr);
      }
      throw error;
    }
  };

  const kb = () => withMainKeyboard();

  const sendHelp = (chatId) =>
    sendMessage(
      chatId,
      [
        "ComposeVC agent control:",
        "Buttons: New session · Stop",
        "/new — create a new IDE chat session",
        "/stop — stop current generation",
        "/help — this message",
        "Any other text is sent to the dedicated Telegram IDE session.",
        "ask_user: option buttons or free text.",
        "ask_otp: paste the verification code in this chat (force-reply).",
      ].join("\n"),
      kb()
    );

  const handleMessage = async (message) => {
    const chatId = message?.chat?.id;
    const text = normalizeCommandText(message?.text || "");
    if (!chatId || !text) return;
    if (!isAllowed(chatId)) {
      await sendMessage(
        chatId,
        `Chat ${chatId} is not allowed. Add it in Telegram allowed chat IDs for this chat’s bot.`
      );
      return;
    }

    // Pending ask_user / ask_otp: free-text goes to the agent, not a new run.
    const pending = state.pendingAsks.get(String(chatId));
    if (pending && !pending.answered) {
      if (text === "/stop") {
        clearPendingAsk(chatId);
        const stopped = await onStop?.();
        return sendMessage(chatId, stopped ? "Stop requested." : "No active generation.", kb());
      }
      if (text === "/start" || text === "/help") return sendHelp(chatId);
      if (text === "/new") {
        // keep pending ask; only create session
      } else {
        return deliverAskAnswer(chatId, pending, { answer: text, selected: [] });
      }
    }

    if (text === "/start" || text === "/help") return sendHelp(chatId);
    if (text === "/stop") {
      clearPendingAsk(chatId);
      const stopped = await onStop?.();
      return sendMessage(chatId, stopped ? "Stop requested." : "No active generation.", kb());
    }
    if (text === "/new") {
      const session = await onNewSession?.(String(chatId));
      return sendMessage(chatId, `New IDE chat session: ${session?.sessionId || "created"}`, kb());
    }

    if (state.busyChats.has(String(chatId))) {
      await sendMessage(
        chatId,
        "This chat already has an active agent run. Wait for completion, answer ask_user/ask_otp, or send /stop.",
        kb()
      );
      return;
    }

    state.busyChats.add(String(chatId));
    try {
      await sendMessage(
        chatId,
        "Sent to ComposeVC agent. Short tool status + final answer will appear here.",
        { reply_markup: mainKeyboard() }
      );
      await onUserMessage?.({
        chatId: String(chatId),
        text,
      });
    } finally {
      state.busyChats.delete(String(chatId));
    }
  };

  const handleCallbackQuery = async (query) => {
    const chatId = query?.message?.chat?.id;
    const data = String(query?.data || "");
    const callbackId = query?.id;
    if (!chatId || !callbackId) return;
    if (!isAllowed(chatId)) {
      await answerCallback(callbackId, "Chat not allowed");
      return;
    }

    const pending = state.pendingAsks.get(String(chatId));
    if (!pending || pending.answered) {
      await answerCallback(callbackId, "No pending question");
      return;
    }
    if (!data.startsWith("ask:")) {
      await answerCallback(callbackId, "Unknown action");
      return;
    }

    const action = data.slice(4);
    if (action === "ok") {
      // Confirm multi-select
      const selected = [...pending.selected];
      if (!selected.length) {
        await answerCallback(callbackId, "Pick at least one option");
        return;
      }
      await answerCallback(callbackId, "Sending…");
      await deliverAskAnswer(chatId, pending, { selected, answer: selected.join(", ") });
      return;
    }

    const index = Number(action);
    if (!Number.isInteger(index) || index < 0 || index >= pending.options.length) {
      await answerCallback(callbackId, "Invalid option");
      return;
    }

    const label = pending.options[index];
    if (pending.multiSelect) {
      if (pending.selected.has(label)) pending.selected.delete(label);
      else pending.selected.add(label);
      const picked = [...pending.selected];
      await answerCallback(
        callbackId,
        picked.length ? `Selected: ${truncateOneLine(picked.join(", "), 160)}` : "Cleared"
      );
      return;
    }

    await answerCallback(callbackId, truncateOneLine(label, 160));
    await deliverAskAnswer(chatId, pending, { selected: [label], answer: label });
  };

  const pollOnce = async () => {
    if (!state.running || !state.config.botToken) return;
    try {
      const updates = await api("getUpdates", {
        offset: state.offset,
        timeout: 25,
        allowed_updates: ["message", "callback_query"],
      });
      state.lastOkAt = Date.now();
      state.lastError = null;
      for (const update of updates || []) {
        state.offset = Math.max(state.offset, Number(update.update_id || 0) + 1);
        // CRITICAL: never await long agent runs inside the poll loop.
        // ask_user waits for a callback_query; if we block here, getUpdates never
        // runs again and the answer can never arrive (infinite loading).
        if (update.callback_query) {
          void handleCallbackQuery(update.callback_query).catch((error) => {
            console.error("Telegram callback failed:", error?.message || error);
          });
          continue;
        }
        if (update.message) {
          void handleMessage(update.message).catch((error) => {
            const chatId = update.message?.chat?.id;
            if (chatId) {
              sendMessage(chatId, `Telegram command failed: ${error?.message || error}`).catch(() => {});
            }
          });
        }
      }
    } catch (error) {
      state.lastError = error?.message || String(error);
      console.error("Telegram polling failed:", state.lastError);
    } finally {
      // Keep polling even while agent runs / ask_user is pending.
      if (state.running) state.pollTimer = setTimeout(pollOnce, 400);
    }
  };

  const stop = () => {
    state.running = false;
    if (state.pollTimer) clearTimeout(state.pollTimer);
    state.pollTimer = null;
  };

  const start = () => {
    if (state.running) return getStatus();
    if (!state.config.enabled) {
      state.lastError = null;
      return getStatus();
    }
    if (!state.config.botToken) {
      state.lastError = "Bot token is empty";
      return getStatus();
    }

    state.running = true;
    state.lastError = null;

    // Validate token with getMe, then begin long-polling.
    void (async () => {
      try {
        const me = await api("getMe");
        if (!state.running) return;
        state.botUsername = me?.username ? String(me.username) : "";
        state.lastOkAt = Date.now();
        state.lastError = null;
        console.log(`Telegram bot started as @${state.botUsername || "unknown"}`);
        void pollOnce();
      } catch (error) {
        state.lastError = error?.message || String(error);
        state.running = false;
        state.botUsername = "";
        console.error("Telegram bot failed to start:", state.lastError);
      }
    })();

    return getStatus();
  };

  const configure = (config) => {
    const next = normalizeTelegramConfig(config);
    const tokenChanged = next.botToken !== state.config.botToken;
    stop();
    state.config = next;
    if (tokenChanged) {
      state.offset = 0;
      state.botUsername = "";
      state.pendingAsks.clear();
    }
    if (!next.enabled || !next.botToken) {
      state.lastError = null;
    }
    start();
    return getStatus();
  };

  const notifyProgress = async (chatId, progress) => {
    if (!chatId || !state.running || !progress) return;
    try {
      if (progress.type === "tool_start") {
        // ask_user: rich prompt + buttons instead of generic tool dump
        if (progress.name === "ask_user") {
          await sendAskUserPrompt(chatId, progress);
          return;
        }
        // ask_otp wait: free-text code prompt (generate_* is a normal short status)
        if (progress.name === "ask_otp") {
          const input = progress.input && typeof progress.input === "object" ? progress.input : {};
          const action = String(input.action || "wait").toLowerCase();
          if (!action.startsWith("generate")) {
            await sendAskOtpPrompt(chatId, progress);
            return;
          }
        }
        const hint = summarizeToolInput(progress.name, progress.input);
        await sendMessage(chatId, hint ? `▶ ${progress.name} · ${hint}` : `▶ ${progress.name}`, {
          reply_markup: undefined,
        });
        return;
      }

      if (progress.type === "tool_end") {
        // ask_user / ask_otp end is already acknowledged when the user answered
        if (progress.name === "ask_user") return;
        if (progress.name === "ask_otp") {
          const input = progress.input && typeof progress.input === "object" ? progress.input : {};
          const action = String(input.action || "wait").toLowerCase();
          if (!action.startsWith("generate")) return;
        }
        const mark = progress.ok ? "✓" : "✕";
        const hint = summarizeToolResult(progress.name, progress.result, progress.ok);
        await sendMessage(chatId, `${mark} ${progress.name} · ${hint}`, {
          reply_markup: undefined,
        });
        return;
      }

      // Skip mid-turn assistant drafts — too noisy; final answer is sent separately.
      if (progress.type === "assistant_text") return;

      if (progress.type === "retry") {
        await sendMessage(
          chatId,
          `↻ retry ${progress.attempt}/${progress.maxRetries}: ${truncateOneLine(progress.reason || "provider error", 120)}`,
          { reply_markup: undefined }
        );
        return;
      }
      if (progress.type === "compact_start") {
        await sendMessage(chatId, `compact… (${progress.reason || "auto"})`, { reply_markup: undefined });
        return;
      }
      if (progress.type === "compact_end") {
        await sendMessage(
          chatId,
          `compact ${progress.tokensBefore} → ${progress.tokensAfter}`,
          { reply_markup: undefined }
        );
        return;
      }
      if (progress.type === "auto_continue") {
        await sendMessage(chatId, `… continue #${progress.iteration}`, { reply_markup: undefined });
      }
    } catch (error) {
      console.error("Telegram notifyProgress failed:", error?.message || error);
    }
  };

  return { configure, stop, start, getStatus, sendMessage, notifyProgress, normalizeTelegramConfig };
}

module.exports = { createTelegramBot, normalizeTelegramConfig, splitTelegramText };
