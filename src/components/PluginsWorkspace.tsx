import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AlertTriangle,
  Box,
  ChevronRight,
  FolderOpen,
  Loader2,
  Play,
  RefreshCw,
  Save,
  Wand2,
} from "lucide-react";
import type { ComposeVCPlugin, ComposeVCPluginConfig, ComposeVCPluginsState } from "../types";

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
};

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
      addons: Array.isArray(config.addons) ? config.addons.slice() : [],
    });
    setDraftFor(plugin.id);
    setDirty(false);
  }, [plugin, draftFor]);

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
      const config: Partial<ComposeVCPluginConfig> = {
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
            ИИ-инструменты: blender · plugin
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

              <Section title="Blender и статус">
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
                          ? `Blender ${plugin.status.version || "?"} · ${
                              plugin.status.source === "config" ? "путь из настроек" : "автоопределение"
                            }`
                          : plugin.status?.error || "Blender не найден"}
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
                      <span className={labelClass}>Путь к blender.exe</span>
                      <div className="flex min-w-0 items-center gap-1.5">
                        <input
                          type="text"
                          value={draft?.executable ?? ""}
                          onChange={(event) => updateDraft({ executable: event.target.value })}
                          placeholder="Автоопределение (Program Files, PATH, Steam…)"
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
                      Пустое поле — автоопределение: Program Files, PATH, Steam, snap/flatpak, macOS Applications.
                    </div>
                  </div>
                </div>
              </Section>

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
                <div className="mb-2 text-[10px] leading-4 text-ink-500">
                  Агент ставит и включает аддоны сам: <span className="font-mono">addon_search</span> →{" "}
                  <span className="font-mono">addon_install</span> (или <span className="font-mono">addon_enable</span>
                  ). Модули ниже включаются перед каждой задачей Blender.
                </div>
                {draft?.addons.length ? (
                  <div className="mb-2 flex flex-wrap gap-1.5">
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
                  <div className="mb-2 text-[10px] text-ink-500">Пока пусто — используется только встроенный набор Blender.</div>
                )}
                <div className="flex items-end gap-2">
                  <label className="grid min-w-0 flex-1 gap-1">
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
                  <button type="button" className={quietBtn} onClick={addAddonModule} disabled={!addonInput.trim()}>
                    Добавить
                  </button>
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

              <Section
                title="Задачи"
              >




                      {selectedJob.addons.length > 0 && (
                        <div className="border-t border-ink-200 pt-1.5 text-[10px] leading-4 text-ink-600">
                          <div className="mb-0.5 text-[10px] uppercase tracking-[0.08em] text-ink-500">аддоны</div>
                          {selectedJob.addons.slice(0, 10).map((addon, index) => (
                            <div key={`${selectedJob.id}-a-${index}`} className="truncate" title={addon.error || addon.module || addon.path}>
                              {addon.enabled ? "1" : "0"} {addon.module || addon.path}
                              {addon.error ? ` · ${addon.error}` : ""}
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
                        <pre
                          className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words border border-ink-200 p-2 font-mono text-[10px] leading-4 text-ink-600 scrollbar-thin"
                          style={{ background: "var(--terminal-bg, var(--input-bg))" }}
                        >
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
