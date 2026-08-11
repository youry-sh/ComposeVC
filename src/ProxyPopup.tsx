import React from "react";
import { Minus, Square, X } from "lucide-react";
import ProxyWorkspace from "./components/ProxyWorkspace";
import { getStoredLanguage, translations } from "./i18n";

function getPopupView(): "usage" | "settings" | null {
  try {
    const v = new URLSearchParams(window.location.search).get("proxyPopup");
    if (v === "usage" || v === "settings") return v;
  } catch {
    /* */
  }
  return null;
}

const ProxyPopup: React.FC = () => {
  const view = getPopupView();
  const t = translations[getStoredLanguage()];
  const title =
    view === "settings"
      ? "Proxy · Settings"
      : view === "usage"
        ? "Proxy · Usage"
        : "Proxy";

  return (
    <div className="proxy-popup-root">
      <div className="proxy-popup-titlebar">
        <span className="proxy-popup-title">{title}</span>
        <div className="flex-1 min-w-0" />
        <div className="proxy-popup-controls">
          <button
            type="button"
            onClick={() => window.lopster?.minimize()}
            className="titlebar-btn"
            aria-label="Minimize"
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => window.lopster?.toggleMaximize()}
            className="titlebar-btn"
            aria-label="Maximize"
          >
            <Square className="w-3 h-3" />
          </button>
          <button
            type="button"
            onClick={() => window.lopster?.close()}
            className="titlebar-btn titlebar-btn-close"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
      <div className="flex-1 min-h-0 flex flex-col overflow-hidden">
        {view ? (
          <ProxyWorkspace labels={t} popupView={view} />
        ) : (
          <div className="flex-1 grid place-items-center text-[12px] text-ink-500">
            No popup view
          </div>
        )}
      </div>
    </div>
  );
};

export default ProxyPopup;
