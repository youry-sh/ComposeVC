import React, { useCallback, useEffect, useMemo, useState } from "react";
import type { Translation } from "../i18n";
import {
  IcoAlertTriangle,
  IcoBlender,
  IcoCheckCircle,
  IcoDownload,
  IcoGit,
  IcoGo,
  IcoPython,
  IcoRust,
  IcoWebSearch,
} from "./topIcons";

/**
 * Setup tab — installs the runtimes/tools the agent needs.
 *
 * The renderer is intentionally dumb: it renders `SetupComponent[]` from
 * `setup:scan`, streams `setup:progress` into cards, and calls
 * `setup:install` / `setup:cancel`. Every platform decision (winget vs
 * apt-get vs brew, downloads, sudo) happens in the main process.
 */

type SetupSettingsProps = {
  labels: Translation;
};

type Notice = { kind: "ok" | "err"; text: string };

const ICONS: Record<SetupComponentIcon, React.FC<{ className?: string }>> = {
  python: IcoPython,
  git: IcoGit,
  blender: IcoBlender,
  go: IcoGo,
  rust: IcoRust,
  search: IcoWebSearch,
};

const PLATFORM_LABEL: Record<SetupPlatform, string> = {
  win: "Windows",
  linux: "Linux",
  mac: "macOS",
};

const ACTIVE_STATES = new Set<SetupProgressState>(["checking", "downloading", "installing"]);
const STEPS: Array<{ state: SetupProgressState; label: string }> = [
  { state: "checking", label: "Проверка" },
  { state: "installing", label: "Установка" },
  { state: "done", label: "Готово" },
];

function errText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stepIndex(state: SetupProgressState | undefined): number {
  if (state === "downloading") return 1;
  const index = STEPS.findIndex((step) => step.state === state);
  return index < 0 ? 0 : index;
}

const SetupCard: React.FC<{
  component: SetupComponent;
  progress?: SetupProgress;
  disabled: boolean;
  onInstall: (id: SetupComponentId) => void;
  onCancel: (id: SetupComponentId) => void;
  onManual: (id: SetupComponentId) => void;
}> = ({ component, progress, disabled, onInstall, onCancel, onManual }) => {
  const Icon = ICONS[component.icon] || IcoDownload;
  const state = progress?.state;
  const active = Boolean(state && ACTIVE_STATES.has(state));
  const isInstalled = component.installed || state === "already" || state === "done";
  const version = progress?.version || component.version;
  const errorText = (state === "error" ? progress?.error : null) || component.lastError || null;
  const log = (progress?.log || []).slice(-5);
  const percent = typeof progress?.percent === "number" ? progress.percent : null;
  const currentStep = stepIndex(state);

  return (
    <div className="settings-card flex h-full min-w-0 flex-col">
      <div className="flex items-start gap-2">
        <span className="settings-header-mark shrink-0" style={{ width: 24, height: 24 }}>
          <Icon className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <div className="settings-card-title !mb-0 truncate">{component.name}</div>
            {isInstalled ? <IcoCheckCircle className="h-3 w-3 shrink-0" style={{ color: "var(--ok)" }} /> : null}
          </div>
          <p
            className="mt-1 overflow-hidden text-[11px] leading-snug text-ink-500"
            style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical" }}
          >
            {component.blurb}
          </p>
        </div>
      </div>

      <div className="mt-2 min-w-0">
        {component.dependsOn.length > 0 ? (
          <p className="truncate font-mono text-[10px] leading-snug text-ink-500">
            Зависимости: {component.dependsOn.join(", ")}
          </p>
        ) : null}
        {isInstalled ? (
          <p className="truncate font-mono text-[10px] leading-snug text-ink-600" title={component.path || undefined}>
            {component.path || "путь не определён"}
          </p>
        ) : null}
      </div>

      {active ? (
        <div className="mt-2 min-w-0 border-t pt-2" style={{ borderColor: "var(--border)" }}>
          <div className="flex items-center gap-1.5 font-mono text-[10px]">
            {STEPS.map((step, index) => {
              const done = index < currentStep || state === "done";
              const current = index === currentStep && state !== "done";
              return (
                <React.Fragment key={step.state}>
                  {index > 0 ? <span className="text-ink-400">→</span> : null}
                  <span
                    className={done ? "text-ink-800" : current ? "text-ink-950" : "text-ink-500"}
                    style={current ? { color: "var(--accent)" } : undefined}
                  >
                    {step.label}
                  </span>
                </React.Fragment>
              );
            })}
            {percent !== null ? <span className="ml-auto text-ink-600">{percent}%</span> : null}
          </div>
          {log.length > 0 ? (
            <pre
              className="scrollbar-thin mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-all rounded-sm px-1.5 py-1 font-mono text-[10px] leading-[1.45] text-ink-600"
              style={{ backgroundColor: "var(--input-bg)" }}
            >
              {log.join("\n")}
            </pre>
          ) : null}
        </div>
      ) : null}

      {!active && errorText ? (
        <div className="mt-2 min-w-0 border-t pt-2" style={{ borderColor: "var(--border)" }}>
          <p
            className="scrollbar-thin max-h-24 overflow-auto whitespace-pre-line font-mono text-[10px] leading-snug"
            style={{ color: "var(--danger)" }}
          >
            {errorText}
          </p>
          <div className="mt-1 flex justify-end">
            <button
              type="button"
              className="settings-chip whitespace-nowrap"
              disabled={disabled}
              onClick={() => onManual(component.id)}
            >
              Скачать вручную
            </button>
          </div>
        </div>
      ) : null}

      <div className="mt-auto flex items-center gap-2 pt-2">
        {active ? (
          <span
            className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-500"
            title={progress?.step}
          >
            {`${percent !== null ? `${percent}% · ` : ""}${progress?.step || "…"}`}
          </span>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {isInstalled ? (
            <button
              type="button"
              disabled
              title={component.path || undefined}
              className="settings-chip is-active inline-flex items-center gap-1 whitespace-nowrap"
            >
              <IcoCheckCircle className="h-3 w-3" />
              {`Уже установлено${version ? ` · v${version}` : ""}`}
            </button>
          ) : active ? (
            <button
              type="button"
              className="settings-chip whitespace-nowrap"
              style={{ color: "var(--danger)" }}
              onClick={() => onCancel(component.id)}
            >
              Отмена
            </button>
          ) : (
            <button
              type="button"
              className="ui-btn-primary h-7 whitespace-nowrap px-2.5 text-[11px]"
              disabled={disabled}
              onClick={() => onInstall(component.id)}
            >
              Скачать и установить
            </button>
          )}
        </div>
      </div>
    </div>
  );
};

export const SetupSettings: React.FC<SetupSettingsProps> = () => {
  const [components, setComponents] = useState<SetupComponent[]>([]);
  const [platform, setPlatform] = useState<SetupPlatform>("win");
  const [progress, setProgress] = useState<Partial<Record<SetupComponentId, SetupProgress>>>({});
  const [loading, setLoading] = useState(true);
  const [scanning, setScanning] = useState(false);
  const [installingAll, setInstallingAll] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  const supported = typeof window !== "undefined" && typeof window.lopster?.setupScan === "function";

  const scan = useCallback(async (showSpinner: boolean) => {
    if (!window.lopster?.setupScan) return;
    if (showSpinner) setScanning(true);
    try {
      const res = await window.lopster.setupScan();
      if (!res) return;
      if (res.ok) {
        setComponents(Array.isArray(res.components) ? res.components : []);
        if (res.platform) setPlatform(res.platform);
        if (res.active) setProgress((prev) => ({ ...prev, ...res.active }));
      } else {
        setNotice({ kind: "err", text: res.error || "Не удалось проверить компоненты" });
      }
    } catch (error) {
      setNotice({ kind: "err", text: errText(error) });
    } finally {
      if (showSpinner) setScanning(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await scan(false);
      if (!cancelled) setLoading(false);
    })();

    const unsubscribe = window.lopster?.onSetupProgress?.((event) => {
      if (!event || !event.id) return;
      setProgress((prev) => ({ ...prev, [event.id]: event }));
      if (event.state === "done" || event.state === "already") {
        setComponents((prev) =>
          prev.map((component) =>
            component.id === event.id
              ? {
                  ...component,
                  installed: true,
                  version: event.version ?? component.version,
                  path: event.path ?? component.path,
                  lastError: null,
                }
              : component
          )
        );
      } else if (event.state === "error") {
        setComponents((prev) =>
          prev.map((component) =>
            component.id === event.id ? { ...component, lastError: event.error || component.lastError } : component
          )
        );
      }
    });

    return () => {
      cancelled = true;
      if (typeof unsubscribe === "function") unsubscribe();
    };
  }, [scan]);

  const install = useCallback(
    async (id: SetupComponentId) => {
      const name = components.find((component) => component.id === id)?.name || id;
      setNotice(null);
      setProgress((prev) => ({ ...prev, [id]: { id, state: "checking", step: "Проверка…", log: [] } }));
      try {
        const res = await window.lopster?.setupInstall(id);
        if (!res) return;
        if (res.ok && res.alreadyInstalled) {
          setComponents((prev) =>
            prev.map((component) =>
              component.id === id
                ? { ...component, installed: true, version: res.version ?? component.version, path: res.path ?? component.path }
                : component
            )
          );
          setNotice({ kind: "ok", text: `${name} уже установлен${res.version ? ` · v${res.version}` : ""}` });
        } else if (res.ok) {
          setComponents((prev) =>
            prev.map((component) =>
              component.id === id
                ? {
                    ...component,
                    installed: true,
                    version: res.version ?? component.version,
                    path: res.path ?? component.path,
                    method: res.method ?? component.method,
                    lastError: null,
                  }
                : component
            )
          );
          setNotice({ kind: "ok", text: `Установлено: ${name}${res.version ? ` · v${res.version}` : ""}` });
        } else {
          const message = res.error || "Установка не завершилась";
          setProgress((prev) => ({
            ...prev,
            [id]: {
              id,
              state: res.cancelled ? "idle" : "error",
              step: res.cancelled ? "Установка отменена" : "Установка не завершилась",
              log: res.log || prev[id]?.log || [],
              error: res.cancelled ? null : message,
            },
          }));
          if (!res.cancelled) setNotice({ kind: "err", text: `${name}: ${message}` });
        }
      } catch (error) {
        setProgress((prev) => ({
          ...prev,
          [id]: { id, state: "error", step: "Ошибка", log: [], error: errText(error) },
        }));
        setNotice({ kind: "err", text: `${name}: ${errText(error)}` });
      } finally {
        void scan(false);
      }
    },
    [components, scan]
  );

  const cancel = useCallback(async (id: SetupComponentId) => {
    try {
      const res = await window.lopster?.setupCancel(id);
      if (res && !res.ok) setNotice({ kind: "err", text: res.error || "Не удалось отменить установку" });
    } catch (error) {
      setNotice({ kind: "err", text: errText(error) });
    }
  }, []);

  const installAll = useCallback(async () => {
    setInstallingAll(true);
    setNotice(null);
    try {
      const res = await window.lopster?.setupInstallAll();
      if (!res) return;
      if (!res.ok) {
        const failed = (res.results || []).filter((entry) => !entry.ok && !entry.alreadyInstalled);
        const names = failed
          .map((entry) => components.find((component) => component.id === entry.id)?.name || entry.id)
          .filter(Boolean);
        setNotice({
          kind: "err",
          text: res.error || (names.length ? `Не установлено: ${names.join(", ")}` : "Установка не завершилась"),
        });
      } else {
        setNotice({ kind: "ok", text: "Все компоненты установлены" });
      }
    } catch (error) {
      setNotice({ kind: "err", text: errText(error) });
    } finally {
      setInstallingAll(false);
      void scan(false);
    }
  }, [components, scan]);

  const openManual = useCallback(async (id: SetupComponentId) => {
    try {
      const res = await window.lopster?.setupOpenManual(id);
      if (res && !res.ok) setNotice({ kind: "err", text: res.error || "Не удалось открыть страницу загрузки" });
    } catch (error) {
      setNotice({ kind: "err", text: errText(error) });
    }
  }, []);

  const openDownloads = useCallback(async () => {
    try {
      const res = await window.lopster?.setupOpenDownloads();
      if (res && !res.ok) setNotice({ kind: "err", text: res.error || "Не удалось открыть папку загрузок" });
    } catch (error) {
      setNotice({ kind: "err", text: errText(error) });
    }
  }, []);

  const installedCount = useMemo(
    () => components.filter((component) => component.installed).length,
    [components]
  );
  const anyActive = useMemo(
    () => Object.values(progress).some((entry) => Boolean(entry && ACTIVE_STATES.has(entry.state))),
    [progress]
  );

  if (loading) {
    return <div className="settings-empty">Проверка установленных компонентов…</div>;
  }

  return (
    <div className="settings-body-scroll">
      {!supported ? (
        <div className="settings-section">
          <div className="settings-card">
            <div className="flex items-center gap-2">
              <IcoAlertTriangle className="h-4 w-4 shrink-0" style={{ color: "var(--ink-500)" }} />
              <div className="settings-card-title !mb-0">Управление установкой доступно только в приложении</div>
            </div>
            <p className="mt-1 text-[11px] leading-snug text-ink-500">
              Откройте ComposeVC как desktop-приложение: установка запускает системные менеджеры пакетов и не работает в
              браузерной сборке.
            </p>
          </div>
        </div>
      ) : null}

      <div className="settings-section">
        <div className="settings-card">
          <div className="flex flex-wrap items-center gap-2">
            <span className="settings-chip is-active">OS: {PLATFORM_LABEL[platform]}</span>
            <span className="settings-chip" title="Компоненты, найденные в системе">
              {installedCount} / {components.length} установлено
            </span>
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <button
                type="button"
                className="settings-chip"
                disabled={!supported || scanning || anyActive || installingAll}
                onClick={() => {
                  setNotice(null);
                  void scan(true);
                }}
              >
                {scanning ? "Проверка…" : "Проверить снова"}
              </button>
              <button type="button" className="settings-chip" disabled={!supported} onClick={() => void openDownloads()}>
                Открыть папку загрузок
              </button>
              <button
                type="button"
                className="ui-btn-primary h-7 px-3 text-[11px]"
                disabled={!supported || installingAll || anyActive}
                onClick={() => void installAll()}
              >
                {installingAll ? "Установка…" : "Скачать и установить всё"}
              </button>
            </div>
          </div>
          {notice ? (
            <p
              className="mt-2 whitespace-pre-line text-[11px] leading-snug"
              style={{ color: notice.kind === "ok" ? "var(--ok)" : "var(--danger)" }}
            >
              {notice.text}
            </p>
          ) : null}
        </div>
      </div>

      <div className="settings-section">
        <div className="grid auto-rows-fr grid-cols-1 items-stretch gap-2 md:grid-cols-2 lg:grid-cols-3">
          {components.map((component) => (
            <SetupCard
              key={component.id}
              component={component}
              progress={progress[component.id]}
              disabled={!supported}
              onInstall={(id) => void install(id)}
              onCancel={(id) => void cancel(id)}
              onManual={(id) => void openManual(id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

export default SetupSettings;
