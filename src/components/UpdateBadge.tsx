import React, { useEffect, useState } from "react";
import { AlertTriangle, ArrowUpCircle, Download, RefreshCw, RotateCw } from "lucide-react";

interface UpdateState {
  status: string;
  currentVersion?: string;
  version?: string | null;
  percent?: number;
  error?: string | null;
  releaseNotes?: string;
  repo?: string;
}

/**
 * Compact auto-update indicator for the title bar.
 *
 * Silently hidden while idle / up to date. Shows progress while the installer
 * downloads, a one-click "restart to update" once it is ready, and a retry
 * affordance if the GitHub feed is unreachable.
 */
export default function UpdateBadge() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const api = window.lopster;
    if (!api?.updateStatus) return;
    let alive = true;
    api
      .updateStatus()
      .then((next) => {
        if (alive) setState(next as unknown as UpdateState);
      })
      .catch(() => {});
    const off = api.onUpdateStatus?.((next) => {
      if (alive) setState(next as unknown as UpdateState);
    });
    return () => {
      alive = false;
      off?.();
    };
  }, []);

  if (!state) return null;
  const { status } = state;

  const run = (fn: () => Promise<unknown> | undefined) => {
    if (busy) return;
    setBusy(true);
    Promise.resolve()
      .then(fn)
      .catch(() => {})
      .finally(() => setBusy(false));
  };

  if (status === "downloaded") {
    return (
      <button
        type="button"
        className="titlebar-update is-ready"
        title={
          `Обновление${state.version ? ` ${state.version}` : ""} загружено — перезапустить ComposeVC, чтобы установить` +
          (state.releaseNotes ? `\n\n${state.releaseNotes}` : "")
        }
        onClick={() => run(() => window.lopster?.updateInstall())}
      >
        <RotateCw className="titlebar-update-ico" />
        <span className="titlebar-update-label">Обновить{state.version ? ` ${state.version}` : ""}</span>
      </button>
    );
  }

  if (status === "downloading") {
    const pct = Math.max(0, Math.min(100, Math.round(Number(state.percent) || 0)));
    return (
      <div className="titlebar-update is-busy" title={`Загрузка обновления${state.version ? ` ${state.version}` : ""} — ${pct}%`}>
        <Download className="titlebar-update-ico" />
        <span className="titlebar-update-label">{pct}%</span>
        <span className="titlebar-update-track" aria-hidden>
          <i style={{ width: `${pct}%` }} />
        </span>
      </div>
    );
  }

  if (status === "available") {
    return (
      <button
        type="button"
        className="titlebar-update is-available"
        title={`Доступно обновление${state.version ? ` ${state.version}` : ""} — скачать сейчас`}
        onClick={() => run(() => window.lopster?.updateDownload())}
      >
        <ArrowUpCircle className="titlebar-update-ico" />
        <span className="titlebar-update-label">v{state.version || "new"}</span>
      </button>
    );
  }

  if (status === "checking") {
    return (
      <div className="titlebar-update is-checking" title="Проверка обновлений…">
        <RefreshCw className="titlebar-update-ico titlebar-update-spin" />
      </div>
    );
  }

  if (status === "error") {
    return (
      <button
        type="button"
        className="titlebar-update is-error"
        title={`Обновление недоступно: ${state.error || "ошибка"}\nНажмите, чтобы повторить проверку`}
        onClick={() => run(() => window.lopster?.updateCheck())}
      >
        <AlertTriangle className="titlebar-update-ico" />
      </button>
    );
  }

  return null;
}
