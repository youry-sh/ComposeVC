const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const store = require("../store.cjs");
const ffmpeg = require("./ffmpeg.cjs");
const probe = require("./probe.cjs");

/**
 * Motion Studio plugin bridge.
 *
 * A "plan" is a small timeline:
 *   timeline: [title|scene|transition|audio]
 *   output:   { width, height, fps, format, crf, preset }
 *   audio:    { path, gainDb }
 *
 * Rendering is exactly one ffmpeg invocation whose `-filter_complex` is built
 * from that timeline: per-segment color/media inputs, drawtext titles with
 * fade/rise/slide animation, xfade transitions, amix/volume audio. The full
 * argv plus ffmpeg stderr is written into the job's log.txt, progress is
 * reported from ffmpeg's own `time=` markers.
 */

const PLUGIN_ID = "motion";
const active = new Map();
let progressSink = null;

const XFADE_TRANSITIONS = new Set([
  "fade",
  "slideleft",
  "slideright",
  "wipeleft",
  "wiperight",
  "circleopen",
  "dissolve",
]);
const ANIMATIONS = new Set(["fade", "rise", "slide", "typewriter"]);
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".mkv", ".webm", ".m4v", ".avi"]);
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

const THEME_COLORS = {
  clean: { background: "0x0f1117", text: "0xffffff", accent: "0x8b5cf6" },
  dark: { background: "0x08090c", text: "0xf2f4f8", accent: "0x8b5cf6" },
  light: { background: "0xf5f6f8", text: "0x14161b", accent: "0x6d3fd1" },
  bold: { background: "0x160a24", text: "0xffffff", accent: "0xc084fc" },
};

function setProgressSink(sink) {
  progressSink = typeof sink === "function" ? sink : null;
}

function emitProgress(payload) {
  if (!payload) return;
  try {
    if (progressSink) progressSink(payload);
  } catch {
    /* renderer gone */
  }
}

function isFile(candidate) {
  try {
    return fs.statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function clamp(value, fallback, min, max) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.max(min, Math.min(max, Math.round(num)));
}

function clean(value, max = 4000) {
  return String(value == null ? "" : value)
    .trim()
    .slice(0, max);
}

// ── Detection ───────────────────────────────────────────────────────────────

function detect(config, userDataPath = "") {
  const base = ffmpeg.detect(userDataPath, config || {}, "ffmpeg");
  const probeInfo = base.found
    ? ffmpeg.detectProbe(userDataPath, { ...(config || {}), ffmpegPath: base.executable })
    : { found: false, executable: "", version: "", error: "FFprobe не найден." };
  return {
    found: base.found,
    executable: base.executable,
    version: base.version,
    source: base.source,
    error: base.found ? "" : base.error,
    checked: base.checked,
    ffprobe: {
      found: probeInfo.found,
      executable: probeInfo.executable,
      version: probeInfo.version,
      error: probeInfo.error || "",
    },
    note: "",
  };
}

async function probePlugin(userDataPath, config) {
  const detected = detect(config, userDataPath);
  if (!detected.found) {
    return {
      ok: false,
      found: false,
      executable: "",
      version: "",
      filters: [],
      encoders: [],
      error: detected.error,
      checked: detected.checked,
    };
  }
  const run = await ffmpeg.run(detected.executable, ["-hide_banner", "-filters"], { timeoutMs: 20000 });
  const encoderRun = await ffmpeg.run(detected.executable, ["-hide_banner", "-encoders"], { timeoutMs: 20000 });
  const text = run.output || "";
  const encodersText = encoderRun.output || "";
  const filters = ["drawtext", "xfade", "amix", "volume", "scale", "pad", "fps", "trim", "palettegen"].filter((name) =>
    new RegExp(`\\s${name}\\s`).test(text)
  );
  const encoders = ["libx264", "aac", "libvpx-vp9", "libopus", "gif"].filter((name) =>
    new RegExp(`\\s${name}\\s`).test(encodersText)
  );
  const missing = ["drawtext", "xfade", "amix"].filter((name) => !filters.includes(name));
  return {
    ok: isFile(detected.executable),
    found: true,
    executable: detected.executable,
    version: detected.version,
    ffprobe: detected.ffprobe,
    filters,
    encoders,
    warning: missing.length ? `В сборке FFmpeg нет фильтров: ${missing.join(", ")}` : "",
    error: "",
  };
}

// ── Process plumbing ────────────────────────────────────────────────────────

function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
}

async function appendLog(logPath, text) {
  if (!logPath || !text) return;
  try {
    await fs.promises.appendFile(logPath, text.endsWith("\n") ? text : `${text}\n`, "utf8");
  } catch {
    /* log is best effort */
  }
}

function quoteArg(value) {
  const text = String(value);
  return /\s|"/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

/**
 * Run one child process. Never throws for process failures: a timeout, cancel
 * or missing binary comes back as { ok:false, ... }.
 */
function runCommand(executable, args, options = {}) {
  const timeoutSec = Math.max(5, Number(options.timeoutSec) || 3600);
  const jobId = clean(options.jobId, 96);
  const onLine = typeof options.onLine === "function" ? options.onLine : null;
  return new Promise((resolve) => {
    let child;
    let stdout = "";
    let stderr = "";
    let stdoutTail = "";
    let stderrTail = "";
    let canceled = false;
    let timedOut = false;
    let settled = false;
    let lineBuffer = "";
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (jobId) active.delete(jobId);
      resolve(payload);
    };
    try {
      child = spawn(executable, args, {
        windowsHide: true,
        detached: process.platform !== "win32",
        env: process.env,
      });
    } catch (error) {
      resolve({
        ok: false,
        code: -1,
        stdout: "",
        stderr: "",
        stdoutTail: "",
        stderrTail: "",
        timedOut: false,
        canceled: false,
        error: error?.message || String(error),
      });
      return;
    }
    if (jobId) {
      active.set(jobId, {
        child,
        cancel: () => {
          canceled = true;
          killTree(child);
        },
      });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutSec * 1000);
    const consume = (text, stream) => {
      if (stream === "out") {
        stdout += text;
        stdoutTail = (stdoutTail + text).slice(-24000);
      } else {
        stderr += text;
        stderrTail = (stderrTail + text).slice(-24000);
      }
      if (!onLine) return;
      lineBuffer += text;
      // ffmpeg writes progress with "\r" only, so every line terminator counts.
      let match = lineBuffer.match(/\r\n|\r|\n/);
      while (match && match.index != null) {
        const line = lineBuffer.slice(0, match.index);
        lineBuffer = lineBuffer.slice(match.index + match[0].length);
        try {
          onLine(line, stream);
        } catch {
          /* ignore marker parsing errors */
        }
        match = lineBuffer.match(/\r\n|\r|\n/);
      }
    };
    child.stdout?.on("data", (chunk) => consume(chunk.toString("utf8"), "out"));
    child.stderr?.on("data", (chunk) => consume(chunk.toString("utf8"), "err"));
    child.on("error", (error) => {
      finish({
        ok: false,
        code: -1,
        stdout,
        stderr,
        stdoutTail,
        stderrTail,
        timedOut,
        canceled,
        error: error?.message || String(error),
      });
    });
    child.on("close", (code) => {
      const error = canceled
        ? "Задача отменена."
        : timedOut
          ? `FFmpeg не завершился за ${timeoutSec} с.`
          : code === 0
            ? ""
            : `FFmpeg завершился с кодом ${code}.`;
      finish({
        ok: code === 0 && !canceled && !timedOut,
        code,
        stdout,
        stderr,
        stdoutTail,
        stderrTail,
        timedOut,
        canceled,
        error,
      });
    });
  });
}

// ── Plan normalisation ─────────────────────────────────────────────────────

function slugify(value, fallback = "motion") {
  const map = {
    а: "a", б: "b", в: "v", г: "g", д: "d", е: "e", ё: "e", ж: "zh", з: "z", и: "i", й: "y",
    к: "k", л: "l", м: "m", н: "n", о: "o", п: "p", р: "r", с: "s", т: "t", у: "u", ф: "f",
    х: "h", ц: "c", ч: "ch", ш: "sh", щ: "sch", ъ: "", ы: "y", ь: "", э: "e", ю: "yu", я: "ya",
  };
  const text = String(value || "")
    .toLowerCase()
    .split("")
    .map((char) => (map[char] == null ? char : map[char]))
    .join("")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return text || fallback;
}

function timestamp() {
  const date = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function normalizeOutput(plan, config) {
  const src = plan?.output && typeof plan.output === "object" ? plan.output : {};
  const format = String(src.format || config?.format || "mp4").toLowerCase();
  return {
    width: clamp(src.width, clamp(config?.width, 1920, 240, 7680), 240, 7680),
    height: clamp(src.height, clamp(config?.height, 1080, 240, 7680), 240, 7680),
    fps: clamp(src.fps, clamp(config?.fps, 30, 12, 120), 12, 120),
    crf: clamp(src.crf, clamp(config?.crf, 20, 0, 51), 0, 51),
    preset: store.MOTION_PRESETS.includes(String(src.preset || ""))
      ? String(src.preset)
      : store.MOTION_PRESETS.includes(String(config?.preset || ""))
        ? String(config.preset)
        : "medium",
    format: store.MOTION_FORMATS.includes(format) ? format : "mp4",
  };
}

function normalizeTimeline(plan) {
  const source = Array.isArray(plan?.timeline) ? plan.timeline : [];
  const items = [];
  source.forEach((raw, index) => {
    if (!raw || typeof raw !== "object") return;
    const kind = ["title", "scene", "transition", "audio"].includes(String(raw.kind)) ? String(raw.kind) : "title";
    const start = Math.max(0, Number(raw.start) || 0);
    const end = Math.max(start + 0.1, Number(raw.end) || start + 2.5);
    const item = {
      id: clean(raw.id, 64) || `item-${index + 1}`,
      kind,
      start: Math.round(start * 100) / 100,
      end: Math.round(end * 100) / 100,
      duration: Math.round((end - start) * 100) / 100,
      text: clean(raw.text, 400),
      animation: ANIMATIONS.has(String(raw.animation)) ? String(raw.animation) : "fade",
      transition: XFADE_TRANSITIONS.has(String(raw.transition)) ? String(raw.transition) : "fade",
      path: clean(raw.path, 4096),
      volume: Number.isFinite(Number(raw.volume)) ? Math.max(0, Math.min(2, Number(raw.volume))) : 1,
    };
    if (kind === "audio" && !item.path) return;
    if (kind !== "audio" && !item.text && !item.path) return;
    items.push(item);
  });
  items.sort((a, b) => a.start - b.start || (a.kind === "transition" ? -1 : 1));
  return items;
}

function resolveFontFile(family) {
  const wanted = String(family || "").trim();
  const candidates = [];
  if (process.platform === "win32") {
    const local = process.env.LOCALAPPDATA || "";
    const windir = process.env.WINDIR || "C:\\Windows";
    const fontsDir = path.join(windir, "Fonts");
    for (const name of [wanted, "Inter", "Segoe UI", "Arial"]) {
      const file = name.replace(/\s+/g, "") ;
      candidates.push(
        path.join(fontsDir, `${file}-Regular.ttf`),
        path.join(fontsDir, `${file}.ttf`),
        local ? path.join(local, "Microsoft", "Windows", "Fonts", `${file}-Regular.ttf`) : ""
      );
    }
    candidates.push(path.join(fontsDir, "segoeui.ttf"), path.join(fontsDir, "arial.ttf"));
  } else if (process.platform === "darwin") {
    candidates.push(
      "/System/Library/Fonts/Supplemental/Arial.ttf",
      "/System/Library/Fonts/Supplemental/Helvetica.ttf",
      "/System/Library/Fonts/Helvetica.ttc",
      "/Library/Fonts/Arial.ttf"
    );
  } else {
    candidates.push(
      "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
      "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
      "/usr/share/fonts/TTF/DejaVuSans.ttf",
      "/usr/share/fonts/dejavu/DejaVuSans.ttf"
    );
    if (wanted) {
      try {
        const output = execFileSync("fc-match", ["-f", "%{file}", wanted], {
          timeout: 4000,
          windowsHide: true,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        });
        const match = String(output || "").trim();
        if (match) candidates.unshift(match);
      } catch {
        /* fontconfig is optional */
      }
    }
  }
  for (const candidate of candidates) {
    if (candidate && isFile(candidate)) return candidate;
  }
  return "";
}

// ── Filter graph ────────────────────────────────────────────────────────────

function escapeText(text) {
  return String(text == null ? "" : text)
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/,/g, "\\,")
    .replace(/%/g, "\\%")
    .replace(/'/g, "\u2019")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]")
    .replace(/;/g, "\\;")
    .replace(/\r?\n/g, " ");
}

function escapeExpr(expression) {
  return String(expression).replace(/,/g, "\\,");
}

function fontOption(fontFile, family) {
  if (fontFile) return `fontfile=${fontFile.replace(/\\/g, "/").replace(/:/g, "\\:")}`;
  const safe = String(family || "sans-serif").replace(/[^A-Za-z0-9 _-]/g, "").trim() || "sans-serif";
  return `font=${escapeText(safe)}`;
}

function wrapLines(text, maxChars) {
  const paragraphs = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const lines = [];
  for (const paragraph of paragraphs) {
    const words = paragraph.split(/\s+/);
    let line = "";
    for (const word of words) {
      if (!line) {
        line = word;
        continue;
      }
      if ((line + " " + word).length <= maxChars) line += ` ${word}`;
      else {
        lines.push(line);
        line = word;
      }
    }
    if (line) lines.push(line);
  }
  return lines.length ? lines.slice(0, 4) : [];
}

function drawTextFilters(options) {
  const {
    text,
    width,
    height,
    fontFile,
    fontFamily,
    color,
    animation,
    duration,
    safeMargins,
    fontSize,
    lineIndex,
    lineCount,
  } = options;
  const lines = wrapLines(text, Math.max(8, Math.floor((width * (safeMargins ? 0.78 : 0.92)) / (fontSize * 0.56))));
  const chosen = lines.length ? lines : [String(text || "")];
  const filters = [];
  const fade = 0.55;
  const alpha =
    animation === "typewriter"
      ? escapeExpr(`min(1,t/${Math.min(0.4, duration / 3)})`)
      : escapeExpr(`if(lt(t,${fade}),t/${fade},if(gt(t,${Math.max(0, duration - fade)}),max(0,((${duration})-t)/${fade}),1))`);
  chosen.forEach((line, index) => {
    const offset = (index - (chosen.length - 1) / 2) * fontSize * 1.24;
    const baseY = `h*0.5+${Math.round(offset)}`;
    let x = "(w-text_w)/2";
    let y = baseY;
    if (animation === "rise") y = `${baseY}+${Math.round(fontSize * 0.9)}*(1-min(t/${fade},1))`;
    if (animation === "slide") x = `(w-text_w)/2-w*0.45*(1-min(t/${fade},1))`;
    const yExpr = /[a-z]/i.test(y) ? escapeExpr(y) : y;
    const xExpr = /[a-z]/i.test(x) ? escapeExpr(x) : x;
    filters.push(
      `drawtext=${[
        fontOption(fontFile, fontFamily),
        `text=${escapeText(line)}`,
        `fontsize=${fontSize}`,
        `fontcolor=${color}`,
        `x=${xExpr}`,
        `y=${yExpr}`,
        `alpha=${alpha}`,
        "shadowcolor=0x000000@0.45",
        "shadowx=0",
        "shadowy=2",
        `line_spacing=${Math.round(fontSize * 0.2)}`,
        `enable=${escapeExpr(`between(t,0,${duration})`)}`,
      ].join(":")}`
    );
  });
  void lineIndex;
  void lineCount;
  return filters;
}

function buildRenderCommand(plan, config, outputPath, durationSec, jobInfo) {
  const output = normalizeOutput(plan, config);
  const timeline = normalizeTimeline(plan);
  const segments = [];
  let pendingTransition = null;
  const audioItems = [];
  for (const item of timeline) {
    if (item.kind === "transition") {
      pendingTransition = item;
      continue;
    }
    if (item.kind === "audio") {
      audioItems.push(item);
      continue;
    }
    segments.push({ ...item, transitionIn: pendingTransition });
    pendingTransition = null;
  }
  if (!segments.length) {
    return { ok: false, error: "В таймлайне нет ни одного титра или сцены." };
  }
  const theme = THEME_COLORS[String(config?.theme || "clean")] || THEME_COLORS.clean;
  const fontFile = resolveFontFile(config?.fontFamily);
  const fontFamily = config?.fontFamily || "Inter";
  const width = output.width;
  const height = output.height;
  const fps = output.fps;
  const args = ["-hide_banner", "-y"];
  const parts = [];
  const videoLabels = [];
  let inputCount = 0;

  segments.forEach((segment, index) => {
    const dur = Math.max(0.2, Number(segment.duration) || 2.5);
    if (segment.path && isFile(segment.path)) {
      const ext = path.extname(segment.path).toLowerCase();
      if (IMAGE_EXTENSIONS.has(ext)) {
        args.push("-loop", "1", "-framerate", String(fps), "-t", dur.toFixed(3), "-i", segment.path);
      } else {
        args.push("-t", dur.toFixed(3), "-i", segment.path);
      }
      const filterInput = inputCount;
      inputCount += 1;
      parts.push(
        `[${filterInput}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
          `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=${theme.background},setsar=1,fps=${fps},` +
          `trim=duration=${dur.toFixed(3)},setpts=PTS-STARTPTS[s${index}]`
      );
    } else {
      args.push("-f", "lavfi", "-t", dur.toFixed(3), "-i", `color=c=${theme.background}:s=${width}x${height}:r=${fps}`);
      const filterInput = inputCount;
      inputCount += 1;
      parts.push(`[${filterInput}:v]fps=${fps},trim=duration=${dur.toFixed(3)},setpts=PTS-STARTPTS[s${index}]`);
    }
    const isTitle = segment.kind === "title" || Boolean(segment.text);
    const lastLabel = `s${index}`;
    if (isTitle && segment.text) {
      const fontSize = Math.max(
        18,
        Math.round((height * (segment.kind === "title" ? 0.062 : 0.042)) / 1)
      );
      const filters = drawTextFilters({
        text: segment.text,
        width,
        height,
        fontFile,
        fontFamily,
        color: theme.text,
        animation: segment.animation,
        duration: dur,
        safeMargins: config?.safeMargins !== false,
        fontSize,
        lineIndex: 0,
        lineCount: 1,
      });
      let previous = lastLabel;
      filters.forEach((filter, filterIndex) => {
        const label = `t${index}_${filterIndex}`;
        parts.push(`[${previous}]${filter}[${label}]`);
        previous = label;
      });
      parts.push(`[${previous}]null[v${index}]`);
    } else {
      parts.push(`[${lastLabel}]null[v${index}]`);
    }
    videoLabels.push({ label: `v${index}`, duration: dur, transitionIn: segment.transitionIn });
  });

  let total = videoLabels[0].duration;
  let current = videoLabels[0].label;
  for (let index = 1; index < videoLabels.length; index += 1) {
    const item = videoLabels[index];
    const transition = item.transitionIn;
    const transitionDuration = transition
      ? Math.max(0.1, Math.min(item.duration / 2, Number(transition.duration) || 0.6, total / 2))
      : 0;
    const outLabel = `x${index}`;
    if (transition && transitionDuration >= 0.1) {
      const offset = Math.max(0, total - transitionDuration);
      const name = XFADE_TRANSITIONS.has(String(transition.transition)) ? transition.transition : "fade";
      parts.push(
        `[${current}][${item.label}]xfade=transition=${name}:duration=${transitionDuration.toFixed(
          3
        )}:offset=${offset.toFixed(3)}[${outLabel}]`
      );
      total = total + item.duration - transitionDuration;
    } else {
      parts.push(`[${current}][${item.label}]concat=n=2:v=1:a=0[${outLabel}]`);
      total += item.duration;
    }
    current = outLabel;
  }
  total = Math.max(0.2, Math.round(total * 1000) / 1000);

  // Optional background audio + timeline audio tracks.
  const audioSources = [];
  if (plan?.audio && typeof plan.audio === "object" && clean(plan.audio.path)) {
    audioSources.push({ path: clean(plan.audio.path), gainDb: Number(plan.audio.gainDb) || 0, volume: 1 });
  }
  for (const item of audioItems) {
    const gainDb = item.volume && item.volume !== 1 ? 20 * Math.log10(item.volume) : 0;
    audioSources.push({ path: item.path, gainDb, volume: item.volume });
  }
  const usableAudio = audioSources.filter((entry) => isFile(entry.path));
  let audioLabel = "";
  if (usableAudio.length) {
    const labels = [];
    usableAudio.forEach((source, index) => {
      const inputIndex = inputCount;
      inputCount += 1;
      args.push("-i", source.path);
      const gain = Math.max(-40, Math.min(20, Number(source.gainDb) || 0));
      parts.push(
        `[${inputIndex}:a]volume=${gain.toFixed(2)}dB,atrim=duration=${total.toFixed(3)},asetpts=PTS-STARTPTS[a${index}]`
      );
      labels.push(`a${index}`);
    });
    if (labels.length === 1) {
      parts.push(`[${labels[0]}]alimiter=limit=0.98[aout]`);
    } else {
      parts.push(
        `${labels.map((label) => `[${label}]`).join("")}amix=inputs=${labels.length}:duration=longest:dropout_transition=0,` +
          `alimiter=limit=0.98[aout]`
      );
    }
    audioLabel = "aout";
  }

  let finalVideo = current;
  if (output.format === "gif") {
    parts.push(`[${finalVideo}]split[g0][g1]`);
    parts.push(`[g0]palettegen=stats_mode=diff[gp]`);
    parts.push(`[g1][gp]paletteuse=dither=bayer[vout]`);
    finalVideo = "vout";
  } else {
    parts.push(`[${finalVideo}]format=yuv420p[vout]`);
    finalVideo = "vout";
  }

  const filterGraph = parts.join(";");
  args.push("-filter_complex", filterGraph);
  args.push("-map", `[${finalVideo}]`);
  if (audioLabel) args.push("-map", `[${audioLabel}]`);

  if (output.format === "webm") {
    args.push("-c:v", "libvpx-vp9", "-crf", String(output.crf), "-b:v", "0", "-row-mt", "1");
    if (audioLabel) args.push("-c:a", "libopus", "-b:a", `${clamp(config?.audioBitrateKbps, 192, 32, 512)}k`);
  } else if (output.format === "gif") {
    args.push("-c:v", "gif", "-loop", "0");
  } else {
    args.push("-c:v", "libx264", "-preset", output.preset, "-crf", String(output.crf), "-pix_fmt", "yuv420p");
    if (output.format === "mp4") args.push("-movflags", "+faststart");
    if (audioLabel) args.push("-c:a", "aac", "-b:a", `${clamp(config?.audioBitrateKbps, 192, 32, 512)}k`);
  }
  args.push("-t", total.toFixed(3), "-shortest", outputPath);

  return {
    ok: true,
    args,
    filterGraph,
    output,
    total,
    segments: segments.length,
    audio: usableAudio.map((entry) => entry.path),
    fontFile,
    jobInfo,
  };
}

// ── Job plumbing ────────────────────────────────────────────────────────────

async function finishJob(userDataPath, job, patch) {
  const finishedAt = Date.now();
  const status = patch.status || (patch.error ? "failed" : "succeeded");
  const updated = await store.updateJob(userDataPath, job.id, {
    ...patch,
    status,
    finishedAt,
    durationMs: finishedAt - (job.startedAt || job.createdAt || finishedAt),
  });
  try {
    const record = await store.getPlugin(userDataPath, PLUGIN_ID);
    await store.updatePlugin(userDataPath, PLUGIN_ID, {
      stats: {
        runs: (record?.stats?.runs || 0) + 1,
        failures: (record?.stats?.failures || 0) + (status === "succeeded" ? 0 : 1),
        lastRunAt: finishedAt,
        lastError: status === "succeeded" ? "" : String(updated.error || "").slice(0, 700),
      },
    });
  } catch {
    /* stats are best effort */
  }
  emitProgress({
    jobId: updated.id,
    pluginId: PLUGIN_ID,
    status: updated.status,
    stage: updated.stage,
    percent: updated.progress,
    done: true,
    error: updated.error || "",
  });
  return updated;
}

async function withJob(userDataPath, options, work) {
  const config = options.config || {};
  const detected = detect(config, userDataPath);
  const job = await store.createJob(userDataPath, {
    pluginId: PLUGIN_ID,
    kind: options.kind || "render",
    title: String(options.title || "Motion Studio"),
  });
  const startedAt = Date.now();
  let running = await store.updateJob(userDataPath, job.id, {
    status: "running",
    startedAt,
    stage: "prepare",
    progress: 1,
    motion: { path: detected.executable, version: detected.version || "" },
  });
  emitProgress({ jobId: running.id, pluginId: PLUGIN_ID, stage: "prepare", percent: 1, status: "running" });
  const setStage = async (stage, percent) => {
    const value = Math.max(0, Math.min(100, Math.round(Number(percent) || 0)));
    emitProgress({ jobId: running.id, pluginId: PLUGIN_ID, stage, percent: value, status: "running" });
    try {
      const next = await store.updateJob(userDataPath, running.id, { stage, progress: value });
      running = next;
    } catch {
      /* job write must not abort the render */
    }
  };
  const ctx = {
    jobId: running.id,
    logPath: running.logPath,
    stage: (stage, percent) => {
      void setStage(stage, percent);
    },
    setStage,
  };
  try {
    const outcome = await work({ job: running, detected, ctx, setStage, config });
    const canceled = outcome?.canceled === true;
    const failed = !canceled && !outcome?.ok;
    const status = canceled ? "canceled" : failed ? "failed" : "succeeded";
    const updated = await finishJob(userDataPath, running, {
      status,
      progress: failed ? clamp(outcome?.progress, 5, 0, 99) : status === "succeeded" ? 100 : clamp(outcome?.progress, 5, 0, 99),
      stage: status === "succeeded" ? "done" : status,
      error: canceled ? "" : outcome?.error || "",
      warnings: Array.isArray(outcome?.warnings) ? outcome.warnings : [],
      summary: outcome?.summary || "",
      previewPath: outcome?.previewPath || "",
      exports: Array.isArray(outcome?.exports) ? outcome.exports : [],
      motion: {
        path: detected.executable,
        version: detected.version || "",
        durationSec: Math.max(0, Number(outcome?.durationSec) || 0),
        frames: Math.max(0, Math.round((Number(outcome?.durationSec) || 0) * (Number(outcome?.fps) || 0))),
        width: clamp(outcome?.width, 0, 0, 7680),
        height: clamp(outcome?.height, 0, 0, 7680),
        audioPath: clean(outcome?.audioPath, 4096),
      },
    });
    return { ...outcome, job: updated };
  } catch (error) {
    const message = error?.message || String(error);
    const updated = await finishJob(userDataPath, running, {
      status: "failed",
      stage: "failed",
      error: message,
      summary: message,
      motion: {
        path: detected.executable,
        version: detected.version || "",
        durationSec: 0,
        frames: 0,
        width: 0,
        height: 0,
        audioPath: "",
      },
    });
    return { ok: false, error: message, job: updated };
  } finally {
    await store.pruneJobs(userDataPath, store.MAX_JOBS).catch(() => {});
  }
}

function safeOutputPath(userDataPath, config, fileName) {
  const root = path.resolve(store.resolveOutputDir(userDataPath, config));
  const target = path.resolve(root, fileName);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Путь вывода оказался вне каталога результатов.");
  }
  return { root, target };
}

function parseTimeMarker(text) {
  const match = String(text || "").match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

// ── Public operations ──────────────────────────────────────────────────────

function planDuration(plan) {
  const items = normalizeTimeline(plan);
  const segments = items.filter((item) => item.kind !== "transition" && item.kind !== "audio");
  if (!segments.length) return 0;
  const transitions = items.filter((item) => item.kind === "transition");
  const total = segments.reduce((sum, item) => sum + item.duration, 0);
  const overlap = Math.min(
    transitions.reduce((sum, item) => sum + Math.min(item.duration, 2), 0),
    total > 0 ? total - 0.2 : 0
  );
  return Math.max(0, Math.round((total - overlap) * 100) / 100);
}

async function runProject(userDataPath, config, plan, options = {}) {
  const detected = detect(config, userDataPath);
  if (!detected.found) {
    return { ok: false, error: detected.error || "FFmpeg не найден. Нажмите «Установить FFmpeg».", job: null };
  }
  const normalized = normalizeTimeline(plan);
  if (!normalized.some((item) => item.kind === "title" || item.kind === "scene")) {
    return { ok: false, error: "В таймлайне нет ни одного титра или сцены.", job: null };
  }
  const output = normalizeOutput(plan, config);
  const baseTitle = options.title || clean(plan?.name, 160) || "Ролик";
  const fileName = `${slugify(baseTitle)}-${timestamp()}.${output.format}`;
  const { root, target } = safeOutputPath(userDataPath, config, fileName);
  await fs.promises.mkdir(root, { recursive: true });

  return withJob(userDataPath, { kind: options.kind || "render", title: baseTitle, config }, async ({ job, ctx, setStage }) => {
    await setStage("build", 4);
    const built = buildRenderCommand(plan, config, target, planDuration(plan), { jobId: job.id });
    if (!built.ok) {
      return { ok: false, error: built.error, progress: 4, exports: [] };
    }
    await appendLog(
      job.logPath,
      [
        `Motion Studio · ${baseTitle}`,
        `FFmpeg ${detected.version || "?"} · ${detected.executable}`,
        `Вывод: ${target}`,
        `Длительность: ${built.total.toFixed(2)} с · ${built.output.width}x${built.output.height}@${built.output.fps} · ${built.output.format}`,
        `Сегментов: ${built.segments} · аудио: ${built.audio.length ? built.audio.join(", ") : "нет"}`,
        built.fontFile ? `Шрифт: ${built.fontFile}` : `Шрифт: ${config?.fontFamily || "Inter"} (fontconfig)`,
        "",
        "Фильтр:",
        built.filterGraph,
        "",
        `$ ffmpeg ${built.args.map(quoteArg).join(" ")}`,
        "",
      ].join("\n")
    );
    await setStage("render", 8);
    let lastPercent = 8;
    const result = await runCommand(detected.executable, built.args, {
      timeoutSec: clamp(config?.timeoutSec, 3600, 10, 7200),
      jobId: job.id,
      onLine: (line) => {
        const seconds = parseTimeMarker(line);
        if (!seconds || !built.total) return;
        const percent = Math.max(8, Math.min(96, 8 + (seconds / built.total) * 88));
        if (percent - lastPercent >= 1) {
          lastPercent = percent;
          ctx.stage("render", percent);
        }
      },
    });
    if (result.logPath) void result.logPath;
    if (result.canceled) {
      return {
        ok: false,
        canceled: true,
        error: "Задача отменена.",
        progress: Math.round(lastPercent),
        exports: [],
        durationSec: built.total,
        fps: built.output.fps,
        width: built.output.width,
        height: built.output.height,
        audioPath: built.audio[0] || "",
      };
    }
    const artifact = isFile(target) ? await fs.promises.stat(target) : null;
    if (!result.ok || !artifact || artifact.size < 1024) {
      const detail = `${result.stderrTail || ""}`
        .split(/\r?\n/)
        .filter((line) => /error|invalid|failed|could not|unable/i.test(line))
        .slice(-4)
        .join(" ");
      return {
        ok: false,
        error:
          result.error && detail
            ? `${result.error} ${detail.slice(0, 800)}`
            : result.error || detail || "FFmpeg не создал файл ролика.",
        progress: Math.min(99, Math.round(lastPercent)),
        exports: [],
        durationSec: built.total,
        fps: built.output.fps,
        width: built.output.width,
        height: built.output.height,
        audioPath: built.audio[0] || "",
      };
    }
    await setStage("preview", 97);
    const previewFile = path.join(job.dir, "frame.png");
    await runCommand(
      detected.executable,
      ["-hide_banner", "-y", "-ss", "0.5", "-i", target, "-frames:v", "1", previewFile],
      { timeoutSec: 60, logPath: null }
    );
    const previewPath = isFile(previewFile) ? previewFile : "";
    return {
      ok: true,
      error: "",
      progress: 100,
      durationSec: built.total,
      fps: built.output.fps,
      width: built.output.width,
      height: built.output.height,
      audioPath: built.audio[0] || "",
      previewPath,
      exports: [{ format: built.output.format.toUpperCase(), path: target, bytes: artifact.size }],
      summary: `${built.output.format.toUpperCase()} ${built.output.width}×${built.output.height} · ${built.total.toFixed(
        1
      )} с · ${(artifact.size / (1024 * 1024)).toFixed(2)} МБ`,
      warnings: [],
    };
  });
}

async function runDemo(userDataPath, config) {
  const plan = {
    name: "Демо: Motion Studio",
    timeline: [
      { id: "d1", kind: "title", text: "Motion Studio", animation: "fade", start: 0, end: 2 },
      { id: "d2", kind: "transition", transition: "dissolve", start: 2, end: 2.6 },
      { id: "d3", kind: "title", text: "Титры, переходы, звук", animation: "rise", start: 2, end: 4 },
      { id: "d4", kind: "transition", transition: "slideleft", start: 4, end: 4.5 },
      { id: "d5", kind: "title", text: "ComposeVC", animation: "slide", start: 4, end: 6 },
    ],
    output: { width: config?.width, height: config?.height, fps: config?.fps, format: config?.format, crf: config?.crf, preset: config?.preset },
    audio: { path: "", gainDb: 0 },
  };
  return runProject(userDataPath, config, plan, { title: "Демо: Motion Studio", kind: "render" });
}

async function probeFile(userDataPath, config, filePath) {
  const target = clean(filePath, 4096);
  if (!target) return { ok: false, media: null, error: "Не указан файл." };
  if (!isFile(target)) return { ok: false, media: null, error: `Не удалось прочитать файл: ${target}` };
  const detected = detect(config, userDataPath);
  const probePath = detected.ffprobe?.found
    ? detected.ffprobe.executable
    : config?.ffprobePath && isFile(config.ffprobePath)
      ? config.ffprobePath
      : "";
  if (!probePath) {
    return { ok: false, media: null, error: "FFprobe не найден. Установите FFmpeg заново или укажите ffprobe." };
  }
  const result = await probe.ffprobeJson(probePath, target);
  if (!result.ok) return { ok: false, media: null, error: result.error || "Не удалось прочитать файл." };
  return { ok: true, media: probe.summarize(result.json), error: "", executable: probePath };
}

async function listMedia(dirPath, limit = 200) {
  return probe.listDirMedia(dirPath, limit);
}

function cancelJob(jobId) {
  const entry = active.get(String(jobId || ""));
  if (!entry) return { canceled: false, reason: "not-running" };
  entry.cancel();
  return { canceled: true };
}

function listRunning() {
  return Array.from(active.keys());
}

async function readPreviewDataUrl(userDataPath, jobId, name) {
  const job = await store.getJob(userDataPath, jobId);
  if (!job) throw new Error("Задача не найдена.");
  const candidates = [];
  if (name) candidates.push(path.join(job.dir, path.basename(String(name))));
  if (job.previewPath) candidates.push(job.previewPath);
  try {
    for (const entry of await fs.promises.readdir(job.dir, { withFileTypes: true })) {
      if (entry.isFile() && /\.(png|jpg|jpeg|webp)$/i.test(entry.name)) candidates.push(path.join(job.dir, entry.name));
    }
  } catch {
    /* job dir is gone */
  }
  const file = candidates.find((candidate) => candidate && path.resolve(candidate).startsWith(path.resolve(job.dir)) && isFile(candidate));
  if (!file) throw new Error("У задачи нет кадра-превью.");
  const stat = await fs.promises.stat(file);
  if (stat.size > 24 * 1024 * 1024) throw new Error("Превью слишком большое.");
  const ext = path.extname(file).toLowerCase();
  const mime = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
  const base64 = (await fs.promises.readFile(file)).toString("base64");
  return { dataUrl: `data:${mime};base64,${base64}`, path: file, bytes: stat.size };
}

async function deleteJob(userDataPath, jobId) {
  if (active.has(String(jobId || ""))) throw new Error("Нельзя удалить выполняющуюся задачу.");
  return store.deleteJob(userDataPath, jobId);
}

void os;

module.exports = {
  PLUGIN_ID,
  setProgressSink,
  detect,
  probe: probePlugin,
  runProject,
  runDemo,
  probeFile,
  listMedia,
  cancelJob,
  listRunning,
  readPreviewDataUrl,
  deleteJob,
  buildRenderCommand,
  normalizeTimeline,
  slugify,
  isFile,
};
