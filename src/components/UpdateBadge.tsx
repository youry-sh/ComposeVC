import React, { useCallback, useEffect, useRef, useState } from "react";
import { AlertTriangle, ArrowUpCircle, Download, RefreshCw, RotateCw, X } from "lucide-react";

interface UpdateState {
  status: string;
  currentVersion?: string;
  version?: string | null;
  percent?: number;
  transferred?: number;
  total?: number;
  bytesPerSecond?: number;
  releaseNotes?: string;
  error?: string | null;
  repo?: string;
  checkedAt?: number | null;
  hasToken?: boolean;
}

const PANEL_WIDTH = 332;

function mb(bytes?: number) {
  const n = Number(bytes) || 0;
  if (!n) return "0 МБ";
  return `${(n / (1024 * 1024)).toFixed(n > 100 * 1024 * 1024 ? 0 : 1)} МБ`;
}

/**
 * Update trigger in the title bar + popover panel with release info and a
 * one-click install (silent NSIS update, app relaunches by itself).
 */
export default function UpdateBadge() {
  const [state, setState] = useState<UpdateState | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 40, right: 12 });
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Set when the user presses "Скачать и обновить": once the download finishes,
  // the install+restart runs by itself (consent was already given by the click).
  const autoInstallRef = useRef(false);

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

  // User already agreed ("Скачать и обновить") → install + relaunch as soon as
  // the download finishes. Without that click nothing is downloaded or applied.
  useEffect(() => {
    const status = state?.status;
    if (status === "downloaded" && autoInstallRef.current) {
      autoInstallRef.current = false;
      setBusy(true);
      Promise.resolve(window.lopster?.updateInstall())
        .catch(() => {})
        .finally(() => setBusy(false));
      return;
    }
    if (status === "error" || status === "idle") autoInstallRef.current = false;
  }, [state?.status]);

  const refreshPosition = useCallback(() => {
    const el = btnRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const right = Math.max(8, Math.round(window.innerWidth - rect.right));
    const maxRight = Math.max(8, window.innerWidth - PANEL_WIDTH - 8);
    setPos({ top: Math.round(rect.bottom + 6), right: Math.min(right, maxRight) });
  }, []);

  useEffect(() => {
    if (!open) return;
    refreshPosition();
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (panelRef.current?.contains(target)) return;
      if (btnRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", refreshPosition);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", refreshPosition);
    };
  }, [open, refreshPosition]);

  const run = (fn: () => Promise<unknown> | undefined) => {
    if (busy) return;
    setBusy(true);
    Promise.resolve()
      .then(fn)
      .catch(() => {})
      .finally(() => setBusy(false));
  };

  const status = state?.status || "idle";
  const pct = Math.max(0, Math.min(100, Math.round(Number(state?.percent) || 0)));
  const version = state?.version || "";
  const currentVersion = state?.currentVersion || "";

  const tone =
    status === "downloaded"
      ? "is-ready"
      : status === "error"
        ? "is-error"
        : status === "available"
          ? "is-available"
          : status === "downloading"
            ? "is-busy"
            : status === "checking"
              ? "is-checking"
              : "is-idle";

  const label =
    status === "downloaded"
      ? `Обновить${version ? ` ${version}` : ""}`
      : status === "downloading"
        ? `${pct}%`
        : status === "available"
          ? `v${version || "new"}`
          : "";

  const badgeTitle =
    status === "downloaded"
      ? `Обновление ${version} готово — установить и перезапустить`
      : status === "downloading"
        ? `Загрузка обновления${version ? ` ${version}` : ""}: ${pct}%`
        : status === "available"
          ? `Доступно обновление ${version}`
          : status === "error"
            ? `Обновление: ${state?.error || "ошибка"}`
            : "Обновления ComposeVC";

  const icon =
    status === "downloaded" ? (
      <RotateCw className="titlebar-update-ico" />
    ) : status === "downloading" ? (
      <Download className="titlebar-update-ico" />
    ) : status === "available" ? (
      <ArrowUpCircle className="titlebar-update-ico" />
    ) : status === "checking" ? (
      <RefreshCw className="titlebar-update-ico titlebar-update-spin" />
    ) : status === "error" ? (
      <AlertTriangle className="titlebar-update-ico" />
    ) : (
      <ArrowUpCircle className="titlebar-update-ico" />
    );

  const primary = () => {
    if (busy) return;
    if (status === "downloaded") {
      run(() => window.lopster?.updateInstall());
      return;
    }
    if (status === "available") {
      autoInstallRef.current = true;
      run(() => window.lopster?.updateDownload());
      return;
    }
    run(() => window.lopster?.updateCheck());
  };

  const primaryLabel =
    status === "downloaded"
      ? "Обновить и перезапустить"
      : status === "available"
        ? "Скачать и обновить"
        : status === "downloading"
          ? "Загрузка…"
          : status === "checking"
            ? "Проверяем…"
            : "Проверить обновления";

  return (
    <div className="titlebar-update-wrap">
      <button
        ref={btnRef}
        type="button"
        className={`titlebar-update ${tone}`}
        title={badgeTitle}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {icon}
        {label ? <span className="titlebar-update-label">{label}</span> : null}
        {status === "downloaded" ? <span className="titlebar-update-dot" aria-hidden /> : null}
        {status === "downloading" ? (
          <span className="titlebar-update-track" aria-hidden>
            <i style={{ width: `${pct}%` }} />
          </span>
        ) : null}
      </button>

      {open ? (
        <div
          ref={panelRef}
          className="titlebar-update-panel"
          role="dialog"
          aria-label="Обновления ComposeVC"
          style={{ top: pos.top, right: pos.right }}
        >
          <div className="titlebar-update-head">
            <span className="titlebar-update-title">ОБНОВЛЕНИЯ</span>
            <button type="button" className="titlebar-update-close" aria-label="Закрыть" onClick={() => setOpen(false)}>
              <X className="w-3 h-3" />
            </button>
          </div>

          <div className="titlebar-update-current">
            Установлено: <b>{currentVersion || "—"}</b>
          </div>

          <div className="titlebar-update-body">
            {status === "dev" ? (
              <p className="titlebar-update-text">
                Автообновление работает в установленной версии. В dev-режиме проверка отключена.
              </p>
            ) : null}

            {status === "checking" ? (
              <p className="titlebar-update-text">Проверяем обновления…</p>
            ) : null}

            {status === "up-to-date" ? (
              <p className="titlebar-update-text">Установлена последняя версия.</p>
            ) : null}

            {status === "available" ? (
              <p className="titlebar-update-text">
                Доступна версия <b>{version}</b>. Без вашего согласия ничего не скачивается — нажмите
                «Скачать и обновить».
              </p>
            ) : null}

            {status === "downloading" ? (
              <>
                <p className="titlebar-update-text">
                  Загрузка <b>{version}</b> — {pct}%
                </p>
                <div className="titlebar-update-bar" aria-hidden>
                  <i style={{ width: `${pct}%` }} />
                </div>
                <div className="titlebar-update-meta">
                  {mb(state?.transferred)} / {mb(state?.total)}
                </div>
              </>
            ) : null}

            {status === "downloaded" ? (
              <>
                <p className="titlebar-update-text">
                  Версия <b>{version}</b> загружена. Приложение закроется, установит обновление и откроется снова.
                </p>
                {state?.releaseNotes ? (
                  <p className="titlebar-update-notes">{state.releaseNotes}</p>
                ) : null}
              </>
            ) : null}

            {status === "error" ? (
              <p className="titlebar-update-text is-error">{state?.error || "Не удалось получить обновление."}</p>
            ) : null}

            {status === "idle" ? <p className="titlebar-update-text">Проверьте наличие новой версии.</p> : null}
          </div>

          <div className="titlebar-update-actions">
            <button
              type="button"
              className="titlebar-update-btn is-primary"
              disabled={busy || status === "downloading" || status === "checking" || status === "dev"}
              onClick={primary}
            >
              {primaryLabel}
            </button>
            <button
              type="button"
              className="titlebar-update-btn"
              onClick={() => window.lopster?.updateOpenRelease()}
            >
              Что нового
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

