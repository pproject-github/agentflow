import { useCallback, useEffect, useMemo, useState } from "react";
import ReleaseWorkflowPanel from "../components/ReleaseWorkflowPanel.jsx";

const FALLBACK_WORKSPACE = {
  id: "release-default-workspace",
  label: "Likee Android 发版",
  path: "/Users/duanfengyuan/migration-workspace/test/likee_android",
  businessLine: "likee",
  platform: "android",
  version: "1.0.0",
};

export default function ReleasePage() {
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
  const workspaceLabel = releaseWorkspace.label || releaseWorkspace.name || "默认发版工作空间";
  const workspacePath = releaseWorkspace.path || releaseWorkspace.repoUrl || "本地发版时间线";

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
          <header className="af-settings-hero">
            <h1 className="af-settings-h1">发版</h1>
            <p className="af-settings-lead">按业务线、平台和版本逐阶段推进发版流程。</p>
            {error ? <p className="af-err af-settings-api-hint">{error}</p> : null}
          </header>

          <section className="af-workspaces-release-view" aria-label="发版流程">
            <header className="af-workspaces-release-head">
              <div>
                <span className="af-release-eyebrow">发版时间线</span>
                <h2>发版</h2>
                <p>当前工作空间：<strong>{workspaceLabel}</strong></p>
                <small>{workspacePath}</small>
              </div>
            </header>
            <ReleaseWorkflowPanel workspace={releaseWorkspace} />
          </section>
        </div>
      </main>
    </div>
  );
}
