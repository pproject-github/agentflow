import { useEffect, useMemo, useState } from "react";

import LoadingState from "../components/LoadingState.jsx";
import { useRoute } from "../routeContext.jsx";
import { DisplayNode } from "./DisplayPage.jsx";

function parseSpacePath(pathname = "") {
  const parts = String(pathname || "").split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  if (parts[0] !== "s" || !parts[1] || !parts[2]) return { owner: "", slug: "", pagePath: "/" };
  return {
    owner: parts[1],
    slug: parts[2],
    pagePath: parts.length > 3 ? `/${parts.slice(3).join("/")}` : "/",
  };
}

function spacePageHref(space, page) {
  const root = `/s/${encodeURIComponent(space.ownerId)}/${encodeURIComponent(space.slug)}`;
  return page.path === "/"
    ? root
    : `${root}${page.path.split("/").filter(Boolean).map(encodeURIComponent).reduce((out, part) => `${out}/${part}`, "")}`;
}

export default function SpacePage() {
  const { path, navigate } = useRoute();
  const route = useMemo(() => parseSpacePath(path), [path]);
  const [state, setState] = useState({ loading: true, error: "", space: null, manageable: false, share: null, nodes: [] });

  useEffect(() => {
    let disposed = false;
    async function load() {
      if (!route.owner || !route.slug) {
        setState({ loading: false, error: "空间地址不完整", space: null, manageable: false, share: null, nodes: [] });
        return;
      }
      setState((current) => ({ ...current, loading: true, error: "" }));
      try {
        const params = new URLSearchParams({ owner: route.owner, slug: route.slug });
        const spaceResponse = await fetch(`/api/spaces/public?${params.toString()}`);
        const spaceJson = await spaceResponse.json().catch(() => ({}));
        if (!spaceResponse.ok) throw new Error(spaceJson.error || "空间不存在");
        const space = spaceJson.space || null;
        const pages = (Array.isArray(space?.pages) ? space.pages : [])
          .filter((page) => !page.hidden || spaceJson.manageable)
          .sort((a, b) => Number(a.order || 0) - Number(b.order || 0));
        const selected = pages.find((page) => page.path === route.pagePath)
          || (route.pagePath === "/" ? pages.find((page) => page.path === "/") || pages[0] : null);
        if (!selected) {
          if (!disposed) setState({ loading: false, error: pages.length ? "页面不存在" : "这个空间还没有页面", space, manageable: Boolean(spaceJson.manageable), share: null, nodes: [] });
          return;
        }
        const shareResponse = await fetch(`/api/display/share?id=${encodeURIComponent(selected.shareId)}`);
        const shareJson = await shareResponse.json().catch(() => ({}));
        if (!shareResponse.ok) throw new Error(shareJson.error || "页面内容不可用");
        if (!disposed) setState({
          loading: false,
          error: "",
          space: { ...space, pages, selectedPage: selected },
          manageable: Boolean(spaceJson.manageable),
          share: shareJson.share || null,
          nodes: Array.isArray(shareJson.nodes) ? shareJson.nodes : [],
        });
      } catch (error) {
        if (!disposed) setState({ loading: false, error: String(error?.message || error), space: null, manageable: false, share: null, nodes: [] });
      }
    }
    void load();
    return () => {
      disposed = true;
    };
  }, [route.owner, route.pagePath, route.slug]);

  if (state.loading) {
    return <main className="af-space-public"><LoadingState variant="page" title="正在打开空间" detail="同步页面目录与最新内容…" /></main>;
  }

  const space = state.space;
  if (!space) {
    return (
      <main className="af-space-public af-space-public--status">
        <div className="af-space-public__message"><span className="material-symbols-outlined">error</span>{state.error}</div>
      </main>
    );
  }

  return (
    <main className="af-space-public">
      <aside className="af-space-public__sidebar">
        <div className="af-space-public__identity">
          <span className="material-symbols-outlined" aria-hidden>library_books</span>
          <div>
            <strong>{space.title}</strong>
            {space.description ? <small>{space.description}</small> : null}
          </div>
        </div>
        <nav className="af-space-public__nav" aria-label={`${space.title} 页面目录`}>
          {(space.pages || []).map((page) => (
            <button
              key={page.id}
              type="button"
              className={page.id === space.selectedPage?.id ? "is-active" : ""}
              onClick={() => navigate(spacePageHref(space, page))}
            >
              <span>{page.title}</span>
              {page.hidden ? <em>隐藏</em> : null}
            </button>
          ))}
        </nav>
        {state.manageable ? (
          <button type="button" className="af-space-public__manage" onClick={() => navigate(`/spaces?spaceId=${encodeURIComponent(space.id)}`)}>
            <span className="material-symbols-outlined" aria-hidden>settings</span>
            管理空间
          </button>
        ) : null}
      </aside>
      <section className="af-space-public__main">
        <header className="af-space-public__page-head">
          <h1>{space.selectedPage?.title || space.title}</h1>
          <span>{space.updatedAt ? `更新于 ${new Date(space.updatedAt).toLocaleString()}` : ""}</span>
        </header>
        {state.error ? <div className="af-space-public__message">{state.error}</div> : null}
        <div className="af-space-public__content">
          {state.nodes.length ? state.nodes.map((node) => (
            <DisplayNode key={node.id} node={node} shareId={space.selectedPage?.shareId || ""} bare />
          )) : <div className="af-space-public__empty">这个页面还没有展示内容。</div>}
        </div>
      </section>
    </main>
  );
}
