import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Box,
  ChevronRight,
  Clapperboard,
  FolderOpen,
  Loader2,
  Music,
  Play,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Wand2,
} from "lucide-react";
import type {
  ComposeVCMotionMedia,
  ComposeVCMotionPlan,
  ComposeVCMotionTimelineItem,
  ComposeVCPlugin,
  ComposeVCPluginConfig,
  ComposeVCPluginsState,
} from "../types";

type DraftConfig = {
  executable: string;
  outputDir: string;
  engine: string;
  width: number;
  height: number;
  samples: number;
  format: string;
  autoRender: boolean;
  timeoutSec: number;
  addons: string[];
  projectDir: string;
  preset: string;
  exportPath: string;
  headless: boolean;
  importGlb: boolean;
  glbDir: string;
  ffmpegPath: string;
  fps: number;
  crf: number;
  theme: string;
  fontFamily: string;
  safeMargins: boolean;
  audioBitrateKbps: number;
};

const MOTION_PRESETS = ["ultrafast", "superfast", "veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"];
const MOTION_FORMATS = ["mp4", "mov", "webm", "gif"];
const MOTION_ANIMATIONS = ["fade", "rise", "slide", "typewriter"];
const MOTION_TRANSITIONS = ["fade", "slideleft", "slideright", "wipeleft", "wiperight", "circleopen", "dissolve"];
const MOTION_KINDS: Array<ComposeVCMotionTimelineItem["kind"]> = ["title", "scene", "transition", "audio"];

const motionPlanFrom = (config: ComposeVCPluginConfig): ComposeVCMotionPlan => ({
  name: "Ролик",
  timeline: [
    { id: "t1", kind: "title", text: "Motion Studio", start: 0, end: 3, animation: "fade" },
    { id: "t2", kind: "transition", start: 3, end: 3.6, transition: "dissolve" },
    { id: "t3", kind: "title", text: "ComposeVC", start: 3, end: 6, animation: "rise" },
  ],
  output: {
    width: config.width || 1920,
    height: config.height || 1080,
    fps: config.fps || 30,
    crf: config.crf ?? 20,
    preset: config.preset || "medium",
    format: config.format || "mp4",
  },
  audio: { path: "", gainDb: 0 },
});

const quietBtn =
  "ide-quiet-btn inline-flex h-7 shrink-0 items-center justify-center gap-1.5 px-2.5 text-[11px] leading-none outline-none transition-colors disabled:opacity-40 theme-soft";
const primaryBtn =
  "ide-primary-btn inline-flex h-7 shrink-0 items-center justify-center gap-1.5 px-2.5 text-[11px] leading-none outline-none transition-colors disabled:opacity-40 ui-btn-primary";
const labelClass = "ide-field-label text-[10px] font-medium uppercase tracking-[0.1em] text-ink-500";
const fieldStyle: React.CSSProperties = { caretColor: "var(--accent)" };
const fieldClass =
  "ide-field h-7 w-full min-w-0 px-2 text-[12px] leading-7 text-ink-950 placeholder-ink-500 outline-none";

const Section: React.FC<{
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
}> = ({ title, actions, children }) => (
  <section className="mb-3 border border-ink-200 bg-ink-0">
    <div className="flex h-8 items-center gap-2 border-b border-ink-200 px-3">
      <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-ink-500">{title}</span>
      <div className="ml-auto flex items-center gap-1.5">{actions}</div>
    </div>
    <div className="px-3 py-3">{children}</div>
  </section>
);

const IcoGodot: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M8.2 5.6a9.4 9.4 0 0 1 7.6 0l1 0.4 2.6-.9a1 1 0 0 1 1.3.8l2 11a1 1 0 0 1-.6 1.1l-3 1.2a1 1 0 0 1-1.2-.4l-1.2-1.8H7.3L6.1 18.8a1 1 0 0 1-1.2.4l-3-1.2a1 1 0 0 1-.6-1.1l2-11a1 1 0 0 1 1.3-.8l2.6.9Z" />
    <path d="M9.4 10.6h.01M14.6 10.6h.01" />
  </svg>
);

const IcoMotion: React.FC<{ className?: string }> = ({ className }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <path d="M3 8.5h18v11a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 19.5v-11Z" />
    <path d="M3 8.5 5.2 4h13.6L21 8.5" />
    <path d="M8.5 8.5 7 4M13 8.5 11.5 4M17.5 8.5 16 4" />
    <path d="m10 13.2 4.2 2.4-4.2 2.4v-4.8Z" />
  </svg>
);

const PluginsWorkspace: React.FC = () => {
  const [state, setState] = useState<ComposeVCPluginsState | null>(null);
  const [activeId, setActiveId] = useState<string>("blender");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<DraftConfig | null>(null);
  const [draftFor, setDraftFor] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [probing, setProbing] = useState(false);
  const [demoBusy, setDemoBusy] = useState(false);
  const [addonInput, setAddonInput] = useState("");
  const [godotAction, setGodotAction] = useState<"build" | "import" | "demo" | null>(null);
  const [godotProgress, setGodotProgress] = useState<{ stage: string; percent: number; done: boolean } | null>(null);
  const [motionPlan, setMotionPlan] = useState<ComposeVCMotionPlan | null>(null);
  const [motionPlanFor, setMotionPlanFor] = useState<string | null>(null);
  const [motionMedia, setMotionMedia] = useState<ComposeVCMotionMedia | null>(null);
  const [motionMediaPath, setMotionMediaPath] = useState("");
  const [motionAudioPath, setMotionAudioPath] = useState("");
  const [motionMediaBusy, setMotionMediaBusy] = useState(false);
  const [motionBusy, setMotionBusy] = useState(false);
  const [installBusy, setInstallBusy] = useState(false);
  const [motionPreview, setMotionPreview] = useState<string | null>(null);
  const [motionProgress, setMotionProgress] = useState<{
    stage: string;
    percent: number;
    done: boolean;
    error?: string;
  } | null>(null);

  const plugin = useMemo(
    () => state?.plugins.find((entry) => entry.id === activeId) || state?.plugins[0] || null,
    [state, activeId]
  );

  const refreshPlugins = useCallback(async () => {
    try {
      const next = await window.lopster?.pluginsList?.();
      if (next) setState(next);
      if (next && !next.ok && next.error) setError(next.error);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      await refreshPlugins();
      if (alive) setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [refreshPlugins]);

  useEffect(() => {
    const offChanged = window.lopster?.onPluginsChanged?.(() => {
      void refreshPlugins();
    });
    const offJob = window.lopster?.onPluginJob?.((payload) => {
      if (payload?.pluginId === "godot") {
        setGodotProgress({
          stage: payload.stage || "",
          percent: Number(payload.percent) || 0,
          done: Boolean(payload.done),
        });
      }
      if (payload?.pluginId === "motion") {
        setMotionProgress((prev) => ({
          stage: payload.stage || prev?.stage || "",
          percent: typeof payload.percent === "number" ? payload.percent : prev?.percent || 0,
          done: Boolean(payload.done),
          error: payload.error || "",
        }));
      }
      if (payload?.done) void refreshPlugins();
    });
    return () => {
      offChanged?.();
      offJob?.();
    };
  }, [refreshPlugins]);

  useEffect(() => {
    if (!plugin) return;
    if (draftFor === plugin.id) return;
    const config = plugin.config;
    const motion = plugin.id === "motion";
    setDraft({
      executable: config.executable || "",
      outputDir: config.outputDir || plugin.outputDir || "",
      engine: config.engine || "EEVEE",
      width: motion ? config.width || 1920 : config.resolution?.width || 1600,
      height: motion ? config.height || 1080 : config.resolution?.height || 1000,
      samples: config.samples || 64,
      format: config.format || (motion ? "mp4" : "GLB"),
      autoRender: config.autoRender !== false,
      timeoutSec: config.timeoutSec || (plugin.id === "godot" ? 1800 : motion ? 3600 : 900),
      addons: Array.isArray(config.addons) ? config.addons.slice() : [],
      projectDir: config.projectDir || "",
      preset: config.preset || (motion ? "medium" : "windows"),
      exportPath: config.exportPath || "",
      headless: config.headless !== false,
      importGlb: config.importGlb !== false,
      glbDir: config.glbDir || "",
      ffmpegPath: config.ffmpegPath || "",
      fps: config.fps || 30,
      crf: config.crf ?? 20,
      theme: config.theme || "clean",
      fontFamily: config.fontFamily || "Inter",
      safeMargins: config.safeMargins !== false,
      audioBitrateKbps: config.audioBitrateKbps || 192,
    });
    setDraftFor(plugin.id);
    setDirty(false);
  }, [plugin, draftFor]);

  useEffect(() => {
    if (!plugin || plugin.id !== "motion") return;
    if (motionPlanFor === plugin.id) return;
    setMotionPlan(motionPlanFrom(plugin.config));
    setMotionPlanFor(plugin.id);
  }, [plugin, motionPlanFor]);

  const updateDraft = (patch: Partial<DraftConfig>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
    setDirty(true);
    setNotice(null);
  };

  const addAddonModule = () => {
    const value = addonInput.trim();
    if (!value) return;
    updateDraft({ addons: Array.from(new Set([...(draft?.addons || []), value])) });
    setAddonInput("");
  };

  const removeAddonModule = (module: string) => {
    updateDraft({ addons: (draft?.addons || []).filter((entry) => entry !== module) });
  };

  const saveConfig = async () => {
    if (!plugin || !draft) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const config: Partial<ComposeVCPluginConfig> =
        plugin.id === "motion"
          ? {
              ffmpegPath: draft.ffmpegPath.trim(),
              outputDir: draft.outputDir.trim(),
              width: Number(draft.width) || 1920,
              height: Number(draft.height) || 1080,
              fps: Number(draft.fps) || 30,
              crf: Number(draft.crf),
              preset: draft.preset || "medium",
              format: draft.format || "mp4",
              theme: draft.theme || "clean",
              fontFamily: draft.fontFamily.trim() || "Inter",
              safeMargins: draft.safeMargins !== false,
              audioBitrateKbps: Number(draft.audioBitrateKbps) || 192,
              timeoutSec: Number(draft.timeoutSec) || 3600,
            }
          : plugin.id === "godot"
          ? {
              executable: draft.executable.trim(),
              projectDir: draft.projectDir.trim(),
              outputDir: draft.outputDir.trim(),
              preset: draft.preset,
              exportPath: draft.exportPath.trim(),
              headless: draft.headless !== false,
              importGlb: draft.importGlb !== false,
              glbDir: draft.glbDir.trim(),
              timeoutSec: Number(draft.timeoutSec) || 1800,
            }
          : {
              executable: draft.executable.trim(),
              outputDir: draft.outputDir.trim(),
              engine: draft.engine,
              resolution: { width: Number(draft.width) || 1600, height: Number(draft.height) || 1000 },
              samples: Number(draft.samples) || 64,
              format: draft.format,
              autoRender: draft.autoRender,
              timeoutSec: Number(draft.timeoutSec) || 900,
              addons: draft.addons,
            };
      const result = await window.lopster?.pluginsUpdate?.(plugin.id, { config });
      if (!result?.ok || !result.plugin) {
        setError(result?.error || "Не удалось сохранить настройки.");
        return;
      }
      setState((prev) =>
        prev ? { ...prev, plugins: prev.plugins.map((entry) => (entry.id === plugin.id ? (result.plugin as ComposeVCPlugin) : entry)) } : prev
      );
      setDirty(false);
      setNotice("Настройки сохранены.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async () => {
    if (!plugin) return;
    setError(null);
    try {
      const result = await window.lopster?.pluginsUpdate?.(plugin.id, { enabled: !plugin.enabled });
      if (!result?.ok) setError(result?.error || "Не удалось переключить плагин.");
      else {
        await refreshPlugins();
        setNotice(result.plugin?.enabled ? "Плагин включён." : "Плагин выключен.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const pickExecutable = async () => {
    const result = await window.lopster?.pluginsPickExecutable?.(plugin?.id);
    if (!result?.ok || !result.path) return;
    const patch: Partial<ComposeVCPluginConfig> =
      plugin?.id === "motion" ? { ffmpegPath: result.path } : { executable: result.path };
    updateDraft(plugin?.id === "motion" ? { ffmpegPath: result.path } : { executable: result.path });
    if (plugin && draft) {
      setSaving(true);
      try {
        const saved = await window.lopster?.pluginsUpdate?.(plugin.id, { config: patch });
        if (saved?.ok) {
          setNotice(`${plugin?.name || "Плагин"} найден и сохранён.`);
          await refreshPlugins();
          setDraft((prev) =>
            prev
              ? plugin.id === "motion"
                ? { ...prev, ffmpegPath: result.path as string }
                : { ...prev, executable: result.path as string }
              : prev
          );
          setDirty(false);
        } else {
          setError(saved?.error || "Не удалось сохранить путь.");
        }
      } finally {
        setSaving(false);
      }
    }
  };

  const pickOutputDir = async () => {
    const result = await window.lopster?.pluginsPickDirectory?.();
    if (result?.ok && result.path) updateDraft({ outputDir: result.path });
  };

  const probe = async () => {
    if (!plugin) return;
    setProbing(true);
    setError(null);
    setNotice(null);
    try {
      const result = await window.lopster?.pluginsProbe?.(plugin.id);
      if (result?.probe) {
        setState((prev) =>
          prev
            ? {
                ...prev,
                plugins: prev.plugins.map((entry) =>
                  entry.id === plugin.id ? { ...entry, status: { ...entry.status, probe: result.probe } } : entry
                ),
              }
            : prev
        );
      }
      if (!result?.ok) {
        setError(result?.probe?.error || result?.error || "Не удалось опросить плагин.");
        return;
      }
      if (plugin.id === "motion") {
        const filters = result.probe?.filters?.join(", ") || "—";
        setNotice(
          `FFmpeg ${result.probe?.version || "?"} · фильтры: ${filters}${result.probe?.warning ? ` · ${result.probe.warning}` : ""}`
        );
        return;
      }
      const engines = result.probe?.engines?.join(", ") || "—";
      setNotice(`Возможности: ${engines}${result.probe?.warning ? ` · ${result.probe.warning}` : ""}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setProbing(false);
    }
  };

  const runDemo = async () => {
    if (!plugin) return;
    setDemoBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await window.lopster?.pluginsRunDemo?.(plugin.id);
      if (!result?.ok) {
        setError(result?.error || "Демо-задача не выполнилась.");
        return;
      }
      setNotice(`Демо готово: ${result.job?.summary || "сцена собрана"}`);
      await refreshPlugins();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDemoBusy(false);
    }
  };

  const pickProjectDir = async () => {
    const result = await window.lopster?.pluginsPickDirectory?.();
    if (result?.ok && result.path) updateDraft({ projectDir: result.path });
  };

  const godotBuild = async () => {
    if (!plugin || !draft) return;
    setGodotAction("build");
    setError(null);
    setNotice(null);
    try {
      const result = await window.lopster?.pluginsGodotBuild?.(plugin.id, {
        preset: draft.preset,
        exportPath: draft.exportPath.trim(),
        timeoutSec: Number(draft.timeoutSec) || 1800,
      });
      if (!result?.ok) {
        setError([result?.error || "Сборка не удалась.", result?.hint].filter(Boolean).join(" "));
        return;
      }
      setNotice(`Сборка готова: ${result.exportPath || result.preset || "ok"}`);
      await refreshPlugins();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGodotAction(null);
    }
  };

  const godotImportGlb = async () => {
    if (!draft) return;
    setGodotAction("import");
    setError(null);
    setNotice(null);
    try {
      const result = await window.lopster?.pluginsGodotImportGlb?.({
        files: draft.glbDir.trim() || undefined,
      });
      if (!result?.ok) {
        setError(result?.error || "Импорт GLB не удался.");
        return;
      }
      setNotice(`Импортировано GLB: ${result.imported?.length ?? 0}`);
      await refreshPlugins();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGodotAction(null);
    }
  };

  const godotDemo = async () => {
    if (!draft) return;
    setGodotAction("demo");
    setError(null);
    setNotice(null);
    try {
      const result = await window.lopster?.pluginsGodotDemo?.({ preset: draft.preset });
      if (!result?.ok) {
        setError([result?.error || "Демо Godot не выполнилось.", result?.hint].filter(Boolean).join(" "));
        return;
      }
      setNotice(`Демо готово: ${result.job?.summary || "проект собран"}`);
      await refreshPlugins();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setGodotAction(null);
    }
  };

  const installMotion = async () => {
    if (!plugin) return;
    setInstallBusy(true);
    setError(null);
    setNotice(null);
    setMotionProgress({ stage: "detect", percent: 0, done: false });
    try {
      const result = await window.lopster?.pluginsMotionInstall?.();
      if (!result?.ok) {
        setError(result?.error || "Не удалось установить FFmpeg.");
        return;
      }
      setNotice(`FFmpeg ${result.version || "найден"} · ${result.executable || ""}`);
      if (result.executable) {
        setDraft((prev) => (prev ? { ...prev, ffmpegPath: result.executable || prev.ffmpegPath } : prev));
      }
      await refreshPlugins();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstallBusy(false);
    }
  };

  const updateTimelineItem = (id: string, patch: Partial<ComposeVCMotionTimelineItem>) => {
    setMotionPlan((prev) =>
      prev
        ? { ...prev, timeline: prev.timeline.map((item) => (item.id === id ? { ...item, ...patch } : item)) }
        : prev
    );
  };

  const addTimelineItem = (kind: ComposeVCMotionTimelineItem["kind"]) => {
    setMotionPlan((prev) => {
      if (!prev) return prev;
      const last = prev.timeline.reduce((max, item) => Math.max(max, Number(item.end) || 0), 0);
      const id = `item-${Date.now().toString(36)}`;
      const base: ComposeVCMotionTimelineItem = {
        id,
        kind,
        start: kind === "transition" ? Math.max(0, last - 0.6) : last,
        end: kind === "transition" ? last : last + 3,
        text: kind === "title" ? "Новый титр" : "",
        animation: "fade",
        transition: "fade",
        path: "",
        volume: 1,
      };
      return { ...prev, timeline: [...prev.timeline, base] };
    });
  };

  const removeTimelineItem = (id: string) => {
    setMotionPlan((prev) => (prev ? { ...prev, timeline: prev.timeline.filter((item) => item.id !== id) } : prev));
  };

  const probeMedia = async () => {
    const target = motionMediaPath.trim();
    if (!target) return;
    setMotionMediaBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await window.lopster?.pluginsMotionProbeFile?.(target);
      if (!result?.ok || !result.media) {
        setMotionMedia(null);
        setError(result?.error || "Не удалось прочитать файл.");
        return;
      }
      setMotionMedia(result.media);
      setNotice("Метаданные прочитаны.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMotionMediaBusy(false);
    }
  };

  const probeAudioFile = async () => {
    const target = motionAudioPath.trim();
    if (!target) return;
    setMotionMediaBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await window.lopster?.pluginsMotionProbeFile?.(target);
      if (!result?.ok || !result.media) {
        setError(result?.error || "Не удалось прочитать файл.");
        return;
      }
      setMotionMedia(result.media);
      setNotice(`Аудио: ${result.media.audioCodec || "дорожка"} · ${result.media.durationSec} с`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMotionMediaBusy(false);
    }
  };

  const applyAudioTrack = () => {
    const target = motionAudioPath.trim();
    setMotionPlan((prev) => (prev ? { ...prev, audio: { ...prev.audio, path: target } } : prev));
    setNotice(target ? "Аудиодорожка добавлена в ролик." : "Аудиодорожка убрана.");
  };

  const renderMotion = async () => {
    if (!plugin || !motionPlan) return;
    setMotionBusy(true);
    setError(null);
    setNotice(null);
    setMotionPreview(null);
    setMotionProgress({ stage: "prepare", percent: 0, done: false });
    try {
      const plan: ComposeVCMotionPlan = {
        ...motionPlan,
        output: {
          width: Number(draft?.width) || motionPlan.output.width,
          height: Number(draft?.height) || motionPlan.output.height,
          fps: Number(draft?.fps) || motionPlan.output.fps,
          crf: Number.isFinite(Number(draft?.crf)) ? Number(draft?.crf) : motionPlan.output.crf,
          preset: draft?.preset || motionPlan.output.preset,
          format: draft?.format || motionPlan.output.format,
        },
        audio: { ...motionPlan.audio, path: motionPlan.audio.path || motionAudioPath.trim() },
      };
      const result = await window.lopster?.pluginsMotionRender?.(plan);
      if (!result?.ok) {
        setError(result?.error || result?.job?.error || "Ролик не собрался.");
        await refreshPlugins();
        return;
      }
      const exported = result.job?.exports?.[0]?.path || "";
      setNotice(`Ролик готов: ${exported || result.job?.summary || "ok"}`);
      await refreshPlugins();
      if (result.job?.id) {
        try {
          const preview = await window.lopster?.pluginsPreview?.(result.job.id);
          if (preview?.ok && preview.dataUrl) setMotionPreview(preview.dataUrl);
        } catch {
          /* preview is optional */
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMotionBusy(false);
    }
  };

  const openFolder = async () => {
    try {
      const result = await window.lopster?.pluginsOpenPath?.("", state?.jobsRoot || "");
      if (!result?.ok) setError(result?.error || "Не удалось открыть папку.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const probeInfo = plugin?.status?.probe;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-ink-0 text-ink-800">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-ink-200 px-3">
        <Box className="h-3.5 w-3.5 shrink-0 text-ink-600" />
        <span className="shrink-0 text-[10px] font-medium uppercase tracking-[0.1em] text-ink-500">Плагины</span>
        <span className="tabular-nums text-[10px] text-ink-500">{state?.plugins.length ?? 0}</span>
        <div className="ml-auto flex min-w-0 items-center gap-1.5">
          <span className="hidden truncate font-mono text-[10px] text-ink-500 md:inline">
            {(state?.plugins || []).flatMap((entry) => entry.tools).join(" · ") || "blender"} · plugin
          </span>
          <button type="button" className={quietBtn} onClick={() => void openFolder()} title="Папка задач">
            <FolderOpen className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className={quietBtn}
            onClick={() => {
              void refreshPlugins();
            }}
            title="Обновить"
          >
            <RefreshCw className="h-3.5 w-3.5" />
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <aside
          className="flex w-[236px] shrink-0 flex-col border-r border-ink-200"
          style={{ background: "color-mix(in srgb, var(--panel-bg) 55%, var(--bg))" }}
        >
          <div className="flex shrink-0 items-center justify-between px-3 py-2">
            <span className="text-[10px] font-medium uppercase tracking-[0.1em] text-ink-500">Установленные</span>
            <span className="font-mono text-[10px] text-ink-400">{state?.plugins.length ?? 0} шт.</span>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-2 scrollbar-thin">
            {loading && !state ? (
              <div className="flex items-center gap-2 px-2 py-2 text-[11px] text-ink-500">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Загрузка…
              </div>
            ) : (
              (state?.plugins || []).map((entry) => {
                const active = plugin?.id === entry.id;
                const found = entry.status?.found;
                return (
                  <button
                    key={entry.id}
                    type="button"
                    onClick={() => setActiveId(entry.id)}
                    className={`ide-library-row group flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors ${active ? "is-active" : ""}`}
                    title={entry.tagline}
                  >
                    <span
                      className="h-1.5 w-1.5 shrink-0 rounded-full"
                      style={{ background: found ? "var(--accent)" : "var(--ink-400)" }}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[12px] font-medium text-ink-950">{entry.name}</span>
                      <span className="block truncate font-mono text-[10px] text-ink-500">
                        {found ? entry.status.version || "найден" : "не найден"} · {entry.stats?.runs || 0} запусков
                      </span>
                    </span>
                    <ChevronRight className="h-3.5 w-3.5 shrink-0 text-ink-400" />
                  </button>
                );
              })
            )}
          </div>
          <div className="shrink-0 border-t border-ink-200 px-3 py-2 text-[10px] leading-4 text-ink-500">
            Плагин — это возможность приложения со своим инструментом ИИ. Blender уже встроен: сцены, PBR-текстуры, рендер
            и экспорт для игр.
          </div>
        </aside>

        <section className="flex min-h-0 min-w-0 flex-1 flex-col">
          {!plugin ? (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-[12px] text-ink-500">
              {loading ? "Загрузка плагинов…" : "Плагины не найдены."}
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3 scrollbar-thin">
              <div className="mb-3 flex flex-wrap items-start gap-3 border border-ink-200 bg-ink-0 px-3 py-3">
                <div
                  className="flex h-10 w-10 shrink-0 items-center justify-center border border-ink-200"
                  style={{ color: plugin.accent || "var(--accent)" }}
                >
                  {plugin.id === "godot" ? (
                    <IcoGodot className="h-5 w-5" />
                  ) : plugin.id === "motion" ? (
                    <IcoMotion className="h-5 w-5" />
                  ) : (
                    <Box className="h-5 w-5" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[14px] font-semibold text-ink-950">{plugin.name}</span>
                    <span className="border border-ink-200 px-1.5 py-0.5 font-mono text-[10px] text-ink-500">
                      {plugin.version}
                    </span>
                    <span
                      className="border px-1.5 py-0.5 font-mono text-[10px]"
                      style={{
                        borderColor: plugin.status?.found ? "var(--border-strong)" : "var(--border)",
                        color: plugin.status?.found ? "var(--ink-800)" : "var(--ink-500)",
                      }}
                    >
                      {plugin.status?.found ? "готов" : `нужен ${plugin.name}`}
                    </span>
                    <span className="font-mono text-[10px] text-ink-500">
                      инструмент: {plugin.tools.map((tool) => `\`${tool}\``).join(", ")}
                    </span>
                  </div>
                  <div className="mt-1 text-[11px] leading-4 text-ink-600">{plugin.tagline}</div>
                  {plugin.description && (
                    <div className="mt-1 text-[10px] leading-4 text-ink-500">{plugin.description}</div>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-1.5">
                  <button type="button" className={quietBtn} onClick={() => void toggleEnabled()}>
                    {plugin.enabled ? "Включён" : "Выключен"}
                  </button>
                  <button
                    type="button"
                    className={primaryBtn}
                    onClick={() => void (plugin.id === "godot" ? godotDemo() : runDemo())}
                    disabled={plugin.id === "godot" ? godotAction !== null : demoBusy}
                  >
                    {(plugin.id === "godot" ? godotAction === "demo" : demoBusy) ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Wand2 className="h-3.5 w-3.5" />
                    )}
                    {plugin.id === "motion" ? "Демо-ролик" : "Демо-сцена"}
                  </button>
                </div>
              </div>

              {error && (
                <div className="mb-3 flex items-start gap-2 border border-ink-200 px-3 py-2 text-[11px] text-status-err">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 whitespace-pre-wrap break-words">{error}</span>
                </div>
              )}
              {notice && !error && (
                <div className="mb-3 border border-ink-200 px-3 py-2 text-[11px] text-ink-600">{notice}</div>
              )}

              {plugin.id !== "motion" && (
              <Section title={plugin.id === "godot" ? "Godot и статус" : "Blender и статус"}>
                <div className="grid gap-3 lg:grid-cols-2">
                  <div className="min-w-0 border border-ink-200 bg-ink-0 p-3">
                    <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.1em] text-ink-500">
                      состояние
                    </div>
                    <div className="flex flex-wrap items-center gap-2 text-[11px]">
                      <span
                        className="h-1.5 w-1.5 rounded-full"
                        style={{ background: plugin.status?.found ? "var(--accent)" : "var(--ink-400)" }}
                      />
                      <span className="text-ink-800">
                        {plugin.status?.found
                          ? `${plugin.name} ${plugin.status.version || "?"} · ${
                              plugin.status.source === "config" ? "путь из настроек" : "автоопределение"
                            }`
                          : plugin.status?.error || `${plugin.name} не найден`}
                      </span>
                      {(plugin.stats?.runs || 0) > 0 && (
                        <span className="ml-auto font-mono text-[10px] text-ink-500">
                          запусков {plugin.stats.runs} · ошибок {plugin.stats.failures}
                        </span>
                      )}
                    </div>
                    {plugin.status?.found && (
                      <div className="mt-1 truncate font-mono text-[10px] text-ink-500">{plugin.status.executable}</div>
                    )}
                    {plugin.status?.note && (
                      <div className="mt-1 text-[10px] leading-4 text-ink-500">{plugin.status.note}</div>
                    )}
                    {(plugin.status?.checked || []).length > 0 && !plugin.status.found && (
                      <div className="mt-2 border-t border-ink-200 pt-1.5 font-mono text-[10px] leading-4 text-ink-500">
                        {(plugin.status?.checked || []).slice(0, 5).map((entry) => (
                          <div key={entry.path} className="truncate" title={entry.path}>
                            {entry.ok ? "1" : "0"} {entry.path}
                          </div>
                        ))}
                      </div>
                    )}
                    {probeInfo && (
                      <div className="mt-2 grid gap-1 border-t border-ink-200 pt-2 text-[10px] leading-4 text-ink-600">
                        <div>
                          <span className="text-ink-500">движки: </span>
                          {(probeInfo.engines || []).join(", ") || "—"}
                        </div>
                        <div className="break-words">
                          <span className="text-ink-500">экспортёры: </span>
                          {Object.entries(probeInfo.operators || {})
                            .filter(([, value]) => value)
                            .map(([key]) => key.replace("export_scene.", "").replace("wm.", ""))
                            .join(", ") || "—"}
                        </div>
                        {probeInfo.error && <div className="text-status-err">{probeInfo.error}</div>}
                      </div>
                    )}
                  </div>

                  <div className="min-w-0 border border-ink-200 bg-ink-0 p-3">
                    <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.1em] text-ink-500">
                      путь и проверка
                    </div>
                    <label className="grid min-w-0 gap-1">
                      <span className={labelClass}>Путь к {plugin.name}</span>
                      <div className="flex min-w-0 items-center gap-1.5">
                        <input
                          type="text"
                          value={draft?.executable ?? ""}
                          onChange={(event) => updateDraft({ executable: event.target.value })}
                          placeholder={
                            plugin.id === "godot"
                              ? "Автоопределение (PATH, Program Files, LOCALAPPDATA)"
                              : "Автоопределение (Program Files, PATH, Steam…)"
                          }
                          className={fieldClass}
                          style={fieldStyle}
                          spellCheck={false}
                        />
                        <button type="button" className={quietBtn} onClick={() => void pickExecutable()}>
                          Обзор…
                        </button>
                      </div>
                    </label>
                    <div className="mt-3 flex flex-wrap items-center gap-1.5">
                      <button type="button" className={primaryBtn} onClick={() => void probe()} disabled={probing}>
                        {probing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                        Проверить
                      </button>
                      <button type="button" className={quietBtn} onClick={() => void openFolder()}>
                        <FolderOpen className="h-3.5 w-3.5" />
                        Папка задач
                      </button>
                    </div>
                    <div className="mt-2 text-[10px] leading-4 text-ink-500">
                      {plugin.id === "godot"
                        ? "Пустое поле — автоопределение: PATH, LOCALAPPDATA, Program Files, scoop/choco, snap/flatpak, Applications."
                        : "Пустое поле — автоопределение: Program Files, PATH, Steam, snap/flatpak, macOS Applications."}
                    </div>
                  </div>
                </div>
              </Section>
              )}

              {plugin.id === "motion" && (
                <>
                  <Section
                    title="Motion Studio"
                    actions={
                      <button type="button" className={primaryBtn} onClick={() => void saveConfig()} disabled={!dirty || saving}>
                        {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                        Сохранить
                      </button>
                    }
                  >
                    <div className="grid gap-3 lg:grid-cols-2">
                      <div className="min-w-0 border border-ink-200 bg-ink-0 p-3">
                        <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.1em] text-ink-500">движок</div>
                        <div className="flex flex-wrap items-center gap-2 text-[11px]">
                          <span
                            className="h-1.5 w-1.5 rounded-full"
                            style={{ background: plugin.status?.found ? "var(--accent)" : "var(--ink-400)" }}
                          />
                          <span className="text-ink-800">
                            {plugin.status?.found
                              ? `FFmpeg ${plugin.status.version || "?"} · ${
                                  plugin.status.source === "config" ? "путь из настроек" : "автоопределение"
                                }`
                              : plugin.status?.error || "FFmpeg не найден"}
                          </span>
                          {(plugin.stats?.runs || 0) > 0 && (
                            <span className="ml-auto font-mono text-[10px] text-ink-500">
                              запусков {plugin.stats.runs} · ошибок {plugin.stats.failures}
                            </span>
                          )}
                        </div>
                        {plugin.status?.found && (
                          <div className="mt-1 truncate font-mono text-[10px] text-ink-500">{plugin.status.executable}</div>
                        )}
                        <label className="mt-2 grid min-w-0 gap-1">
                          <span className={labelClass}>Путь к FFmpeg</span>
                          <input
                            type="text"
                            value={draft?.ffmpegPath ?? ""}
                            onChange={(event) => updateDraft({ ffmpegPath: event.target.value })}
                            placeholder="Автоопределение (PATH, LOCALAPPDATA, userData/plugins/motion/bin)"
                            className={fieldClass}
                            style={fieldStyle}
                            spellCheck={false}
                          />
                        </label>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <button type="button" className={quietBtn} onClick={() => void probe()} disabled={probing}>
                            {probing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                            Обнаружить
                          </button>
                          <button
                            type="button"
                            className={primaryBtn}
                            onClick={() => void installMotion()}
                            disabled={installBusy || !plugin.enabled}
                          >
                            {installBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                            Установить FFmpeg
                          </button>
                          <button type="button" className={quietBtn} onClick={() => void pickExecutable()}>
                            Указать путь
                          </button>
                          <button type="button" className={quietBtn} onClick={() => void openFolder()}>
                            <FolderOpen className="h-3.5 w-3.5" />
                            Папка задач
                          </button>
                        </div>
                        {motionProgress && (
                          <div className="mt-2 flex items-center gap-2">
                            <span className="w-24 shrink-0 truncate font-mono text-[10px] text-ink-500">
                              {motionProgress.stage || "job"}
                            </span>
                            <span className="h-1 min-w-0 flex-1 bg-ink-200">
                              <span
                                className="block h-1"
                                style={{ width: `${Math.max(0, Math.min(100, motionProgress.percent))}%`, background: "var(--accent)" }}
                              />
                            </span>
                            <span className="w-8 shrink-0 text-right font-mono text-[10px] tabular-nums text-ink-500">
                              {Math.max(0, Math.min(100, motionProgress.percent))}%
                            </span>
                          </div>
                        )}
                        <div className="mt-2 border-t border-ink-200 pt-1.5 font-mono text-[10px] leading-4 text-ink-500">
                          ffprobe: {plugin.status?.ffprobe?.found ? plugin.status.ffprobe?.version || "найден" : "не найден"}
                        </div>
                      </div>

                      <div className="min-w-0 border border-ink-200 bg-ink-0 p-3">
                        <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.1em] text-ink-500">вывод</div>
                        <div className="grid gap-2 sm:grid-cols-2">
                          <label className="grid min-w-0 gap-1">
                            <span className={labelClass}>Ширина</span>
                            <input
                              type="number"
                              min={240}
                              max={7680}
                              value={draft?.width ?? 1920}
                              onChange={(event) => updateDraft({ width: Number(event.target.value) })}
                              className={fieldClass}
                              style={fieldStyle}
                            />
                          </label>
                          <label className="grid min-w-0 gap-1">
                            <span className={labelClass}>Высота</span>
                            <input
                              type="number"
                              min={240}
                              max={7680}
                              value={draft?.height ?? 1080}
                              onChange={(event) => updateDraft({ height: Number(event.target.value) })}
                              className={fieldClass}
                              style={fieldStyle}
                            />
                          </label>
                          <label className="grid min-w-0 gap-1">
                            <span className={labelClass}>FPS</span>
                            <input
                              type="number"
                              min={12}
                              max={120}
                              value={draft?.fps ?? 30}
                              onChange={(event) => updateDraft({ fps: Number(event.target.value) })}
                              className={fieldClass}
                              style={fieldStyle}
                            />
                          </label>
                          <label className="grid min-w-0 gap-1">
                            <span className={labelClass}>CRF</span>
                            <input
                              type="number"
                              min={0}
                              max={51}
                              value={draft?.crf ?? 20}
                              onChange={(event) => updateDraft({ crf: Number(event.target.value) })}
                              className={fieldClass}
                              style={fieldStyle}
                            />
                          </label>
                          <label className="grid min-w-0 gap-1">
                            <span className={labelClass}>Пресет</span>
                            <select
                              value={draft?.preset || "medium"}
                              onChange={(event) => updateDraft({ preset: event.target.value })}
                              className={fieldClass}
                            >
                              {MOTION_PRESETS.map((preset) => (
                                <option key={preset} value={preset}>
                                  {preset}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="grid min-w-0 gap-1">
                            <span className={labelClass}>Формат</span>
                            <select
                              value={draft?.format || "mp4"}
                              onChange={(event) => updateDraft({ format: event.target.value })}
                              className={fieldClass}
                            >
                              {MOTION_FORMATS.map((format) => (
                                <option key={format} value={format}>
                                  {format}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="grid min-w-0 gap-1">
                            <span className={labelClass}>Шрифт</span>
                            <input
                              type="text"
                              value={draft?.fontFamily ?? "Inter"}
                              onChange={(event) => updateDraft({ fontFamily: event.target.value })}
                              className={fieldClass}
                              style={fieldStyle}
                              spellCheck={false}
                            />
                          </label>
                          <label className="grid min-w-0 gap-1">
                            <span className={labelClass}>Тема</span>
                            <select
                              value={draft?.theme || "clean"}
                              onChange={(event) => updateDraft({ theme: event.target.value })}
                              className={fieldClass}
                            >
                              {["clean", "dark", "light", "bold"].map((theme) => (
                                <option key={theme} value={theme}>
                                  {theme}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="grid min-w-0 gap-1">
                            <span className={labelClass}>Аудио, кбит/с</span>
                            <input
                              type="number"
                              min={32}
                              max={512}
                              value={draft?.audioBitrateKbps ?? 192}
                              onChange={(event) => updateDraft({ audioBitrateKbps: Number(event.target.value) })}
                              className={fieldClass}
                              style={fieldStyle}
                            />
                          </label>
                          <label className="grid min-w-0 gap-1">
                            <span className={labelClass}>Таймаут, с</span>
                            <input
                              type="number"
                              min={10}
                              max={7200}
                              value={draft?.timeoutSec ?? 3600}
                              onChange={(event) => updateDraft({ timeoutSec: Number(event.target.value) })}
                              className={fieldClass}
                              style={fieldStyle}
                            />
                          </label>
                        </div>
                        <label className="mt-2 flex items-center gap-2 text-[11px] text-ink-700">
                          <input
                            type="checkbox"
                            checked={draft?.safeMargins !== false}
                            onChange={(event) => updateDraft({ safeMargins: event.target.checked })}
                          />
                          Safe margins
                        </label>
                        <div className="mt-2 flex min-w-0 items-center gap-1.5">
                          <input
                            type="text"
                            value={draft?.outputDir ?? ""}
                            onChange={(event) => updateDraft({ outputDir: event.target.value })}
                            placeholder="По умолчанию: userData/plugins/output"
                            className={fieldClass}
                            style={fieldStyle}
                            spellCheck={false}
                          />
                          <button type="button" className={quietBtn} onClick={() => void pickOutputDir()}>
                            Обзор…
                          </button>
                        </div>
                      </div>
                    </div>
                  </Section>

                  <Section
                    title="Таймлайн"
                    actions={
                      <div className="flex items-center gap-1">
                        {MOTION_KINDS.map((kind) => (
                          <button
                            key={kind}
                            type="button"
                            className={quietBtn}
                            onClick={() => addTimelineItem(kind)}
                            title={`Добавить: ${kind}`}
                          >
                            <Plus className="h-3.5 w-3.5" />
                            {kind}
                          </button>
                        ))}
                      </div>
                    }
                  >
                    {motionPlan?.timeline.length ? (
                      <div className="min-w-0 overflow-x-auto">
                        <table className="w-full min-w-[720px] border-collapse text-[11px]">
                          <thead>
                            <tr className="text-left text-[10px] font-medium uppercase tracking-[0.1em] text-ink-500">
                              <th className="border-b border-ink-200 py-1 pr-2">тип</th>
                              <th className="w-[72px] border-b border-ink-200 py-1 pr-2">старт</th>
                              <th className="w-[72px] border-b border-ink-200 py-1 pr-2">конец</th>
                              <th className="border-b border-ink-200 py-1 pr-2">содержимое</th>
                              <th className="w-[128px] border-b border-ink-200 py-1 pr-2">эффект</th>
                              <th className="w-[32px] border-b border-ink-200 py-1" />
                            </tr>
                          </thead>
                          <tbody>
                            {motionPlan.timeline.map((item) => (
                              <tr key={item.id} className="align-top">
                                <td className="border-b border-ink-200 py-1 pr-2">
                                  <select
                                    value={item.kind}
                                    onChange={(event) =>
                                      updateTimelineItem(item.id, {
                                        kind: event.target.value as ComposeVCMotionTimelineItem["kind"],
                                      })
                                    }
                                    className={fieldClass}
                                  >
                                    {MOTION_KINDS.map((kind) => (
                                      <option key={kind} value={kind}>
                                        {kind}
                                      </option>
                                    ))}
                                  </select>
                                </td>
                                <td className="border-b border-ink-200 py-1 pr-2">
                                  <input
                                    type="number"
                                    step={0.1}
                                    min={0}
                                    value={item.start}
                                    onChange={(event) => updateTimelineItem(item.id, { start: Number(event.target.value) })}
                                    className={fieldClass}
                                    style={fieldStyle}
                                  />
                                </td>
                                <td className="border-b border-ink-200 py-1 pr-2">
                                  <input
                                    type="number"
                                    step={0.1}
                                    min={0}
                                    value={item.end}
                                    onChange={(event) => updateTimelineItem(item.id, { end: Number(event.target.value) })}
                                    className={fieldClass}
                                    style={fieldStyle}
                                  />
                                </td>
                                <td className="border-b border-ink-200 py-1 pr-2">
                                  {item.kind === "title" ? (
                                    <input
                                      type="text"
                                      value={item.text || ""}
                                      onChange={(event) => updateTimelineItem(item.id, { text: event.target.value })}
                                      placeholder="Текст титра"
                                      className={fieldClass}
                                      style={fieldStyle}
                                    />
                                  ) : item.kind === "scene" ? (
                                    <input
                                      type="text"
                                      value={item.path || ""}
                                      onChange={(event) => updateTimelineItem(item.id, { path: event.target.value })}
                                      placeholder="Путь к видео или изображению"
                                      className={fieldClass}
                                      style={fieldStyle}
                                      spellCheck={false}
                                    />
                                  ) : item.kind === "audio" ? (
                                    <div className="flex min-w-0 items-center gap-1.5">
                                      <input
                                        type="text"
                                        value={item.path || ""}
                                        onChange={(event) => updateTimelineItem(item.id, { path: event.target.value })}
                                        placeholder="Путь к аудиофайлу"
                                        className={fieldClass}
                                        style={fieldStyle}
                                        spellCheck={false}
                                      />
                                      <input
                                        type="number"
                                        min={0}
                                        max={2}
                                        step={0.1}
                                        value={item.volume ?? 1}
                                        onChange={(event) => updateTimelineItem(item.id, { volume: Number(event.target.value) })}
                                        className={`${fieldClass} w-16 shrink-0`}
                                        style={fieldStyle}
                                        title="Громкость"
                                      />
                                    </div>
                                  ) : (
                                    <span className="font-mono text-[10px] text-ink-500">
                                      переход между соседними сценами
                                    </span>
                                  )}
                                </td>
                                <td className="border-b border-ink-200 py-1 pr-2">
                                  {item.kind === "title" ? (
                                    <select
                                      value={item.animation || "fade"}
                                      onChange={(event) => updateTimelineItem(item.id, { animation: event.target.value as ComposeVCMotionTimelineItem["animation"] })}
                                      className={fieldClass}
                                    >
                                      {MOTION_ANIMATIONS.map((animation) => (
                                        <option key={animation} value={animation}>
                                          {animation}
                                        </option>
                                      ))}
                                    </select>
                                  ) : item.kind === "transition" ? (
                                    <select
                                      value={item.transition || "fade"}
                                      onChange={(event) => updateTimelineItem(item.id, { transition: event.target.value as ComposeVCMotionTimelineItem["transition"] })}
                                      className={fieldClass}
                                    >
                                      {MOTION_TRANSITIONS.map((transition) => (
                                        <option key={transition} value={transition}>
                                          {transition}
                                        </option>
                                      ))}
                                    </select>
                                  ) : (
                                    <span className="font-mono text-[10px] text-ink-400">—</span>
                                  )}
                                </td>
                                <td className="border-b border-ink-200 py-1 text-right">
                                  <button
                                    type="button"
                                    className="inline-flex h-7 w-6 items-center justify-center text-ink-500 transition-colors hover:text-ink-900"
                                    onClick={() => removeTimelineItem(item.id)}
                                    title="Удалить строку"
                                  >
                                    <Trash2 className="h-3.5 w-3.5" />
                                  </button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : (
                      <div className="text-[10px] leading-4 text-ink-500">Таймлайн пуст — добавьте титр.</div>
                    )}
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 border-t border-ink-200 pt-2">
                      <button
                        type="button"
                        className={primaryBtn}
                        onClick={() => void renderMotion()}
                        disabled={!plugin.status?.found || motionBusy || !motionPlan?.timeline.length}
                        title={plugin.status?.found ? "Собрать ролик" : plugin.status?.error || "FFmpeg не найден"}
                      >
                        {motionBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Clapperboard className="h-3.5 w-3.5" />}
                        Собрать ролик
                      </button>
                      {motionProgress && (
                        <span className="ml-auto font-mono text-[10px] text-ink-500">
                          {motionProgress.stage || "job"} · {Math.max(0, Math.min(100, motionProgress.percent))}%
                        </span>
                      )}
                      {plugin.lastJob && (
                        <span className="truncate font-mono text-[10px] text-ink-500" title={plugin.lastJob.summary}>
                          {plugin.lastJob.status} · {plugin.lastJob.summary || plugin.lastJob.stage}
                        </span>
                      )}
                    </div>
                    {motionPreview && (
                      <img
                        src={motionPreview}
                        alt="Кадр ролика"
                        className="mt-2 max-h-44 border border-ink-200 object-contain"
                      />
                    )}
                  </Section>

                  <Section title="Медиа">
                    <div className="grid gap-3 lg:grid-cols-2">
                      <div className="min-w-0 border border-ink-200 bg-ink-0 p-3">
                        <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.1em] text-ink-500">
                          файл и метаданные
                        </div>
                        <div className="flex min-w-0 items-center gap-1.5">
                          <input
                            type="text"
                            value={motionMediaPath}
                            onChange={(event) => setMotionMediaPath(event.target.value)}
                            placeholder="Путь к видео, изображению или аудио"
                            className={fieldClass}
                            style={fieldStyle}
                            spellCheck={false}
                          />
                          <button
                            type="button"
                            className={quietBtn}
                            onClick={() => void probeMedia()}
                            disabled={motionMediaBusy || !motionMediaPath.trim()}
                          >
                            {motionMediaBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                            Прочитать
                          </button>
                        </div>
                        {motionMedia && (
                          <dl className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 border-t border-ink-200 pt-2 text-[10px] leading-4 text-ink-600">
                            <div className="flex justify-between gap-2">
                              <dt className="text-ink-500">длительность</dt>
                              <dd className="tabular-nums">{motionMedia.durationSec} с</dd>
                            </div>
                            <div className="flex justify-between gap-2">
                              <dt className="text-ink-500">разрешение</dt>
                              <dd className="tabular-nums">
                                {motionMedia.width || 0}×{motionMedia.height || 0}
                              </dd>
                            </div>
                            <div className="flex justify-between gap-2">
                              <dt className="text-ink-500">fps</dt>
                              <dd className="tabular-nums">{motionMedia.fps || "—"}</dd>
                            </div>
                            <div className="flex justify-between gap-2">
                              <dt className="text-ink-500">битрейт</dt>
                              <dd className="tabular-nums">{motionMedia.bitrateKbps || 0} кбит/с</dd>
                            </div>
                            <div className="flex justify-between gap-2">
                              <dt className="text-ink-500">видео</dt>
                              <dd className="truncate">{motionMedia.videoCodec || "—"}</dd>
                            </div>
                            <div className="flex justify-between gap-2">
                              <dt className="text-ink-500">аудио</dt>
                              <dd className="truncate">{motionMedia.audioCodec || (motionMedia.hasAudio ? "есть" : "нет")}</dd>
                            </div>
                            <div className="col-span-2 flex justify-between gap-2">
                              <dt className="text-ink-500">размер</dt>
                              <dd className="tabular-nums">
                                {(motionMedia.sizeBytes / (1024 * 1024)).toFixed(1)} МБ
                              </dd>
                            </div>
                          </dl>
                        )}
                      </div>

                      <div className="min-w-0 border border-ink-200 bg-ink-0 p-3">
                        <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.1em] text-ink-500">
                          аудиодорожка
                        </div>
                        <div className="flex min-w-0 items-center gap-1.5">
                          <input
                            type="text"
                            value={motionAudioPath}
                            onChange={(event) => setMotionAudioPath(event.target.value)}
                            placeholder="Путь к mp3/wav/m4a"
                            className={fieldClass}
                            style={fieldStyle}
                            spellCheck={false}
                          />
                          <button
                            type="button"
                            className={quietBtn}
                            onClick={() => void probeAudioFile()}
                            disabled={motionMediaBusy || !motionAudioPath.trim()}
                          >
                            <Music className="h-3.5 w-3.5" />
                            Проверить
                          </button>
                        </div>
                        <div className="mt-2 flex flex-wrap items-center gap-1.5">
                          <button type="button" className={quietBtn} onClick={applyAudioTrack}>
                            В дорожку
                          </button>
                          <span className="truncate font-mono text-[10px] text-ink-500">
                            {motionPlan?.audio.path || "без звука"}
                          </span>
                        </div>
                      </div>
                    </div>
                  </Section>
                </>
              )}

              {plugin.id === "godot" && (
                <Section
                  title="Сборка и экспорт"
                  actions={
                    <button
                      type="button"
                      className={primaryBtn}
                      onClick={() => void saveConfig()}
                      disabled={!dirty || saving}
                    >
                      {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                      Сохранить
                    </button>
                  }
                >
                  <div className="grid gap-2 lg:grid-cols-4">
                    <label className="col-span-2 grid min-w-0 gap-1">
                      <span className={labelClass}>Проект</span>
                      <div className="flex min-w-0 items-center gap-1.5">
                        <input
                          type="text"
                          value={draft?.projectDir ?? ""}
                          onChange={(event) => updateDraft({ projectDir: event.target.value })}
                          placeholder="userData/plugins/godot/project"
                          className={fieldClass}
                          style={fieldStyle}
                          spellCheck={false}
                        />
                        <button type="button" className={quietBtn} onClick={() => void pickProjectDir()}>
                          Обзор…
                        </button>
                      </div>
                    </label>
                    <label className="col-span-2 grid min-w-0 gap-1">
                      <span className={labelClass}>Файл экспорта</span>
                      <input
                        type="text"
                        value={draft?.exportPath ?? ""}
                        onChange={(event) => updateDraft({ exportPath: event.target.value })}
                        placeholder="build/<preset>/game"
                        className={fieldClass}
                        style={fieldStyle}
                        spellCheck={false}
                      />
                    </label>
                    <label className="col-span-2 grid min-w-0 gap-1">
                      <span className={labelClass}>Каталог GLB</span>
                      <input
                        type="text"
                        value={draft?.glbDir ?? ""}
                        onChange={(event) => updateDraft({ glbDir: event.target.value })}
                        placeholder="по умолчанию: папка результатов Blender"
                        className={fieldClass}
                        style={fieldStyle}
                        spellCheck={false}
                      />
                    </label>
                    <label className="grid min-w-0 gap-1">
                      <span className={labelClass}>Таймаут, с</span>
                      <input
                        type="number"
                        min={10}
                        max={7200}
                        value={draft?.timeoutSec ?? 1800}
                        onChange={(event) => updateDraft({ timeoutSec: Number(event.target.value) })}
                        className={fieldClass}
                        style={fieldStyle}
                      />
                    </label>
                    <div className="col-span-2 flex flex-wrap items-center gap-1.5 lg:col-span-4">
                      <span className={labelClass}>Пресет</span>
                      {["windows", "linux", "macos", "web", "android"].map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          className={draft?.preset === preset ? primaryBtn : quietBtn}
                          onClick={() => updateDraft({ preset })}
                        >
                          {preset}
                        </button>
                      ))}
                    </div>
                    <label className="flex items-center gap-2 text-[11px] text-ink-700">
                      <input
                        type="checkbox"
                        checked={draft?.headless !== false}
                        onChange={(event) => updateDraft({ headless: event.target.checked })}
                      />
                      headless
                    </label>
                    <label className="flex items-center gap-2 text-[11px] text-ink-700">
                      <input
                        type="checkbox"
                        checked={draft?.importGlb !== false}
                        onChange={(event) => updateDraft({ importGlb: event.target.checked })}
                      />
                      Импорт GLB
                    </label>
                    <div className="col-span-2 flex flex-wrap items-center gap-1.5 lg:col-span-4">
                      <button
                        type="button"
                        className={quietBtn}
                        onClick={() => void godotImportGlb()}
                        disabled={godotAction !== null}
                      >
                        {godotAction === "import" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                        Импорт GLB
                      </button>
                      <button
                        type="button"
                        className={primaryBtn}
                        onClick={() => void godotBuild()}
                        disabled={godotAction !== null}
                      >
                        {godotAction === "build" ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Play className="h-3.5 w-3.5" />
                        )}
                        Сборка
                      </button>
                      <button
                        type="button"
                        className={quietBtn}
                        onClick={() => void godotDemo()}
                        disabled={godotAction !== null}
                      >
                        {godotAction === "demo" ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Wand2 className="h-3.5 w-3.5" />
                        )}
                        Демо
                      </button>
                      {godotProgress && (
                        <span className="ml-auto font-mono text-[10px] text-ink-500">
                          {godotProgress.stage || "job"} · {godotProgress.percent}%
                        </span>
                      )}
                    </div>
                  </div>
                </Section>
              )}

              {plugin.id === "blender" && (
                <>
              <Section
                title="Blender-аддоны"
                actions={
                  <>
                    <span className="font-mono text-[10px] text-ink-500">{draft?.addons.length || 0}</span>
                    <button
                      type="button"
                      className={primaryBtn}
                      onClick={() => void saveConfig()}
                      disabled={!dirty || saving}
                    >
                      {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                      Сохранить
                    </button>
                  </>
                }
              >
                <div className="grid gap-3 lg:grid-cols-2">
                  <div className="min-w-0 border border-ink-200 bg-ink-0 p-3">
                    <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.1em] text-ink-500">
                      включаются автоматически
                    </div>
                    {draft?.addons.length ? (
                      <div className="flex flex-wrap gap-1.5">
                        {draft.addons.map((module) => (
                          <span
                            key={module}
                            className="inline-flex h-6 max-w-full items-center gap-1.5 border border-ink-200 px-2 font-mono text-[10px] text-ink-700"
                          >
                            <span className="truncate" title={module}>
                              {module}
                            </span>
                            <button
                              type="button"
                              onClick={() => removeAddonModule(module)}
                              className="text-ink-500 transition-colors hover:text-ink-900"
                              title="Убрать из списка"
                            >
                              ×
                            </button>
                          </span>
                        ))}
                      </div>
                    ) : (
                      <div className="text-[10px] leading-4 text-ink-500">
                        Пока пусто — используется только встроенный набор Blender.
                      </div>
                    )}
                    <div className="mt-2 border-t border-ink-200 pt-2 text-[10px] leading-4 text-ink-500">
                      Агент ставит и включает аддоны сам: <span className="font-mono">addon_search</span> →{" "}
                      <span className="font-mono">addon_install</span> (или <span className="font-mono">addon_enable</span>).
                    </div>
                  </div>

                  <div className="min-w-0 border border-ink-200 bg-ink-0 p-3">
                    <div className="mb-2 text-[10px] font-medium uppercase tracking-[0.1em] text-ink-500">
                      добавить модуль вручную
                    </div>
                    <label className="grid min-w-0 gap-1">
                      <span className={labelClass}>Модуль аддона</span>
                      <input
                        type="text"
                        value={addonInput}
                        onChange={(event) => setAddonInput(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            addAddonModule();
                          }
                        }}
                        placeholder="bl_ext.user_default.my_addon"
                        className={fieldClass}
                        style={fieldStyle}
                        spellCheck={false}
                      />
                    </label>
                    <button
                      type="button"
                      className={`${quietBtn} mt-2`}
                      onClick={addAddonModule}
                      disabled={!addonInput.trim()}
                    >
                      Добавить
                    </button>
                    <div className="mt-2 text-[10px] leading-4 text-ink-500">
                      Модуль попадёт в список после сохранения настроек.
                    </div>
                  </div>
                </div>
              </Section>

              <Section
                title="Настройки по умолчанию"
                actions={
                  <>
                    <button
                      type="button"
                      className={quietBtn}
                      onClick={() => {
                        setDraftFor(null);
                        setDirty(false);
                      }}
                    >
                      Сбросить
                    </button>
                    <button
                      type="button"
                      className={primaryBtn}
                      onClick={() => void saveConfig()}
                      disabled={!dirty || saving}
                    >
                      {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                      Сохранить
                    </button>
                  </>
                }
              >
                <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
                  <label className="grid min-w-0 gap-1">
                    <span className={labelClass}>Движок</span>
                    <select
                      value={draft?.engine || "EEVEE"}
                      onChange={(event) => updateDraft({ engine: event.target.value })}
                      className={fieldClass}
                    >
                      <option value="EEVEE">EEVEE</option>
                      <option value="CYCLES">Cycles</option>
                      <option value="WORKBENCH">Workbench</option>
                    </select>
                  </label>
                  <label className="grid min-w-0 gap-1">
                    <span className={labelClass}>Экспорт</span>
                    <select
                      value={draft?.format || "GLB"}
                      onChange={(event) => updateDraft({ format: event.target.value })}
                      className={fieldClass}
                    >
                      {["GLB", "GLTF", "FBX", "OBJ", "USD", "STL", "PLY", "BLEND"].map((format) => (
                        <option key={format} value={format}>
                          {format}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="grid min-w-0 gap-1">
                    <span className={labelClass}>Ширина</span>
                    <input
                      type="number"
                      min={64}
                      max={8192}
                      value={draft?.width ?? 1600}
                      onChange={(event) => updateDraft({ width: Number(event.target.value) })}
                      className={fieldClass}
                      style={fieldStyle}
                    />
                  </label>
                  <label className="grid min-w-0 gap-1">
                    <span className={labelClass}>Высота</span>
                    <input
                      type="number"
                      min={64}
                      max={8192}
                      value={draft?.height ?? 1000}
                      onChange={(event) => updateDraft({ height: Number(event.target.value) })}
                      className={fieldClass}
                      style={fieldStyle}
                    />
                  </label>
                  <label className="grid min-w-0 gap-1">
                    <span className={labelClass}>Сэмплы</span>
                    <input
                      type="number"
                      min={1}
                      max={4096}
                      value={draft?.samples ?? 64}
                      onChange={(event) => updateDraft({ samples: Number(event.target.value) })}
                      className={fieldClass}
                      style={fieldStyle}
                    />
                  </label>
                  <label className="grid min-w-0 gap-1">
                    <span className={labelClass}>Таймаут, с</span>
                    <input
                      type="number"
                      min={10}
                      max={7200}
                      value={draft?.timeoutSec ?? 900}
                      onChange={(event) => updateDraft({ timeoutSec: Number(event.target.value) })}
                      className={fieldClass}
                      style={fieldStyle}
                    />
                  </label>
                  <label className="flex items-end gap-2 pb-1 text-[11px] text-ink-700">
                    <input
                      type="checkbox"
                      checked={draft?.autoRender !== false}
                      onChange={(event) => updateDraft({ autoRender: event.target.checked })}
                    />
                    Авто-рендер
                  </label>
                  <div className="col-span-2 flex items-end gap-2 lg:col-span-4">
                    <label className="grid min-w-0 flex-1 gap-1">
                      <span className={labelClass}>Папка результатов</span>
                      <input
                        type="text"
                        value={draft?.outputDir ?? ""}
                        onChange={(event) => updateDraft({ outputDir: event.target.value })}
                        placeholder="По умолчанию: userData/plugins/output"
                        className={fieldClass}
                        style={fieldStyle}
                        spellCheck={false}
                      />
                    </label>
                    <button type="button" className={quietBtn} onClick={() => void pickOutputDir()}>
                      Обзор…
                    </button>
                  </div>
                </div>
              </Section>



                </>
              )}

              <Section title="Что умеет плагин">
                <ul className="grid gap-1 text-[10px] leading-4 text-ink-600 sm:grid-cols-2">
                  {plugin.capabilities.map((capability) => (
                    <li key={capability} className="flex gap-1.5">
                      <span className="mt-[3px] h-1 w-1 shrink-0 rounded-full bg-[var(--ink-400)]" />
                      <span className="min-w-0">{capability}</span>
                    </li>
                  ))}
                </ul>
              </Section>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

export default PluginsWorkspace;
