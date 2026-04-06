import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";
import "./i18n"; // 初始化 i18n
import faviconUrl from "./assets/agentflow-icon.svg?url";

const faviconLink = document.querySelector('link[rel="icon"]');
if (faviconLink) faviconLink.href = faviconUrl;

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
