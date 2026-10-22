import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Cable } from "lucide-react";
import { McpServer } from "../types";

interface Props {
  rootPath: string | null;
}

const McpConnector: React.FC<Props> = ({ rootPath }) => {
  const anchorRef = useRef<HTMLButtonElement>(null);
  const closeTimer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [box, setBox] = useState<{ top: number; left: number } | null>(null);
  const [servers, setServers] = useState<McpServer[]>([]);
  const [enabled, setEnabled] = useState<string[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState("");

  const refresh = async () => {
    const list = await window.lopster?.listMcpServers?.();
    setServers(list || []);
    if (!rootPath) {
      setEnabled([]);
      return;
    }
    const binding = await window.lopster?.listProjectMcp?.(rootPath);
    setEnabled(binding?.serverIds || []);
  };

  useEffect(() => {
    void refresh();
    const off = window.lopster?.onMcpChanged?.(() => void refresh());
    return () => off?.();
  }, [rootPath]);

  const place = () => {
    const rect = anchorRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = 280;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    setBox({ top: rect.top - 8, left });
  };

  const show = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    place();
    setOpen(true);
    void refresh();
  };

  const hide = () => {
    if (closeTimer.current) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setOpen(false), 160);
  };

  const toggle = async (server: McpServer) => {
    if (!rootPath) return;
    const next = !enabled.includes(server.id);
    setBusyId(server.id);
    setError("");
    setEnabled((prev) => next ? [...prev, server.id] : prev.filter((id) => id !== server.id));
    try {
      const result = await window.lopster?.setProjectMcp?.(rootPath, server.id, next);
      setEnabled(result?.serverIds || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      void refresh();
    } finally {
      setBusyId(null);
    }
  };

  const menu = open && box ? createPortal(
    <div
      className="mcp-connector-pop"
      style={{ left: box.left, top: box.top, transform: "translateY(-100%)" }}
      onMouseEnter={show}
      onMouseLeave={hide}
    >
      <div className="mcp-connector-head">Connector</div>
      {!rootPath && <div className="mcp-connector-empty">Open a project folder to attach MCP servers to this chat.</div>}
      {rootPath && !servers.length && <div className="mcp-connector-empty">No servers installed. Download them in Custom Tools → MCP.</div>}
      {rootPath && servers.length > 0 && (
        <div className="mcp-connector-list">
          {servers.map((server) => {
            const on = enabled.includes(server.id);
            return (
              <button key={server.id} type="button" className="mcp-connector-row" disabled={busyId === server.id} onClick={() => void toggle(server)}>
                <span className="min-w-0 flex-1 text-left">
                  <span className="block truncate text-[12px] text-ink-950">{server.title || server.name}</span>
                  <span className="block truncate font-mono text-[10px] text-ink-500">{server.marketplace?.name || server.type}</span>
                </span>
                <span className={`mcp-connector-switch ${on ? "is-on" : ""}`} aria-pressed={on} />
              </button>
            );
          })}
        </div>
      )}
      {error && <div className="px-3 py-2 text-[10px] text-status-err">{error}</div>}
    </div>,
    document.body
  ) : null;

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        className={`chat-composer-icon-btn relative ${enabled.length ? "text-ink-950" : ""}`}
        title="Connector"
        aria-label="Connector"
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        <Cable className="h-3.5 w-3.5" />
        {enabled.length > 0 && <span className="mcp-connector-dot" />}
      </button>
      {menu}
    </>
  );
};

export default McpConnector;
