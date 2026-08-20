import { useCallback, useEffect, useMemo, useState } from "react";

import { useRoute } from "../routeContext.jsx";

const MARKETPLACE_SCOPES = [
  { id: "all", label: "全部" },
  { id: "owned", label: "我的发布" },
  { id: "installed", label: "已安装 / 可用" },
];

function initialMarketplaceView() {
  const params = new URLSearchParams(window.location.search);
  const kind = params.get("kind") === "node" ? "node" : "flow";
  const requestedScope = params.get("scope") || "all";
  const scope = MARKETPLACE_SCOPES.some((item) => item.id === requestedScope) ? requestedScope : "all";
  return { kind, scope };
}

function ownedBy(item, authUser) {
  const owner = String(item?.ownerUserId || "").trim();
  return new Set([
    String(authUser?.userId || "").trim(),
    String(authUser?.username || "").trim(),
  ].filter(Boolean)).has(owner);
}

function formatCount(value) {
  return new Intl.NumberFormat("zh-CN").format(Number(value || 0));
}

function portCount(value) {
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return 0;
}

function sourceLabel(source) {
  if (source === "marketplace") return "Marketplace";
  if (source === "flow") return "流程内节点";
  if (source === "project") return "项目节点";
  if (source === "builtin") return "内置节点";
  return source || "AgentFlow";
}

export default function MarketplacePage({ authUser }) {
  const { navigate } = useRoute();
  const initialView = useMemo(initialMarketplaceView, []);
  const [kind, setKind] = useState(initialView.kind);
  const [scope, setScope] = useState(initialView.scope);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  useEffect(() => {
    const params = new URLSearchParams({ kind, scope });
    window.history.replaceState({}, "", `/marketplace?${params}`);
  }, [kind, scope]);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ kind, scope, sort: "useCount", order: "desc" });
      if (query.trim()) params.set("q", query.trim());
      const response = await fetch(`/api/marketplace/resources?${params}`);
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      setItems(Array.isArray(body.items) ? body.items : []);
    } catch (loadError) {
      setItems([]);
      setError(String(loadError?.message || loadError));
    } finally {
      setLoading(false);
    }
  }, [kind, query, scope]);

  useEffect(() => {
    const timer = window.setTimeout(load, 180);
    return () => window.clearTimeout(timer);
  }, [load]);

  const installFlow = useCallback(async (item) => {
    const flowId = window.prompt("安装到个人空间，Flow ID：", item.liveFlowId || item.definitionId || item.id);
    if (!flowId) return;
    const key = `install:${item.resourceType}:${item.id}@${item.version}`;
    setBusy(key);
    setError("");
    try {
      const response = await fetch("/api/marketplace/flows/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: item.id,
          version: item.version,
          flowId,
          projectFlow: item.projectFlow === true,
          ownerUserId: item.liveOwnerUserId || item.ownerUserId || "",
          flowSource: item.liveFlowSource || "",
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      navigate(body.url || `/workspace?flowId=${encodeURIComponent(flowId)}&flowSource=user`);
    } catch (installError) {
      setError(String(installError?.message || installError));
    } finally {
      setBusy("");
    }
  }, [navigate]);

  const toggleVisibility = useCallback(async (item) => {
    const nextVisibility = item.visibility === "private" ? "public" : "private";
    const key = `visibility:${item.resourceType}:${item.id}@${item.version}`;
    setBusy(key);
    setError("");
    try {
      const response = await fetch("/api/marketplace/visibility", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: item.projectFlow ? "project-flow" : item.resourceType,
          id: item.id,
          version: item.version,
          visibility: nextVisibility,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      await load();
    } catch (visibilityError) {
      setError(String(visibilityError?.message || visibilityError));
    } finally {
      setBusy("");
    }
  }, [load]);

  const deletePublishedResource = useCallback(async (item) => {
    const endpoint = item.resourceType === "node"
      ? "/api/marketplace/node"
      : item.resourceType === "flow-snippet"
        ? "/api/marketplace/flow-snippet"
        : "";
    if (!endpoint || !window.confirm(`确认删除 ${item.displayName || item.id}@${item.version}？`)) return;
    const key = `delete:${item.resourceType}:${item.id}@${item.version}`;
    setBusy(key);
    setError("");
    try {
      const params = new URLSearchParams({ id: item.id, version: item.version });
      const response = await fetch(`${endpoint}?${params}`, { method: "DELETE" });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || body.ok === false) throw new Error(body.error || `HTTP ${response.status}`);
      await load();
    } catch (deleteError) {
      setError(String(deleteError?.message || deleteError));
    } finally {
      setBusy("");
    }
  }, [load]);

  return (
    <main className="af-marketplace-page">
      <header className="af-marketplace-hero">
        <div>
          <span className="af-marketplace-eyebrow">AGENTFLOW RESOURCE CENTER</span>
          <h1>市场</h1>
          <p>发现、安装并管理完整 Flow、流程片段与可复用节点。</p>
        </div>
        <label className="af-marketplace-search">
          <span className="material-symbols-outlined">search</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、说明、作者或标签" />
        </label>
      </header>

      <div className="af-marketplace-toolbar">
        <div className="af-marketplace-tabs" aria-label="资源类型">
          <button type="button" className={kind === "flow" ? "is-active" : ""} onClick={() => setKind("flow")}>流程</button>
          <button type="button" className={kind === "node" ? "is-active" : ""} onClick={() => setKind("node")}>节点</button>
        </div>
        <div className="af-marketplace-scopes" aria-label="资源范围">
          {MARKETPLACE_SCOPES.map((item) => (
            <button key={item.id} type="button" className={scope === item.id ? "is-active" : ""} onClick={() => setScope(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
        <span className="af-marketplace-sort">
          <span className="material-symbols-outlined">{scope === "installed" ? "inventory_2" : "trending_down"}</span>
          {scope === "installed" ? "当前可用资源" : "使用次数从高到低"}
        </span>
      </div>

      {error ? <div className="af-marketplace-error">{error}</div> : null}
      {loading ? <div className="af-marketplace-empty">正在加载市场…</div> : null}
      {!loading && items.length === 0 ? (
        <div className="af-marketplace-empty">
          {scope === "owned" ? "你还没有发布匹配的资源" : scope === "installed" ? "没有匹配的已安装或可用资源" : `没有匹配的${kind === "flow" ? "流程" : "节点"}`}
        </div>
      ) : null}

      <section className="af-marketplace-grid">
        {items.map((item, index) => {
          const resourceType = item.resourceType || kind;
          const key = `${resourceType}:${item.id}@${item.version || item.definitionId || index}`;
          const mine = ownedBy(item, authUser);
          const visibilityBusy = busy === `visibility:${resourceType}:${item.id}@${item.version}`;
          const deleteBusy = busy === `delete:${resourceType}:${item.id}@${item.version}`;
          const installBusy = busy === `install:${resourceType}:${item.id}@${item.version}`;
          const installedFlowId = Array.isArray(item.installedFlowIds) ? item.installedFlowIds[0] : "";
          return (
            <article className="af-marketplace-card" key={key}>
              <div className="af-marketplace-card__top">
                <span className="af-marketplace-rank">#{index + 1}</span>
                {item.localCatalog ? (
                  <span className="af-marketplace-visibility is-local">
                    <span className="material-symbols-outlined">inventory_2</span>
                    可用
                  </span>
                ) : (
                  <span className={`af-marketplace-visibility is-${item.visibility || "public"}`}>
                    <span className="material-symbols-outlined">{item.visibility === "private" ? "lock" : "public"}</span>
                    {item.visibility === "private" ? "私有" : "公开"}
                  </span>
                )}
              </div>
              <h2>{item.displayName || item.id}</h2>
              <p>{item.description || "暂无说明"}</p>
              <div className="af-marketplace-version">
                {item.definitionId || item.id}{item.versionLabel ? ` · ${item.versionLabel}` : item.version ? ` · v${item.version}` : ""}
              </div>
              {item.localCatalog ? (
                <div className="af-marketplace-stats">
                  <strong><span className="material-symbols-outlined">input</span>{formatCount(portCount(item.inputs))}<small>输入</small></strong>
                  <strong><span className="material-symbols-outlined">output</span>{formatCount(portCount(item.outputs))}<small>输出</small></strong>
                  <strong><span className="material-symbols-outlined">inventory_2</span><em>{sourceLabel(item.source)}</em><small>来源</small></strong>
                </div>
              ) : resourceType === "flow-snippet" ? (
                <div className="af-marketplace-stats">
                  <strong><span className="material-symbols-outlined">add_circle</span>{formatCount(item.useCount)}<small>添加</small></strong>
                  <strong><span className="material-symbols-outlined">account_tree</span>{formatCount(item.nodeCount)}<small>节点</small></strong>
                  <strong><span className="material-symbols-outlined">group</span>{formatCount(item.uniqueUserCount)}<small>用户</small></strong>
                </div>
              ) : (
                <div className="af-marketplace-stats">
                  <strong><span className="material-symbols-outlined">play_circle</span>{formatCount(item.useCount)}<small>使用</small></strong>
                  <strong><span className="material-symbols-outlined">download</span>{formatCount(item.installCount)}<small>安装</small></strong>
                  <strong><span className="material-symbols-outlined">group</span>{formatCount(item.uniqueUserCount)}<small>用户</small></strong>
                </div>
              )}
              <footer>
                <span>{item.localCatalog ? sourceLabel(item.source) : `by ${item.ownerUserId || "AgentFlow"}`}</span>
                <div>
                  {mine && !item.localCatalog ? (
                    <button type="button" disabled={visibilityBusy} onClick={() => toggleVisibility(item)}>
                      {item.visibility === "private" ? "设为公开" : "设为私有"}
                    </button>
                  ) : null}
                  {mine && (resourceType === "node" || resourceType === "flow-snippet") && !item.localCatalog ? (
                    <button className="is-danger" type="button" disabled={deleteBusy} onClick={() => deletePublishedResource(item)}>
                      {deleteBusy ? "删除中…" : "删除"}
                    </button>
                  ) : null}
                  {resourceType === "flow" ? (
                    item.projectFlow && mine ? (
                      <button
                        className="is-primary"
                        type="button"
                        onClick={() => {
                          const params = new URLSearchParams({
                            flowId: item.liveFlowId || item.definitionId,
                            flowSource: item.liveFlowSource || "user",
                          });
                          if (item.liveWorkspaceId) params.set("workspaceId", item.liveWorkspaceId);
                          navigate(`/workspace?${params}`);
                        }}
                      >
                        打开
                      </button>
                    ) : installedFlowId ? (
                      <button className="is-primary" type="button" onClick={() => navigate(`/workspace?flowId=${encodeURIComponent(installedFlowId)}&flowSource=user`)}>打开</button>
                    ) : (
                      <button className="is-primary" type="button" disabled={installBusy} onClick={() => installFlow(item)}>
                        {installBusy ? "安装中…" : "安装到个人空间"}
                      </button>
                    )
                  ) : resourceType === "flow-snippet" ? (
                    <button
                      className="is-primary"
                      type="button"
                      onClick={() => navigate(`/marketplace/preview?id=${encodeURIComponent(item.id)}&version=${encodeURIComponent(item.version || "1.0.0")}`)}
                    >
                      预览
                    </button>
                  ) : (
                    <button className="is-primary" type="button" onClick={() => navigate("/projects")}>在流程中使用</button>
                  )}
                </div>
              </footer>
            </article>
          );
        })}
      </section>

    </main>
  );
}
