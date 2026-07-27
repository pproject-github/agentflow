import { useEffect, useState } from "react";
import {
  APP_VERSION_CHECK_INTERVAL_MS,
  APP_VERSION_SNOOZE_MS,
  CLIENT_APP_VERSION,
  appVersionSnoozeKey,
  hasAppVersionChanged,
  normalizeAppVersion,
} from "../appVersion.js";

function snoozedUntil(key) {
  if (!key) return 0;
  try {
    const value = Number(window.sessionStorage.getItem(key));
    return Number.isFinite(value) ? value : 0;
  } catch {
    return 0;
  }
}

export default function AppVersionNotice() {
  const [update, setUpdate] = useState(null);

  useEffect(() => {
    let cancelled = false;
    let checking = false;

    const checkVersion = async () => {
      if (checking || document.visibilityState === "hidden") return;
      checking = true;
      try {
        const response = await fetch("/api/app-version", { cache: "no-store" });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok || cancelled) return;
        const serverVersion = normalizeAppVersion(payload.version);
        if (!hasAppVersionChanged(CLIENT_APP_VERSION, serverVersion)) {
          setUpdate(null);
          return;
        }
        const snoozeKey = appVersionSnoozeKey(CLIENT_APP_VERSION, serverVersion);
        if (snoozedUntil(snoozeKey) > Date.now()) return;
        setUpdate({
          clientVersion: normalizeAppVersion(CLIENT_APP_VERSION),
          serverVersion,
          startedAt: String(payload.startedAt || ""),
          snoozeKey,
        });
      } catch {
        // 服务重启窗口内请求失败是正常现象，下次轮询或重新聚焦时再检查。
      } finally {
        checking = false;
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void checkVersion();
    };
    const intervalId = window.setInterval(() => void checkVersion(), APP_VERSION_CHECK_INTERVAL_MS);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", checkVersion);
    void checkVersion();
    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", checkVersion);
    };
  }, []);

  if (!update) return null;

  const snooze = () => {
    try {
      window.sessionStorage.setItem(update.snoozeKey, String(Date.now() + APP_VERSION_SNOOZE_MS));
    } catch {
      /* ignore unavailable session storage */
    }
    setUpdate(null);
  };

  return (
    <aside className="af-app-version-notice" role="status" aria-live="polite">
      <span className="material-symbols-outlined af-app-version-notice__icon" aria-hidden>system_update</span>
      <div className="af-app-version-notice__copy">
        <strong>AgentFlow 已更新</strong>
        <span>v{update.clientVersion} → v{update.serverVersion}，刷新后生效</span>
      </div>
      <div className="af-app-version-notice__actions">
        <button type="button" className="af-app-version-notice__later" onClick={snooze}>稍后</button>
        <button type="button" className="af-app-version-notice__refresh" onClick={() => window.location.reload()}>
          刷新更新
        </button>
      </div>
    </aside>
  );
}
