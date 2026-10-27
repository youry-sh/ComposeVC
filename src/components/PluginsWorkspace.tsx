import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Box,
  ChevronRight,
  Copy,
  FolderOpen,
  Loader2,
  Play,
  RefreshCw,
  Save,
  Square,
  TerminalSquare,
  Trash2,
  Wand2,
  ExternalLink,
  Image as ImageIcon,
} from "lucide-react";
import type {
  ComposeVCPlugin,
  ComposeVCPluginConfig,
  ComposeVCPluginJob,
  ComposeVCPluginsState,
} from "../types";
import { dispatchInsertChatInput } from "../utils/mouseSnippets";

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
};

const quietBtn =
  "ide-quiet-btn inline-flex h-7 shrink-0 items-center justify-center gap-1.5 px-2.5 text-[11px] leading-none outline-none transition-colors disabled:opacity-40 theme-soft";
const primaryBtn =
  "ide-primary-btn inline-flex h-7 shrink-0 items-center justify-center gap-1.5 px-2.5 text-[11px] leading-none outline-none transition-colors disabled:opacity-40 ui-btn-primary";
const labelClass = "ide-field-label text-[10px] font-medium uppercase tracking-[0.1em] text-ink-500";
const fieldStyle: React.CSSProperties = { caretColor: "var(--accent)" };
const fieldClass =
  "ide-field h-7 w-full min-w-0 px-2 text-[12px] leading-7 text-ink-950 placeholder-ink-500 outline-none";

const STATUS_LABEL: Record<string, string> = {
  queued: "в очереди",
  running: "выполняется",
  succeeded: "готово",
  failed: "ошибка",
  canceled: "отменено",
};

function statusColor(status: string): string {
  if (status === "running") return "var(--accent)";
  if (status === "failed") return "var(--status-err, #d9534f)";
  if (status === "canceled") return "var(--ink-400)";
  if (status === "succeeded") return "var(--ink-900)";
  return "var(--ink-500)";
}

function fmtBytes(bytes: number): string {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} Б`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} КБ`;
  return `${(value / (1024 * 1024)).toFixed(1)} МБ`;
}

function fmtDuration(ms: number): string {
  const value = Number(ms) || 0;
  if (value <= 0) return "—";
  const seconds = Math.round(value / 1000);
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} м ${seconds % 60} с`;
}

function fmtWhen(ts: number): string {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString([], {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

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

const PluginsWorkspace: React.FC = () => {
  const [state, setState] = useState<ComposeVCPluginsState | null>(null);
  const [jobs, setJobs] = useState<ComposeVCPluginJob[]>([]);
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
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [logs, setLogs] = useState<Record<string, string>>({});
  const [logBusy, setLogBusy] = useState(false);

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

  const refreshJobs = useCallback(async () => {
    try {
      const result = await window.lopster?.pluginsJobs?.({ limit: 60 });
      if (result?.ok && result.jobs) setJobs(result.jobs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      setLoading(true);
      await Promise.all([refreshPlugins(), refreshJobs()]);
      if (alive) setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [refreshPlugins, refreshJobs]);

  useEffect(() => {
    const offChanged = window.lopster?.onPluginsChanged?.(() => {
      void refreshPlugins();
      void refreshJobs();
    });
    const offJob = window.lopster?.onPluginJob?.((payload) => {
      if (!payload?.jobId) return;
      setJobs((prev) => {
        const index = prev.findIndex((job) => job.id === payload.jobId);
        if (index < 0) return prev;
        const next = prev.slice();
        next[index] = {
          ...next[index],
          status: payload.status || next[index].status,
          progress: typeof payload.percent === "number" ? payload.percent : next[index].progress,
          stage: payload.stage || next[index].stage,
          error: payload.error ?? next[index].error,
        };
        return next;
      });
      if (payload.done) {
        void refreshJobs();
        void refreshPlugins();
      }
    });
    return () => {
      offChanged?.();
      offJob?.();
    };
  }, [refreshPlugins, refreshJobs]);

  useEffect(() => {
    if (!plugin) return;
    if (draftFor === plugin.id) return;
    const config = plugin.config;
    setDraft({
      executable: config.executable || "",
      outputDir: config.outputDir || plugin.outputDir || "",
      engine: config.engine || "EEVEE",
      width: config.resolution?.width || 1600,
      height: config.resolution?.height || 1000,
      samples: config.samples || 64,
      format: config.format || "GLB",
      autoRender: config.autoRender !== false,
      timeoutSec: config.timeoutSec || 900,
    });
    setDraftFor(plugin.id);
    setDirty(false);
  }, [plugin, draftFor]);

  useEffect(() => {
    if (selectedJobId) return;
    const withPreview = jobs.find((job) => job.status === "succeeded" && job.previewPath);
    if (withPreview) setSelectedJobId(withPreview.id);
  }, [jobs, selectedJobId]);

  const selectedJob = useMemo(
    () => jobs.find((job) => job.id === selectedJobId) || null,
    [jobs, selectedJobId]
  );

  useEffect(() => {
    const job = selectedJob;
    if (!job || !job.previewPath || previews[job.id]) return;
    let alive = true;
    void window.lopster?.pluginsPreview?.(job.id).then((result) => {
      if (!alive || !result?.ok || !result.dataUrl) return;
      setPreviews((prev) => ({ ...prev, [job.id]: result.dataUrl as string }));
    });
    return () => {
      alive = false;
    };
  }, [selectedJob, previews]);

  const updateDraft = (patch: Partial<DraftConfig>) => {
    setDraft((prev) => (prev ? { ...prev, ...patch } : prev));
    setDirty(true);
    setNotice(null);
  };

  const saveConfig = async () => {
    if (!plugin || !draft) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const config: Partial<ComposeVCPluginConfig> = {
        executable: draft.executable.trim(),
        outputDir: draft.outputDir.trim(),
        engine: draft.engine,
        resolution: { width: Number(draft.width) || 1600, height: Number(draft.height) || 1000 },
        samples: Number(draft.samples) || 64,
        format: draft.format,
        autoRender: draft.autoRender,
        timeoutSec: Number(draft.timeoutSec) || 900,
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
    const result = await window.lopster?.pluginsPickExecutable?.();
    if (!result?.ok || !result.path) return;
    updateDraft({ executable: result.path });
    if (plugin && draft) {
      setSaving(true);
      try {
        const saved = await window.lopster?.pluginsUpdate?.(plugin.id, {
          config: { executable: result.path },
        });
        if (saved?.ok) {
          setNotice("Blender найден и сохранён.");
          await refreshPlugins();
          setDraft((prev) => (prev ? { ...prev, executable: result.path as string } : prev));
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
      if (!result?.ok) {
        setError(result?.error || "Не удалось опросить плагин.");
        return;
      }
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
      const engines = result.probe?.engines?.join(", ") || "—";
      setNotice(`Возможности: ${engines}`);
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
        const checked = result?.error ? "" : "";
        setError(`${result?.error || "Демо-задача не выполнилась."}${checked}`);
        await refreshJobs();
        return;
      }
      setNotice(`Демо готово: ${result.job?.summary || "сцена собрана"}`);
      setSelectedJobId(result.job?.id || null);
      await refreshJobs();
      await refreshPlugins();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDemoBusy(false);
    }
  };

  const cancelJob = async (job: ComposeVCPluginJob) => {
    try {
      await window.lopster?.pluginsCancel?.(job.id);
      await refreshJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const deleteJob = async (job: ComposeVCPluginJob) => {
    const ok = window.confirm(`Удалить задачу «${job.title || job.id}» вместе с файлами?`);
    if (!ok) return;
    try {
      const result = await window.lopster?.pluginsDeleteJob?.(job.id);
      if (!result?.ok) setError(result?.error || "Не удалось удалить задачу.");
      if (selectedJobId === job.id) setSelectedJobId(null);
      setPreviews((prev) => {
        const next = { ...prev };
        delete next[job.id];
        return next;
      });
      await refreshJobs();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const openFolder = async (job?: ComposeVCPluginJob | null) => {
    try {
      const result = job
        ? await window.lopster?.pluginsOpenPath?.(job.id)
        : await window.lopster?.pluginsOpenPath?.("", state?.jobsRoot || "");
      if (!result?.ok) setError(result?.error || "Не удалось открыть папку.");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const openInBlender = async (job: ComposeVCPluginJob) => {
    try {
      const result = await window.lopster?.pluginsOpenInBlender?.(job.id);
      if (!result?.ok) setError(result?.error || "Не удалось открыть Blender.");
      else setNotice(`Blender открыт: ${result.file}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const copyArtifacts = async (job: ComposeVCPluginJob) => {
    try {
      const result = await window.lopster?.pluginsCopyArtifacts?.(job.id, draft?.outputDir || "");
      if (!result?.ok) setError(result?.error || "Не удалось скопировать файлы.");
      else setNotice(`Скопировано ${result.copied?.length || 0} файл(ов) → ${result.folder}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const showLog = async (job: ComposeVCPluginJob) => {
    setLogBusy(true);
    try {
      const result = await window.lopster?.pluginsLog?.(job.id);
      if (result?.ok && typeof result.log === "string") {
        setLogs((prev) => ({ ...prev, [job.id]: result.log as string }));
      } else {
        setError(result?.error || "Лог недоступен.");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLogBusy(false);
    }
  };

  const insertPrompt = (text: string) => {
    dispatchInsertChatInput(text, false);
    setNotice("Запрос вставлен в чат — отправьте его агенту.");
  };

  const copyPrompt = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("Запрос скопирован.");
    } catch {
      setError("Не удалось скопировать в буфер обмена.");
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
            ИИ-инструменты: blender · plugin
          </span>
          <button type="button" className={quietBtn} onClick={() => void openFolder(null)} title="Папка задач">
            <FolderOpen className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            className={quietBtn}
            onClick={() => {
              void refreshPlugins();
              void refreshJobs();
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
            <span className="font-mono text-[10px] text-ink-400">1-й: Blender</span>
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
                  <Box className="h-5 w-5" />
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
                      {plugin.status?.found ? "готов" : "нужен Blender"}
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
                  <button type="button" className={primaryBtn} onClick={() => void runDemo()} disabled={demoBusy}>
                    {demoBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}
                    Демо-сцена
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

              <Section
                title="Blender и статус"
                actions={
                  <>
                    <button type="button" className={quietBtn} onClick={() => void probe()} disabled={probing}>
                      {probing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
                      Проверить
                    </button>
                    <button type="button" className={quietBtn} onClick={() => void openFolder(null)}>
                      <FolderOpen className="h-3.5 w-3.5" />
                      Папка задач
                    </button>
                  </>
                }
              >
                <div className="mb-2 flex flex-wrap items-center gap-2 text-[11px]">
                  <span
                    className="h-1.5 w-1.5 rounded-full"
                    style={{ background: plugin.status?.found ? "var(--accent)" : "var(--ink-400)" }}
                  />
                  <span className="text-ink-800">
                    {plugin.status?.found
                      ? `Blender ${plugin.status.version || "?"} · ${plugin.status.source === "config" ? "путь из настроек" : "автоопределение"}`
                      : plugin.status?.error || "Blender не найден"}
                  </span>
                  {(plugin.stats?.runs || 0) > 0 && (
                    <span className="ml-auto font-mono text-[10px] text-ink-500">
                      запусков {plugin.stats.runs} · ошибок {plugin.stats.failures}
                    </span>
                  )}
                </div>
                <div className="flex flex-wrap items-end gap-2">
                  <label className="grid min-w-0 flex-1 gap-1">
                    <span className={labelClass}>Путь к blender.exe</span>
                    <input
                      type="text"
                      value={draft?.executable ?? ""}
                      onChange={(event) => updateDraft({ executable: event.target.value })}
                      placeholder="Автоопределение (Program Files, PATH, Steam…)"
                      className={fieldClass}
                      style={fieldStyle}
                      spellCheck={false}
                    />
                  </label>
                  <button type="button" className={quietBtn} onClick={() => void pickExecutable()}>
                    Обзор…
                  </button>
                </div>
                {plugin.status?.found && (
                  <div className="mt-1 truncate font-mono text-[10px] text-ink-500">{plugin.status.executable}</div>
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

              <Section
                title="Задачи"
                actions={
                  <>
                    <span className="font-mono text-[10px] text-ink-500">{jobs.length}</span>
                    <button type="button" className={quietBtn} onClick={() => void refreshJobs()}>
                      <RefreshCw className="h-3.5 w-3.5" />
                    </button>
                  </>
                }
              >
                {jobs.length === 0 ? (
                  <div className="py-2 text-[11px] leading-5 text-ink-500">
                    Задач пока нет. Скажи агенту: «Сделай стилизованный игровой меч и экспортируй GLB» — он вызовет
                    инструмент blender. Или нажми «Демо-сцена».
                  </div>
                ) : (
                  <div className="border border-ink-200">
                    {jobs.map((job) => {
                      const active = job.id === selectedJobId;
                      const running = job.status === "running" || job.status === "queued";
                      return (
                        <div
                          key={job.id}
                          className="flex items-center gap-2 border-b border-ink-200 px-2 py-1.5 last:border-b-0"
                          style={{ background: active ? "color-mix(in srgb, var(--panel-bg) 70%, var(--bg))" : undefined }}
                        >
                          <button
                            type="button"
                            className="flex min-w-0 flex-1 items-start gap-2 text-left outline-none"
                            onClick={() => setSelectedJobId(active ? null : job.id)}
                            title={job.error || job.summary || job.title}
                          >
                            <span
                              className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
                              style={{ background: statusColor(job.status) }}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="flex min-w-0 items-center gap-2">
                                <span className="truncate text-[12px] font-medium text-ink-950">
                                  {job.title || job.kind}
                                </span>
                                <span className="shrink-0 font-mono text-[10px] text-ink-500">{job.kind}</span>
                                <span className="shrink-0 font-mono text-[10px] text-ink-500">
                                  {STATUS_LABEL[job.status] || job.status}
                                </span>
                              </span>
                              <span className="mt-0.5 block truncate text-[10px] text-ink-500">
                                {job.error || job.summary || job.stage || fmtWhen(job.createdAt)}
                              </span>
                            </span>
                            <span className="shrink-0 text-right font-mono text-[10px] leading-4 text-ink-500">
                              <span className="block">{fmtDuration(job.durationMs)}</span>
                              <span className="block">{fmtWhen(job.createdAt)}</span>
                            </span>
                          </button>
                          <div className="flex shrink-0 items-center gap-0.5">
                            {running ? (
                              <button
                                type="button"
                                className={quietBtn}
                                onClick={() => void cancelJob(job)}
                                title="Остановить"
                              >
                                <Square className="h-3.5 w-3.5" />
                              </button>
                            ) : (
                              <>
                                <button
                                  type="button"
                                  className={quietBtn}
                                  onClick={() => void openFolder(job)}
                                  title="Открыть папку задачи"
                                >
                                  <FolderOpen className="h-3.5 w-3.5" />
                                </button>
                                {job.blendPath && (
                                  <button
                                    type="button"
                                    className={quietBtn}
                                    onClick={() => void openInBlender(job)}
                                    title="Открыть .blend в Blender"
                                  >
                                    <ExternalLink className="h-3.5 w-3.5" />
                                  </button>
                                )}
                                <button
                                  type="button"
                                  className={quietBtn}
                                  onClick={() => void copyArtifacts(job)}
                                  title="Скопировать результаты в папку"
                                >
                                  <Copy className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  type="button"
                                  className="ui-btn-danger h-7 px-1.5 text-[10px]"
                                  onClick={() => void deleteJob(job)}
                                  title="Удалить задачу"
                                >
                                  <Trash2 className="h-3.5 w-3.5" />
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {selectedJob && (
                  <div className="mt-2 border border-ink-200">
                    <div className="flex flex-wrap items-center gap-2 border-b border-ink-200 px-2.5 py-1.5">
                      <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-ink-900">
                        {selectedJob.title || selectedJob.id}
                      </span>
                      <span className="font-mono text-[10px] text-ink-500">{selectedJob.id}</span>
                      <button
                        type="button"
                        className={quietBtn}
                        onClick={() => void showLog(selectedJob)}
                        disabled={logBusy}
                      >
                        <TerminalSquare className="h-3.5 w-3.5" />
                        Лог
                      </button>
                    </div>
                    <div className="grid gap-2 px-2.5 py-2">
                      {selectedJob.error && (
                        <div className="whitespace-pre-wrap break-words text-[11px] text-status-err">
                          {selectedJob.error}
                        </div>
                      )}
                      {previews[selectedJob.id] ? (
                        <div className="flex min-w-0 flex-col gap-1">
                          <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.08em] text-ink-500">
                            <ImageIcon className="h-3.5 w-3.5" /> рендер
                          </div>
                          <img
                            src={previews[selectedJob.id]}
                            alt="Blender render"
                            className="max-h-[320px] w-auto max-w-full border border-ink-200 object-contain"
                          />
                        </div>
                      ) : selectedJob.previewPath ? (
                        <div className="text-[10px] text-ink-500">Превью загружается…</div>
                      ) : null}
                      {selectedJob.renders.length > 0 && (
                        <div className="grid gap-0.5 font-mono text-[10px] leading-4 text-ink-600">
                          {selectedJob.renders.map((render) => (
                            <div key={render.path} className="truncate" title={render.path}>
                              PNG {render.name}
                            </div>
                          ))}
                        </div>
                      )}
                      {selectedJob.exports.length > 0 && (
                        <div className="grid gap-0.5 font-mono text-[10px] leading-4 text-ink-600">
                          {selectedJob.exports.map((item) => (
                            <div key={item.path} className="flex items-center gap-2">
                              <span className="w-11 shrink-0 text-ink-500">{item.format}</span>
                              <span className="min-w-0 flex-1 truncate" title={item.path}>
                                {item.path}
                              </span>
                              <span className="shrink-0 text-ink-500">{fmtBytes(item.bytes)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                      {selectedJob.warnings.length > 0 && (
                        <div className="border-t border-ink-200 pt-1.5 text-[10px] leading-4 text-ink-500">
                          <div className="mb-0.5 flex items-center gap-1 text-[10px] uppercase tracking-[0.08em]">
                            <AlertTriangle className="h-3 w-3" /> предупреждения
                          </div>
                          {selectedJob.warnings.slice(0, 8).map((warning, index) => (
                            <div key={`${selectedJob.id}-w-${index}`} className="truncate" title={warning}>
                              {warning}
                            </div>
                          ))}
                        </div>
                      )}
                      {logs[selectedJob.id] && (
                        <pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words border border-ink-200 bg-[var(--terminal-bg,var(--input-bg))] p-2 font-mono text-[10px] leading-4 text-ink-600 scrollbar-thin">
                          {logs[selectedJob.id]}
                        </pre>
                      )}
                    </div>
                  </div>
                )}
              </Section>

              <Section title="Что умеет плагин">
                <ul className="grid gap-1 text-[10px] leading-4 text-ink-600">
                  {plugin.capabilities.map((capability) => (
                    <li key={capability} className="flex gap-1.5">
                      <span className="mt-[3px] h-1 w-1 shrink-0 rounded-full bg-[var(--ink-400)]" />
                      <span className="min-w-0">{capability}</span>
                    </li>
                  ))}
                </ul>
              </Section>

              <Section title="Примеры запросов агенту">
                <div className="grid gap-1.5">
                  {plugin.examples.map((example) => (
                    <div key={example} className="flex items-start gap-2 border border-ink-200 px-2.5 py-1.5">
                      <span className="min-w-0 flex-1 text-[11px] leading-4 text-ink-700">{example}</span>
                      <div className="flex shrink-0 items-center gap-1">
                        <button
                          type="button"
                          className={quietBtn}
                          onClick={() => insertPrompt(example)}
                          title="Вставить в чат"
                        >
                          в чат
                        </button>
                        <button
                          type="button"
                          className={quietBtn}
                          onClick={() => void copyPrompt(example)}
                          title="Скопировать"
                        >
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <div className="mt-2 text-[10px] leading-4 text-ink-500">
                  Агент вызывает инструмент <span className="font-mono">blender</span>: декларативный план сцены, PBR-материалы,
                  процедурные или файловые текстуры, свет, камеры, рендер, запекание и экспорт. Для полной свободы доступен
                  произвольный bpy-скрипт.
                </div>
              </Section>
            </div>
          )}
        </section>
      </div>
    </div>
  );
};

export default PluginsWorkspace;
