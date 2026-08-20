import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useState } from "react";

import { flowUrlForView } from "../pipelineViewPreference.js";
import { useRoute } from "../routeContext.jsx";

function previewTarget() {
  const params = new URLSearchParams(window.location.search);
  return {
    id: String(params.get("id") || "").trim(),
    version: String(params.get("version") || "").trim(),
  };
}

function projectKey(project) {
  return `${project?.source || "user"}:${project?.id || ""}:${project?.collaboration?.id || ""}`;
}

function fallbackPosition(index) {
  return { x: (index % 3) * 300, y: Math.floor(index / 3) * 160 };
}

function snippetGraph(snippet) {
  const instances = snippet?.snippet?.instances && typeof snippet.snippet.instances === "object"
    ? snippet.snippet.instances
    : {};
  const positions = snippet?.snippet?.ui?.nodePositions && typeof snippet.snippet.ui.nodePositions === "object"
    ? snippet.snippet.ui.nodePositions
    : {};
  const nodes = Object.entries(instances).map(([id, instance], index) => {
    const stored = positions[id];
    const position = Number.isFinite(stored?.x) && Number.isFinite(stored?.y)
      ? { x: Number(stored.x), y: Number(stored.y) }
      : fallbackPosition(index);
    const label = String(instance?.label || instance?.displayName || instance?.name || id);
    const definition = String(instance?.definitionId || id).replace(/^marketplace:/, "");
    return {
      id,
      position,
      className: "af-marketplace-preview-node",
      data: {
        label: (
          <span className="af-marketplace-preview-node__content">
            <strong>{label}</strong>
            <small>{definition}</small>
          </span>
        ),
      },
      draggable: false,
      connectable: false,
      selectable: true,
    };
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = (Array.isArray(snippet?.snippet?.edges) ? snippet.snippet.edges : [])
    .filter((edge) => nodeIds.has(String(edge?.source || "")) && nodeIds.has(String(edge?.target || "")))
    .map((edge, index) => ({
      id: String(edge?.id || `${edge.source}-${edge.target}-${index}`),
      source: String(edge.source),
      target: String(edge.target),
      animated: false,
      markerEnd: { type: MarkerType.ArrowClosed, color: "#8c73df" },
      style: { stroke: "#8c73df", strokeWidth: 2 },
    }));
  return { nodes, edges };
}

function MarketplaceSnippetPreviewInner() {
  const { navigate } = useRoute();
  const target = useMemo(previewTarget, []);
  const [snippet, setSnippet] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [projectPickerOpen, setProjectPickerOpen] = useState(false);
  const [projects, setProjects] = useState([]);
  const [selectedProjectKey, setSelectedProjectKey] = useState("");
  const [projectsLoading, setProjectsLoading] = useState(false);
  const [projectsError, setProjectsError] = useState("");

  useEffect(() => {
    let active = true;
    const load = async () => {
      setLoading(true);
      setError("");
      try {
        if (!target.id) throw new Error("缺少流程片段 ID");
        const response = await fetch("/api/marketplace/flow-snippets");
        const body = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
        const found = (Array.isArray(body.snippets) ? body.snippets : []).find((item) => (
          String(item.id || "") === target.id
          && (!target.version || String(item.version || "") === target.version)
        ));
        if (!found) throw new Error(`流程片段不存在或无权访问：${target.id}${target.version ? `@${target.version}` : ""}`);
        if (active) setSnippet(found);
      } catch (loadError) {
        if (active) setError(String(loadError?.message || loadError));
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, [target.id, target.version]);

  const graph = useMemo(() => snippetGraph(snippet), [snippet]);

  const openProjectPicker = useCallback(async () => {
    setProjectPickerOpen(true);
    setProjects([]);
    setSelectedProjectKey("");
    setProjectsLoading(true);
    setProjectsError("");
    try {
      const response = await fetch("/api/flows?view=personal");
      const body = await response.json().catch(() => []);
      if (!response.ok) throw new Error(body?.error || `HTTP ${response.status}`);
      const editable = (Array.isArray(body) ? body : []).filter((flow) => (
        !flow?.archived
        && !["builtin", "admin"].includes(String(flow?.source || "user"))
        && flow?.collaboration?.role !== "viewer"
      ));
      setProjects(editable);
      setSelectedProjectKey(editable[0] ? projectKey(editable[0]) : "");
    } catch (projectError) {
      setProjectsError(String(projectError?.message || projectError));
    } finally {
      setProjectsLoading(false);
    }
  }, []);

  const addToProject = useCallback(() => {
    const project = projects.find((item) => projectKey(item) === selectedProjectKey);
    if (!project || !snippet) return;
    const url = new URL(flowUrlForView(project, "workspace"), window.location.origin);
    url.searchParams.set("marketplaceSnippetId", snippet.id);
    url.searchParams.set("marketplaceSnippetVersion", snippet.version || "1.0.0");
    navigate(`${url.pathname}${url.search}`);
  }, [navigate, projects, selectedProjectKey, snippet]);

  return (
    <main className="af-marketplace-preview-page">
      <header className="af-marketplace-preview-topbar">
        <div className="af-marketplace-preview-topbar__left">
          <button type="button" className="af-icon-btn" onClick={() => navigate("/marketplace?kind=flow")} aria-label="返回流程仓库">
            <span className="material-symbols-outlined" aria-hidden>arrow_back</span>
          </button>
          <div>
            <span>FLOW PREVIEW</span>
            <strong>{snippet?.displayName || snippet?.name || target.id || "流程片段"}</strong>
          </div>
          <em><span className="material-symbols-outlined" aria-hidden>visibility</span>只读预览</em>
        </div>
        <div className="af-marketplace-preview-topbar__right">
          {snippet ? <small>{snippet.nodeCount || graph.nodes.length} 个节点 · {snippet.edgeCount || graph.edges.length} 条连线 · v{snippet.version || "1.0.0"}</small> : null}
          <button type="button" className="af-marketplace-preview-add" disabled={!snippet || loading} onClick={() => void openProjectPicker()}>
            <span className="material-symbols-outlined" aria-hidden>add_to_photos</span>
            添加到 Project
          </button>
        </div>
      </header>

      <section className="af-marketplace-preview-canvas">
        {loading ? <div className="af-marketplace-preview-state">正在加载流程预览…</div> : null}
        {error ? (
          <div className="af-marketplace-preview-state is-error">
            <span className="material-symbols-outlined" aria-hidden>error</span>
            <strong>{error}</strong>
            <button type="button" onClick={() => navigate("/marketplace?kind=flow")}>返回流程仓库</button>
          </div>
        ) : null}
        {!loading && !error && snippet ? (
          <>
            <ReactFlow
              nodes={graph.nodes}
              edges={graph.edges}
              fitView
              fitViewOptions={{ padding: 0.24, maxZoom: 1.15 }}
              minZoom={0.15}
              maxZoom={2.5}
              nodesDraggable={false}
              nodesConnectable={false}
              elementsSelectable={false}
              panOnDrag
              zoomOnScroll
              zoomOnPinch
              zoomOnDoubleClick={false}
              proOptions={{ hideAttribution: true }}
            >
              <Background color="rgba(255,255,255,0.09)" gap={22} size={1} />
              <Controls showInteractive={false} position="bottom-right" />
            </ReactFlow>
            <aside className="af-marketplace-preview-summary">
              <strong>{snippet.description || "暂无说明"}</strong>
              <span>{snippet.id} · 由 {snippet.ownerUserId || "AgentFlow"} 发布</span>
            </aside>
          </>
        ) : null}
      </section>

      {projectPickerOpen ? (
        <div className="af-flow-snippet-modal-overlay" onMouseDown={() => !projectsLoading && setProjectPickerOpen(false)}>
          <div className="af-flow-snippet-modal af-marketplace-preview-project-modal" role="dialog" aria-modal="true" aria-label="添加到 Project" onMouseDown={(event) => event.stopPropagation()}>
            <div className="af-flow-snippet-modal__head">
              <span className="af-flow-snippet-modal__title"><span className="material-symbols-outlined" aria-hidden>add_to_photos</span>添加到 Project</span>
              <button type="button" className="af-flow-snippet-modal__close" disabled={projectsLoading} onClick={() => setProjectPickerOpen(false)} aria-label="关闭">
                <span className="material-symbols-outlined" aria-hidden>close</span>
              </button>
            </div>
            <div className="af-flow-snippet-modal__body">
              <p className="af-marketplace-preview-project-hint">选择目标后，将进入对应 Workspace，并把当前片段复制到调整态画布。</p>
              {projectsLoading ? <div className="af-marketplace-snippet-projects__empty">正在读取 Projects…</div> : null}
              {projectsError ? <div className="af-flow-snippet-error">{projectsError}</div> : null}
              {!projectsLoading && !projectsError && projects.length === 0 ? <div className="af-marketplace-snippet-projects__empty">暂无可编辑 Project。</div> : null}
              <div className="af-marketplace-snippet-project-list">
                {projects.map((project) => {
                  const key = projectKey(project);
                  return (
                    <label key={key} className={selectedProjectKey === key ? "is-selected" : ""}>
                      <input type="radio" name="preview-project" value={key} checked={selectedProjectKey === key} onChange={() => setSelectedProjectKey(key)} />
                      <span><strong>{project.id}</strong><small>{project.source === "workspace" ? "共享 Project" : "个人 Project"}</small></span>
                      <span className="material-symbols-outlined" aria-hidden>arrow_forward</span>
                    </label>
                  );
                })}
              </div>
            </div>
            <div className="af-flow-snippet-modal__foot">
              <button type="button" className="af-flow-snippet-modal__btn" disabled={projectsLoading} onClick={() => setProjectPickerOpen(false)}>取消</button>
              <button type="button" className="af-flow-snippet-modal__btn af-flow-snippet-modal__btn--primary" disabled={!selectedProjectKey || projectsLoading} onClick={addToProject}>添加到流程</button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}

export default function MarketplaceSnippetPreviewPage() {
  return (
    <ReactFlowProvider>
      <MarketplaceSnippetPreviewInner />
    </ReactFlowProvider>
  );
}
