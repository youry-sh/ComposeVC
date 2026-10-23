import React, { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { THEME_CHANGE_EVENT } from "../themes";
import "@xterm/xterm/css/xterm.css";

type TerminalId = "1" | "2";

function cssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

/** Build the xterm palette from the active theme tokens so the terminal
 *  re-skins with every tab/modal instead of staying fixed to a mono grey. */
function readTerminalTheme() {
  return {
    background: cssVar("--terminal-bg", "#090909"),
    foreground: cssVar("--text", "#e8e8e8"),
    cursor: cssVar("--text", "#f2f2f2"),
    cursorAccent: cssVar("--bg", "#090909"),
    selectionBackground: cssVar("--ink-400", "#3b3b3b"),
    black: cssVar("--bg", "#090909"),
    brightBlack: cssVar("--ink-500", "#666666"),
    white: cssVar("--text", "#d6d6d6"),
    brightWhite: cssVar("--ink-950", "#ffffff"),
  };
}

function TerminalPane({ id }: { id: TerminalId }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const fit = new FitAddon();
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: "bar",
      fontFamily: '"Cascadia Code", "JetBrains Mono", Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.18,
      scrollback: 10000,
      allowProposedApi: false,
      theme: readTerminalTheme(),
    });
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;

    const onThemeChange = () => {
      try {
        terminal.options.theme = readTerminalTheme();
      } catch {
        /* ignore — theme update is best-effort */
      }
    };
    window.addEventListener(THEME_CHANGE_EVENT, onThemeChange);

    terminal.attachCustomKeyEventHandler((event) => {
      if (!(event.ctrlKey && event.shiftKey)) return true;
      const key = event.key.toLowerCase();
      if (key === "c" && terminal.hasSelection()) {
        void navigator.clipboard.writeText(terminal.getSelection());
        return false;
      }
      if (key === "v" && event.type === "keydown") {
        void navigator.clipboard.readText().then((text) => window.lopster?.terminalInput(id, text));
        return false;
      }
      return true;
    });

    const dataDisposable = terminal.onData((data) => window.lopster?.terminalInput(id, data));
    const onData = window.lopster?.onTerminalData((payload) => {
      if (payload.id === id) terminal.write(payload.data);
    });
    const onExit = window.lopster?.onTerminalExit((payload) => {
      if (payload.id === id) terminal.writeln(`\r\n[process exited: ${payload.exitCode}]`);
    });
    const resize = () => {
      if (!host.isConnected || host.clientWidth < 2 || host.clientHeight < 2) return;
      try {
        fit.fit();
        window.lopster?.terminalResize(id, terminal.cols, terminal.rows);
      } catch { /* hidden while switching tabs */ }
    };
    const observer = new ResizeObserver(resize);
    observer.observe(host);
    const onContextMenu = (event: MouseEvent) => {
      event.preventDefault();
      if (terminal.hasSelection()) {
        void navigator.clipboard.writeText(terminal.getSelection());
      } else {
        void navigator.clipboard.readText().then((text) => window.lopster?.terminalInput(id, text));
      }
    };
    host.addEventListener("contextmenu", onContextMenu);

    void window.lopster?.terminalEnsure(id).then(() => {
      resize();
      terminal.focus();
    }).catch((error) => terminal.writeln(`\r\nTerminal failed: ${String(error)}`));

    return () => {
      observer.disconnect();
      window.removeEventListener(THEME_CHANGE_EVENT, onThemeChange);
      host.removeEventListener("contextmenu", onContextMenu);
      dataDisposable.dispose();
      onData?.();
      onExit?.();
      terminal.dispose();
      terminalRef.current = null;
    };
  }, [id]);

  return <div ref={hostRef} className="terminal-pane" onMouseDown={() => terminalRef.current?.focus()} />;
}

const TerminalWorkspace: React.FC = () => (
  <div className="terminal-workspace">
    <TerminalPane id="1" />
    <TerminalPane id="2" />
  </div>
);

export default TerminalWorkspace;
