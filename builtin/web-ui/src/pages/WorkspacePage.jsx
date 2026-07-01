import {
  Background,
  Handle,
  MarkerType,
  NodeResizeControl,
  Position,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useUpdateNodeInternals,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ChartDisplayContent, MarkdownDisplayContent, TableDisplayContent } from "../displayRenderers.jsx";
import { buildCanvasClipboard, buildInstancesForYaml, pasteCanvasClipboard, VALID_ROLES } from "../flowFormat.js";
import { FLOW_NODE_TYPE, FlowNode } from "../FlowNode.jsx";
import { normalizeImages } from "../imageAttachments.js";
import { cloneNodeIoDraftSlots, filterValidEdges, mergeNodeWithPalette, revealConnectedSlots } from "../mergeFlowNodes.js";
import { KeyboardShortcutsModal } from "../KeyboardShortcutsModal.jsx";
import { NodeJumpPalette } from "../NodeJumpPalette.jsx";
import { NODE_INSTANCE_ID_RE, NodePropertiesPanel } from "../NodePropertiesPanel.jsx";
import { useCanvasHistory } from "../useCanvasHistory.js";
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
import { isEditableFocus, isQuestionMarkShortcut } from "../hotkeyUtils.js";

const STORAGE_FALLBACK_KEY = "af:workspace-graph:v2";
const PALETTE_ORDER = ["DISPLAY", "CONTROL", "TOOL", "PROVIDE", "AGENT"];
const HIDDEN_WORKSPACE_DEFS = new Set(["control_start", "control_end", "control_load_skills", "control_load_mcp"]);
const WORKSPACE_RUN_DEFINITION = {
  id: "workspace_run",
  displayName: "Run",
  label: "Run",
  description: "Run the downstream workspace subgraph connected from this node.",
  type: "control",
  inputs: [{ type: "node", name: "prev", default: "" }],
  outputs: [{ type: "node", name: "next", default: "" }],
};
const WORKSPACE_LOAD_SKILLS_DEFINITION = {
  id: "control_load_skills",
  displayName: "Load Skills",
  label: "Load Skills",
  description: "Load the currently selected Workspace skill collection for downstream agent nodes.",
  type: "control",
  inputs: [
    { type: "node", name: "prev", default: "" },
    { type: "text", name: "skillKeys", default: "", showOnNode: false },
  ],
  outputs: [
    { type: "node", name: "next", default: "" },
    { type: "text", name: "skillsContext", default: "", showOnNode: true },
  ],
};
const WORKSPACE_LOAD_MCP_DEFINITION = {
  id: "control_load_mcp",
  displayName: "Load MCP",
  label: "Load MCP",
  description: "Load selected Cursor MCP server tool manifests for downstream agent nodes.",
  type: "control",
  inputs: [
    { type: "node", name: "prev", default: "" },
    { type: "text", name: "serverNames", default: "", showOnNode: false },
  ],
  outputs: [
    { type: "node", name: "next", default: "" },
    { type: "text", name: "mcpContext", default: "", showOnNode: true },
  ],
};

const WORKSPACE_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
const DEFAULT_WORKSPACE_NODE_WIDTH = 320;
const MIN_WORKSPACE_NODE_WIDTH = 180;
const MAX_WORKSPACE_NODE_WIDTH = 960;
const MIN_WORKSPACE_NODE_HEIGHT = 96;
const MAX_WORKSPACE_NODE_HEIGHT = 900;
const DISPLAY_REF_PREFIX = "display-ref:";

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

function isWorkspaceImageFile(file) {
  if (!file) return false;
  const type = String(file.type || "");
  if (type && /^image\//i.test(type)) return true;
  const ext = String(file.name || "").toLowerCase().split(".").pop();
  return WORKSPACE_IMAGE_EXTENSIONS.has(ext);
}

function workspaceRawFileUrl(src, flowParams) {
  const text = String(src || "").trim();
  if (!text) return "";
  if (/^(?:https?:|data:|blob:|file:)/i.test(text) || text.startsWith("/")) return text;
  const q = flowParamsQuery(flowParams || {});
  q.set("path", text);
  return `/api/workspace/file/raw?${q.toString()}`;
}

function workspaceDownloadFileUrl(src, flowParams) {
  const text = String(src || "").trim();
  if (!text) return "";
  const q = flowParamsQuery(flowParams || {});
  q.set("path", text);
  q.set("download", "1");
  return `/api/workspace/file/raw?${q.toString()}`;
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

function hasEditableTextSelection(target) {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return Number(target.selectionStart ?? 0) !== Number(target.selectionEnd ?? 0);
  }
  if (target instanceof Element && target.closest('[contenteditable="true"]')) {
    const selection = window.getSelection?.();
    return Boolean(selection && !selection.isCollapsed);
  }
  return false;
}

function shouldUseCanvasCopyFromEditable(target) {
  if (!target || typeof target.closest !== "function") return false;
  return Boolean(target.closest(".af-flow-node__prompt-stack")) && !hasEditableTextSelection(target);
}

function isLowValueWorkspaceRunLog(text) {
  const line = String(text || "").trim();
  return (
    !line ||
    /^思考中/.test(line) ||
    /^生成回复中/.test(line) ||
    /^完成$/.test(line) ||
    /^事件:\s*(system|user)$/i.test(line) ||
    /^工具\s+\w+ToolCall\s+\((started|completed)\)$/i.test(line) ||
    /^Started\s+\S+/.test(line) ||
    /^Completed\s+\S+/.test(line) ||
    /^Run started:/.test(line) ||
    /^Run finished/.test(line) ||
    /^Run paused/.test(line) ||
    /^Workspace run paused/.test(line) ||
    /^Paused at/.test(line)
  );
}

function isLegacyWorkspaceRunLogText(text) {
  const line = String(text || "").trim();
  return (
    isLowValueWorkspaceRunLog(line) ||
    /^Run started:/.test(line) ||
    /^Run finished/.test(line) ||
    /^Run paused/.test(line) ||
    /^Workspace run paused/.test(line) ||
    /^Started\s+\S+/.test(line) ||
    /^Completed\s+\S+/.test(line)
  );
}

function workspaceRunActivityText(text) {
  const line = String(text || "").trim();
  if (!line) return "";
  if (/^思考中/.test(line)) return "模型正在思考";
  if (/^生成回复中/.test(line)) return "模型正在生成回复";
  if (/^Timing\s+(.+?):\s+(\d+)ms/i.test(line)) {
    const match = line.match(/^Timing\s+(.+?):\s+(\d+)ms/i);
    return `耗时：${match?.[1] || "step"} ${match?.[2] || "0"}ms`;
  }
  if (/^工具\s+(.+?)(?:\s+\((started|completed)\))?$/i.test(line)) {
    const match = line.match(/^工具\s+(.+?)(?:\s+\((started|completed)\))?$/i);
    const tool = String(match?.[1] || "tool").trim();
    const state = String(match?.[2] || "").toLowerCase();
    if (tool === "thinking") return "模型正在思考";
    const toolLabel = tool === "readToolCall"
      ? "读取文件/上下文"
      : tool === "grepToolCall"
        ? "搜索代码"
        : tool === "editToolCall"
          ? "编辑文件"
          : tool;
    return state === "completed" ? `完成：${toolLabel}` : `执行：${toolLabel}`;
  }
  if (/^\[stderr\]/.test(line)) return line;
  return "";
}

function extractThinkingDeltaFromRawTrace(event) {
  if (String(event?.type || "") !== "raw") return "";
  if (String(event?.eventType || "") !== "thinking") return "";
  const rawText = String(event?.text || "").trim();
  if (!rawText) return "";
  try {
    const parsed = JSON.parse(rawText);
    if (parsed?.type !== "thinking") return "";
    const subtype = String(parsed?.subtype || "");
    if (subtype && subtype !== "delta") return "";
    return String(parsed?.text || parsed?.delta || parsed?.thinking || "").trim();
  } catch {
    return "";
  }
}

function schemaTypeForDefinition(definitionId, def) {
  const id = String(definitionId || def?.id || "").toLowerCase();
  if (id.startsWith("control_")) return "control";
  if (id.startsWith("provide_")) return "provide";
  if (id.startsWith("tool_")) return "agent";
  return def?.type || "agent";
}

function marketplaceRefForDefinition(def) {
  const id = String(def?.marketplaceDefinitionId || def?.id || "").trim();
  return id.startsWith("marketplace:") ? id : "";
}

function runtimeDefinitionIdForPalette(def) {
  if (!def) return "";
  const baseDefinitionId = String(def.baseDefinitionId || "").trim();
  if (!baseDefinitionId) return String(def.id || "").trim();
  const runtime = def.runtime && typeof def.runtime === "object" ? def.runtime : {};
  const hasPackagedRuntime = Boolean(runtime.entry || runtime.command);
  if (hasPackagedRuntime && baseDefinitionId === "tool_nodejs") return String(def.id || "").trim();
  return baseDefinitionId;
}

function paletteCategory(node) {
  const id = String(runtimeDefinitionIdForPalette(node) || node?.id || "");
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
  if (ext === "html") return "web";
  if (["csv", "tsv"].includes(ext)) return "table";
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
    showOnNode: slot?.showOnNode != null
      ? slot.showOnNode !== false
      : Boolean(slot?.required) || String(slot?.type || "node").trim().toLowerCase() === "node",
  }));
}

function nodeHandleSignature(node) {
  const data = node?.data || {};
  const encodeSlots = (slots) => (Array.isArray(slots) ? slots : [])
    .map((slot, index) => {
      if (slot?.showOnNode === false) return "";
      return [index, String(slot?.type || ""), String(slot?.name || ""), slot?.required ? "1" : "0"].join(":");
    })
    .filter(Boolean)
    .join("|");
  return `${encodeSlots(data.inputs)}=>${encodeSlots(data.outputs)}`;
}

function workspaceNodeLayoutSignature(node) {
  const data = node?.data || {};
  const displaySize = data?.displaySize && typeof data.displaySize === "object" ? data.displaySize : {};
  const nodeSize = data?.nodeSize && typeof data.nodeSize === "object" ? data.nodeSize : {};
  return [
    nodeHandleSignature(node),
    Number(node?.width || 0) || "",
    Number(node?.height || 0) || "",
    Number(node?.measured?.width || 0) || "",
    Number(node?.measured?.height || 0) || "",
    Number(nodeSize.width || 0) || "",
    Number(nodeSize.height || 0) || "",
    Number(displaySize.width || 0) || "",
    Number(displaySize.height || 0) || "",
    data?.isExecuting ? "executing" : "",
    data?.nodeStatus || "",
    data?.runningRunNodeId || "",
  ].join("::");
}

function graphToFlow(graph, palette) {
  const rawInstances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  const instances = sanitizeWorkspaceRuntimeOutputs(rawInstances);
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
    const runtimeDefinitionId = runtimeDefinitionIdForPalette(def) || definitionId;
    const runtimeDef = palette.find((p) => p.id === runtimeDefinitionId) || def;
    const marketplaceRef = inst.marketplaceRef || marketplaceRefForDefinition(def);
    const pos = positions[id] && typeof positions[id].x === "number" && typeof positions[id].y === "number"
      ? positions[id]
      : { x: 320 + nodeIds.size * 20, y: 180 + nodeIds.size * 12 };
    const isDisplay = Boolean(displayKind(runtimeDefinitionId));
    const rawSize = sizes[id] && typeof sizes[id].width === "number" && typeof sizes[id].height === "number"
      ? { width: sizes[id].width, height: sizes[id].height }
      : null;
    const size = normalizeWorkspaceNodeSize(rawSize, { display: isDisplay });
    return {
      id,
      type: FLOW_NODE_TYPE,
      position: pos,
      ...(size ? { width: size.width, height: size.height } : {}),
      data: {
        label: inst.label || labelForDefinition(def) || labelForDefinition(runtimeDef) || id,
        definitionId: runtimeDefinitionId,
        ...(marketplaceRef ? { marketplaceRef } : {}),
        ...(def?.packageId ? { marketplacePackageId: def.packageId } : {}),
        ...(def?.version ? { marketplaceVersion: def.version } : {}),
        schemaType: schemaTypeForDefinition(runtimeDefinitionId, runtimeDef || def),
        role: inst.role || "normal",
        model: inst.model || undefined,
        body: inst.body || "",
        script: inst.script || "",
        ...(size ? { nodeSize: size } : {}),
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

function displayRefNodeId(sourceId) {
  return `${DISPLAY_REF_PREFIX}${sourceId}`;
}

function sourceIdFromDisplayRefId(nodeId) {
  const text = String(nodeId || "");
  return text.startsWith(DISPLAY_REF_PREFIX) ? text.slice(DISPLAY_REF_PREFIX.length) : text;
}

function normalizeCanvasViewport(raw) {
  if (!raw || typeof raw !== "object") return null;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const zoom = Number(raw.zoom);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom)) return null;
  return { x, y, zoom: Math.min(Math.max(zoom, 0.1), 4) };
}

function normalizeDisplayPageState(raw, workspaceNodes = []) {
  const sourceNodes = new Map((Array.isArray(workspaceNodes) ? workspaceNodes : [])
    .filter((node) => displayKind(node?.data?.definitionId))
    .map((node) => [node.id, node]));
  const rawIds = Array.isArray(raw?.nodeIds) ? raw.nodeIds : [];
  const nodeIds = [];
  const seen = new Set();
  for (const rawId of rawIds) {
    const id = String(rawId || "").trim();
    if (!id || seen.has(id) || !sourceNodes.has(id)) continue;
    seen.add(id);
    nodeIds.push(id);
  }
  const nodePositions = {};
  const positions = raw?.nodePositions && typeof raw.nodePositions === "object" ? raw.nodePositions : {};
  nodeIds.forEach((id, index) => {
    const pos = positions[id];
    nodePositions[id] = pos && typeof pos.x === "number" && typeof pos.y === "number"
      ? { x: pos.x, y: pos.y }
      : { x: 180 + index * 36, y: 120 + index * 28 };
  });
  const nodeSizes = {};
  const sizes = raw?.nodeSizes && typeof raw.nodeSizes === "object" ? raw.nodeSizes : {};
  nodeIds.forEach((id) => {
    const size = normalizeWorkspaceNodeSize(sizes[id], { display: true });
    if (size) nodeSizes[id] = size;
  });
  const viewport = normalizeCanvasViewport(raw?.viewport);
  return { nodeIds, nodePositions, nodeSizes, ...(viewport ? { viewport } : {}) };
}

function displayPageForGraph(displayPage, workspaceNodes = []) {
  return normalizeDisplayPageState(displayPage, workspaceNodes);
}

function clampWorkspaceFocusZoom(zoom) {
  const n = Number.isFinite(zoom) ? zoom : 1;
  return Math.min(Math.max(n, 0.75), 1);
}

async function copyTextToClipboard(text) {
  const value = String(text || "");
  if (!value) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* fall through to the legacy path */
  }
  try {
    const textarea = document.createElement("textarea");
    textarea.value = value;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(max, Math.max(min, Math.round(n)));
}

function normalizeWorkspaceNodeSize(size, { display = false } = {}) {
  if (!size || typeof size !== "object") return null;
  const rawWidth = Number(size.width);
  const rawHeight = Number(size.height);
  if (!Number.isFinite(rawWidth) || !Number.isFinite(rawHeight) || rawWidth <= 0 || rawHeight <= 0) return null;
  if (display) {
    return { width: Math.round(rawWidth), height: Math.round(rawHeight) };
  }
  return {
    width: clampNumber(rawWidth, MIN_WORKSPACE_NODE_WIDTH, MAX_WORKSPACE_NODE_WIDTH) || DEFAULT_WORKSPACE_NODE_WIDTH,
    height: clampNumber(rawHeight, MIN_WORKSPACE_NODE_HEIGHT, MAX_WORKSPACE_NODE_HEIGHT) || MIN_WORKSPACE_NODE_HEIGHT,
  };
}

function persistedWorkspaceNodeSize(node) {
  const isDisplay = Boolean(displayKind(node?.data?.definitionId));
  const width = Number(node?.data?.displaySize?.width || node?.data?.nodeSize?.width || node?.width || (isDisplay ? node?.measured?.width : 0) || 0);
  const height = Number(node?.data?.displaySize?.height || node?.data?.nodeSize?.height || node?.height || (isDisplay ? node?.measured?.height : 0) || 0);
  return normalizeWorkspaceNodeSize({ width, height }, { display: isDisplay });
}

function flowToGraph(nodes, edges, instances) {
  const graphInstances = sanitizeWorkspaceRuntimeOutputs(buildInstancesForYaml(nodes, instances || {}));
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
    const size = persistedWorkspaceNodeSize(node);
    if (size) nodeSizes[node.id] = size;
  }
  return { version: 1, instances: graphInstances, edges: graphEdges, ui: { nodePositions, nodeSizes } };
}

function sanitizeWorkspaceRuntimeOutputs(instances) {
  const next = {};
  for (const [id, instance] of Object.entries(instances || {})) {
    const definitionId = String(instance?.definitionId || id);
    const shouldKeepOutputValues = Boolean(displayKind(definitionId)) || definitionId.startsWith("provide_");
    if (shouldKeepOutputValues || !Array.isArray(instance?.output)) {
      next[id] = instance;
      continue;
    }
    next[id] = {
      ...instance,
      output: instance.output.map((slot) => ({
        ...slot,
        value: "",
        default: "",
      })),
    };
  }
  return next;
}

function displayKind(definitionId) {
  const id = String(definitionId || "");
  if (id === "display_markdown") return "markdown";
  if (id === "display_mermaid") return "mermaid";
  if (id === "display_ascii") return "ascii";
  if (id === "display_html") return "html";
  if (id === "display_image") return "image";
  if (id === "display_chart") return "chart";
  if (id === "display_table") return "table";
  return "";
}

function displayContent(data) {
  const slots = [...(data?.inputs || []), ...(data?.outputs || [])];
  const kind = displayKind(data?.definitionId);
  const primaryName = kind === "image" ? "src" : "content";
  const slotText = (slot) => String(slot?.value ?? slot?.default ?? "");
  const hasSlotText = (slot) => slotText(slot).trim();
  const contentSlot =
    slots.find((slot) => slot?.name === primaryName && hasSlotText(slot)) ||
    slots.find((slot) => slot?.name === "filePath" && hasSlotText(slot)) ||
    slots.find((slot) => slot?.type === "text" && hasSlotText(slot));
  return String(data?.body || (contentSlot ? slotText(contentSlot) : ""));
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

function safeDownloadFilename(name, extension) {
  const base = String(name || "html-render")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/^-+|-+$/g, "") || "html-render";
  const ext = String(extension || "png").replace(/^\.+/, "") || "png";
  return `${base}.${ext}`;
}

function triggerDownloadUrl(url, filename) {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  try {
    triggerDownloadUrl(url, filename);
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

function htmlSnapshotMarkup(content) {
  const raw = normalizeHtmlDisplayContent(content);
  const doc = new DOMParser().parseFromString(raw || "<body></body>", "text/html");
  const serializer = new XMLSerializer();
  const styles = Array.from(doc.querySelectorAll("style"))
    .map((node) => serializer.serializeToString(node))
    .join("\n");
  const bodyHtml = doc.body
    ? Array.from(doc.body.childNodes).map((node) => serializer.serializeToString(node)).join("")
    : raw;
  return `
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; min-height: 100%; background: transparent; }
      .af-html-snapshot-root { width: 100%; min-height: 100%; overflow: hidden; }
    </style>
    ${styles}
    <div xmlns="http://www.w3.org/1999/xhtml" class="af-html-snapshot-root">${bodyHtml}</div>
  `;
}

async function saveHtmlDisplayAsImage({ content, width, height, filename }) {
  const w = Math.max(1, Math.round(Number(width) || 960));
  const h = Math.max(1, Math.round(Number(height) || 640));
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <foreignObject width="100%" height="100%">
    <div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px;overflow:hidden;background:#ffffff;">
      ${htmlSnapshotMarkup(content)}
    </div>
  </foreignObject>
</svg>`;
  const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const svgUrl = URL.createObjectURL(svgBlob);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = svgUrl;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas is unavailable");
    ctx.drawImage(img, 0, 0, w, h);
    const pngBlob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!pngBlob) throw new Error("Could not encode PNG");
    downloadBlob(pngBlob, filename);
  } catch (error) {
    downloadBlob(svgBlob, filename.replace(/\.png$/i, ".svg"));
    throw error;
  } finally {
    URL.revokeObjectURL(svgUrl);
  }
}

function displayAltText(data) {
  const slots = [...(data?.inputs || []), ...(data?.outputs || [])];
  const altSlot = slots.find((slot) => slot?.name === "alt");
  return String(altSlot?.value || altSlot?.default || data?.label || "Image preview");
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
    const pointerId = event.pointerId;
    event.currentTarget.setPointerCapture?.(pointerId);
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
    <div className={`af-visible-scroll-frame ${className}`}>
      <div ref={scrollerRef} className={`af-visible-scroll-frame__scroller ${className}`} onScroll={updateScrollbar}>
        {children}
      </div>
      <div
        ref={scrollbarTrackRef}
        className={"af-visible-scrollbar" + (scrollbar.visible ? " af-visible-scrollbar--visible" : "")}
        onPointerDown={handleScrollbarPointerDown}
        aria-hidden="true"
      >
        <span style={{ height: `${scrollbar.height}%`, top: `${scrollbar.top}%` }} />
      </div>
    </div>
  );
}

function DisplayBody({ data, flowParams, htmlFrameRef, htmlFrameVersion = 0 }) {
  const kind = displayKind(data?.definitionId);
  if (!kind) return null;
  const rawContent = displayContent(data);
  const content = kind === "html" ? normalizeHtmlDisplayContent(rawContent) : rawContent;
  if (!content.trim()) return <VisibleScrollFrame className="af-work-display-empty">No display content</VisibleScrollFrame>;
  if (kind === "html") {
    return (
      <VisibleScrollFrame className="af-work-display-body af-work-display-body--html">
        <iframe
          key={htmlFrameVersion}
          ref={htmlFrameRef}
          className="af-work-display-html-frame"
          title={data?.label || "HTML preview"}
          sandbox="allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox"
          srcDoc={htmlDisplaySrcDoc(content)}
        />
      </VisibleScrollFrame>
    );
  }
  if (kind === "image") {
    const imageSrc = workspaceRawFileUrl(content, flowParams);
    return (
      <VisibleScrollFrame className="af-work-display-body af-work-display-body--image">
        <img className="af-work-display-image" src={imageSrc} alt={displayAltText(data)} loading="lazy" />
      </VisibleScrollFrame>
    );
  }
  if (kind === "markdown") {
    return (
      <VisibleScrollFrame className="af-work-display-body af-work-display-body--markdown">
        <MarkdownDisplayContent content={content} resolveSrc={(src) => workspaceRawFileUrl(src, flowParams)} />
      </VisibleScrollFrame>
    );
  }
  if (kind === "chart") {
    return <VisibleScrollFrame className="af-work-display-body af-work-display-body--chart"><ChartDisplayContent content={content} /></VisibleScrollFrame>;
  }
  if (kind === "table") {
    return <VisibleScrollFrame className="af-work-display-body af-work-display-body--table"><TableDisplayContent content={content} /></VisibleScrollFrame>;
  }
  if (kind === "mermaid") {
    return (
      <VisibleScrollFrame className="af-work-display-body">
        <MermaidPreview code={content} />
        <pre className="af-work-node__diagram af-work-node__diagram--mermaid">{content}</pre>
      </VisibleScrollFrame>
    );
  }
  return <VisibleScrollFrame className="af-work-display-body af-work-display-body--ascii"><pre className="af-work-node__diagram af-work-node__diagram--ascii">{content}</pre></VisibleScrollFrame>;
}

function DisplayPickerPreview({ node }) {
  const kind = displayKind(node?.data?.definitionId);
  const rawContent = displayContent(node?.data);
  const content = kind === "html" ? normalizeHtmlDisplayContent(rawContent) : rawContent;
  if (!content.trim()) return <div className="af-display-picker-preview__empty">No content</div>;
  if (kind === "html") {
    return <iframe title={node?.data?.label || node?.id} sandbox="allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox" srcDoc={htmlDisplaySrcDoc(content)} />;
  }
  if (kind === "image") {
    return <img src={workspaceRawFileUrl(content, node?.data?.flowParams)} alt={node?.data?.label || node?.id} loading="lazy" />;
  }
  if (kind === "markdown") {
    return (
      <div className="af-display-picker-preview__markdown">
        <MarkdownDisplayContent content={content} resolveSrc={(src) => workspaceRawFileUrl(src, node?.data?.flowParams)} />
      </div>
    );
  }
  if (kind === "chart") {
    return <ChartDisplayContent content={content} />;
  }
  if (kind === "table") {
    return <TableDisplayContent content={content} />;
  }
  if (kind === "mermaid") {
    return (
      <div className="af-display-picker-preview__diagram">
        <MermaidPreview code={content} />
        <pre>{content}</pre>
      </div>
    );
  }
  return <pre className="af-display-picker-preview__pre">{content}</pre>;
}

function MarkdownDisplayEditor({ value, onChange, onUploadImage, readOnly = false }) {
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const insertText = useCallback((text) => {
    const current = String(value || "");
    const textarea = textareaRef.current;
    const start = Number(textarea?.selectionStart ?? current.length);
    const end = Number(textarea?.selectionEnd ?? start);
    const prefix = current.slice(0, start);
    const suffix = current.slice(end);
    const spacerBefore = prefix && !prefix.endsWith("\n") ? "\n" : "";
    const spacerAfter = suffix && !suffix.startsWith("\n") ? "\n" : "";
    const next = `${prefix}${spacerBefore}${text}${spacerAfter}${suffix}`;
    onChange?.(next);
    window.requestAnimationFrame(() => {
      const pos = prefix.length + spacerBefore.length + text.length;
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(pos, pos);
    });
  }, [onChange, value]);
  const uploadAndInsert = useCallback(async (file) => {
    if (readOnly) return;
    if (!file || uploading) return;
    setUploading(true);
    try {
      const path = await onUploadImage?.(file);
      const imagePath = String(path || "").trim();
      if (imagePath) {
        const alt = String(file.name || "image").replace(/\.[^.]+$/g, "").trim() || "image";
        insertText(`![${alt}](${imagePath})`);
      }
    } finally {
      setUploading(false);
    }
  }, [insertText, onUploadImage, readOnly, uploading]);
  return (
    <div
      className="af-work-display-editor nodrag nopan"
      onClick={(event) => event.stopPropagation()}
      onDragOver={(event) => {
        const hasImage = Array.from(event.dataTransfer?.items || []).some((item) => String(item?.type || "").startsWith("image/"));
        if (!hasImage) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(event) => {
        const file = Array.from(event.dataTransfer?.files || []).find(isWorkspaceImageFile);
        if (!file) return;
        event.preventDefault();
        uploadAndInsert(file);
      }}
    >
      <div className="af-work-display-editor__toolbar">
        <button
          type="button"
          className="af-work-display-card__action"
          disabled={uploading || readOnly}
          onClick={() => fileInputRef.current?.click()}
          aria-label="上传图片"
          title="上传图片"
        >
          <span className="material-symbols-outlined">{uploading ? "hourglass_top" : "add_photo_alternate"}</span>
        </button>
        <input
          ref={fileInputRef}
          className="af-hidden-file-input"
          type="file"
          accept="image/*"
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (file) uploadAndInsert(file);
          }}
        />
      </div>
      <textarea
        ref={textareaRef}
        className="af-work-display-editor__textarea"
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") event.stopPropagation();
        }}
        placeholder="输入 Markdown 内容"
        spellCheck={false}
        readOnly={readOnly}
      />
    </div>
  );
}

function WorkspaceNodeChat({ nodeId, data }) {
  const active = data?.nodeChatActive;
  const selected = Boolean(data?.selected);
  const chat = data?.nodeChat || {};
  const messages = Array.isArray(chat.messages) ? chat.messages : [];
  const draft = String(chat.draft || "");
  const [localDraft, setLocalDraft] = useState(draft);
  const composingDraftRef = useRef(false);
  const candidate = String(chat.candidateContent || "");
  const running = Boolean(chat.running);
  const readOnly = Boolean(data?.readOnly);
  const error = String(chat.error || "");

  useEffect(() => {
    if (!composingDraftRef.current) setLocalDraft(draft);
  }, [draft]);

  if (!active && !selected) return null;

  if (!active) {
    return (
      <button
        type="button"
        className="af-work-node-chat-anchor nodrag nopan"
        onClick={(event) => {
          event.stopPropagation();
          data?.onToggleNodeChat?.(nodeId);
        }}
        title="微调这个节点"
        aria-label="微调这个节点"
      >
        <span className="material-symbols-outlined af-work-node-chat-anchor__plus" aria-hidden>add</span>
        <span className="af-work-node-chat-anchor__label">继续微调这个展示</span>
        <span className="material-symbols-outlined af-work-node-chat-anchor__expand" aria-hidden>open_in_full</span>
      </button>
    );
  }

  return (
    <div className="af-work-node-chat nodrag nopan" onClick={(event) => event.stopPropagation()}>
      <div className="af-work-node-chat__head">
        <div>
          <strong>继续微调</strong>
          <span>{data?.label || nodeId}</span>
        </div>
        <button type="button" onClick={() => data?.onCloseNodeChat?.()} aria-label="关闭节点微调">
          <span className="material-symbols-outlined" aria-hidden>close</span>
        </button>
      </div>
      {(messages.length > 0 || running || error || candidate.trim()) ? (
        <div className="af-work-node-chat__messages">
          {messages.slice(-4).map((msg, index) => (
            <div key={`${msg.at || index}-${index}`} className={`af-work-node-chat__msg af-work-node-chat__msg--${msg.role === "assistant" ? "assistant" : "user"}`}>
              <span>{msg.role === "assistant" ? "AI" : "你"}</span>
              <p>{msg.text}</p>
            </div>
          ))}
          {running ? <div className="af-work-node-chat__pending">生成中...</div> : null}
          {error ? <div className="af-work-node-chat__error">{error}</div> : null}
        </div>
      ) : null}
      <div className="af-work-node-chat__composer">
        <button type="button" className="af-work-node-chat__add" disabled={running || readOnly} aria-label="添加上下文">
          <span className="material-symbols-outlined" aria-hidden>add</span>
        </button>
        <textarea
          className="af-work-node-chat__input"
          rows={2}
          value={localDraft}
          disabled={running || readOnly}
          placeholder="描述你想怎么调整这个展示"
          onCompositionStart={() => {
            composingDraftRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingDraftRef.current = false;
            const next = event.currentTarget.value;
            setLocalDraft(next);
            data?.onUpdateNodeChatDraft?.(nodeId, next);
          }}
          onChange={(event) => {
            const next = event.target.value;
            setLocalDraft(next);
            if (!composingDraftRef.current) data?.onUpdateNodeChatDraft?.(nodeId, next);
          }}
          onKeyDown={(event) => {
            if (event.isComposing || event.nativeEvent?.isComposing || event.keyCode === 229) return;
            if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              data?.onSendNodeChat?.(nodeId, localDraft);
            }
          }}
        />
        <button
          type="button"
          className="af-work-node-chat__send"
          disabled={running || readOnly || !localDraft.trim()}
          onClick={() => data?.onSendNodeChat?.(nodeId, localDraft)}
          aria-label="发送"
        >
          <span className="material-symbols-outlined" aria-hidden>arrow_upward</span>
        </button>
      </div>
      <div className="af-work-node-chat__actions">
        <button type="button" disabled={running || readOnly || !candidate.trim()} onClick={() => data?.onApplyNodeChatCandidate?.(nodeId, "replace")}>
          替换当前内容
        </button>
        <button type="button" disabled={running || readOnly || !candidate.trim()} onClick={() => data?.onApplyNodeChatCandidate?.(nodeId, "append")}>
          追加
        </button>
      </div>
    </div>
  );
}

function displayFileExtension(kind) {
  if (kind === "mermaid") return "mmd";
  if (kind === "ascii") return "txt";
  if (kind === "html") return "html";
  if (kind === "image") return "txt";
  if (kind === "chart") return "json";
  if (kind === "table") return "json";
  return "md";
}

function displayFileStem(value) {
  return String(value || "display")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "display";
}

function suggestDisplayFilePath(id, data) {
  const kind = displayKind(data?.definitionId) || "markdown";
  const stem = displayFileStem(data?.label || id || kind);
  return `outputs/${stem}.${displayFileExtension(kind)}`;
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
  const htmlFrameRef = useRef(null);
  const [htmlFrameVersion, setHtmlFrameVersion] = useState(0);
  const [savingHtmlImage, setSavingHtmlImage] = useState(false);
  const [resizingDisplay, setResizingDisplay] = useState(false);
  const [markdownEditing, setMarkdownEditing] = useState(false);
  const [markdownDraft, setMarkdownDraft] = useState("");
  const [imageDragActive, setImageDragActive] = useState(false);
  const imageUploadInputRef = useRef(null);
  const markdownContent = kind === "markdown" ? displayContent(data) : "";
  const readOnly = Boolean(data?.readOnly);
  const presentationMode = Boolean(data?.displayPageMode);
  useEffect(() => {
    if (!resizingDisplay) return undefined;
    const stop = () => setResizingDisplay(false);
    window.addEventListener("pointerup", stop, true);
    window.addEventListener("pointercancel", stop, true);
    window.addEventListener("mouseup", stop, true);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("pointerup", stop, true);
      window.removeEventListener("pointercancel", stop, true);
      window.removeEventListener("mouseup", stop, true);
      window.removeEventListener("blur", stop);
    };
  }, [resizingDisplay]);
  useEffect(() => {
    if (!markdownEditing) setMarkdownDraft(String(markdownContent || ""));
  }, [markdownContent, markdownEditing]);
  const title = data?.label || (kind === "mermaid" ? "Mermaid" : kind === "ascii" ? "ASCII" : kind === "html" ? "HTML" : kind === "image" ? "Image" : kind === "chart" ? "Chart" : kind === "table" ? "Table" : "Markdown");
  const displaySize = data?.displaySize && Number(data.displaySize.width) > 0 && Number(data.displaySize.height) > 0
    ? { width: Number(data.displaySize.width), height: Number(data.displaySize.height) }
    : null;
  const saveHtmlImage = useCallback(async () => {
    if (kind !== "html" || savingHtmlImage) return;
    const content = normalizeHtmlDisplayContent(displayContent(data));
    if (!content.trim()) return;
    const rect = htmlFrameRef.current?.getBoundingClientRect?.();
    const width = Math.round(rect?.width || Math.max(320, Number(displaySize?.width || 960) - 2));
    const height = Math.round(rect?.height || Math.max(180, Number(displaySize?.height || 640) - 46));
    setSavingHtmlImage(true);
    try {
      await saveHtmlDisplayAsImage({
        content,
        width,
        height,
        filename: safeDownloadFilename(data?.label || id || "html-render", "png"),
      });
    } catch (error) {
      console.warn("Failed to save HTML display as PNG; downloaded SVG fallback.", error);
    } finally {
      setSavingHtmlImage(false);
    }
  }, [data, displaySize?.height, displaySize?.width, id, kind, savingHtmlImage]);
  const uploadImageFile = useCallback((file) => {
    if (readOnly) return;
    if (!file || kind !== "image") return;
    data?.onUploadImageToDisplayNode?.(id, file);
  }, [data, id, kind, readOnly]);
  const handleImageDragOver = useCallback((event) => {
    if (readOnly) return;
    if (kind !== "image") return;
    const files = Array.from(event.dataTransfer?.files || []);
    const hasImageFile = files.some(isWorkspaceImageFile) || Array.from(event.dataTransfer?.items || []).some((item) => String(item?.type || "").startsWith("image/"));
    if (!hasImageFile) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
    setImageDragActive(true);
  }, [kind, readOnly]);
  const handleImageDragLeave = useCallback((event) => {
    if (kind !== "image") return;
    if (event.currentTarget.contains(event.relatedTarget)) return;
    setImageDragActive(false);
  }, [kind]);
  const handleImageDrop = useCallback((event) => {
    if (kind !== "image") return;
    const file = Array.from(event.dataTransfer?.files || []).find(isWorkspaceImageFile);
    if (!file) return;
    event.preventDefault();
    event.stopPropagation();
    setImageDragActive(false);
    uploadImageFile(file);
  }, [kind, uploadImageFile]);
  return (
    <div
      className={
        "af-work-display-card" +
        (displaySize ? " af-work-display-card--sized" : "") +
        (selected ? " af-work-display-card--selected" : "") +
        (resizingDisplay ? " af-work-display-card--resizing" : "") +
        (imageDragActive ? " af-work-display-card--image-drop" : "") +
        (presentationMode ? " af-work-display-card--presentation" : "") +
        (data?.isExecuting ? " af-work-display-card--executing" : "") +
        (data?.nodeStatus === "success" ? " af-work-display-card--done" : "") +
        (data?.nodeStatus === "failed" ? " af-work-display-card--failed" : "")
      }
      style={displaySize ? { width: displaySize.width, height: displaySize.height } : undefined}
      onDragOver={handleImageDragOver}
      onDragLeave={handleImageDragLeave}
      onDrop={handleImageDrop}
    >
      <NodeResizeControl
        className="af-work-display-resize nodrag"
        position="bottom-right"
        minWidth={320}
        minHeight={180}
        onResizeStart={() => setResizingDisplay(true)}
        onResizeEnd={() => setResizingDisplay(false)}
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
          <span className="material-symbols-outlined">{displayIcon(kind)}</span>
          <strong>{title}</strong>
          <span>{data?.definitionId || "display"}</span>
        </div>
        {kind === "html" ? (
          <div className="af-work-display-card__html-controls nodrag" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              className="af-work-display-card__action"
              onClick={() => {
                try {
                  htmlFrameRef.current?.contentWindow?.history?.back?.();
                } catch {
                  /* sandboxed iframe history may be inaccessible */
                }
              }}
              aria-label="后退"
              title="后退"
            >
              <span className="material-symbols-outlined">arrow_back</span>
            </button>
            <button
              type="button"
              className="af-work-display-card__action"
              onClick={() => {
                try {
                  htmlFrameRef.current?.contentWindow?.history?.forward?.();
                } catch {
                  /* sandboxed iframe history may be inaccessible */
                }
              }}
              aria-label="前进"
              title="前进"
            >
              <span className="material-symbols-outlined">arrow_forward</span>
            </button>
            <button
              type="button"
              className="af-work-display-card__action"
              onClick={() => setHtmlFrameVersion((value) => value + 1)}
              aria-label="刷新"
              title="刷新"
            >
              <span className="material-symbols-outlined">refresh</span>
            </button>
            <button
              type="button"
              className="af-work-display-card__action"
              disabled={savingHtmlImage}
              onClick={saveHtmlImage}
              aria-label="截图另存为图片"
              title="截图另存为图片"
            >
              <span className="material-symbols-outlined">{savingHtmlImage ? "hourglass_empty" : "photo_camera"}</span>
            </button>
          </div>
        ) : null}
        {kind === "markdown" ? (
          markdownEditing ? (
            <div className="af-work-display-card__html-controls nodrag" onClick={(event) => event.stopPropagation()}>
              <button
                type="button"
                className="af-work-display-card__action"
                disabled={readOnly}
                onClick={() => {
                  data?.onSetDisplayNodeContent?.(id, markdownDraft, "replace", {
                    logChat: false,
                    statusMessage: "已更新 Markdown 内容",
                  });
                  setMarkdownEditing(false);
                }}
                aria-label="保存并预览"
                title="保存并预览"
              >
                <span className="material-symbols-outlined">done</span>
              </button>
              <button
                type="button"
                className="af-work-display-card__action"
                onClick={() => {
                  setMarkdownDraft(String(markdownContent || ""));
                  setMarkdownEditing(false);
                }}
                aria-label="取消编辑"
                title="取消编辑"
              >
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="af-work-display-card__action nodrag"
              disabled={readOnly}
              onClick={(event) => {
                event.stopPropagation();
                setMarkdownDraft(String(markdownContent || ""));
                setMarkdownEditing(true);
              }}
              aria-label="编辑 Markdown"
              title="编辑 Markdown"
            >
              <span className="material-symbols-outlined">edit</span>
            </button>
          )
        ) : null}
        {kind === "image" ? (
          <>
            <input
              ref={imageUploadInputRef}
              className="af-hidden-file-input"
              type="file"
              accept="image/*"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) uploadImageFile(file);
              }}
            />
            <button
              type="button"
              className="af-work-display-card__action nodrag"
              disabled={readOnly}
              onClick={(event) => {
                event.stopPropagation();
                imageUploadInputRef.current?.click();
              }}
              aria-label="上传图片"
              title="上传图片"
            >
              <span className="material-symbols-outlined">upload</span>
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="af-work-display-card__action nodrag"
          disabled={readOnly}
          onClick={() => data?.onSaveDisplayNodeToFile?.(id, data)}
          aria-label="另存为文件"
          title="另存为文件"
        >
          <span className="material-symbols-outlined">save</span>
        </button>
        <button type="button" className="af-work-display-card__close nodrag" disabled={readOnly} onClick={() => deleteNode?.(id)} aria-label="删除节点">
          <span className="material-symbols-outlined">close</span>
        </button>
      </div>
      {kind === "markdown" && markdownEditing ? (
        <MarkdownDisplayEditor value={markdownDraft} onChange={setMarkdownDraft} onUploadImage={data?.onUploadWorkspaceImage} readOnly={readOnly} />
      ) : (
        <DisplayBody data={data} flowParams={data?.flowParams} htmlFrameRef={htmlFrameRef} htmlFrameVersion={htmlFrameVersion} />
      )}
      <WorkspaceNodeChat nodeId={id} data={data} />
    </div>
  );
}

function WorkspaceRunNode({ id, data, selected, deleteNode }) {
  const inputs = Array.isArray(data?.inputs) ? data.inputs : [];
  const outputs = Array.isArray(data?.outputs) ? data.outputs : [];
  const running = data?.runningRunNodeId === id;
  const stopped = data?.nodeStatus === "stopped";
  const readOnly = Boolean(data?.readOnly);
  return (
    <div
      className={
        "af-work-run-card" +
        (selected ? " af-work-run-card--selected" : "") +
        (running ? " af-work-run-card--running" : "") +
        (data?.isExecuting ? " af-work-run-card--executing" : "") +
        (data?.nodeStatus === "success" ? " af-work-run-card--done" : "") +
        (data?.nodeStatus === "failed" ? " af-work-run-card--failed" : "") +
        (stopped ? " af-work-run-card--stopped" : "")
      }
    >
      {inputs.map((slot, idx) => {
        if (slot.showOnNode === false) return null;
        const top = `${2.25 + idx * 1.75}rem`;
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
        <button type="button" className="af-work-display-card__close nodrag" disabled={readOnly} onClick={() => deleteNode?.(id)} aria-label="删除节点">
          <span className="material-symbols-outlined">close</span>
        </button>
      </div>
      <button
        type="button"
        className={"af-work-run-card__button nodrag" + (running ? " af-work-run-card__button--stop" : "")}
        disabled={readOnly}
        onClick={(event) => {
          event.stopPropagation();
          if (running) data?.onStopWorkspaceNode?.(id);
          else data?.onRunWorkspaceNode?.(id);
        }}
      >
        <span className="material-symbols-outlined">{running ? "stop_circle" : "play_arrow"}</span>
        <span>{running ? "Stop" : "Run line"}</span>
      </button>
    </div>
  );
}

function WorkspaceFlowNode(props) {
  const { setEdges, setNodes } = useReactFlow();
  const syncNodePropDraft = props.data?.onSyncNodePropDraft;
  const readOnly = Boolean(props.data?.readOnly);
  const [resizingFlowNode, setResizingFlowNode] = useState(false);
  const nodeSize = props.data?.nodeSize && Number(props.data.nodeSize.width) > 0 && Number(props.data.nodeSize.height) > 0
    ? { width: Number(props.data.nodeSize.width), height: Number(props.data.nodeSize.height) }
    : null;
  const deleteNode = useCallback((nodeId) => {
    if (readOnly) return;
    setNodes((list) => list.filter((node) => node.id !== nodeId));
    setEdges((list) => list.filter((edge) => edge.source !== nodeId && edge.target !== nodeId));
  }, [readOnly, setEdges, setNodes]);
  const onModelChange = useCallback((nodeId, model) => {
    if (readOnly) return;
    setNodes((list) => list.map((node) => node.id === nodeId ? { ...node, data: { ...node.data, model } } : node));
    syncNodePropDraft?.(nodeId, { model });
  }, [readOnly, setNodes, syncNodePropDraft]);
  const onProvideValueChange = useCallback((nodeId, value) => {
    if (readOnly) return;
    setNodes((list) => list.map((node) => {
      if (node.id !== nodeId) return node;
      const outputs = Array.isArray(node.data?.outputs) && node.data.outputs.length
        ? node.data.outputs.map((slot, index) => index === 0 ? { ...slot, default: value, value } : slot)
        : [{ type: "bool", name: "value", default: value, value }];
      return { ...node, data: { ...node.data, body: "", outputs } };
    }));
    syncNodePropDraft?.(nodeId, (draft) => {
      const outputs = Array.isArray(draft?.outputs) && draft.outputs.length
        ? draft.outputs.map((slot, index) => index === 0 ? { ...slot, default: value, value } : slot)
        : [{ type: "bool", name: "value", default: value, value }];
      return { body: "", outputs };
    });
  }, [readOnly, setNodes, syncNodePropDraft]);
  const onNodeBodyChange = useCallback((nodeId, body) => {
    if (readOnly) return;
    setNodes((list) => list.map((node) => (
      node.id === nodeId ? { ...node, data: { ...node.data, body } } : node
    )));
    syncNodePropDraft?.(nodeId, { body });
  }, [readOnly, setNodes, syncNodePropDraft]);
  const onNodeImagesChange = useCallback((nodeId, images) => {
    if (readOnly) return;
    const normalizedImages = normalizeImages(images);
    setNodes((list) => list.map((node) => (
      node.id === nodeId ? { ...node, data: { ...node.data, images: normalizedImages } } : node
    )));
    syncNodePropDraft?.(nodeId, { images: normalizedImages });
  }, [readOnly, setNodes, syncNodePropDraft]);
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
  if (props.data?.definitionId === "control_load_mcp") {
    return (
      <WorkspaceLoadMcpNode
        {...props}
        deleteNode={deleteNode}
        servers={props.data?.mcpServers}
        onChangeMcpNames={props.data?.onChangeLoadMcpNames}
      />
    );
  }
  return (
    <div
      className={
        "af-work-flow-node" +
        (props.selected ? " af-work-flow-node--selected" : "") +
        (resizingFlowNode ? " af-work-flow-node--resizing" : "")
      }
      style={nodeSize ? { width: nodeSize.width, height: nodeSize.height } : undefined}
    >
      {!readOnly ? (
        <NodeResizeControl
          className="af-work-display-resize af-work-flow-resize nodrag"
          position="bottom-right"
          minWidth={MIN_WORKSPACE_NODE_WIDTH}
          minHeight={MIN_WORKSPACE_NODE_HEIGHT}
          maxWidth={MAX_WORKSPACE_NODE_WIDTH}
          maxHeight={MAX_WORKSPACE_NODE_HEIGHT}
          onResizeStart={() => setResizingFlowNode(true)}
          onResizeEnd={() => setResizingFlowNode(false)}
        >
          <span className="material-symbols-outlined" aria-hidden>open_in_full</span>
        </NodeResizeControl>
      ) : null}
      <FlowNode
        {...props}
        deleteNode={deleteNode}
        modelLists={props.data?.modelLists}
        onModelChange={onModelChange}
        onProvideValueChange={onProvideValueChange}
        onNodeBodyChange={onNodeBodyChange}
        onNodeImagesChange={onNodeImagesChange}
      />
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

function collectDirectoryPaths(files, out = []) {
  for (const item of files || []) {
    if (item.type !== "directory") continue;
    out.push(item.path);
    if (Array.isArray(item.children)) collectDirectoryPaths(item.children, out);
  }
  return out;
}

function parentDirectoryPaths(relPath) {
  const parts = String(relPath || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  const dirs = [];
  for (let i = 1; i < parts.length; i++) {
    dirs.push(parts.slice(0, i).join("/"));
  }
  return dirs;
}

function sortWorkspaceFileItems(items) {
  return [...(items || [])].sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return String(a.name || "").localeCompare(String(b.name || ""));
  });
}

function upsertWorkspaceFile(items, relPath, size = 0) {
  const parts = String(relPath || "")
    .replace(/\\/g, "/")
    .split("/")
    .filter(Boolean);
  if (parts.length === 0) return items;
  const visit = (list, index, prefix) => {
    const name = parts[index];
    const itemPath = prefix ? `${prefix}/${name}` : name;
    const isLeaf = index === parts.length - 1;
    let found = false;
    const next = (Array.isArray(list) ? list : []).map((item) => {
      if (item.name !== name) return item;
      found = true;
      if (isLeaf) {
        return {
          ...item,
          type: "file",
          name,
          path: itemPath,
          icon: iconForFile(name),
          size,
        };
      }
      return {
        ...item,
        type: "directory",
        name,
        path: itemPath,
        icon: iconForFile(name, true),
        children: visit(item.children || [], index + 1, itemPath),
      };
    });
    if (!found) {
      next.push(isLeaf
        ? { type: "file", name, path: itemPath, icon: iconForFile(name), size }
        : { type: "directory", name, path: itemPath, icon: iconForFile(name, true), children: visit([], index + 1, itemPath) });
    }
    return sortWorkspaceFileItems(next);
  };
  return visit(items || [], 0, "");
}

function FileTree({ items, flowParams, onOpen, collapsedDirs, onToggleDir, onCreateFile, onCreateFolder, onDelete, onFileDragStart }) {
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
              {!isDir ? (
                <a
                  className="af-work-file-action"
                  href={workspaceDownloadFileUrl(item.path, flowParams)}
                  download={item.name}
                  onClick={(event) => event.stopPropagation()}
                  title="下载"
                  aria-label={`下载 ${item.name}`}
                >
                  <span className="material-symbols-outlined">download</span>
                </a>
              ) : null}
              <button type="button" className="af-work-file-action af-work-file-action--danger" onClick={() => onDelete?.(item)} title="删除" aria-label={`删除 ${item.name}`}>
                <span className="material-symbols-outlined">delete</span>
              </button>
            </div>
            {isDir && !collapsed && item.children?.length ? (
              <FileTree items={item.children} flowParams={flowParams} onOpen={onOpen} collapsedDirs={collapsedDirs} onToggleDir={onToggleDir} onCreateFile={onCreateFile} onCreateFolder={onCreateFolder} onDelete={onDelete} onFileDragStart={onFileDragStart} />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function WorkspaceComposerThread({ messages, running, showRunningIndicator = true }) {
  const hasBody = messages.length > 0;
  return (
    <div className="af-composer-ai-stack af-composer-ai-stack--in-panel af-composer-thread-stack">
      {messages.map((msg, idx) => {
        const role = msg.kind === "run-log" || msg.kind === "run-summary" || msg.kind === "activity" || msg.kind === "prompt" || msg.kind === "raw" || msg.kind === "thinking" || msg.kind === "result" || msg.kind === "assistant"
          ? "reply"
          : msg.role === "user"
            ? "user-msg"
            : msg.error
              ? "error"
              : "reply";
        const label = msg.kind === "run-summary"
          ? "Steps"
          : msg.kind === "run-log"
            ? "Run"
            : msg.kind === "activity"
              ? "Activity"
              : msg.kind === "prompt"
                ? "Prompt"
                : msg.kind === "raw"
                  ? "Raw Trace"
                  : msg.kind === "thinking"
                    ? "Thinking"
                    : msg.kind === "result"
                      ? "Result"
                      : msg.kind === "assistant"
                        ? "Response"
                        : msg.role === "user"
                          ? "You"
                          : msg.error
                            ? "Error"
                            : "Reply";
        return (
          <section
            key={`${idx}-${msg.role}-${String(msg.text || "").slice(0, 24)}`}
            className={`af-composer-ai-block af-composer-ai-block--${role}${msg.kind ? ` af-composer-ai-block--kind-${msg.kind}` : ""}`}
          >
            <div className="af-composer-ai-block-label">{label}</div>
            <div className="af-composer-ai-block-body">{msg.text}</div>
          </section>
        );
      })}
      {showRunningIndicator && running && !hasBody ? (
        <section className="af-composer-ai-block af-composer-ai-block--reply af-composer-ai-block--pending">
          <div className="af-composer-ai-block-label">Reply</div>
          <div className="af-composer-ai-block-body">Waiting...</div>
        </section>
      ) : null}
      {showRunningIndicator && running && hasBody ? (
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
  const inputs = Array.isArray(data?.inputs) ? data.inputs : [];
  const slot = inputs.find((item) => item?.name === "skillsContext" || item?.name === "skillKeys" || item?.type === "text");
  return selectedSkillKeysFromValue(slot?.default || slot?.value || "");
}

function serializeSkillKeys(keys) {
  return JSON.stringify(Array.from(new Set((keys || []).map(String).filter(Boolean))));
}

function selectedMcpNamesFromNodeData(data) {
  const bodyNames = selectedSkillKeysFromValue(data?.body || "");
  if (bodyNames.length > 0) return bodyNames;
  const inputs = Array.isArray(data?.inputs) ? data.inputs : [];
  const slot = inputs.find((item) => item?.name === "mcpContext" || item?.name === "serverNames" || item?.type === "text");
  return selectedSkillKeysFromValue(slot?.default || slot?.value || "");
}

function serializeMcpNames(names) {
  return JSON.stringify(Array.from(new Set((names || []).map(String).filter(Boolean))));
}

function nodeToPropDraft(node) {
  if (!node) return null;
  const { inputs, outputs } = cloneNodeIoDraftSlots(node);
  return {
    id: node.id,
    newId: node.id,
    label: String(node.data?.label ?? node.id),
    role: String(node.data?.role ?? "normal"),
    model: String(node.data?.model ?? ""),
    body: String(node.data?.body ?? ""),
    images: normalizeImages(node.data?.images),
    script: String(node.data?.script ?? ""),
    inputs,
    outputs,
  };
}

function normalizeWorkspacePropIoSlots(slots) {
  return (Array.isArray(slots) ? slots : []).map((slot) => ({
    type: String(slot?.type ?? "node").trim() || "node",
    name: String(slot?.name ?? ""),
    default: String(slot?.default ?? ""),
    required: Boolean(slot?.required),
    showOnNode: slot?.showOnNode != null
      ? slot.showOnNode !== false
      : Boolean(slot?.required) || String(slot?.type ?? "node").trim().toLowerCase() === "node",
  }));
}

function workspaceNodeDataFromPropDraft(selectedNode, draft, nextId) {
  const defId = String(selectedNode?.data?.definitionId ?? nextId);
  const isProvideDef = defId.startsWith("provide_");
  const roleStr = String(draft?.role || "").trim();
  const role = VALID_ROLES.includes(roleStr) ? roleStr : "normal";
  const modelTrim = String(draft?.model || "").trim();
  const nextData = {
    ...selectedNode.data,
    label: String(draft?.label || "").trim() || nextId,
    role,
    model: modelTrim === "" || modelTrim === "default" ? undefined : modelTrim,
    body: isProvideDef ? "" : String(draft?.body ?? ""),
    images: isProvideDef ? [] : normalizeImages(draft?.images),
    inputs: normalizeWorkspacePropIoSlots(draft?.inputs),
    outputs: isProvideDef && Array.isArray(selectedNode.data?.outputs)
      ? selectedNode.data.outputs
      : normalizeWorkspacePropIoSlots(draft?.outputs),
  };
  const scriptTrim = String(draft?.script ?? "").trim();
  if (defId === "tool_nodejs" || scriptTrim !== "") nextData.script = String(draft?.script ?? "");
  else delete nextData.script;
  return nextData;
}

function workspaceApplyNodePropDraftToCanvasState({ nodes, edges, instances, selectedNode, draft, allowRename = false }) {
  if (!draft || !selectedNode) return { ok: false, error: "" };
  const oldId = selectedNode.id;
  const trimmedNew = String(draft.newId || "").trim();
  const nextId = allowRename ? trimmedNew : oldId;
  if (allowRename) {
    if (!NODE_INSTANCE_ID_RE.test(nextId)) return { ok: false, error: "Invalid instance id" };
    if (nodes.some((node) => node.id === nextId && node.id !== oldId)) return { ok: false, error: "Duplicate instance id" };
  }
  const nextData = workspaceNodeDataFromPropDraft(selectedNode, draft, nextId);
  const prevData = selectedNode.data || {};
  const changed =
    nextId !== oldId ||
    prevData.label !== nextData.label ||
    prevData.role !== nextData.role ||
    prevData.model !== nextData.model ||
    prevData.body !== nextData.body ||
    JSON.stringify(normalizeImages(prevData.images)) !== JSON.stringify(nextData.images) ||
    (prevData.script ?? undefined) !== (nextData.script ?? undefined) ||
    JSON.stringify(prevData.inputs || []) !== JSON.stringify(nextData.inputs || []) ||
    JSON.stringify(prevData.outputs || []) !== JSON.stringify(nextData.outputs || []);
  if (!changed) return { ok: true, changed: false, nextId, nodes, edges, instances };

  const nextNodes = nodes.map((node) => (
    node.id === oldId ? { ...node, id: nextId, selected: true, data: nextData } : node
  ));
  let nextEdges = edges;
  let nextInstances = instances;
  if (nextId !== oldId) {
    nextInstances = { ...(instances || {}) };
    const base = { ...(nextInstances[oldId] || {}) };
    delete nextInstances[oldId];
    nextInstances[nextId] = base;
    nextEdges = edges.map((edge, index) => ({
      ...edge,
      source: edge.source === oldId ? nextId : edge.source,
      target: edge.target === oldId ? nextId : edge.target,
      id: `we-${edge.source === oldId ? nextId : edge.source}-${edge.target === oldId ? nextId : edge.target}-${index}`,
    }));
  }
  return { ok: true, changed: true, nextId, nodes: nextNodes, edges: nextEdges, instances: nextInstances };
}

function draftValueEquals(a, b) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

function mergeUntouchedPropDraft(current, previousNodeDraft, nextNodeDraft) {
  if (!current || !previousNodeDraft || !nextNodeDraft) return nextNodeDraft;
  const next = { ...current };
  for (const key of ["newId", "label", "role", "model", "body", "images", "script", "inputs", "outputs"]) {
    if (draftValueEquals(current[key], previousNodeDraft[key])) {
      next[key] = nextNodeDraft[key];
    }
  }
  return next;
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
  const [search, setSearch] = useState("");
  const [collapsedGroups, setCollapsedGroups] = useState(() => new Set());
  const menuRef = useRef(null);
  const scrollbarTrackRef = useRef(null);
  const [scrollbar, setScrollbar] = useState({ visible: false, top: 0, height: 100 });
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
  useEffect(() => {
    setCollapsedGroups((current) => {
      let changed = false;
      const next = new Set(current);
      for (const group of groups.collectionGroups) {
        if (!next.has(group.id)) {
          next.add(group.id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [groups.collectionGroups]);
  const filteredGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return groups;
    const matchesSkill = (skill) => {
      const haystack = [
        skill?.key,
        skill?.name,
        skill?.description,
      ].map((part) => String(part || "").toLowerCase()).join(" ");
      return haystack.includes(q);
    };
    const collectionGroups = groups.collectionGroups
      .map((group) => {
        const groupMatches = [group?.id, group?.name, group?.description]
          .map((part) => String(part || "").toLowerCase())
          .join(" ")
          .includes(q);
        const groupSkills = groupMatches ? group.skills : group.skills.filter(matchesSkill);
        return { ...group, skills: groupSkills };
      })
      .filter((group) => group.skills.length > 0);
    return {
      collectionGroups,
      ungrouped: groups.ungrouped.filter(matchesSkill),
    };
  }, [groups, search]);
  const toggleKeys = useCallback((toggleKeysList, checked) => {
    const next = new Set(keys);
    for (const key of toggleKeysList) {
      if (checked) next.add(key);
      else next.delete(key);
    }
    onChangeSkillKeys?.(id, Array.from(next));
  }, [id, keys, onChangeSkillKeys]);
  const toggleCollapsedGroup = useCallback((groupId) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);
  const updateMenuScrollbar = useCallback(() => {
    const el = menuRef.current;
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
    if (!open) return;
    const frame = requestAnimationFrame(updateMenuScrollbar);
    return () => cancelAnimationFrame(frame);
  }, [collapsedGroups, filteredGroups, keys.size, open, updateMenuScrollbar]);
  const scrollMenuToRatio = useCallback((ratio) => {
    const el = menuRef.current;
    if (!el) return;
    const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
    el.scrollTop = Math.min(1, Math.max(0, ratio)) * maxScroll;
    updateMenuScrollbar();
  }, [updateMenuScrollbar]);
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
    scrollMenuToRatio(pointerRatioFromTrack(event.clientY, grabOffsetPx));
    const pointerId = event.pointerId;
    event.currentTarget.setPointerCapture?.(pointerId);
    const onMove = (moveEvent) => {
      moveEvent.preventDefault();
      scrollMenuToRatio(pointerRatioFromTrack(moveEvent.clientY, grabOffsetPx));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }, [pointerRatioFromTrack, scrollMenuToRatio, scrollbar.height, scrollbar.top, scrollbar.visible]);

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
          if (!open) data?.onRefreshSkills?.();
          setOpen((v) => !v);
        }}>
          <span>{keys.size > 0 ? `${keys.size} skills selected` : "选择 Skills"}</span>
          <span className="material-symbols-outlined" aria-hidden>{open ? "expand_less" : "expand_more"}</span>
        </button>
        {open ? (
          <div className="af-work-load-skills-menu-shell" onClick={(event) => event.stopPropagation()}>
            <div className="af-work-load-skills-search">
              <span className="material-symbols-outlined" aria-hidden>search</span>
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索 Skills..."
                spellCheck={false}
                autoComplete="off"
                aria-label="搜索 Skills"
              />
              {search ? (
                <button type="button" onClick={() => setSearch("")} aria-label="清空搜索">
                  <span className="material-symbols-outlined" aria-hidden>close</span>
                </button>
              ) : null}
            </div>
            <div ref={menuRef} className="af-work-load-skills-menu" onScroll={updateMenuScrollbar}>
              {filteredGroups.collectionGroups.map((group) => {
                const groupKeys = group.skills.map((skill) => skill.key);
                const checkedCount = groupKeys.filter((key) => keys.has(key)).length;
                const allChecked = groupKeys.length > 0 && checkedCount === groupKeys.length;
                const collapsed = collapsedGroups.has(group.id);
                return (
                  <section key={group.id} className={"af-work-load-skills-menu__group" + (collapsed ? " af-work-load-skills-menu__group--collapsed" : "")}>
                    <div className="af-work-load-skills-menu__group-head">
                      <input
                        type="checkbox"
                        checked={allChecked}
                        onChange={(event) => toggleKeys(groupKeys, event.target.checked)}
                        aria-label={`选择 ${group.name}`}
                      />
                      <button
                        type="button"
                        className="af-work-load-skills-menu__group-toggle"
                        onClick={() => toggleCollapsedGroup(group.id)}
                        aria-expanded={!collapsed}
                      >
                        <span className="af-work-load-skills-menu__group-main">
                          <span>{group.name}</span>
                          {group.description ? <em>{group.description}</em> : null}
                        </span>
                      </button>
                      <small>{checkedCount}/{groupKeys.length}</small>
                      <button
                        type="button"
                        className="af-work-load-skills-menu__group-arrow"
                        onClick={() => toggleCollapsedGroup(group.id)}
                        aria-label={collapsed ? `展开 ${group.name}` : `收起 ${group.name}`}
                      >
                        <span className="material-symbols-outlined" aria-hidden>{collapsed ? "chevron_right" : "expand_more"}</span>
                      </button>
                    </div>
                    {!collapsed ? (
                      <div className="af-work-load-skills-menu__options">
	                        {group.skills.map((skill) => (
	                          <label key={`${group.id}:${skill.key}`} className="af-work-load-skills-menu__option">
	                            <input type="checkbox" checked={keys.has(skill.key)} onChange={(event) => toggleKeys([skill.key], event.target.checked)} />
	                            <span className="af-work-load-skills-menu__option-main">
	                              <span className="af-work-load-skills-menu__option-title">{skill.name}</span>
	                              {skill.description ? <span className="af-work-load-skills-menu__option-desc">{skill.description}</span> : null}
	                            </span>
	                          </label>
	                        ))}
                      </div>
                    ) : null}
                  </section>
                );
              })}
              {filteredGroups.ungrouped.length > 0 ? (
                <section className="af-work-load-skills-menu__group">
                  <div className="af-work-load-skills-menu__group-head af-work-load-skills-menu__group-head--plain">
                    <span>Ungrouped</span>
                    <small>{filteredGroups.ungrouped.length}</small>
                  </div>
                  <div className="af-work-load-skills-menu__options">
	                    {filteredGroups.ungrouped.map((skill) => (
	                      <label key={`ungrouped:${skill.key}`} className="af-work-load-skills-menu__option">
	                        <input type="checkbox" checked={keys.has(skill.key)} onChange={(event) => toggleKeys([skill.key], event.target.checked)} />
	                        <span className="af-work-load-skills-menu__option-main">
	                          <span className="af-work-load-skills-menu__option-title">{skill.name}</span>
	                          {skill.description ? <span className="af-work-load-skills-menu__option-desc">{skill.description}</span> : null}
	                        </span>
	                      </label>
	                    ))}
                  </div>
                </section>
              ) : null}
              {filteredGroups.collectionGroups.length === 0 && filteredGroups.ungrouped.length === 0 ? (
                <div className="af-work-load-skills-menu__empty">没有匹配的 Skills</div>
              ) : null}
              <button type="button" className="af-work-load-skills-menu__clear" onClick={() => onChangeSkillKeys?.(id, [])}>清空</button>
            </div>
            <div
              ref={scrollbarTrackRef}
              className={"af-work-load-skills-scrollbar" + (scrollbar.visible ? " af-work-load-skills-scrollbar--visible" : "")}
              onPointerDown={handleScrollbarPointerDown}
              aria-hidden="true"
            >
              <span style={{ height: `${scrollbar.height}%`, top: `${scrollbar.top}%` }} />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function WorkspaceLoadMcpNode({ id, data, selected, deleteNode, servers = [], onChangeMcpNames }) {
  const inputs = Array.isArray(data?.inputs) ? data.inputs : [];
  const outputs = Array.isArray(data?.outputs) ? data.outputs : [];
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const keys = useMemo(() => new Set(selectedMcpNamesFromNodeData(data)), [data]);
  const serverList = useMemo(() => (Array.isArray(servers) ? servers : [])
    .map((server) => ({
      name: String(server?.name || ""),
      description: String(server?.description || ""),
      detail: String(server?.url || [server?.command, ...(Array.isArray(server?.args) ? server.args : [])].filter(Boolean).join(" ") || ""),
      type: String(server?.type || ""),
    }))
    .filter((server) => server.name), [servers]);
  const filteredServers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return serverList;
    return serverList.filter((server) => [server.name, server.description, server.detail, server.type].join(" ").toLowerCase().includes(q));
  }, [search, serverList]);
  const toggleKeys = useCallback((toggleKeysList, checked) => {
    const next = new Set(keys);
    for (const key of toggleKeysList) {
      if (checked) next.add(key);
      else next.delete(key);
    }
    onChangeMcpNames?.(id, Array.from(next));
  }, [id, keys, onChangeMcpNames]);

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
        <span className="material-symbols-outlined">hub</span>
        <strong>{data?.label || "Load MCP"}</strong>
        <span>{data?.definitionId || "control_load_mcp"}</span>
        <button type="button" className="af-work-display-card__close nodrag" onClick={() => deleteNode?.(id)} aria-label="删除节点">
          <span className="material-symbols-outlined">close</span>
        </button>
      </div>
      <div className="af-work-load-skills-card__body nodrag">
        <button type="button" className="af-work-load-skills-card__select" onClick={(event) => {
          event.stopPropagation();
          if (!open) data?.onRefreshMcps?.();
          setOpen((v) => !v);
        }}>
          <span>{keys.size > 0 ? `${keys.size} MCP selected` : "选择 MCP"}</span>
          <span className="material-symbols-outlined" aria-hidden>{open ? "expand_less" : "expand_more"}</span>
        </button>
        {open ? (
          <div className="af-work-load-skills-menu-shell" onClick={(event) => event.stopPropagation()}>
            <div className="af-work-load-skills-search">
              <span className="material-symbols-outlined" aria-hidden>search</span>
              <input
                type="search"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="搜索 MCP..."
                spellCheck={false}
                autoComplete="off"
                aria-label="搜索 MCP"
              />
              {search ? (
                <button type="button" onClick={() => setSearch("")} aria-label="清空搜索">
                  <span className="material-symbols-outlined" aria-hidden>close</span>
                </button>
              ) : null}
            </div>
            <div className="af-work-load-skills-menu">
              <section className="af-work-load-skills-menu__group">
                <div className="af-work-load-skills-menu__group-head af-work-load-skills-menu__group-head--plain">
                  <span>MCP Servers</span>
                  <small>{filteredServers.length}</small>
                </div>
                <div className="af-work-load-skills-menu__options">
                  {filteredServers.map((server) => (
                    <label key={server.name} className="af-work-load-skills-menu__option">
                      <input type="checkbox" checked={keys.has(server.name)} onChange={(event) => toggleKeys([server.name], event.target.checked)} />
                      <span className="af-work-load-skills-menu__option-main">
                        <span className="af-work-load-skills-menu__option-title">{server.name}</span>
                        {server.description || server.detail ? (
                          <span className="af-work-load-skills-menu__option-desc">{server.description || server.detail}</span>
                        ) : null}
                      </span>
                    </label>
                  ))}
                </div>
              </section>
              {filteredServers.length === 0 ? (
                <div className="af-work-load-skills-menu__empty">没有匹配的 MCP</div>
              ) : null}
              <button type="button" className="af-work-load-skills-menu__clear" onClick={() => onChangeMcpNames?.(id, [])}>清空</button>
            </div>
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
  const updateNodeInternals = useUpdateNodeInternals();
  const flowParams = useMemo(readFlowParamsFromUrl, []);
  const [workspaceMode, setWorkspaceMode] = useState(() => (
    new URLSearchParams(window.location.search).get("view") === "display" ? "display" : "workspace"
  ));
  const [nodes, setNodes] = useNodesState([]);
  const [edges, setEdges, rawOnEdgesChange] = useEdgesState([]);
  const nodesRef = useRef([]);
  const edgesRef = useRef([]);
  const [displayPage, setDisplayPage] = useState(() => normalizeDisplayPageState(null, []));
  const displayPageRef = useRef(displayPage);
  const [workspaceViewport, setWorkspaceViewport] = useState(null);
  const workspaceViewportRef = useRef(null);
  const [selectedDisplayNodeIds, setSelectedDisplayNodeIds] = useState([]);
  const nodeHandleSignaturesRef = useRef(new Map());
  const renderedNodeLayoutSignaturesRef = useRef(new Map());
  const canvasClipboardRef = useRef(null);
  const connectionStartRef = useRef(null);
  const connectionMenuRef = useRef(null);
  const [connectionMenu, setConnectionMenu] = useState(null);
  const [instances, setInstances] = useState({});
  const instancesRef = useRef({});
  const loadedRef = useRef(false);
  const saveTimerRef = useRef(null);
  const [palette, setPalette] = useState([]);
  const [paletteSearch, setPaletteSearch] = useState("");
  const [paletteMode, setPaletteMode] = useState("nodes");
  const [flowSnippets, setFlowSnippets] = useState([]);
  const [flowSnippetsLoading, setFlowSnippetsLoading] = useState(false);
  const [flowSnippetsError, setFlowSnippetsError] = useState("");
  const [publishSnippetOpen, setPublishSnippetOpen] = useState(false);
  const [publishSnippetDraft, setPublishSnippetDraft] = useState({ name: "", id: "", description: "" });
  const [publishSnippetBusy, setPublishSnippetBusy] = useState(false);
  const [publishSnippetError, setPublishSnippetError] = useState("");
  const [flowSnippetToast, setFlowSnippetToast] = useState("");
  const flowSnippetToastTimerRef = useRef(null);
  const [displayShareOpen, setDisplayShareOpen] = useState(false);
  const [displayShareBusy, setDisplayShareBusy] = useState(false);
  const [displayShareError, setDisplayShareError] = useState("");
  const [displayShareResult, setDisplayShareResult] = useState(null);
  const [displayShareDraft, setDisplayShareDraft] = useState({ title: "", layout: "gallery", nodeIds: [] });
  const [displayLinkOpen, setDisplayLinkOpen] = useState(false);
  const [displayLinkCopyState, setDisplayLinkCopyState] = useState("");
  const [displayPickerOpen, setDisplayPickerOpen] = useState(false);
  const [displayPickerSearch, setDisplayPickerSearch] = useState("");
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const [quickAddMode, setQuickAddMode] = useState("nodes");
  const [quickAddSearch, setQuickAddSearch] = useState("");
  const [quickAddActiveIndex, setQuickAddActiveIndex] = useState(0);
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const selectedNodeIdRef = useRef("");
  const [nodePropDraft, setNodePropDraft] = useState(null);
  const nodePropDraftRef = useRef(null);
  const [nodePropsError, setNodePropsError] = useState("");
  const [files, setFiles] = useState([]);
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  const [workspaceWritable, setWorkspaceWritable] = useState(true);
  const [fileFilter, setFileFilter] = useState("");
  const [collapsedDirs, setCollapsedDirs] = useState(() => new Set());
  const workspaceSidebarRef = useRef(null);
  const [workspaceFilesPaneHeight, setWorkspaceFilesPaneHeight] = useState(() => {
    try {
      const saved = Number(window.localStorage.getItem("agentflow.workspace.filesPaneHeight") || 0);
      if (Number.isFinite(saved) && saved >= 160) return saved;
    } catch {
      /* ignore storage */
    }
    return 360;
  });
  const [workspaceSidebarResizing, setWorkspaceSidebarResizing] = useState(false);
  const [modelLists, setModelLists] = useState({ cursor: [], opencode: [], claudeCode: [] });
  const [composerModel, setComposerModel] = useState("");
  const [skills, setSkills] = useState([]);
  const [skillsLoaded, setSkillsLoaded] = useState(false);
  const [selectedSkills, setSelectedSkills] = useState([]);
  const [skillCollections, setSkillCollections] = useState([]);
  const [skillCollectionsLoaded, setSkillCollectionsLoaded] = useState(false);
  const [mcpServers, setMcpServers] = useState([]);

  const showFlowSnippetToast = useCallback((message) => {
    if (flowSnippetToastTimerRef.current) {
      window.clearTimeout(flowSnippetToastTimerRef.current);
    }
    setFlowSnippetToast(message);
    flowSnippetToastTimerRef.current = window.setTimeout(() => {
      setFlowSnippetToast("");
      flowSnippetToastTimerRef.current = null;
    }, 3800);
  }, []);

  const refreshNodeInternals = useCallback((nodeId) => {
    const id = String(nodeId || "").trim();
    if (!id) return;
    const refresh = () => updateNodeInternals(id);
    window.requestAnimationFrame(refresh);
    window.setTimeout(refresh, 80);
  }, [updateNodeInternals]);

  useEffect(() => {
    try {
      window.localStorage.setItem("agentflow.workspace.filesPaneHeight", String(Math.round(workspaceFilesPaneHeight)));
    } catch {
      /* ignore storage */
    }
  }, [workspaceFilesPaneHeight]);

  const setWorkspaceFilesPaneFromPointer = useCallback((clientY) => {
    const sidebar = workspaceSidebarRef.current;
    if (!sidebar) return;
    const rect = sidebar.getBoundingClientRect();
    const padding = 16;
    const minFiles = 150;
    const minPalette = 230;
    const contentTop = rect.top + padding;
    const contentBottom = rect.bottom - padding;
    const maxFiles = Math.max(minFiles, contentBottom - contentTop - minPalette);
    const next = Math.min(Math.max(clientY - contentTop, minFiles), maxFiles);
    setWorkspaceFilesPaneHeight(next);
  }, []);

  const startWorkspaceSidebarResize = useCallback((event) => {
    event.preventDefault();
    event.stopPropagation();
    setWorkspaceSidebarResizing(true);
    setWorkspaceFilesPaneFromPointer(event.clientY);
    const onPointerMove = (moveEvent) => {
      moveEvent.preventDefault();
      setWorkspaceFilesPaneFromPointer(moveEvent.clientY);
    };
    const onPointerUp = () => {
      setWorkspaceSidebarResizing(false);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerUp, true);
    };
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerUp, true);
  }, [setWorkspaceFilesPaneFromPointer]);

  useEffect(() => () => {
    if (flowSnippetToastTimerRef.current) {
      window.clearTimeout(flowSnippetToastTimerRef.current);
    }
  }, []);
  const [collapsedSkillCollections, setCollapsedSkillCollections] = useState(() => new Set());
  const [skillsOpen, setSkillsOpen] = useState(false);
  const skillsButtonRef = useRef(null);
  const skillsMenuRef = useRef(null);
  const quickAddInputRef = useRef(null);
  const [skillsMenuStyle, setSkillsMenuStyle] = useState({});
  const [composerText, setComposerText] = useState("");
  const [composerRunning, setComposerRunning] = useState(false);
  const [composerMessages, setComposerMessages] = useState([]);
  const [composerRunSessions, setComposerRunSessions] = useState([]);
  const [activeComposerSessionId, setActiveComposerSessionId] = useState("workspace");
  const [composerSidebarOpen, setComposerSidebarOpen] = useState(false);
  const [composerMinimized, setComposerMinimized] = useState(true);
  const [activeNodeChatId, setActiveNodeChatId] = useState("");
  const [nodeChatSessions, setNodeChatSessions] = useState({});
  const [workspaceSidebarCollapsed, setWorkspaceSidebarCollapsed] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [jumpPaletteOpen, setJumpPaletteOpen] = useState(false);
  const [canvasTool, setCanvasTool] = useState("pan");
  const [authUser, setAuthUser] = useState(null);
  const [runningRunNodeId, setRunningRunNodeId] = useState("");
  const workspaceRunAbortRef = useRef(null);
  const workspaceRunStoppedRef = useRef(false);
  const [workspaceExecutingNodes, setWorkspaceExecutingNodes] = useState(() => new Set());
  const [workspaceNodeRunStatus, setWorkspaceNodeRunStatus] = useState({});
  const [status, setStatus] = useState("");
  const skillsStorageKey = useMemo(() => workspaceSkillsStorageKey(flowParams), [flowParams]);
  const [skillsStorageReadyKey, setSkillsStorageReadyKey] = useState("");

  useEffect(() => {
    if (!flowParams.flowId) return;
    recordPipelineView(flowParams.flowId, flowParams.flowSource || "user", "workspace", Boolean(flowParams.archived));
  }, [flowParams]);

  useEffect(() => {
    const syncWorkspaceModeFromUrl = () => {
      setWorkspaceMode(new URLSearchParams(window.location.search).get("view") === "display" ? "display" : "workspace");
    };
    window.addEventListener("popstate", syncWorkspaceModeFromUrl);
    return () => window.removeEventListener("popstate", syncWorkspaceModeFromUrl);
  }, []);

  useEffect(() => {
    setComposerMessages([]);
    setComposerRunSessions([]);
    setActiveComposerSessionId("workspace");
    setComposerMinimized(true);
  }, [flowParams]);

  const loadFiles = useCallback(async () => {
    const q = flowParamsQuery(flowParams);
    const res = await fetch(`/api/workspace/files?${q.toString()}`);
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || "读取 workspace 失败");
    const nextFiles = json.files || [];
    setFiles(nextFiles);
    setCollapsedDirs(new Set(collectDirectoryPaths(nextFiles)));
    setWorkspaceRoot(json.root || "");
  }, [flowParams]);

  const loadFlowSnippets = useCallback(async () => {
    setFlowSnippetsLoading(true);
    setFlowSnippetsError("");
    try {
      const res = await fetch("/api/marketplace/flow-snippets");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "读取流程片段失败");
      setFlowSnippets(Array.isArray(json.snippets) ? json.snippets : []);
    } catch (e) {
      setFlowSnippetsError(String(e.message || e));
      setFlowSnippets([]);
    } finally {
      setFlowSnippetsLoading(false);
    }
  }, []);

  const saveGraph = useCallback(async (nextNodes = nodes, nextEdges = edges) => {
    if (!loadedRef.current) return;
    if (!workspaceWritable) {
      setStatus("Readonly workspace");
      throw new Error("Readonly workspace");
    }
    const graph = flowToGraph(nextNodes, nextEdges, instancesRef.current);
    graph.ui = {
      ...(graph.ui || {}),
      ...(workspaceViewportRef.current ? { viewport: workspaceViewportRef.current } : {}),
      displayPage: displayPageForGraph(displayPageRef.current, nextNodes),
    };
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
  }, [edges, flowParams, nodes, workspaceWritable]);

  const restoreCanvasSnapshot = useCallback((snapshot) => {
    const nextInstances = snapshot?.extra?.instances && typeof snapshot.extra.instances === "object"
      ? snapshot.extra.instances
      : {};
    instancesRef.current = nextInstances;
    setInstances(nextInstances);
    setNodes(Array.isArray(snapshot?.nodes) ? snapshot.nodes : []);
    setEdges(Array.isArray(snapshot?.edges) ? snapshot.edges : []);
    setSelectedNodeId("");
    setConnectionMenu(null);
  }, [setEdges, setNodes]);

  const canvasHistoryExtra = useMemo(() => ({ instances }), [instances]);
  const canvasHistory = useCanvasHistory({
    nodes,
    edges,
    extra: canvasHistoryExtra,
    enabled: loadedRef.current,
    onRestore: restoreCanvasSnapshot,
  });
  const {
    resetHistory: resetCanvasHistory,
    undo: undoCanvas,
    redo: redoCanvas,
  } = canvasHistory;

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
      WORKSPACE_LOAD_MCP_DEFINITION,
      WORKSPACE_RUN_DEFINITION,
    ];
    setPalette(paletteList);
    const graph = graphJson.graph || JSON.parse(localStorage.getItem(STORAGE_FALLBACK_KEY) || "null") || {};
    const flow = graphToFlow(graph, paletteList);
    const nextDisplayPage = normalizeDisplayPageState(graph?.ui?.displayPage, flow.nodes);
    const nextWorkspaceViewport = normalizeCanvasViewport(graph?.ui?.viewport);
    instancesRef.current = flow.instances;
    setInstances(flow.instances);
    setNodes(flow.nodes);
    setEdges(flow.edges);
    setDisplayPage(nextDisplayPage);
    displayPageRef.current = nextDisplayPage;
    setWorkspaceViewport(nextWorkspaceViewport);
    workspaceViewportRef.current = nextWorkspaceViewport;
    setSelectedDisplayNodeIds([]);
    resetCanvasHistory(flow.nodes, flow.edges, { instances: flow.instances });
    const writable = graphJson.writable !== false;
    setWorkspaceWritable(writable);
    setStatus(writable ? "Workspace ready" : "Readonly workspace");
    loadedRef.current = true;
  }, [flowParams, i18n.language, loadFiles, resetCanvasHistory, setEdges, setNodes]);

  const publishNodeToMarketplace = useCallback(
    async (draft, definitionId) => {
      const payload = {
        packageId: draft?.newId || draft?.id || draft?.label,
        label: draft?.label || draft?.newId || draft?.id,
        version: "1.0.0",
        definitionId,
        body: draft?.body || "",
        script: draft?.script || "",
        inputs: Array.isArray(draft?.inputs) ? draft.inputs : [],
        outputs: Array.isArray(draft?.outputs) ? draft.outputs : [],
        flowId: flowParams.flowId,
        flowSource: flowParams.flowSource || "user",
        archived: Boolean(flowParams.archived),
      };
      const resp = await fetch("/api/marketplace/publish-node-from-instance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await resp.json().catch(() => ({}));
      if (!resp.ok || result?.ok === false) throw new Error(result?.error || "Publish failed");
      await loadWorkspace();
      setStatus(`Published node ${result.definitionId || result.id || payload.packageId}`);
      return result;
    },
    [flowParams, loadWorkspace],
  );

  const openComposerLogPanel = useCallback((sessionId = "workspace") => {
    setComposerSidebarOpen(true);
    setNodePropDraft(null);
    setActiveComposerSessionId(sessionId || "workspace");
  }, []);

  const stopWorkspaceRun = useCallback(async (runNodeId = "") => {
    const id = String(runNodeId || runningRunNodeId || "").trim();
    if (!id) return;
    workspaceRunStoppedRef.current = true;
    if (workspaceRunAbortRef.current) {
      workspaceRunAbortRef.current.abort();
      workspaceRunAbortRef.current = null;
    }
    setRunningRunNodeId("");
    setWorkspaceExecutingNodes(new Set());
    setWorkspaceNodeRunStatus((current) => {
      const next = { ...current };
      for (const [nodeId, item] of Object.entries(next)) {
        if (item?.status === "running") next[nodeId] = { status: "stopped" };
      }
      next[id] = { status: "stopped" };
      return next;
    });
    setStatus(`Workspace run stopped: ${id}`);
    setComposerRunSessions((list) => list.map((session) => (
      session.runNodeId === id && session.status === "running"
        ? {
            ...session,
            status: "stopped",
            endedAt: Date.now(),
            messages: [
              ...(Array.isArray(session.messages) ? session.messages : []),
              { role: "assistant", kind: "status", text: "Workspace run stopped.", at: Date.now() },
            ].slice(-160),
          }
        : session
    )));
    try {
      await fetch("/api/workspace/run/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...flowParams, runNodeId: id }),
      });
    } catch (_) {}
  }, [flowParams, runningRunNodeId]);

  const runWorkspaceNode = useCallback(async (runNodeId) => {
    if (!workspaceWritable) {
      setStatus("Readonly workspace");
      return;
    }
    if (!runNodeId || runningRunNodeId) return;
    let runNodes = nodes;
    let runEdges = edges;
    let runInstances = instancesRef.current;
    const draft = nodePropDraftRef.current;
    if (draft?.id) {
      const draftSelectedNode = runNodes.find((node) => node.id === draft.id);
      const applied = workspaceApplyNodePropDraftToCanvasState({
        nodes: runNodes,
        edges: runEdges,
        instances: runInstances,
        selectedNode: draftSelectedNode,
        draft,
        allowRename: false,
      });
      if (applied?.error) {
        setNodePropsError(applied.error);
        setStatus(applied.error);
        return;
      }
      if (applied?.ok && applied.changed) {
        runNodes = applied.nodes;
        runEdges = applied.edges;
        runInstances = applied.instances;
        instancesRef.current = runInstances;
        setInstances(runInstances);
        setNodes(runNodes);
        setEdges(runEdges);
        refreshNodeInternals(applied.nextId || draft.id);
      }
    }
    const graph = flowToGraph(runNodes, runEdges, runInstances);
    const runSessionId = `run-${Date.now()}-${String(runNodeId).replace(/[^a-z0-9_-]+/gi, "_")}`;
    const runSessionLabel = `Run ${runNodeId}`;
    const abortController = new AbortController();
    workspaceRunAbortRef.current = abortController;
    workspaceRunStoppedRef.current = false;
    setRunningRunNodeId(runNodeId);
    setWorkspaceExecutingNodes(new Set([runNodeId]));
    setWorkspaceNodeRunStatus({ [runNodeId]: { status: "running" } });
    setStatus(`Running ${runNodeId}...`);
    setActiveComposerSessionId(runSessionId);
    setComposerRunSessions((list) => [
      ...list.slice(-7),
      {
        id: runSessionId,
        label: runSessionLabel,
        runNodeId,
        status: "running",
        startedAt: Date.now(),
        steps: [],
        messages: [{ role: "assistant", kind: "run-summary", text: "准备运行...", at: Date.now() }],
      },
    ]);
    try {
      await saveGraph(runNodes, runEdges);
      const res = await fetch("/api/workspace/run", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        signal: abortController.signal,
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
      let finalPauseNodeIds = [];
      let activeNodeId = runNodeId;
      const nodeLabelForRun = (nodeId, definitionId) => {
        const node = nodes.find((item) => item.id === nodeId);
        const label = String(node?.data?.label || nodeId || "").trim();
        const type = String(definitionId || node?.data?.definitionId || "").trim();
        return type && type !== label ? `${label} (${type})` : label;
      };
      const updateRunStep = (nodeId, definitionId, stepStatus) => {
        const id = String(nodeId || "").trim();
        if (!id) return;
        setComposerRunSessions((list) => list.map((session) => {
          if (session.id !== runSessionId) return session;
          const existingSteps = Array.isArray(session.steps) ? session.steps : [];
          const nextSteps = [...existingSteps];
          const existingIndex = nextSteps.findIndex((step) => step.id === id);
          const nextStep = {
            id,
            label: nodeLabelForRun(id, definitionId),
            status: stepStatus,
          };
          if (existingIndex >= 0) {
            nextSteps[existingIndex] = { ...nextSteps[existingIndex], ...nextStep };
          } else {
            nextSteps.push(nextStep);
          }
          const summary = nextSteps
            .map((step, index) => {
              const prefix = step.status === "done" ? "[done]" : step.status === "failed" ? "[failed]" : "[running]";
              return `${index + 1}. ${prefix} ${step.label}`;
            })
            .join("\n");
          const currentMessages = Array.isArray(session.messages) ? session.messages : [];
          const summaryIndex = currentMessages.findIndex((msg) => msg.kind === "run-summary");
          const summaryMessage = {
            role: "assistant",
            kind: "run-summary",
            text: summary || "准备运行...",
            at: Date.now(),
          };
          const nextMessages = [...currentMessages];
          if (summaryIndex >= 0) {
            nextMessages[summaryIndex] = summaryMessage;
          } else {
            nextMessages.unshift(summaryMessage);
          }
          return { ...session, steps: nextSteps, messages: nextMessages.slice(-160) };
        }));
      };
      const markNodeStart = (nodeId) => {
        const id = String(nodeId || "").trim();
        if (!id) return;
        const previousId = activeNodeId;
        activeNodeId = id;
        setWorkspaceExecutingNodes(new Set([id]));
        setWorkspaceNodeRunStatus((current) => ({
          ...current,
          ...(previousId && previousId !== id && current[previousId]?.status === "running" ? { [previousId]: { status: "success" } } : {}),
          [id]: { status: "running" },
        }));
      };
      const markNodeDone = (nodeId) => {
        const id = String(nodeId || "").trim();
        if (!id) return;
        setWorkspaceExecutingNodes((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
        setWorkspaceNodeRunStatus((current) => ({ ...current, [id]: { status: "success" } }));
      };
      const appendNaturalText = (kind, text) => {
        const chunk = String(text || "");
        if (!chunk.trim()) return;
        const naturalKind = ["assistant", "thinking", "result", "error", "prompt"].includes(kind) ? kind : "assistant";
        setComposerRunSessions((list) => list.map((session) => {
          if (session.id !== runSessionId) return session;
          let currentMessages = Array.isArray(session.messages) ? session.messages : [];
          if (naturalKind === "result") {
            const lastAssistant = [...currentMessages].reverse().find((msg) => msg.kind === "assistant");
            if (String(lastAssistant?.text || "").trim() === chunk.trim()) return session;
          }
          if (naturalKind === "assistant") {
            const lastResultIndex = currentMessages.findIndex((msg) => msg.kind === "result" && String(msg.text || "").trim() === chunk.trim());
            if (lastResultIndex >= 0) {
              currentMessages = currentMessages.filter((_, idx) => idx !== lastResultIndex);
            }
          }
          const nextMessages = [...currentMessages];
          const last = nextMessages[nextMessages.length - 1];
          if (last && last.kind === naturalKind && !last.error) {
            nextMessages[nextMessages.length - 1] = { ...last, text: `${last.text || ""}${last.text ? "\n" : ""}${chunk}` };
          } else {
            nextMessages.push({
              role: "assistant",
              kind: naturalKind,
              text: chunk,
              ...(naturalKind === "error" ? { error: true } : {}),
              at: Date.now(),
            });
          }
          return { ...session, messages: nextMessages.slice(-160) };
        }));
      };
      const appendThinkingText = (text) => {
        const chunk = String(text || "");
        if (!chunk.trim()) return;
        setComposerRunSessions((list) => list.map((session) => {
          if (session.id !== runSessionId) return session;
          const currentMessages = Array.isArray(session.messages) ? session.messages : [];
          const thinkingIndex = currentMessages.findIndex((msg) => msg.kind === "thinking");
          const nextMessages = [...currentMessages];
          if (thinkingIndex >= 0) {
            const prev = String(nextMessages[thinkingIndex]?.text || "");
            nextMessages[thinkingIndex] = {
              ...nextMessages[thinkingIndex],
              text: `${prev}${prev && !prev.endsWith("\n") ? "" : ""}${chunk}`,
              at: Date.now(),
            };
          } else {
            const activityIndex = nextMessages.findIndex((msg) => msg.kind === "activity");
            nextMessages.splice(activityIndex >= 0 ? activityIndex + 1 : nextMessages.length, 0, {
              role: "assistant",
              kind: "thinking",
              text: chunk,
              at: Date.now(),
            });
          }
          return { ...session, messages: nextMessages.slice(-160) };
        }));
      };
      const updateRunActivity = (text) => {
        const activity = workspaceRunActivityText(text);
        if (!activity) return;
        setComposerRunSessions((list) => list.map((session) => {
          if (session.id !== runSessionId) return session;
          const currentActivities = Array.isArray(session.activities) ? session.activities : [];
          const nextActivities = currentActivities[currentActivities.length - 1] === activity
            ? currentActivities
            : [...currentActivities, activity].slice(-8);
          const currentMessages = Array.isArray(session.messages) ? session.messages : [];
          const activityIndex = currentMessages.findIndex((msg) => msg.kind === "activity");
          const activityMessage = {
            role: "assistant",
            kind: "activity",
            text: nextActivities.map((item, index) => `${index + 1}. ${item}`).join("\n"),
            at: Date.now(),
          };
          const nextMessages = [...currentMessages];
          if (activityIndex >= 0) {
            nextMessages[activityIndex] = activityMessage;
          } else {
            const summaryIndex = nextMessages.findIndex((msg) => msg.kind === "run-summary");
            nextMessages.splice(summaryIndex >= 0 ? summaryIndex + 1 : 0, 0, activityMessage);
          }
          return { ...session, activities: nextActivities, messages: nextMessages.slice(-160) };
        }));
      };
      const appendRawTrace = (event) => {
        const source = String(event?.source || "runner");
        const stream = String(event?.stream || "");
        const eventType = String(event?.eventType || "event");
        const rawText = String(event?.text || "").trim();
        if (!rawText) return;
        const entry = `[${source}${stream ? `:${stream}` : ""}] ${eventType}\n${rawText}`;
        setComposerRunSessions((list) => list.map((session) => {
          if (session.id !== runSessionId) return session;
          const currentRaw = Array.isArray(session.rawTrace) ? session.rawTrace : [];
          const nextRaw = [...currentRaw, entry].slice(-80);
          const currentMessages = Array.isArray(session.messages) ? session.messages : [];
          const rawIndex = currentMessages.findIndex((msg) => msg.kind === "raw");
          const rawMessage = {
            role: "assistant",
            kind: "raw",
            text: nextRaw.join("\n\n---\n\n"),
            at: Date.now(),
          };
          const nextMessages = [...currentMessages];
          if (rawIndex >= 0) {
            nextMessages[rawIndex] = rawMessage;
          } else {
            nextMessages.push(rawMessage);
          }
          return { ...session, rawTrace: nextRaw, messages: nextMessages.slice(-160) };
        }));
      };
      const markRunSessionStatus = (sessionStatus) => {
        setComposerRunSessions((list) => list.map((session) => (
          session.id === runSessionId ? { ...session, status: sessionStatus, endedAt: Date.now() } : session
        )));
      };
      const eventTouchedNodeIds = (event) => {
        const ids = new Set();
        const nodeId = String(event?.nodeId || "").trim();
        if (nodeId) ids.add(nodeId);
        for (const displayId of Array.isArray(event?.displayNodeIds) ? event.displayNodeIds : []) {
          const text = String(displayId || "").trim();
          if (text) ids.add(text);
        }
        for (const touchedId of Array.isArray(event?.touchedNodeIds) ? event.touchedNodeIds : []) {
          const text = String(touchedId || "").trim();
          if (text) ids.add(text);
        }
        if (ids.size === 0) {
          for (const orderedId of Array.isArray(event?.order) ? event.order : []) {
            const text = String(orderedId || "").trim();
            if (text) ids.add(text);
          }
        }
        return ids;
      };
      const applyGraph = (nextGraph, touchedNodeIds = null) => {
        const flow = graphToFlow(nextGraph || graph, palette);
        const incomingNodesById = new Map(flow.nodes.map((node) => [node.id, node]));
        const incomingInstances = flow.instances || {};
        const scopedIds = touchedNodeIds instanceof Set ? touchedNodeIds : null;
        setNodes((currentNodes) => {
          const currentIds = new Set(currentNodes.map((node) => node.id));
          const currentGraph = flowToGraph(currentNodes, edgesRef.current, instancesRef.current);
          const nextInstances = { ...(currentGraph.instances || {}) };
          for (const [instanceId, instance] of Object.entries(incomingInstances)) {
            if (scopedIds && !scopedIds.has(instanceId)) continue;
            if (!currentIds.has(instanceId)) continue;
            const currentInstance = nextInstances[instanceId];
            if (displayKind(instance?.definitionId || currentInstance?.definitionId)) {
              nextInstances[instanceId] = instance;
            } else if (Array.isArray(instance?.output)) {
              nextInstances[instanceId] = { ...(currentInstance || instance), output: instance.output };
            }
          }
          instancesRef.current = nextInstances;
          setInstances(nextInstances);
          return currentNodes.map((node) => {
            if (scopedIds && !scopedIds.has(node.id)) return node;
            const incomingNode = incomingNodesById.get(node.id);
            if (!incomingNode) return node;
            if (!displayKind(incomingNode.data?.definitionId || node.data?.definitionId)) {
              return Array.isArray(incomingNode.data?.outputs)
                ? { ...node, data: { ...node.data, outputs: incomingNode.data.outputs } }
                : node;
            }
            return {
              ...node,
              data: {
                ...node.data,
                ...incomingNode.data,
              },
            };
          });
        });
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
          if (event.type === "stopped") {
            workspaceRunStoppedRef.current = true;
            finalOrder = Array.isArray(event.order) ? event.order : finalOrder;
            continue;
          }
          if (event.type === "node-start") {
            setStatus(`Running ${event.nodeId}...`);
            markNodeStart(event.nodeId);
            updateRunStep(event.nodeId, event.definitionId, "running");
          }
          if (event.type === "node-done") {
            markNodeDone(event.nodeId);
            updateRunStep(event.nodeId, event.definitionId, "done");
          }
          if (event.type === "status") {
            updateRunActivity(event.line || event.message || "");
          }
          if (event.type === "paused") {
            finalPauseNodeIds = Array.isArray(event.nodeIds) ? event.nodeIds : [];
          }
          if (event.type === "natural") {
            if (event.kind === "thinking") appendThinkingText(event.text || "");
            else appendNaturalText(event.kind, event.text || "");
          }
          if (event.type === "raw") {
            const rawThinking = extractThinkingDeltaFromRawTrace(event);
            if (rawThinking) appendThinkingText(rawThinking);
            appendRawTrace(event);
          }
          if (event.type === "graph" && event.graph) applyGraph(event.graph, eventTouchedNodeIds(event));
          if (event.type === "done") {
            if (event.graph) applyGraph(event.graph, eventTouchedNodeIds(event));
            finalOrder = Array.isArray(event.order) ? event.order : [];
            finalPauseNodeIds = Array.isArray(event.pauseNodeIds) ? event.pauseNodeIds : finalPauseNodeIds;
          }
        }
      }
      if (buffer.trim()) {
        const event = JSON.parse(buffer);
        if (event.type === "error") throw new Error(event.error || "Workspace run failed");
        if (event.type === "stopped") {
          workspaceRunStoppedRef.current = true;
        }
        if (event.type === "node-start") {
          setStatus(`Running ${event.nodeId}...`);
          markNodeStart(event.nodeId);
          updateRunStep(event.nodeId, event.definitionId, "running");
        }
        if (event.type === "node-done") {
          markNodeDone(event.nodeId);
          updateRunStep(event.nodeId, event.definitionId, "done");
        }
        if (event.type === "status") {
          updateRunActivity(event.line || event.message || "");
        }
        if (event.type === "paused") {
          finalPauseNodeIds = Array.isArray(event.nodeIds) ? event.nodeIds : [];
        }
        if (event.type === "natural") {
          if (event.kind === "thinking") appendThinkingText(event.text || "");
          else appendNaturalText(event.kind, event.text || "");
        }
        if (event.type === "raw") {
          const rawThinking = extractThinkingDeltaFromRawTrace(event);
          if (rawThinking) appendThinkingText(rawThinking);
          appendRawTrace(event);
        }
        if (event.type === "graph" && event.graph) applyGraph(event.graph, eventTouchedNodeIds(event));
        if (event.type === "done") {
          if (event.graph) applyGraph(event.graph, eventTouchedNodeIds(event));
          finalOrder = Array.isArray(event.order) ? event.order : [];
          finalPauseNodeIds = Array.isArray(event.pauseNodeIds) ? event.pauseNodeIds : finalPauseNodeIds;
        }
      }
      if (workspaceRunStoppedRef.current) {
        setWorkspaceExecutingNodes(new Set());
        setWorkspaceNodeRunStatus((current) => {
          const id = Object.entries(current).find(([, item]) => item?.status === "running")?.[0] || runNodeId;
          return id ? { ...current, [id]: { status: "stopped" } } : current;
        });
      }
      setStatus(
        workspaceRunStoppedRef.current
          ? `Workspace run stopped: ${runNodeId}`
          : finalPauseNodeIds.length
          ? `Workspace run paused at ${finalPauseNodeIds.join(", ")}`
          : `Workspace run done: ${finalOrder.length ? finalOrder.join(" -> ") : runNodeId}`
      );
      markRunSessionStatus(workspaceRunStoppedRef.current ? "stopped" : finalPauseNodeIds.length ? "paused" : "done");
      if (!workspaceRunStoppedRef.current) await loadFiles();
    } catch (e) {
      if (workspaceRunStoppedRef.current || e?.name === "AbortError") {
        setWorkspaceExecutingNodes(new Set());
        setWorkspaceNodeRunStatus((current) => {
          const id = Object.entries(current).find(([, item]) => item?.status === "running")?.[0] || runNodeId;
          return id ? { ...current, [id]: { status: "stopped" } } : current;
        });
        setStatus(`Workspace run stopped: ${runNodeId}`);
        setComposerRunSessions((list) => list.map((session) => (
          session.id === runSessionId ? { ...session, status: "stopped", endedAt: Date.now() } : session
        )));
        return;
      }
      setWorkspaceExecutingNodes(new Set());
      setWorkspaceNodeRunStatus((current) => {
        const id = Object.entries(current).find(([, item]) => item?.status === "running")?.[0];
        return id ? { ...current, [id]: { status: "failed" } } : current;
      });
      setStatus(String(e.message || e));
      setComposerRunSessions((list) => list.map((session) => (
        session.id === runSessionId
          ? {
              ...session,
              status: "failed",
              endedAt: Date.now(),
              messages: [
                ...(Array.isArray(session.messages) ? session.messages : []),
                { role: "assistant", error: true, text: String(e.message || e), at: Date.now() },
              ].slice(-160),
            }
          : session
      )));
    } finally {
      if (workspaceRunAbortRef.current === abortController) workspaceRunAbortRef.current = null;
      setRunningRunNodeId("");
      setWorkspaceExecutingNodes(new Set());
    }
  }, [composerModel, edges, flowParams, loadFiles, nodes, palette, refreshNodeInternals, runningRunNodeId, saveGraph, selectedSkills, setEdges, setNodes, workspaceWritable]);

  const refreshSkills = useCallback(async () => {
    try {
      const r = await fetch("/api/skills");
      const j = await r.json().catch(() => ({}));
      const list = Array.isArray(j.skills) ? j.skills.map((s) => ({
        key: String(s.key),
        name: String(s.name || s.id || s.key),
        description: s.description ? String(s.description) : "",
        sourceLabel: s.sourceLabel ? String(s.sourceLabel) : "",
      })) : [];
      setSkills(list);
      setSkillsLoaded(true);
    } catch {
      setSkillsLoaded(true);
    }
  }, []);

  const refreshMcps = useCallback(async () => {
    try {
      const r = await fetch("/api/mcps");
      const j = await r.json().catch(() => ({}));
      const list = Array.isArray(j.servers) ? j.servers.map((server) => ({
        name: String(server?.name || ""),
        type: String(server?.type || ""),
        url: String(server?.url || ""),
        command: String(server?.command || ""),
        args: Array.isArray(server?.args) ? server.args.map(String) : [],
        description: String(server?.description || ""),
      })).filter((server) => server.name) : [];
      setMcpServers(list);
    } catch {
      setMcpServers([]);
    }
  }, []);

  useEffect(() => {
    loadWorkspace().catch((e) => setStatus(String(e.message || e)));
    void loadFlowSnippets();
    fetch("/api/model-lists").then((r) => r.json()).then((j) => setModelLists({
      cursor: Array.isArray(j.cursor) ? j.cursor.map(String) : [],
      opencode: Array.isArray(j.opencode) ? j.opencode.map(String) : [],
      claudeCode: Array.isArray(j.claudeCode) ? j.claudeCode.map(String) : [],
    })).catch(() => {});
    void refreshSkills();
    void refreshMcps();
    fetch("/api/skill-collections").then((r) => r.json()).then((j) => {
      setSkillCollections(normalizeSkillCollections(j));
      setSkillCollectionsLoaded(true);
    }).catch(() => {});
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((j) => setAuthUser(j.user || null))
      .catch(() => setAuthUser(null));
  }, [loadWorkspace, loadFlowSnippets, refreshMcps, refreshSkills, skillsStorageKey]);

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
    const prev = nodeHandleSignaturesRef.current;
    const next = new Map();
    const changedIds = [];
    for (const node of nodes) {
      const signature = nodeHandleSignature(node);
      next.set(node.id, signature);
      if (prev.get(node.id) !== signature) changedIds.push(node.id);
    }
    nodeHandleSignaturesRef.current = next;
    if (changedIds.length === 0) return undefined;
    const refresh = () => changedIds.forEach((id) => updateNodeInternals(id));
    const raf = window.requestAnimationFrame(refresh);
    const timer = window.setTimeout(refresh, 80);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [nodes, updateNodeInternals]);

  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);

  useEffect(() => {
    displayPageRef.current = displayPage;
  }, [displayPage]);

  useEffect(() => {
    workspaceViewportRef.current = workspaceViewport;
  }, [workspaceViewport]);

  useEffect(() => {
    nodePropDraftRef.current = nodePropDraft;
  }, [nodePropDraft]);

  useEffect(() => {
    selectedNodeIdRef.current = selectedNodeId;
  }, [selectedNodeId]);

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
    if (!workspaceWritable) return;
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveGraph().catch((e) => setStatus(String(e.message || e)));
    }, 650);
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, [nodes, edges, displayPage, saveGraph, workspaceWritable]);

  const changeLoadSkillKeys = useCallback((nodeId, keys) => {
    if (!workspaceWritable) {
      setStatus("Readonly workspace");
      return;
    }
    const serialized = serializeSkillKeys(keys);
    const patchInputSlots = (slots) => (Array.isArray(slots) ? slots.map((slot) => {
      if (slot?.name !== "skillKeys" && slot?.name !== "skillsContext" && slot?.type !== "text") return slot;
      return { ...slot, default: serialized, value: serialized };
    }) : []);
    const nextNodes = nodes.map((node) => {
      if (node.id !== nodeId) return node;
      return {
        ...node,
        data: {
          ...node.data,
          body: serialized,
          inputs: patchInputSlots(node.data?.inputs),
        },
      };
    });
    const currentInstances = instancesRef.current || {};
    const base = currentInstances[nodeId] && typeof currentInstances[nodeId] === "object" ? currentInstances[nodeId] : {};
    const nextInstances = {
      ...currentInstances,
      [nodeId]: {
        ...base,
        body: serialized,
        input: patchInputSlots(base.input),
      },
    };
    instancesRef.current = nextInstances;
    setNodes(nextNodes);
    setInstances(nextInstances);
    setNodePropDraft((draft) => {
      if (!draft || draft.id !== nodeId) return draft;
      return {
        ...draft,
        body: serialized,
        inputs: patchInputSlots(draft.inputs),
      };
    });
    saveGraph(nextNodes, edges).catch((e) => setStatus(String(e.message || e)));
  }, [edges, nodes, saveGraph, setNodes, workspaceWritable]);

  const changeLoadMcpNames = useCallback((nodeId, names) => {
    if (!workspaceWritable) {
      setStatus("Readonly workspace");
      return;
    }
    const serialized = serializeMcpNames(names);
    const patchInputSlots = (slots) => (Array.isArray(slots) ? slots.map((slot) => {
      if (slot?.name !== "serverNames" && slot?.name !== "mcpContext" && slot?.type !== "text") return slot;
      return { ...slot, default: serialized, value: serialized };
    }) : []);
    const nextNodes = nodes.map((node) => {
      if (node.id !== nodeId) return node;
      return {
        ...node,
        data: {
          ...node.data,
          body: serialized,
          inputs: patchInputSlots(node.data?.inputs),
        },
      };
    });
    const currentInstances = instancesRef.current || {};
    const base = currentInstances[nodeId] && typeof currentInstances[nodeId] === "object" ? currentInstances[nodeId] : {};
    const nextInstances = {
      ...currentInstances,
      [nodeId]: {
        ...base,
        body: serialized,
        input: patchInputSlots(base.input),
      },
    };
    instancesRef.current = nextInstances;
    setNodes(nextNodes);
    setInstances(nextInstances);
    setNodePropDraft((draft) => {
      if (!draft || draft.id !== nodeId) return draft;
      return {
        ...draft,
        body: serialized,
        inputs: patchInputSlots(draft.inputs),
      };
    });
    saveGraph(nextNodes, edges).catch((e) => setStatus(String(e.message || e)));
  }, [edges, nodes, saveGraph, setNodes, workspaceWritable]);

  const toggleNodeChat = useCallback((nodeId) => {
    const id = String(nodeId || "").trim();
    if (!id) return;
    setActiveNodeChatId((current) => (current === id ? "" : id));
    setNodeChatSessions((sessions) => ({
      ...sessions,
      [id]: sessions[id] || {
        sessionId: `nodechat_${Date.now()}_${id.replace(/[^a-z0-9_-]+/gi, "_")}`,
        messages: [],
        draft: "",
        candidateContent: "",
        running: false,
        error: "",
      },
    }));
  }, []);

  const updateNodeChatDraft = useCallback((nodeId, draft) => {
    const id = String(nodeId || "").trim();
    if (!id) return;
    setNodeChatSessions((sessions) => ({
      ...sessions,
      [id]: {
        ...(sessions[id] || { sessionId: `nodechat_${Date.now()}_${id.replace(/[^a-z0-9_-]+/gi, "_")}`, messages: [] }),
        draft: String(draft || ""),
        error: "",
      },
    }));
  }, []);

  const setDisplayNodeContent = useCallback((nodeId, content, mode = "replace", options = {}) => {
    if (!workspaceWritable) {
      setStatus("Readonly workspace");
      return;
    }
    const id = String(nodeId || "").trim();
    if (!id) return;
    const currentNode = nodesRef.current.find((node) => node.id === id);
    const kind = displayKind(currentNode?.data?.definitionId);
    const text = kind === "html" ? normalizeHtmlDisplayContent(content) : String(content || "");
    const currentContent = currentNode ? displayContent(currentNode.data) : "";
    const nextText = mode === "append" && String(currentContent || "").trim()
      ? `${String(currentContent).replace(/\s+$/g, "")}\n\n${text.trim()}`
      : text;
    const primaryName = kind === "image" ? "src" : "content";
    const patchSlots = (slots) => {
      let patched = false;
      const nextSlots = (Array.isArray(slots) ? slots : []).map((slot) => {
        const name = String(slot?.name || "");
        const type = String(slot?.type || "");
        if (!patched && (name === primaryName || name === "filePath" || type === "text")) {
          patched = true;
          return { ...slot, default: nextText, value: nextText };
        }
        return slot;
      });
      return nextSlots;
    };
    const nextNodes = nodesRef.current.map((node) => {
      if (node.id !== id) return node;
      return {
        ...node,
        data: {
          ...node.data,
          body: nextText,
          inputs: patchSlots(node.data?.inputs),
          outputs: patchSlots(node.data?.outputs),
        },
      };
    });
    const currentInstances = instancesRef.current || {};
    const base = currentInstances[id] && typeof currentInstances[id] === "object" ? currentInstances[id] : {};
    const nextInstances = {
      ...currentInstances,
      [id]: {
        ...base,
        body: nextText,
        input: patchSlots(base.input),
        output: patchSlots(base.output),
      },
    };
    instancesRef.current = nextInstances;
    setNodes(nextNodes);
    setInstances(nextInstances);
    setNodePropDraft((draft) => (draft?.id === id ? { ...draft, body: nextText } : draft));
    if (options?.logChat !== false) {
      setNodeChatSessions((sessions) => ({
        ...sessions,
        [id]: {
          ...(sessions[id] || {}),
          candidateContent: "",
          messages: [
            ...((sessions[id]?.messages && Array.isArray(sessions[id].messages)) ? sessions[id].messages : []),
            { role: "assistant", text: mode === "append" ? "已追加到当前节点内容。" : "已替换当前节点内容。", at: Date.now() },
          ],
        },
      }));
    }
    saveGraph(nextNodes, edgesRef.current).catch((e) => setStatus(String(e.message || e)));
    setStatus(String(options?.statusMessage || "") || (mode === "append" ? "已追加节点内容" : "已替换节点内容"));
  }, [saveGraph, setNodes, workspaceWritable]);

  const uploadWorkspaceImage = useCallback(async (file) => {
    if (!workspaceWritable) {
      setStatus("Readonly workspace");
      return "";
    }
    if (!isWorkspaceImageFile(file)) {
      setStatus("请选择图片文件");
      return "";
    }
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("dir", "img");
      if (flowParams.flowId) form.set("flowId", flowParams.flowId);
      if (flowParams.flowSource) form.set("flowSource", flowParams.flowSource);
      if (flowParams.archived) form.set("archived", "1");
      const res = await fetch("/api/workspace/upload", {
        method: "POST",
        body: form,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "上传图片失败");
      const savedPath = String(json.path || "").trim();
      if (!savedPath) throw new Error("上传图片失败：未返回路径");
      await loadFiles();
      setCollapsedDirs((prev) => {
        const next = new Set(prev);
        for (const dir of parentDirectoryPaths(savedPath)) next.delete(dir);
        return next;
      });
      setStatus(`已上传图片 ${savedPath}`);
      return savedPath;
    } catch (e) {
      setStatus(String(e.message || e));
      return "";
    }
  }, [flowParams, loadFiles, workspaceWritable]);

  const uploadImageToDisplayNode = useCallback(async (nodeId, file) => {
    const id = String(nodeId || "").trim();
    if (!id) return;
    const savedPath = await uploadWorkspaceImage(file);
    if (savedPath) {
      setDisplayNodeContent(id, savedPath, "replace", {
        logChat: false,
        statusMessage: `已上传图片 ${savedPath}`,
      });
    }
  }, [setDisplayNodeContent, uploadWorkspaceImage]);

  const applyNodeChatCandidate = useCallback((nodeId, mode = "replace") => {
    const id = String(nodeId || "").trim();
    const candidate = String(nodeChatSessions[id]?.candidateContent || "").trim();
    if (!id || !candidate) return;
    setDisplayNodeContent(id, candidate, mode);
  }, [nodeChatSessions, setDisplayNodeContent]);

  const sendNodeChat = useCallback(async (nodeId, messageOverride = undefined) => {
    if (!workspaceWritable) {
      setStatus("Readonly workspace");
      return;
    }
    const id = String(nodeId || "").trim();
    if (!id) return;
    const session = nodeChatSessions[id] || {};
    const message = String(messageOverride !== undefined ? messageOverride : session.draft || "").trim();
    if (!message || session.running) return;
    const node = nodesRef.current.find((item) => item.id === id);
    if (!node) return;
    const userMessage = { role: "user", text: message, at: Date.now() };
    const previousMessages = Array.isArray(session.messages) ? session.messages : [];
    const nextSessionId = session.sessionId || `nodechat_${Date.now()}_${id.replace(/[^a-z0-9_-]+/gi, "_")}`;
    setNodeChatSessions((sessions) => ({
      ...sessions,
      [id]: {
        ...session,
        sessionId: nextSessionId,
        messages: [...previousMessages, userMessage],
        draft: "",
        running: true,
        error: "",
      },
    }));
    try {
      const res = await fetch("/api/workspace/node-chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...flowParams,
          sessionId: nextSessionId,
          node: {
            id,
            label: node.data?.label || id,
            definitionId: node.data?.definitionId || "",
          },
          nodeKind: displayKind(node.data?.definitionId) || "markdown",
          currentContent: displayContent(node.data),
          messages: previousMessages,
          message,
          model: composerModel,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "节点微调失败");
      const candidateContent = String(json.candidateContent || json.reply || "").trim();
      setNodeChatSessions((sessions) => ({
        ...sessions,
        [id]: {
          ...(sessions[id] || {}),
          sessionId: String(json.sessionId || nextSessionId),
          running: false,
          candidateContent,
          messages: [
            ...(((sessions[id]?.messages && Array.isArray(sessions[id].messages)) ? sessions[id].messages : [...previousMessages, userMessage])),
            { role: "assistant", text: candidateContent || "已生成候选内容。", at: Date.now() },
          ],
        },
      }));
    } catch (e) {
      const err = String(e.message || e);
      setNodeChatSessions((sessions) => ({
        ...sessions,
        [id]: {
          ...(sessions[id] || {}),
          running: false,
          error: err,
        },
      }));
      setStatus(err);
    }
  }, [composerModel, flowParams, nodeChatSessions, workspaceWritable]);

  const saveDisplayNodeToFile = useCallback(async (nodeId, data) => {
    if (!workspaceWritable) {
      setStatus("Readonly workspace");
      return;
    }
    const content = displayContent(data);
    if (!String(content || "").trim()) {
      setStatus("展示节点没有可保存内容");
      return;
    }
    const defaultPath = suggestDisplayFilePath(nodeId, data);
    const relPath = window.prompt("保存到 workspace 相对路径", defaultPath);
    if (!relPath) return;
    try {
      const res = await fetch("/api/workspace/file", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...flowParams, path: relPath, content }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "保存文件失败");
      const savedPath = json.path || relPath;
      const verifyQuery = flowParamsQuery(flowParams);
      verifyQuery.set("path", savedPath);
      const verifyRes = await fetch(`/api/workspace/file?${verifyQuery.toString()}`);
      if (!verifyRes.ok) {
        const verifyJson = await verifyRes.json().catch(() => ({}));
        throw new Error(verifyJson.error || `保存后读取失败：${savedPath}`);
      }
      await loadFiles();
      setFiles((current) => upsertWorkspaceFile(current, savedPath, String(content || "").length));
      setCollapsedDirs((prev) => {
        const next = new Set(prev);
        for (const dir of parentDirectoryPaths(savedPath)) next.delete(dir);
        return next;
      });
      setStatus(`已保存 ${savedPath}`);
    } catch (e) {
      setStatus(String(e.message || e));
    }
  }, [flowParams, loadFiles, workspaceWritable]);

  const syncNodePropDraft = useCallback((nodeId, patchOrUpdater) => {
    const id = String(nodeId || "");
    if (!id) return;
    setNodePropDraft((draft) => {
      if (!draft || draft.id !== id) return draft;
      const patch = typeof patchOrUpdater === "function" ? patchOrUpdater(draft) : patchOrUpdater;
      if (!patch || typeof patch !== "object") return draft;
      return { ...draft, ...patch };
    });
  }, []);

  const hydratedNodes = useMemo(() => nodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      selected: node.selected === true,
      modelLists,
      showBodyPreview: true,
      isExecuting: workspaceExecutingNodes.has(node.id),
      nodeStatus: workspaceNodeRunStatus[node.id]?.status ?? null,
      nodeElapsed: workspaceNodeRunStatus[node.id]?.elapsed ?? null,
      flowParams,
      readOnly: !workspaceWritable,
      onRunWorkspaceNode: runWorkspaceNode,
      onStopWorkspaceNode: stopWorkspaceRun,
      runningRunNodeId,
      skills,
      skillCollections,
      onChangeLoadSkillKeys: changeLoadSkillKeys,
      onRefreshSkills: refreshSkills,
      mcpServers,
      onChangeLoadMcpNames: changeLoadMcpNames,
      onRefreshMcps: refreshMcps,
      onSaveDisplayNodeToFile: saveDisplayNodeToFile,
      onUploadWorkspaceImage: uploadWorkspaceImage,
      onUploadImageToDisplayNode: uploadImageToDisplayNode,
      nodeChatActive: activeNodeChatId === node.id,
      nodeChat: nodeChatSessions[node.id] || null,
      onSetDisplayNodeContent: setDisplayNodeContent,
      onToggleNodeChat: toggleNodeChat,
      onCloseNodeChat: () => setActiveNodeChatId(""),
      onUpdateNodeChatDraft: updateNodeChatDraft,
      onSendNodeChat: sendNodeChat,
      onApplyNodeChatCandidate: applyNodeChatCandidate,
      onSyncNodePropDraft: syncNodePropDraft,
    },
  })), [activeNodeChatId, applyNodeChatCandidate, changeLoadMcpNames, changeLoadSkillKeys, flowParams, mcpServers, modelLists, nodeChatSessions, nodes, refreshMcps, refreshSkills, runWorkspaceNode, runningRunNodeId, saveDisplayNodeToFile, sendNodeChat, setDisplayNodeContent, skillCollections, skills, stopWorkspaceRun, syncNodePropDraft, toggleNodeChat, updateNodeChatDraft, uploadImageToDisplayNode, uploadWorkspaceImage, workspaceExecutingNodes, workspaceNodeRunStatus, workspaceWritable]);

  const hydratedNodeById = useMemo(
    () => new Map(hydratedNodes.map((node) => [node.id, node])),
    [hydratedNodes],
  );

  const displayCanvasNodes = useMemo(() => {
    const selected = new Set(selectedDisplayNodeIds);
    return displayPage.nodeIds
      .map((sourceId, index) => {
        const sourceNode = hydratedNodeById.get(sourceId);
        if (!sourceNode || !displayKind(sourceNode.data?.definitionId)) return null;
        const fallbackSize = persistedWorkspaceNodeSize(sourceNode) || { width: 520, height: 320 };
        const size = normalizeWorkspaceNodeSize(displayPage.nodeSizes[sourceId] || fallbackSize, { display: true }) || fallbackSize;
        const position = displayPage.nodePositions[sourceId] || { x: 180 + index * 36, y: 120 + index * 28 };
        return {
          ...sourceNode,
          id: displayRefNodeId(sourceId),
          position,
          selected: selected.has(sourceId),
          width: size.width,
          height: size.height,
          data: {
            ...sourceNode.data,
            sourceNodeId: sourceId,
            displayPageMode: true,
            readOnly: true,
            selected: selected.has(sourceId),
            displaySize: size,
            nodeSize: size,
          },
        };
      })
      .filter(Boolean);
  }, [displayPage, hydratedNodeById, selectedDisplayNodeIds]);

  const availableDisplayNodes = useMemo(
    () => hydratedNodes.filter((node) => displayKind(node?.data?.definitionId)),
    [hydratedNodes],
  );

  const isDisplayMode = workspaceMode === "display";

  useEffect(() => {
    if (!isDisplayMode || !displayPage.viewport) return undefined;
    const viewport = displayPage.viewport;
    const apply = () => {
      try {
        reactFlow.setViewport(viewport, { duration: 0 });
      } catch {
        /* React Flow may not be mounted yet during route transitions. */
      }
    };
    const raf = window.requestAnimationFrame(() => window.requestAnimationFrame(apply));
    return () => window.cancelAnimationFrame(raf);
  }, [displayPage.viewport, isDisplayMode, reactFlow]);

  useEffect(() => {
    if (isDisplayMode || !workspaceViewport) return undefined;
    const viewport = workspaceViewport;
    const apply = () => {
      try {
        reactFlow.setViewport(viewport, { duration: 0 });
      } catch {
        /* React Flow may not be mounted yet during route transitions. */
      }
    };
    const raf = window.requestAnimationFrame(() => window.requestAnimationFrame(apply));
    return () => window.cancelAnimationFrame(raf);
  }, [isDisplayMode, reactFlow, workspaceViewport]);

  useEffect(() => {
    const prev = renderedNodeLayoutSignaturesRef.current;
    const next = new Map();
    const changedIds = [];
    for (const node of [...hydratedNodes, ...displayCanvasNodes]) {
      const signature = workspaceNodeLayoutSignature(node);
      next.set(node.id, signature);
      if (prev.get(node.id) !== signature) changedIds.push(node.id);
    }
    renderedNodeLayoutSignaturesRef.current = next;
    if (changedIds.length === 0) return undefined;
    const refresh = () => changedIds.forEach((id) => updateNodeInternals(id));
    const raf = window.requestAnimationFrame(refresh);
    const timer = window.setTimeout(refresh, 80);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [displayCanvasNodes, hydratedNodes, updateNodeInternals]);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) || null,
    [nodes, selectedNodeId],
  );
  const selectedNodePropSnapshotRef = useRef({ id: "", draft: null });
  const selectedNodePropSignature = useMemo(() => {
    const draft = nodeToPropDraft(selectedNode);
    return draft ? JSON.stringify(draft) : "";
  }, [selectedNode]);

  useEffect(() => {
    if (!selectedNode) {
      selectedNodePropSnapshotRef.current = { id: "", draft: null };
      setNodePropDraft(null);
      setNodePropsError("");
      return;
    }
    const nextDraft = nodeToPropDraft(selectedNode);
    const previousSnapshot = selectedNodePropSnapshotRef.current;
    selectedNodePropSnapshotRef.current = { id: selectedNode.id, draft: nextDraft };
    setNodePropDraft((current) => {
      if (!current || current.id !== selectedNode.id) return nextDraft;
      if (previousSnapshot.id !== selectedNode.id || !previousSnapshot.draft) return nextDraft;
      return mergeUntouchedPropDraft(current, previousSnapshot.draft, nextDraft);
    });
    setNodePropsError("");
  }, [selectedNode?.id, selectedNodePropSignature]);

  const applyNodeProperties = useCallback((allowRename = false) => {
    if (!nodePropDraft || !selectedNode) return false;
    if (!workspaceWritable) {
      setNodePropsError("Readonly workspace");
      setStatus("Readonly workspace");
      return false;
    }
    setNodePropsError("");
    const applied = workspaceApplyNodePropDraftToCanvasState({
      nodes,
      edges,
      instances: instancesRef.current,
      selectedNode,
      draft: nodePropDraft,
      allowRename,
    });
    if (applied?.error) {
      setNodePropsError(applied.error);
      return false;
    }
    if (!applied?.ok || !applied.changed) return true;
    instancesRef.current = applied.instances;
    setInstances(applied.instances);
    setNodes(applied.nodes);
    setEdges(applied.edges);
    if (applied.nextId !== selectedNode.id) setSelectedNodeId(applied.nextId);
    refreshNodeInternals(applied.nextId);
    return true;
  }, [edges, nodePropDraft, nodes, selectedNode, setEdges, setNodes, refreshNodeInternals, workspaceWritable]);

  useEffect(() => {
    if (!workspaceWritable) return undefined;
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
    JSON.stringify(nodePropDraft?.images || []),
    nodePropDraft?.script,
    JSON.stringify(nodePropDraft?.inputs || []),
    JSON.stringify(nodePropDraft?.outputs || []),
    applyNodeProperties,
    selectedNode?.id,
    workspaceWritable,
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

  const canvasNodes = isDisplayMode ? displayCanvasNodes : hydratedNodes;
  const canvasEdges = isDisplayMode ? [] : coloredEdges;
  const jumpPaletteNodes = useMemo(() => (
    isDisplayMode
      ? displayCanvasNodes.map((node) => ({ ...node, id: sourceIdFromDisplayRefId(node.id) }))
      : hydratedNodes
  ), [displayCanvasNodes, hydratedNodes, isDisplayMode]);

  const jumpToWorkspaceNodeById = useCallback((nodeId) => {
    const sourceId = String(nodeId || "").trim();
    if (!sourceId) return;
    const flowNodeId = isDisplayMode ? displayRefNodeId(sourceId) : sourceId;
    if (isDisplayMode) {
      setSelectedDisplayNodeIds([sourceId]);
    } else {
      setNodes((list) => list.map((node) => ({ ...node, selected: node.id === flowNodeId })));
      setEdges((list) => list.map((edge) => ({ ...edge, selected: false })));
      setSelectedNodeId(flowNodeId);
    }
    const center = () => {
      const userNode = reactFlow.getNode(flowNodeId);
      if (!userNode) return;
      const internal = reactFlow.getInternalNode?.(flowNodeId);
      const width = internal?.measured?.width ?? internal?.width ?? userNode.width ?? 260;
      const height = internal?.measured?.height ?? internal?.height ?? userNode.height ?? 120;
      const { zoom } = reactFlow.getViewport();
      void reactFlow.setCenter(userNode.position.x + width / 2, userNode.position.y + height / 2, {
        zoom: clampWorkspaceFocusZoom(zoom),
        duration: 240,
      });
    };
    window.requestAnimationFrame(() => window.requestAnimationFrame(center));
  }, [isDisplayMode, reactFlow, setEdges, setNodes]);

  const lockCurrentViewport = useCallback(() => {
    const viewport = reactFlow.getViewport();
    const normalized = {
      x: Number(viewport.x) || 0,
      y: Number(viewport.y) || 0,
      zoom: Math.min(Math.max(Number(viewport.zoom) || 1, 0.1), 4),
    };
    if (isDisplayMode) {
      const next = {
        ...displayPageRef.current,
        viewport: normalized,
      };
      displayPageRef.current = next;
      setDisplayPage(next);
      setStatus("已固定 Display 进入视角");
    } else {
      workspaceViewportRef.current = normalized;
      setWorkspaceViewport(normalized);
      setStatus("已固定 Workspace 进入视角");
    }
    saveGraph(nodesRef.current, edgesRef.current).catch((e) => setStatus(String(e.message || e)));
  }, [isDisplayMode, reactFlow, saveGraph]);

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

  const quickAddFlowItems = useMemo(() => {
    const q = quickAddSearch.trim().toLowerCase();
    return flowSnippets
      .filter((snippet) => !q || [
        snippet.id,
        snippet.version,
        snippet.displayName,
        snippet.name,
        snippet.description,
        ...(Array.isArray(snippet.tags) ? snippet.tags : []),
      ].some((value) => String(value || "").toLowerCase().includes(q)))
      .sort((a, b) => String(a.displayName || a.name || a.id).localeCompare(String(b.displayName || b.name || b.id)))
      .slice(0, 30);
  }, [flowSnippets, quickAddSearch]);

  useEffect(() => {
    setQuickAddActiveIndex(0);
  }, [quickAddSearch, quickAddOpen, quickAddMode]);

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
  useEffect(() => {
    setCollapsedSkillCollections((current) => {
      let changed = false;
      const next = new Set(current);
      for (const group of skillCollectionGroups.groups) {
        if (!next.has(group.id)) {
          next.add(group.id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [skillCollectionGroups.groups]);

  const selectedCanvasNodes = useMemo(() => {
    const selected = nodes.filter((node) => node.selected);
    if (selected.length > 0) return selected;
    return selectedNodeId ? nodes.filter((node) => node.id === selectedNodeId) : [];
  }, [nodes, selectedNodeId]);

  const selectedCanvasNodeIds = useMemo(() => selectedCanvasNodes.map((node) => node.id), [selectedCanvasNodes]);

  const workspaceDisplayNodes = useMemo(
    () => nodes.filter((node) => displayKind(node?.data?.definitionId)),
    [nodes],
  );

  const selectedWorkspaceDisplayNodeIds = useMemo(
    () => selectedCanvasNodes.filter((node) => displayKind(node?.data?.definitionId)).map((node) => node.id),
    [selectedCanvasNodes],
  );

  const authInitial = useMemo(() => {
    const name = String(authUser?.username || authUser?.userId || "").trim();
    return name ? name.slice(0, 1).toUpperCase() : "?";
  }, [authUser]);

  const selectedCanvasNodeIdSet = useMemo(() => new Set(selectedCanvasNodeIds), [selectedCanvasNodeIds]);

  const selectedCanvasInternalEdges = useMemo(
    () => edges.filter((edge) => selectedCanvasNodeIdSet.has(edge.source) && selectedCanvasNodeIdSet.has(edge.target)),
    [edges, selectedCanvasNodeIdSet],
  );

  const switchWorkspaceMode = useCallback((mode) => {
    const nextMode = mode === "display" ? "display" : "workspace";
    setWorkspaceMode(nextMode);
    setSelectedNodeId("");
    setSelectedDisplayNodeIds([]);
    setConnectionMenu(null);
    setQuickAddOpen(false);
    setDisplayPickerOpen(false);
    const q = flowParamsQuery(flowParams);
    if (nextMode === "display") q.set("view", "display");
    const url = `/workspace${q.toString() ? `?${q.toString()}` : ""}`;
    window.history.pushState({}, "", url);
  }, [flowParams]);

  const addDisplayPageNode = useCallback((sourceId) => {
    const id = String(sourceId || "").trim();
    if (!id) return;
    const sourceNode = nodesRef.current.find((node) => node.id === id);
    if (!sourceNode || !displayKind(sourceNode.data?.definitionId)) {
      setStatus("展示节点不可用");
      return;
    }
    setDisplayPage((prev) => {
      if (prev.nodeIds.includes(id)) return prev;
      const nextIndex = prev.nodeIds.length;
      const sourceSize = persistedWorkspaceNodeSize(sourceNode);
      return {
        nodeIds: [...prev.nodeIds, id],
        nodePositions: {
          ...prev.nodePositions,
          [id]: { x: 180 + nextIndex * 36, y: 120 + nextIndex * 28 },
        },
        nodeSizes: {
          ...prev.nodeSizes,
          ...(sourceSize ? { [id]: sourceSize } : {}),
        },
      };
    });
    setSelectedDisplayNodeIds([id]);
  }, []);

  const removeDisplayPageNode = useCallback((sourceId) => {
    const id = String(sourceId || "").trim();
    if (!id) return;
    setDisplayPage((prev) => {
      const nodeIds = prev.nodeIds.filter((item) => item !== id);
      const nodePositions = { ...prev.nodePositions };
      const nodeSizes = { ...prev.nodeSizes };
      delete nodePositions[id];
      delete nodeSizes[id];
      return { nodeIds, nodePositions, nodeSizes };
    });
    setSelectedDisplayNodeIds((ids) => ids.filter((item) => item !== id));
  }, []);

  const toggleDisplayPageNode = useCallback((sourceId) => {
    const id = String(sourceId || "").trim();
    if (!id) return;
    if (displayPageRef.current.nodeIds.includes(id)) removeDisplayPageNode(id);
    else addDisplayPageNode(id);
  }, [addDisplayPageNode, removeDisplayPageNode]);

  const filteredAvailableDisplayNodes = useMemo(() => {
    const q = displayPickerSearch.trim().toLowerCase();
    if (!q) return availableDisplayNodes;
    return availableDisplayNodes.filter((node) =>
      [node.id, node.data?.label, node.data?.definitionId]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q))
    );
  }, [availableDisplayNodes, displayPickerSearch]);

  const displayPickerColumns = useMemo(() => {
    const count = filteredAvailableDisplayNodes.length;
    const columnCount = count <= 1 ? 1 : count <= 4 ? 2 : 3;
    const columns = Array.from({ length: columnCount }, () => ({ height: 0, nodes: [] }));
    for (const node of filteredAvailableDisplayNodes) {
      const previewSize = persistedWorkspaceNodeSize(node) || { width: 420, height: 260 };
      const width = Math.max(1, Number(previewSize.width) || 420);
      const height = Math.max(1, Number(previewSize.height) || 260);
      const estimatedHeight = Math.min(26, Math.max(5.5, (height / width) * 16)) + 3.2;
      let target = columns[0];
      for (const column of columns) {
        if (column.height < target.height) target = column;
      }
      target.nodes.push(node);
      target.height += estimatedHeight;
    }
    return columns.map((column) => column.nodes);
  }, [filteredAvailableDisplayNodes]);

  const renderDisplayPickerCard = useCallback((node) => {
    const checked = displayPage.nodeIds.includes(node.id);
    const previewSize = persistedWorkspaceNodeSize(node) || { width: 420, height: 260 };
    const previewWidth = Math.max(1, Math.round(Number(previewSize.width) || 420));
    const previewHeight = Math.max(1, Math.round(Number(previewSize.height) || 260));
    return (
      <button
        key={node.id}
        type="button"
        className={"af-display-picker-card" + (checked ? " af-display-picker-card--selected" : "")}
        style={{ "--af-display-picker-card-ratio": `${previewWidth} / ${previewHeight}` }}
        onClick={() => toggleDisplayPageNode(node.id)}
      >
        <span className="af-display-picker-card__check" aria-hidden>
          <input type="checkbox" checked={checked} readOnly tabIndex={-1} />
        </span>
        <span className="af-display-picker-card__preview">
          <DisplayPickerPreview node={node} />
        </span>
        <span className="af-display-picker-card__meta">
          <strong>{node.data?.label || node.id}</strong>
          <small>{displayKind(node.data?.definitionId)} · {node.id}</small>
        </span>
      </button>
    );
  }, [displayPage.nodeIds, toggleDisplayPageNode]);

  const filteredFlowSnippets = useMemo(() => {
    const q = paletteSearch.trim().toLowerCase();
    if (!q) return flowSnippets;
    return flowSnippets.filter((snippet) =>
      [
        snippet.id,
        snippet.version,
        snippet.displayName,
        snippet.name,
        snippet.description,
        ...(Array.isArray(snippet.tags) ? snippet.tags : []),
      ]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q)),
    );
  }, [flowSnippets, paletteSearch]);

  const makeUniqueSnippetNodeId = useCallback((base, used) => {
    const clean = String(base || "snippet_node")
      .trim()
      .replace(/[^a-zA-Z0-9_]+/g, "_")
      .replace(/^_+|_+$/g, "") || "snippet_node";
    let id = `${clean}_${Date.now().toString(36)}`;
    let index = 2;
    while (used.has(id)) {
      id = `${clean}_${Date.now().toString(36)}_${index}`;
      index += 1;
    }
    used.add(id);
    return id;
  }, []);

  const insertFlowSnippet = useCallback((snippetEntry, positionOverride) => {
    if (!workspaceWritable) {
      setStatus("Readonly workspace");
      return;
    }
    const snippet = snippetEntry?.snippet && typeof snippetEntry.snippet === "object" ? snippetEntry.snippet : {};
    const sourceInstances = snippet.instances && typeof snippet.instances === "object" ? snippet.instances : {};
    const oldIds = Object.keys(sourceInstances);
    if (oldIds.length === 0) return;

    const used = new Set(nodesRef.current.map((node) => node.id));
    const idMap = {};
    for (const oldId of oldIds) idMap[oldId] = makeUniqueSnippetNodeId(oldId, used);

    const sourcePositions = snippet.ui?.nodePositions && typeof snippet.ui.nodePositions === "object"
      ? snippet.ui.nodePositions
      : {};
    const sourceSizes = snippet.ui?.nodeSizes && typeof snippet.ui.nodeSizes === "object"
      ? snippet.ui.nodeSizes
      : {};
    const points = oldIds.map((id) => {
      const pos = sourcePositions[id];
      return {
        id,
        x: typeof pos?.x === "number" ? pos.x : 0,
        y: typeof pos?.y === "number" ? pos.y : 0,
      };
    });
    const minX = Math.min(...points.map((point) => point.x));
    const minY = Math.min(...points.map((point) => point.y));
    let insertAt = positionOverride || { x: 360 + nodesRef.current.length * 24, y: 180 + nodesRef.current.length * 18 };
    if (!positionOverride) {
      const wrap = document.querySelector(".af-workspace-canvas .react-flow");
      if (wrap) {
        const rect = wrap.getBoundingClientRect();
        insertAt = reactFlow.screenToFlowPosition({
          x: rect.left + rect.width * 0.48,
          y: rect.top + rect.height * 0.32,
        });
      }
    }

    const nextInstances = {};
    const nodePositions = {};
    const nodeSizes = {};
    for (const point of points) {
      const nextId = idMap[point.id];
      nextInstances[nextId] = { ...(sourceInstances[point.id] || {}) };
      nodePositions[nextId] = {
        x: insertAt.x + (point.x - minX),
        y: insertAt.y + (point.y - minY),
      };
      const size = sourceSizes[point.id];
      if (typeof size?.width === "number" && typeof size?.height === "number") {
        nodeSizes[nextId] = { width: size.width, height: size.height };
      }
    }

    const oldIdSet = new Set(oldIds);
    const nextEdges = (Array.isArray(snippet.edges) ? snippet.edges : [])
      .filter((edge) => oldIdSet.has(edge?.source) && oldIdSet.has(edge?.target))
      .map((edge) => ({
        source: idMap[edge.source],
        target: idMap[edge.target],
        sourceHandle: edge.sourceHandle ?? null,
        targetHandle: edge.targetHandle ?? null,
      }));

    const flow = graphToFlow({ instances: nextInstances, edges: nextEdges, ui: { nodePositions, nodeSizes } }, palette);
    const insertedNodes = flow.nodes.map((node) => ({ ...node, selected: true }));
    instancesRef.current = { ...instancesRef.current, ...flow.instances };
    setInstances(instancesRef.current);
    setNodes((list) => [...list.map((node) => ({ ...node, selected: false })), ...insertedNodes]);
    setEdges((list) => [...list.map((edge) => ({ ...edge, selected: false })), ...flow.edges]);
    setStatus(`已添加流程片段：${snippetEntry.displayName || snippetEntry.id}`);
  }, [makeUniqueSnippetNodeId, palette, reactFlow, setEdges, setNodes, workspaceWritable]);

  const openPublishSnippetDialog = useCallback(() => {
    if (selectedCanvasNodes.length < 2) {
      setFlowSnippetsError("请先在 workspace 画布上选择至少两个节点。");
      setPaletteMode("flows");
      return;
    }
    const first = selectedCanvasNodes[0];
    const fallbackName =
      selectedCanvasNodes.length === 2
        ? `${first.data?.label || first.id} 片段`
        : `${first.data?.label || first.id} 等 ${selectedCanvasNodes.length} 个节点`;
    setPublishSnippetDraft({
      name: fallbackName,
      id: fallbackName.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, ""),
      description: "",
    });
    setPublishSnippetError("");
    setPublishSnippetOpen(true);
    setPaletteMode("flows");
  }, [selectedCanvasNodes]);

  const publishSelectedFlowSnippet = useCallback(async () => {
    if (selectedCanvasNodes.length < 2) return;
    const name = publishSnippetDraft.name.trim();
    if (!name) {
      setPublishSnippetError("请填写片段名称。");
      return;
    }
    const nodePositions = {};
    const nodeSizes = {};
    for (const node of selectedCanvasNodes) {
      nodePositions[node.id] = { x: node.position?.x || 0, y: node.position?.y || 0 };
      const size = persistedWorkspaceNodeSize(node);
      if (size) nodeSizes[node.id] = size;
    }
    const snippetEdges = selectedCanvasInternalEdges.map((edge) => ({
      source: edge.source,
      target: edge.target,
      sourceHandle: edge.sourceHandle ?? null,
      targetHandle: edge.targetHandle ?? null,
    }));
    setPublishSnippetBusy(true);
    setPublishSnippetError("");
    try {
      const res = await fetch("/api/marketplace/publish-flow-snippet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: publishSnippetDraft.id,
          name,
          displayName: name,
          version: "1.0.0",
          description: publishSnippetDraft.description,
          snippet: {
            instances: buildInstancesForYaml(selectedCanvasNodes, instancesRef.current),
            edges: snippetEdges,
            ui: { nodePositions, nodeSizes },
          },
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.ok === false) throw new Error(json.error || "发布流程片段失败");
      setPublishSnippetOpen(false);
      setStatus(`流程片段已发布：${json.id || name}`);
      showFlowSnippetToast(`流程片段已发布：${json.id || name}`);
      await loadFlowSnippets();
      setPaletteMode("flows");
    } catch (e) {
      setPublishSnippetError(String(e.message || e));
    } finally {
      setPublishSnippetBusy(false);
    }
  }, [loadFlowSnippets, publishSnippetDraft, selectedCanvasInternalEdges, selectedCanvasNodes, showFlowSnippetToast]);

  const openDisplayShareDialog = useCallback(() => {
    if (workspaceDisplayNodes.length === 0) {
      setStatus("当前 workspace 没有 display 节点");
      return;
    }
    const defaultNodeIds = selectedWorkspaceDisplayNodeIds.length > 0 ? selectedWorkspaceDisplayNodeIds : workspaceDisplayNodes.map((node) => node.id);
    const title = flowParams.flowId ? `${flowParams.flowId} 展示页` : "AgentFlow Display";
    setDisplayShareDraft({ title, layout: "gallery", nodeIds: defaultNodeIds });
    setDisplayShareError("");
    setDisplayShareResult(null);
    setDisplayShareOpen(true);
  }, [flowParams.flowId, selectedWorkspaceDisplayNodeIds, workspaceDisplayNodes]);

  const toggleDisplayShareNode = useCallback((nodeId) => {
    setDisplayShareDraft((prev) => {
      const current = Array.isArray(prev.nodeIds) ? prev.nodeIds : [];
      return current.includes(nodeId)
        ? { ...prev, nodeIds: current.filter((id) => id !== nodeId) }
        : { ...prev, nodeIds: [...current, nodeId] };
    });
  }, []);

  const publishDisplayShare = useCallback(async () => {
    const title = displayShareDraft.title.trim();
    const nodeIds = Array.isArray(displayShareDraft.nodeIds) ? displayShareDraft.nodeIds : [];
    if (nodeIds.length === 0) {
      setDisplayShareError("请选择至少一个 display 节点。");
      return;
    }
    setDisplayShareBusy(true);
    setDisplayShareError("");
    setDisplayShareResult(null);
    try {
      await saveGraph(nodes, edges);
      const res = await fetch("/api/display/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...flowParams,
          title,
          layout: displayShareDraft.layout,
          nodeIds,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.ok === false) throw new Error(json.error || "发布展示页失败");
      const absoluteUrl = new URL(json.url || `/display/${json.share?.id || ""}`, window.location.origin).href;
      setDisplayShareResult({ ...json, absoluteUrl });
      setStatus("展示页已生成");
    } catch (e) {
      setDisplayShareError(String(e.message || e));
    } finally {
      setDisplayShareBusy(false);
    }
  }, [displayShareDraft, edges, flowParams, nodes, saveGraph]);

  const publishCurrentDisplayPage = useCallback(async () => {
    const nodeIds = Array.isArray(displayPage.nodeIds) ? displayPage.nodeIds : [];
    if (nodeIds.length === 0) {
      setDisplayShareError("请先添加至少一个展示节点。");
      setStatus("请先添加至少一个展示节点");
      setDisplayPickerOpen(true);
      return;
    }
    setDisplayShareBusy(true);
    setDisplayShareError("");
    try {
      await saveGraph(nodes, edges);
      const title = flowParams.flowId ? `${flowParams.flowId} 展示页` : "AgentFlow Display";
      const res = await fetch("/api/display/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...flowParams,
          title,
          layout: "canvas",
          nodeIds,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.ok === false) throw new Error(json.error || "生成展示链接失败");
      const absoluteUrl = new URL(json.url || `/display/${json.share?.id || ""}`, window.location.origin).href;
      setDisplayShareResult({ ...json, absoluteUrl });
      setDisplayLinkOpen(true);
      setStatus("展示链接已生成");
    } catch (e) {
      const message = String(e.message || e);
      setDisplayShareError(message);
      setStatus(message);
    } finally {
      setDisplayShareBusy(false);
    }
  }, [displayPage.nodeIds, edges, flowParams, nodes, saveGraph]);

  const copyDisplayShareUrl = useCallback(async () => {
    const url = displayShareResult?.absoluteUrl;
    if (!url) return;
    const ok = await copyTextToClipboard(url);
    setDisplayLinkCopyState(ok ? "copied" : "failed");
    window.setTimeout(() => setDisplayLinkCopyState(""), 1600);
  }, [displayShareResult?.absoluteUrl]);

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
    if (workspaceMode === "display") {
      const nextSelected = [];
      let shouldUpdateLayout = false;
      setDisplayPage((prev) => {
        const nodePositions = { ...prev.nodePositions };
        const nodeSizes = { ...prev.nodeSizes };
        for (const change of changes || []) {
          const sourceId = sourceIdFromDisplayRefId(change?.id);
          if (!sourceId || !prev.nodeIds.includes(sourceId)) continue;
          if (change.type === "select") {
            if (change.selected) nextSelected.push(sourceId);
            continue;
          }
          if (change.type === "position" && change.position) {
            nodePositions[sourceId] = { x: change.position.x, y: change.position.y };
            shouldUpdateLayout = true;
            continue;
          }
          if (change.type === "dimensions" && change.dimensions?.width && change.dimensions?.height) {
            const size = normalizeWorkspaceNodeSize({
              width: Math.round(Number(change.dimensions.width)),
              height: Math.round(Number(change.dimensions.height)),
            }, { display: true });
            if (size) {
              nodeSizes[sourceId] = size;
              shouldUpdateLayout = true;
            }
          }
        }
        return shouldUpdateLayout ? { ...prev, nodePositions, nodeSizes } : prev;
      });
      if ((changes || []).some((change) => change?.type === "select")) {
        setSelectedDisplayNodeIds(nextSelected);
      }
      return;
    }
    if (!workspaceWritable) {
      const selectionChanges = (changes || []).filter((change) => change?.type === "select");
      if (selectionChanges.length > 0) {
        setNodes((current) => applyNodeChanges(selectionChanges, current));
      }
      return;
    }
    const resized = new Map();
    for (const change of changes || []) {
      if (change?.type === "dimensions" && change.dimensions?.width && change.dimensions?.height) {
        const node = nodes.find((item) => item.id === change.id);
        const isDisplay = Boolean(displayKind(node?.data?.definitionId));
        const size = normalizeWorkspaceNodeSize({
          width: Math.round(Number(change.dimensions.width)),
          height: Math.round(Number(change.dimensions.height)),
        }, { display: isDisplay });
        if (size) resized.set(change.id, size);
      }
    }
    const resizedIds = Array.from(resized.keys());
    setNodes((current) => applyNodeChanges(changes, current).map((node) => {
      const size = resized.get(node.id);
      if (!size) return node;
      if (!displayKind(node.data?.definitionId)) {
        return {
          ...node,
          width: size.width,
          height: size.height,
          data: {
            ...node.data,
            nodeSize: size,
          },
        };
      }
      return {
        ...node,
        width: size.width,
        height: size.height,
        data: {
          ...node.data,
          nodeSize: size,
          displaySize: size,
        },
      };
    }));
    if (resizedIds.length > 0) {
      const refresh = () => resizedIds.forEach((id) => updateNodeInternals(id));
      window.requestAnimationFrame(refresh);
      window.setTimeout(refresh, 80);
    }
  }, [nodes, setNodes, updateNodeInternals, workspaceMode, workspaceWritable]);

  const handleEdgesChange = useCallback((changes) => {
    if (workspaceMode === "display") return;
    if (!workspaceWritable) {
      const selectionChanges = (changes || []).filter((change) => change?.type === "select");
      if (selectionChanges.length > 0) {
        setEdges((current) => applyEdgeChanges(selectionChanges, current));
      }
      return;
    }
    rawOnEdgesChange(changes);
  }, [rawOnEdgesChange, setEdges, workspaceMode, workspaceWritable]);

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
    if (!workspaceWritable) {
      setStatus("Readonly workspace");
      return null;
    }
    if (!def) return null;
    const runtimeDefinitionId = runtimeDefinitionIdForPalette(def) || def.id;
    const marketplaceRef = marketplaceRefForDefinition(def);
    const id = overrides.id || nextNodeId(runtimeDefinitionId, nodes);
    const input = cloneSlots(def.inputs);
    const output = cloneSlots(def.outputs);
    const instance = {
      definitionId: runtimeDefinitionId,
      ...(marketplaceRef ? { marketplaceRef } : {}),
      ...(def.packageId ? { marketplacePackageId: def.packageId } : {}),
      ...(def.version ? { marketplaceVersion: def.version } : {}),
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
        definitionId: runtimeDefinitionId,
        ...(marketplaceRef ? { marketplaceRef } : {}),
        ...(def.packageId ? { marketplacePackageId: def.packageId } : {}),
        ...(def.version ? { marketplaceVersion: def.version } : {}),
        schemaType: schemaTypeForDefinition(runtimeDefinitionId, def),
        role: "normal",
        body: instance.body,
        inputs: instance.input,
        outputs: instance.output,
      },
    };
    const merged = { ...mergeNodeWithPalette(node, { ...instancesRef.current, [id]: instance }, palette), selected: true };
    setNodes((list) => [...list.map((item) => ({ ...item, selected: false })), merged]);
    if (overrides.openProperties) setSelectedNodeId(id);
    return id;
  }, [defaultWorkspaceNodePosition, nodes, palette, setNodes, workspaceWritable]);

  const isValidConnection = useCallback((params) => workspaceConnectionCompatible(params, nodesRef.current), []);

  const handleConnect = useCallback((params) => {
    if (!workspaceWritable) {
      setStatus("Readonly workspace");
      return;
    }
    if (!workspaceConnectionCompatible(params, nodesRef.current)) {
      setStatus("端口类型不匹配，已取消连线");
      return;
    }
    setConnectionMenu(null);
    setNodes((current) => revealConnectedSlots(current, params));
    setEdges((current) => {
      const filtered = current.filter(
        (edge) => !(edge.target === params.target && edge.targetHandle === params.targetHandle)
      );
      return addEdge({ ...params, markerEnd: { type: MarkerType.ArrowClosed } }, filtered);
    });
  }, [setEdges, setNodes, workspaceWritable]);

  const handleConnectStart = useCallback((_, params) => {
    if (!workspaceWritable) return;
    connectionStartRef.current = buildWorkspaceConnectionDraft(params, nodesRef.current);
    setConnectionMenu(null);
  }, [workspaceWritable]);

  const handleConnectEnd = useCallback((event, connectionState) => {
    if (!workspaceWritable) return;
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
  }, [palette, reactFlow, workspaceWritable]);

  const handleConnectionMenuSelect = useCallback((candidate) => {
    if (!workspaceWritable) {
      setStatus("Readonly workspace");
      setConnectionMenu(null);
      return;
    }
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
    setNodes((current) => revealConnectedSlots(current, nextConnection));
    setEdges((current) => {
      const filtered = current.filter(
        (edge) => !(edge.target === nextConnection.target && edge.targetHandle === nextConnection.targetHandle)
      );
      return addEdge({ ...nextConnection, markerEnd: { type: MarkerType.ArrowClosed } }, filtered);
    });
    setConnectionMenu(null);
  }, [addNodeFromDefinition, setEdges, workspaceWritable]);

  const addQuickNode = useCallback((def) => {
    if (!def) return;
    addNodeFromDefinition(def, { position: quickAddNodePosition() });
    setQuickAddOpen(false);
    setQuickAddSearch("");
  }, [addNodeFromDefinition, quickAddNodePosition]);

  const addQuickFlowSnippet = useCallback((snippet) => {
    if (!snippet) return;
    insertFlowSnippet(snippet, quickAddNodePosition());
    setQuickAddOpen(false);
    setQuickAddSearch("");
  }, [insertFlowSnippet, quickAddNodePosition]);

  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.defaultPrevented) return;
      const editable = isEditableFocus(event.target) || isEditableShortcutTarget(event.target);
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        saveGraph().catch((e) => setStatus(String(e.message || e)));
        return;
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        event.stopPropagation();
        setJumpPaletteOpen((open) => !open);
        return;
      }
      if (jumpPaletteOpen) return;
      if (shortcutsOpen) {
        if (event.key === "Escape" || isQuestionMarkShortcut(event)) {
          event.preventDefault();
          setShortcutsOpen(false);
        }
        return;
      }
      const shortcutKey = event.key.toLowerCase();
      const copyShortcut = (event.metaKey || event.ctrlKey) && shortcutKey === "c";
      const pasteShortcut = (event.metaKey || event.ctrlKey) && shortcutKey === "v";
      const useCanvasCopyFromEditable = editable && copyShortcut && shouldUseCanvasCopyFromEditable(event.target);
      if (editable && !useCanvasCopyFromEditable) return;
      const wantsUndo = (event.metaKey || event.ctrlKey) && !event.shiftKey && shortcutKey === "z";
      const wantsRedo =
        (event.metaKey || event.ctrlKey) &&
        ((event.shiftKey && shortcutKey === "z") || shortcutKey === "y");
      if (wantsUndo || wantsRedo) {
        if (isDisplayMode) {
          event.preventDefault();
          event.stopPropagation();
          setStatus("展示页布局会自动保存");
          return;
        }
        if (!workspaceWritable) {
          event.preventDefault();
          setStatus("Readonly workspace");
          return;
        }
        event.preventDefault();
        event.stopPropagation();
        const changed = wantsUndo ? undoCanvas() : redoCanvas();
        setStatus(changed ? (wantsUndo ? "Undo canvas change" : "Redo canvas change") : (wantsUndo ? "Nothing to undo" : "Nothing to redo"));
        return;
      }
      if (copyShortcut) {
        if (isDisplayMode) return;
        const selectedId = selectedNodeIdRef.current;
        const sourceNodes = (nodesRef.current || []).some((node) => node?.selected)
          ? nodesRef.current
          : (nodesRef.current || []).map((node) => (
              selectedId && node.id === selectedId ? { ...node, selected: true } : node
            ));
        const clip = buildCanvasClipboard(sourceNodes, edgesRef.current, instancesRef.current);
        if (clip) {
          event.preventDefault();
          event.stopPropagation();
          canvasClipboardRef.current = clip;
          if (useCanvasCopyFromEditable && typeof event.target?.blur === "function") event.target.blur();
          setStatus(`Copied ${clip.nodes.length} node${clip.nodes.length > 1 ? "s" : ""}`);
        }
        return;
      }
      if (pasteShortcut) {
        if (isDisplayMode) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        if (!workspaceWritable) {
          event.preventDefault();
          setStatus("Readonly workspace");
          return;
        }
        const pasted = pasteCanvasClipboard(canvasClipboardRef.current, nodesRef.current, edgesRef.current, instancesRef.current);
        if (pasted) {
          event.preventDefault();
          event.stopPropagation();
          instancesRef.current = pasted.instances;
          setInstances(pasted.instances);
          setNodes(pasted.nodes);
          setEdges(pasted.edges);
          setStatus(`Pasted ${pasted.pastedNodeIds.length} node${pasted.pastedNodeIds.length > 1 ? "s" : ""}`);
        }
        return;
      }
      if (isQuestionMarkShortcut(event) && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        setShortcutsOpen(true);
        return;
      }
      if (event.key === "a" || event.key === "A") {
        if (event.metaKey || event.ctrlKey) {
          event.preventDefault();
          if (isDisplayMode) {
            setSelectedDisplayNodeIds(displayPageRef.current.nodeIds);
          } else {
            setNodes((list) => list.map((node) => ({ ...node, selected: true })));
            setEdges((list) => list.map((edge) => ({ ...edge, selected: false })));
          }
          return;
        }
        if (event.altKey) return;
        if (isDisplayMode) {
          event.preventDefault();
          setDisplayPickerOpen(true);
          return;
        }
        if (!workspaceWritable) {
          event.preventDefault();
          setStatus("Readonly workspace");
          return;
        }
        event.preventDefault();
        setQuickAddOpen(true);
        return;
      }
      if ((event.key === "v" || event.key === "V") && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        setCanvasTool("select");
        return;
      }
      if ((event.key === "h" || event.key === "H") && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        setCanvasTool("pan");
        return;
      }
      if ((event.key === "f" || event.key === "F") && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        lockCurrentViewport();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [isDisplayMode, jumpPaletteOpen, lockCurrentViewport, redoCanvas, saveGraph, shortcutsOpen, setEdges, setNodes, undoCanvas, workspaceWritable]);

  const toggleDir = useCallback((dirPath) => {
    setCollapsedDirs((prev) => {
      const next = new Set(prev);
      if (next.has(dirPath)) next.delete(dirPath);
      else next.add(dirPath);
      return next;
    });
  }, []);

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

  const addDisplayFromFile = useCallback(async (item, position) => {
    const fileName = String(item?.name || item?.path || "").toLowerCase();
    const ext = fileName.split(".").pop();
    const displayDefinitionId = ext === "html"
      ? "display_html"
      : ext === "csv" || ext === "tsv" || (ext === "json" && /\b(table|data|rows|report)\b/i.test(fileName))
        ? "display_table"
      : ["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(ext)
        ? "display_image"
        : "display_markdown";
    const def = palette.find((node) => node.id === displayDefinitionId);
    if (!def) {
      setStatus("展示节点不可用");
      return;
    }
    const isImageDisplay = displayDefinitionId === "display_image";
    let content = String(item.path || "");
    if (!isImageDisplay) {
      const q = flowParamsQuery(flowParams);
      q.set("path", item.path);
      const res = await fetch(`/api/workspace/file?${q.toString()}`);
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "读取文件失败");
      content = String(json.content || "");
    }
    const primaryName = displayDefinitionId === "display_image" ? "src" : "content";
    const inputs = cloneSlots(def.inputs).map((slot) => (
      slot.name === primaryName ? { ...slot, default: content, value: content } : slot
    ));
    const outputs = cloneSlots(def.outputs).map((slot) => (
      slot.name === primaryName ? { ...slot, default: content, value: content } : slot
    ));
    addNodeFromDefinition(def, {
      label: item.name || "Display",
      body: content,
      inputs,
      outputs,
      position,
    });
    setStatus(`已创建展示：${item.path}`);
  }, [addNodeFromDefinition, flowParams, palette]);

  const openFileNode = useCallback((item) => {
    if (!workspaceWritable) {
      setStatus("Readonly workspace");
      return;
    }
    addDisplayFromFile(item, defaultWorkspaceNodePosition()).catch((e) => setStatus(String(e.message || e)));
  }, [addDisplayFromFile, defaultWorkspaceNodePosition, workspaceWritable]);

  const handleWorkspaceDrop = useCallback((event) => {
    if (!workspaceWritable) {
      event.preventDefault();
      setStatus("Readonly workspace");
      return;
    }
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
      addDisplayFromFile(item, position).catch((e) => setStatus(String(e.message || e)));
      return;
    }

    const snippetKey = event.dataTransfer.getData("application/agentflow-snippet");
    if (snippetKey) {
      const snippet = flowSnippets.find((item) => `${item.id}@${item.version}` === snippetKey);
      if (!snippet) return;
      event.preventDefault();
      const position = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      insertFlowSnippet(snippet, position);
      return;
    }

    const defId = event.dataTransfer.getData("application/agentflow-node");
    if (!defId) return;
    const def = palette.find((node) => node.id === defId);
    if (!def) return;
    event.preventDefault();
    const position = reactFlow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    addNodeFromDefinition(def, { position });
  }, [addDisplayFromFile, addNodeFromDefinition, flowSnippets, insertFlowSnippet, palette, reactFlow, workspaceWritable]);

  const handleWorkspaceDragOver = useCallback((event) => {
    if (!workspaceWritable) return;
    const types = Array.from(event.dataTransfer.types || []);
    if (
      !types.includes("application/x-agentflow-workspace-file") &&
      !types.includes("application/agentflow-node") &&
      !types.includes("application/agentflow-snippet")
    ) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = types.includes("application/agentflow-node") || types.includes("application/agentflow-snippet") ? "move" : "copy";
  }, [workspaceWritable]);

  const createWorkspaceFile = useCallback(async (baseDir = "") => {
    if (!workspaceWritable) {
      setStatus("Readonly workspace");
      return;
    }
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
      await loadFiles();
      setCollapsedDirs((prev) => {
        const next = new Set(prev);
        for (const dir of parentDirectoryPaths(json.path || relPath)) next.delete(dir);
        return next;
      });
      setStatus(`已创建 ${json.path}`);
    } catch (e) {
      setStatus(String(e.message || e));
    }
  }, [flowParams, loadFiles, workspaceWritable]);

  const createWorkspaceFolder = useCallback(async (baseDir = "") => {
    if (!workspaceWritable) {
      setStatus("Readonly workspace");
      return;
    }
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
      await loadFiles();
      setCollapsedDirs((prev) => {
        const next = new Set(prev);
        for (const dir of parentDirectoryPaths(json.path || relPath)) next.delete(dir);
        if (json.path) next.delete(json.path);
        return next;
      });
      setStatus(`已创建 ${json.path}`);
    } catch (e) {
      setStatus(String(e.message || e));
    }
  }, [flowParams, loadFiles, workspaceWritable]);

  const deleteWorkspacePath = useCallback(async (item) => {
    if (!workspaceWritable) {
      setStatus("Readonly workspace");
      return;
    }
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
  }, [flowParams, loadFiles, workspaceWritable]);

  const submitWorkspaceAi = useCallback(async () => {
    if (!workspaceWritable) {
      setStatus("Readonly workspace");
      return;
    }
    const prompt = composerText.trim();
    if (!prompt || composerRunning) return;
    const graph = flowToGraph(nodes, edges, instancesRef.current);
    setComposerText("");
    setComposerRunning(true);
    openComposerLogPanel("workspace");
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
          allowFlowYaml: false,
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
  }, [composerModel, composerRunning, composerText, edges, flowParams, loadWorkspace, nodes, openComposerLogPanel, saveGraph, selectedCanvasNodeIds, selectedSkills, workspaceWritable]);

  const activeRunSession = composerRunSessions.find((session) => session.id === activeComposerSessionId) || null;
  const activeComposerMessages = activeRunSession ? (Array.isArray(activeRunSession.messages) ? activeRunSession.messages : []) : composerMessages;
  const activeComposerRunning = activeRunSession ? activeRunSession.status === "running" : composerRunning;
  const activeComposerStatus = activeRunSession
    ? activeRunSession.status === "running"
      ? `${activeRunSession.label} running`
      : activeRunSession.status === "paused"
        ? `${activeRunSession.label} paused`
        : activeRunSession.status === "failed"
          ? `${activeRunSession.label} failed`
          : `${activeRunSession.label} done`
    : composerRunning
      ? "Workspace agent running"
      : composerMessages.length > 0
        ? "Workspace conversation"
        : "Ready";

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
            <button
              type="button"
              className={workspaceMode === "workspace" ? "af-view-switch__active" : ""}
              onClick={() => switchWorkspaceMode("workspace")}
            >
              Workspace
            </button>
            <button
              type="button"
              className={workspaceMode === "display" ? "af-view-switch__active" : ""}
              onClick={() => switchWorkspaceMode("display")}
            >
              Display
            </button>
          </div>
        </div>
        <div className="af-pipeline-top-right af-workspace-actions">
          <span className="af-workspace-save-status">{status}</span>
          {isDisplayMode ? (
            <>
              <button
                type="button"
                className="af-workspace-display-share-btn"
                disabled={displayShareBusy || (!displayShareResult?.absoluteUrl && displayPage.nodeIds.length === 0)}
                onClick={() => {
                  setDisplayLinkCopyState("");
                  if (displayShareResult?.absoluteUrl) setDisplayLinkOpen(true);
                  else void publishCurrentDisplayPage();
                }}
                title={displayShareResult?.absoluteUrl ? "查看展示链接" : displayPage.nodeIds.length === 0 ? "先添加展示节点" : "生成展示链接"}
              >
                <span className="material-symbols-outlined" aria-hidden>{displayShareBusy ? "hourglass_empty" : "ios_share"}</span>
                {displayShareBusy ? "生成中" : displayShareResult?.absoluteUrl ? "展示链接" : "生成链接"}
              </button>
              <button
                type="button"
                className="af-workspace-display-share-btn"
                disabled={availableDisplayNodes.length === 0}
                onClick={() => setDisplayPickerOpen(true)}
                title={availableDisplayNodes.length === 0 ? "当前 workspace 没有 display 节点" : "选择展示节点 (A)"}
              >
                <span className="material-symbols-outlined" aria-hidden>add_to_photos</span>
                添加展示
              </button>
            </>
          ) : null}
          <button
            type="button"
            className="af-icon-btn"
            onClick={() => setShortcutsOpen(true)}
            aria-label="快捷键"
            title="快捷键 (?)"
          >
            <span className="material-symbols-outlined">help</span>
          </button>
          <button
            type="button"
            className={"af-composer-topbar-btn" + (composerSidebarOpen ? " af-composer-topbar-btn--active" : "") + (composerRunning ? " af-composer-topbar-btn--running" : "")}
            disabled={isDisplayMode}
            onClick={() => setComposerSidebarOpen((v) => !v)}
          >
            AI
          </button>
          <button type="button" className="af-btn-primary af-btn-primary--lg" disabled={!workspaceWritable} onClick={() => saveGraph().catch((e) => setStatus(String(e.message || e)))}>
            Save
          </button>
        </div>
      </header>
      {flowSnippetToast ? (
        <div className="af-flow-snippet-toast" role="status" aria-live="polite">
          <span className="material-symbols-outlined" aria-hidden>check_circle</span>
          <span>{flowSnippetToast}</span>
          <button type="button" onClick={() => setFlowSnippetToast("")} aria-label="关闭发布提示">
            <span className="material-symbols-outlined" aria-hidden>close</span>
          </button>
        </div>
      ) : null}

      <div
        className={
          "af-workspace-body" +
          (!isDisplayMode && (composerSidebarOpen || nodePropDraft) ? " af-workspace-body--drawer" : "") +
          (!isDisplayMode && workspaceSidebarCollapsed ? " af-workspace-body--sidebar-collapsed" : "") +
          (isDisplayMode ? " af-workspace-body--display-mode" : "")
        }
      >
        {!isDisplayMode && workspaceSidebarCollapsed ? (
          <nav className="af-workspace-rail" aria-label="Workspace sidebar">
            <div className="af-workspace-rail__stack">
              <button
                type="button"
                className="af-workspace-rail__primary"
                onClick={() => setQuickAddOpen(true)}
                aria-label="添加节点"
                title="添加节点"
              >
                <span className="material-symbols-outlined" aria-hidden>add</span>
                <span className="af-workspace-rail__dot" aria-hidden />
              </button>
              <button
                type="button"
                className="af-workspace-rail__btn"
                onClick={() => setWorkspaceSidebarCollapsed(false)}
                aria-label="展开文件"
                title="展开文件"
              >
                <span className="material-symbols-outlined" aria-hidden>folder</span>
              </button>
              <span className="af-workspace-rail__divider" aria-hidden />
              <button
                type="button"
                className="af-workspace-rail__avatar"
                onClick={() => setWorkspaceSidebarCollapsed(false)}
                aria-label="展开侧边栏"
                title={authUser?.username || authUser?.userId || "展开侧边栏"}
              >
                {authInitial}
              </button>
            </div>
          </nav>
        ) : null}
        {!isDisplayMode ? <aside
          ref={workspaceSidebarRef}
          className={"af-workspace-sidebar" + (workspaceSidebarResizing ? " af-workspace-sidebar--resizing" : "")}
          aria-hidden={workspaceSidebarCollapsed}
          style={{ "--af-work-files-pane-height": `${Math.round(workspaceFilesPaneHeight)}px` }}
        >
          <section className="af-workspace-files-section">
            <div className="af-workspace-sidebar-head">
              <h2>Files</h2>
              <div className="af-workspace-sidebar-actions">
                <button type="button" className="af-icon-btn" onClick={() => setWorkspaceSidebarCollapsed(true)} aria-label="最小化侧边栏" title="最小化侧边栏">
                  <span className="material-symbols-outlined">keyboard_double_arrow_left</span>
                </button>
                <button type="button" className="af-icon-btn" disabled={!workspaceWritable} onClick={() => createWorkspaceFile("")} aria-label="新增文件" title="新增文件">
                  <span className="material-symbols-outlined">note_add</span>
                </button>
                <button type="button" className="af-icon-btn" disabled={!workspaceWritable} onClick={() => createWorkspaceFolder("")} aria-label="新增文件夹" title="新增文件夹">
                  <span className="material-symbols-outlined">create_new_folder</span>
                </button>
                <button type="button" className="af-icon-btn" onClick={() => void loadFiles()} aria-label="刷新文件" title="刷新文件">
                  <span className="material-symbols-outlined">refresh</span>
                </button>
              </div>
            </div>
            <input className="af-workspace-search" value={fileFilter} onChange={(e) => setFileFilter(e.target.value)} placeholder="搜索文件..." />
            <div className="af-workspace-files-scroll">
              <FileTree items={filteredFiles} flowParams={flowParams} onOpen={openFileNode} collapsedDirs={collapsedDirs} onToggleDir={toggleDir} onCreateFile={createWorkspaceFile} onCreateFolder={createWorkspaceFolder} onDelete={deleteWorkspacePath} onFileDragStart={handleFileDragStart} />
            </div>
          </section>

          <button
            type="button"
            className="af-workspace-sidebar-resizer"
            onPointerDown={startWorkspaceSidebarResize}
            role="separator"
            aria-orientation="horizontal"
            aria-label="调整 Files 和 Palette 区域大小"
            title="拖动调整 Files / Palette 高度"
          />

          <section className="af-workspace-nodes-section">
            <div className="af-node-palette-head af-workspace-node-palette-head">
              <h2 className="af-node-palette-title">
                <span>Palette</span>
                <span className="af-node-palette-title-kbd" aria-label="快捷键 A">A</span>
              </h2>
              <label className="af-palette-search-wrap">
                <span className="af-visually-hidden">{paletteMode === "flows" ? "搜索流程片段" : "搜索节点"}</span>
                <span className="af-palette-search-icon material-symbols-outlined" aria-hidden>
                  search
                </span>
                <input
                  type="search"
                  className="af-palette-search-input"
                  value={paletteSearch}
                  onChange={(e) => setPaletteSearch(e.target.value)}
                  placeholder={paletteMode === "flows" ? "搜索流程片段..." : "搜索节点..."}
                  aria-label={paletteMode === "flows" ? "搜索流程片段" : "搜索节点"}
                />
              </label>
              <div className="af-palette-tabs" role="tablist" aria-label="Palette 类型">
                <button
                  type="button"
                  role="tab"
                  aria-selected={paletteMode === "nodes"}
                  className={"af-palette-tab" + (paletteMode === "nodes" ? " af-palette-tab--active" : "")}
                  onClick={() => setPaletteMode("nodes")}
                >
                  <span className="material-symbols-outlined" aria-hidden>category</span>
                  节点
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={paletteMode === "flows"}
                  className={"af-palette-tab" + (paletteMode === "flows" ? " af-palette-tab--active" : "")}
                  onClick={() => setPaletteMode("flows")}
                >
                  <span className="material-symbols-outlined" aria-hidden>account_tree</span>
                  流程
                </button>
              </div>
            </div>
            <div className="af-node-palette-scroll af-workspace-node-palette-scroll">
              {paletteMode === "flows" ? (
                <>
                  <section className="af-palette-section af-flow-palette-section--snippets">
                    <div className="af-flow-snippet-actions">
                      <button
                        type="button"
                        className="af-flow-snippet-publish-btn"
                        onClick={openPublishSnippetDialog}
                        disabled={selectedCanvasNodes.length < 2}
                        title={selectedCanvasNodes.length < 2 ? "选择至少两个节点后发布流程片段" : "发布选中的流程片段"}
                      >
                        <span className="material-symbols-outlined" aria-hidden>ios_share</span>
                        发布选中片段
                      </button>
                      <span className="af-flow-snippet-selection">
                        已选 {selectedCanvasNodes.length} 节点 / {selectedCanvasInternalEdges.length} 连线
                      </span>
                    </div>
                  </section>
                  {flowSnippetsError ? <p className="af-err af-palette-list-err">{flowSnippetsError}</p> : null}
                  {flowSnippetsLoading ? (
                    <p className="af-palette-empty">正在加载流程片段...</p>
                  ) : filteredFlowSnippets.length > 0 ? (
                    <section className="af-palette-section af-flow-palette-section--snippets">
                      <h3 className="af-palette-cat">FLOW SNIPPETS</h3>
                      <div className="af-palette-cards">
                        {filteredFlowSnippets.map((snippet) => {
                          const key = `${snippet.id}@${snippet.version}`;
                          const title = snippet.displayName || snippet.name || snippet.id;
                          const desc = snippet.description || `${snippet.nodeCount || 0} 个节点，${snippet.edgeCount || 0} 条连线`;
                          return (
                            <button
                              key={key}
                              type="button"
                              className="af-palette-card af-flow-snippet-card"
                              draggable
                              onDragStart={(event) => {
                                event.dataTransfer.effectAllowed = "move";
                                event.dataTransfer.setData("application/agentflow-snippet", key);
                                event.dataTransfer.setData("text/plain", key);
                              }}
                              onClick={() => insertFlowSnippet(snippet)}
                              title={desc}
                            >
                              <span className="af-palette-card-head">
                                <span className="af-palette-card-icon" aria-hidden>
                                  <span className="material-symbols-outlined">account_tree</span>
                                </span>
                                <span className="af-palette-card-main">
                                  <span className="af-palette-card-label">{title}</span>
                                  <span className="af-palette-card-id">{snippet.id}@{snippet.version}</span>
                                </span>
                              </span>
                              {desc ? <span className="af-palette-card-desc">{desc}</span> : null}
                              <span className="af-flow-snippet-meta" aria-hidden>
                                <span>{snippet.nodeCount || 0} nodes</span>
                                <span>{snippet.edgeCount || 0} edges</span>
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  ) : (
                    <p className="af-palette-empty">
                      {paletteSearch.trim() ? "没有匹配的流程片段" : "暂无流程片段。选择多个节点后发布。"}
                    </p>
                  )}
                </>
              ) : (
                <>
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
                </>
              )}
            </div>
          </section>

        </aside> : null}

        <main className="af-workspace-canvas">
          <ReactFlow
            className={
              "af-flow-canvas af-workspace-flow" +
              (canvasTool === "pan" ? " af-flow-canvas--tool-pan" : " af-flow-canvas--tool-select") +
              (isDisplayMode ? " af-workspace-flow--display-mode" : "")
            }
            nodes={canvasNodes}
            edges={canvasEdges}
            nodeTypes={nodeTypes}
            onNodesChange={handleNodesChange}
            onEdgesChange={handleEdgesChange}
            onConnect={isDisplayMode ? undefined : handleConnect}
            onConnectStart={isDisplayMode ? undefined : handleConnectStart}
            onConnectEnd={isDisplayMode ? undefined : handleConnectEnd}
            isValidConnection={isDisplayMode ? undefined : isValidConnection}
            onNodeClick={(_, node) => {
              if (isDisplayMode) {
                setSelectedDisplayNodeIds([sourceIdFromDisplayRefId(node.id)]);
                return;
              }
              // React Flow handles selection on click. If the properties drawer is already open,
              // keep it in sync with the clicked node; otherwise opening requires double click.
              if (selectedNodeId) setSelectedNodeId(node.id);
            }}
            onNodeDoubleClick={(event, node) => {
              event.preventDefault();
              if (isDisplayMode) return;
              setComposerSidebarOpen(false);
              setNodes((list) => list.map((item) => ({ ...item, selected: item.id === node.id })));
              setEdges((list) => list.map((item) => ({ ...item, selected: false })));
              setSelectedNodeId(node.id);
            }}
            onPaneClick={() => {
              if (isDisplayMode) setSelectedDisplayNodeIds([]);
              else setSelectedNodeId("");
            }}
            onDrop={isDisplayMode ? undefined : handleWorkspaceDrop}
            onDragOver={isDisplayMode ? undefined : handleWorkspaceDragOver}
            nodesDraggable={isDisplayMode ? true : workspaceWritable}
            nodesConnectable={isDisplayMode ? false : workspaceWritable}
            edgesReconnectable={isDisplayMode ? false : workspaceWritable}
            deleteKeyCode={isDisplayMode ? null : workspaceWritable ? ["Backspace", "Delete"] : null}
            selectionOnDrag={canvasTool === "select"}
            panOnDrag={canvasTool === "pan" ? true : [1, 2]}
            panActivationKeyCode="Space"
            proOptions={{ hideAttribution: true }}
            fitView={false}
            minZoom={0.1}
            maxZoom={4}
          >
            <Background color="rgba(255,255,255,0.12)" gap={22} size={1} />
          </ReactFlow>
          {!isDisplayMode && connectionMenu ? (() => {
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

          {!isDisplayMode && !composerMinimized ? (
          <div className="af-workspace-composer af-bottom-composer-stack af-flow-bottom-composer">
            <div className="af-pipeline-composer-inner">
              <button
                type="button"
                className="af-workspace-composer-minimize"
                onClick={() => setComposerMinimized(true)}
                aria-label="最小化 AI 输入框"
                title="最小化"
              >
                <span className="material-symbols-outlined" aria-hidden>remove</span>
              </button>
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
                    disabled={!workspaceWritable}
                  />
                </div>
                <div className="af-composer-toolbar">
                  <div className="af-composer-skills-field">
                    <button
                      ref={skillsButtonRef}
                      type="button"
                      className={"af-composer-skills-button" + (selectedSkills.length > 0 ? " af-composer-skills-button--active" : "")}
                      disabled={composerRunning || !workspaceWritable}
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

                  <label className="af-composer-model-field">
                    <select className="af-composer-model-select" value={composerModel} onChange={(e) => setComposerModel(e.target.value)} aria-label="模型">
                      <option value="">默认模型</option>
                      {modelOptions.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                    </select>
                  </label>

                  <button
                    type="button"
                    className={"af-composer-send" + (composerText.trim() && !composerRunning ? " af-composer-send--active" : "") + (composerRunning ? " af-composer-send--stop" : "")}
                    disabled={composerRunning || !composerText.trim() || !workspaceWritable}
                    aria-label={composerRunning ? "Running" : "Send"}
                    onClick={() => void submitWorkspaceAi()}
                  >
                    <span className="material-symbols-outlined" aria-hidden>{composerRunning ? "sync" : "arrow_upward"}</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
          ) : !isDisplayMode ? (
            <button
              type="button"
              className="af-workspace-composer-fab"
              onClick={() => setComposerMinimized(false)}
              aria-label="展开 AI 输入框"
              title="展开 AI 输入框"
            >
              <span className="material-symbols-outlined" aria-hidden>auto_awesome</span>
            </button>
          ) : null}
        </main>
        {!isDisplayMode && composerSidebarOpen ? (
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
                <button
                  type="button"
                  className={"af-composer-session-tab" + (activeComposerSessionId === "workspace" ? " af-composer-session-tab--active" : "")}
                  onClick={() => setActiveComposerSessionId("workspace")}
                >
                  <span className="af-composer-session-label">Workspace</span>
                </button>
                {composerRunSessions.map((session) => (
                  <button
                    key={session.id}
                    type="button"
                    className={
                      "af-composer-session-tab" +
                      (activeComposerSessionId === session.id ? " af-composer-session-tab--active" : "") +
                      (session.status === "running" ? " af-composer-session-tab--running" : "")
                    }
                    onClick={() => setActiveComposerSessionId(session.id)}
                    title={session.runNodeId || session.label}
                  >
                    <span className="af-composer-session-label">{session.label}</span>
                  </button>
                ))}
              </div>
              <div
                className={"af-composer-sidebar-status" + (activeComposerRunning ? " af-composer-sidebar-status--running" : "")}
                role="status"
                aria-live="polite"
              >
                {activeComposerStatus}
              </div>
              <div className="af-composer-sidebar-thread">
                <WorkspaceComposerThread
                  messages={activeComposerMessages}
                  running={activeComposerRunning}
                  showRunningIndicator={!activeRunSession}
                />
              </div>
            </div>
          </aside>
        ) : !isDisplayMode && nodePropDraft && selectedNode ? (
          <aside className="af-pipeline-drawer af-workspace-node-drawer" aria-label="Workspace Node Properties">
            <NodePropertiesPanel
              draft={nodePropDraft}
              setDraft={setNodePropDraft}
              definitionId={String(selectedNode.data?.definitionId || selectedNode.id)}
              systemPromptReadonly={String(selectedNode.data?.description || "")}
              modelLists={modelLists}
              disabled={!workspaceWritable}
              onIdBlur={() => applyNodeProperties(true)}
              onClose={() => setSelectedNodeId("")}
              onPublishToMarketplace={publishNodeToMarketplace}
              error={nodePropsError}
              ioSlots={{
                inputs: Array.isArray(nodePropDraft?.inputs) ? nodePropDraft.inputs : [],
                outputs: Array.isArray(nodePropDraft?.outputs) ? nodePropDraft.outputs : [],
              }}
            />
          </aside>
        ) : null}
        <KeyboardShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
        <NodeJumpPalette
          open={jumpPaletteOpen}
          onClose={() => setJumpPaletteOpen(false)}
          onJump={jumpToWorkspaceNodeById}
          nodes={jumpPaletteNodes}
        />
        {publishSnippetOpen ? createPortal(
          <div className="af-flow-snippet-modal-overlay">
            <div className="af-flow-snippet-modal" role="dialog" aria-modal="true" aria-label="发布流程片段">
              <div className="af-flow-snippet-modal__head">
                <span className="af-flow-snippet-modal__title">
                  <span className="material-symbols-outlined" aria-hidden>ios_share</span>
                  发布流程片段
                </span>
                <button
                  type="button"
                  className="af-flow-snippet-modal__close"
                  onClick={() => setPublishSnippetOpen(false)}
                  aria-label="关闭"
                >
                  <span className="material-symbols-outlined" aria-hidden>close</span>
                </button>
              </div>
              <div className="af-flow-snippet-modal__body">
                <label className="af-flow-snippet-field">
                  <span>名称</span>
                  <input
                    type="text"
                    value={publishSnippetDraft.name}
                    onChange={(event) => {
                      const name = event.target.value;
                      setPublishSnippetDraft((prev) => ({
                        ...prev,
                        name,
                        id: prev.id ? prev.id : name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, ""),
                      }));
                    }}
                    placeholder="例如：内容整理片段"
                    autoFocus
                  />
                </label>
                <label className="af-flow-snippet-field">
                  <span>ID</span>
                  <input
                    type="text"
                    value={publishSnippetDraft.id}
                    onChange={(event) => setPublishSnippetDraft((prev) => ({ ...prev, id: event.target.value }))}
                    placeholder="content-cleanup-snippet"
                  />
                </label>
                <label className="af-flow-snippet-field">
                  <span>说明</span>
                  <textarea
                    value={publishSnippetDraft.description}
                    onChange={(event) => setPublishSnippetDraft((prev) => ({ ...prev, description: event.target.value }))}
                    placeholder="这段流程适合什么 workspace 场景、需要接哪些上下游。"
                    rows={4}
                  />
                </label>
                <div className="af-flow-snippet-summary">
                  将发布 {selectedCanvasNodes.length} 个节点和 {selectedCanvasInternalEdges.length} 条内部连线。
                </div>
                {publishSnippetError ? <div className="af-flow-snippet-error">{publishSnippetError}</div> : null}
              </div>
              <div className="af-flow-snippet-modal__foot">
                <button
                  type="button"
                  className="af-flow-snippet-modal__btn"
                  onClick={() => setPublishSnippetOpen(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="af-flow-snippet-modal__btn af-flow-snippet-modal__btn--primary"
                  disabled={publishSnippetBusy || !publishSnippetDraft.name.trim()}
                  onClick={() => void publishSelectedFlowSnippet()}
                >
                  {publishSnippetBusy ? "发布中..." : "发布"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        ) : null}
        {displayShareOpen ? createPortal(
          <div className="af-flow-snippet-modal-overlay">
            <div className="af-flow-snippet-modal af-display-share-modal" role="dialog" aria-modal="true" aria-label="发布展示页">
              <div className="af-flow-snippet-modal__head">
                <span className="af-flow-snippet-modal__title">
                  <span className="material-symbols-outlined" aria-hidden>present_to_all</span>
                  发布展示页
                </span>
                <button
                  type="button"
                  className="af-flow-snippet-modal__close"
                  onClick={() => setDisplayShareOpen(false)}
                  aria-label="关闭"
                >
                  <span className="material-symbols-outlined" aria-hidden>close</span>
                </button>
              </div>
              <div className="af-flow-snippet-modal__body">
                <label className="af-flow-snippet-field">
                  <span>标题</span>
                  <input
                    type="text"
                    value={displayShareDraft.title}
                    onChange={(event) => setDisplayShareDraft((prev) => ({ ...prev, title: event.target.value }))}
                    placeholder="展示页标题"
                    autoFocus
                  />
                </label>
                <label className="af-flow-snippet-field">
                  <span>布局</span>
                  <select
                    className="af-display-share-select"
                    value={displayShareDraft.layout}
                    onChange={(event) => setDisplayShareDraft((prev) => ({ ...prev, layout: event.target.value }))}
                  >
                    <option value="gallery">Gallery</option>
                    <option value="document">Document</option>
                    <option value="slides">Slides</option>
                  </select>
                </label>
                <div className="af-display-share-node-list" role="group" aria-label="选择展示节点">
                  {workspaceDisplayNodes.map((node) => {
                    const checked = Array.isArray(displayShareDraft.nodeIds) && displayShareDraft.nodeIds.includes(node.id);
                    return (
                      <label key={node.id} className="af-display-share-node-row">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleDisplayShareNode(node.id)}
                        />
                        <span className="af-display-share-node-row__main">
                          <strong>{node.data?.label || node.id}</strong>
                          <small>{displayKind(node.data?.definitionId)} · {node.id}</small>
                        </span>
                      </label>
                    );
                  })}
                </div>
                {displayShareResult?.absoluteUrl ? (
                  <div className="af-display-share-result">
                    <input type="text" readOnly value={displayShareResult.absoluteUrl} onFocus={(event) => event.target.select()} />
                    <button type="button" onClick={() => window.open(displayShareResult.absoluteUrl, "_blank", "noopener,noreferrer")}>
                      打开
                    </button>
                    <button
                      type="button"
                      onClick={() => void copyDisplayShareUrl()}
                    >
                      {displayLinkCopyState === "copied" ? "已复制" : displayLinkCopyState === "failed" ? "复制失败" : "复制"}
                    </button>
                  </div>
                ) : null}
                {displayShareError ? <div className="af-flow-snippet-error">{displayShareError}</div> : null}
              </div>
              <div className="af-flow-snippet-modal__foot">
                <button
                  type="button"
                  className="af-flow-snippet-modal__btn"
                  onClick={() => setDisplayShareOpen(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="af-flow-snippet-modal__btn af-flow-snippet-modal__btn--primary"
                  disabled={displayShareBusy || !Array.isArray(displayShareDraft.nodeIds) || displayShareDraft.nodeIds.length === 0}
                  onClick={() => void publishDisplayShare()}
                >
                  {displayShareBusy ? "生成中..." : "生成链接"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        ) : null}
        {displayLinkOpen ? createPortal(
          <div className="af-flow-snippet-modal-overlay">
            <div className="af-flow-snippet-modal af-display-link-modal" role="dialog" aria-modal="true" aria-label="展示链接">
              <div className="af-flow-snippet-modal__head">
                <span className="af-flow-snippet-modal__title">
                  <span className="material-symbols-outlined" aria-hidden>link</span>
                  展示链接
                </span>
                <button
                  type="button"
                  className="af-flow-snippet-modal__close"
                  onClick={() => {
                    setDisplayLinkCopyState("");
                    setDisplayLinkOpen(false);
                  }}
                  aria-label="关闭"
                >
                  <span className="material-symbols-outlined" aria-hidden>close</span>
                </button>
              </div>
              <div className="af-flow-snippet-modal__body">
                {displayShareResult?.absoluteUrl ? (
                  <div className="af-display-link-modal__url">
                    <input type="text" readOnly value={displayShareResult.absoluteUrl} onFocus={(event) => event.target.select()} autoFocus />
                    <button type="button" onClick={() => window.open(displayShareResult.absoluteUrl, "_blank", "noopener,noreferrer")}>
                      <span className="material-symbols-outlined" aria-hidden>open_in_new</span>
                      打开
                    </button>
                    <button type="button" onClick={() => void copyDisplayShareUrl()}>
                      <span className="material-symbols-outlined" aria-hidden>{displayLinkCopyState === "copied" ? "check" : "content_copy"}</span>
                      {displayLinkCopyState === "copied" ? "已复制" : displayLinkCopyState === "failed" ? "复制失败" : "复制"}
                    </button>
                  </div>
                ) : (
                  <div className="af-display-link-modal__empty">还没有生成展示链接</div>
                )}
                {displayShareError ? <div className="af-flow-snippet-error">{displayShareError}</div> : null}
              </div>
              <div className="af-flow-snippet-modal__foot">
                <button
                  type="button"
                  className="af-flow-snippet-modal__btn"
                  onClick={() => {
                    setDisplayLinkCopyState("");
                    setDisplayLinkOpen(false);
                  }}
                >
                  关闭
                </button>
                <button
                  type="button"
                  className="af-flow-snippet-modal__btn af-flow-snippet-modal__btn--primary"
                  disabled={displayShareBusy || displayPage.nodeIds.length === 0}
                  onClick={() => void publishCurrentDisplayPage()}
                >
                  {displayShareBusy ? "生成中..." : displayShareResult?.absoluteUrl ? "更新链接" : "生成链接"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        ) : null}
        {displayPickerOpen ? createPortal(
          <div className="af-flow-snippet-modal-overlay">
            <div className="af-flow-snippet-modal af-display-picker-modal" role="dialog" aria-modal="true" aria-label="选择展示节点">
              <div className="af-flow-snippet-modal__head">
                <span className="af-flow-snippet-modal__title">
                  <span className="material-symbols-outlined" aria-hidden>add_to_photos</span>
                  选择展示节点
                </span>
                <button
                  type="button"
                  className="af-flow-snippet-modal__close"
                  onClick={() => setDisplayPickerOpen(false)}
                  aria-label="关闭"
                >
                  <span className="material-symbols-outlined" aria-hidden>close</span>
                </button>
              </div>
              <div className="af-flow-snippet-modal__body">
                <label className="af-display-picker-search">
                  <span className="material-symbols-outlined" aria-hidden>search</span>
                  <input
                    type="search"
                    value={displayPickerSearch}
                    onChange={(event) => setDisplayPickerSearch(event.target.value)}
                    placeholder="搜索展示节点..."
                    autoFocus
                  />
                </label>
                <div
                  className="af-display-picker-grid"
                  role="group"
                  aria-label="选择展示节点"
                  style={{ "--af-display-picker-columns": displayPickerColumns.length || 1 }}
                >
                  {filteredAvailableDisplayNodes.length > 0 ? displayPickerColumns.map((column, columnIndex) => (
                    <div key={`display-picker-column-${columnIndex}`} className="af-display-picker-column">
                      {column.map(renderDisplayPickerCard)}
                    </div>
                  )) : (
                    <div className="af-display-picker-empty">
                      {availableDisplayNodes.length === 0 ? "当前 Workspace 没有 display 节点" : "没有匹配的展示节点"}
                    </div>
                  )}
                </div>
              </div>
              <div className="af-flow-snippet-modal__foot">
                <button
                  type="button"
                  className="af-flow-snippet-modal__btn af-flow-snippet-modal__btn--primary"
                  onClick={() => setDisplayPickerOpen(false)}
                >
                  完成
                </button>
              </div>
            </div>
          </div>,
          document.body,
        ) : null}
        {!isDisplayMode && quickAddOpen ? createPortal(
          <div className="af-workspace-quick-add-backdrop" onMouseDown={() => setQuickAddOpen(false)}>
            <div className="af-workspace-quick-add" role="dialog" aria-modal="true" aria-label="Add workspace node" onMouseDown={(event) => event.stopPropagation()}>
              <div className="af-workspace-quick-add__tabs" role="tablist" aria-label="选择添加类型">
                <button
                  type="button"
                  role="tab"
                  aria-selected={quickAddMode === "nodes"}
                  className={"af-workspace-quick-add__tab" + (quickAddMode === "nodes" ? " af-workspace-quick-add__tab--active" : "")}
                  onClick={() => setQuickAddMode("nodes")}
                >
                  节点
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={quickAddMode === "flows"}
                  className={"af-workspace-quick-add__tab" + (quickAddMode === "flows" ? " af-workspace-quick-add__tab--active" : "")}
                  onClick={() => setQuickAddMode("flows")}
                >
                  流程
                </button>
              </div>
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
                      const count = quickAddMode === "flows" ? quickAddFlowItems.length : quickAddItems.length;
                      setQuickAddActiveIndex((idx) => Math.min(Math.max(0, count - 1), idx + 1));
                    } else if (event.key === "ArrowUp") {
                      event.preventDefault();
                      setQuickAddActiveIndex((idx) => Math.max(0, idx - 1));
                    } else if (event.key === "Tab") {
                      event.preventDefault();
                      setQuickAddMode((mode) => (mode === "nodes" ? "flows" : "nodes"));
                    } else if (event.key === "Enter") {
                      event.preventDefault();
                      if (quickAddMode === "flows") {
                        addQuickFlowSnippet(quickAddFlowItems[quickAddActiveIndex] || quickAddFlowItems[0]);
                      } else {
                        addQuickNode(quickAddItems[quickAddActiveIndex] || quickAddItems[0]);
                      }
                    }
                  }}
                  placeholder={quickAddMode === "flows" ? "搜索流程片段..." : "搜索节点..."}
                  aria-label={quickAddMode === "flows" ? "搜索流程片段" : "搜索节点"}
                />
              </div>
              <div className="af-workspace-quick-add__list">
                {quickAddMode === "flows" ? (
                  quickAddFlowItems.length === 0 ? (
                    <div className="af-workspace-quick-add__empty">
                      {flowSnippetsLoading ? "正在加载流程片段..." : flowSnippetsError || "没有匹配的流程片段"}
                    </div>
                  ) : quickAddFlowItems.map((snippet, index) => {
                    const label = snippet.displayName || snippet.name || snippet.id;
                    const instances = snippet.snippet && typeof snippet.snippet === "object" ? snippet.snippet.instances : null;
                    const edges = snippet.snippet && typeof snippet.snippet === "object" ? snippet.snippet.edges : null;
                    const nodeCount = Number.isFinite(Number(snippet.nodeCount)) ? Number(snippet.nodeCount) : Object.keys(instances || {}).length;
                    const edgeCount = Number.isFinite(Number(snippet.edgeCount)) ? Number(snippet.edgeCount) : (Array.isArray(edges) ? edges.length : 0);
                    return (
                      <button
                        key={`${snippet.id}@${snippet.version}`}
                        type="button"
                        className={"af-workspace-quick-add__item" + (index === quickAddActiveIndex ? " af-workspace-quick-add__item--active" : "")}
                        onMouseEnter={() => setQuickAddActiveIndex(index)}
                        onClick={() => addQuickFlowSnippet(snippet)}
                      >
                        <span className="af-workspace-quick-add__icon material-symbols-outlined" aria-hidden>schema</span>
                        <span className="af-workspace-quick-add__main">
                          <span className="af-workspace-quick-add__label">{label}</span>
                          <span className="af-workspace-quick-add__meta">{snippet.id}{snippet.version ? ` · v${snippet.version}` : ""}</span>
                          <span className="af-workspace-quick-add__desc">{snippet.description || `${nodeCount} 节点 / ${edgeCount} 连线`}</span>
                        </span>
                        <span className="af-workspace-quick-add__cat">FLOW</span>
                      </button>
                    );
                  })
                ) : quickAddItems.length === 0 ? (
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
