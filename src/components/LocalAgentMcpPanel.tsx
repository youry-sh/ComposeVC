import React, { useCallback, useEffect, useState } from "react";
import { Copy, Play, Square, Loader2, RefreshCw, FolderOpen, Eye, EyeOff, Check } from "lucide-react";

type Props = {
  pxBtn: string;
};

const EMPTY_HINT = "оставь ПУСТЫМ";
const ORIGINAL_NAME = "spaces-maui-sessions-samples";

export default function LocalAgentMcpPanel({ pxBtn }: Props) {
  const api = (window as any).lopster;
  const [state, setState] = useState<LocalAgentState | null>(null);
  const [starting, setStarting] = useState(false);
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [showToken, setShowToken] = useState(false);

  const refresh = useCallback(async () => {
    const res = await api?.localAgentStatus?.();
    if (res?.ok && res.state) setState(res.state);
  }, [api]);

  useEffect(() => {
    void refresh();
    const id = window.setInterval(() => void refresh(), 15000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const copy = async (text: string, id: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      /* */
    }
  };

  const start = async () => {
    setStarting(true);
    setError(null);
    const res = await api?.localAgentStart?.();
    if (res?.state) setState(res.state);
    if (!res?.ok) setError(res?.error || "Не удалось запустить");
    setStarting(false);
  };

  const stop = async () => {
    setStopping(true);
    setError(null);
    const res = await api?.localAgentStop?.();
    if (res?.state) setState(res.state);
    setStopping(false);
  };

  const pickDir = async () => {
    const res = await api?.localAgentPickDir?.();
    if (res?.ok) await refresh();
  };

  const c = state?.connector;
  const running = Boolean(state?.running);
  const maskedToken = c?.token ? `${c.token.slice(0, 4)}${"•".repeat(Math.max(0, c.token.length - 8))}${c.token.slice(-4)}` : "";

  const connectorText = c
    ? [
        `Оригинальное название : ${ORIGINAL_NAME}`,
        `Name        : ${c.name}`,
        `URL         : ${c.url}`,
        `Transport   : ${c.transport}`,
        `Auth        : ${c.auth}   (Prefix: ${c.prefix})`,
        `Token       : ${c.token}`,
        `Description : ${EMPTY_HINT}`,
      ].join("\n")
    : "";

  const rows: Array<{ id: string; label: string; value: string; display?: string; copyable: boolean }> = c
    ? [
        { id: "orig", label: "Оригинальное название", value: ORIGINAL_NAME, copyable: true },
        { id: "name", label: "Name", value: c.name, copyable: true },
        { id: "url", label: "URL", value: c.url, display: c.url || "— запусти MCP —", copyable: Boolean(c.url) },
        { id: "transport", label: "Transport", value: c.transport, copyable: true },
        { id: "auth", label: "Auth", value: `${c.auth}   (Prefix: ${c.prefix})`, copyable: false },
        {
          id: "token",
          label: "Token",
          value: c.token,
          display: c.token ? (showToken ? c.token : maskedToken) : "— нет MCP_TOKEN в .env —",
          copyable: Boolean(c.token),
        },
        { id: "desc", label: "Description", value: "", display: EMPTY_HINT, copyable: false },
      ]
    : [];

  const statusLabel = starting
    ? "запуск…"
    : running
    ? state?.publicOk === false
      ? "on · туннель ещё прогревается"
      : "on"
    : state?.localOk
    ? "сервер on · туннеля нет"
    : "off";

  return (
    <section className="proxy-panel flex flex-col flex-1 min-h-0">
      <div className="proxy-table-header">
        <span>Local Coding Agent · MCP</span>
        <span
          className={`ml-auto text-[10px] font-mono normal-case tracking-normal ${
            running ? "text-ink-800" : "text-ink-500"
          }`}
        >
          {statusLabel}
        </span>
      </div>

      <div className="p-3 space-y-3 flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        {/* folder + actions */}
        <div className="flex flex-wrap items-center gap-1.5 min-w-0">
          <code className="proxy-mono-box flex-1 min-w-0 truncate" title={state?.agentDir}>
            {state?.agentDir || "…"}
          </code>
          <button type="button" onClick={() => void pickDir()} className="proxy-header-icon" title="Выбрать папку агента">
            <FolderOpen className="w-3 h-3" />
          </button>
          <button type="button" onClick={() => void refresh()} className="proxy-header-icon" title="Обновить статус">
            <RefreshCw className="w-3 h-3" />
          </button>
          {running || state?.localOk || state?.tunnelRunning ? (
            <>
              <button
                type="button"
                disabled={starting || stopping}
                onClick={() => void start()}
                className={pxBtn}
                title="Перезапустить (новый URL)"
              >
                {starting ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                Restart
              </button>
              <button
                type="button"
                disabled={starting || stopping}
                onClick={() => void stop()}
                className={`${pxBtn} theme-btn-danger`}
              >
                {stopping ? <Loader2 className="w-3 h-3 animate-spin" /> : <Square className="w-3 h-3" />}
                Stop MCP
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={starting || !state?.exists}
              onClick={() => void start()}
              className={pxBtn}
            >
              {starting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Play className="w-3 h-3" />}
              {starting ? "Запускаю MCP…" : "Start MCP"}
            </button>
          )}
        </div>

        <div className="text-[10px] text-ink-500">
          MCP и туннель продолжают работать после закрытия приложения — выключаются только кнопкой Stop MCP.
        </div>

        {state && !state.exists && (
          <div className="text-[11px] text-red-500">В этой папке нет server.py — выбери папку local-coding-agent.</div>
        )}
        {(error || state?.error) && (
          <div className="text-[11px] text-red-500 break-words">{error || state?.error}</div>
        )}

        {/* connector card */}
        {c && (
          <div className="space-y-1">
            <div className="flex items-center">
              <span className="text-[10px] uppercase tracking-wider text-ink-500">Коннектор</span>
              <button
                type="button"
                disabled={!c.url}
                onClick={() => void copy(connectorText, "all-conn")}
                className="ml-auto proxy-header-icon disabled:opacity-40"
                title="Скопировать все поля"
              >
                {copied === "all-conn" ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
              </button>
            </div>
            <div className="rounded-md border border-ink-200 font-mono text-[11px]">
              {rows.map((r) => (
                <div key={r.id} className="flex items-center gap-2 px-2 py-1 border-b border-ink-200 last:border-b-0">
                  <span className="w-36 flex-shrink-0 text-ink-500 truncate" title={r.label}>{r.label}</span>
                  <span
                    className={`flex-1 min-w-0 truncate ${r.id === "desc" ? "italic text-ink-500" : ""}`}
                    title={r.id === "token" ? "" : r.display ?? r.value}
                  >
                    {r.display ?? r.value}
                  </span>
                  {r.id === "token" && c.token && (
                    <button
                      type="button"
                      onClick={() => setShowToken((v) => !v)}
                      className="proxy-header-icon"
                      title={showToken ? "Скрыть" : "Показать"}
                    >
                      {showToken ? <EyeOff className="w-3 h-3" /> : <Eye className="w-3 h-3" />}
                    </button>
                  )}
                  {r.copyable ? (
                    <button
                      type="button"
                      onClick={() => void copy(r.value, r.id)}
                      className="proxy-header-icon"
                      title="Copy"
                    >
                      {copied === r.id ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                    </button>
                  ) : (
                    <span className="w-[22px]" />
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* instruction */}
        {state?.instruction && (
          <div className="space-y-1">
            <div className="flex items-center">
              <span className="text-[10px] uppercase tracking-wider text-ink-500">Промт для Notion Agent</span>
              <button
                type="button"
                onClick={() => void copy(state.instruction, "prompt")}
                className={`ml-auto ${pxBtn}`}
              >
                {copied === "prompt" ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
                {copied === "prompt" ? "Скопировано" : "Копировать промт"}
              </button>
            </div>
            <pre className="proxy-mono-box !block whitespace-pre-wrap max-h-[40vh] overflow-y-auto scrollbar-thin text-[11px] leading-relaxed">
              {state.instruction}
            </pre>
          </div>
        )}
      </div>
    </section>
  );
}
