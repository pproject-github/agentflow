import { useCallback, useEffect, useMemo, useState } from "react";
import ReleaseWorkflowPanel from "../components/ReleaseWorkflowPanel.jsx";
import { resolveReleaseContext } from "../lib/releaseWorkflowModel.js";

const FALLBACK_WORKSPACE = {
  id: "release-default-workspace",
  label: "Likee Android 发版",
  path: "/Users/duanfengyuan/migration-workspace/test/likee_android",
  businessLine: "likee",
  platform: "android",
  version: "1.0.0",
};

export default function ReleasePage({ authUser }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [builtins, setBuiltins] = useState([]);
  const [custom, setCustom] = useState([]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/workspaces");
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`);
      setBuiltins(Array.isArray(payload.workspaces) ? payload.workspaces.filter((item) => item?.builtin) : []);
      setCustom(Array.isArray(payload.customWorkspaces) ? payload.customWorkspaces : []);
    } catch (cause) {
      setError(String(cause?.message || cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const releaseWorkspace = useMemo(() => custom[0] || builtins[0] || FALLBACK_WORKSPACE, [builtins, custom]);
  const navigationSearch = typeof window === "undefined" ? "" : window.location.search;
  const navigationContext = useMemo(() => {
    const params = new URLSearchParams(navigationSearch);
    return params.has("businessLine") || params.has("platform") || params.has("version")
      ? resolveReleaseContext(releaseWorkspace, params)
      : null;
  }, [navigationSearch, releaseWorkspace]);
  const operator = authUser?.username || authUser?.userId || "未记录";

  return (
    <div className="af-workspaces-page">
      <header className="af-settings-top">
        <div className="af-settings-crumb" aria-label="发版">
          <span className="af-settings-crumb-muted">AgentFlow</span>
          <span className="af-settings-crumb-sep" aria-hidden>/</span>
          <span className="af-settings-crumb-active">发版</span>
        </div>
        <button type="button" className="af-schedules-refresh" onClick={load} disabled={loading}>
          <span className="material-symbols-outlined">refresh</span>
          刷新
        </button>
      </header>

      <main className="af-settings-body">
        <div className="af-workspaces-inner">
          {error ? <p className="af-err af-settings-api-hint">{error}</p> : null}

          <section className="af-workspaces-release-view" aria-label="发版流程">
            <ReleaseWorkflowPanel workspace={releaseWorkspace} releaseContext={navigationContext} operator={operator} />
          </section>
        </div>
      </main>
    </div>
  );
}
