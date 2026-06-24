import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";
import "./onboarding/styles.css";
import "./i18n"; // 初始化 i18n
import faviconUrl from "./assets/agentflow-icon.svg?url";

window.addEventListener("error", (event) => {
  console.error("[AgentFlow UI global error]", event.error || event.message, {
    filename: event.filename,
    lineno: event.lineno,
    colno: event.colno,
  });
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("[AgentFlow UI unhandled rejection]", event.reason);
});

const faviconLink = document.querySelector('link[rel="icon"]');
if (faviconLink) faviconLink.href = faviconUrl;

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
