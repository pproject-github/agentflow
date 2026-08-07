import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
  useUpdateNodeInternals,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { buildStableEdgeKey, reconcileFlowGraph } from "../flowDiff.js";
import { buildCanvasClipboard, deserializeFromFlowYaml, pasteCanvasClipboard, serializeToFlowYaml, VALID_ROLES } from "../flowFormat.js";
import { computeSlotEdgeWarnings } from "../flowSlotEdgeWarnings.js";
import { normalizeImages } from "../imageAttachments.js";
import { cloneNodeIoDraftSlots, filterValidEdges, mergeNodeWithPalette, revealConnectedSlots } from "../mergeFlowNodes.js";
import { recordPipelineOpened } from "../pipelineRecent.js";
import { flowUrlForView, recordPipelineView } from "../pipelineViewPreference.js";
import { useCanvasHistory } from "../useCanvasHistory.js";
import { useRoute } from "../routeContext.jsx";
import { FLOW_NODE_TYPE, FlowNode } from "../FlowNode.jsx";
import {
  areSlotsCompatible,
  getHandleColor,
  getNodeSlotByHandle,
  getSlotConnectionLabel,
} from "../nodeSchema.js";
import { isEditableFocus, isQuestionMarkShortcut } from "../hotkeyUtils.js";
import { NODE_INSTANCE_ID_RE } from "../NodePropertiesPanel.jsx";

/* global __APP_VERSION__ */
const APP_VERSION = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(max, Math.max(min, Math.round(n)));
}

const MIN_FLOW_NODE_WIDTH = 220;

const MAX_FLOW_NODE_WIDTH = 1600;

const MAX_FLOW_NODE_HEIGHT = 900;

function normalizeFlowNodeSize(size) {
  if (!size || typeof size !== "object") return null;
  const rawWidth = Number(size.width);
  const rawHeight = Number(size.height);
  if (!Number.isFinite(rawWidth) || !Number.isFinite(rawHeight) || rawWidth <= 0 || rawHeight <= 0) return null;
  return {
    width: clampNumber(rawWidth, MIN_FLOW_NODE_WIDTH, MAX_FLOW_NODE_WIDTH) || DEFAULT_FLOW_NODE_WIDTH,
    height: clampNumber(rawHeight, MIN_FLOW_NODE_HEIGHT, MAX_FLOW_NODE_HEIGHT) || MIN_FLOW_NODE_HEIGHT,
  };
}

const MIN_FLOW_NODE_HEIGHT = 104;

const DEFAULT_FLOW_NODE_WIDTH = 320;


/** 包装 FlowNode 以注入 deleteNode 与 onProvideExpand 功能 */
function FlowNodeWrapper(props) {
  const { setNodes } = useReactFlow();
  const updateNodeInternals = useUpdateNodeInternals();
  const { modelLists, onModelChange } = useContext(FlowNodeContext);
  const wrapperRef = useRef(null);
  const readOnly = Boolean(props.data?.readOnly);
  const displaySize = props.data?.displaySize && Number(props.data.displaySize.width) > 0 && Number(props.data.displaySize.height) > 0
    ? { width: Number(props.data.displaySize.width), height: Number(props.data.displaySize.height) }
    : null;
  const resizable = props.data?.definitionId === "agent_subAgent" && !props.data?.isRunMode && !readOnly;

  const refreshNodeInternals = useCallback((nodeId) => {
    const refresh = () => updateNodeInternals(nodeId);
    window.requestAnimationFrame(refresh);
    window.setTimeout(refresh, 80);
  }, [updateNodeInternals]);

  const applyNodeDisplaySize = useCallback((nodeId, nextSize) => {
    const size = normalizeFlowNodeSize(nextSize);
    if (!size) return;
    setNodes((list) => list.map((node) => {
      if (node.id !== nodeId) return node;
      const currentWidth = Number(node.data?.displaySize?.width || node.width || node.measured?.width || 0);
      const currentHeight = Number(node.data?.displaySize?.height || node.height || node.measured?.height || 0);
      if (Math.abs(currentWidth - size.width) < 2 && Math.abs(currentHeight - size.height) < 2) return node;
      return {
        ...node,
        width: size.width,
        height: size.height,
        data: {
          ...node.data,
          displaySize: size,
        },
      };
    }));
    refreshNodeInternals(nodeId);
  }, [refreshNodeInternals, setNodes]);

  const onNodeContentResize = useCallback((nodeId) => {
    if (readOnly) return;
    const el = wrapperRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    applyNodeDisplaySize(nodeId, {
      width: Math.max(rect.width, el.scrollWidth),
      height: Math.max(rect.height, el.scrollHeight),
    });
  }, [applyNodeDisplaySize, readOnly]);

  const startNodeResize = useCallback((event) => {
    if (!resizable) return;
    event.preventDefault();
    event.stopPropagation();
    const el = wrapperRef.current;
    const rect = el?.getBoundingClientRect();
    const startWidth = Number(props.data?.displaySize?.width || props.width || props.measured?.width || rect?.width || DEFAULT_FLOW_NODE_WIDTH);
    const startHeight = Number(props.data?.displaySize?.height || props.height || props.measured?.height || rect?.height || MIN_FLOW_NODE_HEIGHT);
    const startX = event.clientX;
    const startY = event.clientY;
    const nodeId = props.id;
    let raf = 0;

    const move = (moveEvent) => {
      const next = normalizeFlowNodeSize({
        width: startWidth + moveEvent.clientX - startX,
        height: startHeight + moveEvent.clientY - startY,
      });
      if (!next) return;
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => applyNodeDisplaySize(nodeId, next));
    };
    const stop = () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
      refreshNodeInternals(nodeId);
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", stop, { once: true });
    window.addEventListener("pointercancel", stop, { once: true });
  }, [applyNodeDisplaySize, props.data?.displaySize?.height, props.data?.displaySize?.width, props.height, props.id, props.measured?.height, props.measured?.width, props.width, refreshNodeInternals, resizable]);

  const deleteNode = useCallback((nodeId) => {
    setNodes((nds) => nds.filter((n) => n.id !== nodeId));
  }, [setNodes]);
  const onProvideExpand = useCallback(() => {
    const definitionId = props.data?.definitionId || "";
    const label = props.data?.label || props.id;
    const content = props.data?.outputs?.[0]?.value || props.data?.outputs?.[0]?.default || "";
    window.__provideEditContent = { instanceId: props.id, label, definitionId, content };
    window.dispatchEvent(new CustomEvent("provide-expand"));
  }, [props.id, props.data]);
  const onProvideValueChange = useCallback((nodeId, value) => {
    setNodes((nds) => nds.map((node) => {
      if (node.id !== nodeId) return node;
      const outputs = Array.isArray(node.data?.outputs) && node.data.outputs.length
        ? node.data.outputs.map((slot, index) => index === 0 ? { ...slot, default: value, value } : slot)
        : [{ type: "bool", name: "value", default: value, value }];
      return { ...node, data: { ...node.data, body: "", outputs } };
    }));
  }, [setNodes]);
  const onNodeBodyChange = useCallback((nodeId, body) => {
    setNodes((nds) => nds.map((node) => (
      node.id === nodeId ? { ...node, data: { ...node.data, body } } : node
    )));
  }, [setNodes]);
  const onNodeImagesChange = useCallback((nodeId, images) => {
    setNodes((nds) => nds.map((node) => (
      node.id === nodeId ? { ...node, data: { ...node.data, images: normalizeImages(images) } } : node
    )));
  }, [setNodes]);
  return (
    <div
      ref={wrapperRef}
      className={"af-flow-node-shell" + (resizable ? " af-flow-node-shell--resizable" : "")}
      style={displaySize ? { width: displaySize.width, height: displaySize.height } : undefined}
    >
      <FlowNode
        {...props}
        data={{ ...props.data, onNodeContentResize }}
        deleteNode={deleteNode}
        onProvideExpand={onProvideExpand}
        onProvideValueChange={onProvideValueChange}
        onNodeBodyChange={onNodeBodyChange}
        onNodeImagesChange={onNodeImagesChange}
        modelLists={modelLists}
        onModelChange={onModelChange}
      />
      {resizable ? (
        <span
          className="af-flow-node-shell__resize-grip nodrag"
          aria-label={props.data?.resizeLabel || "Resize node"}
          role="separator"
          onPointerDown={startNodeResize}
        />
      ) : null}
    </div>
  );
}

const FLOW_CANVAS_CLIPBOARD_TYPE = "agentflow.flow.canvas-clipboard";

/** @type {React.Context<{ modelLists: { cursor: string[], opencode: string[] }, onModelChange: (nodeId: string, newModel: string) => void }>} */
const FlowNodeContext = createContext({ modelLists: { cursor: [], opencode: [] }, onModelChange: () => {} });

const SYNC_HIGHLIGHT_MS = 1200;

const SYNC_NODE_FLASH_CLASS = "af-flow-node--sync-flash";

const SYNC_EDGE_FLASH_CLASS = "af-flow-edge--sync-flash";

function appendClassName(base, cls) {
  const text = String(base || "").trim();
  if (!text) return cls;
  if (text.split(/\s+/).includes(cls)) return text;
  return `${text} ${cls}`;
}

function removeClassName(base, cls) {
  const text = String(base || "").trim();
  if (!text) return "";
  return text
    .split(/\s+/)
    .filter((x) => x && x !== cls)
    .join(" ");
}

function paletteSlotLabel(slot, index) {
  const name = String(slot?.name || slot?.id || "").trim();
  const type = String(slot?.type || "").trim();
  if (name) return name;
  if (type) return type;
  return `#${index + 1}`;
}

function buildPaletteNode(def, id, position, instances, palette) {
  const schemaType = schemaTypeForPalette(def);
  const raw = {
    id,
    type: FLOW_NODE_TYPE,
    position,
    data: {
      label: def.label ?? def.id,
      definitionId: def.id,
      schemaType,
      inputs: Array.isArray(def.inputs) ? def.inputs.map((x) => ({ ...x })) : [],
      outputs: Array.isArray(def.outputs) ? def.outputs.map((x) => ({ ...x })) : [],
    },
  };
  return mergeNodeWithPalette(raw, instances, palette);
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

function isConnectionTypeCompatible(connection, nodes) {
  const source = String(connection?.source || "");
  const target = String(connection?.target || "");
  if (!source || !target) return false;
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const src = nodeById.get(source);
  const tgt = nodeById.get(target);
  const srcSlot = getNodeSlotByHandle(src, connection.sourceHandle || "output-0", "source");
  const tgtSlot = getNodeSlotByHandle(tgt, connection.targetHandle || "input-0", "target");
  if (!srcSlot || !tgtSlot) return false;
  return areSlotsCompatible(srcSlot, tgtSlot);
}

function buildConnectionDraft(params, nodes) {
  const nodeId = String(params?.nodeId || "");
  const handleId = String(params?.handleId || "");
  const handleType = params?.handleType === "target" ? "target" : params?.handleType === "source" ? "source" : "";
  if (!nodeId || !handleId || !handleType) return null;
  const node = nodes.find((n) => n.id === nodeId);
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

function buildCompatiblePaletteCandidates(palette, draft) {
  if (!draft) return [];
  return palette
    .map((def, order) => {
      const match = findCompatibleSlotForDefinition(def, palette, draft);
      if (!match) return null;
      const category = paletteCategory(def);
      return {
        def,
        order,
        category,
        categoryRank: PALETTE_ORDER.indexOf(category),
        slot: match.slot,
        slotIndex: match.slotIndex,
        displayLabel: paletteDisplayLabel(match.hydrated.data || def),
        description: paletteDescription(def),
      };
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





function persistFlowCanvasClipboard(clipboard) {
  try {
    localStorage.setItem(FLOW_CANVAS_CLIPBOARD_STORAGE_KEY, encodeFlowCanvasClipboard(clipboard));
  } catch {
    /* ignore storage failures */
  }
}

function readPersistedFlowCanvasClipboard() {
  try {
    return decodeFlowCanvasClipboard(localStorage.getItem(FLOW_CANVAS_CLIPBOARD_STORAGE_KEY));
  } catch {
    return null;
  }
}

function isReadonlyBuiltinFlowSource(source) {
  return source === "builtin" || source === "admin";
}

/** 保存 flow.yaml 的 API flowSource：内置来源写入工作区副本 */
function flowSourceForWrite(source) {
  return source === "builtin" || source === "admin" ? "workspace" : source ?? "user";
}

function replaceFlowUrl(flow, previewMode = false) {
  if (!window.location.pathname.startsWith("/flow")) return;
  if (!flow) {
    window.history.replaceState({}, "", previewMode ? "/flow-preview?preview=1" : "/flow");
    return;
  }
  const current = new URLSearchParams(window.location.search);
  const q = new URLSearchParams({
    flowId: flow.id,
    flowSource: flow.source ?? "user",
  });
  if (flow.archived) q.set("flowArchived", "1");
  if (previewMode) q.set("preview", "1");
  if (current.get("panel") === "settings") q.set("panel", "settings");
  window.history.replaceState({}, "", (previewMode ? "/flow-preview?" : "/flow?") + q.toString());
}

function FlowBoard({
  fitViewEpoch,
  canvasTool,
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onConnectStart,
  onConnectEnd,
  isValidConnection,
  onNodesDelete,
  onNodeClick,
  onNodeDoubleClick,
  onEdgeClick,
  onFlowInit,
  onDrop,
  onDragOver,
  /** 右侧抽屉打开时隐藏小地图与缩放，避免与侧栏叠压 */
  hideMinimapAndControls,
  /** 底部与缩略图、缩放控件同一行的 AI 输入区 */
  bottomSlot,
  /** 本地预览：保留选择、缩放和拖动画布，禁用任何图结构修改 */
  readOnly = false,
}) {
  const { t } = useTranslation();
  const isRunMode = !onNodesChange;
  const panOnDrag = isRunMode || readOnly ? true : (canvasTool === "pan" ? true : [1, 2]);
  const selectionOnDrag = isRunMode || readOnly ? false : (canvasTool === "select");
  const flowClassName =
    "af-flow-canvas" +
    (isRunMode ? " af-flow-canvas--run-mode" : "") +
    (canvasTool === "pan" ? " af-flow-canvas--tool-pan" : " af-flow-canvas--tool-select");

  const noop = useCallback(() => {}, []);

  const coloredEdges = useMemo(() => {
    const nodeById = new Map(nodes.map((n) => [n.id, n]));
    const selectedNodeIds = new Set(nodes.filter((n) => n.selected).map((n) => n.id));
    const hasNodeSelection = selectedNodeIds.size > 0;
    const hexToRgba = (hex, a) => {
      const m = /^#([0-9a-f]{6})$/i.exec(hex);
      if (!m) return hex;
      const n = parseInt(m[1], 16);
      return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
    };
    const MISMATCH_COLOR = "#ff5169";
    return edges.map((e) => {
      const src = nodeById.get(e.source);
      const tgt = nodeById.get(e.target);
      const sm = /^output-(\d+)$/.exec(e.sourceHandle || "");
      const tm = /^input-(\d+)$/.exec(e.targetHandle || "");
      const srcSlot = src && sm ? src.data?.outputs?.[parseInt(sm[1], 10)] : null;
      const tgtSlot = tgt && tm ? tgt.data?.inputs?.[parseInt(tm[1], 10)] : null;
      const srcHue = srcSlot?.type ? getHandleColor(srcSlot.type) : null;
      const tgtHue = tgtSlot?.type ? getHandleColor(tgtSlot.type) : null;
      const mismatch = srcHue && tgtHue && srcHue !== tgtHue;
      const adjacentToSelected = hasNodeSelection && (selectedNodeIds.has(e.source) || selectedNodeIds.has(e.target));

      const prevStyle = e.style || {};
      if (mismatch) {
        const mismatchAlpha = e.selected ? 0.95 : adjacentToSelected ? 0.85 : 0.78;
        const stroke = hexToRgba(MISMATCH_COLOR, mismatchAlpha);
        return {
          ...e,
          className: ((e.className || "") + " af-flow-edge--type-mismatch" + (adjacentToSelected ? " af-flow-edge--adjacent" : "")).trim(),
          style: {
            ...prevStyle,
            stroke,
            strokeWidth: adjacentToSelected ? 2.75 : 2.5,
            strokeDasharray: "6 4",
          },
          markerEnd:
            e.markerEnd && typeof e.markerEnd === "object"
              ? { ...e.markerEnd, color: stroke }
              : { type: MarkerType.ArrowClosed, color: stroke },
        };
      }

      const hue = srcHue || tgtHue;
      if (!hue) {
        if (adjacentToSelected) {
          return {
            ...e,
            className: ((e.className || "") + " af-flow-edge--adjacent").trim(),
            style: { ...prevStyle, strokeWidth: 2.5 },
          };
        }
        return e;
      }
      const alpha = adjacentToSelected ? 0.7 : e.selected ? 0.7 : 0.38;
      const stroke = hexToRgba(hue, alpha);
      const strokeWidth = adjacentToSelected ? 2.5 : prevStyle.strokeWidth ?? 2;
      return {
        ...e,
        className: ((e.className || "") + (adjacentToSelected ? " af-flow-edge--adjacent" : "")).trim(),
        style: { ...prevStyle, stroke, strokeWidth },
        markerEnd:
          e.markerEnd && typeof e.markerEnd === "object"
            ? { ...e.markerEnd, color: stroke }
            : { type: MarkerType.ArrowClosed, color: stroke },
      };
    });
  }, [nodes, edges]);

  return (
    <ReactFlow
      className={flowClassName}
      nodes={nodes}
      edges={coloredEdges}
      onNodesChange={onNodesChange || noop}
      onEdgesChange={onEdgesChange || noop}
      onConnect={isRunMode || readOnly ? undefined : onConnect}
      onConnectStart={isRunMode || readOnly ? undefined : onConnectStart}
      onConnectEnd={isRunMode || readOnly ? undefined : onConnectEnd}
      isValidConnection={isRunMode || readOnly ? undefined : isValidConnection}
      onNodesDelete={isRunMode || readOnly ? undefined : onNodesDelete}
      onNodeClick={onNodeClick}
      onNodeDoubleClick={isRunMode || readOnly ? undefined : onNodeDoubleClick}
      onEdgeClick={isRunMode || readOnly ? undefined : onEdgeClick}
      onInit={onFlowInit}
      onDrop={isRunMode || readOnly ? undefined : onDrop}
      onDragOver={isRunMode || readOnly ? undefined : onDragOver}
      nodeTypes={nodeTypes}
      selectionOnDrag={selectionOnDrag}
      panOnDrag={panOnDrag}
      nodesDraggable={!isRunMode && !readOnly}
      nodesConnectable={!isRunMode && !readOnly}
      elementsSelectable={!isRunMode}
      edgesFocusable={!isRunMode && !readOnly}
      panActivationKeyCode="Space"
      proOptions={{ hideAttribution: true }}
      fitView={false}
      minZoom={0.1}
      maxZoom={4}
      defaultEdgeOptions={{
        style: { stroke: "rgba(205, 189, 255, 0.45)", strokeWidth: 2 },
      }}
      connectionLineStyle={{ stroke: "rgba(205, 189, 255, 0.65)", strokeWidth: 2 }}
    >
      <Background gap={20} size={1} color="rgba(28, 27, 27, 0.9)" />
      <Panel
        position="bottom-center"
        className={
          "af-flow-bottom-unified-panel" +
          (hideMinimapAndControls ? " af-flow-bottom-unified-panel--solo" : "")
        }
      >
        <div
          className={
            "af-flow-bottom-unified-row" +
            (hideMinimapAndControls ? " af-flow-bottom-unified-row--solo" : "")
          }
        >
          {!hideMinimapAndControls ? (
            <div className="af-flow-bottom-unified__side af-flow-bottom-unified__side--minimap">
              <MiniMap
                zoomable
                pannable
                position="bottom-left"
                className="af-flow-bottom-minimap"
                style={{ width: 152, height: 104 }}
                maskColor="rgba(14, 14, 14, 0.85)"
                nodeColor={(n) => {
                  const st = (n.data?.schemaType ?? "agent").toLowerCase();
                  if (st === "control") return "rgba(237, 108, 2, 0.85)";
                  if (st === "provide") return "rgba(0, 228, 117, 0.35)";
                  if (st === "tool") return "rgba(124, 77, 255, 0.75)";
                  return "rgba(158, 202, 255, 0.5)";
                }}
              />
            </div>
          ) : null}
          <div className="af-flow-bottom-unified__center">{bottomSlot}</div>
          {!hideMinimapAndControls ? (
            <div className="af-flow-bottom-unified__side af-flow-bottom-unified__side--zoom">
              <Controls position="bottom-right" showInteractive={false} className="af-flow-bottom-controls" />
            </div>
          ) : null}
        </div>
      </Panel>
      {!hideMinimapAndControls && (
        <Panel position="bottom-left" className="af-pin-legend">
          {[
            { type: "node", color: "#ff9800" },
            { type: "text", color: "#2196f3" },
            { type: "file", color: "#4caf50" },
            { type: "bool", color: "#9c27b0" },
          ].map(({ type, color }) => (
            <span key={type} className="af-pin-legend__item">
              <span className="af-pin-legend__dot" style={{ background: color }} />
              <span className="af-pin-legend__label">{type}</span>
            </span>
          ))}
        </Panel>
      )}
      <FitViewHelper fitViewEpoch={fitViewEpoch} />
      {!isRunMode && nodes.length === 0 ? (
        <div className="af-flow-empty-hint">
          <span className="af-flow-empty-hint-icon material-symbols-outlined">account_tree</span>
          <p className="af-flow-empty-hint-text">{t("flow:emptyCanvas.composerHint")}</p>
          <p className="af-flow-empty-hint-sub" dangerouslySetInnerHTML={{ __html: t("flow:emptyCanvas.composerSub") }} />
        </div>
      ) : null}
    </ReactFlow>
  );
}

const FLOW_CANVAS_CLIPBOARD_STORAGE_KEY = "af:flow:canvas-clipboard";

function FitViewHelper({ fitViewEpoch }) {
  const { fitView } = useReactFlow();
  const fitViewRef = useRef(fitView);
  fitViewRef.current = fitView;
  useEffect(() => {
    if (fitViewEpoch > 0) {
      const t = requestAnimationFrame(() => fitViewRef.current({ padding: 0.2, duration: 200, maxZoom: 1 }));
      return () => cancelAnimationFrame(t);
    }
  }, [fitViewEpoch]);
  return null;
}

const PALETTE_ORDER = ["CONTROL", "TOOL", "PROVIDE", "AGENT"];

function decodeFlowCanvasClipboard(text) {
  try {
    const parsed = JSON.parse(String(text || ""));
    if (parsed?.type !== FLOW_CANVAS_CLIPBOARD_TYPE) return null;
    const clipboard = parsed.clipboard;
    if (!clipboard || !Array.isArray(clipboard.nodes) || clipboard.nodes.length === 0) return null;
    return clipboard;
  } catch {
    return null;
  }
}

function encodeFlowCanvasClipboard(clipboard) {
  return JSON.stringify({
    type: FLOW_CANVAS_CLIPBOARD_TYPE,
    version: 1,
    clipboard,
  });
}

function findCompatibleSlotForDefinition(def, palette, draft) {
  const hydrated = buildPaletteNode(def, `__candidate_${def.id}`, { x: 0, y: 0 }, {}, palette);
  const side = draft.handleType === "source" ? "inputs" : "outputs";
  const slots = Array.isArray(hydrated.data?.[side]) ? hydrated.data[side] : [];
  for (let i = 0; i < slots.length; i += 1) {
    const slot = slots[i];
    const ok =
      draft.handleType === "source"
        ? areSlotsCompatible(draft.slot, slot)
        : areSlotsCompatible(slot, draft.slot);
    if (ok) return { slot, slotIndex: i, hydrated };
  }
  return null;
}

const nodeTypes = { [FLOW_NODE_TYPE]: FlowNodeWrapper };

function paletteCategory(node) {
  const id = (node?.id ?? "").trim();
  if (/^control/i.test(id)) return "CONTROL";
  if (/^tool/i.test(id)) return "TOOL";
  if (/^provide/i.test(id)) return "PROVIDE";
  return "AGENT";
}

function paletteDescription(node) {
  const desc = String(node?.description || node?.body || "").replace(/\s+/g, " ").trim();
  return desc;
}

function paletteDisplayLabel(node) {
  const label = String(node?.label || "").trim();
  return label || String(node?.id || "").trim();
}


function schemaTypeForPalette(node) {
  const cat = paletteCategory(node);
  if (cat === "CONTROL") return "control";
  if (cat === "PROVIDE") return "provide";
  if (cat === "TOOL") return "tool";
  return "agent";
}
































function NodeInternalsRefreshBridge({ onReady }) {
  const updateNodeInternals = useUpdateNodeInternals();
  useEffect(() => {
    onReady(updateNodeInternals);
    return () => onReady(null);
  }, [onReady, updateNodeInternals]);
  return null;
}

function clampFocusZoom(zoom) {
  const n = Number.isFinite(zoom) ? zoom : 1;
  return Math.min(Math.max(n, 0.75), 1);
}

function normalizeFlowViewport(raw) {
  if (!raw || typeof raw !== "object") return null;
  const x = Number(raw.x);
  const y = Number(raw.y);
  const zoom = Number(raw.zoom);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(zoom)) return null;
  return { x, y, zoom: Math.min(Math.max(zoom, 0.1), 4) };
}

// 长时间运行的 flow 会累积数万条 cli-raw / agent-stdout 日志。
// 不限制数量会让 DOM 节点膨胀 + 每次 append 触发全量重渲 + smoothScroll 动画 → 页面肉眼可见卡顿。
const MAX_RUN_LOGS = 1500;
const RUN_LOGS_TRIM_BUFFER = 500;






export default function FlowEditorPage({ previewMode = false }) {
  const { t, i18n } = useTranslation();
  const { navigate, path } = useRoute();
  const staticPreview = previewMode && window.__AGENTFLOW_STATIC_FLOW_PREVIEW__
    ? window.__AGENTFLOW_STATIC_FLOW_PREVIEW__
    : null;
  const updateNodeInternalsRef = useRef(null);
  const nodeHandleSignaturesRef = useRef(new Map());
  const handleNodeInternalsRefreshReady = useCallback((fn) => {
    updateNodeInternalsRef.current = typeof fn === "function" ? fn : null;
  }, []);
  const [flows, setFlows] = useState([]);
  const [listError, setListError] = useState("");
  const [selected, setSelected] = useState(null);
  const [fitViewEpoch, setFitViewEpoch] = useState(0);
  const [flowDescription, setFlowDescription] = useState("");
  const [loadError, setLoadError] = useState("");
  const [saveStatus, setSaveStatus] = useState("");
  const [renameFlowId, setRenameFlowId] = useState("");
  const [renameFlowError, setRenameFlowError] = useState("");
  /** 槽位校验横幅：关闭后隐藏，直至刷新、切换流水线或警告集合变化 */
  const [slotWarningsBannerDismissed, setSlotWarningsBannerDismissed] = useState(false);
  const [palette, setPalette] = useState([]);
  const [paletteSearch, setPaletteSearch] = useState("");
  const paletteSearchInputRef = useRef(null);
  const [flowSnippets, setFlowSnippets] = useState([]);
  const [flowSnippetsLoading, setFlowSnippetsLoading] = useState(false);
  const [flowSnippetsError, setFlowSnippetsError] = useState("");
  const [flowSnippetToast, setFlowSnippetToast] = useState("");
  const flowSnippetToastTimerRef = useRef(null);
  const [marketplaceCatalogNodes, setMarketplaceCatalogNodes] = useState([]);
  const [marketplaceCatalogLoading, setMarketplaceCatalogLoading] = useState(false);
  const [marketplaceCatalogError, setMarketplaceCatalogError] = useState("");
  const [rightPanel, setRightPanel] = useState(/** @type {null | "settings" | "history" | "node"} */ (null));
  const [recentRuns, setRecentRuns] = useState(
    /** @type {Array<{ flowId: string, runId?: string, at: number, durationMs?: number, status?: string }>} */ ([]),
  );
  const [recentRunsError, setRecentRunsError] = useState("");
  const [recentRunsLoading, setRecentRunsLoading] = useState(false);


  const refreshNodeInternals = useCallback((nodeId) => {
    const id = String(nodeId || "").trim();
    if (!id) return;
    const refresh = () => updateNodeInternalsRef.current?.(id);
    window.requestAnimationFrame(refresh);
    window.setTimeout(refresh, 80);
  }, []);

  useEffect(() => () => {
    if (flowSnippetToastTimerRef.current) {
      window.clearTimeout(flowSnippetToastTimerRef.current);
    }
  }, []);

  // 当前 pipeline 目录下的文件列表
  const [pipelineFiles, setPipelineFiles] = useState(
    /** @type {{ files: Array<{name: string, type: 'file'|'directory', icon: string, path: string, size?: number, children?: Array}>, path?: string, error?: string }} */ ({
      files: [],
    }),
  );
  const [pipelineFilesLoading, setPipelineFilesLoading] = useState(false);

  useEffect(() => {
    if (previewMode) return;
    if (!selected?.id) return;
    if (isReadonlyBuiltinFlowSource(selected.source)) return;
    recordPipelineView(selected.id, selected.source ?? "user", "pipeline", Boolean(selected.archived));
  }, [previewMode, selected?.id, selected?.source, selected?.archived]);

  useEffect(() => {
    if (!selected?.id || !isReadonlyBuiltinFlowSource(selected.source)) return;
    navigate(flowUrlForView(selected, "workspace"));
  }, [navigate, selected?.id, selected?.source, selected?.archived]);

  // ── Run mode state ──
  const [runMode, setRunMode] = useState(/** @type {"edit" | "ready" | "running" | "stopped" | "done" | "error"} */ ("edit"));
  const [runLogs, setRunLogs] = useState(/** @type {Array<{ ts: string, type: string, text: string }>} */ ([]));
  const [runConsoleOpen, setRunConsoleOpen] = useState(false);
  /** 当前一次 apply 的 run 目录 uuid（来自 apply-start），用于侧栏拉取 intermediate/output */
  const [runContextNodeId, setRunContextNodeId] = useState(/** @type {string | null} */ (null));
  const runLogEndRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  // 终端式粘底：用户在底部时自动跟随；用户手动上滑后暂停；重新回到底部自动恢复。
  const runLogStickRef = useRef(true);
  // 忽略 scrollIntoView 自身触发的 scroll 事件，避免把粘底误判成「用户上滑」。
  const runLogProgrammaticScrollRef = useRef(false);
  const [provideEditContent, setProvideEditContent] = useState(
    /** @type {null | { instanceId: string, label: string, definitionId: string, content: string }} */ (null),
  );

  const [canvasTool, setCanvasTool] = useState(/** @type {"select" | "pan"} */ ("pan"));
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [jumpPaletteOpen, setJumpPaletteOpen] = useState(false);
  const nodePanelSuppressedRef = useRef(/** @type {string | null} */ (null));
  const soleSelectedNodeRef = useRef(/** @type {import("@xyflow/react").Node | null} */ (null));

  const [nodePropsFlowEpoch, setNodePropsFlowEpoch] = useState(0);
  const [nodePropDraft, setNodePropDraft] = useState(
    /** @type {null | { id: string, newId: string, label: string, role: string, model: string, body: string, script?: string, inputs: IoDraftSlot[], outputs: IoDraftSlot[] }} */ (null),
  );
  const [nodePropsError, setNodePropsError] = useState("");
  const [modelLists, setModelLists] = useState(/** @type {{ cursor: string[], opencode: string[], claudeCode: string[], codex: string[] }} */ ({ cursor: [], opencode: [], claudeCode: [], codex: [] }));

  // 多 Session 支持





















  const instancesRef = useRef({});
  const urlLoadedRef = useRef(false);
  const reactFlowInstanceRef = useRef(null);
  const flowViewportRef = useRef(null);
  const syncHighlightTimerRef = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));
  // 自动保存用：hasLoadedRef 在 loadFlow 成功尾部置 true，期间禁止写盘防覆盖；
  // loadEpochRef 每次进入 loadFlow 自增，in-flight debounce 定时器捕获旧 epoch 时主动放弃，
  // 避免切换流水线后把旧画布状态写到新 flow 里；
  // lastPersistedYamlRef 记录最近一次成功写入的 YAML，后续相同内容的自动保存直接 short-circuit
  const hasLoadedRef = useRef(false);
  const loadEpochRef = useRef(0);
  const lastPersistedYamlRef = useRef("");
  const lastPersistedRevisionRef = useRef("");
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
  const flowCanvasFocusRef = useRef(null);
  const canvasClipboardRef = useRef(null);
  const connectionStartRef = useRef(null);
  const connectionMenuRef = useRef(null);
  const insertFlowSnippetRef = useRef(null);
  const [connectionMenu, setConnectionMenu] = useState(null);
  const restoreCanvasSnapshot = useCallback((snapshot) => {
    instancesRef.current = snapshot?.extra?.instances && typeof snapshot.extra.instances === "object"
      ? snapshot.extra.instances
      : {};
    setNodes(Array.isArray(snapshot?.nodes) ? snapshot.nodes : []);
    setEdges(Array.isArray(snapshot?.edges) ? snapshot.edges : []);
    setConnectionMenu(null);
  }, [setEdges, setNodes]);
  const canvasHistoryExtra = useMemo(() => ({ instances: instancesRef.current }), [edges, nodes]);
  const {
    resetHistory: resetCanvasHistory,
    undo: undoCanvas,
    redo: redoCanvas,
  } = useCanvasHistory({
    nodes,
    edges,
    extra: canvasHistoryExtra,
    enabled: Boolean(selected) && hasLoadedRef.current && runMode === "edit",
    onRestore: restoreCanvasSnapshot,
  });

  const provideNodes = useMemo(
    () => nodes.filter((n) => (n.data?.definitionId || "").startsWith("provide_")),
    [nodes]
  );

  const cliInputSlotNames = useMemo(() => {
    const mapping = {};
    for (const node of nodes) {
      if (!node.data?.inputs) continue;
      const inputSlots = node.data.inputs;
      for (let i = 0; i < inputSlots.length; i++) {
        const slot = inputSlots[i];
        if (!slot?.name) continue;
        const edge = edges.find(
          (e) => e.target === node.id && e.targetHandle === `input-${i}`
        );
        if (!edge?.source) continue;
        const sourceNode = provideNodes.find((p) => p.id === edge.source);
        if (sourceNode) {
          mapping[edge.source] = slot.name;
        }
      }
    }
    return mapping;
  }, [nodes, edges, provideNodes]);

  const soleSelectedNode = useMemo(() => {
    const sel = nodes.filter((n) => n.selected);
    return sel.length === 1 ? sel[0] : null;
  }, [nodes]);

  const flowSlotEdgeWarnings = useMemo(() => {
    if (!selected) return [];
    return computeSlotEdgeWarnings(nodes, edges, t);
  }, [selected, nodes, edges, t]);

  const slotWarningsSignature = useMemo(
    () => flowSlotEdgeWarnings.map((w) => w.key).join("|"),
    [flowSlotEdgeWarnings],
  );

  const hasSlotValidationError = useMemo(
    () => flowSlotEdgeWarnings.some((w) => String(w?.level || "warning").toLowerCase() === "error"),
    [flowSlotEdgeWarnings],
  );

  useLayoutEffect(() => {
    // 默认行为：仅 warning 时收起；存在 error 时展开。
    setSlotWarningsBannerDismissed(flowSlotEdgeWarnings.length > 0 && !hasSlotValidationError);
  }, [slotWarningsSignature, selected?.id, selected?.source, flowSlotEdgeWarnings.length, hasSlotValidationError]);

  soleSelectedNodeRef.current = soleSelectedNode;

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
    const refresh = () => changedIds.forEach((id) => updateNodeInternalsRef.current?.(id));
    const raf = window.requestAnimationFrame(refresh);
    const timer = window.setTimeout(refresh, 80);
    return () => {
      window.cancelAnimationFrame(raf);
      window.clearTimeout(timer);
    };
  }, [nodes]);

  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);

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

  useEffect(
    () => () => {
      if (syncHighlightTimerRef.current != null) {
        clearTimeout(syncHighlightTimerRef.current);
        syncHighlightTimerRef.current = null;
      }
    },
    [],
  );







  const loadFlowList = useCallback(async () => {
    setListError("");
    if (previewMode) {
      if (staticPreview?.flow) {
        setFlows([staticPreview.flow]);
      } else {
        setFlows([]);
        setListError("Static Flow preview data is missing");
      }
      return;
    }
    try {
      const r = await fetch("/api/flows");
      if (!r.ok) throw new Error("HTTP " + r.status);
      setFlows(await r.json());
    } catch (e) {
      setListError(String(e.message || e));
    }
  }, [previewMode, staticPreview]);

  useEffect(() => {
    loadFlowList();
  }, [loadFlowList]);

  /** 旧链接 /flow?new=1：转到首页并打开新建弹框 */
  useEffect(() => {
    if (path !== "/flow") return;
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("new") === "1" && !sp.get("flowId")) {
      navigate("/projects?new=1");
    }
  }, [path, navigate]);

  useEffect(() => {
    if (path !== "/flow" || !selected) return;
    const sp = new URLSearchParams(window.location.search);
    if (sp.get("panel") === "settings") setRightPanel("settings");
  }, [path, selected?.id, selected?.source]);

  useEffect(() => {
    if (previewMode) return undefined;
    let cancelled = false;
    const load = () => {
      fetch("/api/model-lists")
        .then((r) => r.json())
        .then((j) => {
          if (!cancelled) {
            setModelLists({
              cursor: Array.isArray(j.cursor) ? j.cursor.map(String) : [],
              opencode: Array.isArray(j.opencode) ? j.opencode.map(String) : [],
              claudeCode: Array.isArray(j.claudeCode) ? j.claudeCode.map(String) : [],
              codex: Array.isArray(j.codex) ? j.codex.map(String) : [],
            });
          }
        })
        .catch(() => {});
    };
    load();
    const t = setTimeout(load, 4000);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [previewMode]);





  const fetchFlowGraphData = useCallback(async (flow) => {
    const flowSource = flow.source ?? "user";
    const flowArchived = Boolean(flow.archived);
    const q = new URLSearchParams({ flowId: flow.id, flowSource });
    if (flowArchived) q.set("archived", "1");
    const nodeQ = new URLSearchParams({ flowId: flow.id, flowSource });
    if (flowArchived) nodeQ.set("archived", "1");
    nodeQ.set("lang", String(i18n.language || "zh").startsWith("zh") ? "zh" : "en");

    let flowRes;
    let paletteJson;
    if (previewMode) {
      if (!staticPreview) throw new Error("Static Flow preview data is missing");
      flowRes = {
        flowYaml: String(staticPreview.flowYaml || ""),
        revision: String(staticPreview.revision || ""),
      };
      paletteJson = staticPreview.nodeCatalog || { nodes: [], pipelineTranslations: {} };
    } else {
      const [fr, nr] = await Promise.all([fetch("/api/flow?" + q.toString()), fetch("/api/nodes?" + nodeQ.toString())]);
      flowRes = await fr.json();
      if (!fr.ok || flowRes.error) throw new Error(flowRes.error || t("flow:nodePropsError.loadFlowFailed"));
      paletteJson = await nr.json();
      if (!nr.ok) throw new Error(t("flow:nodePropsError.loadNodesFailed"));
    }
    const paletteList = Array.isArray(paletteJson) ? paletteJson : Array.isArray(paletteJson?.nodes) ? paletteJson.nodes : [];
    const pipelineTranslations = (!Array.isArray(paletteJson) && paletteJson?.pipelineTranslations) || {};

    const result = deserializeFromFlowYaml(flowRes.flowYaml || "");
    if (result.error) throw new Error(result.error);
    const instances = { ...(result.instances || {}) };
    const mergedNodes = result.nodes.map((n) => {
      const merged = mergeNodeWithPalette(n, instances, paletteList, pipelineTranslations, flow.id);
      return previewMode
        ? { ...merged, data: { ...merged.data, readOnly: true } }
        : merged;
    });
    const validEdges = filterValidEdges(result.edges, mergedNodes);
    return {
      flowSource,
      paletteList,
      instances,
      flowDescriptionText: result.description ?? "",
      viewport: normalizeFlowViewport(result.viewport),
      nodes: mergedNodes,
      edges: validEdges,
      revision: String(flowRes.revision || ""),
    };
  }, [i18n.language, previewMode, staticPreview, t]);

  const loadFlow = useCallback(
    /**
     * @param {{ id: string, source?: string, archived?: boolean }} flow
     * @param {{ preserveViewState?: boolean, incrementalSync?: boolean }} [opts]
     */
    async (flow, opts = {}) => {
      // 增量同步时保留画布视图状态，避免闪烁。
      const preserveViewState = Boolean(opts.preserveViewState);
      const incrementalSync = preserveViewState && Boolean(opts.incrementalSync);
      // 加载入口：冻结自动保存，epoch 自增让 in-flight 定时器放弃写入
      hasLoadedRef.current = false;
      loadEpochRef.current += 1;
      setSelected(flow);
      setLoadError("");
      if (!preserveViewState) {
        setSaveStatus("");
        setPaletteSearch("");
        setRightPanel(null);
        setFlowDescription("");
        setRenameFlowId("");
        setRenameFlowError("");
        setCanvasTool("pan");
      }
      if (!incrementalSync) {
        instancesRef.current = {};
        setNodes([]);
        setEdges([]);
      }
      replaceFlowUrl(flow, previewMode);
      try {
        const nextGraph = await fetchFlowGraphData(flow);
        setPalette(nextGraph.paletteList);
        instancesRef.current = nextGraph.instances;
        setFlowDescription(nextGraph.flowDescriptionText);
        setRenameFlowId(flow.id || "");

        if (incrementalSync) {
          const prevNodes = nodesRef.current;
          const prevEdges = edgesRef.current;
          try {
            const reconciled = reconcileFlowGraph(prevNodes, prevEdges, nextGraph.nodes, nextGraph.edges);
            const flashNodeIds = new Set([...reconciled.changes.addedNodeIds, ...reconciled.changes.updatedNodeIds]);
            const flashEdgeKeys = new Set([...reconciled.changes.addedEdgeKeys, ...reconciled.changes.updatedEdgeKeys]);

            const nodesWithFlash =
              flashNodeIds.size > 0
                ? reconciled.nodes.map((n) =>
                    flashNodeIds.has(n.id)
                      ? {
                          ...n,
                          className: appendClassName(n.className, SYNC_NODE_FLASH_CLASS),
                        }
                      : n,
                  )
                : reconciled.nodes;
            const edgesWithFlash =
              flashEdgeKeys.size > 0
                ? reconciled.edges.map((e) =>
                    flashEdgeKeys.has(buildStableEdgeKey(e))
                      ? {
                          ...e,
                          className: appendClassName(e.className, SYNC_EDGE_FLASH_CLASS),
                        }
                      : e,
                  )
                : reconciled.edges;

            setNodes(nodesWithFlash);
            setEdges(edgesWithFlash);

            if (syncHighlightTimerRef.current != null) {
              clearTimeout(syncHighlightTimerRef.current);
              syncHighlightTimerRef.current = null;
            }
            if (flashNodeIds.size > 0 || flashEdgeKeys.size > 0) {
              syncHighlightTimerRef.current = window.setTimeout(() => {
                syncHighlightTimerRef.current = null;
                if (flashNodeIds.size > 0) {
                  setNodes((prev) =>
                    prev.map((n) => {
                      if (!flashNodeIds.has(n.id)) return n;
                      const nextClassName = removeClassName(n.className, SYNC_NODE_FLASH_CLASS);
                      return nextClassName === String(n.className || "") ? n : { ...n, className: nextClassName };
                    }),
                  );
                }
                if (flashEdgeKeys.size > 0) {
                  setEdges((prev) =>
                    prev.map((e) => {
                      if (!flashEdgeKeys.has(buildStableEdgeKey(e))) return e;
                      const nextClassName = removeClassName(e.className, SYNC_EDGE_FLASH_CLASS);
                      return nextClassName === String(e.className || "") ? e : { ...e, className: nextClassName };
                    }),
                  );
                }
              }, SYNC_HIGHLIGHT_MS);
            }
          } catch {
            // diff 异常时降级全量替换，确保同步可靠性
            setNodes(nextGraph.nodes);
            setEdges(nextGraph.edges);
          }
        } else {
          setNodes(nextGraph.nodes);
          setEdges(nextGraph.edges);
          flowViewportRef.current = nextGraph.viewport || null;
          if (nextGraph.viewport) {
            const applyViewport = () => {
              try {
                reactFlowInstanceRef.current?.setViewport(nextGraph.viewport, { duration: 0 });
              } catch {
                /* React Flow may not be mounted yet during route transitions. */
              }
            };
            requestAnimationFrame(() => requestAnimationFrame(applyViewport));
          } else {
            setFitViewEpoch((x) => x + 1);
          }
        }

        recordPipelineOpened(flow.id, nextGraph.flowSource);
        setNodePropsFlowEpoch((x) => x + 1);
        resetCanvasHistory(nextGraph.nodes, nextGraph.edges, { instances: nextGraph.instances });
        // 以加载快照作为 lastPersistedYaml 基线，开启自动保存；
        // 若无用户改动，首次自动保存 debounce 结束时的 serialize 结果与基线一致 → 跳过 POST
        try {
          lastPersistedYamlRef.current = serializeToFlowYaml(
            nextGraph.nodes,
            nextGraph.edges,
            nextGraph.instances,
            { description: nextGraph.flowDescriptionText, viewport: flowViewportRef.current },
          );
        } catch {
          lastPersistedYamlRef.current = "";
        }
        lastPersistedRevisionRef.current = nextGraph.revision || "";
        hasLoadedRef.current = true;
      } catch (e) {
        setLoadError(String(e.message || e));
      }
    },
    [fetchFlowGraphData, previewMode, resetCanvasHistory, setNodes, setEdges],
  );


  const loadMarketplaceCatalog = useCallback(async () => {
    setMarketplaceCatalogLoading(true);
    setMarketplaceCatalogError("");
    try {
      const resp = await fetch("/api/marketplace/nodes");
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data?.error || "Failed to load marketplace nodes");
      setMarketplaceCatalogNodes(Array.isArray(data?.nodes) ? data.nodes : []);
    } catch (e) {
      setMarketplaceCatalogError(String(e.message || e));
      setMarketplaceCatalogNodes([]);
    } finally {
      setMarketplaceCatalogLoading(false);
    }
  }, []);

  const loadFlowSnippets = useCallback(async () => {
    setFlowSnippetsLoading(true);
    setFlowSnippetsError("");
    try {
      const resp = await fetch("/api/marketplace/flow-snippets");
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) throw new Error(data?.error || "Failed to load flow snippets");
      setFlowSnippets(Array.isArray(data?.snippets) ? data.snippets : []);
    } catch (e) {
      setFlowSnippetsError(String(e.message || e));
      setFlowSnippets([]);
    } finally {
      setFlowSnippetsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (previewMode) return;
    if (!selected) return;
    void loadMarketplaceCatalog();
    void loadFlowSnippets();
  }, [previewMode, selected?.id, selected?.source, selected?.archived, loadMarketplaceCatalog, loadFlowSnippets]);




  useEffect(() => {
    if (urlLoadedRef.current || flows.length === 0) return;
    const sp = new URLSearchParams(window.location.search);
    const id = sp.get("flowId") || (previewMode ? flows[0]?.id : "");
    if (!id) return;
    const source = sp.get("flowSource") ?? (previewMode ? flows[0]?.source || "preview" : "user");
    const wantArchived = sp.get("flowArchived") === "1";
    const f = flows.find(
      (x) => x.id === id && (x.source ?? "user") === source && Boolean(x.archived) === wantArchived,
    );
    if (f) {
      urlLoadedRef.current = true;
      loadFlow(f);
    }
  }, [flows, loadFlow, previewMode]);

  /** 外部（CLI / curl）写入 flow.yaml 后自动刷新画布。
   *  使用短轮询（2 s）替代 SSE，避免 HTTP/1.1 连接数耗尽导致 /api/flow/run 等请求排队。 */
  const syncVersionRef = useRef(0);
  useEffect(() => {
    if (previewMode) return;
    if (!selected) return;
    const flowId = selected.id;
    const flowSource = selected.source ?? "user";
    const flowArchived = Boolean(selected.archived);
    syncVersionRef.current = 0;

    let cancelled = false;
    const poll = async () => {
      if (cancelled) return;
      const q = new URLSearchParams({ flowId, flowSource, v: String(syncVersionRef.current) });
      if (flowArchived) q.set("archived", "1");
      try {
        const r = await fetch("/api/flow-editor-sync-poll?" + q.toString());
        if (!r.ok || cancelled) return;
        const j = await r.json();
        if (cancelled) return;
        if (j.changed) {
          syncVersionRef.current = j.version;
          const selectedNodeIdBeforeRefresh = soleSelectedNodeRef.current?.id ?? null;
          await loadFlow(
            { id: flowId, source: flowSource, archived: flowArchived },
            { preserveViewState: true, incrementalSync: true },
          );
          if (selectedNodeIdBeforeRefresh) {
            setNodes((prev) =>
              prev.map((n) => ({
                ...n,
                selected: n.id === selectedNodeIdBeforeRefresh,
              })),
            );
          }
        } else {
          syncVersionRef.current = j.version;
        }
      } catch (_) {}
    };
    const id = window.setInterval(poll, 2000);
    poll();
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [previewMode, selected?.id, selected?.source, selected?.archived, loadFlow, setNodes]);


  /** 成功与运行说明短暂消失，错误与「保存中」保留至下一次状态更新 */
  useEffect(() => {
    if (!saveStatus) return;
    const ms = saveStatus.startsWith(t("flow:status.runInTerminal")) ? 5200 : 2800;
    const timer = window.setTimeout(() => setSaveStatus(""), ms);
    return () => clearTimeout(timer);
  }, [saveStatus, t]);

  useEffect(() => {
    const onProvideExpand = () => {
      if (window.__provideEditContent) {
        setProvideEditContent(window.__provideEditContent);
        window.__provideEditContent = null;
      }
    };
    window.addEventListener("provide-expand", onProvideExpand);
    return () => window.removeEventListener("provide-expand", onProvideExpand);
  }, []);

  useEffect(() => {
    if (!soleSelectedNode) {
      setNodePropDraft(null);
      return;
    }
    const inst = instancesRef.current[soleSelectedNode.id] || {};
    const { inputs: draftInputs, outputs: draftOutputs } = cloneNodeIoDraftSlots(soleSelectedNode);
    const defId = String(soleSelectedNode.data?.definitionId ?? soleSelectedNode.id ?? "");
    const scriptFromNode =
      soleSelectedNode.data?.script != null ? String(soleSelectedNode.data.script) : undefined;
    const scriptFromInst = inst.script != null ? String(inst.script) : undefined;
    const scriptDraft =
      defId === "tool_nodejs" || (scriptFromNode && scriptFromNode.trim() !== "") || (scriptFromInst && scriptFromInst.trim() !== "")
        ? String(scriptFromNode ?? scriptFromInst ?? "")
        : "";
    setNodePropDraft({
      id: soleSelectedNode.id,
      newId: soleSelectedNode.id,
      label: String(soleSelectedNode.data?.label ?? soleSelectedNode.id),
      role: soleSelectedNode.data?.role ?? "普通",
      model: String(soleSelectedNode.data?.model ?? inst.model ?? ""),
      body: String(soleSelectedNode.data?.body ?? inst.body ?? ""),
      images: normalizeImages(soleSelectedNode.data?.images ?? inst.images),
      script: scriptDraft,
      inputs: draftInputs,
      outputs: draftOutputs,
    });
  }, [soleSelectedNode?.id, nodePropsFlowEpoch]);

  /** 仅一个节点选中时关闭抽屉；打开抽屉改由双击节点触发，避免单击选中时误开侧栏 */
  useEffect(() => {
    if (!selected) return;
    if (!soleSelectedNode) {
      nodePanelSuppressedRef.current = null;
      setRightPanel((p) => (p === "node" ? null : p));
    }
  }, [selected, soleSelectedNode?.id]);

  const openNodePanelFromCanvasClick = useCallback(() => {
    nodePanelSuppressedRef.current = null;
    setRightPanel((p) => {
      if (p === "settings" || p === "history") return p;
      return "node";
    });
  }, []);

  const onNodeClick = useCallback(
    (/** @type {import("react").MouseEvent} */ e, /** @type {import("@xyflow/react").Node} */ node) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      if (runMode !== "edit") {
        setRunContextNodeId(node?.id ?? null);
      }
    },
    [runMode],
  );

  const onNodeDoubleClick = useCallback(
    (/** @type {import("react").MouseEvent} */ e, /** @type {import("@xyflow/react").Node} */ node) => {
      if (runMode !== "edit") return;
      e.preventDefault();
      setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === node.id })));
      setEdges((es) => es.map((edge) => ({ ...edge, selected: false })));
      openNodePanelFromCanvasClick();
    },
    [openNodePanelFromCanvasClick, runMode, setEdges, setNodes],
  );

  const handleEdgeClick = useCallback(
    (/** @type {import("react").MouseEvent} */ e, /** @type {import("@xyflow/react").Edge} */ edge) => {
      if (runMode !== "edit") return;
      const multi = e.metaKey || e.ctrlKey || e.shiftKey;
      setEdges((eds) =>
        eds.map((ed) =>
          ed.id === edge.id
            ? { ...ed, selected: !ed.selected || !multi }
            : multi ? ed : { ...ed, selected: false }
        )
      );
      if (!multi) {
        setNodes((ns) => ns.map((n) => ({ ...n, selected: false })));
      }
    },
    [runMode, setEdges, setNodes],
  );

  const isValidConnection = useCallback((params) => isConnectionTypeCompatible(params, nodesRef.current), []);

  const onConnect = useCallback(
    (params) => {
      if (!isConnectionTypeCompatible(params, nodesRef.current)) {
        setSaveStatus("端口类型不匹配，已取消连线");
        return;
      }
      setConnectionMenu(null);
      setNodes((nds) => revealConnectedSlots(nds, params));
      setEdges((eds) => {
        // 同一个 input handle 只允许一条入边 — 替换旧连接
        const filtered = eds.filter(
          (e) => !(e.target === params.target && e.targetHandle === params.targetHandle)
        );
        return addEdge({ ...params, markerEnd: { type: MarkerType.ArrowClosed } }, filtered);
      });
    },
    [setEdges, setNodes],
  );

  const onConnectStart = useCallback((_, params) => {
    connectionStartRef.current = buildConnectionDraft(params, nodesRef.current);
    setConnectionMenu(null);
  }, []);

  const onConnectEnd = useCallback(
    (event, connectionState) => {
      const draft = connectionStartRef.current;
      connectionStartRef.current = null;
      if (!selected || !draft) return;
      if (connectionState?.toNode) return;
      const candidates = buildCompatiblePaletteCandidates(palette, draft);
      if (candidates.length === 0) {
        setSaveStatus(`没有匹配 ${draft.slotType} 端口的节点`);
        return;
      }
      const clientX = event?.changedTouches?.[0]?.clientX ?? event?.clientX;
      const clientY = event?.changedTouches?.[0]?.clientY ?? event?.clientY;
      if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
      const rfi = reactFlowInstanceRef.current;
      const wrap = document.querySelector(".af-pipeline-flow .react-flow");
      if (!rfi || !wrap) return;
      const rect = wrap.getBoundingClientRect();
      const menuWidth = 320;
      const menuHeight = Math.min(440, 104 + candidates.length * 58);
      const left = Math.max(12, Math.min(clientX - rect.left, rect.width - menuWidth - 12));
      const top = Math.max(12, Math.min(clientY - rect.top, rect.height - menuHeight - 12));
      setConnectionMenu({
        left,
        top,
        flowPosition: rfi.screenToFlowPosition({ x: clientX, y: clientY }),
        draft,
        candidates,
        query: "",
      });
    },
    [palette, selected],
  );

  const onNodesDelete = useCallback((deleted) => {
    for (const n of deleted) {
      delete instancesRef.current[n.id];
    }
  }, []);

  const onFlowInit = useCallback((instance) => {
    reactFlowInstanceRef.current = instance;
  }, []);

  const focusNodeFromSlotWarning = useCallback(
    (/** @type {string} */ nodeId) => {
      setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === nodeId })));
      setEdges((es) => es.map((e) => ({ ...e, selected: false })));
      openNodePanelFromCanvasClick();
      const center = () => {
        const rfi = reactFlowInstanceRef.current;
        if (!rfi?.getNode) return;
        const userNode = rfi.getNode(nodeId);
        if (!userNode) return;
        const internal = rfi.getInternalNode?.(nodeId);
        const w = internal?.measured?.width ?? internal?.width ?? userNode.width ?? 200;
        const h = internal?.measured?.height ?? internal?.height ?? userNode.height ?? 88;
        const { zoom } = rfi.getViewport();
        void rfi.setCenter(userNode.position.x + w / 2, userNode.position.y + h / 2, {
          zoom: clampFocusZoom(zoom),
          duration: 220,
        });
      };
      requestAnimationFrame(() => requestAnimationFrame(center));
    },
    [setNodes, setEdges, openNodePanelFromCanvasClick],
  );


  const createPaletteNodeAt = useCallback(
    (def, position) => {
      const id = `node-${Date.now()}`;
      return buildPaletteNode(def, id, position, instancesRef.current, palette);
    },
    [palette],
  );


  const handleConnectionMenuSelect = useCallback(
    (candidate) => {
      const menu = connectionMenuRef.current;
      if (!selected || !menu || !candidate?.def) return;
      const newNode = createPaletteNodeAt(candidate.def, menu.flowPosition);
      const nextConnection =
        menu.draft.handleType === "source"
          ? {
              source: menu.draft.nodeId,
              sourceHandle: menu.draft.handleId,
              target: newNode.id,
              targetHandle: `input-${candidate.slotIndex}`,
            }
          : {
              source: newNode.id,
              sourceHandle: `output-${candidate.slotIndex}`,
              target: menu.draft.nodeId,
              targetHandle: menu.draft.handleId,
            };
      setNodes((nds) => revealConnectedSlots([...nds, newNode], nextConnection));
      setEdges((eds) => {
        const filtered = eds.filter(
          (e) => !(e.target === nextConnection.target && e.targetHandle === nextConnection.targetHandle)
        );
        return addEdge({ ...nextConnection, markerEnd: { type: MarkerType.ArrowClosed } }, filtered);
      });
      setConnectionMenu(null);
    },
    [selected, createPaletteNodeAt, setNodes, setEdges],
  );

  const handlePaletteDragOver = useCallback((e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const handlePaletteDrop = useCallback(
    (e) => {
      e.preventDefault();
      if (!selected) return;
      const rfi = reactFlowInstanceRef.current;
      if (!rfi) return;
      const position = rfi.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const snippetKey = e.dataTransfer.getData("application/agentflow-snippet");
      if (snippetKey) {
        const snippet = flowSnippets.find((item) => `${item.id}@${item.version}` === snippetKey);
        if (snippet) insertFlowSnippetRef.current?.(snippet, position);
        return;
      }
      const defId = e.dataTransfer.getData("application/agentflow-node");
      if (!defId) return;
      const def = palette.find((p) => p.id === defId);
      if (!def) return;
      setNodes((nds) => [...nds, createPaletteNodeAt(def, position)]);
    },
    [selected, palette, flowSnippets, setNodes, createPaletteNodeAt],
  );

  const persistFlowToServer = useCallback(
    async (nodelist, edgelist) => {
      if (!selected) return;
      const yaml = serializeToFlowYaml(nodelist, edgelist, instancesRef.current, {
        description: flowDescription,
        viewport: flowViewportRef.current,
      });
      // 与上次成功写入完全一致时跳过，避免 loadFlow 后首次自动保存的冗余 POST
      if (yaml === lastPersistedYamlRef.current) return;
      setSaveStatus(t("flow:status.saving"));
      try {
        const writeSource = flowSourceForWrite(selected.source);
        const r = await fetch("/api/flow", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            flowId: selected.id,
            flowSource: writeSource,
            flowYaml: yaml,
            baseRevision: lastPersistedRevisionRef.current,
            ...(selected.archived ? { flowArchived: true } : {}),
          }),
        });
        const data = await r.json();
if (!r.ok || !data.success) throw new Error(data.error || t("flow:status.saveFailed"));
        lastPersistedYamlRef.current = yaml;
        lastPersistedRevisionRef.current = String(data.revision || lastPersistedRevisionRef.current);
        setSaveStatus(t("flow:status.saved"));
        if (isReadonlyBuiltinFlowSource(selected.source) && writeSource === "workspace") {
          const next = { id: selected.id, source: "workspace", path: undefined };
          setSelected(next);
          replaceFlowUrl(next);
          recordPipelineOpened(selected.id, "workspace");
        }
      } catch (e) {
        setSaveStatus(t("flow:status.saveFailed") + ": " + (e.message || e));
      }
    },
    [selected, flowDescription],
  );

  // 自动保存：nodes/edges/flowDescription 任一变化 → 400ms debounce 落盘。
  // 加载期、非 edit 模式（ready/running 等）、archived 流水线下不触发。
  // loadEpoch 快照避免切流水线后旧 timer 把旧状态写入新 flow。
  useEffect(() => {
    if (previewMode) return;
    if (!selected || !hasLoadedRef.current) return;
    if (runMode !== "edit") return;
    if (selected.archived) return;
    const epoch = loadEpochRef.current;
    const timer = setTimeout(() => {
      if (epoch !== loadEpochRef.current) return;
      if (!hasLoadedRef.current) return;
      persistFlowToServer(nodesRef.current, edgesRef.current);
    }, 400);
    return () => clearTimeout(timer);
  }, [nodes, edges, flowDescription, previewMode, runMode, selected, persistFlowToServer]);






  const handleSave = useCallback(() => {
    persistFlowToServer(nodes, edges);
  }, [persistFlowToServer, nodes, edges]);

  const lockPipelineViewport = useCallback(() => {
    if (!selected) return;
    const viewport = normalizeFlowViewport(reactFlowInstanceRef.current?.getViewport?.());
    if (!viewport) return;
    flowViewportRef.current = viewport;
    setSaveStatus("已固定 Pipeline 进入视角");
    persistFlowToServer(nodesRef.current, edgesRef.current);
  }, [persistFlowToServer, selected]);

  const handleNodeModelChange = useCallback(
    (nodeId, newModel) => {
      const normalizedModel = newModel.trim() === "" || newModel === "default" ? undefined : newModel.trim();
      const nextNodes = nodes.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, model: normalizedModel } } : n,
      );
      setNodes(nextNodes);
      persistFlowToServer(nextNodes, edges);
    },
    [nodes, edges, setNodes, persistFlowToServer],
  );

  const applyNodeProperties = useCallback(() => {
    if (!nodePropDraft || !selected || !soleSelectedNode) return false;
    const oldId = soleSelectedNode.id;
    const trimmedNew = nodePropDraft.newId.trim();
    setNodePropsError("");
    if (!NODE_INSTANCE_ID_RE.test(trimmedNew)) {
      setNodePropsError(t("flow:nodePropsError.invalidInstanceId"));
      return false;
    }
    if (nodes.some((n) => n.id === trimmedNew && n.id !== oldId)) {
      setNodePropsError(t("flow:nodePropsError.duplicateInstanceId"));
      return false;
    }
    const roleStr = nodePropDraft.role.trim();
    const role = VALID_ROLES.includes(roleStr) ? roleStr : "普通";
    const modelTrim = nodePropDraft.model.trim();
    const normIo = (arr) =>
      (Array.isArray(arr) ? arr : []).map((s) => ({
        type: String(s?.type ?? "节点").trim() || "节点",
        name: String(s?.name ?? ""),
        default: String(s?.default ?? ""),
        description: String(s?.description ?? ""),
        required: Boolean(s?.required),
        showOnNode: s?.showOnNode != null
          ? s.showOnNode !== false
          : Boolean(s?.required) || String(s?.type ?? "节点").trim().toLowerCase() === "node",
      }));
    const nextInputs = normIo(nodePropDraft.inputs);
    const nextOutputs = normIo(nodePropDraft.outputs);
    const defIdForScript = String(soleSelectedNode.data?.definitionId ?? trimmedNew);
    const isProvideDef = defIdForScript.startsWith("provide_");
    const nextData = {
      ...soleSelectedNode.data,
      label: nodePropDraft.label.trim() || trimmedNew,
      displayLabel: nodePropDraft.label.trim() || trimmedNew,
      role,
      model: modelTrim === "" || modelTrim === "default" ? undefined : modelTrim,
      body: isProvideDef ? "" : nodePropDraft.body,
      images: isProvideDef ? [] : normalizeImages(nodePropDraft.images),
      inputs: nextInputs,
      outputs: isProvideDef && Array.isArray(soleSelectedNode.data?.outputs) ? soleSelectedNode.data.outputs : nextOutputs,
    };
    const scriptTrim = String(nodePropDraft.script ?? "").trim();
    if (defIdForScript === "tool_nodejs" || scriptTrim !== "") {
      nextData.script = String(nodePropDraft.script ?? "");
    } else {
      delete nextData.script;
    }

    let nextNodes;
    let nextEdges = edges;

    if (trimmedNew !== oldId) {
      const ir = { ...instancesRef.current };
      const base = { ...(ir[oldId] || {}) };
      delete ir[oldId];
      ir[trimmedNew] = base;
      instancesRef.current = ir;

      nextNodes = nodes.map((n) => {
        if (n.id !== oldId) return n;
        return {
          ...n,
          id: trimmedNew,
          selected: true,
          data: nextData,
        };
      });
      nextEdges = edges.map((e, i) => ({
        ...e,
        source: e.source === oldId ? trimmedNew : e.source,
        target: e.target === oldId ? trimmedNew : e.target,
        id: `e-${e.source === oldId ? trimmedNew : e.source}-${e.target === oldId ? trimmedNew : e.target}-${i}`,
      }));
    } else {
      nextNodes = nodes.map((n) => (n.id === oldId ? { ...n, data: nextData } : n));
    }

    setNodes(nextNodes);
    setEdges(nextEdges);
    refreshNodeInternals(trimmedNew);
    persistFlowToServer(nextNodes, nextEdges);
    return true;
  }, [
    nodePropDraft,
    selected,
    soleSelectedNode,
    nodes,
    edges,
    setNodes,
    setEdges,
    refreshNodeInternals,
    persistFlowToServer,
  ]);

  // 自动提交 draft（除 newId 外的所有字段）。不做 id 校验，总用 oldId；
  // 无差异时早返回，避免无谓的 setNodes 触发父层保存。
  const applyNodePropertiesNoRename = useCallback(() => {
    if (!nodePropDraft || !selected || !soleSelectedNode) return false;
    const oldId = soleSelectedNode.id;
    const roleStr = nodePropDraft.role.trim();
    const role = VALID_ROLES.includes(roleStr) ? roleStr : "普通";
    const modelTrim = nodePropDraft.model.trim();
    const normIo = (arr) =>
      (Array.isArray(arr) ? arr : []).map((s) => ({
        type: String(s?.type ?? "节点").trim() || "节点",
        name: String(s?.name ?? ""),
        default: String(s?.default ?? ""),
        description: String(s?.description ?? ""),
        required: Boolean(s?.required),
        showOnNode: s?.showOnNode != null
          ? s.showOnNode !== false
          : Boolean(s?.required) || String(s?.type ?? "节点").trim().toLowerCase() === "node",
      }));
    const nextInputs = normIo(nodePropDraft.inputs);
    const nextOutputs = normIo(nodePropDraft.outputs);
    const defIdForScript = String(soleSelectedNode.data?.definitionId ?? oldId);
    const isProvideDef = defIdForScript.startsWith("provide_");
    const labelVal = nodePropDraft.label.trim() || oldId;
    const modelVal = modelTrim === "" || modelTrim === "default" ? undefined : modelTrim;
    const nextData = {
      ...soleSelectedNode.data,
      label: labelVal,
      displayLabel: labelVal,
      role,
      model: modelVal,
      body: isProvideDef ? "" : nodePropDraft.body,
      images: isProvideDef ? [] : normalizeImages(nodePropDraft.images),
      inputs: nextInputs,
      outputs: isProvideDef && Array.isArray(soleSelectedNode.data?.outputs) ? soleSelectedNode.data.outputs : nextOutputs,
    };
    const scriptTrim = String(nodePropDraft.script ?? "").trim();
    if (defIdForScript === "tool_nodejs" || scriptTrim !== "") {
      nextData.script = String(nodePropDraft.script ?? "");
    } else {
      delete nextData.script;
    }
    const prev = soleSelectedNode.data || {};
    const changed =
      prev.label !== nextData.label ||
      prev.role !== nextData.role ||
      prev.model !== nextData.model ||
      prev.body !== nextData.body ||
      JSON.stringify(normalizeImages(prev.images)) !== JSON.stringify(nextData.images) ||
      (prev.script ?? undefined) !== (nextData.script ?? undefined) ||
      JSON.stringify(prev.inputs || []) !== JSON.stringify(nextInputs) ||
      JSON.stringify(prev.outputs || []) !== JSON.stringify(nextOutputs);
    if (!changed) return true;
    setNodes((nds) => nds.map((n) => (n.id === oldId ? { ...n, data: nextData } : n)));
    refreshNodeInternals(oldId);
    return true;
  }, [nodePropDraft, selected, soleSelectedNode, setNodes, refreshNodeInternals]);

  // ref 转发避免依赖变化触发 effect 循环
  const applyNodePropertiesNoRenameRef = useRef(applyNodePropertiesNoRename);
  useEffect(() => {
    applyNodePropertiesNoRenameRef.current = applyNodePropertiesNoRename;
  }, [applyNodePropertiesNoRename]);

  // 节点属性 draft 变化 → 400ms debounce 自动提交（newId 除外，由 blur 处理）
  useEffect(() => {
    if (previewMode) return;
    if (!nodePropDraft) return;
    if (!selected || !hasLoadedRef.current) return;
    if (runMode !== "edit") return;
    const timer = setTimeout(() => {
      applyNodePropertiesNoRenameRef.current();
    }, 400);
    return () => clearTimeout(timer);
  }, [nodePropDraft, previewMode, selected, runMode]);


  const focusFlowCanvasForShortcuts = useCallback((e) => {
    if (runMode !== "edit") return;
    const target = e?.target;
    if (isEditableFocus(target)) return;
    if (target?.closest?.("button, a, [role='button'], .react-flow__handle")) return;
    flowCanvasFocusRef.current?.focus?.({ preventScroll: true });
  }, [runMode]);

  useEffect(() => {
    const onKeyDown = (/** @type {KeyboardEvent} */ e) => {
      if (previewMode) return;
      if (runMode !== "edit") return;
      const editable = isEditableFocus(e.target);

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        if (rightPanel === "node" && soleSelectedNode && nodePropDraft) {
          e.preventDefault();
          e.stopPropagation();
          const committed = applyNodeProperties();
          if (!committed) handleSave();
          return;
        }
        if (editable) return;
        e.preventDefault();
        e.stopPropagation();
        handleSave();
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        e.stopPropagation();
        setJumpPaletteOpen((o) => !o);
        return;
      }

      if (jumpPaletteOpen) {
        return;
      }

      if (shortcutsOpen) {
        if (e.key === "Escape") {
          e.preventDefault();
          setShortcutsOpen(false);
          return;
        }
        if (isQuestionMarkShortcut(e) && !e.metaKey && !e.ctrlKey && !e.altKey) {
          e.preventDefault();
          setShortcutsOpen(false);
          return;
        }
        if (
          (e.key === "v" ||
            e.key === "V" ||
            e.key === "h" ||
            e.key === "H") &&
          !e.metaKey &&
          !e.ctrlKey &&
          !e.altKey
        ) {
          e.preventDefault();
        }
        return;
      }

      if (editable) return;

      const shortcutKey = e.key.toLowerCase();
      const wantsUndo = (e.metaKey || e.ctrlKey) && !e.shiftKey && shortcutKey === "z";
      const wantsRedo =
        (e.metaKey || e.ctrlKey) &&
        ((e.shiftKey && shortcutKey === "z") || shortcutKey === "y");
      if (wantsUndo || wantsRedo) {
        e.preventDefault();
        e.stopPropagation();
        const changed = wantsUndo ? undoCanvas() : redoCanvas();
        setSaveStatus(changed ? (wantsUndo ? "Undo canvas change" : "Redo canvas change") : (wantsUndo ? "Nothing to undo" : "Nothing to redo"));
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
        const clip = buildCanvasClipboard(nodesRef.current, edgesRef.current, instancesRef.current);
        if (clip) {
          e.preventDefault();
          e.stopPropagation();
          canvasClipboardRef.current = clip;
          persistFlowCanvasClipboard(clip);
          setSaveStatus(`Copied ${clip.nodes.length} node${clip.nodes.length > 1 ? "s" : ""}`);
        }
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") {
        const canvasClipboard = canvasClipboardRef.current || readPersistedFlowCanvasClipboard();
        if (canvasClipboard && !canvasClipboardRef.current) canvasClipboardRef.current = canvasClipboard;
        const pasted = pasteCanvasClipboard(canvasClipboard, nodesRef.current, edgesRef.current, instancesRef.current);
        if (pasted) {
          e.preventDefault();
          e.stopPropagation();
          instancesRef.current = pasted.instances;
          setNodes(pasted.nodes);
          setEdges(pasted.edges);
          setSaveStatus(`Pasted ${pasted.pastedNodeIds.length} node${pasted.pastedNodeIds.length > 1 ? "s" : ""}`);
        }
        return;
      }

      if ((e.key === "a" || e.key === "A") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        paletteSearchInputRef.current?.focus();
        paletteSearchInputRef.current?.select?.();
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
        e.preventDefault();
        e.stopPropagation();
        setNodes((ns) => ns.map((n) => ({ ...n, selected: true })));
        setEdges((es) => es.map((edge) => ({ ...edge, selected: false })));
        return;
      }

      if (isQuestionMarkShortcut(e) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setShortcutsOpen((o) => !o);
        return;
      }
      if ((e.key === "v" || e.key === "V") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setCanvasTool("select");
        return;
      }
      if ((e.key === "h" || e.key === "H") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        setCanvasTool("pan");
        return;
      }
      if ((e.key === "f" || e.key === "F") && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        lockPipelineViewport();
        return;
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    handleSave,
    lockPipelineViewport,
    shortcutsOpen,
    jumpPaletteOpen,
    rightPanel,
    soleSelectedNode,
    nodePropDraft,
    applyNodeProperties,
    previewMode,
    runMode,
    undoCanvas,
    redoCanvas,
  ]);

  // ── Auto-scroll run log（终端式粘底） ──
  // 默认粘底；用户主动上滑则暂停跟随，重新接近底部时自动恢复。ring buffer 由 MAX_RUN_LOGS 裁剪保证。
  useEffect(() => {
    const end = runLogEndRef.current;
    if (!end) return;
    const scroller = end.parentElement;
    if (!scroller) return;
    if (!runLogStickRef.current) return;
    runLogProgrammaticScrollRef.current = true;
    end.scrollIntoView({ behavior: "auto", block: "end" });
    // 下一帧解除忽略：scrollIntoView 产生的 scroll 事件会在本轮事件循环里派发。
    requestAnimationFrame(() => { runLogProgrammaticScrollRef.current = false; });
  }, [runLogs]);

  // 订阅 console 滚动事件，实时更新 stick 状态。
  useEffect(() => {
    const end = runLogEndRef.current;
    if (!end) return;
    const scroller = end.parentElement;
    if (!scroller) return;
    const onScroll = () => {
      if (runLogProgrammaticScrollRef.current) return;
      const distance = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
      runLogStickRef.current = distance < 40;
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => scroller.removeEventListener("scroll", onScroll);
  }, [runConsoleOpen, runMode]);

  // 进入 run 模式 / console 重新打开时，强制回到底部并恢复粘底。
  useEffect(() => {
    if (runMode === "edit" || !runConsoleOpen) return;
    runLogStickRef.current = true;
    const end = runLogEndRef.current;
    if (!end) return;
    runLogProgrammaticScrollRef.current = true;
    end.scrollIntoView({ behavior: "auto", block: "end" });
    requestAnimationFrame(() => { runLogProgrammaticScrollRef.current = false; });
  }, [runMode, runConsoleOpen]);

  // ── Run log 数量上限：超阈值时裁剪到 MAX，避免 DOM 爆炸与全量重渲 ──
  useEffect(() => {
    if (runLogs.length > MAX_RUN_LOGS + RUN_LOGS_TRIM_BUFFER) {
      setRunLogs((prev) => (prev.length > MAX_RUN_LOGS + RUN_LOGS_TRIM_BUFFER ? prev.slice(-MAX_RUN_LOGS) : prev));
    }
  }, [runLogs]);









  // ── 页面加载 / 刷新后检测活跃 run，恢复 run 模式 ──

  // ── run 模式下轮询节点状态（刷新后继续看到推进、完成自动翻转） ──

  useEffect(() => {
    if (rightPanel !== "history" || !selected) return;
    let cancelled = false;
    (async () => {
      setRecentRunsLoading(true);
      setRecentRunsError("");
      try {
        const r = await fetch("/api/pipeline-recent-runs");
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
        if (!cancelled) setRecentRuns(Array.isArray(j.runs) ? j.runs : []);
      } catch (e) {
        if (!cancelled) {
          setRecentRunsError(String(e.message || e));
          setRecentRuns([]);
        }
      } finally {
        if (!cancelled) setRecentRunsLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rightPanel, selected]);

  // 加载当前 pipeline 目录下的文件列表
  useEffect(() => {
    if (previewMode) {
      setPipelineFiles({ files: [] });
      return;
    }
    if (!selected) {
      setPipelineFiles({ files: [] });
      return;
    }
    let cancelled = false;
    (async () => {
      setPipelineFilesLoading(true);
      try {
        const params = new URLSearchParams({
          flowId: selected.id,
          flowSource: selected.source || "user",
          archived: selected.archived ? "1" : "0",
        });
        const r = await fetch(`/api/pipeline-files?${params}`);
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
        if (!cancelled) {
          setPipelineFiles({ files: Array.isArray(j.files) ? j.files : [], path: j.path, error: j.error });
        }
      } catch (e) {
        if (!cancelled) {
          setPipelineFiles({ files: [], error: e.message || String(e) });
        }
      } finally {
        if (!cancelled) setPipelineFilesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [previewMode, selected]);












  const makeUniqueSnippetNodeId = useCallback((base, used) => {
    const clean = String(base || "snippet-node")
      .trim()
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "snippet-node";
    const stamp = Date.now().toString(36);
    let id = `${clean}-${stamp}`;
    let i = 2;
    while (used.has(id)) {
      id = `${clean}-${stamp}-${i}`;
      i += 1;
    }
    used.add(id);
    return id;
  }, []);

  const insertFlowSnippet = useCallback(
    (snippetEntry, positionOverride) => {
      if (!selected || !snippetEntry) return;
      const snippet = snippetEntry.snippet && typeof snippetEntry.snippet === "object" ? snippetEntry.snippet : {};
      const instances = snippet.instances && typeof snippet.instances === "object" ? snippet.instances : {};
      const oldIds = Object.keys(instances);
      if (oldIds.length === 0) return;
      const used = new Set(nodesRef.current.map((n) => n.id));
      const idMap = {};
      for (const oldId of oldIds) idMap[oldId] = makeUniqueSnippetNodeId(oldId, used);

      const positions = snippet.ui?.nodePositions && typeof snippet.ui.nodePositions === "object"
        ? snippet.ui.nodePositions
        : {};
      const sourceSizes = snippet.ui?.nodeSizes && typeof snippet.ui.nodeSizes === "object"
        ? snippet.ui.nodeSizes
        : {};
      const sourcePositions = oldIds.map((id) => {
        const p = positions[id];
        return {
          id,
          x: typeof p?.x === "number" ? p.x : 0,
          y: typeof p?.y === "number" ? p.y : 0,
        };
      });
      const minX = Math.min(...sourcePositions.map((p) => p.x));
      const minY = Math.min(...sourcePositions.map((p) => p.y));
      let insertAt = positionOverride || { x: 180, y: 160 };
      const rfi = reactFlowInstanceRef.current;
      const wrap = document.querySelector(".af-pipeline-flow .react-flow");
      if (!positionOverride && rfi && wrap) {
        const rect = wrap.getBoundingClientRect();
        insertAt = rfi.screenToFlowPosition({
          x: rect.left + rect.width * 0.48,
          y: rect.top + rect.height * 0.32,
        });
      }

      const remappedInstances = {};
      for (const oldId of oldIds) {
        remappedInstances[idMap[oldId]] = { ...(instances[oldId] || {}) };
      }
      instancesRef.current = { ...instancesRef.current, ...remappedInstances };

      const nextNodes = oldIds.map((oldId) => {
        const inst = instances[oldId] || {};
        const pos = sourcePositions.find((p) => p.id === oldId) || { x: 0, y: 0 };
        const size = sourceSizes[oldId] && typeof sourceSizes[oldId].width === "number" && typeof sourceSizes[oldId].height === "number"
          ? { width: sourceSizes[oldId].width, height: sourceSizes[oldId].height }
          : null;
        const rawNode = {
          id: idMap[oldId],
          type: "flowNode",
          selected: true,
          position: {
            x: insertAt.x + (pos.x - minX),
            y: insertAt.y + (pos.y - minY),
          },
          ...(size ? { width: size.width, height: size.height } : {}),
          data: {
            label: inst.label || idMap[oldId],
            definitionId: inst.definitionId || oldId,
            role: inst.role || "normal",
            body: inst.body || "",
            script: inst.script || "",
            ...(size ? { displaySize: size } : {}),
          },
        };
        return mergeNodeWithPalette(rawNode, instancesRef.current, palette, {}, selected.id);
      });

      const oldIdSet = new Set(oldIds);
      const nextEdges = (Array.isArray(snippet.edges) ? snippet.edges : [])
        .filter((edge) => oldIdSet.has(edge?.source) && oldIdSet.has(edge?.target))
        .map((edge, index) => ({
          id: `e-${idMap[edge.source]}-${idMap[edge.target]}-${Date.now()}-${index}`,
          source: idMap[edge.source],
          target: idMap[edge.target],
          sourceHandle: edge.sourceHandle ?? undefined,
          targetHandle: edge.targetHandle ?? undefined,
          markerEnd: { type: MarkerType.ArrowClosed },
        }));

      setNodes((prev) => [...prev.map((n) => ({ ...n, selected: false })), ...nextNodes]);
      setEdges((prev) => [...prev.map((e) => ({ ...e, selected: false })), ...nextEdges]);
      setSaveStatus(`已添加流程片段：${snippetEntry.displayName || snippetEntry.id}`);
    },
    [makeUniqueSnippetNodeId, palette, selected, setEdges, setNodes],
  );
  insertFlowSnippetRef.current = insertFlowSnippet;






















  return (
    <ReactFlowProvider>
      <NodeInternalsRefreshBridge onReady={handleNodeInternalsRefreshReady} />
      <FlowNodeContext.Provider value={{ modelLists, onModelChange: handleNodeModelChange }}>
        <div className={"af-pipeline-page" + (runMode !== "edit" ? " af-pipeline-page--run-mode" : "") + (previewMode ? " af-pipeline-page--preview" : "")}>
          <header className="af-pipeline-top">
            <div className="af-pipeline-top-left">
              <button
                type="button"
                className="af-icon-btn af-pipeline-back"
                onClick={() => {
                  if (previewMode) {
                    window.history.back();
                  } else {
                    navigate("/projects");
                  }
                }}
                aria-label={previewMode ? "返回" : runMode !== "edit" ? t("flow:topbar.backToEdit") : t("flow:topbar.backToProjects")}
                title={previewMode ? "返回" : runMode !== "edit" ? t("flow:topbar.backToEdit") : t("flow:topbar.backToProjects")}
            >
              <span className="material-symbols-outlined">arrow_back</span>
            </button>
            <div className="af-pipeline-brand">
              <span className="af-pipeline-brand-name">{previewMode ? "LOCAL PREVIEW" : "PIPELINE"}</span>
              <span className="af-pipeline-brand-ver">{previewMode ? selected?.id || "flow.yaml" : `V${APP_VERSION}-STABLE`}</span>
            </div>
            {!previewMode ? <div className="af-view-switch" aria-label="视图切换">
              <button type="button" className="af-view-switch__active">Pipeline</button>
              <button type="button" onClick={() => navigate(flowUrlForView(selected, "workspace"))}>Workspace</button>
              <button type="button" onClick={() => navigate(flowUrlForView(selected, "display"))}>Display</button>
            </div> : <span className="af-flow-preview-badge"><span className="material-symbols-outlined" aria-hidden>visibility</span>只读</span>}
          </div>
          <div className="af-pipeline-top-right af-flow-toolbar-actions">
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

        <div className={"af-pipeline-body" + (runMode !== "edit" ? " af-pipeline-body--run-mode" : "") + (previewMode ? " af-pipeline-body--preview" : "")}>

          <div className="af-pipeline-main-stack">
          <div className="af-pipeline-canvas-col">
            {loadError ? <div className="af-banner af-banner--err af-pipeline-banner">{loadError}</div> : null}
            {selected && flowSlotEdgeWarnings.length > 0 && !slotWarningsBannerDismissed ? (
              <div
                className="af-banner af-banner--warn af-flow-slot-warnings"
                role="region"
                aria-label={t("flow:validation.flowWarningAriaLabel")}
              >
                <div className="af-flow-slot-warnings-head">
                  <div className="af-flow-slot-warnings-title">{t("flow:palette.validationWarnings")}</div>
                  <div className="af-flow-slot-warnings-head-actions">
                    <button
                      type="button"
                      className="af-icon-btn"
                      aria-label={t("flow:validation.closeBanner")}
                      title={t("common:common.close")}
                      onClick={() => setSlotWarningsBannerDismissed(true)}
                    >
                      <span className="material-symbols-outlined" aria-hidden>
                        close
                      </span>
                    </button>
                  </div>
                </div>
                <ul className="af-flow-slot-warnings-list">
                  {flowSlotEdgeWarnings.map((w) => (
                    <li key={w.key}>
                      {t("flow:validation.nodePrefix")} &quot;
                      <a
                        href="#"
                        className="af-flow-slot-warning-node-link"
                        aria-label={t("flow:validation.focusNodeAriaLabel", { nodeId: w.nodeId })}
                        onClick={(e) => {
                          e.preventDefault();
                          focusNodeFromSlotWarning(w.nodeId);
                        }}
                      >
                        {w.nodeId}
                      </a>
                      &quot;{w.suffix}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {selected && flowSlotEdgeWarnings.length > 0 && slotWarningsBannerDismissed ? (
              <div
                className="af-banner af-banner--warn af-flow-slot-warnings af-flow-slot-warnings--collapsed"
                role="status"
                aria-live="polite"
              >
                <span className="af-flow-slot-warnings-collapsed-text">
                  {t("flow:validation.slotWarningCount", { count: flowSlotEdgeWarnings.length })}
                </span>
                <div className="af-flow-slot-warnings-collapsed-actions">
                  <button
                    type="button"
                    className="af-flow-slot-warnings-collapsed-btn"
                    onClick={() => setSlotWarningsBannerDismissed(false)}
                  >
                    {t("flow:validation.show")}
                  </button>
                </div>
              </div>
            ) : null}
            <div
              ref={flowCanvasFocusRef}
              className="af-react-flow-wrap af-pipeline-flow"
              tabIndex={-1}
              onPointerDownCapture={focusFlowCanvasForShortcuts}
            >
              {selected ? (
                <>
                <FlowBoard
                  fitViewEpoch={fitViewEpoch}
                  canvasTool={canvasTool}
                  nodes={nodes}
                  edges={edges}
                  onNodesChange={runMode !== "edit" ? undefined : onNodesChange}
                  onEdgesChange={runMode !== "edit" ? undefined : onEdgesChange}
                  onConnect={runMode !== "edit" ? undefined : onConnect}
                  onConnectStart={runMode !== "edit" ? undefined : onConnectStart}
                  onConnectEnd={runMode !== "edit" ? undefined : onConnectEnd}
                  isValidConnection={runMode !== "edit" ? undefined : isValidConnection}
                  onNodesDelete={runMode !== "edit" ? undefined : onNodesDelete}
                  onNodeClick={onNodeClick}
                  onNodeDoubleClick={onNodeDoubleClick}
                  onEdgeClick={handleEdgeClick}
                  onFlowInit={onFlowInit}
                  onDrop={handlePaletteDrop}
                  onDragOver={handlePaletteDragOver}
                  hideMinimapAndControls={Boolean(selected && rightPanel)}
                  readOnly={previewMode}
                />
                {connectionMenu && runMode === "edit" ? (() => {
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
                </>
              ) : (
                <div className="af-placeholder af-pipeline-placeholder">{t("flow:pipeline.selectPipeline")}</div>
              )}
            </div>
          </div>

          </div>


        </div>

      </div>

      </FlowNodeContext.Provider>
    </ReactFlowProvider>
  );
}
