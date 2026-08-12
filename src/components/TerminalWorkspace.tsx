import React, { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

type TerminalId = "1" | "2";

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
      theme: {
        background: "#090909",
        foreground: "#d6d6d6",
        cursor: "#f2f2f2",
        cursorAccent: "#090909",
        selectionBackground: "#3b3b3b",
        black: "#090909",
        brightBlack: "#666666",
        white: "#d6d6d6",
        brightWhite: "#ffffff",
      },
    });
    terminal.loadAddon(fit);
    terminal.open(host);
    terminalRef.current = terminal;

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
