import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertTriangle,
  Bookmark,
  BookmarkPlus,
  Check,
  ClipboardPaste,
  Copy,
  FileText,
  Folder,
  FolderOpen,
  History,
  Layers,
  Loader2,
  Plus,
  RotateCcw,
  Send,
  Sparkles,
  Square,
  Trash2,
  X,
} from "lucide-react";
import ChatMonoScroll, { ChatMonoScrollHandle } from "./ChatMonoScroll";
import ModelPicker, { ModelPickerLabels } from "./ModelPicker";
import { AIModel, AIProvider, ProviderConfig } from "../types";

export const EXPERT_SLOT_IDS = ["expert-1", "expert-2", "expert-3"] as const;

type ExpertMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  meta?: Record<string, unknown>;
};

type ExpertMessageMeta = {
  kind?: string;
  modelId?: string;
  modelName?: string;
  contextTokens?: number;
  contextLimit?: number;
  stopped?: boolean;
  study?: ExpertStudyMeta;
};

function readMeta(message: ExpertMessage): ExpertMessageMeta {
  return (message.meta || {}) as ExpertMessageMeta;
}

export type ExpertStudyMeta = {
  status?: string;
  files?: number;
  lines?: number;
  rounds?: number;
  modules?: number;
  contracts?: number;
  readFiles?: number;
  updatedAt?: number;
};

type ExpertSessionSummary = {
  sessionId: string;
  title: string;
  rootPath: string | null;
  projectName: string | null;
  messageCount: number;
  promptCount: number;
  updatedAt: number;
  createdAt: number;
};

type ExpertSavedEntry = {
  id: string;
  name: string;
  sessionId: string;
  title: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
};

type ExpertSlot = {
  id: string;
  rootPath: string | null;
  projectName: string | null;
  selectedModelId: string | null;
  sessionId: string | null;
  draft: string;
  updatedAt: number;
  messages: ExpertMessage[];
  running: boolean;
  phase: string | null;
  status: string;
  study: ExpertStudyMeta | null;
  contextTokens: number;
  contextLimit: number;
  error: string | null;
  historyOpen: boolean;
  saveOpen: boolean;
  modelOpen: boolean;
  confirmReset: boolean;
};

type ExpertLabels = ModelPickerLabels & {
  send: string;
  stop: string;
};

type ExpertWorkspaceProps = {
  providerConfig: ProviderConfig;
  labels: ExpertLabels;
};

type ModalState =
  | { kind: "history"; slotId: string }
  | { kind: "save"; slotId: string }
  | null;

const PHASES: Array<{ id: string; label: string }> = [
  { id: "scan", label: "Scan" },
  { id: "study", label: "Study" },
  { id: "compose", label: "Compose" },
];

function formatTokens(value: number): string {
  const n = Math.max(0, Number(value) || 0);
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(n % 1_000 === 0 ? 0 : 1)}k`;
  return String(n);
}

function formatWhen(ts: number): string {
  if (!ts) return "—";
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

function createSlots(): ExpertSlot[] {
  return EXPERT_SLOT_IDS.map((id) => ({
    id,
    rootPath: null,
    projectName: null,
    selectedModelId: null,
    sessionId: null,
    draft: "",
    updatedAt: 0,
    messages: [],
    running: false,
    phase: null,
    status: "",
    study: null,
    contextTokens: 0,
    contextLimit: 0,
    error: null,
    historyOpen: false,
    saveOpen: false,
    modelOpen: false,
    confirmReset: false,
  }));
}

function persistedSlots(slots: ExpertSlot[]) {
  return slots.map((slot) => ({
    id: slot.id,
    rootPath: slot.rootPath,
    projectName: slot.projectName,
    selectedModelId: slot.selectedModelId,
    sessionId: slot.sessionId,
    draft: slot.draft,
    updatedAt: slot.updatedAt,
  }));
}

function projectNameOf(rootPath: string | null): string | null {
  if (!rootPath) return null;
  const parts = rootPath.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || rootPath;
}

function phaseIndex(phase: string | null): number {
  const index = PHASES.findIndex((item) => item.id === phase);
  return index === -1 ? -1 : index;
}

/** Textarea that grows with its content, capped so the dock never eats the chat. */
const AutoTextarea: React.FC<{
  value: string;
  placeholder: string;
  disabled?: boolean;
  onChange: (value: string) => void;
  onSend: () => void;
}> = ({ value, placeholder, disabled, onChange, onSend }) => {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    const next = Math.min(168, Math.max(38, el.scrollHeight));
    el.style.height = `${next}px`;
  }, [value]);

  return (
    <textarea
      ref={ref}
      value={value}
      rows={1}
      placeholder={placeholder}
      spellCheck={false}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      onKeyDown={(event) => {
        if (event.key !== "Enter") return;
        if (event.nativeEvent.isComposing) return;
        if (event.shiftKey) return;
        event.preventDefault();
        onSend();
      }}
    />
  );
};

const ExpertWorkspace: React.FC<ExpertWorkspaceProps> = ({ providerConfig, labels }) => {
  const [slots, setSlots] = useState<ExpertSlot[]>(createSlots);
  const [hydrated, setHydrated] = useState(false);
  const [modal, setModal] = useState<ModalState>(null);
  const [history, setHistory] = useState<{ loading: boolean; sessions: ExpertSessionSummary[]; saved: ExpertSavedEntry[] }>({
    loading: false,
    sessions: [],
    saved: [],
  });
  const [saveName, setSaveName] = useState("");
  const [toast, setToast] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const scrollRefs = useRef<Record<string, ChatMonoScrollHandle | null>>({});
  const slotsRef = useRef(slots);
  const saveTimer = useRef<number | null>(null);

  slotsRef.current = slots;

  const models: AIModel[] = providerConfig.models || [];
  const providers: AIProvider[] = providerConfig.providers || [];
  const defaultModelId = useMemo(() => {
    const configured = (providerConfig as { selectedModelId?: string }).selectedModelId;
    if (configured && models.some((model) => model.id === configured)) return configured;
    return models[0]?.id || null;
  }, [models, providerConfig]);

  const pushToast = useCallback((text: string) => {
    setToast(text);
    window.setTimeout(() => setToast((current) => (current === text ? null : current)), 2200);
  }, []);

  const patchSlot = useCallback((slotId: string, patch: Partial<ExpertSlot>) => {
    setSlots((prev) => prev.map((slot) => (slot.id === slotId ? { ...slot, ...patch, updatedAt: Date.now() } : slot)));
  }, []);

  // ── hydrate from disk ─────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    const applyDisk = async () => {
      let disk: ReturnType<NonNullable<Window["lopster"]>["expertLoadStateSync"]> | null = null;
      try {
        disk = window.lopster?.expertLoadStateSync?.() || null;
      } catch {
        disk = null;
      }
      if (!disk) {
        try {
          disk = (await window.lopster?.expertLoadState?.()) || null;
        } catch {
          disk = null;
        }
      }
      if (cancelled) return;
      const byId = new Map((disk?.slots || []).map((slot) => [slot.id, slot]));
      const next = createSlots().map((slot) => {
        const saved = byId.get(slot.id);
        if (!saved) return { ...slot, selectedModelId: defaultModelId };
        return {
          ...slot,
          rootPath: saved.rootPath || null,
          projectName: saved.projectName || projectNameOf(saved.rootPath || null),
          selectedModelId: saved.selectedModelId || defaultModelId,
          sessionId: saved.sessionId || null,
          draft: saved.draft || "",
        };
      });
      setSlots(next);
      setHydrated(true);

      for (const slot of next) {
        if (!slot.sessionId) continue;
        try {
          const session = await window.lopster?.expertLoadSession?.(slot.sessionId);
          if (cancelled || !session) continue;
          setSlots((prev) =>
            prev.map((item) =>
              item.id === slot.id
                ? {
                    ...item,
                    messages: session.messages as ExpertMessage[],
                    contextTokens: Number(session.contextTokens) || 0,
                    contextLimit: Number(session.contextLimit) || 0,
                  }
                : item
            )
          );
        } catch {
          /* a deleted session must not block the tab */
        }
      }
      for (const slot of next) {
        if (!slot.rootPath) continue;
        try {
          const status = await window.lopster?.expertStudyStatus?.(slot.rootPath);
          const meta = status?.meta as ExpertStudyMeta | undefined;
          if (cancelled || !meta) continue;
          setSlots((prev) =>
            prev.map((item) => (item.id === slot.id ? { ...item, study: meta } : item))
          );
        } catch {
          /* ignore */
        }
      }
    };
    void applyDisk();
    return () => {
      cancelled = true;
    };
  }, [defaultModelId]);

  // ── persist slot meta (debounced) + sync on exit ───────────────────────────
  useEffect(() => {
    if (!hydrated) return;
    if (saveTimer.current) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      window.lopster?.expertSaveState?.({ slots: persistedSlots(slotsRef.current) });
    }, 320);
    return () => {
      if (saveTimer.current) window.clearTimeout(saveTimer.current);
    };
  }, [slots, hydrated]);

  useEffect(() => {
    const flush = () => {
      try {
        window.lopster?.expertSaveStateSync?.({ slots: persistedSlots(slotsRef.current) });
      } catch {
        /* ignore */
      }
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);

  // ── live progress from main ────────────────────────────────────────────────
  useEffect(() => {
    const unsubscribe = window.lopster?.onExpertProgress?.((payload) => {
      const slotId = String(payload?.slotId || "");
      if (!EXPERT_SLOT_IDS.includes(slotId as (typeof EXPERT_SLOT_IDS)[number])) return;
      setSlots((prev) =>
        prev.map((slot) => {
          if (slot.id !== slotId) return slot;
          const study = slot.study ? { ...slot.study } : {};
          if (payload.files !== undefined) study.files = Number(payload.files) || 0;
          if (payload.lines !== undefined) study.lines = Number(payload.lines) || 0;
          if (payload.rounds !== undefined) study.rounds = Number(payload.rounds) || 0;
          if (payload.readFiles !== undefined) study.readFiles = Number(payload.readFiles) || 0;
          if (payload.phase === "study" || payload.phase === "scan") study.status = "studying";
          return {
            ...slot,
            phase: payload.phase ? String(payload.phase) : slot.phase,
            status: payload.status ? String(payload.status) : slot.status,
            running: payload.done === true ? false : slot.running,
            contextTokens: Number(payload.contextTokens) || slot.contextTokens,
            study: Object.keys(study).length ? study : slot.study,
          };
        })
      );
    });
    return () => unsubscribe?.();
  }, []);

  // ── folder / session actions ───────────────────────────────────────────────
  const loadStudyStatus = useCallback(async (slotId: string, rootPath: string | null) => {
    if (!rootPath) {
      patchSlot(slotId, { study: null });
      return;
    }
    try {
      const status = await window.lopster?.expertStudyStatus?.(rootPath);
      patchSlot(slotId, { study: (status?.meta as ExpertStudyMeta) || null });
    } catch {
      patchSlot(slotId, { study: null });
    }
  }, [patchSlot]);

  const chooseFolder = useCallback(
    async (slotId: string) => {
      const slot = slotsRef.current.find((item) => item.id === slotId);
      if (!slot || slot.running) return;
      try {
        const picked = await window.lopster?.openFolder?.();
        if (!picked?.path) return;
        patchSlot(slotId, {
          rootPath: picked.path,
          projectName: picked.name || projectNameOf(picked.path),
          sessionId: null,
          messages: [],
          contextTokens: 0,
          contextLimit: 0,
          error: null,
          status: "",
          phase: null,
        });
        void loadStudyStatus(slotId, picked.path);
      } catch (error) {
        patchSlot(slotId, { error: error instanceof Error ? error.message : String(error) });
      }
    },
    [loadStudyStatus, patchSlot]
  );

  const newChat = useCallback(
    (slotId: string) => {
      const slot = slotsRef.current.find((item) => item.id === slotId);
      if (!slot || slot.running) return;
      patchSlot(slotId, {
        sessionId: null,
        messages: [],
        draft: "",
        error: null,
        status: "",
        phase: null,
        contextTokens: 0,
        contextLimit: 0,
      });
    },
    [patchSlot]
  );

  const loadHistory = useCallback(
    async (slotId: string) => {
      const slot = slotsRef.current.find((item) => item.id === slotId);
      setModal({ kind: "history", slotId });
      setHistory({ loading: true, sessions: [], saved: [] });
      try {
        const [sessions, saved] = await Promise.all([
          window.lopster?.expertListSessions?.(slot?.rootPath || null) || Promise.resolve([]),
          window.lopster?.expertListSaved?.() || Promise.resolve([]),
        ]);
        setHistory({ loading: false, sessions: sessions || [], saved: saved || [] });
      } catch {
        setHistory({ loading: false, sessions: [], saved: [] });
      }
    },
    []
  );

  const openSession = useCallback(
    async (slotId: string, sessionId: string) => {
      try {
        const session = await window.lopster?.expertLoadSession?.(sessionId);
        if (!session) return;
        patchSlot(slotId, {
          sessionId: session.sessionId,
          rootPath: session.rootPath || null,
          projectName: session.projectName || projectNameOf(session.rootPath || null),
          messages: session.messages as ExpertMessage[],
          contextTokens: Number(session.contextTokens) || 0,
          contextLimit: Number(session.contextLimit) || 0,
          error: null,
          status: "",
          phase: null,
        });
        setModal(null);
        if (session.rootPath) void loadStudyStatus(slotId, session.rootPath);
      } catch {
        pushToast("Could not open that chat");
      }
    },
    [loadStudyStatus, patchSlot, pushToast]
  );

  const deleteSession = useCallback(
    async (slotId: string, sessionId: string) => {
      await window.lopster?.expertDeleteSession?.(sessionId);
      setHistory((prev) => ({ ...prev, sessions: prev.sessions.filter((item) => item.sessionId !== sessionId) }));
      const slot = slotsRef.current.find((item) => item.id === slotId);
      if (slot?.sessionId === sessionId) {
        patchSlot(slotId, { sessionId: null, messages: [], contextTokens: 0, contextLimit: 0 });
      }
      pushToast("Chat deleted");
    },
    [patchSlot, pushToast]
  );

  const openSaved = useCallback(
    async (slotId: string, savedId: string) => {
      const res = await window.lopster?.expertOpenSaved?.({ savedId, slotId });
      const session = res?.session as
        | { sessionId: string; messages: ExpertMessage[]; rootPath?: string | null; projectName?: string | null }
        | undefined;
      if (!res?.ok || !session) {
        pushToast(res?.error || "Could not open the saved session");
        return;
      }
      patchSlot(slotId, {
        sessionId: session.sessionId,
        messages: session.messages || [],
        rootPath: session.rootPath || null,
        projectName: session.projectName || projectNameOf(session.rootPath || null),
        error: null,
        phase: null,
        status: "",
      });
      setModal(null);
      pushToast("Saved session opened");
    },
    [patchSlot, pushToast]
  );

  const saveSession = useCallback(
    async (slotId: string, name: string) => {
      const slot = slotsRef.current.find((item) => item.id === slotId);
      if (!slot?.sessionId) {
        pushToast("Nothing to save yet");
        return;
      }
      const res = await window.lopster?.expertSaveSession?.(slot.sessionId, name);
      if (res?.ok) {
        patchSlot(slotId, { saveOpen: false });
        setModal(null);
        pushToast("Session saved");
      } else {
        pushToast(res?.error || "Could not save the session");
      }
    },
    [patchSlot, pushToast]
  );

  const copySession = useCallback(
    async (slotId: string) => {
      const slot = slotsRef.current.find((item) => item.id === slotId);
      if (!slot?.sessionId) {
        pushToast("Nothing to copy yet");
        return;
      }
      const res = await window.lopster?.expertCopySession?.({ sessionId: slot.sessionId });
      pushToast(res?.ok ? "Session copied" : res?.error || "Could not copy the session");
    },
    [pushToast]
  );

  const pasteSession = useCallback(
    async (slotId: string) => {
      const slot = slotsRef.current.find((item) => item.id === slotId);
      if (!slot || slot.running) return;
      const res = await window.lopster?.expertPasteSession?.({
        slotId,
        rootPath: slot.rootPath,
        projectName: slot.projectName,
      });
      const session = res?.session as
        | { sessionId: string; messages: ExpertMessage[]; rootPath?: string | null; projectName?: string | null }
        | undefined;
      if (!res?.ok || !session) {
        pushToast(res?.error || "Clipboard has no Expert session");
        return;
      }
      patchSlot(slotId, {
        sessionId: session.sessionId,
        messages: session.messages || [],
        rootPath: session.rootPath || slot.rootPath,
        projectName: session.projectName || slot.projectName,
        error: null,
        phase: null,
        status: "",
      });
      pushToast("Session pasted");
    },
    [patchSlot, pushToast]
  );

  const resetStudy = useCallback(
    async (slotId: string) => {
      const slot = slotsRef.current.find((item) => item.id === slotId);
      if (!slot?.rootPath || slot.running) return;
      await window.lopster?.expertRestudy?.(slot.rootPath);
      patchSlot(slotId, { study: { status: "empty" }, confirmReset: false, status: "" });
      pushToast("Study reset — the next message re-studies the project");
    },
    [patchSlot, pushToast]
  );

  // ── send / stop ────────────────────────────────────────────────────────────
  const send = useCallback(
    async (slotId: string) => {
      const slot = slotsRef.current.find((item) => item.id === slotId);
      if (!slot || slot.running) return;
      const task = slot.draft.trim();
      if (!task) return;
      if (!slot.rootPath) {
        patchSlot(slotId, { error: "Select a project directory first." });
        return;
      }
      const modelId = slot.selectedModelId || defaultModelId;
      if (!modelId) {
        patchSlot(slotId, { error: "No model configured. Add one in Providers." });
        return;
      }
      const optimistic: ExpertMessage = {
        id: `local-${Date.now().toString(36)}`,
        role: "user",
        content: task,
        createdAt: Date.now(),
      };
      patchSlot(slotId, {
        messages: [...slot.messages, optimistic],
        draft: "",
        running: true,
        error: null,
        phase: "start",
        status: "Preparing Expert…",
      });

      try {
        const res = await window.lopster?.expertSend?.({
          slotId,
          task,
          modelId,
          rootPath: slot.rootPath,
          projectName: slot.projectName,
          sessionId: slot.sessionId,
        });
        const sessionId = res?.sessionId || slot.sessionId;
        if (sessionId) {
          const session = await window.lopster?.expertLoadSession?.(sessionId);
          if (session) {
            patchSlot(slotId, {
              sessionId: session.sessionId,
              messages: session.messages as ExpertMessage[],
              contextTokens: Number(session.contextTokens) || 0,
              contextLimit: Number(session.contextLimit) || 0,
            });
          }
        } else if (res?.message) {
          patchSlot(slotId, {
            messages: [...(slotsRef.current.find((item) => item.id === slotId)?.messages || []), res.message as ExpertMessage],
          });
        }
        if (res?.study) {
          setSlots((prev) =>
            prev.map((item) =>
              item.id === slotId ? { ...item, study: res.study as ExpertStudyMeta, running: false } : item
            )
          );
        }
        patchSlot(slotId, {
          running: false,
          phase: res?.ok ? "done" : "error",
          error: res?.ok ? null : res?.error || "Expert failed",
          status: res?.ok ? "Prompt ready" : "Failed",
        });
      } catch (error) {
        patchSlot(slotId, {
          running: false,
          phase: "error",
          error: error instanceof Error ? error.message : String(error),
          status: "Failed",
        });
      }
    },
    [defaultModelId, patchSlot]
  );

  const stop = useCallback(async (slotId: string) => {
    patchSlot(slotId, { status: "Stopping…" });
    await window.lopster?.expertStop?.(slotId);
  }, [patchSlot]);

  const copyPrompt = useCallback(
    async (messageId: string, text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setCopiedId(messageId);
        window.setTimeout(() => setCopiedId((current) => (current === messageId ? null : current)), 1600);
      } catch {
        pushToast("Clipboard is not available");
      }
    },
    [pushToast]
  );

  // keep the newest turn visible
  useEffect(() => {
    for (const slot of slots) {
      const ref = scrollRefs.current[slot.id];
      if (ref) ref.scrollToBottom({ smooth: false });
    }
  }, [slots.map((slot) => slot.messages.length).join(","), slots.map((slot) => slot.running).join(",")]);

  const totalPrompts = useMemo(
    () =>
      slots.reduce(
        (sum, slot) => sum + slot.messages.filter((message) => message.meta?.kind === "prompt").length,
        0
      ),
    [slots]
  );

  const modelPickerLabels: ModelPickerLabels = {
    selectModel: labels.selectModel,
    noModelsConfigured: labels.noModelsConfigured,
    searchModels: labels.searchModels,
    noModelsFound: labels.noModelsFound,
  };

  const renderStudyStrip = (slot: ExpertSlot) => {
    const study = slot.study;
    const studied = study?.status === "ready";
    const partial = study?.status === "partial" || study?.status === "studying" || study?.status === "scanned";
    const files = Number(study?.files) || 0;
    const rounds = Number(study?.rounds) || 0;
    const readFiles = Number(study?.readFiles) || 0;
    const coverage = files > 0 ? Math.min(1, readFiles / Math.max(files, 1)) : 0;
    return (
      <div className={`expert-study ${studied ? "is-ready" : partial ? "is-partial" : ""}`}>
        <span className="expert-study-dot" aria-hidden />
        <span className="expert-study-label">
          {slot.running && slot.phase === "study"
            ? "STUDYING"
            : studied
              ? "STUDIED"
              : partial
                ? "PARTIAL"
                : "NOT STUDIED"}
        </span>
        <span className="expert-study-facts">
          {files > 0 ? `${files.toLocaleString()} files` : "no scan yet"}
          {rounds > 0 ? ` · ${rounds} rounds` : ""}
          {readFiles > 0 ? ` · ${readFiles} read` : ""}
        </span>
        <span className="expert-study-bar" aria-hidden>
          <i style={{ width: `${Math.round(coverage * 100)}%` }} />
        </span>
        {slot.rootPath ? (
          slot.confirmReset ? (
            <button
              type="button"
              className="expert-study-reset is-confirm"
              onClick={() => void resetStudy(slot.id)}
              title="Confirm: delete the stored study"
            >
              confirm
            </button>
          ) : (
            <button
              type="button"
              className="expert-study-reset"
              disabled={slot.running}
              onClick={() => patchSlot(slot.id, { confirmReset: true })}
              onBlur={() => patchSlot(slot.id, { confirmReset: false })}
              title="Re-study the whole project on the next message"
            >
              <RotateCcw />
            </button>
          )
        ) : null}
      </div>
    );
  };

  const renderMessages = (slot: ExpertSlot) => {
    if (!slot.messages.length && !slot.running) {
      return (
        <div className="expert-empty">
          <div className="expert-empty-mark">
            <Sparkles />
          </div>
          <p className="expert-empty-title">Whole-project prompt composer</p>
          <p className="expert-empty-text">
            Pick a directory. Expert scans every file, maps modules, contracts and flows, then turns your task
            into one prompt that plugs into the code that already exists.
          </p>
          <button type="button" className="expert-empty-btn" onClick={() => void chooseFolder(slot.id)}>
            <FolderOpen /> Select directory
          </button>
        </div>
      );
    }

    return (
      <div className="expert-thread">
        {slot.messages.map((message) => {
          if (message.role === "user") {
            return (
              <div key={message.id} className="expert-msg expert-msg-user">
                <span className="expert-msg-tag">TASK</span>
                <div className="expert-msg-user-body">{message.content}</div>
              </div>
            );
          }
          const isPrompt = message.meta?.kind === "prompt";
          const isError = message.meta?.kind === "error";
          const meta = message.meta || {};
          return (
            <article
              key={message.id}
              className={`expert-msg expert-msg-assistant ${isPrompt ? "is-prompt" : ""} ${isError ? "is-error" : ""} ${
                meta.stopped ? "is-stopped" : ""
              }`}
            >
              <div className="expert-msg-head">
                <span className="expert-msg-kind">
                  {isPrompt ? <FileText /> : isError ? <AlertTriangle /> : <Layers />}
                  {isPrompt ? "PROMPT" : isError ? "ERROR" : "STUDY"}
                </span>
                {isPrompt ? (
                  <span className="expert-msg-meta">
                    {String(meta.modelName || "")}
                    {meta.contextTokens ? ` · ${formatTokens(Number(meta.contextTokens))} ctx` : ""}
                    {Number(meta.study?.rounds || 0) > 0 ? ` · ${Number(meta.study?.rounds)} rounds` : ""}
                  </span>
                ) : null}
                <span className="expert-msg-actions">
                  {isPrompt ? (
                    <button
                      type="button"
                      className="expert-copy"
                      onClick={() => void copyPrompt(message.id, message.content)}
                      title="Copy the whole prompt"
                    >
                      {copiedId === message.id ? <Check /> : <Copy />}
                      <span>{copiedId === message.id ? "copied" : "copy"}</span>
                    </button>
                  ) : null}
                  <span className="expert-msg-time">{formatWhen(message.createdAt)}</span>
                </span>
              </div>
              {isPrompt ? (
                <div className="expert-prompt-body">{message.content}</div>
              ) : (
                <div className="expert-note-body">{message.content}</div>
              )}
            </article>
          );
        })}

        {slot.running ? (
          <div className="expert-live">
            <div className="expert-live-head">
              <Loader2 className="expert-live-spin" />
              <span>{slot.status || "Working…"}</span>
            </div>
            <div className="expert-live-phases">
              {PHASES.map((phase) => {
                const active = phaseIndex(slot.phase) === phaseIndex(phase.id);
                const done = phaseIndex(slot.phase) > phaseIndex(phase.id);
                return (
                  <span
                    key={phase.id}
                    className={`expert-live-phase ${active ? "is-active" : ""} ${done ? "is-done" : ""}`}
                  >
                    <i aria-hidden />
                    {phase.label}
                  </span>
                );
              })}
            </div>
            {slot.study?.files ? (
              <div className="expert-live-facts">
                {Number(slot.study.files).toLocaleString()} files
                {slot.study.rounds ? ` · ${slot.study.rounds} rounds` : ""}
                {slot.study.readFiles ? ` · ${slot.study.readFiles} read` : ""}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    );
  };

  const renderPane = (slot: ExpertSlot, index: number) => {
    const contextPct =
      slot.contextLimit > 0 ? Math.min(1, (slot.contextTokens || 0) / slot.contextLimit) : 0;
    return (
      <section key={slot.id} className={`expert-pane ${slot.running ? "is-running" : ""}`}>
        <header className="expert-pane-head">
          <span className="expert-pane-index">{String(index + 1).padStart(2, "0")}</span>
          <button
            type="button"
            className="expert-folder"
            onClick={() => void chooseFolder(slot.id)}
            disabled={slot.running}
            title={slot.rootPath || "Select directory"}
          >
            {slot.rootPath ? <Folder /> : <FolderOpen />}
            <span>{slot.projectName || "Select directory"}</span>
          </button>
          <span className="expert-pane-tools">
            <button type="button" disabled={slot.running} onClick={() => newChat(slot.id)} title="New chat">
              <Plus />
            </button>
            <button type="button" disabled={slot.running} onClick={() => void loadHistory(slot.id)} title="Chat history">
              <History />
            </button>
            <button type="button" disabled={!slot.sessionId} onClick={() => void copySession(slot.id)} title="Copy session">
              <Copy />
            </button>
            <button type="button" disabled={slot.running} onClick={() => void pasteSession(slot.id)} title="Paste session">
              <ClipboardPaste />
            </button>
            <button
              type="button"
              disabled={!slot.sessionId}
              onClick={() => {
                setSaveName(slot.messages.find((message) => message.role === "user")?.content.slice(0, 60) || "Expert chat");
                setModal({ kind: "save", slotId: slot.id });
              }}
              title="Save session"
            >
              <BookmarkPlus />
            </button>
          </span>
        </header>

        {renderStudyStrip(slot)}

        <ChatMonoScroll
          className="expert-transcript"
          ref={(handle) => {
            scrollRefs.current[slot.id] = handle;
          }}
        >
          {renderMessages(slot)}
        </ChatMonoScroll>

        <div className="expert-dock">
          {slot.error ? (
            <div className="expert-error">
              <AlertTriangle />
              <span>{slot.error}</span>
              <button type="button" onClick={() => patchSlot(slot.id, { error: null })} title="Dismiss">
                <X />
              </button>
            </div>
          ) : null}
          <div className="expert-composer">
            <AutoTextarea
              value={slot.draft}
              disabled={slot.running}
              placeholder="Write your task — Expert already knows the project…"
              onChange={(value) => patchSlot(slot.id, { draft: value })}
              onSend={() => void send(slot.id)}
            />
            <div className="expert-composer-row">
              <ModelPicker
                open={slot.modelOpen}
                onOpenChange={(open) => patchSlot(slot.id, { modelOpen: open })}
                providers={providers}
                models={models}
                selectedModelId={slot.selectedModelId || defaultModelId || undefined}
                onSelectModel={(modelId) => patchSlot(slot.id, { selectedModelId: modelId })}
                labels={modelPickerLabels}
              />
              <span
                className={`expert-ctx ${contextPct > 0.85 ? "is-danger" : contextPct > 0.6 ? "is-warn" : ""}`}
                title={
                  slot.contextLimit
                    ? `${slot.contextTokens.toLocaleString()} / ${slot.contextLimit.toLocaleString()} context tokens`
                    : "Context usage appears after the first prompt"
                }
              >
                <span className="expert-ctx-bar">
                  <i style={{ width: `${Math.round(contextPct * 100)}%` }} />
                </span>
                <span className="expert-ctx-text">
                  ctx {formatTokens(slot.contextTokens)}
                  {slot.contextLimit ? `/${formatTokens(slot.contextLimit)}` : ""}
                </span>
              </span>
              {slot.running ? (
                <button type="button" className="expert-send is-stop" onClick={() => void stop(slot.id)}>
                  <Square />
                  <span>{labels.stop}</span>
                </button>
              ) : (
                <button
                  type="button"
                  className="expert-send"
                  disabled={!slot.draft.trim() || !slot.rootPath}
                  onClick={() => void send(slot.id)}
                >
                  <Send />
                  <span>{labels.send}</span>
                </button>
              )}
            </div>
          </div>
        </div>
      </section>
    );
  };

  return (
    <div className="expert-root">
      <header className="expert-topbar">
        <span className="expert-brand">
          <Sparkles />
          <strong>Expert</strong>
          <span className="expert-brand-sub">project-aware prompt composer</span>
        </span>
        <span className="expert-topbar-facts">
          {slots.filter((slot) => slot.rootPath).length}/3 projects · {totalPrompts} prompts
        </span>
      </header>

      <div className="expert-stage">{slots.map(renderPane)}</div>

      {modal ? (
        <div className="expert-modal-backdrop" onClick={() => setModal(null)}>
          <div className="expert-modal" onClick={(event) => event.stopPropagation()}>
            <header className="expert-modal-head">
              <div>
                <span className="expert-modal-kicker">
                  {modal.kind === "history" ? "SESSION LOG" : "SAVE SESSION"}
                </span>
                <h3>{modal.kind === "history" ? "Expert chats" : "Save this session"}</h3>
              </div>
              <button type="button" className="expert-icon-btn" onClick={() => setModal(null)} aria-label="Close">
                <X />
              </button>
            </header>

            {modal.kind === "save" ? (
              <div className="expert-modal-body">
                <label className="expert-field">
                  <span>Name</span>
                  <input
                    value={saveName}
                    autoFocus
                    onChange={(event) => setSaveName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void saveSession(modal.slotId, saveName);
                    }}
                    placeholder="Session name"
                  />
                </label>
                <div className="expert-modal-actions">
                  <button type="button" className="expert-btn" onClick={() => setModal(null)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="expert-btn is-primary"
                    onClick={() => void saveSession(modal.slotId, saveName)}
                  >
                    <Bookmark /> Save
                  </button>
                </div>
              </div>
            ) : (
              <div className="expert-modal-body is-scroll">
                {history.loading ? (
                  <div className="expert-modal-loading">
                    <Loader2 className="expert-live-spin" /> Loading…
                  </div>
                ) : (
                  <>
                    <div className="expert-modal-section">CHATS</div>
                    {history.sessions.length === 0 ? (
                      <div className="expert-modal-empty">No chats for this folder yet.</div>
                    ) : (
                      <ul className="expert-session-list">
                        {history.sessions.map((session) => (
                          <li key={session.sessionId} className="expert-session-item">
                            <button
                              type="button"
                              className="expert-session-open"
                              onClick={() => void openSession(modal.slotId, session.sessionId)}
                              disabled={slots.find((slot) => slot.id === modal.slotId)?.running}
                            >
                              <span className="expert-session-title">{session.title || "Expert chat"}</span>
                              <span className="expert-session-meta">
                                {session.promptCount} prompts · {session.messageCount} msgs · {formatWhen(session.updatedAt)}
                              </span>
                            </button>
                            <button
                              type="button"
                              className="expert-session-del"
                              title="Delete chat"
                              onClick={() => void deleteSession(modal.slotId, session.sessionId)}
                            >
                              <Trash2 />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}

                    <div className="expert-modal-section">SAVED</div>
                    {history.saved.length === 0 ? (
                      <div className="expert-modal-empty">Saved sessions appear here.</div>
                    ) : (
                      <ul className="expert-session-list">
                        {history.saved.map((entry) => (
                          <li key={entry.id} className="expert-session-item">
                            <button
                              type="button"
                              className="expert-session-open"
                              onClick={() => void openSaved(modal.slotId, entry.id)}
                              disabled={slots.find((slot) => slot.id === modal.slotId)?.running}
                            >
                              <span className="expert-session-title">
                                <Bookmark /> {entry.name}
                              </span>
                              <span className="expert-session-meta">
                                {entry.messageCount} msgs · {formatWhen(entry.updatedAt)}
                              </span>
                            </button>
                            <button
                              type="button"
                              className="expert-session-del"
                              title="Delete saved session"
                              onClick={async () => {
                                await window.lopster?.expertDeleteSaved?.(entry.id);
                                setHistory((prev) => ({
                                  ...prev,
                                  saved: prev.saved.filter((item) => item.id !== entry.id),
                                }));
                              }}
                            >
                              <Trash2 />
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        </div>
      ) : null}

      {toast ? <div className="expert-toast">{toast}</div> : null}
    </div>
  );
};

export default ExpertWorkspace;
