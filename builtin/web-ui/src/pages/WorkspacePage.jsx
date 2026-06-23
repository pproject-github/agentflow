import {
  Background,
  Handle,
  MarkerType,
  NodeResizeControl,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  applyNodeChanges,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import { buildInstancesForYaml } from "../flowFormat.js";
import { FLOW_NODE_TYPE, FlowNode } from "../FlowNode.jsx";
import { filterValidEdges, mergeNodeWithPalette } from "../mergeFlowNodes.js";
import { getHandleColor } from "../nodeSchema.js";
import { flowUrlForView, recordPipelineView } from "../pipelineViewPreference.js";
import { useRoute } from "../routeContext.jsx";

const STORAGE_FALLBACK_KEY = "af:workspace-graph:v2";
const PALETTE_ORDER = ["DISPLAY", "CONTROL", "TOOL", "PROVIDE", "AGENT"];
const HIDDEN_WORKSPACE_DEFS = new Set(["control_start", "control_end"]);

/* global __APP_VERSION__ */
const APP_VERSION = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";

function readFlowParamsFromUrl() {
  const sp = new URLSearchParams(window.location.search);
  return {
    flowId: sp.get("flowId") || "",
    flowSource: sp.get("flowSource") || "user",
    archived: sp.get("archived") === "1" || sp.get("flowArchived") === "1",
  };
}

function flowParamsQuery(params) {
  const q = new URLSearchParams();
  if (params.flowId) q.set("flowId", params.flowId);
  if (params.flowSource) q.set("flowSource", params.flowSource);
  if (params.archived) q.set("archived", "1");
  return q;
}

function workspaceComposerStorageKey(params) {
  const flowId = String(params?.flowId || "").trim();
  if (!flowId) return "";
  const flowSource = String(params?.flowSource || "user").trim() || "user";
  return `af:workspace-composer:${flowId}:${flowSource}${params?.archived ? ":archived" : ""}`;
}

function normalizeWorkspaceComposerMessages(value) {
  return (Array.isArray(value) ? value : [])
    .filter((msg) => msg && (msg.role === "user" || msg.role === "assistant") && typeof msg.text === "string")
    .map((msg) => ({
      role: msg.role,
      text: msg.text,
      ...(msg.error ? { error: true } : {}),
      ...(typeof msg.at === "number" ? { at: msg.at } : {}),
    }))
    .slice(-80);
}

function schemaTypeForDefinition(definitionId, def) {
  const id = String(definitionId || def?.id || "").toLowerCase();
  if (id.startsWith("control_")) return "control";
  if (id.startsWith("provide_")) return "provide";
  if (id.startsWith("tool_")) return "agent";
  return def?.type || "agent";
}

function paletteCategory(node) {
  const id = String(node?.id || "");
  if (id.startsWith("display_")) return "DISPLAY";
  if (/^control/i.test(id)) return "CONTROL";
  if (/^tool/i.test(id)) return "TOOL";
  if (/^provide/i.test(id)) return "PROVIDE";
  return "AGENT";
}

function paletteIcon(cat) {
  if (cat === "DISPLAY") return "preview";
  if (cat === "CONTROL") return "account_tree";
  if (cat === "TOOL") return "build";
  if (cat === "PROVIDE") return "database";
  return "smart_toy";
}

function labelForDefinition(def) {
  return String(def?.displayName || def?.label || def?.id || "Node");
}

function iconForFile(fileName, isDir = false) {
  if (isDir) return "folder";
  const ext = String(fileName || "").toLowerCase().split(".").pop();
  if (ext === "md" || ext === "markdown") return "article";
  if (["js", "jsx", "ts", "tsx", "mjs", "cjs"].includes(ext)) return "code";
  if (["yaml", "yml", "json"].includes(ext)) return "data_object";
  return "draft";
}

function nextNodeId(definitionId, nodes) {
  const base = String(definitionId || "node")
    .replace(/^(agent|control|provide|tool|display)_/i, "")
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "") || "node";
  const taken = new Set(nodes.map((n) => n.id));
  for (let i = 1; i < 10000; i++) {
    const id = `${base}_${i}`;
    if (!taken.has(id)) return id;
  }
  return `${base}_${Date.now().toString(36)}`;
}

function slotDefault(slot) {
  if (slot?.default != null) return String(slot.default);
  if (slot?.value != null) return String(slot.value);
  return "";
}

function cloneSlots(slots) {
  return (Array.isArray(slots) ? slots : []).map((slot) => ({
    type: slot?.type || "node",
    name: slot?.name || "",
    default: slotDefault(slot),
  }));
}

function graphToFlow(graph, palette) {
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  const rawEdges = Array.isArray(graph?.edges) ? graph.edges : [];
  const positions = graph?.ui?.nodePositions && typeof graph.ui.nodePositions === "object" ? graph.ui.nodePositions : {};
  const sizes = graph?.ui?.nodeSizes && typeof graph.ui.nodeSizes === "object" ? graph.ui.nodeSizes : {};
  const nodeIds = new Set(Object.keys(instances));
  for (const edge of rawEdges) {
    if (edge?.source) nodeIds.add(String(edge.source));
    if (edge?.target) nodeIds.add(String(edge.target));
  }
  const rawNodes = Array.from(nodeIds).map((id) => {
    const inst = instances[id] || {};
    const definitionId = inst.definitionId || id;
    const def = palette.find((p) => p.id === definitionId);
    const pos = positions[id] && typeof positions[id].x === "number" && typeof positions[id].y === "number"
      ? positions[id]
      : { x: 320 + nodeIds.size * 20, y: 180 + nodeIds.size * 12 };
    const size = sizes[id] && typeof sizes[id].width === "number" && typeof sizes[id].height === "number"
      ? { width: sizes[id].width, height: sizes[id].height }
      : null;
    const isDisplay = Boolean(displayKind(definitionId));
    return {
      id,
      type: FLOW_NODE_TYPE,
      position: pos,
      ...(isDisplay && size ? { width: size.width, height: size.height } : {}),
      data: {
        label: inst.label || labelForDefinition(def) || id,
        definitionId,
        schemaType: schemaTypeForDefinition(definitionId, def),
        role: inst.role || "normal",
        model: inst.model || undefined,
        body: inst.body || "",
        script: inst.script || "",
        ...(isDisplay && size ? { displaySize: size } : {}),
      },
    };
  });
  const merged = rawNodes.map((node) => mergeNodeWithPalette(node, instances, palette));
  const edges = rawEdges
    .filter((e) => e?.source && e?.target)
    .map((e, idx) => ({
      id: e.id || `we-${e.source}-${e.target}-${idx}`,
      source: String(e.source),
      target: String(e.target),
      sourceHandle: e.sourceHandle ?? undefined,
      targetHandle: e.targetHandle ?? undefined,
      markerEnd: { type: MarkerType.ArrowClosed },
    }));
  return { nodes: merged, edges: filterValidEdges(edges, merged), instances };
}

function flowToGraph(nodes, edges, instances) {
  const graphInstances = buildInstancesForYaml(nodes, instances || {});
  const graphEdges = edges.map((edge) => ({
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? null,
    targetHandle: edge.targetHandle ?? null,
  }));
  const nodePositions = {};
  const nodeSizes = {};
  for (const node of nodes) {
    nodePositions[node.id] = { x: node.position?.x || 0, y: node.position?.y || 0 };
    if (displayKind(node.data?.definitionId)) {
      const width = Number(node.data?.displaySize?.width || node.width || node.measured?.width || 0);
      const height = Number(node.data?.displaySize?.height || node.height || node.measured?.height || 0);
      if (width > 0 && height > 0) {
        nodeSizes[node.id] = { width, height };
      }
    }
  }
  return { version: 1, instances: graphInstances, edges: graphEdges, ui: { nodePositions, nodeSizes } };
}

function displayKind(definitionId) {
  const id = String(definitionId || "");
  if (id === "display_markdown") return "markdown";
  if (id === "display_mermaid") return "mermaid";
  if (id === "display_ascii") return "ascii";
  return "";
}

function displayContent(data) {
  const slots = [...(data?.inputs || []), ...(data?.outputs || [])];
  const contentSlot = slots.find((slot) => slot?.name === "content") || slots.find((slot) => slot?.type === "text");
  return String(data?.body || contentSlot?.default || "");
}

function splitMarkdownTableRow(line) {
  let text = String(line || "").trim();
  if (!text.includes("|")) return [];
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  return text.split("|").map((cell) => cell.trim());
}

function isMarkdownTableSeparator(line) {
  const cells = splitMarkdownTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function markdownTableAlignments(separatorLine) {
  return splitMarkdownTableRow(separatorLine).map((cell) => {
    if (cell.startsWith(":") && cell.endsWith(":")) return "center";
    if (cell.endsWith(":")) return "right";
    return "left";
  });
}

function parseMarkdownDisplayBlocks(markdown) {
  const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let textLines = [];
  let inFence = false;
  const flushText = () => {
    if (!textLines.length) return;
    blocks.push({ type: "markdown", text: textLines.join("\n") });
    textLines = [];
  };

  for (let i = 0; i < lines.length;) {
    const line = lines[i] || "";
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      textLines.push(line);
      i++;
      continue;
    }
    if (!inFence && i + 1 < lines.length && splitMarkdownTableRow(line).length > 1 && isMarkdownTableSeparator(lines[i + 1])) {
      flushText();
      const headers = splitMarkdownTableRow(line);
      const align = markdownTableAlignments(lines[i + 1]);
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && splitMarkdownTableRow(lines[i]).length > 1) {
        rows.push(splitMarkdownTableRow(lines[i]));
        i++;
      }
      blocks.push({ type: "table", headers, align, rows });
      continue;
    }
    textLines.push(line);
    i++;
  }
  flushText();
  return blocks;
}

function MarkdownInline({ children }) {
  return <ReactMarkdown components={{ p: ({ children: pChildren }) => <>{pChildren}</> }}>{String(children || "")}</ReactMarkdown>;
}

function MarkdownDisplayContent({ content }) {
  const blocks = useMemo(() => parseMarkdownDisplayBlocks(content), [content]);
  return (
    <>
      {blocks.map((block, idx) => {
        if (block.type !== "table") {
          return <ReactMarkdown key={`md-${idx}`}>{block.text}</ReactMarkdown>;
        }
        return (
          <div className="af-work-display-table-wrap" key={`table-${idx}`}>
            <table className="af-work-display-table">
              <thead>
                <tr>
                  {block.headers.map((cell, cellIdx) => (
                    <th key={cellIdx} style={{ textAlign: block.align[cellIdx] || "left" }}>
                      <MarkdownInline>{cell}</MarkdownInline>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIdx) => (
                  <tr key={rowIdx}>
                    {block.headers.map((_, cellIdx) => (
                      <td key={cellIdx} style={{ textAlign: block.align[cellIdx] || "left" }}>
                        <MarkdownInline>{row[cellIdx] || ""}</MarkdownInline>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
    </>
  );
}

function parseMermaidFlowchart(code) {
  const lines = String(code || "").split(/\r?\n/).map((line) => line.replace(/%%.*$/, "").trim()).filter(Boolean);
  const nodes = new Map();
  const edges = [];
  let direction = "TD";
  const ensure = (id, label = "") => {
    const clean = String(id || "").replace(/[^A-Za-z0-9_]/g, "_") || `N${nodes.size + 1}`;
    if (!nodes.has(clean)) nodes.set(clean, { id: clean, label: label || clean });
    else if (label) nodes.get(clean).label = label;
    return clean;
  };
  const parseEndpoint = (raw) => {
    const text = String(raw || "").trim().replace(/[;,]+$/, "");
    const match = text.match(/^([A-Za-z][A-Za-z0-9_]*)(?:\[(.+?)\]|\((.+?)\)|\{(.+?)\})?$/);
    if (!match) return ensure(text.replace(/[^A-Za-z0-9_]/g, "_"), text);
    return ensure(match[1], match[2] || match[3] || match[4] || match[1]);
  };
  for (const line of lines) {
    const dir = line.match(/^(graph|flowchart)\s+(TD|TB|BT|LR|RL)\b/i);
    if (dir) {
      direction = dir[2].toUpperCase();
      continue;
    }
    const edge = line.match(/^(.+?)\s*-{1,2}>+\s*(.+)$/);
    if (edge) {
      edges.push({ from: parseEndpoint(edge[1]), to: parseEndpoint(edge[2]) });
      continue;
    }
    parseEndpoint(line);
  }
  return { nodes: Array.from(nodes.values()), edges, direction };
}

function MermaidPreview({ code }) {
  const graph = useMemo(() => parseMermaidFlowchart(code), [code]);
  if (!String(code || "").trim()) return null;
  const horizontal = graph.direction === "LR" || graph.direction === "RL";
  const nodeW = 142;
  const nodeH = 44;
  const gapX = horizontal ? 96 : 32;
  const gapY = horizontal ? 30 : 68;
  const positions = new Map();
  graph.nodes.forEach((node, idx) => {
    positions.set(node.id, {
      x: 24 + (horizontal ? idx * (nodeW + gapX) : (idx % 3) * (nodeW + gapX)),
      y: 24 + (horizontal ? (idx % 3) * (nodeH + gapY) : idx * (nodeH + gapY)),
    });
  });
  const maxX = Math.max(360, ...Array.from(positions.values()).map((p) => p.x + nodeW + 24));
  const maxY = Math.max(180, ...Array.from(positions.values()).map((p) => p.y + nodeH + 24));
  return (
    <div className="af-work-node__mermaid-preview">
      <svg viewBox={`0 0 ${maxX} ${maxY}`} role="img" aria-label="Mermaid preview">
        <defs>
          <marker id="af-work-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" />
          </marker>
        </defs>
        {graph.edges.map((edge, idx) => {
          const a = positions.get(edge.from);
          const b = positions.get(edge.to);
          if (!a || !b) return null;
          const d = horizontal
            ? `M ${a.x + nodeW} ${a.y + nodeH / 2} C ${(a.x + b.x + nodeW) / 2} ${a.y + nodeH / 2}, ${(a.x + b.x + nodeW) / 2} ${b.y + nodeH / 2}, ${b.x} ${b.y + nodeH / 2}`
            : `M ${a.x + nodeW / 2} ${a.y + nodeH} C ${a.x + nodeW / 2} ${a.y + nodeH + 28}, ${b.x + nodeW / 2} ${b.y - 28}, ${b.x + nodeW / 2} ${b.y}`;
          return <path key={`${edge.from}-${edge.to}-${idx}`} className="af-work-node__mermaid-edge" d={d} markerEnd="url(#af-work-arrow)" />;
        })}
        {graph.nodes.map((node) => {
          const p = positions.get(node.id);
          return (
            <g key={node.id}>
              <rect className="af-work-node__mermaid-box" x={p.x} y={p.y} width={nodeW} height={nodeH} rx="8" />
              <text className="af-work-node__mermaid-text" x={p.x + nodeW / 2} y={p.y + nodeH / 2 + 5} textAnchor="middle">
                {node.label.slice(0, 22)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function DisplayBody({ data }) {
  const kind = displayKind(data?.definitionId);
  if (!kind) return null;
  const content = displayContent(data);
  if (!content.trim()) return <div className="af-work-display-empty">No display content</div>;
  if (kind === "markdown") {
    return <div className="af-work-display-body af-work-display-body--markdown"><MarkdownDisplayContent content={content} /></div>;
  }
  if (kind === "mermaid") {
    return (
      <div className="af-work-display-body">
        <MermaidPreview code={content} />
        <pre className="af-work-node__diagram af-work-node__diagram--mermaid">{content}</pre>
      </div>
    );
  }
  return <pre className="af-work-display-body af-work-node__diagram af-work-node__diagram--ascii">{content}</pre>;
}

function WorkspaceDisplayNode({ id, data, selected, deleteNode }) {
  const inputs = Array.isArray(data?.inputs) ? data.inputs : [];
  const outputs = Array.isArray(data?.outputs) ? data.outputs : [];
  const kind = displayKind(data?.definitionId);
  const title = data?.label || (kind === "mermaid" ? "Mermaid" : kind === "ascii" ? "ASCII" : "Markdown");
  const displaySize = data?.displaySize && Number(data.displaySize.width) > 0 && Number(data.displaySize.height) > 0
    ? { width: Number(data.displaySize.width), height: Number(data.displaySize.height) }
    : null;
  return (
    <div
      className={"af-work-display-card" + (displaySize ? " af-work-display-card--sized" : "") + (selected ? " af-work-display-card--selected" : "")}
      style={displaySize ? { width: displaySize.width, height: displaySize.height } : undefined}
    >
      <NodeResizeControl
        className="af-work-display-resize nodrag"
        position="bottom-right"
        minWidth={320}
        minHeight={180}
        maxWidth={1200}
        maxHeight={1000}
      >
        <span className="material-symbols-outlined" aria-hidden>open_in_full</span>
      </NodeResizeControl>
      {inputs.map((slot, idx) => (
        <Handle
          key={`in-${idx}`}
          type="target"
          position={Position.Left}
          id={`input-${idx}`}
          className="af-work-display-handle af-work-display-handle--in"
          style={{ top: `${4.15 + idx * 1.75}rem`, background: getHandleColor(slot.type) }}
          title={`${slot.name || `#${idx + 1}`} · ${slot.type}`}
        />
      ))}
      {outputs.map((slot, idx) => (
        <Handle
          key={`out-${idx}`}
          type="source"
          position={Position.Right}
          id={`output-${idx}`}
          className="af-work-display-handle af-work-display-handle--out"
          style={{ top: `${4.15 + idx * 1.75}rem`, background: getHandleColor(slot.type) }}
          title={`${slot.name || `#${idx + 1}`} · ${slot.type}`}
        />
      ))}
      <div className="af-work-display-card__head">
        <div className="af-work-display-card__title">
          <span className="material-symbols-outlined">{kind === "mermaid" ? "account_tree" : kind === "ascii" ? "notes" : "article"}</span>
          <strong>{title}</strong>
          <span>{data?.definitionId || "display"}</span>
        </div>
        <button type="button" className="af-work-display-card__close nodrag" onClick={() => deleteNode?.(id)} aria-label="删除节点">
          <span className="material-symbols-outlined">close</span>
        </button>
      </div>
      <DisplayBody data={data} />
    </div>
  );
}

function WorkspaceFlowNode(props) {
  const { setEdges, setNodes } = useReactFlow();
  const deleteNode = useCallback((nodeId) => {
    setNodes((list) => list.filter((node) => node.id !== nodeId));
    setEdges((list) => list.filter((edge) => edge.source !== nodeId && edge.target !== nodeId));
  }, [setEdges, setNodes]);
  const onModelChange = useCallback((nodeId, model) => {
    setNodes((list) => list.map((node) => node.id === nodeId ? { ...node, data: { ...node.data, model } } : node));
  }, [setNodes]);
  if (displayKind(props.data?.definitionId)) {
    return <WorkspaceDisplayNode {...props} deleteNode={deleteNode} />;
  }
  return (
    <div className="af-work-flow-node">
      <FlowNode {...props} deleteNode={deleteNode} modelLists={props.data?.modelLists} onModelChange={onModelChange} />
    </div>
  );
}

const nodeTypes = { [FLOW_NODE_TYPE]: WorkspaceFlowNode };

function flattenFiles(files, out = []) {
  for (const item of files || []) {
    if (item.type === "file") out.push(item);
    if (Array.isArray(item.children)) flattenFiles(item.children, out);
  }
  return out;
}

function FileTree({ items, onOpen, collapsedDirs, onToggleDir, onCreateFile, onCreateFolder, onDelete, onFileDragStart }) {
  return (
    <ul className="af-work-files">
      {(items || []).map((item) => {
        const isDir = item.type === "directory";
        const collapsed = isDir && collapsedDirs?.has(item.path);
        return (
          <li key={item.path}>
            <div className="af-work-file-row">
              <button
                type="button"
                className={"af-work-file af-work-file--" + item.type}
                draggable={!isDir}
                onDragStart={(e) => {
                  if (!isDir) onFileDragStart?.(e, item);
                }}
                onClick={() => isDir ? onToggleDir?.(item.path) : onOpen(item)}
                title={item.path}
              >
                {isDir ? <span className="material-symbols-outlined af-work-file__chevron">{collapsed ? "chevron_right" : "expand_more"}</span> : null}
                <span className="material-symbols-outlined">{item.icon || iconForFile(item.name, isDir)}</span>
                <span>{item.name}</span>
              </button>
              {isDir ? (
                <>
                  <button type="button" className="af-work-file-action" onClick={() => onCreateFile?.(item.path)} title="新增文件" aria-label={`在 ${item.name} 新增文件`}>
                    <span className="material-symbols-outlined">note_add</span>
                  </button>
                  <button type="button" className="af-work-file-action" onClick={() => onCreateFolder?.(item.path)} title="新增文件夹" aria-label={`在 ${item.name} 新增文件夹`}>
                    <span className="material-symbols-outlined">create_new_folder</span>
                  </button>
                </>
              ) : null}
              <button type="button" className="af-work-file-action af-work-file-action--danger" onClick={() => onDelete?.(item)} title="删除" aria-label={`删除 ${item.name}`}>
                <span className="material-symbols-outlined">delete</span>
              </button>
            </div>
            {isDir && !collapsed && item.children?.length ? (
              <FileTree items={item.children} onOpen={onOpen} collapsedDirs={collapsedDirs} onToggleDir={onToggleDir} onCreateFile={onCreateFile} onCreateFolder={onCreateFolder} onDelete={onDelete} onFileDragStart={onFileDragStart} />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function WorkspaceComposerThread({ messages, running }) {
  const hasBody = messages.length > 0;
  return (
    <div className="af-composer-ai-stack af-composer-ai-stack--in-panel af-composer-thread-stack">
      {messages.map((msg, idx) => {
        const role = msg.role === "user" ? "user-msg" : msg.error ? "error" : "reply";
        const label = msg.role === "user" ? "You" : msg.error ? "Error" : "Reply";
        return (
          <section key={`${idx}-${msg.role}-${String(msg.text || "").slice(0, 24)}`} className={`af-composer-ai-block af-composer-ai-block--${role}`}>
            <div className="af-composer-ai-block-label">{label}</div>
            <div className="af-composer-ai-block-body">{msg.text}</div>
          </section>
        );
      })}
      {running && !hasBody ? (
        <section className="af-composer-ai-block af-composer-ai-block--reply af-composer-ai-block--pending">
          <div className="af-composer-ai-block-label">Reply</div>
          <div className="af-composer-ai-block-body">Waiting...</div>
        </section>
      ) : null}
      {running && hasBody ? (
        <section className="af-composer-ai-block af-composer-ai-block--thinking">
          <div className="af-composer-ai-block-label">Thinking</div>
          <div className="af-composer-ai-block-body">Workspace agent is running...</div>
        </section>
      ) : null}
    </div>
  );
}

function WorkspacePageInner() {
  const { i18n } = useTranslation();
  const { navigate } = useRoute();
  const reactFlow = useReactFlow();
  const flowParams = useMemo(readFlowParamsFromUrl, []);
  const [nodes, setNodes] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const [instances, setInstances] = useState({});
  const instancesRef = useRef({});
  const loadedRef = useRef(false);
  const saveTimerRef = useRef(null);
  const [palette, setPalette] = useState([]);
  const [paletteSearch, setPaletteSearch] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [files, setFiles] = useState([]);
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [fileFilter, setFileFilter] = useState("");
  const [collapsedDirs, setCollapsedDirs] = useState(() => new Set());
  const [modelLists, setModelLists] = useState({ cursor: [], opencode: [], claudeCode: [] });
  const [composerModel, setComposerModel] = useState("");
  const [skills, setSkills] = useState([]);
  const [selectedSkills, setSelectedSkills] = useState([]);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const skillsButtonRef = useRef(null);
  const skillsMenuRef = useRef(null);
  const [skillsMenuStyle, setSkillsMenuStyle] = useState({});
  const [useWorkspaceSkills, setUseWorkspaceSkills] = useState(true);
  const [allowFlowYaml, setAllowFlowYaml] = useState(false);
  const [composerText, setComposerText] = useState("");
  const [composerRunning, setComposerRunning] = useState(false);
  const [composerMessages, setComposerMessages] = useState([]);
  const [composerSidebarOpen, setComposerSidebarOpen] = useState(false);
  const [status, setStatus] = useState("");
  const composerStorageKey = useMemo(() => workspaceComposerStorageKey(flowParams), [flowParams]);
  const composerLoadedRef = useRef(false);

  useEffect(() => {
    if (!flowParams.flowId) return;
    recordPipelineView(flowParams.flowId, flowParams.flowSource || "user", "workspace", Boolean(flowParams.archived));
  }, [flowParams]);

  useEffect(() => {
    composerLoadedRef.current = false;
    if (!composerStorageKey) {
      setComposerMessages([]);
      composerLoadedRef.current = true;
      return;
    }
    try {
      const raw = localStorage.getItem(composerStorageKey);
      setComposerMessages(raw ? normalizeWorkspaceComposerMessages(JSON.parse(raw)) : []);
    } catch {
      setComposerMessages([]);
    } finally {
      composerLoadedRef.current = true;
    }
  }, [composerStorageKey]);

  useEffect(() => {
    if (!composerLoadedRef.current || !composerStorageKey) return;
    try {
      localStorage.setItem(composerStorageKey, JSON.stringify(normalizeWorkspaceComposerMessages(composerMessages)));
    } catch {
      /* ignore quota */
    }
  }, [composerMessages, composerStorageKey]);

  const loadFiles = useCallback(async () => {
    const q = flowParamsQuery(flowParams);
    const res = await fetch(`/api/workspace/files?${q.toString()}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "读取 workspace 失败");
    setFiles(json.files || []);
    setWorkspaceRoot(json.root || "");
  }, [flowParams]);

  const saveGraph = useCallback(async (nextNodes = nodes, nextEdges = edges) => {
    if (!loadedRef.current) return;
    const graph = flowToGraph(nextNodes, nextEdges, instancesRef.current);
    const res = await fetch("/api/workspace/graph", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...flowParams, graph }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "保存 workspace graph 失败");
    instancesRef.current = json.graph?.instances || graph.instances;
    setInstances(instancesRef.current);
    setStatus("Workspace graph saved");
  }, [edges, flowParams, nodes]);

  const loadWorkspace = useCallback(async () => {
    loadedRef.current = false;
    const q = flowParamsQuery(flowParams);
    const nodeQ = flowParamsQuery(flowParams);
    nodeQ.set("lang", String(i18n.language || "zh").startsWith("zh") ? "zh" : "en");
    const [nodesRes, graphRes] = await Promise.all([
      fetch(`/api/nodes?${nodeQ.toString()}`),
      fetch(`/api/workspace/graph?${q.toString()}`),
      loadFiles(),
    ]);
    const nodesJson = await nodesRes.json();
    const graphJson = await graphRes.json();
    if (!nodesRes.ok) throw new Error(nodesJson.error || "读取节点定义失败");
    if (!graphRes.ok) throw new Error(graphJson.error || "读取 workspace graph 失败");
    const paletteList = (Array.isArray(nodesJson) ? nodesJson : nodesJson.nodes || []).filter((node) => !HIDDEN_WORKSPACE_DEFS.has(node.id));
    setPalette(paletteList);
    const graph = graphJson.graph || JSON.parse(localStorage.getItem(STORAGE_FALLBACK_KEY) || "null") || {};
    const flow = graphToFlow(graph, paletteList);
    instancesRef.current = flow.instances;
    setInstances(flow.instances);
    setNodes(flow.nodes);
    setEdges(flow.edges);
    setStatus(graphJson.writable ? "Workspace ready" : "Readonly workspace");
    loadedRef.current = true;
  }, [flowParams, i18n.language, loadFiles, setEdges, setNodes]);

  useEffect(() => {
    loadWorkspace().catch((e) => setStatus(String(e.message || e)));
    fetch("/api/model-lists").then((r) => r.json()).then((j) => setModelLists({
      cursor: Array.isArray(j.cursor) ? j.cursor.map(String) : [],
      opencode: Array.isArray(j.opencode) ? j.opencode.map(String) : [],
      claudeCode: Array.isArray(j.claudeCode) ? j.claudeCode.map(String) : [],
    })).catch(() => {});
    fetch("/api/skills").then((r) => r.json()).then((j) => {
      const list = Array.isArray(j.skills) ? j.skills.map((s) => ({
        key: String(s.key),
        name: String(s.name || s.id || s.key),
        description: s.description ? String(s.description) : "",
        sourceLabel: s.sourceLabel ? String(s.sourceLabel) : "",
      })) : [];
      setSkills(list);
      setSelectedSkills(list.map((s) => s.key));
    }).catch(() => {});
  }, [loadWorkspace]);

  useEffect(() => {
    instancesRef.current = instances;
  }, [instances]);

  useEffect(() => {
    if (!loadedRef.current) return;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveGraph().catch((e) => setStatus(String(e.message || e)));
    }, 650);
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, [nodes, edges, saveGraph]);

  const hydratedNodes = useMemo(() => nodes.map((node) => ({
    ...node,
    data: { ...node.data, modelLists },
  })), [modelLists, nodes]);

  const coloredEdges = useMemo(() => {
    const nodeById = new Map(hydratedNodes.map((node) => [node.id, node]));
    return edges.map((edge) => {
      const src = nodeById.get(edge.source);
      const tgt = nodeById.get(edge.target);
      const sm = /^output-(\d+)$/.exec(edge.sourceHandle || "");
      const tm = /^input-(\d+)$/.exec(edge.targetHandle || "");
      const srcSlot = src && sm ? src.data?.outputs?.[parseInt(sm[1], 10)] : null;
      const tgtSlot = tgt && tm ? tgt.data?.inputs?.[parseInt(tm[1], 10)] : null;
      const hue = srcSlot?.type ? getHandleColor(srcSlot.type) : tgtSlot?.type ? getHandleColor(tgtSlot.type) : "";
      if (!hue) return edge;
      return {
        ...edge,
        style: { ...(edge.style || {}), stroke: hue, strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: hue },
      };
    });
  }, [edges, hydratedNodes]);

  const groupedPalette = useMemo(() => {
    const q = paletteSearch.trim().toLowerCase();
    const grouped = { DISPLAY: [], CONTROL: [], TOOL: [], PROVIDE: [], AGENT: [] };
    for (const item of palette) {
      if (q && ![item.id, item.label, item.displayName, item.description].some((x) => String(x || "").toLowerCase().includes(q))) continue;
      grouped[paletteCategory(item)].push(item);
    }
    for (const cat of PALETTE_ORDER) grouped[cat].sort((a, b) => a.id.localeCompare(b.id));
    return grouped;
  }, [palette, paletteSearch]);

  const filteredFiles = useMemo(() => {
    const q = fileFilter.trim().toLowerCase();
    if (!q) return files;
    return flattenFiles(files).filter((file) => file.path.toLowerCase().includes(q));
  }, [fileFilter, files]);

  const modelOptions = [
    ...(modelLists.cursor || []).map((m) => ({ label: `Cursor · ${m.split(" - ")[0]}`, value: `cursor:${m.split(" - ")[0]}` })),
    ...(modelLists.opencode || []).map((m) => ({ label: `OpenCode · ${m.split(" - ")[0]}`, value: `opencode:${m.split(" - ")[0]}` })),
    ...(modelLists.claudeCode || []).map((m) => ({ label: `Claude · ${m.split(" - ")[0]}`, value: `claude-code:${m.split(" - ")[0]}` })),
  ];

  const selectedSkillSet = useMemo(() => new Set(selectedSkills), [selectedSkills]);
  const skillGroups = useMemo(() => {
    const byLabel = new Map();
    for (const skill of skills) {
      const label = skill.sourceLabel || "Workspace Skills";
      if (!byLabel.has(label)) byLabel.set(label, []);
      byLabel.get(label).push(skill);
    }
    return Array.from(byLabel.entries()).map(([label, groupSkills]) => ({ label, skills: groupSkills }));
  }, [skills]);

  const selectedCanvasNodes = useMemo(() => {
    const selected = nodes.filter((node) => node.selected);
    if (selected.length > 0) return selected;
    return selectedNodeId ? nodes.filter((node) => node.id === selectedNodeId) : [];
  }, [nodes, selectedNodeId]);

  const selectedCanvasNodeIds = useMemo(() => selectedCanvasNodes.map((node) => node.id), [selectedCanvasNodes]);

  const dismissSelectedNode = useCallback((nodeId) => {
    setNodes((list) => list.map((node) => (
      node.id === nodeId ? { ...node, selected: false } : node
    )));
    setSelectedNodeId((current) => (current === nodeId ? "" : current));
  }, [setNodes]);

  const updateSkillsMenuPosition = useCallback(() => {
    const btn = skillsButtonRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const width = Math.min(420, Math.max(320, rect.width + 160));
    const margin = 12;
    const availableAbove = Math.max(180, rect.top - margin * 2);
    const maxHeight = Math.min(560, availableAbove);
    setSkillsMenuStyle({
      position: "fixed",
      left: Math.max(12, Math.min(window.innerWidth - width - 12, rect.left)),
      top: Math.max(margin, rect.top - maxHeight - margin),
      width,
      maxHeight,
      zIndex: 10000,
    });
  }, []);

  useEffect(() => {
    if (!skillsOpen) return;
    updateSkillsMenuPosition();
    const onPointerDown = (e) => {
      const target = e.target;
      if (skillsButtonRef.current?.contains(target) || skillsMenuRef.current?.contains(target)) return;
      setSkillsOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key === "Escape") setSkillsOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", updateSkillsMenuPosition);
    window.addEventListener("scroll", updateSkillsMenuPosition, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", updateSkillsMenuPosition);
      window.removeEventListener("scroll", updateSkillsMenuPosition, true);
    };
  }, [skillsOpen, updateSkillsMenuPosition]);

  const handleNodesChange = useCallback((changes) => {
    const resized = new Map();
    for (const change of changes || []) {
      if (change?.type === "dimensions" && change.dimensions?.width && change.dimensions?.height) {
        resized.set(change.id, {
          width: Math.round(Number(change.dimensions.width)),
          height: Math.round(Number(change.dimensions.height)),
        });
      }
    }
    setNodes((current) => applyNodeChanges(changes, current).map((node) => {
      const size = resized.get(node.id);
      if (!size || !displayKind(node.data?.definitionId)) return node;
      return {
        ...node,
        data: {
          ...node.data,
          displaySize: size,
        },
      };
    }));
  }, [setNodes]);

  const defaultWorkspaceNodePosition = useCallback(() => {
    const wrap = document.querySelector(".af-workspace-canvas .react-flow");
    if (wrap) {
      const rect = wrap.getBoundingClientRect();
      return reactFlow.screenToFlowPosition({
        x: rect.left + rect.width * 0.48,
        y: rect.top + rect.height * 0.32,
      });
    }
    return { x: 360 + nodes.length * 36, y: 180 + nodes.length * 28 };
  }, [nodes.length, reactFlow]);

  const addNodeFromDefinition = useCallback((def, overrides = {}) => {
    if (!def) return null;
    const id = overrides.id || nextNodeId(def.id, nodes);
    const input = cloneSlots(def.inputs);
    const output = cloneSlots(def.outputs);
    const instance = {
      definitionId: def.id,
      label: overrides.label || labelForDefinition(def),
      role: "normal",
      body: overrides.body || "",
      input: overrides.inputs || input,
      output: overrides.outputs || output,
    };
    const node = {
      id,
      type: FLOW_NODE_TYPE,
      position: overrides.position || defaultWorkspaceNodePosition(),
      data: {
        label: instance.label,
        definitionId: def.id,
        schemaType: schemaTypeForDefinition(def.id, def),
        role: "normal",
        body: instance.body,
        inputs: instance.input,
        outputs: instance.output,
      },
    };
    const merged = { ...mergeNodeWithPalette(node, { ...instancesRef.current, [id]: instance }, palette), selected: true };
    setNodes((list) => [...list.map((item) => ({ ...item, selected: false })), merged]);
    setSelectedNodeId(id);
    return id;
  }, [defaultWorkspaceNodePosition, nodes, palette, setNodes]);

  const toggleDir = useCallback((dirPath) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  }, []);

  const openFileNode = useCallback((item) => {
    const def = palette.find((node) => node.id === "provide_file");
    if (!def) return;
    const outputs = cloneSlots(def.outputs);
    if (outputs[0]) outputs[0] = { ...outputs[0], default: item.path };
    addNodeFromDefinition(def, { label: item.name, outputs });
  }, [addNodeFromDefinition, palette]);

  const handleFileDragStart = useCallback((event, item) => {
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("application/x-agentflow-workspace-file", JSON.stringify({
      path: item.path,
      name: item.name,
      type: item.type,
    }));
    event.dataTransfer.setData("text/plain", item.path);
  }, []);

  const handlePaletteNodeDragStart = useCallback((event, def) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("application/agentflow-node", def.id);
    event.dataTransfer.setData("text/plain", def.id);
  }, []);

  const addMarkdownDisplayFromFile = useCallback(async (item, position) => {
    const def = palette.find((node) => node.id === "display_markdown");
    if (!def) {
      setStatus("Markdown Display 节点不可用");
      return;
    }
    const q = flowParamsQuery(flowParams);
    q.set("path", item.path);
    const res = await fetch(`/api/workspace/file?${q.toString()}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "读取文件失败");
    const content = String(json.content || "");
    const inputs = cloneSlots(def.inputs).map((slot) => (
      slot.name === "content" ? { ...slot, default: content } : slot
    ));
    const outputs = cloneSlots(def.outputs).map((slot) => (
      slot.name === "content" ? { ...slot, default: content } : slot
    ));
    addNodeFromDefinition(def, {
      label: item.name || "Markdown",
      body: content,
      inputs,
      outputs,
      position,
    });
    setStatus(`已创建 Markdown 展示：${item.path}`);
  }, [addNodeFromDefinition, flowParams, palette]);

  const handleWorkspaceDrop = useCallback((event) => {
    const raw = event.dataTransfer.getData("application/x-agentflow-workspace-file");
    if (raw) {
      event.preventDefault();
      let item;
      try {
        item = JSON.parse(raw);
      } catch {
        return;
      }
      if (!item?.path) return;
      const position = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      addMarkdownDisplayFromFile(item, position).catch((e) => setStatus(String(e.message || e)));
      return;
    }

    const defId = event.dataTransfer.getData("application/agentflow-node");
    if (!defId) return;
    const def = palette.find((node) => node.id === defId);
    if (!def) return;
    event.preventDefault();
    const position = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    addNodeFromDefinition(def, { position });
  }, [addMarkdownDisplayFromFile, addNodeFromDefinition, palette, reactFlow]);

  const handleWorkspaceDragOver = useCallback((event) => {
    const types = Array.from(event.dataTransfer.types || []);
    if (!types.includes("application/x-agentflow-workspace-file") && !types.includes("application/agentflow-node")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = types.includes("application/agentflow-node") ? "move" : "copy";
  }, []);

  const createWorkspaceFile = useCallback(async (baseDir = "") => {
    const name = window.prompt("新文件名", baseDir ? `${baseDir}/notes.md` : "notes.md");
    if (!name) return;
    const relPath = baseDir && !name.includes("/") ? `${baseDir}/${name}` : name;
    try {
      const res = await fetch("/api/workspace/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...flowParams, path: relPath, content: "" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "创建文件失败");
      setStatus(`已创建 ${json.path}`);
      await loadFiles();
    } catch (e) {
      setStatus(String(e.message || e));
    }
  }, [flowParams, loadFiles]);

  const createWorkspaceFolder = useCallback(async (baseDir = "") => {
    const name = window.prompt("新文件夹名", baseDir ? `${baseDir}/docs` : "docs");
    if (!name) return;
    const relPath = baseDir && !name.includes("/") ? `${baseDir}/${name}` : name;
    try {
      const res = await fetch("/api/workspace/folder", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...flowParams, path: relPath }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "创建文件夹失败");
      setCollapsedDirs((prev) => {
        const next = new Set(prev);
        if (baseDir) next.delete(baseDir);
        return next;
      });
      setStatus(`已创建 ${json.path}`);
      await loadFiles();
    } catch (e) {
      setStatus(String(e.message || e));
    }
  }, [flowParams, loadFiles]);

  const deleteWorkspacePath = useCallback(async (item) => {
    if (!item?.path || !window.confirm(`删除 ${item.path}？`)) return;
    try {
      const res = await fetch("/api/workspace/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...flowParams, path: item.path }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "删除失败");
      setStatus(`已删除 ${json.path}`);
      await loadFiles();
    } catch (e) {
      setStatus(String(e.message || e));
    }
  }, [flowParams, loadFiles]);

  const submitWorkspaceAi = useCallback(async () => {
    const prompt = composerText.trim();
    if (!prompt || composerRunning) return;
    const graph = flowToGraph(nodes, edges, instancesRef.current);
    setComposerText("");
    setComposerRunning(true);
    setComposerSidebarOpen(true);
    setComposerMessages((list) => [...list, { role: "user", text: prompt, at: Date.now() }]);
    try {
      const res = await fetch("/api/workspace/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...flowParams,
          prompt,
          outputKind: "markdown",
          workspaceGraph: graph,
          allowFlowYaml,
          model: composerModel,
          selectedSkills: useWorkspaceSkills ? selectedSkills : [],
          selectedNodeIds: selectedCanvasNodeIds,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "生成失败");
      const text = String(json.content || "").trim();
      setComposerMessages((list) => [...list, { role: "assistant", text, at: Date.now() }]);
      const def = palette.find((node) => node.id === "display_markdown");
      if (def && text) {
        const inputs = cloneSlots(def.inputs).map((slot) => slot.name === "content" ? { ...slot, default: text } : slot);
        const outputs = cloneSlots(def.outputs).map((slot) => slot.name === "content" ? { ...slot, default: text } : slot);
        addNodeFromDefinition(def, { label: "AI Markdown", body: text, inputs, outputs, position: { x: 440 + nodes.length * 24, y: 220 + nodes.length * 20 } });
      }
      setStatus("AI 生成完成");
    } catch (e) {
      const message = String(e.message || e);
      setComposerMessages((list) => [...list, { role: "assistant", text: message, error: true, at: Date.now() }]);
      setStatus(message);
    } finally {
      setComposerRunning(false);
    }
  }, [addNodeFromDefinition, allowFlowYaml, composerModel, composerRunning, composerText, edges, flowParams, nodes, palette, selectedCanvasNodeIds, selectedSkills, useWorkspaceSkills]);

  return (
    <div className="af-workspace-page">
      <header className="af-pipeline-top af-workspace-top">
        <div className="af-pipeline-top-left">
          <button type="button" className="af-icon-btn af-pipeline-back" onClick={() => navigate("/projects")} aria-label="返回">
            <span className="material-symbols-outlined">arrow_back</span>
          </button>
          <div className="af-pipeline-brand" title={flowParams.flowId ? `${flowParams.flowId} · ${workspaceRoot}` : workspaceRoot || "PROJECT"}>
            <span className="af-pipeline-brand-name">WORKSPACE</span>
            <span className="af-pipeline-brand-ver">V{APP_VERSION}-STABLE</span>
          </div>
          <div className="af-view-switch" aria-label="视图切换">
            <button type="button" onClick={() => {
              navigate(flowUrlForView({
                id: flowParams.flowId,
                source: flowParams.flowSource || "user",
                archived: Boolean(flowParams.archived),
              }, "pipeline"));
            }}>Pipeline</button>
            <button type="button" className="af-view-switch__active">Workspace</button>
          </div>
        </div>
        <div className="af-pipeline-top-right af-workspace-actions">
          <span className="af-workspace-save-status">{status}</span>
          <button
            type="button"
            className={"af-composer-topbar-btn" + (composerSidebarOpen ? " af-composer-topbar-btn--active" : "") + (composerRunning ? " af-composer-topbar-btn--running" : "")}
            onClick={() => setComposerSidebarOpen((v) => !v)}
          >
            AI
          </button>
          <button type="button" className="af-btn-primary af-btn-primary--lg" onClick={() => saveGraph().catch((e) => setStatus(String(e.message || e)))}>
            Save
          </button>
        </div>
      </header>

      <div className={"af-workspace-body" + (composerSidebarOpen ? " af-workspace-body--drawer" : "")}>
        <aside className="af-workspace-sidebar">
          <section className="af-workspace-files-section">
            <div className="af-workspace-sidebar-head">
              <h2>Files</h2>
              <div className="af-workspace-sidebar-actions">
                <button type="button" className="af-icon-btn" onClick={() => createWorkspaceFile("")} aria-label="新增文件" title="新增文件">
                  <span className="material-symbols-outlined">note_add</span>
                </button>
                <button type="button" className="af-icon-btn" onClick={() => createWorkspaceFolder("")} aria-label="新增文件夹" title="新增文件夹">
                  <span className="material-symbols-outlined">create_new_folder</span>
                </button>
                <button type="button" className="af-icon-btn" onClick={() => void loadFiles()} aria-label="刷新文件" title="刷新文件">
                  <span className="material-symbols-outlined">refresh</span>
                </button>
              </div>
            </div>
            <input className="af-workspace-search" value={fileFilter} onChange={(e) => setFileFilter(e.target.value)} placeholder="搜索文件..." />
            <div className="af-workspace-files-scroll">
              <FileTree items={filteredFiles} onOpen={openFileNode} collapsedDirs={collapsedDirs} onToggleDir={toggleDir} onCreateFile={createWorkspaceFile} onCreateFolder={createWorkspaceFolder} onDelete={deleteWorkspacePath} onFileDragStart={handleFileDragStart} />
            </div>
          </section>

          <section className="af-workspace-nodes-section">
            <div className="af-workspace-sidebar-head">
              <h2>Nodes</h2>
            </div>
            <input className="af-workspace-search" value={paletteSearch} onChange={(e) => setPaletteSearch(e.target.value)} placeholder="搜索节点..." />
            <div className="af-workspace-node-palette">
              {PALETTE_ORDER.map((cat) => groupedPalette[cat]?.length ? (
                <div className="af-workspace-node-group" key={cat}>
                  <div className="af-workspace-node-group__title">
                    <span className="material-symbols-outlined">{paletteIcon(cat)}</span>
                    <span>{cat}</span>
                  </div>
                  {groupedPalette[cat].map((node) => (
                    <button
                      key={node.id}
                      type="button"
                      draggable
                      onDragStart={(e) => handlePaletteNodeDragStart(e, node)}
                      onClick={() => addNodeFromDefinition(node)}
                      title={node.description || node.id}
                    >
                      <span className="material-symbols-outlined">{paletteIcon(cat)}</span>
                      <span className="af-workspace-node-palette__text">
                        <span className="af-workspace-node-palette__label">{labelForDefinition(node)}</span>
                        <span className="af-workspace-node-palette__id">{node.id}</span>
                      </span>
                    </button>
                  ))}
                </div>
              ) : null)}
            </div>
          </section>

        </aside>

        <main className="af-workspace-canvas">
          <ReactFlow
            className="af-flow-canvas af-workspace-flow"
            nodes={hydratedNodes}
            edges={coloredEdges}
            nodeTypes={nodeTypes}
            onNodesChange={handleNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={(params) => setEdges((eds) => addEdge({ ...params, markerEnd: { type: MarkerType.ArrowClosed } }, eds))}
            onNodeClick={(_, node) => setSelectedNodeId(node.id)}
            onPaneClick={() => setSelectedNodeId("")}
            onDrop={handleWorkspaceDrop}
            onDragOver={handleWorkspaceDragOver}
            proOptions={{ hideAttribution: true }}
            fitView={false}
            minZoom={0.1}
            maxZoom={4}
          >
            <Background color="rgba(255,255,255,0.12)" gap={22} size={1} />
          </ReactFlow>

          <div className="af-workspace-composer af-bottom-composer-stack af-flow-bottom-composer">
            <div className="af-pipeline-composer-inner">
              <div className="af-composer-selected" aria-label="Selected workspace nodes">
                {selectedCanvasNodes.length === 0 ? (
                  <span className="af-composer-selected-empty">
                    选择画布节点后，可作为本次 Workspace AI 的上下文。
                  </span>
                ) : (
                  selectedCanvasNodes.map((node) => {
                    const label = String(node.data?.label ?? node.id);
                    const defId = node.data?.definitionId ? String(node.data.definitionId) : "";
                    const tip = defId && defId !== label ? `${label} · ${node.id} · ${defId}` : `${label} · ${node.id}`;
                    return (
                      <div key={node.id} className="af-composer-node-chip" title={tip}>
                        <span className="af-composer-node-chip-kind">{defId || "node"}</span>
                        <span className="af-composer-node-chip-label">{label}</span>
                        <button
                          type="button"
                          className="af-composer-node-chip-dismiss"
                          onClick={() => dismissSelectedNode(node.id)}
                          aria-label={`取消选择 ${node.id}`}
                        >
                          <span className="material-symbols-outlined">close</span>
                        </button>
                      </div>
                    );
                  })
                )}
              </div>
              <div className="af-composer-card af-composer-card--input-only">
                <div className="af-composer-input-wrap">
                  <textarea
                    className="af-composer-textarea"
                    value={composerText}
                    rows={2}
                    onChange={(e) => setComposerText(e.target.value)}
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                        e.preventDefault();
                        void submitWorkspaceAi();
                      }
                    }}
                    placeholder="描述你想在 workspace 中生成、分析或展示的内容"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div className="af-composer-toolbar">
                  <label className="af-composer-session-field">
                    <select className="af-composer-session-select" value="workspace" disabled aria-label="Workspace conversation">
                      <option value="workspace">Workspace</option>
                    </select>
                  </label>

                  <div className="af-composer-skills-field">
                    <button
                      ref={skillsButtonRef}
                      type="button"
                      className={"af-composer-skills-button" + (useWorkspaceSkills && selectedSkills.length > 0 ? " af-composer-skills-button--active" : "")}
                      disabled={composerRunning}
                      aria-haspopup="listbox"
                      aria-expanded={skillsOpen}
                      onClick={() => setSkillsOpen((v) => !v)}
                    >
                      <span className="material-symbols-outlined" aria-hidden>extension</span>
                      <span>{useWorkspaceSkills && selectedSkills.length > 0 ? `Skills ${selectedSkills.length}` : "Skills"}</span>
                    </button>
                    {skillsOpen && !composerRunning
                      ? createPortal(
                          <div ref={skillsMenuRef} className="af-composer-skills-menu" role="listbox" aria-label="Workspace skills" style={skillsMenuStyle}>
                            <label className="af-composer-skill-option af-workspace-skill-master">
                              <input type="checkbox" checked={useWorkspaceSkills} onChange={(e) => setUseWorkspaceSkills(e.target.checked)} />
                              <span className="af-composer-skill-option-main">
                                <span className="af-composer-skill-option-title">Use workspace skills by default</span>
                                <span className="af-composer-skill-option-desc">Workspace 视图默认启用，用于搭临时工作图和生成中间文件。</span>
                              </span>
                            </label>
                            {skills.length === 0 ? (
                              <div className="af-composer-skills-empty">No skills found</div>
                            ) : (
                              skillGroups.map((group) => (
                                <div key={group.label} className="af-composer-skill-group">
                                  <div className="af-composer-skill-group-title">
                                    <span>{group.label}</span>
                                    <span>{group.skills.length}</span>
                                  </div>
                                  {group.skills.map((skill) => (
                                    <label key={skill.key} className="af-composer-skill-option">
                                      <input
                                        type="checkbox"
                                        checked={selectedSkillSet.has(skill.key)}
                                        disabled={!useWorkspaceSkills}
                                        onChange={(e) => {
                                          const checked = e.target.checked;
                                          setSelectedSkills((prev) => checked
                                            ? (prev.includes(skill.key) ? prev : [...prev, skill.key])
                                            : prev.filter((k) => k !== skill.key));
                                        }}
                                      />
                                      <span className="af-composer-skill-option-main">
                                        <span className="af-composer-skill-option-title">{skill.name}</span>
                                        {skill.description ? <span className="af-composer-skill-option-desc">{skill.description}</span> : null}
                                      </span>
                                    </label>
                                  ))}
                                </div>
                              ))
                            )}
                          </div>,
                          document.body,
                        )
                      : null}
                  </div>

                  <label className="af-workspace-flowyaml-toggle" title="Workspace 默认不修改正式 flow.yaml">
                    <input type="checkbox" checked={allowFlowYaml} onChange={(e) => setAllowFlowYaml(e.target.checked)} />
                    <span>flow.yaml</span>
                  </label>

                  <label className="af-composer-model-field">
                    <select className="af-composer-model-select" value={composerModel} onChange={(e) => setComposerModel(e.target.value)} aria-label="模型">
                      <option value="">默认模型</option>
                      {modelOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                    </select>
                  </label>

                  <button
                    type="button"
                    className={"af-composer-send" + (composerText.trim() && !composerRunning ? " af-composer-send--active" : "") + (composerRunning ? " af-composer-send--stop" : "")}
                    disabled={composerRunning || !composerText.trim()}
                    aria-label={composerRunning ? "Running" : "Send"}
                    onClick={() => void submitWorkspaceAi()}
                  >
                    <span className="material-symbols-outlined" aria-hidden>{composerRunning ? "sync" : "arrow_upward"}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </main>
        {composerSidebarOpen ? (
          <aside className="af-pipeline-drawer af-pipeline-drawer--wide af-workspace-composer-drawer" aria-label="Workspace AI Composer">
            <div className="af-composer-sidebar">
              <div className="af-pipeline-drawer-head">
                <h2 className="af-pipeline-drawer-title">AI Composer</h2>
                <button
                  type="button"
                  className="af-pipeline-drawer-close af-icon-btn"
                  onClick={() => setComposerSidebarOpen(false)}
                  aria-label="关闭 AI 对话侧栏"
                >
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>
              <div className="af-composer-session-tabs">
                <button type="button" className="af-composer-session-tab af-composer-session-tab--active">
                  <span className="af-composer-session-label">Workspace</span>
                </button>
              </div>
              <div
                className={"af-composer-sidebar-status" + (composerRunning ? " af-composer-sidebar-status--running" : "")}
                role="status"
                aria-live="polite"
              >
                {composerRunning ? "Workspace agent running" : composerMessages.length > 0 ? "Workspace conversation" : "Ready"}
              </div>
              <div className="af-composer-sidebar-thread">
                <WorkspaceComposerThread messages={composerMessages} running={composerRunning} />
              </div>
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}

export default function WorkspacePage() {
  return (
    <ReactFlowProvider>
      <WorkspacePageInner />
    </ReactFlowProvider>
  );
}
