import { useCallback, useEffect, useMemo, useState } from "react";
import ReleaseWorkflowPanel from "../components/ReleaseWorkflowPanel.jsx";
import { resolveReleaseContext } from "../lib/releaseWorkflowModel.js";
import { useRoute } from "../routeContext.jsx";

function readSearch() {
  return typeof window === "undefined" ? "" : window.location.search;
}

function paramsFromSearch(search) {
  return new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
}

function buildReleaseSearch({ businessLine, platform, version, batch, workspaceId }) {
  const params = new URLSearchParams();
  if (businessLine) params.set("businessLine", businessLine);
  if (platform) params.set("platform", platform);
  if (version) params.set("version", version);
  if (batch) params.set("batch", batch);
  if (workspaceId) params.set("workspaceId", workspaceId);
  const text = params.toString();
  return text ? `?${text}` : "";
}

export default function ReleasePage({ authUser }) {
  const { navigate } = useRoute();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [builtins, setBuiltins] = useState([]);
  const [custom, setCustom] = useState([]);
  const [releaseWorkspaces, setReleaseWorkspaces] = useState([]);
  const [releaseAccess, setReleaseAccess] = useState(null);
  const [navigationSearch, setNavigationSearch] = useState(readSearch);
  const [versionDraft, setVersionDraft] = useState("");
  const [batchDraft, setBatchDraft] = useState("initial");

  const load = useCallback(async () => {
    // 用户需求点: 线上发版工程由服务端 allowlist 提供，页面不能使用开发机路径兜底。
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/workspaces");
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`);
      setBuiltins(Array.isArray(payload.workspaces) ? payload.workspaces.filter((item) => item?.builtin) : []);
      setCustom(Array.isArray(payload.customWorkspaces) ? payload.customWorkspaces : []);
      setReleaseWorkspaces(Array.isArray(payload.releaseWorkspaces) ? payload.releaseWorkspaces : []);
      if (payload.releaseAccess && typeof payload.releaseAccess === "object") {
        setReleaseAccess(payload.releaseAccess);
      }
    } catch (cause) {
      setError(String(cause?.message || cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const onPopState = () => setNavigationSearch(readSearch());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const membership = releaseAccess?.membership || null;
  const membershipKey = membership
    ? `${membership.businessLine || ""}/${membership.platform || ""}`
    : "";

  const applyNavigationSearch = useCallback((nextSearch) => {
    const normalized = nextSearch || "";
    if (typeof window !== "undefined") {
      const url = `${window.location.pathname}${normalized}${window.location.hash || ""}`;
      window.history.replaceState(window.history.state, "", url);
    }
    setNavigationSearch(normalized);
  }, []);

  // 用户需求点: 未写明业务线/平台时，用登录用户的 operators 归属补全深链。
  useEffect(() => {
    if (!membership?.businessLine || !membership?.platform) return;
    const params = paramsFromSearch(navigationSearch);
    if (params.get("businessLine") && params.get("platform")) return;
    const next = buildReleaseSearch({
      businessLine: membership.businessLine,
      platform: membership.platform,
      version: params.get("version") || "1.0.0",
      batch: params.get("batch") || "initial",
      workspaceId: params.get("workspaceId") || "",
    });
    if (next !== navigationSearch) applyNavigationSearch(next);
  }, [applyNavigationSearch, membershipKey, navigationSearch]);

  useEffect(() => {
    const params = paramsFromSearch(navigationSearch);
    setVersionDraft(params.get("version") || "1.0.0");
    setBatchDraft(params.get("batch") || "initial");
  }, [navigationSearch]);

  const releaseWorkspace = useMemo(() => {
    // 用户需求点: 深链只携带 workspaceId/业务上下文，未配置工程时明确提示而不是伪造工作区。
    const params = paramsFromSearch(navigationSearch);
    const requestedPath = String(params.get("workspacePath") || "").trim();
    const requestedId = String(params.get("workspaceId") || "").trim();
    const candidates = [...releaseWorkspaces, ...custom, ...builtins].filter(Boolean);
    const businessLine = String(params.get("businessLine") || membership?.businessLine || "").trim().toLowerCase();
    const platformRaw = String(params.get("platform") || membership?.platform || "").trim().toLowerCase();
    const platform = /ios|iphone/i.test(platformRaw) ? "ios" : platformRaw;
    if (requestedPath || requestedId) {
      const matched = candidates.find((item) => (
        (requestedId && String(item.id || "") === requestedId)
        || (requestedPath && String(item.path || "") === requestedPath)
      ));
      if (matched) return matched;
      if (businessLine && platform) {
        const releaseProject = candidates.find((item) => item.release && item.businessLine === businessLine && item.platform === platform);
        if (releaseProject) return releaseProject;
      }
      return { id: requestedId || "release-workspace", ...(requestedPath ? { path: requestedPath } : {}) };
    }
    if (businessLine && platform) {
      return candidates.find((item) => item.release && item.businessLine === businessLine && item.platform === platform)
        || candidates.find((item) => !item.builtin && item.businessLine === businessLine && item.platform === platform)
        || null;
    }
    return candidates.find((item) => item.release) || candidates.find((item) => !item.builtin) || candidates[0] || null;
  }, [builtins, custom, membershipKey, navigationSearch, releaseWorkspaces]);

  const navigationContext = useMemo(() => {
    const params = paramsFromSearch(navigationSearch);
    const hasExplicit = params.has("businessLine") || params.has("platform") || params.has("version") || params.has("batch");
    if (!hasExplicit && !membership) return null;
    const merged = new URLSearchParams(params);
    if (!merged.get("businessLine") && membership?.businessLine) merged.set("businessLine", membership.businessLine);
    if (!merged.get("platform") && membership?.platform) merged.set("platform", membership.platform);
    if (!merged.get("version")) merged.set("version", "1.0.0");
    if (!merged.get("batch")) merged.set("batch", "initial");
    return resolveReleaseContext(releaseWorkspace, merged);
  }, [membershipKey, navigationSearch, releaseWorkspace]);

  const operator = authUser?.username || authUser?.userId || "未记录";
  // 未返回 releaseAccess 时保持可写以兼容旧服务端；有名单后以服务端 canWrite 为准。
  const canWrite = releaseAccess ? releaseAccess.canWrite === true : true;

  const handleReleaseAccess = useCallback((nextAccess) => {
    if (!nextAccess || typeof nextAccess !== "object") return;
    setReleaseAccess((previous) => {
      if (previous && JSON.stringify(previous) === JSON.stringify(nextAccess)) return previous;
      return nextAccess;
    });
  }, []);

  const commitVersionNavigation = useCallback((event) => {
    event?.preventDefault?.();
    const params = paramsFromSearch(navigationSearch);
    const businessLine = params.get("businessLine") || membership?.businessLine || navigationContext?.businessLine || "";
    const platform = params.get("platform") || membership?.platform || navigationContext?.platform || "";
    applyNavigationSearch(buildReleaseSearch({
      businessLine,
      platform,
      version: String(versionDraft || "").trim() || "1.0.0",
      batch: String(batchDraft || "").trim().toLowerCase() || "initial",
      workspaceId: params.get("workspaceId") || releaseWorkspace?.id || "",
    }));
  }, [applyNavigationSearch, batchDraft, membership, navigationContext, navigationSearch, releaseWorkspace, versionDraft]);

  return (
    <div className="af-workspaces-page">
      <header className="af-settings-top">
        <div className="af-settings-crumb" aria-label="发版">
          <span className="af-settings-crumb-muted">AgentFlow</span>
          <span className="af-settings-crumb-sep" aria-hidden>/</span>
          <button type="button" className="af-settings-crumb-link" onClick={() => navigate("/releases")}>
            发版
          </button>
          <span className="af-settings-crumb-sep" aria-hidden>/</span>
          <span className="af-settings-crumb-active">流程</span>
        </div>
        <form className="af-release-version-switcher" onSubmit={commitVersionNavigation}>
          <label>
            <span>版本</span>
            <input value={versionDraft} onChange={(event) => setVersionDraft(event.target.value)} placeholder="如 1.0.0" aria-label="发版版本" />
          </label>
          <label>
            <span>批次</span>
            <select value={batchDraft} onChange={(event) => setBatchDraft(event.target.value)} aria-label="发版批次">
              <option value="initial">initial</option>
              <option value="supplemental">supplemental</option>
            </select>
          </label>
          <button type="submit">进入</button>
        </form>
        <button type="button" className="af-schedules-refresh" onClick={load} disabled={loading}>
          <span className="material-symbols-outlined">refresh</span>
          刷新
        </button>
      </header>

      <main className="af-settings-body">
        <div className="af-workspaces-inner">
          {error ? <p className="af-err af-settings-api-hint">{error}</p> : null}
          {releaseAccess && !canWrite ? (
            <p className="af-release-readonly-banner" role="status">可浏览发版时间线，当前账号无发版操作权限。</p>
          ) : null}

          {releaseWorkspace ? (
            <section className="af-workspaces-release-view" aria-label="发版流程">
              <ReleaseWorkflowPanel
                workspace={releaseWorkspace}
                releaseContext={navigationContext}
                operator={operator}
                canWrite={canWrite}
                releaseAccess={releaseAccess}
                onReleaseAccess={handleReleaseAccess}
              />
            </section>
          ) : (
            <p className="af-err af-settings-api-hint">当前业务线和平台尚未配置发版工程，请联系管理员配置 release deployment。</p>
          )}
        </div>
      </main>
    </div>
  );
}
