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
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import { buildStableEdgeKey, reconcileFlowGraph } from "../flowDiff.js";
import { buildCanvasClipboard, buildInstancesForYaml, deserializeFromFlowYaml, pasteCanvasClipboard, serializeToFlowYaml, VALID_ROLES } from "../flowFormat.js";
import { computeSlotEdgeWarnings } from "../flowSlotEdgeWarnings.js";
import { normalizeImages } from "../imageAttachments.js";
import { cloneNodeIoDraftSlots, filterValidEdges, mergeNodeWithPalette, revealConnectedSlots } from "../mergeFlowNodes.js";
import { formatDurationMs, formatRelativeTime, recordPipelineOpened } from "../pipelineRecent.js";
import { flowUrlForView, recordPipelineView } from "../pipelineViewPreference.js";
import { useCanvasHistory } from "../useCanvasHistory.js";
import {
  addSkillKeys,
  collectionSelectionState,
  collectionSkillKeys,
  normalizeSkillCollections,
  readStoredOrDefaultSkillKeys,
  removeSkillKeys,
} from "../skillCollections.js";
import { useRoute } from "../routeContext.jsx";
import { FLOW_NODE_TYPE, FlowNode } from "../FlowNode.jsx";
import {
  areSlotsCompatible,
  getHandleColor,
  getNodeSlotByHandle,
  getSlotConnectionLabel,
} from "../nodeSchema.js";
import { isEditableFocus, isQuestionMarkShortcut } from "../hotkeyUtils.js";
import { ArchivePipelineModal } from "../ArchivePipelineModal.jsx";
import { ConfirmModal } from "../ConfirmModal.jsx";
import { DeletePipelineModal } from "../DeletePipelineModal.jsx";
import { KeyboardShortcutsModal } from "../KeyboardShortcutsModal.jsx";
import { NodeJumpPalette } from "../NodeJumpPalette.jsx";
import { FileEditModal } from "../FileEditModal.jsx";
import { NODE_INSTANCE_ID_RE, NodePropertiesPanel } from "../NodePropertiesPanel.jsx";
import RunNodeContextPanel from "../RunNodeContextPanel.jsx";
import RunConfigPanel from "../components/RunConfigPanel.jsx";
import LogViewer from "../components/LogViewer.jsx";

/* global __APP_VERSION__ */
const APP_VERSION = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";

/** 顶栏 MM:SS.cc；ms 为从 0 起的经过毫秒数 */
function formatStopwatchMs(ms) {
  const n = Math.max(0, Number(ms) || 0);
  const h = Math.floor(n / 3600000);
  const m = Math.floor((n % 3600000) / 60000);
  const s = Math.floor((n % 60000) / 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * running：始终显示计时数字；其余模式：无有效累计时长时显示 --（如从历史进入且磁盘无 totalExecutedMs）
 * @param {number} ms
 * @param {"running" | "stopped" | "done" | "error"} mode
 */
function formatToolbarRunTimer(ms, mode) {
  if (mode === "running") return formatStopwatchMs(ms);
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "--";
  return formatStopwatchMs(ms);
}

/** @typedef {{ type: string, name: string, default: string }} IoDraftSlot */

/** @type {React.Context<{ modelLists: { cursor: string[], opencode: string[] }, onModelChange: (nodeId: string, newModel: string) => void }>} */
const FlowNodeContext = createContext({ modelLists: { cursor: [], opencode: [] }, onModelChange: () => {} });

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

const nodeTypes = { [FLOW_NODE_TYPE]: FlowNodeWrapper };

const PALETTE_ORDER = ["CONTROL", "TOOL", "PROVIDE", "AGENT"];
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

function paletteCategory(node) {
  const id = (node?.id ?? "").trim();
  if (/^control/i.test(id)) return "CONTROL";
  if (/^tool/i.test(id)) return "TOOL";
  if (/^provide/i.test(id)) return "PROVIDE";
  return "AGENT";
}

function schemaTypeForPalette(node) {
  const cat = paletteCategory(node);
  if (cat === "CONTROL") return "control";
  if (cat === "PROVIDE") return "provide";
  if (cat === "TOOL") return "tool";
  return "agent";
}

function summarizeMarketplaceSlots(slots) {
  const list = Array.isArray(slots) ? slots : [];
  return list
    .map((slot) => {
      const name = String(slot?.name || slot?.id || "").trim();
      const type = String(slot?.type || "").trim();
      if (!name && !type) return "";
      return type ? `${name || "-"}: ${type}` : name;
    })
    .filter(Boolean);
}

function paletteDisplayLabel(node) {
  const label = String(node?.label || "").trim();
  return label || String(node?.id || "").trim();
}

function paletteDescription(node) {
  const desc = String(node?.description || node?.body || "").replace(/\s+/g, " ").trim();
  return desc;
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

function paletteIcon(cat) {
  if (cat === "CONTROL") return "account_tree";
  if (cat === "TOOL") return "build";
  if (cat === "PROVIDE") return "database";
  return "smart_toy";
}

function paletteNodeMatchesQuery(node, queryLower) {
  if (!queryLower) return true;
  const parts = [node?.id, node?.label, node?.description].filter(Boolean);
  return parts.some((s) => String(s).toLowerCase().includes(queryLower));
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

const DEFAULT_FLOW_NODE_WIDTH = 320;
const MIN_FLOW_NODE_WIDTH = 220;
const MAX_FLOW_NODE_WIDTH = 1600;
const MIN_FLOW_NODE_HEIGHT = 104;
const MAX_FLOW_NODE_HEIGHT = 900;

function clampNumber(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(max, Math.max(min, Math.round(n)));
}

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

/** @type {RegExp} */
const MENTION_ID_RE = /@([a-zA-Z_][a-zA-Z0-9_]*)/g;

/**
 * 从全文解析 @实例ID（去重，保持出现顺序）。
 * @param {string} text
 * @returns {string[]}
 */
function parseMentionInstanceIds(text) {
  const seen = new Set();
  const ordered = [];
  let m;
  const re = new RegExp(MENTION_ID_RE.source, "g");
  while ((m = re.exec(text)) !== null) {
    const id = m[1];
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}

/**
 * 光标处是否正在输入 @提及（@ 后至光标之间无空白）。
 * @param {string} text
 * @param {number} cursor
 * @returns {{ atIndex: number, query: string } | null}
 */
function mentionDraftAtCursor(text, cursor) {
  const before = text.slice(0, cursor);
  const at = before.lastIndexOf("@");
  if (at < 0) return null;
  const afterAt = before.slice(at + 1);
  if (/[\s\n]/.test(afterAt)) return null;
  return { atIndex: at, query: afterAt };
}

/**
 * Composer 模型下拉：OpenCode 项使用 `opencode:` 前缀；兼容旧值（仅在 opencode 列表中的无前缀 id）。
 * @param {string} model
 * @param {string[]} cursorList
 * @param {string[]} opencodeList
 */
/** "composer-2-fast - Composer 2 Fast (default)" → "composer-2-fast" */
function modelEntryId(entry) {
  const idx = String(entry || "").indexOf(" - ");
  return idx >= 0 ? entry.slice(0, idx).trim() : String(entry || "").trim();
}

function normalizeComposerModelValue(model, cursorList, opencodeList, claudeCodeList) {
  const m = (model || "").trim();
  if (!m) return "";
  if (m.startsWith("opencode:") || m.startsWith("claude-code:")) return m;
  const c = Array.isArray(cursorList) ? cursorList : [];
  const o = Array.isArray(opencodeList) ? opencodeList : [];
  const cc = Array.isArray(claudeCodeList) ? claudeCodeList : [];
  const cIds = c.map(modelEntryId);
  const oIds = o.map(modelEntryId);
  const ccIds = cc.map(modelEntryId);
  if (ccIds.includes(m) && !cIds.includes(m) && !oIds.includes(m)) return `claude-code:${m}`;
  if (oIds.includes(m) && !cIds.includes(m)) return `opencode:${m}`;
  return m;
}

/** 步骤条、芯片上展示的模型名（过长则截断） */
function formatComposerModelShort(model) {
  if (model == null) return "";
  const t = String(model).trim();
  if (!t) return "";
  if (t.length <= 26) return t;
  return `${t.slice(0, 12)}…${t.slice(-10)}`;
}

/** 从会话标题「对话 N」解析最大序号；与 localStorage 恢复配合，避免新建仍从 ref=0 递增得到第二个「对话 1」 */
function maxDialogueNumFromSessionLabels(sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) return 0;
  let max = 0;
  for (const s of sessions) {
    const m = /^(?:对话|Conversation|Chat)\s*(\d+)\s*$/.exec(String(s?.label ?? "").trim());
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return max;
}

/**
 * 多步任务进度：横向可滚动卡片，展示序号、摘要、角色与模型。
 * @param {{ steps: Array<{ index: number, type?: string, description?: string, status?: string, nodeRole?: string, executorModel?: string, model?: string, instanceId?: string }> }} props
 */
function ComposerStepsTrack({ steps }) {
  const { t } = useTranslation();
  if (!steps || steps.length === 0) return null;
  return (
    <div className="af-composer-steps-track" role="list" aria-label={t("flow:composer.stepsAriaLabel")}>
      {steps.map((s) => {
        const desc = String(s.description || s.type || "").trim();
        const modelShow = s.model || s.executorModel;
        const title = [
          `${s.index + 1}. ${desc || "—"}`,
          s.nodeRole ? t("flow:composer.stepRoleLabel", { role: s.nodeRole }) : "",
          s.instanceId ? t("flow:composer.stepInstanceLabel", { instanceId: s.instanceId }) : "",
          modelShow ? `${t("flow:palette.model")}：${modelShow}` : "",
        ]
          .filter(Boolean)
          .join("\n");
        const st = s.status || "pending";
        return (
          <div
            key={s.index}
            className={
              "af-composer-step-chip" +
              (st === "done" ? " af-composer-step-chip--done" : "") +
              (st === "running" ? " af-composer-step-chip--running" : "") +
              (st === "error" ? " af-composer-step-chip--error" : "") +
              (st === "pending" ? " af-composer-step-chip--pending" : "")
            }
            role="listitem"
            title={title}
          >
            <span className="af-composer-step-chip-idx">{s.index + 1}</span>
            <span className="af-composer-step-chip-main">
              {s.nodeRole || modelShow ? (
                <span className="af-composer-step-chip-meta">
                  {s.nodeRole ? <span className="af-composer-step-chip-role">{s.nodeRole}</span> : null}
                  {modelShow ? (
                    <span className="af-composer-step-chip-model">{formatComposerModelShort(modelShow)}</span>
                  ) : null}
                </span>
              ) : null}
            </span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Cursor 流式 assistant 与最终 result 常重复，展开/面板中省略重复的「结果」块。
 */
function shouldOmitComposerResult(assistantJoined, resultJoined) {
  const a = assistantJoined.trim();
  const r = resultJoined.trim();
  if (!r) return true;
  if (!a) return false;
  if (a === r) return true;
  if (a.endsWith(r)) return true;
  if (r.length >= 8 && a.includes(r)) return true;
  return false;
}

/**
 * 合并流式相邻同 kind 片段，保留时间顺序（思考与回复可穿插）。
 * 过滤掉空内容或仅包含空白字符的片段。
 * @param {Array<{ kind: string, text: string }>} segments
 * @returns {Array<{ kind: string, text: string }>}
 */
function coalesceComposerSegmentsInOrder(segments) {
  const out = [];
  for (const s of segments) {
    if (!s || typeof s.text !== "string") continue;
    const trimmed = s.text.trim();
    if (!trimmed) continue; // 过滤空内容或仅空白字符
    const kind = typeof s.kind === "string" && s.kind ? s.kind : "assistant";
    const last = out[out.length - 1];
    if (last && last.kind === kind) {
      last.text += (kind === "error" || kind === "result") ? `\n${s.text}` : s.text;
    } else {
      out.push({ kind, text: s.text });
    }
  }
  return out;
}

function segmentKindToComposerLabel(kind, t) {
  if (kind === "thinking") return t("flow:composer.thinking");
  if (kind === "result") return t("flow:composer.result");
  if (kind === "assistant") return t("flow:composer.reply");
  if (kind === "error") return t("flow:composer.error");
  return String(kind);
}

function segmentKindToComposerBlockClass(kind) {
  if (kind === "thinking") return "af-composer-ai-block af-composer-ai-block--thinking";
  if (kind === "result") return "af-composer-ai-block af-composer-ai-block--result";
  if (kind === "assistant") return "af-composer-ai-block af-composer-ai-block--reply";
  if (kind === "error") return "af-composer-ai-block af-composer-ai-block--error";
  return "af-composer-ai-block af-composer-ai-block--reply";
}

/**
 * 对话线程：历史轮次 + 当前轮流式片段（与底部输出区一致的分块展示，非纯文本拼接）。
 * 支持自动滚动到底部。
 * @param {{
 *   thread: Array<
 *     | { type: "user"; text: string }
 *     | { type: "assistant"; segments: Array<{ kind: string; text: string }> }
 *   >,
 *   liveSegments: Array<{ kind: string; text: string }>,
 *   running: boolean,
 *   className?: string,
 *   autoScroll?: boolean,
 * }} props
 */
function ComposerThreadContent({ thread, liveSegments, running, className = "", autoScroll = true }) {
  const { t } = useTranslation();
  const stackRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const stackClass = ["af-composer-ai-stack", "af-composer-ai-stack--in-panel", "af-composer-thread-stack", className]
    .filter(Boolean)
    .join(" ");

  // 自动滚动到底部
  useEffect(() => {
    if (!autoScroll || !stackRef.current) return;
    const el = stackRef.current;
    // 使用 requestAnimationFrame 确保在渲染完成后滚动
    requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
  }, [thread, liveSegments, autoScroll]);

  return (
    <div ref={stackRef} className={stackClass}>
      {thread.map((item, i) =>
        item.type === "user" ? (
          <section
            key={`composer-u-${i}-${item.text.slice(0, 48)}`}
            className="af-composer-ai-block af-composer-ai-block--user-msg"
          >
            <div className="af-composer-ai-block-label">{t("flow:composer.yourQuestion")}</div>
            <div className="af-composer-ai-block-body">{item.text}</div>
          </section>
        ) : (
          <div key={`composer-a-${i}`} className="af-composer-thread-assistant">
            <AssistantStreamBlocks segments={item.segments} running={false} />
          </div>
        ),
      )}
      <div className="af-composer-thread-assistant">
        <AssistantStreamBlocks segments={liveSegments} running={running} />
      </div>
    </div>
  );
}

/**
 * 单轮 AI 输出：按流式到达顺序展示思考 / 回复 / 结果（相邻同 kind 合并）；错误置底。running 且无内容时显示等待。
 * @param {{ segments: Array<{ kind: string, text: string }>, running?: boolean }} props
 */
function AssistantStreamBlocks({ segments, running = false }) {
  const { t } = useTranslation();
  const reply = segments.filter((s) => s.kind === "assistant").map((s) => s.text).join("");
  const result = segments.filter((s) => s.kind === "result").map((s) => s.text).join("");
  const omitResult = shouldOmitComposerResult(reply, result);
  const errText = segments
    .filter((s) => s.kind === "error")
    .map((s) => s.text)
    .join("\n");
  const naturalRaw = segments.filter((s) => s.kind !== "error");
  const naturalFiltered = omitResult ? naturalRaw.filter((s) => s.kind !== "result") : naturalRaw;
  const orderedBlocks = coalesceComposerSegmentsInOrder(naturalFiltered);
  const hasBody = Boolean(orderedBlocks.length > 0 || errText);
  return (
    <>
      {orderedBlocks.map((s, i) => (
        <section key={`${s.kind}-${i}`} className={segmentKindToComposerBlockClass(s.kind)}>
          <div className="af-composer-ai-block-label">{segmentKindToComposerLabel(s.kind, t)}</div>
          <div className="af-composer-ai-block-body">{s.text}</div>
        </section>
      ))}
      {running && !hasBody ? (
        <section className="af-composer-ai-block af-composer-ai-block--reply af-composer-ai-block--pending">
          <div className="af-composer-ai-block-label">{t("flow:composer.reply")}</div>
          <div className="af-composer-ai-block-body">{t("flow:composer.waiting")}</div>
        </section>
      ) : null}
      {errText ? (
        <section className="af-composer-ai-block af-composer-ai-block--error">
          <div className="af-composer-ai-block-label">{t("flow:composer.error")}</div>
          <div className="af-composer-ai-block-body">{errText}</div>
        </section>
      ) : null}
    </>
  );
}

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
// 轮询日志时单次增量字节上限：防止 log 突增导致一次性解析/渲染几十 MB。
const RUN_LOG_POLL_TAIL_BYTES = 262144;
// 单行日志渲染上限：agent stdout / JSON blob 可能数十 KB，整行塞进 DOM
// 会把 RunConsole 卡成 PPT。截断不影响历史文件，仅压缩 UI 呈现。
// 重要：V8 的 String.prototype.slice 会产生 SlicedString，共享父串底层 buffer；
// 直接返回 slice + 拼接不会释放原始 20KB/200KB 父串（初次 tail 256KB 里 500+ 条，
// 每条各自 slice，这一整块内存被拽着不放）。
// 用短占位字符串（全字面量）替代，保证父串可以被 GC。
const MAX_LOG_LINE_CHARS = 2000;
function capLogText(text) {
  if (typeof text !== "string") return "";
  if (text.length <= MAX_LOG_LINE_CHARS) return text;
  return `[log line truncated, ${text.length} chars]`;
}

// 解析单次 log 文本时最多产出的条目数。tail=256KB 若是细碎行可能几千条，
// 全塞到 setRunLogs 会让 React 做一轮无谓的大 diff（后面马上又被 trim 掉）。
const MAX_LOG_ENTRIES_PER_PARSE = MAX_RUN_LOGS;

/** 解析 runs/{uuid}/logs/log.txt 的一行 `[ISO] [tag] body` */
function parseRunLogLine(line) {
  const m = line.match(/^\[([^\]]+)\]\s+\[([^\]]+)\]\s+([\s\S]*)$/);
  if (!m) return null;
  const [, ts, tag, body] = m;
  if (tag === "cli") {
    try {
      const evt = JSON.parse(body);
      if (evt && evt.event === "node-start") {
        return { ts, type: "node-start", text: `节点 ${evt.instanceId || ""}${evt.label ? ` · ${evt.label}` : ""} 开始` };
      }
      if (evt && evt.event === "node-done") {
        return { ts, type: "node-done", text: `节点 ${evt.instanceId || ""} 完成${evt.elapsed ? ` (${evt.elapsed})` : ""}` };
      }
      if (evt && evt.event === "node-failed") {
        return { ts, type: "node-failed", text: `节点 ${evt.instanceId || ""} 失败${evt.error ? `: ${evt.error}` : ""}` };
      }
      if (evt && evt.event === "apply-start") {
        return { ts, type: "info", text: `[apply-start] uuid=${evt.uuid || ""}` };
      }
      return { ts, type: "info", text: capLogText(body) };
    } catch {
      return { ts, type: "info", text: capLogText(body) };
    }
  }
  return { ts, type: "log", text: capLogText(`[${tag}] ${body}`) };
}

function parseRunLogText(text) {
  if (!text) return [];
  const out = [];
  // 从后往前取：只需要最新的 MAX_LOG_ENTRIES_PER_PARSE 条就够渲染。
  // 前端有 MAX_RUN_LOGS 的硬上限，再往前的历史行解析完也会被立即 trim。
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0 && out.length < MAX_LOG_ENTRIES_PER_PARSE; i--) {
    const line = lines[i];
    if (!line) continue;
    const e = parseRunLogLine(line);
    if (e) out.push(e);
  }
  out.reverse();
  return out;
}

function shallowEqualStatusMap(a, b) {
  if (a === b) return true;
  if (!a || !b) return false;
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    const va = a[k];
    const vb = b[k];
    if (!vb) return false;
    if (va === vb) continue;
    if (va.status !== vb.status) return false;
    if ((va.elapsed ?? null) !== (vb.elapsed ?? null)) return false;
  }
  return true;
}

function setsEqual(a, b) {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
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
}) {
  const { t } = useTranslation();
  const isRunMode = !onNodesChange;
  const panOnDrag = isRunMode ? true : (canvasTool === "pan" ? true : [1, 2]);
  const selectionOnDrag = isRunMode ? false : (canvasTool === "select");
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
      onConnect={isRunMode ? undefined : onConnect}
      onConnectStart={isRunMode ? undefined : onConnectStart}
      onConnectEnd={isRunMode ? undefined : onConnectEnd}
      isValidConnection={isRunMode ? undefined : isValidConnection}
      onNodesDelete={isRunMode ? undefined : onNodesDelete}
      onNodeClick={onNodeClick}
      onNodeDoubleClick={isRunMode ? undefined : onNodeDoubleClick}
      onEdgeClick={isRunMode ? undefined : onEdgeClick}
      onInit={onFlowInit}
      onDrop={isRunMode ? undefined : onDrop}
      onDragOver={isRunMode ? undefined : onDragOver}
      nodeTypes={nodeTypes}
      selectionOnDrag={selectionOnDrag}
      panOnDrag={panOnDrag}
      nodesDraggable={!isRunMode}
      nodesConnectable={!isRunMode}
      elementsSelectable={!isRunMode}
      edgesFocusable={!isRunMode}
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

function replaceFlowUrl(flow) {
  if (!window.location.pathname.startsWith("/flow")) return;
  if (!flow) {
    window.history.replaceState({}, "", "/flow");
    return;
  }
  const current = new URLSearchParams(window.location.search);
  const q = new URLSearchParams({
    flowId: flow.id,
    flowSource: flow.source ?? "user",
  });
  if (flow.archived) q.set("flowArchived", "1");
  if (current.get("panel") === "settings") q.set("panel", "settings");
  window.history.replaceState({}, "", "/flow?" + q.toString());
}

/** 保存 flow.yaml 的 API flowSource：内置来源写入工作区副本 */
function flowSourceForWrite(source) {
  return source === "builtin" || source === "admin" ? "workspace" : source ?? "user";
}

function isReadonlyBuiltinFlowSource(source) {
  return source === "builtin" || source === "admin";
}

function flowSourceLabelZh(source, t) {
  if (source === "builtin" || source === "admin") return t("flow:settings.builtin");
  if (source === "workspace") return t("flow:palette.workspace");
  return t("flow:palette.userDir");
}

function persistedFlowNodeSize(node) {
  const width = Number(node?.data?.displaySize?.width || node?.width || 0);
  const height = Number(node?.data?.displaySize?.height || node?.height || 0);
  if (width > 0 && height > 0) return { width: Math.round(width), height: Math.round(height) };
  return null;
}

const RUN_CONSOLE_HEIGHT_STORAGE_KEY = "af:run-console-height";
/** 约 14rem + 顶部分隔条高度，与原先仅 head+body 时的可视区域接近 */
const RUN_CONSOLE_HEIGHT_DEFAULT_PX = 230;
const DEFAULT_SCHEDULE = {
  enabled: false,
  cron: "",
  timezone: "Asia/Shanghai",
  preset: "",
  overlapPolicy: "skip",
  misfirePolicy: "skip",
  nextRunAt: null,
};
const DEFAULT_SCHEDULE_STATE = {};

function clampRunConsoleHeightPx(h) {
  if (!Number.isFinite(h)) return RUN_CONSOLE_HEIGHT_DEFAULT_PX;
  const max = Math.max(240, Math.floor(window.innerHeight * 0.88));
  return Math.min(Math.max(Math.round(h), 96), max);
}

function readRunConsoleHeightPx() {
  try {
    const raw = localStorage.getItem(RUN_CONSOLE_HEIGHT_STORAGE_KEY);
    if (raw == null) return RUN_CONSOLE_HEIGHT_DEFAULT_PX;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return RUN_CONSOLE_HEIGHT_DEFAULT_PX;
    return clampRunConsoleHeightPx(n);
  } catch {
    return RUN_CONSOLE_HEIGHT_DEFAULT_PX;
  }
}

export default function FlowEditorPage() {
  const { t, i18n } = useTranslation();
  const { navigate, path } = useRoute();
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
  const [moveFlowError, setMoveFlowError] = useState("");
  const [moveFlowBusy, setMoveFlowBusy] = useState(false);
  const [renameFlowId, setRenameFlowId] = useState("");
  const [renameFlowBusy, setRenameFlowBusy] = useState(false);
  const [renameFlowError, setRenameFlowError] = useState("");
  const [pathCopied, setPathCopied] = useState(false);
  const [archiveModalOpen, setArchiveModalOpen] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [fileEditModal, setFileEditModal] = useState(
    /** @type {null | { filePath: string, fileName: string }} */ (null),
  );
  /** 槽位校验横幅：关闭后隐藏，直至刷新、切换流水线或警告集合变化 */
  const [slotWarningsBannerDismissed, setSlotWarningsBannerDismissed] = useState(false);
  const [slotWarningsRefreshing, setSlotWarningsRefreshing] = useState(false);
  const slotWarningsRefreshBusyRef = useRef(false);
  const [palette, setPalette] = useState([]);
  const [paletteSearch, setPaletteSearch] = useState("");
  const [paletteMode, setPaletteMode] = useState("nodes");
  const paletteSearchInputRef = useRef(null);
  const [flowSnippets, setFlowSnippets] = useState([]);
  const [flowSnippetsLoading, setFlowSnippetsLoading] = useState(false);
  const [flowSnippetsError, setFlowSnippetsError] = useState("");
  const [publishSnippetOpen, setPublishSnippetOpen] = useState(false);
  const [publishSnippetDraft, setPublishSnippetDraft] = useState({ name: "", id: "", description: "" });
  const [publishSnippetBusy, setPublishSnippetBusy] = useState(false);
  const [publishSnippetError, setPublishSnippetError] = useState("");
  const [flowSnippetToast, setFlowSnippetToast] = useState("");
  const flowSnippetToastTimerRef = useRef(null);
  const [marketplaceCatalogNodes, setMarketplaceCatalogNodes] = useState([]);
  const [marketplaceCatalogLoading, setMarketplaceCatalogLoading] = useState(false);
  const [marketplaceCatalogError, setMarketplaceCatalogError] = useState("");
  const [marketplaceInstallBusy, setMarketplaceInstallBusy] = useState("");
  const [marketplacePreviewNode, setMarketplacePreviewNode] = useState(null);
  const [rightPanel, setRightPanel] = useState(/** @type {null | "settings" | "history" | "node" | "composer"} */ (null));
  const [recentRuns, setRecentRuns] = useState(
    /** @type {Array<{ flowId: string, runId?: string, at: number, durationMs?: number, status?: string }>} */ ([]),
  );
  const [recentRunsError, setRecentRunsError] = useState("");
  const [recentRunsLoading, setRecentRunsLoading] = useState(false);

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
    const refresh = () => updateNodeInternalsRef.current?.(id);
    window.requestAnimationFrame(refresh);
    window.setTimeout(refresh, 80);
  }, []);

  useEffect(() => () => {
    if (flowSnippetToastTimerRef.current) {
      window.clearTimeout(flowSnippetToastTimerRef.current);
    }
  }, []);

  // 工作区展开状态
  const [workspaceExpanded, setWorkspaceExpanded] = useState(false);
  // 当前 pipeline 目录下的文件列表
  const [pipelineFiles, setPipelineFiles] = useState(
    /** @type {{ files: Array<{name: string, type: 'file'|'directory', icon: string, path: string, size?: number, children?: Array}>, path?: string, error?: string }} */ ({
      files: [],
    }),
  );
  const [pipelineFilesLoading, setPipelineFilesLoading] = useState(false);

  // ── Engine online detection ──
  const [engineOnline, setEngineOnline] = useState(true);
  useEffect(() => {
    let cancelled = false;
    const check = () => {
      fetch("/api/flows", { method: "HEAD" })
        .then((r) => { if (!cancelled) setEngineOnline(r.ok); })
        .catch(() => { if (!cancelled) setEngineOnline(false); });
    };
    check();
    const id = window.setInterval(check, 5000);
    return () => { cancelled = true; window.clearInterval(id); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/dev-info")
      .then((r) => r.json())
      .then((data) => { if (!cancelled) setIsDevMode(Boolean(data?.isDev)); })
      .catch(() => { /* ignore */ });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!selected?.id) return;
    recordPipelineView(selected.id, selected.source ?? "user", "pipeline", Boolean(selected.archived));
  }, [selected?.id, selected?.source, selected?.archived]);

  // ── Run mode state ──
  const [runMode, setRunMode] = useState(/** @type {"edit" | "ready" | "running" | "stopped" | "done" | "error"} */ ("edit"));
  const [runLogs, setRunLogs] = useState(/** @type {Array<{ ts: string, type: string, text: string }>} */ ([]));
  const runLogBytesRef = useRef(0);
  const [executingNodes, setExecutingNodes] = useState(/** @type {Set<string>} */ (new Set()));
  const [nodeRunStatus, setNodeRunStatus] = useState(/** @type {Record<string, { status: string, elapsed?: string }>} */ ({}));
  const [runStartTime, setRunStartTime] = useState(/** @type {number | null} */ (null));
  const [runElapsedMs, setRunElapsedMs] = useState(0);
  const [runConsoleOpen, setRunConsoleOpen] = useState(false);
  const [isDevMode, setIsDevMode] = useState(false);
  const [logViewerOpen, setLogViewerOpen] = useState(false);
  const [runConsoleHeightPx, setRunConsoleHeightPx] = useState(readRunConsoleHeightPx);
  const runConsoleResizeDragRef = useRef(
    /** @type {{ active: boolean, pointerId: number, startY: number, startH: number }} */ ({
      active: false,
      pointerId: -1,
      startY: 0,
      startH: RUN_CONSOLE_HEIGHT_DEFAULT_PX,
    }),
  );
  /** 当前一次 apply 的 run 目录 uuid（来自 apply-start），用于侧栏拉取 intermediate/output */
  const [currentRunUuid, setCurrentRunUuid] = useState(/** @type {string | null} */ (null));
  const [runContextNodeId, setRunContextNodeId] = useState(/** @type {string | null} */ (null));
  const [cliInputs, setCliInputs] = useState(/** @type {Record<string, { type: "str" | "file", value?: string, path?: string }>} */ ({}));
  // handleRun 的 useCallback deps 只有 [selected]，闭包里的 cliInputs 会过期；
  // ready 模式下用户在 RunConfigPanel 编辑参数后点"开始执行"，需要读最新值 → 走 ref
  const cliInputsRef = useRef(cliInputs);
  useEffect(() => { cliInputsRef.current = cliInputs; }, [cliInputs]);
  const [runDropdownOpen, setRunDropdownOpen] = useState(false);
  const [runWithParamsOpen, setRunWithParamsOpen] = useState(false);
  const [runParamsDraft, setRunParamsDraft] = useState(/** @type {Record<string, string>} */ ({}));
  const [runPresets, setRunPresets] = useState(/** @type {Record<string, Record<string, string>>} */ ({}));
  const [activePresetName, setActivePresetName] = useState(/** @type {string | null} */ (null));
  const [scheduleDraft, setScheduleDraft] = useState(DEFAULT_SCHEDULE);
  const [scheduleLoading, setScheduleLoading] = useState(false);
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [scheduleError, setScheduleError] = useState("");
  const [scheduleStatus, setScheduleStatus] = useState("");
  const [scheduleState, setScheduleState] = useState(DEFAULT_SCHEDULE_STATE);
  const [scheduleRuntimeStatus, setScheduleRuntimeStatus] = useState(null);
  const scheduleEditSeqRef = useRef(0);
  const runAbortRef = useRef(/** @type {AbortController | null} */ (null));
  const runLogEndRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  // 终端式粘底：用户在底部时自动跟随；用户手动上滑后暂停；重新回到底部自动恢复。
  const runLogStickRef = useRef(true);
  // 忽略 scrollIntoView 自身触发的 scroll 事件，避免把粘底误判成「用户上滑」。
  const runLogProgrammaticScrollRef = useRef(false);
  const [userCheckContent, setUserCheckContent] = useState(
    /** @type {null | { instanceId: string, execId: number, inputPath: string, outputPath: string, content: string }} */ (null),
  );
  const [userCheckEditedContent, setUserCheckEditedContent] = useState(/** @type {string | null} */ (null));
  const [userCheckEditing, setUserCheckEditing] = useState(false);
  const [userCheckAiPrompt, setUserCheckAiPrompt] = useState("");
  const [userCheckAiRunning, setUserCheckAiRunning] = useState(false);
  const userCheckEditRef = useRef(/** @type {HTMLTextAreaElement | null} */ (null));

  const [userAskPrompt, setUserAskPrompt] = useState(
    /** @type {null | { instanceId: string, execId: number, question: string, options: Array<{ index: number, name: string, label: string }> }} */ (null),
  );
  const [userAskSubmitting, setUserAskSubmitting] = useState(false);

  const [toolPrintContent, setToolPrintContent] = useState(
    /** @type {null | { instanceId: string, execId: number, content: string, createdAt: number }} */ (null),
  );
  const [toolPrintExpanded, setToolPrintExpanded] = useState(false);

  const [provideEditContent, setProvideEditContent] = useState(
    /** @type {null | { instanceId: string, label: string, definitionId: string, content: string }} */ (null),
  );
  const provideEditRef = useRef(/** @type {HTMLTextAreaElement | null} */ (null));

  const [composerText, setComposerText] = useState("");
  const [composerCursor, setComposerCursor] = useState(0);
  const [mentionHighlight, setMentionHighlight] = useState(0);
  const [canvasTool, setCanvasTool] = useState(/** @type {"select" | "pan"} */ ("pan"));
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [jumpPaletteOpen, setJumpPaletteOpen] = useState(false);
  const composerInputRef = useRef(/** @type {HTMLTextAreaElement | null} */ (null));
  const nodePanelSuppressedRef = useRef(/** @type {string | null} */ (null));
  const soleSelectedNodeRef = useRef(/** @type {import("@xyflow/react").Node | null} */ (null));

  const [nodePropsFlowEpoch, setNodePropsFlowEpoch] = useState(0);
  const [nodePropDraft, setNodePropDraft] = useState(
    /** @type {null | { id: string, newId: string, label: string, role: string, model: string, body: string, script?: string, inputs: IoDraftSlot[], outputs: IoDraftSlot[] }} */ (null),
  );
  const [nodePropsError, setNodePropsError] = useState("");
  const [modelLists, setModelLists] = useState(/** @type {{ cursor: string[], opencode: string[], claudeCode: string[] }} */ ({ cursor: [], opencode: [], claudeCode: [] }));
  const [composerModel, setComposerModel] = useState("");
  const [composerPhaseRole, setComposerPhaseRole] = useState("");
  const [composerSkills, setComposerSkills] = useState(/** @type {Array<{ key: string, name: string, description?: string, sourceLabel?: string }>} */ ([]));
  const [composerSelectedSkills, setComposerSelectedSkills] = useState(/** @type {string[]} */ ([]));
  const [composerSkillsLoaded, setComposerSkillsLoaded] = useState(false);
  const [composerSkillCollections, setComposerSkillCollections] = useState([]);
  const [composerSkillCollectionsLoaded, setComposerSkillCollectionsLoaded] = useState(false);
  const [composerCollapsedSkillCollections, setComposerCollapsedSkillCollections] = useState(() => new Set());
  const [composerSkillsOpen, setComposerSkillsOpen] = useState(false);
  const composerSkillsButtonRef = useRef(/** @type {HTMLButtonElement | null} */ (null));
  const composerSkillsMenuRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  const [composerSkillsMenuStyle, setComposerSkillsMenuStyle] = useState(/** @type {React.CSSProperties} */ ({}));

  // 多 Session 支持
  /** @typedef {{ id: string, label: string, thread: Array, segments: Array, running: boolean, statusLine: string, steps: Array, outputDismissed: boolean, createdAt: number, phaseContext: null | { phases: Array, currentPhase: number, isLastPhase: boolean, userPromptOriginal: string, nextPhase: object | null } }} ComposerSession */

  const getComposerStorageKey = useCallback((flow) => {
    if (!flow) return null;
    const flowId = flow.id;
    const flowSource = flow.source ?? "user";
    const flowArchived = flow.archived ? "archived" : "";
    return {
      sessionsKey: `af:composer-sessions:${flowId}:${flowSource}${flowArchived ? ":" + flowArchived : ""}`,
      activeKey: `af:composer-active-session:${flowId}:${flowSource}${flowArchived ? ":" + flowArchived : ""}`,
    };
  }, []);

  const getComposerSkillsStorageKey = useCallback((flow) => {
    if (!flow) return "";
    const flowId = flow.id;
    const flowSource = flow.source ?? "user";
    const flowArchived = flow.archived ? "archived" : "";
    return `af:composer-skills:pipeline:${flowId}:${flowSource}${flowArchived ? ":" + flowArchived : ""}`;
  }, []);

  const loadComposerSessionsForFlow = useCallback((flow) => {
    const keys = getComposerStorageKey(flow);
    if (!keys) return { sessions: [], activeSessionId: null };

    try {
      const raw = localStorage.getItem(keys.sessionsKey);
      if (!raw) return { sessions: [], activeSessionId: null };
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return { sessions: [], activeSessionId: null };
      const sessions = parsed.filter(s => s && typeof s.id === "string").map(s => ({
        ...s,
        running: false,
        statusLine: s.running ? t("flow:composer.pageRefreshReset") : s.statusLine,
        steps: [],
      }));
      let activeSessionId = null;
      try {
        activeSessionId = localStorage.getItem(keys.activeKey);
        if (activeSessionId && !sessions.some(s => s.id === activeSessionId)) {
          activeSessionId = null;
        }
      } catch {
        activeSessionId = null;
      }
      return { sessions, activeSessionId };
    } catch {
      return { sessions: [], activeSessionId: null };
    }
  }, [getComposerStorageKey]);

  const saveComposerSessionsForFlow = useCallback((flow, sessions, activeSessionId) => {
    const keys = getComposerStorageKey(flow);
    if (!keys) return;
    try {
      localStorage.setItem(keys.sessionsKey, JSON.stringify(sessions));
      if (activeSessionId) {
        localStorage.setItem(keys.activeKey, activeSessionId);
      } else {
        localStorage.removeItem(keys.activeKey);
      }
    } catch {
      // 忽略写入错误
    }
  }, [getComposerStorageKey]);

  const composerSessionIdRef = useRef(0);
  const composerSessionsForFlowRef = useRef(/** @type {{ sessions: ComposerSession[], activeSessionId: string | null, flowKey: string | null }} */ ({
    sessions: [],
    activeSessionId: null,
    flowKey: null,
  }));

  const [composerSessions, setComposerSessions] = useState(/** @type {ComposerSession[]} */ ([]));
  const [activeSessionId, setActiveSessionId] = useState(/** @type {string | null} */ (null));
  const composerSkillsStorageKey = useMemo(() => getComposerSkillsStorageKey(selected), [getComposerSkillsStorageKey, selected]);
  const [composerSkillsStorageReadyKey, setComposerSkillsStorageReadyKey] = useState("");

  const flowKeyForComposer = useMemo(() => {
    if (!selected) return null;
    const flowId = selected.id;
    const flowSource = selected.source ?? "user";
    const flowArchived = selected.archived ? "archived" : "";
    return `${flowId}:${flowSource}${flowArchived ? ":" + flowArchived : ""}`;
  }, [selected]);

  const initialDataLoadedRef = useRef(false);

  useEffect(() => {
    if (!flowKeyForComposer) {
      setComposerSessions([]);
      setActiveSessionId(null);
      composerSessionsForFlowRef.current = { sessions: [], activeSessionId: null, flowKey: null };
      return;
    }

    const ref = composerSessionsForFlowRef.current;
    if (ref.flowKey === flowKeyForComposer) {
      return;
    }

    ref.flowKey = flowKeyForComposer;

    if (initialDataLoadedRef.current && ref.sessions.length > 0) {
      saveComposerSessionsForFlow(selected, ref.sessions, ref.activeSessionId);
    }

    const { sessions, activeSessionId } = loadComposerSessionsForFlow(selected);

    if (sessions.length === 0) {
      const id = `session-1-${Date.now()}`;
      const newSession = {
        id,
        label: t("flow:composer.conversationLabel", { n: 1 }),
        thread: [],
        segments: [],
        running: false,
        statusLine: "",
        steps: [],
        outputDismissed: false,
        createdAt: Date.now(),
        phaseContext: null,
      };
      ref.sessions = [newSession];
      ref.activeSessionId = id;
      setComposerSessions([newSession]);
      setActiveSessionId(id);
    } else {
      // 复用已有的空对话 tab，避免每次进入流水线都创建新空 tab
      const lastSession = sessions[sessions.length - 1];
      const lastIsEmpty = lastSession && (!lastSession.thread || lastSession.thread.length === 0);

      if (lastIsEmpty) {
        composerSessionIdRef.current = maxDialogueNumFromSessionLabels(sessions);
        ref.sessions = sessions;
        ref.activeSessionId = lastSession.id;
        setComposerSessions(sessions);
        setActiveSessionId(lastSession.id);
      } else {
        const nextNum = maxDialogueNumFromSessionLabels(sessions) + 1;
        composerSessionIdRef.current = nextNum;
        const newId = `session-${nextNum}-${Date.now()}`;
        const newSession = {
          id: newId,
          label: t("flow:composer.conversationLabel", { n: nextNum }),
          thread: [],
          segments: [],
          running: false,
          statusLine: "",
          steps: [],
          outputDismissed: false,
          createdAt: Date.now(),
          phaseContext: null,
        };
        const allSessions = [...sessions, newSession];
        ref.sessions = allSessions;
        ref.activeSessionId = newId;
        setComposerSessions(allSessions);
        setActiveSessionId(newId);
      }
    }

    initialDataLoadedRef.current = true;
  }, [flowKeyForComposer, selected, loadComposerSessionsForFlow, saveComposerSessionsForFlow]);

  // 当前激活的 session 状态（派生）
  const activeSession = useMemo(() => {
    return composerSessions.find((s) => s.id === activeSessionId) || null;
  }, [composerSessions, activeSessionId]);

  // 兼容旧代码的快捷访问
  const composerRunning = activeSession?.running ?? false;
  const composerStatusLine = activeSession?.statusLine ?? "";
  const composerNaturalSegments = activeSession?.segments ?? [];
  const composerThread = activeSession?.thread ?? [];
  const composerSteps = activeSession?.steps ?? [];
  const composerOutputDismissed = activeSession?.outputDismissed ?? false;
  const composerPhaseContext = activeSession?.phaseContext ?? null;

  const composerNaturalSegmentsRef = useRef(/** @type {Array<{ kind: string, text: string }>} */ ([]));
  const [composerExpanded, setComposerExpanded] = useState(false);
  const composerAbortRef = useRef(/** @type {AbortController | null} */ (null));
  const composerSidebarThreadRef = useRef(/** @type {HTMLDivElement | null} */ (null));
  useEffect(() => {
    const el = composerSidebarThreadRef.current;
    if (!el) return;
    requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
  }, [composerThread, composerNaturalSegments]);
  /** 当前流式请求所属的 session（用于关闭 tab 时中止、与 active 解耦） */
  const composerStreamingSessionIdRef = useRef(/** @type {string | null} */ (null));
  const composerSubmittingRef = useRef(false);
  /** 供分阶段自动续跑时调用最新 submitComposer，避免闭包陈旧 */
  const submitComposerRef = useRef(/** @type {null | ((a?: string, o?: object) => Promise<void>)} */ (null));

  // 创建新 session - 使用 ref 保证稳定引用
  const createComposerSession = useCallback((label) => {
    const currentCount = ++composerSessionIdRef.current;
    const id = `session-${currentCount}-${Date.now()}`;
    const newSession = {
      id,
      label: label || t("flow:composer.conversationLabel", { n: currentCount }),
      thread: [],
      segments: [],
      running: false,
      statusLine: "",
      steps: [],
      outputDismissed: false,
      createdAt: Date.now(),
      phaseContext: null,
    };
    setComposerSessions((prev) => [...prev, newSession]);
    setActiveSessionId(id);
    return id;
  }, []);

  // 持久化 sessions 到 localStorage
  useEffect(() => {
    if (!selected || !initialDataLoadedRef.current) return;
    composerSessionsForFlowRef.current.sessions = composerSessions;
    composerSessionsForFlowRef.current.activeSessionId = activeSessionId;
    saveComposerSessionsForFlow(selected, composerSessions, activeSessionId);
  }, [composerSessions, activeSessionId, selected, saveComposerSessionsForFlow]);

  useEffect(() => {
    composerSessionIdRef.current = Math.max(
      composerSessionIdRef.current,
      maxDialogueNumFromSessionLabels(composerSessions),
    );
  }, [composerSessions]);

  // 关闭 session - 使用函数式更新避免依赖 stale state
  const closeComposerSession = useCallback((sessionId) => {
    if (composerStreamingSessionIdRef.current === sessionId) {
      composerAbortRef.current?.abort();
    }
    setComposerSessions((prev) => {
      const filtered = prev.filter((s) => s.id !== sessionId);
      // 检查是否关闭的是当前激活的 session
      const isClosingActive = prev.some((s, idx) => s.id === sessionId && prev.findIndex(ss => ss.id === activeSessionId) === idx);
      if (isClosingActive || activeSessionId === sessionId) {
        const remaining = filtered;
        if (remaining.length > 0) {
          // 切换到列表中最后一个 session
          setActiveSessionId(remaining[remaining.length - 1].id);
        } else {
          setTimeout(() => {
            composerSessionIdRef.current = 0;
            const n = ++composerSessionIdRef.current;
            const newId = `session-${n}-${Date.now()}`;
            const newSession = {
              id: newId,
              label: t("flow:composer.conversationLabel", { n }),
              thread: [],
              segments: [],
              running: false,
              statusLine: "",
              steps: [],
              outputDismissed: false,
              createdAt: Date.now(),
              phaseContext: null,
            };
            setComposerSessions((p) => [...p, newSession]);
            setActiveSessionId(newId);
          }, 0);
        }
      }
      return filtered;
    });
  }, [activeSessionId]);

  // 更新当前 session 的工具函数
  const updateActiveSession = useCallback((updater) => {
    setComposerSessions((prev) => {
      const idx = prev.findIndex((s) => s.id === activeSessionId);
      if (idx < 0) return prev;
      const updated = { ...prev[idx] };
      updater(updated);
      const next = [...prev];
      next[idx] = updated;
      return next;
    });
  }, [activeSessionId]);

  // 兼容旧代码的 setter（操作当前 session）
  const setComposerRunning = useCallback((running) => {
    updateActiveSession((s) => { s.running = running; });
  }, [updateActiveSession]);
  const setComposerStatusLine = useCallback((line) => {
    updateActiveSession((s) => { s.statusLine = line; });
  }, [updateActiveSession]);
  const setComposerNaturalSegments = useCallback((segmentsOrUpdater) => {
    updateActiveSession((s) => {
      if (typeof segmentsOrUpdater === "function") {
        s.segments = segmentsOrUpdater(s.segments);
      } else {
        s.segments = segmentsOrUpdater;
      }
    });
  }, [updateActiveSession]);
  const setComposerThread = useCallback((threadOrUpdater) => {
    updateActiveSession((s) => {
      if (typeof threadOrUpdater === "function") {
        s.thread = threadOrUpdater(s.thread);
      } else {
        s.thread = threadOrUpdater;
      }
    });
  }, [updateActiveSession]);
  const setComposerSteps = useCallback((stepsOrUpdater) => {
    updateActiveSession((s) => {
      if (typeof stepsOrUpdater === "function") {
        s.steps = stepsOrUpdater(s.steps);
      } else {
        s.steps = stepsOrUpdater;
      }
    });
  }, [updateActiveSession]);
  const setComposerOutputDismissed = useCallback((dismissed) => {
    updateActiveSession((s) => { s.outputDismissed = dismissed; });
  }, [updateActiveSession]);
  const setComposerPhaseContext = useCallback((ctx) => {
    updateActiveSession((s) => { s.phaseContext = typeof ctx === "function" ? ctx(s.phaseContext) : ctx; });
  }, [updateActiveSession]);

  /** 切换对话 tab 时恢复该会话的输出面板（点 X 收起后再次点 tab 可重新打开） */
  const activateComposerSession = useCallback((sessionId) => {
    setActiveSessionId(sessionId);
    setComposerSessions((prev) => {
      const idx = prev.findIndex((s) => s.id === sessionId);
      if (idx < 0) return prev;
      if (!prev[idx].outputDismissed) return prev;
      const next = [...prev];
      next[idx] = { ...prev[idx], outputDismissed: false };
      return next;
    });
  }, []);

  useEffect(() => {
    composerNaturalSegmentsRef.current = composerNaturalSegments;
  }, [composerNaturalSegments]);

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
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);
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

  // run 模式下的 nodes/edges 派生视图：用 useMemo 避免每次父组件重渲（如计时器 setState）都重建整份数组。
  const runFocusIds = useMemo(() => {
    if (runMode === "edit" || executingNodes.size === 0) return null;
    const s = new Set(executingNodes);
    for (const e of edges) {
      if (executingNodes.has(e.source)) s.add(e.target);
      if (executingNodes.has(e.target)) s.add(e.source);
    }
    return s;
  }, [runMode, executingNodes, edges]);

  const runNodes = useMemo(() => {
    if (runMode === "edit") return nodes;
    return nodes.map((n) => ({
      ...n,
      draggable: false,
      connectable: false,
      data: {
        ...n.data,
        isRunMode: true,
        isExecuting: executingNodes.has(n.id),
        nodeStatus: nodeRunStatus[n.id]?.status ?? null,
        nodeElapsed: nodeRunStatus[n.id]?.elapsed ?? null,
        isDim: runFocusIds ? !runFocusIds.has(n.id) : false,
      },
    }));
  }, [runMode, nodes, executingNodes, nodeRunStatus, runFocusIds]);

  const runEdges = useMemo(() => {
    if (!runFocusIds) return edges;
    return edges.map((e) => {
      const touchesExec = executingNodes.has(e.source) || executingNodes.has(e.target);
      const base = e.className ? e.className.replace(/\s?af-flow-edge--(dim|focus)\b/g, "") : "";
      const cls = touchesExec ? "af-flow-edge--focus" : "af-flow-edge--dim";
      return { ...e, className: (base ? base + " " : "") + cls };
    });
  }, [edges, executingNodes, runFocusIds]);

  useEffect(() => {
    if (!selected) {
      setRunPresets({});
      setActivePresetName(null);
      setScheduleDraft(DEFAULT_SCHEDULE);
      setScheduleState(DEFAULT_SCHEDULE_STATE);
      setScheduleRuntimeStatus(null);
      setScheduleError("");
      setScheduleStatus("");
      return;
    }
    const params = new URLSearchParams({
      flowId: selected.id,
      flowSource: selected.source || "user",
    });
    if (selected.archived) params.set("archived", "1");
    fetch(`/api/flow/run-config?${params.toString()}`)
      .then((r) => r.json())
      .then((data) => {
        setRunPresets(data.presets || {});
        setActivePresetName(data.activePreset || null);
      })
      .catch(() => {
        setRunPresets({});
        setActivePresetName(null);
      });
  }, [selected?.id, selected?.source, selected?.archived]);

  const updateScheduleDraft = useCallback((updater) => {
    scheduleEditSeqRef.current += 1;
    setScheduleDraft(updater);
  }, []);

  const loadSchedule = useCallback(async (flow, opts = {}) => {
    if (!flow) return;
    const quiet = Boolean(opts.quiet);
    const force = Boolean(opts.force);
    const editSeqAtStart = scheduleEditSeqRef.current;
    if (!quiet) {
      setScheduleLoading(true);
      setScheduleError("");
      setScheduleStatus("");
    }
    const params = new URLSearchParams({
      flowId: flow.id,
      flowSource: flow.source || "user",
    });
    if (flow.archived) params.set("archived", "1");
    try {
      const r = await fetch(`/api/flow/schedule?${params.toString()}`);
      const data = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
      if (!force && scheduleEditSeqRef.current !== editSeqAtStart) return;
      setScheduleDraft({ ...DEFAULT_SCHEDULE, ...(data.schedule || {}) });
      setScheduleState(data.state && typeof data.state === "object" ? data.state : DEFAULT_SCHEDULE_STATE);
      setScheduleRuntimeStatus(data.status || null);
    } catch (e) {
      if (!force && scheduleEditSeqRef.current !== editSeqAtStart) return;
      setScheduleDraft(DEFAULT_SCHEDULE);
      setScheduleState(DEFAULT_SCHEDULE_STATE);
      setScheduleRuntimeStatus(null);
      setScheduleError(String(e.message || e));
    } finally {
      setScheduleLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    const run = async () => {
      await loadSchedule(selected);
      if (cancelled) return;
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [selected?.id, selected?.source, selected?.archived, loadSchedule]);

  // 将活跃预设值同步到 cliInputs，确保主 RUN 按钮使用正确的预设
  useEffect(() => {
    if (!activePresetName || !runPresets[activePresetName]) return;
    if (provideNodes.length === 0) return;
    const presetValues = runPresets[activePresetName];
    const newCliInputs = {};
    for (const node of provideNodes) {
      const slotName = cliInputSlotNames[node.id];
      if (!slotName) continue;
      const definitionId = node.data?.definitionId || "";
      const value = presetValues[node.id] ?? node.data?.outputs?.[0]?.default ?? "";
      if (definitionId.startsWith("provide_file")) {
        newCliInputs[slotName] = { type: "file", path: value };
      } else {
        newCliInputs[slotName] = { type: "str", value };
      }
    }
    if (Object.keys(newCliInputs).length > 0) {
      setCliInputs(newCliInputs);
    }
  }, [activePresetName, runPresets, provideNodes, cliInputSlotNames]);

  const handleProvideEditSave = useCallback(() => {
    if (!provideEditContent || !provideEditRef.current) return;
    const newContent = provideEditRef.current.value;
    setNodes((nds) =>
      nds.map((n) => {
        if (n.id !== provideEditContent.instanceId) return n;
        return {
          ...n,
          data: {
            ...n.data,
            outputs: n.data?.outputs?.map((o, i) =>
              i === 0 ? { ...o, default: newContent } : o
            ) || [{ type: "text", name: "value", default: newContent }],
          },
        };
      })
    );
    setProvideEditContent(null);
  }, [provideEditContent, setNodes]);

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

  const paletteDefForSoleNode = useMemo(() => {
    if (!soleSelectedNode) return null;
    const did = soleSelectedNode.data?.definitionId;
    return palette.find((p) => p.id === did) ?? null;
  }, [soleSelectedNode, palette]);

  const groupedPalette = useMemo(() => {
    const g = { CONTROL: [], TOOL: [], PROVIDE: [], AGENT: [] };
    for (const n of palette) {
      const cat = paletteCategory(n);
      g[cat].push(n);
    }
    for (const k of PALETTE_ORDER) {
      g[k].sort((a, b) => a.id.localeCompare(b.id));
    }
    return g;
  }, [palette]);

  const filteredGroupedPalette = useMemo(() => {
    const q = paletteSearch.trim().toLowerCase();
    if (!q) return groupedPalette;
    const g = { CONTROL: [], TOOL: [], PROVIDE: [], AGENT: [] };
    for (const k of PALETTE_ORDER) {
      g[k] = groupedPalette[k].filter((n) => paletteNodeMatchesQuery(n, q));
    }
    return g;
  }, [groupedPalette, paletteSearch]);

  const filteredPaletteCount = useMemo(
    () => PALETTE_ORDER.reduce((n, cat) => n + filteredGroupedPalette[cat].length, 0),
    [filteredGroupedPalette],
  );

  const marketplaceNodes = useMemo(
    () =>
      palette.filter((n) => {
        const id = String(n.id ?? "");
        const source = String(n.source ?? "");
        return id.startsWith("marketplace:") || source === "marketplace" || source === "collection";
      }),
    [palette],
  );

  const installedMarketplaceKeys = useMemo(() => {
    const keys = new Set();
    for (const n of marketplaceNodes) {
      const id = String(n.id ?? "");
      if (!id) continue;
      keys.add(id);
      if (id.startsWith("marketplace:")) {
        const spec = id.slice("marketplace:".length);
        const [pkgId] = spec.split("@");
        if (pkgId) keys.add(`marketplace:${pkgId}`);
      }
    }
    return keys;
  }, [marketplaceNodes]);

  const loadFlowList = useCallback(async () => {
    setListError("");
    try {
      const r = await fetch("/api/flows");
      if (!r.ok) throw new Error("HTTP " + r.status);
      setFlows(await r.json());
    } catch (e) {
      setListError(String(e.message || e));
    }
  }, []);

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
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/skills")
      .then((r) => r.json())
      .then((j) => {
        if (cancelled) return;
        const skills = Array.isArray(j.skills)
          ? j.skills
              .filter((s) => s && typeof s.key === "string" && s.key.trim())
              .map((s) => ({
                key: String(s.key),
                name: String(s.name || s.id || s.key),
                description: s.description ? String(s.description) : "",
                sourceLabel: s.sourceLabel ? String(s.sourceLabel) : "",
              }))
          : [];
        setComposerSkills(skills);
        setComposerSkillsLoaded(true);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/skill-collections")
      .then((r) => r.json())
      .then((j) => {
        if (!cancelled) {
          setComposerSkillCollections(normalizeSkillCollections(j));
          setComposerSkillCollectionsLoaded(true);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setComposerSkillsStorageReadyKey("");
    if (!composerSkillsLoaded || !composerSkillCollectionsLoaded) return;
    if (!composerSkillsStorageKey) {
      setComposerSelectedSkills([]);
      return;
    }
    setComposerSelectedSkills(readStoredOrDefaultSkillKeys(composerSkillsStorageKey, "pipeline", composerSkills, composerSkillCollections));
    setComposerSkillsStorageReadyKey(composerSkillsStorageKey);
  }, [composerSkillCollections, composerSkillCollectionsLoaded, composerSkills, composerSkillsLoaded, composerSkillsStorageKey]);

  useEffect(() => {
    if (composerSkillsStorageReadyKey !== composerSkillsStorageKey || !composerSkillsStorageKey) return;
    try {
      localStorage.setItem(composerSkillsStorageKey, JSON.stringify(composerSelectedSkills));
    } catch {
      /* ignore quota */
    }
  }, [composerSelectedSkills, composerSkillsStorageKey, composerSkillsStorageReadyKey]);

  const fetchFlowGraphData = useCallback(async (flow) => {
    const flowSource = flow.source ?? "user";
    const flowArchived = Boolean(flow.archived);
    const q = new URLSearchParams({ flowId: flow.id, flowSource });
    if (flowArchived) q.set("archived", "1");
    const nodeQ = new URLSearchParams({ flowId: flow.id, flowSource });
    if (flowArchived) nodeQ.set("archived", "1");
    nodeQ.set("lang", String(i18n.language || "zh").startsWith("zh") ? "zh" : "en");

    const [fr, nr] = await Promise.all([fetch("/api/flow?" + q.toString()), fetch("/api/nodes?" + nodeQ.toString())]);
    const flowRes = await fr.json();
    if (!fr.ok || flowRes.error) throw new Error(flowRes.error || t("flow:nodePropsError.loadFlowFailed"));
    const paletteJson = await nr.json();
    if (!nr.ok) throw new Error(t("flow:nodePropsError.loadNodesFailed"));
    const paletteList = Array.isArray(paletteJson) ? paletteJson : Array.isArray(paletteJson?.nodes) ? paletteJson.nodes : [];
    const pipelineTranslations = (!Array.isArray(paletteJson) && paletteJson?.pipelineTranslations) || {};

    const result = deserializeFromFlowYaml(flowRes.flowYaml || "");
    if (result.error) throw new Error(result.error);
    const instances = { ...(result.instances || {}) };
    const mergedNodes = result.nodes.map((n) => mergeNodeWithPalette(n, instances, paletteList, pipelineTranslations, flow.id));
    const validEdges = filterValidEdges(result.edges, mergedNodes);
    return {
      flowSource,
      paletteList,
      instances,
      flowDescriptionText: result.description ?? "",
      viewport: normalizeFlowViewport(result.viewport),
      nodes: mergedNodes,
      edges: validEdges,
    };
  }, [i18n.language, t]);

  const loadFlow = useCallback(
    /**
     * @param {{ id: string, source?: string, archived?: boolean }} flow
     * @param {{ preserveComposer?: boolean, incrementalSync?: boolean }} [opts]
     */
    async (flow, opts = {}) => {
      const preserveComposer = Boolean(opts.preserveComposer);
      const incrementalSync = preserveComposer && Boolean(opts.incrementalSync);
      // 加载入口：冻结自动保存，epoch 自增让 in-flight 定时器放弃写入
      hasLoadedRef.current = false;
      loadEpochRef.current += 1;
      setSelected(flow);
      setLoadError("");
      if (!preserveComposer) {
        setSaveStatus("");
        setPaletteSearch("");
        setRightPanel(null);
        setFlowDescription("");
        setRenameFlowId("");
        setRenameFlowError("");
        setComposerText("");
        setComposerThread([]);
        setComposerNaturalSegments([]);
        setComposerSteps([]);
        setComposerOutputDismissed(false);
        setComposerPhaseContext(null);
        setCanvasTool("pan");
      }
      if (!incrementalSync) {
        instancesRef.current = {};
        setNodes([]);
        setEdges([]);
      }
      replaceFlowUrl(flow);
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
        hasLoadedRef.current = true;
      } catch (e) {
        setLoadError(String(e.message || e));
      }
    },
    [fetchFlowGraphData, resetCanvasHistory, setNodes, setEdges],
  );

  const reloadPaletteForSelectedFlow = useCallback(async () => {
    if (!selected?.id) return;
    const flowSource = selected.source ?? "user";
    const nodeQ = new URLSearchParams({ flowId: selected.id, flowSource });
    if (selected.archived) nodeQ.set("archived", "1");
    nodeQ.set("lang", String(i18n.language || "zh").startsWith("zh") ? "zh" : "en");
    const resp = await fetch("/api/nodes?" + nodeQ.toString());
    const paletteJson = await resp.json();
    if (!resp.ok) throw new Error(paletteJson?.error || t("flow:nodePropsError.loadNodesFailed"));
    const paletteList = Array.isArray(paletteJson) ? paletteJson : Array.isArray(paletteJson?.nodes) ? paletteJson.nodes : [];
    setPalette(paletteList);
  }, [selected, t, i18n.language]);

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
    if (!selected) return;
    void loadMarketplaceCatalog();
    void loadFlowSnippets();
  }, [selected?.id, selected?.source, selected?.archived, loadMarketplaceCatalog, loadFlowSnippets]);

  const installMarketplaceNodeForFlow = useCallback(
    async (node) => {
      if (!selected || !node) return;
      const nodeSpec = node.definitionId || `marketplace:${node.id}${node.version ? `@${node.version}` : ""}`;
      if (!nodeSpec) return;
      setMarketplaceInstallBusy(nodeSpec);
      setMarketplaceCatalogError("");
      try {
        const resp = await fetch("/api/marketplace/install-node", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            flowId: selected.id,
            flowSource: selected.source || "user",
            archived: Boolean(selected.archived),
            nodeSpec,
          }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok || data?.ok === false) throw new Error(data?.error || "Failed to install marketplace node");
        await reloadPaletteForSelectedFlow();
      } catch (e) {
        setMarketplaceCatalogError(String(e.message || e));
      } finally {
        setMarketplaceInstallBusy("");
      }
    },
    [selected, reloadPaletteForSelectedFlow],
  );

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
        flowId: selected?.id,
        flowSource: selected?.source || "user",
      };
      const resp = await fetch("/api/marketplace/publish-node-from-instance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const result = await resp.json();
      if (!resp.ok || result?.ok === false) throw new Error(result?.error || "Publish failed");
      await reloadPaletteForSelectedFlow();
      return result;
    },
    [reloadPaletteForSelectedFlow, selected],
  );

  const handleSlotWarningsRefresh = useCallback(async () => {
    if (!selected || slotWarningsRefreshBusyRef.current) return;
    const flowId = selected.id;
    const flowSource = selected.source ?? "user";
    const selectedNodeIdBefore = soleSelectedNodeRef.current?.id ?? null;
    slotWarningsRefreshBusyRef.current = true;
    setSlotWarningsRefreshing(true);
    try {
      await loadFlow(
        { id: flowId, source: flowSource, archived: selected.archived },
        { preserveComposer: true, incrementalSync: true },
      );
      if (selectedNodeIdBefore) {
        setNodes((prev) =>
          prev.map((n) => ({
            ...n,
            selected: n.id === selectedNodeIdBefore,
          })),
        );
      }
    } finally {
      slotWarningsRefreshBusyRef.current = false;
      setSlotWarningsRefreshing(false);
    }
  }, [selected, selected?.archived, loadFlow, setNodes]);

  useEffect(() => {
    if (urlLoadedRef.current || flows.length === 0) return;
    const sp = new URLSearchParams(window.location.search);
    const id = sp.get("flowId");
    if (!id) return;
    const source = sp.get("flowSource") ?? "user";
    const wantArchived = sp.get("flowArchived") === "1";
    const f = flows.find(
      (x) => x.id === id && (x.source ?? "user") === source && Boolean(x.archived) === wantArchived,
    );
    if (f) {
      urlLoadedRef.current = true;
      loadFlow(f);
    }
  }, [flows, loadFlow]);

  /** 外部（Composer / curl）写入 flow.yaml 后自动刷新画布。
   *  使用短轮询（2 s）替代 SSE，避免 HTTP/1.1 连接数耗尽导致 /api/flow/run 等请求排队。 */
  const syncVersionRef = useRef(0);
  useEffect(() => {
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
            { preserveComposer: true, incrementalSync: true },
          );
          await loadSchedule(
            { id: flowId, source: flowSource, archived: flowArchived },
            { quiet: true, force: true },
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
  }, [selected?.id, selected?.source, selected?.archived, loadFlow, loadSchedule, setNodes]);

  /** 左下角 toast 语义色 */
  const paletteTipMods = useMemo(() => {
    if (!saveStatus) return "";
    if (saveStatus.startsWith(t("flow:status.saveFailed"))) return " af-palette-tip--error";
    if (saveStatus === t("flow:status.saved")) return " af-palette-tip--success";
    return " af-palette-tip--info";
  }, [saveStatus]);

  /** 成功与运行说明短暂消失，错误与「保存中」保留至下一次状态更新 */
  useEffect(() => {
    if (!saveStatus) return;
    const transient =
      saveStatus === t("flow:status.saved") || saveStatus.startsWith(t("flow:status.runInTerminal"));
    const ms = saveStatus.startsWith(t("flow:status.runInTerminal")) ? 5200 : 2800;
    const timer = window.setTimeout(() => setSaveStatus(""), ms);
    return () => clearTimeout(timer);
  }, [saveStatus, t]);

  useEffect(() => {
    setMoveFlowError("");
  }, [selected?.id, selected?.source]);

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

  const jumpToNodeById = useCallback(
    (/** @type {string} */ nodeId) => {
      setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === nodeId })));
      setEdges((es) => es.map((e) => ({ ...e, selected: false })));
      const center = () => {
        const rfi = reactFlowInstanceRef.current;
        if (!rfi?.getNode) return;
        const userNode = rfi.getNode(nodeId);
        if (!userNode) return;
        const internal = rfi.getInternalNode?.(nodeId);
        const w = internal?.measured?.width ?? internal?.width ?? userNode.width ?? 200;
        const h = internal?.measured?.height ?? internal?.height ?? userNode.height ?? 88;
        const { zoom } = rfi.getViewport();
        const targetZoom = clampFocusZoom(zoom);
        void rfi.setCenter(userNode.position.x + w / 2, userNode.position.y + h / 2, {
          zoom: targetZoom,
          duration: 260,
        });
      };
      requestAnimationFrame(() => requestAnimationFrame(center));
    },
    [setNodes, setEdges],
  );

  const createPaletteNodeAt = useCallback(
    (def, position) => {
      const id = `node-${Date.now()}`;
      return buildPaletteNode(def, id, position, instancesRef.current, palette);
    },
    [palette],
  );

  const addNodeFromPalette = useCallback(
    (def) => {
      if (!selected || !def) return;
      let position = { x: 180, y: 160 };
      const rfi = reactFlowInstanceRef.current;
      const wrap = document.querySelector(".af-pipeline-flow .react-flow");
      if (rfi && wrap) {
        const rect = wrap.getBoundingClientRect();
        position = rfi.screenToFlowPosition({
          x: rect.left + rect.width * 0.45,
          y: rect.top + rect.height * 0.38,
        });
      }
      setNodes((nds) => [...nds, createPaletteNodeAt(def, position)]);
    },
    [selected, setNodes, createPaletteNodeAt],
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
            ...(selected.archived ? { flowArchived: true } : {}),
          }),
        });
        const data = await r.json();
if (!r.ok || !data.success) throw new Error(data.error || t("flow:status.saveFailed"));
        lastPersistedYamlRef.current = yaml;
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
  }, [nodes, edges, flowDescription, runMode, selected, persistFlowToServer]);

  const handleMoveFlow = useCallback(
    async (toSource) => {
      if (!selected) return;
      if (selected.archived) return;
      const from = selected.source ?? "user";
      if (from !== "user" && from !== "workspace") return;
      if (from === toSource) return;
      setMoveFlowBusy(true);
      setMoveFlowError("");
      try {
        const r = await fetch("/api/flow/move", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ flowId: selected.id, fromSource: from, toSource }),
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : t("flow:composer.requestFailed"));
        const nextSource = j.flowSource === "workspace" || j.flowSource === "user" ? j.flowSource : toSource;
        let nextFlow = { id: selected.id, source: nextSource, archived: selected.archived };
        try {
          const rList = await fetch("/api/flows");
          if (rList.ok) {
            const list = await rList.json();
            const found = Array.isArray(list)
              ? list.find(
                  (x) =>
                    x.id === selected.id &&
                    (x.source ?? "user") === nextSource &&
                    Boolean(x.archived) === Boolean(selected.archived),
                )
              : null;
            if (found) nextFlow = found;
          }
        } catch {
          /* keep nextFlow */
        }
        await loadFlow(nextFlow, { preserveComposer: true });
        recordPipelineOpened(selected.id, nextSource);
      } catch (e) {
        setMoveFlowError(String(e.message || e));
      } finally {
        setMoveFlowBusy(false);
      }
    },
    [selected, loadFlow],
  );

  const handleSaveSchedule = useCallback(async () => {
    if (!selected) return;
    setScheduleSaving(true);
    setScheduleError("");
    setScheduleStatus("");
    try {
      const r = await fetch("/api/flow/schedule", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          flowId: selected.id,
          flowSource: selected.source || "user",
          archived: Boolean(selected.archived),
          schedule: scheduleDraft,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || !data.success) throw new Error(data.error || "Failed to save schedule");
      setScheduleDraft({ ...DEFAULT_SCHEDULE, ...(data.schedule || {}) });
      setScheduleStatus(t("flow:schedule.saved"));
      await loadSchedule(selected, { quiet: true, force: true });
    } catch (e) {
      setScheduleError(String(e.message || e));
    } finally {
      setScheduleSaving(false);
    }
  }, [selected, scheduleDraft, loadSchedule, t]);

  const handleSavePipelineSettings = useCallback(async () => {
    if (!selected) return;
    await persistFlowToServer(nodesRef.current, edgesRef.current);
    if (!selected.archived && selected.source !== "builtin") {
      await handleSaveSchedule();
    }
  }, [selected, persistFlowToServer, handleSaveSchedule]);

  const handleRenameFlow = useCallback(async () => {
    if (!selected || !renameFlowId.trim()) return;
    const newId = renameFlowId.trim();
    if (newId === selected.id) { setRenameFlowError(""); return; }
    setRenameFlowBusy(true);
    setRenameFlowError("");
    try {
      const r = await fetch("/api/flow/rename", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flowId: selected.id, flowSource: selected.source ?? "user", newFlowId: newId }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(typeof j.error === "string" ? j.error : t("flow:composer.requestFailed"));
      let nextFlow = { id: j.flowId, source: j.flowSource ?? selected.source, archived: selected.archived };
      try {
        const rList = await fetch("/api/flows");
        if (rList.ok) {
          const list = await rList.json();
          const found = Array.isArray(list) ? list.find((x) => x.id === j.flowId && (x.source ?? "user") === (j.flowSource ?? selected.source)) : null;
          if (found) nextFlow = found;
        }
      } catch { /* keep nextFlow */ }
      await loadFlow(nextFlow, { preserveComposer: true });
      recordPipelineOpened(j.flowId, j.flowSource ?? selected.source);
    } catch (e) {
      setRenameFlowError(String(e.message || e));
    } finally {
      setRenameFlowBusy(false);
    }
  }, [selected, renameFlowId, loadFlow]);

  const handleCopyPath = useCallback((pathStr) => {
    navigator.clipboard.writeText(pathStr).then(() => {
      setPathCopied(true);
      setTimeout(() => setPathCopied(false), 2000);
    }).catch(() => {});
  }, []);

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
    if (!nodePropDraft) return;
    if (!selected || !hasLoadedRef.current) return;
    if (runMode !== "edit") return;
    const timer = setTimeout(() => {
      applyNodePropertiesNoRenameRef.current();
    }, 400);
    return () => clearTimeout(timer);
  }, [nodePropDraft, selected, runMode]);

  // newId 输入框 blur 时提交重命名：复用 applyNodeProperties 的完整校验路径。
  // 校验失败会在 nodePropsError banner 显示，draft 保留用户输入。
  const commitIdRename = useCallback(() => {
    if (!nodePropDraft || !soleSelectedNode) return;
    if (nodePropDraft.newId.trim() === soleSelectedNode.id) {
      setNodePropsError("");
      return;
    }
    applyNodeProperties();
  }, [nodePropDraft, soleSelectedNode, applyNodeProperties]);

  useEffect(() => {
    const onKeyDown = (/** @type {KeyboardEvent} */ e) => {
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
          setSaveStatus(`Copied ${clip.nodes.length} node${clip.nodes.length > 1 ? "s" : ""}`);
        }
        return;
      }

      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "v") {
        const pasted = pasteCanvasClipboard(canvasClipboardRef.current, nodesRef.current, edgesRef.current, instancesRef.current);
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
    runMode,
    undoCanvas,
    redoCanvas,
  ]);

  // ── Run timer tick ──
  // 顶栏只显示秒，5Hz 更新毫无意义却让整个 FlowEditorPage 重渲。500ms 间隔 + 仅当整秒变化时才 setState。
  useEffect(() => {
    if (runMode !== "running" || runStartTime == null) return;
    let lastSec = Math.floor((Date.now() - runStartTime) / 1000);
    const id = setInterval(() => {
      const ms = Date.now() - runStartTime;
      const sec = Math.floor(ms / 1000);
      if (sec !== lastSec) {
        lastSec = sec;
        setRunElapsedMs(ms);
      }
    }, 500);
    return () => clearInterval(id);
  }, [runMode, runStartTime]);

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

  const onRunConsoleResizePointerDown = useCallback((e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    runConsoleResizeDragRef.current = {
      active: true,
      pointerId: e.pointerId,
      startY: e.clientY,
      startH: runConsoleHeightPx,
    };
    el.setPointerCapture(e.pointerId);
  }, [runConsoleHeightPx]);

  const onRunConsoleResizePointerMove = useCallback((e) => {
    const d = runConsoleResizeDragRef.current;
    if (!d.active || e.pointerId !== d.pointerId) return;
    const delta = d.startY - e.clientY;
    setRunConsoleHeightPx(clampRunConsoleHeightPx(d.startH + delta));
  }, []);

  const persistRunConsoleHeight = useCallback(() => {
    setRunConsoleHeightPx((h) => {
      const clamped = clampRunConsoleHeightPx(h);
      try {
        localStorage.setItem(RUN_CONSOLE_HEIGHT_STORAGE_KEY, String(clamped));
      } catch {
        /* ignore */
      }
      return clamped;
    });
  }, []);

  const onRunConsoleResizePointerUp = useCallback(
    (e) => {
      const d = runConsoleResizeDragRef.current;
      if (!d.active || e.pointerId !== d.pointerId) return;
      d.active = false;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        /* ignore */
      }
      persistRunConsoleHeight();
    },
    [persistRunConsoleHeight],
  );

  const onRunConsoleResizeLostCapture = useCallback(() => {
    const d = runConsoleResizeDragRef.current;
    if (!d.active) return;
    d.active = false;
    persistRunConsoleHeight();
  }, [persistRunConsoleHeight]);

  useEffect(() => {
    function onResize() {
      setRunConsoleHeightPx((h) => clampRunConsoleHeightPx(h));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const handleRun = useCallback(async (/** @type {{ runUuid?: string | null, cliInputsOverride?: Record<string, { type: "str" | "file", value?: string, path?: string }>, prepareOnly?: boolean }} */ opts = {}) => {
    if (!selected) return;
    const runUuid =
      opts.runUuid != null && String(opts.runUuid).trim() ? String(opts.runUuid).trim() : null;
    const inputsToUse = opts.cliInputsOverride ?? cliInputsRef.current;
    const prepareOnly = Boolean(opts.prepareOnly);
    // prepareOnly：进入 run 布局但不启动 CLI，等用户点"开始执行"再真正 fetch
    setRunMode(prepareOnly ? "ready" : "running");
    /* 勿在 fetch 完成前清空：否则在连接建立前控制台会一直空白（计时器已启动） */
    setRunLogs(
      prepareOnly
        ? []
        : [
            {
              ts: new Date().toISOString(),
              type: "info",
              text: runUuid
                ? t("flow:run.connectingApiResume", { uuid: runUuid })
                : t("flow:run.connectingApi"),
            },
          ],
    );
    setExecutingNodes(new Set());
    setNodeRunStatus({});
    setRunConsoleOpen(!prepareOnly);
    setRightPanel(null);
    if (!runUuid) setCurrentRunUuid(null);
    if (prepareOnly) return;
    // resume (runUuid != null)：保留当前 runElapsedMs（上屏显示累计值），等 apply-start 事件把 startTime 精确对齐到 CLI 记录的 totalExecutedMs。
    // 新 run：常规从 0 起。
    if (!runUuid) {
      const start = Date.now();
      setRunStartTime(start);
      setRunElapsedMs(0);
    }

    const abort = new AbortController();
    runAbortRef.current = abort;

    try {
      const resp = await fetch("/api/flow/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flowId: selected.id, flowSource: selected.source || "user", ...(runUuid ? { uuid: runUuid } : {}), cliInputs: inputsToUse }),
        signal: abort.signal,
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: t("flow:composer.requestFailed") }));
        setRunLogs((prev) => [...prev, { ts: new Date().toISOString(), type: "error", text: err.error || t("flow:composer.requestFailed") }]);
        setRunMode("error");
        return;
      }

      setRunLogs((prev) => [
        ...prev,
        { ts: new Date().toISOString(), type: "info", text: t("flow:run.connectedReceiving") },
      ]);

      if (!resp.body) {
        setRunLogs((prev) => [
          ...prev,
          { ts: new Date().toISOString(), type: "error", text: t("flow:run.noBody") },
        ]);
        setRunMode("error");
        return;
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";

      const applyNdjsonMessage = (msg) => {
        const now = msg.ts || new Date().toISOString();
        if (msg.type === "event") {
          if (msg.event === "node-start") {
            setExecutingNodes((s) => new Set(s).add(msg.instanceId));
            setNodeRunStatus((prev) => ({
              ...prev,
              [msg.instanceId]: { status: "running", startMs: Date.now() },
            }));
            setRunLogs((prev) => [
              ...prev,
              { ts: now, type: "node-start", text: msg.label ? t("flow:run.nodeStartWithLabel", { instanceId: msg.instanceId, label: msg.label }) : t("flow:run.nodeStart", { instanceId: msg.instanceId }) },
            ]);
          } else if (msg.event === "node-done") {
            setExecutingNodes((s) => {
              const n = new Set(s);
              n.delete(msg.instanceId);
              return n;
            });
            const elapsed = msg.elapsed ?? null;
            setNodeRunStatus((prev) => ({
              ...prev,
              [msg.instanceId]: { status: "success", elapsed },
            }));
            setRunLogs((prev) => [
              ...prev,
              { ts: now, type: "node-done", text: elapsed ? t("flow:run.nodeDoneWithElapsed", { instanceId: msg.instanceId, elapsed }) : t("flow:run.nodeDone", { instanceId: msg.instanceId }) },
            ]);
          } else if (msg.event === "node-failed") {
            setExecutingNodes((s) => {
              const n = new Set(s);
              n.delete(msg.instanceId);
              return n;
            });
            setNodeRunStatus((prev) => ({
              ...prev,
              [msg.instanceId]: { status: "failed", elapsed: msg.elapsed ?? null },
            }));
            setRunLogs((prev) => [
              ...prev,
              { ts: now, type: "node-failed", text: t("flow:run.nodeFailed", { instanceId: msg.instanceId }) },
            ]);
          } else if (msg.event === "apply-start") {
            if (msg.uuid) setCurrentRunUuid(String(msg.uuid));
            // 优先用 CLI 携带的原始 runStartTime：resume 场景显示「这个 uuid 从首次启动到现在的墙钟总时长」，
            // 而不是只算 totalExecutedMs + 本次 resume 进入后的时长。
            if (typeof msg.runStartTime === "number" && msg.runStartTime > 0) {
              setRunStartTime(msg.runStartTime);
              setRunElapsedMs(Math.max(0, Date.now() - msg.runStartTime));
            } else if (typeof msg.totalExecutedMs === "number" && msg.totalExecutedMs > 0) {
              // 旧版 CLI 兜底：把 startTime 往回偏移 totalExecutedMs
              const offsetStart = Date.now() - msg.totalExecutedMs;
              setRunStartTime(offsetStart);
              setRunElapsedMs(msg.totalExecutedMs);
            }
            setRunLogs((prev) => [...prev, { ts: now, type: "info", text: t("flow:run.pipelineStart", { uuid: msg.uuid || "?" }) }]);
          } else if (msg.event === "apply-done") {
            setRunLogs((prev) => [...prev, { ts: now, type: "info", text: msg.totalElapsed ? t("flow:run.pipelineDoneWithElapsed", { elapsed: msg.totalElapsed }) : t("flow:run.pipelineDone") }]);
          } else if (msg.event === "apply-paused") {
            setRunLogs((prev) => [...prev, { ts: now, type: "warn", text: t("flow:run.pipelinePaused", { nodes: (msg.pendingNodes || []).join(", ") }) }]);
          } else {
            setRunLogs((prev) => [...prev, { ts: now, type: "event", text: `[${msg.event}] ${JSON.stringify(msg)}` }]);
          }
        } else if (msg.type === "user-check-content") {
          setUserCheckContent({
            instanceId: msg.instanceId,
            execId: msg.execId ?? 1,
            inputPath: msg.inputPath,
            outputPath: msg.outputPath,
            content: msg.content || "",
          });
          setUserCheckEditedContent(msg.content || "");
          setUserCheckEditing(false);
          setUserCheckAiPrompt("");
          setUserCheckAiRunning(false);
          setRunLogs((prev) => [
            ...prev,
            { ts: now, type: "user-check", text: t("flow:run.userCheckContent", { instanceId: msg.instanceId }) },
          ]);
        } else if (msg.type === "user-ask-prompt") {
          setUserAskPrompt({
            instanceId: msg.instanceId,
            execId: msg.execId ?? 1,
            question: msg.question || "",
            options: Array.isArray(msg.options) ? msg.options : [],
          });
          setUserAskSubmitting(false);
          setRunLogs((prev) => [
            ...prev,
            { ts: now, type: "user-ask", text: t("flow:run.userAskPrompt", { instanceId: msg.instanceId, defaultValue: `等待用户选择 (${msg.instanceId})` }) },
          ]);
        } else if (msg.type === "tool-print-content") {
          setToolPrintContent({
            instanceId: msg.instanceId,
            execId: msg.execId ?? 1,
            content: msg.content || "",
            createdAt: Date.now(),
          });
          setToolPrintExpanded(false);
        } else if (msg.type === "log") {
          setRunLogs((prev) => [
            ...prev,
            { ts: now, type: "log", text: msg.text != null ? String(msg.text) : "" },
          ]);
        } else if (msg.type === "error") {
          setRunLogs((prev) => [...prev, { ts: now, type: "error", text: msg.message || t("flow:run.unknownError") }]);
        } else if (msg.type === "done") {
          setRunLogs((prev) => [
            ...prev,
            { ts: now, type: "done", text: t("flow:run.executionEnd", { exitCode: msg.exitCode ?? "?" }) },
          ]);
        } else {
          setRunLogs((prev) => [...prev, { ts: now, type: "log", text: JSON.stringify(msg) }]);
        }
      };

      const ingestLine = (line) => {
        if (!line.trim()) return;
        try {
          applyNdjsonMessage(JSON.parse(line));
        } catch {
          setRunLogs((prev) => [...prev, { ts: new Date().toISOString(), type: "log", text: line }]);
        }
      };

      while (true) {
        const { done, value } = await reader.read();
        buf += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) ingestLine(line);
        if (done) break;
      }
      if (buf.trim()) ingestLine(buf);

      setRunMode("done");
    } catch (e) {
      if (e.name === "AbortError") {
        setRunLogs((prev) => [...prev, { ts: new Date().toISOString(), type: "warn", text: t("flow:run.executionStopped") }]);
        setRunMode("stopped");
      } else {
        setRunLogs((prev) => [...prev, { ts: new Date().toISOString(), type: "error", text: e.message || t("flow:run.unknownError") }]);
        setRunMode("error");
      }
    } finally {
      runAbortRef.current = null;
      setExecutingNodes(new Set());
    }
  }, [selected]);

  const [stopConfirmOpen, setStopConfirmOpen] = useState(false);
  const handleStop = useCallback(() => {
    setStopConfirmOpen(true);
  }, []);
  const confirmStop = useCallback(async () => {
    setStopConfirmOpen(false);
    if (runAbortRef.current) {
      runAbortRef.current.abort();
      runAbortRef.current = null;
    }
    if (selected) {
      try {
        await fetch("/api/flow/run/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ flowId: selected.id, flowSource: selected.source || "user" }),
        });
      } catch (_) {}
    }
    setRunMode("stopped");
    setExecutingNodes(new Set());
  }, [selected]);

  const handleBackToEdit = useCallback(() => {
    setRunMode("edit");
    setExecutingNodes(new Set());
    setNodeRunStatus({});
    setRunContextNodeId(null);
    setCurrentRunUuid(null);
  }, []);

  // running 态下点击返回需先询问：停止并进入编辑 / 后台运行并退出 / 取消
  const [backPromptOpen, setBackPromptOpen] = useState(false);
  const stopAndEdit = useCallback(async () => {
    setBackPromptOpen(false);
    if (runAbortRef.current) {
      runAbortRef.current.abort();
      runAbortRef.current = null;
    }
    if (selected) {
      try {
        await fetch("/api/flow/run/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ flowId: selected.id, flowSource: selected.source || "user" }),
        });
      } catch (_) {}
    }
    handleBackToEdit();
  }, [selected, handleBackToEdit]);
  const backgroundAndExit = useCallback(() => {
    setBackPromptOpen(false);
    navigate("/projects");
  }, [navigate]);

  /** 从执行历史进入该次 run 的画布态（列表状态可能与实际目录不一致，如仍显示进行中但实际可恢复） */
  const openRunFromHistory = useCallback(
    (
      /** @type {{ flowId: string, runId?: string, at: number, durationMs?: number, endedAt?: number|null, status?: string }} */ run,
    ) => {
      const rid = run.runId != null && String(run.runId).trim() ? String(run.runId).trim() : null;
      const fid =
        run.flowId != null && String(run.flowId).trim() ? String(run.flowId).trim() : selected?.id != null ? String(selected.id) : null;
      setCurrentRunUuid(rid);
      const st = run.status || "unknown";
      /** @type {"running" | "stopped" | "done" | "error"} */
      let mode = "stopped";
      if (st === "success") mode = "done";
      else if (st === "failed") mode = "error";
      else if (st === "running") mode = "running";
      else mode = "stopped";
      setRunMode(mode);
      /** 墙钟时长：running 用 Date.now()-at 由 timer 自动推进；其余用 endedAt-at（若无则回退 durationMs）。 */
      const startAt = typeof run.at === "number" ? run.at : null;
      if (mode === "running" && startAt != null) {
        setRunStartTime(startAt);
        setRunElapsedMs(Math.max(0, Date.now() - startAt));
      } else if (startAt != null && typeof run.endedAt === "number" && run.endedAt > startAt) {
        setRunStartTime(null);
        setRunElapsedMs(run.endedAt - startAt);
      } else {
        setRunStartTime(null);
        setRunElapsedMs(Math.max(0, run.durationMs ?? 0));
      }
      setRunLogs([]);
      setExecutingNodes(new Set());
      setNodeRunStatus({});
      setRunContextNodeId(null);
      setRightPanel(null);
      setRunConsoleOpen(false);
      if (rid && fid) {
        const q = new URLSearchParams({ flowId: fid, runId: rid });
        void fetch(`/api/run-node-statuses?${q}`)
          .then((r) => r.json())
          .then((j) => {
            const raw = j.statuses && typeof j.statuses === "object" ? j.statuses : {};
            /** @type {Record<string, { status: string, elapsed?: string }>} */
            const next = {};
            for (const [id, v] of Object.entries(raw)) {
              if (v && typeof v === "object" && typeof v.status === "string") {
                next[id] = {
                  status: v.status,
                  ...(v.elapsed != null && String(v.elapsed).trim() !== "" ? { elapsed: String(v.elapsed) } : {}),
                };
              }
            }
            setNodeRunStatus(next);
          })
          .catch(() => {});
      }
    },
    [selected?.id],
  );

  // ── 页面加载 / 刷新后检测活跃 run，恢复 run 模式 ──
  useEffect(() => {
    if (!selected?.id) return;
    if (runMode !== "edit") return; // 已在 run 模式则跳过
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/pipeline-recent-runs");
        const j = await r.json();
        if (cancelled || !r.ok) return;
        const runs = Array.isArray(j.runs) ? j.runs : [];
        const activeRun = runs.find(
          (x) => x.flowId === selected.id && x.status === "running",
        );
        if (!activeRun || cancelled) return;
        const rid = activeRun.runId || null;
        setCurrentRunUuid(rid);
        setRunMode("running");
        setRunConsoleOpen(true);
        setRunStartTime(activeRun.at || Date.now());
        runLogBytesRef.current = 0;
        const seedLogs = [{ ts: new Date().toISOString(), type: "info", text: `[resume] 检测到活跃 run ${rid}，已恢复运行视图` }];
        // 拉取节点状态
        if (rid) {
          const q = new URLSearchParams({ flowId: selected.id, runId: rid });
          const sr = await fetch(`/api/run-node-statuses?${q}`);
          const sj = await sr.json();
          if (cancelled) return;
          const raw = sj.statuses && typeof sj.statuses === "object" ? sj.statuses : {};
          const next = {};
          const exec = new Set();
          for (const [id, v] of Object.entries(raw)) {
            if (v && typeof v === "object" && typeof v.status === "string") {
              next[id] = { status: v.status, ...(v.elapsed != null && String(v.elapsed).trim() !== "" ? { elapsed: String(v.elapsed) } : {}) };
              if (v.status === "running") exec.add(id);
            }
          }
          setNodeRunStatus(next);
          setExecutingNodes(exec);

          // 拉取历史日志：初次加载用 tailBytes 仅取末尾段，避免长跑 run 拉取整份 run.log 卡住浏览器。
          try {
            const lq = new URLSearchParams({ flowId: selected.id, runId: rid, sinceBytes: "0", tailBytes: "262144" });
            const lr = await fetch(`/api/run-log?${lq}`);
            if (lr.ok) {
              const lj = await lr.json();
              if (!cancelled) {
                runLogBytesRef.current = Number(lj.bytes || 0);
                const entries = parseRunLogText(typeof lj.text === "string" ? lj.text : "");
                setRunLogs([...entries, ...seedLogs]);
                return;
              }
            }
          } catch { /* ignore */ }
        }
        setRunLogs(seedLogs);
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [selected?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── run 模式下轮询节点状态（刷新后继续看到推进、完成自动翻转） ──
  useEffect(() => {
    if (runMode === "edit") return;
    if (!selected?.id || !currentRunUuid) return;
    let cancelled = false;
    let timer = null;
    const tick = async () => {
      try {
        const q = new URLSearchParams({ flowId: selected.id, runId: currentRunUuid });
        const sr = await fetch(`/api/run-node-statuses?${q}`);
        if (!sr.ok) return;
        const sj = await sr.json();
        if (cancelled) return;
        const raw = sj.statuses && typeof sj.statuses === "object" ? sj.statuses : {};
        const next = {};
        const exec = new Set();
        for (const [id, v] of Object.entries(raw)) {
          if (v && typeof v === "object" && typeof v.status === "string") {
            next[id] = { status: v.status, ...(v.elapsed != null && String(v.elapsed).trim() !== "" ? { elapsed: String(v.elapsed) } : {}) };
            if (v.status === "running") exec.add(id);
          }
        }
        // 跳过无变化的 setState，避免每 2.5s 触发 runNodes/runEdges 全量 memo 重算 + 21 个 ReactFlow 节点重渲。
        setNodeRunStatus((prev) => (shallowEqualStatusMap(prev, next) ? prev : next));
        setExecutingNodes((prev) => (setsEqual(prev, exec) ? prev : exec));

        // 增量拉取日志：带 tailBytes 上限，防止 log 突增导致单次几十 MB delta。
        try {
          const lq = new URLSearchParams({
            flowId: selected.id,
            runId: currentRunUuid,
            sinceBytes: String(runLogBytesRef.current || 0),
            tailBytes: String(RUN_LOG_POLL_TAIL_BYTES),
          });
          const lr = await fetch(`/api/run-log?${lq}`);
          if (lr.ok) {
            const lj = await lr.json();
            if (cancelled) return;
            const newBytes = Number(lj.bytes || 0);
            const delta = typeof lj.text === "string" ? lj.text : "";
            if (delta) {
              const entries = parseRunLogText(delta);
              if (entries.length > 0) setRunLogs((prev) => [...prev, ...entries]);
            }
            runLogBytesRef.current = newBytes;
          }
        } catch { /* ignore */ }

        // 每拍直接查 API：后端 isApplyProcessAlive 用 PID + kill(pid,0) 做进程探活，
        // 是唯一可信的「run 还在跑」判断。不再用节点 result.md 扫描做前置短路，
        // 否则会在 result.md 人工修改 / pre-process 时序缝隙里误判。
        try {
          const rr = await fetch("/api/pipeline-recent-runs");
          if (!rr.ok) return;
          const rj = await rr.json();
          if (cancelled) return;
          const runs = Array.isArray(rj.runs) ? rj.runs : [];
          const me = runs.find((x) => x.flowId === selected.id && x.runId === currentRunUuid);
          if (me && me.status) {
            const st = me.status;
            if (st === "running") setRunMode((prev) => (prev === "running" ? prev : "running"));
            else if (st === "success") setRunMode("done");
            else if (st === "failed") setRunMode("error");
            else if (st === "stopped" || st === "interrupted") setRunMode("stopped");
          }
        } catch { /* ignore */ }
      } catch { /* ignore */ }
    };
    tick();
    timer = window.setInterval(tick, 2500);
    return () => { cancelled = true; if (timer) window.clearInterval(timer); };
  }, [runMode, selected?.id, currentRunUuid]);

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
  }, [selected]);

  const runsForCurrentFlow = useMemo(() => {
    if (!selected) return [];
    return recentRuns
      .filter((r) => r && r.flowId === selected.id)
      .sort((a, b) => b.at - a.at);
  }, [recentRuns, selected]);

  const execHistoryStats = useMemo(() => {
    let success = 0;
    let failed = 0;
    let running = 0;
    let stopped = 0;
    let interrupted = 0;
    for (const r of runsForCurrentFlow) {
      const s = r.status || "unknown";
      if (s === "success") success += 1;
      else if (s === "failed") failed += 1;
      else if (s === "running") running += 1;
      else if (s === "stopped") stopped += 1;
      else if (s === "interrupted") interrupted += 1;
    }
    return { success, failed, running, stopped, interrupted };
  }, [runsForCurrentFlow]);

  const mentionDraft = useMemo(
    () => (selected ? mentionDraftAtCursor(composerText, composerCursor) : null),
    [selected, composerText, composerCursor],
  );

  /** @typedef {{ kind: "instance" | "definition"; id: string; title: string; subtitle?: string }} MentionMenuPick */
  const mentionMenuFlat = useMemo(() => {
    if (!mentionDraft || !selected) return /** @type {MentionMenuPick[]} */ ([]);
    const q = mentionDraft.query.toLowerCase();
    const matchesQuery = (haystacks) => {
      if (!q) return true;
      return haystacks.some((s) => s && String(s).toLowerCase().includes(q));
    };

    const instanceRows = nodes
      .map((n) => {
        const id = n.id;
        const label = String(n.data?.label ?? id);
        const defId = n.data?.definitionId ? String(n.data.definitionId) : "";
        const subs = [label !== id ? label : "", defId && defId !== id ? defId : ""].filter(Boolean);
        return { id, label, defId, subs };
      })
      .filter(({ id, label, defId }) => matchesQuery([id, label, defId]))
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, 18)
      .map(({ id, label, defId }) => {
        const subtitle = [label !== id ? label : null, defId || null].filter(Boolean).join(" · ") || undefined;
        return /** @type {MentionMenuPick} */ ({
          kind: "instance",
          id,
          title: id,
          subtitle,
        });
      });

    const definitionRows = palette
      .filter((p) => p && p.id && matchesQuery([p.id, p.label, p.description]))
      .sort((a, b) => a.id.localeCompare(b.id))
      .slice(0, 22)
      .map((p) =>
        /** @type {MentionMenuPick} */ ({
          kind: "definition",
          id: p.id,
          title: p.id,
          subtitle: p.label && p.label !== p.id ? String(p.label) : String(p.type || ""),
        }),
      );

    return [...instanceRows, ...definitionRows];
  }, [mentionDraft, nodes, palette, selected]);

  const mentionMenuSections = useMemo(() => {
    const inst = mentionMenuFlat.filter((x) => x.kind === "instance");
    const def = mentionMenuFlat.filter((x) => x.kind === "definition");
    return { instances: inst, definitions: def };
  }, [mentionMenuFlat]);

  useEffect(() => {
    setMentionHighlight((h) => {
      const max = Math.max(0, mentionMenuFlat.length - 1);
      return Math.min(Math.max(0, h), max);
    });
  }, [mentionMenuFlat]);

  const mentionIdsOrdered = useMemo(() => parseMentionInstanceIds(composerText), [composerText]);

  const selectedCanvasNodes = useMemo(() => nodes.filter((n) => n.selected), [nodes]);

  const selectedCanvasNodeIds = useMemo(
    () => new Set(selectedCanvasNodes.map((n) => n.id)),
    [selectedCanvasNodes],
  );

  const selectedCanvasInternalEdges = useMemo(
    () => edges.filter((e) => selectedCanvasNodeIds.has(e.source) && selectedCanvasNodeIds.has(e.target)),
    [edges, selectedCanvasNodeIds],
  );

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

  const openPublishSnippetDialog = useCallback(() => {
    if (selectedCanvasNodes.length < 2) {
      setFlowSnippetsError("请先在画布上选择至少两个节点。");
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
    if (!selected || selectedCanvasNodes.length < 2) return;
    const name = publishSnippetDraft.name.trim();
    if (!name) {
      setPublishSnippetError("请填写片段名称。");
      return;
    }
    const instances = buildInstancesForYaml(selectedCanvasNodes, instancesRef.current);
    const nodePositions = {};
    const nodeSizes = {};
    for (const node of selectedCanvasNodes) {
      nodePositions[node.id] = { x: node.position?.x || 0, y: node.position?.y || 0 };
      const size = persistedFlowNodeSize(node);
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
      const resp = await fetch("/api/marketplace/publish-flow-snippet", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: publishSnippetDraft.id,
          name,
          displayName: name,
          version: "1.0.0",
          description: publishSnippetDraft.description,
          snippet: {
            instances,
            edges: snippetEdges,
            ui: { nodePositions, nodeSizes },
          },
        }),
      });
      const result = await resp.json().catch(() => ({}));
      if (!resp.ok || result?.ok === false) throw new Error(result?.error || "Publish failed");
      setPublishSnippetOpen(false);
      setSaveStatus(`流程片段已发布：${result.id || name}`);
      showFlowSnippetToast(`流程片段已发布：${result.id || name}`);
      await loadFlowSnippets();
      setPaletteMode("flows");
    } catch (e) {
      setPublishSnippetError(String(e.message || e));
    } finally {
      setPublishSnippetBusy(false);
    }
  }, [
    selected,
    selectedCanvasNodes,
    selectedCanvasInternalEdges,
    publishSnippetDraft,
    loadFlowSnippets,
    showFlowSnippetToast,
  ]);

  /** 画布选中优先，再补全仅出现在 @提及 中的节点 */
  const composerStripEntries = useMemo(() => {
    const out =
      /** @type {Array<
        | { kind: "canvas"; node: import("@xyflow/react").Node }
        | { kind: "mention"; node: import("@xyflow/react").Node }
        | { kind: "definition"; definition: (typeof palette)[number] }
      >} */ ([]);
    const seen = new Set();
    for (const n of selectedCanvasNodes) {
      seen.add(n.id);
      out.push({ node: n, kind: "canvas" });
    }
    const byNodeId = new Map(nodes.map((n) => [n.id, n]));
    const byPaletteId = new Map(palette.map((p) => [p.id, p]));
    for (const id of mentionIdsOrdered) {
      if (seen.has(id)) continue;
      const node = byNodeId.get(id);
      if (node) {
        seen.add(id);
        out.push({ node, kind: "mention" });
        continue;
      }
      const def = byPaletteId.get(id);
      if (def) {
        seen.add(id);
        out.push({ definition: def, kind: "definition" });
      }
    }
    return out;
  }, [selectedCanvasNodes, mentionIdsOrdered, nodes, palette]);

  const composerModelSelect = useMemo(() => {
    const cursor = Array.isArray(modelLists?.cursor) ? modelLists.cursor : [];
    const opencode = Array.isArray(modelLists?.opencode) ? modelLists.opencode : [];
    const claudeCode = Array.isArray(modelLists?.claudeCode) ? modelLists.claudeCode : [];
    const opencodeIdValues = opencode.map((m) => `opencode:${modelEntryId(m)}`);
    const claudeCodeIdValues = claudeCode.map((m) => `claude-code:${modelEntryId(m)}`);
    const idSet = new Set(
      [...cursor, ...opencode, ...claudeCode]
        .map(modelEntryId)
        .concat(opencodeIdValues)
        .concat(claudeCodeIdValues),
    );
    const raw = (composerModel || "").trim();
    const normalized = normalizeComposerModelValue(composerModel, cursor, opencode, claudeCode);
    const extra = normalized && !idSet.has(normalized) && !idSet.has(raw) ? raw : "";
    return { cursorList: cursor, opencodeList: opencode, claudeCodeList: claudeCode, currentNotInLists: extra };
  }, [modelLists, composerModel]);

  const composerSelectedSkillSet = useMemo(() => new Set(composerSelectedSkills), [composerSelectedSkills]);
  const composerSelectedSkillCount = composerSelectedSkills.length;
  const composerCollectionGroups = useMemo(() => {
    const byKey = new Map(composerSkills.map((skill) => [skill.key, skill]));
    const used = new Set();
    const usedNames = new Set();
    const groups = composerSkillCollections
      .map((collection) => {
        const groupSkills = collectionSkillKeys(collection, composerSkills).map((key) => byKey.get(key)).filter(Boolean);
        for (const skill of groupSkills) {
          used.add(skill.key);
          usedNames.add(String(skill.name || skill.id || skill.key || "").trim());
        }
        return { ...collection, skills: groupSkills };
      })
      .filter((collection) => collection.skills.length > 0);
    const ungrouped = composerSkills.filter((skill) => {
      const name = String(skill.name || skill.id || skill.key || "").trim();
      return !used.has(skill.key) && !usedNames.has(name);
    });
    return { groups, ungrouped };
  }, [composerSkillCollections, composerSkills]);

  const updateComposerSkillsMenuPosition = useCallback(() => {
    const btn = composerSkillsButtonRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    const width = Math.min(400, Math.max(300, window.innerWidth - 24));
    const left = Math.min(Math.max(12, rect.right - width), window.innerWidth - width - 12);
    const availableAbove = Math.max(140, rect.top - 22);
    const maxHeight = Math.min(360, availableAbove);
    setComposerSkillsMenuStyle({
      position: "fixed",
      left: `${left}px`,
      top: `${Math.max(12, rect.top - maxHeight - 10)}px`,
      width: `${width}px`,
      maxHeight: `${maxHeight}px`,
    });
  }, []);

  useEffect(() => {
    const cursor = Array.isArray(modelLists?.cursor) ? modelLists.cursor : [];
    const opencode = Array.isArray(modelLists?.opencode) ? modelLists.opencode : [];
    const claudeCode = Array.isArray(modelLists?.claudeCode) ? modelLists.claudeCode : [];
    setComposerModel((prev) => {
      const next = normalizeComposerModelValue(prev, cursor, opencode, claudeCode);
      return next === prev ? prev : next;
    });
  }, [modelLists.cursor, modelLists.opencode, modelLists.claudeCode]);

  useEffect(() => {
    if (!composerSkillsOpen) return;
    updateComposerSkillsMenuPosition();
    const onPointerDown = (e) => {
      const target = e.target;
      if (composerSkillsButtonRef.current?.contains(target) || composerSkillsMenuRef.current?.contains(target)) return;
      setComposerSkillsOpen(false);
    };
    const onKeyDown = (e) => {
      if (e.key === "Escape") setComposerSkillsOpen(false);
    };
    window.addEventListener("resize", updateComposerSkillsMenuPosition);
    window.addEventListener("scroll", updateComposerSkillsMenuPosition, true);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("resize", updateComposerSkillsMenuPosition);
      window.removeEventListener("scroll", updateComposerSkillsMenuPosition, true);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [composerSkillsOpen, updateComposerSkillsMenuPosition]);

  const submitComposer = useCallback(async (overridePrompt, options = {}) => {
    if (!selected || composerSubmittingRef.current) return;
    const phaseContextSnapshot = options.phaseContextSnapshot;
    const q = (typeof overridePrompt === "string" ? overridePrompt : composerText).trim();
    if (!q) return;
    const prevSegs = composerNaturalSegmentsRef.current;
    composerSubmittingRef.current = true;
    setComposerRunning(true);
    setComposerStatusLine(t("flow:composer.connecting"));
    setRightPanel((p) => p !== "composer" ? "composer" : p);

    const snapshotThread = [...composerThread];
    if (prevSegs.length > 0) {
      snapshotThread.push({ type: "assistant", segments: [...prevSegs] });
    }
    setComposerThread([...snapshotThread, { type: "user", text: q }]);

    // 首条消息时自动更新 session label 为消息摘要
    if (snapshotThread.filter((m) => m.type === "user").length === 0) {
      const summary = q.replace(/\s+/g, " ").slice(0, 30) + (q.length > 30 ? "…" : "");
      setComposerSessions((prev) =>
        prev.map((s) => s.id === activeSessionId ? { ...s, label: summary } : s)
      );
    }

    const threadForApi = snapshotThread.map((item) => {
      if (item.type === "user") return { role: "user", text: item.text };
      const text = (item.segments || [])
        .filter((s) => s.kind === "assistant" || s.kind === "result")
        .map((s) => s.text)
        .join("\n");
      return { role: "assistant", text };
    }).filter((m) => m.text);

    const currentPhaseCtx = phaseContextSnapshot ?? composerPhaseContext;
    setComposerText("");
    setComposerNaturalSegments([]);
    setComposerSteps([]);
    setComposerOutputDismissed(false);
    const ac = new AbortController();
    composerAbortRef.current = ac;
    composerStreamingSessionIdRef.current = activeSessionId;
    let connectTimer = null;
    const cursor = Array.isArray(modelLists?.cursor) ? modelLists.cursor : [];
    const opencode = Array.isArray(modelLists?.opencode) ? modelLists.opencode : [];
    const claudeCode = Array.isArray(modelLists?.claudeCode) ? modelLists.claudeCode : [];
    const modelKey = normalizeComposerModelValue(composerModel, cursor, opencode, claudeCode);
    const contextInstanceIds = composerStripEntries
      .filter((e) => e.kind !== "definition" && e.node)
      .map((e) => e.node.id);
    const flowForReload = selected;
    let sawDone = false;
    let phaseStreamError = false;
    try {
      // 连接阶段超时保护：若一直拿不到响应（如 UI 服务未启动/卡死），避免永远停在“连接中…”
      connectTimer = setTimeout(() => ac.abort(), 120_000);
      const reqBody = {
        prompt: q,
        model: modelKey,
        flowId: selected.id,
        flowSource: selected.source ?? "user",
        ...(selected.archived ? { flowArchived: true } : {}),
        contextInstanceIds,
        thread: threadForApi,
        selectedSkills: composerSelectedSkills,
      };
      if (currentPhaseCtx && currentPhaseCtx.nextPhase && !currentPhaseCtx.isLastPhase) {
        reqBody.phaseContext = {
          phaseIndex: currentPhaseCtx.nextPhase.index,
          phases: currentPhaseCtx.phases,
          userPromptOriginal: currentPhaseCtx.userPromptOriginal || q,
        };
      }
      if (composerPhaseRole) {
        reqBody.phaseRole = composerPhaseRole;
      }
      const res = await fetch("/api/composer-agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(reqBody),
        signal: ac.signal,
      });
      if (connectTimer) {
        clearTimeout(connectTimer);
        connectTimer = null;
      }
      if (!res.ok) {
        let msg = res.statusText || t("flow:composer.requestFailed");
        try {
          const j = await res.json();
          if (j && j.error) msg = String(j.error);
        } catch {
          /* ignore */
        }
        setComposerStatusLine(msg);
        setComposerNaturalSegments([{ kind: "error", text: msg }]);
        return;
      }
      const reader = res.body?.getReader();
      if (!reader) {
        setComposerStatusLine(t("flow:composer.cannotReadStream"));
        return;
      }
      const dec = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        for (;;) {
          const nl = buf.indexOf("\n");
          if (nl < 0) break;
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (!line) continue;
          let ev;
          try {
            ev = JSON.parse(line);
          } catch {
            continue;
          }
          if (ev.type === "status" && typeof ev.line === "string") setComposerStatusLine(ev.line);
          if (ev.type === "natural" && typeof ev.text === "string" && ev.text) {
            const kind = typeof ev.kind === "string" && ev.kind ? ev.kind : "assistant";
            setComposerNaturalSegments((prev) => [...prev, { kind, text: ev.text }]);
          }
          if (ev.type === "error" && ev.message) {
            phaseStreamError = true;
            const code = ev.code ? ` [${ev.code}]` : "";
            const msg = String(ev.message) + code;
            setComposerStatusLine(msg);
            setComposerNaturalSegments((prev) => [...prev, { kind: "error", text: msg }]);
          }
          if (ev.type === "plan" && Array.isArray(ev.steps)) {
            setComposerSteps(ev.steps.map((s) => ({ ...s, status: "pending" })));
            const stepSummary = ev.steps.map((s, i) => `${i + 1}. ${s.description || s.type}`).join("\n");
            setComposerNaturalSegments((prev) => [
              ...prev,
              { kind: "assistant", text: t("flow:composer.taskPlan", { count: ev.steps.length, summary: stepSummary }) },
            ]);
          }
          if (ev.type === "step-start") {
            const idx = ev.index ?? 0;
            const total = ev.total ?? 0;
            const tierLabel = ev.tier ? ` [${ev.tier}]` : "";
            const modelLabel = ev.model ? ` (${ev.model})` : "";
            setComposerStatusLine(t("flow:composer.step", { current: idx + 1, total, description: (ev.description || "") + tierLabel + modelLabel }));
            setComposerSteps((prev) =>
              prev.map((s) =>
                s.index === idx
                  ? {
                      ...s,
                      status: "running",
                      model: ev.model,
                      tier: ev.tier,
                      nodeRole: ev.nodeRole ?? s.nodeRole,
                      instanceId: ev.instanceId ?? s.instanceId,
                      instanceLabel: ev.instanceLabel ?? s.instanceLabel,
                    }
                  : s,
              ),
            );
          }
          if (ev.type === "step-progress") {
            const idx = ev.index ?? 0;
            const total = ev.total ?? 0;
            setComposerStatusLine(t("flow:composer.step", { current: idx + 1, total, description: ev.description || "" }));
          }
          if (ev.type === "step-done") {
            const idx = ev.index ?? 0;
            setComposerSteps((prev) =>
              prev.map((s) => (s.index === idx ? { ...s, status: ev.success ? "done" : "error" } : s)),
            );
          }
          if (ev.type === "phase-plan" && Array.isArray(ev.phases)) {
            setComposerPhaseContext((prev) => ({
              ...(prev || {}),
              phases: ev.phases,
              currentPhase: ev.currentPhase ?? 0,
              phaseTotal: ev.phaseTotal ?? ev.phases.length,
              phaseName: ev.phaseName || "",
              isLastPhase: false,
              nextPhase: null,
              userPromptOriginal: prev?.userPromptOriginal || q,
            }));
            const phaseLabels = ev.phases.map((p, i) => `${i + 1}. ${p.label}`).join(" → ");
            setComposerNaturalSegments((prev) => [
              ...prev,
              { kind: "assistant", text: t("flow:composer.phaseGeneration", { count: ev.phases.length, labels: phaseLabels, current: ev.phaseName || "" }) },
            ]);
          }
          if (ev.type === "phase-complete") {
            setComposerPhaseContext((prev) => {
              const next = {
                ...(prev || {}),
                phases: ev.phases || prev?.phases || [],
                currentPhase: ev.phaseIndex ?? 0,
                phaseTotal: ev.phaseTotal ?? ev.phases?.length ?? 0,
                phaseName: ev.phaseName || "",
                isLastPhase: Boolean(ev.isLastPhase),
                nextPhase: ev.nextPhase || null,
                userPromptOriginal: ev.userPromptOriginal || prev?.userPromptOriginal || q,
              };
              return next;
            });
            if (!ev.isLastPhase && ev.nextPhase) {
              setComposerNaturalSegments((prev) => [
                ...prev,
                { kind: "assistant", text: t("flow:composer.phaseComplete", { phaseName: ev.phaseName || t("flow:composer.nextPhase"), nextPhase: ev.nextPhase.label }) },
              ]);
            }
          }
          if (ev.type === "done") {
            sawDone = true;
            setComposerStatusLine((s) => s || t("flow:composer.done"));
          }
        }
      }
    } catch (e) {
      const err = /** @type {Error & { name?: string }} */ (e);
      if (err.name === "AbortError") {
        const msg = connectTimer
          ? t("flow:composer.connectTimeout")
          : t("flow:composer.aborted");
        setComposerStatusLine(msg);
        setComposerNaturalSegments((prev) => [...prev, { kind: "error", text: msg }]);
      } else {
        const code = err.code || err.name || "UNKNOWN";
        const msg = `${err.message || String(e)} [${code}]`;
        setComposerStatusLine(msg);
        setComposerNaturalSegments((prev) => [...prev, { kind: "error", text: msg }]);
      }
    } finally {
      composerSubmittingRef.current = false;
      setComposerRunning(false);
      composerAbortRef.current = null;
      composerStreamingSessionIdRef.current = null;
      if (connectTimer) clearTimeout(connectTimer);
      if (sawDone && flowForReload) {
        const reloadFlow = {
          id: flowForReload.id,
          source: flowForReload.source ?? "user",
          archived: flowForReload.archived,
        };
        void (async () => {
          await loadFlow(reloadFlow, { preserveComposer: true, incrementalSync: true });
          await loadSchedule(reloadFlow, { quiet: true, force: true });
        })();
      }
    }
  }, [selected, composerText, composerModel, modelLists, composerStripEntries, loadFlow, loadSchedule, composerThread, activeSessionId, composerPhaseContext, composerPhaseRole, composerSelectedSkills]);

  submitComposerRef.current = submitComposer;

  const skipRemainingPhases = useCallback(() => {
    if (!composerPhaseContext || composerPhaseContext.isLastPhase) return;
    setComposerPhaseContext(null);
    void submitComposer(t("flow:composer.skipRemainingPhases"));
  }, [composerPhaseContext, submitComposer]);

  const continueNextPhase = useCallback(() => {
    if (!composerPhaseContext || composerPhaseContext.isLastPhase || !composerPhaseContext.nextPhase) return;
    const label = String(composerPhaseContext.nextPhase.label || "").trim() || t("flow:composer.nextPhase");
    void submitComposer(t("flow:composer.continuePhase", { label }), { phaseContextSnapshot: composerPhaseContext });
  }, [composerPhaseContext, submitComposer]);

  useEffect(() => {
    if (!composerExpanded) return;
    const onKey = (e) => {
      if (e.key === "Escape") setComposerExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [composerExpanded]);

  useEffect(() => {
    if (runMode !== "edit") setComposerExpanded(false);
  }, [runMode]);

  useLayoutEffect(() => {
    const ta = composerInputRef.current;
    if (!ta) return;
    if (!selected) {
      ta.style.height = "";
      return;
    }
    ta.style.height = "0px";
    const cs = getComputedStyle(ta);
    const lineHeight = parseFloat(cs.lineHeight);
    const padY = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const lh = Number.isFinite(lineHeight) && lineHeight > 0 ? lineHeight : 13 * 1.45;
    const minH = padY + lh * 2;
    const maxH = padY + lh * 10;
    const next = Math.min(Math.max(ta.scrollHeight, minH), maxH);
    ta.style.height = `${next}px`;
  }, [composerText, selected]);

  const insertMentionPick = useCallback(
    (pickedId) => {
      const text = composerText;
      const cursor = composerCursor;
      const ctx = mentionDraftAtCursor(text, cursor);
      if (!ctx) return;
      const newText = text.slice(0, ctx.atIndex) + `@${pickedId} ` + text.slice(cursor);
      setComposerText(newText);
      const newPos = ctx.atIndex + pickedId.length + 2;
      queueMicrotask(() => {
        const el = composerInputRef.current;
        if (el) {
          el.focus();
          el.setSelectionRange(newPos, newPos);
        }
        setComposerCursor(newPos);
      });
    },
    [composerText, composerCursor],
  );

  const removeMentionToken = useCallback((instanceId) => {
    setComposerText((prev) => {
      const token = `@${instanceId}`;
      const i = prev.indexOf(token);
      if (i < 0) return prev;
      return prev.slice(0, i) + prev.slice(i + token.length);
    });
  }, []);

  const dismissComposerStripTag = useCallback(
    (entry) => {
      if (entry.kind === "canvas") {
        setNodes((ns) => ns.map((x) => (x.id === entry.node.id ? { ...x, selected: false } : x)));
      } else if (entry.kind === "mention") {
        removeMentionToken(entry.node.id);
      } else {
        removeMentionToken(entry.definition.id);
      }
    },
    [setNodes, removeMentionToken],
  );

  const openHistoryPanel = useCallback(() => {
    setRightPanel((p) => (p === "history" ? null : "history"));
  }, []);

  const openSettingsPanel = useCallback(() => {
    setRightPanel((p) => (p === "settings" ? null : "settings"));
  }, []);

  const openComposerPanel = useCallback(() => {
    setRightPanel((p) => (p === "composer" ? null : "composer"));
  }, []);

  const closeRightPanel = useCallback(() => {
    setRightPanel((p) => {
      if (p === "node" && soleSelectedNodeRef.current) {
        nodePanelSuppressedRef.current = soleSelectedNodeRef.current.id;
      }
      return null;
    });
  }, []);

  const toggleShortcutsPanel = useCallback(() => {
    setShortcutsOpen((o) => !o);
  }, []);

  const renderPipelineSettingsPage = () => {
    if (!selected) return null;
    const scheduleReadOnly = scheduleSaving || selected.archived || isReadonlyBuiltinFlowSource(selected.source);
    const scheduleRuntimeLabel = scheduleRuntimeStatus?.running
      ? t("flow:schedule.running")
      : scheduleDraft.enabled
        ? t("flow:schedule.waiting")
        : t("flow:schedule.disabled");
    const scheduleRuntimeMod = scheduleRuntimeStatus?.running
      ? "running"
      : scheduleDraft.enabled
        ? "waiting"
        : "disabled";
    const marketplacePreview = marketplaceCatalogNodes.slice(0, 12);
    const marketReadOnly = selected.archived || isReadonlyBuiltinFlowSource(selected.source);
    return (
      <section className="af-pipeline-settings-page" aria-label={t("flow:settings.title")}>
        <aside className="af-pipeline-settings-nav" aria-label={t("flow:settings.sectionNav")}>
          <div className="af-pipeline-settings-nav-title">{t("flow:settings.title")}</div>
          <a href="#pipeline-basic" className="af-pipeline-settings-nav-item af-pipeline-settings-nav-item--active">
            <span className="material-symbols-outlined" aria-hidden>badge</span>
            {t("flow:settings.basicInfo")}
          </a>
          <a href="#pipeline-storage" className="af-pipeline-settings-nav-item">
            <span className="material-symbols-outlined" aria-hidden>folder_open</span>
            {t("flow:settings.storageAndPath")}
          </a>
          <a href="#pipeline-marketplace" className="af-pipeline-settings-nav-item">
            <span className="material-symbols-outlined" aria-hidden>deployed_code</span>
            {t("flow:settings.nodeMarketplace")}
          </a>
          <a href="#pipeline-schedule" className="af-pipeline-settings-nav-item">
            <span className="material-symbols-outlined" aria-hidden>schedule</span>
            {t("flow:schedule.title")}
          </a>
          <a href="#pipeline-metadata" className="af-pipeline-settings-nav-item">
            <span className="material-symbols-outlined" aria-hidden>dataset</span>
            {t("flow:pipeline.metadata")}
          </a>
          <button type="button" className="af-pipeline-settings-nav-link" onClick={() => navigate("/settings")}>
            {t("flow:settings.globalSettings")}
            <span className="material-symbols-outlined" aria-hidden>open_in_new</span>
          </button>
        </aside>

        <main className="af-pipeline-settings-main">
          <div className="af-pipeline-settings-main-head">
            <div>
              <h1 className="af-pipeline-settings-title">{t("flow:settings.title")}</h1>
              <p className="af-pipeline-settings-subtitle">{t("flow:settings.subtitle")}</p>
            </div>
            <button type="button" className="af-btn-secondary" onClick={closeRightPanel}>
              <span className="material-symbols-outlined" aria-hidden>arrow_back</span>
              {t("flow:settings.backToCanvas")}
            </button>
          </div>

          <section id="pipeline-basic" className="af-pipeline-settings-section">
            <div className="af-pipeline-settings-section-head">
              <span className="af-pipeline-settings-section-index">1.</span>
              <h2>{t("flow:settings.basicInfo")}</h2>
            </div>
            <div className="af-pipeline-settings-grid af-pipeline-settings-grid--two">
              <div className="af-pipeline-drawer-field">
                <span className="af-pipeline-drawer-label">{t("flow:pipeline.pipelineId")}</span>
                {(selected.source === "user" || selected.source === "workspace") && !selected.archived ? (
                  <div className="af-pipeline-rename-row">
                    <input
                      type="text"
                      className="af-pipeline-rename-input"
                      value={renameFlowId}
                      onChange={(e) => { setRenameFlowId(e.target.value); setRenameFlowError(""); }}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleRenameFlow(); } }}
                      onBlur={() => { if (renameFlowId.trim() && renameFlowId.trim() !== selected.id) handleRenameFlow(); }}
                      placeholder={selected.id}
                      disabled={renameFlowBusy}
                      spellCheck={false}
                    />
                    <span className="af-pipeline-drawer-badge">
                      {flowSourceLabelZh(selected.source ?? "user", t)}
                    </span>
                  </div>
                ) : (
                  <div className="af-pipeline-drawer-readonly">
                    {selected.id}
                    <span className="af-pipeline-drawer-badge">
                      {flowSourceLabelZh(selected.source ?? "user", t)}
                    </span>
                    {selected.archived ? (
                      <span className="af-pipeline-drawer-badge af-pipeline-drawer-badge--muted">{t("flow:settings.archived")}</span>
                    ) : null}
                  </div>
                )}
                {renameFlowError ? <p className="af-err af-pipeline-drawer-err">{renameFlowError}</p> : null}
              </div>

              <div className="af-pipeline-settings-kv-block">
                <span className="af-pipeline-drawer-label">{t("flow:settings.owner")}</span>
                <div className="af-pipeline-drawer-readonly">
                  <span className="material-symbols-outlined" aria-hidden>person</span>
                  {selected.owner || "bigo"}
                </div>
              </div>
            </div>
            <label className="af-pipeline-drawer-field">
              <span className="af-pipeline-drawer-label">{t("flow:pipeline.introduction")}</span>
              <textarea
                className="af-pipeline-drawer-textarea af-pipeline-settings-textarea"
                value={flowDescription}
                onChange={(e) => setFlowDescription(e.target.value)}
                placeholder={t("flow:pipeline.introductionPlaceholder")}
                rows={4}
                spellCheck={false}
              />
            </label>
          </section>

          <section id="pipeline-storage" className="af-pipeline-settings-section">
            <div className="af-pipeline-settings-section-head">
              <span className="af-pipeline-settings-section-index">2.</span>
              <h2>{t("flow:settings.storageAndPath")}</h2>
            </div>
            {typeof selected.path === "string" && selected.path ? (
              <div className="af-pipeline-drawer-field">
                <span className="af-pipeline-drawer-label">{t("flow:pipeline.diskPath")}</span>
                <div className="af-pipeline-drawer-readonly af-pipeline-drawer-readonly--mono af-pipeline-path-row">
                  <span className="af-pipeline-path-text">{selected.path}</span>
                  <button
                    type="button"
                    className="af-icon-btn af-pipeline-copy-btn"
                    onClick={() => handleCopyPath(selected.path)}
                    title={t("flow:settings.copyPath")}
                  >
                    <span className="material-symbols-outlined">{pathCopied ? "check" : "content_copy"}</span>
                  </button>
                </div>
              </div>
            ) : null}
            {(selected.source === "user" || selected.source === "workspace") ? (
              selected.archived ? (
                <p className="af-pipeline-drawer-muted">{t("flow:settings.archivedNote")}</p>
              ) : (
                <div className="af-pipeline-drawer-field">
                  <span className="af-pipeline-drawer-label">{t("flow:pipeline.storageLocation")}</span>
                  <div className="af-pipeline-move-actions">
                    {selected.source === "user" ? (
                      <button
                        type="button"
                        className="af-btn-secondary"
                        disabled={moveFlowBusy}
                        onClick={() => handleMoveFlow("workspace")}
                      >
                        {moveFlowBusy ? t("flow:settings.moveBusy") : t("flow:settings.moveToWorkspace")}
                      </button>
                    ) : (
                      <button
                        type="button"
                        className="af-btn-secondary"
                        disabled={moveFlowBusy}
                        onClick={() => handleMoveFlow("user")}
                      >
                        {moveFlowBusy ? t("flow:settings.moveBusy") : t("flow:settings.moveToUserDir")}
                      </button>
                    )}
                  </div>
                  {moveFlowError ? <p className="af-err af-pipeline-drawer-err">{moveFlowError}</p> : null}
                </div>
              )
            ) : (
              <p className="af-pipeline-drawer-muted">{t("flow:settings.builtinNote")}</p>
            )}
          </section>

          <section id="pipeline-marketplace" className="af-pipeline-settings-section">
            <div className="af-pipeline-settings-section-head">
              <span className="af-pipeline-settings-section-index">3.</span>
              <h2>{t("flow:settings.nodeMarketplace")}</h2>
            </div>
            <div className="af-pipeline-market-row">
              <div>
                <div className="af-pipeline-market-count">
                  {marketplaceCatalogNodes.length} {t("flow:settings.marketNodesUnit")}
                </div>
                <p className="af-pipeline-drawer-muted">{t("flow:settings.marketplaceHint")}</p>
              </div>
              <button type="button" className="af-btn-secondary" onClick={loadMarketplaceCatalog} disabled={marketplaceCatalogLoading}>
                <span className="material-symbols-outlined" aria-hidden>refresh</span>
                {marketplaceCatalogLoading ? t("common:common.loading") : t("common:common.refresh")}
              </button>
            </div>
            {marketplaceCatalogError ? <p className="af-err af-pipeline-drawer-err">{marketplaceCatalogError}</p> : null}
            {marketplaceCatalogLoading ? (
              <p className="af-pipeline-drawer-muted">{t("common:common.loading")}</p>
            ) : marketplacePreview.length > 0 ? (
              <div className="af-pipeline-market-list">
                {marketplacePreview.map((n) => {
                  const definitionId = n.definitionId || `marketplace:${n.id}${n.version ? `@${n.version}` : ""}`;
                  const installed = installedMarketplaceKeys.has(definitionId) || installedMarketplaceKeys.has(`marketplace:${n.id}`);
                  const paletteDef = marketplaceNodes.find(
                    (x) => String(x.id) === definitionId || String(x.id) === `marketplace:${n.id}`,
                  );
                  const busy = marketplaceInstallBusy === definitionId;
                  const inputSlots = summarizeMarketplaceSlots(n.inputs || n.input);
                  const outputSlots = summarizeMarketplaceSlots(n.outputs || n.output);
                  return (
                    <div key={definitionId} className="af-pipeline-market-item">
                      <span className="material-symbols-outlined" aria-hidden>{installed ? "check_circle" : "extension"}</span>
                      <div className="af-pipeline-market-main">
                        <div className="af-pipeline-market-title-row">
                          <strong>{n.displayName || n.label || n.id}</strong>
                          <span>{n.version ? `v${n.version}` : definitionId}</span>
                        </div>
                        <p className="af-pipeline-market-purpose">
                          {n.description || t("flow:settings.marketplaceNoDescription")}
                        </p>
                        <div className="af-pipeline-market-io">
                          <div>
                            <span className="af-pipeline-market-io-label">Inputs</span>
                            <div className="af-pipeline-market-chips">
                              {inputSlots.length > 0 ? inputSlots.map((slot) => (
                                <span key={`in-${definitionId}-${slot}`} className="af-pipeline-market-chip">{slot}</span>
                              )) : <span className="af-pipeline-market-chip af-pipeline-market-chip--muted">{t("flow:settings.noInputs")}</span>}
                            </div>
                          </div>
                          <div>
                            <span className="af-pipeline-market-io-label">Outputs</span>
                            <div className="af-pipeline-market-chips">
                              {outputSlots.length > 0 ? outputSlots.map((slot) => (
                                <span key={`out-${definitionId}-${slot}`} className="af-pipeline-market-chip">{slot}</span>
                              )) : <span className="af-pipeline-market-chip af-pipeline-market-chip--muted">{t("flow:settings.noOutputs")}</span>}
                            </div>
                          </div>
                        </div>
                      </div>
                      <div className="af-pipeline-market-actions">
                        <button
                          type="button"
                          className="af-btn-secondary af-pipeline-market-action"
                          onClick={() => setMarketplacePreviewNode(n)}
                        >
                          {t("flow:settings.previewNode")}
                        </button>
                        <button
                          type="button"
                          className={installed ? "af-btn-secondary af-pipeline-market-action" : "af-btn-primary af-pipeline-market-action"}
                          disabled={marketReadOnly || busy}
                          onClick={() => {
                            if (installed && paletteDef) {
                              addNodeFromPalette(paletteDef);
                              setRightPanel(null);
                            } else {
                              void installMarketplaceNodeForFlow(n);
                            }
                          }}
                        >
                          {busy
                            ? t("flow:settings.installingNode")
                            : installed
                              ? t("flow:settings.addInstalledNode")
                              : t("flow:settings.installNode")}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="af-pipeline-settings-empty">{t("flow:settings.marketplaceEmpty")}</div>
            )}
          </section>

          <section id="pipeline-schedule" className="af-pipeline-settings-section">
            <div className="af-pipeline-settings-section-head">
              <span className="af-pipeline-settings-section-index">4.</span>
              <h2>{t("flow:schedule.title")}</h2>
            </div>
            {scheduleLoading ? (
              <p className="af-pipeline-drawer-muted">{t("common:common.loading")}</p>
            ) : (
              <>
                <div className="af-pipeline-settings-schedule-grid">
                  <label className="af-new-pipeline-radio af-pipeline-settings-checkbox">
                    <input
                      type="checkbox"
                      checked={Boolean(scheduleDraft.enabled)}
                      disabled={scheduleReadOnly}
                      onChange={(e) =>
                        updateScheduleDraft((prev) => ({ ...prev, enabled: e.target.checked }))
                      }
                    />
                    <span>{t("flow:schedule.enabled")}</span>
                  </label>
                  <label className="af-pipeline-drawer-field">
                    <span className="af-pipeline-drawer-label">{t("flow:schedule.cron")}</span>
                    <input
                      type="text"
                      className="af-pipeline-rename-input"
                      value={scheduleDraft.cron || ""}
                      disabled={scheduleReadOnly}
                      onChange={(e) =>
                        updateScheduleDraft((prev) => ({ ...prev, cron: e.target.value }))
                      }
                      placeholder="0 9 * * *"
                      spellCheck={false}
                    />
                  </label>
                  <label className="af-pipeline-drawer-field">
                    <span className="af-pipeline-drawer-label">{t("flow:schedule.timezone")}</span>
                    <input
                      type="text"
                      className="af-pipeline-rename-input"
                      value={scheduleDraft.timezone || ""}
                      disabled={scheduleReadOnly}
                      onChange={(e) =>
                        updateScheduleDraft((prev) => ({ ...prev, timezone: e.target.value }))
                      }
                      placeholder="Asia/Shanghai"
                      spellCheck={false}
                    />
                  </label>
                  <label className="af-pipeline-drawer-field">
                    <span className="af-pipeline-drawer-label">{t("flow:schedule.preset")}</span>
                    <select
                      className="af-pipeline-flow-select"
                      value={scheduleDraft.preset || ""}
                      disabled={scheduleReadOnly}
                      onChange={(e) =>
                        updateScheduleDraft((prev) => ({ ...prev, preset: e.target.value }))
                      }
                    >
                      <option value="">{t("flow:schedule.defaultPreset")}</option>
                      {Object.keys(runPresets).map((name) => (
                        <option key={name} value={name}>{name}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="af-pipeline-settings-schedule-status">
                  <span className={`af-pipeline-settings-status-dot af-pipeline-settings-status-dot--${scheduleRuntimeMod}`} />
                  <span>
                    {scheduleDraft.nextRunAt
                      ? t("flow:schedule.nextRun", { time: new Date(scheduleDraft.nextRunAt).toLocaleString() })
                      : t("flow:schedule.noNextRun")}
                  </span>
                  <span>{t("flow:schedule.runtime")}：{scheduleRuntimeLabel}</span>
                </div>
                <dl className="af-pipeline-meta-dl af-pipeline-settings-dl">
                  {scheduleState.lastTriggeredAt ? (
                    <div className="af-pipeline-meta-row">
                      <dt>{t("flow:schedule.lastTriggeredAt")}</dt>
                      <dd>{new Date(scheduleState.lastTriggeredAt).toLocaleString()}</dd>
                    </div>
                  ) : null}
                  {scheduleState.lastSkippedAt ? (
                    <div className="af-pipeline-meta-row">
                      <dt>{t("flow:schedule.lastSkippedAt")}</dt>
                      <dd>
                        {new Date(scheduleState.lastSkippedAt).toLocaleString()}
                        {scheduleState.lastSkipReason ? ` · ${scheduleState.lastSkipReason}` : ""}
                      </dd>
                    </div>
                  ) : null}
                  {scheduleState.lastRunUuid ? (
                    <div className="af-pipeline-meta-row">
                      <dt>{t("flow:schedule.lastRun")}</dt>
                      <dd>{scheduleState.lastRunUuid}</dd>
                    </div>
                  ) : null}
                  {scheduleState.lastExitCode != null ? (
                    <div className="af-pipeline-meta-row">
                      <dt>{t("flow:schedule.lastExit")}</dt>
                      <dd>{String(scheduleState.lastExitCode)}</dd>
                    </div>
                  ) : null}
                  {scheduleState.lastFinishedAt ? (
                    <div className="af-pipeline-meta-row">
                      <dt>{t("flow:schedule.lastFinishedAt")}</dt>
                      <dd>{new Date(scheduleState.lastFinishedAt).toLocaleString()}</dd>
                    </div>
                  ) : null}
                </dl>
                {(scheduleRuntimeStatus?.lastError || scheduleState.lastError) ? (
                  <p className="af-err af-pipeline-drawer-err">
                    {scheduleRuntimeStatus?.lastError || scheduleState.lastError}
                  </p>
                ) : null}
                {selected.archived || isReadonlyBuiltinFlowSource(selected.source) ? (
                  <p className="af-pipeline-drawer-muted">{t("flow:schedule.readonlyNote")}</p>
                ) : null}
                {scheduleError ? <p className="af-err af-pipeline-drawer-err">{scheduleError}</p> : null}
                {scheduleStatus ? <p className="af-pipeline-drawer-muted">{scheduleStatus}</p> : null}
              </>
            )}
          </section>

          <section id="pipeline-metadata" className="af-pipeline-settings-section">
            <div className="af-pipeline-settings-section-head">
              <span className="af-pipeline-settings-section-index">5.</span>
              <h2>{t("flow:pipeline.metadata")}</h2>
            </div>
            <dl className="af-pipeline-meta-dl af-pipeline-settings-dl">
              <div className="af-pipeline-meta-row">
                <dt>{t("flow:pipeline.nodeCount")}</dt>
                <dd>{nodes.length} {t("flow:pipeline.nodesUnit")}</dd>
              </div>
              <div className="af-pipeline-meta-row">
                <dt>{t("flow:settings.marketplaceNodes")}</dt>
                <dd>{marketplaceNodes.length}</dd>
              </div>
              <div className="af-pipeline-meta-row">
                <dt>{t("flow:settings.source")}</dt>
                <dd>{flowSourceLabelZh(selected.source ?? "user", t)}</dd>
              </div>
            </dl>
          </section>
        </main>

        <aside className="af-pipeline-settings-side" aria-label={t("flow:settings.overview")}>
          <section className="af-pipeline-settings-side-card">
            <div className="af-pipeline-settings-overview-head">
              <span className="af-pipeline-settings-overview-icon material-symbols-outlined" aria-hidden>account_tree</span>
              <div>
                <h2>{selected.id}</h2>
                <span className={`af-pipeline-settings-status af-pipeline-settings-status--${scheduleRuntimeMod}`}>
                  {scheduleRuntimeLabel}
                </span>
              </div>
            </div>
            <dl className="af-pipeline-settings-side-dl">
              <div>
                <dt>{t("flow:pipeline.nodeCount")}</dt>
                <dd>{nodes.length}</dd>
              </div>
              <div>
                <dt>{t("flow:settings.owner")}</dt>
                <dd>{selected.owner || "bigo"}</dd>
              </div>
              <div>
                <dt>{t("flow:settings.source")}</dt>
                <dd>{flowSourceLabelZh(selected.source ?? "user", t)}</dd>
              </div>
            </dl>
          </section>
          <section className="af-pipeline-settings-side-card">
            <h2>{t("flow:settings.quickActions")}</h2>
            <button type="button" className="af-btn-primary af-pipeline-settings-side-action" onClick={() => void handleSavePipelineSettings()} disabled={scheduleSaving}>
              <span className="material-symbols-outlined" aria-hidden>save</span>
              {scheduleSaving ? t("flow:settings.savingChanges") : t("flow:settings.saveChanges")}
            </button>
            <button type="button" className="af-btn-secondary af-pipeline-settings-side-action" onClick={closeRightPanel}>
              <span className="material-symbols-outlined" aria-hidden>arrow_back</span>
              {t("flow:settings.backToCanvas")}
            </button>
          </section>
          <section className="af-pipeline-settings-side-card">
            <h2>{t("flow:settings.help")}</h2>
            <p className="af-pipeline-drawer-muted">{t("flow:settings.helpText")}</p>
            <button type="button" className="af-pipeline-drawer-link" onClick={() => navigate("/settings")}>
              {t("flow:settings.globalSettings")}
            </button>
          </section>
        </aside>
      </section>
    );
  };

  const renderMarketplacePreviewDialog = () => {
    const n = marketplacePreviewNode;
    if (!n) return null;
    const definitionId = n.definitionId || `marketplace:${n.id}${n.version ? `@${n.version}` : ""}`;
    const title = n.displayName || n.label || n.id;
    const inputSlots = summarizeMarketplaceSlots(n.inputs || n.input);
    const outputSlots = summarizeMarketplaceSlots(n.outputs || n.output);
    return createPortal(
      <div
        className="af-market-preview-overlay"
        role="dialog"
        aria-modal="true"
        aria-label={t("flow:settings.nodePreviewTitle")}
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) setMarketplacePreviewNode(null);
        }}
      >
        <div className="af-market-preview-dialog">
          <div className="af-market-preview-head">
            <div>
              <span className="af-pipeline-drawer-label">{t("flow:settings.nodePreviewTitle")}</span>
              <h2>{title}</h2>
            </div>
            <button
              type="button"
              className="af-icon-btn"
              onClick={() => setMarketplacePreviewNode(null)}
              aria-label={t("flow:settings.closePreview")}
            >
              <span className="material-symbols-outlined">close</span>
            </button>
          </div>

          <div className="af-market-preview-body">
            <section className="af-market-preview-visual" aria-label={t("flow:settings.nodeStylePreview")}>
              <div className="af-market-preview-node">
                <div className="af-market-preview-node-ports af-market-preview-node-ports--left">
                  {(inputSlots.length > 0 ? inputSlots : [""]).slice(0, 4).map((slot, idx) => (
                    <span key={`preview-in-${idx}`} title={slot} />
                  ))}
                </div>
                <div className="af-market-preview-node-main">
                  <span className="af-market-preview-node-icon material-symbols-outlined" aria-hidden>
                    extension
                  </span>
                  <strong>{title}</strong>
                  <span>{definitionId}</span>
                </div>
                <div className="af-market-preview-node-ports af-market-preview-node-ports--right">
                  {(outputSlots.length > 0 ? outputSlots : [""]).slice(0, 4).map((slot, idx) => (
                    <span key={`preview-out-${idx}`} title={slot} />
                  ))}
                </div>
              </div>
            </section>

            <section className="af-market-preview-section">
              <h3>{t("flow:settings.nodeFunction")}</h3>
              <p>{n.description || t("flow:settings.marketplaceNoDescription")}</p>
            </section>

            <div className="af-market-preview-io-grid">
              <section className="af-market-preview-section">
                <h3>Inputs</h3>
                <div className="af-pipeline-market-chips af-market-preview-chips">
                  {inputSlots.length > 0 ? inputSlots.map((slot) => (
                    <span key={`preview-input-${slot}`} className="af-pipeline-market-chip">{slot}</span>
                  )) : <span className="af-pipeline-market-chip af-pipeline-market-chip--muted">{t("flow:settings.noInputs")}</span>}
                </div>
              </section>
              <section className="af-market-preview-section">
                <h3>Outputs</h3>
                <div className="af-pipeline-market-chips af-market-preview-chips">
                  {outputSlots.length > 0 ? outputSlots.map((slot) => (
                    <span key={`preview-output-${slot}`} className="af-pipeline-market-chip">{slot}</span>
                  )) : <span className="af-pipeline-market-chip af-pipeline-market-chip--muted">{t("flow:settings.noOutputs")}</span>}
                </div>
              </section>
            </div>

            <section className="af-market-preview-section">
              <h3>{t("flow:settings.nodePackageInfo")}</h3>
              <dl className="af-market-preview-dl">
                <div>
                  <dt>{t("flow:settings.definitionId")}</dt>
                  <dd>{definitionId}</dd>
                </div>
                <div>
                  <dt>{t("flow:settings.version")}</dt>
                  <dd>{n.version || "-"}</dd>
                </div>
                <div>
                  <dt>{t("flow:settings.packagePath")}</dt>
                  <dd>{n.packageDir || "-"}</dd>
                </div>
                <div>
                  <dt>{t("flow:settings.packagedFiles")}</dt>
                  <dd>
                    {Array.isArray(n.packagedFiles) && n.packagedFiles.length > 0
                      ? n.packagedFiles.map((f) => f.to || f).join(", ")
                      : "-"}
                  </dd>
                </div>
              </dl>
            </section>
          </div>
        </div>
      </div>,
      document.body,
    );
  };

  return (
    <ReactFlowProvider>
      <NodeInternalsRefreshBridge onReady={handleNodeInternalsRefreshReady} />
      <FlowNodeContext.Provider value={{ modelLists, onModelChange: handleNodeModelChange }}>
        <div className={"af-pipeline-page" + (runMode !== "edit" ? " af-pipeline-page--run-mode" : "")}>
          <header className="af-pipeline-top">
            <div className="af-pipeline-top-left">
              <button
                type="button"
                className="af-icon-btn af-pipeline-back"
                onClick={() => {
                  if (runMode === "running") {
                    setBackPromptOpen(true);
                  } else if (runMode !== "edit") {
                    handleBackToEdit();
                  } else {
                    navigate("/projects");
                  }
                }}
                aria-label={runMode !== "edit" ? t("flow:topbar.backToEdit") : t("flow:topbar.backToProjects")}
                title={runMode !== "edit" ? t("flow:topbar.backToEdit") : t("flow:topbar.backToProjects")}
            >
              <span className="material-symbols-outlined">arrow_back</span>
            </button>
            <div className="af-pipeline-brand">
              <span className="af-pipeline-brand-name">PIPELINE</span>
              <span className="af-pipeline-brand-ver">V{APP_VERSION}-STABLE</span>
            </div>
            <div className="af-view-switch" aria-label="视图切换">
              <button type="button" className="af-view-switch__active">Pipeline</button>
              <button type="button" onClick={() => navigate(flowUrlForView(selected, "workspace"))}>Workspace</button>
              <button type="button" onClick={() => navigate(flowUrlForView(selected, "display"))}>Display</button>
            </div>
          </div>
          <div className="af-pipeline-top-right af-flow-toolbar-actions">
            {isDevMode && (
              <button
                type="button"
                className={"af-icon-btn" + (logViewerOpen ? " af-icon-btn--active" : "")}
                aria-label="Composer Logs (dev)"
                title="Composer Logs (dev)"
                onClick={() => setLogViewerOpen((v) => !v)}
              >
                <span className="material-symbols-outlined">description</span>
              </button>
            )}
            {runMode === "running" && (
              <div className="af-run-timer">
                <span className="af-run-timer__dot" />
                <span className="af-run-timer__label">RUNTIME</span>
                <span className="af-run-timer__value">{formatToolbarRunTimer(runElapsedMs, "running")}</span>
              </div>
            )}
            {runMode === "stopped" && (
              <div className="af-run-timer af-run-timer--stopped">
                <span className="af-run-timer__label">PAUSED</span>
                <span className="af-run-timer__value">{formatToolbarRunTimer(runElapsedMs, "stopped")}</span>
              </div>
            )}
            {(runMode === "done" || runMode === "error") && (
              <div className={"af-run-timer" + (runMode === "error" ? " af-run-timer--error" : " af-run-timer--done")}>
                <span className="af-run-timer__label">{runMode === "error" ? "FAILED" : "COMPLETED"}</span>
                <span className="af-run-timer__value">{formatToolbarRunTimer(runElapsedMs, runMode)}</span>
              </div>
            )}
            {runMode !== "edit" && (
              <button
                type="button"
                className={"af-icon-btn" + (runConsoleOpen ? " af-icon-btn--active" : "")}
                aria-label={t("flow:topbar.executionLog")}
                title={t("flow:topbar.executionLog")}
                onClick={() => setRunConsoleOpen((v) => !v)}
              >
                <span className="material-symbols-outlined">terminal</span>
              </button>
            )}
            {runMode === "edit" && (
              <>
                <button
                  type="button"
                  className={"af-icon-btn" + (rightPanel === "history" ? " af-icon-btn--active" : "")}
                  aria-label={t("flow:topbar.history")}
                  title={t("flow:topbar.history")}
                  disabled={!selected}
                  onClick={openHistoryPanel}
                >
                  <span className="material-symbols-outlined">history</span>
                </button>
                <button
                  type="button"
                  className={"af-icon-btn" + (rightPanel === "settings" ? " af-icon-btn--active" : "")}
                  onClick={openSettingsPanel}
                  aria-label={t("flow:topbar.pipelineSettings")}
                  title={t("flow:topbar.pipelineSettings")}
                  disabled={!selected}
                >
                  <span className="material-symbols-outlined">settings</span>
                </button>
                <button
                  type="button"
                  className={"af-composer-topbar-btn" + (rightPanel === "composer" ? " af-composer-topbar-btn--active" : "") + (composerRunning ? " af-composer-topbar-btn--running" : "")}
                  onClick={openComposerPanel}
                  aria-label="AI Composer"
                  title="AI Composer"
                  disabled={!selected}
                >
                  AI
                </button>
                <button
                  type="button"
                  className={"af-icon-btn af-shortcuts-trigger" + (shortcutsOpen ? " af-icon-btn--active" : "")}
                  onClick={toggleShortcutsPanel}
                  aria-label={t("flow:topbar.shortcutsLabel")}
                  title={t("flow:topbar.shortcutsTitle")}
                  disabled={!selected}
                >
                  <span className="af-shortcuts-trigger__mark" aria-hidden>
                    ?
                  </span>
                </button>
                <button
                  type="button"
                  className="af-icon-btn af-icon-btn--danger"
                  aria-label={t("flow:topbar.deletePipeline")}
                  title={t("flow:topbar.deletePipeline")}
                  disabled={
                    !selected ||
                    isReadonlyBuiltinFlowSource(selected.source) ||
                    (selected.source !== "user" && selected.source !== "workspace")
                  }
                  onClick={() => setDeleteModalOpen(true)}
                >
                  <span className="material-symbols-outlined">delete_forever</span>
                </button>
                <button
                  type="button"
                  className="af-btn-pipeline-archive"
                  disabled={
                    !selected ||
                    isReadonlyBuiltinFlowSource(selected.source) ||
                    selected.archived ||
                    (selected.source !== "user" && selected.source !== "workspace")
                  }
                  onClick={() => setArchiveModalOpen(true)}
                >
                  Archive
                </button>
              </>
            )}
            {runMode === "running" ? (
              <button type="button" className="af-btn-run-stop" onClick={handleStop} title={t("flow:run.pauseRun")}>
                <span className="material-symbols-outlined">pause</span>
                Pause
              </button>
            ) : runMode === "ready" ? (
              <>
                <button
                  type="button"
                  className="af-btn-primary af-btn-primary--lg"
                  disabled={!selected}
                  onClick={() => void handleRun()}
                  title={t("flow:topbar.startRun")}
                >
                  {t("flow:topbar.startRun")}
                </button>
                <button type="button" className="af-btn-pipeline-save" onClick={handleBackToEdit}>
                  <span className="material-symbols-outlined">edit</span>
                  Edit
                </button>
              </>
            ) : runMode === "stopped" ? (
              <>
                <button
                  type="button"
                  className="af-btn-primary af-btn-primary--lg"
                  disabled={!selected}
                  onClick={() => void handleRun({ runUuid: currentRunUuid })}
                  title={
                    currentRunUuid
                      ? t("flow:topbar.resumeTitle", { uuid: currentRunUuid })
                      : t("flow:topbar.resumeTitleNoUuid")
                  }
                >
                  Resume
                </button>
                <button type="button" className="af-btn-pipeline-save" onClick={handleBackToEdit}>
                  <span className="material-symbols-outlined">edit</span>
                  Edit
                </button>
              </>
            ) : runMode === "done" || runMode === "error" ? (
              <>
                <button
                  type="button"
                  className="af-btn-primary af-btn-primary--lg"
                  disabled={!selected}
                  onClick={() => void handleRun()}
                  title={t("flow:topbar.rerunTitle")}
                >
                  Run
                </button>
                <button type="button" className="af-btn-pipeline-save" onClick={handleBackToEdit}>
                  <span className="material-symbols-outlined">edit</span>
                  Edit
                </button>
              </>
            ) : (
              <div className="af-run-btn-group">
                <button type="button" className="af-btn-primary af-btn-primary--lg af-run-btn-main" disabled={!selected} onClick={() => void handleRun()}>
                  Run
                </button>
                <button
                  type="button"
                  className="af-run-btn-dropdown"
                  disabled={!selected}
                  onClick={() => setRunDropdownOpen((v) => !v)}
                  aria-label={t("flow:topbar.runOptions")}
                  aria-expanded={runDropdownOpen}
                >
                  <span className="material-symbols-outlined">arrow_drop_down</span>
                </button>
                {runDropdownOpen && selected && (
                  <div className="af-run-dropdown-menu">
                    <button
                      type="button"
                      className="af-run-dropdown-item"
                      onClick={() => {
                        setRunDropdownOpen(false);
                        // 从 provideNodes 提取当前值作为 draft
                        const draft = {};
                        for (const node of provideNodes) {
                          const slotName = cliInputSlotNames[node.id];
                          if (slotName) {
                            draft[slotName] = cliInputs[slotName]?.value ?? cliInputs[slotName]?.path ?? node.data?.outputs?.[0]?.default ?? "";
                          }
                        }
                        setRunParamsDraft(draft);
                        setRunWithParamsOpen(true);
                      }}
                    >
                      <span className="material-symbols-outlined">edit_note</span>
                      {t("flow:topbar.runWithParams")}
                    </button>
                    <button
                      type="button"
                      className="af-run-dropdown-item"
                      onClick={() => {
                        setRunDropdownOpen(false);
                        void handleRun({ prepareOnly: true });
                      }}
                    >
                      <span className="material-symbols-outlined">tune</span>
                      {t("flow:topbar.editRun")}
                    </button>
                    <div className="af-run-dropdown-divider" />
                    <div className="af-run-dropdown-section">
                      <span className="af-run-dropdown-section-label">{t("flow:topbar.runWithPreset")}</span>
                      <button
                        type="button"
                        className="af-run-dropdown-item"
                        onClick={() => {
                          setRunDropdownOpen(false);
                          void handleRun();
                        }}
                      >
                        <span className="material-symbols-outlined">play_arrow</span>
                        {t("flow:runPreset.default")}
                      </button>
                      {Object.keys(runPresets).map((presetName) => (
                        <button
                          key={presetName}
                          type="button"
                          className="af-run-dropdown-item"
                          onClick={() => {
                            setRunDropdownOpen(false);
                            const presetValues = runPresets[presetName] || {};
                            const cliInputsOverride = {};
                            for (const node of provideNodes) {
                              const slotName = cliInputSlotNames[node.id];
                              if (!slotName) continue;
                              const definitionId = node.data?.definitionId || "";
                              const value = presetValues[node.id] ?? "";
                              if (definitionId.startsWith("provide_file")) {
                                cliInputsOverride[slotName] = { type: "file", path: value };
                              } else {
                                cliInputsOverride[slotName] = { type: "str", value };
                              }
                            }
                            void handleRun({ cliInputsOverride });
                          }}
                        >
                          <span className="material-symbols-outlined">bookmark</span>
                          {presetName}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
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

        <div className={"af-pipeline-body" + (runMode !== "edit" ? " af-pipeline-body--run-mode" : "")}>
          {runMode === "edit" && rightPanel !== "settings" ? (
          <aside className="af-node-palette af-flow-left-panel" id="af-node-palette" aria-label={t("flow:palette2.nodePalette")}>
            {/* 工作区切换区域 - 可展开 */}
            <div className={`af-palette-workspace${workspaceExpanded ? " af-palette-workspace--expanded" : ""}`}>
              <button
                type="button"
                className="af-palette-workspace-head"
                onClick={() => setWorkspaceExpanded((v) => !v)}
                aria-expanded={workspaceExpanded}
              >
                <span className="af-palette-workspace-icon material-symbols-outlined" aria-hidden>
                  folder_open
                </span>
                <span className="af-palette-workspace-label">{t("flow:palette.workspace")}</span>
                <span className="af-palette-workspace-chevron material-symbols-outlined" aria-hidden>
                  {workspaceExpanded ? "expand_less" : "expand_more"}
                </span>
              </button>
              <div className="af-palette-workspace-path" title={selected ? (selected.path || pipelineFiles.path || "") : ""}>
                {selected ? selected.id : t("flow:palette2.noPipelineSelected")}
              </div>

              {/* 展开后的工作区树形结构 */}
              {workspaceExpanded && (
                <div className="af-palette-workspace-tree">
                  {pipelineFilesLoading ? (
                    <div className="af-palette-workspace-loading">{t("flow:palette.loading")}</div>
                  ) : pipelineFiles.error ? (
                    <div className="af-palette-workspace-empty">{pipelineFiles.error}</div>
                  ) : !selected ? (
                    <div className="af-palette-workspace-empty">{t("flow:palette2.noPipelineSelected")}</div>
                  ) : (
                    <>
                      {/* 当前 pipeline 文件列表 */}
                      <div className="af-palette-workspace-group">
                        <div className="af-palette-workspace-group-head">
                          <span className="material-symbols-outlined" aria-hidden>folder</span>
                          <span>{selected.id}</span>
                          <span className="af-palette-workspace-count">({pipelineFiles.files.length})</span>
                        </div>
                        {pipelineFiles.files.length > 0 ? (
                          <ul className="af-palette-workspace-list">
                            {pipelineFiles.files.filter((f) => f.type === "file").map((file) => (
                              <li
                                key={file.path}
                                className="af-palette-workspace-item af-palette-workspace-item--clickable"
                                title={file.path}
                                onClick={() => setFileEditModal({ filePath: file.path, fileName: file.name })}
                              >
                                <span className="material-symbols-outlined af-palette-workspace-item-icon" aria-hidden>
                                  {file.icon}
                                </span>
                                <span className="af-palette-workspace-item-label">{file.name}</span>
                                {file.size != null && (
                                  <span className="af-palette-workspace-item-size">
                                    {file.size < 1024 ? `${file.size}B` : file.size < 1024 * 1024 ? `${(file.size / 1024).toFixed(1)}KB` : `${(file.size / 1024 / 1024).toFixed(1)}MB`}
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        ) : pipelineFiles.files.filter((f) => f.type === "directory").length === 0 ? (
                          <div className="af-palette-workspace-empty">暂无文件</div>
                        ) : null}
                      </div>

                      {/* 子目录展开 */}
                      {pipelineFiles.files.filter((f) => f.type === "directory" && f.children?.length > 0).map((dir) => (
                        <div key={dir.path} className="af-palette-workspace-group af-palette-workspace-group--sub">
                          <div className="af-palette-workspace-group-head">
                            <span className="material-symbols-outlined" aria-hidden>{dir.icon}</span>
                            <span>{dir.name}/</span>
                            <span className="af-palette-workspace-count">({dir.children.length})</span>
                          </div>
                          <ul className="af-palette-workspace-list">
                            {dir.children.map((child) => (
                              <li
                                key={child.path}
                                className={`af-palette-workspace-item${child.type === "file" ? " af-palette-workspace-item--clickable" : ""}`}
                                title={child.path}
                                onClick={child.type === "file" ? () => setFileEditModal({ filePath: child.path, fileName: child.name }) : undefined}
                              >
                                <span className="material-symbols-outlined af-palette-workspace-item-icon" aria-hidden>
                                  {child.icon}
                                </span>
                                <span className="af-palette-workspace-item-label">{child.name}</span>
                                {child.type === "file" && child.size != null && (
                                  <span className="af-palette-workspace-item-size">
                                    {child.size < 1024 ? `${child.size}B` : child.size < 1024 * 1024 ? `${(child.size / 1024).toFixed(1)}KB` : `${(child.size / 1024 / 1024).toFixed(1)}MB`}
                                  </span>
                                )}
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="af-node-palette-head">
              <h2 className="af-node-palette-title">
                <span>Palette</span>
                <span className="af-node-palette-title-kbd" aria-label="快捷键 A">A</span>
              </h2>
              <label className="af-palette-search-wrap">
                <span className="af-visually-hidden">{paletteMode === "flows" ? "搜索流程片段" : t("flow:palette.searchNodes")}</span>
                <span className="af-palette-search-icon material-symbols-outlined" aria-hidden>
                  search
                </span>
                <input
                  ref={paletteSearchInputRef}
                  type="search"
                  className="af-palette-search-input"
                  value={paletteSearch}
                  onChange={(e) => setPaletteSearch(e.target.value)}
                  placeholder={(paletteMode === "flows" ? "搜索流程片段" : t("flow:palette.searchNodes")) + "…"}
                  aria-label={paletteMode === "flows" ? "搜索流程片段" : t("flow:palette.searchNodes")}
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
            {listError ? <p className="af-err af-palette-list-err">{listError}</p> : null}
            <div className="af-node-palette-scroll">
              {paletteMode === "flows" ? (
                <>
                  <section className="af-palette-section af-flow-palette-section--snippets">
                    <div className="af-flow-snippet-actions">
                      <button
                        type="button"
                        className="af-flow-snippet-publish-btn"
                        onClick={openPublishSnippetDialog}
                        disabled={!selected || selectedCanvasNodes.length < 2}
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
                    <p className="af-palette-empty">正在加载流程片段…</p>
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
                              onClick={() => insertFlowSnippet(snippet)}
                              draggable={!!selected}
                              onDragStart={(e) => {
                                e.dataTransfer.setData("application/agentflow-snippet", key);
                                e.dataTransfer.effectAllowed = "move";
                              }}
                              disabled={!selected}
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
                      {paletteSearch.trim() ? "无匹配流程片段" : "暂无流程片段。选择多个节点后发布。"}
                    </p>
                  )}
                </>
              ) : (
              <>
              {PALETTE_ORDER.filter((cat) => filteredGroupedPalette[cat].length > 0).map((cat) => (
                <section key={cat} className={`af-palette-section af-flow-palette-section--${cat}`}>
                  <h3 className="af-palette-cat">{cat}</h3>
                  <div className="af-palette-cards">
                    {filteredGroupedPalette[cat].map((n) => {
                      const inputs = paletteSlotsPreview(n.inputs, "input");
                      const outputs = paletteSlotsPreview(n.outputs, "output");
                      const isLoadSkillsNode = n.id === "control_load_skills";
                      const desc = isLoadSkillsNode
                        ? "从当前 Skills collection 或上游上下文自动注入 Skills，通常无需手填参数。"
                        : paletteDescription(n);
                      const displayLabel = paletteDisplayLabel(n);
                      return (
                        <button
                          key={n.id}
                          type="button"
                          className="af-palette-card"
                          onClick={() => addNodeFromPalette(n)}
                          draggable={!!selected}
                          onDragStart={(e) => {
                            e.dataTransfer.setData("application/agentflow-node", n.id);
                            e.dataTransfer.effectAllowed = "move";
                          }}
                          disabled={!selected}
                          title={desc || n.id}
                        >
                          <span className="af-palette-card-head">
                            <span className="af-palette-card-icon" aria-hidden>
                              <span className="material-symbols-outlined">{paletteIcon(cat)}</span>
                            </span>
                            <span className="af-palette-card-main">
                              <span className="af-palette-card-label">{displayLabel}</span>
                              {displayLabel !== n.id ? <span className="af-palette-card-id">{n.id}</span> : null}
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
              ))}
              {selected && palette.length === 0 ? (
                <p className="af-palette-empty">{t("flow:palette.noComponents")}</p>
              ) : null}
              {selected && palette.length > 0 && paletteSearch.trim() && filteredPaletteCount === 0 ? (
                <p className="af-palette-empty">{t("flow:palette.noMatch")}</p>
              ) : null}
              {!selected ? (
                <p className="af-palette-empty">{t("flow:palette.selectPipeline")}</p>
              ) : null}
              </>
              )}
            </div>

            <footer className="af-palette-engine">
              <div className="af-palette-engine-head">
                <span className={"af-palette-engine-dot" + (engineOnline ? "" : " af-palette-engine-dot--offline")} aria-hidden />
                <span className="af-palette-engine-label">{engineOnline ? t("common:engine.online") : t("common:engine.offline")}</span>
              </div>
              {saveStatus ? (
                <div
                  className={"af-palette-tip" + paletteTipMods}
                  role="status"
                  aria-live="polite"
                >
                  {saveStatus}
                </div>
              ) : null}
            </footer>
          </aside>
          ) : runMode !== "edit" && selected ? (
            <RunConfigPanel
              flowId={selected.id}
              flowSource={selected.source || "user"}
              flowArchived={selected.archived}
              provideNodes={provideNodes}
              edges={edges}
              nodes={nodes}
              onCliInputsChange={setCliInputs}
              onBackToEdit={handleBackToEdit}
            />
          ) : null}

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
                      disabled={slotWarningsRefreshing}
                      aria-label={t("flow:validation.reloadFromServer")}
                      title={t("flow:validation.reloadFromServerShort")}
                      onClick={() => void handleSlotWarningsRefresh()}
                    >
                      <span className="material-symbols-outlined" aria-hidden>
                        refresh
                      </span>
                    </button>
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
                <button
                  type="button"
                  className="af-flow-slot-warnings-kbd-hint"
                  onClick={toggleShortcutsPanel}
                  title={t("flow:validation.shortcutHint")}
                >
                  <kbd>?</kbd> {t("flow:validation.shortcutHintLabel")}
                </button>
                <div className="af-flow-slot-warnings-collapsed-actions">
                  <button
                    type="button"
                    className="af-flow-slot-warnings-collapsed-btn"
                    onClick={() => setSlotWarningsBannerDismissed(false)}
                  >
                    {t("flow:validation.show")}
                  </button>
                  <button
                    type="button"
                    className="af-flow-slot-warnings-collapsed-btn"
                    disabled={slotWarningsRefreshing}
                    onClick={() => void handleSlotWarningsRefresh()}
                  >
                    {t("common:common.refresh")}
                  </button>
                </div>
              </div>
            ) : null}
            {rightPanel === "settings" && selected && runMode === "edit" ? (
              renderPipelineSettingsPage()
            ) : (
            <div className="af-react-flow-wrap af-pipeline-flow">
              {selected ? (
                <>
                <FlowBoard
                  fitViewEpoch={fitViewEpoch}
                  canvasTool={canvasTool}
                  nodes={runNodes}
                  edges={runEdges}
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
                  bottomSlot={
                    runMode === "edit" ? (
                    <div className="af-bottom-composer-stack af-flow-bottom-composer">
                    <div className="af-pipeline-composer-inner">
                <div className="af-composer-selected" aria-label={t("flow:composer.selectedNodesAriaLabel")}>
                  {composerStripEntries.length === 0 ? (
                    <span className="af-composer-selected-empty">
                      {t("flow:composer.selectedNodesEmpty")}
                    </span>
                  ) : (
                    composerStripEntries.map((entry, idx) => {
                      if (entry.kind === "definition") {
                        const d = entry.definition;
                        const label = String(d.label ?? d.id);
                        const tip = [d.id, d.description ? String(d.description).slice(0, 120) : ""]
                          .filter(Boolean)
                          .join(" — ");
                        return (
                          <div key={`def-${d.id}`} className="af-composer-node-chip af-composer-node-chip--definition" title={tip}>
                            <span className="af-composer-node-chip-label">{label}</span>
                            <button
                              type="button"
                              className="af-composer-node-chip-dismiss"
                              onClick={() => dismissComposerStripTag(entry)}
                              aria-label={t("flow:composer.removeFromInput", { id: d.id })}
                            >
                              <span className="material-symbols-outlined">close</span>
                            </button>
                          </div>
                        );
                      }
                      const n = entry.node;
                      const kind = entry.kind;
                      const label = String(n.data?.label ?? n.id);
                      const defId = n.data?.definitionId ? String(n.data.definitionId) : "";
                      const tip =
                        defId && defId !== label ? `${label} · ${n.id} · ${defId}` : `${label} · ${n.id}`;
                      const dismissLabel =
                        kind === "canvas" ? t("flow:composer.deselectNode", { id: n.id }) : t("flow:composer.removeFromInput", { id: n.id });
                      return (
                        <div
                          key={n.id}
                          className={
                            "af-composer-node-chip" +
                            (kind === "mention" ? " af-composer-node-chip--mention" : "")
                          }
                          title={tip}
                        >
                          <span className="af-composer-node-chip-label">{label}</span>
                          <button
                            type="button"
                            className="af-composer-node-chip-dismiss"
                            onClick={() => dismissComposerStripTag(entry)}
                            aria-label={dismissLabel}
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
                      ref={composerInputRef}
                      className="af-composer-textarea"
                      placeholder={t("flow:composer.inputPlaceholder")}
                      disabled={!selected}
                      value={composerText}
                      rows={2}
                      onChange={(e) => {
                        setComposerText(e.target.value);
                        setComposerCursor(e.target.selectionStart ?? e.target.value.length);
                      }}
                      onSelect={(e) => {
                        const t = e.target;
                        if (t instanceof HTMLTextAreaElement) setComposerCursor(t.selectionStart ?? 0);
                      }}
                      onKeyDown={(e) => {
                        if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                          e.preventDefault();
                          void submitComposer();
                          return;
                        }
                        if (
                          mentionDraft &&
                          mentionMenuFlat.length > 0 &&
                          (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "Enter")
                        ) {
                          if (e.key === "ArrowDown") {
                            e.preventDefault();
                            setMentionHighlight((h) => (h + 1) % mentionMenuFlat.length);
                          } else if (e.key === "ArrowUp") {
                            e.preventDefault();
                            setMentionHighlight((h) => (h - 1 + mentionMenuFlat.length) % mentionMenuFlat.length);
                          } else if (e.key === "Enter") {
                            e.preventDefault();
                            const pick = mentionMenuFlat[mentionHighlight];
                            if (pick) insertMentionPick(pick.id);
                          }
                        }
                      }}
                      onKeyUp={(e) => {
                        const t = e.target;
                        if (t instanceof HTMLTextAreaElement) setComposerCursor(t.selectionStart ?? t.value.length);
                      }}
                      onClick={(e) => {
                        const t = e.target;
                        if (t instanceof HTMLTextAreaElement) setComposerCursor(t.selectionStart ?? 0);
                      }}
                      aria-label={t("flow:composer.inputAriaLabel")}
                      autoComplete="off"
                      spellCheck={false}
                    />
                    {mentionDraft && selected && mentionMenuFlat.length > 0 ? (
                      <ul className="af-composer-mention-menu" role="listbox" aria-label={t("flow:composer.mentionAriaLabel")}>
                        {mentionMenuSections.instances.length > 0 ? (
                          <li className="af-composer-mention-section" role="presentation">
                            <div className="af-composer-mention-section-title">Instances</div>
                          </li>
                        ) : null}
                        {mentionMenuSections.instances.map((pick, i) => {
                          const flatIdx = i;
                          return (
                            <li key={`i-${pick.id}`} role="option" aria-selected={flatIdx === mentionHighlight}>
                              <button
                                type="button"
                                className={
                                  "af-composer-mention-item" +
                                  (flatIdx === mentionHighlight ? " af-composer-mention-item--active" : "")
                                }
                                onMouseDown={(e) => e.preventDefault()}
                                onMouseEnter={() => setMentionHighlight(flatIdx)}
                                onClick={() => insertMentionPick(pick.id)}
                              >
                                <span className="af-composer-mention-id">{pick.title}</span>
                                {pick.subtitle ? (
                                  <span className="af-composer-mention-sub">{pick.subtitle}</span>
                                ) : null}
                              </button>
                            </li>
                          );
                        })}
                        {mentionMenuSections.definitions.length > 0 ? (
                          <li className="af-composer-mention-section" role="presentation">
                            <div className="af-composer-mention-section-title">Node</div>
                          </li>
                        ) : null}
                        {mentionMenuSections.definitions.map((pick, i) => {
                          const flatIdx = mentionMenuSections.instances.length + i;
                          return (
                            <li key={`d-${pick.id}`} role="option" aria-selected={flatIdx === mentionHighlight}>
                              <button
                                type="button"
                                className={
                                  "af-composer-mention-item" +
                                  (flatIdx === mentionHighlight ? " af-composer-mention-item--active" : "")
                                }
                                onMouseDown={(e) => e.preventDefault()}
                                onMouseEnter={() => setMentionHighlight(flatIdx)}
                                onClick={() => insertMentionPick(pick.id)}
                              >
                                <span className="af-composer-mention-id">{pick.title}</span>
                                {pick.subtitle ? (
                                  <span className="af-composer-mention-sub">{pick.subtitle}</span>
                                ) : null}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    ) : null}
                  </div>
                  <div className="af-composer-toolbar">
                    {composerSessions.length > 0 && (
                      <label className="af-composer-session-field">
                        <select
                          className="af-composer-session-select"
                          value={activeSessionId || ""}
                          onChange={(e) => {
                            if (e.target.value === "__new__") {
                              createComposerSession();
                            } else {
                              activateComposerSession(e.target.value);
                            }
                          }}
                          disabled={composerRunning}
                          aria-label={t("flow:composer.switchConversation")}
                        >
                          {composerSessions.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.label}{s.running ? " ⏳" : ""}
                            </option>
                          ))}
                          <option value="__new__">＋ {t("flow:composer.newConversation")}</option>
                        </select>
                      </label>
                    )}
                    <div className="af-composer-skills-field">
                      <button
                        ref={composerSkillsButtonRef}
                        type="button"
                        className={
                          "af-composer-skills-button" +
                          (composerSelectedSkillCount > 0 ? " af-composer-skills-button--active" : "")
                        }
                        disabled={!selected || composerRunning}
                        aria-haspopup="listbox"
                        aria-expanded={composerSkillsOpen}
                        onClick={() => setComposerSkillsOpen((v) => !v)}
                      >
                        <span className="material-symbols-outlined" aria-hidden>extension</span>
                        <span>{composerSelectedSkillCount > 0 ? `Skills ${composerSelectedSkillCount}` : "Skills"}</span>
                      </button>
                      {composerSkillsOpen && !composerRunning
                        ? createPortal(
                            <div
                              ref={composerSkillsMenuRef}
                              className="af-composer-skills-menu"
                              role="listbox"
                              aria-label="Composer skills"
                              style={composerSkillsMenuStyle}
                            >
                              {composerSkills.length === 0 ? (
                                <div className="af-composer-skills-empty">No skills found</div>
                              ) : (
                                <>
                                  {composerCollectionGroups.groups.map((group) => {
                                    const keys = collectionSkillKeys(group, composerSkills);
                                    const state = collectionSelectionState(group, composerSelectedSkillSet, composerSkills);
                                    const collapsed = composerCollapsedSkillCollections.has(group.id);
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
                                                setComposerSelectedSkills((prev) => checked ? addSkillKeys(prev, keys) : removeSkillKeys(prev, keys));
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
                                              setComposerCollapsedSkillCollections((prev) => {
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
                                                checked={composerSelectedSkillSet.has(skill.key)}
                                                onChange={(e) => {
                                                  const checked = e.target.checked;
                                                  setComposerSelectedSkills((prev) => {
                                                    if (checked) return prev.includes(skill.key) ? prev : [...prev, skill.key];
                                                    return prev.filter((k) => k !== skill.key);
                                                  });
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
                                  {composerCollectionGroups.ungrouped.length > 0 ? (
                                    <div className="af-composer-skill-group">
                                      <div className="af-composer-skill-group-title">
                                        <span>Ungrouped</span>
                                        <span>{composerCollectionGroups.ungrouped.length}</span>
                                      </div>
                                      {composerCollectionGroups.ungrouped.map((skill) => (
                                        <label key={`ungrouped:${skill.key}`} className="af-composer-skill-option">
                                          <input
                                            type="checkbox"
                                            checked={composerSelectedSkillSet.has(skill.key)}
                                            onChange={(e) => {
                                              const checked = e.target.checked;
                                              setComposerSelectedSkills((prev) => checked
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
                      <span className="af-visually-hidden">{t("flow:composer.modelLabel")}</span>
                      <select
                        className="af-composer-model-select"
                        value={(() => {
                          const dm = (composerModel || "").trim();
                          if (!dm) return "";
                          if (composerModelSelect.currentNotInLists) return composerModelSelect.currentNotInLists;
                          return normalizeComposerModelValue(
                            composerModel,
                            composerModelSelect.cursorList,
                            composerModelSelect.opencodeList,
                            composerModelSelect.claudeCodeList,
                          );
                        })()}
                        onChange={(e) => setComposerModel(e.target.value)}
                        disabled={!selected || composerRunning}
                        aria-label={t("flow:composer.modelAriaLabel")}
                      >
                        <option value="">{t("flow:composer.modelDefault")}</option>
                        {composerModelSelect.currentNotInLists ? (
                          <option value={composerModelSelect.currentNotInLists}>
                            {composerModelSelect.currentNotInLists}{t("flow:composer.modelNotInList")}
                          </option>
                        ) : null}
                        {composerModelSelect.cursorList.length > 0 ? (
                          <optgroup label="Cursor">
                            {composerModelSelect.cursorList.map((m) => (
                              <option key={`composer-c-${m}`} value={modelEntryId(m)}>
                                {m}
                              </option>
                            ))}
                          </optgroup>
                        ) : null}
                        {composerModelSelect.opencodeList.length > 0 ? (
                          <optgroup label="OpenCode">
                            {composerModelSelect.opencodeList.map((m) => (
                              <option key={`composer-o-${m}`} value={`opencode:${modelEntryId(m)}`}>
                                {m}
                              </option>
                            ))}
                          </optgroup>
                        ) : null}
                        {composerModelSelect.claudeCodeList.length > 0 ? (
                          <optgroup label="Claude Code">
                            {composerModelSelect.claudeCodeList.map((m) => (
                              <option key={`composer-cc-${m}`} value={`claude-code:${modelEntryId(m)}`}>
                                {m}
                              </option>
                            ))}
                          </optgroup>
                        ) : null}
                      </select>
                    </label>
                    <button
                      type="button"
                      className={
                        "af-composer-send" +
                        (selected && composerText.trim() && !composerRunning ? " af-composer-send--active" : "") +
                        (composerRunning ? " af-composer-send--stop" : "")
                      }
                      disabled={!selected || (!composerRunning && !composerText.trim())}
                      aria-label={composerRunning ? t("flow:composer.stopGeneration") : t("flow:composer.send")}
                      title={composerRunning ? t("flow:composer.stopGeneration") : undefined}
                      onClick={() => {
                        if (composerRunning) {
                          composerAbortRef.current?.abort();
                          return;
                        }
                        void submitComposer();
                      }}
                    >
                      <span className="material-symbols-outlined" aria-hidden>
                        {composerRunning ? "stop" : "arrow_upward"}
                      </span>
                    </button>
                  </div>
                </div>
                {composerExpanded
                  ? createPortal(
                      <div
                        className="af-node-props-expand-overlay af-composer-thread-dialog-overlay"
                        role="dialog"
                        aria-modal="true"
                        aria-label={t("flow:composer.conversationOutput")}
                        onMouseDown={(e) => {
                          if (e.target === e.currentTarget) setComposerExpanded(false);
                        }}
                      >
                        <div className="af-node-props-expand-panel af-composer-thread-dialog-panel">
                          <div className="af-node-props-expand-head af-composer-thread-dialog-head">
                            <div className="af-composer-thread-dialog-head-main">
                              <span className="af-node-props-expand-title">{t("flow:nodeProps.conversationOutput")}</span>
                              <div
                                className={
                                  "af-composer-thread-dialog-status" +
                                  (composerRunning ? " af-composer-thread-dialog-status--running" : "")
                                }
                                role="status"
                                aria-live="polite"
                                title={composerStatusLine || undefined}
                              >
                                {composerRunning && !composerStatusLine ? t("flow:composer.executing") : composerStatusLine || t("flow:composer.ready")}
                              </div>
                            </div>
                            <button
                              type="button"
                              className="af-icon-btn"
                              onClick={() => setComposerExpanded(false)}
                              aria-label={t("flow:composer.collapseAriaLabel")}
                            >
                              <span className="material-symbols-outlined">close</span>
                            </button>
                          </div>
                          {composerSteps.length > 1 &&
                          !(
                            composerPhaseContext &&
                            Array.isArray(composerPhaseContext.phases) &&
                            composerPhaseContext.phases.length > 1
                          ) ? (
                            <div className="af-composer-steps-track-wrap">
                              <ComposerStepsTrack steps={composerSteps} />
                            </div>
                          ) : null}
                          {composerPhaseContext && Array.isArray(composerPhaseContext.phases) && composerPhaseContext.phases.length > 1 ? (
                            <div className="af-composer-phase-bar" aria-label={t("flow:composer.phaseProgress")}>
                              {composerPhaseContext.phases.map((p, i) => {
                                const status = p.status
                                  || (i < (composerPhaseContext.currentPhase ?? 0) ? "done"
                                    : i === (composerPhaseContext.currentPhase ?? 0) ? (composerRunning ? "running" : (composerPhaseContext.nextPhase ? "done" : (composerPhaseContext.isLastPhase ? "done" : "running")))
                                    : "pending");
                                return (
                                  <div
                                    key={p.name || i}
                                    className={
                                      "af-composer-phase-item"
                                      + (status === "done" ? " af-composer-phase-item--done" : "")
                                      + (status === "running" ? " af-composer-phase-item--running" : "")
                                      + (status === "pending" ? " af-composer-phase-item--pending" : "")
                                    }
                                    title={`${p.label}${p.description ? "：" + p.description : ""}`}
                                  >
                                    <span className="af-composer-phase-dot" aria-hidden>
                                      {status === "done" ? (
                                        <span className="material-symbols-outlined" style={{ fontSize: "0.85rem" }}>check</span>
                                      ) : (
                                        <span>{i + 1}</span>
                                      )}
                                    </span>
                                    <span className="af-composer-phase-label">{p.label}</span>
                                  </div>
                                );
                              })}
                            </div>
                          ) : null}
                          <div className="af-composer-thread-dialog-scroll">
                            <ComposerThreadContent
                              thread={composerThread}
                              liveSegments={composerNaturalSegments}
                              running={composerRunning}
                            />
                          </div>
                          {composerPhaseContext && !composerPhaseContext.isLastPhase && composerPhaseContext.nextPhase && !composerRunning ? (
                            <div className="af-composer-phase-review af-composer-phase-review--minimal" aria-label={t("flow:composer.phaseReviewLabel")}>
                              <span className="af-composer-phase-auto-hint">
                                {t("flow:composer.phaseReviewHint", { nextPhase: composerPhaseContext.nextPhase.label })}
                              </span>
                              <div className="af-composer-phase-review-buttons">
                                <button
                                  type="button"
                                  className="af-composer-phase-btn af-composer-phase-btn--continue"
                                  onClick={continueNextPhase}
                                >
                                  {t("flow:composer.phaseReviewContinue", { label: composerPhaseContext.nextPhase.label })}
                                </button>
                                <button
                                  type="button"
                                  className="af-composer-phase-btn af-composer-phase-btn--skip"
                                  onClick={skipRemainingPhases}
                                >
                                  {t("flow:composer.phaseReviewSkip")}
                                </button>
                              </div>
                            </div>
                          ) : null}
                        </div>
                      </div>,
                      document.body,
                    )
                  : null}
                    </div>
                    </div>
                    ) : null
                  }
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
            )}
          </div>

        {runMode !== "edit" && runConsoleOpen && (
          <div
            className="af-run-console"
            style={{ height: runConsoleHeightPx }}
          >
            <div
              className="af-run-console__resize"
              role="separator"
              aria-orientation="horizontal"
              aria-label={t("flow:run.resizeConsole")}
              onPointerDown={onRunConsoleResizePointerDown}
              onPointerMove={onRunConsoleResizePointerMove}
              onPointerUp={onRunConsoleResizePointerUp}
              onPointerCancel={onRunConsoleResizePointerUp}
              onLostPointerCapture={onRunConsoleResizeLostCapture}
            />
            <div className="af-run-console__head">
              <span className="af-run-console__title">
                <span className="material-symbols-outlined" aria-hidden>terminal</span>
                EXECUTION CONSOLE
              </span>
              <div className="af-run-console__head-right">
                {runMode === "running" && <span className="af-run-console__live-badge">LIVE</span>}
                <button
                  type="button"
                  className="af-icon-btn af-run-console__close"
                  onClick={() => setRunConsoleOpen(false)}
                  aria-label={t("flow:run.closeLog")}
                >
                  <span className="material-symbols-outlined">expand_more</span>
                </button>
              </div>
            </div>
            <div className="af-run-console__body">
              {runLogs.map((log, i) => (
                <div
                  key={i}
                  className={
                    "af-run-console__line" +
                    (log.type === "error" ? " af-run-console__line--error" : "") +
                    (log.type === "warn" ? " af-run-console__line--warn" : "") +
                    (log.type === "node-start" ? " af-run-console__line--start" : "") +
                    (log.type === "node-done" ? " af-run-console__line--done" : "") +
                    (log.type === "node-failed" ? " af-run-console__line--error" : "") +
                    (log.type === "done" ? " af-run-console__line--done" : "")
                  }
                >
                  <span className="af-run-console__ts">
                    [{log.ts ? new Date(log.ts).toLocaleTimeString() : "--:--:--"}]
                  </span>
                  <span className="af-run-console__text">{log.text != null ? String(log.text) : ""}</span>
                </div>
              ))}
              <div ref={runLogEndRef} />
            </div>
          </div>
        )}
          </div>

          {runMode !== "edit" && runContextNodeId && selected ? (
            <RunNodeContextPanel
              instanceId={runContextNodeId}
              flowId={selected.id}
              runId={currentRunUuid}
              nodeStatus={nodeRunStatus[runContextNodeId]?.status ?? null}
              onClose={() => setRunContextNodeId(null)}
            />
          ) : null}

          {rightPanel && rightPanel !== "settings" && selected && runMode === "edit" ? (
            <aside
              className={"af-pipeline-drawer" + (rightPanel === "node" ? " af-pipeline-drawer--wide" : "") + (rightPanel === "composer" ? " af-pipeline-drawer--wide" : "")}
              aria-label={
                rightPanel === "settings" ? t("flow:settings.title") : rightPanel === "history" ? t("flow:history.title") : rightPanel === "composer" ? "AI Composer" : t("flow:nodeProps.title")
              }
            >
              {rightPanel === "composer" ? (
                <div className="af-composer-sidebar">
                  <div className="af-pipeline-drawer-head">
                    <h2 className="af-pipeline-drawer-title">AI Composer</h2>
                    <button
                      type="button"
                      className="af-pipeline-drawer-close af-icon-btn"
                      onClick={closeRightPanel}
                      aria-label={t("flow:composer.closeSidebar")}
                    >
                      <span className="material-symbols-outlined">close</span>
                    </button>
                  </div>
                  {/* Session Tabs */}
                  {composerSessions.length > 0 && (
                    <div className="af-composer-session-tabs">
                      {composerSessions.map((session) => (
                        <button
                          key={session.id}
                          type="button"
                          ref={(el) => {
                            if (el && session.id === activeSessionId) {
                              el.scrollIntoView({ block: "nearest", inline: "nearest" });
                            }
                          }}
                          className={[
                            "af-composer-session-tab",
                            session.id === activeSessionId ? "af-composer-session-tab--active" : "",
                            session.running ? "af-composer-session-tab--running" : "",
                          ].filter(Boolean).join(" ")}
                          onClick={() => activateComposerSession(session.id)}
                          title={session.label}
                        >
                          <span className="af-composer-session-label">{session.label}</span>
                          <span
                            className="af-composer-session-close"
                            role="button"
                            tabIndex={0}
                            onClick={(e) => {
                              e.stopPropagation();
                              closeComposerSession(session.id);
                            }}
                            onKeyDown={(e) => {
                              if (e.key !== "Enter" && e.key !== " ") return;
                              e.preventDefault();
                              e.stopPropagation();
                              closeComposerSession(session.id);
                            }}
                            title={session.running ? t("flow:composer.endConversation") : t("flow:composer.closeConversation")}
                          >
                            <span className="material-symbols-outlined" style={{ fontSize: "0.75rem" }}>
                              close
                            </span>
                          </span>
                        </button>
                      ))}
                      <button
                        type="button"
                        className="af-composer-session-add"
                        onClick={() => createComposerSession()}
                        title={t("flow:composer.newConversation")}
                      >
                        <span className="material-symbols-outlined">add</span>
                      </button>
                    </div>
                  )}
                  {/* Status */}
                  <div
                    className={
                      "af-composer-sidebar-status" +
                      (composerRunning ? " af-composer-sidebar-status--running" : "")
                    }
                    role="status"
                    aria-live="polite"
                  >
                    {composerRunning && !composerStatusLine ? t("flow:composer.executing") : composerStatusLine || t("flow:composer.ready")}
                  </div>
                  {/* Phase progress bar */}
                  {composerPhaseContext && Array.isArray(composerPhaseContext.phases) && composerPhaseContext.phases.length > 1 ? (
                    <div className="af-composer-phase-bar" aria-label={t("flow:composer.phaseProgress")}>
                      {composerPhaseContext.phases.map((p, i) => {
                        const status = p.status
                          || (i < (composerPhaseContext.currentPhase ?? 0) ? "done"
                            : i === (composerPhaseContext.currentPhase ?? 0) ? (composerRunning ? "running" : (composerPhaseContext.isLastPhase && i === composerPhaseContext.phases.length - 1 ? "done" : (composerPhaseContext.nextPhase ? "done" : "running")))
                            : "pending");
                        return (
                          <div
                            key={p.name || i}
                            className={
                              "af-composer-phase-item"
                              + (status === "done" ? " af-composer-phase-item--done" : "")
                              + (status === "running" ? " af-composer-phase-item--running" : "")
                              + (status === "pending" ? " af-composer-phase-item--pending" : "")
                            }
                            title={`${p.label}${p.description ? "：" + p.description : ""}`}
                          >
                            <span className="af-composer-phase-dot" aria-hidden>
                              {status === "done" ? (
                                <span className="material-symbols-outlined" style={{ fontSize: "0.85rem" }}>check</span>
                              ) : (
                                <span>{i + 1}</span>
                              )}
                            </span>
                            <span className="af-composer-phase-label">{p.label}</span>
                          </div>
                        );
                      })}
                    </div>
                  ) : null}
                  {/* Thread content */}
                  <div className="af-composer-sidebar-thread" ref={composerSidebarThreadRef}>
                    <ComposerThreadContent
                      thread={composerThread}
                      liveSegments={composerNaturalSegments}
                      running={composerRunning}
                    />
                  </div>
                  {/* Phase continue/skip review controls */}
                  {composerPhaseContext && !composerPhaseContext.isLastPhase && composerPhaseContext.nextPhase && !composerRunning ? (
                    <div className="af-composer-phase-review af-composer-phase-review--minimal" aria-label={t("flow:composer.phaseReviewLabel")}>
                      <span className="af-composer-phase-auto-hint">
                        {t("flow:composer.phaseReviewHint", { nextPhase: composerPhaseContext.nextPhase.label })}
                      </span>
                      <div className="af-composer-phase-review-buttons">
                        <button
                          type="button"
                          className="af-composer-phase-btn af-composer-phase-btn--continue"
                          onClick={continueNextPhase}
                        >
                          {t("flow:composer.phaseReviewContinue", { label: composerPhaseContext.nextPhase.label })}
                        </button>
                        <button
                          type="button"
                          className="af-composer-phase-btn af-composer-phase-btn--skip"
                          onClick={skipRemainingPhases}
                        >
                          {t("flow:composer.phaseReviewSkip")}
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : rightPanel === "node" && soleSelectedNode ? (
                nodePropDraft ? (
                  <NodePropertiesPanel
                    draft={nodePropDraft}
                    setDraft={setNodePropDraft}
                    definitionId={String(soleSelectedNode.data?.definitionId ?? soleSelectedNode.id)}
                    systemPromptReadonly={String(paletteDefForSoleNode?.description ?? "")}
                    modelLists={modelLists}
                    disabled={!selected}
                    onIdBlur={commitIdRename}
                    onClose={closeRightPanel}
                    onPublishToMarketplace={publishNodeToMarketplace}
                    error={nodePropsError}
                    ioSlots={{
                      inputs: Array.isArray(nodePropDraft?.inputs) ? nodePropDraft.inputs : [],
                      outputs: Array.isArray(nodePropDraft?.outputs) ? nodePropDraft.outputs : [],
                    }}
                  />
                ) : (
                  <div className="af-pipeline-drawer-body">
                    <p className="af-pipeline-drawer-muted">{t("flow:pipeline.loadingProps")}</p>
                  </div>
                )
              ) : (
                <>
                  <div className="af-pipeline-drawer-head">
                    <h2 className="af-pipeline-drawer-title">
                      {rightPanel === "settings" ? t("flow:settings.title") : t("flow:history.title")}
                    </h2>
                    <button
                      type="button"
                      className="af-pipeline-drawer-close af-icon-btn"
                      onClick={closeRightPanel}
                      aria-label={t("flow:composer.closeSidebar")}
                    >
                      <span className="material-symbols-outlined">close</span>
                    </button>
                  </div>

                  <div className="af-pipeline-drawer-body">
                    {rightPanel === "settings" ? (
                      <>
                        <div className="af-pipeline-drawer-field">
                          <span className="af-pipeline-drawer-label">{t("flow:pipeline.pipelineId")}</span>
                          {(selected.source === "user" || selected.source === "workspace") && !selected.archived ? (
                            <div className="af-pipeline-rename-row">
                              <input
                                type="text"
                                className="af-pipeline-rename-input"
                                value={renameFlowId}
                                onChange={(e) => { setRenameFlowId(e.target.value); setRenameFlowError(""); }}
                                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleRenameFlow(); } }}
                                onBlur={() => { if (renameFlowId.trim() && renameFlowId.trim() !== selected.id) handleRenameFlow(); }}
                                placeholder={selected.id}
                                disabled={renameFlowBusy}
                                spellCheck={false}
                              />
                              <span className="af-pipeline-drawer-badge">
                                {flowSourceLabelZh(selected.source ?? "user", t)}
                              </span>
                            </div>
                          ) : (
                            <div className="af-pipeline-drawer-readonly">
                              {selected.id}
                              <span className="af-pipeline-drawer-badge">
                                {flowSourceLabelZh(selected.source ?? "user", t)}
                              </span>
                              {selected.archived ? (
                                <span className="af-pipeline-drawer-badge af-pipeline-drawer-badge--muted">{t("flow:settings.archived")}</span>
                              ) : null}
                            </div>
                          )}
                          {renameFlowError ? <p className="af-err af-pipeline-drawer-err">{renameFlowError}</p> : null}
                        </div>
                        {typeof selected.path === "string" && selected.path ? (
                          <div className="af-pipeline-drawer-field">
                            <span className="af-pipeline-drawer-label">{t("flow:pipeline.diskPath")}</span>
                            <div className="af-pipeline-drawer-readonly af-pipeline-drawer-readonly--mono af-pipeline-path-row">
                              <span className="af-pipeline-path-text">{selected.path}</span>
                              <button
                                type="button"
                                className="af-icon-btn af-pipeline-copy-btn"
                                onClick={() => handleCopyPath(selected.path)}
                                title={t("flow:settings.copyPath")}
                              >
                                <span className="material-symbols-outlined">{pathCopied ? "check" : "content_copy"}</span>
                              </button>
                            </div>
                          </div>
                        ) : null}
                        {(selected.source === "user" || selected.source === "workspace") ? (
                          selected.archived ? (
                            <p className="af-pipeline-drawer-muted">
                              {t("flow:settings.archivedNote")}
                            </p>
                          ) : (
                            <div className="af-pipeline-drawer-field">
                              <span className="af-pipeline-drawer-label">{t("flow:pipeline.storageLocation")}</span>
                              <div className="af-pipeline-move-actions">
                                {selected.source === "user" ? (
                                  <button
                                    type="button"
                                    className="af-btn-secondary"
                                    disabled={moveFlowBusy}
                                    onClick={() => handleMoveFlow("workspace")}
                                  >
                                    {moveFlowBusy ? t("flow:settings.moveBusy") : t("flow:settings.moveToWorkspace")}
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    className="af-btn-secondary"
                                    disabled={moveFlowBusy}
                                    onClick={() => handleMoveFlow("user")}
                                  >
                                    {moveFlowBusy ? t("flow:settings.moveBusy") : t("flow:settings.moveToUserDir")}
                                  </button>
                                )}
                              </div>
                              {moveFlowError ? <p className="af-err af-pipeline-drawer-err">{moveFlowError}</p> : null}
                            </div>
                          )
                        ) : (
                          <p className="af-pipeline-drawer-muted">
                            {t("flow:settings.builtinNote")}
                          </p>
                        )}
                        <label className="af-pipeline-drawer-field">
                          <span className="af-pipeline-drawer-label">{t("flow:pipeline.introduction")}</span>
                          <textarea
                            className="af-pipeline-drawer-textarea"
                            value={flowDescription}
                            onChange={(e) => setFlowDescription(e.target.value)}
                            placeholder={t("flow:pipeline.introductionPlaceholder")}
                            rows={5}
                            spellCheck={false}
                          />
                        </label>
                        <div className="af-pipeline-meta-card">
                          <h3 className="af-pipeline-meta-title">{t("flow:schedule.title")}</h3>
                          {scheduleLoading ? (
                            <p className="af-pipeline-drawer-muted">{t("common:common.loading")}</p>
                          ) : (
                            <>
                              <label className="af-new-pipeline-radio">
                                <input
                                  type="checkbox"
                                  checked={Boolean(scheduleDraft.enabled)}
                                  disabled={scheduleSaving || selected.archived || isReadonlyBuiltinFlowSource(selected.source)}
                                  onChange={(e) =>
                                    updateScheduleDraft((prev) => ({ ...prev, enabled: e.target.checked }))
                                  }
                                />
                                <span>{t("flow:schedule.enabled")}</span>
                              </label>
                              <label className="af-pipeline-drawer-field">
                                <span className="af-pipeline-drawer-label">{t("flow:schedule.cron")}</span>
                                <input
                                  type="text"
                                  className="af-pipeline-rename-input"
                                  value={scheduleDraft.cron || ""}
                                  disabled={scheduleSaving || selected.archived || isReadonlyBuiltinFlowSource(selected.source)}
                                  onChange={(e) =>
                                    updateScheduleDraft((prev) => ({ ...prev, cron: e.target.value }))
                                  }
                                  placeholder="0 9 * * *"
                                  spellCheck={false}
                                />
                              </label>
                              <label className="af-pipeline-drawer-field">
                                <span className="af-pipeline-drawer-label">{t("flow:schedule.timezone")}</span>
                                <input
                                  type="text"
                                  className="af-pipeline-rename-input"
                                  value={scheduleDraft.timezone || ""}
                                  disabled={scheduleSaving || selected.archived || isReadonlyBuiltinFlowSource(selected.source)}
                                  onChange={(e) =>
                                    updateScheduleDraft((prev) => ({ ...prev, timezone: e.target.value }))
                                  }
                                  placeholder="Asia/Shanghai"
                                  spellCheck={false}
                                />
                              </label>
                              <label className="af-pipeline-drawer-field">
                                <span className="af-pipeline-drawer-label">{t("flow:schedule.preset")}</span>
                                <select
                                  className="af-pipeline-flow-select"
                                  value={scheduleDraft.preset || ""}
                                  disabled={scheduleSaving || selected.archived || isReadonlyBuiltinFlowSource(selected.source)}
                                  onChange={(e) =>
                                    updateScheduleDraft((prev) => ({ ...prev, preset: e.target.value }))
                                  }
                                >
                                  <option value="">{t("flow:schedule.defaultPreset")}</option>
                                  {Object.keys(runPresets).map((name) => (
                                    <option key={name} value={name}>{name}</option>
                                  ))}
                                </select>
                              </label>
                              <div className="af-pipeline-drawer-readonly">
                                <span>{t("flow:schedule.overlapSkip")}</span>
                              </div>
                              {scheduleDraft.nextRunAt ? (
                                <p className="af-pipeline-drawer-muted">
                                  {t("flow:schedule.nextRun", {
                                    time: new Date(scheduleDraft.nextRunAt).toLocaleString(),
                                  })}
                                </p>
                              ) : (
                                <p className="af-pipeline-drawer-muted">{t("flow:schedule.noNextRun")}</p>
                              )}
                              <dl className="af-pipeline-meta-dl">
                                <div className="af-pipeline-meta-row">
                                  <dt>{t("flow:schedule.runtime")}</dt>
                                  <dd>
                                    {scheduleRuntimeStatus?.running
                                      ? t("flow:schedule.running")
                                      : scheduleDraft.enabled
                                        ? t("flow:schedule.waiting")
                                        : t("flow:schedule.disabled")}
                                  </dd>
                                </div>
                                {scheduleState.lastTriggeredAt ? (
                                  <div className="af-pipeline-meta-row">
                                    <dt>{t("flow:schedule.lastTriggeredAt")}</dt>
                                    <dd>{new Date(scheduleState.lastTriggeredAt).toLocaleString()}</dd>
                                  </div>
                                ) : null}
                                {scheduleState.lastSkippedAt ? (
                                  <div className="af-pipeline-meta-row">
                                    <dt>{t("flow:schedule.lastSkippedAt")}</dt>
                                    <dd>
                                      {new Date(scheduleState.lastSkippedAt).toLocaleString()}
                                      {scheduleState.lastSkipReason ? ` · ${scheduleState.lastSkipReason}` : ""}
                                    </dd>
                                  </div>
                                ) : null}
                                {scheduleState.lastRunUuid ? (
                                  <div className="af-pipeline-meta-row">
                                    <dt>{t("flow:schedule.lastRun")}</dt>
                                    <dd>{scheduleState.lastRunUuid}</dd>
                                  </div>
                                ) : null}
                                {scheduleState.lastExitCode != null ? (
                                  <div className="af-pipeline-meta-row">
                                    <dt>{t("flow:schedule.lastExit")}</dt>
                                    <dd>{String(scheduleState.lastExitCode)}</dd>
                                  </div>
                                ) : null}
                                {scheduleState.lastFinishedAt ? (
                                  <div className="af-pipeline-meta-row">
                                    <dt>{t("flow:schedule.lastFinishedAt")}</dt>
                                    <dd>{new Date(scheduleState.lastFinishedAt).toLocaleString()}</dd>
                                  </div>
                                ) : null}
                              </dl>
                              {(scheduleRuntimeStatus?.lastError || scheduleState.lastError) ? (
                                <p className="af-err af-pipeline-drawer-err">
                                  {scheduleRuntimeStatus?.lastError || scheduleState.lastError}
                                </p>
                              ) : null}
                              {selected.archived || isReadonlyBuiltinFlowSource(selected.source) ? (
                                <p className="af-pipeline-drawer-muted">{t("flow:schedule.readonlyNote")}</p>
                              ) : null}
                              {scheduleError ? <p className="af-err af-pipeline-drawer-err">{scheduleError}</p> : null}
                              {scheduleStatus ? <p className="af-pipeline-drawer-muted">{scheduleStatus}</p> : null}
                              <button
                                type="button"
                                className="af-btn-secondary"
                                disabled={scheduleSaving || selected.archived || isReadonlyBuiltinFlowSource(selected.source)}
                                onClick={handleSaveSchedule}
                              >
                                {scheduleSaving ? t("flow:schedule.saving") : t("flow:schedule.save")}
                              </button>
                            </>
                          )}
                        </div>
                        <div className="af-pipeline-meta-card">
                          <h3 className="af-pipeline-meta-title">{t("flow:pipeline.metadata")}</h3>
                          <dl className="af-pipeline-meta-dl">
                            <div className="af-pipeline-meta-row">
                              <dt>{t("flow:pipeline.nodeCount")}</dt>
                              <dd>{nodes.length} {t("flow:pipeline.nodesUnit")}</dd>
                            </div>
                          </dl>
                        </div>
                        <button
                          type="button"
                          className="af-pipeline-drawer-link"
                          onClick={() => navigate("/settings")}
                        >
                          {t("flow:settings.globalSettings")}
                        </button>
                      </>
                    ) : (
                      <>
                        <p className="af-pipeline-drawer-lead">
                          {t("flow:settings.currentPipeline")}<strong>{selected.id}</strong>
                        </p>
                        {recentRunsLoading ? (
                          <p className="af-pipeline-drawer-muted">{t("common:common.loading")}</p>
                        ) : recentRunsError ? (
                          <p className="af-err af-pipeline-drawer-err">{recentRunsError}</p>
                        ) : runsForCurrentFlow.length === 0 ? (
                          <p className="af-pipeline-drawer-muted">{t("flow:pipeline.noRuns")}</p>
                        ) : (
                          <>
                            {execHistoryStats.success +
                              execHistoryStats.failed +
                              execHistoryStats.running +
                              execHistoryStats.stopped +
                              execHistoryStats.interrupted >
                            0 ? (
                              <div className="af-exec-history-summary" aria-label={t("flow:history.summary")}>
                                {execHistoryStats.success > 0 ? (
                                  <span className="af-exec-history-pill af-exec-history-pill--success">
                                    {t("flow:history.successCount", { count: execHistoryStats.success })}
                                  </span>
                                ) : null}
                                {execHistoryStats.failed > 0 ? (
                                  <span className="af-exec-history-pill af-exec-history-pill--failed">
                                    {t("flow:history.failedCount", { count: execHistoryStats.failed })}
                                  </span>
                                ) : null}
                                {execHistoryStats.stopped > 0 ? (
                                  <span className="af-exec-history-pill af-exec-history-pill--stopped">
                                    {t("flow:history.stoppedCount", { count: execHistoryStats.stopped })}
                                  </span>
                                ) : null}
                                {execHistoryStats.interrupted > 0 ? (
                                  <span className="af-exec-history-pill af-exec-history-pill--interrupted">
                                    {t("flow:history.interruptedCount", { count: execHistoryStats.interrupted })}
                                  </span>
                                ) : null}
                                {execHistoryStats.running > 0 ? (
                                  <span className="af-exec-history-pill af-exec-history-pill--running">
                                    {t("flow:history.runningCount", { count: execHistoryStats.running })}
                                  </span>
                                ) : null}
                              </div>
                            ) : null}
                            <ul className="af-exec-history-list">
                              {runsForCurrentFlow.map((run, idx) => {
                                const st = run.status || "unknown";
                                const cardMod =
                                  st === "success"
                                    ? "af-exec-history-card--success"
                                    : st === "failed"
                                      ? "af-exec-history-card--failed"
                                      : st === "stopped"
                                        ? "af-exec-history-card--stopped"
                                        : st === "interrupted"
                                          ? "af-exec-history-card--interrupted"
                                          : st === "running"
                                            ? "af-exec-history-card--running"
                                            : "af-exec-history-card--unknown";
                                const statusZh =
                                  st === "success"
                                    ? t("flow:history.success")
                                    : st === "failed"
                                      ? t("flow:history.failed")
                                      : st === "stopped"
                                        ? t("flow:history.stopped")
                                        : st === "interrupted"
                                          ? t("flow:history.interrupted")
                                          : st === "running"
                                            ? t("flow:history.running")
                                            : t("flow:history.unknown");
                                const statusIcon =
                                  st === "success"
                                    ? "check_circle"
                                    : st === "failed"
                                      ? "error"
                                      : st === "stopped"
                                        ? "stop_circle"
                                        : st === "interrupted"
                                          ? "sync_disabled"
                                          : st === "running"
                                            ? "progress_activity"
                                            : "help";
                                const runKey = run.runId || `${run.at}-${idx}`;
                                // runId 为目录名时间戳（如 20260403142712）；取前 6 位会得到同年月的相同前缀，故用后段区分
                                const runLabel =
                                  run.runId != null && run.runId.length >= 6
                                    ? t("flow:history.runLabel", { id: run.runId.length > 8 ? run.runId.slice(-8) : run.runId })
                                    : t("flow:history.runLabel", { id: runsForCurrentFlow.length - idx });
                                return (
                                  <li key={`${selected.id}-${runKey}`} className="af-exec-history-list-item">
                                    <button
                                      type="button"
                                      className={`af-exec-history-card ${cardMod}`}
                                      onClick={() => openRunFromHistory(run)}
                                      title={t("flow:history.enterRunView")}
                                    >
                                      <div className="af-exec-history-card-top">
                                        <span className="af-exec-history-card-title">{runLabel}</span>
                                        <span className="af-exec-history-card-time">{formatRelativeTime(run.at, t)}</span>
                                      </div>
                                      <div className="af-exec-history-card-bottom">
                                        <span className="af-exec-history-card-status">
                                          <span className="material-symbols-outlined" aria-hidden>
                                            {statusIcon}
                                          </span>
                                          {statusZh}
                                        </span>
                                        <span className="af-exec-history-card-duration">
                                          <span className="material-symbols-outlined" aria-hidden>
                                            timer
                                          </span>
                                          {formatDurationMs(run.durationMs, t)}
                                        </span>
                                      </div>
                                    </button>
                                  </li>
                                );
                              })}
                            </ul>
                          </>
                        )}
                      </>
                    )}
                  </div>
                </>
              )}
            </aside>
          ) : null}
        </div>

        <ConfirmModal
          open={stopConfirmOpen}
          title={t("flow:run.pauseTitle", { defaultValue: "暂停运行" })}
          message={t("flow:run.pauseConfirm")}
          confirmLabel={t("flow:run.pauseConfirmOk", { defaultValue: "暂停" })}
          onConfirm={confirmStop}
          onCancel={() => setStopConfirmOpen(false)}
        />
        <ConfirmModal
          open={backPromptOpen}
          title={t("flow:run.backPromptTitle", { defaultValue: "返回项目列表" })}
          message={t("flow:run.backPromptMessage", {
            defaultValue: "流水线仍在运行，请选择处理方式：后台继续运行并退出，或停止后返回编辑。",
          })}
          confirmLabel={t("flow:run.backBackground", { defaultValue: "后台运行并退出" })}
          secondaryLabel={t("flow:run.backStopEdit", { defaultValue: "停止并进入编辑" })}
          secondaryDestructive
          onConfirm={backgroundAndExit}
          onSecondary={stopAndEdit}
          onCancel={() => setBackPromptOpen(false)}
        />
        <KeyboardShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
        {renderMarketplacePreviewDialog()}
        <NodeJumpPalette
          open={jumpPaletteOpen}
          onClose={() => setJumpPaletteOpen(false)}
          onJump={jumpToNodeById}
          nodes={nodes}
        />
        <LogViewer
          open={logViewerOpen}
          onClose={() => setLogViewerOpen(false)}
          flowId={selected?.id ?? ""}
        />
        <ArchivePipelineModal
          open={archiveModalOpen}
          onClose={() => setArchiveModalOpen(false)}
          flowId={selected?.id ?? ""}
          flowSource={selected?.source ?? "user"}
          onArchived={async () => {
            setArchiveModalOpen(false);
            await loadFlowList();
            navigate("/projects?tab=archived");
          }}
        />
        <DeletePipelineModal
          open={deleteModalOpen && Boolean(selected?.id)}
          onClose={() => setDeleteModalOpen(false)}
          flowId={selected?.id ?? ""}
          flowSource={selected?.source ?? "user"}
          flowArchived={Boolean(selected?.archived)}
          onDeleted={async () => {
            setDeleteModalOpen(false);
            setSelected(null);
            setNodes([]);
            setEdges([]);
            setComposerPhaseContext(null);
            await loadFlowList();
            navigate("/projects");
          }}
        />

        {publishSnippetOpen && createPortal(
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
                  aria-label={t("common:common.close")}
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
                    onChange={(e) => {
                      const name = e.target.value;
                      setPublishSnippetDraft((prev) => ({
                        ...prev,
                        name,
                        id: prev.id ? prev.id : name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, ""),
                      }));
                    }}
                    placeholder="例如：PR 检查片段"
                    autoFocus
                  />
                </label>
                <label className="af-flow-snippet-field">
                  <span>ID</span>
                  <input
                    type="text"
                    value={publishSnippetDraft.id}
                    onChange={(e) => setPublishSnippetDraft((prev) => ({ ...prev, id: e.target.value }))}
                    placeholder="pr-check-snippet"
                  />
                </label>
                <label className="af-flow-snippet-field">
                  <span>说明</span>
                  <textarea
                    value={publishSnippetDraft.description}
                    onChange={(e) => setPublishSnippetDraft((prev) => ({ ...prev, description: e.target.value }))}
                    placeholder="这段流程适合什么场景、需要接哪些上下游。"
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
                  {publishSnippetBusy ? "发布中…" : "发布"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

        <FileEditModal
          open={Boolean(fileEditModal)}
          onClose={() => setFileEditModal(null)}
          flowId={selected?.id ?? ""}
          flowSource={selected?.source ?? "user"}
          flowArchived={Boolean(selected?.archived)}
          filePath={fileEditModal?.filePath ?? ""}
          fileName={fileEditModal?.fileName ?? ""}
          onSaved={() => {
            // 刷新文件列表
            setPipelineFiles((prev) => ({ ...prev }));
          }}
        />
      </div>

      {userCheckContent && runMode !== "edit" && createPortal(
        <div className="af-user-check-modal-overlay">
          <div className="af-user-check-modal" role="dialog" aria-modal="true">
            <div className="af-user-check-modal__head">
              <span className="af-user-check-modal__title">
                <span className="material-symbols-outlined" aria-hidden>fact_check</span>
                {t("flow:userCheck.title", { instanceId: userCheckContent.instanceId })}
              </span>
              <div className="af-user-check-modal__actions">
                {userCheckEditing ? (
                  <>
                    <button type="button" className="af-user-check-modal__btn af-user-check-modal__btn--save" onClick={async () => {
                      if (!userCheckContent || !selected || !currentRunUuid) return;
                      const editedContent = userCheckEditedContent || userCheckContent.content;
                      try {
                        const res = await fetch("/api/flow", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ flowId: selected.id, flowSource: selected.source ?? "user", action: "save-user-check-content", runUuid: currentRunUuid, instanceId: userCheckContent.instanceId, content: editedContent }) });
                        if (res.ok) {
                          setUserCheckContent((prev) => prev ? { ...prev, content: editedContent } : prev);
                          setUserCheckEditing(false);
                          setRunLogs((prev) => [...prev, { ts: new Date().toISOString(), type: "info", text: t("flow:userCheck.contentSaved") }]);
                        } else { setRunLogs((prev) => [...prev, { ts: new Date().toISOString(), type: "error", text: t("flow:userCheck.saveFailed") }]); }
                      } catch { setRunLogs((prev) => [...prev, { ts: new Date().toISOString(), type: "error", text: t("flow:userCheck.saveFailed") }]); }
                    }}>
                      <span className="material-symbols-outlined">save</span>
                      {t("flow:userCheck.save")}
                    </button>
                    <button type="button" className="af-user-check-modal__btn" onClick={() => { setUserCheckEditedContent(userCheckContent.content); setUserCheckEditing(false); }}>
                      <span className="material-symbols-outlined">close</span>
                      {t("flow:userCheck.cancel")}
                    </button>
                  </>
                ) : (
                  <>
                    <button type="button" className="af-user-check-modal__btn" onClick={() => setUserCheckEditing(true)}>
                      <span className="material-symbols-outlined">edit</span>
                      {t("flow:userCheck.edit")}
                    </button>
                    <button type="button" className="af-user-check-modal__btn" onClick={() => setUserCheckContent(null)}>
                      <span className="material-symbols-outlined">close</span>
                    </button>
                  </>
                )}
              </div>
            </div>
            <div className="af-user-check-modal__body">
              {userCheckEditing ? (
                <textarea ref={userCheckEditRef} className="af-user-check-modal__textarea" value={userCheckEditedContent || userCheckContent.content} onChange={(e) => setUserCheckEditedContent(e.target.value)} />
              ) : (
                <div className="af-user-check-modal__preview"><pre>{userCheckEditedContent || userCheckContent.content}</pre></div>
              )}
            </div>
            <div className="af-user-check-modal__ai-bar">
              <input
                type="text"
                className="af-user-check-modal__ai-input"
                placeholder={t("flow:userCheck.aiEditPlaceholder")}
                value={userCheckAiPrompt}
                onChange={(e) => setUserCheckAiPrompt(e.target.value)}
                disabled={userCheckAiRunning}
              />
              <button
                type="button"
                className="af-user-check-modal__btn af-user-check-modal__btn--ai"
                disabled={userCheckAiRunning || !userCheckAiPrompt.trim()}
                onClick={() => {
                  if (!userCheckContent || !selected || !currentRunUuid || !userCheckAiPrompt.trim()) return;
                  setUserCheckAiRunning(true);
                  setRunLogs((prev) => [...prev, { ts: new Date().toISOString(), type: "info", text: t("flow:userCheck.aiEditStarted") }]);
                  fetch("/api/flow", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ flowId: selected.id, flowSource: selected.source ?? "user", action: "ai-edit-user-check-content", runUuid: currentRunUuid, instanceId: userCheckContent.instanceId, content: userCheckEditedContent || userCheckContent.content, prompt: userCheckAiPrompt }) })
                    .then((res) => res.json())
                    .then((data) => {
                      setUserCheckAiRunning(false);
                      if (data.ok && data.content) {
                        setUserCheckEditedContent(data.content);
                        setUserCheckEditing(true);
                        setUserCheckAiPrompt("");
                        setRunLogs((prev) => [...prev, { ts: new Date().toISOString(), type: "info", text: t("flow:userCheck.aiEditDone") }]);
                      } else { setRunLogs((prev) => [...prev, { ts: new Date().toISOString(), type: "error", text: data.error || t("flow:userCheck.aiEditFailed") }]); }
                    })
                    .catch(() => { setUserCheckAiRunning(false); setRunLogs((prev) => [...prev, { ts: new Date().toISOString(), type: "error", text: t("flow:userCheck.aiEditFailed") }]); });
                }}
              >
                {userCheckAiRunning ? <span className="material-symbols-outlined af-spin">sync</span> : <span className="material-symbols-outlined">auto_fix_high</span>}
                {t("flow:userCheck.aiEditBtn")}
              </button>
            </div>
            <div className="af-user-check-modal__foot">
              <span className="af-user-check-modal__hint">{t("flow:userCheck.hint")}</span>
              <button type="button" className="af-user-check-modal__btn af-user-check-modal__btn--continue" onClick={async () => {
                if (!userCheckContent || !selected || !currentRunUuid) return;
                // 先保存内容并更新节点状态为 success
                const contentToSave = userCheckEditedContent || userCheckContent.content;
                try {
                  const res = await fetch("/api/flow", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      flowId: selected.id,
                      flowSource: selected.source ?? "user",
                      action: "save-user-check-content",
                      runUuid: currentRunUuid,
                      instanceId: userCheckContent.instanceId,
                      content: contentToSave,
                    }),
                  });
                  if (res.ok) {
                    // 再调用 confirm-user-check 更新节点状态为 success
                    await fetch("/api/flow", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        flowId: selected.id,
                        flowSource: selected.source ?? "user",
                        action: "confirm-user-check",
                        runUuid: currentRunUuid,
                        instanceId: userCheckContent.instanceId,
                        execId: userCheckContent.execId,
                      }),
                    });
                    setUserCheckContent(null);
                    setUserCheckAiPrompt("");
                    void handleRun({ runUuid: currentRunUuid });
                  } else {
                    setRunLogs((prev) => [...prev, { ts: new Date().toISOString(), type: "error", text: t("flow:userCheck.saveFailed") }]);
                  }
                } catch {
                  setRunLogs((prev) => [...prev, { ts: new Date().toISOString(), type: "error", text: t("flow:userCheck.saveFailed") }]);
                }
              }}>
                <span className="material-symbols-outlined">play_arrow</span>
                {t("flow:userCheck.continue")}
              </button>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {userAskPrompt && runMode !== "edit" && createPortal(
        <div className="af-user-ask-modal-overlay">
          <div className="af-user-ask-modal" role="dialog" aria-modal="true">
            <div className="af-user-ask-modal__head">
              <span className="af-user-ask-modal__title">
                <span className="material-symbols-outlined" aria-hidden>help</span>
                {t("flow:userAsk.title", { instanceId: userAskPrompt.instanceId })}
              </span>
              <div className="af-user-ask-modal__actions">
                <button type="button" className="af-user-ask-modal__btn" onClick={() => setUserAskPrompt(null)} aria-label={t("flow:userAsk.close")}>
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>
            </div>
            <div className="af-user-ask-modal__body">
              {userAskPrompt.question.trim() ? (
                <div className="af-user-ask-modal__question"><pre>{userAskPrompt.question}</pre></div>
              ) : null}
              {userAskPrompt.options.length === 0 ? (
                <div className="af-user-ask-modal__empty">{t("flow:userAsk.noOptions")}</div>
              ) : (
                <div className="af-user-ask-modal__options">
                  {userAskPrompt.options.map((opt) => (
                    <button
                      key={opt.name}
                      type="button"
                      className="af-user-ask-option"
                      disabled={userAskSubmitting}
                      onClick={async () => {
                        if (!userAskPrompt || !selected || !currentRunUuid) return;
                        setUserAskSubmitting(true);
                        try {
                          const res = await fetch("/api/flow", {
                            method: "POST",
                            headers: { "Content-Type": "application/json" },
                            body: JSON.stringify({
                              flowId: selected.id,
                              flowSource: selected.source ?? "user",
                              action: "confirm-user-ask",
                              runUuid: currentRunUuid,
                              instanceId: userAskPrompt.instanceId,
                              execId: userAskPrompt.execId,
                              branch: opt.name,
                              selectedIndex: opt.index,
                              selectedLabel: opt.label,
                            }),
                          });
                          if (res.ok) {
                            setUserAskPrompt(null);
                            setUserAskSubmitting(false);
                            void handleRun({ runUuid: currentRunUuid });
                          } else {
                            setUserAskSubmitting(false);
                            setRunLogs((prev) => [...prev, { ts: new Date().toISOString(), type: "error", text: t("flow:userAsk.submitFailed") }]);
                          }
                        } catch {
                          setUserAskSubmitting(false);
                          setRunLogs((prev) => [...prev, { ts: new Date().toISOString(), type: "error", text: t("flow:userAsk.submitFailed") }]);
                        }
                      }}
                    >
                      <span className="af-user-ask-option__index">[{opt.index}]</span>
                      <span className="af-user-ask-option__label">{opt.label}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="af-user-ask-modal__foot">
              <span className="af-user-ask-modal__hint">{userAskSubmitting ? t("flow:userAsk.submitting") : t("flow:userAsk.hint")}</span>
            </div>
          </div>
        </div>,
        document.body,
      )}

      {toolPrintContent && runMode !== "edit" && (
        <div
          className={"af-tool-print-toast" + (toolPrintExpanded ? " af-tool-print-toast--expanded" : "")}
          role="status"
          aria-live="polite"
        >
          <div className="af-tool-print-toast__head">
            <span className="material-symbols-outlined">print</span>
            <span className="af-tool-print-toast__title">{t("flow:toolPrint.title", { instanceId: toolPrintContent.instanceId })}</span>
            <button
              type="button"
              className="af-tool-print-toast__close"
              onClick={() => setToolPrintExpanded((v) => !v)}
              aria-label={toolPrintExpanded ? t("flow:toolPrint.restore") : t("flow:toolPrint.expand")}
              title={toolPrintExpanded ? t("flow:toolPrint.restore") : t("flow:toolPrint.expand")}
            >
              <span className="material-symbols-outlined">{toolPrintExpanded ? "close_fullscreen" : "open_in_full"}</span>
            </button>
            <button type="button" className="af-tool-print-toast__close" onClick={() => setToolPrintContent(null)} aria-label={t("common:close")}>
              <span className="material-symbols-outlined">close</span>
            </button>
          </div>
          <div className="af-tool-print-toast__body">
            <div className="af-tool-print-toast__markdown">
              <ReactMarkdown>{toolPrintContent.content}</ReactMarkdown>
            </div>
          </div>
        </div>
      )}

      {provideEditContent && (
        <div className="af-provide-edit-overlay">
          <div className="af-provide-edit-modal" role="dialog" aria-modal="true">
            <div className="af-provide-edit-modal__head">
              <span className="material-symbols-outlined">edit_document</span>
              <span className="af-provide-edit-modal__title">{provideEditContent.label}</span>
              <button type="button" className="af-provide-edit-modal__close" onClick={() => setProvideEditContent(null)} aria-label={t("common:close")}>
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div className="af-provide-edit-modal__body">
              <textarea
                ref={provideEditRef}
                className="af-provide-edit-modal__textarea"
                defaultValue={provideEditContent.content}
                autoFocus
              />
            </div>
            <div className="af-provide-edit-modal__foot">
              <button type="button" className="af-provide-edit-modal__btn af-provide-edit-modal__btn--save" onClick={handleProvideEditSave}>
                <span className="material-symbols-outlined">save</span>
                {t("flow:provideEdit.save")}
              </button>
              <button type="button" className="af-provide-edit-modal__btn" onClick={() => setProvideEditContent(null)}>
                <span className="material-symbols-outlined">close</span>
                {t("flow:provideEdit.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}

      {runWithParamsOpen && (
        <div className="af-run-params-overlay">
          <div className="af-run-params-modal" role="dialog" aria-modal="true">
            <div className="af-run-params-modal__head">
              <span className="material-symbols-outlined">edit_note</span>
              <span className="af-run-params-modal__title">{t("flow:runParams.title")}</span>
              <button type="button" className="af-run-params-modal__close" onClick={() => setRunWithParamsOpen(false)} aria-label={t("common:close")}>
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div className="af-run-params-modal__body">
              {provideNodes.length === 0 ? (
                <div className="af-run-params-empty">{t("flow:runParams.noParams")}</div>
              ) : (
                <div className="af-run-params-list">
                  {provideNodes.map((node) => {
                    const slotName = cliInputSlotNames[node.id];
                    if (!slotName) return null;
                    const definitionId = node.data?.definitionId || "";
                    const isFile = definitionId.startsWith("provide_file");
                    const isBool = definitionId === "provide_bool";
                    const label = node.data?.label || node.id;
                    const currentValue = runParamsDraft[slotName] ?? "";
                    const boolChecked = ["true", "1", "yes", "on"].includes(String(currentValue).trim().toLowerCase());
                    return (
                      <div key={node.id} className="af-run-params-item">
                        <div className="af-run-params-item__head">
                          <span className={"af-run-params-item__icon material-symbols-outlined" + (isFile ? " af-run-params-item__icon--file" : "")}>
                            {isFile ? "description" : isBool ? "toggle_on" : "text_fields"}
                          </span>
                          <span className="af-run-params-item__label">{label}</span>
                          <span className="af-run-params-item__slot">{slotName}</span>
                        </div>
                        {isBool ? (
                          <button
                            type="button"
                            className={"af-run-config-bool-toggle" + (boolChecked ? " af-run-config-bool-toggle--true" : "")}
                            onClick={() => setRunParamsDraft((d) => ({ ...d, [slotName]: boolChecked ? "false" : "true" }))}
                            aria-pressed={boolChecked}
                          >
                            {boolChecked ? "true" : "false"}
                          </button>
                        ) : (
                          <input
                            type="text"
                            className="af-run-params-item__input"
                            value={currentValue}
                            onChange={(e) => setRunParamsDraft((d) => ({ ...d, [slotName]: e.target.value }))}
                            placeholder={isFile ? t("flow:runConfig.filePathPlaceholder") : t("flow:runConfig.stringValuePlaceholder")}
                          />
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
            <div className="af-run-params-modal__foot">
              <button
                type="button"
                className="af-run-params-modal__btn af-run-params-modal__btn--run"
                onClick={() => {
                  // 将 runParamsDraft 转换为 cliInputs 格式
                  const cliInputsOverride = {};
                  for (const node of provideNodes) {
                    const slotName = cliInputSlotNames[node.id];
                    if (!slotName) continue;
                    const definitionId = node.data?.definitionId || "";
                    const value = runParamsDraft[slotName] ?? "";
                    if (definitionId.startsWith("provide_file")) {
                      cliInputsOverride[slotName] = { type: "file", path: value };
                    } else {
                      cliInputsOverride[slotName] = { type: "str", value };
                    }
                  }
                  setRunWithParamsOpen(false);
                  setRunDropdownOpen(false);
                  void handleRun({ cliInputsOverride });
                }}
              >
                <span className="material-symbols-outlined">play_arrow</span>
                {t("flow:runParams.run")}
              </button>
              <button type="button" className="af-run-params-modal__btn" onClick={() => setRunWithParamsOpen(false)}>
                <span className="material-symbols-outlined">close</span>
                {t("flow:runParams.cancel")}
              </button>
            </div>
          </div>
        </div>
      )}
      </FlowNodeContext.Provider>
    </ReactFlowProvider>
  );
}
