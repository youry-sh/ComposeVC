/**
 * Lopster Guard — detection engine for malicious LLM-provider injections.
 *
 * Independent rewrite (not a fork of holone). Same threat model:
 * cheap resellers inject tool_use / shell payloads into model responses.
 * Guard sits on the Lopster proxy wire, scans assistant text + tool-call
 * arguments, and can alert or hard-block before the client executes them.
 *
 * What it catches (active injection):
 *   download-exec, obfuscation, persistence, network/proxy hijack,
 *   anti-forensics, locale tricks, AI-client config poisoning,
 *   credential theft, exfil channels, git attacks, supply-chain,
 *   process injection / UAC, thinking-block smuggling, IOC blocklist,
 *   unsolicited tool_use (client never advertised tools).
 *
 * What it does NOT catch (by design, same honesty as holone):
 *   passive prompt reading / credential harvesting of your requests.
 *   Do not send secrets to untrusted providers.
 */

const fs = require("fs");
const path = require("path");

const SEV = { low: 1, medium: 2, high: 3 };
const RULE_UNSOLICITED = "proto-tooluse-unsolicited";

function parseSeverity(s) {
  const k = String(s || "low").toLowerCase().trim();
  if (k === "high") return "high";
  if (k === "medium") return "medium";
  return "low";
}

function sevRank(s) {
  return SEV[parseSeverity(s)] || 1;
}

function truncate(str, n = 160) {
  const s = String(str || "");
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function excerpt(text, start, end, pad = 40) {
  const a = Math.max(0, start - pad);
  const b = Math.min(text.length, end + pad);
  let out = text.slice(a, b).replace(/\s+/g, " ");
  if (a > 0) out = "…" + out;
  if (b < text.length) out = out + "…";
  return truncate(out, 200);
}

/** Extra rules beyond the base pack — authored for Lopster (more coverage). */
const EXTRA_RULES = [
  {
    id: "dl-powershell-downloadcradle",
    category: "download-exec",
    severity: "high",
    pattern:
      "(?i)\\b(iex|invoke-expression)\\b[\\s\\S]{0,120}?(iwr|irm|invoke-webrequest|invoke-restmethod)\\b",
    description: "PowerShell download cradle (IEX + web request)",
  },
  {
    id: "dl-bash-process-sub",
    category: "download-exec",
    severity: "high",
    pattern: "(?i)bash\\s*<\\s*\\(\\s*(curl|wget)\\b",
    description: "Bash process substitution download-exec",
  },
  {
    id: "dl-python-urllib-exec",
    category: "download-exec",
    severity: "high",
    pattern:
      "(?i)(urllib|requests)\\.[a-z_]+\\([^\\n]{0,80}http[^\\n]{0,120}\\)[\\s\\S]{0,80}?(exec|eval|os\\.system|subprocess)",
    description: "Python fetch then exec",
  },
  {
    id: "dl-node-child-curl",
    category: "download-exec",
    severity: "high",
    pattern:
      "(?i)(child_process|execSync|spawnSync)[\\s\\S]{0,60}?(curl|wget|powershell|cmd\\.exe|bash)",
    description: "Node child_process launching download/shell tools",
  },
  {
    id: "obf-base64-pipe-sh",
    category: "obfuscation",
    severity: "high",
    pattern: "(?i)base64\\s+(-d|--decode)[^|\\n]*\\|\\s*(ba)?sh\\b",
    description: "Base64 decode piped to shell",
  },
  {
    id: "obf-xxd-pipe-sh",
    category: "obfuscation",
    severity: "high",
    pattern: "(?i)\\bxxd\\s+-r[^|\\n]*\\|\\s*(ba)?sh\\b",
    description: "xxd reverse pipe to shell",
  },
  {
    id: "persist-systemd-user",
    category: "persistence",
    severity: "high",
    pattern: "(?i)\\.config/systemd/user/|systemctl\\s+--user\\s+enable",
    description: "systemd user unit persistence",
  },
  {
    id: "persist-wmi-event",
    category: "persistence",
    severity: "high",
    pattern: "(?i)__eventfilter|commandlineseventconsumer|wmic\\s+event",
    description: "WMI event subscription persistence",
  },
  {
    id: "persist-startup-folder",
    category: "persistence",
    severity: "medium",
    pattern:
      "(?i)\\b(startup|start menu\\\\programs\\\\startup)\\b[^\\n]*\\.(bat|cmd|vbs|ps1|lnk|exe)\\b",
    description: "Windows Startup folder drop",
  },
  {
    id: "net-ssh-reverse",
    category: "network",
    severity: "high",
    pattern:
      "(?i)ssh\\s+[^\\n]*-R\\s+\\d+:|reverse\\s*shell|nc\\s+-e\\s+/bin/(ba)?sh",
    description: "Reverse shell / SSH reverse tunnel",
  },
  {
    id: "net-iptables-redirect",
    category: "network",
    severity: "medium",
    pattern: "(?i)iptables\\s+[^\\n]*(-j\\s+REDIRECT|PREROUTING|DNAT)",
    description: "iptables traffic redirect",
  },
  {
    id: "af-history-wipe",
    category: "anti-forensics",
    severity: "high",
    pattern:
      "(?i)history\\s+-c|rm\\s+-f\\s+~?/?\\.bash_history|Clear-History|Remove-ItemProperty[^\\n]*RunMRU",
    description: "Shell/history wipe",
  },
  {
    id: "af-timestomp",
    category: "anti-forensics",
    severity: "medium",
    pattern:
      "(?i)timestomp|Set-ItemProperty[^\\n]*LastWriteTime|touch\\s+-t\\s+\\d",
    description: "Timestamp manipulation",
  },
  {
    id: "cfg-claude-hooks",
    category: "client-config",
    severity: "high",
    pattern:
      "(?i)(\\.claude/settings\\.json|PreToolUse|PostToolUse|SessionStart)[^\\n]{0,200}(curl|wget|iex|powershell|bash|hooks?)",
    description: "Claude Code hook poisoning",
  },
  {
    id: "cfg-mcp-remote",
    category: "client-config",
    severity: "high",
    pattern:
      "(?i)\\.mcp\\.json[^\\n]{0,300}(command|url)[^\\n]{0,120}(curl|http|npx|node)",
    description: "MCP config remote command injection",
  },
  {
    id: "cfg-cursor-rules",
    category: "client-config",
    severity: "medium",
    pattern:
      "(?i)(\\.cursorrules|\\.cursor/rules|AGENTS\\.md|CLAUDE\\.md)[\\s\\S]{0,200}(ignore previous|exfil|curl\\s+https?://|webhook)",
    description: "AI client instruction file poisoning",
  },
  {
    id: "cred-ssh-private",
    category: "credential-theft",
    severity: "high",
    pattern:
      "(?i)id_rsa|id_ed25519|\\.ssh/config|BEGIN\\s+OPENSSH\\s+PRIVATE\\s+KEY",
    description: "SSH private key access",
  },
  {
    id: "cred-browser-login",
    category: "credential-theft",
    severity: "high",
    pattern:
      "(?i)(Login\\s*Data|Cookies|Web\\s*Data)[^\\n]{0,80}(Chrome|Chromium|Edge|Brave)|os_crypt|Local\\s*State",
    description: "Browser credential store access",
  },
  {
    id: "cred-env-files",
    category: "credential-theft",
    severity: "medium",
    pattern:
      "(?i)(\\.env|\\.env\\.local|\\.npmrc|\\.netrc|\\.pgpass|credentials\\.json)[^\\n]{0,60}(cat|type|Get-Content|readFile)",
    description: "Dotenv / package credential file read",
  },
  {
    id: "exfil-discord-webhook",
    category: "exfil",
    severity: "high",
    pattern: "(?i)discord(?:app)?\\.com/api/webhooks/\\d+/[A-Za-z0-9_-]+",
    description: "Discord webhook exfil URL",
  },
  {
    id: "exfil-telegram-bot",
    category: "exfil",
    severity: "high",
    pattern: "(?i)api\\.telegram\\.org/bot[0-9]+:[A-Za-z0-9_-]+",
    description: "Telegram bot API exfil",
  },
  {
    id: "exfil-slack-hook",
    category: "exfil",
    severity: "high",
    pattern: "(?i)hooks\\.slack\\.com/services/[A-Za-z0-9/_-]+",
    description: "Slack webhook exfil",
  },
  {
    id: "exfil-ngrok-tunnel",
    category: "exfil",
    severity: "medium",
    pattern:
      "(?i)\\b(ngrok\\.io|ngrok-free\\.app|serveo\\.net|localhost\\.run|webhook\\.site|requestbin)\\b",
    description: "Ephemeral tunnel / requestbin exfil host",
  },
  {
    id: "git-hooks-path",
    category: "git-attack",
    severity: "high",
    pattern:
      "(?i)core\\.hooksPath|\\.git/hooks/(pre-commit|post-checkout|post-merge)|git\\s+config[^\\n]*hooksPath",
    description: "Git hooks path hijack",
  },
  {
    id: "supply-postinstall",
    category: "supply-chain",
    severity: "high",
    pattern:
      '(?i)"postinstall"\\s*:\\s*"[^"]*(curl|wget|powershell|node\\s+-e|bash)',
    description: "npm postinstall malicious script",
  },
  {
    id: "supply-typosquat-install",
    category: "supply-chain",
    severity: "medium",
    pattern:
      "(?i)(npm\\s+i(nstall)?|pip\\s+install|go\\s+get)[^\\n]{0,80}(extra-index-url|--registry=http)",
    description: "Untrusted registry / dependency confusion hint",
  },
  {
    id: "think-hidden-instr",
    category: "thinking-inject",
    severity: "high",
    pattern:
      "(?i)(ignore\\s+(all\\s+)?(previous|prior)\\s+(instructions|rules)|system\\s*:\\s*you\\s+must\\s+run|<!--\\s*INSTRUCTION)",
    description: "Hidden instruction / prompt override in model text",
  },
  {
    id: "think-tool-smuggle",
    category: "thinking-inject",
    severity: "high",
    pattern:
      "(?i)<tool_call>|<function_call>|run_tool\\s*\\(|tool_use\\s*:\\s*\\{",
    description: "Tool-call smuggling markers in free text",
  },
  {
    id: "inj-proc-hollowing",
    category: "process-inject",
    severity: "high",
    pattern:
      "(?i)CreateRemoteThread|WriteProcessMemory|VirtualAllocEx|NtMapViewOfSection|QueueUserAPC|ReflectiveLoader|ManualMap|RunPE",
    description: "Process injection / hollowing APIs",
  },
  {
    id: "inj-uac-bypass",
    category: "process-inject",
    severity: "high",
    pattern:
      "(?i)fodhelper|computerdefaults|eventvwr|compmgmtlauncher|ms-settings\\\\Shell\\\\Open\\\\command|mscfile\\\\shell",
    description: "UAC bypass LOLBin / registry hijack",
  },
  {
    id: "def-tamper-mp",
    category: "anti-forensics",
    severity: "high",
    pattern:
      "(?i)Set-MpPreference[^\\n]*DisableRealtimeMonitoring|MpCmdRun[^\\n]*removedefinitions|sc\\s+stop\\s+WinDefend|Add-MpPreference\\s+-Exclusion",
    description: "AV / realtime protection tampering",
  },
  {
    id: "container-escape",
    category: "persistence",
    severity: "high",
    pattern:
      "(?i)nsenter\\s+--target\\s+1|--cap-add=SYS_ADMIN|--privileged|security-opt\\s+apparmor=unconfined|/var/run/docker\\.sock",
    description: "Container escape primitives",
  },
  {
    id: "thinking-oversized-sig",
    category: "thinking-inject",
    severity: "medium",
    pattern: "(?i)\"signature\"\\s*:\\s*\"[A-Za-z0-9+/=]{400,}\"",
    description: "Anomalously large thinking signature (stego channel)",
  },
];

function loadJsonSafe(file, fallback) {
  try {
    const raw = fs.readFileSync(file, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * Convert Go-style regex patterns to JS RegExp.
 * Holone/RE2 rules use inline `(?i)` — JS needs the `i` flag instead.
 * Also strip other unsupported inline flags carefully.
 */
function toJsRegExp(pattern) {
  let src = String(pattern || "");
  let flags = "";
  // Leading or embedded Go/PCRE inline case-insensitive flag
  if (/\(\?i\)/.test(src) || /^\(\?i:/.test(src)) {
    flags += "i";
    src = src.replace(/\(\?i\)/g, "");
    // (?i:...) → (?:...) keep non-capturing group body
    src = src.replace(/\(\?i:/g, "(?:");
  }
  // Drop other inline flags that JS doesn't support if they appear
  src = src.replace(/\(\?[imsU-]+\)/g, "");
  return new RegExp(src, flags);
}

function compileRules(rawRules) {
  const out = [];
  const seen = new Set();
  for (const r of rawRules || []) {
    if (!r || !r.id || !r.pattern) continue;
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    let re;
    try {
      re = toJsRegExp(r.pattern);
    } catch (e) {
      // Skip broken patterns rather than crash the proxy
      continue;
    }
    out.push({
      id: r.id,
      category: r.category || "other",
      severity: parseSeverity(r.severity),
      pattern: r.pattern,
      description: r.description || r.id,
      re,
    });
  }
  return out;
}

function compileBlockTerms(bl) {
  const terms = [];
  const add = (kind, vals) => {
    for (const v of vals || []) {
      const term = String(v || "").trim();
      if (!term) continue;
      terms.push({ kind, term, lower: term.toLowerCase() });
    }
  };
  add("domain", bl.domains);
  add("ip", bl.ips);
  add("path", bl.paths);
  add("task", bl.task_names);
  add("process", bl.process_names);
  add("hash", bl.hashes);
  return terms;
}

class GuardEngine {
  /**
   * @param {{ rules?: object[], blocklist?: object }} opts
   */
  constructor(opts = {}) {
    const dir = path.join(__dirname);
    const pack = opts.rulesPack || loadJsonSafe(path.join(dir, "rules.json"), { rules: [] });
    const bl =
      opts.blocklist || loadJsonSafe(path.join(dir, "blocklist.json"), { domains: [] });
    const merged = [...(pack.rules || []), ...EXTRA_RULES];
    this.rules = compileRules(merged);
    this.terms = compileBlockTerms(bl);
    this.packVersion = pack.version || 1;
    this.ruleCount = this.rules.length;
    this.iocCount = this.terms.length;
  }

  listRules() {
    return this.rules.map((r) => ({
      id: r.id,
      category: r.category,
      severity: r.severity,
      pattern: r.pattern,
      description: r.description,
    }));
  }

  /**
   * Scan a single text blob. source labels origin (e.g. "content", "tool:Bash").
   * @returns {Array<{ruleId,category,severity,match,excerpt,source,description}>}
   */
  inspect(text, source = "content") {
    if (text == null || text === "") return [];
    const s = typeof text === "string" ? text : String(text);
    if (!s) return [];
    const out = [];
    const seen = new Set();
    const add = (f) => {
      const key = f.ruleId + "\0" + f.match;
      if (seen.has(key)) return;
      seen.add(key);
      out.push(f);
    };

    for (const r of this.rules) {
      let m;
      try {
        m = r.re.exec(s);
      } catch {
        continue;
      }
      if (!m) continue;
      const start = m.index;
      const end = start + m[0].length;
      add({
        ruleId: r.id,
        category: r.category,
        severity: r.severity,
        match: truncate(m[0], 160),
        excerpt: excerpt(s, start, end),
        source,
        description: r.description,
      });
      // reset lastIndex for global-ish safety (we don't use /g, but be safe)
      r.re.lastIndex = 0;
    }

    if (this.terms.length) {
      const low = s.toLowerCase();
      for (const bt of this.terms) {
        const idx = low.indexOf(bt.lower);
        if (idx < 0) continue;
        add({
          ruleId: "ioc-" + bt.kind,
          category: "ioc",
          severity: "high",
          match: bt.term,
          excerpt: excerpt(s, idx, idx + bt.lower.length),
          source,
          description: `Known indicator of compromise (${bt.kind})`,
        });
      }
    }
    return out;
  }

  /**
   * Strip all rule/IOC matches from text in one pass (fast, non-destructive to stream).
   * Returns { text, findings, changed }.
   * @param {string} text
   * @param {string} source
   * @param {{ minSeverity?: string, replacement?: string }} opts
   */
  scrubText(text, source = "content", opts = {}) {
    if (text == null || text === "") {
      return { text: text == null ? text : "", findings: [], changed: false };
    }
    let s = typeof text === "string" ? text : String(text);
    if (!s) return { text: s, findings: [], changed: false };

    const minRank = sevRank(opts.minSeverity || "high");
    const replacement =
      opts.replacement != null ? String(opts.replacement) : "«removed by Lopster Guard»";
    const findings = [];
    const seen = new Set();

    // Collect all match ranges first (rules + IOCs), then splice from end → start
    const ranges = [];

    for (const r of this.rules) {
      if (sevRank(r.severity) < minRank) continue;
      try {
        // Build a fresh global-ish matcher (original rules are non-/g)
        const flags = (r.re.flags || "").includes("i") ? "gi" : "g";
        const re = new RegExp(r.re.source, flags);
        let m;
        let guard = 0;
        while ((m = re.exec(s)) !== null && guard++ < 50) {
          const start = m.index;
          const end = start + m[0].length;
          if (end <= start) {
            re.lastIndex = start + 1;
            continue;
          }
          ranges.push({ start, end, ruleId: r.id, category: r.category, severity: r.severity, match: m[0], description: r.description });
          if (!re.global) break;
        }
      } catch {
        /* skip broken */
      }
    }

    if (this.terms.length) {
      const low = s.toLowerCase();
      for (const bt of this.terms) {
        if (sevRank("high") < minRank) continue;
        let from = 0;
        let guard = 0;
        while (guard++ < 50) {
          const idx = low.indexOf(bt.lower, from);
          if (idx < 0) break;
          ranges.push({
            start: idx,
            end: idx + bt.lower.length,
            ruleId: "ioc-" + bt.kind,
            category: "ioc",
            severity: "high",
            match: bt.term,
            description: `Known indicator of compromise (${bt.kind})`,
          });
          from = idx + bt.lower.length;
        }
      }
    }

    if (!ranges.length) return { text: s, findings: [], changed: false };

    // Merge overlapping ranges
    ranges.sort((a, b) => a.start - b.start || b.end - a.end);
    const merged = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r.start <= last.end) {
        last.end = Math.max(last.end, r.end);
        // keep highest severity finding id
        if (sevRank(r.severity) > sevRank(last.severity)) {
          last.ruleId = r.ruleId;
          last.category = r.category;
          last.severity = r.severity;
          last.match = r.match;
          last.description = r.description;
        }
      } else {
        merged.push({ ...r });
      }
    }

    // Splice from end so indices stay valid
    for (let i = merged.length - 1; i >= 0; i--) {
      const r = merged[i];
      const key = r.ruleId + "\0" + truncate(r.match, 160);
      if (!seen.has(key)) {
        seen.add(key);
        findings.push({
          ruleId: r.ruleId,
          category: r.category,
          severity: r.severity,
          match: truncate(r.match, 160),
          excerpt: excerpt(s, r.start, r.end),
          source,
          description: r.description,
        });
      }
      s = s.slice(0, r.start) + replacement + s.slice(r.end);
    }

    return {
      text: s,
      findings: this.sortFindings(findings),
      changed: true,
    };
  }

  maxSeverity(findings) {
    let max = "low";
    let rank = 0;
    for (const f of findings || []) {
      const r = sevRank(f.severity);
      if (r > rank) {
        rank = r;
        max = parseSeverity(f.severity);
      }
    }
    return max;
  }

  sortFindings(findings) {
    return [...(findings || [])].sort((a, b) => {
      const d = sevRank(b.severity) - sevRank(a.severity);
      if (d) return d;
      return String(a.ruleId).localeCompare(String(b.ruleId));
    });
  }
}

/** Singleton default engine (compiled once). */
let _default = null;
function getDefaultEngine() {
  if (!_default) _default = new GuardEngine();
  return _default;
}

function resetDefaultEngine() {
  _default = null;
}

module.exports = {
  GuardEngine,
  getDefaultEngine,
  resetDefaultEngine,
  parseSeverity,
  sevRank,
  RULE_UNSOLICITED,
  EXTRA_RULES,
  SEV,
  toJsRegExp,
  compileRules,
};
