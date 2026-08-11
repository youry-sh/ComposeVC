import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  Satellite,
  Play,
  Send,
  Square,
  Pencil,
  Trash2,
  RefreshCw,
  Plus,
  Power,
  PowerOff,
  FileText,
  X,
  Loader2,
  Clock,
  AlertTriangle,
  ChevronLeft,
  MessageSquare,
  CheckCircle2,
  FolderOpen,
  Timer,
} from "lucide-react";
import type {
  AIModel,
  ProviderConfig,
  RunnerJob,
  RunnerReport,
  RunnerReportSummary,
} from "../types";

type Props = {
  providerConfig: ProviderConfig;
  rootPath?: string | null;
  projectName?: string | null;
  onSendToRunner?: (runnerId: string) => void;
};

type EditorState =
  | { mode: "create" }
  | { mode: "edit"; runner: RunnerJob }
  | null;

const emptyForm = {
  name: "",
  prompt: "",
  modelId: "",
  triggerType: "interval" as "interval" | "off",
  intervalMinutes: 60,
  maxRetries: 2,
  enabled: true,
  useCurrentFolder: true,
};

function formatWhen(ts?: number | null) {
  if (!ts) return "—";
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return "—";
  }
}

function formatDuration(ms: number) {
  const n = Math.max(0, Number(ms) || 0);
  if (n < 1000) return `${n}мс`;
  const sec = Math.round(n / 1000);
  if (sec < 60) return `${sec}с`;
  const min = Math.floor(sec / 60);
  const rem = sec % 60;
  if (min < 60) return rem ? `${min}м ${rem}с` : `${min}м`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h}ч ${m}м` : `${h}ч`;
}

function statusClass(status?: string | null) {
  const s = String(status || "idle").toLowerCase();
  if (s === "running") return "text-sky-400";
  if (s === "success") return "text-emerald-400";
  if (s === "error") return "text-rose-400";
  if (s === "stopped") return "text-amber-400";
  if (s === "queued") return "text-amber-400";
  return "text-ink-500";
}

function statusLabel(status?: string | null) {
  const s = String(status || "idle").toLowerCase();
  if (s === "running") return "работает";
  if (s === "success") return "успех";
  if (s === "error") return "ошибка";
  if (s === "stopped") return "остановлен";
  if (s === "queued") return "в очереди";
  if (s === "idle") return "ожидание";
  return s;
}

function triggerLabel(runner: RunnerJob) {
  if (runner.trigger?.type === "interval") {
    return `каждые ${runner.trigger.intervalMinutes} мин`;
  }
  return "вручную";
}

function shortPath(p?: string | null, max = 48) {
  const s = String(p || "").trim();
  if (!s) return "—";
  if (s.length <= max) return s;
  return `…${s.slice(-(max - 1))}`;
}

const RunnerWorkspace: React.FC<Props> = ({
  providerConfig,
  rootPath,
  projectName,
  onSendToRunner,
}) => {
  const [runners, setRunners] = useState<RunnerJob[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<"runners" | "reports">("runners");
  const [selectedRunnerId, setSelectedRunnerId] = useState<string | null>(null);
  const [reports, setReports] = useState<RunnerReportSummary[]>([]);
  const [selectedReport, setSelectedReport] = useState<RunnerReport | null>(null);
  const [editor, setEditor] = useState<EditorState>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [reportsLoading, setReportsLoading] = useState(false);

  const showToast = useCallback((text: string) => {
    setToast(text);
    const timer = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(timer);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await window.lopster?.listRunners();
      setRunners(res?.runners || []);
    } catch {
      /* */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const unsubChanged = window.lopster?.onRunnersChanged?.(() => {
      void refresh();
    });
    const unsubStatus = window.lopster?.onRunnerStatus?.(() => {
      void refresh();
    });
    return () => {
      unsubChanged?.();
      unsubStatus?.();
    };
  }, [refresh]);

  const selectedRunner = useMemo(
    () => runners.find((r) => r.id === selectedRunnerId) || null,
    [runners, selectedRunnerId]
  );

  const loadReports = useCallback(async (runnerId: string) => {
    setReportsLoading(true);
    try {
      const res = await window.lopster?.listRunnerReports({ runnerId, limit: 300 });
      setReports(res?.reports || []);
    } catch {
      setReports([]);
    } finally {
      setReportsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (tab === "reports" && selectedRunnerId) {
      setSelectedReport(null);
      void loadReports(selectedRunnerId);
    }
  }, [tab, selectedRunnerId, loadReports]);

  useEffect(() => {
    if (tab !== "reports") return;
    const unsubReport = window.lopster?.onRunnerReportChanged?.((payload) => {
      if (!selectedRunnerId) return;
      if (payload?.deleted) {
        void loadReports(selectedRunnerId);
        return;
      }
      if (payload?.report && payload.report.runnerId === selectedRunnerId) {
        void loadReports(selectedRunnerId);
        if (selectedReport && payload.report.id === selectedReport.id) {
          setSelectedReport(payload.report);
        }
      }
    });
    return () => unsubReport?.();
  }, [tab, selectedRunnerId, selectedReport, loadReports]);

  const modelLabel = useCallback(
    (modelId: string) => {
      const model = providerConfig.models.find((m) => m.id === modelId);
      return model?.name || modelId || "—";
    },
    [providerConfig.models]
  );

  const handleRun = async (runner: RunnerJob) => {
    setBusyId(runner.id);
    try {
      const res = await window.lopster?.runRunner(runner.id, {});
      if (res?.ok) {
        showToast(
          res.queued
            ? `${runner.name}: запрос в очереди (ранер уже работает)`
            : `${runner.name}: запущен`
        );
      } else {
        showToast(res?.error || "Не удалось запустить");
      }
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleStop = async (runner: RunnerJob) => {
    setBusyId(runner.id);
    try {
      await window.lopster?.stopRunner(runner.id);
      showToast(`${runner.name}: остановлен`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    } finally {
      setBusyId(null);
    }
  };

  const handleToggleEnabled = async (runner: RunnerJob) => {
    try {
      await window.lopster?.updateRunner(runner.id, { enabled: !runner.enabled });
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    }
  };

  const handleDelete = async (runner: RunnerJob) => {
    if (!window.confirm(`Удалить ранера «${runner.name}»? Отчёты будут сохранены.`)) return;
    try {
      await window.lopster?.deleteRunner(runner.id);
      if (selectedRunnerId === runner.id) {
        setSelectedRunnerId(null);
      }
      showToast(`${runner.name}: удалён`);
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    }
  };

  const openReports = (runner: RunnerJob) => {
    setSelectedRunnerId(runner.id);
    setSelectedReport(null);
    setTab("reports");
  };

  const handleSaveEditor = async (form: typeof emptyForm) => {
    if (!form.prompt.trim()) {
      showToast("Промт обязателен");
      return;
    }
    if (!form.modelId) {
      showToast("Выберите модель");
      return;
    }
    const payload = {
      name: form.name.trim() || "Runner",
      prompt: form.prompt.trim(),
      modelId: form.modelId,
      enabled: form.enabled,
      trigger:
        form.triggerType === "off"
          ? { type: "off" }
          : { type: "interval", intervalMinutes: Math.max(1, form.intervalMinutes) },
      maxRetries: Math.max(0, Math.min(5, form.maxRetries)),
      rootPath: form.useCurrentFolder && rootPath ? rootPath : null,
      projectName: form.useCurrentFolder && projectName ? projectName : null,
    };
    try {
      if (editor?.mode === "edit") {
        await window.lopster?.updateRunner(editor.runner.id, payload);
        showToast("Настройки ранера сохранены");
      } else {
        await window.lopster?.createRunner(payload);
        showToast("Ранер создан");
      }
      setEditor(null);
      void refresh();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err));
    }
  };

  const handleOpenReport = async (report: RunnerReportSummary) => {
    try {
      const res = await window.lopster?.getRunnerReport(report.runnerId, report.id);
      if (res?.report) setSelectedReport(res.report);
    } catch {
      /* */
    }
  };

  const activeCount = runners.filter((r) => r.running).length;
  const queuedCount = runners.filter((r) => r.queued).length;
  const totalRuns = runners.reduce((sum, r) => sum + (r.stats?.totalRuns || 0), 0);
  const totalErrors = runners.reduce((sum, r) => sum + (r.stats?.totalErrors || 0), 0);

  return (
    <div className="flex-1 min-w-0 min-h-0 flex flex-col overflow-hidden">
      <header className="flex shrink-0 flex-col border-b border-ink-200">
        <div className="flex h-12 items-center justify-between px-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-[13px] font-medium text-ink-950">
              <Satellite className="h-4 w-4 text-accent" />
              Runner
              <span className="rounded-full bg-accent-muted px-2 py-0.5 text-[10px] font-medium text-accent">
                фоновая автономия
              </span>
            </div>
            <div className="truncate text-[11px] text-ink-500">
              Бесконечные агенты: интервальный триггер + ручные запросы (Ctrl+R). Работают, даже когда ты в других вкладках.
            </div>
          </div>
          <div className="flex items-center gap-1">
            <div className="mr-2 hidden items-center gap-3 text-[10px] text-ink-500 md:flex">
              <span className="flex items-center gap-1">
                <span className="h-1.5 w-1.5 rounded-full bg-sky-400" />
                работает: {activeCount}
              </span>
              {queuedCount > 0 && (
                <span className="flex items-center gap-1">
                  <span className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                  в очереди: {queuedCount}
                </span>
              )}
              <span>запусков: {totalRuns}</span>
              <span className={totalErrors > 0 ? "text-rose-500" : ""}>ошибок: {totalErrors}</span>
            </div>
            <button
              type="button"
              onClick={() => void refresh()}
              className="grid h-8 w-8 place-items-center rounded-md text-ink-500 hover:bg-ink-100"
              title="Обновить"
            >
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setEditor({ mode: "create" })}
              className="flex h-8 items-center gap-1 rounded-md border border-ink-300 px-3 text-[11px] text-ink-800 hover:bg-ink-100"
            >
              <Plus className="h-3.5 w-3.5" />
              Новый ранер
            </button>
          </div>
        </div>
        <div className="flex items-center gap-1 border-t border-ink-100 px-2">
          <button
            type="button"
            onClick={() => setTab("runners")}
            className={`flex h-8 items-center gap-1.5 rounded-t-md px-3 text-[11px] ${
              tab === "runners"
                ? "border-b-2 border-accent font-medium text-ink-950"
                : "text-ink-500 hover:text-ink-800"
            }`}
          >
            <Satellite className="h-3.5 w-3.5" />
            Ранеры
          </button>
          <button
            type="button"
            onClick={() => {
              if (!selectedRunnerId && runners.length) {
                setSelectedRunnerId(runners[0].id);
              }
              setTab("reports");
            }}
            className={`flex h-8 items-center gap-1.5 rounded-t-md px-3 text-[11px] ${
              tab === "reports"
                ? "border-b-2 border-accent font-medium text-ink-950"
                : "text-ink-500 hover:text-ink-800"
            }`}
          >
            <FileText className="h-3.5 w-3.5" />
            Отчёты
            {selectedRunnerId ? ` · ${runners.find((r) => r.id === selectedRunnerId)?.name || ""}` : ""}
          </button>
        </div>
      </header>

      {toast && (
        <div className="flex items-center gap-2 border-b border-emerald-500/20 bg-emerald-500/10 px-4 py-1.5 text-[11px] text-emerald-600">
          <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
          {toast}
        </div>
      )}

      <div className="flex-1 min-h-0 overflow-auto">
        {loading ? (
          <div className="flex items-center justify-center gap-2 p-8 text-[12px] text-ink-500">
            <Loader2 className="h-4 w-4 animate-spin" /> Загрузка…
          </div>
        ) : tab === "runners" ? (
          runners.length === 0 ? (
            <div className="p-10 text-center">
              <div className="mx-auto grid h-12 w-12 place-items-center rounded-xl border border-dashed border-ink-300 text-accent">
                <Satellite className="h-5 w-5" />
              </div>
              <div className="mt-3 text-[13px] font-medium text-ink-800">Пока нет ни одного ранера</div>
              <div className="mx-auto mt-1 max-w-sm text-[11px] text-ink-500">
                Ранер — это бесконечный фоновый агент со своим промтом и моделью. Он запускается сам по
                интервалу (минуты) и по твоему запросу через Ctrl+R. Всё, что он делает, попадает в отчёты.
              </div>
              <button
                type="button"
                onClick={() => setEditor({ mode: "create" })}
                className="theme-primary mt-4 inline-flex h-9 items-center gap-1.5 rounded-md px-4 text-[12px] font-medium"
              >
                <Plus className="h-4 w-4" />
                Создать первого ранера
              </button>
            </div>
          ) : (
            <table className="w-full border-collapse text-left">
              <thead className="sticky top-0 z-10 bg-ink-100">
                <tr className="border-b border-ink-200 text-[10px] uppercase tracking-wide text-ink-500">
                  <th className="px-4 py-2 font-medium">Ранер</th>
                  <th className="px-3 py-2 font-medium">Модель</th>
                  <th className="px-3 py-2 font-medium">Триггер</th>
                  <th className="px-3 py-2 font-medium">Статус</th>
                  <th className="px-3 py-2 font-medium">Последний запуск</th>
                  <th className="px-3 py-2 font-medium">Следующий</th>
                  <th className="px-3 py-2 font-medium">Запуски / Ошибки</th>
                  <th className="px-3 py-2 text-right font-medium">Действия</th>
                </tr>
              </thead>
              <tbody>
                {runners.map((runner) => (
                  <tr
                    key={runner.id}
                    className={`border-b border-ink-100 align-top transition-colors hover:bg-ink-50 ${
                      runner.running ? "bg-sky-500/5" : ""
                    }`}
                  >
                    <td className="max-w-[280px] px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        {runner.running ? (
                          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-sky-500/15">
                            <span className="h-2 w-2 animate-pulse rounded-full bg-sky-400" />
                          </span>
                        ) : (
                          <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-ink-100">
                            <span className="h-2 w-2 rounded-full bg-ink-400" />
                          </span>
                        )}
                        <div className="min-w-0">
                          <div className="truncate text-[12px] font-medium text-ink-950">
                            {runner.name}
                            {runner.enabled === false && (
                              <span className="ml-1.5 rounded bg-ink-100 px-1 py-0.5 text-[9px] text-ink-500">
                                выкл
                              </span>
                            )}
                          </div>
                          <div
                            className="mt-0.5 truncate text-[10px] text-ink-500"
                            title={runner.prompt}
                          >
                            {runner.prompt}
                          </div>
                          {runner.stats?.lastMessage && (
                            <div className="mt-0.5 flex items-center gap-1 truncate text-[10px] theme-accent-soft">
                              <MessageSquare className="h-2.5 w-2.5 shrink-0" />
                              {runner.stats.lastMessage}
                            </div>
                          )}
                        </div>
                      </div>
                    </td>
                    <td className="max-w-[140px] px-3 py-2.5">
                      <div className="truncate text-[11px] text-ink-700" title={runner.modelId}>
                        {modelLabel(runner.modelId)}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1 text-[11px] text-ink-700">
                        {runner.trigger?.type === "interval" ? (
                          <>
                            <Timer className="h-3 w-3 text-ink-400" />
                            {triggerLabel(runner)}
                          </>
                        ) : (
                          <span className="text-ink-500">вручную</span>
                        )}
                      </div>
                      <div className="mt-0.5 text-[9px] text-ink-400">
                        повторов при сбое: {runner.maxRetries ?? 2}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex flex-col gap-0.5">
                        <span className={`text-[11px] font-medium ${statusClass(runner.lastStatus)}`}>
                          {runner.running ? "работает…" : statusLabel(runner.lastStatus)}
                        </span>
                        {runner.queued && (
                          <span className="text-[10px] text-amber-500">+ в очереди</span>
                        )}
                        {runner.lastError && (
                          <span
                            className="max-w-[160px] truncate text-[9px] text-rose-400"
                            title={runner.lastError}
                          >
                            {runner.lastError}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-[10px] text-ink-600">
                      {runner.running ? (
                        <span className="text-sky-500">{formatWhen(runner.lastRunAt)}</span>
                      ) : (
                        formatWhen(runner.lastRunAt)
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-[10px] text-ink-600">
                      {runner.enabled === false || !runner.nextRunAt ? (
                        "—"
                      ) : (
                        <span className="flex items-center gap-1">
                          <Clock className="h-3 w-3 text-ink-400" />
                          {formatWhen(runner.nextRunAt)}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="text-[11px] text-ink-700">
                        {runner.stats?.totalRuns || 0}
                        <span className="mx-1 text-ink-300">/</span>
                        <span className={runner.stats?.totalErrors ? "text-rose-500" : "text-ink-500"}>
                          {runner.stats?.totalErrors || 0}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center justify-end gap-0.5">
                        {runner.running ? (
                          <button
                            type="button"
                            onClick={() => void handleStop(runner)}
                            className="grid h-7 w-7 place-items-center rounded-md text-rose-500 hover:bg-rose-500/10"
                            title="Остановить"
                          >
                            {busyId === runner.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Square className="h-3.5 w-3.5" />
                            )}
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => void handleRun(runner)}
                            className="grid h-7 w-7 place-items-center rounded-md text-emerald-500 hover:bg-emerald-500/10"
                            title="Запустить сейчас"
                          >
                            {busyId === runner.id ? (
                              <Loader2 className="h-3.5 w-3.5 animate-spin" />
                            ) : (
                              <Play className="h-3.5 w-3.5" />
                            )}
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => onSendToRunner?.(runner.id)}
                          className="grid h-7 w-7 place-items-center rounded-md text-accent hover:bg-accent-muted"
                          title="Отправить запрос (Ctrl+R)"
                        >
                          <Send className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => openReports(runner)}
                          className="grid h-7 w-7 place-items-center rounded-md text-ink-500 hover:bg-ink-100"
                          title="Отчёты ранера"
                        >
                          <FileText className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => setEditor({ mode: "edit", runner })}
                          className="grid h-7 w-7 place-items-center rounded-md text-ink-500 hover:bg-ink-100"
                          title="Изменить"
                        >
                          <Pencil className="h-3.5 w-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleToggleEnabled(runner)}
                          className="grid h-7 w-7 place-items-center rounded-md text-ink-500 hover:bg-ink-100"
                          title={runner.enabled ? "Выключить" : "Включить"}
                        >
                          {runner.enabled ? (
                            <Power className="h-3.5 w-3.5" />
                          ) : (
                            <PowerOff className="h-3.5 w-3.5" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleDelete(runner)}
                          className="grid h-7 w-7 place-items-center rounded-md text-ink-500 hover:bg-rose-500/10 hover:text-rose-500"
                          title="Удалить"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : (
          <div className="flex h-full min-h-0 flex-col">
            <div className="flex items-center gap-2 border-b border-ink-200 px-4 py-2">
              <button
                type="button"
                onClick={() => setTab("runners")}
                className="flex h-7 items-center gap-1 rounded-md border border-ink-300 px-2 text-[10px] text-ink-700 hover:bg-ink-100"
              >
                <ChevronLeft className="h-3 w-3" />
                Ранеры
              </button>
              <div className="min-w-0 flex-1">
                <select
                  value={selectedRunnerId || ""}
                  onChange={(event) => {
                    const id = event.target.value;
                    if (id) {
                      setSelectedRunnerId(id);
                      setSelectedReport(null);
                    }
                  }}
                  className="theme-input h-7 max-w-[300px] rounded-md px-2 text-[11px] outline-none"
                >
                  {runners.map((runner) => (
                    <option key={runner.id} value={runner.id}>
                      {runner.name}
                    </option>
                  ))}
                </select>
              </div>
              <button
                type="button"
                onClick={() => selectedRunnerId && void loadReports(selectedRunnerId)}
                className="grid h-7 w-7 place-items-center rounded-md text-ink-500 hover:bg-ink-100"
                title="Обновить отчёты"
              >
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            </div>
            {reportsLoading ? (
              <div className="flex items-center justify-center gap-2 p-8 text-[12px] text-ink-500">
                <Loader2 className="h-4 w-4 animate-spin" /> Загрузка отчётов…
              </div>
            ) : reports.length === 0 ? (
              <div className="p-10 text-center text-[12px] text-ink-500">
                {selectedRunner
                  ? `У ранера «${selectedRunner.name}» пока нет отчётов`
                  : "Выберите ранера, чтобы увидеть его отчёты"}
              </div>
            ) : (
              <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
                <div className="min-h-0 flex-1 overflow-auto border-r border-ink-200 lg:max-w-[46%]">
                  {reports.map((report) => (
                    <button
                      key={report.id}
                      type="button"
                      onClick={() => void handleOpenReport(report)}
                      className={`block w-full border-b border-ink-100 px-4 py-2.5 text-left transition-colors hover:bg-ink-50 ${
                        selectedReport?.id === report.id ? "bg-accent-muted" : ""
                      }`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className={`text-[11px] font-medium ${statusClass(report.status)}`}>
                          {statusLabel(report.status)}
                        </span>
                        <span className="text-[9px] text-ink-400">
                          {report.trigger === "interval"
                            ? "интервал"
                            : report.trigger === "queued"
                              ? "очередь"
                              : "запрос"}
                        </span>
                      </div>
                      {report.message && (
                        <div className="mt-0.5 flex items-center gap-1 truncate text-[10px] text-accent">
                          <MessageSquare className="h-2.5 w-2.5 shrink-0" />
                          {report.message}
                        </div>
                      )}
                      <div className="mt-0.5 line-clamp-2 text-[10px] text-ink-600">
                        {report.summary || "(пустой отчёт)"}
                      </div>
                      <div className="mt-1 flex items-center gap-2 text-[9px] text-ink-400">
                        <span>{formatWhen(report.startedAt)}</span>
                        {report.finishedAt ? (
                          <span>· {formatDuration(report.finishedAt - report.startedAt)}</span>
                        ) : (
                          <span className="text-sky-500">· идёт…</span>
                        )}
                        <span>· инструментов: {report.toolCount || 0}</span>
                      </div>
                    </button>
                  ))}
                </div>
                <div className="min-h-0 flex-1 overflow-auto">
                  {selectedReport ? (
                    <div className="p-4">
                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className={`text-[12px] font-semibold ${statusClass(selectedReport.status)}`}>
                            {statusLabel(selectedReport.status)}
                          </span>
                          <span className="text-[10px] text-ink-400">
                            {formatWhen(selectedReport.startedAt)} → {formatWhen(selectedReport.finishedAt)}
                          </span>
                        </div>
                        <span className="rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[9px] text-ink-500">
                          {selectedReport.modelName || selectedReport.modelId || ""}
                        </span>
                      </div>
                      {selectedReport.message && (
                        <div className="mt-2 flex items-start gap-1.5 rounded-md border border-accent-muted bg-accent-muted px-2 py-1.5 text-[11px] text-accent">
                          <MessageSquare className="mt-0.5 h-3 w-3 shrink-0" />
                          Запрос: {selectedReport.message}
                        </div>
                      )}
                      {selectedReport.error && (
                        <div className="mt-2 flex items-start gap-1.5 rounded-md border border-status-err-border bg-status-err-bg px-2 py-1.5 text-[11px] text-status-err">
                          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
                          <span className="whitespace-pre-wrap">{selectedReport.error}</span>
                        </div>
                      )}
                      {selectedReport.summary && (
                        <div className="mt-3 rounded-md border border-ink-200 bg-ink-50 px-3 py-2 text-[11px] text-ink-700">
                          {selectedReport.summary}
                        </div>
                      )}
                      {selectedReport.text && (
                        <pre className="mt-3 whitespace-pre-wrap rounded-md border border-ink-200 bg-ink-100 p-3 font-mono text-[11px] leading-relaxed text-ink-800">
                          {selectedReport.text}
                        </pre>
                      )}
                      {selectedReport.toolSteps && selectedReport.toolSteps.length > 0 && (
                        <div className="mt-4">
                          <div className="text-[10px] font-medium uppercase tracking-wide text-ink-500">
                            Инструменты ({selectedReport.toolSteps.length})
                          </div>
                          <div className="mt-1.5 space-y-1">
                            {selectedReport.toolSteps.map((step, index) => (
                              <div
                                key={`${step.at || index}-${index}`}
                                className="flex items-center gap-2 rounded-md border border-ink-200 px-2 py-1 text-[10px]"
                              >
                                <span
                                  className={`shrink-0 font-medium ${
                                    step.type === "tool_start" ? "text-sky-500" : "text-emerald-500"
                                  }`}
                                >
                                  {step.type === "tool_start" ? "→" : "✓"}
                                </span>
                                <span className="shrink-0 rounded bg-ink-100 px-1.5 py-0.5 font-mono text-[9px] text-ink-700">
                                  {step.name}
                                </span>
                                {step.label && <span className="truncate text-ink-500">{step.label}</span>}
                                {step.error && (
                                  <span className="ml-auto truncate text-rose-400">{step.error}</span>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      <div className="mt-4 flex justify-end">
                        <button
                          type="button"
                          onClick={() => {
                            if (selectedReport && window.confirm("Удалить этот отчёт?")) {
                              void window.lopster?.deleteRunnerReport(
                                selectedReport.runnerId,
                                selectedReport.id
                              );
                              setSelectedReport(null);
                            }
                          }}
                          className="flex h-7 items-center gap-1 rounded-md border border-ink-300 px-2 text-[10px] text-ink-600 hover:bg-rose-500/10 hover:text-rose-500"
                        >
                          <Trash2 className="h-3 w-3" />
                          Удалить отчёт
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="p-10 text-center text-[12px] text-ink-500">
                      Выберите отчёт слева
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {editor && <RunnerEditorModal
        editor={editor}
        models={providerConfig.models}
        modelLabel={modelLabel}
        rootPath={rootPath}
        projectName={projectName}
        onClose={() => setEditor(null)}
        onSave={handleSaveEditor}
        onToast={showToast}
      />}
    </div>
  );
};

type EditorModalProps = {
  editor: NonNullable<EditorState>;
  models: AIModel[];
  modelLabel: (id: string) => string;
  rootPath?: string | null;
  projectName?: string | null;
  onClose: () => void;
  onSave: (form: typeof emptyForm) => Promise<void> | void;
  onToast: (text: string) => void;
};

const RunnerEditorModal: React.FC<EditorModalProps> = ({
  editor,
  models,
  modelLabel,
  rootPath,
  projectName,
  onClose,
  onSave,
  onToast,
}) => {
  const editing = editor.mode === "edit" ? editor.runner : null;
  const [form, setForm] = useState(() => ({
    name: editing?.name || "",
    prompt: editing?.prompt || "",
    modelId: editing?.modelId || (models[0]?.id || ""),
    triggerType: editing?.trigger?.type === "off" ? ("off" as const) : ("interval" as const),
    intervalMinutes: editing?.trigger?.type === "interval" ? editing.trigger.intervalMinutes : 60,
    maxRetries: editing?.maxRetries ?? 2,
    enabled: editing?.enabled !== false,
    useCurrentFolder: Boolean(editing?.rootPath) || Boolean(rootPath),
  }));

  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(form);
    } finally {
      setSaving(false);
    }
  };

  const set = <K extends keyof typeof emptyForm>(key: K, value: (typeof emptyForm)[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  return (
    <div
      className="fixed inset-0 z-[80] flex items-start justify-center theme-scrim p-6 animate-fade-in"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="theme-panel mt-10 flex max-h-[85vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl shadow-modal">
        <div className="flex items-center justify-between border-b border-ink-200 px-4 py-3">
          <div className="flex items-center gap-2 text-[13px] font-medium text-ink-950">
            <Satellite className="h-4 w-4 text-accent" />
            {editing ? `Изменить ранера · ${editing.name}` : "Новый ранер"}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid h-7 w-7 place-items-center rounded-md text-ink-500 hover:bg-ink-100"
            aria-label="Закрыть"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-auto px-4 py-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-[10px] font-medium uppercase tracking-wide text-ink-500">
                Название
              </label>
              <input
                value={form.name}
                onChange={(event) => set("name", event.target.value)}
                placeholder="Мой ранер"
                className="theme-input h-9 w-full rounded-md px-2 text-[12px] outline-none"
              />
            </div>
            <div className="space-y-1">
              <label className="text-[10px] font-medium uppercase tracking-wide text-ink-500">
                Модель
              </label>
              <select
                value={form.modelId}
                onChange={(event) => set("modelId", event.target.value)}
                className="theme-input h-9 w-full rounded-md px-2 text-[12px] outline-none"
              >
                {models.length === 0 && <option value="">— модели не настроены —</option>}
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.name || model.id}
                  </option>
                ))}
              </select>
              {models.length === 0 && (
                <div className="text-[10px] text-rose-500">
                  Сначала добавьте провайдера и модель в настройках
                </div>
              )}
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[10px] font-medium uppercase tracking-wide text-ink-500">
              Промт — задача ранера
            </label>
            <textarea
              value={form.prompt}
              onChange={(event) => set("prompt", event.target.value)}
              rows={6}
              placeholder={"Опиши задачу, которую ранер выполняет бесконечно.\nНапример: каждые 30 минут проверяй новости по теме X, сохраняй отчёт в reports/news.md и пиши сводку."}
              className="theme-input w-full resize-y rounded-md px-2 py-2 font-mono text-[11px] outline-none placeholder:text-ink-500"
            />
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div className="space-y-1">
              <label className="text-[10px] font-medium uppercase tracking-wide text-ink-500">
                Триггер
              </label>
              <select
                value={form.triggerType}
                onChange={(event) => set("triggerType", event.target.value as "interval" | "off")}
                className="theme-input h-9 w-full rounded-md px-2 text-[12px] outline-none"
              >
                <option value="interval">по интервалу</option>
                <option value="off">вручную</option>
              </select>
            </div>
            {form.triggerType === "interval" ? (
              <div className="space-y-1">
                <label className="text-[10px] font-medium uppercase tracking-wide text-ink-500">
                  Интервал, мин
                </label>
                <input
                  type="number"
                  min={1}
                  max={43200}
                  value={form.intervalMinutes}
                  onChange={(event) => set("intervalMinutes", Math.max(1, Number(event.target.value) || 1))}
                  className="theme-input h-9 w-full rounded-md px-2 text-[12px] outline-none"
                />
              </div>
            ) : (
              <div className="flex items-end pb-2 text-[10px] text-ink-400">
                запуск только по запросу (Ctrl+R)
              </div>
            )}
            <div className="space-y-1">
              <label className="text-[10px] font-medium uppercase tracking-wide text-ink-500">
                Повторы при сбое
              </label>
              <input
                type="number"
                min={0}
                max={5}
                value={form.maxRetries}
                onChange={(event) => set("maxRetries", Math.max(0, Math.min(5, Number(event.target.value) || 0)))}
                className="theme-input h-9 w-full rounded-md px-2 text-[12px] outline-none"
              />
            </div>
            <div className="flex items-end">
              <label className="flex h-9 cursor-pointer items-center gap-2 rounded-md border border-ink-300 px-2 text-[11px] text-ink-700">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(event) => set("enabled", event.target.checked)}
                  className="h-3.5 w-3.5 accent-accent"
                />
                Включён
              </label>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-[10px] font-medium uppercase tracking-wide text-ink-500">
              Рабочая папка
            </label>
            <label className="flex items-center gap-2 rounded-md border border-ink-200 bg-ink-50 px-2 py-1.5 text-[11px] text-ink-700">
              <input
                type="checkbox"
                checked={form.useCurrentFolder}
                onChange={(event) => set("useCurrentFolder", event.target.checked)}
                className="h-3.5 w-3.5 accent-accent"
              />
              <FolderOpen className="h-3.5 w-3.5 text-ink-400" />
              <span className="truncate">
                {form.useCurrentFolder && rootPath
                  ? shortPath(rootPath, 70)
                  : projectName
                    ? projectName
                    : "Текущая открытая папка"}
              </span>
            </label>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-ink-200 px-4 py-3">
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-md border border-ink-300 px-3 text-[11px] text-ink-700 hover:bg-ink-100"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={() => void handleSave()}
            disabled={saving || !form.prompt.trim() || !form.modelId}
            className="theme-primary inline-flex h-8 items-center gap-1.5 rounded-md px-4 text-[11px] font-medium disabled:cursor-not-allowed disabled:opacity-40"
          >
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
            {editing ? "Сохранить" : "Создать"}
          </button>
        </div>
      </div>
    </div>
  );
};

export default RunnerWorkspace;
