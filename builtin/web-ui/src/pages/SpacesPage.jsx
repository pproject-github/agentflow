import { useCallback, useEffect, useMemo, useState } from "react";

import LoadingState from "../components/LoadingState.jsx";
import { useRoute } from "../routeContext.jsx";

function slugify(value = "") {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function queryDraft() {
  const params = new URLSearchParams(window.location.search);
  return {
    selectedSpaceId: params.get("spaceId") || "",
    shareId: params.get("shareId") || "",
    title: params.get("title") || "",
  };
}

export default function SpacesPage() {
  const { navigate } = useRoute();
  const initial = useMemo(queryDraft, []);
  const [spaces, setSpaces] = useState([]);
  const [selectedId, setSelectedId] = useState(initial.selectedSpaceId);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [createDraft, setCreateDraft] = useState({ title: "", slug: "", visibility: "public" });
  const [pageDraft, setPageDraft] = useState({
    shareId: initial.shareId,
    title: initial.title || "新页面",
    path: "/",
  });

  const selected = spaces.find((space) => space.id === selectedId) || spaces[0] || null;

  const load = useCallback(async (preferredId = "") => {
    setLoading(true);
    setError("");
    try {
      const response = await fetch("/api/spaces");
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error || "读取空间失败");
      const next = Array.isArray(json.spaces) ? json.spaces : [];
      setSpaces(next);
      setSelectedId((current) => preferredId || current || next[0]?.id || "");
    } catch (loadError) {
      setError(String(loadError?.message || loadError));
      setSpaces([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(initial.selectedSpaceId);
  }, [initial.selectedSpaceId, load]);

  const createNewSpace = useCallback(async () => {
    const title = createDraft.title.trim();
    if (!title) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/spaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          slug: createDraft.slug || slugify(title),
          visibility: createDraft.visibility,
        }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error || "创建空间失败");
      setCreateDraft({ title: "", slug: "", visibility: "public" });
      setMessage("空间已创建");
      await load(json.space?.id || "");
    } catch (createError) {
      setError(String(createError?.message || createError));
    } finally {
      setBusy(false);
    }
  }, [createDraft, load]);

  const patchSpace = useCallback(async (patch) => {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch("/api/spaces", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: selected.id, ...patch }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error || "更新空间失败");
      setSpaces((current) => current.map((space) => space.id === selected.id ? json.space : space));
      setMessage("空间设置已更新");
    } catch (patchError) {
      setError(String(patchError?.message || patchError));
    } finally {
      setBusy(false);
    }
  }, [selected]);

  const bindPage = useCallback(async () => {
    if (!selected || !pageDraft.shareId.trim() || !pageDraft.title.trim()) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch("/api/spaces/page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          spaceId: selected.id,
          shareId: pageDraft.shareId.trim(),
          title: pageDraft.title.trim(),
          path: pageDraft.path.trim() || "/",
        }),
      });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error || "发布页面失败");
      setSpaces((current) => current.map((space) => space.id === selected.id ? json.space : space));
      setMessage("页面已发布到空间，路由永久有效");
      setPageDraft({ shareId: "", title: "新页面", path: "/" });
      window.history.replaceState({}, "", `/spaces?spaceId=${encodeURIComponent(selected.id)}`);
    } catch (bindError) {
      setError(String(bindError?.message || bindError));
    } finally {
      setBusy(false);
    }
  }, [pageDraft, selected]);

  const removePage = useCallback(async (page) => {
    if (!selected || !window.confirm(`从空间移除“${page.title}”？底层 Flow 和展示内容不会被删除。`)) return;
    setBusy(true);
    setError("");
    try {
      const params = new URLSearchParams({ spaceId: selected.id, pageId: page.id });
      const response = await fetch(`/api/spaces/page?${params.toString()}`, { method: "DELETE" });
      const json = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(json.error || "移除页面失败");
      setSpaces((current) => current.map((space) => space.id === selected.id ? json.space : space));
      setMessage("页面已从目录移除");
    } catch (removeError) {
      setError(String(removeError?.message || removeError));
    } finally {
      setBusy(false);
    }
  }, [selected]);

  if (loading) return <LoadingState variant="page" title="正在读取空间" detail="加载页面目录与发布状态…" />;

  return (
    <div className="af-spaces-admin">
      <aside className="af-spaces-admin__sidebar">
        <header>
          <h1>空间</h1>
          <p>用固定路由组织长期展示内容。</p>
        </header>
        <nav aria-label="我的空间">
          {spaces.map((space) => (
            <button key={space.id} type="button" className={space.id === selected?.id ? "is-active" : ""} onClick={() => setSelectedId(space.id)}>
              <span>{space.title}</span>
              <small>{space.visibility === "private" ? "私有" : "公开"} · {space.pages.length} 页</small>
            </button>
          ))}
        </nav>
        <div className="af-spaces-admin__create">
          <strong>新建空间</strong>
          <input
            value={createDraft.title}
            onChange={(event) => setCreateDraft((current) => ({ ...current, title: event.target.value, slug: current.slug || slugify(event.target.value) }))}
            placeholder="空间标题"
          />
          <input value={createDraft.slug} onChange={(event) => setCreateDraft((current) => ({ ...current, slug: slugify(event.target.value) }))} placeholder="URL slug" />
          <select value={createDraft.visibility} onChange={(event) => setCreateDraft((current) => ({ ...current, visibility: event.target.value }))}>
            <option value="public">公开</option>
            <option value="private">私有</option>
          </select>
          <button type="button" disabled={busy || !createDraft.title.trim()} onClick={() => void createNewSpace()}>创建</button>
        </div>
      </aside>

      <main className="af-spaces-admin__main">
        {selected ? (
          <>
            <header className="af-spaces-admin__head">
              <div>
                <span>SPACE</span>
                <h2>{selected.title}</h2>
                <code>/s/{selected.ownerId}/{selected.slug}</code>
              </div>
              <div className="af-spaces-admin__head-actions">
                <button type="button" onClick={() => navigate(`/s/${encodeURIComponent(selected.ownerId)}/${encodeURIComponent(selected.slug)}`)}>打开空间</button>
                <button type="button" disabled={busy} onClick={() => void patchSpace({ visibility: selected.visibility === "private" ? "public" : "private" })}>
                  {selected.visibility === "private" ? "设为公开" : "设为私有"}
                </button>
                <button type="button" disabled={busy} onClick={() => void patchSpace({ status: selected.status === "paused" ? "active" : "paused" })}>
                  {selected.status === "paused" ? "重新启用" : "暂停"}
                </button>
              </div>
            </header>

            <section className="af-spaces-admin__section">
              <div className="af-spaces-admin__section-title">
                <h3>页面目录</h3>
                <span>页面没有独立 TTL；暂停空间也不会删除内容。</span>
              </div>
              <div className="af-spaces-admin__pages">
                {selected.pages.length ? selected.pages.map((page) => (
                  <div key={page.id} className="af-spaces-admin__page-row">
                    <button type="button" onClick={() => navigate(`/s/${encodeURIComponent(selected.ownerId)}/${encodeURIComponent(selected.slug)}${page.path === "/" ? "" : page.path}`)}>{page.title}</button>
                    <code>{page.path}</code>
                    <span>{page.hidden ? "隐藏" : "显示"}</span>
                    <button type="button" className="is-danger" disabled={busy} onClick={() => void removePage(page)}>移除</button>
                  </div>
                )) : <p className="af-spaces-admin__empty">还没有页面。从 Workspace 生成展示内容后，可以直接发布到这里。</p>}
              </div>
            </section>

            <section className="af-spaces-admin__section">
              <div className="af-spaces-admin__section-title">
                <h3>发布页面</h3>
                <span>同一路径再次发布会更新绑定，不会更换公开 URL。</span>
              </div>
              <div className="af-spaces-admin__publish">
                <label><span>页面标题</span><input value={pageDraft.title} onChange={(event) => setPageDraft((current) => ({ ...current, title: event.target.value }))} /></label>
                <label><span>页面路径</span><input value={pageDraft.path} onChange={(event) => setPageDraft((current) => ({ ...current, path: event.target.value }))} placeholder="/" /></label>
                <label><span>展示 Share ID</span><input value={pageDraft.shareId} onChange={(event) => setPageDraft((current) => ({ ...current, shareId: event.target.value }))} placeholder="从 Workspace 分享结果带入" /></label>
                <button type="button" disabled={busy || !pageDraft.shareId.trim() || !pageDraft.title.trim()} onClick={() => void bindPage()}>{busy ? "发布中…" : "发布到空间"}</button>
              </div>
            </section>
          </>
        ) : (
          <div className="af-spaces-admin__welcome">
            <span className="material-symbols-outlined" aria-hidden>library_books</span>
            <h2>创建第一个空间</h2>
            <p>空间提供固定 URL、左侧页面目录和长期展示内容。</p>
          </div>
        )}
        {error ? <div className="af-spaces-admin__notice is-error">{error}</div> : null}
        {message ? <div className="af-spaces-admin__notice">{message}</div> : null}
      </main>
    </div>
  );
}
