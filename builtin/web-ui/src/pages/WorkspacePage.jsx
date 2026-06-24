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
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import { buildInstancesForYaml, VALID_ROLES } from "../flowFormat.js";
import { FLOW_NODE_TYPE, FlowNode } from "../FlowNode.jsx";
import { cloneNodeIoDraftSlots, filterValidEdges, mergeNodeWithPalette } from "../mergeFlowNodes.js";
import { NODE_INSTANCE_ID_RE, NodePropertiesPanel } from "../NodePropertiesPanel.jsx";
import {
  areSlotsCompatible,
  getHandleColor,
  getNodeSlotByHandle,
  getSlotConnectionLabel,
} from "../nodeSchema.js";
import { flowUrlForView, recordPipelineView } from "../pipelineViewPreference.js";
import {
  addSkillKeys,
  collectionSelectionState,
  collectionSkillKeys,
  normalizeSkillCollections,
  readStoredOrDefaultSkillKeys,
  removeSkillKeys,
} from "../skillCollections.js";
import { useRoute } from "../routeContext.jsx";

const STORAGE_FALLBACK_KEY = "af:workspace-graph:v2";
const PALETTE_ORDER = ["DISPLAY", "CONTROL", "TOOL", "PROVIDE", "AGENT"];
const HIDDEN_WORKSPACE_DEFS = new Set(["control_start", "control_end", "control_load_skills"]);
const WORKSPACE_RUN_DEFINITION = {
  id: "workspace_run",
  displayName: "Run",
  label: "Run",
  description: "Run the downstream workspace subgraph connected from this node.",
  type: "control",
  inputs: [],
  outputs: [{ type: "node", name: "next", default: "" }],
};
const WORKSPACE_LOAD_SKILLS_DEFINITION = {
  id: "control_load_skills",
  displayName: "Load Skills",
  label: "Load Skills",
  description: "Load the currently selected Workspace skill collection for downstream agent nodes.",
  type: "control",
  inputs: [{ type: "node", name: "prev", default: "" }],
  outputs: [
    { type: "node", name: "next", default: "" },
    { type: "text", name: "skillsContext", default: "" },
  ],
};

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

function workspaceSkillsStorageKey(params) {
  const flowId = String(params?.flowId || "").trim();
  if (!flowId) return "";
  const flowSource = String(params?.flowSource || "user").trim() || "user";
  return `af:composer-skills:workspace:${flowId}:${flowSource}${params?.archived ? ":archived" : ""}`;
}

function isEditableShortcutTarget(target) {
  if (!target || typeof target.closest !== "function") return false;
  return Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
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
  if (id === "workspace_run") return "CONTROL";
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

function paletteDisplayLabel(node) {
  return labelForDefinition(node);
}

function paletteDescription(node) {
  return String(node?.description || node?.body || "").replace(/\s+/g, " ").trim();
}

function paletteSlotLabel(slot, index) {
  const name = String(slot?.name || slot?.id || "").trim();
  const type = String(slot?.type || "").trim();
  if (name) return name;
  if (type) return type;
  return `#${index + 1}`;
}

function paletteSlotTip(kind, slot, index) {
  const name = String(slot?.name || slot?.id || `#${index + 1}`).trim();
  const type = String(slot?.type || "").trim();
  const value = String(slot?.default ?? slot?.value ?? "").trim();
  return [kind, name, type ? `type: ${type}` : "", value ? `default: ${value}` : ""].filter(Boolean).join(" · ");
}

function paletteSlotsPreview(slots, kind) {
  const list = Array.isArray(slots) ? slots : [];
  const shown = list.slice(0, 4);
  const hidden = Math.max(0, list.length - shown.length);
  return { list, shown, hidden, kind };
}

function workspaceConnectionCompatible(connection, nodes) {
  const source = String(connection?.source || "");
  const target = String(connection?.target || "");
  if (!source || !target) return false;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const srcSlot = getNodeSlotByHandle(nodeById.get(source), connection.sourceHandle || "output-0", "source");
  const tgtSlot = getNodeSlotByHandle(nodeById.get(target), connection.targetHandle || "input-0", "target");
  return Boolean(srcSlot && tgtSlot && areSlotsCompatible(srcSlot, tgtSlot));
}

function buildWorkspaceConnectionDraft(params, nodes) {
  const nodeId = String(params?.nodeId || "");
  const handleId = String(params?.handleId || "");
  const handleType = params?.handleType === "target" ? "target" : params?.handleType === "source" ? "source" : "";
  if (!nodeId || !handleId || !handleType) return null;
  const node = nodes.find((item) => item.id === nodeId);
  const slot = getNodeSlotByHandle(node, handleId, handleType);
  if (!slot) return null;
  return {
    nodeId,
    handleId,
    handleType,
    slot,
    slotType: getSlotConnectionLabel(slot),
  };
}

function buildWorkspaceConnectionCandidates(palette, draft) {
  if (!draft) return [];
  return palette
    .map((def, order) => {
      const slots = Array.isArray(draft.handleType === "source" ? def.inputs : def.outputs)
        ? (draft.handleType === "source" ? def.inputs : def.outputs)
        : [];
      for (let i = 0; i < slots.length; i += 1) {
        const slot = slots[i];
        const ok = draft.handleType === "source"
          ? areSlotsCompatible(draft.slot, slot)
          : areSlotsCompatible(slot, draft.slot);
        if (!ok) continue;
        const category = paletteCategory(def);
        return {
          def,
          order,
          category,
          categoryRank: PALETTE_ORDER.indexOf(category),
          slot,
          slotIndex: i,
          displayLabel: paletteDisplayLabel(def),
          description: paletteDescription(def),
        };
      }
      return null;
    })
    .filter(Boolean)
    .sort((a, b) => {
      const aRequired = a.slot?.required ? 0 : 1;
      const bRequired = b.slot?.required ? 0 : 1;
      return (
        aRequired - bRequired ||
        a.slotIndex - b.slotIndex ||
        a.categoryRank - b.categoryRank ||
        a.order - b.order
      );
    });
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
    required: Boolean(slot?.required),
    showOnNode: slot?.showOnNode !== false,
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
  const outputEntries = outputs
    .map((slot, idx) => ({ slot, idx }))
    .sort((a, b) => {
      const an = String(a.slot?.name || "").trim();
      const bn = String(b.slot?.name || "").trim();
      if (an === "next" && bn !== "next") return -1;
      if (bn === "next" && an !== "next") return 1;
      const at = String(a.slot?.type || "").trim();
      const bt = String(b.slot?.type || "").trim();
      if (at === "node" && bt !== "node") return -1;
      if (bt === "node" && at !== "node") return 1;
      return a.idx - b.idx;
    });
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
      {inputs.map((slot, idx) => {
        if (slot.showOnNode === false) return null;
        const top = `${4.15 + idx * 1.75}rem`;
        const label = slot.name || `#${idx + 1}`;
        return (
          <Fragment key={`in-${idx}`}>
            <span className="af-work-port-label af-work-port-label--in" style={{ top }}>{label}</span>
            <Handle
              type="target"
              position={Position.Left}
              id={`input-${idx}`}
              className="af-work-display-handle af-work-display-handle--in"
              style={{ top, background: getHandleColor(slot.type) }}
              title={`${label} · ${slot.type}`}
            />
          </Fragment>
        );
      })}
      {outputEntries.map(({ slot, idx }, visualIndex) => {
        if (slot.showOnNode === false) return null;
        const top = `${4.15 + visualIndex * 1.75}rem`;
        const label = slot.name || `#${idx + 1}`;
        return (
          <Fragment key={`out-${idx}`}>
            <span className="af-work-port-label af-work-port-label--out" style={{ top }}>{label}</span>
            <Handle
              type="source"
              position={Position.Right}
              id={`output-${idx}`}
              className="af-work-display-handle af-work-display-handle--out"
              style={{ top, background: getHandleColor(slot.type) }}
              title={`${label} · ${slot.type}`}
            />
          </Fragment>
        );
      })}
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

function WorkspaceRunNode({ id, data, selected, deleteNode }) {
  const outputs = Array.isArray(data?.outputs) ? data.outputs : [];
  const running = data?.runningRunNodeId === id;
  return (
    <div className={"af-work-run-card" + (selected ? " af-work-run-card--selected" : "") + (running ? " af-work-run-card--running" : "")}>
      {outputs.map((slot, idx) => {
        if (slot.showOnNode === false) return null;
        const top = `${2.25 + idx * 1.75}rem`;
        const label = slot.name || `#${idx + 1}`;
        return (
          <Fragment key={`out-${idx}`}>
            <span className="af-work-port-label af-work-port-label--out" style={{ top }}>{label}</span>
            <Handle
              type="source"
              position={Position.Right}
              id={`output-${idx}`}
              className="af-work-display-handle af-work-display-handle--out"
              style={{ top, background: getHandleColor(slot.type) }}
              title={`${label} · ${slot.type}`}
            />
          </Fragment>
        );
      })}
      <div className="af-work-run-card__head">
        <span className="material-symbols-outlined">play_circle</span>
        <strong>{data?.label || "Run"}</strong>
        <span>{data?.definitionId || "workspace_run"}</span>
        <button type="button" className="af-work-display-card__close nodrag" onClick={() => deleteNode?.(id)} aria-label="删除节点">
          <span className="material-symbols-outlined">close</span>
        </button>
      </div>
      <button
        type="button"
        className="af-work-run-card__button nodrag"
        disabled={running}
        onClick={(event) => {
          event.stopPropagation();
          data?.onRunWorkspaceNode?.(id);
        }}
      >
        <span className={"material-symbols-outlined" + (running ? " af-spin" : "")}>{running ? "sync" : "play_arrow"}</span>
        <span>{running ? "Running" : "Run line"}</span>
      </button>
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
  if (props.data?.definitionId === "workspace_run") {
    return <WorkspaceRunNode {...props} deleteNode={deleteNode} />;
  }
  if (props.data?.definitionId === "control_load_skills") {
    return (
      <WorkspaceLoadSkillsNode
        {...props}
        deleteNode={deleteNode}
        skills={props.data?.skills}
        skillCollections={props.data?.skillCollections}
        onChangeSkillKeys={props.data?.onChangeLoadSkillKeys}
      />
    );
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

function selectedSkillKeysFromValue(rawValue) {
  const raw = String(rawValue || "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean);
  } catch {
    /* plain list fallback */
  }
  return raw.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);
}

function selectedSkillKeysFromNodeData(data) {
  const bodyKeys = selectedSkillKeysFromValue(data?.body || "");
  if (bodyKeys.length > 0) return bodyKeys;
  const outputs = Array.isArray(data?.outputs) ? data.outputs : [];
  const inputs = Array.isArray(data?.inputs) ? data.inputs : [];
  const slot = [...outputs, ...inputs].find((item) => item?.name === "skillsContext" || item?.type === "text");
  return selectedSkillKeysFromValue(slot?.default || slot?.value || "");
}

function serializeSkillKeys(keys) {
  return JSON.stringify(Array.from(new Set((keys || []).map(String).filter(Boolean))));
}

function WorkspaceLoadSkillsNode({
  id,
  data,
  selected,
  deleteNode,
  skills,
  skillCollections,
  onChangeSkillKeys,
}) {
  const inputs = Array.isArray(data?.inputs) ? data.inputs : [];
  const outputs = Array.isArray(data?.outputs) ? data.outputs : [];
  const skillsList = Array.isArray(skills) ? skills : [];
  const collectionsList = Array.isArray(skillCollections) ? skillCollections : [];
  const [open, setOpen] = useState(false);
  const keys = useMemo(() => new Set(selectedSkillKeysFromNodeData(data)), [data]);
  const byKey = useMemo(() => new Map(skillsList.map((skill) => [skill.key, skill])), [skillsList]);
  const groups = useMemo(() => {
    const used = new Set();
    const collectionGroups = collectionsList
      .map((collection) => {
        const groupSkills = collectionSkillKeys(collection, skillsList).map((key) => byKey.get(key)).filter(Boolean);
        for (const skill of groupSkills) used.add(skill.key);
        return { ...collection, skills: groupSkills };
      })
      .filter((collection) => collection.skills.length > 0);
    const ungrouped = skillsList.filter((skill) => !used.has(skill.key));
    return { collectionGroups, ungrouped };
  }, [byKey, collectionsList, skillsList]);
  const toggleKeys = useCallback((toggleKeysList, checked) => {
    const next = new Set(keys);
    for (const key of toggleKeysList) {
      if (checked) next.add(key);
      else next.delete(key);
    }
    onChangeSkillKeys?.(id, Array.from(next));
  }, [id, keys, onChangeSkillKeys]);

  return (
    <div className={"af-work-load-skills-card" + (selected ? " af-work-load-skills-card--selected" : "")}>
      {inputs.map((slot, idx) => {
        if (slot.showOnNode === false) return null;
        const top = `${2.6 + idx * 1.7}rem`;
        const label = slot.name || `#${idx + 1}`;
        return (
          <Fragment key={`in-${idx}`}>
            <span className="af-work-port-label af-work-port-label--in" style={{ top }}>{label}</span>
            <Handle
              type="target"
              position={Position.Left}
              id={`input-${idx}`}
              className="af-work-display-handle af-work-display-handle--in"
              style={{ top, background: getHandleColor(slot.type) }}
              title={`${label} · ${slot.type}`}
            />
          </Fragment>
        );
      })}
      {outputs.map((slot, idx) => {
        if (slot.showOnNode === false) return null;
        const top = `${2.6 + idx * 1.7}rem`;
        const label = slot.name || `#${idx + 1}`;
        return (
          <Fragment key={`out-${idx}`}>
            <span className="af-work-port-label af-work-port-label--out" style={{ top }}>{label}</span>
            <Handle
              type="source"
              position={Position.Right}
              id={`output-${idx}`}
              className="af-work-display-handle af-work-display-handle--out"
              style={{ top, background: getHandleColor(slot.type) }}
              title={`${label} · ${slot.type}`}
            />
          </Fragment>
        );
      })}
      <div className="af-work-load-skills-card__head">
        <span className="material-symbols-outlined">extension</span>
        <strong>{data?.label || "Load Skills"}</strong>
        <span>{data?.definitionId || "control_load_skills"}</span>
        <button type="button" className="af-work-display-card__close nodrag" onClick={() => deleteNode?.(id)} aria-label="删除节点">
          <span className="material-symbols-outlined">close</span>
        </button>
      </div>
      <div className="af-work-load-skills-card__body nodrag">
        <button type="button" className="af-work-load-skills-card__select" onClick={(event) => {
          event.stopPropagation();
          setOpen((v) => !v);
        }}>
          <span>{keys.size > 0 ? `${keys.size} skills selected` : "选择 Skills"}</span>
          <span className="material-symbols-outlined" aria-hidden>{open ? "expand_less" : "expand_more"}</span>
        </button>
        {open ? (
          <div className="af-work-load-skills-menu" onClick={(event) => event.stopPropagation()}>
            {groups.collectionGroups.map((group) => {
              const groupKeys = group.skills.map((skill) => skill.key);
              const checkedCount = groupKeys.filter((key) => keys.has(key)).length;
              const allChecked = groupKeys.length > 0 && checkedCount === groupKeys.length;
              return (
                <section key={group.id} className="af-work-load-skills-menu__group">
                  <label className="af-work-load-skills-menu__group-head">
                    <input type="checkbox" checked={allChecked} onChange={(event) => toggleKeys(groupKeys, event.target.checked)} />
                    <span>{group.name}</span>
                    <small>{checkedCount}/{groupKeys.length}</small>
                  </label>
                  <div className="af-work-load-skills-menu__options">
                    {group.skills.map((skill) => (
                      <label key={`${group.id}:${skill.key}`} className="af-work-load-skills-menu__option">
                        <input type="checkbox" checked={keys.has(skill.key)} onChange={(event) => toggleKeys([skill.key], event.target.checked)} />
                        <span>{skill.name}</span>
                      </label>
                    ))}
                  </div>
                </section>
              );
            })}
            {groups.ungrouped.length > 0 ? (
              <section className="af-work-load-skills-menu__group">
                <div className="af-work-load-skills-menu__group-head af-work-load-skills-menu__group-head--plain">
                  <span>Ungrouped</span>
                  <small>{groups.ungrouped.length}</small>
                </div>
                <div className="af-work-load-skills-menu__options">
                  {groups.ungrouped.map((skill) => (
                    <label key={`ungrouped:${skill.key}`} className="af-work-load-skills-menu__option">
                      <input type="checkbox" checked={keys.has(skill.key)} onChange={(event) => toggleKeys([skill.key], event.target.checked)} />
                      <span>{skill.name}</span>
                    </label>
                  ))}
                </div>
              </section>
            ) : null}
            <button type="button" className="af-work-load-skills-menu__clear" onClick={() => onChangeSkillKeys?.(id, [])}>清空</button>
          </div>
        ) : null}
      </div>
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
  const nodesRef = useRef([]);
  const connectionStartRef = useRef(null);
  const connectionMenuRef = useRef(null);
  const [connectionMenu, setConnectionMenu] = useState(null);
  const [instances, setInstances] = useState({});
  const instancesRef = useRef({});
  const loadedRef = useRef(false);
  const saveTimerRef = useRef(null);
  const [palette, setPalette] = useState([]);
  const [paletteSearch, setPaletteSearch] = useState("");
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [quickAddSearch, setQuickAddSearch] = useState("");
  const [quickAddActiveIndex, setQuickAddActiveIndex] = useState(0);
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [nodePropDraft, setNodePropDraft] = useState(null);
  const [nodePropsError, setNodePropsError] = useState("");
  const [files, setFiles] = useState([]);
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [fileFilter, setFileFilter] = useState("");
  const [collapsedDirs, setCollapsedDirs] = useState(() => new Set());
  const [modelLists, setModelLists] = useState({ cursor: [], opencode: [], claudeCode: [] });
  const [composerModel, setComposerModel] = useState("");
  const [skills, setSkills] = useState([]);
  const [skillsLoaded, setSkillsLoaded] = useState(false);
  const [selectedSkills, setSelectedSkills] = useState([]);
  const [skillCollections, setSkillCollections] = useState([]);
  const [skillCollectionsLoaded, setSkillCollectionsLoaded] = useState(false);
  const [collapsedSkillCollections, setCollapsedSkillCollections] = useState(() => new Set());
  const [skillsOpen, setSkillsOpen] = useState(false);
  const skillsButtonRef = useRef(null);
  const skillsMenuRef = useRef(null);
  const quickAddInputRef = useRef(null);
  const [skillsMenuStyle, setSkillsMenuStyle] = useState({});
  const [allowFlowYaml, setAllowFlowYaml] = useState(false);
  const [composerText, setComposerText] = useState("");
  const [composerRunning, setComposerRunning] = useState(false);
  const [composerMessages, setComposerMessages] = useState([]);
  const [composerSidebarOpen, setComposerSidebarOpen] = useState(false);
  const [runningRunNodeId, setRunningRunNodeId] = useState("");
  const [status, setStatus] = useState("");
  const composerStorageKey = useMemo(() => workspaceComposerStorageKey(flowParams), [flowParams]);
  const skillsStorageKey = useMemo(() => workspaceSkillsStorageKey(flowParams), [flowParams]);
  const composerLoadedRef = useRef(false);
  const [skillsStorageReadyKey, setSkillsStorageReadyKey] = useState("");

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
    const paletteList = [
      ...(Array.isArray(nodesJson) ? nodesJson : nodesJson.nodes || []).filter((node) => !HIDDEN_WORKSPACE_DEFS.has(node.id)),
      WORKSPACE_LOAD_SKILLS_DEFINITION,
      WORKSPACE_RUN_DEFINITION,
    ];
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

  const runWorkspaceNode = useCallback(async (runNodeId) => {
    if (!runNodeId || runningRunNodeId) return;
    const graph = flowToGraph(nodes, edges, instancesRef.current);
    setRunningRunNodeId(runNodeId);
    setStatus(`Running ${runNodeId}...`);
    try {
      await saveGraph(nodes, edges);
      const res = await fetch("/api/workspace/run", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify({
          ...flowParams,
          graph,
          runNodeId,
          model: composerModel,
          selectedSkills,
          stream: true,
        }),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        throw new Error(json.error || "Workspace run failed");
      }
      if (!res.body) throw new Error("Workspace run stream unavailable");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finalOrder = [];
      const applyGraph = (nextGraph) => {
        const flow = graphToFlow(nextGraph || graph, palette);
        instancesRef.current = flow.instances;
        setInstances(flow.instances);
        setNodes(flow.nodes);
        setEdges(flow.edges);
      };
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.type === "error") throw new Error(event.error || "Workspace run failed");
          if (event.type === "node-start") setStatus(`Running ${event.nodeId}...`);
          if (event.type === "graph" && event.graph) applyGraph(event.graph);
          if (event.type === "done") {
            if (event.graph) applyGraph(event.graph);
            finalOrder = Array.isArray(event.order) ? event.order : [];
          }
        }
      }
      if (buffer.trim()) {
        const event = JSON.parse(buffer);
        if (event.type === "error") throw new Error(event.error || "Workspace run failed");
        if (event.type === "graph" && event.graph) applyGraph(event.graph);
        if (event.type === "done") {
          if (event.graph) applyGraph(event.graph);
          finalOrder = Array.isArray(event.order) ? event.order : [];
        }
      }
      setStatus(`Workspace run done: ${finalOrder.length ? finalOrder.join(" -> ") : runNodeId}`);
      await loadFiles();
    } catch (e) {
      setStatus(String(e.message || e));
    } finally {
      setRunningRunNodeId("");
    }
  }, [composerModel, edges, flowParams, loadFiles, nodes, palette, runningRunNodeId, saveGraph, selectedSkills, setEdges, setNodes]);

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
      setSkillsLoaded(true);
    }).catch(() => {});
    fetch("/api/skill-collections").then((r) => r.json()).then((j) => {
      setSkillCollections(normalizeSkillCollections(j));
      setSkillCollectionsLoaded(true);
    }).catch(() => {});
  }, [loadWorkspace, skillsStorageKey]);

  useEffect(() => {
    setSkillsStorageReadyKey("");
    if (!skillsLoaded || !skillCollectionsLoaded) return;
    if (!skillsStorageKey) {
      setSelectedSkills([]);
      return;
    }
    setSelectedSkills(readStoredOrDefaultSkillKeys(skillsStorageKey, "workspace", skills, skillCollections));
    setSkillsStorageReadyKey(skillsStorageKey);
  }, [skillCollections, skillCollectionsLoaded, skills, skillsLoaded, skillsStorageKey]);

  useEffect(() => {
    if (skillsStorageReadyKey !== skillsStorageKey || !skillsStorageKey) return;
    try {
      localStorage.setItem(skillsStorageKey, JSON.stringify(selectedSkills));
    } catch {
      /* ignore quota */
    }
  }, [selectedSkills, skillsStorageKey, skillsStorageReadyKey]);

  useEffect(() => {
    instancesRef.current = instances;
  }, [instances]);

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    connectionMenuRef.current = connectionMenu;
  }, [connectionMenu]);

  useEffect(() => {
    if (!connectionMenu) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") setConnectionMenu(null);
    };
    const onPointerDown = (event) => {
      if (event.target?.closest?.(".af-connect-node-menu")) return;
      setConnectionMenu(null);
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [connectionMenu]);

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

  const changeLoadSkillKeys = useCallback((nodeId, keys) => {
    const serialized = serializeSkillKeys(keys);
    const patchSlots = (slots) => (Array.isArray(slots) ? slots.map((slot) => {
      if (slot?.name !== "skillsContext" && slot?.type !== "text") return slot;
      return { ...slot, default: serialized, value: serialized };
    }) : []);
    setNodes((list) => list.map((node) => {
      if (node.id !== nodeId) return node;
      return {
        ...node,
        data: {
          ...node.data,
          body: serialized,
          inputs: patchSlots(node.data?.inputs),
          outputs: patchSlots(node.data?.outputs),
        },
      };
    }));
    setInstances((prev) => {
      const base = prev[nodeId] && typeof prev[nodeId] === "object" ? prev[nodeId] : {};
      const next = {
        ...prev,
        [nodeId]: {
          ...base,
          body: serialized,
          input: patchSlots(base.input),
          output: patchSlots(base.output),
        },
      };
      instancesRef.current = next;
      return next;
    });
  }, [setNodes]);

  const hydratedNodes = useMemo(() => nodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      modelLists,
      showBodyPreview: true,
      onRunWorkspaceNode: runWorkspaceNode,
      runningRunNodeId,
      skills,
      skillCollections,
      onChangeLoadSkillKeys: changeLoadSkillKeys,
    },
  })), [changeLoadSkillKeys, modelLists, nodes, runWorkspaceNode, runningRunNodeId, skillCollections, skills]);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) || null,
    [nodes, selectedNodeId],
  );

  useEffect(() => {
    if (!selectedNode) {
      setNodePropDraft(null);
      setNodePropsError("");
      return;
    }
    const { inputs, outputs } = cloneNodeIoDraftSlots(selectedNode);
    setNodePropDraft({
      id: selectedNode.id,
      newId: selectedNode.id,
      label: String(selectedNode.data?.label ?? selectedNode.id),
      role: String(selectedNode.data?.role ?? "normal"),
      model: String(selectedNode.data?.model ?? ""),
      body: String(selectedNode.data?.body ?? ""),
      script: String(selectedNode.data?.script ?? ""),
      inputs,
      outputs,
    });
    setNodePropsError("");
  }, [selectedNode?.id]);

  const applyNodeProperties = useCallback((allowRename = false) => {
    if (!nodePropDraft || !selectedNode) return false;
    const oldId = selectedNode.id;
    const trimmedNew = String(nodePropDraft.newId || "").trim();
    const nextId = allowRename ? trimmedNew : oldId;
    setNodePropsError("");
    if (allowRename) {
      if (!NODE_INSTANCE_ID_RE.test(nextId)) {
        setNodePropsError("Invalid instance id");
        return false;
      }
      if (nodes.some((node) => node.id === nextId && node.id !== oldId)) {
        setNodePropsError("Duplicate instance id");
        return false;
      }
    }
    const roleStr = String(nodePropDraft.role || "").trim();
    const role = VALID_ROLES.includes(roleStr) ? roleStr : "normal";
    const modelTrim = String(nodePropDraft.model || "").trim();
    const normIo = (arr) => (Array.isArray(arr) ? arr : []).map((slot) => ({
      type: String(slot?.type ?? "node").trim() || "node",
      name: String(slot?.name ?? ""),
      default: String(slot?.default ?? ""),
      required: Boolean(slot?.required),
      showOnNode: slot?.showOnNode !== false,
    }));
    const nextData = {
      ...selectedNode.data,
      label: String(nodePropDraft.label || "").trim() || nextId,
      role,
      model: modelTrim === "" || modelTrim === "default" ? undefined : modelTrim,
      body: String(nodePropDraft.body ?? ""),
      inputs: normIo(nodePropDraft.inputs),
      outputs: normIo(nodePropDraft.outputs),
    };
    const scriptTrim = String(nodePropDraft.script ?? "").trim();
    const defId = String(selectedNode.data?.definitionId ?? nextId);
    if (defId === "tool_nodejs" || scriptTrim !== "") nextData.script = String(nodePropDraft.script ?? "");
    else delete nextData.script;

    const prevData = selectedNode.data || {};
    const changed =
      nextId !== oldId ||
      prevData.label !== nextData.label ||
      prevData.role !== nextData.role ||
      prevData.model !== nextData.model ||
      prevData.body !== nextData.body ||
      (prevData.script ?? undefined) !== (nextData.script ?? undefined) ||
      JSON.stringify(prevData.inputs || []) !== JSON.stringify(nextData.inputs || []) ||
      JSON.stringify(prevData.outputs || []) !== JSON.stringify(nextData.outputs || []);
    if (!changed) return true;

    let nextNodes = nodes.map((node) => (
      node.id === oldId ? { ...node, id: nextId, selected: true, data: nextData } : node
    ));
    let nextEdges = edges;
    if (nextId !== oldId) {
      const nextInstances = { ...instancesRef.current };
      const base = { ...(nextInstances[oldId] || {}) };
      delete nextInstances[oldId];
      nextInstances[nextId] = base;
      instancesRef.current = nextInstances;
      setInstances(nextInstances);
      nextEdges = edges.map((edge, index) => ({
        ...edge,
        source: edge.source === oldId ? nextId : edge.source,
        target: edge.target === oldId ? nextId : edge.target,
        id: `we-${edge.source === oldId ? nextId : edge.source}-${edge.target === oldId ? nextId : edge.target}-${index}`,
      }));
      setSelectedNodeId(nextId);
    }
    setNodes(nextNodes);
    setEdges(nextEdges);
    return true;
  }, [edges, nodePropDraft, nodes, selectedNode, setEdges, setNodes]);

  useEffect(() => {
    if (!nodePropDraft || !selectedNode) return;
    const timer = window.setTimeout(() => {
      applyNodeProperties(false);
    }, 350);
    return () => window.clearTimeout(timer);
  }, [
    nodePropDraft?.label,
    nodePropDraft?.role,
    nodePropDraft?.model,
    nodePropDraft?.body,
    nodePropDraft?.script,
    JSON.stringify(nodePropDraft?.inputs || []),
    JSON.stringify(nodePropDraft?.outputs || []),
    applyNodeProperties,
    selectedNode?.id,
  ]);

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

  const quickAddItems = useMemo(() => {
    const q = quickAddSearch.trim().toLowerCase();
    return palette
      .filter((item) => !q || [item.id, item.label, item.displayName, item.description]
        .some((x) => String(x || "").toLowerCase().includes(q)))
      .sort((a, b) => {
        const ac = PALETTE_ORDER.indexOf(paletteCategory(a));
        const bc = PALETTE_ORDER.indexOf(paletteCategory(b));
        if (ac !== bc) return ac - bc;
        return paletteDisplayLabel(a).localeCompare(paletteDisplayLabel(b));
      })
      .slice(0, 30);
  }, [palette, quickAddSearch]);

  useEffect(() => {
    setQuickAddActiveIndex(0);
  }, [quickAddSearch, quickAddOpen]);

  useEffect(() => {
    if (!quickAddOpen) return;
    const timer = window.setTimeout(() => quickAddInputRef.current?.focus(), 0);
    return () => window.clearTimeout(timer);
  }, [quickAddOpen]);

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
  const skillCollectionGroups = useMemo(() => {
    const byKey = new Map(skills.map((skill) => [skill.key, skill]));
    const used = new Set();
    const usedNames = new Set();
    const groups = skillCollections
      .map((collection) => {
        const groupSkills = collectionSkillKeys(collection, skills).map((key) => byKey.get(key)).filter(Boolean);
        for (const skill of groupSkills) {
          used.add(skill.key);
          usedNames.add(String(skill.name || skill.id || skill.key || "").trim());
        }
        return { ...collection, skills: groupSkills };
      })
      .filter((collection) => collection.skills.length > 0);
    const ungrouped = skills.filter((skill) => {
      const name = String(skill.name || skill.id || skill.key || "").trim();
      return !used.has(skill.key) && !usedNames.has(name);
    });
    return { groups, ungrouped };
  }, [skillCollections, skills]);

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

  const quickAddNodePosition = useCallback(() => {
    if (selectedNode) {
      const width = Number(selectedNode.measured?.width || selectedNode.width || 260);
      return {
        x: Number(selectedNode.position?.x || 0) + width + 140,
        y: Number(selectedNode.position?.y || 0),
      };
    }
    return defaultWorkspaceNodePosition();
  }, [defaultWorkspaceNodePosition, selectedNode]);

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

  const isValidConnection = useCallback((params) => workspaceConnectionCompatible(params, nodesRef.current), []);

  const handleConnect = useCallback((params) => {
    if (!workspaceConnectionCompatible(params, nodesRef.current)) {
      setStatus("端口类型不匹配，已取消连线");
      return;
    }
    setConnectionMenu(null);
    setEdges((current) => {
      const filtered = current.filter(
        (edge) => !(edge.target === params.target && edge.targetHandle === params.targetHandle)
      );
      return addEdge({ ...params, markerEnd: { type: MarkerType.ArrowClosed } }, filtered);
    });
  }, [setEdges]);

  const handleConnectStart = useCallback((_, params) => {
    connectionStartRef.current = buildWorkspaceConnectionDraft(params, nodesRef.current);
    setConnectionMenu(null);
  }, []);

  const handleConnectEnd = useCallback((event, connectionState) => {
    const draft = connectionStartRef.current;
    connectionStartRef.current = null;
    if (!draft) return;
    if (connectionState?.toNode) return;
    const candidates = buildWorkspaceConnectionCandidates(palette, draft);
    if (candidates.length === 0) {
      setStatus(`没有匹配 ${draft.slotType} 端口的节点`);
      return;
    }
    const clientX = event?.changedTouches?.[0]?.clientX ?? event?.clientX;
    const clientY = event?.changedTouches?.[0]?.clientY ?? event?.clientY;
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
    const wrap = document.querySelector(".af-workspace-canvas .react-flow");
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const menuWidth = 320;
    const menuHeight = Math.min(440, 104 + candidates.length * 58);
    const left = Math.max(12, Math.min(clientX - rect.left, rect.width - menuWidth - 12));
    const top = Math.max(12, Math.min(clientY - rect.top, rect.height - menuHeight - 12));
    setConnectionMenu({
      left,
      top,
      flowPosition: reactFlow.screenToFlowPosition({ x: clientX, y: clientY }),
      draft,
      candidates,
      query: "",
    });
  }, [palette, reactFlow]);

  const handleConnectionMenuSelect = useCallback((candidate) => {
    const menu = connectionMenuRef.current;
    if (!menu || !candidate?.def) return;
    const newNodeId = addNodeFromDefinition(candidate.def, { position: menu.flowPosition });
    if (!newNodeId) return;
    const nextConnection =
      menu.draft.handleType === "source"
        ? {
            source: menu.draft.nodeId,
            sourceHandle: menu.draft.handleId,
            target: newNodeId,
            targetHandle: `input-${candidate.slotIndex}`,
          }
        : {
            source: newNodeId,
            sourceHandle: `output-${candidate.slotIndex}`,
            target: menu.draft.nodeId,
            targetHandle: menu.draft.handleId,
          };
    setEdges((current) => {
      const filtered = current.filter(
        (edge) => !(edge.target === nextConnection.target && edge.targetHandle === nextConnection.targetHandle)
      );
      return addEdge({ ...nextConnection, markerEnd: { type: MarkerType.ArrowClosed } }, filtered);
    });
    setConnectionMenu(null);
  }, [addNodeFromDefinition, setEdges]);

  const addQuickNode = useCallback((def) => {
    if (!def) return;
    addNodeFromDefinition(def, { position: quickAddNodePosition() });
    setQuickAddOpen(false);
    setQuickAddSearch("");
  }, [addNodeFromDefinition, quickAddNodePosition]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableShortcutTarget(event.target)) return;
      if (event.key === "a" || event.key === "A") {
        event.preventDefault();
        setQuickAddOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

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
      await saveGraph(nodes, edges);
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
          selectedSkills,
          selectedNodeIds: selectedCanvasNodeIds,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "生成失败");
      const text = String(json.content || "").trim();
      setComposerMessages((list) => [...list, { role: "assistant", text, at: Date.now() }]);
      await loadWorkspace();
      setStatus("AI 生成完成");
    } catch (e) {
      const message = String(e.message || e);
      setComposerMessages((list) => [...list, { role: "assistant", text: message, error: true, at: Date.now() }]);
      setStatus(message);
    } finally {
      setComposerRunning(false);
    }
  }, [allowFlowYaml, composerModel, composerRunning, composerText, edges, flowParams, loadWorkspace, nodes, saveGraph, selectedCanvasNodeIds, selectedSkills]);

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

      <div className={"af-workspace-body" + (composerSidebarOpen || nodePropDraft ? " af-workspace-body--drawer" : "")}>
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
            <div className="af-node-palette-head af-workspace-node-palette-head">
              <h2 className="af-node-palette-title">
                <span>Node Palette</span>
                <span className="af-node-palette-title-kbd" aria-label="快捷键 A">A</span>
              </h2>
              <label className="af-palette-search-wrap">
                <span className="af-visually-hidden">搜索节点</span>
                <span className="af-palette-search-icon material-symbols-outlined" aria-hidden>
                  search
                </span>
                <input
                  type="search"
                  className="af-palette-search-input"
                  value={paletteSearch}
                  onChange={(e) => setPaletteSearch(e.target.value)}
                  placeholder="搜索节点..."
                  aria-label="搜索节点"
                />
              </label>
            </div>
            <div className="af-node-palette-scroll af-workspace-node-palette-scroll">
              {PALETTE_ORDER.map((cat) => groupedPalette[cat]?.length ? (
                <section key={cat} className={`af-palette-section af-flow-palette-section--${cat}`}>
                  <h3 className="af-palette-cat">{cat}</h3>
                  <div className="af-palette-cards">
                    {groupedPalette[cat].map((node) => {
                      const inputs = paletteSlotsPreview(node.inputs, "input");
                      const outputs = paletteSlotsPreview(node.outputs, "output");
                      const desc = paletteDescription(node);
                      const displayLabel = paletteDisplayLabel(node);
                      return (
                        <button
                          key={node.id}
                          type="button"
                          className="af-palette-card"
                          draggable
                          onDragStart={(e) => handlePaletteNodeDragStart(e, node)}
                          onClick={() => addNodeFromDefinition(node)}
                          title={desc || node.id}
                        >
                          <span className="af-palette-card-head">
                            <span className="af-palette-card-icon" aria-hidden>
                              <span className="material-symbols-outlined">{paletteIcon(cat)}</span>
                            </span>
                            <span className="af-palette-card-main">
                              <span className="af-palette-card-label">{displayLabel}</span>
                              {displayLabel !== node.id ? <span className="af-palette-card-id">{node.id}</span> : null}
                            </span>
                          </span>
                          {desc ? <span className="af-palette-card-desc">{desc}</span> : null}
                          <span className="af-palette-card-ports" aria-hidden>
                            <span className="af-palette-card-port-side af-palette-card-port-side--in">
                              <span className="af-palette-card-port-count">{inputs.list.length} IN</span>
                              <span className="af-palette-card-port-list">
                                {inputs.shown.map((slot, i) => (
                                  <span key={`in-${i}`} className="af-palette-card-port" title={paletteSlotTip("input", slot, i)}>
                                    <span
                                      className="af-palette-card-port-dot"
                                      style={{ background: getHandleColor(slot?.type) }}
                                    />
                                    <span className="af-palette-card-port-name">{paletteSlotLabel(slot, i)}</span>
                                  </span>
                                ))}
                                {inputs.hidden > 0 ? <span className="af-palette-card-port-more">+{inputs.hidden}</span> : null}
                              </span>
                            </span>
                            <span className="af-palette-card-port-side af-palette-card-port-side--out">
                              <span className="af-palette-card-port-count">{outputs.list.length} OUT</span>
                              <span className="af-palette-card-port-list">
                                {outputs.shown.map((slot, i) => (
                                  <span key={`out-${i}`} className="af-palette-card-port" title={paletteSlotTip("output", slot, i)}>
                                    <span className="af-palette-card-port-name">{paletteSlotLabel(slot, i)}</span>
                                    <span
                                      className="af-palette-card-port-dot"
                                      style={{ background: getHandleColor(slot?.type) }}
                                    />
                                  </span>
                                ))}
                                {outputs.hidden > 0 ? <span className="af-palette-card-port-more">+{outputs.hidden}</span> : null}
                              </span>
                            </span>
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </section>
              ) : null)}
              {palette.length > 0 && paletteSearch.trim() && PALETTE_ORDER.every((cat) => !groupedPalette[cat]?.length) ? (
                <p className="af-palette-empty">没有匹配的节点</p>
              ) : null}
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
            onConnect={handleConnect}
            onConnectStart={handleConnectStart}
            onConnectEnd={handleConnectEnd}
            isValidConnection={isValidConnection}
            onNodeClick={(_, node) => {
              setComposerSidebarOpen(false);
              setSelectedNodeId(node.id);
            }}
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
          {connectionMenu ? (() => {
            const q = String(connectionMenu.query || "").trim().toLowerCase();
            const visibleCandidates = q
              ? connectionMenu.candidates.filter((candidate) =>
                  [
                    candidate.def?.id,
                    candidate.displayLabel,
                    candidate.description,
                    candidate.slot?.name,
                    candidate.slot?.type,
                  ]
                    .filter(Boolean)
                    .some((value) => String(value).toLowerCase().includes(q))
                )
              : connectionMenu.candidates;
            const portKind = connectionMenu.draft.handleType === "source" ? "IN" : "OUT";
            return (
              <div
                className="af-connect-node-menu"
                style={{ left: connectionMenu.left, top: connectionMenu.top }}
                role="dialog"
                aria-label="选择匹配节点"
              >
                <div className="af-connect-node-menu__head">
                  <div className="af-connect-node-menu__title">
                    <span
                      className="af-connect-node-menu__dot"
                      style={{ background: getHandleColor(connectionMenu.draft.slot?.type) }}
                      aria-hidden
                    />
                    <span>匹配 {connectionMenu.draft.slotType} 节点</span>
                  </div>
                  <button
                    type="button"
                    className="af-connect-node-menu__close"
                    aria-label="关闭"
                    onClick={() => setConnectionMenu(null)}
                  >
                    <span className="material-symbols-outlined" aria-hidden>close</span>
                  </button>
                </div>
                <label className="af-connect-node-menu__search">
                  <span className="material-symbols-outlined" aria-hidden>search</span>
                  <input
                    type="search"
                    value={connectionMenu.query}
                    onChange={(event) =>
                      setConnectionMenu((menu) => menu ? { ...menu, query: event.target.value } : menu)
                    }
                    placeholder="搜索节点"
                    autoFocus
                  />
                </label>
                <div className="af-connect-node-menu__list">
                  {visibleCandidates.map((candidate) => {
                    const label = candidate.displayLabel || candidate.def?.id;
                    const slotLabel = paletteSlotLabel(candidate.slot, candidate.slotIndex);
                    return (
                      <button
                        key={`${candidate.def.id}-${candidate.slotIndex}`}
                        type="button"
                        className="af-connect-node-menu__item"
                        onClick={() => handleConnectionMenuSelect(candidate)}
                        title={candidate.description || candidate.def.id}
                      >
                        <span className="af-connect-node-menu__item-main">
                          <span className="af-connect-node-menu__item-label">{label}</span>
                          {label !== candidate.def.id ? (
                            <span className="af-connect-node-menu__item-id">{candidate.def.id}</span>
                          ) : null}
                        </span>
                        <span className="af-connect-node-menu__port">
                          <span>{portKind}</span>
                          <span
                            className="af-connect-node-menu__port-dot"
                            style={{ background: getHandleColor(candidate.slot?.type) }}
                            aria-hidden
                          />
                          <span className="af-connect-node-menu__port-name">{slotLabel}</span>
                        </span>
                      </button>
                    );
                  })}
                  {visibleCandidates.length === 0 ? (
                    <div className="af-connect-node-menu__empty">没有匹配结果</div>
                  ) : null}
                </div>
              </div>
            );
          })() : null}

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
                      className={"af-composer-skills-button" + (selectedSkills.length > 0 ? " af-composer-skills-button--active" : "")}
                      disabled={composerRunning}
                      aria-haspopup="listbox"
                      aria-expanded={skillsOpen}
                      onClick={() => setSkillsOpen((v) => !v)}
                    >
                      <span className="material-symbols-outlined" aria-hidden>extension</span>
                      <span>{selectedSkills.length > 0 ? `Skills ${selectedSkills.length}` : "Skills"}</span>
                    </button>
                    {skillsOpen && !composerRunning
                      ? createPortal(
                          <div ref={skillsMenuRef} className="af-composer-skills-menu" role="listbox" aria-label="Skills" style={skillsMenuStyle}>
                            {skills.length === 0 ? (
                              <div className="af-composer-skills-empty">No skills found</div>
                            ) : (
                              <>
                                {skillCollectionGroups.groups.map((group) => {
                                  const keys = collectionSkillKeys(group, skills);
                                  const state = collectionSelectionState(group, selectedSkillSet, skills);
                                  const collapsed = collapsedSkillCollections.has(group.id);
                                  return (
                                    <div key={group.id} className={"af-composer-skill-group af-composer-skill-group--framed" + (collapsed ? " af-composer-skill-group--collapsed" : "")}>
                                      <div className="af-composer-skill-group-title af-composer-skill-group-title--selectable">
                                        <label className="af-composer-skill-group-check">
                                          <input
                                            type="checkbox"
                                            checked={state === "all"}
                                            disabled={keys.length === 0}
                                            onChange={(e) => {
                                              const checked = e.target.checked;
                                              setSelectedSkills((prev) => checked ? addSkillKeys(prev, keys) : removeSkillKeys(prev, keys));
                                            }}
                                          />
                                          <span className="af-composer-skill-group-title-main">
                                            <span>{group.name}</span>
                                            {group.builtin ? <em>built-in</em> : null}
                                            {state === "partial" ? <em>partial</em> : null}
                                          </span>
                                        </label>
                                        <button
                                          type="button"
                                          className="af-composer-skill-group-toggle"
                                          aria-label={collapsed ? `展开 ${group.name}` : `收起 ${group.name}`}
                                          onClick={() => {
                                            setCollapsedSkillCollections((prev) => {
                                              const next = new Set(prev);
                                              if (next.has(group.id)) next.delete(group.id);
                                              else next.add(group.id);
                                              return next;
                                            });
                                          }}
                                        >
                                          <span>{group.skills.length}</span>
                                          <span className="material-symbols-outlined" aria-hidden>{collapsed ? "expand_more" : "expand_less"}</span>
                                        </button>
                                      </div>
                                      {!collapsed ? <div className="af-composer-skill-group-items">
                                        {group.skills.map((skill) => (
                                          <label key={`${group.id}:${skill.key}`} className="af-composer-skill-option">
                                            <input
                                              type="checkbox"
                                              checked={selectedSkillSet.has(skill.key)}
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
                                      </div> : null}
                                    </div>
                                  );
                                })}
                                {skillCollectionGroups.ungrouped.length > 0 ? (
                                  <div className="af-composer-skill-group">
                                    <div className="af-composer-skill-group-title">
                                      <span>Ungrouped</span>
                                      <span>{skillCollectionGroups.ungrouped.length}</span>
                                    </div>
                                    {skillCollectionGroups.ungrouped.map((skill) => (
                                      <label key={`ungrouped:${skill.key}`} className="af-composer-skill-option">
                                        <input
                                          type="checkbox"
                                          checked={selectedSkillSet.has(skill.key)}
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
                                ) : null}
                              </>
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
        ) : nodePropDraft && selectedNode ? (
          <aside className="af-pipeline-drawer af-workspace-node-drawer" aria-label="Workspace Node Properties">
            <NodePropertiesPanel
              draft={nodePropDraft}
              setDraft={setNodePropDraft}
              definitionId={String(selectedNode.data?.definitionId || selectedNode.id)}
              systemPromptReadonly={String(selectedNode.data?.description || "")}
              modelLists={modelLists}
              disabled={false}
              onIdBlur={() => applyNodeProperties(true)}
              onClose={() => setSelectedNodeId("")}
              error={nodePropsError}
              ioSlots={{
                inputs: Array.isArray(nodePropDraft?.inputs) ? nodePropDraft.inputs : [],
                outputs: Array.isArray(nodePropDraft?.outputs) ? nodePropDraft.outputs : [],
              }}
            />
          </aside>
        ) : null}
        {quickAddOpen ? createPortal(
          <div className="af-workspace-quick-add-backdrop" onMouseDown={() => setQuickAddOpen(false)}>
            <div className="af-workspace-quick-add" role="dialog" aria-modal="true" aria-label="Add workspace node" onMouseDown={(event) => event.stopPropagation()}>
              <div className="af-workspace-quick-add__search">
                <span className="material-symbols-outlined" aria-hidden>search</span>
                <input
                  ref={quickAddInputRef}
                  value={quickAddSearch}
                  onChange={(event) => setQuickAddSearch(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setQuickAddOpen(false);
                    } else if (event.key === "ArrowDown") {
                      event.preventDefault();
                      setQuickAddActiveIndex((idx) => Math.min(quickAddItems.length - 1, idx + 1));
                    } else if (event.key === "ArrowUp") {
                      event.preventDefault();
                      setQuickAddActiveIndex((idx) => Math.max(0, idx - 1));
                    } else if (event.key === "Enter") {
                      event.preventDefault();
                      addQuickNode(quickAddItems[quickAddActiveIndex] || quickAddItems[0]);
                    }
                  }}
                  placeholder="搜索节点..."
                  aria-label="搜索节点"
                />
              </div>
              <div className="af-workspace-quick-add__list">
                {quickAddItems.length === 0 ? (
                  <div className="af-workspace-quick-add__empty">没有匹配的节点</div>
                ) : quickAddItems.map((node, index) => {
                  const cat = paletteCategory(node);
                  const label = paletteDisplayLabel(node);
                  const desc = paletteDescription(node);
                  return (
                    <button
                      key={node.id}
                      type="button"
                      className={"af-workspace-quick-add__item" + (index === quickAddActiveIndex ? " af-workspace-quick-add__item--active" : "")}
                      onMouseEnter={() => setQuickAddActiveIndex(index)}
                      onClick={() => addQuickNode(node)}
                    >
                      <span className="af-workspace-quick-add__icon material-symbols-outlined" aria-hidden>{paletteIcon(cat)}</span>
                      <span className="af-workspace-quick-add__main">
                        <span className="af-workspace-quick-add__label">{label}</span>
                        <span className="af-workspace-quick-add__meta">{node.id}</span>
                        {desc ? <span className="af-workspace-quick-add__desc">{desc}</span> : null}
                      </span>
                      <span className="af-workspace-quick-add__cat">{cat}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>,
          document.body,
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
