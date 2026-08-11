/**
 * Extract scannable text surfaces from OpenAI-format chat responses
 * (non-stream JSON + per-chunk SSE) and decide alert/block/scrub.
 *
 * Default mode is "scrub": strip dangerous fragments only from shell/exec
 * tool args — never abort the stream, never rewrite ordinary code tools
 * (edit_file / read_file / write / grep / …) even if the code *mentions*
 * similar patterns (curl|sh in a comment, schtasks in docs, etc.).
 */

const {
  getDefaultEngine,
  parseSeverity,
  sevRank,
  RULE_UNSOLICITED,
} = require("./engine.cjs");

const SCRUB_PLACEHOLDER = "«removed by Lopster Guard»";

/**
 * Tools whose arguments are actual shell / process execution.
 * Only these get scrubbed in mode=scrub. Everything else (file edit, search,
 * browser, …) passes through untouched so normal coding work is never mangled.
 */
const EXEC_TOOL_RE =
  /^(bash|shell|zsh|sh|cmd|powershell|pwsh|run_terminal_command|run_terminal|terminal|execute|exec|run_command|run_shell|command|osascript|os_system|subprocess|python_repl|code_execution|code_interpreter)$/i;

function isExecutableToolName(name) {
  const n = String(name || "")
    .trim()
    .replace(/^functions?\./i, "");
  if (!n) return false;
  if (EXEC_TOOL_RE.test(n)) return true;
  // Common aliases: Shell, Bash, run_terminal_command, etc.
  if (/\b(bash|shell|powershell|pwsh|cmd\.exe|terminal)\b/i.test(n) && !/read|write|edit|search|grep|find|list/i.test(n)) {
    return true;
  }
  return false;
}

/**
 * Default policy — OFF by default (heavy scanner; opt-in), scrub when enabled.
 * mode: "scrub" | "block" | "alert" | "off"
 * blockOn / scrubOn: "high" | "medium" | "any"  (severity threshold)
 */
function defaultGuardConfig() {
  return {
    enabled: false,
    mode: "scrub", // scrub | block | alert | off
    /** Severity threshold for scrub/block actions */
    blockOn: "high", // high | medium | any
    scrubOn: "high",
    /** When client sent no tools, any tool_calls → high */
    unsolicitedTools: true,
    /** Also scan/scrub reasoning / thinking fields */
    scanThinking: true,
    /**
     * scrub mode: only rewrite shell/exec tool args (default true).
     * Ordinary tools + assistant text are never cut from the stream.
     */
    scrubExecToolsOnly: true,
    /** Max findings kept per request (log size) */
    maxFindings: 32,
    /** Replacement text for scrubbed spans */
    scrubReplacement: SCRUB_PLACEHOLDER,
  };
}

function normalizeMode(mode) {
  const m = String(mode || "scrub").toLowerCase().trim();
  if (m === "block" || m === "alert" || m === "off" || m === "scrub") return m;
  return "scrub";
}

function normalizeThreshold(v, fallback = "high") {
  const t = String(v || fallback).toLowerCase().trim();
  if (t === "medium" || t === "any") return t;
  return "high";
}

function normalizeGuardConfig(raw) {
  const base = defaultGuardConfig();
  if (!raw || typeof raw !== "object") return { ...base };
  const mode = normalizeMode(raw.mode != null ? raw.mode : base.mode);
  const blockOn = normalizeThreshold(raw.blockOn != null ? raw.blockOn : base.blockOn);
  const scrubOn = normalizeThreshold(
    raw.scrubOn != null ? raw.scrubOn : raw.blockOn != null ? raw.blockOn : base.scrubOn
  );
  return {
    // Guard is OFF by default; only an explicit true enables it (heavy scanner).
    // LOPSTER_GUARD_DISABLED=1 forces it off even when the store says on.
    enabled:
      process.env.LOPSTER_GUARD_DISABLED === "1" ? false : raw.enabled === true && mode !== "off",
    mode,
    blockOn,
    scrubOn,
    unsolicitedTools: raw.unsolicitedTools !== false,
    scanThinking: raw.scanThinking !== false,
    scrubExecToolsOnly: raw.scrubExecToolsOnly !== false,
    maxFindings: Math.max(1, Math.min(200, Number(raw.maxFindings) || base.maxFindings)),
    scrubReplacement:
      raw.scrubReplacement != null ? String(raw.scrubReplacement) : base.scrubReplacement,
  };
}

function thresholdRank(name) {
  if (name === "any") return 1;
  if (name === "medium") return 2;
  return 3; // high
}

function clientAdvertisedTools(openaiBody) {
  if (!openaiBody || typeof openaiBody !== "object") return false;
  if (Array.isArray(openaiBody.tools) && openaiBody.tools.length > 0) return true;
  if (Array.isArray(openaiBody.functions) && openaiBody.functions.length > 0) return true;
  // tool_choice "none" still means client is tool-aware; only empty tools = unsolicited
  return false;
}

function stringifyArgs(args) {
  if (args == null) return "";
  if (typeof args === "string") return args;
  try {
    return JSON.stringify(args);
  } catch {
    return String(args);
  }
}

/**
 * Pull text surfaces from an OpenAI chat.completion (full) or chunk delta.
 * Returns array of { text, source }.
 */
function extractSurfacesFromOpenAIMessage(msg, { scanThinking = true } = {}) {
  const out = [];
  if (!msg || typeof msg !== "object") return out;

  const push = (text, source) => {
    if (text == null) return;
    const s = typeof text === "string" ? text : String(text);
    if (s) out.push({ text: s, source });
  };

  // content: string | array of parts
  if (typeof msg.content === "string") {
    push(msg.content, "content");
  } else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if (!part) continue;
      if (typeof part === "string") push(part, "content");
      else if (typeof part.text === "string") push(part.text, part.type || "content");
      else if (typeof part.content === "string") push(part.content, part.type || "content");
      else if (part.type === "tool_use" || part.type === "function_call") {
        push(part.name || "", `tool_name:${part.name || "?"}`);
        push(stringifyArgs(part.input ?? part.arguments), `tool:${part.name || "unknown"}`);
      }
    }
  }

  if (scanThinking) {
    push(msg.reasoning_content, "reasoning");
    push(msg.reasoning, "reasoning");
    push(msg.thinking, "thinking");
    // Anthropic-style redacted_thinking sometimes leaks as string fields
    if (typeof msg.signature === "string" && msg.signature.length > 200) {
      push(`"signature":"${msg.signature}"`, "thinking_signature");
    }
  }

  // tool_calls (OpenAI)
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      const name = tc?.function?.name || tc?.name || tc?.type || "tool";
      push(name, `tool_name:${name}`);
      const args = tc?.function?.arguments ?? tc?.arguments ?? tc?.input;
      push(stringifyArgs(args), `tool:${name}`);
    }
  }

  // function_call (legacy)
  if (msg.function_call) {
    const name = msg.function_call.name || "function";
    push(name, `tool_name:${name}`);
    push(stringifyArgs(msg.function_call.arguments), `tool:${name}`);
  }

  return out;
}

function extractSurfacesFromOpenAIResponse(payload, opts) {
  const out = [];
  if (!payload || typeof payload !== "object") return out;
  const choices = payload.choices || [];
  for (const ch of choices) {
    if (ch?.message) out.push(...extractSurfacesFromOpenAIMessage(ch.message, opts));
    if (ch?.delta) out.push(...extractSurfacesFromOpenAIMessage(ch.delta, opts));
    // Some providers put text at choice level
    if (typeof ch?.text === "string") out.push({ text: ch.text, source: "content" });
  }
  return out;
}

function extractSurfacesFromChunk(chunk, opts) {
  return extractSurfacesFromOpenAIResponse(chunk, opts);
}

function hasToolCallsInPayload(payload) {
  if (!payload || typeof payload !== "object") return false;
  for (const ch of payload.choices || []) {
    const msg = ch?.message || ch?.delta;
    if (!msg) continue;
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) return true;
    if (msg.function_call && (msg.function_call.name || msg.function_call.arguments)) return true;
    if (Array.isArray(msg.content)) {
      for (const p of msg.content) {
        if (p && (p.type === "tool_use" || p.type === "function_call")) return true;
      }
    }
  }
  return false;
}

/**
 * Scan extracted surfaces + optional unsolicited-tool anomaly.
 */
function scanSurfaces(
  surfaces,
  {
    engine,
    clientHadTools = false,
    unsolicitedTools = true,
    sawToolCalls = false,
  } = {}
) {
  const eng = engine || getDefaultEngine();
  let findings = [];
  for (const { text, source } of surfaces || []) {
    findings = findings.concat(eng.inspect(text, source));
  }
  if (unsolicitedTools && sawToolCalls && !clientHadTools) {
    findings.push({
      ruleId: RULE_UNSOLICITED,
      category: "protocol",
      severity: "high",
      match: "tool_calls without client tools",
      excerpt: "Provider returned tool_calls but the client request advertised no tools",
      source: "protocol",
      description:
        "Unsolicited tool use — strong signal of provider-side injection (client never declared tools)",
    });
  }
  findings = eng.sortFindings(findings);
  return findings;
}

function mergeFindings(a, b, max = 32) {
  const eng = getDefaultEngine();
  const out = [];
  const seen = new Set();
  for (const f of [...(a || []), ...(b || [])]) {
    if (!f) continue;
    const k = `${f.ruleId}\0${f.match || ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(f);
  }
  return eng.sortFindings(out).slice(0, max);
}

/**
 * Scrub a single message / delta object in place of a shallow clone.
 *
 * Policy (scrubExecToolsOnly, default true):
 *  - Shell/exec tool args → may cut dangerous command spans
 *  - Ordinary tools (edit_file, read_file, write, grep, …) → never rewrite
 *  - Assistant text / thinking → never rewrite (code/docs often look similar)
 * Tool names and structure always stay intact.
 */
function scrubOpenAIMessage(msg, cfg) {
  const eng = getDefaultEngine();
  const findings = [];
  let changed = false;
  if (!msg || typeof msg !== "object") {
    return { message: msg, findings, changed: false };
  }

  const execOnly = cfg.scrubExecToolsOnly !== false;

  const scrub = (text, source) => {
    if (text == null) return text;
    const s = typeof text === "string" ? text : String(text);
    if (!s) return text;
    const r = eng.scrubText(s, source, {
      minSeverity: cfg.scrubOn || "high",
      replacement: cfg.scrubReplacement,
    });
    if (r.findings?.length) findings.push(...r.findings);
    if (r.changed) {
      changed = true;
      return r.text;
    }
    return text;
  };

  const out = { ...msg };

  // Content / thinking: do not cut in default scrub — normal explanations & code
  // samples would get mangled (curl|sh in a comment, schtasks in docs, …).
  if (!execOnly) {
    if (typeof out.content === "string") {
      out.content = scrub(out.content, "content");
    } else if (Array.isArray(out.content)) {
      out.content = out.content.map((part) => {
        if (part == null) return part;
        if (typeof part === "string") return scrub(part, "content");
        if (typeof part !== "object") return part;
        const p = { ...part };
        if (typeof p.text === "string") p.text = scrub(p.text, p.type || "content");
        if (typeof p.content === "string") p.content = scrub(p.content, p.type || "content");
        return p;
      });
    }
    if (cfg.scanThinking !== false) {
      if (typeof out.reasoning_content === "string") {
        out.reasoning_content = scrub(out.reasoning_content, "reasoning");
      }
      if (typeof out.reasoning === "string") {
        out.reasoning = scrub(out.reasoning, "reasoning");
      }
      if (typeof out.thinking === "string") {
        out.thinking = scrub(out.thinking, "thinking");
      }
    }
  } else if (Array.isArray(out.content)) {
    // Still allow scrubbing embedded tool_use blocks that are shell tools
    out.content = out.content.map((part) => {
      if (!part || typeof part !== "object") return part;
      if (part.type !== "tool_use" && part.type !== "function_call") return part;
      const tname = part.name || "unknown";
      if (!isExecutableToolName(tname)) return part;
      const p = { ...part };
      if (typeof p.input === "string") {
        p.input = scrub(p.input, `tool:${tname}`);
      } else if (p.input != null && typeof p.input === "object") {
        const raw = stringifyArgs(p.input);
        const next = scrub(raw, `tool:${tname}`);
        if (next !== raw) {
          try {
            p.input = JSON.parse(next);
          } catch {
            p.input = next;
          }
        }
      }
      if (typeof p.arguments === "string") {
        p.arguments = scrub(p.arguments, `tool:${tname}`);
      }
      return p;
    });
  }

  if (Array.isArray(out.tool_calls)) {
    out.tool_calls = out.tool_calls.map((tc) => {
      if (!tc || typeof tc !== "object") return tc;
      const name = tc.function?.name || tc.name || tc.type || "tool";
      // Ordinary coding tools: leave args alone (code can look like payloads)
      if (execOnly && !isExecutableToolName(name)) return tc;
      const t = { ...tc };
      if (t.function && typeof t.function === "object") {
        t.function = { ...t.function };
        if (typeof t.function.arguments === "string") {
          t.function.arguments = scrub(t.function.arguments, `tool:${name}`);
        }
      }
      if (typeof t.arguments === "string") {
        t.arguments = scrub(t.arguments, `tool:${name}`);
      }
      return t;
    });
  }

  if (out.function_call && typeof out.function_call === "object") {
    const name = out.function_call.name || "function";
    if (!execOnly || isExecutableToolName(name)) {
      out.function_call = { ...out.function_call };
      if (typeof out.function_call.arguments === "string") {
        out.function_call.arguments = scrub(out.function_call.arguments, `tool:${name}`);
      }
    }
  }

  return {
    message: out,
    findings: eng.sortFindings(findings),
    changed,
  };
}

/**
 * Strip unsolicited tool_calls when the client never advertised tools.
 * Stream stays open; tools just disappear (client has nothing to execute).
 */
function stripUnsolicitedTools(payload) {
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.choices)) {
    return { payload, changed: false };
  }
  let changed = false;
  const choices = payload.choices.map((ch) => {
    if (!ch || typeof ch !== "object") return ch;
    const c = { ...ch };
    for (const key of ["message", "delta"]) {
      if (!c[key] || typeof c[key] !== "object") continue;
      const m = { ...c[key] };
      if (Array.isArray(m.tool_calls) && m.tool_calls.length) {
        delete m.tool_calls;
        changed = true;
      }
      if (m.function_call) {
        delete m.function_call;
        changed = true;
      }
      if (Array.isArray(m.content)) {
        const next = m.content.filter(
          (p) => !(p && (p.type === "tool_use" || p.type === "function_call"))
        );
        if (next.length !== m.content.length) {
          m.content = next;
          changed = true;
        }
      }
      c[key] = m;
    }
    if (c.finish_reason === "tool_calls") {
      c.finish_reason = "stop";
      changed = true;
    }
    return c;
  });
  return { payload: changed ? { ...payload, choices } : payload, changed };
}

/**
 * Scrub dangerous fragments inside an OpenAI chat.completion / chunk payload.
 * Never removes legitimate tool structure — only matched command spans inside text/args.
 */
function scrubOpenAIPayload(payload, cfg, openaiBody) {
  const config = normalizeGuardConfig(cfg);
  if (!payload || typeof payload !== "object") {
    return { payload, findings: [], changed: false };
  }

  let allFindings = [];
  let changed = false;
  let out = { ...payload };

  if (Array.isArray(payload.choices)) {
    out.choices = payload.choices.map((ch) => {
      if (!ch || typeof ch !== "object") return ch;
      const c = { ...ch };
      for (const key of ["message", "delta"]) {
        if (c[key]) {
          const r = scrubOpenAIMessage(c[key], config);
          c[key] = r.message;
          if (r.findings.length) allFindings = allFindings.concat(r.findings);
          if (r.changed) changed = true;
        }
      }
      // choice-level text: only scrub when not exec-tools-only (default: leave alone)
      if (typeof c.text === "string" && config.scrubExecToolsOnly === false) {
        const eng = getDefaultEngine();
        const r = eng.scrubText(c.text, "content", {
          minSeverity: config.scrubOn,
          replacement: config.scrubReplacement,
        });
        if (r.findings.length) allFindings = allFindings.concat(r.findings);
        if (r.changed) {
          c.text = r.text;
          changed = true;
        }
      }
      return c;
    });
  }

  // Protocol: unsolicited tool_calls → drop tools, do not kill the response
  if (
    config.unsolicitedTools &&
    openaiBody &&
    !clientAdvertisedTools(openaiBody) &&
    hasToolCallsInPayload(out)
  ) {
    const stripped = stripUnsolicitedTools(out);
    out = stripped.payload;
    if (stripped.changed) {
      changed = true;
      allFindings.push({
        ruleId: RULE_UNSOLICITED,
        category: "protocol",
        severity: "high",
        match: "tool_calls without client tools",
        excerpt: "Stripped unsolicited tool_calls (client advertised no tools)",
        source: "protocol",
        description:
          "Unsolicited tool use — stripped tool_calls; stream continued (scrub mode)",
      });
    }
  }

  const eng = getDefaultEngine();
  return {
    payload: out,
    findings: eng.sortFindings(allFindings).slice(0, config.maxFindings),
    changed,
  };
}

/**
 * Decide whether to allow / alert / scrub / block based on config + findings.
 * @returns {{ action: 'allow'|'alert'|'scrub'|'block', severity, findings, reason? }}
 */
function decide(findings, config) {
  const cfg = normalizeGuardConfig(config);
  const list = findings || [];
  if (!cfg.enabled || cfg.mode === "off" || !list.length) {
    return { action: "allow", severity: "low", findings: list };
  }
  const eng = getDefaultEngine();
  const severity = eng.maxSeverity(list);
  const rank = sevRank(severity);

  const thrName = cfg.mode === "scrub" ? cfg.scrubOn : cfg.blockOn;
  const threshold = thresholdRank(thrName);
  const hitsThreshold = rank >= threshold;

  if (!hitsThreshold) {
    // Still surface as alert if any findings and mode is block/alert
    return {
      action: cfg.mode === "block" || cfg.mode === "alert" ? "alert" : "allow",
      severity,
      findings: list,
      reason: "below_threshold",
    };
  }
  if (cfg.mode === "alert") {
    return { action: "alert", severity, findings: list, reason: "alert_mode" };
  }
  if (cfg.mode === "scrub") {
    return {
      action: "scrub",
      severity,
      findings: list,
      reason: `scrub_on_${cfg.scrubOn}`,
    };
  }
  // mode === block
  return {
    action: "block",
    severity,
    findings: list,
    reason: `blocked_on_${cfg.blockOn}`,
  };
}

/**
 * Full scan of a non-stream OpenAI chat.completion payload.
 * In scrub mode, returns a mutated payload with dangerous spans cut out.
 */
function scanOpenAIResponse(payload, openaiBody, config) {
  const cfg = normalizeGuardConfig(config);
  if (!cfg.enabled) {
    return {
      action: "allow",
      severity: "low",
      findings: [],
      skipped: true,
      payload,
      changed: false,
    };
  }
  const surfaces = extractSurfacesFromOpenAIResponse(payload, {
    scanThinking: cfg.scanThinking,
  });
  const findings = scanSurfaces(surfaces, {
    clientHadTools: clientAdvertisedTools(openaiBody),
    unsolicitedTools: cfg.unsolicitedTools,
    sawToolCalls: hasToolCallsInPayload(payload),
  });
  const capped = findings.slice(0, cfg.maxFindings);
  const decision = decide(capped, cfg);

  if (decision.action === "scrub") {
    const scrubbed = scrubOpenAIPayload(payload, cfg, openaiBody);
    return {
      ...decision,
      findings: mergeFindings(capped, scrubbed.findings, cfg.maxFindings),
      payload: scrubbed.payload,
      changed: scrubbed.changed,
    };
  }

  return { ...decision, findings: capped, payload, changed: false };
}

/**
 * Incremental stream scanner — accumulate text + tool arg fragments.
 * scrub mode: rewrite each chunk, never set blocked.
 * block mode: set blocked on high hit (pipeline aborts).
 */
function createStreamScanner(openaiBody, config) {
  const cfg = normalizeGuardConfig(config);
  const clientHadTools = clientAdvertisedTools(openaiBody);
  let textBuf = "";
  let toolArgsBuf = "";
  let sawToolCalls = false;
  let allFindings = [];
  let blocked = false;
  let scrubbedAny = false;
  let lastDecision = { action: "allow", severity: "low", findings: [], chunk: null };

  function ingestChunk(chunk) {
    if (!cfg.enabled || blocked) {
      return { ...lastDecision, chunk: blocked ? null : chunk };
    }
    const surfaces = extractSurfacesFromChunk(chunk, { scanThinking: cfg.scanThinking });
    for (const { text, source } of surfaces) {
      if (source === "content" || source === "reasoning" || source === "thinking") {
        textBuf += text;
      } else if (source.startsWith("tool")) {
        toolArgsBuf += text;
        sawToolCalls = true;
      } else {
        textBuf += text;
      }
    }
    if (hasToolCallsInPayload(chunk)) sawToolCalls = true;

    // Scan rolling buffers (cheap enough; rules are regex)
    const surfacesNow = [
      { text: textBuf, source: "content" },
      { text: toolArgsBuf, source: "tool:stream" },
    ];
    const findings = scanSurfaces(surfacesNow, {
      clientHadTools,
      unsolicitedTools: cfg.unsolicitedTools,
      sawToolCalls,
    }).slice(0, cfg.maxFindings);

    // Merge unique findings
    const seen = new Set(allFindings.map((f) => f.ruleId + "\0" + f.match));
    for (const f of findings) {
      const k = f.ruleId + "\0" + f.match;
      if (!seen.has(k)) {
        seen.add(k);
        allFindings.push(f);
      }
    }
    allFindings = allFindings.slice(0, cfg.maxFindings);
    lastDecision = decide(allFindings, cfg);

    let outChunk = chunk;
    if (lastDecision.action === "scrub") {
      const scrubbed = scrubOpenAIPayload(chunk, cfg, openaiBody);
      outChunk = scrubbed.payload;
      if (scrubbed.changed) scrubbedAny = true;
      lastDecision = {
        ...lastDecision,
        findings: mergeFindings(allFindings, scrubbed.findings, cfg.maxFindings),
        changed: scrubbed.changed || scrubbedAny,
        chunk: outChunk,
      };
    } else {
      lastDecision = { ...lastDecision, chunk: outChunk, changed: false };
    }

    if (lastDecision.action === "block") blocked = true;
    return lastDecision;
  }

  function finalize() {
    if (!cfg.enabled) {
      return { action: "allow", severity: "low", findings: [], skipped: true, changed: false };
    }
    lastDecision = decide(allFindings, cfg);
    return {
      ...lastDecision,
      findings: allFindings,
      changed: scrubbedAny,
    };
  }

  return {
    ingestChunk,
    finalize,
    get blocked() {
      return blocked;
    },
    get findings() {
      return allFindings;
    },
    get config() {
      return cfg;
    },
    get scrubbed() {
      return scrubbedAny;
    },
  };
}

/**
 * Build OpenAI-compatible error body when blocking.
 */
function blockErrorPayload(decision, { model } = {}) {
  const findings = (decision?.findings || []).slice(0, 8);
  const top = findings[0];
  const rules = findings.map((f) => f.ruleId).join(", ");
  const message =
    `Lopster Guard blocked this response: suspected malicious provider injection ` +
    `(severity=${decision?.severity || "high"}; rules=${rules || top?.ruleId || "unknown"}). ` +
    `${top?.description || "Dangerous tool/command pattern detected"}. ` +
    `Match: ${top?.match || "—"}. ` +
    `Switch Guard mode to "scrub" to cut fragments without stopping the stream.`;

  return {
    error: {
      message,
      type: "lopster_guard_block",
      param: null,
      code: "guard_blocked",
      guard: {
        severity: decision?.severity || "high",
        action: "block",
        findings: findings.map((f) => ({
          ruleId: f.ruleId,
          category: f.category,
          severity: f.severity,
          match: f.match,
          source: f.source,
          description: f.description,
        })),
      },
    },
    model: model || undefined,
  };
}

/**
 * SSE chunk that informs the client mid-stream that Guard blocked.
 */
function blockSseChunk(decision, { model, id } = {}) {
  const msg =
    (decision?.findings?.[0]?.description || "malicious injection") +
    ` [${(decision?.findings || []).map((f) => f.ruleId).slice(0, 4).join(", ")}]`;
  return {
    id: id || "lopster-guard-block",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: model || "lopster-guard",
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          content:
            `\n\n⚠️ **Lopster Guard BLOCKED** this stream: ${msg}. ` +
            `Provider response contained injection patterns and was stopped. ` +
            `Use mode "scrub" to strip fragments without aborting.`,
        },
        finish_reason: "stop",
      },
    ],
    lopster_guard: {
      action: "block",
      severity: decision?.severity,
      findings: (decision?.findings || []).slice(0, 8),
    },
  };
}

module.exports = {
  defaultGuardConfig,
  normalizeGuardConfig,
  clientAdvertisedTools,
  isExecutableToolName,
  extractSurfacesFromOpenAIMessage,
  extractSurfacesFromOpenAIResponse,
  extractSurfacesFromChunk,
  hasToolCallsInPayload,
  scanSurfaces,
  decide,
  scrubOpenAIMessage,
  scrubOpenAIPayload,
  scanOpenAIResponse,
  createStreamScanner,
  blockErrorPayload,
  blockSseChunk,
  parseSeverity,
  sevRank,
  SCRUB_PLACEHOLDER,
};
