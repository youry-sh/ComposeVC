import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import ProxyPopup from "./ProxyPopup";
import "katex/dist/katex.min.css";
import "./index.css";
import { initTheme } from "./themes";

initTheme();

const popupView = new URLSearchParams(window.location.search).get("proxyPopup");
const rootElement = document.getElementById("root")!;

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    {popupView === "usage" || popupView === "settings" ? (
      <ProxyPopup />
    ) : (
      <App />
    )}
  </React.StrictMode>
);
