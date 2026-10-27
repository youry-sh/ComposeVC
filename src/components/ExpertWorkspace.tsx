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
  Hash,
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
import MarkdownContent from "./markdown/MarkdownContent";
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
  studying: boolean;
  phase: string | null;
  status: string;
  study: ExpertStudyMeta | null;
  contextTokens: number;
  contextLimit: number;
  error: string | null;
  modelOpen: boolean;
  preview: boolean;
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
    studying: false,
    phase: null,
    status: "",
    study: null,
    contextTokens: 0,
    contextLimit: 0,
    error: null,
    modelOpen: false,
    preview: false,
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
  const [historyTab, setHistoryTab] = useState<"chats" | "saved">("chats");
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
    const configured = providerConfig.selectedModelId;
    if (configured && models.some((model) => model.id === configured)) return configured;
    return models[0]?.id || null;
  }, [models, providerConfig.selectedModelId]);

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
          const meta = status?.meta as unknown as ExpertStudyMeta | undefined;
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
          const phase = payload.phase ? String(payload.phase) : slot.phase;
          const studyFinished = payload.studyDone !== undefined;
          const isStudyPhase = phase === "scan" || phase === "study";
          const study: ExpertStudyMeta = { ...(slot.study || {}) };
          if (payload.files !== undefined) study.files = Number(payload.files) || 0;
          if (payload.lines !== undefined) study.lines = Number(payload.lines) || 0;
          if (payload.rounds !== undefined) study.rounds = Number(payload.rounds) || 0;
          if (payload.readFiles !== undefined) study.readFiles = Number(payload.readFiles) || 0;
          if (isStudyPhase && !studyFinished) study.status = "studying";
          if (studyFinished) {
            study.status =
              typeof payload.studyStatus === "string"
                ? String(payload.studyStatus)
                : payload.studyDone === true
                  ? "ready"
                  : "partial";
          }
          if (payload.phase === "error") study.status = "partial";
          return {
            ...slot,
            phase,
            status: payload.status ? String(payload.status) : slot.status,
            running: payload.done === true ? false : slot.running,
            studying: isStudyPhase && !studyFinished ? true : studyFinished ? false : slot.studying,
            contextTokens: Number(payload.contextTokens) || slot.contextTokens,
            study: Object.keys(study).length ? study : slot.study,
          };
        })
      );
    });
    return () => unsubscribe?.();
  }, []);

  useEffect(() => {
    if (!modal) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setModal(null);
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [modal]);

  // ── folder / session actions ───────────────────────────────────────────────
  const loadStudyStatus = useCallback(async (slotId: string, rootPath: string | null) => {
    if (!rootPath) {
      patchSlot(slotId, { study: null });
      return;
    }
    try {
      const status = await window.lopster?.expertStudyStatus?.(rootPath);
      const current = slotsRef.current.find((item) => item.id === slotId);
      // A live study owns the strip; a stale disk snapshot must not overwrite it.
      if (current?.studying) return;
      patchSlot(slotId, { study: (status?.meta as unknown as ExpertStudyMeta) || null });
    } catch {
      patchSlot(slotId, { study: null });
    }
  }, [patchSlot]);

  const startStudy = useCallback(
    async (input: {
      slotId: string;
      rootPath?: string | null;
      projectName?: string | null;
      modelId?: string | null;
      sessionId?: string | null;
      force?: boolean;
    }) => {
      const slot = slotsRef.current.find((item) => item.id === input.slotId);
      const rootPath = input.rootPath ?? slot?.rootPath ?? null;
      if (!slot || !rootPath || slot.studying) return;
      const modelId = input.modelId || slot.selectedModelId || defaultModelId;
      if (!modelId) {
        patchSlot(input.slotId, { error: "No model configured. Add one in Providers, then study." });
        return;
      }
      if (!window.lopster?.expertStudy) {
        patchSlot(input.slotId, { error: "Expert study bridge is unavailable — restart ComposeVC." });
        return;
      }
      patchSlot(input.slotId, {
        studying: true,
        error: null,
        phase: "scan",
        status: "Scanning every file in the project…",
        study: { status: "studying" },
      });
      try {
        const res = await window.lopster.expertStudy({
          slotId: input.slotId,
          rootPath,
          projectName: input.projectName || slot.projectName || projectNameOf(rootPath),
          modelId,
          sessionId: input.sessionId ?? slot.sessionId,
          force: input.force === true,
        });
        if (res?.ok) {
          patchSlot(input.slotId, {
            studying: false,
            phase: "done",
            status: "",
            study: (res.meta as unknown as ExpertStudyMeta) || null,
          });
        } else {
          const current = slotsRef.current.find((item) => item.id === input.slotId);
          patchSlot(input.slotId, {
            studying: false,
            phase: null,
            status: "",
            error: res?.stopped ? null : res?.error || "Study failed",
            study: { ...(current?.study || {}), status: "partial" },
          });
          if (!res?.stopped) pushToast(res?.error || "Study failed");
        }
      } catch (error) {
        patchSlot(input.slotId, {
          studying: false,
          phase: null,
          status: "",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [defaultModelId, patchSlot, pushToast]
  );

  const chooseFolder = useCallback(
    async (slotId: string) => {
      const slot = slotsRef.current.find((item) => item.id === slotId);
      if (!slot || slot.running || slot.studying) return;
      try {
        const picked = await window.lopster?.openFolder?.();
        if (!picked?.path) return;
        const projectName = picked.name || projectNameOf(picked.path);
        patchSlot(slotId, {
          rootPath: picked.path,
          projectName,
          sessionId: null,
          messages: [],
          contextTokens: 0,
          contextLimit: 0,
          error: null,
          status: "",
          phase: null,
          studying: false,
          study: null,
        });
        // Study starts immediately: by the time the first task arrives the whole
        // project is already mapped, and the pane shows live progress instead of
        // a stale "pick a directory" screen.
        const modelId = slot.selectedModelId || defaultModelId;
        if (modelId) {
          void startStudy({ slotId, rootPath: picked.path, projectName, modelId, sessionId: null });
        } else {
          void loadStudyStatus(slotId, picked.path);
        }
      } catch (error) {
        patchSlot(slotId, { error: error instanceof Error ? error.message : String(error) });
      }
    },
    [defaultModelId, loadStudyStatus, patchSlot, startStudy]
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
      setHistoryTab("chats");
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
      const session = res?.session as unknown as
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
      if (!slot) return;
      if (!slot.messages.length) {
        pushToast("Nothing to save yet — send a task first");
        return;
      }
      if (!window.lopster?.expertSaveSnapshot) {
        pushToast("Save is unavailable — restart ComposeVC");
        return;
      }
      const res = await window.lopster
        .expertSaveSnapshot({
          slotId,
          name,
          title: slot.messages.find((message) => message.role === "user")?.content.slice(0, 60) || "Expert chat",
          rootPath: slot.rootPath,
          projectName: slot.projectName,
          modelId: slot.selectedModelId || defaultModelId,
          sessionId: slot.sessionId,
          messages: slot.messages.map((message) => ({
            id: message.id,
            role: message.role,
            content: message.content,
            createdAt: message.createdAt,
            meta: message.meta,
          })),
        })
        .catch(
          (error): { ok: boolean; error: string; sessionId?: string } => ({
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          })
        );
      if (res?.ok) {
        if (res.sessionId) patchSlot(slotId, { sessionId: res.sessionId });
        setModal(null);
        pushToast("Session saved — History → Saved");
      } else {
        pushToast(res?.error || "Could not save the session");
      }
    },
    [defaultModelId, patchSlot, pushToast]
  );

  const copySession = useCallback(
    async (slotId: string) => {
      const slot = slotsRef.current.find((item) => item.id === slotId);
      if (!slot?.sessionId) {
        pushToast("Nothing to copy yet");
        return;
      }
      const res = await window.lopster?.expertCopySession?.({ sessionId: slot.sessionId });
      pushToast(res?.ok ? `Session ID copied · ${res.sessionId || slot.sessionId}` : res?.error || "Could not copy the session");
    },
    [pushToast]
  );

  const copySessionId = useCallback(
    async (sessionId: string | null) => {
      if (!sessionId) {
        pushToast("No session ID yet — send a task first");
        return;
      }
      try {
        await navigator.clipboard.writeText(sessionId);
        pushToast(`Session ID copied · ${sessionId}`);
      } catch {
        pushToast("Clipboard is not available");
      }
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
      const session = res?.session as unknown as
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
      pushToast("Session copied — the original stays untouched");
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
      if (!window.lopster?.expertSend) {
        patchSlot(slotId, { error: "Expert bridge is unavailable — restart ComposeVC." });
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
        phase: slot.studying ? slot.phase : "start",
        status: slot.studying ? slot.status : "Preparing Expert…",
      });

      try {
        // Create the persisted session up front so Copy / Save work while the
        // study and compose are still running (before the reply resolves).
        let sessionId = slot.sessionId;
        if (!sessionId && window.lopster?.expertNewSession) {
          const created = await window.lopster
            .expertNewSession({
              rootPath: slot.rootPath,
              projectName: slot.projectName,
              slotId,
            })
            .catch(() => null);
          const createdSession = created?.session as unknown as { sessionId?: string } | undefined;
          if (created?.ok && createdSession?.sessionId) {
            sessionId = createdSession.sessionId;
            patchSlot(slotId, { sessionId });
          }
        }
        const res = await window.lopster?.expertSend?.({
          slotId,
          task,
          modelId,
          rootPath: slot.rootPath,
          projectName: slot.projectName,
          sessionId,
        });
        const resolvedSessionId = res?.sessionId || sessionId;
        if (resolvedSessionId) {
          const session = await window.lopster?.expertLoadSession?.(resolvedSessionId);
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
              item.id === slotId ? { ...item, study: res.study as unknown as ExpertStudyMeta, running: false } : item
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
          {slot.studying
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
        {slot.sessionId ? (
          <button
            type="button"
            className="expert-session-id"
            onClick={() => void copySessionId(slot.sessionId)}
            title={`Copy session ID · ${slot.sessionId}`}
          >
            <Hash />
            <span>{slot.sessionId.slice(-8)}</span>
          </button>
        ) : null}
        {slot.rootPath ? (
          slot.confirmReset ? (
            <button
              type="button"
              className="expert-study-reset is-confirm"
              disabled={slot.running}
              onClick={() => void resetStudy(slot.id)}
              title="Confirm: delete the stored study"
            >
              confirm
            </button>
          ) : (
            <button
              type="button"
              className="expert-study-reset"
              disabled={slot.running || slot.studying}
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
      if (!slot.rootPath) {
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

      const studied = slot.study?.status === "ready";
      const files = Number(slot.study?.files) || 0;
      const rounds = Number(slot.study?.rounds) || 0;
      const readFiles = Number(slot.study?.readFiles) || 0;
      return (
        <div className="expert-empty is-project">
          <div className="expert-empty-mark">
            {slot.studying ? <Loader2 className="expert-live-spin" /> : <FolderOpen />}
          </div>
          <p className="expert-empty-title">{slot.studying ? "Studying project" : "Project selected"}</p>
          <p className="expert-empty-project">{slot.projectName || projectNameOf(slot.rootPath)}</p>
          <p className="expert-empty-path" title={slot.rootPath}>
            {slot.rootPath}
          </p>
          <p className="expert-empty-text">
            {slot.studying
              ? slot.status || "Scanning every file, mapping modules, contracts and flows…"
              : studied
                ? `Studied ${files.toLocaleString()} files · ${rounds} rounds${readFiles ? ` · ${readFiles} read in depth` : ""}. Write your task and you get one implementation prompt.`
                : "The project is selected. Write your task — Expert studies it fully first, then composes the prompt."}
          </p>
          <div className="expert-empty-actions">
            {slot.studying ? (
              <button type="button" className="expert-empty-btn is-quiet" onClick={() => void stop(slot.id)}>
                <Square /> Stop study
              </button>
            ) : (
              <button type="button" className="expert-empty-btn" onClick={() => void startStudy({ slotId: slot.id, force: studied })}>
                <Layers /> {studied ? "Re-study" : "Study now"}
              </button>
            )}
            <button
              type="button"
              className="expert-empty-btn is-quiet"
              disabled={slot.studying}
              onClick={() => void chooseFolder(slot.id)}
            >
              <FolderOpen /> Change folder
            </button>
          </div>
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
          const meta = readMeta(message);
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
                <div className="expert-prompt-body">
                  <MarkdownContent content={message.content} />
                </div>
              ) : (
                <div className="expert-note-body">
                  <MarkdownContent content={message.content} />
                </div>
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
            disabled={slot.running || slot.studying}
            title={
              slot.studying
                ? "Stop the study before changing the folder"
                : slot.rootPath || "Select directory"
            }
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
            <button type="button" disabled={!slot.sessionId} onClick={() => void copySession(slot.id)} title="Copy session ID">
              <Copy />
            </button>
            <button type="button" disabled={slot.running} onClick={() => void pasteSession(slot.id)} title="Paste session or session ID">
              <ClipboardPaste />
            </button>
            <button
              type="button"
              onClick={() => {
                if (!slot.messages.length) {
                  pushToast("Send a task first — there is nothing to save yet");
                  return;
                }
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
            {slot.preview ? (
              <ChatMonoScroll className="expert-composer-preview">
                <div className="expert-composer-preview-inner">
                  {slot.draft.trim() ? (
                    <MarkdownContent content={slot.draft} />
                  ) : (
                    <p className="expert-composer-preview-empty">
                      Markdown preview — start typing and the task renders here.
                    </p>
                  )}
                </div>
              </ChatMonoScroll>
            ) : null}
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
              <button
                type="button"
                className={`expert-md-toggle ${slot.preview ? "is-active" : ""}`}
                onClick={() => patchSlot(slot.id, { preview: !slot.preview })}
                title={slot.preview ? "Hide Markdown preview" : "Markdown preview of the task"}
                aria-pressed={slot.preview}
              >
                MD
              </button>
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
              <>
                <div className="expert-modal-tabs" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={historyTab === "chats"}
                    className={`expert-modal-tab ${historyTab === "chats" ? "is-active" : ""}`}
                    onClick={() => setHistoryTab("chats")}
                  >
                    Chats <span>{history.sessions.length}</span>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={historyTab === "saved"}
                    className={`expert-modal-tab ${historyTab === "saved" ? "is-active" : ""}`}
                    onClick={() => setHistoryTab("saved")}
                  >
                    Saved <span>{history.saved.length}</span>
                  </button>
                  <span className="expert-modal-tabs-hint">
                    {slots.find((slot) => slot.id === modal.slotId)?.projectName || "all folders"}
                  </span>
                </div>
                <ChatMonoScroll className="expert-modal-scroll">
                  <div className="expert-modal-body">
                  {history.loading ? (
                    <div className="expert-modal-loading">
                      <Loader2 className="expert-live-spin" /> Loading…
                    </div>
                  ) : historyTab === "chats" ? (
                    history.sessions.length === 0 ? (
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
                              title={session.title || "Expert chat"}
                            >
                              <span className="expert-session-title">
                                <FileText />
                                <span className="expert-session-name">{session.title || "Expert chat"}</span>
                              </span>
                              <span className="expert-session-meta">
                                {session.promptCount} prompts · {session.messageCount} msgs ·{" "}
                                {formatWhen(session.updatedAt)}
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
                    )
                  ) : history.saved.length === 0 ? (
                    <div className="expert-modal-empty">
                      Saved sessions appear here. Use the bookmark button in a chat header to save one.
                    </div>
                  ) : (
                    <ul className="expert-session-list">
                      {history.saved.map((entry) => (
                        <li key={entry.id} className="expert-session-item">
                          <button
                            type="button"
                            className="expert-session-open"
                            onClick={() => void openSaved(modal.slotId, entry.id)}
                            disabled={slots.find((slot) => slot.id === modal.slotId)?.running}
                            title={entry.name}
                          >
                            <span className="expert-session-title">
                              <Bookmark />
                              <span className="expert-session-name">{entry.name}</span>
                            </span>
                            <span className="expert-session-meta">
                              {entry.messageCount} msgs · {formatWhen(entry.updatedAt)}
                            </span>
                          </button>
                          <button
                            type="button"
                            className="expert-session-copy"
                            title="Copy saved session ID"
                            onClick={() => void copySessionId(entry.sessionId)}
                          >
                            <Hash />
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
                  </div>
                </ChatMonoScroll>
              </>
            )}
          </div>
        </div>
      ) : null}

      {toast ? <div className="expert-toast">{toast}</div> : null}
    </div>
  );
};

export default ExpertWorkspace;
