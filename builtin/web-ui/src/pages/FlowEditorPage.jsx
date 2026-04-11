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
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { buildStableEdgeKey, reconcileFlowGraph } from "../flowDiff.js";
import { buildInstancesForYaml, deserializeFromFlowYaml, serializeToFlowYaml, VALID_ROLES } from "../flowFormat.js";
import { computeSlotEdgeWarnings } from "../flowSlotEdgeWarnings.js";
import { cloneNodeIoDraftSlots, filterValidEdges, mergeNodeWithPalette } from "../mergeFlowNodes.js";
import { formatDurationMs, formatRelativeTime, recordPipelineOpened } from "../pipelineRecent.js";
import { useRoute } from "../routeContext.jsx";
import { FLOW_NODE_TYPE, FlowNode } from "../FlowNode.jsx";
import { isEditableFocus, isQuestionMarkShortcut } from "../hotkeyUtils.js";
import { ArchivePipelineModal } from "../ArchivePipelineModal.jsx";
import { DeletePipelineModal } from "../DeletePipelineModal.jsx";
import { KeyboardShortcutsModal } from "../KeyboardShortcutsModal.jsx";
import { NODE_INSTANCE_ID_RE, NodePropertiesPanel } from "../NodePropertiesPanel.jsx";
import RunNodeContextPanel from "../RunNodeContextPanel.jsx";

/* global __APP_VERSION__ */
const APP_VERSION = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";

/** 顶栏 MM:SS.cc；ms 为从 0 起的经过毫秒数 */
function formatStopwatchMs(ms) {
  const n = Math.max(0, Number(ms) || 0);
  return `${String(Math.floor(n / 60000)).padStart(2, "0")}:${String(Math.floor((n % 60000) / 1000)).padStart(2, "0")}.${String(
    Math.floor((n % 1000) / 10),
  ).padStart(2, "0")}`;
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

/** 包装 FlowNode 以注入 deleteNode 功能 */
function FlowNodeWrapper(props) {
  const { setNodes } = useReactFlow();
  const deleteNode = useCallback((nodeId) => {
    setNodes((nds) => nds.filter((n) => n.id !== nodeId));
  }, [setNodes]);
  return <FlowNode {...props} deleteNode={deleteNode} />;
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

/**
 * 从 pipeline 路径提取工作区目录
 * @param {string} path
 * @returns {string}
 */
function getWorkspaceFromPath(path) {
  if (!path) return "";
  // 移除 flow.yaml 文件名，返回所在目录
  const lastSlash = path.lastIndexOf("/");
  if (lastSlash === -1) return path;
  const dir = path.slice(0, lastSlash);
  // 如果是 .agentflow/pipelines/xxx/flow.yaml 结构，返回工作区根目录
  const agentflowIdx = dir.indexOf("/.agentflow/");
  if (agentflowIdx !== -1) {
    return dir.slice(0, agentflowIdx) || dir;
  }
  return dir;
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

function normalizeComposerModelValue(model, cursorList, opencodeList) {
  const m = (model || "").trim();
  if (!m) return "";
  if (m.startsWith("opencode:")) return m;
  const c = Array.isArray(cursorList) ? cursorList : [];
  const o = Array.isArray(opencodeList) ? opencodeList : [];
  const cIds = c.map(modelEntryId);
  const oIds = o.map(modelEntryId);
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
      last.text += kind === "error" ? `\n${s.text}` : s.text;
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

function FitViewHelper({ fitViewEpoch, nodeCount }) {
  const { fitView } = useReactFlow();
  useEffect(() => {
    if (fitViewEpoch > 0 && nodeCount > 0) {
      const t = requestAnimationFrame(() => fitView({ padding: 0.2, duration: 200 }));
      return () => cancelAnimationFrame(t);
    }
  }, [fitViewEpoch, nodeCount, fitView]);
  return null;
}

function FlowBoard({
  fitViewEpoch,
  canvasTool,
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onNodesDelete,
  onNodeClick,
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

  return (
    <ReactFlow
      className={flowClassName}
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange || noop}
      onEdgesChange={onEdgesChange || noop}
      onConnect={isRunMode ? undefined : onConnect}
      onNodesDelete={isRunMode ? undefined : onNodesDelete}
      onNodeClick={onNodeClick}
      onInit={onFlowInit}
      onDrop={isRunMode ? undefined : onDrop}
      onDragOver={isRunMode ? undefined : onDragOver}
      nodeTypes={nodeTypes}
      selectionOnDrag={selectionOnDrag}
      panOnDrag={panOnDrag}
      nodesDraggable={!isRunMode}
      nodesConnectable={!isRunMode}
      elementsSelectable={!isRunMode}
      panActivationKeyCode="Space"
      proOptions={{ hideAttribution: true }}
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
            { type: "str", color: "#2196f3" },
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
      <FitViewHelper fitViewEpoch={fitViewEpoch} nodeCount={nodes.length} />
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

/** @param {{ id: string, source?: string, archived?: boolean }} f */
function flowListEntryKey(f) {
  const src = f.source ?? "user";
  const ar = f.archived ? "1" : "0";
  return `${f.id}\u0000${src}\u0000${ar}`;
}

function replaceFlowUrl(flow) {
  if (!window.location.pathname.startsWith("/flow")) return;
  if (!flow) {
    window.history.replaceState({}, "", "/flow");
    return;
  }
  const q = new URLSearchParams({
    flowId: flow.id,
    flowSource: flow.source ?? "user",
  });
  if (flow.archived) q.set("flowArchived", "1");
  window.history.replaceState({}, "", "/flow?" + q.toString());
}

/** 保存 flow.yaml 的 API flowSource：builtin 写入工作区副本 */
function flowSourceForWrite(source) {
  return source === "builtin" ? "workspace" : source ?? "user";
}

function flowSourceLabelZh(source, t) {
  if (source === "builtin") return t("flow:settings.builtin");
  if (source === "workspace") return t("flow:palette.workspace");
  return t("flow:palette.userDir");
}

const RUN_CONSOLE_HEIGHT_STORAGE_KEY = "af:run-console-height";
/** 约 14rem + 顶部分隔条高度，与原先仅 head+body 时的可视区域接近 */
const RUN_CONSOLE_HEIGHT_DEFAULT_PX = 230;

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
  const { t } = useTranslation();
  const { navigate, path } = useRoute();
  const [flows, setFlows] = useState([]);
  const [listError, setListError] = useState("");
  const [selected, setSelected] = useState(null);
  const [fitViewEpoch, setFitViewEpoch] = useState(0);
  const [flowDescription, setFlowDescription] = useState("");
  const [loadError, setLoadError] = useState("");
  const [saveStatus, setSaveStatus] = useState("");
  const [moveFlowError, setMoveFlowError] = useState("");
  const [moveFlowBusy, setMoveFlowBusy] = useState(false);
  const [archiveModalOpen, setArchiveModalOpen] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  /** 槽位校验横幅：关闭后隐藏，直至刷新、切换流水线或警告集合变化 */
  const [slotWarningsBannerDismissed, setSlotWarningsBannerDismissed] = useState(false);
  const [slotWarningsRefreshing, setSlotWarningsRefreshing] = useState(false);
  const slotWarningsRefreshBusyRef = useRef(false);
  const [palette, setPalette] = useState([]);
  const [paletteSearch, setPaletteSearch] = useState("");
  const [rightPanel, setRightPanel] = useState(/** @type {null | "settings" | "history" | "node" | "composer"} */ (null));
  const [recentRuns, setRecentRuns] = useState(
    /** @type {Array<{ flowId: string, runId?: string, at: number, durationMs?: number, status?: string }>} */ ([]),
  );
  const [recentRunsError, setRecentRunsError] = useState("");
  const [recentRunsLoading, setRecentRunsLoading] = useState(false);

  // 工作区树形结构
  const [workspaceExpanded, setWorkspaceExpanded] = useState(false);
  const [workspaceTree, setWorkspaceTree] = useState(
    /** @type {{ pipelines: Array<{id: string, source: string, archived?: boolean}>, runs: Array<{flowId: string, runs: Array<{runId: string, at: number}>}> }} */ ({
      pipelines: [],
      runs: [],
    }),
  );
  const [workspaceTreeLoading, setWorkspaceTreeLoading] = useState(false);

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

  // ── Run mode state ──
  const [runMode, setRunMode] = useState(/** @type {"edit" | "running" | "stopped" | "done" | "error"} */ ("edit"));
  const [runLogs, setRunLogs] = useState(/** @type {Array<{ ts: string, type: string, text: string }>} */ ([]));
  const [executingNodes, setExecutingNodes] = useState(/** @type {Set<string>} */ (new Set()));
  const [nodeRunStatus, setNodeRunStatus] = useState(/** @type {Record<string, { status: string, elapsed?: string }>} */ ({}));
  const [runStartTime, setRunStartTime] = useState(/** @type {number | null} */ (null));
  const [runElapsedMs, setRunElapsedMs] = useState(0);
  const [runConsoleOpen, setRunConsoleOpen] = useState(false);
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
  const runAbortRef = useRef(/** @type {AbortController | null} */ (null));
  const runLogEndRef = useRef(/** @type {HTMLDivElement | null} */ (null));

  const [composerText, setComposerText] = useState("");
  const [composerCursor, setComposerCursor] = useState(0);
  const [mentionHighlight, setMentionHighlight] = useState(0);
  const [canvasTool, setCanvasTool] = useState(/** @type {"select" | "pan"} */ ("pan"));
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const composerInputRef = useRef(/** @type {HTMLTextAreaElement | null} */ (null));
  const nodePanelSuppressedRef = useRef(/** @type {string | null} */ (null));
  const soleSelectedNodeRef = useRef(/** @type {import("@xyflow/react").Node | null} */ (null));

  const [nodePropsFlowEpoch, setNodePropsFlowEpoch] = useState(0);
  const [nodePropDraft, setNodePropDraft] = useState(
    /** @type {null | { id: string, newId: string, label: string, role: string, model: string, body: string, script?: string, inputs: IoDraftSlot[], outputs: IoDraftSlot[] }} */ (null),
  );
  const [nodePropsError, setNodePropsError] = useState("");
  const [modelLists, setModelLists] = useState(/** @type {{ cursor: string[], opencode: string[] }} */ ({ cursor: [], opencode: [] }));
  const [composerModel, setComposerModel] = useState("");
  const [composerPhaseRole, setComposerPhaseRole] = useState("");

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
      // 每次进入流水线时创建一个新的空对话 tab 并激活
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
  const syncHighlightTimerRef = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));
  const [nodes, setNodes, onNodesChange] = useNodesState([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState([]);
  const nodesRef = useRef(nodes);
  const edgesRef = useRef(edges);

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

  useEffect(() => {
    // 默认行为：仅 warning 时收起；存在 error 时展开。
    setSlotWarningsBannerDismissed(flowSlotEdgeWarnings.length > 0 && !hasSlotValidationError);
  }, [slotWarningsSignature, selected?.id, selected?.source, flowSlotEdgeWarnings.length, hasSlotValidationError]);

  soleSelectedNodeRef.current = soleSelectedNode;

  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  useEffect(() => {
    edgesRef.current = edges;
  }, [edges]);

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
    let cancelled = false;
    const load = () => {
      fetch("/api/model-lists")
        .then((r) => r.json())
        .then((j) => {
          if (!cancelled) {
            setModelLists({
              cursor: Array.isArray(j.cursor) ? j.cursor.map(String) : [],
              opencode: Array.isArray(j.opencode) ? j.opencode.map(String) : [],
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

  const fetchFlowGraphData = useCallback(async (flow) => {
    const flowSource = flow.source ?? "user";
    const flowArchived = Boolean(flow.archived);
    const q = new URLSearchParams({ flowId: flow.id, flowSource });
    if (flowArchived) q.set("archived", "1");
    const nodeQ = new URLSearchParams({ flowId: flow.id, flowSource });
    if (flowArchived) nodeQ.set("archived", "1");

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
      nodes: mergedNodes,
      edges: validEdges,
    };
  }, []);

  const loadFlow = useCallback(
    /**
     * @param {{ id: string, source?: string, archived?: boolean }} flow
     * @param {{ preserveComposer?: boolean, incrementalSync?: boolean }} [opts]
     */
    async (flow, opts = {}) => {
      const preserveComposer = Boolean(opts.preserveComposer);
      const incrementalSync = preserveComposer && Boolean(opts.incrementalSync);
      setSelected(flow);
      setLoadError("");
      if (!preserveComposer) {
        setSaveStatus("");
        setPaletteSearch("");
        setRightPanel(null);
        setFlowDescription("");
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
          setFitViewEpoch((x) => x + 1);
        }

        recordPipelineOpened(flow.id, nextGraph.flowSource);
        setNodePropsFlowEpoch((x) => x + 1);
      } catch (e) {
        setLoadError(String(e.message || e));
      }
    },
    [fetchFlowGraphData, setNodes, setEdges],
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
  }, [selected?.id, selected?.source, selected?.archived, loadFlow, setNodes]);

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
      script: scriptDraft,
      inputs: draftInputs,
      outputs: draftOutputs,
    });
  }, [soleSelectedNode?.id, nodePropsFlowEpoch]);

  /** 仅一个节点选中时关闭抽屉；打开抽屉改由 onNodeClick（单击）触发，避免拖动节点时误开侧栏 */
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
        return;
      }
      openNodePanelFromCanvasClick();
    },
    [openNodePanelFromCanvasClick, runMode],
  );

  const onConnect = useCallback(
    (params) => setEdges((eds) => addEdge({ ...params, markerEnd: { type: MarkerType.ArrowClosed } }, eds)),
    [setEdges],
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
          zoom,
          duration: 220,
        });
      };
      requestAnimationFrame(() => requestAnimationFrame(center));
    },
    [setNodes, setEdges, openNodePanelFromCanvasClick],
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
      const id = `node-${Date.now()}`;
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
      const merged = mergeNodeWithPalette(raw, instancesRef.current, palette);
      setNodes((nds) => [...nds, merged]);
    },
    [selected, palette, setNodes],
  );

  const handlePaletteDragOver = useCallback((e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }, []);

  const handlePaletteDrop = useCallback(
    (e) => {
      e.preventDefault();
      if (!selected) return;
      const defId = e.dataTransfer.getData("application/agentflow-node");
      if (!defId) return;
      const def = palette.find((p) => p.id === defId);
      if (!def) return;
      const rfi = reactFlowInstanceRef.current;
      if (!rfi) return;
      const position = rfi.screenToFlowPosition({ x: e.clientX, y: e.clientY });
      const id = `node-${Date.now()}`;
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
      const merged = mergeNodeWithPalette(raw, instancesRef.current, palette);
      setNodes((nds) => [...nds, merged]);
    },
    [selected, palette, setNodes],
  );

  const persistFlowToServer = useCallback(
    async (nodelist, edgelist) => {
      if (!selected) return;
      setSaveStatus(t("flow:status.saving"));
      try {
        const yaml = serializeToFlowYaml(nodelist, edgelist, instancesRef.current, {
          description: flowDescription,
        });
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
        setFlowDescription(data.description || "");
        setSaveStatus(t("flow:status.saved"));
        if (selected.source === "builtin" && writeSource === "workspace") {
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

  const handleSave = useCallback(() => {
    persistFlowToServer(nodes, edges);
  }, [persistFlowToServer, nodes, edges]);

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
      }));
    const nextInputs = normIo(nodePropDraft.inputs);
    const nextOutputs = normIo(nodePropDraft.outputs);
    const defIdForScript = String(soleSelectedNode.data?.definitionId ?? trimmedNew);
    const nextData = {
      ...soleSelectedNode.data,
      label: nodePropDraft.label.trim() || trimmedNew,
      role,
      model: modelTrim === "" || modelTrim === "default" ? undefined : modelTrim,
      body: nodePropDraft.body,
      inputs: nextInputs,
      outputs: nextOutputs,
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
    persistFlowToServer,
  ]);

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
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    handleSave,
    shortcutsOpen,
    rightPanel,
    soleSelectedNode,
    nodePropDraft,
    applyNodeProperties,
    runMode,
  ]);

  // ── Run timer tick ──
  useEffect(() => {
    if (runMode !== "running" || runStartTime == null) return;
    const id = setInterval(() => setRunElapsedMs(Date.now() - runStartTime), 200);
    return () => clearInterval(id);
  }, [runMode, runStartTime]);

  // ── Auto-scroll run log ──
  useEffect(() => {
    if (runLogEndRef.current) runLogEndRef.current.scrollIntoView({ behavior: "smooth" });
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

  const handleRun = useCallback(async (/** @type {{ runUuid?: string | null }} */ opts = {}) => {
    if (!selected) return;
    const runUuid =
      opts.runUuid != null && String(opts.runUuid).trim() ? String(opts.runUuid).trim() : null;
    setRunMode("running");
    /* 勿在 fetch 完成前清空：否则在连接建立前控制台会一直空白（计时器已启动） */
    setRunLogs([
      {
        ts: new Date().toISOString(),
        type: "info",
        text: runUuid
          ? t("flow:run.connectingApiResume", { uuid: runUuid })
          : t("flow:run.connectingApi"),
      },
    ]);
    setExecutingNodes(new Set());
    setNodeRunStatus({});
    setRunConsoleOpen(true);
    setRightPanel(null);
    if (!runUuid) setCurrentRunUuid(null);
    const start = Date.now();
    setRunStartTime(start);
    setRunElapsedMs(0);

    const abort = new AbortController();
    runAbortRef.current = abort;

    try {
      const resp = await fetch("/api/flow/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ flowId: selected.id, ...(runUuid ? { uuid: runUuid } : {}) }),
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
            setRunLogs((prev) => [...prev, { ts: now, type: "info", text: t("flow:run.pipelineStart", { uuid: msg.uuid || "?" }) }]);
          } else if (msg.event === "apply-done") {
            setRunLogs((prev) => [...prev, { ts: now, type: "info", text: msg.totalElapsed ? t("flow:run.pipelineDoneWithElapsed", { elapsed: msg.totalElapsed }) : t("flow:run.pipelineDone") }]);
          } else if (msg.event === "apply-paused") {
            setRunLogs((prev) => [...prev, { ts: now, type: "warn", text: t("flow:run.pipelinePaused", { nodes: (msg.pendingNodes || []).join(", ") }) }]);
          } else {
            setRunLogs((prev) => [...prev, { ts: now, type: "event", text: `[${msg.event}] ${JSON.stringify(msg)}` }]);
          }
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

  const handleStop = useCallback(async () => {
    if (runAbortRef.current) {
      runAbortRef.current.abort();
      runAbortRef.current = null;
    }
    if (selected) {
      try {
        await fetch("/api/flow/run/stop", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ flowId: selected.id }),
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

  /** 从执行历史进入该次 run 的画布态（列表状态可能与实际目录不一致，如仍显示进行中但实际可恢复） */
  const openRunFromHistory = useCallback(
    (
      /** @type {{ flowId: string, runId?: string, at: number, durationMs?: number, status?: string }} */ run,
    ) => {
      const rid = run.runId != null && String(run.runId).trim() ? String(run.runId).trim() : null;
      const fid =
        run.flowId != null && String(run.flowId).trim() ? String(run.flowId).trim() : selected?.id != null ? String(selected.id) : null;
      setCurrentRunUuid(rid);
      const st = run.status || "unknown";
      /** @type {"stopped" | "done" | "error"} */
      let mode = "stopped";
      if (st === "success") mode = "done";
      else if (st === "failed") mode = "error";
      else if (st === "stopped" || st === "interrupted") mode = "stopped";
      else if (st === "running") mode = "stopped";
      else mode = "stopped";
      setRunMode(mode);
      setRunElapsedMs(Math.max(0, run.durationMs ?? 0));
      setRunStartTime(null);
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

  // 加载工作区树形结构
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setWorkspaceTreeLoading(true);
      try {
        const r = await fetch("/api/workspace-tree");
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || "HTTP " + r.status);
        if (!cancelled) {
          setWorkspaceTree({
            pipelines: Array.isArray(j.pipelines) ? j.pipelines : [],
            runs: Array.isArray(j.runs) ? j.runs : [],
          });
        }
      } catch (e) {
        if (!cancelled) {
          setWorkspaceTree({ pipelines: [], runs: [] });
        }
      } finally {
        if (!cancelled) setWorkspaceTreeLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

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
    const opencodeIdValues = opencode.map((m) => `opencode:${modelEntryId(m)}`);
    const idSet = new Set([...cursor, ...opencode].map(modelEntryId).concat(opencodeIdValues));
    const raw = (composerModel || "").trim();
    const normalized = normalizeComposerModelValue(composerModel, cursor, opencode);
    const extra = normalized && !idSet.has(normalized) && !idSet.has(raw) ? raw : "";
    return { cursorList: cursor, opencodeList: opencode, currentNotInLists: extra };
  }, [modelLists, composerModel]);

  useEffect(() => {
    const cursor = Array.isArray(modelLists?.cursor) ? modelLists.cursor : [];
    const opencode = Array.isArray(modelLists?.opencode) ? modelLists.opencode : [];
    setComposerModel((prev) => {
      const next = normalizeComposerModelValue(prev, cursor, opencode);
      return next === prev ? prev : next;
    });
  }, [modelLists.cursor, modelLists.opencode]);

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
    const modelKey = normalizeComposerModelValue(composerModel, cursor, opencode);
    const contextInstanceIds = composerStripEntries
      .filter((e) => e.kind !== "definition" && e.node)
      .map((e) => e.node.id);
    const flowForReload = selected;
    let sawDone = false;
    /** 分阶段：本段流结束后自动进入下一阶段（不点「继续」） */
    let phaseContinueSnapshot = null;
    let phaseAutoContinueLabel = /** @type {string | null} */ (null);
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
              if (!ev.isLastPhase && ev.nextPhase) {
                phaseContinueSnapshot = next;
                phaseAutoContinueLabel =
                  String(ev.nextPhase.label || "").trim() || t("flow:composer.nextPhase");
              }
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
      if (
        phaseContinueSnapshot &&
        phaseAutoContinueLabel &&
        !ac.signal.aborted &&
        !phaseStreamError &&
        phaseContinueSnapshot.nextPhase &&
        !phaseContinueSnapshot.isLastPhase
      ) {
        const snap = phaseContinueSnapshot;
        const label = phaseAutoContinueLabel;
        window.setTimeout(() => {
          void submitComposerRef.current?.(t("flow:composer.continuePhase", { label }), { phaseContextSnapshot: snap });
        }, 0);
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
        void loadFlow(
          {
            id: flowForReload.id,
            source: flowForReload.source ?? "user",
            archived: flowForReload.archived,
          },
          { preserveComposer: true, incrementalSync: true },
        );
      }
    }
  }, [selected, composerText, composerModel, modelLists, composerStripEntries, loadFlow, composerThread, activeSessionId, composerPhaseContext, composerPhaseRole]);

  submitComposerRef.current = submitComposer;

  const skipRemainingPhases = useCallback(() => {
    if (!composerPhaseContext || composerPhaseContext.isLastPhase) return;
    setComposerPhaseContext(null);
    void submitComposer(t("flow:composer.skipRemainingPhases"));
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

  const flowSelectValue = selected ? flowListEntryKey(selected) : "";

  return (
    <ReactFlowProvider>
      <div className={"af-pipeline-page" + (runMode !== "edit" ? " af-pipeline-page--run-mode" : "")}>
        <header className="af-pipeline-top">
          <div className="af-pipeline-top-left">
            <button
              type="button"
              className="af-icon-btn af-pipeline-back"
              onClick={() => {
                if (runMode !== "edit") {
                  if (runMode === "running") void handleStop();
                  else handleBackToEdit();
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
            <div className="af-pipeline-flow-pick">
              <label className="af-visually-hidden" htmlFor="af-flow-select">
                {t("flow:topbar.currentPipeline")}
              </label>
              <select
                id="af-flow-select"
                className="af-pipeline-flow-select"
                value={flowSelectValue}
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) return;
                  const parts = v.split("\u0000");
                  const id = parts[0];
                  const src = parts[1] || "user";
                  const archived = parts[2] === "1";
                  const f = flows.find(
                    (x) => x.id === id && (x.source ?? "user") === src && Boolean(x.archived) === archived,
                  );
                  if (f) loadFlow(f);
                }}
                disabled={flows.length === 0}
              >
                {flows.length === 0 ? (
                  <option value="">{t("flow:palette.loading")}</option>
                ) : (
                  <>
                    {!selected ? <option value="">{t("flow:pipeline.selectPipeline")}</option> : null}
                    {flows.map((f) => (
                      <option key={flowListEntryKey(f)} value={flowListEntryKey(f)}>
                        {f.id} ({flowSourceLabelZh(f.source ?? "user", t)})
                        {f.archived ? ` · ${t("flow:palette.archived")}` : ""}
                      </option>
                    ))}
                  </>
                )}
              </select>
            </div>
          </div>
          <div className="af-pipeline-top-right af-flow-toolbar-actions">
            {runMode === "running" && (
              <div className="af-run-timer">
                <span className="af-run-timer__dot" />
                <span className="af-run-timer__label">RUNTIME</span>
                <span className="af-run-timer__value">{formatToolbarRunTimer(runElapsedMs, "running")}</span>
              </div>
            )}
            {runMode === "stopped" && (
              <div className="af-run-timer af-run-timer--stopped">
                <span className="af-run-timer__label">STOPPED</span>
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
                    selected.source === "builtin" ||
                    (selected.source !== "user" && selected.source !== "workspace")
                  }
                  onClick={() => setDeleteModalOpen(true)}
                >
                  <span className="material-symbols-outlined">delete_forever</span>
                </button>
                <button type="button" className="af-btn-pipeline-save" disabled={!selected} onClick={handleSave}>
                  Save
                </button>
                <button
                  type="button"
                  className="af-btn-pipeline-archive"
                  disabled={
                    !selected ||
                    selected.source === "builtin" ||
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
              <button type="button" className="af-btn-run-stop" onClick={handleStop}>
                <span className="material-symbols-outlined">stop</span>
                Stop
              </button>
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
              <button type="button" className="af-btn-pipeline-save" onClick={handleBackToEdit}>
                <span className="material-symbols-outlined">edit</span>
                Edit
              </button>
            ) : (
              <button type="button" className="af-btn-primary af-btn-primary--lg" disabled={!selected} onClick={() => void handleRun()}>
                Run
              </button>
            )}
          </div>
        </header>

        <div className={"af-pipeline-body" + (runMode !== "edit" ? " af-pipeline-body--run-mode" : "")}>
          {runMode === "edit" ? (
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
              <div className="af-palette-workspace-path" title={selected?.path ? getWorkspaceFromPath(selected.path) : ""}>
                {selected?.path ? getWorkspaceFromPath(selected.path) : t("flow:palette2.noPipelineSelected")}
              </div>

              {/* 展开后的工作区树形结构 */}
              {workspaceExpanded && (
                <div className="af-palette-workspace-tree">
                  {workspaceTreeLoading ? (
                    <div className="af-palette-workspace-loading">{t("flow:palette.loading")}</div>
                  ) : (
                    <>
                      {/* Pipelines 分组 */}
                      <div className="af-palette-workspace-group">
                        <div className="af-palette-workspace-group-head">
                          <span className="material-symbols-outlined" aria-hidden>account_tree</span>
                          <span>Pipelines</span>
                          <span className="af-palette-workspace-count">({workspaceTree.pipelines.length})</span>
                        </div>
                        {workspaceTree.pipelines.length > 0 ? (
                          <ul className="af-palette-workspace-list">
                            {workspaceTree.pipelines.map((p) => (
                              <li
                                key={p.id}
                                className={`af-palette-workspace-item${p.archived ? " af-palette-workspace-item--archived" : ""}${selected?.id === p.id ? " af-palette-workspace-item--active" : ""}`}
                                onClick={() => {
                                  // 切换到该 pipeline
                                  const flow = flows.find((f) => f.id === p.id && (f.source ?? "user") === p.source);
                                  if (flow) loadFlow(flow);
                                }}
                              >
                                <span className="material-symbols-outlined af-palette-workspace-item-icon" aria-hidden>
                                  {p.archived ? "archive" : "description"}
                                </span>
                                <span className="af-palette-workspace-item-label" title={p.id}>
                                  {p.id}
                                </span>
                                {p.archived && <span className="af-palette-workspace-item-badge">{t("flow:palette.archived")}</span>}
                              </li>
                            ))}
                          </ul>
                        ) : (
                          <div className="af-palette-workspace-empty">{t("flow:palette.noPipelines")}</div>
                        )}
                      </div>

                      {/* Runs 分组 */}
                      <div className="af-palette-workspace-group">
                        <div className="af-palette-workspace-group-head">
                          <span className="material-symbols-outlined" aria-hidden>play_circle</span>
                          <span>Runs</span>
                          <span className="af-palette-workspace-count">({workspaceTree.runs.reduce((sum, r) => sum + r.runs.length, 0)})</span>
                        </div>
                        {workspaceTree.runs.length > 0 ? (
                          <ul className="af-palette-workspace-list">
                            {workspaceTree.runs.slice(0, 5).map((flowRuns) => (
                              <li key={flowRuns.flowId} className="af-palette-workspace-run-group">
                                <div className="af-palette-workspace-run-flow">{flowRuns.flowId}</div>
                                <ul className="af-palette-workspace-run-list">
                                  {flowRuns.runs.slice(0, 3).map((run) => (
                                    <li
                                      key={run.runId}
                                      className="af-palette-workspace-run-item"
                                      title={t("flow:palette2.runId", { id: run.runId })}
                                    >
                                      <span className="material-symbols-outlined" aria-hidden>schedule</span>
                                      <span className="af-palette-workspace-run-id">{run.runId.slice(0, 8)}…</span>
                                      <span className="af-palette-workspace-run-time">{formatRelativeTime(run.at, t)}</span>
                                    </li>
                                  ))}
                                  {flowRuns.runs.length > 3 && (
                                    <li className="af-palette-workspace-run-more">{t("flow:palette2.moreRuns", { count: flowRuns.runs.length - 3 })}</li>
                                  )}
                                </ul>
                              </li>
                            ))}
                            {workspaceTree.runs.length > 5 && (
                              <li className="af-palette-workspace-more">{t("flow:palette2.moreFlows", { count: workspaceTree.runs.length - 5 })}</li>
                            )}
                          </ul>
                        ) : (
                          <div className="af-palette-workspace-empty">{t("flow:palette.noRuns")}</div>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            <div className="af-node-palette-head">
              <h2 className="af-node-palette-title">Node Palette</h2>
              <label className="af-palette-search-wrap">
                <span className="af-visually-hidden">{t("flow:palette.searchNodes")}</span>
                <span className="af-palette-search-icon material-symbols-outlined" aria-hidden>
                  search
                </span>
                <input
                  type="search"
                  className="af-palette-search-input"
                  value={paletteSearch}
                  onChange={(e) => setPaletteSearch(e.target.value)}
                  placeholder={t("flow:palette.searchNodes") + "…"}
                  aria-label={t("flow:palette.searchNodes")}
                />
              </label>
            </div>
            {listError ? <p className="af-err af-palette-list-err">{listError}</p> : null}
            <div className="af-node-palette-scroll">
              {PALETTE_ORDER.filter((cat) => filteredGroupedPalette[cat].length > 0).map((cat) => (
                <section key={cat} className={`af-palette-section af-flow-palette-section--${cat}`}>
                  <h3 className="af-palette-cat">{cat}</h3>
                  <div className="af-palette-cards">
                    {filteredGroupedPalette[cat].map((n) => (
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
                        title={n.description || n.id}
                      >
                        <span className="af-palette-card-icon" aria-hidden>
                          <span className="material-symbols-outlined">{paletteIcon(cat)}</span>
                        </span>
                        <span className="af-palette-card-label">{n.id}</span>
                      </button>
                    ))}
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
            <div className="af-react-flow-wrap af-pipeline-flow">
              {selected ? (
                <FlowBoard
                  fitViewEpoch={fitViewEpoch}
                  canvasTool={canvasTool}
                  nodes={runMode !== "edit" ? nodes.map((n) => ({
                    ...n,
                    draggable: false,
                    connectable: false,
                    data: {
                      ...n.data,
                      isRunMode: true,
                      isExecuting: executingNodes.has(n.id),
                      nodeStatus: nodeRunStatus[n.id]?.status ?? null,
                      nodeElapsed: nodeRunStatus[n.id]?.elapsed ?? null,
                    },
                  })) : nodes}
                  edges={edges}
                  onNodesChange={runMode !== "edit" ? undefined : onNodesChange}
                  onEdgesChange={runMode !== "edit" ? undefined : onEdgesChange}
                  onConnect={runMode !== "edit" ? undefined : onConnect}
                  onNodesDelete={runMode !== "edit" ? undefined : onNodesDelete}
                  onNodeClick={onNodeClick}
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
                          <div className="af-composer-thread-dialog-scroll">
                            <ComposerThreadContent
                              thread={composerThread}
                              liveSegments={composerNaturalSegments}
                              running={composerRunning}
                            />
                          </div>
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
              ) : (
                <div className="af-placeholder af-pipeline-placeholder">{t("flow:pipeline.selectPipeline")}</div>
              )}
            </div>
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

          {rightPanel && selected && runMode === "edit" ? (
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
                          className={[
                            "af-composer-session-tab",
                            session.id === activeSessionId ? "af-composer-session-tab--active" : "",
                            session.running ? "af-composer-session-tab--running" : "",
                          ].filter(Boolean).join(" ")}
                          onClick={() => activateComposerSession(session.id)}
                          title={session.label}
                        >
                          <span className="af-composer-session-label">{session.label}</span>
                          {(composerSessions.length > 1 || session.running) && (
                            <span
                              className="af-composer-session-close"
                              onClick={(e) => {
                                e.stopPropagation();
                                closeComposerSession(session.id);
                              }}
                              title={session.running ? t("flow:composer.endConversation") : t("flow:composer.closeConversation")}
                            >
                              <span className="material-symbols-outlined" style={{ fontSize: "0.75rem" }}>
                                close
                              </span>
                            </span>
                          )}
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
                  {/* Thread content */}
                  <div className="af-composer-sidebar-thread" ref={composerSidebarThreadRef}>
                    <ComposerThreadContent
                      thread={composerThread}
                      liveSegments={composerNaturalSegments}
                      running={composerRunning}
                    />
                  </div>
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
                    onSave={applyNodeProperties}
                    onClose={closeRightPanel}
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
                        <label className="af-pipeline-drawer-field">
                          <span className="af-pipeline-drawer-label">{t("flow:pipeline.pipelineId")}</span>
                          <div className="af-pipeline-drawer-readonly">
                            {selected.id}
                            <span className="af-pipeline-drawer-badge">
                              {flowSourceLabelZh(selected.source ?? "user", t)}
                            </span>
                            {selected.archived ? (
                              <span className="af-pipeline-drawer-badge af-pipeline-drawer-badge--muted">{t("flow:settings.archived")}</span>
                            ) : null}
                          </div>
                        </label>
                        {typeof selected.path === "string" && selected.path ? (
                          <label className="af-pipeline-drawer-field">
                            <span className="af-pipeline-drawer-label">{t("flow:pipeline.diskPath")}</span>
                            <div className="af-pipeline-drawer-readonly af-pipeline-drawer-readonly--mono">
                              {selected.path}
                            </div>
                          </label>
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
                            placeholder="flow.yaml ui.description"
                            rows={5}
                            spellCheck={false}
                          />
                        </label>
                        <div className="af-pipeline-meta-card">
                          <h3 className="af-pipeline-meta-title">{t("flow:pipeline.metadata")}</h3>
                          <dl className="af-pipeline-meta-dl">
                            <div className="af-pipeline-meta-row">
                              <dt>{t("flow:pipeline.nodeCount")}</dt>
                              <dd>{nodes.length} {t("flow:pipeline.nodesUnit")}</dd>
                            </div>
                          </dl>
                        </div>
                        <button type="button" className="af-btn-primary af-pipeline-drawer-save" onClick={handleSave}>
                          {t("flow:settings.saveChanges")}
                        </button>
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

        <KeyboardShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
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
      </div>
    </ReactFlowProvider>
  );
}
