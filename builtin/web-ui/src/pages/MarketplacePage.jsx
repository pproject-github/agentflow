import { useCallback, useEffect, useMemo, useState } from "react";

import { useRoute } from "../routeContext.jsx";

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

export default function MarketplacePage({ authUser }) {
  const { navigate } = useRoute();
  const [kind, setKind] = useState("flow");
  const [owned, setOwned] = useState(false);
  const [query, setQuery] = useState("");
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const params = new URLSearchParams({ kind, sort: "useCount", order: "desc" });
      if (owned) params.set("scope", "owned");
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
  }, [kind, owned, query]);

  useEffect(() => {
    const timer = window.setTimeout(load, 180);
    return () => window.clearTimeout(timer);
  }, [load]);

  const visibleItems = useMemo(() => items, [items]);

  const installFlow = useCallback(async (item) => {
    const flowId = window.prompt("安装到个人空间，Flow ID：", item.id);
    if (!flowId) return;
    const key = `install:${item.id}@${item.version}`;
    setBusy(key);
    setError("");
    try {
      const response = await fetch("/api/marketplace/flows/install", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, version: item.version, flowId }),
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
    const key = `visibility:${item.id}@${item.version}`;
    setBusy(key);
    setError("");
    try {
      const response = await fetch("/api/marketplace/visibility", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, id: item.id, version: item.version, visibility: nextVisibility }),
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
      await load();
    } catch (visibilityError) {
      setError(String(visibilityError?.message || visibilityError));
    } finally {
      setBusy("");
    }
  }, [kind, load]);

  return (
    <main className="af-marketplace-page">
      <header className="af-marketplace-hero">
        <div>
          <span className="af-marketplace-eyebrow">AGENTFLOW MARKETPLACE</span>
          <h1>市场</h1>
          <p>发现可运行的 Flow 模板与可复用节点，默认按真实使用次数排序。</p>
        </div>
        <label className="af-marketplace-search">
          <span className="material-symbols-outlined">search</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、说明、作者或标签" />
        </label>
      </header>

      <div className="af-marketplace-toolbar">
        <div className="af-marketplace-tabs">
          <button type="button" className={kind === "flow" ? "is-active" : ""} onClick={() => setKind("flow")}>流程</button>
          <button type="button" className={kind === "node" ? "is-active" : ""} onClick={() => setKind("node")}>节点</button>
        </div>
        <label className="af-marketplace-owned">
          <input type="checkbox" checked={owned} onChange={(event) => setOwned(event.target.checked)} />
          只看我的发布（含私有）
        </label>
        <span className="af-marketplace-sort"><span className="material-symbols-outlined">trending_down</span>使用次数从高到低</span>
      </div>

      {error ? <div className="af-marketplace-error">{error}</div> : null}
      {loading ? <div className="af-marketplace-empty">正在加载市场…</div> : null}
      {!loading && visibleItems.length === 0 ? <div className="af-marketplace-empty">没有匹配的{kind === "flow" ? "流程" : "节点"}</div> : null}

      <section className="af-marketplace-grid">
        {visibleItems.map((item, index) => {
          const key = `${kind}:${item.id}@${item.version}`;
          const mine = ownedBy(item, authUser);
          return (
            <article className="af-marketplace-card" key={key}>
              <div className="af-marketplace-card__top">
                <span className="af-marketplace-rank">#{index + 1}</span>
                <span className={`af-marketplace-visibility is-${item.visibility || "public"}`}>
                  <span className="material-symbols-outlined">{item.visibility === "private" ? "lock" : "public"}</span>
                  {item.visibility === "private" ? "私有" : "公开"}
                </span>
              </div>
              <div className="af-marketplace-kind-icon"><span className="material-symbols-outlined">{kind === "flow" ? "schema" : "deployed_code"}</span></div>
              <h2>{item.displayName || item.id}</h2>
              <p>{item.description || "暂无说明"}</p>
              <div className="af-marketplace-version">{item.id} · v{item.version}</div>
              <div className="af-marketplace-stats">
                <strong><span className="material-symbols-outlined">play_circle</span>{formatCount(item.useCount)}<small>使用</small></strong>
                <strong><span className="material-symbols-outlined">download</span>{formatCount(item.installCount)}<small>安装</small></strong>
                <strong><span className="material-symbols-outlined">group</span>{formatCount(item.uniqueUserCount)}<small>用户</small></strong>
              </div>
              <footer>
                <span>by {item.ownerUserId || "AgentFlow"}</span>
                <div>
                  {mine ? (
                    <button type="button" disabled={busy === `visibility:${item.id}@${item.version}`} onClick={() => toggleVisibility(item)}>
                      {item.visibility === "private" ? "设为公开" : "设为私有"}
                    </button>
                  ) : null}
                  {kind === "flow" ? (
                    <button className="is-primary" type="button" disabled={busy === `install:${item.id}@${item.version}`} onClick={() => installFlow(item)}>
                      {busy === `install:${item.id}@${item.version}` ? "安装中…" : "安装到个人空间"}
                    </button>
                  ) : (
                    <button className="is-primary" type="button" onClick={() => navigate("/nodes")}>在流程中使用</button>
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
