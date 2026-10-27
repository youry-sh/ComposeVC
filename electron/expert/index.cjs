/**
 * Expert workspace service.
 *
 * A normal chat answers; Expert studies the whole repository once per folder,
 * keeps that study on disk, and then composes implementation prompts that are
 * wired into the code that already exists.
 *
 * Pipeline per send:
 *   1. resolve model/provider (same provider config as chat)
 *   2. ensure a persisted project study  (scan → themed agent rounds → dossier)
 *   3. compose ONE prompt from dossier + verified digest + the user's task
 *   4. persist the Expert chat session (survives app restart)
 *
 * Everything is cancellable; every phase reports progress on `expert:progress`.
 */

const fs = require("fs");
const path = require("path");
const { BrowserWindow, clipboard, ipcMain } = require("electron");
const { Worker } = require("worker_threads");

const store = require("./store.cjs");
const scanLib = require("./scan.cjs");
const prompts = require("./prompts.cjs");

const PROGRESS_CHANNEL = "expert:progress";
const STUDY_MAX_EXTRA_ROUNDS = 3;
const STUDY_ROUND_ITERATIONS = 10;
const COMPOSE_ITERATIONS = 8;
const STUDY_ROUND_TIMEOUT_MS = 16 * 60 * 1000;
const MAX_CONVERSATION_CHARS = 14000;

const READONLY_EXCLUDE = [
  "edit_file",
  "create_file",
  "bash",
  "wsl",
  "restore_backup",
  "custom_tool",
  "telegram",
  "proxy_manager",
  "runner",
  "vm",
  "generate_image",
  "spawn_subagent",
  "spawn_subagent_batch",
  "wait_subagents",
  "cf_mail",
  "ask_otp",
  "ask_user",
  "work_timer",
  "compact_history",
  "knowledge",
  "mcp_manager",
  "git",
  "shodan",
  "http",
  "web_search",
  "web_fetch",
  "think",
  "vision",
  "vision_blender",
  "blender",
  "plugin",
];

function createExpertService(deps = {}) {
  const { app, runAgentLoop, readProviderConfig, resolveModelLimits, clampTokenSetting, countTokens } = deps;
  if (!app || typeof runAgentLoop !== "function") {
    throw new Error("Expert service needs the Electron app and runAgentLoop");
  }

  const runs = new Map(); // slotId -> { controller, sessionId, runId }
  const studyRuns = new Map(); // slotId -> AbortController (background study only)
  const studyJobs = new Map(); // projectKey -> Promise<study>
  const progressState = new Map(); // slotId -> { timer, pending }

  function userData() {
    return app.getPath("userData");
  }

  function sendProgress(payload) {
    for (const win of BrowserWindow.getAllWindows()) {
      try {
        if (!win.isDestroyed()) win.webContents.send(PROGRESS_CHANNEL, payload);
      } catch {
        /* window gone */
      }
    }
  }

  function emit(slotId, payload) {
    const key = String(slotId || "expert-1");
    const state = progressState.get(key) || { timer: null, pending: null };
    state.pending = { ...payload, slotId: key, at: Date.now() };
    if (payload.immediate) {
      if (state.timer) {
        clearTimeout(state.timer);
        state.timer = null;
      }
      const next = state.pending;
      state.pending = null;
      progressState.set(key, state);
      sendProgress(next);
      return;
    }
    if (!state.timer) {
      state.timer = setTimeout(() => {
        state.timer = null;
        const next = state.pending;
        state.pending = null;
        if (next) sendProgress(next);
      }, 110);
    }
    progressState.set(key, state);
  }

  async function resolveModel(modelId) {
    const config = await readProviderConfig();
    const models = Array.isArray(config?.models) ? config.models : [];
    const model =
      models.find((item) => item.id === modelId) ||
      models.find((item) => item.id === config?.selectedModelId) ||
      models[0];
    if (!model) throw new Error("No model configured. Add a model in Providers first.");
    const provider = (config.providers || []).find((item) => item.id === model.providerId);
    if (!provider) throw new Error("Provider for the selected model is missing");
    if (!provider.apiKey) throw new Error(`API key is empty for ${provider.name || provider.id}`);
    let limits = null;
    try {
      limits = await resolveModelLimits(model, provider);
    } catch {
      limits = null;
    }
    const context = clampTokenSetting(limits?.context ?? model.contextLimit, model.contextLimit || 64_000, {
      min: 8_000,
      max: 2_000_000,
    });
    return {
      config,
      provider,
      model: {
        ...model,
        contextLimit: context,
        outputLimit: limits?.output || model.outputLimit || undefined,
      },
      context,
      compact: Math.max(4_000, Math.floor(context * 0.8)),
    };
  }

  async function scanInWorker(rootPath, signal) {
    return new Promise((resolve, reject) => {
      let worker;
      try {
        worker = new Worker(path.join(__dirname, "scanWorker.cjs"), {
          workerData: { rootPath },
        });
      } catch (error) {
        reject(error);
        return;
      }
      let settled = false;
      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener?.("abort", onAbort);
        try {
          worker.terminate();
        } catch {
          /* ignore */
        }
        fn(value);
      };
      const onAbort = () => {
        const error = new Error("Aborted");
        error.name = "AbortError";
        finish(reject, error);
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener?.("abort", onAbort, { once: true });
      worker.once("message", (message) => {
        if (message?.ok) finish(resolve, message);
        else finish(reject, new Error(message?.error || "Project scan failed"));
      });
      worker.once("error", (error) => finish(reject, error));
      worker.once("exit", (code) => {
        if (!settled && code !== 0) finish(reject, new Error(`Project scan worker exited (${code})`));
      });
    });
  }

  async function scanProjectSafely(rootPath, signal) {
    try {
      return await scanInWorker(rootPath, signal);
    } catch (error) {
      if (error?.name === "AbortError" || signal?.aborted) throw error;
      // Worker unavailable (packaging/permissions) — degrade to the main thread.
      const result = scanLib.scanProject(rootPath);
      return { ok: true, scan: result.scan, digest: result.digest };
    }
  }

  function toolContextFor(rootPath, projectName) {
    return {
      rootPath: rootPath || null,
      projectName: projectName || null,
      userDataPath: userData(),
      customToolQuery: "",
    };
  }

  function makeLocalSignal(parent) {
    const local = new AbortController();
    const onAbort = () => {
      try {
        local.abort();
      } catch {
        /* ignore */
      }
    };
    if (parent?.aborted) onAbort();
    else parent?.addEventListener?.("abort", onAbort, { once: true });
    return {
      signal: local.signal,
      abort: () => {
        try {
          local.abort();
        } catch {
          /* ignore */
        }
      },
      dispose: () => parent?.removeEventListener?.("abort", onAbort),
    };
  }

  function normalizeRel(input, rootPath) {
    const raw =
      input?.path || input?.file_path || input?.filePath || input?.file || input?.directory || input?.dir || "";
    if (typeof raw !== "string" || !raw) return null;
    try {
      const abs = path.isAbsolute(raw) ? raw : path.join(rootPath, raw);
      const rel = path.relative(rootPath, abs).replace(/\\/g, "/");
      if (!rel || rel.startsWith("..")) return null;
      return rel;
    } catch {
      return null;
    }
  }

  function mergeDossier(previous, incoming, roundId) {
    const base = previous && typeof previous === "object" ? previous : {};
    const next = {
      summary: base.summary || "",
      architecture: base.architecture || "",
      modules: Array.isArray(base.modules) ? [...base.modules] : [],
      flows: Array.isArray(base.flows) ? [...base.flows] : [],
      contracts: Array.isArray(base.contracts) ? [...base.contracts] : [],
      conventions: Array.isArray(base.conventions) ? [...base.conventions] : [],
      reuse: Array.isArray(base.reuse) ? [...base.reuse] : [],
      gaps: Array.isArray(base.gaps) ? [...base.gaps] : [],
      glossary: Array.isArray(base.glossary) ? [...base.glossary] : [],
      rounds: Array.isArray(base.rounds) ? [...base.rounds] : [],
    };
    const inc = incoming && typeof incoming === "object" ? incoming : {};

    const pushUnique = (target, items, keyOf) => {
      const seen = new Set(target.map((item) => keyOf(item)));
      for (const item of Array.isArray(items) ? items : []) {
        if (!item) continue;
        const key = keyOf(item);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        if (target.length < 400) target.push(item);
      }
    };

    if (typeof inc.summary === "string" && inc.summary.trim() && !next.summary) {
      next.summary = inc.summary.trim().slice(0, 4000);
    }
    if (typeof inc.architecture === "string" && inc.architecture.trim()) {
      next.architecture = `${next.architecture ? `${next.architecture}\n` : ""}${inc.architecture.trim().slice(0, 6000)}`.slice(0, 14000);
    }
    pushUnique(next.modules, inc.modules, (item) => String(item?.path || item?.role || "").toLowerCase());
    pushUnique(next.flows, inc.flows, (item) => String(item?.name || "").toLowerCase());
    pushUnique(
      next.contracts,
      inc.contracts,
      (item) => `${String(item?.kind || "").toLowerCase()}|${String(item?.id || "").toLowerCase()}`
    );
    pushUnique(next.conventions, inc.conventions, (item) => String(item || "").toLowerCase());
    pushUnique(next.reuse, inc.reuse, (item) => String(item?.need || "").toLowerCase());
    pushUnique(next.gaps, inc.gaps, (item) => String(item || "").toLowerCase());
    pushUnique(next.glossary, inc.glossary, (item) => String(item?.term || "").toLowerCase());
    if (roundId && !next.rounds.includes(roundId)) next.rounds.push(roundId);
    return next;
  }

  // ── study ──────────────────────────────────────────────────────────────────

  function studyMeta(study) {
    const scan = study?.scan;
    return {
      status: study?.status || "empty",
      files: scan?.stats?.files || 0,
      lines: scan?.stats?.lines || 0,
      rounds: (study?.rounds || []).filter((round) => round.status === "done").length,
      modules: (study?.dossier?.modules || []).length,
      contracts: (study?.dossier?.contracts || []).length,
      readFiles: (study?.coverage?.readFiles || []).length,
      updatedAt: study?.updatedAt || 0,
    };
  }

  async function ensureStudy({ slotId, sessionId, rootPath, projectName, modelId, signal, force }) {
    if (!rootPath) return null;
    const key = store.projectKey(rootPath);
    if (studyJobs.has(key)) {
      const running = studyJobs.get(key);
      if (running.slotId !== slotId) {
        emit(slotId, {
          phase: "study",
          status: "Waiting for the project study that is already running…",
          sessionId,
          immediate: true,
        });
      }
      return running.promise;
    }
    if (force) {
      store.deleteStudy(userData(), rootPath);
    }
    const entry = { slotId, promise: null };
    entry.promise = runStudy({ slotId, sessionId, rootPath, projectName, modelId, signal }).finally(() => {
      studyJobs.delete(key);
    });
    studyJobs.set(key, entry);
    return entry.promise;
  }

  async function runStudy({ slotId, sessionId, rootPath, projectName, modelId, signal }) {
    let study = store.readStudy(userData(), rootPath);
    if (study.status === "ready" && study.scan && study.dossier) return study;

    // 1. Deterministic scan — always runs first and is persisted immediately.
    if (!study.scan) {
      emit(slotId, {
        phase: "scan",
        status: "Scanning every file in the project…",
        sessionId,
        immediate: true,
      });
      const scanned = await scanProjectSafely(rootPath, signal);
      const scan = scanned.scan;
      const digest = scanned.digest;
      study = store.writeStudy(userData(), rootPath, {
        ...study,
        status: "scanned",
        projectName: scan.projectName || projectName || null,
        scan,
        digest,
        createdAt: study.createdAt || Date.now(),
        dossier: study.dossier || {},
      });
      emit(slotId, {
        phase: "scan",
        status: `Scanned ${scan.stats.files} files · ${scan.stats.lines} lines`,
        files: scan.stats.files,
        lines: scan.stats.lines,
        sessionId,
        immediate: true,
      });
    }

    const { provider, model, context, compact } = await resolveModel(modelId);
    const rounds = [];
    for (const round of prompts.ROUNDS) rounds.push(round);

    // Extra coverage rounds: keep reading unread hotspots when the project is big.
    const hotspotFiles = (study.scan.files || []).slice(0, 140);
    const readSet = new Set((study.coverage.readFiles || []).map((item) => item.toLowerCase()));
    const unreadHotspots = hotspotFiles.filter((file) => !readSet.has(String(file.p).toLowerCase()));
    const extra = unreadHotspots.length > 8 ? STUDY_MAX_EXTRA_ROUNDS : 0;
    for (let index = 0; index < extra; index += 1) {
      rounds.push({
        id: `coverage-${index + 1}`,
        title: `Coverage pass ${index + 1}`,
        goal:
          "Read the remaining unread hotspot files and add only the facts that are still missing " +
          "(module roles, flows, contracts, conventions). Do not repeat what is already known.",
      });
    }

    let finished = 0;
    let stopped = false;
    for (let index = 0; index < rounds.length; index += 1) {
      const round = rounds[index];
      const existing = (study.rounds || []).find((item) => item.id === round.id);
      const retryable = existing && existing.status === "done" && existing.parsed === false && (existing.attempts || 1) < 2;
      if (existing && existing.status === "done" && !retryable) {
        finished += 1;
        continue;
      }
      if (signal?.aborted) {
        stopped = true;
        break;
      }
      const focus = prompts.pickFocus(round.id, study.scan, study.coverage.readFiles || []);
      emit(slotId, {
        phase: "study",
        round: round.id,
        roundIndex: index,
        roundCount: rounds.length,
        title: round.title,
        status: `Studying ${round.title.toLowerCase()} · ${focus.focus.length} focus files`,
        files: study.scan.stats.files,
        lines: study.scan.stats.lines,
        sessionId,
        immediate: true,
      });

      const local = makeLocalSignal(signal);
      const timer = setTimeout(() => local.abort(), STUDY_ROUND_TIMEOUT_MS);
      let roundText = "";
      let roundError = null;
      let roundTokens = 0;
      const readFiles = new Set(study.coverage.readFiles || []);
      try {
        const userPrompt = prompts.buildStudyUserPrompt({
          round,
          roundIndex: index,
          roundCount: rounds.length,
          digest: study.digest || scanLib.buildDigestText(study.scan),
          scan: study.scan,
          focus,
          previousDossier: study.dossier,
        });
        const result = await runAgentLoop({
          provider,
          model,
          messages: [{ role: "user", content: userPrompt }],
          systemPrompt: prompts.STUDY_SYSTEM,
          sessionId: `expert-study:${study.key}:${round.id}`,
          toolContext: toolContextFor(rootPath, projectName),
          signal: local.signal,
          tokenCountingMode: "provider",
          maxContextTokens: context,
          autoCompactTokens: compact,
          rootPath,
          userDataPath: userData(),
          builtinToolsOnly: true,
          excludeToolNames: READONLY_EXCLUDE,
          maxIterations: STUDY_ROUND_ITERATIONS,
          onProgress: (progress) => {
            if (!progress || typeof progress !== "object") return;
            if (progress.type === "tool_start") {
              const rel = progress.name === "read_file" ? normalizeRel(progress.input, rootPath) : null;
              if (rel) readFiles.add(rel);
              emit(slotId, {
                phase: "study",
                round: round.id,
                roundIndex: index,
                roundCount: rounds.length,
                status: progress.name ? `${round.title} · ${progress.name}${rel ? ` ${rel}` : ""}` : round.title,
                tool: progress.name || null,
                readFiles: readFiles.size,
                sessionId,
              });
            } else if (progress.type === "context_usage" && Number(progress.tokens)) {
              roundTokens = Math.max(roundTokens, Number(progress.tokens) || 0);
              emit(slotId, {
                phase: "study",
                round: round.id,
                contextTokens: roundTokens,
                sessionId,
              });
            }
          },
        });
        if (result?.stopped) {
          if (signal?.aborted) stopped = true;
          else roundError = "Study round timed out";
        }
        roundText = String(result?.text || "");
        roundTokens = Math.max(roundTokens, Number(result?.contextTokens) || 0);
      } catch (error) {
        if (signal?.aborted) stopped = true;
        roundError = error instanceof Error ? error.message : String(error);
      } finally {
        clearTimeout(timer);
        local.dispose();
      }

      const parsed = roundError ? null : prompts.parseDossierJson(roundText);
      const dossier = mergeDossier(study.dossier, parsed || {}, parsed ? round.id : null);
      const roundRecord = {
        id: round.id,
        title: round.title,
        status: roundError ? "error" : stopped ? "stopped" : "done",
        parsed: Boolean(parsed),
        attempts: (existing?.attempts || 0) + 1,
        startedAt: Date.now(),
        text: roundText.slice(0, 20000),
        tokens: roundTokens,
        ...(roundError ? { error: roundError } : {}),
        ...(parsed ? {} : roundError || stopped ? {} : { note: "model returned non-JSON output; kept as raw notes" }),
      };
      study = store.writeStudy(userData(), rootPath, {
        ...study,
        status: stopped ? "partial" : "studying",
        dossier,
        rounds: [...(study.rounds || []).filter((item) => item.id !== round.id), roundRecord],
        coverage: {
          readFiles: [...readFiles].slice(0, 4000),
          rounds: [...new Set([...(study.coverage?.rounds || []), round.id])],
        },
        studyTokens: (Number(study.studyTokens) || 0) + roundTokens,
      });
      if (parsed) finished += 1;
      if (stopped) break;
    }

    const failed = (study.rounds || []).some((round) => round.status === "error");
    const enriched = (study.rounds || []).some((round) => round.parsed === true);
    study = store.writeStudy(userData(), rootPath, {
      ...study,
      status: stopped ? "partial" : failed || !enriched ? "partial" : "ready",
      projectName: study.projectName || projectName || null,
    });
    emit(slotId, {
      phase: "study",
      status: stopped
        ? "Study paused — send any message to continue"
        : `Project studied · ${study.scan?.stats?.files || 0} files · ${finished} rounds`,
      studyDone: !stopped,
      studyStatus: study.status,
      files: study.scan?.stats?.files || 0,
      lines: study.scan?.stats?.lines || 0,
      rounds: finished,
      sessionId,
      immediate: true,
    });
    return study;
  }

  // ── compose ────────────────────────────────────────────────────────────────

  function conversationContext(session, currentTask) {
    const messages = Array.isArray(session?.messages) ? session.messages : [];
    const previous = messages.filter((message) => message.content !== currentTask);
    const tail = previous.slice(-8);
    const text = tail
      .map((message) =>
        `${message.role === "user" ? "USER" : "EXPERT PROMPT"}: ${String(message.content || "").slice(0, 3500)}`
      )
      .join("\n\n");
    return text.length > MAX_CONVERSATION_CHARS ? text.slice(-MAX_CONVERSATION_CHARS) : text;
  }

  async function composePrompt({ slotId, session, task, rootPath, projectName, study, signal }) {
    const { provider, model, context, compact } = await resolveModel(session?.modelId);
    const dossierText = prompts.renderDossier(study?.dossier, study?.scan);
    const digest = study?.digest || (study?.scan ? scanLib.buildDigestText(study.scan) : "");
    const meta = studyMeta(study);

    const userPrompt = prompts.buildComposeUserPrompt({
      task,
      digest,
      dossierText,
      conversation: conversationContext(session, task),
      projectName: projectName || study?.scan?.projectName || session?.projectName,
      studyMeta: meta,
    });
    const systemPrompt = `${prompts.COMPOSE_SYSTEM_BASE}\n\nPROJECT: ${
      projectName || study?.scan?.projectName || "unknown"
    }${rootPath ? `\nROOT: ${rootPath}` : ""}`;

    emit(slotId, {
      phase: "compose",
      status: "Composing the implementation prompt…",
      sessionId: session?.sessionId,
      immediate: true,
    });

    let localTokens = 0;
    const result = await runAgentLoop({
      provider,
      model,
      messages: [{ role: "user", content: userPrompt }],
      systemPrompt,
      sessionId: `expert-compose:${session.sessionId}`,
      toolContext: toolContextFor(rootPath, projectName),
      signal,
      tokenCountingMode: "provider",
      maxContextTokens: context,
      autoCompactTokens: compact,
      rootPath,
      userDataPath: userData(),
      builtinToolsOnly: true,
      excludeToolNames: READONLY_EXCLUDE,
      maxIterations: COMPOSE_ITERATIONS,
      onProgress: (progress) => {
        if (!progress || typeof progress !== "object") return;
        if (progress.type === "tool_start") {
          emit(slotId, {
            phase: "compose",
            status: `Verifying ${progress.name || "context"}…`,
            tool: progress.name || null,
            sessionId: session?.sessionId,
          });
        } else if (progress.type === "context_usage" && Number(progress.tokens)) {
          localTokens = Math.max(localTokens, Number(progress.tokens) || 0);
          emit(slotId, { phase: "compose", contextTokens: localTokens, sessionId: session?.sessionId });
        }
      },
    });

    const text = prompts.cleanComposedPrompt(result?.text || "");
    return {
      text,
      stopped: Boolean(result?.stopped),
      contextTokens: Number(result?.contextTokens) || localTokens || estimateTokens(systemPrompt, userPrompt),
      contextLimit: context,
      modelId: model.id,
      modelName: model.name || model.id,
      usage: result?.usage || null,
    };
  }

  function estimateTokens(...texts) {
    if (typeof countTokens === "function") {
      try {
        return texts.reduce((sum, text) => sum + countTokens(String(text || "")), 0);
      } catch {
        /* fall through */
      }
    }
    const chars = texts.reduce((sum, text) => sum + String(text || "").length, 0);
    return Math.round(chars / 4);
  }

  // ── send / stop ────────────────────────────────────────────────────────────

  async function send(payload = {}) {
    const slotId = store.SLOT_IDS.includes(payload.slotId) ? payload.slotId : store.SLOT_IDS[0];
    const task = typeof payload.task === "string" ? payload.task.trim() : "";
    if (!task) return { ok: false, error: "Write a task first" };
    if (runs.has(slotId)) return { ok: false, error: "This Expert chat is already running" };

    const rootPath = typeof payload.rootPath === "string" && payload.rootPath ? payload.rootPath : null;
    const projectName =
      payload.projectName || (rootPath ? path.basename(rootPath) : null) || "Project";
    const modelId = typeof payload.modelId === "string" ? payload.modelId : null;

    let session = payload.sessionId ? store.readSession(userData(), payload.sessionId) : null;
    if (!session || (rootPath && session.rootPath !== rootPath)) {
      session = store.createSession(userData(), {
        rootPath,
        projectName,
        slotId,
        title: task.slice(0, 80),
      });
    }
    if (!session.sessionId) return { ok: false, error: "Could not create the Expert session" };

    const controller = new AbortController();
    const runId = `${slotId}-${Date.now().toString(36)}`;
    runs.set(slotId, { controller, sessionId: session.sessionId, runId });

    const userMessage = {
      id: store.newMessageId(),
      role: "user",
      content: task,
      createdAt: Date.now(),
    };
    session.messages.push(userMessage);
    if (!session.title || session.title === "Expert chat") session.title = task.slice(0, 80);
    session.rootPath = rootPath || session.rootPath;
    session.projectName = projectName;
    session.modelId = modelId || session.modelId || null;
    session = store.writeSession(userData(), session);

    const studyInFlight = Boolean(rootPath && studyJobs.has(store.projectKey(rootPath)));
    if (!studyInFlight) {
      emit(slotId, {
        phase: "start",
        status: "Preparing Expert…",
        sessionId: session.sessionId,
        runId,
        task,
        immediate: true,
      });
    }

    try {
      const study = await ensureStudy({
        slotId,
        sessionId: session.sessionId,
        rootPath,
        projectName,
        modelId: session.modelId,
        signal: controller.signal,
      });

      if (controller.signal.aborted) {
        const abortError = new Error("Stopped by user.");
        abortError.name = "AbortError";
        throw abortError;
      }

      let assistant;
      if (prompts.isSmallTalk(task)) {
        const meta = studyMeta(study);
        assistant = {
          id: store.newMessageId(),
          role: "assistant",
          content: rootPath
            ? `Project studied: ${meta.files} files · ${meta.lines} lines · ${meta.modules} modules · ${meta.contracts} contracts · ${meta.readFiles} files read in depth.\n\nThe Expert has the whole project mapped. Write your task and you get one implementation prompt you can copy.`
            : "No project folder selected. Pick a folder in the Expert header so the whole repository can be studied, then write your task.",
          createdAt: Date.now(),
          meta: { kind: "status", study: meta },
        };
      } else if (!rootPath) {
        assistant = {
          id: store.newMessageId(),
          role: "assistant",
          content:
            "Pick a project folder first — Expert composes prompts only from a studied repository, never from guesses.",
          createdAt: Date.now(),
          meta: { kind: "error" },
        };
      } else {
        const composed = await composePrompt({
          slotId,
          session,
          task,
          rootPath,
          projectName,
          study,
          signal: controller.signal,
        });
        assistant = {
          id: store.newMessageId(),
          role: "assistant",
          content: composed.text || (composed.stopped ? "Stopped before the prompt was finished." : "The model returned an empty prompt."),
          createdAt: Date.now(),
          meta: {
            kind: composed.text ? "prompt" : "error",
            modelId: composed.modelId,
            modelName: composed.modelName,
            contextTokens: composed.contextTokens,
            contextLimit: composed.contextLimit,
            stopped: composed.stopped || false,
            study: studyMeta(study),
            usage: composed.usage || undefined,
          },
        };
      }

      session = store.readSession(userData(), session.sessionId) || session;
      session.messages.push(assistant);
      session.contextTokens = assistant.meta?.contextTokens || 0;
      session.contextLimit = assistant.meta?.contextLimit || 0;
      session.study = assistant.meta?.study || studyMeta(study);
      session = store.writeSession(userData(), session);

      emit(slotId, {
        phase: "done",
        status: "Prompt ready",
        done: true,
        sessionId: session.sessionId,
        runId,
        contextTokens: assistant.meta?.contextTokens || 0,
        immediate: true,
      });

      return {
        ok: true,
        runId,
        sessionId: session.sessionId,
        title: session.title,
        message: assistant,
        study: assistant.meta?.study || null,
        contextTokens: assistant.meta?.contextTokens || 0,
        contextLimit: assistant.meta?.contextLimit || 0,
        stopped: Boolean(assistant.meta?.stopped),
      };
    } catch (error) {
      const aborted = error?.name === "AbortError" || controller.signal.aborted;
      const text = aborted
        ? "Stopped by user."
        : `Expert failed: ${error instanceof Error ? error.message : String(error)}`;
      const assistant = {
        id: store.newMessageId(),
        role: "assistant",
        content: text,
        createdAt: Date.now(),
        meta: { kind: "error" },
      };
      const latest = store.readSession(userData(), session.sessionId) || session;
      latest.messages.push(assistant);
      store.writeSession(userData(), latest);
      emit(slotId, { phase: "error", status: text, done: true, sessionId: session.sessionId, runId, immediate: true });
      return { ok: false, error: text, sessionId: session.sessionId, message: assistant, stopped: aborted };
    } finally {
      runs.delete(slotId);
    }
  }

  async function startStudy(payload = {}) {
    const slotId = store.SLOT_IDS.includes(payload.slotId) ? payload.slotId : store.SLOT_IDS[0];
    const rootPath = typeof payload.rootPath === "string" && payload.rootPath ? payload.rootPath : null;
    if (!rootPath) return { ok: false, error: "Choose a project folder first" };
    if (studyRuns.has(slotId)) return { ok: false, error: "The project is already being studied" };
    const controller = new AbortController();
    studyRuns.set(slotId, controller);
    const projectName = payload.projectName || path.basename(rootPath);
    try {
      const study = await ensureStudy({
        slotId,
        sessionId: payload.sessionId || null,
        rootPath,
        projectName,
        modelId: payload.modelId || null,
        signal: controller.signal,
        force: payload.force === true,
      });
      return {
        ok: Boolean(study),
        meta: studyMeta(study),
        study: study ? { status: study.status, updatedAt: study.updatedAt } : null,
        stopped: controller.signal.aborted,
      };
    } catch (error) {
      const aborted = controller.signal.aborted || error?.name === "AbortError";
      const text = aborted ? "Study stopped" : error instanceof Error ? error.message : String(error);
      emit(slotId, {
        phase: aborted ? "stopped" : "error",
        status: text,
        studyDone: true,
        immediate: true,
      });
      return { ok: false, error: text, stopped: aborted };
    } finally {
      studyRuns.delete(slotId);
    }
  }

  function stop(slotId) {
    const key = store.SLOT_IDS.includes(slotId) ? slotId : store.SLOT_IDS[0];
    let stoppedSomething = false;
    const study = studyRuns.get(key);
    if (study) {
      try {
        study.abort();
        stoppedSomething = true;
      } catch {
        /* ignore */
      }
    }
    const entry = runs.get(key);
    if (entry) {
      try {
        entry.controller.abort();
        stoppedSomething = true;
      } catch {
        /* ignore */
      }
    }
    if (!stoppedSomething) return { ok: false, error: "Nothing is running" };
    emit(key, { phase: "stopping", status: "Stopping…", immediate: true });
    return { ok: true };
  }

  // ── ipc ───────────────────────────────────────────────────────────────────

  function register() {
    ipcMain.handle("expert:loadState", () => {
      try {
        return store.readState(userData());
      } catch {
        return store.emptyState();
      }
    });

    ipcMain.on("expert:loadStateSync", (event) => {
      try {
        event.returnValue = store.readState(userData());
      } catch {
        event.returnValue = store.emptyState();
      }
    });

    ipcMain.handle("expert:saveState", (_event, patch) => {
      try {
        return { ok: true, state: store.savePatch(userData(), patch) };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

    ipcMain.on("expert:saveStateSync", (event, patch) => {
      try {
        event.returnValue = { ok: true, state: store.savePatch(userData(), patch) };
      } catch (error) {
        event.returnValue = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

    ipcMain.handle("expert:send", async (_event, payload) => send(payload || {}));
    ipcMain.handle("expert:stop", (_event, slotId) => stop(slotId));
    ipcMain.handle("expert:study", async (_event, payload) => startStudy(payload || {}));

    ipcMain.handle("expert:saveSnapshot", (_event, payload) => {
      try {
        const input = payload && typeof payload === "object" ? payload : {};
        const name = String(input.name || "").trim();
        let session = input.sessionId ? store.readSession(userData(), input.sessionId) : null;
        if (!session) {
          const messages = Array.isArray(input.messages) ? input.messages : [];
          if (!messages.length) {
            return { ok: false, error: "Nothing to save yet — send a task first" };
          }
          const firstUser = messages.find((message) => message?.role === "user" && message?.content);
          session = store.createSession(userData(), {
            rootPath: input.rootPath || null,
            projectName: input.projectName || null,
            modelId: input.modelId || null,
            slotId: input.slotId || null,
            title: input.title || firstUser?.content || "",
            messages,
          });
        }
        if (!session.messages.length) {
          return { ok: false, error: "Nothing to save yet — send a task first" };
        }
        const entry = store.saveNamedSession(userData(), session.sessionId, name || session.title);
        return entry
          ? { ok: true, entry, sessionId: session.sessionId }
          : { ok: false, error: "Could not save the session" };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

    ipcMain.handle("expert:loadSession", (_event, sessionId) => store.readSession(userData(), sessionId));

    ipcMain.handle("expert:listSessions", (_event, rootPath) => store.listSessions(userData(), rootPath));

    ipcMain.handle("expert:newSession", (_event, input) => {
      try {
        return {
          ok: true,
          session: store.createSession(userData(), {
            rootPath: input?.rootPath || null,
            projectName: input?.projectName || null,
            slotId: input?.slotId || null,
          }),
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

    ipcMain.handle("expert:deleteSession", (_event, sessionId) => ({
      deleted: store.deleteSession(userData(), sessionId),
    }));

    ipcMain.handle("expert:renameSession", (_event, sessionId, title) => {
      const session = store.readSession(userData(), sessionId);
      if (!session) return { ok: false, error: "Session not found" };
      session.title = String(title || "").slice(0, 90);
      return { ok: true, session: store.writeSession(userData(), session) };
    });

    ipcMain.handle("expert:saveSession", (_event, sessionId, name) => {
      try {
        const entry = store.saveNamedSession(userData(), sessionId, name);
        return entry ? { ok: true, entry } : { ok: false, error: "Session not found" };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });

    ipcMain.handle("expert:listSaved", () => store.listSaved(userData()));

    ipcMain.handle("expert:deleteSaved", (_event, savedId) => store.deleteSaved(userData(), savedId));

    ipcMain.handle("expert:openSaved", (_event, input) => {
      const snapshot = store.readSavedSession(userData(), input?.savedId);
      if (!snapshot) return { ok: false, error: "Saved session not found" };
      const copy = store.createSession(userData(), {
        rootPath: snapshot.rootPath,
        projectName: snapshot.projectName,
        title: snapshot.title,
        messages: snapshot.messages,
        slotId: input?.slotId || null,
      });
      return { ok: true, session: copy };
    });

    ipcMain.handle("expert:copySession", (_event, payload) => {
      const session = store.readSession(userData(), payload?.sessionId);
      if (!session) return { ok: false, error: "Session not found" };
      // Same contract as the main chat: the clipboard carries the session id,
      // and Paste makes a fresh copy of that session.
      clipboard.writeText(session.sessionId);
      return {
        ok: true,
        sessionId: session.sessionId,
        messageCount: session.messages.length,
      };
    });

    ipcMain.handle("expert:pasteSession", (_event, input) => {
      let raw = "";
      try {
        raw = clipboard.readText();
      } catch {
        raw = "";
      }
      const text = String(raw || "").trim();
      if (!text) return { ok: false, error: "Clipboard is empty" };

      const copyTitle = (title) => {
        const base = String(title || "").trim() || "Expert chat";
        return /^copy of\s/i.test(base) ? base : `Copy of ${base}`;
      };

      const cloneSession = (session) =>
        store.createSession(userData(), {
          rootPath: input?.rootPath || session.rootPath || null,
          projectName: input?.projectName || session.projectName || null,
          modelId: input?.modelId || session.modelId || null,
          title: copyTitle(session.title),
          messages: session.messages,
          slotId: input?.slotId || null,
        });

      // 1) A plain session id (copied by the id chip / "#abc" label).
      const maybeId = text.replace(/^#/, "").trim();
      if (maybeId && maybeId.length <= 160 && /^[A-Za-z0-9._:-]+$/.test(maybeId) && !maybeId.startsWith("{")) {
        let existing = store.readSession(userData(), maybeId);
        if (!existing) {
          for (const entry of store.listSaved(userData())) {
            const snapshot = store.readSavedSession(userData(), entry.id);
            if (snapshot && snapshot.sessionId === maybeId) {
              existing = snapshot;
              break;
            }
          }
        }
        if (!existing) return { ok: false, error: "No Expert session with this ID" };
        return { ok: true, session: cloneSession(existing), fromSessionId: maybeId };
      }

      // 2) A full session snapshot (Copy session).
      let pack;
      try {
        pack = JSON.parse(text);
      } catch {
        return { ok: false, error: "Clipboard has no Expert session or session ID" };
      }
      if (!pack || pack.type !== "composevc-expert-session" || !Array.isArray(pack.messages)) {
        return { ok: false, error: "Clipboard has no Expert session or session ID" };
      }
      const session = store.createSession(userData(), {
        rootPath: input?.rootPath || pack.rootPath || null,
        projectName: input?.projectName || pack.projectName || null,
        title: copyTitle(pack.title || "Expert chat"),
        messages: pack.messages,
        slotId: input?.slotId || null,
      });
      return { ok: true, session };
    });

    ipcMain.handle("expert:studyStatus", (_event, rootPath) => {
      if (!rootPath) return { ok: true, study: store.emptyStudy(null), meta: studyMeta(store.emptyStudy(null)) };
      const study = store.readStudy(userData(), rootPath);
      return { ok: true, study: { status: study.status, updatedAt: study.updatedAt }, meta: studyMeta(study) };
    });

    ipcMain.handle("expert:readDossier", (_event, rootPath) => {
      if (!rootPath) return { ok: false, error: "No folder" };
      const study = store.readStudy(userData(), rootPath);
      return {
        ok: true,
        meta: studyMeta(study),
        dossier: study.dossier || null,
        text: prompts.renderDossier(study.dossier, study.scan),
        digest: String(study.digest || "").slice(0, 40000),
      };
    });

    ipcMain.handle("expert:restudy", (_event, rootPath) => {
      if (!rootPath) return { ok: false, error: "No folder" };
      store.deleteStudy(userData(), rootPath);
      return { ok: true };
    });
  }

  function dispose() {
    for (const entry of runs.values()) {
      try {
        entry.controller.abort();
      } catch {
        /* ignore */
      }
    }
    for (const controller of studyRuns.values()) {
      try {
        controller.abort();
      } catch {
        /* ignore */
      }
    }
    runs.clear();
    studyRuns.clear();
    for (const state of progressState.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    progressState.clear();
  }

  return { register, send, stop, startStudy, dispose, studyMeta };
}

module.exports = { createExpertService, PROGRESS_CHANNEL };
