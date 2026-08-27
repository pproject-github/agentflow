import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useRoute } from "../routeContext.jsx";

const MARKETPLACE_SCOPES = [
  { id: "all", label: "全部" },
  { id: "owned", label: "我的发布" },
];

const FLOW_RELEASE_STATES = [
  { id: "all", label: "全部状态" },
  { id: "stable", label: "Stable" },
  { id: "draft", label: "Draft" },
];

function initialMarketplaceView() {
  const params = new URLSearchParams(window.location.search);
  const kind = params.get("kind") === "node" ? "node" : "flow";
  const requestedScope = params.get("scope") || "all";
  const scope = MARKETPLACE_SCOPES.some((item) => item.id === requestedScope) ? requestedScope : "all";
  const requestedReleaseState = params.get("releaseState") || "all";
  const releaseState = FLOW_RELEASE_STATES.some((item) => item.id === requestedReleaseState) ? requestedReleaseState : "all";
  return { kind, scope, releaseState };
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

function sourceLabel(source) {
  if (source === "marketplace") return "节点仓库";
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
  const [releaseState, setReleaseState] = useState(initialView.releaseState);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState([]);
  const [nextCursor, setNextCursor] = useState("");
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const requestRef = useRef(null);

  useEffect(() => {
    const params = new URLSearchParams({ kind, scope });
    if (kind === "flow" && releaseState !== "all") params.set("releaseState", releaseState);
    window.history.replaceState({}, "", `/marketplace?${params}`);
  }, [kind, releaseState, scope]);

  const load = useCallback(async ({ cursor = "", append = false } = {}) => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ kind, scope, sort: "useCount", order: "desc", limit: "24" });
      if (kind === "flow" && releaseState !== "all") params.set("releaseState", releaseState);
      if (cursor) params.set("cursor", cursor);
      if (query.trim()) params.set("q", query.trim());
      const response = await fetch(`/api/marketplace/resources?${params}`, { signal: controller.signal });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      const nextItems = Array.isArray(body.items) ? body.items : [];
      setItems((current) => append ? [...current, ...nextItems] : nextItems);
      setNextCursor(String(body.nextCursor || ""));
      setTotal(Number(body.total || nextItems.length));
    } catch (loadError) {
      if (loadError?.name === "AbortError") return;
      if (!append) setItems([]);
      setError(String(loadError?.message || loadError));
    } finally {
      if (requestRef.current === controller) {
        requestRef.current = null;
        setLoading(false);
      }
    }
  }, [kind, query, releaseState, scope]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 180);
    return () => {
      window.clearTimeout(timer);
      requestRef.current?.abort();
    };
  }, [load]);

  const openFlowPreview = useCallback(async (item) => {
    const key = `preview:${item.id}@${item.version}`;
    setBusy(key);
    setError("");
    try {
      const response = await fetch("/api/marketplace/flows/workspace-preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: item.id,
          version: item.version,
          kind: item.resourceType === "node" ? "node" : item.resourceType === "flow-snippet" ? "snippet" : "flow",
          projectFlow: item.projectFlow === true,
        }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      navigate(body.url);
    } catch (previewError) {
      setError(String(previewError?.message || previewError));
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
          <span className="af-marketplace-eyebrow">AGENTFLOW FLOW REPOSITORY</span>
          <h1>流程仓库</h1>
          <p>发现经过验证的可运行流程与可审阅节点，预览后再加入自己的 Workspace。</p>
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
        {kind === "flow" ? (
          <div className="af-marketplace-scopes af-marketplace-release-tabs" aria-label="稳定状态">
            {FLOW_RELEASE_STATES.map((item) => (
              <button key={item.id} type="button" className={releaseState === item.id ? "is-active" : ""} onClick={() => setReleaseState(item.id)}>
                {item.label}
              </button>
            ))}
          </div>
        ) : null}
        <span className="af-marketplace-sort">
          <span className="material-symbols-outlined">trending_down</span>
          使用次数从高到低
        </span>
      </div>

      {error ? <div className="af-marketplace-error">{error}</div> : null}
      {loading && items.length === 0 ? <div className="af-marketplace-empty">正在加载流程仓库…</div> : null}
      {!loading && items.length === 0 ? (
        <div className="af-marketplace-empty">
          {scope === "owned"
            ? "你还没有发布匹配的资源"
            : kind === "flow" && releaseState === "stable"
              ? "没有匹配的 Stable 流程"
              : kind === "flow" && releaseState === "draft"
                ? "没有匹配的 Draft 流程"
                : `没有匹配的${kind === "flow" ? "流程" : "节点"}`}
        </div>
      ) : null}

      <section className="af-marketplace-grid">
        {items.map((item, index) => {
          const resourceType = item.resourceType || kind;
          const key = `${resourceType}:${item.id}@${item.version || item.definitionId || index}`;
          const mine = ownedBy(item, authUser);
          const visibilityBusy = busy === `visibility:${resourceType}:${item.id}@${item.version}`;
          const deleteBusy = busy === `delete:${resourceType}:${item.id}@${item.version}`;
          const previewBusy = busy === `preview:${item.id}@${item.version}`;
          return (
            <article className="af-marketplace-card" key={key}>
              <div className="af-marketplace-card__top">
                <span className="af-marketplace-rank">#{index + 1}</span>
                <div className="af-marketplace-card__badges">
                  {resourceType === "flow" ? (
                    <span className={`af-marketplace-release-state is-${item.releaseState || "draft"}`}>
                      <span className="material-symbols-outlined">{item.releaseState === "stable" ? "verified" : "edit_note"}</span>
                      {item.releaseState === "stable"
                        ? `${item.stableReleaseId ? `Stable ${item.stableReleaseId}` : "Stable"}${item.hasUnpublishedChanges ? " · 有调整" : ""}`
                        : "Draft"}
                    </span>
                  ) : null}
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
              </div>
              <h2>{item.displayName || item.id}</h2>
              <p>{item.description || "暂无说明"}</p>
              <div className="af-marketplace-version">
                {item.definitionId || item.id}{item.runModeLabel ? ` · ${item.runModeLabel}` : ""}{item.versionLabel ? ` · ${item.versionLabel}` : item.version ? ` · v${item.version}` : ""}
              </div>
              <div className="af-marketplace-stats">
                <strong><span className="material-symbols-outlined">play_circle</span>{formatCount(item.useCount)}<small>使用</small></strong>
              </div>
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
                    <button
                      className="is-primary"
                      type="button"
                      disabled={previewBusy}
                      onClick={() => void openFlowPreview(item)}
                    >
                      {previewBusy ? "打开中…" : "预览"}
                    </button>
                  ) : (
                    <button
                      className="is-primary"
                      type="button"
                      disabled={previewBusy}
                      onClick={() => void openFlowPreview(item)}
                    >
                      {previewBusy ? "打开中…" : "预览"}
                    </button>
                  )}
                </div>
              </footer>
            </article>
          );
        })}
      </section>

      {nextCursor ? (
        <div className="af-marketplace-pagination">
          <button type="button" disabled={loading} onClick={() => void load({ cursor: nextCursor, append: true })}>
            {loading ? "正在加载…" : `加载更多（已显示 ${items.length} / ${total}）`}
          </button>
        </div>
      ) : null}

    </main>
  );
}
