import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  ReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ChartDisplayContent, MarkdownDisplayContent, TableDisplayContent } from "../displayRenderers.jsx";
import { useRoute } from "../routeContext.jsx";

function displayContent(node) {
  const slots = [...(node?.inputs || []), ...(node?.outputs || [])];
  const primaryName = node?.kind === "image" ? "src" : "content";
  const slotText = (slot) => String(slot?.value ?? slot?.default ?? "");
  const hasSlotText = (slot) => slotText(slot).trim();
  const contentSlot =
    slots.find((slot) => slot?.name === primaryName && hasSlotText(slot)) ||
    slots.find((slot) => slot?.name === "filePath" && hasSlotText(slot)) ||
    slots.find((slot) => slot?.type === "text" && hasSlotText(slot));
  return String(node?.body || (contentSlot ? slotText(contentSlot) : ""));
}

function displayIcon(kind) {
  if (kind === "mermaid") return "account_tree";
  if (kind === "ascii") return "notes";
  if (kind === "html") return "html";
  if (kind === "image") return "image";
  if (kind === "chart") return "bar_chart";
  if (kind === "table") return "table";
  return "article";
}

function normalizeHtmlDisplayContent(content) {
  let text = String(content || "").trim();
  if (!text) return "";
  const fenced = text.match(/```(?:html|HTML)?\s*\n?([\s\S]*?)```/);
  if (fenced && fenced[1]) text = fenced[1].trim();
  else {
    const openFence = text.match(/```(?:html|HTML)?\s*\n?([\s\S]*)$/);
    if (openFence && openFence[1]) text = openFence[1].trim();
  }
  text = text.replace(/^html\s*\n/i, "").replace(/```\s*$/g, "").trim();
  const markerPatterns = [
    /<!doctype\b/i,
    /<html\b/i,
    /<head\b/i,
    /<body\b/i,
    /<style\b/i,
    /<script\b/i,
    /<main\b/i,
    /<section\b/i,
    /<article\b/i,
    /<div\b/i,
    /<svg\b/i,
    /<canvas\b/i,
  ];
  const firstHtmlIndex = markerPatterns.reduce((best, pattern) => {
    const match = pattern.exec(text);
    if (!match) return best;
    return best < 0 ? match.index : Math.min(best, match.index);
  }, -1);
  if (firstHtmlIndex > 0) text = text.slice(firstHtmlIndex).trim();
  return text;
}

function htmlDisplaySrcDoc(content) {
  const html = normalizeHtmlDisplayContent(content);
  if (!html.trim()) return "";
  if (/<base\s+[^>]*target\s*=/i.test(html)) return html;
  const base = '<base target="_blank">';
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b([^>]*)>/i, `<head$1>${base}`);
  }
  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(/<html\b([^>]*)>/i, `<html$1><head>${base}</head>`);
  }
  return `<!doctype html><html><head>${base}</head><body>${html}</body></html>`;
}

function displayFileUrl(src, shareId) {
  const text = String(src || "").trim();
  if (!text) return "";
  if (/^(?:https?:|data:|blob:|file:)/i.test(text) || text.startsWith("/")) return text;
  const q = new URLSearchParams();
  q.set("id", shareId);
  q.set("path", text);
  return `/api/display/file/raw?${q.toString()}`;
}

function markdownImageSrc(src, shareId) {
  const text = String(src || "").trim();
  if (!text) return "";
  return displayFileUrl(text, shareId);
}

function VisibleScrollFrame({ className = "", children }) {
  const scrollerRef = useRef(null);
  const scrollbarTrackRef = useRef(null);
  const [scrollbar, setScrollbar] = useState({ visible: false, top: 0, height: 100 });

  const updateScrollbar = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const scrollHeight = Math.max(1, el.scrollHeight);
    const clientHeight = Math.max(1, el.clientHeight);
    const visible = scrollHeight > clientHeight + 1;
    const height = visible ? Math.max(12, (clientHeight / scrollHeight) * 100) : 100;
    const maxTop = Math.max(0, 100 - height);
    const top = visible ? Math.min(maxTop, (el.scrollTop / Math.max(1, scrollHeight - clientHeight)) * maxTop) : 0;
    setScrollbar({ visible, top, height });
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(updateScrollbar);
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === "undefined") {
      return () => cancelAnimationFrame(frame);
    }
    const observer = new ResizeObserver(updateScrollbar);
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [children, updateScrollbar]);

  const scrollToRatio = useCallback((ratio) => {
    const el = scrollerRef.current;
    if (!el) return;
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTop = Math.min(1, Math.max(0, ratio)) * maxScroll;
    updateScrollbar();
  }, [updateScrollbar]);

  const pointerRatioFromTrack = useCallback((clientY, grabOffsetPx = 0) => {
    const track = scrollbarTrackRef.current;
    if (!track) return 0;
    const rect = track.getBoundingClientRect();
    const thumbPx = (scrollbar.height / 100) * rect.height;
    const maxTopPx = Math.max(1, rect.height - thumbPx);
    return (clientY - rect.top - grabOffsetPx) / maxTopPx;
  }, [scrollbar.height]);

  const handleScrollbarPointerDown = useCallback((event) => {
    if (!scrollbar.visible) return;
    event.preventDefault();
    event.stopPropagation();
    const track = scrollbarTrackRef.current;
    if (!track) return;
    const rect = track.getBoundingClientRect();
    const thumbTopPx = (scrollbar.top / 100) * rect.height;
    const thumbHeightPx = (scrollbar.height / 100) * rect.height;
    const insideThumb = event.clientY >= rect.top + thumbTopPx && event.clientY <= rect.top + thumbTopPx + thumbHeightPx;
    const grabOffsetPx = insideThumb ? event.clientY - rect.top - thumbTopPx : thumbHeightPx / 2;
    scrollToRatio(pointerRatioFromTrack(event.clientY, grabOffsetPx));
    const onMove = (moveEvent) => {
      moveEvent.preventDefault();
      scrollToRatio(pointerRatioFromTrack(moveEvent.clientY, grabOffsetPx));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, [pointerRatioFromTrack, scrollToRatio, scrollbar.height, scrollbar.top, scrollbar.visible]);

  return (
    <div className={`af-public-display-node__body ${className} nowheel nopan nodrag`}>
      <div ref={scrollerRef} className={`af-public-display-node__scroller ${className} nowheel nopan nodrag`} onScroll={updateScrollbar}>
        {children}
      </div>
      <div
        ref={scrollbarTrackRef}
        className={"af-public-display-scrollbar" + (scrollbar.visible ? " af-public-display-scrollbar--visible" : "")}
        onPointerDown={handleScrollbarPointerDown}
        aria-hidden="true"
      >
        <span style={{ height: `${scrollbar.height}%`, top: `${scrollbar.top}%` }} />
      </div>
    </div>
  );
}

function DisplayNode({ node, shareId, style }) {
  const raw = displayContent(node);
  const content = node.kind === "html" ? normalizeHtmlDisplayContent(raw) : raw;
  const bodyClassName = `af-public-display-node__body--${node.kind || "unknown"}`;
  return (
    <section className={`af-public-display-node af-public-display-node--${node.kind || "unknown"}`} style={style}>
      <div className="af-public-display-node__head">
        <div className="af-public-display-node__title">
          <span className="material-symbols-outlined" aria-hidden>{displayIcon(node.kind)}</span>
          <strong>{node.label || node.id}</strong>
          <em>{node.definitionId || node.kind || "display"}</em>
        </div>
      </div>
      <VisibleScrollFrame className={bodyClassName}>
        {content.trim() ? (
          <>
            {node.kind === "html" ? <iframe title={node.label || node.id} sandbox="allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox" srcDoc={htmlDisplaySrcDoc(content)} /> : null}
            {node.kind === "image" ? <img src={displayFileUrl(content, shareId)} alt={node.label || node.id} loading="lazy" /> : null}
            {node.kind === "markdown" ? (
              <div className="af-public-display-markdown">
                <MarkdownDisplayContent content={content} resolveSrc={(src) => markdownImageSrc(src, shareId)} />
              </div>
            ) : null}
            {node.kind === "chart" ? <ChartDisplayContent content={content} /> : null}
            {node.kind === "table" ? <TableDisplayContent content={content} /> : null}
            {node.kind === "mermaid" || node.kind === "ascii" ? <pre>{content}</pre> : null}
          </>
        ) : (
          <div className="af-public-display-empty">No display content</div>
        )}
      </VisibleScrollFrame>
    </section>
  );
}

function PublicDisplayFlowNode({ data }) {
  return <DisplayNode node={data?.node} shareId={data?.shareId} />;
}

const publicDisplayNodeTypes = { publicDisplay: PublicDisplayFlowNode };

function displayShareIdFromPath(path) {
  const parts = String(path || "").split("/").filter(Boolean);
  if (parts[0] === "display" && parts[1]) return decodeURIComponent(parts[1]);
  return new URLSearchParams(window.location.search).get("id") || "";
}

export default function DisplayPage() {
  const { path } = useRoute();
  const shareId = useMemo(() => displayShareIdFromPath(path), [path]);
  const [state, setState] = useState({ loading: true, error: "", share: null, nodes: [] });

  useEffect(() => {
    let disposed = false;
    async function load() {
      if (!shareId) {
        setState({ loading: false, error: "Missing display share id", share: null, nodes: [] });
        return;
      }
      setState((prev) => ({ ...prev, loading: true, error: "" }));
      try {
        const res = await fetch(`/api/display/share?id=${encodeURIComponent(shareId)}`);
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || "展示页不存在");
        if (!disposed) setState({ loading: false, error: "", share: json.share || null, nodes: Array.isArray(json.nodes) ? json.nodes : [] });
      } catch (err) {
        if (!disposed) setState({ loading: false, error: String(err?.message || err), share: null, nodes: [] });
      }
    }
    load();
    return () => {
      disposed = true;
    };
  }, [shareId]);

  const flowNodes = useMemo(() => {
    const nodes = Array.isArray(state.nodes) ? state.nodes : [];
    return nodes.map((node, index) => {
      const pos = node.position && typeof node.position.x === "number" && typeof node.position.y === "number"
        ? node.position
        : { x: 120 + index * 40, y: 100 + index * 32 };
      const size = node.size && typeof node.size.width === "number" && typeof node.size.height === "number"
        ? node.size
        : { width: 520, height: 320 };
      return {
        id: node.id,
        type: "publicDisplay",
        position: pos,
        data: { node, shareId },
        selectable: false,
        draggable: false,
        style: {
          width: Math.max(1, Number(size.width) || 520),
          height: Math.max(1, Number(size.height) || 320),
        },
      };
    });
  }, [shareId, state.nodes]);
  const fixedViewport = useMemo(() => {
    const viewport = state.share?.viewport;
    if (!viewport || typeof viewport !== "object") return null;
    const x = Number(viewport.x);
    const y = Number(viewport.y);
    const zoom = Number(viewport.zoom);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom)) return null;
    return { x, y, zoom: Math.min(Math.max(zoom, 0.1), 4) };
  }, [state.share?.viewport]);

  if (state.loading) {
    return <main className="af-public-display-page"><div className="af-public-display-status">Loading...</div></main>;
  }
  if (state.error) {
    return (
      <main className="af-public-display-page">
        <div className="af-public-display-status af-public-display-status--error">
          <span className="material-symbols-outlined" aria-hidden>error</span>
          <span>{state.error}</span>
        </div>
      </main>
    );
  }

  return (
    <main className="af-public-display-page af-public-display-page--canvas">
      <ReactFlowProvider>
        <ReactFlow
          className="af-public-display-flow"
          nodes={flowNodes}
          edges={[]}
          nodeTypes={publicDisplayNodeTypes}
          nodesDraggable={false}
          nodesConnectable={false}
          elementsSelectable={false}
          panOnDrag
          noPanClassName="nopan"
          noDragClassName="nodrag"
          noWheelClassName="nowheel"
          panOnScroll
          zoomOnScroll
          zoomOnPinch
          defaultViewport={fixedViewport || undefined}
          fitView={!fixedViewport}
          fitViewOptions={{ padding: 0.18, duration: 180 }}
          minZoom={0.1}
          maxZoom={4}
          proOptions={{ hideAttribution: true }}
        >
          <Background color="rgba(255,255,255,0.12)" gap={22} size={1} />
        </ReactFlow>
      </ReactFlowProvider>
    </main>
  );
}
