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
  useStoreApi,
  useUpdateNodeInternals,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Fragment, Suspense, lazy, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { ChartDisplayContent, MarkdownDisplayContent, TableDisplayContent } from "../displayRenderers.jsx";
import { buildCanvasClipboard, buildInstancesForYaml, pasteCanvasClipboard, VALID_ROLES } from "../flowFormat.js";
import { FLOW_NODE_TYPE, FlowNode } from "../FlowNode.jsx";
import { normalizeImages } from "../imageAttachments.js";
import {
  cloneNodeIoDraftSlots,
  filterValidEdges,
  mergeNodeWithPalette,
  revealConnectedSlots,
  revealConnectedSlotsForEdges,
} from "../mergeFlowNodes.js";
import { KeyboardShortcutsModal } from "../KeyboardShortcutsModal.jsx";
import { NodeJumpPalette } from "../NodeJumpPalette.jsx";
import WorkspaceRunLogsDrawer from "../components/WorkspaceRunLogsDrawer.jsx";
import LoadingState from "../components/LoadingState.jsx";
import {
  ComposerAssistantActivity,
  ComposerAssistantInput,
  ComposerAssistantTurn,
} from "../components/ComposerAssistant.jsx";
import { normalizeReactAppDisplayContent, reactAppDisplaySrcDoc } from "../reactAppDisplay.js";
import { NODE_INSTANCE_ID_RE, NodePropertiesPanel } from "../NodePropertiesPanel.jsx";
import { ArchivePipelineModal } from "../ArchivePipelineModal.jsx";
import { DeletePipelineModal } from "../DeletePipelineModal.jsx";
import { useCanvasHistory } from "../useCanvasHistory.js";
import {
  areSlotsCompatible,
  getHandleColor,
  getNodeSlotByHandle,
  getSlotConnectionLabel,
} from "../nodeSchema.js";
import { recordPipelineView } from "../pipelineViewPreference.js";
import {
  sortWorkflowIssueLinks,
  workflowIssueIsLogicalParent,
  workflowIssueLinkKind,
  workflowIssueMrStatus,
  workflowIssueParentKey,
  workflowIssueTreeCount,
} from "../prdWorkflowIssuePresentation.js";
import {
  aiDocArticleTitle,
  dedupeConfirmedAiDocs,
  isConfirmedAiDocCandidate,
} from "../prdWorkflowAiDocs.js";
import {
  canonicalPrdWorkflowStageKey,
  isPrdWorkflowGlobalEvent,
  isPrdWorkflowReviewLink,
  mergePrdWorkflowActionLists,
  selectCurrentPrdWorkflowActionLinks,
} from "../prdWorkflowActionLinks.js";
import {
  diffWorkspaceGraphsForUi,
  reconcileWorkspaceEdges,
  reconcileWorkspaceInstances,
  reconcileWorkspaceNodes,
  workspaceValueEqual,
} from "../workspaceGraphDelta.js";
import { layoutWorkspaceNodePositions } from "../../../../bin/lib/workspace-auto-layout.mjs";
import {
  coalesceWorkspaceCanvasChanges,
  coalesceWorkspaceSaveRequest,
  finalizeWorkspaceCanvasChanges,
  partitionWorkspaceCanvasChanges,
  shouldSkipWorkspaceRemoteRefresh,
  workspaceCanvasInteractionCommitsChanges,
  workspaceCanvasInteractionIsActive,
  workspaceCanvasInteractionPhase,
  workspaceBackgroundLoadSkipReason,
  workspaceLoadResourcePlan,
  workspaceResizePresentationSize,
  workspaceSaveBaselineAfterSuccess,
  workspaceSyncIndicatorPresentation,
} from "../workspaceSyncGuard.js";
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

const WorkflowAssistantThread = lazy(() => import("../components/WorkflowAssistantThread.jsx"));

const STORAGE_FALLBACK_KEY = "af:workspace-graph:v2";
const WORKSPACE_SIDEBAR_COLLAPSED_STORAGE_PREFIX = "agentflow.workspace.sidebarCollapsed";
const PALETTE_ORDER = ["DISPLAY", "CONTROL", "TOOL", "PROVIDE", "AGENT"];

const WORKSPACE_IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg"]);
const DEFAULT_WORKSPACE_NODE_WIDTH = 320;
const MIN_WORKSPACE_NODE_WIDTH = 180;
const MAX_WORKSPACE_NODE_WIDTH = 960;
const MIN_WORKSPACE_NODE_HEIGHT = 96;
const MAX_WORKSPACE_NODE_HEIGHT = 900;
const DEFAULT_WORKSPACE_DISPLAY_WIDTH = 520;
const DEFAULT_WORKSPACE_DISPLAY_HEIGHT = 320;
const WORKSPACE_GROUP_PADDING = 52;
const MIN_WORKSPACE_GROUP_WIDTH = 240;
const MIN_WORKSPACE_GROUP_HEIGHT = 160;
const DISPLAY_REF_PREFIX = "display-ref:";
const DISPLAY_GROUP_REF_PREFIX = "display-group-ref:";
const DEFAULT_WORKSPACE_SCHEDULE_CRON = "0 9 * * *";
const DEFAULT_WORKSPACE_SCHEDULE_TIMEZONE = "Asia/Shanghai";

/* global __APP_VERSION__ */
const APP_VERSION = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "0.0.0";

function readFlowParamsFromUrl() {
  const sp = new URLSearchParams(window.location.search);
  const returnTo = String(sp.get("returnTo") || "").trim();
  return {
    flowId: sp.get("flowId") || "",
    flowSource: sp.get("flowSource") || "user",
    workspaceId: sp.get("workspaceId") || "",
    workflowShare: sp.get("workflowShare") || "",
    adminOwnerId: sp.get("adminOwnerId") || "",
    archived: sp.get("archived") === "1" || sp.get("flowArchived") === "1",
    returnTo: returnTo === "/workflows" || returnTo.startsWith("/workflows?") ? returnTo : "",
    workflowDemo: sp.get("workflowDemo") === "1",
  };
}

function flowParamsQuery(params) {
  const q = new URLSearchParams();
  if (params.flowId) q.set("flowId", params.flowId);
  if (params.flowSource) q.set("flowSource", params.flowSource);
  if (params.workspaceId) q.set("workspaceId", params.workspaceId);
  if (params.workflowShare) q.set("workflowShare", params.workflowShare);
  if (params.adminOwnerId) q.set("adminOwnerId", params.adminOwnerId);
  if (params.archived) q.set("archived", "1");
  if (params.returnTo) q.set("returnTo", params.returnTo);
  if (params.workflowDemo) q.set("workflowDemo", "1");
  return q;
}

function workflowProjectBindingKey(project = {}) {
  return [project.workspaceId || "", project.flowSource || "user", project.flowId || ""].join("\t");
}

function readWorkflowDemoSnapshot(tapdId) {
  const id = String(tapdId || "").trim();
  if (!id) return null;
  try {
    const parsed = JSON.parse(window.sessionStorage.getItem(`agentflow.workflow.demo:${id}`) || "null");
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function clipConversationText(value, max = 4000) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]` : text;
}

function normalizeConversationMessage(message) {
  const text = clipConversationText(message?.text, 4000);
  if (!text) return null;
  return {
    role: message?.role === "user" ? "user" : "assistant",
    ...(message?.kind ? { kind: String(message.kind) } : {}),
    text,
    ...(message?.error ? { error: true } : {}),
    at: Number.isFinite(Number(message?.at)) ? Number(message.at) : Date.now(),
  };
}

function normalizeConversationMessages(messages, limit = 80) {
  return (Array.isArray(messages) ? messages : [])
    .map(normalizeConversationMessage)
    .filter(Boolean)
    .slice(-limit);
}

function normalizeNodeChatSessionsForPersistence(sessions) {
  const source = sessions && typeof sessions === "object" && !Array.isArray(sessions) ? sessions : {};
  const next = {};
  for (const [nodeId, session] of Object.entries(source).slice(-80)) {
    const id = String(nodeId || "").trim();
    if (!id || !session || typeof session !== "object") continue;
    const messages = normalizeConversationMessages(session.messages, 40);
    const draft = clipConversationText(session.draft || "", 2000);
    if (!messages.length && !draft) continue;
    next[id] = {
      sessionId: String(session.sessionId || `nodechat_${id}`),
      messages,
      ...(draft ? { draft } : {}),
      candidateContent: "",
      running: false,
      error: "",
    };
  }
  return next;
}

function normalizeComposerRunSessionsForPersistence(sessions) {
  return (Array.isArray(sessions) ? sessions : [])
    .map((session) => {
      const id = String(session?.id || "").trim();
      if (!id) return null;
      const messages = normalizeConversationMessages(session?.messages, 80);
      if (!messages.length) return null;
      const status = String(session?.status || "done");
      return {
        id,
        label: clipConversationText(session?.label || id, 120),
        status: status === "failed" ? "failed" : "done",
        messages,
      };
    })
    .filter(Boolean)
    .slice(-20);
}

function normalizeWorkspaceConversationsForUi(raw) {
  const data = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const composer = data.composer && typeof data.composer === "object" && !Array.isArray(data.composer) ? data.composer : {};
  return {
    composer: {
      activeSessionId: String(composer.activeSessionId || "workspace").trim() || "workspace",
      messages: normalizeConversationMessages(composer.messages, 100),
      runSessions: normalizeComposerRunSessionsForPersistence(composer.runSessions),
    },
    nodeChats: normalizeNodeChatSessionsForPersistence(data.nodeChats),
  };
}

function isWorkspaceImageFile(file) {
  if (!file) return false;
  const type = String(file.type || "");
  if (type && /^image\//i.test(type)) return true;
  const ext = String(file.name || "").toLowerCase().split(".").pop();
  return WORKSPACE_IMAGE_EXTENSIONS.has(ext);
}

function workspaceRawFileUrl(src, flowParams, opts = {}) {
  const text = String(src || "").trim();
  if (!text) return "";
  if (/^(?:https?:|data:|blob:|file:)/i.test(text) || text.startsWith("/")) return text;
  const q = flowParamsQuery(flowParams || {});
  q.set("path", text);
  if (opts.download) q.set("download", "1");
  return `/api/workspace/file/raw?${q.toString()}`;
}

function workspaceSkillsStorageKey(params) {
  const flowId = String(params?.flowId || "").trim();
  if (!flowId) return "";
  const flowSource = String(params?.flowSource || "user").trim() || "user";
  const adminOwner = String(params?.adminOwnerId || "").trim();
  return `af:composer-skills:workspace:${flowId}:${flowSource}${adminOwner ? `:admin:${adminOwner}` : ""}${params?.archived ? ":archived" : ""}`;
}

function workspaceSidebarCollapsedStorageKey(authUser) {
  const userKey = String(authUser?.username || authUser?.userId || "").trim();
  return userKey
    ? `${WORKSPACE_SIDEBAR_COLLAPSED_STORAGE_PREFIX}:${userKey}`
    : WORKSPACE_SIDEBAR_COLLAPSED_STORAGE_PREFIX;
}

function readWorkspaceSidebarCollapsed(key) {
  try {
    const saved = window.localStorage.getItem(key);
    if (saved === "false") return false;
    if (saved === "true") return true;
  } catch {
    /* ignore storage */
  }
  return true;
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
  if (isIgnorableWorkspaceRunStderr(line)) return "";
  if (/^运行完成/.test(line)) return "运行完成";
  if (/^运行暂停/.test(line)) return "运行暂停";
  if (/^运行停止/.test(line)) return "运行停止";
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

function isIgnorableWorkspaceRunStderr(line) {
  if (!/^\[stderr\]/.test(line)) return false;
  return (
    /Reading additional input from stdin/i.test(line) ||
    /rmcp::transport::worker/i.test(line) ||
    /Transport channel closed/i.test(line) ||
    /http\/request failed/i.test(line) ||
    /AuthRequiredError/i.test(line) ||
    /No access token was provided/i.test(line) ||
    /api\.githubcopilot\.com/i.test(line)
  );
}

function workspaceRunActivityKind(text) {
  const line = String(text || "").trim();
  if (!line) return "other";
  if (/^模型/.test(line)) return "model";
  if (/^(执行|完成|耗时)：/.test(line)) return "tool";
  if (/^运行/.test(line)) return "run";
  if (/^\[stderr\]/.test(line)) return "error";
  return "other";
}

function workspaceRunNodeAlias(nodes, instances, nodeId, fallback = "Workspace Run") {
  const id = String(nodeId || "").trim();
  const node = Array.isArray(nodes) ? nodes.find((item) => String(item?.id || "") === id) : null;
  const instance = instances && typeof instances === "object" ? instances[id] : null;
  const label = String(node?.data?.label || instance?.label || "").trim();
  return label || id || fallback;
}

function workspaceRunNameWithId(alias, nodeId, fallback = "Workspace Run") {
  const cleanAlias = String(alias || "").trim() || fallback;
  const cleanId = String(nodeId || "").trim();
  if (!cleanId || cleanAlias === cleanId) return cleanAlias;
  return `${cleanAlias} (${cleanId})`;
}

function formatWorkspaceRunDuration(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return `${value}ms`;
  if (value < 60_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1000);
  return `${minutes}m${seconds ? `${seconds}s` : ""}`;
}

function prdWorkflowPhaseLabel(phase) {
  const key = String(phase || "").trim().toLowerCase();
  const labels = {
    unselected: "未选择需求",
    unavailable: "未连接",
    json_unsupported: "待升级",
    command_failed: "读取失败",
    uninitialized: "未初始化",
    preflight_blocked: "环境阻塞",
    tech_design_missing: "缺技术方案",
    tech_design_draft_review: "方案待确认",
    tech_design_confirmed: "方案已确认",
    baseline_missing: "缺基线",
    plan_missing: "缺计划",
    plan_draft_review: "计划待确认",
    issue_binding_missing: "待绑定 Issue",
    ready_for_implementation: "待实现",
    implementation_ready: "待实现",
    implementing: "实现中",
    implementation_in_progress: "实现中",
    implementation_review: "实现待审",
    self_test_ready: "待自测",
    bugfix: "修 Bug",
    fix_ready: "待修复",
    fix_in_progress: "修复中",
    testing: "已提测",
    done: "完成",
    blocked: "阻塞",
    conflict: "冲突",
    requirement_changed: "需求变更",
  };
  return labels[key] || key || "未知";
}

function prdWorkflowFlowStepIndex(phase) {
  const key = String(phase || "").trim().toLowerCase();
  if (!key || ["unselected", "unavailable", "json_unsupported", "command_failed", "uninitialized", "preflight_blocked"].includes(key)) return -1;
  if (/done|complete|closed|finished/.test(key)) return 3;
  if (/bug|fix|testing|test|self_test|submit_test/.test(key)) return 2;
  if (/implement|development|ready_for_implementation|issue_binding|gitlab|mr/.test(key)) return 1;
  return 0;
}

function prdWorkflowFlowSteps(phase) {
  const current = prdWorkflowFlowStepIndex(phase);
  return ["方案确定", "开发", "Bug 修复", "完成"].map((label, index) => {
    let status = "pending";
    if (current > index) status = "done";
    else if (current === index) status = index === 3 ? "done" : "current";
    return { label, status };
  });
}

function prdWorkflowMilestoneStatus(status) {
  const s = String(status || "").trim().toLowerCase();
  if (["done", "success", "completed"].includes(s)) return "done";
  if (["current", "running", "active"].includes(s)) return "current";
  if (["blocked", "failed", "error"].includes(s)) return "blocked";
  return "pending";
}

function prdWorkflowActionLabel(action) {
  if (!action || typeof action !== "object") return "";
  return String(action.label || action.title || action.name || action.id || action.action || "").trim();
}

function prdWorkflowRequirementTitle(snapshot, tapdId = "") {
  const globalState = snapshot?.globalState && typeof snapshot.globalState === "object"
    ? snapshot.globalState
    : {};
  const requirement = snapshot?.overall?.requirement && typeof snapshot.overall.requirement === "object"
    ? snapshot.overall.requirement
    : {};
  const title = String(
    globalState.title
    || requirement.title
    || requirement.name
    || snapshot?.prd?.title
    || snapshot?.raw?.prd?.title
    || "",
  ).trim();
  return title || (tapdId ? `TAPD ${tapdId}` : "选择 TAPD 需求后读取状态");
}

function prdWorkflowNormalizeHref(href) {
  const clean = String(href || "").trim();
  if (!clean) return "";
  if ((clean.startsWith("/") && !clean.startsWith("//")) || clean.startsWith("#")) return clean;
  if (!/^https?:\/\//i.test(clean)) return "";
  try {
    const url = new URL(clean);
    if (url.hostname === "0.0.0.0" || url.hostname === "::" || url.hostname === "[::]") {
      const currentHost = window.location.hostname;
      url.hostname = currentHost && currentHost !== "0.0.0.0" && currentHost !== "::" ? currentHost : "127.0.0.1";
    }
    const workflowShare = String(new URLSearchParams(window.location.search).get("workflowShare") || "").trim();
    if (workflowShare && url.pathname.startsWith("/api/prd-workflow/review/") && !url.searchParams.has("workflowShare")) {
      url.searchParams.set("workflowShare", workflowShare);
    }
    return url.href;
  } catch (_) {
    return clean;
  }
}

function prdWorkflowArtifactHref(item) {
  const url = String(item?.url || item?.href || "").trim();
  if (url) return prdWorkflowNormalizeHref(url);
  const p = String(item?.path || "").trim();
  return p && /^https?:\/\//i.test(p) ? prdWorkflowNormalizeHref(p) : "";
}

function prdWorkflowActionStatus(status) {
  const s = String(status || "").trim().toLowerCase();
  if (["done", "success", "completed", "passed"].includes(s)) return "done";
  if (["current", "running", "active", "next"].includes(s)) return "current";
  if (["observed", "observation"].includes(s)) return "observed";
  if (["superseded", "stale", "replaced"].includes(s)) return "superseded";
  if (["blocked", "failed", "error", "conflict"].includes(s)) return "blocked";
  return "pending";
}

function prdWorkflowActionTruth(item) {
  if (!item || typeof item !== "object") return "";
  const explicit = String(item.truth || item.stateTruth || item.state_truth || "").trim().toLowerCase();
  if (explicit) return explicit;
  const idem = String(item.idempotencyKey || item.idempotency_key || "").trim();
  if (idem.startsWith("snapshot-action:")) return "observation";
  if (String(item.source || "") === "prd-flow-client" && String(item.type || "") === "workflow-action") return "observation";
  if (String(item.type || "") === "review-link") return "runtime_event";
  return "";
}

function prdWorkflowActionCountsAsDone(item) {
  return prdWorkflowActionStatus(item?.status) === "done" && prdWorkflowActionTruth(item) !== "observation";
}

function prdWorkflowActionTitle(item, index) {
  if (!item || typeof item !== "object") return `Action ${index + 1}`;
  return String(item.title || item.label || item.name || item.actionLabel || item.action_label || item.id || item.action || `Action ${index + 1}`);
}

function prdWorkflowActionDetail(item) {
  if (!item || typeof item !== "object") return "";
  return String(item.detail || item.content || item.description || item.summary || item.message || item.reason || "");
}

function prdWorkflowActionCodeText(item) {
  if (!item || typeof item !== "object") return "";
  return [
    item.code,
    item.action,
    item.actionId,
    item.action_id,
    item.stage,
    item.stageKey,
    item.stage_key,
    item.type,
    item.title,
  ].map((value) => String(value || "")).join(" ").toLowerCase();
}

function prdWorkflowActionIssueLabel(item, fallback = "当前任务") {
  const source = [
    item?.issueLabel,
    item?.issue_label,
    item?.title,
    item?.label,
    item?.name,
  ].map((value) => String(value || "")).join(" ");
  const match = source.match(/\b(Issue\d+|Bug\d+)\b/i);
  if (match) return match[1].replace(/^issue/i, "Issue").replace(/^bug/i, "Bug");
  return fallback;
}

function prdWorkflowActionDisplayTitle(item, index) {
  const title = prdWorkflowActionTitle(item, index);
  const explicitTitle = String(
    item?.title || item?.label || item?.name || item?.actionLabel || item?.action_label || "",
  ).trim();
  if (explicitTitle) return explicitTitle;
  const status = prdWorkflowActionStatus(item?.status);
  const durableDone = prdWorkflowActionCountsAsDone(item);
  const stage = prdWorkflowStageKey(item);
  const text = `${stage} ${prdWorkflowActionCodeText(item)}`;
  const label = prdWorkflowActionIssueLabel(item);
  if (/issue-plan:|plan_draft_local|submit-plan|plan-doc|plan_doc_confirmed/.test(text)) {
    if (durableDone) return `${label} 方案已确认`;
    if (status === "observed" || status === "superseded" || prdWorkflowActionTruth(item) === "observation") return `${label} 方案状态已观察`;
    if (status === "current" && /^确认\s+/.test(title)) return title;
  }
  if (/issue-gitlab:|gitlab_issue_missing|ensure-gitlab-issue/.test(text)) {
    if (durableDone) return `已为 ${label} 创建/绑定 GitLab Issue`;
    if (status === "observed" || status === "superseded" || prdWorkflowActionTruth(item) === "observation") return `${label} GitLab Issue 状态已观察`;
  }
  if (/implementation_in_progress|impl_in_progress/.test(text)) return `正在实现 ${label}`;
  if (/implementation_ready/.test(text)) return `可以开始实现 ${label}`;
  return title;
}

function prdWorkflowActionDisplayDetail(item) {
  if (!item || typeof item !== "object") return "";
  const raw = prdWorkflowActionDetail(item);
  if (raw) return raw;
  const status = prdWorkflowActionStatus(item.status);
  const truth = prdWorkflowActionTruth(item);
  const durableDone = prdWorkflowActionCountsAsDone(item);
  const stage = prdWorkflowStageKey(item);
  const text = `${stage} ${prdWorkflowActionCodeText(item)}`;
  const links = prdWorkflowActionLinks(item);
  const hasPlan = links.some((link) => /方案|plan|markdown|review|预览/i.test(String(link.label || "")));
  const hasGitlabIssue = links.some((link) => /gitlab issue/i.test(String(link.label || "")));
  const hasGitlabEpic = links.some((link) => /gitlab epic/i.test(String(link.label || "")));
  if (/issue-plan:|plan_draft_local|submit-plan|plan-doc|plan_doc_confirmed/.test(text)) {
    if (durableDone) {
      return hasPlan ? "方案已确认并归档；可从下方打开方案文档预览。" : "方案已确认并归档。";
    }
    if (truth === "observation" || status === "observed") return "客户端上报了当前方案阶段；这不是 ai-doc 确认结果。";
    if (status === "superseded") return "该客户端观察已被更新状态替代，仅保留为运行态记录。";
    if (status === "current") return "方案草稿已生成，等待确认；确认后会归档为正式方案。";
    return "方案草稿已生成，等待确认。";
  }
  if (/issue-gitlab:|gitlab_issue_missing|ensure-gitlab-issue/.test(text)) {
    if (durableDone) {
      if (hasGitlabIssue && hasGitlabEpic) return "GitLab Issue 和 Epic 已绑定；可从下方打开关联链接。";
      if (hasGitlabIssue) return "GitLab Issue 已绑定；可从下方打开关联链接。";
      return "GitLab Issue 绑定步骤已完成。";
    }
    if (truth === "observation" || status === "observed") return "客户端上报了 GitLab Issue 阶段；是否已绑定以 GitLab/ai-doc 事实为准。";
    if (status === "superseded") return "该客户端观察已被更新状态替代，仅保留为运行态记录。";
    return "方案文档已归档，等待创建或绑定 GitLab Issue。";
  }
  if (/implementation_in_progress|impl_in_progress/.test(text)) {
    return "需求分支已就绪，当前处于实现中；实现 MR 创建后会记录到本 Issue。";
  }
  if (/implementation_ready/.test(text)) {
    return "方案文档和 GitLab Issue 已就绪，等待开始实现。";
  }
  return "";
}

function prdWorkflowActionTime(item) {
  if (!item || typeof item !== "object") return "";
  return String(
    item.stageEnteredAt ||
    item.stage_entered_at ||
    item.time ||
    item.at ||
    item.observedAt ||
    item.observed_at ||
    item.reportedAt ||
    item.reported_at ||
    item.startedAt ||
    item.started_at ||
    item.completedAt ||
    item.completed_at ||
    item.updatedAt ||
    item.updated_at ||
    item.createdAt ||
    item.created_at ||
    "",
  );
}

const PRD_WORKFLOW_TIME_ZONE = "Asia/Shanghai";
const PRD_WORKFLOW_DATE_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: PRD_WORKFLOW_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});
const PRD_WORKFLOW_TIME_FORMATTER = new Intl.DateTimeFormat("zh-CN", {
  timeZone: PRD_WORKFLOW_TIME_ZONE,
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function prdWorkflowDateFromAction(item) {
  const raw = prdWorkflowActionTime(item);
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function prdWorkflowBeijingDateLabel(item) {
  const date = prdWorkflowDateFromAction(item);
  if (!date) return "无时间";
  return PRD_WORKFLOW_DATE_FORMATTER.format(date).replace(/\//g, "-");
}

function prdWorkflowBeijingTimeLabel(item) {
  const date = prdWorkflowDateFromAction(item);
  if (!date) return "";
  return PRD_WORKFLOW_TIME_FORMATTER.format(date);
}

function prdWorkflowActionDayGroups(rows = []) {
  const groups = [];
  (Array.isArray(rows) ? rows : []).forEach((item, index) => {
    const day = prdWorkflowBeijingDateLabel(item);
    let group = groups[groups.length - 1];
    if (!group || group.day !== day) {
      group = { day, items: [] };
      groups.push(group);
    }
    group.items.push({ item, index });
  });
  return groups;
}

function prdWorkflowActionStatusText(status) {
  const normalized = prdWorkflowActionStatus(status);
  if (normalized === "done") return "完成";
  if (normalized === "current") return "当前";
  if (normalized === "observed") return "已观察";
  if (normalized === "superseded") return "已更新";
  if (normalized === "blocked") return "阻塞";
  return "待处理";
}

function prdWorkflowPlatformLabel(platform) {
  const value = String(platform || "").trim();
  const normalized = value.toLowerCase();
  if (normalized === "android") return "Android";
  if (normalized === "ios") return "iOS";
  if (["all", "both", "cross-platform", "cross_platform"].includes(normalized)) return "双端";
  return value;
}

function prdWorkflowActionDisplayStatus(item) {
  const status = prdWorkflowActionStatus(item?.status);
  if (prdWorkflowActionTruth(item) === "observation" && status === "done") return "已观察";
  return prdWorkflowActionStatusText(status);
}

function prdWorkflowActionTagEntries(item) {
  if (!item || typeof item !== "object") return [];
  const out = [];
  const push = (type, label, value) => {
    const text = String(value || "").trim();
    if (!text) return;
    out.push({ key: `${type}:${text}`, type, label: String(label || text), value: text });
  };
  const status = prdWorkflowActionStatus(item.status);
  const tagStatus = prdWorkflowActionTruth(item) === "observation" && status === "done" ? "observed" : status;
  push("status", prdWorkflowActionStatusText(tagStatus), tagStatus);
  push("issue", item.issueKey || item.issue_key || item.issue, item.issueKey || item.issue_key || item.issue);
  push("platform", prdWorkflowPlatformLabel(item.platform), item.platform);
  return out;
}

function prdWorkflowActionFilterTags(rows = []) {
  const seen = new Map();
  (Array.isArray(rows) ? rows : []).forEach((item) => {
    prdWorkflowActionTagEntries(item).forEach((tag) => {
      const prev = seen.get(tag.key);
      seen.set(tag.key, { ...tag, count: (prev?.count || 0) + 1 });
    });
  });
  return Array.from(seen.values()).sort((a, b) => {
    const order = { status: 0, issue: 1, platform: 2, source: 3, actor: 4 };
    return (order[a.type] ?? 9) - (order[b.type] ?? 9) || b.count - a.count || a.label.localeCompare(b.label);
  });
}

function prdWorkflowActionMatchesFilter(item, filterKey) {
  const key = String(filterKey || "all");
  if (!key || key === "all") return true;
  return prdWorkflowActionTagEntries(item).some((tag) => tag.key === key);
}

function prdWorkflowActionMeta(item) {
  if (!item || typeof item !== "object") return [];
  const out = [];
  const push = (label, value) => {
    const text = String(value || "").trim();
    if (!text) return;
    out.push({ label, value: text });
  };
  push("Issue", item.issueKey || item.issue_key || item.issue);
  push("平台", prdWorkflowPlatformLabel(item.platform));
  return out;
}

function prdWorkflowActionLinks(item) {
  const out = [];
  const push = (label, href, metadata = {}) => {
    const cleanHref = prdWorkflowNormalizeHref(href);
    if (!cleanHref) return;
    out.push({
      ...metadata,
      label: String(label || cleanHref).trim() || cleanHref,
      href: cleanHref,
    });
  };
  const collect = (value, labelHint = "链接", depth = 0) => {
    if (depth > 3 || value == null) return;
    if (typeof value === "string") {
      if (/^(https?:\/\/|file:\/\/)/i.test(value) || value.startsWith("/")) push(labelHint, value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((entry, index) => collect(entry, `${labelHint} ${index + 1}`, depth + 1));
      return;
    }
    if (typeof value !== "object") return;
    const label = value.label || value.title || value.name || value.kind || value.type || labelHint;
    push(
      label,
      value.url || value.href || value.path || value.file || value.filePath || value.file_path,
      value,
    );
    for (const key of ["links", "urls", "artifacts", "outputs", "output", "results", "result", "files"]) {
      if (value[key] != null) collect(value[key], key, depth + 1);
    }
  };
  const links = Array.isArray(item?.links) ? item.links : [];
  for (const link of links) {
    if (typeof link === "string") push("链接", link);
    else push(link?.label || link?.title || link?.kind || "链接", link?.url || link?.href, link);
  }
  for (const artifact of Array.isArray(item?.artifacts) ? item.artifacts : []) {
    push(
      artifact?.label || artifact?.title || artifact?.kind || "Artifact",
      prdWorkflowArtifactHref(artifact),
      artifact,
    );
  }
  push("TAPD", item?.tapdUrl || item?.tapd_url);
  push("ai-doc", item?.docUrl || item?.doc_url || item?.aiDocUrl || item?.ai_doc_url);
  push("Plan", item?.planDocUrl || item?.plan_doc_url || item?.planUrl || item?.plan_url);
  push("Issue", item?.issueUrl || item?.issue_url);
  push("GitLab Issue", item?.gitlabIssue || item?.gitlab_issue);
  push("GitLab Epic", item?.gitlabEpic || item?.gitlab_epic);
  push("MR", item?.mrUrl || item?.mr_url || item?.mergeRequestUrl || item?.merge_request_url);
  push("实现 MR", item?.implMr || item?.impl_mr);
  push("修复 MR", item?.fixMr || item?.fix_mr);
  push("提测 MR", item?.testMr || item?.test_mr);
  push("集成 MR", item?.integrationMr || item?.integration_mr);
  push("Jenkins", item?.jenkinsUrl || item?.jenkins_url || item?.jenkinsBuildUrl || item?.jenkins_build_url);
  push("安装包", item?.jenkinsPackageUrl || item?.jenkins_package_url);
  push("二维码", item?.jenkinsQrUrl || item?.jenkins_qr_url);
  push("调整", item?.editUrl || item?.edit_url || item?.adjustUrl || item?.adjust_url);
  push("链接", item?.url || item?.href);
  collect(item?.urls, "URL");
  collect(item?.outputs, "产物");
  collect(item?.output, "产物");
  collect(item?.results, "结果");
  collect(item?.result, "结果");
  collect(item?.files, "文件");
  return selectCurrentPrdWorkflowActionLinks(out, item);
}

function prdWorkflowAiDocLinks(snapshot, actionRows = []) {
  const candidates = [];
  const issueTitleByKey = new Map();
  const requirementTitle = String(
    snapshot?.overall?.requirement?.title
    || snapshot?.overall?.requirement?.name
    || "",
  ).trim();
  for (const issue of prdWorkflowFlattenIssuesFromSnapshot(snapshot)) {
    const issueKey = prdWorkflowIssueKey(issue);
    const issueTitle = String(issue?.title || issue?.name || issue?.summary || "").trim();
    if (issueKey && issueTitle) issueTitleByKey.set(issueKey, issueTitle);
  }
  const collect = (item, context = {}) => {
    if (!item || typeof item !== "object") return;
    const pushCandidate = (link, linkContext = {}) => {
      if (!link || typeof link !== "object") return;
      const issueKey = String(context.issueKey || item?.issueKey || item?.issue_key || item?.issue || "").trim();
      const source = link.source
        || link.sourceArtifact
        || link.source_artifact
        || item.sourceArtifact
        || item.source_artifact
        || item.source
        || context.source
        || null;
      const candidateTitle = aiDocArticleTitle({
        ...link,
        title: link.title || context.documentTitle || item?.title || "",
        documentTitle: link.documentTitle
          || link.document_title
          || item?.documentTitle
          || item?.document_title
          || "",
      }, {
        issueTitle: issueTitleByKey.get(issueKey) || "",
        requirementTitle,
      });
      const candidate = {
        label: String(link.label || "ai-doc").trim() || "ai-doc",
        href: String(link.href || link.url || "").trim(),
        kind: String(link.kind || link.type || item.kind || item.type || "").trim(),
        title: candidateTitle,
        issueKey,
        platform: context.platform || prdWorkflowPlatformLabel(item.platform),
        durability: link.durability || item.durability || context.durability || "",
        persistence: link.persistence || item.persistence || context.persistence || "",
        truth: link.truth || link.stateTruth || link.state_truth || prdWorkflowActionTruth(item) || context.truth || "",
        authority: link.authority || item.authority || context.authority || "",
        confirmed: link.confirmed ?? item.confirmed ?? context.confirmed,
        source,
        documentPath: link.documentPath
          || link.document_path
          || link.path
          || linkContext.documentPath
          || source?.path
          || source?.documentPath
          || source?.document_path
          || "",
      };
      if (candidate.href) candidates.push(candidate);
    };
    for (const artifact of Array.isArray(item?.artifacts) ? item.artifacts : []) {
      if (!artifact || typeof artifact !== "object") continue;
      pushCandidate({
        ...artifact,
        label: artifact.label || artifact.title || artifact.kind || "ai-doc",
        href: prdWorkflowArtifactHref(artifact),
      }, { documentPath: artifact.path });
    }
    for (const link of Array.isArray(item?.links) ? item.links : []) {
      if (!link || typeof link !== "object") continue;
      pushCandidate({
        ...link,
        label: link.label || link.title || link.kind || "ai-doc",
        href: prdWorkflowArtifactHref(link),
      }, { documentPath: link.path });
    }
    const directHref = prdWorkflowArtifactHref(item);
    if (directHref) {
      pushCandidate({
        ...item,
        label: item.label || item.title || item.kind || "ai-doc",
        href: directHref,
      }, { documentPath: item.path });
    }
  };
  collect(snapshot);
  for (const item of Array.isArray(actionRows) ? actionRows : []) {
    collect(item, {
      issueKey: String(item?.issueKey || item?.issue_key || item?.issue || "").trim(),
      platform: prdWorkflowPlatformLabel(item?.platform),
      documentTitle: String(item?.documentTitle || item?.document_title || item?.title || "").trim(),
    });
  }
  for (const key of ["actions", "workflowActions", "workflow_actions", "timeline", "history", "events", "runtimeEvents", "runtime_events"]) {
    for (const item of Array.isArray(snapshot?.[key]) ? snapshot[key] : []) {
      collect(item, {
        issueKey: String(item?.issueKey || item?.issue_key || item?.issue || "").trim(),
        platform: prdWorkflowPlatformLabel(item?.platform),
        documentTitle: String(item?.documentTitle || item?.document_title || item?.title || "").trim(),
      });
    }
  }
  for (const issue of prdWorkflowFlattenIssuesFromSnapshot(snapshot)) {
    collect(issue, {
      issueKey: prdWorkflowIssueKey(issue),
      platform: prdWorkflowPlatformLabel(issue?.platform),
      documentTitle: String(issue?.title || issue?.name || issue?.summary || "").trim(),
    });
  }
  const prdFlowExtension = snapshot?.extensions?.["prd-flow"] && typeof snapshot.extensions["prd-flow"] === "object"
    ? snapshot.extensions["prd-flow"]
    : {};
  for (const item of [
    ...(Array.isArray(snapshot?.aiDocs) ? snapshot.aiDocs : []),
    ...(Array.isArray(snapshot?.ai_docs) ? snapshot.ai_docs : []),
    ...(Array.isArray(prdFlowExtension.aiDocs) ? prdFlowExtension.aiDocs : []),
    ...(Array.isArray(prdFlowExtension.ai_docs) ? prdFlowExtension.ai_docs : []),
  ]) {
    collect(item, {
      issueKey: String(item?.issueKey || item?.issue_key || "").trim(),
      platform: prdWorkflowPlatformLabel(item?.platform),
      documentTitle: String(item?.title || item?.label || "").trim(),
    });
  }
  return dedupeConfirmedAiDocs(candidates, window.location.origin);
}

function prdWorkflowActionPayloadExtras(item) {
  if (!item || typeof item !== "object") return {};
  return {
    marker: item.marker || item.flag || "",
    command: item.command || item.nextCommand || item.next_command || "",
    runtimeOnly: item.runtimeOnly === true || item.runtime_only === true,
    markerOnly: item.markerOnly === true || item.marker_only === true,
    url: item.url || item.href || item.mrUrl || item.mr_url || item.mergeRequestUrl || item.merge_request_url || "",
    mr: item.mr || item.mrUrl || item.mr_url || item.mergeRequestUrl || item.merge_request_url || "",
    testEnv: item.testEnv || item.test_environment || "",
    summary: item.summary || item.detail || item.description || "",
    links: Array.isArray(item.links) ? item.links : [],
    artifacts: Array.isArray(item.artifacts) ? item.artifacts : [],
    outputs: Array.isArray(item.outputs) ? item.outputs : [],
    results: Array.isArray(item.results) ? item.results : [],
  };
}

function prdWorkflowIssueKey(item, index = 0) {
  return String(item?.key || item?.issueKey || item?.issue_key || item?.id || item?.iid || item?.title || `issue-${index + 1}`).trim();
}

function prdWorkflowIssueTitle(item, index = 0) {
  return String(item?.title || item?.name || item?.label || item?.summary || prdWorkflowIssueKey(item, index) || `Issue ${index + 1}`).trim();
}

function prdWorkflowIssueEpicKey(item) {
  return String(item?.epicKey || item?.epic_key || item?.epic || item?.epicTitle || item?.epic_title || item?.parentEpic || item?.parent_epic || "未归类").trim();
}

function prdWorkflowIssueParentKey(item) {
  return String(
    item?.sourceIssue
    || item?.source_issue
    || item?.parentKey
    || item?.parent_key
    || item?.parent
    || item?.parentIssue
    || item?.parent_issue
    || "",
  ).trim();
}

function prdWorkflowIssueLinks(item) {
  const links = prdWorkflowActionLinks(item);
  const pushList = (list, fallbackLabel) => {
    if (!Array.isArray(list)) return;
    for (const entry of list) {
      if (!entry) continue;
      if (typeof entry === "string") {
        links.push({ label: fallbackLabel, href: entry });
      } else {
        const href = entry.url || entry.href || entry.webUrl || entry.web_url || entry.mrUrl || entry.mr_url || entry.issueUrl || entry.issue_url;
        if (href) links.push({ label: entry.label || entry.title || entry.platform || entry.kind || fallbackLabel, href });
      }
    }
  };
  pushList(item?.mrs, "MR");
  pushList(item?.mergeRequests, "MR");
  pushList(item?.merge_requests, "MR");
  pushList(item?.implMrs, "MR");
  pushList(item?.impl_mrs, "MR");
  pushList(item?.platformMrs, "MR");
  pushList(item?.platform_mrs, "MR");
  const seen = new Set();
  return links.filter((link) => {
    const href = String(link.href || "").trim();
    if (!href) return false;
    const key = `${link.label}\n${href}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function prdWorkflowIssueGroups(snapshot) {
  const directEpics = Array.isArray(snapshot?.epics) ? snapshot.epics : Array.isArray(snapshot?.epicGroups) ? snapshot.epicGroups : Array.isArray(snapshot?.epic_groups) ? snapshot.epic_groups : [];
  const flatIssues = [];
  const groups = new Map();
  const ensureGroup = (key, title = "") => {
    const cleanKey = String(key || "未归类").trim() || "未归类";
    if (!groups.has(cleanKey)) {
      groups.set(cleanKey, { key: cleanKey, title: String(title || cleanKey), issues: [] });
    } else if (title && groups.get(cleanKey).title === cleanKey) {
      groups.get(cleanKey).title = String(title);
    }
    return groups.get(cleanKey);
  };
  for (const epic of directEpics) {
    const key = String(epic?.key || epic?.id || epic?.title || epic?.name || "未归类").trim();
    const group = ensureGroup(key, epic?.title || epic?.name || key);
    const list = Array.isArray(epic?.issues) ? epic.issues : Array.isArray(epic?.children) ? epic.children : Array.isArray(epic?.items) ? epic.items : [];
    for (const issue of list) {
      if (issue && typeof issue === "object") group.issues.push({ ...issue, epicKey: key });
    }
  }
  for (const item of Array.isArray(snapshot?.issues) ? snapshot.issues : []) {
    if (item && typeof item === "object") flatIssues.push(item);
  }
  for (const item of flatIssues) {
    ensureGroup(prdWorkflowIssueEpicKey(item)).issues.push(item);
  }
  const buildIssueTree = (list) => {
    const byKey = new Map();
    const rows = [];
    const availableKeys = list.map((issue, index) => prdWorkflowIssueKey(issue, index));
    list.forEach((issue, index) => {
      const key = prdWorkflowIssueKey(issue, index);
      byKey.set(key, { issue, children: [] });
    });
    list.forEach((issue, index) => {
      const key = prdWorkflowIssueKey(issue, index);
      const parent = prdWorkflowIssueParentKey(issue) || workflowIssueParentKey(issue, availableKeys);
      const row = byKey.get(key);
      if (parent && byKey.has(parent)) byKey.get(parent).children.push(row);
      else rows.push(row);
    });
    return rows;
  };
  return Array.from(groups.values()).map((group) => ({
    ...group,
    issues: buildIssueTree(group.issues),
  }));
}

function prdWorkflowActionId(item) {
  return String(item?.actionId || item?.action_id || item?.action || item?.id || "").trim();
}

function prdWorkflowChecklistActionKey(item) {
  return String(item?.actionModel?.key || item?.key || item?.actionKey || item?.action_key || item?.action || item?.actionId || item?.action_id || item?.stageKey || item?.stage_key || "").trim();
}

function prdWorkflowChecklistStatusIcon(status) {
  const value = String(status || "pending");
  if (value === "passed") return "check";
  if (value === "failed") return "close";
  if (value === "blocked") return "block";
  if (value === "skipped") return "skip_next";
  return "radio_button_unchecked";
}

function prdWorkflowStageKey(item) {
  return canonicalPrdWorkflowStageKey(item);
}

function prdWorkflowActionSortTime(item) {
  const time = prdWorkflowActionTime(item) ||
    String(item?.startedAt || item?.started_at || item?.createdAt || item?.created_at || item?.updatedAt || item?.updated_at || "");
  const ts = Date.parse(time);
  return Number.isFinite(ts) ? ts : NaN;
}

function prdWorkflowFlattenIssuesFromSnapshot(snapshot) {
  const out = [];
  const visitIssue = (issue) => {
    if (issue && typeof issue === "object" && !Array.isArray(issue)) out.push(issue);
  };
  const visitGroup = (group) => {
    if (!group || typeof group !== "object" || Array.isArray(group)) return;
    const list = Array.isArray(group.issues) ? group.issues : Array.isArray(group.children) ? group.children : Array.isArray(group.items) ? group.items : [];
    for (const item of list) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      if (item.issue && typeof item.issue === "object") {
        visitIssue(item.issue);
        if (Array.isArray(item.children)) item.children.forEach((child) => visitIssue(child?.issue || child));
      } else {
        visitIssue(item);
      }
    }
  };
  [
    snapshot?.issues,
    snapshot?.raw?.issues,
    snapshot?.raw?.prd?.issues,
  ].forEach((list) => {
    if (Array.isArray(list)) list.forEach(visitIssue);
  });
  [
    snapshot?.epics,
    snapshot?.epicGroups,
    snapshot?.epic_groups,
    snapshot?.raw?.epics,
    snapshot?.raw?.epicGroups,
    snapshot?.raw?.epic_groups,
    snapshot?.raw?.prd?.epics,
    snapshot?.raw?.prd?.epicGroups,
    snapshot?.raw?.prd?.epic_groups,
  ].forEach((list) => {
    if (Array.isArray(list)) list.forEach(visitGroup);
  });
  return out;
}

function prdWorkflowFindSnapshotIssue(snapshot, issueKey) {
  const key = String(issueKey || "").trim();
  if (!key) return null;
  return prdWorkflowFlattenIssuesFromSnapshot(snapshot).find((issue, index) => prdWorkflowIssueKey(issue, index) === key) || null;
}

function prdWorkflowSnapshotGitlabEpic(snapshot) {
  return String(
    snapshot?.gitlabEpic ||
    snapshot?.gitlab_epic ||
    snapshot?.prd?.gitlabEpic ||
    snapshot?.prd?.gitlab_epic ||
    snapshot?.raw?.gitlabEpic ||
    snapshot?.raw?.gitlab_epic ||
    snapshot?.raw?.prd?.gitlabEpic ||
    snapshot?.raw?.prd?.gitlab_epic ||
    "",
  ).trim();
}

function prdWorkflowEnrichActionWithSnapshotFacts(snapshot, item) {
  if (!item || typeof item !== "object") return item;
  const issueKey = String(item.issueKey || item.issue_key || item.issue || "").trim();
  const issue = prdWorkflowFindSnapshotIssue(snapshot, issueKey);
  const platform = String(item.platform || issue?.platform || "").trim();
  const enrichedItem = platform && !item.platform ? { ...item, platform } : item;
  const gitlabIssue = String(issue?.gitlabIssue || issue?.gitlab_issue || enrichedItem.gitlabIssue || enrichedItem.gitlab_issue || "").trim();
  const gitlabEpic = prdWorkflowSnapshotGitlabEpic(snapshot);
  if (!gitlabIssue && !gitlabEpic) return enrichedItem;
  const stage = prdWorkflowStageKey(enrichedItem);
  const stageText = `${stage} ${prdWorkflowActionCodeText(enrichedItem)}`;
  const shouldAttachGitlabArtifacts = /issue-gitlab:|gitlab_issue_missing|ensure-gitlab-issue|implementation|impl_|fix_|testing|submit-test|self-test/i.test(stageText);
  if (!shouldAttachGitlabArtifacts) return enrichedItem;
  const artifacts = [];
  if (gitlabIssue) {
    artifacts.push({
      key: `gitlab-issue:${issueKey}:${(platform || "all").toLowerCase()}`,
      label: "GitLab Issue",
      kind: "gitlab-issue",
      durability: "durable",
      url: gitlabIssue,
    });
  }
  if (gitlabEpic) {
    artifacts.push({
      key: "gitlab-epic:requirement",
      label: "GitLab Epic",
      kind: "gitlab-epic",
      durability: "durable",
      url: gitlabEpic,
    });
  }
  const status = prdWorkflowActionStatus(enrichedItem.status);
  const shouldRetitle = gitlabIssue && status === "done" && /^issue-gitlab:/.test(stage) && /需要.*GitLab Issue/.test(String(enrichedItem.title || enrichedItem.label || ""));
  return {
    ...enrichedItem,
    ...(shouldRetitle ? {
      title: String(enrichedItem.title || enrichedItem.label || "GitLab Issue 已绑定")
        .replace(/^需要为/, "已为")
        .replace("创建或绑定", "创建/绑定"),
      label: String(enrichedItem.label || enrichedItem.title || "GitLab Issue 已绑定")
        .replace(/^需要为/, "已为")
        .replace("创建或绑定", "创建/绑定"),
    } : {}),
    artifacts: mergePrdWorkflowActionLists(enrichedItem.artifacts, artifacts),
  };
}

function prdWorkflowMergeActionRecord(prev, next) {
  const nextTime = prdWorkflowActionSortTime(next);
  const prevTime = prdWorkflowActionSortTime(prev);
  const latest = Number.isFinite(nextTime) && (!Number.isFinite(prevTime) || nextTime >= prevTime) ? next : prev;
  const status = latest?.status || next?.status || prev?.status;
  return {
    ...prev,
    ...next,
    title: prdWorkflowActionTitle(latest, 0) || prdWorkflowActionTitle(next, 0) || prdWorkflowActionTitle(prev, 0),
    detail: prdWorkflowActionDetail(latest) || prdWorkflowActionDetail(next) || prdWorkflowActionDetail(prev),
    status,
    links: mergePrdWorkflowActionLists(prev?.links, next?.links),
    artifacts: mergePrdWorkflowActionLists(prev?.artifacts, next?.artifacts),
    outputs: mergePrdWorkflowActionLists(prev?.outputs, next?.outputs),
    results: mergePrdWorkflowActionLists(prev?.results, next?.results),
    events: mergePrdWorkflowActionLists(prev?.events, next?.events),
    createdAt: prev?.createdAt || prev?.created_at || next?.createdAt || next?.created_at,
    startedAt: prev?.startedAt || prev?.started_at || next?.startedAt || next?.started_at,
    updatedAt: latest?.updatedAt || latest?.updated_at || next?.updatedAt || next?.updated_at || prev?.updatedAt || prev?.updated_at,
  };
}

function prdWorkflowActionRows(snapshot, nextAction) {
  const rows = [];
  const seenByStage = new Map();
  const seenById = new Map();
  const pendingExtrasByStage = new Map();
  const shouldSkipRow = (item) => {
    if (!item || typeof item !== "object") return true;
    if (item.auxiliary === true || item.auxiliary_event === true) return true;
    if (isPrdWorkflowGlobalEvent(item)) return true;
    if (String(item.type || "") === "review-link") return true;
    if (String(item.type || "") === "action-preview" || item.preview === true) return true;
    if (
      String(item.type || "") === "same-platform-stage-conflict" &&
      /\/api\/prd-workflow\/review\//.test(String(item.conflict?.previousArtifact || item.conflict?.incomingArtifact || ""))
    ) {
      return true;
    }
    return false;
  };
  const mergeOnlyExtras = (base, extras) => ({
    ...base,
    links: mergePrdWorkflowActionLists(base?.links, extras?.links),
    artifacts: mergePrdWorkflowActionLists(base?.artifacts, extras?.artifacts),
    outputs: mergePrdWorkflowActionLists(base?.outputs, extras?.outputs),
    results: mergePrdWorkflowActionLists(base?.results, extras?.results),
  });
  const rememberExtras = (stageKey, item) => {
    if (!stageKey) return;
    const index = seenByStage.get(stageKey);
    if (index != null) {
      rows[index] = mergeOnlyExtras(rows[index], item);
      return;
    }
    pendingExtrasByStage.set(stageKey, mergeOnlyExtras(pendingExtrasByStage.get(stageKey) || {}, item));
  };
  const applyPendingExtras = (stageKey, item) => (
    stageKey && pendingExtrasByStage.has(stageKey)
      ? mergeOnlyExtras(item, pendingExtrasByStage.get(stageKey))
      : item
  );
  const addRows = (list) => {
    if (!Array.isArray(list)) return;
    for (const item of list) {
      const stageKey = prdWorkflowStageKey(item);
      if (shouldSkipRow(item)) {
        rememberExtras(stageKey, item);
        continue;
      }
      const idKey = String(item.id || item.eventId || item.event_id || item.actionId || item.action_id || "").trim();
      const key = stageKey || idKey;
      const index = key ? (seenByStage.get(key) ?? seenById.get(idKey)) : null;
      if (key && index != null) {
        rows[index] = applyPendingExtras(stageKey, prdWorkflowMergeActionRecord(rows[index], item));
        if (stageKey) seenByStage.set(stageKey, index);
        if (idKey) seenById.set(idKey, index);
      } else {
        if (key) seenByStage.set(key, rows.length);
        if (idKey) seenById.set(idKey, rows.length);
        rows.push(applyPendingExtras(stageKey, item));
      }
    }
  };
  addRows(snapshot?.actions);
  addRows(snapshot?.workflowActions);
  addRows(snapshot?.workflow_actions);
  addRows(snapshot?.timeline);
  addRows(snapshot?.history);
  addRows(snapshot?.events);
  addRows(snapshot?.runtimeEvents);
  addRows(snapshot?.runtime_events);
  if (nextAction && typeof nextAction === "object") {
    const nextId = prdWorkflowActionId(nextAction);
    const nextStage = prdWorkflowStageKey(nextAction);
    const index = nextStage ? seenByStage.get(nextStage) : nextId ? seenById.get(nextId) : null;
    const nextRow = { ...nextAction, status: nextAction.status || "next", kind: "next_action" };
    if (index != null) rows[index] = prdWorkflowMergeActionRecord(rows[index], nextRow);
  }
  return rows
    .map((item, index) => ({ item, index, ts: prdWorkflowActionSortTime(item) }))
    .filter((entry) => Number.isFinite(entry.ts))
    .sort((a, b) => {
      return b.ts - a.ts || a.index - b.index;
    })
    .map((entry) => prdWorkflowEnrichActionWithSnapshotFacts(snapshot, entry.item));
}

function prdWorkflowRuntimeAuditRows(snapshot) {
  const runtimeRows = Array.isArray(snapshot?.runtimeEvents)
    ? snapshot.runtimeEvents
    : Array.isArray(snapshot?.runtime_events)
      ? snapshot.runtime_events
      : [];
  const snapshotRows = Array.isArray(snapshot?.snapshotAudit)
    ? snapshot.snapshotAudit
    : Array.isArray(snapshot?.snapshot_audit)
      ? snapshot.snapshot_audit
      : [];
  const rows = [...runtimeRows, ...snapshotRows];
  return rows
    .filter((item) => item && typeof item === "object")
    .map((item, index) => ({ item, index, ts: prdWorkflowActionSortTime(item) }))
    .sort((a, b) => {
      const at = Number.isFinite(a.ts);
      const bt = Number.isFinite(b.ts);
      if (at && bt) return b.ts - a.ts || b.index - a.index;
      if (at) return -1;
      if (bt) return 1;
      return b.index - a.index;
    })
    .slice(0, 8)
    .map((entry) => entry.item);
}

function prdWorkflowAuditMatchesFilter(item, filter) {
  const f = String(filter || "all");
  if (f === "all") return true;
  const text = [
    item?.status,
    item?.type,
    item?.kind,
    item?.title,
    item?.detail,
    item?.error,
    JSON.stringify(item?.links || []),
    JSON.stringify(item?.artifacts || []),
  ].join(" ").toLowerCase();
  if (f === "errors") return /error|failed|conflict|blocked|stale|revision|冲突|失败/.test(text);
  if (f === "review") return /review|temporary-review|临时/.test(text);
  if (f === "external") return /mr|merge request|gitlab|jenkins|package|build|tapd/.test(text);
  return true;
}

function workspaceRunActivityLine(item, index) {
  const text = typeof item === "string" ? item : String(item?.text || "");
  const stepMs = typeof item === "object" ? Number(item?.stepMs) : NaN;
  const totalMs = typeof item === "object" ? Number(item?.totalMs) : NaN;
  const timing = Number.isFinite(stepMs) && Number.isFinite(totalMs)
    ? `（+${formatWorkspaceRunDuration(stepMs)} / 总 ${formatWorkspaceRunDuration(totalMs)}）`
    : "";
  return `${index + 1}. ${text}${timing}`;
}

function parseWorkspaceRunRawJson(event) {
  if (String(event?.type || "") !== "raw") return null;
  const rawText = String(event?.text || "").trim();
  if (!rawText) return null;
  try {
    return JSON.parse(rawText);
  } catch {
    return null;
  }
}

function firstFiniteWorkspaceRunNumber(...values) {
  for (const value of values) {
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return NaN;
}

function workspaceRunToolCallName(parsed) {
  const call = parsed?.tool_call && typeof parsed.tool_call === "object" ? parsed.tool_call : {};
  const key = Object.keys(call).find((item) => /ToolCall$/i.test(item)) || "";
  if (key) return key;
  return String(parsed?.name || parsed?.tool || "tool_call");
}

function workspaceRunToolCallPayload(parsed) {
  const call = parsed?.tool_call && typeof parsed.tool_call === "object" ? parsed.tool_call : {};
  const key = Object.keys(call).find((item) => /ToolCall$/i.test(item)) || "";
  return key && call[key] && typeof call[key] === "object" ? call[key] : {};
}

function workspaceRunToolLabel(name, payload) {
  const command = String(payload?.args?.command || "");
  if (/ck_fetch\.py/.test(command)) return "CK 查询";
  if (/collect_important_mails\.py|list_mails_by_date\.py|read_mail_content\.py/.test(command)) return "邮件脚本";
  if (/npm\s+run\s+build|build:web-ui/.test(command)) return "前端构建";
  if (/python3/.test(command)) return "Python 脚本";
  const map = {
    shellToolCall: "Shell 命令",
    readToolCall: "读取文件/上下文",
    grepToolCall: "搜索代码",
    globToolCall: "查找文件",
    editToolCall: "编辑文件",
    writeToolCall: "写入文件",
  };
  return map[name] || name || "工具调用";
}

function workspaceRunRawTimingEntry(event) {
  const parsed = parseWorkspaceRunRawJson(event);
  if (!parsed || typeof parsed !== "object") return null;
  const type = String(parsed.type || "");
  const subtype = String(parsed.subtype || "");
  const at = firstFiniteWorkspaceRunNumber(parsed.timestamp_ms, parsed.completedAtMs, parsed.startedAtMs, event?.ts, Date.now());
  if (type === "tool_call" && subtype === "completed") {
    const payload = workspaceRunToolCallPayload(parsed);
    const name = workspaceRunToolCallName(parsed);
    const startedAt = firstFiniteWorkspaceRunNumber(parsed.startedAtMs, payload?.startedAtMs);
    const completedAt = firstFiniteWorkspaceRunNumber(parsed.completedAtMs, payload?.completedAtMs);
    const result = payload?.result?.success || payload?.result?.failure || {};
    const durationMs = Number.isFinite(startedAt) && Number.isFinite(completedAt)
      ? Math.max(0, completedAt - startedAt)
      : firstFiniteWorkspaceRunNumber(result.executionTime, result.localExecutionTimeMs);
    const command = String(payload?.args?.command || result.command || "").trim();
    const commandLine = command ? command.split("\n").find(Boolean) || command : "";
    return {
      kind: "tool",
      label: workspaceRunToolLabel(name, payload),
      durationMs: Number.isFinite(durationMs) ? durationMs : null,
      at,
      detail: commandLine ? commandLine.slice(0, 90) : "",
    };
  }
  if (type === "result") {
    const durationMs = firstFiniteWorkspaceRunNumber(parsed.duration_ms, parsed.duration_api_ms);
    return {
      kind: "total",
      label: "运行总耗时",
      durationMs: Number.isFinite(durationMs) ? durationMs : null,
      at,
      detail: parsed.is_error ? "失败结束" : "成功结束",
    };
  }
  if (type === "connection") {
    const label = subtype === "reconnecting" ? "连接重连" : subtype === "reconnected" ? "连接恢复" : "连接事件";
    return { kind: "network", label, durationMs: null, at, detail: "" };
  }
  if (type === "retry") {
    const label = subtype === "resuming" ? "会话恢复" : subtype === "starting" ? "开始重试" : "重试事件";
    return { kind: "network", label, durationMs: null, at, detail: "" };
  }
  return null;
}

function workspaceRunActivityMessageText(activities, timingEntries, startedAt, lastAt) {
  const activityItems = (Array.isArray(activities) ? activities : [])
    .map((item) => (typeof item === "string" ? { text: item } : item))
    .filter((item) => item && String(item.text || "").trim());
  const timingItems = Array.isArray(timingEntries) ? timingEntries : [];
  const explicitTotal = [...timingItems].reverse().find((item) => item?.kind === "total" && Number.isFinite(Number(item.durationMs)));
  const activityTotal = [...activityItems].reverse().find((item) => Number.isFinite(Number(item.totalMs)));
  const inferredTotal = Number.isFinite(Number(lastAt)) && Number.isFinite(Number(startedAt))
    ? Math.max(0, Number(lastAt) - Number(startedAt))
    : NaN;
  const totalMs = firstFiniteWorkspaceRunNumber(explicitTotal?.durationMs, activityTotal?.totalMs, inferredTotal);
  const modelMs = activityItems
    .filter((item) => item.kind === "model")
    .reduce((sum, item) => sum + (Number(item.stepMs) || 0), 0);
  const toolEntries = timingItems.filter((item) => item?.kind === "tool");
  const toolMs = toolEntries.reduce((sum, item) => sum + (Number(item.durationMs) || 0), 0);
  const networkCount = timingItems.filter((item) => item?.kind === "network").length;
  const slowCandidates = [
    ...activityItems
      .filter((item) => Number(item.stepMs) >= 1000)
      .map((item) => ({ label: item.text, durationMs: Number(item.stepMs), detail: "Activity 间隔" })),
    ...toolEntries
      .filter((item) => Number(item.durationMs) >= 1000)
      .map((item) => ({ label: item.label, durationMs: Number(item.durationMs), detail: item.detail || "工具实际执行" })),
  ].sort((a, b) => b.durationMs - a.durationMs).slice(0, 6);
  const lines = ["耗时概览"];
  if (Number.isFinite(totalMs)) lines.push(`- 当前总耗时：${formatWorkspaceRunDuration(totalMs)}`);
  if (modelMs > 0) lines.push(`- 模型相关间隔：约 ${formatWorkspaceRunDuration(modelMs)}（按 Activity 间隔估算）`);
  if (toolEntries.length > 0) lines.push(`- 工具实际执行：${formatWorkspaceRunDuration(toolMs)}（${toolEntries.length} 次完成事件）`);
  if (networkCount > 0) lines.push(`- 网络/会话恢复事件：${networkCount} 次`);
  if (slowCandidates.length > 0) {
    lines.push("");
    lines.push("慢步骤");
    slowCandidates.forEach((item, index) => {
      const detail = item.detail ? ` · ${item.detail}` : "";
      lines.push(`${index + 1}. ${item.label}：${formatWorkspaceRunDuration(item.durationMs)}${detail}`);
    });
  }
  if (activityItems.length > 0) {
    lines.push("");
    lines.push("最近 Activity");
    activityItems.slice(-10).forEach((item, index) => {
      lines.push(workspaceRunActivityLine(item, index));
    });
  }
  if (toolEntries.length > 0) {
    lines.push("");
    lines.push("最近工具完成");
    toolEntries.slice(-8).forEach((item, index) => {
      const duration = Number.isFinite(Number(item.durationMs)) ? ` ${formatWorkspaceRunDuration(item.durationMs)}` : "";
      const detail = item.detail ? ` · ${item.detail}` : "";
      lines.push(`${index + 1}. ${item.label}${duration}${detail}`);
    });
  }
  return lines.join("\n");
}

function extractThinkingDeltaFromRawTrace(event) {
  if (String(event?.type || "") !== "raw") return "";
  if (String(event?.eventType || "") !== "thinking") return "";
  const parsed = parseWorkspaceRunRawJson(event);
  if (parsed?.type !== "thinking") return "";
  const subtype = String(parsed?.subtype || "");
  if (subtype && subtype !== "delta") return "";
  return String(parsed?.text || parsed?.delta || parsed?.thinking || "").trim();
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
  return baseDefinitionId;
}

function shellQuoteArg(value) {
  const text = String(value ?? "");
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

function runtimeInterpreterForMarketplaceEntry(runtime, entry) {
  const language = String(runtime?.language || "").trim().toLowerCase();
  const entryLower = String(entry || "").trim().toLowerCase();
  if (language.includes("python") || entryLower.endsWith(".py")) return "python3";
  if (language.includes("shell") || language === "bash" || entryLower.endsWith(".sh") || entryLower.endsWith(".bash")) return "bash";
  return "node";
}

function marketplaceRuntimeArg(arg) {
  const text = String(arg ?? "").trim();
  if (!text) return "";
  if (text.includes("${")) return text;
  return shellQuoteArg(text);
}

function scriptFromMarketplaceRuntime(def) {
  if (String(def?.baseDefinitionId || "").trim() !== "tool_nodejs") return "";
  const runtime = def?.runtime && typeof def.runtime === "object" ? def.runtime : {};
  const entry = String(runtime.entry || "").trim().replace(/^\/+/, "");
  if (entry) {
    const packageDir = String(def?.packageDir || "").trim().replace(/\/+$/, "");
    const entryPath = packageDir ? `${packageDir}/${entry}` : `\${flowDir}/${entry}`;
    const args = Array.isArray(runtime.args) ? runtime.args.map(marketplaceRuntimeArg).filter(Boolean) : [];
    return [runtimeInterpreterForMarketplaceEntry(runtime, entry), shellQuoteArg(entryPath), ...args].join(" ");
  }
  const command = String(runtime.command || "").trim();
  return command;
}

function paletteCategory(node) {
  const id = String(runtimeDefinitionIdForPalette(node) || node?.id || "");
  if (id === "workspace_run" || id === "workspace_scheduled_run") return "CONTROL";
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

function buildWorkspaceExistingConnectionCandidates(nodes, edges, draft) {
  if (!draft) return [];
  const candidates = [];
  const wantInputs = draft.handleType === "source";
  for (const node of nodes || []) {
    if (!node || node.id === draft.nodeId) continue;
    const slots = Array.isArray(wantInputs ? node.data?.inputs : node.data?.outputs)
      ? (wantInputs ? node.data.inputs : node.data.outputs)
      : [];
    for (let slotIndex = 0; slotIndex < slots.length; slotIndex += 1) {
      const slot = slots[slotIndex];
      if (slot?.showOnNode === false) continue;
      const ok = wantInputs
        ? areSlotsCompatible(draft.slot, slot)
        : areSlotsCompatible(slot, draft.slot);
      if (!ok) continue;
      const connection = wantInputs
        ? {
            source: draft.nodeId,
            sourceHandle: draft.handleId,
            target: node.id,
            targetHandle: `input-${slotIndex}`,
          }
        : {
            source: node.id,
            sourceHandle: `output-${slotIndex}`,
            target: draft.nodeId,
            targetHandle: draft.handleId,
          };
      const occupied = (edges || []).some((edge) => (
        edge.target === connection.target && edge.targetHandle === connection.targetHandle
      ));
      candidates.push({
        node,
        nodeId: node.id,
        nodeLabel: node.data?.label || node.id,
        definitionId: node.data?.definitionId || "",
        slot,
        slotIndex,
        handleId: wantInputs ? connection.targetHandle : connection.sourceHandle,
        connection,
        occupied,
      });
    }
  }
  return candidates.sort((a, b) => {
    const ay = Number(a.node?.position?.y || 0);
    const by = Number(b.node?.position?.y || 0);
    const ax = Number(a.node?.position?.x || 0);
    const bx = Number(b.node?.position?.x || 0);
    return ay - by || ax - bx || a.slotIndex - b.slotIndex || String(a.nodeId).localeCompare(String(b.nodeId));
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

function scheduledRunIntervalToCron(intervalMinutes) {
  const n = Number(intervalMinutes);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_WORKSPACE_SCHEDULE_CRON;
  const minutes = Math.max(1, Math.min(1440, Math.round(n)));
  if (minutes < 60) return `*/${minutes} * * * *`;
  if (minutes === 60) return "0 * * * *";
  if (minutes < 1440 && minutes % 60 === 0) return `0 */${minutes / 60} * * *`;
  return DEFAULT_WORKSPACE_SCHEDULE_CRON;
}

function padScheduleNumber(value, fallback = 0, min = 0, max = 59) {
  const n = Math.max(min, Math.min(max, Number.parseInt(String(value ?? fallback), 10) || fallback));
  return String(n).padStart(2, "0");
}

function normalizeScheduleTime(value) {
  const match = String(value || "").trim().match(/^(\d{1,2}):(\d{1,2})$/);
  if (!match) return "09:00";
  return `${padScheduleNumber(match[1], 9, 0, 23)}:${padScheduleNumber(match[2], 0, 0, 59)}`;
}

function scheduleCronFromParts(scheduleType, time, weekday, monthDay, customCron) {
  const normalizedTime = normalizeScheduleTime(time);
  const [hour, minute] = normalizedTime.split(":").map((part) => Number.parseInt(part, 10));
  const type = String(scheduleType || "daily");
  if (type === "weekly") {
    const day = Math.max(0, Math.min(6, Number.parseInt(String(weekday ?? 1), 10) || 1));
    return `${minute} ${hour} * * ${day}`;
  }
  if (type === "monthly") {
    const day = Math.max(1, Math.min(31, Number.parseInt(String(monthDay ?? 1), 10) || 1));
    return `${minute} ${hour} ${day} * *`;
  }
  if (type === "custom") return String(customCron || "").trim() || DEFAULT_WORKSPACE_SCHEDULE_CRON;
  return `${minute} ${hour} * * *`;
}

function inferSchedulePartsFromCron(cron) {
  const normalizedCron = String(cron || DEFAULT_WORKSPACE_SCHEDULE_CRON).trim();
  const parts = normalizedCron.split(/\s+/);
  if (parts.length !== 5) {
    return { scheduleType: "custom", time: "09:00", weekday: 1, monthDay: 1 };
  }
  const [minuteRaw, hourRaw, dayRaw, monthRaw, weekRaw] = parts;
  const minute = Number.parseInt(minuteRaw, 10);
  const hour = Number.parseInt(hourRaw, 10);
  const hasSimpleTime = Number.isFinite(minute) && Number.isFinite(hour) && minuteRaw === String(minute) && hourRaw === String(hour);
  const time = hasSimpleTime
    ? `${padScheduleNumber(hour, 9, 0, 23)}:${padScheduleNumber(minute, 0, 0, 59)}`
    : "09:00";
  if (hasSimpleTime && dayRaw === "*" && monthRaw === "*" && weekRaw === "*") {
    return { scheduleType: "daily", time, weekday: 1, monthDay: 1 };
  }
  if (hasSimpleTime && dayRaw === "*" && monthRaw === "*" && /^\d+$/.test(weekRaw)) {
    return { scheduleType: "weekly", time, weekday: Math.max(0, Math.min(6, Number.parseInt(weekRaw, 10))), monthDay: 1 };
  }
  if (hasSimpleTime && /^\d+$/.test(dayRaw) && monthRaw === "*" && weekRaw === "*") {
    return { scheduleType: "monthly", time, weekday: 1, monthDay: Math.max(1, Math.min(31, Number.parseInt(dayRaw, 10))) };
  }
  return { scheduleType: "custom", time, weekday: 1, monthDay: 1 };
}

function normalizeScheduledRunConfig(raw) {
  let parsed = {};
  const text = String(raw || "").trim();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = {};
    }
  }
  const intervalMinutes = Number(parsed.intervalMinutes);
  const migratedCron = scheduledRunIntervalToCron(intervalMinutes);
  const rawCron = typeof parsed.cron === "string" && parsed.cron.trim()
    ? parsed.cron.trim()
    : migratedCron;
  const inferred = inferSchedulePartsFromCron(rawCron);
  const scheduleType = ["daily", "weekly", "monthly", "custom"].includes(parsed.scheduleType)
    ? parsed.scheduleType
    : inferred.scheduleType;
  const time = normalizeScheduleTime(parsed.time || inferred.time || "09:00");
  const weekday = Math.max(0, Math.min(6, Number.parseInt(String(parsed.weekday ?? inferred.weekday ?? 1), 10) || 1));
  const monthDay = Math.max(1, Math.min(31, Number.parseInt(String(parsed.monthDay ?? inferred.monthDay ?? 1), 10) || 1));
  const cron = scheduleCronFromParts(scheduleType, time, weekday, monthDay, rawCron);
  return {
    enabled: parsed.enabled === true,
    scheduleType,
    time,
    weekday,
    monthDay,
    cron,
    timezone: DEFAULT_WORKSPACE_SCHEDULE_TIMEZONE,
    targetRunNodeId: typeof parsed.targetRunNodeId === "string" ? parsed.targetRunNodeId.trim() : "",
    overlapPolicy: "skip",
  };
}

function serializeScheduledRunConfig(config) {
  const normalized = normalizeScheduledRunConfig(JSON.stringify(config || {}));
  return JSON.stringify(normalized);
}

function formatScheduledRunTime(ts) {
  const value = Number(ts || 0);
  if (!Number.isFinite(value) || value <= 0) return "-";
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function scheduleTypeLabel(type) {
  if (type === "weekly") return "每周";
  if (type === "monthly") return "每月";
  if (type === "custom") return "高级 Cron";
  return "每天";
}

function scheduledRunTimestamp(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function scheduledRunStateFromServer(rawSchedules) {
  const next = {};
  for (const item of Array.isArray(rawSchedules) ? rawSchedules : []) {
    const scheduleNodeId = String(item?.scheduleNodeId || item?.runNodeId || "").trim();
    if (!scheduleNodeId) continue;
    next[scheduleNodeId] = {
      nextAt: scheduledRunTimestamp(item.nextRunAt),
      lastAt: scheduledRunTimestamp(item.lastTriggeredAt),
      lastStatus: String(item.lastStatus || (item.enabled ? "armed" : "disabled")),
      lastError: String(item.lastError || ""),
      lastRunId: String(item.lastRunId || ""),
      targetRunNodeId: String(item.targetRunNodeId || item.runNodeId || ""),
      cron: String(item.cron || ""),
      timezone: String(item.timezone || ""),
    };
  }
  return next;
}

function isWorkspaceGroupNode(node) {
  return Boolean(node?.data?.isWorkspaceGroup);
}

function workspaceGroupTitle(index) {
  return index > 0 ? `Group ${index + 1}` : "Group";
}

function normalizeWorkspaceGroups(raw) {
  const list = Array.isArray(raw) ? raw : [];
  return list
    .map((group, index) => {
      const id = String(group?.id || `group_${index + 1}`).trim();
      const x = Number(group?.x);
      const y = Number(group?.y);
      const width = Number(group?.width);
      const height = Number(group?.height);
      if (!id || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height)) return null;
      return {
        id,
        title: String(group?.title || workspaceGroupTitle(index)).trim() || workspaceGroupTitle(index),
        color: String(group?.color || "purple").trim() || "purple",
        nodeIds: Array.from(new Set((Array.isArray(group?.nodeIds) ? group.nodeIds : [])
          .map((nodeId) => String(nodeId || "").trim())
          .filter(Boolean))),
        x,
        y,
        width: Math.max(MIN_WORKSPACE_GROUP_WIDTH, Math.round(width)),
        height: Math.max(MIN_WORKSPACE_GROUP_HEIGHT, Math.round(height)),
      };
    })
    .filter(Boolean);
}

function inferredWorkspaceGroupNodeIds(group, graph) {
  if (Array.isArray(group?.nodeIds) && group.nodeIds.length > 0) return group.nodeIds;
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  const positions = graph?.ui?.nodePositions && typeof graph.ui.nodePositions === "object" ? graph.ui.nodePositions : {};
  const sizes = graph?.ui?.nodeSizes && typeof graph.ui.nodeSizes === "object" ? graph.ui.nodeSizes : {};
  return Object.keys(instances).filter((nodeId) => {
    const position = positions[nodeId];
    if (!position || !Number.isFinite(Number(position.x)) || !Number.isFinite(Number(position.y))) return false;
    const size = sizes[nodeId] || {};
    const centerX = Number(position.x) + Math.max(1, Number(size.width) || DEFAULT_WORKSPACE_NODE_WIDTH) / 2;
    const centerY = Number(position.y) + Math.max(1, Number(size.height) || MIN_WORKSPACE_NODE_HEIGHT) / 2;
    return centerX >= group.x && centerX <= group.x + group.width && centerY >= group.y && centerY <= group.y + group.height;
  });
}

function workspaceGroupNodesFromGraph(graph) {
  const groups = normalizeWorkspaceGroups(graph?.ui?.groups);
  return groups.map((group) => ({
    id: group.id,
    type: FLOW_NODE_TYPE,
    position: { x: group.x, y: group.y },
    width: group.width,
    height: group.height,
    selected: false,
    draggable: true,
    selectable: true,
    zIndex: 0,
    data: {
      isWorkspaceGroup: true,
      label: group.title,
      title: group.title,
      color: group.color,
      nodeIds: inferredWorkspaceGroupNodeIds(group, graph),
      nodeSize: { width: group.width, height: group.height },
    },
  }));
}

function normalizeWorkspaceGroupSize(size) {
  const width = Number(size?.width);
  const height = Number(size?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height)) return null;
  return {
    width: Math.max(MIN_WORKSPACE_GROUP_WIDTH, Math.round(width)),
    height: Math.max(MIN_WORKSPACE_GROUP_HEIGHT, Math.round(height)),
  };
}

function expandWorkspaceGroupPositionChanges(changes, currentNodes) {
  const list = Array.isArray(changes) ? changes : [];
  const nodesById = new Map((Array.isArray(currentNodes) ? currentNodes : []).map((node) => [node.id, node]));
  const explicitlyChanged = new Set(list.map((change) => String(change?.id || "")).filter(Boolean));
  const expanded = [...list];
  for (const change of list) {
    if (change?.type !== "position" || !change.position) continue;
    const groupNode = nodesById.get(change.id);
    if (!isWorkspaceGroupNode(groupNode)) continue;
    const dx = Number(change.position.x) - Number(groupNode.position?.x || 0);
    const dy = Number(change.position.y) - Number(groupNode.position?.y || 0);
    if (!Number.isFinite(dx) || !Number.isFinite(dy) || (dx === 0 && dy === 0)) continue;
    for (const memberId of Array.isArray(groupNode.data?.nodeIds) ? groupNode.data.nodeIds : []) {
      if (explicitlyChanged.has(memberId)) continue;
      const member = nodesById.get(memberId);
      if (!member || isWorkspaceGroupNode(member)) continue;
      expanded.push({
        type: "position",
        id: memberId,
        position: {
          x: Number(member.position?.x || 0) + dx,
          y: Number(member.position?.y || 0) + dy,
        },
        dragging: change.dragging,
      });
    }
  }
  return expanded;
}

function cloneSlots(slots) {
  return (Array.isArray(slots) ? slots : []).map((slot) => ({
    type: slot?.type || "node",
    name: slot?.name || "",
    default: slotDefault(slot),
    required: Boolean(slot?.required),
    description: String(slot?.description || ""),
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
  const resultContent = contextRunResultContentFromData(data);
  return [
    nodeHandleSignature(node),
    workspaceDisplayKindFromData(data) || "",
    resultContent ? "has-result" : "",
    data?.contextRunResultNonce || "",
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
    data?.runningRunNodeIds?.has?.(node?.id) ? "running-run" : "",
  ].join("::");
}

function workspaceHydratedNodeRuntimeEqual(a, b) {
  if (!a || !b) return false;
  return a.selected === b.selected &&
    a.hasConnections === b.hasConnections &&
    a.isExecuting === b.isExecuting &&
    a.nodeStatus === b.nodeStatus &&
    a.nodeElapsed === b.nodeElapsed &&
    a.nodeRunDetail === b.nodeRunDetail &&
    a.optimizingRun === b.optimizingRun &&
    a.scheduledRunState === b.scheduledRunState &&
    a.nodeChatActive === b.nodeChatActive &&
    a.nodeChat === b.nodeChat;
}

const EMPTY_DISPLAY_SOURCE_NODES = new Map();
const EMPTY_DISPLAY_CANVAS_NODES = [];

function graphToFlow(graph, palette) {
  const rawInstances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  const instances = sanitizeWorkspaceRuntimeOutputs(rawInstances);
  const rawEdges = Array.isArray(graph?.edges) ? graph.edges : [];
  // 缺坐标通常来自 AI 新写的 DSL。统一走 CLI 同款确定性排版；原有坐标保持不动，避免打开
  // 页面时覆盖用户手工拖拽结果。
  const positions = layoutWorkspaceNodePositions(graph, { preserveExisting: true });
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
    const runtimeScript = scriptFromMarketplaceRuntime(def);
    const pos = positions[id] && typeof positions[id].x === "number" && typeof positions[id].y === "number"
      ? positions[id]
      : { x: 120, y: 360 };
    const isDisplay = Boolean(workspaceDisplayKindFromData({ definitionId: runtimeDefinitionId, inputs: inst.input, outputs: inst.output }));
    const rawSize = sizes[id] && typeof sizes[id].width === "number" && typeof sizes[id].height === "number"
      ? { width: sizes[id].width, height: sizes[id].height }
      : null;
    const size = normalizeWorkspaceNodeSize(rawSize, { display: isDisplay });
    const useSize = size && !isOneClickTaskDefinitionId(runtimeDefinitionId);
    return {
      id,
      type: FLOW_NODE_TYPE,
      position: pos,
      ...(useSize ? { width: size.width, height: size.height } : {}),
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
        script: inst.script || runtimeScript || "",
        scriptRef: inst.scriptRef || "",
        implementationRef: inst.implementationRef || "",
        implementationMode: inst.implementationMode || "",
        displayReloadKey: inst.displayReloadKey || "",
        ...(useSize ? { nodeSize: size } : {}),
        ...(isDisplay && useSize ? { displaySize: size } : {}),
      },
    };
  });
  const merged = rawNodes.map((node) => mergeNodeWithPalette(node, instances, palette));
  const groupNodes = workspaceGroupNodesFromGraph(graph);
  const edges = rawEdges
    .filter((e) => e?.source && e?.target)
    .filter((e) => !groupNodes.some((node) => node.id === String(e.source) || node.id === String(e.target)))
    .map((e, idx) => ({
      id: e.id || `we-${e.source}-${e.target}-${idx}`,
      source: String(e.source),
      target: String(e.target),
      sourceHandle: e.sourceHandle ?? undefined,
      targetHandle: e.targetHandle ?? undefined,
      markerEnd: { type: MarkerType.ArrowClosed },
    }));
  // 首次加载的边和用户刚拉出的边遵守同一条规则：边存在，端点 handle 就必须可见。
  // 否则 React Flow 会保留语义边，但因为端点没有渲染而完全画不出来。
  const edgeAwareNodes = revealConnectedSlotsForEdges(merged, edges);
  const nodes = [...groupNodes, ...edgeAwareNodes];
  return { nodes, edges: filterValidEdges(edges, nodes), instances };
}

function displayRefNodeId(sourceId) {
  return `${DISPLAY_REF_PREFIX}${sourceId}`;
}

function sourceIdFromDisplayRefId(nodeId) {
  const text = String(nodeId || "");
  return text.startsWith(DISPLAY_REF_PREFIX) ? text.slice(DISPLAY_REF_PREFIX.length) : text;
}

function displayGroupRefNodeId(groupId) {
  return `${DISPLAY_GROUP_REF_PREFIX}${groupId}`;
}

function displayGroupBounds(group, displayPage, sourceNodeById) {
  const memberIds = (Array.isArray(group?.nodeIds) ? group.nodeIds : [])
    .filter((id) => displayPage.nodeIds.includes(id) && sourceNodeById.has(id));
  if (memberIds.length === 0) return null;
  const bounds = memberIds.reduce((acc, id) => {
    const sourceNode = sourceNodeById.get(id);
    const fallbackSize = persistedWorkspaceNodeSize(sourceNode) || { width: 520, height: 320 };
    const size = normalizeWorkspaceNodeSize(displayPage.nodeSizes[id] || fallbackSize, { display: true }) || fallbackSize;
    const position = displayPage.nodePositions[id] || sourceNode?.position || { x: 0, y: 0 };
    return {
      minX: Math.min(acc.minX, Number(position.x) || 0),
      minY: Math.min(acc.minY, Number(position.y) || 0),
      maxX: Math.max(acc.maxX, (Number(position.x) || 0) + size.width),
      maxY: Math.max(acc.maxY, (Number(position.y) || 0) + size.height),
    };
  }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
  return {
    memberIds,
    position: {
      x: bounds.minX - WORKSPACE_GROUP_PADDING,
      y: bounds.minY - WORKSPACE_GROUP_PADDING,
    },
    size: {
      width: Math.max(MIN_WORKSPACE_GROUP_WIDTH, bounds.maxX - bounds.minX + WORKSPACE_GROUP_PADDING * 2),
      height: Math.max(MIN_WORKSPACE_GROUP_HEIGHT, bounds.maxY - bounds.minY + WORKSPACE_GROUP_PADDING * 2),
    },
  };
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

const DISPLAY_SHARE_EXPIRY_OPTIONS = [
  { value: "1", label: "1 天" },
  { value: "7", label: "7 天" },
  { value: "30", label: "30 天" },
  { value: "90", label: "90 天" },
  { value: "365", label: "1 年" },
  { value: "permanent", label: "永久" },
];

function defaultDisplayShareDraft(patch = {}) {
  return {
    title: "",
    layout: "gallery",
    nodeIds: [],
    expiresInDays: 30,
    permanent: false,
    ...patch,
  };
}

function displayShareExpiryValue(draft = {}) {
  return draft.permanent ? "permanent" : String(draft.expiresInDays || 30);
}

function displayShareExpiryPayload(draft = {}) {
  if (draft.permanent) return { expiresMode: "permanent", permanent: true };
  const days = Number(draft.expiresInDays || 30);
  return { expiresMode: "days", expiresInDays: Number.isFinite(days) ? days : 30 };
}

function formatDisplayShareExpiry(share = {}) {
  if (!share.expiresAt) return "永久有效";
  const time = Date.parse(String(share.expiresAt || ""));
  if (!Number.isFinite(time)) return "永久有效";
  return `有效期至 ${new Date(time).toLocaleString()}`;
}

function displayShareUrl(share = {}) {
  return new URL(share.url || `/display/${share.id || ""}`, window.location.origin).href;
}

const WORKSPACE_CANVAS_CLIPBOARD_STORAGE_KEY = "af:workspace:canvas-clipboard";
const WORKSPACE_CANVAS_CLIPBOARD_TYPE = "agentflow.workspace.canvas-clipboard";

function encodeWorkspaceCanvasClipboard(clipboard) {
  return JSON.stringify({
    type: WORKSPACE_CANVAS_CLIPBOARD_TYPE,
    version: 1,
    clipboard,
  });
}

function decodeWorkspaceCanvasClipboard(text) {
  try {
    const parsed = JSON.parse(String(text || ""));
    if (parsed?.type !== WORKSPACE_CANVAS_CLIPBOARD_TYPE) return null;
    const clipboard = parsed.clipboard;
    if (!clipboard || !Array.isArray(clipboard.nodes) || clipboard.nodes.length === 0) return null;
    return clipboard;
  } catch {
    return null;
  }
}

function persistWorkspaceCanvasClipboard(clipboard) {
  try {
    localStorage.setItem(WORKSPACE_CANVAS_CLIPBOARD_STORAGE_KEY, encodeWorkspaceCanvasClipboard(clipboard));
  } catch {
    /* ignore storage failures */
  }
}

function readPersistedWorkspaceCanvasClipboard() {
  try {
    return decodeWorkspaceCanvasClipboard(localStorage.getItem(WORKSPACE_CANVAS_CLIPBOARD_STORAGE_KEY));
  } catch {
    return null;
  }
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

function normalizeWorkspaceDisplaySize(size) {
  const normalized = normalizeWorkspaceNodeSize(size, { display: true });
  if (!normalized) return null;
  return {
    width: Math.max(320, Math.round(normalized.width)),
    height: Math.max(180, Math.round(normalized.height)),
  };
}

function defaultWorkspaceDisplaySizeForKind(kind) {
  const text = String(kind || "").trim().toLowerCase();
  if (text === "html" || text === "react") return { width: 720, height: 520 };
  if (text === "table" || text === "chart") return { width: 640, height: 380 };
  if (text === "image") return { width: 520, height: 360 };
  return { width: DEFAULT_WORKSPACE_DISPLAY_WIDTH, height: DEFAULT_WORKSPACE_DISPLAY_HEIGHT };
}

function contextRunResultDisplaySizeFromData(data, displayDefinitionId = "") {
  const existingDisplaySize = normalizeWorkspaceDisplaySize(data?.displaySize);
  if (existingDisplaySize) return existingDisplaySize;
  const existingNodeSize = normalizeWorkspaceDisplaySize(data?.nodeSize);
  if (existingNodeSize) return existingNodeSize;
  const kind = displayKind(displayDefinitionId) || normalizeContextRunDisplayType(workspaceSlotConfigValue(data?.inputs || data?.input || [], "displayType", "markdown"));
  return defaultWorkspaceDisplaySizeForKind(kind);
}

function persistedWorkspaceNodeSize(node) {
  if (isOneClickTaskDefinitionId(node?.data?.definitionId)) return null;
  const isDisplay = Boolean(workspaceDisplayKindFromData(node?.data));
  const width = Number(node?.data?.displaySize?.width || node?.data?.nodeSize?.width || node?.width || (isDisplay ? node?.measured?.width : 0) || 0);
  const height = Number(node?.data?.displaySize?.height || node?.data?.nodeSize?.height || node?.height || (isDisplay ? node?.measured?.height : 0) || 0);
  return normalizeWorkspaceNodeSize({ width, height }, { display: isDisplay });
}

function flowToGraph(nodes, edges, instances) {
  const regularNodes = (nodes || []).filter((node) => !isWorkspaceGroupNode(node));
  const groupNodes = (nodes || []).filter(isWorkspaceGroupNode);
  const graphInstances = sanitizeWorkspaceRuntimeOutputs(buildInstancesForYaml(regularNodes, instances || {}));
  const graphEdges = edges.map((edge) => ({
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? null,
    targetHandle: edge.targetHandle ?? null,
  })).filter((edge) => (
    !groupNodes.some((node) => node.id === edge.source || node.id === edge.target)
  ));
  const nodePositions = {};
  const nodeSizes = {};
  const groups = [];
  for (const node of regularNodes) {
    nodePositions[node.id] = { x: node.position?.x || 0, y: node.position?.y || 0 };
    const size = persistedWorkspaceNodeSize(node);
    if (size) nodeSizes[node.id] = size;
  }
  for (const node of groupNodes) {
    const width = Number(node.data?.nodeSize?.width || node.width || node.measured?.width || 0);
    const height = Number(node.data?.nodeSize?.height || node.height || node.measured?.height || 0);
    groups.push({
      id: node.id,
      title: String(node.data?.title || node.data?.label || "Group"),
      color: String(node.data?.color || "purple"),
      nodeIds: Array.from(new Set((Array.isArray(node.data?.nodeIds) ? node.data.nodeIds : [])
        .map((nodeId) => String(nodeId || "").trim())
        .filter((nodeId) => regularNodes.some((regularNode) => regularNode.id === nodeId)))),
      x: Number(node.position?.x || 0),
      y: Number(node.position?.y || 0),
      width: Math.max(MIN_WORKSPACE_GROUP_WIDTH, Math.round(width || MIN_WORKSPACE_GROUP_WIDTH)),
      height: Math.max(MIN_WORKSPACE_GROUP_HEIGHT, Math.round(height || MIN_WORKSPACE_GROUP_HEIGHT)),
    });
  }
  return { version: 1, instances: graphInstances, edges: graphEdges, ui: { nodePositions, nodeSizes, groups } };
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
  if (id === "display_react_app") return "react";
  if (id === "display_image") return "image";
  if (id === "display_chart") return "chart";
  if (id === "display_table") return "table";
  return "";
}

function workspaceDisplayKindFromData(data) {
  const direct = displayKind(data?.definitionId);
  if (direct) return direct;
  if (isOneClickTaskDefinitionId(data?.definitionId)) {
    if (!contextRunResultContentFromData(data)) return "";
    return normalizeContextRunDisplayType(workspaceSlotConfigValue(data?.inputs || data?.input || [], "displayType", "markdown"));
  }
  return "";
}

function displayContent(data) {
  const slots = [...(data?.inputs || []), ...(data?.outputs || [])];
  const kind = workspaceDisplayKindFromData(data);
  const isContextRun = isOneClickTaskDefinitionId(data?.definitionId);
  const primaryName = kind === "image" ? "src" : "content";
  const slotText = (slot) => String(slot?.value ?? slot?.default ?? "");
  const hasSlotText = (slot) => slotText(slot).trim();
  const contentSlot =
    slots.find((slot) => slot?.name === primaryName && hasSlotText(slot)) ||
    slots.find((slot) => slot?.name === "filePath" && hasSlotText(slot)) ||
    slots.find((slot) => slot?.type === "text" && hasSlotText(slot));
  const slotContent = contentSlot ? slotText(contentSlot) : "";
  return String(isContextRun ? slotContent : (data?.body || slotContent));
}

function displayTextFilePath(value, kind = "") {
  const text = String(value || "").trim();
  if (!text || text.length > 260) return "";
  if (/[\r\n<>]/.test(text)) return "";
  if (/^(?:https?:|data:|blob:|file:|javascript:|mailto:|tel:)/i.test(text)) return "";
  const clean = text.replace(/^\/+/, "");
  if (clean.includes("..") || clean.startsWith(".")) return "";
  const ext = clean.split("?")[0].split("#")[0].toLowerCase().split(".").pop() || "";
  const allowedByKind = {
    html: new Set(["html", "htm"]),
    react: new Set(["json", "jsx", "tsx", "js", "txt"]),
    markdown: new Set(["md", "markdown", "txt"]),
    mermaid: new Set(["mmd", "mermaid", "txt"]),
    ascii: new Set(["txt", "log"]),
    chart: new Set(["json"]),
    table: new Set(["json", "csv", "tsv"]),
  };
  const allowed = allowedByKind[kind] || new Set(["html", "htm", "md", "markdown", "txt", "json", "csv", "tsv"]);
  return allowed.has(ext) ? clean : "";
}

function normalizeAgentflowEnvelopeBlock(block) {
  let text = String(block || "").replace(/\r\n/g, "\n").trim();
  if (!text.includes("\n")) {
    text = text
      .replace(/\s+(resultFile|result|outParams|outParams\.[A-Za-z_][A-Za-z0-9_-]*)\s*:/g, "\n$1:")
      .replace(/(^|\n)outParams:\s+([A-Za-z_][A-Za-z0-9_-]*\s*:)/g, "$1outParams:\n  $2");
  }
  return text;
}

function displayOutputEnvelopeContent(value) {
  const raw = String(value || "").trim();
  if (!raw) return String(value || "");
  const agentflow = raw.match(/---agentflow\b([\s\S]*?)---end/i);
  if (agentflow?.[1]) {
    const block = normalizeAgentflowEnvelopeBlock(agentflow[1]);
    const fileMatch = block.match(/^resultFile\s*:\s*["']?([^"'\n]+)["']?/m);
    if (fileMatch?.[1]) return fileMatch[1].trim();
    const inlineMatch = block.match(/^result\s*:\s*(.*)$/m);
    if (inlineMatch) {
      const valueText = String(inlineMatch[1] || "").trim();
      if (valueText === "|" || valueText === ">") {
        const after = block.slice((inlineMatch.index || 0) + inlineMatch[0].length).split("\n");
        return after
          .filter((line) => /^\s+/.test(line) || !line.trim())
          .map((line) => line.replace(/^\s{2}/, ""))
          .join("\n")
          .replace(/\s+$/g, "");
      }
      return valueText.replace(/^["']|["']$/g, "");
    }
    const outside = raw.replace(agentflow[0], "").trim();
    if (outside) return outside;
  }
  if (!/["']result["']\s*:|["']outParams["']\s*:|["']resultFile["']\s*:/i.test(raw)) return String(value || "");
  const candidates = [raw];
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.unshift(raw.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && (Object.prototype.hasOwnProperty.call(parsed, "result") || Object.prototype.hasOwnProperty.call(parsed, "resultFile"))) {
        const result = parsed.resultFile || parsed.result;
        return typeof result === "string" ? result : JSON.stringify(result, null, 2);
      }
    } catch {
      /* try next */
    }
  }
  return String(value || "");
}

async function readWorkspaceTextFile(flowParams, filePath) {
  const q = flowParamsQuery(flowParams);
  q.set("path", filePath);
  const res = await fetch(`/api/workspace/file?${q.toString()}`);
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `读取文件失败：${filePath}`);
  return String(json.content || "");
}

async function writeWorkspaceTextFile(flowParams, filePath, content) {
  const res = await fetch("/api/workspace/file", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...flowParams, path: filePath, content: String(content || "") }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `写入文件失败：${filePath}`);
  return json.path || filePath;
}

function displayRefineSourceContext(nodeId, nodes = [], edges = []) {
  const id = String(nodeId || "");
  if (!id) return "";
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return (Array.isArray(edges) ? edges : [])
    .filter((edge) => String(edge?.target || "") === id)
    .slice(0, 4)
    .map((edge) => {
      const source = byId.get(String(edge?.source || ""));
      if (!source) return "";
      const data = source.data || {};
      const body = String(data.body || "").trim();
      const lines = [
        `- upstreamId: ${source.id}`,
        `  label: ${String(data.label || source.id).trim()}`,
        `  definitionId: ${String(data.definitionId || "").trim()}`,
      ];
      if (body) lines.push(`  task: ${body.slice(0, 4000)}`);
      return lines.join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

function normalizeHtmlDisplayContent(content) {
  let text = displayOutputEnvelopeContent(content).trim();
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

function htmlContentProblem(content) {
  const text = normalizeHtmlDisplayContent(content);
  if (!text.trim()) return "";
  if (/<[^>]*$/g.test(text)) return "HTML 内容末尾存在未闭合标签，可能是生成或保存时被截断。";
  if (/^(?:<!doctype\b|<html\b)/i.test(text) && !/<\/html\s*>/i.test(text)) {
    return "完整 HTML 文档缺少 </html> 结束标签，可能是生成或保存时被截断。";
  }
  return "";
}

function validateDisplayContentForWrite(kind, content) {
  if (kind === "html") return htmlContentProblem(content);
  return "";
}

function htmlDisplaySrcDoc(content, frameId = "") {
  const html = normalizeHtmlDisplayContent(content);
  if (!html.trim()) return "";
  const frameIdJson = JSON.stringify(String(frameId || ""));
  const guard = `<base target="_blank"><script data-agentflow-display-link-guard="1">
(() => {
  const frameId = ${frameIdJson};
  const postSize = () => {
    const doc = document.documentElement;
    const body = document.body;
    const height = Math.ceil(Math.max(
      doc ? doc.scrollHeight : 0,
      doc ? doc.offsetHeight : 0,
      doc ? doc.clientHeight : 0,
      body ? body.scrollHeight : 0,
      body ? body.offsetHeight : 0,
      body ? body.clientHeight : 0,
      window.innerHeight || 0
    ));
    window.parent.postMessage({ source: "agentflow-html-display-size", frameId, height }, "*");
  };
  document.addEventListener("click", (event) => {
    const link = event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if (!link) return;
    const rawHref = String(link.getAttribute("href") || "").trim();
    if (!rawHref || rawHref.startsWith("#")) return;
    if (/^javascript:/i.test(rawHref)) {
      event.preventDefault();
      return;
    }
    event.preventDefault();
    window.open(link.href, "_blank", "noopener,noreferrer");
  }, true);
  window.addEventListener("load", postSize);
  window.addEventListener("resize", postSize);
  requestAnimationFrame(postSize);
  setTimeout(postSize, 60);
  setTimeout(postSize, 300);
  if (typeof ResizeObserver !== "undefined") {
    const resizeObserver = new ResizeObserver(postSize);
    resizeObserver.observe(document.documentElement);
    if (document.body) resizeObserver.observe(document.body);
  }
  if (typeof MutationObserver !== "undefined") {
    const mutationObserver = new MutationObserver(postSize);
    mutationObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  }
})();
</script>`;
  if (/data-agentflow-display-link-guard=["']1["']/i.test(html)) return html;
  if (/<head\b[^>]*>/i.test(html)) {
    return html.replace(/<head\b([^>]*)>/i, `<head$1>${guard}`);
  }
  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(/<html\b([^>]*)>/i, `<html$1><head>${guard}</head>`);
  }
  return `<!doctype html><html><head>${guard}</head><body>${html}</body></html>`;
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

function htmlSnapshotMarkupFromDocument(doc, width, height) {
  const serializer = new XMLSerializer();
  const styles = Array.from(doc.head?.querySelectorAll("style") || [])
    .map((node) => serializer.serializeToString(node))
    .join("\n");
  const bodyHtml = doc.body
    ? Array.from(doc.body.childNodes).map((node) => serializer.serializeToString(node)).join("")
    : "";
  const view = doc.defaultView || window;
  const bodyStyle = doc.body ? view.getComputedStyle(doc.body) : null;
  const htmlStyle = doc.documentElement ? view.getComputedStyle(doc.documentElement) : null;
  const background = bodyStyle?.backgroundColor && bodyStyle.backgroundColor !== "rgba(0, 0, 0, 0)"
    ? bodyStyle.backgroundColor
    : htmlStyle?.backgroundColor && htmlStyle.backgroundColor !== "rgba(0, 0, 0, 0)"
      ? htmlStyle.backgroundColor
      : "#ffffff";
  return `
    <style>
      * { box-sizing: border-box; }
      html, body { margin: 0; width: ${width}px; min-height: ${height}px; background: ${background}; overflow: hidden; }
      .af-html-snapshot-root { width: ${width}px; min-height: ${height}px; overflow: hidden; background: ${background}; }
    </style>
    ${styles}
    <div xmlns="http://www.w3.org/1999/xhtml" class="af-html-snapshot-root">${bodyHtml}</div>
  `;
}

function htmlSnapshotMarkup(content, width, height) {
  const raw = normalizeHtmlDisplayContent(content);
  const doc = new DOMParser().parseFromString(raw || "<body></body>", "text/html");
  return htmlSnapshotMarkupFromDocument(doc, width, height);
}

function htmlFrameDocument(iframe) {
  try {
    return iframe?.contentDocument || iframe?.contentWindow?.document || null;
  } catch {
    return null;
  }
}

function htmlFrameDocumentHtml(iframe) {
  const doc = htmlFrameDocument(iframe);
  if (!doc?.documentElement) return "";
  const doctype = doc.doctype
    ? `<!DOCTYPE ${doc.doctype.name}${doc.doctype.publicId ? ` PUBLIC "${doc.doctype.publicId}"` : ""}${doc.doctype.systemId ? ` "${doc.doctype.systemId}"` : ""}>`
    : "<!DOCTYPE html>";
  return `${doctype}\n${doc.documentElement.outerHTML}`;
}

function elementSnapshotDebug(element) {
  if (!element) return null;
  const rect = element.getBoundingClientRect?.();
  return {
    rectWidth: rect?.width ? Math.round(rect.width) : null,
    rectHeight: rect?.height ? Math.round(rect.height) : null,
    clientWidth: element.clientWidth || null,
    clientHeight: element.clientHeight || null,
    scrollWidth: element.scrollWidth || null,
    scrollHeight: element.scrollHeight || null,
    offsetWidth: element.offsetWidth || null,
    offsetHeight: element.offsetHeight || null,
  };
}

function htmlFrameSnapshotMetrics(iframe, fallbackWidth, fallbackHeight, extra = {}) {
  const rect = iframe?.getBoundingClientRect?.();
  const doc = htmlFrameDocument(iframe);
  const docEl = doc?.documentElement;
  const body = doc?.body;
  const card = extra?.card || null;
  const displayBody = extra?.displayBody || null;
  const scroller = extra?.scroller || null;
  const displaySize = extra?.displaySize || null;
  const debug = {
    fallbackWidth: Number(fallbackWidth) || null,
    fallbackHeight: Number(fallbackHeight) || null,
    displaySizeWidth: Number(displaySize?.width || 0) || null,
    displaySizeHeight: Number(displaySize?.height || 0) || null,
    rectWidth: rect?.width ? Math.round(rect.width) : null,
    rectHeight: rect?.height ? Math.round(rect.height) : null,
    iframeClientWidth: iframe?.clientWidth || null,
    iframeClientHeight: iframe?.clientHeight || null,
    docScrollWidth: docEl?.scrollWidth || null,
    docScrollHeight: docEl?.scrollHeight || null,
    bodyScrollWidth: body?.scrollWidth || null,
    bodyScrollHeight: body?.scrollHeight || null,
    docOffsetWidth: docEl?.offsetWidth || null,
    bodyOffsetWidth: body?.offsetWidth || null,
    card: elementSnapshotDebug(card),
    displayBody: elementSnapshotDebug(displayBody),
    scroller: elementSnapshotDebug(scroller),
  };
  const widthCandidates = [
    Number(fallbackWidth) || 0,
    Number(displaySize?.width || 0),
    Number(card?.clientWidth || 0),
    Number(card?.scrollWidth || 0),
    Number(displayBody?.clientWidth || 0),
    Number(displayBody?.scrollWidth || 0),
    Number(scroller?.clientWidth || 0),
    Number(scroller?.scrollWidth || 0),
    Number(rect?.width) || 0,
    Number(iframe?.clientWidth) || 0,
    Number(docEl?.scrollWidth || 0),
    Number(body?.scrollWidth || 0),
    Number(docEl?.offsetWidth || 0),
    Number(body?.offsetWidth || 0),
  ].map((value) => Math.ceil(value)).filter((value) => value > 0);
  const width = Math.max(1, ...(widthCandidates.length ? widthCandidates : [960]));
  const height = Math.max(
    1,
    Math.round(Number(fallbackHeight) || rect?.height || iframe?.clientHeight || 640),
    Math.ceil(Number(docEl?.scrollHeight || 0)),
    Math.ceil(Number(body?.scrollHeight || 0)),
  );
  return { width, height, debug };
}

async function saveHtmlDisplayAsImage({ flowParams, content, sourceFilePath, iframe, width, height, filename, snapshotElements, displaySize }) {
  const metrics = htmlFrameSnapshotMetrics(iframe, width, height, {
    ...(snapshotElements || {}),
    displaySize,
  });
  const renderedHtml = htmlFrameDocumentHtml(iframe);
  const res = await fetch("/api/workspace/html-screenshot", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ...flowParams,
      content: renderedHtml || content,
      sourceFilePath: sourceFilePath || "",
      width: metrics.width,
      height: metrics.height,
      filename,
    }),
  });
  if (!res.ok) {
    const json = await res.json().catch(() => ({}));
    throw new Error(json.error || "截图失败");
  }
  const blob = await res.blob();
  downloadBlob(blob, filename);
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
  if (kind === "react") return "deployed_code";
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
  const kind = workspaceDisplayKindFromData(data);
  const rawContent = displayContent(data);
  const unwrappedRawContent = kind === "image" ? rawContent : displayOutputEnvelopeContent(rawContent);
  const filePath = kind === "image" ? "" : displayTextFilePath(unwrappedRawContent, kind);
  const [fileContent, setFileContent] = useState("");
  const [fileError, setFileError] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (!filePath) {
      setFileContent("");
      setFileError("");
      setFileLoading(false);
      return () => { cancelled = true; };
    }
    setFileLoading(true);
    setFileError("");
    setFileContent("");
    readWorkspaceTextFile(flowParams, filePath)
      .then((text) => {
        if (!cancelled) setFileContent(text);
      })
      .catch((error) => {
        if (!cancelled) setFileError(String(error.message || error));
      })
      .finally(() => {
        if (!cancelled) setFileLoading(false);
      });
    return () => { cancelled = true; };
  }, [filePath, flowParams?.flowId, flowParams?.flowSource, flowParams?.archived, data?.displayReloadKey]);
  const resolvedContent = filePath ? fileContent : unwrappedRawContent;
  const content = kind === "html"
    ? normalizeHtmlDisplayContent(resolvedContent)
    : kind === "react"
      ? normalizeReactAppDisplayContent(resolvedContent)
      : displayOutputEnvelopeContent(resolvedContent);
  const htmlFrameIdRef = useRef("");
  if (!htmlFrameIdRef.current) {
    htmlFrameIdRef.current = `html-display-${Math.random().toString(36).slice(2, 10)}`;
  }
  if (!kind) return null;
  const contentProblem = validateDisplayContentForWrite(kind, content);
  if (fileLoading) return <VisibleScrollFrame className="af-work-display-empty">Loading {filePath}...</VisibleScrollFrame>;
  if (fileError) return <VisibleScrollFrame className="af-work-display-empty">{fileError}</VisibleScrollFrame>;
  if (contentProblem) return <VisibleScrollFrame className="af-work-display-empty">{contentProblem}</VisibleScrollFrame>;
  if (!content.trim()) return <VisibleScrollFrame className="af-work-display-empty">No display content</VisibleScrollFrame>;
  if (kind === "html" || kind === "react") {
    return (
      <div className="af-work-display-body af-work-display-body--html">
        <iframe
          key={htmlFrameVersion}
          ref={htmlFrameRef}
          className="af-work-display-html-frame"
          title={data?.label || (kind === "react" ? "React app preview" : "HTML preview")}
          sandbox="allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox"
          srcDoc={kind === "react" ? reactAppDisplaySrcDoc(content, htmlFrameIdRef.current) : htmlDisplaySrcDoc(content, htmlFrameIdRef.current)}
        />
      </div>
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
        <MarkdownDisplayContent content={content} basePath={filePath} resolveSrc={(src, opts) => workspaceRawFileUrl(src, flowParams, opts)} />
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
        <details className="af-work-display-mermaid-source">
          <summary>查看 Mermaid 源码</summary>
          <pre className="af-work-node__diagram af-work-node__diagram--mermaid">{content}</pre>
        </details>
      </VisibleScrollFrame>
    );
  }
  return <VisibleScrollFrame className="af-work-display-body af-work-display-body--ascii"><pre className="af-work-node__diagram af-work-node__diagram--ascii">{content}</pre></VisibleScrollFrame>;
}

function DisplayFullscreenPreview({ node, onClose }) {
  const htmlFrameRef = useRef(null);
  const kind = workspaceDisplayKindFromData(node?.data);
  const title = node?.data?.label || (kind === "html" ? "HTML 展示" : kind === "markdown" ? "Markdown 展示" : "Display 预览");
  const readOnly = Boolean(node?.data?.readOnly);
  const [markdownEditing, setMarkdownEditing] = useState(false);
  const [markdownDraft, setMarkdownDraft] = useState("");
  const [markdownFileContent, setMarkdownFileContent] = useState("");
  const [markdownFileLoading, setMarkdownFileLoading] = useState(false);
  const currentDisplayContent = displayContent(node?.data);
  const markdownSourceContent = kind === "markdown" ? displayOutputEnvelopeContent(currentDisplayContent) : "";
  const markdownFilePath = kind === "markdown" ? displayTextFilePath(markdownSourceContent, "markdown") : "";
  const markdownContent = kind === "markdown" ? (markdownFilePath ? markdownFileContent : markdownSourceContent) : "";
  useEffect(() => {
    const onKeyDown = (event) => {
      if (event.key !== "Escape") return;
      if (markdownEditing) {
        setMarkdownDraft(String(markdownContent || ""));
        setMarkdownEditing(false);
        return;
      }
      onClose?.();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [markdownContent, markdownEditing, onClose]);
  useEffect(() => {
    let cancelled = false;
    if (kind !== "markdown" || !markdownFilePath) {
      setMarkdownFileContent("");
      setMarkdownFileLoading(false);
      return () => { cancelled = true; };
    }
    setMarkdownFileLoading(true);
    readWorkspaceTextFile(node?.data?.flowParams || {}, markdownFilePath)
      .then((text) => {
        if (!cancelled) setMarkdownFileContent(text);
      })
      .catch((error) => {
        if (!cancelled) {
          setMarkdownFileContent("");
          node?.data?.onStatus?.(String(error.message || error));
        }
      })
      .finally(() => {
        if (!cancelled) setMarkdownFileLoading(false);
      });
    return () => { cancelled = true; };
  }, [kind, markdownFilePath, node?.data?.flowParams?.flowId, node?.data?.flowParams?.flowSource, node?.data?.flowParams?.archived, node?.data?.displayReloadKey]);
  useEffect(() => {
    if (!markdownEditing) setMarkdownDraft(String(markdownContent || ""));
  }, [markdownContent, markdownEditing]);
  if (!node) return null;
  return createPortal(
    <div className="af-display-preview-overlay" role="dialog" aria-modal="true" aria-label="全屏预览">
      <div className="af-display-preview-shell">
        <div className="af-display-preview-head">
          <div className="af-display-preview-title">
            <span className="material-symbols-outlined" aria-hidden>{displayIcon(kind)}</span>
            <strong>{title}</strong>
            <span>{node.id}</span>
          </div>
          <div className="af-display-preview-actions">
            {kind === "markdown" ? (
              markdownEditing ? (
                <>
                  <button
                    type="button"
                    className="af-display-preview-action"
                    disabled={readOnly || markdownFileLoading}
                    onClick={async () => {
                      try {
                        await saveMarkdownDisplayEdit({
                          nodeId: node.id,
                          data: node.data,
                          filePath: markdownFilePath,
                          content: markdownDraft,
                          setFileContent: setMarkdownFileContent,
                        });
                        setMarkdownEditing(false);
                      } catch (error) {
                        node?.data?.onStatus?.(String(error.message || error));
                      }
                    }}
                    aria-label="保存并预览"
                    title="保存并预览"
                  >
                    <span className="material-symbols-outlined" aria-hidden>done</span>
                  </button>
                  <button
                    type="button"
                    className="af-display-preview-action"
                    onClick={() => {
                      setMarkdownDraft(String(markdownContent || ""));
                      setMarkdownEditing(false);
                    }}
                    aria-label="取消编辑"
                    title="取消编辑"
                  >
                    <span className="material-symbols-outlined" aria-hidden>close</span>
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="af-display-preview-action"
                  disabled={readOnly || markdownFileLoading}
                  onClick={() => {
                    setMarkdownDraft(String(markdownContent || ""));
                    setMarkdownEditing(true);
                  }}
                  aria-label="编辑 Markdown"
                  title="编辑 Markdown"
                >
                  <span className="material-symbols-outlined" aria-hidden>edit</span>
                </button>
              )
            ) : null}
            <button type="button" className="af-display-preview-action" onClick={onClose} aria-label="关闭全屏预览" title="关闭">
              <span className="material-symbols-outlined" aria-hidden>close_fullscreen</span>
            </button>
          </div>
        </div>
        <div className="af-display-preview-content">
          {kind === "markdown" && markdownEditing ? (
            <MarkdownDisplayEditor value={markdownDraft} onChange={setMarkdownDraft} onUploadImage={node.data?.onUploadWorkspaceImage} readOnly={readOnly} />
          ) : (
            <DisplayBody data={node.data} flowParams={node.data?.flowParams} htmlFrameRef={htmlFrameRef} />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function DisplayPickerPreview({ node }) {
  const kind = workspaceDisplayKindFromData(node?.data);
  const rawContent = displayContent(node?.data);
  const unwrappedRawContent = kind === "image" ? rawContent : displayOutputEnvelopeContent(rawContent);
  const filePath = kind === "image" ? "" : displayTextFilePath(unwrappedRawContent, kind);
  const [fileContent, setFileContent] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  useEffect(() => {
    let cancelled = false;
    if (!filePath) {
      setFileContent("");
      setFileLoading(false);
      return () => { cancelled = true; };
    }
    setFileLoading(true);
    setFileContent("");
    readWorkspaceTextFile(node?.data?.flowParams || {}, filePath)
      .then((text) => {
        if (!cancelled) setFileContent(text);
      })
      .catch(() => {
        if (!cancelled) setFileContent("");
      })
      .finally(() => {
        if (!cancelled) setFileLoading(false);
      });
    return () => { cancelled = true; };
  }, [filePath, node?.data?.flowParams?.flowId, node?.data?.flowParams?.flowSource, node?.data?.flowParams?.archived, node?.data?.displayReloadKey]);
  const resolvedContent = filePath ? fileContent : unwrappedRawContent;
  const content = kind === "html"
    ? normalizeHtmlDisplayContent(resolvedContent)
    : kind === "react"
      ? normalizeReactAppDisplayContent(resolvedContent)
      : displayOutputEnvelopeContent(resolvedContent);
  const contentProblem = validateDisplayContentForWrite(kind, content);
  if (fileLoading) return <div className="af-display-picker-preview__empty">Loading</div>;
  if (contentProblem) return <div className="af-display-picker-preview__empty">{contentProblem}</div>;
  if (!content.trim()) return <div className="af-display-picker-preview__empty">No content</div>;
  if (kind === "html" || kind === "react") {
    return <iframe title={node?.data?.label || node?.id} sandbox="allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox" srcDoc={kind === "react" ? reactAppDisplaySrcDoc(content) : htmlDisplaySrcDoc(content)} />;
  }
  if (kind === "image") {
    return <img src={workspaceRawFileUrl(content, node?.data?.flowParams)} alt={node?.data?.label || node?.id} loading="lazy" />;
  }
  if (kind === "markdown") {
    return (
      <div className="af-display-picker-preview__markdown">
        <MarkdownDisplayContent content={content} basePath={filePath} resolveSrc={(src, opts) => workspaceRawFileUrl(src, node?.data?.flowParams, opts)} />
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
  const scrollbarTrackRef = useRef(null);
  const [uploading, setUploading] = useState(false);
  const [scrollbar, setScrollbar] = useState({ visible: false, top: 0, height: 100 });
  const updateScrollbar = useCallback(() => {
    const el = textareaRef.current;
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
    const textarea = textareaRef.current;
    if (!textarea || typeof ResizeObserver === "undefined") {
      return () => cancelAnimationFrame(frame);
    }
    const observer = new ResizeObserver(updateScrollbar);
    observer.observe(textarea);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [updateScrollbar, value]);
  const scrollToRatio = useCallback((ratio) => {
    const el = textareaRef.current;
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
        onScroll={updateScrollbar}
        onKeyDown={(event) => {
          if (event.key === "Escape") event.stopPropagation();
        }}
        placeholder="输入 Markdown 内容"
        spellCheck={false}
        readOnly={readOnly}
      />
      <div
        ref={scrollbarTrackRef}
        className={"af-work-display-editor__scrollbar" + (scrollbar.visible ? " af-work-display-editor__scrollbar--visible" : "")}
        onPointerDown={handleScrollbarPointerDown}
        aria-hidden="true"
      >
        <span style={{ height: `${scrollbar.height}%`, top: `${scrollbar.top}%` }} />
      </div>
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
  const visibleMessages = messages.slice(-2);

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
      {(messages.length > 0 || running || error) ? (
        <div className="af-work-node-chat__messages">
          {visibleMessages.map((msg, index) => (
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
      {candidate.trim() ? (
        <div className="af-work-node-chat__messages">
          <div className="af-work-node-chat__msg af-work-node-chat__msg--assistant">
            <span>AI</span>
            <p>{candidate}</p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function displayFileExtension(kind) {
  if (kind === "mermaid") return "mmd";
  if (kind === "ascii") return "txt";
  if (kind === "html") return "html";
  if (kind === "react") return "json";
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

function workspaceNodeOutputOwnerSegment(nodeId) {
  return String(nodeId || "node")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "node";
}

function workspaceSafeOutputPath(value, kind = "") {
  const direct = displayTextFilePath(value, kind).replace(/^\/+/, "");
  return direct.startsWith("outputs/") ? direct : "";
}

function workspaceNodeOwnedOutputPaths(nodeId, data) {
  const owner = workspaceNodeOutputOwnerSegment(nodeId);
  const paths = new Set();
  const kind = workspaceDisplayKindFromData(data) || "";
  if (owner && isOneClickTaskDefinitionId(data?.definitionId)) paths.add(`outputs/${owner}`);
  const contentPath = workspaceSafeOutputPath(displayContent(data), kind);
  if (contentPath) paths.add(contentPath);
  const outputs = Array.isArray(data?.outputs) ? data.outputs : [];
  const ownsPublishedOutput = outputs.some((slot) => {
    const value = String(slot?.value ?? slot?.default ?? "").trim().replace(/^\/+/, "");
    const path = workspaceSafeOutputPath(value, kind);
    if (path) paths.add(path);
    return value === `outputs/${owner}` || value.startsWith(`outputs/${owner}/`);
  });
  if (owner && ownsPublishedOutput) paths.add(`outputs/${owner}`);
  return Array.from(paths);
}

function suggestDisplayFilePath(id, data) {
  const kind = workspaceDisplayKindFromData(data) || "markdown";
  const stem = displayFileStem(data?.label || id || kind);
  return `outputs/${stem}.${displayFileExtension(kind)}`;
}

async function saveMarkdownDisplayEdit({ nodeId, data, filePath, content, setFileContent }) {
  if (filePath) {
    const savedPath = await writeWorkspaceTextFile(data?.flowParams || {}, filePath, content);
    setFileContent?.(content);
    data?.onSetDisplayNodeContent?.(nodeId, savedPath, "replace", {
      logChat: false,
      reloadDisplay: true,
      statusMessage: `已更新 ${savedPath}`,
    });
    return;
  }
  data?.onSetDisplayNodeContent?.(nodeId, content, "replace", {
    logChat: false,
    statusMessage: "已更新 Markdown 内容",
  });
}

function WorkspaceDisplayNode({ id, data, selected, deleteNode, width, height }) {
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
  const kind = workspaceDisplayKindFromData(data);
  const displayCardRef = useRef(null);
  const htmlFrameRef = useRef(null);
  const [htmlFrameVersion, setHtmlFrameVersion] = useState(0);
  const [savingHtmlImage, setSavingHtmlImage] = useState(false);
  const [resizingDisplay, setResizingDisplay] = useState(false);
  const [markdownEditing, setMarkdownEditing] = useState(false);
  const [markdownDraft, setMarkdownDraft] = useState("");
  const [markdownFileContent, setMarkdownFileContent] = useState("");
  const [markdownFileLoading, setMarkdownFileLoading] = useState(false);
  const [imageDragActive, setImageDragActive] = useState(false);
  const imageUploadInputRef = useRef(null);
  const currentDisplayContent = displayContent(data);
  const markdownSourceContent = kind === "markdown" ? displayOutputEnvelopeContent(currentDisplayContent) : "";
  const markdownFilePath = kind === "markdown" ? displayTextFilePath(markdownSourceContent, "markdown") : "";
  const markdownContent = kind === "markdown" ? (markdownFilePath ? markdownFileContent : markdownSourceContent) : "";
  const readOnly = Boolean(data?.readOnly);
  const presentationMode = Boolean(data?.displayPageMode);
  useEffect(() => {
    let cancelled = false;
    if (kind !== "markdown" || !markdownFilePath) {
      setMarkdownFileContent("");
      setMarkdownFileLoading(false);
      return () => { cancelled = true; };
    }
    setMarkdownFileLoading(true);
    readWorkspaceTextFile(data?.flowParams || {}, markdownFilePath)
      .then((text) => {
        if (!cancelled) setMarkdownFileContent(text);
      })
      .catch((error) => {
        if (!cancelled) {
          setMarkdownFileContent("");
          data?.onStatus?.(String(error.message || error));
        }
      })
      .finally(() => {
        if (!cancelled) setMarkdownFileLoading(false);
      });
    return () => { cancelled = true; };
  }, [kind, markdownFilePath, data?.flowParams?.flowId, data?.flowParams?.flowSource, data?.flowParams?.archived, data?.displayReloadKey]);
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
  const title = data?.label || (kind === "mermaid" ? "Mermaid" : kind === "ascii" ? "ASCII" : kind === "html" ? "HTML" : kind === "react" ? "React App" : kind === "image" ? "Image" : kind === "chart" ? "Chart" : kind === "table" ? "Table" : "Markdown");
  const shareNodeId = String(data?.sourceNodeId || id);
  const sharingDisplay = data?.sharingDisplayNodeId === shareNodeId;
  const persistedDisplaySize = data?.displaySize && Number(data.displaySize.width) > 0 && Number(data.displaySize.height) > 0
    ? { width: Number(data.displaySize.width), height: Number(data.displaySize.height) }
    : null;
  const displaySize = workspaceResizePresentationSize({
    resizing: resizingDisplay,
    liveSize: normalizeWorkspaceDisplaySize({ width, height }),
    persistedSize: persistedDisplaySize,
  });
  const saveHtmlImage = useCallback(async () => {
    if (kind !== "html" || savingHtmlImage) return;
    const rawContent = displayContent(data);
    const filePath = displayTextFilePath(rawContent, kind);
    let sourceContent = rawContent;
    if (filePath) {
      try {
        sourceContent = await readWorkspaceTextFile(data?.flowParams || {}, filePath);
      } catch (error) {
        setSavingHtmlImage(false);
        console.warn("Failed to read HTML display file before saving image.", error);
        return;
      }
    }
    const content = normalizeHtmlDisplayContent(sourceContent);
    if (!content.trim()) return;
    const problem = validateDisplayContentForWrite(kind, content);
    if (problem) {
      console.warn(problem);
      return;
    }
    const rect = htmlFrameRef.current?.getBoundingClientRect?.();
    const displayBodyEl = displayCardRef.current?.querySelector?.(".af-work-display-body");
    const scrollerEl = displayCardRef.current?.querySelector?.(".af-visible-scroll-frame__scroller");
    const width = Math.round(Math.max(
      Number(rect?.width || 0),
      Number(displaySize?.width || 0),
      Number(displayCardRef.current?.clientWidth || 0),
      Number(displayBodyEl?.clientWidth || 0),
      Number(scrollerEl?.clientWidth || 0),
      Math.max(320, Number(displaySize?.width || 960) - 2),
    ));
    const height = Math.round(Math.max(
      Number(rect?.height || 0),
      Number(displaySize?.height || 0),
      Number(displayCardRef.current?.clientHeight || 0),
      Number(displayBodyEl?.clientHeight || 0),
      Number(scrollerEl?.clientHeight || 0),
      Math.max(180, Number(displaySize?.height || 640) - 46),
    ));
    setSavingHtmlImage(true);
    try {
      await saveHtmlDisplayAsImage({
        flowParams: data?.flowParams || {},
        content,
        sourceFilePath: filePath,
        iframe: htmlFrameRef.current,
        width,
        height,
        filename: safeDownloadFilename(data?.label || id || "html-render", "png"),
        snapshotElements: {
          card: displayCardRef.current,
          displayBody: displayBodyEl,
          scroller: scrollerEl,
        },
        displaySize,
      });
      data?.onStatus?.("已导出 HTML 展示截图");
    } catch (error) {
      const message = String(error?.message || error || "截图失败");
      data?.onStatus?.(`HTML 截图失败：${message}`);
      console.warn("Failed to save HTML display as PNG.", error);
    } finally {
      setSavingHtmlImage(false);
    }
  }, [data, displaySize?.height, displaySize?.width, id, kind, savingHtmlImage]);
  const uploadImageFile = useCallback((file) => {
    if (readOnly) return;
    if (!file || kind !== "image") return;
    data?.onUploadImageToDisplayNode?.(id, file);
  }, [data, id, kind, readOnly]);
  const clearDisplayContent = useCallback((event) => {
    event?.stopPropagation?.();
    if (readOnly) return;
    data?.onSetDisplayNodeContent?.(id, "", "replace", {
      logChat: false,
      reloadDisplay: true,
      statusMessage: "已清空 Display 内容",
    });
    if (kind === "markdown") {
      setMarkdownDraft("");
      setMarkdownEditing(false);
    }
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
        (data?.hasConnections ? " af-work-display-card--connected" : "") +
        (selected ? " af-work-display-card--selected" : "") +
        (resizingDisplay ? " af-work-display-card--resizing" : "") +
        (imageDragActive ? " af-work-display-card--image-drop" : "") +
        (presentationMode ? " af-work-display-card--presentation" : "") +
        (data?.isExecuting ? " af-work-display-card--executing" : "") +
        (data?.nodeStatus === "success" ? " af-work-display-card--done" : "") +
        (data?.nodeStatus === "failed" ? " af-work-display-card--failed" : "")
      }
      style={displaySize ? { width: displaySize.width, height: displaySize.height } : undefined}
      ref={displayCardRef}
      onPointerDownCapture={data?.onSelectNodePointerDown}
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
                disabled={readOnly || markdownFileLoading}
                onClick={async () => {
                  try {
                    await saveMarkdownDisplayEdit({
                      nodeId: id,
                      data,
                      filePath: markdownFilePath,
                      content: markdownDraft,
                      setFileContent: setMarkdownFileContent,
                    });
                    setMarkdownEditing(false);
                  } catch (error) {
                    data?.onStatus?.(String(error.message || error));
                  }
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
              disabled={readOnly || markdownFileLoading}
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
          onClick={(event) => {
            event.stopPropagation();
            data?.onOpenDisplayPreview?.(shareNodeId);
          }}
          aria-label="全屏预览"
          title="全屏预览"
        >
          <span className="material-symbols-outlined">fullscreen</span>
        </button>
        <button
          type="button"
          className="af-work-display-card__action nodrag"
          disabled={sharingDisplay}
          onClick={(event) => {
            event.stopPropagation();
            data?.onShareDisplayNode?.(shareNodeId);
          }}
          aria-label="分享展示"
          title="分享展示"
        >
          <span className="material-symbols-outlined">{sharingDisplay ? "hourglass_empty" : "ios_share"}</span>
        </button>
        <button
          type="button"
          className="af-work-display-card__action nodrag"
          disabled={readOnly}
          onClick={clearDisplayContent}
          aria-label="清空内容"
          title="清空内容"
        >
          <span className="material-symbols-outlined">delete_sweep</span>
        </button>
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
  const running = data?.runningRunNodeIds?.has?.(id) || data?.runningRunNodeIds?.[id] === true || data?.isExecuting || data?.nodeStatus === "running";
  const optimizing = data?.optimizingRun === true;
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
      onPointerDownCapture={data?.onSelectNodePointerDown}
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
      <div className="af-work-run-card__actions">
        <button
          type="button"
          className={"af-work-run-card__button nodrag" + (running ? " af-work-run-card__button--stop" : "")}
          disabled={readOnly || optimizing}
          onClick={(event) => {
            event.stopPropagation();
            if (running) data?.onStopWorkspaceNode?.(id);
            else data?.onRunWorkspaceNode?.(id);
          }}
        >
          <span className="material-symbols-outlined">{running ? "stop_circle" : "play_arrow"}</span>
          <span>{running ? "Stop" : "Run line"}</span>
        </button>
        <button
          type="button"
          className="af-work-run-card__button af-work-run-card__rerun nodrag"
          disabled={readOnly || running || optimizing}
          title="忽略缓存重跑：上游节点即使产出还在、指纹也对得上，照样重新执行"
          aria-label="忽略缓存重跑"
          onClick={(event) => {
            event.stopPropagation();
            data?.onRunWorkspaceNode?.(id, { ignoreCache: true });
          }}
        >
          <span className="material-symbols-outlined">restart_alt</span>
        </button>
        <button
          type="button"
          className={"af-work-run-card__button af-work-run-card__optimize nodrag" + (optimizing ? " af-work-run-card__optimize--running" : "")}
          disabled={readOnly || running || optimizing}
          title={optimizing ? "正在优化" : "为下游节点提前生成 implementation"}
          aria-label={optimizing ? "正在优化" : "优化"}
          onClick={(event) => {
            event.stopPropagation();
            data?.onOptimizeWorkspaceRun?.(id);
          }}
        >
          <span className="material-symbols-outlined">{optimizing ? "sync" : "auto_fix_high"}</span>
        </button>
        <button
          type="button"
          className="af-work-run-card__button af-work-run-card__logs nodrag"
          title="查看执行日志"
          aria-label="查看执行日志"
          onClick={(event) => {
            event.stopPropagation();
            data?.onOpenWorkspaceRunLogs?.({
              nodeId: id,
              runNodeId: id,
              scheduleNodeId: "",
              label: data?.label || "Run",
            });
          }}
        >
          <span className="material-symbols-outlined">article</span>
        </button>
      </div>
    </div>
  );
}

function WorkspaceContextRunNode({ id, data, selected, deleteNode, skills, skillCollections, workspaces }) {
  const inputs = Array.isArray(data?.inputs) ? data.inputs : [];
  const outputs = Array.isArray(data?.outputs) ? data.outputs : [];
  const config = contextRunConfigFromData(data);
  const [taskDraft, setTaskDraft] = useState(config.task);
  const composingTaskRef = useRef(false);
  const lastConfigTaskRef = useRef(config.task);
  const running = data?.runningRunNodeIds?.has?.(id) || data?.runningRunNodeIds?.[id] === true || data?.isExecuting || data?.nodeStatus === "running";
  const stopped = data?.nodeStatus === "stopped";
  const readOnly = Boolean(data?.readOnly);
  const skillsList = Array.isArray(skills) ? skills : [];
  const collectionsList = Array.isArray(skillCollections) ? skillCollections : [];
  const workspaceList = useMemo(() => (Array.isArray(workspaces) ? workspaces : [])
    .map((item) => ({
      id: String(item?.id || ""),
      label: String(item?.label || item?.name || "知识库"),
      kind: item?.kind === "git" ? "git" : "local",
      path: String(item?.path || ""),
      repoUrl: String(item?.repoUrl || ""),
      branch: String(item?.branch || ""),
      mountPath: String(item?.mountPath || ""),
      builtin: item?.builtin === true,
      exists: item?.exists !== false,
      type: String(item?.type || ""),
    }))
    .filter((item) => item.path), [workspaces]);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skillsSearch, setSkillsSearch] = useState("");
  const [collapsedSkillGroups, setCollapsedSkillGroups] = useState(() => new Set());
  const [workspaceOpen, setWorkspaceOpen] = useState(false);
  const [workspaceSearch, setWorkspaceSearch] = useState("");
  const [viewMode, setViewMode] = useState("config");
  const outputPreview = contextRunResultContentFromData(data);
  const hasResult = Boolean(outputPreview);
  const displayDefinitionId = contextRunDisplayDefinitionId(config.displayType);
  const resultDisplaySize = useMemo(
    () => contextRunResultDisplaySizeFromData(data, displayDefinitionId),
    [data?.displaySize, data?.nodeSize, data?.inputs, data?.input, displayDefinitionId],
  );
  const resultDisplayData = useMemo(() => ({
    ...data,
    sourceNodeId: id,
    label: data?.label && data.label !== "Context Run" ? data.label : "一键任务",
    definitionId: displayDefinitionId,
    displaySize: resultDisplaySize,
    nodeSize: resultDisplaySize,
    body: outputPreview,
    inputs: [{ type: "text", name: displayDefinitionId === "display_image" ? "src" : "content", value: outputPreview, default: outputPreview }],
    outputs: outputs.length ? outputs : [{ type: "node", name: "next", default: "" }],
  }), [data, displayDefinitionId, id, outputPreview, outputs, resultDisplaySize]);
  const cursorModels = Array.isArray(data?.modelLists?.cursor) ? data.modelLists.cursor : [];
  const opencodeModels = Array.isArray(data?.modelLists?.opencode) ? data.modelLists.opencode : [];
  const claudeCodeModels = Array.isArray(data?.modelLists?.claudeCode) ? data.modelLists.claudeCode : [];
  const codexModels = Array.isArray(data?.modelLists?.codex) ? data.modelLists.codex : [];
  const cursorModelIds = useMemo(() => new Set(cursorModels.map(workspaceModelEntryId)), [cursorModels]);
  const opencodeModelIds = useMemo(() => new Set(opencodeModels.map(workspaceModelEntryId)), [opencodeModels]);
  const claudeCodeModelIds = useMemo(() => new Set(claudeCodeModels.map(workspaceModelEntryId)), [claudeCodeModels]);
  const codexModelIds = useMemo(() => new Set(codexModels.map(workspaceModelEntryId)), [codexModels]);
  const rawModel = config.model;
  const normalizedModelForSelect = useMemo(() => {
    if (!rawModel) return "";
    if (
      rawModel.startsWith("cursor:") ||
      rawModel.startsWith("opencode:") ||
      rawModel.startsWith("codex:") ||
      rawModel.startsWith("claude-code:")
    ) return rawModel;
    if (claudeCodeModelIds.has(rawModel)) return `claude-code:${rawModel}`;
    if (codexModelIds.has(rawModel)) return `codex:${rawModel}`;
    if (opencodeModelIds.has(rawModel)) return `opencode:${rawModel}`;
    if (cursorModelIds.has(rawModel)) return `cursor:${rawModel}`;
    return rawModel;
  }, [claudeCodeModelIds, codexModelIds, cursorModelIds, opencodeModelIds, rawModel]);
  const displayModel = rawModel.startsWith("cursor:")
    ? rawModel.slice(7)
    : rawModel.startsWith("opencode:")
      ? rawModel.slice(9)
      : rawModel.startsWith("codex:")
        ? rawModel.slice(6)
        : rawModel.startsWith("claude-code:")
          ? rawModel.slice(12)
          : rawModel;
  const bareModel = displayModel;
  const modelNotInLists = Boolean(rawModel) &&
    !cursorModelIds.has(bareModel) &&
    !opencodeModelIds.has(bareModel) &&
    !claudeCodeModelIds.has(bareModel) &&
    !codexModelIds.has(bareModel);
  const selectedSkillSet = useMemo(() => new Set(config.skillKeys), [config.skillKeys]);
  const skillsByKey = useMemo(() => new Map(skillsList.map((skill) => [skill.key, skill])), [skillsList]);
  const skillGroups = useMemo(() => {
    const used = new Set();
    const collectionGroups = collectionsList
      .map((collection) => {
        const groupSkills = collectionSkillKeys(collection, skillsList).map((key) => skillsByKey.get(key)).filter(Boolean);
        for (const skill of groupSkills) used.add(skill.key);
        return { ...collection, skills: groupSkills };
      })
      .filter((collection) => collection.skills.length > 0);
    const ungrouped = skillsList.filter((skill) => !used.has(skill.key));
    return { collectionGroups, ungrouped };
  }, [collectionsList, skillsByKey, skillsList]);
  useEffect(() => {
    setCollapsedSkillGroups((current) => {
      let changed = false;
      const next = new Set(current);
      for (const group of skillGroups.collectionGroups) {
        if (!next.has(group.id)) {
          next.add(group.id);
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [skillGroups.collectionGroups]);
  const filteredSkillGroups = useMemo(() => {
    const q = skillsSearch.trim().toLowerCase();
    if (!q) return skillGroups;
    const matchesSkill = (skill) => [skill?.key, skill?.name, skill?.description]
      .map((part) => String(part || "").toLowerCase())
      .join(" ")
      .includes(q);
    const collectionGroups = skillGroups.collectionGroups
      .map((group) => {
        const groupMatches = [group?.id, group?.name, group?.description]
          .map((part) => String(part || "").toLowerCase())
          .join(" ")
          .includes(q);
        return { ...group, skills: groupMatches ? group.skills : group.skills.filter(matchesSkill) };
      })
      .filter((group) => group.skills.length > 0);
    return { collectionGroups, ungrouped: skillGroups.ungrouped.filter(matchesSkill) };
  }, [skillGroups, skillsSearch]);
  const skillsMenuScrollbar = useWorkspaceMenuScrollbar(skillsOpen, [
    filteredSkillGroups.collectionGroups.length,
    filteredSkillGroups.ungrouped.length,
    collapsedSkillGroups.size,
    config.skillKeys.length,
    skillsSearch,
  ]);
  const filteredWorkspaces = useMemo(() => {
    const q = workspaceSearch.trim().toLowerCase();
    if (!q) return workspaceList;
    return workspaceList.filter((item) => [item.id, item.label, item.path, item.repoUrl, item.branch, item.mountPath, item.type].join(" ").toLowerCase().includes(q));
  }, [workspaceList, workspaceSearch]);
  const selectedKnowledgeSources = useMemo(() => knowledgeSourcesFromContext(config.knowledgeContext), [config.knowledgeContext]);
  const selectedKnowledgeKeys = useMemo(() => new Set(selectedKnowledgeSources.map((item) => item.id || item.path || item.repoPath).filter(Boolean)), [selectedKnowledgeSources]);
  const workspaceMenuScrollbar = useWorkspaceMenuScrollbar(workspaceOpen, [
    filteredWorkspaces.length,
    selectedKnowledgeSources.length,
    workspaceSearch,
  ]);
  useEffect(() => {
    if (config.task === lastConfigTaskRef.current) return;
    lastConfigTaskRef.current = config.task;
    if (!composingTaskRef.current) setTaskDraft(config.task);
  }, [config.task]);
  useEffect(() => {
    if (!hasResult) {
      setViewMode("config");
      return;
    }
    if (!running) {
      setViewMode("result");
    }
  }, [hasResult, outputPreview, running]);
  useEffect(() => {
    if (!(viewMode === "result" && hasResult)) return undefined;
    data?.onEnsureWorkspaceNodeDisplaySize?.(id, resultDisplaySize);
    data?.onRefreshNodeInternals?.(id);
    const timer = window.setTimeout(() => data?.onRefreshNodeInternals?.(id), 120);
    return () => window.clearTimeout(timer);
  }, [data?.onEnsureWorkspaceNodeDisplaySize, data?.onRefreshNodeInternals, displayDefinitionId, hasResult, id, outputPreview, resultDisplaySize, viewMode]);
  const updateConfig = (patch) => {
    data?.onChangeContextRunConfig?.(id, { ...config, task: taskDraft, ...patch });
  };
  const commitTaskDraft = (value = taskDraft) => {
    const text = String(value ?? "");
    if (text !== config.task) {
      lastConfigTaskRef.current = text;
      data?.onChangeContextRunConfig?.(id, { ...config, task: text });
    }
  };
  const toggleSkillKeys = (keys, checked) => {
    const next = new Set(config.skillKeys);
    for (const key of keys) {
      const text = String(key || "").trim();
      if (!text) continue;
      if (checked) next.add(text);
      else next.delete(text);
    }
    updateConfig({ skillKeys: Array.from(next) });
  };
  const toggleCollapsedSkillGroup = (groupId) => {
    setCollapsedSkillGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };
  const toggleKnowledgeSource = (workspace, checked) => {
    const key = workspace?.id || workspace?.path || "";
    if (!key) return;
    const selected = workspaceList.filter((item) => {
      const itemKey = item.id || item.path || "";
      if (itemKey === key) return checked;
      return selectedKnowledgeKeys.has(itemKey);
    });
    updateConfig({ knowledgeContext: knowledgeContextFromWorkspaces(selected) });
  };
  const clearKnowledgeSources = () => {
    updateConfig({ knowledgeContext: null });
  };
  if (viewMode === "result" && hasResult) {
    return (
      <WorkspaceDisplayNode
        id={id}
        data={{
          ...resultDisplayData,
          selected: data?.selected,
          onSelectNodePointerDown: data?.onSelectNodePointerDown,
        }}
        selected={selected}
        deleteNode={deleteNode}
      />
    );
  }
  return (
    <div
      className={
        "af-work-context-run-card" +
        (selected ? " af-work-context-run-card--selected" : "") +
        (viewMode === "result" && hasResult ? " af-work-context-run-card--result" : "") +
        (running ? " af-work-context-run-card--running" : "") +
        (data?.nodeStatus === "success" ? " af-work-context-run-card--done" : "") +
        (data?.nodeStatus === "failed" ? " af-work-context-run-card--failed" : "") +
        (stopped ? " af-work-context-run-card--stopped" : "")
      }
      onPointerDownCapture={data?.onSelectNodePointerDown}
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
      <div className="af-work-context-run-card__head">
        <span className="material-symbols-outlined">automation</span>
        <strong>{data?.label && data.label !== "Context Run" ? data.label : "一键任务"}</strong>
        <div
          className="af-work-context-run-card__model-wrap nodrag"
          onPointerDown={(event) => event.stopPropagation()}
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
        >
          <select
            className="af-work-context-run-card__model"
            value={normalizedModelForSelect}
            disabled={readOnly}
            aria-label="模型"
            title={displayModel || "默认模型"}
            onChange={(event) => updateConfig({ model: event.target.value })}
          >
            <option value="">默认</option>
            {modelNotInLists ? <option value={rawModel}>{rawModel}</option> : null}
            {cursorModels.length ? (
              <optgroup label="Cursor">
                {cursorModels.map((item) => (
                  <option key={`context-cursor-${item}`} value={`cursor:${workspaceModelEntryId(item)}`}>
                    {workspaceModelEntryId(item)}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {opencodeModels.length ? (
              <optgroup label="OpenCode">
                {opencodeModels.map((item) => (
                  <option key={`context-opencode-${item}`} value={`opencode:${workspaceModelEntryId(item)}`}>
                    {workspaceModelEntryId(item)}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {codexModels.length ? (
              <optgroup label="Codex">
                {codexModels.map((item) => (
                  <option key={`context-codex-${item}`} value={`codex:${workspaceModelEntryId(item)}`}>
                    {workspaceModelEntryId(item)}
                  </option>
                ))}
              </optgroup>
            ) : null}
            {claudeCodeModels.length ? (
              <optgroup label="Claude Code">
                {claudeCodeModels.map((item) => (
                  <option key={`context-claude-${item}`} value={`claude-code:${workspaceModelEntryId(item)}`}>
                    {workspaceModelEntryId(item)}
                  </option>
                ))}
              </optgroup>
            ) : null}
          </select>
          <span className="material-symbols-outlined" aria-hidden>expand_more</span>
        </div>
        <span className="af-work-context-run-card__kind">{isOneClickTaskDefinitionId(data?.definitionId) ? "workspace_one_click_task" : (data?.definitionId || "workspace_one_click_task")}</span>
        {hasResult ? (
          <div className="af-work-context-run-card__view-switch nodrag" onClick={(event) => event.stopPropagation()}>
            <button
              type="button"
              className={viewMode === "config" ? "is-active" : ""}
              onClick={() => setViewMode("config")}
              aria-label="切换到任务配置"
            >
              <span className="material-symbols-outlined">tune</span>
            </button>
            <button
              type="button"
              className={viewMode === "result" ? "is-active" : ""}
              onClick={() => setViewMode("result")}
              aria-label="切换到展示结果"
            >
              <span className="material-symbols-outlined">preview</span>
            </button>
          </div>
        ) : null}
        <button type="button" className="af-work-display-card__close nodrag" disabled={readOnly} onClick={() => deleteNode?.(id)} aria-label="删除节点">
          <span className="material-symbols-outlined">close</span>
        </button>
      </div>
      <div className="af-work-context-run-card__body nodrag">
        <>
            <textarea
          value={taskDraft}
          disabled={readOnly}
          placeholder="输入任务，例如：基于选中的知识库总结需求并生成展示页"
          onCompositionStart={() => {
            composingTaskRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingTaskRef.current = false;
            setTaskDraft(event.currentTarget.value);
            commitTaskDraft(event.currentTarget.value);
          }}
          onChange={(event) => {
            setTaskDraft(event.target.value);
          }}
          onBlur={(event) => commitTaskDraft(event.currentTarget.value)}
        />
        <div className="af-work-context-run-card__grid">
          <div className="af-work-context-run-card__skills">
            <button
              type="button"
              disabled={readOnly}
              className="af-work-context-run-card__select"
              onClick={(event) => {
                event.stopPropagation();
                if (!skillsOpen) data?.onRefreshSkills?.();
                setSkillsOpen((open) => !open);
              }}
            >
              <span className="material-symbols-outlined">extension</span>
              <span>{config.skillKeys.length ? `${config.skillKeys.length} skills` : "Skills"}</span>
              <span className="material-symbols-outlined">expand_more</span>
            </button>
            {skillsOpen ? (
              <div className="af-work-context-run-card__skills-menu" onClick={(event) => event.stopPropagation()}>
                <div className="af-work-load-skills-search">
                  <span className="material-symbols-outlined" aria-hidden>search</span>
                  <input
                    type="search"
                    value={skillsSearch}
                    onChange={(event) => setSkillsSearch(event.target.value)}
                    placeholder="搜索 Skills..."
                    spellCheck={false}
                    autoComplete="off"
                    aria-label="搜索 Skills"
                  />
                  {skillsSearch ? (
                    <button type="button" onClick={() => setSkillsSearch("")} aria-label="清空搜索">
                      <span className="material-symbols-outlined" aria-hidden>close</span>
                    </button>
                  ) : null}
                </div>
                <div
                  ref={skillsMenuScrollbar.menuRef}
                  className="af-work-load-skills-menu af-work-context-run-card__menu-scroll"
                  onScroll={skillsMenuScrollbar.updateMenuScrollbar}
                >
                  {filteredSkillGroups.collectionGroups.map((group) => {
                    const groupKeys = group.skills.map((skill) => skill.key);
                    const checkedCount = groupKeys.filter((key) => selectedSkillSet.has(key)).length;
                    const allChecked = groupKeys.length > 0 && checkedCount === groupKeys.length;
                    const collapsed = collapsedSkillGroups.has(group.id);
                    return (
                      <section key={group.id} className={"af-work-load-skills-menu__group" + (collapsed ? " af-work-load-skills-menu__group--collapsed" : "")}>
                        <div className="af-work-load-skills-menu__group-head">
                          <input
                            type="checkbox"
                            checked={allChecked}
                            disabled={readOnly}
                            onChange={(event) => toggleSkillKeys(groupKeys, event.target.checked)}
                            aria-label={`选择 ${group.name}`}
                          />
                          <button
                            type="button"
                            className="af-work-load-skills-menu__group-toggle"
                            onClick={() => toggleCollapsedSkillGroup(group.id)}
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
                            onClick={() => toggleCollapsedSkillGroup(group.id)}
                            aria-label={collapsed ? `展开 ${group.name}` : `收起 ${group.name}`}
                          >
                            <span className="material-symbols-outlined" aria-hidden>{collapsed ? "chevron_right" : "expand_more"}</span>
                          </button>
                        </div>
                        {!collapsed ? (
                          <div className="af-work-load-skills-menu__options">
                            {group.skills.map((skill) => (
                              <label key={`${group.id}:${skill.key}`} className="af-work-load-skills-menu__option">
                                <input
                                  type="checkbox"
                                  checked={selectedSkillSet.has(skill.key)}
                                  disabled={readOnly}
                                  onChange={(event) => toggleSkillKeys([skill.key], event.target.checked)}
                                />
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
                  {filteredSkillGroups.ungrouped.length > 0 ? (
                    <section className="af-work-load-skills-menu__group">
                      <div className="af-work-load-skills-menu__group-head af-work-load-skills-menu__group-head--plain">
                        <span>Ungrouped</span>
                        <small>{filteredSkillGroups.ungrouped.length}</small>
                      </div>
                      <div className="af-work-load-skills-menu__options">
                        {filteredSkillGroups.ungrouped.map((skill) => (
                          <label key={`ungrouped:${skill.key}`} className="af-work-load-skills-menu__option">
                            <input
                              type="checkbox"
                              checked={selectedSkillSet.has(skill.key)}
                              disabled={readOnly}
                              onChange={(event) => toggleSkillKeys([skill.key], event.target.checked)}
                            />
                            <span className="af-work-load-skills-menu__option-main">
                              <span className="af-work-load-skills-menu__option-title">{skill.name}</span>
                              {skill.description ? <span className="af-work-load-skills-menu__option-desc">{skill.description}</span> : null}
                            </span>
                          </label>
                        ))}
                      </div>
                    </section>
                  ) : null}
                  {filteredSkillGroups.collectionGroups.length === 0 && filteredSkillGroups.ungrouped.length === 0 ? (
                    <div className="af-work-load-skills-menu__empty">没有匹配的 Skills</div>
                  ) : null}
                  <button type="button" className="af-work-load-skills-menu__clear" onClick={() => updateConfig({ skillKeys: [] })}>清空</button>
                </div>
                <div
                  ref={skillsMenuScrollbar.scrollbarTrackRef}
                  className={"af-work-load-skills-scrollbar" + (skillsMenuScrollbar.scrollbar.visible ? " af-work-load-skills-scrollbar--visible" : "")}
                  onPointerDown={skillsMenuScrollbar.handleScrollbarPointerDown}
                  aria-hidden="true"
                >
                  <span style={{ height: `${skillsMenuScrollbar.scrollbar.height}%`, top: `${skillsMenuScrollbar.scrollbar.top}%` }} />
                </div>
              </div>
            ) : null}
          </div>
          <div className="af-work-context-run-card__workspace">
            <button
              type="button"
              disabled={readOnly}
              className="af-work-context-run-card__select"
              onClick={(event) => {
                event.stopPropagation();
                if (!workspaceOpen) data?.onRefreshWorkspaces?.();
                setWorkspaceOpen((open) => !open);
              }}
            >
              <span className="material-symbols-outlined">{selectedKnowledgeSources.length ? "folder_open" : "folder_off"}</span>
              <span>{selectedKnowledgeSources.length ? `${selectedKnowledgeSources.length} 知识库` : "知识库"}</span>
              <span className="material-symbols-outlined">expand_more</span>
            </button>
            {workspaceOpen ? (
              <div className="af-work-context-run-card__workspace-menu" onClick={(event) => event.stopPropagation()}>
                <div className="af-work-load-skills-search">
                  <span className="material-symbols-outlined" aria-hidden>search</span>
                  <input
                    type="search"
                    value={workspaceSearch}
                    onChange={(event) => setWorkspaceSearch(event.target.value)}
                    placeholder="搜索知识库..."
                    spellCheck={false}
                    autoComplete="off"
                    aria-label="搜索知识库"
                  />
                  {workspaceSearch ? (
                    <button type="button" onClick={() => setWorkspaceSearch("")} aria-label="清空搜索">
                      <span className="material-symbols-outlined" aria-hidden>close</span>
                    </button>
                  ) : null}
                </div>
                <div
                  ref={workspaceMenuScrollbar.menuRef}
                  className="af-work-load-skills-menu af-work-context-run-card__menu-scroll"
                  onScroll={workspaceMenuScrollbar.updateMenuScrollbar}
                >
                  <section className="af-work-load-skills-menu__group">
                    <div className="af-work-load-skills-menu__group-head af-work-load-skills-menu__group-head--plain">
                      <span>知识库</span>
                      <small>{filteredWorkspaces.length}</small>
                    </div>
                    <div className="af-work-load-skills-menu__options">
                      {filteredWorkspaces.map((item) => (
                        <label key={`${item.id}:${item.path}`} className="af-work-load-skills-menu__option">
                          <input
                            type="checkbox"
                            checked={selectedKnowledgeKeys.has(item.id || item.path)}
                            disabled={readOnly}
                            onChange={(event) => toggleKnowledgeSource(item, event.target.checked)}
                          />
                          <span className="af-work-load-skills-menu__option-main">
                            <span className="af-work-load-skills-menu__option-title">{item.label}</span>
                            <span className="af-work-load-skills-menu__option-desc">
                              {item.kind === "git" && item.repoUrl ? `${item.repoUrl}${item.branch ? ` · ${item.branch}` : ""}${item.mountPath ? ` · ${item.mountPath}` : ""}` : item.path}
                              {item.exists ? "" : " · 路径未就绪"}
                            </span>
                          </span>
                        </label>
                      ))}
                    </div>
                  </section>
                  {filteredWorkspaces.length === 0 ? (
                    <div className="af-work-load-skills-menu__empty">没有匹配的知识库</div>
                  ) : null}
                  <button type="button" className="af-work-load-skills-menu__clear" onClick={clearKnowledgeSources}>清空知识库</button>
                </div>
                <div
                  ref={workspaceMenuScrollbar.scrollbarTrackRef}
                  className={"af-work-load-skills-scrollbar" + (workspaceMenuScrollbar.scrollbar.visible ? " af-work-load-skills-scrollbar--visible" : "")}
                  onPointerDown={workspaceMenuScrollbar.handleScrollbarPointerDown}
                  aria-hidden="true"
                >
                  <span style={{ height: `${workspaceMenuScrollbar.scrollbar.height}%`, top: `${workspaceMenuScrollbar.scrollbar.top}%` }} />
                </div>
              </div>
            ) : null}
          </div>
          <select
            value={config.displayType}
            disabled={readOnly}
            onChange={(event) => updateConfig({ displayType: event.target.value })}
          >
            <option value="markdown">Markdown</option>
            <option value="html">HTML</option>
            <option value="react">React</option>
            <option value="table">Table</option>
            <option value="chart">Chart</option>
            <option value="ascii">ASCII</option>
            <option value="mermaid">Mermaid</option>
          </select>
        </div>
        {outputPreview ? (
          <pre className="af-work-context-run-card__preview">{outputPreview.slice(0, 520)}</pre>
        ) : null}
        </>
        <div className="af-work-context-run-card__actions">
          <button
            type="button"
            className={"af-work-run-card__button af-work-context-run-card__run nodrag" + (running ? " af-work-run-card__button--stop" : "")}
            disabled={readOnly}
            onClick={(event) => {
              event.stopPropagation();
              commitTaskDraft();
              if (running) data?.onStopWorkspaceNode?.(id);
              else data?.onRunWorkspaceNode?.(id);
            }}
          >
            <span className="material-symbols-outlined">{running ? "stop_circle" : "play_arrow"}</span>
            <span>{running ? "Stop" : "Run"}</span>
          </button>
          <button
            type="button"
            className="af-work-run-card__button af-work-context-run-card__logs nodrag"
            onClick={(event) => {
              event.stopPropagation();
              data?.onOpenWorkspaceRunLogs?.({
                nodeId: id,
                runNodeId: id,
                scheduleNodeId: "",
                label: data?.label && data.label !== "Context Run" ? data.label : "一键任务",
              });
            }}
          >
            <span className="material-symbols-outlined">article</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function WorkspaceScheduledRunNode({ id, data, selected, deleteNode }) {
  const inputs = Array.isArray(data?.inputs) ? data.inputs : [];
  const outputs = Array.isArray(data?.outputs) ? data.outputs : [];
  const config = normalizeScheduledRunConfig(data?.body || "");
  const [cronDraft, setCronDraft] = useState(config.cron);
  const scheduleState = data?.scheduledRunState || {};
  const running = data?.runningRunNodeIds?.has?.(id) || data?.runningRunNodeIds?.[id] === true || data?.isExecuting || data?.nodeStatus === "running";
  const optimizing = data?.optimizingRun === true;
  const stopped = data?.nodeStatus === "stopped";
  const readOnly = Boolean(data?.readOnly);
  const updateConfig = (patch) => {
    data?.onChangeScheduledRunConfig?.(id, { ...config, ...patch });
  };
  const updateScheduleType = (scheduleType) => {
    updateConfig({ scheduleType, cron: scheduleCronFromParts(scheduleType, config.time, config.weekday, config.monthDay, config.cron) });
  };
  const updateScheduleTime = (time) => {
    updateConfig({ time, cron: scheduleCronFromParts(config.scheduleType, time, config.weekday, config.monthDay, config.cron) });
  };
  const [selectedHour, selectedMinute] = normalizeScheduleTime(config.time).split(":");
  const updateScheduleHourMinute = (hour, minute) => {
    updateScheduleTime(`${padScheduleNumber(hour, 9, 0, 23)}:${padScheduleNumber(minute, 0, 0, 59)}`);
  };
  const updateWeekday = (weekday) => {
    updateConfig({ weekday, cron: scheduleCronFromParts(config.scheduleType, config.time, weekday, config.monthDay, config.cron) });
  };
  const updateMonthDay = (monthDay) => {
    updateConfig({ monthDay, cron: scheduleCronFromParts(config.scheduleType, config.time, config.weekday, monthDay, config.cron) });
  };
  useEffect(() => {
    setCronDraft(config.cron);
  }, [config.cron, id]);
  const commitCronDraft = () => {
    if (readOnly || cronDraft === config.cron) return;
    updateConfig({ cron: cronDraft });
  };
  return (
    <div
      className={
        "af-work-run-card af-work-schedule-card" +
        (selected ? " af-work-run-card--selected" : "") +
        (config.enabled ? " af-work-schedule-card--enabled" : "") +
        (running ? " af-work-run-card--running" : "") +
        (data?.isExecuting ? " af-work-run-card--executing" : "") +
        (data?.nodeStatus === "success" ? " af-work-run-card--done" : "") +
        (data?.nodeStatus === "failed" ? " af-work-run-card--failed" : "") +
        (stopped ? " af-work-run-card--stopped" : "")
      }
      onPointerDownCapture={data?.onSelectNodePointerDown}
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
        <span className="material-symbols-outlined">event_repeat</span>
        <strong>{data?.label || "Scheduled Run"}</strong>
        <span>{data?.definitionId || "workspace_scheduled_run"}</span>
        <button type="button" className="af-work-display-card__close nodrag" disabled={readOnly} onClick={() => deleteNode?.(id)} aria-label="删除节点">
          <span className="material-symbols-outlined">close</span>
        </button>
      </div>
      <div className="af-work-schedule-card__body nodrag">
        <label className="af-work-schedule-card__toggle">
          <input
            type="checkbox"
            checked={config.enabled}
            disabled={readOnly}
            onChange={(event) => updateConfig({ enabled: event.target.checked })}
          />
          <span>{config.enabled ? "定时开启" : "定时关闭"}</span>
        </label>
        <label className="af-work-schedule-card__field">
          <span>频率</span>
          <select
            value={config.scheduleType}
            disabled={readOnly}
            onChange={(event) => updateScheduleType(event.target.value)}
          >
            <option value="daily">每天</option>
            <option value="weekly">每周</option>
            <option value="monthly">每月</option>
            <option value="custom">高级 Cron</option>
          </select>
        </label>
        {config.scheduleType !== "custom" ? (
          <label className="af-work-schedule-card__field">
            <span>时间</span>
            <div className="af-work-schedule-time-selects">
              <select
                value={selectedHour}
                disabled={readOnly}
                aria-label="小时"
                onChange={(event) => updateScheduleHourMinute(event.target.value, selectedMinute)}
              >
                {Array.from({ length: 24 }, (_, hour) => padScheduleNumber(hour, 0, 0, 23)).map((hour) => (
                  <option key={hour} value={hour}>{hour} 时</option>
                ))}
              </select>
              <select
                value={selectedMinute}
                disabled={readOnly}
                aria-label="分钟"
                onChange={(event) => updateScheduleHourMinute(selectedHour, event.target.value)}
              >
                {Array.from({ length: 12 }, (_, index) => padScheduleNumber(index * 5, 0, 0, 59)).map((minute) => (
                  <option key={minute} value={minute}>{minute} 分</option>
                ))}
              </select>
            </div>
          </label>
        ) : null}
        {config.scheduleType === "weekly" ? (
          <label className="af-work-schedule-card__field">
            <span>星期</span>
            <select
              value={config.weekday}
              disabled={readOnly}
              onChange={(event) => updateWeekday(event.target.value)}
            >
              <option value={1}>周一</option>
              <option value={2}>周二</option>
              <option value={3}>周三</option>
              <option value={4}>周四</option>
              <option value={5}>周五</option>
              <option value={6}>周六</option>
              <option value={0}>周日</option>
            </select>
          </label>
        ) : null}
        {config.scheduleType === "monthly" ? (
          <label className="af-work-schedule-card__field">
            <span>日期</span>
            <select
              value={config.monthDay}
              disabled={readOnly}
              onChange={(event) => updateMonthDay(event.target.value)}
            >
              {Array.from({ length: 31 }, (_, index) => index + 1).map((day) => (
                <option key={day} value={day}>{day} 日</option>
              ))}
            </select>
          </label>
        ) : null}
        {config.scheduleType === "custom" ? (
          <label className="af-work-schedule-card__field">
            <span>Cron</span>
            <input
              type="text"
              value={cronDraft}
              disabled={readOnly}
              spellCheck={false}
              placeholder={DEFAULT_WORKSPACE_SCHEDULE_CRON}
              onChange={(event) => setCronDraft(event.target.value)}
              onBlur={commitCronDraft}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
            />
          </label>
        ) : null}
        <div className="af-work-schedule-card__meta">
          <span>{scheduleTypeLabel(config.scheduleType)} {config.scheduleType === "custom" ? "" : config.time}</span>
          <span>Next {formatScheduledRunTime(scheduleState.nextAt)}</span>
          <span>{running ? "running" : (scheduleState.lastStatus || "idle")}</span>
        </div>
        {scheduleState.lastError ? (
          <div className="af-work-schedule-card__error">{scheduleState.lastError}</div>
        ) : null}
        <div className="af-work-schedule-card__actions">
          <button
            type="button"
            className={"af-work-run-card__button af-work-schedule-card__run-now nodrag" + (running ? " af-work-run-card__button--stop" : "")}
            disabled={readOnly || optimizing}
            onClick={(event) => {
              event.stopPropagation();
              if (running) data?.onStopWorkspaceNode?.(id);
              else data?.onRunWorkspaceNode?.(id);
            }}
          >
            <span className="material-symbols-outlined">{running ? "stop_circle" : "play_arrow"}</span>
            <span>{running ? "停止" : "立即运行"}</span>
          </button>
          <button
            type="button"
            className={"af-work-run-card__button af-work-schedule-card__optimize nodrag" + (optimizing ? " af-work-schedule-card__optimize--running" : "")}
            disabled={readOnly || running || optimizing}
            title="为下游节点提前生成 implementation"
            onClick={(event) => {
              event.stopPropagation();
              data?.onOptimizeWorkspaceSchedule?.(id);
            }}
          >
            <span className="material-symbols-outlined">{optimizing ? "sync" : "auto_fix_high"}</span>
            <span>{optimizing ? "优化中" : "优化"}</span>
          </button>
          <button
            type="button"
            className="af-work-run-card__button af-work-schedule-card__logs nodrag"
            onClick={(event) => {
              event.stopPropagation();
              data?.onOpenWorkspaceRunLogs?.({
                nodeId: id,
                scheduleNodeId: id,
                runNodeId: scheduleState.targetRunNodeId || id,
                lastRunId: scheduleState.lastRunId || "",
                label: data?.label || "Scheduled Run",
              });
            }}
          >
            <span className="material-symbols-outlined">article</span>
            <span>日志</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function WorkspaceGroupNode({ id, data, selected, deleteNode }) {
  const { setNodes } = useReactFlow();
  const readOnly = Boolean(data?.readOnly);
  const size = normalizeWorkspaceGroupSize(data?.nodeSize) || {
    width: MIN_WORKSPACE_GROUP_WIDTH,
    height: MIN_WORKSPACE_GROUP_HEIGHT,
  };
  const onSelectGroupPointerDown = useCallback((event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    if (event.target?.closest?.(".af-work-group-node__resize, .af-work-group-node__delete")) return;
    setNodes((list) => selectSingleCanvasNodeUnlessDraggingSelection(list, id));
  }, [id, setNodes]);
  return (
    <div
      className={
        "af-work-group-node" +
        (selected ? " af-work-group-node--selected" : "") +
        (data?.displayPageMode ? " af-work-group-node--presentation" : "")
      }
      style={{ width: size.width, height: size.height }}
      onPointerDownCapture={onSelectGroupPointerDown}
    >
      {!readOnly ? (
        <NodeResizeControl
          className="af-work-group-node__resize nodrag"
          minWidth={MIN_WORKSPACE_GROUP_WIDTH}
          minHeight={MIN_WORKSPACE_GROUP_HEIGHT}
          position="bottom-right"
        >
          <span className="material-symbols-outlined">open_in_full</span>
        </NodeResizeControl>
      ) : null}
      <div className="af-work-group-node__title nodrag">
        <span>{data?.title || data?.label || "Group"}</span>
        {!readOnly ? (
          <button
            type="button"
            className="af-work-group-node__delete"
            onClick={(event) => {
              event.stopPropagation();
              deleteNode?.(id);
            }}
            aria-label="删除分组"
            title="删除分组"
          >
            <span className="material-symbols-outlined">close</span>
          </button>
        ) : null}
      </div>
    </div>
  );
}

function WorkspaceFlowNode(props) {
  const { setEdges, setNodes } = useReactFlow();
  const syncNodePropDraft = props.data?.onSyncNodePropDraft;
  const readOnly = Boolean(props.data?.readOnly);
  const [resizingFlowNode, setResizingFlowNode] = useState(false);
  const persistedNodeSize = props.data?.nodeSize && Number(props.data.nodeSize.width) > 0 && Number(props.data.nodeSize.height) > 0
    ? { width: Number(props.data.nodeSize.width), height: Number(props.data.nodeSize.height) }
    : null;
  const nodeSize = workspaceResizePresentationSize({
    resizing: resizingFlowNode,
    liveSize: normalizeWorkspaceNodeSize({ width: props.width, height: props.height }),
    persistedSize: persistedNodeSize,
  });
  const deleteNode = useCallback((nodeId) => {
    if (readOnly) return;
    props.data?.onCleanupWorkspaceNodeOutputs?.(nodeId, props.data);
    const linkedDisplayId = isOneClickTaskDefinitionId(props.data?.definitionId) ? contextRunLinkedDisplayNodeId(nodeId) : "";
    const deleteIds = new Set([nodeId, linkedDisplayId].filter(Boolean));
    setNodes((list) => list.filter((node) => !deleteIds.has(node.id)));
    setEdges((list) => list.filter((edge) => !deleteIds.has(edge.source) && !deleteIds.has(edge.target)));
  }, [props.data, readOnly, setEdges, setNodes]);
  const onSelectNodePointerDown = useCallback((event) => {
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey) return;
    if (event.target?.closest?.(".react-flow__handle, .af-work-display-resize")) return;
    setNodes((list) => {
      const next = selectSingleCanvasNodeUnlessDraggingSelection(list, props.id);
      if (next !== list) props.data?.onSuppressWorkspaceSelectionAutosave?.({ nodes: next });
      return next;
    });
    setEdges((list) => {
      const next = clearSelectedCanvasEdges(list);
      if (next !== list) props.data?.onSuppressWorkspaceSelectionAutosave?.({ edges: next });
      return next;
    });
  }, [props.data, props.id, setEdges, setNodes]);
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
  if (props.data?.isWorkspaceGroup) {
    return <WorkspaceGroupNode {...props} deleteNode={deleteNode} />;
  }
  if (displayKind(props.data?.definitionId)) {
    return <WorkspaceDisplayNode {...props} data={{ ...props.data, onSelectNodePointerDown }} deleteNode={deleteNode} />;
  }
  if (props.data?.definitionId === "workspace_run") {
    return <WorkspaceRunNode {...props} data={{ ...props.data, onSelectNodePointerDown }} deleteNode={deleteNode} />;
  }
  if (props.data?.definitionId === "workspace_scheduled_run") {
    return <WorkspaceScheduledRunNode {...props} data={{ ...props.data, onSelectNodePointerDown }} deleteNode={deleteNode} />;
  }
  if (isOneClickTaskDefinitionId(props.data?.definitionId)) {
    return (
      <WorkspaceContextRunNode
        {...props}
        data={{ ...props.data, onSelectNodePointerDown }}
        deleteNode={deleteNode}
        skills={props.data?.skills}
        skillCollections={props.data?.skillCollections}
        workspaces={props.data?.workspaceTargets}
      />
    );
  }
  if (props.data?.definitionId === "control_load_skills") {
    return (
      <WorkspaceLoadSkillsNode
        {...props}
        data={{ ...props.data, onSelectNodePointerDown }}
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
        data={{ ...props.data, onSelectNodePointerDown }}
        deleteNode={deleteNode}
        servers={props.data?.mcpServers}
        onChangeMcpNames={props.data?.onChangeLoadMcpNames}
      />
    );
  }
  if (props.data?.definitionId === "control_cd_workspace") {
    return (
      <WorkspaceLoadWorkspaceNode
        {...props}
        data={{ ...props.data, onSelectNodePointerDown }}
        deleteNode={deleteNode}
        workspaces={props.data?.workspaceTargets}
        onChangeWorkspace={props.data?.onChangeLoadWorkspace}
        onRefreshWorkspaces={props.data?.onRefreshWorkspaces}
      />
    );
  }
  return (
    <div
      className={
        "af-work-flow-node" +
        (props.selected ? " af-work-flow-node--selected" : "") +
        (resizingFlowNode ? " af-work-flow-node--resizing" : "") +
        (props.data?.isExecuting || props.data?.nodeStatus === "running" ? " af-work-flow-node--executing" : "") +
        (props.data?.nodeStatus === "success" ? " af-work-flow-node--done" : "") +
        (props.data?.nodeStatus === "failed" ? " af-work-flow-node--failed" : "") +
        (props.data?.nodeStatus === "stopped" ? " af-work-flow-node--stopped" : "")
      }
      style={nodeSize ? { width: nodeSize.width, height: nodeSize.height } : undefined}
      onPointerDownCapture={onSelectNodePointerDown}
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
        deferTextCommit
        modelLists={props.data?.modelLists}
        onModelChange={onModelChange}
        onProvideValueChange={onProvideValueChange}
        onNodeBodyChange={onNodeBodyChange}
        onNodeImagesChange={onNodeImagesChange}
      />
    </div>
  );
}

const nodeTypes = { [FLOW_NODE_TYPE]: memo(WorkspaceFlowNode) };

function flattenFiles(files, out = []) {
  for (const item of files || []) {
    if (item.type === "file") out.push(item);
    if (Array.isArray(item.children)) flattenFiles(item.children, out);
  }
  return out;
}

function findWorkspaceFileItem(files, itemPath) {
  const needle = String(itemPath || "");
  if (!needle) return null;
  for (const item of files || []) {
    if (item.path === needle) return item;
    const found = Array.isArray(item.children) ? findWorkspaceFileItem(item.children, needle) : null;
    if (found) return found;
  }
  return null;
}

function workspaceParentDir(relPath) {
  const normalized = String(relPath || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  if (!normalized || !normalized.includes("/")) return "";
  return normalized.split("/").slice(0, -1).join("/");
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

function selectSingleCanvasNode(nodes, nodeId) {
  const id = String(nodeId || "");
  let changed = false;
  const nextNodes = (nodes || []).map((node) => {
    const selected = node.id === id;
    if (node.selected === selected) return node;
    changed = true;
    return { ...node, selected };
  });
  return changed ? nextNodes : nodes;
}

function selectSingleCanvasNodeUnlessDraggingSelection(nodes, nodeId) {
  const id = String(nodeId || "");
  const clickedNode = (nodes || []).find((node) => node.id === id);
  const selectedCount = (nodes || []).reduce((count, node) => count + (node.selected ? 1 : 0), 0);
  if (clickedNode?.selected && selectedCount > 1) return nodes;
  return selectSingleCanvasNode(nodes, id);
}

function clearSelectedCanvasEdges(edges) {
  let changed = false;
  const nextEdges = (edges || []).map((edge) => {
    if (!edge.selected) return edge;
    changed = true;
    return { ...edge, selected: false };
  });
  return changed ? nextEdges : edges;
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

function formatWorkspaceFileSize(size) {
  const n = Number(size || 0);
  if (!Number.isFinite(n) || n <= 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 102.4) / 10} KB`;
  return `${Math.round(n / 1024 / 102.4) / 10} MB`;
}

function FileTree({ items, onOpen, selectedPath, collapsedDirs, onToggleDir, onSelect, onFileDragStart, onDelete, onDownload }) {
  return (
    <ul className="af-work-files">
      {(items || []).map((item) => {
        const isDir = item.type === "directory";
        const collapsed = isDir && collapsedDirs?.has(item.path);
        const selected = selectedPath === item.path;
        return (
          <li key={item.path}>
            <div className="af-work-file-row">
              <button
                type="button"
                className={"af-work-file af-work-file--" + item.type + (selected ? " af-work-file--selected" : "")}
                draggable={!isDir}
                onDragStart={(e) => {
                  if (!isDir) onFileDragStart?.(e, item);
                }}
                onClick={() => {
                  onSelect?.(item);
                  if (isDir) onToggleDir?.(item.path);
                }}
                onDoubleClick={() => {
                  if (!isDir) onOpen(item);
                }}
                title={item.path}
              >
                {isDir ? <span className="material-symbols-outlined af-work-file__chevron">{collapsed ? "chevron_right" : "expand_more"}</span> : null}
                <span className="material-symbols-outlined">{item.icon || iconForFile(item.name, isDir)}</span>
                <span>{item.name}</span>
              </button>
              {selected ? (
                <div className="af-work-file-actions">
                  {!isDir ? (
                    <button
                      type="button"
                      className="af-work-file-action"
                      onClick={(event) => {
                        event.stopPropagation();
                        onDownload?.(item);
                      }}
                      aria-label={`下载 ${item.name}`}
                      title={`下载 ${item.path}`}
                    >
                      <span className="material-symbols-outlined" aria-hidden>download</span>
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="af-work-file-action af-work-file-action--danger"
                    onClick={(event) => {
                      event.stopPropagation();
                      onDelete?.(item);
                    }}
                    aria-label={`删除 ${item.name}`}
                    title={`删除 ${item.path}`}
                  >
                    <span className="material-symbols-outlined" aria-hidden>delete</span>
                  </button>
                </div>
              ) : null}
            </div>
            {isDir && !collapsed && item.children?.length ? (
              <FileTree items={item.children} onOpen={onOpen} selectedPath={selectedPath} collapsedDirs={collapsedDirs} onToggleDir={onToggleDir} onSelect={onSelect} onFileDragStart={onFileDragStart} onDelete={onDelete} onDownload={onDownload} />
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function WorkspaceFilePickerModal({ files, query, onQueryChange, onSelect, onUpload, onClose }) {
  const flatFiles = useMemo(() => flattenFiles(files), [files]);
  const needle = String(query || "").trim().toLowerCase();
  const visibleFiles = flatFiles.filter((file) => {
    if (!needle) return true;
    return `${file.path} ${file.name}`.toLowerCase().includes(needle);
  });

  return (
    <div className="af-flow-snippet-modal-overlay" onMouseDown={onClose}>
      <div className="af-flow-snippet-modal af-work-file-picker-modal" role="dialog" aria-modal="true" aria-label="选择文件" onMouseDown={(event) => event.stopPropagation()}>
        <div className="af-flow-snippet-modal__head">
          <span className="af-flow-snippet-modal__title">
            <span className="material-symbols-outlined">folder_open</span>
            选择文件
          </span>
          <button type="button" className="af-flow-snippet-modal__close" onClick={onClose} aria-label="关闭">
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>
        <div className="af-flow-snippet-modal__body">
          <div className="af-work-file-picker-modal__tools">
            <input value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="搜索文件路径..." autoFocus />
            <button type="button" onClick={() => onUpload?.("")}>
              <span className="material-symbols-outlined">upload_file</span>
              上传
            </button>
          </div>
          <div className="af-work-file-picker-modal__list">
            {visibleFiles.map((file) => (
              <button key={file.path} type="button" className="af-work-file-picker-modal__item" onClick={() => onSelect(file)}>
                <span className="material-symbols-outlined">{file.icon || iconForFile(file.name)}</span>
                <span className="af-work-file-picker-modal__main">
                  <strong>{file.name}</strong>
                  <small>{file.path}</small>
                </span>
                {file.size ? <em>{formatWorkspaceFileSize(file.size)}</em> : null}
              </button>
            ))}
            {visibleFiles.length === 0 ? (
              <div className="af-work-file-picker-modal__empty">没有匹配文件，可先上传或调整搜索词。</div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function workspaceComposerActivityLabel(msg) {
  if (msg.kind === "run-summary") return "Steps";
  if (msg.kind === "run-log") return "Run";
  if (msg.kind === "activity") return "Activity";
  if (msg.kind === "prompt") return "Prompt";
  if (msg.kind === "raw") return "Raw Trace";
  if (msg.kind === "thinking") return "Thinking";
  return "Activity";
}

function WorkspaceComposerThread({ messages, running, showRunningIndicator = true, technical = false }) {
  if (technical) {
    return (
      <ComposerAssistantActivity
        items={messages.map((msg, index) => ({
          id: `${msg.kind || "activity"}-${index}-${String(msg.text || "").slice(0, 24)}`,
          kind: msg.kind || "activity",
          label: workspaceComposerActivityLabel(msg),
          text: msg.text,
        }))}
        running={running}
        label="执行过程"
        defaultOpen={running}
      />
    );
  }

  const hasBody = messages.length > 0;
  return (
    <div className="af-composer-ai-stack af-composer-ai-stack--in-panel af-composer-thread-stack af-composer-assistant-thread">
      {messages.map((msg, idx) => {
        return (
          <ComposerAssistantTurn
            key={`${idx}-${msg.role}-${String(msg.text || "").slice(0, 24)}`}
            role={msg.role === "user" ? "user" : "assistant"}
            content={msg.text}
            error={Boolean(msg.error)}
            copy={!msg.error}
          />
        );
      })}
      {showRunningIndicator && running && !hasBody ? (
        <ComposerAssistantTurn pending pendingLabel="正在理解 Workspace 并规划修改" />
      ) : null}
      {showRunningIndicator && running && hasBody ? (
        <ComposerAssistantTurn pending pendingLabel="仍在生成并同步 Workspace" copy={false} />
      ) : null}
    </div>
  );
}

function isWorkspaceComposerTechnicalMessage(msg) {
  const kind = String(msg?.kind || "");
  return ["run-log", "run-summary", "activity", "prompt", "raw", "thinking"].includes(kind);
}

function workspaceComposerConversationMessages(messages, running = false) {
  const list = Array.isArray(messages) ? messages : [];
  const conversational = list.filter((msg) => !isWorkspaceComposerTechnicalMessage(msg));
  if (conversational.length > 0) return conversational;
  const fallback = [...list].reverse().find((msg) => msg?.kind === "result" || msg?.kind === "assistant" || msg?.error);
  if (fallback) return [fallback];
  if (list.length > 0 || running) {
    if (running) return [];
    return [{
      role: "assistant",
      kind: "assistant",
      text: "运行已完成。可以在下方继续追问、要求总结或调整结果。",
      at: 0,
    }];
  }
  return [];
}

function workspaceComposerTechnicalMessages(messages) {
  return (Array.isArray(messages) ? messages : []).filter(isWorkspaceComposerTechnicalMessage);
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

function selectedSkillKeysFromConfigSlots(data) {
  const slots = [...(Array.isArray(data?.inputs) ? data.inputs : []), ...(Array.isArray(data?.outputs) ? data.outputs : [])];
  const slot = slots.find((item) => item?.name === "skillKeys" || item?.name === "skillsContext");
  return selectedSkillKeysFromValue(slot?.default || slot?.value || "");
}

function compactSelectionParts(items, emptyLabel, maxVisible = 1) {
  const names = (Array.isArray(items) ? items : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  if (!names.length) return { head: emptyLabel, extra: "", title: "" };
  const head = names.slice(0, maxVisible).join("、");
  return {
    head,
    extra: names.length > maxVisible ? `等 ${names.length} 个` : "",
    title: names.join(", "),
  };
}

function serializeSkillKeys(keys) {
  return JSON.stringify(Array.from(new Set((keys || []).map(String).filter(Boolean))));
}

function workspaceSlotConfigValue(slots, name, fallback = "") {
  const slot = (Array.isArray(slots) ? slots : []).find((item) => item?.name === name);
  const value = String(slot?.value ?? slot?.default ?? "").trim();
  return value || fallback;
}

function workspaceSlotConfigJsonValue(slots, name) {
  const raw = workspaceSlotConfigValue(slots, name, "");
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeContextRunDisplayType(value) {
  const text = String(value || "").trim().toLowerCase();
  return ["markdown", "html", "react", "table", "chart", "ascii", "mermaid"].includes(text) ? text : "markdown";
}

function workspaceModelEntryId(entry) {
  const text = String(entry || "");
  const idx = text.indexOf(" - ");
  return idx >= 0 ? text.slice(0, idx).trim() : text.trim();
}

function contextRunDisplayDefinitionId(displayType) {
  const kind = normalizeContextRunDisplayType(displayType);
  if (kind === "html") return "display_html";
  if (kind === "react") return "display_react_app";
  if (kind === "table") return "display_table";
  if (kind === "chart") return "display_chart";
  if (kind === "ascii") return "display_ascii";
  if (kind === "mermaid") return "display_mermaid";
  return "display_markdown";
}

function contextRunLinkedDisplayNodeId(nodeId) {
  return `${String(nodeId || "context_run").trim() || "context_run"}__display`;
}

function contextRunDisplayPrimarySlotName(displayDefinitionId) {
  return displayDefinitionId === "display_image" ? "src" : "content";
}

function contextRunDisplaySlots(definitionSlots, displayDefinitionId, content) {
  const primaryName = contextRunDisplayPrimarySlotName(displayDefinitionId);
  const list = cloneSlots(definitionSlots);
  let hasPrimary = false;
  const next = list.map((slot) => {
    if (slot?.name === primaryName) {
      hasPrimary = true;
      return { ...slot, default: content, value: content, showOnNode: slot.showOnNode !== false };
    }
    if (slot?.name === "filePath") return { ...slot, default: "", value: "" };
    return slot;
  });
  if (!hasPrimary) next.push({ type: "text", name: primaryName, default: content, value: content, required: true, showOnNode: true });
  return next;
}

function contextRunSlotHandleId(slots, prefix, preferredNames = [], preferredTypes = []) {
  const list = Array.isArray(slots) ? slots : [];
  const names = new Set((Array.isArray(preferredNames) ? preferredNames : []).map((name) => String(name || "").trim()).filter(Boolean));
  const types = new Set((Array.isArray(preferredTypes) ? preferredTypes : []).map((type) => String(type || "").trim()).filter(Boolean));
  const visible = (slot) => slot?.showOnNode !== false;
  let index = list.findIndex((slot) => visible(slot) && names.has(String(slot?.name || "").trim()));
  if (index < 0) index = list.findIndex((slot) => names.has(String(slot?.name || "").trim()));
  if (index < 0) index = list.findIndex((slot) => visible(slot) && types.has(String(slot?.type || "").trim()));
  if (index < 0) index = list.findIndex((slot) => visible(slot));
  if (index < 0) index = 0;
  return `${prefix}-${index}`;
}

function clearContextRunOutputSlots(slots) {
  return (Array.isArray(slots) ? slots : []).map((slot) => {
    if (slot?.type === "node" || slot?.name === "next") return slot;
    return { ...slot, default: "", value: "" };
  });
}

function contextRunResultContentFromData(data) {
  const outputs = Array.isArray(data?.outputs)
    ? data.outputs
    : Array.isArray(data?.output)
      ? data.output
      : [];
  const slotValue = (slot) => String(slot?.value ?? slot?.default ?? "").trim();
  const primary =
    outputs.find((slot) => (slot?.name === "content" || slot?.name === "result") && slotValue(slot)) ||
    outputs.find((slot) => slot?.name === "resultFile" && slotValue(slot)) ||
    outputs.find((slot) => slot?.type !== "node" && slot?.name !== "next" && slot?.name !== "displayType" && slotValue(slot));
  return primary ? slotValue(primary) : "";
}

function contextRunConfigFromData(data) {
  const inputs = Array.isArray(data?.inputs) ? data.inputs : [];
  const includeRaw = workspaceSlotConfigValue(inputs, "includeWorkspaceContext", "true").toLowerCase();
  const knowledgeContext = workspaceSlotConfigJsonValue(inputs, "knowledgeContext");
  const legacyWorkspaceContext = workspaceSlotConfigJsonValue(inputs, "workspaceContext");
  return {
    task: String(data?.body || ""),
    skillKeys: selectedSkillKeysFromConfigSlots(data),
    includeWorkspaceContext: includeRaw !== "false" && includeRaw !== "0" && includeRaw !== "off",
    knowledgeContext: knowledgeContext || (legacyWorkspaceContext ? knowledgeContextFromWorkspaces([legacyWorkspaceContext]) : null),
    workspaceContext: legacyWorkspaceContext,
    displayType: normalizeContextRunDisplayType(workspaceSlotConfigValue(inputs, "displayType", "markdown")),
    model: String(data?.model || "").trim(),
  };
}

function isOneClickTaskDefinitionId(definitionId) {
  const id = String(definitionId || "");
  return id === "workspace_one_click_task" || id === "workspace_context_run";
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

function knowledgeSourceFromWorkspace(workspace = {}, role = "context") {
  const cwd = String(workspace?.cwd || workspace?.workspaceRoot || workspace?.path || "").trim();
  const id = String(workspace?.id || "").trim();
  const rawLabel = String(workspace?.label || workspace?.name || "").trim();
  if (!cwd && !id && !rawLabel) return null;
  const label = String(rawLabel || id || "知识库").trim();
  return {
    id,
    label,
    kind: workspace?.kind === "git" ? "git" : "local",
    type: String(workspace?.type || ""),
    repoPath: cwd,
    path: cwd,
    mountPath: String(workspace?.mountPath || id || label).trim(),
    repoUrl: String(workspace?.repoUrl || "").trim(),
    branch: String(workspace?.branch || "").trim(),
    readonly: true,
    role,
  };
}

function knowledgeContextFromWorkspaces(workspaces = []) {
  const sources = (Array.isArray(workspaces) ? workspaces : [workspaces])
    .map((workspace, index) => knowledgeSourceFromWorkspace(workspace, index === 0 ? "primary" : "context"))
    .filter(Boolean);
  return sources.length ? { version: 1, sources } : null;
}

function knowledgeSourcesFromContext(value) {
  const sources = value && typeof value === "object" && Array.isArray(value.sources) ? value.sources : [];
  return sources.map((source) => knowledgeSourceFromWorkspace(source, source?.role || "context")).filter(Boolean);
}

function workspaceSelectionFromNodeData(data) {
  const inputs = Array.isArray(data?.inputs) ? data.inputs : [];
  const knowledge = workspaceSlotConfigJsonValue(inputs, "knowledgeContext");
  const legacyWorkspace = workspaceSlotConfigJsonValue(inputs, "workspaceContext");
  const sources = knowledgeSourcesFromContext(knowledge || (legacyWorkspace ? knowledgeContextFromWorkspaces([legacyWorkspace]) : null));
  return {
    sources,
    path: workspaceSlotConfigValue(inputs, "path", ""),
    label: workspaceSlotConfigValue(inputs, "label", ""),
  };
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
    scriptRef: String(node.data?.scriptRef ?? ""),
    implementationRef: String(node.data?.implementationRef ?? ""),
    implementationMode: String(node.data?.implementationMode ?? ""),
    inputs,
    outputs,
  };
}

function workspaceRunNodeModel(nodes, instances, runNodeId, fallback = "") {
  const id = String(runNodeId || "").trim();
  const node = (Array.isArray(nodes) ? nodes : []).find((item) => String(item?.id || "") === id);
  const nodeModel = String(node?.data?.model || "").trim();
  if (nodeModel && nodeModel !== "default") return nodeModel;
  const instanceModel = String(instances?.[id]?.model || "").trim();
  if (instanceModel && instanceModel !== "default") return instanceModel;
  return String(fallback || "").trim();
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
  for (const key of ["scriptRef", "implementationRef", "implementationMode"]) {
    const value = String(draft?.[key] ?? "").trim();
    if (value) nextData[key] = value;
    else delete nextData[key];
  }
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
    (prevData.scriptRef ?? undefined) !== (nextData.scriptRef ?? undefined) ||
    (prevData.implementationRef ?? undefined) !== (nextData.implementationRef ?? undefined) ||
    (prevData.implementationMode ?? undefined) !== (nextData.implementationMode ?? undefined) ||
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
  for (const key of ["newId", "label", "role", "model", "body", "images", "script", "scriptRef", "implementationRef", "implementationMode", "inputs", "outputs"]) {
    if (draftValueEquals(current[key], previousNodeDraft[key])) {
      next[key] = nextNodeDraft[key];
    }
  }
  return next;
}

function useWorkspaceMenuScrollbar(open, refreshDeps = []) {
  const menuRef = useRef(null);
  const scrollbarTrackRef = useRef(null);
  const [scrollbar, setScrollbar] = useState({ visible: false, top: 0, height: 100 });
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
    if (!open) return undefined;
    const frame = requestAnimationFrame(updateMenuScrollbar);
    return () => cancelAnimationFrame(frame);
  }, [open, updateMenuScrollbar, ...refreshDeps]);

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

  return { menuRef, scrollbarTrackRef, scrollbar, updateMenuScrollbar, handleScrollbarPointerDown };
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
  const selectedSkillNames = useMemo(() => Array.from(keys).map((key) => byKey.get(key)?.name || key), [byKey, keys]);
  const selectedSkillSummary = useMemo(() => compactSelectionParts(selectedSkillNames, "选择 Skills"), [selectedSkillNames]);
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
    <div
      className={
        "af-work-load-skills-card" +
        (selected ? " af-work-load-skills-card--selected" : "") +
        (open ? " af-work-load-skills-card--menu-open" : "")
      }
      onPointerDownCapture={data?.onSelectNodePointerDown}
    >
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
          <span className="af-work-load-skills-card__summary" title={selectedSkillSummary.title}>
            <span className="af-work-load-skills-card__summary-main">{selectedSkillSummary.head}</span>
            {selectedSkillSummary.extra ? <span className="af-work-load-skills-card__summary-extra">{selectedSkillSummary.extra}</span> : null}
          </span>
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
    <div
      className={
        "af-work-load-skills-card" +
        (selected ? " af-work-load-skills-card--selected" : "") +
        (open ? " af-work-load-skills-card--menu-open" : "")
      }
      onPointerDownCapture={data?.onSelectNodePointerDown}
    >
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

function WorkspaceLoadWorkspaceNode({ id, data, selected, deleteNode, workspaces = [], onChangeWorkspace, onRefreshWorkspaces }) {
  const inputs = Array.isArray(data?.inputs) ? data.inputs : [];
  const outputs = Array.isArray(data?.outputs) ? data.outputs : [];
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const selectedKnowledge = workspaceSelectionFromNodeData(data);
  const workspaceList = useMemo(() => (Array.isArray(workspaces) ? workspaces : [])
    .map((item) => ({
      id: String(item?.id || ""),
      label: String(item?.label || item?.name || "知识库"),
      kind: item?.kind === "git" ? "git" : "local",
      path: String(item?.path || ""),
      repoUrl: String(item?.repoUrl || ""),
      branch: String(item?.branch || ""),
      mountPath: String(item?.mountPath || ""),
      builtin: item?.builtin === true,
      exists: item?.exists !== false,
    }))
    .filter((item) => item.path), [workspaces]);
  const filteredWorkspaces = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return workspaceList;
    return workspaceList.filter((item) => [item.id, item.label, item.path, item.repoUrl, item.branch, item.mountPath].join(" ").toLowerCase().includes(q));
  }, [search, workspaceList]);
  const selectedKeys = useMemo(() => new Set((selectedKnowledge.sources || []).map((item) => item.id || item.path || item.repoPath).filter(Boolean)), [selectedKnowledge.sources]);
  const selectedWorkspaceNames = useMemo(() => (selectedKnowledge.sources || []).map((item) => item.label || item.id || item.mountPath || item.path), [selectedKnowledge.sources]);
  const title = useMemo(() => compactSelectionParts(selectedWorkspaceNames, "选择知识库"), [selectedWorkspaceNames]);
  const workspaceMenuScrollbar = useWorkspaceMenuScrollbar(open, [
    filteredWorkspaces.length,
    selectedWorkspaceNames.length,
    search,
  ]);
  const toggleWorkspace = (workspace, checked) => {
    const key = workspace?.id || workspace?.path || "";
    const selectedItems = workspaceList.filter((item) => {
      const itemKey = item.id || item.path || "";
      if (itemKey === key) return checked;
      return selectedKeys.has(itemKey);
    });
    onChangeWorkspace?.(id, selectedItems);
  };
  return (
    <div
      className={
        "af-work-load-skills-card af-work-load-workspace-card" +
        (selected ? " af-work-load-skills-card--selected" : "") +
        (open ? " af-work-load-skills-card--menu-open" : "")
      }
      onPointerDownCapture={data?.onSelectNodePointerDown}
    >
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
        <span className="material-symbols-outlined">folder_managed</span>
        <strong>{data?.label || "加载知识库"}</strong>
        <span>{data?.definitionId || "control_cd_workspace"}</span>
        <button type="button" className="af-work-display-card__close nodrag" onClick={() => deleteNode?.(id)} aria-label="删除节点">
          <span className="material-symbols-outlined">close</span>
        </button>
      </div>
      <div className="af-work-load-skills-card__body nodrag">
        <button type="button" className="af-work-load-skills-card__select" onClick={(event) => {
          event.stopPropagation();
          if (!open) onRefreshWorkspaces?.();
          setOpen((v) => !v);
        }}>
          <span className="af-work-load-skills-card__summary" title={title.title}>
            <span className="af-work-load-skills-card__summary-main">{title.head}</span>
            {title.extra ? <span className="af-work-load-skills-card__summary-extra">{title.extra}</span> : null}
          </span>
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
                placeholder="搜索知识库..."
                spellCheck={false}
                autoComplete="off"
                aria-label="搜索知识库"
              />
              {search ? (
                <button type="button" onClick={() => setSearch("")} aria-label="清空搜索">
                  <span className="material-symbols-outlined" aria-hidden>close</span>
                </button>
              ) : null}
            </div>
            <div
              ref={workspaceMenuScrollbar.menuRef}
              className="af-work-load-skills-menu"
              onScroll={workspaceMenuScrollbar.updateMenuScrollbar}
            >
              <section className="af-work-load-skills-menu__group">
                <div className="af-work-load-skills-menu__group-head af-work-load-skills-menu__group-head--plain">
                  <span>知识库</span>
                  <small>{filteredWorkspaces.length}</small>
                </div>
                <div className="af-work-load-skills-menu__options">
                  {filteredWorkspaces.map((item) => (
                    <label key={`${item.id}:${item.path}`} className="af-work-load-skills-menu__option">
                      <input
                        type="checkbox"
                        checked={selectedKeys.has(item.id || item.path)}
                        onChange={(event) => toggleWorkspace(item, event.target.checked)}
                      />
                      <span className="af-work-load-skills-menu__option-main">
                        <span className="af-work-load-skills-menu__option-title">{item.label}</span>
                        <span className="af-work-load-skills-menu__option-desc">
                          {item.kind === "git" && item.repoUrl ? `${item.repoUrl}${item.branch ? ` · ${item.branch}` : ""}${item.mountPath ? ` · ${item.mountPath}` : ""}` : item.path}
                          {item.exists ? "" : " · 路径未就绪"}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              </section>
              {filteredWorkspaces.length === 0 ? (
                <div className="af-work-load-skills-menu__empty">没有匹配的知识库</div>
              ) : null}
              <button type="button" className="af-work-load-skills-menu__clear" onClick={() => onChangeWorkspace?.(id, [])}>清空知识库</button>
            </div>
            <div
              ref={workspaceMenuScrollbar.scrollbarTrackRef}
              className={"af-work-load-skills-scrollbar" + (workspaceMenuScrollbar.scrollbar.visible ? " af-work-load-skills-scrollbar--visible" : "")}
              onPointerDown={workspaceMenuScrollbar.handleScrollbarPointerDown}
              aria-hidden="true"
            >
              <span style={{ height: `${workspaceMenuScrollbar.scrollbar.height}%`, top: `${workspaceMenuScrollbar.scrollbar.top}%` }} />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PrdWorkflowPanel({
  tapdId,
  setTapdId,
  snapshot,
  loading,
  error,
  actionRunning,
  actionOutput,
  pendingConfirm,
  conflict,
  reviewPublishing,
  onRefresh,
  onRunDryRun,
  onConfirmAction,
  onRetryConflict,
  onPublishReview,
}) {
  const [auditFilter, setAuditFilter] = useState("all");
  const phase = String(snapshot?.phase || (tapdId ? "unavailable" : "unselected"));
  const milestones = Array.isArray(snapshot?.milestones) ? snapshot.milestones : [];
  const issues = Array.isArray(snapshot?.issues) ? snapshot.issues : [];
  const artifacts = Array.isArray(snapshot?.artifacts) ? snapshot.artifacts : [];
  const gaps = Array.isArray(snapshot?.optionalGaps) ? snapshot.optionalGaps : [];
  const nextAction = snapshot?.nextAction && typeof snapshot.nextAction === "object" ? snapshot.nextAction : null;
  const actionLabel = prdWorkflowActionLabel(nextAction);
  const canDryRun = Boolean(nextAction?.dryRunSupported || nextAction?.dry_run_supported);
  const rawOutput = String(snapshot?.rawOutput || "");
  return (
    <main className="af-prd-workflow" aria-label="PRD Workflow">
      <section className="af-prd-workflow__hero">
        <div>
          <span className="af-prd-workflow__eyebrow">PRD Workflow</span>
          <h1>需求流程状态机</h1>
          <p>从 TAPD、ai-doc、GitLab 和本地草稿推导状态；Workflow 只保存协作运行态。</p>
        </div>
        <form className="af-prd-workflow__lookup" onSubmit={(event) => {
          event.preventDefault();
          onRefresh?.();
        }}>
          <label>
            <span>TAPD ID</span>
            <input
              value={tapdId}
              onChange={(event) => setTapdId(event.target.value)}
              placeholder="输入需求 ID"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <button type="submit" disabled={loading}>
            <span className="material-symbols-outlined" aria-hidden>{loading ? "hourglass_empty" : "sync"}</span>
            {loading ? "读取中" : "刷新"}
          </button>
        </form>
      </section>

      <section className="af-prd-workflow__grid">
        <article className="af-prd-workflow-card af-prd-workflow-card--status">
          <div className="af-prd-workflow-card__head">
            <span className={`af-prd-workflow-phase af-prd-workflow-phase--${phase.toLowerCase().replace(/[^a-z0-9_-]+/gi, "_")}`}>
              {prdWorkflowPhaseLabel(phase)}
            </span>
            {snapshot?.revision ? <code>{snapshot.revision}</code> : null}
          </div>
          <h2>{snapshot?.pointer || (tapdId ? "等待 prd-flow 返回状态" : "输入 TAPD ID 开始")}</h2>
          {error ? <p className="af-prd-workflow-error">{error}</p> : null}
          {nextAction ? (
            <div className="af-prd-workflow-next">
              <span>下一步</span>
              <strong>{actionLabel || nextAction.id}</strong>
              {nextAction.issueKey || nextAction.issue_key ? <small>{nextAction.issueKey || nextAction.issue_key}</small> : null}
              {nextAction.command ? <code>{nextAction.command}</code> : null}
            </div>
          ) : (
            <p className="af-prd-workflow-muted">暂无可执行动作。</p>
          )}
        </article>

        <article className="af-prd-workflow-card">
          <div className="af-prd-workflow-card__head">
            <h2>状态线</h2>
            <span>{milestones.length}</span>
          </div>
          <div className="af-prd-workflow-timeline">
            {milestones.length ? milestones.map((item, index) => {
              const st = prdWorkflowMilestoneStatus(item.status);
              return (
                <div key={item.id || `${item.label}-${index}`} className={`af-prd-workflow-step af-prd-workflow-step--${st}`}>
                  <span className="af-prd-workflow-step__dot" />
                  <div>
                    <strong>{item.label || item.id || `Step ${index + 1}`}</strong>
                    {item.detail || item.description ? <small>{item.detail || item.description}</small> : null}
                  </div>
                </div>
              );
            }) : (
              <p className="af-prd-workflow-muted">状态线会在 `prd-flow current --json` 可用后展示。</p>
            )}
          </div>
        </article>

        <article className="af-prd-workflow-card">
          <div className="af-prd-workflow-card__head">
            <h2>Artifacts</h2>
            <span>{artifacts.length}</span>
          </div>
          <div className="af-prd-workflow-list">
            {artifacts.length ? artifacts.map((item, index) => {
              const href = prdWorkflowArtifactHref(item);
              const label = String(item.label || item.title || item.kind || href || `Artifact ${index + 1}`);
              return href ? (
                <a key={`${href}-${index}`} href={href} target="_blank" rel="noreferrer">
                  <span>{label}</span>
                  <small>{item.kind || href}</small>
                </a>
              ) : (
                <div key={`${label}-${index}`}>
                  <span>{label}</span>
                  <small>{item.kind || ""}</small>
                </div>
              );
            }) : (
              <p className="af-prd-workflow-muted">暂无归档链接。</p>
            )}
          </div>
        </article>

        <article className="af-prd-workflow-card">
          <div className="af-prd-workflow-card__head">
            <h2>Issues</h2>
            <span>{issues.length}</span>
          </div>
          <div className="af-prd-workflow-issues">
            {issues.length ? issues.map((item, index) => (
              <div key={item.key || `${item.title}-${index}`} className="af-prd-workflow-issue">
                <strong>{item.title || item.key || `Issue ${index + 1}`}</strong>
                <small>{[item.key, item.platform, item.status].filter(Boolean).join(" · ")}</small>
              </div>
            )) : (
              <p className="af-prd-workflow-muted">暂无 Issue 信息。</p>
            )}
          </div>
        </article>
      </section>

      {(gaps.length || rawOutput || actionOutput) ? (
        <section className="af-prd-workflow__details">
          {gaps.length ? (
            <article className="af-prd-workflow-card">
              <div className="af-prd-workflow-card__head">
                <h2>Optional</h2>
                <span>{gaps.length}</span>
              </div>
              <div className="af-prd-workflow-gap-list">
                {gaps.map((gap, index) => (
                  <p key={`${gap.text || gap}-${index}`}>{typeof gap === "string" ? gap : gap.text || JSON.stringify(gap)}</p>
                ))}
              </div>
            </article>
          ) : null}
          {rawOutput || actionOutput ? (
            <article className="af-prd-workflow-card af-prd-workflow-card--raw">
              <div className="af-prd-workflow-card__head">
                <h2>Raw</h2>
                <button type="button" disabled={reviewPublishing || !(rawOutput || actionOutput)} onClick={() => onPublishReview?.()}>
                  <span className="material-symbols-outlined" aria-hidden>{reviewPublishing ? "hourglass_empty" : "ios_share"}</span>
                  {reviewPublishing ? "生成中" : "生成 Review 链接"}
                </button>
              </div>
              <pre>{actionOutput || rawOutput}</pre>
            </article>
          ) : null}
        </section>
      ) : null}
    </main>
  );
}

function PrdWorkflowIssueCard({ row, index = 0, child = false }) {
  const issue = row?.issue || {};
  const logicalParent = workflowIssueIsLogicalParent(issue);
  const allLinks = sortWorkflowIssueLinks(prdWorkflowIssueLinks(issue));
  const visibleLinks = logicalParent
    ? allLinks.filter((link) => !["issue", "mr"].includes(workflowIssueLinkKind(link)))
    : allLinks;
  const mrStatus = workflowIssueMrStatus(issue, allLinks);
  const issueKey = prdWorkflowIssueKey(issue, index);
  const platform = logicalParent ? "" : prdWorkflowPlatformLabel(issue.platform);
  const childCount = Array.isArray(row?.children) ? row.children.length : 0;
  const meta = [
    issueKey,
    logicalParent && childCount ? `${childCount} 个端侧 Issue` : platform,
    issue.status,
  ].filter(Boolean);

  return (
    <div className={`af-prd-workflow-issue${child ? " af-prd-workflow-issue--child" : ""}${logicalParent ? " af-prd-workflow-issue--aggregate" : ""}`}>
      <strong>{prdWorkflowIssueTitle(issue, index)}</strong>
      <small>{meta.join(" · ")}</small>
      <div className="af-prd-workflow-issue__state-row">
        <span className={`af-prd-workflow-issue__state af-prd-workflow-issue__state--${mrStatus.kind}`}>
          {mrStatus.label}
        </span>
        {mrStatus.detail ? <small>{mrStatus.detail}</small> : null}
      </div>
      {visibleLinks.length ? (
        <div className="af-prd-workflow-issue__links">
          {visibleLinks.map((link) => (
            <a key={`${link.label}-${link.href}`} href={link.href} target="_blank" rel="noreferrer">{link.label}</a>
          ))}
        </div>
      ) : null}
      {childCount ? (
        <div className="af-prd-workflow-issue__children">
          {row.children.map((childRow, childIndex) => (
            <PrdWorkflowIssueCard
              key={prdWorkflowIssueKey(childRow?.issue || {}, childIndex)}
              row={childRow}
              index={childIndex}
              child
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function prdWorkflowOverallDisplayValue(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (typeof value !== "object" || Array.isArray(value)) return "";
  return String(value.label || value.name || value.value || value.key || value.code || value.username || value.userId || "").trim();
}

function prdWorkflowOverallDisplayList(value) {
  const list = Array.isArray(value) ? value : value == null || value === "" ? [] : [value];
  return list.map((item) => prdWorkflowOverallDisplayValue(item)).filter(Boolean);
}

function prdWorkflowOverallExperimentLabel(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return prdWorkflowOverallDisplayValue(value);
  const name = prdWorkflowOverallDisplayValue(value);
  const groups = prdWorkflowOverallDisplayList(value.groups || value.variants || value.buckets);
  return [name, groups.length ? groups.join(" / ") : ""].filter(Boolean).join(" · ");
}

function prdWorkflowOverallSettingLabel(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return prdWorkflowOverallDisplayValue(value);
  const name = prdWorkflowOverallDisplayValue(value);
  const defaultValue = value.defaultValue ?? value.default_value ?? value.default;
  return [name, defaultValue != null && defaultValue !== "" ? `默认 ${String(defaultValue)}` : ""].filter(Boolean).join(" · ");
}

function PrdWorkflowOverallPlatform({ platform, value }) {
  const owner = prdWorkflowOverallDisplayValue(value?.owner);
  const tags = prdWorkflowOverallDisplayList(value?.tags);
  const experiments = (Array.isArray(value?.experiments) ? value.experiments : []).map(prdWorkflowOverallExperimentLabel).filter(Boolean);
  const settings = (Array.isArray(value?.settings) ? value.settings : []).map(prdWorkflowOverallSettingLabel).filter(Boolean);
  const countries = prdWorkflowOverallDisplayList(value?.filters?.countries);
  const users = prdWorkflowOverallDisplayList(value?.filters?.users);
  const versions = prdWorkflowOverallDisplayList(value?.filters?.versions);
  const rules = prdWorkflowOverallDisplayList(value?.rules);
  const rows = [
    ["Tag", tags],
    ["AB 实验", experiments],
    ["Settings", settings],
    ["国家过滤", countries],
    ["用户过滤", users],
    ["版本过滤", versions],
  ].filter(([, values]) => values.length);
  if (!owner && !rows.length && !rules.length) return null;
  return (
    <section className="af-prd-overall-platform">
      <div className="af-prd-overall-platform__head">
        <strong>{prdWorkflowPlatformLabel(platform) || platform}</strong>
        {owner ? <span><span className="material-symbols-outlined" aria-hidden>person</span>{owner}</span> : null}
      </div>
      {rows.map(([label, values]) => (
        <div className="af-prd-overall-platform__row" key={label}>
          <small>{label}</small>
          <div>{values.map((item) => <span key={`${label}-${item}`}>{item}</span>)}</div>
        </div>
      ))}
      {rules.length ? (
        <div className="af-prd-overall-platform__rules">
          <small>实现规则</small>
          <ul>{rules.map((rule) => <li key={rule}>{rule}</li>)}</ul>
        </div>
      ) : null}
    </section>
  );
}

function PrdWorkflowOverallCard({ overall, tapdId }) {
  const requirement = overall?.requirement && typeof overall.requirement === "object" ? overall.requirement : {};
  const platforms = overall?.platforms && typeof overall.platforms === "object" ? overall.platforms : {};
  const title = String(requirement.title || requirement.name || "").trim();
  const tapdUrl = String(requirement.tapdUrl || requirement.tapd_url || requirement.url || "").trim();
  const status = prdWorkflowOverallDisplayValue(requirement.status || requirement.tapdStatus || requirement.tapd_status);
  const requirementTapdId = String(requirement.tapdId || requirement.tapd_id || tapdId || "").trim();
  const platformEntries = Object.entries(platforms).filter(([platform, value]) => (
    platform && value && typeof value === "object" && !Array.isArray(value)
  ));
  const hasReportedContent = Boolean(title || tapdUrl || status || platformEntries.length);
  if (!requirementTapdId && !hasReportedContent) return null;
  return (
    <article className="af-prd-workflow-card af-prd-overall">
      <div className="af-prd-workflow-card__head">
        <h2>需求概览</h2>
        {status ? <span className="af-prd-overall__status">{status}</span> : null}
      </div>
      {(title || tapdUrl || requirementTapdId) ? (
        <div className="af-prd-overall__requirement">
          {tapdUrl ? (
            <a href={tapdUrl} target="_blank" rel="noreferrer">
              <strong>{title || `TAPD ${requirementTapdId}`}</strong>
              <span className="material-symbols-outlined" aria-hidden>open_in_new</span>
            </a>
          ) : <strong>{title || `TAPD ${requirementTapdId}`}</strong>}
        </div>
      ) : null}
      {hasReportedContent ? (
        <div className="af-prd-overall__platforms">
          {platformEntries.map(([platform, value]) => (
            <PrdWorkflowOverallPlatform key={platform} platform={platform} value={value} />
          ))}
        </div>
      ) : (
        <p className="af-prd-workflow-muted">
          暂无阶段级 Overall 信息。技术方案、端侧方案或实现 MR 上报后会逐步补充，也可让本地 Agent 执行 Overall 整理更新。
        </p>
      )}
    </article>
  );
}

function WorkflowGlobalStateField({ fieldKey, field }) {
  if (!field || typeof field !== "object" || Array.isArray(field)) return null;
  const label = String(field.label || fieldKey || "").trim();
  const requestedType = String(field.type || "text").trim().toLowerCase();
  const type = ["text", "user", "chips", "list", "link"].includes(requestedType) ? requestedType : "text";
  const values = prdWorkflowOverallDisplayList(field.value);
  if (!values.length) return null;
  if (type === "list") {
    return (
      <div className="af-prd-overall-platform__rules">
        <small>{label}</small>
        <ul>{values.map((value, index) => <li key={`${fieldKey}-${index}-${value}`}>{value}</li>)}</ul>
      </div>
    );
  }
  if (type === "link") {
    const rawValue = field.value && typeof field.value === "object" && !Array.isArray(field.value) ? field.value : {};
    const href = prdWorkflowNormalizeHref(field.href || field.url || rawValue.href || rawValue.url || "");
    return (
      <div className="af-prd-overall-platform__row af-prd-overall-platform__row--link">
        <small>{label}</small>
        {href ? (
          <a href={href} target="_blank" rel="noreferrer">
            <span>{values[0]}</span>
            <span className="material-symbols-outlined" aria-hidden>open_in_new</span>
          </a>
        ) : <strong>{values[0]}</strong>}
      </div>
    );
  }
  return (
    <div className={`af-prd-overall-platform__row af-prd-overall-platform__row--${type}`}>
      <small>{label}</small>
      <div>{values.map((value, index) => <span key={`${fieldKey}-${index}-${value}`}>{value}</span>)}</div>
    </div>
  );
}

function WorkflowGlobalStateSection({ sectionKey, section }) {
  if (!section || typeof section !== "object" || Array.isArray(section)) return null;
  const fields = section.fields && typeof section.fields === "object" && !Array.isArray(section.fields)
    ? Object.entries(section.fields)
    : [];
  const visibleFields = fields.filter(([, field]) => (
    field && typeof field === "object" && prdWorkflowOverallDisplayList(field.value).length
  ));
  if (!visibleFields.length) return null;
  const compact = sectionKey === "progress";
  return (
    <section className={`af-prd-overall-platform${compact ? " af-prd-overall-platform--compact" : ""}`}>
      <div className="af-prd-overall-platform__head">
        <strong>{String(section.title || sectionKey || "").trim()}</strong>
      </div>
      <div className="af-prd-overall-platform__fields">
        {visibleFields.map(([fieldKey, field]) => (
          <WorkflowGlobalStateField key={fieldKey} fieldKey={fieldKey} field={field} />
        ))}
      </div>
    </section>
  );
}

function WorkflowGlobalStateCard({ globalState, tapdId }) {
  const state = globalState && typeof globalState === "object" && !Array.isArray(globalState) ? globalState : {};
  const workflow = state.workflow && typeof state.workflow === "object" && !Array.isArray(state.workflow) ? state.workflow : {};
  const sections = state.sections && typeof state.sections === "object" && !Array.isArray(state.sections) ? state.sections : {};
  const title = String(state.title || "").trim();
  const url = prdWorkflowNormalizeHref(state.url || "");
  const status = prdWorkflowOverallDisplayValue(state.status);
  const workflowId = String(workflow.id || tapdId || "").trim();
  const sectionEntries = Object.entries(sections).filter(([sectionKey, section]) => (
    sectionKey && section && typeof section === "object" && !Array.isArray(section)
  ));
  const hasReportedContent = Boolean(title || url || status || sectionEntries.length);
  if (!workflowId && !hasReportedContent) return null;
  return (
    <article className="af-prd-workflow-card af-prd-overall">
      <div className="af-prd-workflow-card__head">
        <h2>需求概览</h2>
        {status ? <span className="af-prd-overall__status">{status}</span> : null}
      </div>
      {(title || url || workflowId) ? (
        <div className="af-prd-overall__requirement">
          {url ? (
            <a href={url} target="_blank" rel="noreferrer">
              <strong>{title || `${workflow.namespace || "Workflow"} ${workflowId}`}</strong>
              <span className="material-symbols-outlined" aria-hidden>open_in_new</span>
            </a>
          ) : <strong>{title || `${workflow.namespace === "tapd" ? "TAPD" : "Workflow"} ${workflowId}`}</strong>}
        </div>
      ) : null}
      {hasReportedContent ? (
        <div className="af-prd-overall__platforms">
          {sectionEntries.map(([sectionKey, section]) => (
            <WorkflowGlobalStateSection key={sectionKey} sectionKey={sectionKey} section={section} />
          ))}
        </div>
      ) : (
        <p className="af-prd-workflow-muted">
          暂无全局状态。各阶段可通过 Workflow 上报逐步补充负责人、配置、规则和其它上下文。
        </p>
      )}
    </article>
  );
}

function PrdWorkflowTimelinePanel({
  flowParams = {},
  tapdId,
  setTapdId,
  collaborationOpenRequest = 0,
  assistantOpenRequest = 0,
  snapshot,
  loading,
  error,
  actionRunning,
  actionOutput,
  pendingConfirm,
  conflict,
  reviewPublishing,
  onRefresh,
  onRunDryRun,
  onConfirmAction,
  onRetryConflict,
  onPublishReview,
}) {
  const [auditFilter, setAuditFilter] = useState("all");
  const [actionFilter, setActionFilter] = useState("all");
  const [checklistExpansionOverrides, setChecklistExpansionOverrides] = useState(() => new Map());
  const [shareOpen, setShareOpen] = useState(false);
  const [shareLoading, setShareLoading] = useState(false);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareError, setShareError] = useState("");
  const [shareCanCreate, setShareCanCreate] = useState(false);
  const [shareCopyState, setShareCopyState] = useState("");
  const [sharing, setSharing] = useState(null);
  const [accessCollaboration, setAccessCollaboration] = useState(null);
  const [memberUsername, setMemberUsername] = useState("");
  const [memberRole, setMemberRole] = useState("reporter");
  const [memberBusy, setMemberBusy] = useState(false);
  const [memberRemovingId, setMemberRemovingId] = useState("");
  const [knowledgeBindings, setKnowledgeBindings] = useState([]);
  const [knowledgeWorkspaces, setKnowledgeWorkspaces] = useState([]);
  const [knowledgeSelection, setKnowledgeSelection] = useState([]);
  const [knowledgeCanManage, setKnowledgeCanManage] = useState(false);
  const [knowledgeBusy, setKnowledgeBusy] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantMessages, setAssistantMessages] = useState([]);
  const [assistantBusy, setAssistantBusy] = useState(false);
  const [assistantError, setAssistantError] = useState("");
  const [assistantSources, setAssistantSources] = useState([]);
  const phase = String(snapshot?.phase || (tapdId ? "unavailable" : "unselected"));
  const issues = Array.isArray(snapshot?.issues) ? snapshot.issues : [];
  const issueGroups = prdWorkflowIssueGroups(snapshot);
  const issueCount = issueGroups.reduce((total, group) => total + workflowIssueTreeCount(group.issues), 0);
  const artifacts = Array.isArray(snapshot?.artifacts) ? snapshot.artifacts : [];
  const gaps = Array.isArray(snapshot?.optionalGaps) ? snapshot.optionalGaps : [];
  const nextAction = snapshot?.nextAction && typeof snapshot.nextAction === "object" ? snapshot.nextAction : null;
  const actionRows = prdWorkflowActionRows(snapshot, nextAction);
  const aiDocLinks = prdWorkflowAiDocLinks(snapshot, actionRows);
  const otherArtifacts = artifacts.filter((item) => !isConfirmedAiDocCandidate({
    ...item,
    href: prdWorkflowArtifactHref(item),
  }));
  const actionFilterTags = useMemo(() => prdWorkflowActionFilterTags(actionRows), [actionRows]);
  useEffect(() => {
    if (actionFilter === "all") return;
    if (!actionFilterTags.some((tag) => tag.key === actionFilter)) setActionFilter("all");
  }, [actionFilter, actionFilterTags]);
  const filteredActionRows = actionRows.filter((item) => prdWorkflowActionMatchesFilter(item, actionFilter));
  const actionDayGroups = prdWorkflowActionDayGroups(filteredActionRows);
  const allAuditRows = prdWorkflowRuntimeAuditRows(snapshot);
  const auditRows = allAuditRows.filter((item) => prdWorkflowAuditMatchesFilter(item, auditFilter));
  const completedCount = filteredActionRows.filter((item) => prdWorkflowActionCountsAsDone(item)).length;
  const collaboration = snapshot?.collaboration && typeof snapshot.collaboration === "object" ? snapshot.collaboration : {};
  const activeAction = collaboration.activeAction && typeof collaboration.activeAction === "object" ? collaboration.activeAction : null;
  const clientObservations = Array.isArray(snapshot?.clientObservations) ? snapshot.clientObservations : [];
  const rawOutput = String(snapshot?.rawOutput || "");
  const globalState = snapshot?.globalState && typeof snapshot.globalState === "object" ? snapshot.globalState : null;
  const workflowSnapshotLoading = Boolean(loading && tapdId && !snapshot);
  const requirementTitle = prdWorkflowRequirementTitle(snapshot, tapdId);
  const workflowSteps = prdWorkflowFlowSteps(phase);
  const openChecklistDocument = useCallback((item, itemKey = "") => {
    const checklist = item?.checklist || item?.actionModel?.checklist;
    const source = String(checklist?.source || item?.source || item?.producer || "").trim().toLowerCase();
    const actionKey = prdWorkflowChecklistActionKey(item);
    if (!tapdId || !source || !actionKey) return;
    const query = new URLSearchParams({
      workflow: `tapd:${tapdId}`,
      source,
      actionKey,
      returnTo: `${window.location.pathname}${window.location.search}`,
    });
    if (itemKey) query.set("itemKey", itemKey);
    if (flowParams.workflowDemo) query.set("demo", "1");
    for (const key of ["flowId", "flowSource", "workspaceId", "workflowShare", "adminOwnerId"]) {
      const value = flowParams[key];
      if (value) query.set(key, value);
    }
    if (flowParams.archived) query.set("archived", "1");
    window.open(`/workflow-checklist?${query.toString()}`, "_blank", "noopener,noreferrer");
  }, [flowParams, tapdId]);
  const toggleChecklist = useCallback((key, expanded) => {
    setChecklistExpansionOverrides((current) => {
      const next = new Map(current);
      next.set(key, !expanded);
      return next;
    });
  }, []);
  const loadKnowledgeBindings = useCallback(async () => {
    const id = String(tapdId || "").trim();
    if (!id || flowParams.workflowShare) {
      setKnowledgeBindings([]);
      setKnowledgeSelection([]);
      setKnowledgeWorkspaces([]);
      setKnowledgeCanManage(false);
      return;
    }
    const response = await fetch(`/api/workflows/knowledge-bindings?tapdId=${encodeURIComponent(id)}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "读取知识工作区绑定失败");
    const bindings = Array.isArray(payload.bindings) ? payload.bindings : [];
    setKnowledgeBindings(bindings);
    setKnowledgeSelection(bindings.map((binding) => binding.workspaceId).filter(Boolean));
    setKnowledgeWorkspaces(Array.isArray(payload.availableWorkspaces) ? payload.availableWorkspaces : []);
    setKnowledgeCanManage(payload.canManage === true);
  }, [flowParams.workflowShare, tapdId]);
  useEffect(() => {
    void loadKnowledgeBindings().catch(() => {
      setKnowledgeBindings([]);
      setKnowledgeSelection([]);
      setKnowledgeWorkspaces([]);
      setKnowledgeCanManage(false);
    });
  }, [loadKnowledgeBindings]);
  const loadSharing = useCallback(async () => {
    const id = String(tapdId || "").trim();
    if (!id) {
      setSharing(null);
      setAccessCollaboration(null);
      return;
    }
    setShareLoading(true);
    setShareError("");
    setShareCopyState("");
    try {
      const query = new URLSearchParams({ tapdId: id });
      if (flowParams.workflowShare) query.set("workflowShare", flowParams.workflowShare);
      const [response, collaborationResponse] = await Promise.all([
        fetch(`/api/prd-workflow/share?${query.toString()}`),
        fetch(`/api/prd-workflow/collaboration?tapdId=${encodeURIComponent(id)}`),
      ]);
      const [payload, collaborationPayload] = await Promise.all([
        response.json().catch(() => ({})),
        collaborationResponse.json().catch(() => ({})),
      ]);
      if (!response.ok) throw new Error(payload.error || "读取 Workflow 分享状态失败");
      if (collaborationResponse.ok) setAccessCollaboration(collaborationPayload.collaboration || null);
      let share = payload.share || null;
      const canCreate = payload.canCreate === true && !flowParams.workflowShare;
      setShareCanCreate(canCreate);
      if (!share && canCreate) {
        const createResponse = await fetch("/api/prd-workflow/share", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...flowParams, tapdId: id }),
        });
        const createPayload = await createResponse.json().catch(() => ({}));
        if (!createResponse.ok) throw new Error(createPayload.error || "生成 Workflow 分享链接失败");
        share = createPayload.share || null;
        if (!collaborationPayload.collaboration) {
          const createdCollaborationResponse = await fetch(`/api/prd-workflow/collaboration?tapdId=${encodeURIComponent(id)}`);
          const createdCollaborationPayload = await createdCollaborationResponse.json().catch(() => ({}));
          if (createdCollaborationResponse.ok) setAccessCollaboration(createdCollaborationPayload.collaboration || null);
        }
      }
      setSharing(share);
    } catch (shareLoadError) {
      setShareError(String(shareLoadError.message || shareLoadError));
    } finally {
      setShareLoading(false);
    }
  }, [flowParams, tapdId]);
  const lastCollaborationOpenRequestRef = useRef(0);
  const openSharing = useCallback(() => {
    setShareOpen(true);
    void loadSharing();
    void loadKnowledgeBindings().catch((loadError) => setShareError(String(loadError.message || loadError)));
  }, [loadKnowledgeBindings, loadSharing]);
  useEffect(() => {
    if (!collaborationOpenRequest || collaborationOpenRequest === lastCollaborationOpenRequestRef.current) return;
    lastCollaborationOpenRequestRef.current = collaborationOpenRequest;
    openSharing();
  }, [collaborationOpenRequest, openSharing]);
  const lastAssistantOpenRequestRef = useRef(0);
  const openAssistant = useCallback(async () => {
    if (!tapdId || flowParams.workflowShare) return;
    setAssistantOpen(true);
    setAssistantError("");
    try {
      const [bindingResult, conversationResponse] = await Promise.all([
        loadKnowledgeBindings(),
        fetch(`/api/workflows/conversation?tapdId=${encodeURIComponent(tapdId)}`),
      ]);
      void bindingResult;
      const conversationPayload = await conversationResponse.json().catch(() => ({}));
      if (conversationResponse.ok) setAssistantMessages(Array.isArray(conversationPayload.messages) ? conversationPayload.messages : []);
    } catch (assistantLoadError) {
      setAssistantError(String(assistantLoadError.message || assistantLoadError));
    }
  }, [flowParams.workflowShare, loadKnowledgeBindings, tapdId]);
  useEffect(() => {
    if (!assistantOpenRequest || assistantOpenRequest === lastAssistantOpenRequestRef.current) return;
    lastAssistantOpenRequestRef.current = assistantOpenRequest;
    void openAssistant();
  }, [assistantOpenRequest, openAssistant]);
  const saveKnowledgeBindings = async () => {
    if (!tapdId || knowledgeBusy || !knowledgeCanManage) return;
    setKnowledgeBusy(true);
    setShareError("");
    try {
      const response = await fetch("/api/workflows/knowledge-bindings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tapdId, workspaceIds: knowledgeSelection }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "保存知识工作区绑定失败");
      setKnowledgeBindings(Array.isArray(payload.bindings) ? payload.bindings : []);
      if (payload.collaboration) setAccessCollaboration(payload.collaboration);
    } catch (knowledgeError) {
      setShareError(String(knowledgeError.message || knowledgeError));
    } finally {
      setKnowledgeBusy(false);
    }
  };
  const submitWorkflowQuestion = async (question) => {
    const text = String(question || "").trim();
    if (!tapdId || !text || assistantBusy) return;
    const optimistic = [...assistantMessages, { role: "user", content: text }];
    setAssistantMessages(optimistic);
    setAssistantBusy(true);
    setAssistantError("");
    try {
      const response = await fetch("/api/workflows/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tapdId, question: text, messages: assistantMessages }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Workflow AI 分析失败");
      setAssistantMessages(Array.isArray(payload.messages) ? payload.messages : [...optimistic, { role: "assistant", content: payload.content || "" }]);
      setAssistantSources(Array.isArray(payload.sources) ? payload.sources : []);
    } catch (questionError) {
      setAssistantError(String(questionError.message || questionError));
      setAssistantMessages(assistantMessages);
    } finally {
      setAssistantBusy(false);
    }
  };
  const createSharingLink = async () => {
    if (!tapdId || shareBusy || flowParams.workflowShare) return;
    setShareBusy(true);
    setShareError("");
    setShareCopyState("");
    try {
      const response = await fetch("/api/prd-workflow/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...flowParams, tapdId }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "生成 Workflow 分享链接失败");
      setSharing(payload.share || null);
      setShareCanCreate(true);
      const collaborationResponse = await fetch(`/api/prd-workflow/collaboration?tapdId=${encodeURIComponent(tapdId)}`);
      const collaborationPayload = await collaborationResponse.json().catch(() => ({}));
      if (collaborationResponse.ok) setAccessCollaboration(collaborationPayload.collaboration || null);
    } catch (shareCreateError) {
      setShareError(String(shareCreateError.message || shareCreateError));
    } finally {
      setShareBusy(false);
    }
  };
  const copySharingLink = async () => {
    const copied = await copyTextToClipboard(sharing?.shortUrl || sharing?.url || "");
    setShareCopyState(copied ? "已复制" : "复制失败");
  };
  const revokeSharingLink = async () => {
    if (!tapdId || shareBusy || !sharing?.canManage) return;
    setShareBusy(true);
    setShareError("");
    setShareCopyState("");
    try {
      const response = await fetch("/api/prd-workflow/share", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tapdId }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "取消 Workflow 分享链接失败");
      setSharing(null);
      setShareCanCreate(true);
    } catch (shareRevokeError) {
      setShareError(String(shareRevokeError.message || shareRevokeError));
    } finally {
      setShareBusy(false);
    }
  };
  const saveWorkflowMember = async (username = memberUsername, role = memberRole) => {
    const identity = String(username || "").trim();
    if (!tapdId || !identity || memberBusy) return;
    setMemberBusy(true);
    setShareError("");
    try {
      const response = await fetch("/api/prd-workflow/collaboration/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tapdId, username: identity, role }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "更新成员权限失败");
      setAccessCollaboration(payload.collaboration || null);
      setMemberUsername("");
    } catch (memberError) {
      setShareError(String(memberError.message || memberError));
    } finally {
      setMemberBusy(false);
    }
  };
  const removeWorkflowMember = async (member) => {
    const memberUserId = String(member?.userId || "").trim();
    if (!tapdId || !memberUserId || memberRemovingId) return;
    setMemberRemovingId(memberUserId);
    setShareError("");
    try {
      const response = await fetch("/api/prd-workflow/collaboration/share", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tapdId, memberUserId }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "移除成员授权失败");
      setAccessCollaboration(payload.collaboration || null);
    } catch (memberError) {
      setShareError(String(memberError.message || memberError));
    } finally {
      setMemberRemovingId("");
    }
  };
  const sharingUrl = sharing?.shortUrl || sharing?.url || "";
  const canManageMembers = accessCollaboration?.role === "owner";
  return (
    <main className="af-prd-workflow af-prd-workflow--timeline" aria-label="PRD Workflow">
      <section className="af-prd-workflow__statusbar">
        <div className="af-prd-workflow__status-main">
          <span className={`af-prd-workflow-phase af-prd-workflow-phase--${phase.toLowerCase().replace(/[^a-z0-9_-]+/gi, "_")}`}>
            {prdWorkflowPhaseLabel(phase)}
          </span>
          <h1>{requirementTitle}</h1>
          <p className="af-prd-workflow__status-subtitle">
            {tapdId ? <>TAPD <strong>{tapdId}</strong> · {flowParams.workflowDemo ? "本地只读示例" : "独立需求 Workflow"}</> : <>尚未选择 TAPD 需求</>}
          </p>
          {error ? <p className="af-prd-workflow-error">{error}</p> : null}
          {(activeAction || collaboration.subscribers || knowledgeBindings.length) ? (
            <div className="af-prd-workflow-collab">
              {activeAction ? (
                <span>
                  <span className="material-symbols-outlined" aria-hidden>lock</span>
                  {activeAction.title || activeAction.action || "Workflow action"} 执行中
                  {activeAction.userId ? <small>{activeAction.userId}</small> : null}
                </span>
              ) : null}
              {collaboration.subscribers ? (
                <span>
                  <span className="material-symbols-outlined" aria-hidden>group</span>
                  {collaboration.subscribers} 个连接
                </span>
              ) : null}
              {knowledgeBindings.slice(0, 3).map((binding) => (
                <span
                  key={binding.workspaceId}
                  className="af-prd-workflow-knowledge-chip"
                  title={[binding.label, binding.branch, binding.repoUrl].filter(Boolean).join(" · ")}
                >
                  <span className="material-symbols-outlined" aria-hidden>database</span>
                  {binding.label}
                  {(binding.type || binding.branch) ? (
                    <small>{[binding.type, binding.branch].filter(Boolean).join(" · ")}</small>
                  ) : null}
                </span>
              ))}
              {knowledgeBindings.length > 3 ? (
                <span className="af-prd-workflow-knowledge-chip af-prd-workflow-knowledge-chip--more">
                  +{knowledgeBindings.length - 3} 个知识库
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
        <form className="af-prd-workflow__lookup" onSubmit={(event) => {
          event.preventDefault();
          onRefresh?.();
        }}>
          <div className="af-prd-workflow-flow" aria-label="需求流程阶段">
            {workflowSteps.map((step) => (
              <div key={step.label} className={`af-prd-workflow-flow__step af-prd-workflow-flow__step--${step.status}`}>
                <span aria-hidden="true" />
                <small>{step.label}</small>
              </div>
            ))}
          </div>
          <div className="af-prd-workflow__lookup-row">
            <label>
              <span>TAPD Workflow</span>
              <input
                value={tapdId}
                onChange={(event) => setTapdId(event.target.value)}
                readOnly={flowParams.workflowDemo}
                placeholder="输入需求 ID"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <button type="submit" disabled={loading}>
              <span className="material-symbols-outlined" aria-hidden>{loading ? "hourglass_empty" : "sync"}</span>
              {loading ? "读取中" : tapdId ? "刷新" : "读取"}
            </button>
          </div>
        </form>
      </section>

      {conflict ? (
        <section className="af-prd-workflow-conflict" aria-label="Workflow conflict">
          <div>
            <span className="material-symbols-outlined" aria-hidden>sync_problem</span>
            <div>
              <strong>状态已变化，需要重新确认</strong>
              <p>{conflict.message || "当前 workflow 状态和执行前不一致。"}</p>
            </div>
          </div>
          <dl>
            <div>
              <dt>执行时 revision</dt>
              <dd>{conflict.expectedRevision || "空"}</dd>
            </div>
            <div>
              <dt>当前 revision</dt>
              <dd>{conflict.currentRevision || "未知"}</dd>
            </div>
            <div>
              <dt>当前状态</dt>
              <dd>{[prdWorkflowPhaseLabel(conflict.currentPhase), conflict.currentPointer].filter(Boolean).join(" · ") || "未知"}</dd>
            </div>
          </dl>
          <div className="af-prd-workflow-conflict__actions">
            <button type="button" onClick={() => onRefresh?.()} disabled={loading || actionRunning}>刷新状态</button>
          </div>
        </section>
      ) : null}

      <section className="af-prd-workflow__main">
        <article className="af-prd-workflow-actions" aria-label="Workflow actions">
          <div className="af-prd-workflow-actions__head">
            <div>
              <h2>Action 时间线</h2>
              <p>{actionRows.length ? `${completedCount}/${filteredActionRows.length} 已完成${actionFilter !== "all" ? ` · 共 ${actionRows.length}` : ""}` : "等待 prd-flow 返回 action 列表"}</p>
            </div>
            {nextAction && prdWorkflowActionId(nextAction) ? (
              <div className="af-prd-workflow-local-command">
                <span>本地 agent 执行</span>
                <code>{nextAction.command || prdWorkflowActionTitle(nextAction, 0)}</code>
              </div>
            ) : null}
          </div>
          {actionFilterTags.length ? (
            <div className="af-prd-workflow-action-filters" aria-label="Action tag filters">
              <button
                type="button"
                className={actionFilter === "all" ? "is-active" : ""}
                aria-pressed={actionFilter === "all"}
                onClick={() => setActionFilter("all")}
              >
                全部 <span>{actionRows.length}</span>
              </button>
              {actionFilterTags.map((tag) => (
                <button
                  key={tag.key}
                  type="button"
                  className={actionFilter === tag.key ? "is-active" : ""}
                  aria-pressed={actionFilter === tag.key}
                  onClick={() => setActionFilter(tag.key)}
                >
                  {tag.label} <span>{tag.count}</span>
                </button>
              ))}
            </div>
          ) : null}
          <div className="af-prd-workflow-action-list">
            {workflowSnapshotLoading ? (
              <LoadingState
                className="af-prd-workflow-action-loading"
                title="正在读取 Workflow"
                detail="同步 Action、阶段进度与关联产物…"
                rows={4}
              />
            ) : filteredActionRows.length ? actionDayGroups.map((group) => (
              <section key={group.day} className="af-prd-workflow-action-day">
                <div className="af-prd-workflow-action-day__label">
                  <span>{group.day}</span>
                  <small>北京时间</small>
                </div>
                <div className="af-prd-workflow-action-day__items">
                  {group.items.map(({ item, index }) => {
                    const rawStatus = prdWorkflowActionStatus(item.status);
                    const status = prdWorkflowActionTruth(item) === "observation" && rawStatus === "done" ? "observed" : rawStatus;
                    const links = prdWorkflowActionLinks(item);
                    const time = prdWorkflowBeijingTimeLabel(item);
                    const meta = prdWorkflowActionMeta(item);
                    const title = prdWorkflowActionDisplayTitle(item, index);
                    const detail = prdWorkflowActionDisplayDetail(item);
                    const checklist = item?.checklist || item?.actionModel?.checklist;
                    const checklistItems = Array.isArray(checklist?.items) ? checklist.items : [];
                    const checklistProgress = checklist?.progress || { completed: 0, total: checklistItems.length, percent: 0 };
                    const checklistCardKey = [
                      item?.source || item?.producer,
                      prdWorkflowChecklistActionKey(item),
                      item?.id || item?.actionId,
                      group.day,
                      index,
                    ].filter((value) => value !== undefined && value !== null && value !== "").join(":");
                    const checklistExpanded = checklistExpansionOverrides.has(checklistCardKey)
                      ? checklistExpansionOverrides.get(checklistCardKey)
                      : status === "current";
                    return (
                      <div key={item.id || item.actionId || `${prdWorkflowActionTitle(item, index)}-${index}`} className={`af-prd-workflow-action af-prd-workflow-action--${status}`}>
                        <div className="af-prd-workflow-action__rail">
                          <span className="af-prd-workflow-action__dot" />
                        </div>
                        <div className="af-prd-workflow-action__body">
                          <div className="af-prd-workflow-action__top">
                            <div>
                              <div className="af-prd-workflow-action__title">
                                {time ? <time dateTime={prdWorkflowActionTime(item)}>{time}</time> : null}
                                <strong>{title}</strong>
                              </div>
                              {detail ? <p>{detail}</p> : null}
                              {meta.length ? (
                                <div className="af-prd-workflow-action__meta">
                                  {meta.map((entry) => (
                                    <span
                                      key={`${entry.label}-${entry.value}`}
                                      className={`af-prd-workflow-action__meta-item af-prd-workflow-action__meta-item--${entry.label === "Issue" ? "issue" : "platform"}`}
                                      title={`${entry.label} · ${entry.value}`}
                                    >
                                      <b>{entry.label}</b>
                                      <span className="af-prd-workflow-action__meta-value">{entry.value}</span>
                                    </span>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                            <span className="af-prd-workflow-action__status">{prdWorkflowActionDisplayStatus(item)}</span>
                          </div>
                          {checklistItems.length ? (
                            <section className="af-prd-workflow-checklist" aria-label={`${title} Checklist`}>
                              <button
                                type="button"
                                className="af-prd-workflow-checklist__head"
                                aria-expanded={checklistExpanded}
                                onClick={() => toggleChecklist(checklistCardKey, checklistExpanded)}
                              >
                                <div>
                                  <strong>执行清单</strong>
                                  <span>{checklistProgress.completed || 0}/{checklistProgress.total || checklistItems.length}</span>
                                </div>
                                <div>
                                  <small>{checklistProgress.ready ? "可确认完成" : `${checklistProgress.percent || 0}%`}</small>
                                  <span className="material-symbols-outlined" aria-hidden>{checklistExpanded ? "expand_less" : "expand_more"}</span>
                                </div>
                              </button>
                              <div className="af-prd-workflow-checklist__meter"><span style={{ width: `${checklistProgress.percent || 0}%` }} /></div>
                              {checklistExpanded ? (
                                <>
                                  <div className="af-prd-workflow-checklist__items">
                                    {checklistItems.slice(0, 6).map((checkItem) => (
                                      <button type="button" key={checkItem.key} onClick={() => openChecklistDocument(item, checkItem.key)}>
                                        <span className={`af-prd-workflow-checklist__state is-${checkItem.state?.status || "pending"}`}>
                                          <span className="material-symbols-outlined" aria-hidden>{prdWorkflowChecklistStatusIcon(checkItem.state?.status)}</span>
                                        </span>
                                        <strong>{checkItem.title}</strong>
                                        <span className="material-symbols-outlined" aria-hidden>open_in_new</span>
                                      </button>
                                    ))}
                                  </div>
                                  <button type="button" className="af-prd-workflow-checklist__open" onClick={() => openChecklistDocument(item)}>
                                    <span>{checklist.document?.title || "查看完整 Checklist 文档"}</span>
                                    {checklistItems.length > 6 ? <small>还有 {checklistItems.length - 6} 项</small> : null}
                                    <span className="material-symbols-outlined" aria-hidden>open_in_new</span>
                                  </button>
                                </>
                              ) : null}
                            </section>
                          ) : null}
                          {links.length ? (
                            <div className="af-prd-workflow-action__links">
                              {links.map((link) => (
                                <a key={`${link.label}-${link.href}`} href={link.href} target="_blank" rel="noreferrer">
                                  <span>{link.label}</span>
                                  <span className="material-symbols-outlined" aria-hidden>open_in_new</span>
                                </a>
                              ))}
                            </div>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )) : (
              <div className="af-prd-workflow-action-empty">
                <strong>{tapdId ? (actionRows.length ? "当前 tag 下暂无 action" : "暂无 prd-flow 上报 action") : "先选择 TAPD 需求"}</strong>
                <p>{tapdId ? (actionRows.length ? "切换到其它 tag 或查看全部。" : "Workflow tab 不会生成默认步骤；需要 prd-flow snapshot 返回 actions/timeline/events/history 或 nextAction。") : "选择后从 prd-flow 读取真实 action、产物和 URL。"}</p>
              </div>
            )}
          </div>
        </article>

        <aside className="af-prd-workflow-side" aria-label="Workflow related links">
          <WorkflowGlobalStateCard globalState={globalState} tapdId={tapdId} />
          {otherArtifacts.length ? (
            <article className="af-prd-workflow-card">
              <div className="af-prd-workflow-card__head">
                <h2>关联产物</h2>
                <span>{otherArtifacts.length}</span>
              </div>
              <div className="af-prd-workflow-list">
                {otherArtifacts.map((item, index) => {
                  const href = prdWorkflowArtifactHref(item);
                  const label = String(item.label || item.title || item.kind || href || `Artifact ${index + 1}`);
                  return href ? (
                    <a key={`${href}-${index}`} href={href} target="_blank" rel="noreferrer">
                      <span>{label}</span>
                      <small>{item.kind || href}</small>
                    </a>
                  ) : (
                    <div key={`${label}-${index}`}>
                      <span>{label}</span>
                      <small>{item.kind || ""}</small>
                    </div>
                  );
                })}
              </div>
            </article>
          ) : null}
          <article className="af-prd-workflow-card">
            <div className="af-prd-workflow-card__head">
              <h2>AI Docs</h2>
              <span>{aiDocLinks.length}</span>
            </div>
            <div className="af-prd-workflow-list">
              {aiDocLinks.length ? aiDocLinks.map((item) => {
                const title = String(item.title || item.label || "ai-doc").trim();
                const meta = [
                  item.label && item.label !== title ? item.label : "",
                  item.platform,
                  item.issueKey,
                ].filter(Boolean);
                return (
                  <a className="af-prd-ai-doc" key={item.href} href={item.href} target="_blank" rel="noreferrer" title={title}>
                    <span className="af-prd-ai-doc__title">{title}</span>
                    <small className="af-prd-ai-doc__meta">{meta.join(" · ") || item.kind || "ai-doc"}</small>
                  </a>
                );
              }) : (
                <p className="af-prd-workflow-muted">暂无 ai-doc 文档。</p>
              )}
            </div>
          </article>
          <article className="af-prd-workflow-card">
            <div className="af-prd-workflow-card__head">
              <h2>Issues</h2>
              <span>{issueCount || issues.length}</span>
            </div>
            <div className="af-prd-workflow-issues">
              {issueGroups.length ? issueGroups.map((group) => (
                <div key={group.key} className="af-prd-workflow-epic">
                  <div className="af-prd-workflow-epic__head">
                    <strong>{group.title || group.key}</strong>
                    <small>{workflowIssueTreeCount(group.issues)}</small>
                  </div>
                  {group.issues.map((row, index) => (
                    <PrdWorkflowIssueCard
                      key={prdWorkflowIssueKey(row?.issue || {}, index)}
                      row={row}
                      index={index}
                    />
                  ))}
                </div>
              )) : (
                <p className="af-prd-workflow-muted">暂无 Issue 信息。</p>
              )}
            </div>
          </article>
          <article className="af-prd-workflow-card">
            <div className="af-prd-workflow-card__head">
              <h2>运行审计</h2>
              <span>{auditRows.length}/{allAuditRows.length}</span>
            </div>
            <div className="af-prd-workflow-audit-filter" role="tablist" aria-label="运行审计筛选">
              {[
                ["all", "全部"],
                ["errors", "异常"],
                ["review", "Review"],
                ["external", "外部"],
              ].map(([key, label]) => (
                <button key={key} type="button" className={auditFilter === key ? "is-active" : ""} onClick={() => setAuditFilter(key)}>
                  {label}
                </button>
              ))}
            </div>
            <div className="af-prd-workflow-audit">
              {auditRows.length ? auditRows.map((item, index) => (
                <div key={item.id || `${item.type}-${index}`}>
                  <strong>{prdWorkflowActionTitle(item, index)}</strong>
                  <small>{[item.status, item.type, prdWorkflowActionTime(item)].filter(Boolean).join(" · ")}</small>
                </div>
              )) : (
                <p className="af-prd-workflow-muted">暂无运行事件。</p>
              )}
            </div>
          </article>
          {rawOutput || actionOutput ? (
            <article className="af-prd-workflow-card af-prd-workflow-card--raw">
              <div className="af-prd-workflow-card__head">
                <h2>Raw</h2>
              </div>
              <pre>{actionOutput || rawOutput}</pre>
            </article>
          ) : null}
        </aside>
      </section>
      {shareOpen ? createPortal(
        <div className="af-flow-snippet-modal-overlay">
          <div className="af-flow-snippet-modal af-display-share-modal af-display-link-modal" role="dialog" aria-modal="true" aria-label="需求协作">
            <div className="af-flow-snippet-modal__head">
              <span className="af-flow-snippet-modal__title">
                <span className="material-symbols-outlined" aria-hidden>group_add</span>
                需求协作
              </span>
              <button type="button" className="af-flow-snippet-modal__close" onClick={() => setShareOpen(false)} aria-label="关闭">
                <span className="material-symbols-outlined" aria-hidden>close</span>
              </button>
            </div>
            <div className="af-flow-snippet-modal__body">
              <section className="af-prd-workflow-access-panel" aria-label="Workflow 成员权限">
                <div className="af-prd-workflow-access-panel__head">
                  <div>
                    <strong>成员权限</strong>
                    <small>TAPD Owner 自动管理；TAPD 参与人默认只读</small>
                  </div>
                  {accessCollaboration?.authority?.type === "tapd" ? <span>TAPD 已同步</span> : <span>待 TAPD 同步</span>}
                </div>
                {canManageMembers ? (
                  <div className="af-workspace-member-add af-prd-workflow-member-add">
                    <input
                      type="text"
                      value={memberUsername}
                      onChange={(event) => setMemberUsername(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" && memberUsername.trim() && !memberBusy) {
                          event.preventDefault();
                          void saveWorkflowMember();
                        }
                      }}
                      placeholder="输入 AgentFlow 用户名"
                      aria-label="成员用户名"
                    />
                    <select value={memberRole} onChange={(event) => setMemberRole(event.target.value)} aria-label="成员权限">
                      <option value="reporter">可上报</option>
                      <option value="viewer">只读</option>
                    </select>
                    <button type="button" disabled={memberBusy || !memberUsername.trim()} onClick={() => void saveWorkflowMember()}>
                      {memberBusy ? "保存中..." : "保存权限"}
                    </button>
                  </div>
                ) : null}
                <div className="af-workspace-member-list">
                  {(accessCollaboration?.members || []).map((member) => {
                    const isOwner = member.role === "owner" || member.userId === accessCollaboration?.ownerId;
                    const isExplicit = member.source === "explicit";
                    const roleLabel = isOwner
                      ? "需求 Owner"
                      : member.role === "reporter"
                      ? "可上报"
                      : member.source === "tapd"
                      ? "TAPD 参与人 · 只读"
                      : "只读";
                    return (
                      <div className="af-workspace-member-row" key={member.userId}>
                        <span className="material-symbols-outlined" aria-hidden>{isOwner ? "shield_person" : "person"}</span>
                        <div>
                          <strong>{member.username || member.userId}</strong>
                          <small>{roleLabel}</small>
                        </div>
                        {canManageMembers && !isOwner ? (
                          <div className="af-prd-workflow-member-actions">
                            <select
                              value={member.role === "reporter" ? "reporter" : "viewer"}
                              disabled={memberBusy || Boolean(memberRemovingId)}
                              onChange={(event) => void saveWorkflowMember(member.username || member.userId, event.target.value)}
                              aria-label={`${member.username || member.userId} 的权限`}
                            >
                              <option value="reporter">可上报</option>
                              <option value="viewer">只读</option>
                            </select>
                            {isExplicit ? (
                              <button type="button" disabled={memberRemovingId === member.userId} onClick={() => void removeWorkflowMember(member)}>
                                {memberRemovingId === member.userId ? "移除中..." : "移除授权"}
                              </button>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                {accessCollaboration?.authority?.unresolvedParticipants?.length ? (
                  <p className="af-prd-workflow-access-panel__unresolved">
                    尚未匹配 AgentFlow 账号：{accessCollaboration.authority.unresolvedParticipants.join("、")}
                  </p>
                ) : null}
              </section>
              {!flowParams.workflowShare ? (
                <section className="af-prd-workflow-access-panel af-workflow-knowledge-panel" aria-label="Workflow 知识工作区">
                  <div className="af-prd-workflow-access-panel__head">
                    <div>
                      <strong>AI 知识工作区</strong>
                      <small>AI 会结合需求上下文，在隔离的代码快照中回答问题；不会修改真实仓库</small>
                    </div>
                    <span>{knowledgeBindings.length ? `已绑定 ${knowledgeBindings.length} 个` : "未绑定"}</span>
                  </div>
                  {knowledgeCanManage ? (
                    <>
                      <div className="af-workflow-knowledge-options">
                        {knowledgeWorkspaces.length ? knowledgeWorkspaces.map((workspace) => {
                          const checked = knowledgeSelection.includes(workspace.workspaceId);
                          return (
                            <label key={workspace.workspaceId} className={checked ? "is-selected" : ""}>
                              <input
                                type="checkbox"
                                checked={checked}
                                onChange={() => setKnowledgeSelection((current) => checked
                                  ? current.filter((id) => id !== workspace.workspaceId)
                                  : [...current, workspace.workspaceId])}
                              />
                              <span>
                                <strong>{workspace.label}</strong>
                                <small>{[workspace.type, workspace.branch, workspace.repoUrl].filter(Boolean).join(" · ")}</small>
                              </span>
                            </label>
                          );
                        }) : <p className="af-prd-workflow-muted">暂无可绑定的知识工作区，请先在知识库页面配置并同步 Git 仓库。</p>}
                      </div>
                      <button type="button" className="af-flow-snippet-modal__btn" disabled={knowledgeBusy} onClick={() => void saveKnowledgeBindings()}>
                        {knowledgeBusy ? "保存中..." : "保存知识绑定"}
                      </button>
                    </>
                  ) : (
                    <div className="af-workflow-knowledge-bindings">
                      {knowledgeBindings.length ? knowledgeBindings.map((binding) => (
                        <span key={binding.workspaceId}>{binding.label}{binding.branch ? ` · ${binding.branch}` : ""}</span>
                      )) : <p className="af-prd-workflow-muted">Owner 尚未绑定代码知识工作区；仍可只基于需求上下文提问。</p>}
                    </div>
                  )}
                </section>
              ) : null}
              <div className="af-prd-workflow-share-divider"><span>只读链接</span></div>
              <p className="af-display-link-modal__empty">
                通过链接分享 TAPD {tapdId}；不会授予上报权限，也不会分享当前 Project、画布或项目文件。
              </p>
              {shareLoading ? <div className="af-display-link-modal__empty">正在生成分享链接...</div> : null}
              {!shareLoading && sharingUrl ? (
                <>
                  <div className="af-display-link-modal__url">
                  <input
                    type="text"
                    value={sharingUrl}
                    readOnly
                    onFocus={(event) => event.currentTarget.select()}
                    aria-label="Workflow 分享链接"
                  />
                  <button type="button" disabled={shareBusy} onClick={() => void copySharingLink()}>
                    <span className="material-symbols-outlined" aria-hidden>content_copy</span>
                    {shareCopyState || "复制链接"}
                  </button>
                  {sharing.canManage ? (
                    <button type="button" disabled={shareBusy} onClick={() => void revokeSharingLink()}>
                      {shareBusy ? "处理中..." : "取消分享"}
                    </button>
                  ) : null}
                  </div>
                  <div className="af-prd-workflow-share-note">
                    获得链接的人无需登录即可只读查看同一份 Workflow；链接不会授予需求推进或项目编辑权限。
                  </div>
                </>
              ) : null}
              {!shareLoading && !sharingUrl && shareCanCreate ? (
                <button type="button" className="af-flow-snippet-modal__btn" disabled={shareBusy} onClick={() => void createSharingLink()}>
                  {shareBusy ? "生成中..." : "生成分享链接"}
                </button>
              ) : null}
              {shareError ? <div className="af-flow-snippet-error">{shareError}</div> : null}
            </div>
            <div className="af-flow-snippet-modal__foot">
              <button type="button" className="af-flow-snippet-modal__btn af-flow-snippet-modal__btn--primary" onClick={() => setShareOpen(false)}>
                完成
              </button>
            </div>
          </div>
        </div>,
        document.body,
      ) : null}
      {assistantOpen ? createPortal(
        <aside className="af-pipeline-drawer af-pipeline-drawer--wide af-workflow-ai-drawer" aria-label="Workflow AI">
          <div className="af-composer-sidebar">
            <div className="af-pipeline-drawer-head">
              <div>
                <h2 className="af-pipeline-drawer-title">Workflow AI</h2>
                <small>TAPD {tapdId} · 需求与代码只读分析</small>
              </div>
              <button type="button" className="af-pipeline-drawer-close af-icon-btn" onClick={() => setAssistantOpen(false)} aria-label="关闭 Workflow AI">
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div className="af-workflow-ai-context">
              <span className="material-symbols-outlined" aria-hidden>verified_user</span>
              <div>
                <strong>{knowledgeBindings.length ? `${knowledgeBindings.length} 个代码知识工作区` : "仅需求上下文"}</strong>
                <small>{knowledgeBindings.length ? "优先使用上报 commit/ref，否则使用绑定分支或本地 HEAD" : "请让需求 Owner 在“协作”中绑定代码仓库"}</small>
              </div>
            </div>
            <Suspense fallback={(
              <div className="af-workflow-assistant-loading" role="status">
                <span className="material-symbols-outlined" aria-hidden>auto_awesome</span>
                正在准备需求 AI…
              </div>
            )}>
              <WorkflowAssistantThread
                messages={assistantMessages}
                running={assistantBusy}
                error={assistantError}
                sources={assistantSources}
                suggestions={["这个需求目前做到哪里了？", "核心实现逻辑在哪些文件？", "当前实现还有哪些风险或遗漏？"]}
                onSend={submitWorkflowQuestion}
              />
            </Suspense>
          </div>
        </aside>,
        document.body,
      ) : null}
    </main>
  );
}

function workspaceConflictValueText(item, side) {
  if (!item?.[`has${side[0].toUpperCase()}${side.slice(1)}`]) return "（删除该字段）";
  const value = item?.[side];
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function workspaceConflictManualText(item) {
  if (!item?.hasIncoming) return "null";
  try {
    return JSON.stringify(item.incoming, null, 2);
  } catch {
    return JSON.stringify(String(item.incoming));
  }
}

function applyWorkspaceConflictPath(graph, pathParts, value, exists = true) {
  const next = JSON.parse(JSON.stringify(graph || {}));
  const parts = Array.isArray(pathParts) ? pathParts : [];
  if (!parts.length) return exists ? value : {};
  let cursor = next;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index];
    const following = parts[index + 1];
    if (!cursor[part] || typeof cursor[part] !== "object") {
      cursor[part] = Number.isInteger(following) ? [] : {};
    }
    cursor = cursor[part];
  }
  const finalPart = parts[parts.length - 1];
  if (exists) cursor[finalPart] = value;
  else if (Array.isArray(cursor) && Number.isInteger(finalPart)) cursor.splice(finalPart, 1);
  else delete cursor[finalPart];
  return next;
}

function WorkspacePageInner() {
  const { t, i18n } = useTranslation();
  const { navigate } = useRoute();
  const reactFlow = useReactFlow();
  const reactFlowStore = useStoreApi();
  const updateNodeInternals = useUpdateNodeInternals();
  const flowParams = useMemo(readFlowParamsFromUrl, []);
  const isWorkflowShareView = Boolean(flowParams.workflowShare);
  const initialFocusNodeIdRef = useRef(new URLSearchParams(window.location.search).get("focusNodeId") || "");
  const workspaceViewportStorageKey = useMemo(
    () => (
      flowParams.workspaceId
        ? `agentflow.workspace.viewport:shared:${flowParams.workspaceId}`
        : `agentflow.workspace.viewport:${flowParams.flowSource || "user"}:${flowParams.adminOwnerId || "self"}:${flowParams.flowId || ""}`
    ),
    [flowParams],
  );
  const [workspaceMode, setWorkspaceMode] = useState(() => (
    (() => {
      if (flowParams.workflowShare) return "workflow";
      const view = new URLSearchParams(window.location.search).get("view");
      return view === "display" || view === "workflow" ? view : "workspace";
    })()
  ));
  const [archiveModalOpen, setArchiveModalOpen] = useState(false);
  const [deleteModalOpen, setDeleteModalOpen] = useState(false);
  const [nodes, setNodes] = useNodesState([]);
  const [edges, setEdges] = useEdgesState([]);
  const nodesRef = useRef([]);
  const edgesRef = useRef([]);
  const workspaceCanvasRef = useRef(null);
  const [displayPage, setDisplayPage] = useState(() => normalizeDisplayPageState(null, []));
  const displayPageRef = useRef(displayPage);
  const [workspaceViewport, setWorkspaceViewport] = useState(null);
  const workspaceViewportRef = useRef(null);
  const workspaceViewportInitializedRef = useRef(false);
  const [selectedDisplayNodeIds, setSelectedDisplayNodeIds] = useState([]);
  const nodeHandleSignaturesRef = useRef(new Map());
  const renderedNodeLayoutSignaturesRef = useRef(new Map());
  const pendingNodeInternalsRefreshRef = useRef(new Set());
  const retryNodeInternalsRefreshRef = useRef(new Set());
  const nodeInternalsRefreshFrameRef = useRef(null);
  const nodeInternalsRefreshTimerRef = useRef(null);
  const lastActiveCanvasNodeChangesRef = useRef([]);
  const canvasClipboardRef = useRef(null);
  const connectionStartRef = useRef(null);
  const connectionMenuRef = useRef(null);
  const [connectionMenu, setConnectionMenu] = useState(null);
  const [instances, setInstances] = useState({});
  const instancesRef = useRef({});
  const loadedRef = useRef(false);
  const saveTimerRef = useRef(null);
  const workspaceRevisionRef = useRef("");
  const workspaceBaseGraphRef = useRef(null);
  const workspaceSaveChainRef = useRef(Promise.resolve());
  const workspaceSaveQueueRef = useRef({ running: false, pending: null });
  const workspaceEditVersionRef = useRef(0);
  const workspaceDirtyRef = useRef(false);
  const workspaceLoadRequestRef = useRef(0);
  const workspaceRemoteRefreshTimerRef = useRef(null);
  const workspaceRemoteRefreshInFlightRef = useRef(false);
  const workspaceRemoteRefreshQueuedRef = useRef(false);
  const workspaceRemoteRefreshTargetRevisionRef = useRef("");
  const skipNextWorkspaceAutosaveRef = useRef(false);
  const workspaceAutosaveSuppressedStateRef = useRef(null);
  const workspaceCanvasInteractionActiveRef = useRef(false);
  const workspaceCanvasPointerIdsRef = useRef(new Set());
  const workspaceViewportInteractionActiveRef = useRef(false);
  const workspaceFlushAfterInteractionRef = useRef(false);
  const workspaceCanvasIsInteracting = useCallback(() => (
    workspaceCanvasInteractionIsActive({
      nodeInteraction: workspaceCanvasInteractionActiveRef.current,
      pointerCount: workspaceCanvasPointerIdsRef.current.size,
      viewportInteraction: workspaceViewportInteractionActiveRef.current,
    })
  ), []);
  const collaborationClientIdRef = useRef(
    typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `client-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const conversationsLoadedRef = useRef(false);
  const conversationsSaveTimerRef = useRef(null);
  const [palette, setPalette] = useState([]);
  const paletteRef = useRef([]);
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
  const [displayShareDraft, setDisplayShareDraft] = useState(() => defaultDisplayShareDraft());
  const [sharingDisplayNodeId, setSharingDisplayNodeId] = useState("");
  const [displayLinkOpen, setDisplayLinkOpen] = useState(false);
  const [displayLinkCopyState, setDisplayLinkCopyState] = useState("");
  const [displaySharesOpen, setDisplaySharesOpen] = useState(false);
  const [displayShares, setDisplayShares] = useState([]);
  const [displaySharesLoading, setDisplaySharesLoading] = useState(false);
  const [displaySharesError, setDisplaySharesError] = useState("");
  const [displayShareUpdatingId, setDisplayShareUpdatingId] = useState("");
  const [displayShareCopyId, setDisplayShareCopyId] = useState("");
  const [displayPickerOpen, setDisplayPickerOpen] = useState(false);
  const [displayPickerSearch, setDisplayPickerSearch] = useState("");
  const [displayPreviewNodeId, setDisplayPreviewNodeId] = useState("");
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
  const [workspaceWritable, setWorkspaceWritable] = useState(!flowParams.adminOwnerId);
  const [adminReview, setAdminReview] = useState(() => (
    flowParams.adminOwnerId
      ? { readonly: true, ownerUserId: flowParams.adminOwnerId, ownerUsername: flowParams.adminOwnerId }
      : null
  ));
  const [workspaceCollaboration, setWorkspaceCollaboration] = useState(null);
  const [workspaceShareOpen, setWorkspaceShareOpen] = useState(false);
  const [workspaceShareBusy, setWorkspaceShareBusy] = useState(false);
  const [workspaceShareError, setWorkspaceShareError] = useState("");
  const [workspaceShareUsername, setWorkspaceShareUsername] = useState("");
  const [workspaceShareRemovingUserId, setWorkspaceShareRemovingUserId] = useState("");
  const [workspaceShareTeam, setWorkspaceShareTeam] = useState(null);
  const [workspaceShareTeamRole, setWorkspaceShareTeamRole] = useState("viewer");
  const [workspaceShareTeamBusy, setWorkspaceShareTeamBusy] = useState(false);
  const [workflowCollaborationOpenRequest, setWorkflowCollaborationOpenRequest] = useState(0);
  const [workflowAssistantOpenRequest, setWorkflowAssistantOpenRequest] = useState(0);
  const [workspaceConflict, setWorkspaceConflict] = useState(null);
  const [workspaceConflictOpen, setWorkspaceConflictOpen] = useState(false);
  const [workspaceConflictChoices, setWorkspaceConflictChoices] = useState({});
  const [workspaceConflictBusy, setWorkspaceConflictBusy] = useState(false);
  const [workspaceConflictError, setWorkspaceConflictError] = useState("");
  const [fileFilter, setFileFilter] = useState("");
  const [collapsedDirs, setCollapsedDirs] = useState(() => new Set());
  const [selectedWorkspaceFilePath, setSelectedWorkspaceFilePath] = useState("");
  const [provideFilePicker, setProvideFilePicker] = useState({ nodeId: "", query: "" });
  const [workspaceFileUploading, setWorkspaceFileUploading] = useState(false);
  const workspaceSidebarRef = useRef(null);
  const workspaceFileUploadInputRef = useRef(null);
  const workspaceFileUploadDirRef = useRef("");
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
  const [modelLists, setModelLists] = useState({ cursor: [], opencode: [], claudeCode: [], codex: [] });
  const [composerModel, setComposerModel] = useState("");
  const [skills, setSkills] = useState([]);
  const [skillsLoaded, setSkillsLoaded] = useState(false);
  const [selectedSkills, setSelectedSkills] = useState([]);
  const [skillCollections, setSkillCollections] = useState([]);
  const [skillCollectionsLoaded, setSkillCollectionsLoaded] = useState(false);
  const [mcpServers, setMcpServers] = useState([]);
  const [workspaceTargets, setWorkspaceTargets] = useState([]);
  const [workflowTapdId, setWorkflowTapdId] = useState(() => {
    try {
      const fromUrl = String(new URLSearchParams(window.location.search).get("tapdId") || "").trim();
      if (fromUrl) return fromUrl;
      return String(window.localStorage.getItem(`agentflow.workflow.tapdId:${flowParams.flowSource || "user"}:${flowParams.flowId || ""}`) || "").trim();
    } catch {
      return "";
    }
  });
  const [workflowSnapshot, setWorkflowSnapshot] = useState(null);
  const [workflowLoading, setWorkflowLoading] = useState(() => Boolean(workflowTapdId));
  const [workflowError, setWorkflowError] = useState("");
  const [workflowDeleteBusy, setWorkflowDeleteBusy] = useState(false);
  const [workflowActionRunning, setWorkflowActionRunning] = useState(false);
  const [workflowActionOutput, setWorkflowActionOutput] = useState("");
  const [workflowPendingConfirm, setWorkflowPendingConfirm] = useState(null);
  const [workflowReviewPublishing, setWorkflowReviewPublishing] = useState(false);
  const [workflowConflict, setWorkflowConflict] = useState(null);
  const [workflowProjectBindings, setWorkflowProjectBindings] = useState([]);
  const [workflowAvailableProjects, setWorkflowAvailableProjects] = useState([]);
  const [workflowProjectBindingOpen, setWorkflowProjectBindingOpen] = useState(false);
  const [workflowProjectBindingBusy, setWorkflowProjectBindingBusy] = useState(false);
  const [workflowProjectBindingError, setWorkflowProjectBindingError] = useState("");
  const [workflowProjectSelection, setWorkflowProjectSelection] = useState("");
  const [workflowProjectPendingMode, setWorkflowProjectPendingMode] = useState("workspace");

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

  const refreshNodeInternals = useCallback((nodeIds) => {
    const ids = Array.isArray(nodeIds) || nodeIds instanceof Set ? nodeIds : [nodeIds];
    for (const nodeId of ids) {
      const id = String(nodeId || "").trim();
      if (!id) continue;
      pendingNodeInternalsRefreshRef.current.add(id);
      retryNodeInternalsRefreshRef.current.add(id);
    }
    if (pendingNodeInternalsRefreshRef.current.size === 0) return;
    if (nodeInternalsRefreshFrameRef.current == null) {
      nodeInternalsRefreshFrameRef.current = window.requestAnimationFrame(() => {
        nodeInternalsRefreshFrameRef.current = null;
        const pending = Array.from(pendingNodeInternalsRefreshRef.current);
        pendingNodeInternalsRefreshRef.current.clear();
        pending.forEach((id) => updateNodeInternals(id));
      });
    }
    if (nodeInternalsRefreshTimerRef.current != null) {
      window.clearTimeout(nodeInternalsRefreshTimerRef.current);
    }
    nodeInternalsRefreshTimerRef.current = window.setTimeout(() => {
      nodeInternalsRefreshTimerRef.current = null;
      const pending = Array.from(retryNodeInternalsRefreshRef.current);
      retryNodeInternalsRefreshRef.current.clear();
      pending.forEach((id) => updateNodeInternals(id));
    }, 80);
  }, [updateNodeInternals]);

  useEffect(() => () => {
    if (nodeInternalsRefreshFrameRef.current != null) {
      window.cancelAnimationFrame(nodeInternalsRefreshFrameRef.current);
    }
    if (nodeInternalsRefreshTimerRef.current != null) {
      window.clearTimeout(nodeInternalsRefreshTimerRef.current);
    }
    pendingNodeInternalsRefreshRef.current.clear();
    retryNodeInternalsRefreshRef.current.clear();
  }, []);

  const ensureWorkspaceNodeDisplaySize = useCallback((nodeId, size) => {
    const id = String(nodeId || "").trim();
    const normalized = normalizeWorkspaceDisplaySize(size);
    if (!id || !normalized) return;
    setNodes((list) => list.map((node) => {
      if (node.id !== id) return node;
      const current = normalizeWorkspaceDisplaySize(node.data?.displaySize);
      const sameDataSize = current && current.width === normalized.width && current.height === normalized.height;
      const sameNodeSize = Math.round(Number(node.width || 0)) === normalized.width && Math.round(Number(node.height || 0)) === normalized.height;
      if (sameDataSize && sameNodeSize) return node;
      return {
        ...node,
        width: normalized.width,
        height: normalized.height,
        data: {
          ...node.data,
          nodeSize: normalized,
          displaySize: normalized,
        },
      };
    }));
    refreshNodeInternals(id);
  }, [refreshNodeInternals, setNodes]);

  useEffect(() => {
    try {
      window.localStorage.setItem("agentflow.workspace.filesPaneHeight", String(Math.round(workspaceFilesPaneHeight)));
    } catch {
      /* ignore storage */
    }
  }, [workspaceFilesPaneHeight]);

  const workspaceFilesPaneHeightFromPointer = useCallback((clientY) => {
    const sidebar = workspaceSidebarRef.current;
    if (!sidebar) return null;
    const rect = sidebar.getBoundingClientRect();
    const padding = 16;
    const minFiles = 150;
    const minPalette = 230;
    const contentTop = rect.top + padding;
    const contentBottom = rect.bottom - padding;
    const maxFiles = Math.max(minFiles, contentBottom - contentTop - minPalette);
    return Math.min(Math.max(clientY - contentTop, minFiles), maxFiles);
  }, []);

  const startWorkspaceSidebarResize = useCallback((event) => {
    event.preventDefault();
    event.stopPropagation();
    const sidebar = workspaceSidebarRef.current;
    if (!sidebar) return;
    let latestHeight = workspaceFilesPaneHeightFromPointer(event.clientY);
    if (!Number.isFinite(latestHeight)) return;
    setWorkspaceSidebarResizing(true);
    setWorkspaceFilesPaneHeight(latestHeight);
    const onPointerMove = (moveEvent) => {
      moveEvent.preventDefault();
      const nextHeight = workspaceFilesPaneHeightFromPointer(moveEvent.clientY);
      if (!Number.isFinite(nextHeight)) return;
      latestHeight = nextHeight;
      sidebar.style.setProperty("--af-work-files-pane-height", `${Math.round(nextHeight)}px`);
    };
    const onPointerUp = () => {
      setWorkspaceFilesPaneHeight(latestHeight);
      setWorkspaceSidebarResizing(false);
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerUp, true);
    };
    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerUp, true);
  }, [workspaceFilesPaneHeightFromPointer]);

  useEffect(() => () => {
    if (flowSnippetToastTimerRef.current) {
      window.clearTimeout(flowSnippetToastTimerRef.current);
    }
    if (conversationsSaveTimerRef.current) {
      window.clearTimeout(conversationsSaveTimerRef.current);
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
  const composerSidebarThreadRef = useRef(null);
  const composerActiveSessionTabRef = useRef(null);
  const [workspaceRunLogsTarget, setWorkspaceRunLogsTarget] = useState(null);
  const [composerMinimized, setComposerMinimized] = useState(true);
  const [activeNodeChatId, setActiveNodeChatId] = useState("");
  const [nodeChatSessions, setNodeChatSessions] = useState({});
  const [authUser, setAuthUser] = useState(null);
  const [authResolved, setAuthResolved] = useState(false);
  const workspaceSidebarStorageKey = useMemo(() => (
    authResolved ? workspaceSidebarCollapsedStorageKey(authUser) : ""
  ), [authResolved, authUser]);
  const [workspaceSidebarCollapsed, setWorkspaceSidebarCollapsed] = useState(true);
  useEffect(() => {
    if (!workspaceSidebarStorageKey) return;
    setWorkspaceSidebarCollapsed(readWorkspaceSidebarCollapsed(workspaceSidebarStorageKey));
  }, [workspaceSidebarStorageKey]);
  useEffect(() => {
    if (!workspaceSidebarStorageKey) return;
    try {
      window.localStorage.setItem(workspaceSidebarStorageKey, workspaceSidebarCollapsed ? "true" : "false");
    } catch {
      /* ignore storage */
    }
  }, [workspaceSidebarCollapsed, workspaceSidebarStorageKey]);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [jumpPaletteOpen, setJumpPaletteOpen] = useState(false);
  const [canvasTool, setCanvasTool] = useState("pan");
  const [runningRunSessions, setRunningRunSessions] = useState({});
  const runningRunSessionsRef = useRef({});
  const [scheduledRunState, setScheduledRunState] = useState({});
  const workspaceRunAbortRefs = useRef(new Map());
  const workspaceRunStoppedRef = useRef(new Set());
  const [workspaceExecutingNodes, setWorkspaceExecutingNodes] = useState(() => new Set());
  const [workspaceNodeRunStatus, setWorkspaceNodeRunStatus] = useState({});
  const [optimizingRunNodeId, setOptimizingRunNodeId] = useState("");
  const [status, setStatus] = useState("");
  const [workspaceSyncPhase, setWorkspaceSyncPhase] = useState("loading");
  const [workspaceSyncDetail, setWorkspaceSyncDetail] = useState("正在载入 Project");
  const [workspaceNodeInteractionUiActive, setWorkspaceNodeInteractionUiActive] = useState(false);
  const skillsStorageKey = useMemo(() => workspaceSkillsStorageKey(flowParams), [flowParams]);
  const [skillsStorageReadyKey, setSkillsStorageReadyKey] = useState("");
  const flowSource = flowParams.flowSource || "user";
  const runningRunNodeIds = useMemo(() => new Set(
    Object.values(runningRunSessions || {})
      .map((session) => String(session?.runNodeId || "").trim())
      .filter(Boolean),
  ), [runningRunSessions]);
  const setRunningRunSessionsSynced = useCallback((updater) => {
    const current = runningRunSessionsRef.current || {};
    const next = typeof updater === "function" ? updater(current) : updater;
    const normalized = next && typeof next === "object" && !Array.isArray(next) ? next : {};
    runningRunSessionsRef.current = normalized;
    setRunningRunSessions(normalized);
    return normalized;
  }, []);
  const canManageCurrentFlow = Boolean(
    flowParams.flowId &&
    !flowParams.adminOwnerId &&
    !flowParams.archived &&
    (
      workspaceCollaboration?.role
        ? workspaceCollaboration.role === "owner"
        : flowSource === "user" || flowSource === "workspace"
    ),
  );
  const canLeaveSharedFlow = Boolean(
    !flowParams.adminOwnerId
    &&
    flowSource === "workspace"
    && workspaceCollaboration?.role
    && workspaceCollaboration.role !== "owner"
  );
  const workspaceSyncIndicator = workspaceSyncIndicatorPresentation({
    phase: workspaceSyncPhase,
    detail: workspaceSyncDetail,
    nodeInteracting: workspaceNodeInteractionUiActive,
  });
  const markWorkspaceDirty = useCallback(() => {
    if (!loadedRef.current || !workspaceWritable) return;
    skipNextWorkspaceAutosaveRef.current = false;
    workspaceEditVersionRef.current += 1;
    workspaceDirtyRef.current = true;
    setWorkspaceSyncPhase("dirty");
    setWorkspaceSyncDetail("本地修改等待同步");
  }, [workspaceWritable]);
  useEffect(() => {
    if (!flowParams.flowId) return;
    recordPipelineView(flowParams.flowId, flowParams.flowSource || "user", "workspace", Boolean(flowParams.archived));
  }, [flowParams]);

  useEffect(() => {
    const syncWorkspaceModeFromUrl = () => {
      const view = new URLSearchParams(window.location.search).get("view");
      setWorkspaceMode(view === "display" || view === "workflow" ? view : "workspace");
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

  const performSaveGraph = useCallback(async (nextNodes, nextEdges, saveEditVersion) => {
    if (!loadedRef.current) return;
    if (!workspaceWritable) {
      setStatus("Readonly workspace");
      setWorkspaceSyncPhase("readonly");
      setWorkspaceSyncDetail("只读 Project");
      throw new Error("Readonly workspace");
    }
    setWorkspaceSyncPhase("saving");
    setWorkspaceSyncDetail("正在同步修改");
    const graph = flowToGraph(nextNodes, nextEdges, instancesRef.current);
    graph.ui = {
      ...(graph.ui || {}),
      displayPage: displayPageForGraph(displayPageRef.current, nextNodes),
    };
    const res = await fetch("/api/workspace/graph", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...flowParams,
        graph,
        baseRevision: workspaceRevisionRef.current,
        baseGraph: workspaceBaseGraphRef.current,
        clientId: collaborationClientIdRef.current,
      }),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 409 || res.status === 428) {
        const conflictItems = Array.isArray(json.conflictItems) ? json.conflictItems : [];
        setWorkspaceConflict({
          currentRevision: String(json.currentRevision || ""),
          message: json.error || "Workspace 已被其他成员更新",
          conflictPaths: Array.isArray(json.conflictPaths) ? json.conflictPaths : [],
          conflictItems,
          mergeGraph: json.mergeGraph || null,
          currentGraph: json.currentGraph || null,
        });
        setWorkspaceConflictChoices(Object.fromEntries(conflictItems.map((item, index) => [
          String(index),
          { mode: "local", manual: workspaceConflictManualText(item) },
        ])));
        setWorkspaceConflictError("");
        setWorkspaceConflictOpen(conflictItems.length > 0);
        setWorkspaceSyncPhase("conflict");
        setWorkspaceSyncDetail(json.error || "存在需要处理的字段冲突");
        const conflictPaths = Array.isArray(json.conflictPaths) ? json.conflictPaths : [];
        const conflictMessage = conflictPaths.length
          ? `${json.error || "Workspace 已被其他成员更新"}：${conflictPaths.join("、")}`
          : json.error || "Workspace 已被其他成员更新";
        const conflictError = new Error(conflictMessage);
        conflictError.code = "WORKSPACE_REVISION_CONFLICT";
        conflictError.currentRevision = json.currentRevision || "";
        throw conflictError;
      }
      const saveError = new Error(json.error || "保存 workspace graph 失败");
      setWorkspaceSyncPhase("error");
      setWorkspaceSyncDetail(saveError.message);
      throw saveError;
    }
    const hasNewerLocalEdits = workspaceEditVersionRef.current !== saveEditVersion;
    const savedBaseline = workspaceSaveBaselineAfterSuccess({
      savedGraph: json.graph,
      sentGraph: graph,
      savedRevision: json.revision,
      currentRevision: workspaceRevisionRef.current,
    });
    workspaceRevisionRef.current = savedBaseline.revision;
    workspaceBaseGraphRef.current = savedBaseline.graph;
    if (!hasNewerLocalEdits) {
      instancesRef.current = json.graph?.instances || graph.instances;
      setInstances(instancesRef.current);
      if (json.merged && json.graph) {
        const mergedFlow = graphToFlow(json.graph, palette);
        const mergedDisplayPage = normalizeDisplayPageState(json.graph?.ui?.displayPage, mergedFlow.nodes);
        instancesRef.current = mergedFlow.instances;
        setInstances(mergedFlow.instances);
        setNodes(mergedFlow.nodes);
        setEdges(mergedFlow.edges);
        displayPageRef.current = mergedDisplayPage;
        setDisplayPage(mergedDisplayPage);
      }
      workspaceDirtyRef.current = false;
    }
    setScheduledRunState(scheduledRunStateFromServer(json.workspaceSchedules || []));
    setWorkspaceConflict(null);
    setWorkspaceConflictOpen(false);
    setWorkspaceSyncPhase(hasNewerLocalEdits ? "dirty" : "synced");
    setWorkspaceSyncDetail(hasNewerLocalEdits ? "本地仍有修改等待同步" : "所有修改已同步");
    setStatus(
      hasNewerLocalEdits
        ? "已保存上一版，本地新修改正在排队"
        : json.merged ? "Workspace graph merged and saved" : "Workspace graph saved",
    );
    return json;
  }, [flowParams, palette, setEdges, setNodes, workspaceWritable]);

  const saveGraph = useCallback((nextNodes = nodes, nextEdges = edges) => {
    const queue = workspaceSaveQueueRef.current;
    const request = {
      nextNodes,
      nextEdges,
      saveEditVersion: workspaceEditVersionRef.current,
      waiters: [],
    };
    const resultPromise = new Promise((resolve, reject) => {
      request.waiters.push({ resolve, reject });
    });

    if (queue.running) {
      queue.pending = coalesceWorkspaceSaveRequest(queue.pending, request);
      return resultPromise;
    }

    queue.running = true;
    const drainQueue = async () => {
      let current = request;
      while (current) {
        if (queue.pending) {
          current = coalesceWorkspaceSaveRequest(current, queue.pending);
          queue.pending = null;
        }
        try {
          const result = await performSaveGraph(
            current.nextNodes,
            current.nextEdges,
            current.saveEditVersion,
          );
          current.waiters.forEach(({ resolve }) => resolve(result));
        } catch (error) {
          if (error?.code !== "WORKSPACE_REVISION_CONFLICT") {
            setWorkspaceSyncPhase("error");
            setWorkspaceSyncDetail(String(error.message || error));
          }
          current.waiters.forEach(({ reject }) => reject(error));
          if (error?.code === "WORKSPACE_REVISION_CONFLICT" && queue.pending) {
            queue.pending.waiters.forEach(({ reject }) => reject(error));
            queue.pending = null;
          }
        }
        current = queue.pending;
        queue.pending = null;
      }
      queue.running = false;
    };

    const queuedSave = workspaceSaveChainRef.current
      .catch(() => undefined)
      .then(drainQueue);
    workspaceSaveChainRef.current = queuedSave;
    return resultPromise;
  }, [edges, nodes, performSaveGraph]);

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

  const loadWorkspace = useCallback(async (options = {}) => {
    const background = options?.background === true;
    const requestId = workspaceLoadRequestRef.current + 1;
    workspaceLoadRequestRef.current = requestId;
    const startedEditVersion = workspaceEditVersionRef.current;
    const startedRevision = workspaceRevisionRef.current;
    if (!background) loadedRef.current = false;
    const resources = workspaceLoadResourcePlan({ background });
    const q = flowParamsQuery(flowParams);
    let nodesJson = null;
    let graphRes;
    if (!resources.nodes && !resources.files) {
      graphRes = await fetch(`/api/workspace/graph?${q.toString()}`);
    } else {
      const nodeQ = flowParamsQuery(flowParams);
      nodeQ.set("lang", String(i18n.language || "zh").startsWith("zh") ? "zh" : "en");
      const [nodesRes, nextGraphRes] = await Promise.all([
        fetch(`/api/nodes?${nodeQ.toString()}`),
        fetch(`/api/workspace/graph?${q.toString()}`),
        loadFiles(),
      ]);
      nodesJson = await nodesRes.json();
      if (!nodesRes.ok) throw new Error(nodesJson.error || "读取节点定义失败");
      graphRes = nextGraphRes;
    }
    const graphJson = await graphRes.json();
    if (!graphRes.ok) throw new Error(graphJson.error || "读取 workspace graph 失败");
    const skipReason = workspaceBackgroundLoadSkipReason({
      background,
      requestId,
      currentRequestId: workspaceLoadRequestRef.current,
      dirty: workspaceDirtyRef.current,
      startedEditVersion,
      currentEditVersion: workspaceEditVersionRef.current,
      startedRevision,
      currentRevision: workspaceRevisionRef.current,
    });
    if (skipReason === "superseded") {
      return { skipped: true, reason: skipReason };
    }
    if (skipReason === "local-edits") {
      setStatus("检测到远端更新；本地修改将在保存时自动合并");
      return { skipped: true, reason: skipReason };
    }
    const paletteList = background
      ? paletteRef.current
      : [
          // 节点定义单一来源：builtin/nodes/*.md（面板可见性由 frontmatter 的 palette: hidden 决定）
          ...(Array.isArray(nodesJson) ? nodesJson : nodesJson.nodes || []),
        ];
    if (!background) {
      paletteRef.current = paletteList;
      setPalette(paletteList);
    }
    const graph = graphJson.graph || JSON.parse(localStorage.getItem(STORAGE_FALLBACK_KEY) || "null") || {};
    const flow = graphToFlow(graph, paletteList);
    const nextDisplayPage = normalizeDisplayPageState(graph?.ui?.displayPage, flow.nodes);
    const shouldInitializeWorkspaceViewport = !workspaceViewportInitializedRef.current;
    let nextWorkspaceViewport = workspaceViewportRef.current;
    if (shouldInitializeWorkspaceViewport) {
      let savedWorkspaceViewport = null;
      try {
        savedWorkspaceViewport = JSON.parse(window.localStorage.getItem(workspaceViewportStorageKey) || "null");
      } catch {
        savedWorkspaceViewport = null;
      }
      nextWorkspaceViewport = normalizeCanvasViewport(savedWorkspaceViewport)
        || normalizeCanvasViewport(graph?.ui?.viewport);
    }
    const delta = background
      ? diffWorkspaceGraphsForUi(workspaceBaseGraphRef.current, graph)
      : null;
    if (background && delta?.safe) {
      const nextNodes = delta.nodesChanged
        ? reconcileWorkspaceNodes(nodesRef.current, flow.nodes, delta.changedNodeIds)
        : nodesRef.current;
      const nextEdges = delta.edgesChanged
        ? reconcileWorkspaceEdges(edgesRef.current, flow.edges)
        : edgesRef.current;
      const displayPageChanged = delta.displayPageChanged
        || !workspaceValueEqual(displayPageRef.current, nextDisplayPage);
      const graphStateChanged = delta.nodesChanged || delta.edgesChanged || displayPageChanged;
      if (graphStateChanged) skipNextWorkspaceAutosaveRef.current = true;
      if (delta.nodesChanged) {
        const nextInstances = reconcileWorkspaceInstances(
          instancesRef.current,
          flow.instances,
          delta.changedNodeIds,
        );
        instancesRef.current = nextInstances;
        nodesRef.current = nextNodes;
        setInstances(nextInstances);
        setNodes(nextNodes);
      }
      if (delta.edgesChanged) {
        edgesRef.current = nextEdges;
        setEdges(nextEdges);
      }
      if (displayPageChanged) {
        displayPageRef.current = nextDisplayPage;
        setDisplayPage(nextDisplayPage);
      }
      if (graphStateChanged) {
        resetCanvasHistory(nextNodes, nextEdges, {
          instances: delta.nodesChanged ? instancesRef.current : flow.instances,
        });
      }
      if (delta.nodesChanged || displayPageChanged) {
        const validDisplayNodeIds = new Set(nextDisplayPage.nodeIds);
        setSelectedDisplayNodeIds((current) => {
          const filtered = current.filter((id) => validDisplayNodeIds.has(id));
          return filtered.length === current.length ? current : filtered;
        });
      }
    } else {
      instancesRef.current = flow.instances;
      nodesRef.current = flow.nodes;
      edgesRef.current = flow.edges;
      displayPageRef.current = nextDisplayPage;
      skipNextWorkspaceAutosaveRef.current = true;
      setInstances(flow.instances);
      setNodes(flow.nodes);
      setEdges(flow.edges);
      setDisplayPage(nextDisplayPage);
      setSelectedDisplayNodeIds([]);
      resetCanvasHistory(flow.nodes, flow.edges, { instances: flow.instances });
    }
    const nextScheduledRunState = scheduledRunStateFromServer(graphJson.workspaceSchedules || []);
    setScheduledRunState((current) => (
      workspaceValueEqual(current, nextScheduledRunState) ? current : nextScheduledRunState
    ));
    workspaceRevisionRef.current = String(graphJson.revision || "");
    workspaceBaseGraphRef.current = graph;
    workspaceDirtyRef.current = false;
    const nextCollaboration = graphJson.collaboration || null;
    setWorkspaceCollaboration((current) => (
      workspaceValueEqual(current, nextCollaboration) ? current : nextCollaboration
    ));
    setAdminReview(graphJson.adminReview || null);
    setWorkspaceConflict(null);
    if (shouldInitializeWorkspaceViewport) {
      setWorkspaceViewport(nextWorkspaceViewport);
      workspaceViewportRef.current = nextWorkspaceViewport;
      workspaceViewportInitializedRef.current = true;
    }
    const writable = graphJson.writable !== false;
    setWorkspaceWritable(writable);
    setStatus(writable ? "Workspace ready" : "Readonly workspace");
    setWorkspaceSyncPhase(writable ? "synced" : "readonly");
    setWorkspaceSyncDetail(
      writable
        ? "所有修改已同步"
        : graphJson.adminReview
          ? `管理员只读查看：${graphJson.adminReview.ownerUsername || graphJson.adminReview.ownerUserId || "其他用户"}`
          : "只读 Project",
    );
    loadedRef.current = true;
    return { skipped: false };
  }, [flowParams, i18n.language, loadFiles, resetCanvasHistory, setEdges, setNodes, workspaceViewportStorageKey]);

  const scheduleWorkspaceRemoteRefresh = useCallback((event = {}) => {
    if (!loadedRef.current) return;
    const revision = String(event.revision || "");
    const isGraphCommit = event.type === "graph.committed";
    const refreshPending = Boolean(
      workspaceRemoteRefreshTimerRef.current
      || workspaceRemoteRefreshInFlightRef.current
      || workspaceRemoteRefreshQueuedRef.current
    );
    if (shouldSkipWorkspaceRemoteRefresh({
      eventType: event.type,
      revision,
      currentRevision: workspaceRevisionRef.current,
      targetRevision: workspaceRemoteRefreshTargetRevisionRef.current,
      refreshPending,
    })) {
      return;
    }
    if (isGraphCommit && revision) {
      workspaceRemoteRefreshTargetRevisionRef.current = revision;
    }
    if (workspaceDirtyRef.current) {
      workspaceRemoteRefreshQueuedRef.current = false;
      setStatus("检测到其他成员的更新；保存时将自动合并");
      return;
    }

    workspaceRemoteRefreshQueuedRef.current = true;
    if (workspaceRemoteRefreshTimerRef.current || workspaceRemoteRefreshInFlightRef.current) return;

    const runRefresh = async () => {
      workspaceRemoteRefreshTimerRef.current = null;
      if (workspaceCanvasIsInteracting()) {
        workspaceRemoteRefreshQueuedRef.current = true;
        return;
      }
      if (workspaceDirtyRef.current) {
        workspaceRemoteRefreshQueuedRef.current = false;
        setStatus("检测到其他成员的更新；保存时将自动合并");
        return;
      }
      workspaceRemoteRefreshQueuedRef.current = false;
      workspaceRemoteRefreshInFlightRef.current = true;
      try {
        await loadWorkspace({ background: true });
        workspaceRemoteRefreshTargetRevisionRef.current = workspaceRevisionRef.current;
      } catch (error) {
        workspaceRemoteRefreshTargetRevisionRef.current = "";
        setStatus(String(error.message || error));
      } finally {
        workspaceRemoteRefreshInFlightRef.current = false;
        if (workspaceRemoteRefreshQueuedRef.current && !workspaceDirtyRef.current) {
          workspaceRemoteRefreshTimerRef.current = window.setTimeout(runRefresh, 40);
        }
      }
    };

    workspaceRemoteRefreshTimerRef.current = window.setTimeout(runRefresh, 40);
  }, [loadWorkspace, workspaceCanvasIsInteracting]);

  const loadPrdWorkflowSnapshot = useCallback(async (tapdIdOverride = workflowTapdId) => {
    const tapdId = String(tapdIdOverride || "").trim();
    setWorkflowLoading(true);
    setWorkflowError("");
    try {
      if (flowParams.workflowDemo) {
        const demoSnapshot = readWorkflowDemoSnapshot(tapdId);
        if (!demoSnapshot) throw new Error("本地示例数据已失效，请返回迭代页重新载入示例");
        setWorkflowSnapshot(demoSnapshot);
        setWorkflowActionOutput("");
        setWorkflowPendingConfirm(null);
        setWorkflowConflict(null);
        return;
      }
      const q = flowParamsQuery(flowParams);
      q.set("tapdId", tapdId);
      q.set("runtimeOnly", "1");
      if (authUser?.isAdmin === true && !flowParams.workflowShare) {
        q.set("adminOperation", "repair-version-membership");
      }
      const res = await fetch(`/api/prd-workflow/snapshot?${q.toString()}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "读取 PRD Workflow 失败");
      setWorkflowSnapshot(data.snapshot || null);
      setWorkflowActionOutput("");
      setWorkflowPendingConfirm(null);
      setWorkflowConflict(null);
      try {
        const key = `agentflow.workflow.tapdId:${flowParams.flowSource || "user"}:${flowParams.flowId || ""}`;
        if (tapdId) window.localStorage.setItem(key, tapdId);
        else window.localStorage.removeItem(key);
      } catch {
        /* ignore storage */
      }
    } catch (e) {
      setWorkflowError(String(e.message || e));
    } finally {
      setWorkflowLoading(false);
    }
  }, [authUser, flowParams, workflowTapdId]);

  const deleteWorkflowAsAdmin = useCallback(async () => {
    const id = String(workflowTapdId || "").trim();
    if (!id || authUser?.isAdmin !== true || workflowDeleteBusy) return;
    if (!window.confirm(`确认清理测试 Workflow TAPD ${id}？此操作会移除协作记录和运行快照，无法恢复。`)) return;
    setWorkflowDeleteBusy(true);
    setWorkflowError("");
    try {
      const response = await fetch("/api/workflows/admin/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tapdId: id }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "清理 Workflow 失败");
      navigate(flowParams.returnTo || "/workflows");
    } catch (error) {
      setWorkflowError(String(error.message || error));
    } finally {
      setWorkflowDeleteBusy(false);
    }
  }, [authUser, flowParams.returnTo, navigate, workflowDeleteBusy, workflowTapdId]);

  const loadWorkflowProjectBindings = useCallback(async () => {
    const tapdId = String(workflowTapdId || "").trim();
    if (!tapdId || flowParams.workflowShare || flowParams.workflowDemo) {
      setWorkflowProjectBindings([]);
      setWorkflowAvailableProjects([]);
      return;
    }
    const response = await fetch(`/api/workflows/project-bindings?tapdId=${encodeURIComponent(tapdId)}`);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "读取 Project 绑定失败");
    const bindings = Array.isArray(payload.bindings) ? payload.bindings : [];
    const available = Array.isArray(payload.availableProjects) ? payload.availableProjects : [];
    setWorkflowProjectBindings(bindings);
    setWorkflowAvailableProjects(available);
    setWorkflowProjectSelection((current) => (
      available.some((project) => workflowProjectBindingKey(project) === current)
        ? current
        : available[0] ? workflowProjectBindingKey(available[0]) : ""
    ));
  }, [flowParams.workflowDemo, flowParams.workflowShare, workflowTapdId]);

  const bindWorkflowProject = useCallback(async () => {
    const project = workflowAvailableProjects.find((item) => (
      workflowProjectBindingKey(item) === workflowProjectSelection
    ));
    if (!project || !workflowTapdId || workflowProjectBindingBusy) return;
    setWorkflowProjectBindingBusy(true);
    setWorkflowProjectBindingError("");
    try {
      const response = await fetch("/api/workflows/project-bindings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tapdId: workflowTapdId, ...project }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "绑定 Project 失败");
      const available = Array.isArray(payload.availableProjects) ? payload.availableProjects : [];
      setWorkflowProjectBindings(Array.isArray(payload.bindings) ? payload.bindings : []);
      setWorkflowAvailableProjects(available);
      setWorkflowProjectSelection(available[0] ? workflowProjectBindingKey(available[0]) : "");
    } catch (bindingError) {
      setWorkflowProjectBindingError(String(bindingError.message || bindingError));
    } finally {
      setWorkflowProjectBindingBusy(false);
    }
  }, [workflowAvailableProjects, workflowProjectBindingBusy, workflowProjectSelection, workflowTapdId]);

  const unbindWorkflowProject = useCallback(async (project) => {
    if (!project?.workspaceId || !workflowTapdId || workflowProjectBindingBusy) return;
    setWorkflowProjectBindingBusy(true);
    setWorkflowProjectBindingError("");
    try {
      const response = await fetch("/api/workflows/project-bindings", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tapdId: workflowTapdId, workspaceId: project.workspaceId }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "解除 Project 绑定失败");
      const available = Array.isArray(payload.availableProjects) ? payload.availableProjects : [];
      setWorkflowProjectBindings(Array.isArray(payload.bindings) ? payload.bindings : []);
      setWorkflowAvailableProjects(available);
      setWorkflowProjectSelection((current) => (
        available.some((item) => workflowProjectBindingKey(item) === current)
          ? current
          : available[0] ? workflowProjectBindingKey(available[0]) : ""
      ));
    } catch (bindingError) {
      setWorkflowProjectBindingError(String(bindingError.message || bindingError));
    } finally {
      setWorkflowProjectBindingBusy(false);
    }
  }, [workflowProjectBindingBusy, workflowTapdId]);

  const runPrdWorkflowAction = useCallback(async (actionOverride = null, options = {}) => {
    const targetAction = actionOverride && typeof actionOverride === "object" ? actionOverride : workflowSnapshot?.nextAction;
    const action = prdWorkflowActionId(targetAction);
    if (!action || workflowActionRunning) return;
    const confirm = options?.confirm === true;
    const expectedRevision = String(options?.expectedRevision || workflowSnapshot?.revision || "");
    setWorkflowActionRunning(true);
    setWorkflowError("");
    if (!confirm) {
      setWorkflowActionOutput("");
      setWorkflowPendingConfirm(null);
      setWorkflowConflict(null);
    }
    try {
      const res = await fetch("/api/prd-workflow/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...flowParams,
          tapdId: workflowTapdId,
          action,
          stage: prdWorkflowStageKey(targetAction),
          title: prdWorkflowActionTitle(targetAction, 0),
          ...prdWorkflowActionPayloadExtras(targetAction),
          dryRun: !confirm,
          confirm,
          issueKey: targetAction.issueKey || targetAction.issue_key || "",
          expectedRevision,
          idempotencyKey: `workflow-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) {
        if (data.snapshot) setWorkflowSnapshot(data.snapshot);
        if (data.conflict) setWorkflowConflict({ ...data.conflict, action: targetAction });
        throw new Error(data.error || "执行 PRD Workflow action 失败");
      }
      setWorkflowActionOutput(data.rawOutput || (data.output ? JSON.stringify(data.output, null, 2) : ""));
      setWorkflowSnapshot(data.snapshot || workflowSnapshot);
      setWorkflowConflict(null);
      if (confirm) setWorkflowPendingConfirm(null);
      else setWorkflowPendingConfirm({ action: targetAction, output: data.output || null, expectedRevision, at: new Date().toISOString() });
    } catch (e) {
      setWorkflowError(String(e.message || e));
    } finally {
      setWorkflowActionRunning(false);
    }
  }, [flowParams, workflowActionRunning, workflowSnapshot, workflowTapdId]);

  const runPrdWorkflowDryRun = useCallback((actionOverride = null) => (
    runPrdWorkflowAction(actionOverride, { confirm: false })
  ), [runPrdWorkflowAction]);

  const confirmPrdWorkflowAction = useCallback(() => {
    const target = workflowPendingConfirm?.action || workflowSnapshot?.nextAction;
    return runPrdWorkflowAction(target, { confirm: true, expectedRevision: workflowPendingConfirm?.expectedRevision || "" });
  }, [runPrdWorkflowAction, workflowPendingConfirm, workflowSnapshot]);

  const retryPrdWorkflowConflict = useCallback(() => {
    const target = workflowConflict?.action || workflowSnapshot?.nextAction;
    setWorkflowConflict(null);
    return runPrdWorkflowAction(target, { confirm: false });
  }, [runPrdWorkflowAction, workflowConflict, workflowSnapshot]);

  const publishPrdWorkflowReviewLink = useCallback(async () => {
    const content = String(workflowActionOutput || workflowSnapshot?.rawOutput || "").trim();
    if (!content || workflowReviewPublishing) return;
    const targetAction = workflowPendingConfirm?.action || workflowSnapshot?.nextAction || {};
    const title = `Review: ${prdWorkflowActionTitle(targetAction, 0) || workflowSnapshot?.pointer || workflowTapdId || "PRD Workflow"}`;
    const looksJson = /^[\[{]/.test(content);
    const markdown = content.startsWith("#")
      ? content
      : `# ${title}\n\n${looksJson ? `\`\`\`json\n${content}\n\`\`\`` : content}`;
    setWorkflowReviewPublishing(true);
    setWorkflowError("");
    try {
      const res = await fetch("/api/workflow-artifacts/publish", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...flowParams,
          workflow: { namespace: "tapd", id: workflowTapdId },
          title,
          markdown,
          action: prdWorkflowActionId(targetAction),
          stage: prdWorkflowStageKey(targetAction),
          issueKey: targetAction.issueKey || targetAction.issue_key || "",
          artifactLabel: "临时 Review",
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.ok === false) throw new Error(data.error || "生成 Review 链接失败");
      setWorkflowSnapshot(data.snapshot || workflowSnapshot);
      const reviewUrl = data.review?.shortUrl || data.review?.url || "";
      if (reviewUrl) setWorkflowActionOutput((prev) => `${prev || content}\n\nReview link: ${reviewUrl}`);
    } catch (e) {
      setWorkflowError(String(e.message || e));
    } finally {
      setWorkflowReviewPublishing(false);
    }
  }, [flowParams, workflowActionOutput, workflowPendingConfirm, workflowReviewPublishing, workflowSnapshot, workflowTapdId]);

  const publishNodeToMarketplace = useCallback(
    async (draft, definitionId) => {
      const payload = {
        packageId: draft?.newId || draft?.id || draft?.label,
        label: draft?.label || draft?.newId || draft?.id,
        version: "1.0.0",
        definitionId,
        body: draft?.body || "",
        script: draft?.script || "",
        scriptRef: draft?.scriptRef || "",
        implementationRef: draft?.implementationRef || "",
        implementationMode: draft?.implementationMode || "",
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

  const latestComposerSessionId = useCallback((sessions = composerRunSessions) => {
    const list = Array.isArray(sessions) ? sessions : [];
    const running = [...list].reverse().find((session) => session?.status === "running" || session?.status === "stopping");
    const latest = running || [...list].reverse().find((session) => session?.id);
    return String(latest?.id || "workspace");
  }, [composerRunSessions]);

  const closeComposerRunSession = useCallback((sessionId) => {
    const id = String(sessionId || "").trim();
    if (!id || id === "workspace") return;
    setComposerRunSessions((list) => {
      const next = (Array.isArray(list) ? list : []).filter((session) => session.id !== id);
      setActiveComposerSessionId((current) => (
        current === id ? latestComposerSessionId(next) : current
      ));
      return next;
    });
  }, [latestComposerSessionId]);

  const openComposerLogPanel = useCallback((sessionId = "") => {
    setComposerSidebarOpen(true);
    setWorkspaceRunLogsTarget(null);
    setNodePropDraft(null);
    setActiveComposerSessionId(sessionId || latestComposerSessionId());
  }, [latestComposerSessionId]);

  const openWorkspaceRunLogs = useCallback((target = {}) => {
    setWorkspaceRunLogsTarget({
      scheduleNodeId: String(target.scheduleNodeId || ""),
      runNodeId: String(target.runNodeId || target.nodeId || ""),
      lastRunId: String(target.lastRunId || ""),
      label: String(target.label || ""),
    });
    setComposerSidebarOpen(false);
    setNodePropDraft(null);
    setSelectedNodeId("");
  }, []);

  const optimizeWorkspaceRun = useCallback(async (targetRunNodeId = "") => {
    const runNodeId = String(targetRunNodeId || "").trim();
    if (!runNodeId || !workspaceWritable) return;
    setOptimizingRunNodeId(runNodeId);
    setStatus(`Optimizing run: ${runNodeId}`);
    try {
      await saveGraph(nodesRef.current, edgesRef.current);
      const graph = flowToGraph(nodesRef.current, edgesRef.current, instancesRef.current);
      const effectiveModel = workspaceRunNodeModel(nodesRef.current, instancesRef.current, runNodeId, composerModel);
      const res = await fetch("/api/workspace/run/optimize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...flowParams,
          runNodeId,
          graph,
          model: effectiveModel,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.ok === false) throw new Error(json.error || "优化失败");
      const nextGraph = json.graph || graph;
      const flow = graphToFlow(nextGraph, palette);
      instancesRef.current = flow.instances;
      setInstances(flow.instances);
      setNodes(flow.nodes);
      setEdges(flow.edges);
      setScheduledRunState(scheduledRunStateFromServer(json.workspaceSchedules || []));
      resetCanvasHistory(flow.nodes, flow.edges, { instances: flow.instances });
      const count = Array.isArray(json.optimized) ? json.optimized.length : 0;
      setStatus(count > 0 ? `已生成 ${count} 个 implementation` : "没有需要优化的节点");
    } catch (e) {
      setStatus(String(e.message || e));
    } finally {
      setOptimizingRunNodeId("");
    }
  }, [composerModel, edgesRef, flowParams, nodesRef, palette, resetCanvasHistory, saveGraph, setEdges, setNodes, workspaceWritable]);

  const stopWorkspaceRun = useCallback(async (runNodeIdOrSessionId = "") => {
    const requestedId = String(runNodeIdOrSessionId || "").trim();
    const sessions = runningRunSessionsRef.current || {};
    const match = Object.entries(sessions).find(([sessionId, session]) => (
      sessionId === requestedId || String(session?.runNodeId || "") === requestedId
    )) || Object.entries(sessions)[0] || null;
    const sessionId = match?.[0] || "";
    const session = match?.[1] || null;
    const runNodeId = String(session?.runNodeId || requestedId || "").trim();
    if (session?.status === "stopping") return;
    const affectedIds = new Set([
      runNodeId,
      ...(Array.isArray(session?.plannedNodeIds) ? session.plannedNodeIds : []),
    ].map((id) => String(id || "").trim()).filter(Boolean));
    if (sessionId) {
      setRunningRunSessionsSynced((current) => {
        const next = { ...current };
        if (next[sessionId]) next[sessionId] = { ...next[sessionId], status: "stopping" };
        return next;
      });
    }
    setStatus(runNodeId ? `Stopping Workspace run: ${runNodeId}...` : "Stopping Workspace run...");
    setComposerRunSessions((list) => list.map((item) => (
      (sessionId ? item.id === sessionId : (!runNodeId || item.runNodeId === runNodeId)) && item.status === "running"
        ? {
            ...item,
            status: "stopping",
          }
        : item
    )));
    try {
      const res = await fetch("/api/workspace/run/stop", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...flowParams, runId: sessionId, runNodeId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json?.stopped !== true) {
        throw new Error(json.error || "Workspace run stop failed");
      }

      const abortController = sessionId ? workspaceRunAbortRefs.current.get(sessionId) : null;
      if (abortController) {
        abortController.abort();
        workspaceRunAbortRefs.current.delete(sessionId);
      }
      if (sessionId) {
        setRunningRunSessionsSynced((current) => {
          const next = { ...current };
          delete next[sessionId];
          return next;
        });
      }
      setWorkspaceExecutingNodes((current) => {
        const next = new Set(current);
        for (const id of affectedIds) next.delete(id);
        return next;
      });
      setWorkspaceNodeRunStatus((current) => {
        const next = { ...current };
        for (const id of affectedIds) {
          if (!id) continue;
          if (!next[id] || ["running", "waiting"].includes(next[id]?.status)) next[id] = { ...next[id], status: "stopped" };
        }
        return next;
      });
      setStatus(runNodeId ? `Workspace run stopped: ${runNodeId}` : "Workspace run stopped");
      setComposerRunSessions((list) => list.map((item) => (
        (sessionId ? item.id === sessionId : (!runNodeId || item.runNodeId === runNodeId))
          ? {
              ...item,
              status: "stopped",
              endedAt: Date.now(),
              messages: [
                ...(Array.isArray(item.messages) ? item.messages : []),
                { role: "assistant", kind: "status", text: "Workspace run stopped.", at: Date.now() },
              ].slice(-160),
            }
          : item
      )));
    } catch (error) {
      if (sessionId) {
        setRunningRunSessionsSynced((current) => {
          const next = { ...current };
          if (next[sessionId]) next[sessionId] = { ...next[sessionId], status: "running" };
          return next;
        });
      }
      const message = String(error?.message || error || "Workspace run stop failed");
      setStatus(`停止失败：${message}`);
      setComposerRunSessions((list) => list.map((item) => (
        (sessionId ? item.id === sessionId : (!runNodeId || item.runNodeId === runNodeId))
          ? {
              ...item,
              status: "running",
              messages: [
                ...(Array.isArray(item.messages) ? item.messages : []),
                { role: "assistant", kind: "error", error: true, text: `停止失败：${message}`, at: Date.now() },
              ].slice(-160),
            }
          : item
      )));
    }
  }, [flowParams, setRunningRunSessionsSynced]);

  const refreshWorkspaceRunStatus = useCallback(async () => {
    if (!flowParams.flowId) return;
    try {
      const q = flowParamsQuery(flowParams);
      const res = await fetch(`/api/workspace/run/status?${q.toString()}`);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) return;
      if (!json.running) {
        setRunningRunSessionsSynced((current) => {
          const next = { ...current };
          for (const [sessionId, session] of Object.entries(next)) {
            if (["running", "stopping", "waiting", "polling"].includes(String(session?.status || ""))) delete next[sessionId];
          }
          return next;
        });
        setWorkspaceExecutingNodes(new Set());
        setWorkspaceNodeRunStatus((current) => {
          const next = { ...current };
          for (const [nodeId, state] of Object.entries(next)) {
            if (["running", "waiting"].includes(String(state?.status || ""))) delete next[nodeId];
          }
          return next;
        });
        return;
      }
      const runs = Array.isArray(json.runs) && json.runs.length
        ? json.runs
        : [{ runId: `run-restored-${json.startedAt || Date.now()}`, runNodeId: json.runNodeId || "", startedAt: json.startedAt || Date.now(), plannedNodeIds: [] }];
      const restoredSessions = {};
      const restoredNodeIds = [];
      for (const item of runs) {
        const runNodeId = String(item?.runNodeId || "").trim();
        const sessionId = String(item?.runId || `run-restored-${item?.startedAt || Date.now()}-${runNodeId}`).trim();
        if (!sessionId) continue;
        const alias = String(item?.label || "").trim() || workspaceRunNodeAlias(nodesRef.current, instancesRef.current, runNodeId, "Workspace Run");
        restoredSessions[sessionId] = {
          id: sessionId,
          runNodeId,
          label: alias,
          status: ["waiting", "polling"].includes(String(item?.state || "")) ? "waiting" : item?.state === "stopping" ? "stopping" : "running",
          plannedNodeIds: Array.isArray(item?.plannedNodeIds) ? item.plannedNodeIds : [],
          waitingNodeId: String(item?.waitingNodeId || ""),
          startedAt: item?.startedAt || Date.now(),
        };
        if (runNodeId) restoredNodeIds.push(runNodeId);
        const waitingNodeId = String(item?.waitingNodeId || "").trim();
        if (waitingNodeId) restoredNodeIds.push(waitingNodeId);
      }
      if (!Object.keys(restoredSessions).length) return;
      setRunningRunSessionsSynced((current) => ({ ...current, ...restoredSessions }));
      setWorkspaceExecutingNodes((current) => {
        const next = new Set(current);
        for (const runNodeId of restoredNodeIds) next.add(runNodeId);
        return next;
      });
      setWorkspaceNodeRunStatus((current) => {
        const next = { ...current };
        for (const item of runs) {
          const runNodeId = String(item?.runNodeId || "").trim();
          const waitingNodeId = String(item?.waitingNodeId || "").trim();
          if (runNodeId) next[runNodeId] = { status: ["waiting", "polling"].includes(String(item?.state || "")) ? "waiting" : "running" };
          if (waitingNodeId) {
            next[waitingNodeId] = {
              status: "waiting",
              detail: {
                phase: String(item?.phase || ""),
                jenkinsStatus: String(item?.jenkinsStatus || ""),
                message: String(item?.message || ""),
                buildNumber: String(item?.buildNumber || ""),
                url: String(item?.url || ""),
                qrUrl: String(item?.qrUrl || ""),
                wakeAt: String(item?.wakeAt || ""),
              },
            };
          }
        }
        return next;
      });
      setStatus(restoredNodeIds.length ? `Workspace run still running: ${restoredNodeIds.join(", ")}` : "Workspace run still running");
      setComposerRunSessions((list) => {
        const next = [...list];
        for (const [sessionId, sessionInfo] of Object.entries(restoredSessions)) {
          if (next.some((session) => session.id === sessionId || (["running", "stopping"].includes(session.status) && session.runNodeId === sessionInfo.runNodeId))) continue;
          const runNodeId = String(sessionInfo.runNodeId || "");
          const alias = String(sessionInfo.label || "").trim() || workspaceRunNodeAlias(nodesRef.current, instancesRef.current, runNodeId, "Workspace Run");
          next.push({
            id: sessionId,
            label: workspaceRunNameWithId(alias, runNodeId, "Workspace Run"),
            alias,
            runNodeId,
            status: sessionInfo.status,
            startedAt: sessionInfo.startedAt || Date.now(),
            steps: runNodeId ? [{ id: runNodeId, label: workspaceRunNameWithId(alias, runNodeId, "Workspace Run"), status: "running" }] : [],
            messages: [{
              role: "assistant",
              kind: "run-summary",
              text: sessionInfo.status === "stopping"
                ? "Workspace run is stopping in the background."
                : "Workspace run is still running in the background.",
              at: Date.now(),
            }],
          });
        }
        return [
          ...next.slice(-8),
        ];
      });
    } catch {
      /* status restore is best-effort */
    }
  }, [flowParams, nodesRef, setRunningRunSessionsSynced]);

  // ignoreCache：这一趟不吃缓存。缓存靠指纹判定，而指纹只覆盖图里的东西——节点读了仓库、
  // 读了网络，这些变化它看不见。所以「强制重跑」不是锦上添花，是这套缓存的必要配套。
  const runWorkspaceNode = useCallback(async (runNodeId, runOptions = {}) => {
    const ignoreCache = runOptions?.ignoreCache === true;
    if (!workspaceWritable) {
      setStatus("Readonly workspace");
      return;
    }
    if (!runNodeId) return;
    const existingSession = Object.values(runningRunSessionsRef.current || {})
      .find((session) => String(session?.runNodeId || "") === String(runNodeId || ""));
    if (existingSession) {
      setStatus(`Workspace run already running: ${runNodeId}`);
      return;
    }
    let runNodes = nodesRef.current;
    let runEdges = edgesRef.current;
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
        nodesRef.current = runNodes;
        edgesRef.current = runEdges;
        setInstances(runInstances);
        setNodes(runNodes);
        setEdges(runEdges);
        refreshNodeInternals(applied.nextId || draft.id);
      }
    }
    const graph = flowToGraph(runNodes, runEdges, runInstances);
    const runSessionId = `run-${Date.now()}-${String(runNodeId).replace(/[^a-z0-9_-]+/gi, "_")}`;
    const runAlias = workspaceRunNodeAlias(runNodes, runInstances, runNodeId, "Workspace Run");
    const runSessionLabel = workspaceRunNameWithId(runAlias, runNodeId, "Workspace Run");
    let plannedNodeIds = [runNodeId];
    try {
      const planRes = await fetch("/api/workspace/run/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...flowParams, graph, runNodeId, ignoreCache }),
      });
      const planJson = await planRes.json().catch(() => ({}));
      if (!planRes.ok || planJson?.ok === false) throw new Error(planJson.error || "Workspace run plan failed");
      plannedNodeIds = Array.isArray(planJson.plannedNodeIds) && planJson.plannedNodeIds.length
        ? planJson.plannedNodeIds.map((id) => String(id || "").trim()).filter(Boolean)
        : [runNodeId];
      plannedNodeIds = Array.from(new Set([runNodeId, ...plannedNodeIds].filter(Boolean)));
      const conflict = planJson.conflict || null;
      if (conflict?.runNodeId || conflict?.runId) {
        const conflictIds = Array.isArray(conflict.conflictNodeIds) && conflict.conflictNodeIds.length
          ? `: ${conflict.conflictNodeIds.join(", ")}`
          : "";
        setStatus(`Run ${runNodeId} conflicts with running ${conflict.runNodeId || conflict.runId}${conflictIds}`);
        return;
      }
    } catch (e) {
      setStatus(String(e.message || e));
      return;
    }
    const plannedSet = new Set(plannedNodeIds);
    const localConflict = Object.values(runningRunSessionsRef.current || {}).find((session) => (
      (Array.isArray(session?.plannedNodeIds) ? session.plannedNodeIds : [])
        .some((id) => plannedSet.has(String(id || "").trim()))
    ));
    if (localConflict) {
      const overlap = (Array.isArray(localConflict.plannedNodeIds) ? localConflict.plannedNodeIds : [])
        .map((id) => String(id || "").trim())
        .filter((id) => id && plannedSet.has(id));
      setStatus(`Run ${runNodeId} conflicts with running ${localConflict.runNodeId || "workspace run"}${overlap.length ? `: ${overlap.join(", ")}` : ""}`);
      return;
    }
    const abortController = new AbortController();
    workspaceRunAbortRefs.current.set(runSessionId, abortController);
    workspaceRunStoppedRef.current.delete(runSessionId);
    setRunningRunSessionsSynced((current) => ({
      ...current,
      [runSessionId]: {
        id: runSessionId,
        runNodeId,
        label: runAlias,
        plannedNodeIds,
        startedAt: Date.now(),
      },
    }));
    setWorkspaceExecutingNodes((current) => new Set([...current, runNodeId]));
    setWorkspaceNodeRunStatus((current) => ({ ...current, [runNodeId]: { status: "running" } }));
    setStatus(`Running ${runSessionLabel}...`);
    setActiveComposerSessionId(runSessionId);
    setComposerRunSessions((list) => [
      ...list.slice(-7),
      {
        id: runSessionId,
        label: runSessionLabel,
        alias: runAlias,
        runNodeId,
        status: "running",
        startedAt: Date.now(),
        steps: [],
        messages: [{ role: "assistant", kind: "run-summary", text: "准备运行...", at: Date.now() }],
      },
    ]);
    let activeNodeId = runNodeId;
    const latestResultByNodeId = new Map();
    const isRunStopped = () => workspaceRunStoppedRef.current.has(runSessionId);
    const removeSessionExecutingNodes = (ids) => {
      const affectedIds = new Set((ids || []).map((id) => String(id || "").trim()).filter(Boolean));
      if (!affectedIds.size) affectedIds.add(String(runNodeId || ""));
      setWorkspaceExecutingNodes((current) => {
        const next = new Set(current);
        for (const id of affectedIds) next.delete(id);
        return next;
      });
    };
    const markSessionNodesFinal = (ids, finalStatus) => {
      const affectedIds = new Set((ids || []).map((id) => String(id || "").trim()).filter(Boolean));
      if (!affectedIds.size) affectedIds.add(String(runNodeId || ""));
      setWorkspaceNodeRunStatus((current) => {
        const next = { ...current };
        for (const id of affectedIds) {
          if (!id) continue;
          if (!next[id] || ["running", "waiting"].includes(next[id]?.status)) next[id] = { ...next[id], status: finalStatus };
        }
        return next;
      });
    };
    let finalDeferred = null;
    try {
      await saveGraph(runNodes, runEdges);
      const effectiveModel = workspaceRunNodeModel(runNodes, runInstances, runNodeId, composerModel);
      const res = await fetch("/api/workspace/run", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        signal: abortController.signal,
        body: JSON.stringify({
          ...flowParams,
          graph,
          runNodeId,
          runAlias,
          runSessionId,
          expectedRevision: workspaceRevisionRef.current,
          clientId: collaborationClientIdRef.current,
          model: effectiveModel,
          selectedSkills,
          ignoreCache,
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
    const ensureContextRunResultDisplay = (nodeId, rawContent) => {
      const id = String(nodeId || "").trim();
      const content = String(rawContent || "").trim();
      if (!id || !content) return;
      const currentInstance = instancesRef.current?.[id];
      if (!isOneClickTaskDefinitionId(currentInstance?.definitionId)) return;
      const displayType = workspaceSlotConfigValue(currentInstance?.input, "displayType", "markdown");
      const displayDefinitionId = contextRunDisplayDefinitionId(displayType);
      const displayId = contextRunLinkedDisplayNodeId(id);
      const displayDef = palette.find((node) => node.id === displayDefinitionId);
      const input = contextRunDisplaySlots(displayDef?.inputs, displayDefinitionId, content);
      const output = contextRunDisplaySlots(displayDef?.outputs, displayDefinitionId, content);
      const displayLabel = String(currentInstance?.label || id || "一键任务").trim();
      const nextInstances = {
        ...(instancesRef.current || {}),
        [id]: {
          ...(currentInstance || {}),
          output: clearContextRunOutputSlots(currentInstance?.output),
        },
        [displayId]: {
          ...(instancesRef.current?.[displayId] || {}),
          definitionId: displayDefinitionId,
          label: displayLabel,
          role: "normal",
          body: content,
          input,
          output,
          sourceContextRunNodeId: id,
          displayReloadKey: String(Date.now()),
        },
      };
      instancesRef.current = nextInstances;
      setInstances(nextInstances);
      const currentNodes = nodesRef.current || [];
      const sourceNode = currentNodes.find((node) => node.id === id);
      const existingDisplayNode = currentNodes.find((node) => node.id === displayId);
      const sourceWidth = Number(sourceNode?.measured?.width || sourceNode?.width || sourceNode?.data?.nodeSize?.width || 520);
      const position = existingDisplayNode?.position || {
        x: Number(sourceNode?.position?.x || 0) + sourceWidth + 120,
        y: Number(sourceNode?.position?.y || 0),
      };
      const displaySize = existingDisplayNode?.data?.displaySize || existingDisplayNode?.data?.nodeSize || { width: DEFAULT_WORKSPACE_DISPLAY_WIDTH, height: DEFAULT_WORKSPACE_DISPLAY_HEIGHT };
      const displayNode = mergeNodeWithPalette({
        id: displayId,
        type: FLOW_NODE_TYPE,
        position,
        width: Number(displaySize.width) || DEFAULT_WORKSPACE_DISPLAY_WIDTH,
        height: Number(displaySize.height) || DEFAULT_WORKSPACE_DISPLAY_HEIGHT,
        data: {
          label: displayLabel,
          definitionId: displayDefinitionId,
          role: "normal",
          body: content,
          inputs: input,
          outputs: output,
          sourceContextRunNodeId: id,
          displayReloadKey: nextInstances[displayId].displayReloadKey,
          nodeSize: displaySize,
          displaySize,
        },
      }, nextInstances, palette);
      const nextNodes = currentNodes.map((node) => {
        if (node.id === id) {
          const { width: _width, height: _height, measured: _measured, ...sourceNodeRest } = node;
          const { nodeSize: _nodeSize, displaySize: _displaySize, ...sourceDataRest } = node.data || {};
          return {
            ...sourceNodeRest,
            data: {
              ...sourceDataRest,
              outputs: clearContextRunOutputSlots(sourceDataRest?.outputs),
              contextRunResultNonce: Date.now(),
            },
          };
        }
        if (node.id === displayId) {
          return {
            ...displayNode,
            selected: node.selected,
          };
        }
        return node;
      });
      if (!existingDisplayNode) nextNodes.push(displayNode);
      nodesRef.current = nextNodes;
      setNodes(nextNodes);
      const currentEdges = edgesRef.current || [];
      const primaryName = contextRunDisplayPrimarySlotName(displayDefinitionId);
      const sourceHandle = contextRunSlotHandleId(currentInstance?.output || sourceNode?.data?.outputs, "output", ["content", "result"], ["text"]);
      const targetHandle = contextRunSlotHandleId(input, "input", [primaryName, "content"], ["text"]);
      const linkedEdge = {
        id: `we-${id}-${displayId}`,
        source: id,
        target: displayId,
        sourceHandle,
        targetHandle,
        markerEnd: { type: MarkerType.ArrowClosed },
      };
      const nextEdges = [
        ...currentEdges.filter((edge) => !(edge.source === id && edge.target === displayId)),
        linkedEdge,
      ];
      edgesRef.current = nextEdges;
      setEdges(nextEdges);
      window.requestAnimationFrame(() => {
        updateNodeInternals(id);
        updateNodeInternals(displayId);
      });
    };

    const patchContextRunResultsFromGraph = (nextGraph, touchedNodeIds = null) => {
      const graphInstances = nextGraph?.instances && typeof nextGraph.instances === "object" ? nextGraph.instances : {};
      const scopedIds = touchedNodeIds instanceof Set ? touchedNodeIds : null;
      for (const [instanceId, instance] of Object.entries(graphInstances)) {
        if (scopedIds && !scopedIds.has(instanceId)) continue;
        if (!isOneClickTaskDefinitionId(instance?.definitionId)) continue;
        const content = contextRunResultContentFromData({ outputs: instance.output });
        if (content) ensureContextRunResultDisplay(instanceId, content);
      }
    };

    const markNodeStart = (nodeId) => {
      const id = String(nodeId || "").trim();
      if (!id) return;
      const previousId = activeNodeId;
      activeNodeId = id;
      setWorkspaceExecutingNodes((current) => {
        const next = new Set(current);
        if (previousId && previousId !== id && previousId !== runNodeId) next.delete(previousId);
        if (runNodeId) next.add(runNodeId);
        next.add(id);
        return next;
      });
      setWorkspaceNodeRunStatus((current) => ({
        ...current,
        ...(previousId && previousId !== id && previousId !== runNodeId && current[previousId]?.status === "running" ? { [previousId]: { status: "success" } } : {}),
        ...(runNodeId ? { [runNodeId]: { status: "running" } } : {}),
        [id]: { status: "running" },
      }));
    };
      const markNodeDone = (nodeId, event = null) => {
        const id = String(nodeId || "").trim();
        if (!id) return;
        setWorkspaceExecutingNodes((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
        const jenkinsStatus = String(event?.jenkinsStatus || "").trim().toUpperCase();
        const status = jenkinsStatus && jenkinsStatus !== "SUCCESS" ? "outcome_failed" : "success";
        setWorkspaceNodeRunStatus((current) => ({
          ...current,
          [id]: {
            ...current[id],
            status,
            ...(jenkinsStatus ? { detail: { ...(current[id]?.detail || {}), jenkinsStatus } } : {}),
          },
        }));
      };
      const updateNodeRunDetail = (event) => {
        const id = String(event?.nodeId || "").trim();
        if (!id || (!event?.phase && !event?.jenkinsStatus)) return;
        const detail = {
          phase: String(event.phase || ""),
          jenkinsStatus: String(event.jenkinsStatus || ""),
          message: String(event.line || event.message || ""),
          buildNumber: String(event.buildNumber || ""),
          url: String(event.url || ""),
          qrUrl: String(event.qrUrl || ""),
          wakeAt: String(event.wakeAt || ""),
        };
        setWorkspaceNodeRunStatus((current) => ({
          ...current,
          [id]: {
            ...current[id],
            status: detail.phase === "complete" ? (current[id]?.status || "running") : "waiting",
            detail,
          },
        }));
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
      const updateRunActivity = (text, event = null) => {
        const activity = workspaceRunActivityText(text);
        if (!activity) return;
        setComposerRunSessions((list) => list.map((session) => {
          if (session.id !== runSessionId) return session;
          const now = Number(event?.ts) || Date.now();
          const startedAt = Number(session.startedAt) || now;
          const previousAt = Number(session.lastActivityAt) || startedAt;
          const stepMs = Math.max(0, now - previousAt);
          const totalMs = Number.isFinite(Number(event?.runElapsedMs))
            ? Math.max(0, Number(event.runElapsedMs))
            : Math.max(0, now - startedAt);
          const currentActivities = Array.isArray(session.activities) ? session.activities : [];
          const lastActivity = currentActivities[currentActivities.length - 1];
          const lastActivityText = typeof lastActivity === "string" ? lastActivity : String(lastActivity?.text || "");
          const nextActivities = lastActivityText === activity
            ? currentActivities
            : [...currentActivities, { text: activity, kind: workspaceRunActivityKind(activity), stepMs, totalMs, at: now }].slice(-30);
          const timingEntries = Array.isArray(session.timingEntries) ? session.timingEntries : [];
          const currentMessages = Array.isArray(session.messages) ? session.messages : [];
          const activityIndex = currentMessages.findIndex((msg) => msg.kind === "activity");
          const activityMessage = {
            role: "assistant",
            kind: "activity",
            text: workspaceRunActivityMessageText(nextActivities, timingEntries, startedAt, now),
            at: Date.now(),
          };
          const nextMessages = [...currentMessages];
          if (activityIndex >= 0) {
            nextMessages[activityIndex] = activityMessage;
          } else {
            const summaryIndex = nextMessages.findIndex((msg) => msg.kind === "run-summary");
            nextMessages.splice(summaryIndex >= 0 ? summaryIndex + 1 : 0, 0, activityMessage);
          }
          return { ...session, activities: nextActivities, lastActivityAt: now, messages: nextMessages.slice(-160) };
        }));
      };
      const appendRawTrace = (event) => {
        const source = String(event?.source || "runner");
        const stream = String(event?.stream || "");
        const eventType = String(event?.eventType || "event");
        const rawText = String(event?.text || "").trim();
        if (!rawText) return;
        const entry = `[${source}${stream ? `:${stream}` : ""}] ${eventType}\n${rawText}`;
        const timingEntry = workspaceRunRawTimingEntry(event);
        setComposerRunSessions((list) => list.map((session) => {
          if (session.id !== runSessionId) return session;
          const currentRaw = Array.isArray(session.rawTrace) ? session.rawTrace : [];
          const nextRaw = [...currentRaw, entry].slice(-80);
          const currentTimingEntries = Array.isArray(session.timingEntries) ? session.timingEntries : [];
          const nextTimingEntries = timingEntry ? [...currentTimingEntries, timingEntry].slice(-80) : currentTimingEntries;
          const currentActivities = Array.isArray(session.activities) ? session.activities : [];
          const startedAt = Number(session.startedAt) || Number(event?.ts) || Date.now();
          const lastAt = Number(timingEntry?.at) || Number(event?.ts) || Date.now();
          const currentMessages = Array.isArray(session.messages) ? session.messages : [];
          const rawMessage = {
            role: "assistant",
            kind: "raw",
            text: nextRaw.join("\n\n---\n\n"),
            at: Date.now(),
          };
          const nextMessages = [...currentMessages];
          const activityIndex = nextMessages.findIndex((msg) => msg.kind === "activity");
          if (timingEntry) {
            const activityMessage = {
              role: "assistant",
              kind: "activity",
              text: workspaceRunActivityMessageText(currentActivities, nextTimingEntries, startedAt, lastAt),
              at: Date.now(),
            };
            if (activityIndex >= 0) {
              nextMessages[activityIndex] = activityMessage;
            } else {
              const summaryIndex = nextMessages.findIndex((msg) => msg.kind === "run-summary");
              nextMessages.splice(summaryIndex >= 0 ? summaryIndex + 1 : 0, 0, activityMessage);
            }
          }
          const rawIndex = nextMessages.findIndex((msg) => msg.kind === "raw");
          if (rawIndex >= 0) {
            nextMessages[rawIndex] = rawMessage;
          } else {
            nextMessages.push(rawMessage);
          }
          return { ...session, rawTrace: nextRaw, timingEntries: nextTimingEntries, messages: nextMessages.slice(-160) };
        }));
      };
      const markRunSessionStatus = (sessionStatus) => {
        setComposerRunSessions((list) => list.map((session) => (
          session.id === runSessionId
            ? { ...session, status: sessionStatus, ...(sessionStatus === "waiting" ? {} : { endedAt: Date.now() }) }
            : session
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
        const mergeRuntimeNodeInstance = (currentInstance, incomingInstance) => {
          const merged = { ...(currentInstance || incomingInstance) };
          if (Array.isArray(incomingInstance?.output)) merged.output = incomingInstance.output;
          for (const key of ["scriptRef", "implementationRef", "implementationMode"]) {
            if (incomingInstance?.[key] != null && String(incomingInstance[key]).trim() !== "") {
              merged[key] = incomingInstance[key];
            }
          }
          return merged;
        };
        const mergeRuntimeNodeData = (currentData, incomingData) => {
          const merged = { ...(currentData || {}) };
          if (Array.isArray(incomingData?.outputs)) merged.outputs = incomingData.outputs;
          for (const key of ["scriptRef", "implementationRef", "implementationMode"]) {
            if (incomingData?.[key] != null && String(incomingData[key]).trim() !== "") {
              merged[key] = incomingData[key];
            }
          }
          return merged;
        };
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
              nextInstances[instanceId] = mergeRuntimeNodeInstance(currentInstance, instance);
            }
          }
          instancesRef.current = nextInstances;
          setInstances(nextInstances);
          return currentNodes.map((node) => {
            if (scopedIds && !scopedIds.has(node.id)) return node;
            const incomingNode = incomingNodesById.get(node.id);
            if (!incomingNode) return node;
            if (!displayKind(incomingNode.data?.definitionId || node.data?.definitionId)) {
              return {
                ...node,
                data: mergeRuntimeNodeData(node.data, incomingNode.data),
              };
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
            workspaceRunStoppedRef.current.add(runSessionId);
            finalOrder = Array.isArray(event.order) ? event.order : finalOrder;
            updateRunActivity("运行停止", event);
            continue;
          }
          if (event.type === "node-start") {
            setStatus(`Running ${event.nodeId}...`);
            markNodeStart(event.nodeId);
            updateRunStep(event.nodeId, event.definitionId, "running");
          }
          if (event.type === "node-done") {
            const finalText = latestResultByNodeId.get(String(event.nodeId || "").trim());
            if (finalText) ensureContextRunResultDisplay(event.nodeId, finalText);
            markNodeDone(event.nodeId, event);
            updateRunStep(event.nodeId, event.definitionId, "done");
          }
          if (event.type === "status") {
            updateNodeRunDetail(event);
            updateRunActivity(event.line || event.message || "", event);
          }
          if (event.type === "node-waiting") {
            updateNodeRunDetail(event);
            updateRunStep(event.nodeId, event.definitionId, "waiting");
          }
          if (event.type === "paused") {
            finalPauseNodeIds = Array.isArray(event.nodeIds) ? event.nodeIds : [];
            updateRunActivity("运行暂停", event);
          }
          if (event.type === "natural") {
            if ((event.kind === "result" || /---agentflow\b|resultFile\s*:|\"resultFile\"\s*:|\"result\"\s*:/i.test(String(event.text || ""))) && event.nodeId) {
              latestResultByNodeId.set(String(event.nodeId || "").trim(), String(event.text || ""));
            }
            if (event.kind === "thinking") appendThinkingText(event.text || "");
            else appendNaturalText(event.kind, event.text || "");
          }
          if (event.type === "raw") {
            const rawThinking = extractThinkingDeltaFromRawTrace(event);
            if (rawThinking) appendThinkingText(rawThinking);
            appendRawTrace(event);
          }
          if (event.type === "graph" && event.graph) {
            const touchedIds = eventTouchedNodeIds(event);
            applyGraph(event.graph, touchedIds);
            patchContextRunResultsFromGraph(event.graph, touchedIds);
          }
          if (event.type === "done") {
            if (event.revision) workspaceRevisionRef.current = String(event.revision);
            if (event.graph) {
              workspaceBaseGraphRef.current = event.graph;
              const touchedIds = eventTouchedNodeIds(event);
              applyGraph(event.graph, touchedIds);
              patchContextRunResultsFromGraph(event.graph, touchedIds);
            }
            finalOrder = Array.isArray(event.order) ? event.order : [];
            finalPauseNodeIds = Array.isArray(event.pauseNodeIds) ? event.pauseNodeIds : finalPauseNodeIds;
            updateRunActivity(finalPauseNodeIds.length ? "运行暂停" : "运行完成", event);
          }
          if (event.type === "waiting") {
            finalDeferred = event;
            if (event.revision) workspaceRevisionRef.current = String(event.revision);
            if (event.graph) {
              workspaceBaseGraphRef.current = event.graph;
              const touchedIds = eventTouchedNodeIds(event);
              applyGraph(event.graph, touchedIds);
            }
            updateNodeRunDetail({
              nodeId: event.nodeId,
              phase: event.phase,
              jenkinsStatus: event.jenkinsStatus,
              line: event.message,
              buildNumber: event.buildNumber,
              url: event.url,
              qrUrl: event.qrUrl,
              wakeAt: event.wakeAt,
            });
            updateRunActivity("已转入后台等待 Jenkins", event);
          }
        }
      }
      if (buffer.trim()) {
        const event = JSON.parse(buffer);
        if (event.type === "error") throw new Error(event.error || "Workspace run failed");
        if (event.type === "stopped") {
          workspaceRunStoppedRef.current.add(runSessionId);
          updateRunActivity("运行停止", event);
        }
        if (event.type === "node-start") {
          setStatus(`Running ${event.nodeId}...`);
          markNodeStart(event.nodeId);
          updateRunStep(event.nodeId, event.definitionId, "running");
        }
        if (event.type === "node-done") {
          const finalText = latestResultByNodeId.get(String(event.nodeId || "").trim());
          if (finalText) ensureContextRunResultDisplay(event.nodeId, finalText);
          markNodeDone(event.nodeId, event);
          updateRunStep(event.nodeId, event.definitionId, "done");
        }
        if (event.type === "status") {
          updateNodeRunDetail(event);
          updateRunActivity(event.line || event.message || "", event);
        }
        if (event.type === "node-waiting") {
          updateNodeRunDetail(event);
          updateRunStep(event.nodeId, event.definitionId, "waiting");
        }
        if (event.type === "paused") {
          finalPauseNodeIds = Array.isArray(event.nodeIds) ? event.nodeIds : [];
          updateRunActivity("运行暂停", event);
        }
        if (event.type === "natural") {
          if ((event.kind === "result" || /---agentflow\b|resultFile\s*:|\"resultFile\"\s*:|\"result\"\s*:/i.test(String(event.text || ""))) && event.nodeId) {
            latestResultByNodeId.set(String(event.nodeId || "").trim(), String(event.text || ""));
          }
          if (event.kind === "thinking") appendThinkingText(event.text || "");
          else appendNaturalText(event.kind, event.text || "");
        }
        if (event.type === "raw") {
          const rawThinking = extractThinkingDeltaFromRawTrace(event);
          if (rawThinking) appendThinkingText(rawThinking);
          appendRawTrace(event);
        }
        if (event.type === "graph" && event.graph) {
          const touchedIds = eventTouchedNodeIds(event);
          applyGraph(event.graph, touchedIds);
          patchContextRunResultsFromGraph(event.graph, touchedIds);
        }
        if (event.type === "done") {
          if (event.revision) workspaceRevisionRef.current = String(event.revision);
          if (event.graph) {
            workspaceBaseGraphRef.current = event.graph;
            const touchedIds = eventTouchedNodeIds(event);
            applyGraph(event.graph, touchedIds);
            patchContextRunResultsFromGraph(event.graph, touchedIds);
          }
          finalOrder = Array.isArray(event.order) ? event.order : [];
          finalPauseNodeIds = Array.isArray(event.pauseNodeIds) ? event.pauseNodeIds : finalPauseNodeIds;
          updateRunActivity(finalPauseNodeIds.length ? "运行暂停" : "运行完成", event);
        }
        if (event.type === "waiting") {
          finalDeferred = event;
          if (event.revision) workspaceRevisionRef.current = String(event.revision);
          if (event.graph) {
            workspaceBaseGraphRef.current = event.graph;
            const touchedIds = eventTouchedNodeIds(event);
            applyGraph(event.graph, touchedIds);
          }
          updateNodeRunDetail({
            nodeId: event.nodeId,
            phase: event.phase,
            jenkinsStatus: event.jenkinsStatus,
            line: event.message,
            buildNumber: event.buildNumber,
            url: event.url,
            qrUrl: event.qrUrl,
            wakeAt: event.wakeAt,
          });
          updateRunActivity("已转入后台等待 Jenkins", event);
        }
      }
      if (isRunStopped()) {
        removeSessionExecutingNodes(plannedNodeIds);
        markSessionNodesFinal(plannedNodeIds, "stopped");
      }
      const finalStatusMessage = isRunStopped()
        ? `Workspace run stopped: ${runNodeId}`
        : finalDeferred
        ? `Workspace run waiting in background: ${finalDeferred.message || finalDeferred.nodeId || runNodeId}`
        : finalPauseNodeIds.length
        ? `Workspace run paused at ${finalPauseNodeIds.join(", ")}`
        : `Workspace run done: ${finalOrder.length ? finalOrder.join(" -> ") : runNodeId}`;
      setStatus(finalStatusMessage);
      if (!isRunStopped() && !finalDeferred) {
        markSessionNodesFinal(plannedNodeIds, finalPauseNodeIds.length ? "paused" : "success");
      }
      markRunSessionStatus(isRunStopped() ? "stopped" : finalDeferred ? "waiting" : finalPauseNodeIds.length ? "paused" : "done");
      if (finalDeferred) {
        setRunningRunSessionsSynced((current) => ({
          ...current,
          [runSessionId]: {
            ...(current[runSessionId] || {}),
            id: runSessionId,
            runNodeId,
            label: runAlias,
            status: "waiting",
            plannedNodeIds,
            waitingNodeId: finalDeferred.nodeId || "",
            startedAt: current[runSessionId]?.startedAt || Date.now(),
          },
        }));
      }
      if (!isRunStopped() && !finalDeferred) {
        try {
          await saveGraph(nodesRef.current, edgesRef.current);
          setStatus(finalStatusMessage);
        } catch (saveError) {
          setStatus(`${finalStatusMessage}，但保存结果失败：${String(saveError.message || saveError)}`);
        }
        await loadFiles();
      }
    } catch (e) {
      if (isRunStopped() || e?.name === "AbortError") {
        removeSessionExecutingNodes(plannedNodeIds);
        markSessionNodesFinal(plannedNodeIds, "stopped");
        setStatus(`Workspace run stopped: ${runNodeId}`);
        setComposerRunSessions((list) => list.map((session) => (
          session.id === runSessionId ? { ...session, status: "stopped", endedAt: Date.now() } : session
        )));
        return;
      }
      removeSessionExecutingNodes(plannedNodeIds);
      markSessionNodesFinal([runNodeId, activeNodeId].filter(Boolean), "failed");
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
      if (workspaceRunAbortRefs.current.get(runSessionId) === abortController) workspaceRunAbortRefs.current.delete(runSessionId);
      if (!finalDeferred) {
        setRunningRunSessionsSynced((current) => {
          const next = { ...current };
          delete next[runSessionId];
          return next;
        });
      }
      workspaceRunStoppedRef.current.delete(runSessionId);
      if (!finalDeferred) removeSessionExecutingNodes(plannedNodeIds);
    }
  }, [composerModel, edges, flowParams, loadFiles, nodes, palette, refreshNodeInternals, saveGraph, selectedSkills, setEdges, setNodes, setRunningRunSessionsSynced, updateNodeInternals, workspaceWritable]);

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

  const refreshWorkspaces = useCallback(async () => {
    try {
      const q = flowParamsQuery(flowParams);
      const r = await fetch(`/api/workspaces?${q.toString()}`);
      const j = await r.json().catch(() => ({}));
      const list = Array.isArray(j.workspaces) ? j.workspaces.map((item) => ({
        id: String(item?.id || ""),
        label: String(item?.label || item?.name || "知识库"),
        path: String(item?.path || ""),
        kind: item?.kind === "git" ? "git" : "local",
        repoUrl: String(item?.repoUrl || ""),
        branch: String(item?.branch || ""),
        mountPath: String(item?.mountPath || ""),
        type: String(item?.type || ""),
        builtin: item?.builtin === true,
        exists: item?.exists !== false,
      })).filter((item) => item.path) : [];
      setWorkspaceTargets(list);
    } catch {
      setWorkspaceTargets([]);
    }
  }, [flowParams]);

  const loadWorkspaceConversations = useCallback(async () => {
    conversationsLoadedRef.current = false;
    try {
      const q = flowParamsQuery(flowParams);
      const r = await fetch(`/api/workspace/conversations?${q.toString()}`);
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
      const normalized = normalizeWorkspaceConversationsForUi(j.conversations || {});
      setComposerMessages(normalized.composer.messages);
      setComposerRunSessions(normalized.composer.runSessions);
      setActiveComposerSessionId(normalized.composer.activeSessionId || "workspace");
      setNodeChatSessions(normalized.nodeChats);
    } catch {
      setComposerMessages([]);
      setComposerRunSessions([]);
      setActiveComposerSessionId("workspace");
      setNodeChatSessions({});
    } finally {
      conversationsLoadedRef.current = true;
    }
  }, [flowParams]);

  const saveWorkspaceConversations = useCallback(async () => {
    if (!workspaceWritable || flowParams.archived) return;
    const conversations = normalizeWorkspaceConversationsForUi({
      composer: {
        activeSessionId: activeComposerSessionId,
        messages: composerMessages,
        runSessions: composerRunSessions,
      },
      nodeChats: nodeChatSessions,
    });
    await fetch("/api/workspace/conversations", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ...flowParams,
        conversations,
      }),
    }).then(async (res) => {
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
    });
  }, [activeComposerSessionId, composerMessages, composerRunSessions, flowParams, nodeChatSessions, workspaceWritable]);

  useEffect(() => {
    let cancelled = false;
    if (isWorkflowShareView) {
      setAuthUser(null);
      setAuthResolved(true);
      return () => {
        cancelled = true;
      };
    }
    const bootstrapWorkspace = async () => {
      const currentUrl = new URL(window.location.href);
      const invite = String(currentUrl.searchParams.get("invite") || "").trim();
      if (invite) {
        setStatus("正在加入共享 Workspace...");
        const accepted = await fetch("/api/workspace/collaboration/accept", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: invite }),
        });
        const acceptedJson = await accepted.json().catch(() => ({}));
        if (!accepted.ok) throw new Error(acceptedJson.error || "加入共享 Workspace 失败");
        currentUrl.searchParams.delete("invite");
        window.history.replaceState({}, "", `${currentUrl.pathname}${currentUrl.search}${currentUrl.hash}`);
      }
      if (cancelled) return;
      await loadWorkspace();
      if (!cancelled) await loadWorkspaceConversations();
    };
    bootstrapWorkspace().catch((e) => {
      const message = String(e.message || e);
      setStatus(message);
      setWorkspaceSyncPhase("error");
      setWorkspaceSyncDetail(message);
    });
    void loadFlowSnippets();
    fetch("/api/model-lists").then((r) => r.json()).then((j) => setModelLists({
      cursor: Array.isArray(j.cursor) ? j.cursor.map(String) : [],
      opencode: Array.isArray(j.opencode) ? j.opencode.map(String) : [],
      claudeCode: Array.isArray(j.claudeCode) ? j.claudeCode.map(String) : [],
      codex: Array.isArray(j.codex) ? j.codex.map(String) : [],
    })).catch(() => {});
    void refreshSkills();
    void refreshMcps();
    void refreshWorkspaces();
    void refreshWorkspaceRunStatus();
    fetch("/api/skill-collections").then((r) => r.json()).then((j) => {
      setSkillCollections(normalizeSkillCollections(j));
      setSkillCollectionsLoaded(true);
    }).catch(() => {});
    fetch("/api/auth/me")
      .then((r) => r.json())
      .then((j) => {
        setAuthUser(j.user || null);
        setAuthResolved(true);
      })
      .catch(() => {
        setAuthUser(null);
        setAuthResolved(true);
      });
    return () => {
      cancelled = true;
    };
  }, [isWorkflowShareView, loadWorkspace, loadWorkspaceConversations, loadFlowSnippets, refreshMcps, refreshSkills, refreshWorkspaceRunStatus, refreshWorkspaces, skillsStorageKey]);

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
    if (workspaceCanvasInteractionActiveRef.current) return undefined;
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
    refreshNodeInternals(changedIds);
    return undefined;
  }, [nodes, refreshNodeInternals]);

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
    if (workspaceCanvasInteractionActiveRef.current) {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      return;
    }
    const suppressedState = workspaceAutosaveSuppressedStateRef.current;
    workspaceAutosaveSuppressedStateRef.current = null;
    if (
      suppressedState?.nodes === nodes
      && suppressedState.edges === edges
      && suppressedState.displayPage === displayPage
    ) {
      return;
    }
    if (skipNextWorkspaceAutosaveRef.current) {
      skipNextWorkspaceAutosaveRef.current = false;
      return;
    }
    markWorkspaceDirty();
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    const saveDelayMs = workspaceFlushAfterInteractionRef.current ? 0 : 650;
    workspaceFlushAfterInteractionRef.current = false;
    saveTimerRef.current = window.setTimeout(() => {
      saveGraph().catch((e) => setStatus(String(e.message || e)));
    }, saveDelayMs);
    return () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    };
  }, [nodes, edges, displayPage, markWorkspaceDirty, saveGraph, workspaceWritable]);

  useEffect(() => {
    if (!conversationsLoadedRef.current) return undefined;
    if (!workspaceWritable || flowParams.archived) return undefined;
    if (conversationsSaveTimerRef.current) window.clearTimeout(conversationsSaveTimerRef.current);
    conversationsSaveTimerRef.current = window.setTimeout(() => {
      saveWorkspaceConversations().catch((e) => setStatus(String(e.message || e)));
    }, 900);
    return () => {
      if (conversationsSaveTimerRef.current) window.clearTimeout(conversationsSaveTimerRef.current);
    };
  }, [activeComposerSessionId, composerMessages, composerRunSessions, flowParams.archived, nodeChatSessions, saveWorkspaceConversations, workspaceWritable]);

  const scheduledRunConfigs = useMemo(() => (
    nodes
      .filter((node) => node?.data?.definitionId === "workspace_scheduled_run")
      .map((node) => ({ id: node.id, config: normalizeScheduledRunConfig(node.data?.body || "") }))
  ), [nodes]);

  const scheduledRunKey = useMemo(() => (
    scheduledRunConfigs
      .map((item) => `${item.id}:${item.config.enabled ? "1" : "0"}:${item.config.cron}:${item.config.timezone}`)
      .join("|")
  ), [scheduledRunConfigs]);

  useEffect(() => {
    if (!loadedRef.current || workspaceMode !== "workspace" || !flowParams.flowId) {
      setScheduledRunState({});
      return undefined;
    }
    if (!scheduledRunConfigs.length) {
      setScheduledRunState({});
      return undefined;
    }
    let cancelled = false;
    const refresh = async () => {
      try {
        const q = flowParamsQuery(flowParams);
        const res = await fetch(`/api/workspace/schedules?${q.toString()}`);
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || "读取 Workspace 定时状态失败");
        if (!cancelled) setScheduledRunState(scheduledRunStateFromServer(json.schedules || []));
      } catch {
        if (!cancelled) {
          setScheduledRunState((current) => {
            const next = {};
            for (const item of scheduledRunConfigs) {
              next[item.id] = {
                ...(current[item.id] || {}),
                lastStatus: current[item.id]?.lastStatus || "unknown",
              };
            }
            return next;
          });
        }
      }
    };
    refresh();
    const timer = window.setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [flowParams, scheduledRunConfigs, scheduledRunKey, workspaceMode]);

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

  const changeLoadWorkspace = useCallback((nodeId, workspaceOrList) => {
    if (!workspaceWritable) {
      setStatus("Readonly workspace");
      return;
    }
    const selected = (Array.isArray(workspaceOrList) ? workspaceOrList : (workspaceOrList ? [workspaceOrList] : []))
      .filter((item) => String(item?.path || "").trim());
    const primary = selected[0] || null;
    const pathValue = String(primary?.path || "").trim();
    const labelValue = selected.length === 1
      ? String(primary?.label || primary?.id || "知识库").trim()
      : (selected.length ? `${selected.length} 个知识库` : "");
    const knowledgeContextValue = selected.length ? JSON.stringify(knowledgeContextFromWorkspaces(selected)) : "";
    const legacyWorkspaceContextValue = primary ? JSON.stringify({
      version: 1,
      id: primary?.id || "",
      label: String(primary?.label || primary?.id || "知识库").trim(),
      kind: primary?.kind || "local",
      cwd: pathValue,
      workspaceRoot: pathValue,
      repoUrl: primary?.repoUrl || "",
      branch: primary?.branch || "",
      mountPath: primary?.mountPath || "",
      type: primary?.type || "",
    }) : "";
    const patchInputSlots = (slots) => (Array.isArray(slots) ? slots.map((slot) => {
      if (slot?.name === "path") return { ...slot, default: pathValue, value: pathValue };
      if (slot?.name === "label") return { ...slot, default: labelValue, value: labelValue };
      if (slot?.name === "knowledgeContext") return { ...slot, default: knowledgeContextValue, value: knowledgeContextValue };
      if (slot?.name === "workspaceContext") return { ...slot, default: legacyWorkspaceContextValue, value: legacyWorkspaceContextValue };
      if (slot?.name === "mode") return { ...slot, default: "set", value: "set" };
      return slot;
    }) : []);
    const patchOutputSlots = (slots) => (Array.isArray(slots) ? slots.map((slot) => {
      if (slot?.name === "knowledgeContext") return { ...slot, default: knowledgeContextValue, value: knowledgeContextValue };
      if (slot?.name === "workspaceContext") return { ...slot, default: legacyWorkspaceContextValue, value: legacyWorkspaceContextValue, showOnNode: false };
      if (slot?.name === "cwd") return { ...slot, default: pathValue, value: pathValue, showOnNode: false };
      return slot;
    }) : []);
    const nextNodes = nodes.map((node) => (
      node.id === nodeId
        ? {
            ...node,
            data: {
              ...node.data,
              label: node.data?.label || "加载知识库",
              inputs: patchInputSlots(node.data?.inputs),
              outputs: patchOutputSlots(node.data?.outputs),
            },
          }
        : node
    ));
    const currentInstances = instancesRef.current || {};
    const base = currentInstances[nodeId] && typeof currentInstances[nodeId] === "object" ? currentInstances[nodeId] : {};
    const nextInstances = {
      ...currentInstances,
      [nodeId]: {
        ...base,
        label: base.label || "加载知识库",
        input: patchInputSlots(base.input),
        output: patchOutputSlots(base.output),
      },
    };
    instancesRef.current = nextInstances;
    setNodes(nextNodes);
    setInstances(nextInstances);
    setNodePropDraft((draft) => (
      draft?.id === nodeId ? { ...draft, inputs: patchInputSlots(draft.inputs), outputs: patchOutputSlots(draft.outputs) } : draft
    ));
    saveGraph(nextNodes, edges).catch((e) => setStatus(String(e.message || e)));
  }, [edges, nodes, saveGraph, setNodes, workspaceWritable]);

  const changeContextRunConfig = useCallback((nodeId, config) => {
    if (!workspaceWritable) {
      setStatus("Readonly workspace");
      return;
    }
    const id = String(nodeId || "");
    if (!id) return;
    const serializedSkills = serializeSkillKeys(config?.skillKeys || []);
    const displayType = normalizeContextRunDisplayType(config?.displayType || "markdown");
    const model = String(config?.model || "").trim();
    const includeWorkspace = config?.includeWorkspaceContext === false ? "false" : "true";
    const workspaceContextValue = config?.workspaceContext && typeof config.workspaceContext === "object"
      ? JSON.stringify(config.workspaceContext)
      : "";
    const knowledgeContextValue = config?.knowledgeContext && typeof config.knowledgeContext === "object"
      ? JSON.stringify(config.knowledgeContext)
      : "";
    const patchInputSlots = (slots) => (Array.isArray(slots) ? slots.map((slot) => {
      if (slot?.name === "skillKeys") return { ...slot, default: serializedSkills, value: serializedSkills };
      if (slot?.name === "displayType") return { ...slot, default: displayType, value: displayType };
      if (slot?.name === "includeWorkspaceContext") return { ...slot, default: includeWorkspace, value: includeWorkspace };
      if (slot?.name === "knowledgeContext") return { ...slot, default: knowledgeContextValue, value: knowledgeContextValue };
      if (slot?.name === "workspaceContext") return { ...slot, default: workspaceContextValue, value: workspaceContextValue };
      return slot;
    }) : []);
    const patchOutputSlots = (slots) => (Array.isArray(slots) ? slots.map((slot) => (
      slot?.name === "displayType" ? { ...slot, default: displayType, value: displayType } : slot
    )) : []);
    const task = String(config?.task ?? "");
    const nextNodes = nodes.map((node) => (
      node.id === id
        ? {
            ...node,
            data: {
              ...node.data,
              body: task,
              model,
              inputs: patchInputSlots(node.data?.inputs),
              outputs: patchOutputSlots(node.data?.outputs),
            },
          }
        : node
    ));
    const currentInstances = instancesRef.current || {};
    const base = currentInstances[id] && typeof currentInstances[id] === "object" ? currentInstances[id] : {};
    const nextInstances = {
      ...currentInstances,
      [id]: {
        ...base,
        body: task,
        model,
        input: patchInputSlots(base.input),
        output: patchOutputSlots(base.output),
      },
    };
    instancesRef.current = nextInstances;
    setNodes(nextNodes);
    setInstances(nextInstances);
    setNodePropDraft((draft) => (
      draft?.id === id
        ? { ...draft, body: task, model, inputs: patchInputSlots(draft.inputs), outputs: patchOutputSlots(draft.outputs) }
        : draft
    ));
    saveGraph(nextNodes, edges).catch((e) => setStatus(String(e.message || e)));
  }, [edges, nodes, saveGraph, setNodes, workspaceWritable]);

  const changeScheduledRunConfig = useCallback((nodeId, config) => {
    if (!workspaceWritable) {
      setStatus("Readonly workspace");
      return;
    }
    const serialized = serializeScheduledRunConfig(config);
    const nextNodes = nodes.map((node) => (
      node.id === nodeId
        ? { ...node, data: { ...node.data, body: serialized } }
        : node
    ));
    const currentInstances = instancesRef.current || {};
    const base = currentInstances[nodeId] && typeof currentInstances[nodeId] === "object" ? currentInstances[nodeId] : {};
    const nextInstances = {
      ...currentInstances,
      [nodeId]: {
        ...base,
        body: serialized,
      },
    };
    instancesRef.current = nextInstances;
    skipNextWorkspaceAutosaveRef.current = true;
    setNodes(nextNodes);
    setInstances(nextInstances);
    setNodePropDraft((draft) => (
      draft?.id === nodeId ? { ...draft, body: serialized } : draft
    ));
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

  const closeNodeChat = useCallback(() => setActiveNodeChatId(""), []);

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
    const kind = workspaceDisplayKindFromData(currentNode?.data);
    const isContextRunNode = isOneClickTaskDefinitionId(currentNode?.data?.definitionId);
    const unwrappedContent = displayOutputEnvelopeContent(content);
    const text = kind === "html"
      ? normalizeHtmlDisplayContent(unwrappedContent)
      : kind === "react"
        ? normalizeReactAppDisplayContent(unwrappedContent)
        : String(unwrappedContent || "");
    const currentContent = currentNode ? displayContent(currentNode.data) : "";
    const nextText = mode === "append" && String(currentContent || "").trim()
      ? `${String(currentContent).replace(/\s+$/g, "")}\n\n${text.trim()}`
      : text;
    const primaryName = kind === "image" ? "src" : "content";
    const displayReloadKey = options?.reloadDisplay ? Date.now() : currentNode?.data?.displayReloadKey;
    const patchSlots = (slots) => {
      let patched = false;
      const nextSlots = (Array.isArray(slots) ? slots : []).map((slot) => {
        const name = String(slot?.name || "");
        const type = String(slot?.type || "");
        const isDisplayContentSlot = isContextRunNode
          ? name === primaryName || name === "result" || name === "filePath"
          : name === primaryName || name === "filePath" || type === "text";
        if (!isDisplayContentSlot) {
          return slot;
        }
        if (!patched) {
          patched = true;
          return { ...slot, default: nextText, value: nextText };
        }
        return { ...slot, default: "", value: "" };
      });
      return nextSlots;
    };
    const nextNodes = nodesRef.current.map((node) => {
      if (node.id !== id) return node;
      return {
        ...node,
        data: {
          ...node.data,
          body: isContextRunNode ? node.data.body : nextText,
          ...(displayReloadKey ? { displayReloadKey } : {}),
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
        body: isContextRunNode ? base.body : nextText,
        input: patchSlots(base.input),
        output: patchSlots(base.output),
      },
    };
    instancesRef.current = nextInstances;
    setNodes(nextNodes);
    setInstances(nextInstances);
    setNodePropDraft((draft) => (draft?.id === id ? { ...draft, ...(isContextRunNode ? {} : { body: nextText }) } : draft));
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

  const uploadWorkspaceFile = useCallback(async (file, targetDir = "") => {
    if (!workspaceWritable) {
      setStatus("Readonly workspace");
      return "";
    }
    if (!file) return "";
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("dir", String(targetDir || ""));
      if (flowParams.flowId) form.set("flowId", flowParams.flowId);
      if (flowParams.flowSource) form.set("flowSource", flowParams.flowSource);
      if (flowParams.adminOwnerId) form.set("adminOwnerId", flowParams.adminOwnerId);
      if (flowParams.archived) form.set("archived", "1");
      const res = await fetch("/api/workspace/upload", {
        method: "POST",
        body: form,
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "上传文件失败");
      const savedPath = String(json.path || "").trim();
      if (!savedPath) throw new Error("上传文件失败：未返回路径");
      await loadFiles();
      setCollapsedDirs((prev) => {
        const next = new Set(prev);
        for (const dir of parentDirectoryPaths(savedPath)) next.delete(dir);
        return next;
      });
      setStatus(`已上传 ${savedPath}`);
      return savedPath;
    } catch (e) {
      setStatus(String(e.message || e));
      return "";
    }
  }, [flowParams, loadFiles, workspaceWritable]);

  const uploadWorkspaceImage = useCallback(async (file) => {
    if (!isWorkspaceImageFile(file)) {
      setStatus("请选择图片文件");
      return "";
    }
    return uploadWorkspaceFile(file, "img");
  }, [uploadWorkspaceFile]);

  const triggerWorkspaceFileUpload = useCallback((targetDir = "") => {
    if (!workspaceWritable) {
      setStatus("Readonly workspace");
      return;
    }
    workspaceFileUploadDirRef.current = String(targetDir || "");
    workspaceFileUploadInputRef.current?.click();
  }, [workspaceWritable]);

  const handleWorkspaceFileUploadInput = useCallback(async (event) => {
    const selected = Array.from(event.target.files || []);
    event.target.value = "";
    if (!selected.length) return;
    const targetDir = workspaceFileUploadDirRef.current || "";
    setWorkspaceFileUploading(true);
    try {
      let lastPath = "";
      for (const file of selected) {
        const savedPath = await uploadWorkspaceFile(file, targetDir);
        if (savedPath) lastPath = savedPath;
      }
      if (selected.length > 1) setStatus(`已上传 ${selected.length} 个文件${lastPath ? `，最后一个：${lastPath}` : ""}`);
    } catch (e) {
      setStatus(String(e.message || e));
    } finally {
      setWorkspaceFileUploading(false);
    }
  }, [uploadWorkspaceFile]);

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
    const nodeKind = workspaceDisplayKindFromData(node.data) || "markdown";
    const rawDisplayContent = displayContent(node.data);
    let targetFilePath = displayTextFilePath(rawDisplayContent, nodeKind);
    let currentContent = displayOutputEnvelopeContent(rawDisplayContent);
    if (targetFilePath) {
      try {
        currentContent = await readWorkspaceTextFile(flowParams, targetFilePath);
      } catch (error) {
        setStatus(String(error.message || error));
      }
    } else if (nodeKind !== "image" && String(currentContent || "").trim()) {
      const problem = validateDisplayContentForWrite(nodeKind, currentContent);
      if (problem) {
        setStatus(`${problem} 未进入微调。`);
        return;
      }
      try {
        const materializedPath = await writeWorkspaceTextFile(flowParams, suggestDisplayFilePath(id, node.data), currentContent);
        await loadFiles();
        setDisplayNodeContent(id, materializedPath, "replace", {
          logChat: false,
          reloadDisplay: true,
          statusMessage: `已将展示保存为 ${materializedPath}`,
        });
        targetFilePath = materializedPath;
        currentContent = "";
      } catch (error) {
        setStatus(String(error.message || error));
        return;
      }
    }
    const sourceContext = displayRefineSourceContext(id, nodesRef.current, edgesRef.current);
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
          nodeKind,
          currentContent: targetFilePath ? "" : currentContent,
          sourceContext,
          targetFilePath,
          messages: previousMessages,
          message,
          model: composerModel,
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "节点微调失败");
      const candidateContent = String(json.candidateContent || json.reply || "").trim();
      const directFileEdit = Boolean(json.directFileEdit);
      const artifactPath = String(json.artifactPath || targetFilePath || "").trim();
      if (directFileEdit && artifactPath) {
        const problem = validateDisplayContentForWrite(nodeKind, candidateContent);
        if (problem) throw new Error(`${problem} 文件已由 agent 修改，请检查 ${artifactPath}。`);
        await loadFiles();
        setDisplayNodeContent(id, artifactPath, "replace", {
          logChat: false,
          reloadDisplay: true,
          statusMessage: `已按微调描述更新 ${artifactPath}`,
        });
      } else if (candidateContent) {
        const problem = validateDisplayContentForWrite(nodeKind, candidateContent);
        if (problem) throw new Error(`${problem} 已取消写入，避免覆盖当前展示文件。`);
        if (targetFilePath) {
          const savedPath = await writeWorkspaceTextFile(flowParams, targetFilePath, candidateContent);
          await loadFiles();
          setDisplayNodeContent(id, savedPath, "replace", {
            logChat: false,
            statusMessage: `已按微调描述更新 ${savedPath}`,
          });
        } else {
          setDisplayNodeContent(id, candidateContent, "replace", {
            logChat: false,
            statusMessage: "已按微调描述更新展示内容",
          });
        }
      }
      setNodeChatSessions((sessions) => ({
        ...sessions,
        [id]: {
          ...(sessions[id] || {}),
          sessionId: String(json.sessionId || nextSessionId),
          running: false,
          candidateContent: "",
          messages: [
            ...(((sessions[id]?.messages && Array.isArray(sessions[id].messages)) ? sessions[id].messages : [...previousMessages, userMessage])),
            { role: "assistant", text: (candidateContent || directFileEdit) ? (artifactPath ? `已更新文件 ${artifactPath}。` : "已按你的描述更新当前展示。") : "没有生成可更新的内容。", at: Date.now() },
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
  }, [composerModel, flowParams, loadFiles, nodeChatSessions, setDisplayNodeContent, workspaceWritable]);

  const saveDisplayNodeToFile = useCallback(async (nodeId, data) => {
    if (!workspaceWritable) {
      setStatus("Readonly workspace");
      return;
    }
    const kind = workspaceDisplayKindFromData(data) || "markdown";
    const rawContent = displayContent(data);
    const sourceFilePath = displayTextFilePath(rawContent, kind);
    let content = displayOutputEnvelopeContent(rawContent);
    if (sourceFilePath) {
      try {
        content = await readWorkspaceTextFile(flowParams, sourceFilePath);
      } catch (e) {
        setStatus(String(e.message || e));
        return;
      }
    }
    if (!String(content || "").trim()) {
      setStatus("展示节点没有可保存内容");
      return;
    }
    const problem = validateDisplayContentForWrite(kind, content);
    if (problem) {
      setStatus(`${problem} 未保存文件。`);
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
      setDisplayNodeContent(nodeId, savedPath, "replace", {
        logChat: false,
        statusMessage: `已保存并引用 ${savedPath}`,
      });
      setStatus(`已保存 ${savedPath}`);
    } catch (e) {
      setStatus(String(e.message || e));
    }
  }, [flowParams, loadFiles, setDisplayNodeContent, workspaceWritable]);

  const shareDisplayNode = useCallback((nodeId) => {
    const id = String(nodeId || "").trim();
    if (!id || sharingDisplayNodeId) return;
    const node = nodesRef.current.find((item) => item.id === id);
    if (!node || !workspaceDisplayKindFromData(node?.data)) {
      setStatus("展示节点不可用");
      return;
    }
    const title = String(node.data?.label || node.data?.displayName || id).trim() || "AgentFlow Display";
    setDisplayShareDraft(defaultDisplayShareDraft({ title, layout: "single", nodeIds: [id], mode: "single-node", sourceNodeId: id }));
    setDisplayShareError("");
    setDisplayShareResult(null);
    setDisplayShareOpen(true);
  }, [sharingDisplayNodeId]);

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

  const setProvideNodeValue = useCallback((nodeId, value) => {
    const id = String(nodeId || "");
    if (!id || !workspaceWritable) return;
    setNodes((list) => list.map((node) => {
      if (node.id !== id) return node;
      const outputs = Array.isArray(node.data?.outputs) && node.data.outputs.length
        ? node.data.outputs.map((slot, index) => index === 0 ? { ...slot, default: value, value } : slot)
        : [{ type: "file", name: "value", default: value, value }];
      return { ...node, data: { ...node.data, body: "", outputs } };
    }));
    syncNodePropDraft(id, (draft) => {
      const outputs = Array.isArray(draft?.outputs) && draft.outputs.length
        ? draft.outputs.map((slot, index) => index === 0 ? { ...slot, default: value, value } : slot)
        : [{ type: "file", name: "value", default: value, value }];
      return { body: "", outputs };
    });
    setStatus(`已选择文件 ${value}`);
  }, [setNodes, syncNodePropDraft, workspaceWritable]);

  const openProvideFilePicker = useCallback((nodeId) => {
    setProvideFilePicker({ nodeId: String(nodeId || ""), query: "" });
  }, []);

  const closeProvideFilePicker = useCallback(() => {
    setProvideFilePicker({ nodeId: "", query: "" });
  }, []);

  const selectProvideFile = useCallback((file) => {
    const path = String(file?.path || "").trim();
    if (!path || !provideFilePicker.nodeId) return;
    setProvideNodeValue(provideFilePicker.nodeId, path);
    closeProvideFilePicker();
  }, [closeProvideFilePicker, provideFilePicker.nodeId, setProvideNodeValue]);

  const cleanupWorkspaceNodeOutputs = useCallback(async (nodeId, data) => {
    if (!workspaceWritable) return;
    const outputPaths = workspaceNodeOwnedOutputPaths(nodeId, data);
    if (outputPaths.length === 0) return;
    const deleted = [];
    try {
      for (const outputPath of outputPaths) {
        const res = await fetch("/api/workspace/delete", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...flowParams, path: outputPath }),
        });
        if (res.status === 404) continue;
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || "清理节点输出失败");
        deleted.push(json.path || outputPath);
      }
      if (deleted.length === 0) return;
      setStatus(`已清理 ${deleted.join(", ")}`);
      await loadFiles();
      setSelectedWorkspaceFilePath((current) => (
        outputPaths.some((outputPath) => current === outputPath || current.startsWith(`${outputPath}/`)) ? "" : current
      ));
    } catch (e) {
      setStatus(String(e.message || e));
    }
  }, [flowParams, loadFiles, workspaceWritable]);

  const suppressWorkspaceSelectionAutosave = useCallback((patch = {}) => {
    const current = workspaceAutosaveSuppressedStateRef.current || {
      nodes: nodesRef.current,
      edges: edgesRef.current,
      displayPage: displayPageRef.current,
    };
    workspaceAutosaveSuppressedStateRef.current = {
      ...current,
      ...patch,
      displayPage: displayPageRef.current,
    };
  }, []);

  const hydratedNodeCommonData = useMemo(() => ({
    modelLists,
    showBodyPreview: true,
    flowParams,
    readOnly: !workspaceWritable,
    onRunWorkspaceNode: runWorkspaceNode,
    onStopWorkspaceNode: stopWorkspaceRun,
    onOpenWorkspaceRunLogs: openWorkspaceRunLogs,
    onOptimizeWorkspaceRun: optimizeWorkspaceRun,
    onOptimizeWorkspaceSchedule: optimizeWorkspaceRun,
    runningRunNodeIds,
    onChangeScheduledRunConfig: changeScheduledRunConfig,
    onChangeContextRunConfig: changeContextRunConfig,
    skills,
    skillCollections,
    onChangeLoadSkillKeys: changeLoadSkillKeys,
    onRefreshSkills: refreshSkills,
    mcpServers,
    onChangeLoadMcpNames: changeLoadMcpNames,
    onRefreshMcps: refreshMcps,
    workspaceTargets,
    onChangeLoadWorkspace: changeLoadWorkspace,
    onRefreshWorkspaces: refreshWorkspaces,
    onSaveDisplayNodeToFile: saveDisplayNodeToFile,
    onShareDisplayNode: shareDisplayNode,
    onOpenDisplayPreview: setDisplayPreviewNodeId,
    onRefreshNodeInternals: refreshNodeInternals,
    onEnsureWorkspaceNodeDisplaySize: ensureWorkspaceNodeDisplaySize,
    sharingDisplayNodeId,
    onUploadWorkspaceImage: uploadWorkspaceImage,
    onUploadImageToDisplayNode: uploadImageToDisplayNode,
    onOpenProvideFilePicker: openProvideFilePicker,
    onStatus: setStatus,
    onSetDisplayNodeContent: setDisplayNodeContent,
    onToggleNodeChat: toggleNodeChat,
    onCloseNodeChat: closeNodeChat,
    onUpdateNodeChatDraft: updateNodeChatDraft,
    onSendNodeChat: sendNodeChat,
    onSyncNodePropDraft: syncNodePropDraft,
    onCleanupWorkspaceNodeOutputs: cleanupWorkspaceNodeOutputs,
    onSuppressWorkspaceSelectionAutosave: suppressWorkspaceSelectionAutosave,
  }), [changeContextRunConfig, changeLoadMcpNames, changeLoadSkillKeys, changeLoadWorkspace, changeScheduledRunConfig, cleanupWorkspaceNodeOutputs, closeNodeChat, ensureWorkspaceNodeDisplaySize, flowParams, mcpServers, modelLists, openProvideFilePicker, openWorkspaceRunLogs, optimizeWorkspaceRun, refreshMcps, refreshNodeInternals, refreshSkills, refreshWorkspaces, runWorkspaceNode, runningRunNodeIds, saveDisplayNodeToFile, sendNodeChat, setDisplayNodeContent, shareDisplayNode, sharingDisplayNodeId, skillCollections, skills, stopWorkspaceRun, suppressWorkspaceSelectionAutosave, syncNodePropDraft, toggleNodeChat, updateNodeChatDraft, uploadImageToDisplayNode, uploadWorkspaceImage, workspaceTargets, workspaceWritable]);

  const connectedWorkspaceNodeIds = useMemo(() => {
    const ids = new Set();
    for (const edge of edges) {
      if (edge?.source) ids.add(String(edge.source));
      if (edge?.target) ids.add(String(edge.target));
    }
    return ids;
  }, [edges]);

  const hydratedNodeCacheRef = useRef(new Map());
  const hydratedNodes = useMemo(() => {
    const cache = hydratedNodeCacheRef.current;
    const seen = new Set();
    const nextNodes = nodes.map((node) => {
      const runtime = {
        selected: node.selected === true,
        hasConnections: connectedWorkspaceNodeIds.has(node.id),
        isExecuting: workspaceExecutingNodes.has(node.id),
        nodeStatus: workspaceNodeRunStatus[node.id]?.status ?? null,
        nodeElapsed: workspaceNodeRunStatus[node.id]?.elapsed ?? null,
        nodeRunDetail: workspaceNodeRunStatus[node.id]?.detail ?? null,
        optimizingRun: optimizingRunNodeId === node.id,
        scheduledRunState: scheduledRunState[node.id] || null,
        nodeChatActive: activeNodeChatId === node.id,
        nodeChat: nodeChatSessions[node.id] || null,
      };
      const cached = cache.get(node.id);
      if (
        cached &&
        cached.source === node &&
        cached.commonData === hydratedNodeCommonData &&
        workspaceHydratedNodeRuntimeEqual(cached.runtime, runtime)
      ) {
        seen.add(node.id);
        return cached.node;
      }
      const canReuseHydratedData = Boolean(
        cached &&
        cached.source?.data === node.data &&
        cached.commonData === hydratedNodeCommonData &&
        workspaceHydratedNodeRuntimeEqual(cached.runtime, runtime)
      );
      const hydrated = {
        ...node,
        data: canReuseHydratedData
          ? cached.node.data
          : {
              ...node.data,
              ...hydratedNodeCommonData,
              ...runtime,
            },
      };
      cache.set(node.id, { source: node, commonData: hydratedNodeCommonData, runtime, node: hydrated });
      seen.add(node.id);
      return hydrated;
    });
    for (const id of cache.keys()) {
      if (!seen.has(id)) cache.delete(id);
    }
    return nextNodes;
  }, [activeNodeChatId, connectedWorkspaceNodeIds, hydratedNodeCommonData, nodeChatSessions, nodes, optimizingRunNodeId, scheduledRunState, workspaceExecutingNodes, workspaceNodeRunStatus]);

  const isDisplayMode = workspaceMode === "display";
  const isWorkflowMode = workspaceMode === "workflow";
  const displaySourceNodeById = useMemo(
    () => (
      isDisplayMode
        ? new Map(hydratedNodes.map((node) => [node.id, node]))
        : EMPTY_DISPLAY_SOURCE_NODES
    ),
    [hydratedNodes, isDisplayMode],
  );
  const displayPreviewNode = useMemo(
    () => (
      displayPreviewNodeId
        ? hydratedNodes.find((node) => node.id === displayPreviewNodeId) || null
        : null
    ),
    [displayPreviewNodeId, hydratedNodes],
  );

  const displayCanvasNodeCacheRef = useRef(new Map());
  const displayCanvasNodes = useMemo(() => {
    if (!isDisplayMode) {
      displayCanvasNodeCacheRef.current.clear();
      return EMPTY_DISPLAY_CANVAS_NODES;
    }
    const selected = new Set(selectedDisplayNodeIds);
    const cache = displayCanvasNodeCacheRef.current;
    const seen = new Set();
    const groupNodes = Array.from(displaySourceNodeById.values())
      .filter(isWorkspaceGroupNode)
      .map((sourceGroup) => {
        const group = {
          id: sourceGroup.id,
          title: sourceGroup.data?.title || sourceGroup.data?.label || "Group",
          color: sourceGroup.data?.color || "purple",
          nodeIds: sourceGroup.data?.nodeIds || [],
        };
        const bounds = displayGroupBounds(group, displayPage, displaySourceNodeById);
        if (!bounds) return null;
        return {
          ...sourceGroup,
          id: displayGroupRefNodeId(sourceGroup.id),
          position: bounds.position,
          width: bounds.size.width,
          height: bounds.size.height,
          selected: false,
          draggable: false,
          selectable: false,
          zIndex: 0,
          data: {
            ...sourceGroup.data,
            nodeIds: bounds.memberIds,
            nodeSize: bounds.size,
            readOnly: true,
            displayPageMode: true,
          },
        };
      })
      .filter(Boolean);
    const result = displayPage.nodeIds
      .map((sourceId, index) => {
        const sourceNode = displaySourceNodeById.get(sourceId);
        if (!sourceNode || !workspaceDisplayKindFromData(sourceNode.data)) return null;
        const fallbackSize = persistedWorkspaceNodeSize(sourceNode) || { width: 520, height: 320 };
        const size = normalizeWorkspaceNodeSize(displayPage.nodeSizes[sourceId] || fallbackSize, { display: true }) || fallbackSize;
        const position = displayPage.nodePositions[sourceId] || { x: 180 + index * 36, y: 120 + index * 28 };
        const isSelected = selected.has(sourceId);
        const cached = cache.get(sourceId);
        if (
          cached &&
          cached.source === sourceNode &&
          cached.position?.x === position.x &&
          cached.position?.y === position.y &&
          cached.size?.width === size.width &&
          cached.size?.height === size.height &&
          cached.selected === isSelected
        ) {
          seen.add(sourceId);
          return cached.node;
        }
        const displayNode = {
          ...sourceNode,
          id: displayRefNodeId(sourceId),
          position,
          selected: isSelected,
          width: size.width,
          height: size.height,
          data: {
            ...sourceNode.data,
            sourceNodeId: sourceId,
            displayPageMode: true,
            readOnly: true,
            selected: isSelected,
            displaySize: size,
            nodeSize: size,
          },
        };
        cache.set(sourceId, { source: sourceNode, position, size, selected: isSelected, node: displayNode });
        seen.add(sourceId);
        return displayNode;
      })
      .filter(Boolean);
    for (const sourceId of cache.keys()) {
      if (!seen.has(sourceId)) cache.delete(sourceId);
    }
    return [...groupNodes, ...result];
  }, [displayPage, displaySourceNodeById, isDisplayMode, selectedDisplayNodeIds]);

  const availableDisplayNodes = useMemo(
    () => hydratedNodes.filter((node) => workspaceDisplayKindFromData(node?.data)),
    [hydratedNodes],
  );

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
    if (isDisplayMode || isWorkflowMode || !workspaceViewport) return undefined;
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
  }, [isDisplayMode, isWorkflowMode, reactFlow, workspaceViewport]);

  useEffect(() => {
    if (!isWorkflowMode) return;
    void loadPrdWorkflowSnapshot(workflowTapdId);
  }, [isWorkflowMode]);

  useEffect(() => {
    if (!isWorkflowMode) return;
    setWorkflowProjectBindingError("");
    void loadWorkflowProjectBindings().catch((bindingError) => {
      setWorkflowProjectBindings([]);
      setWorkflowAvailableProjects([]);
      setWorkflowProjectBindingError(String(bindingError.message || bindingError));
    });
  }, [isWorkflowMode, loadWorkflowProjectBindings]);

  useEffect(() => {
    if (!isWorkflowMode || !workflowTapdId || flowParams.workflowDemo) return undefined;
    const q = flowParamsQuery(flowParams);
    q.set("tapdId", workflowTapdId);
    let events = null;
    let reconnectTimer = null;
    let cancelled = false;

    const closeEvents = () => {
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (!events) return;
      events.onmessage = null;
      events.onerror = null;
      events.close();
      events = null;
    };
    const connect = () => {
      if (cancelled || document.hidden || events) return;
      events = new EventSource(`/api/prd-workflow/events?${q.toString()}`);
      events.onmessage = () => {
        void loadPrdWorkflowSnapshot(workflowTapdId);
      };
      events.onerror = () => {
        closeEvents();
        if (!cancelled && !document.hidden) {
          reconnectTimer = window.setTimeout(connect, 5000);
        }
      };
    };
    const handleVisibilityChange = () => {
      if (document.hidden) {
        closeEvents();
        return;
      }
      void loadPrdWorkflowSnapshot(workflowTapdId);
      connect();
    };

    connect();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      closeEvents();
    };
  }, [flowParams, isWorkflowMode, loadPrdWorkflowSnapshot, workflowTapdId]);

  useEffect(() => {
    if (!flowParams.flowId || isWorkflowMode) return undefined;
    const q = flowParamsQuery(flowParams);
    q.set("clientId", collaborationClientIdRef.current);
    let events = null;
    let reconnectTimer = null;
    let cancelled = false;

    const closeEvents = () => {
      if (reconnectTimer) {
        window.clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      if (!events) return;
      events.onmessage = null;
      events.onerror = null;
      events.close();
      events = null;
    };
    const connect = () => {
      if (cancelled || document.hidden || events) return;
      events = new EventSource(`/api/workspace/events?${q.toString()}`);
      events.onmessage = (message) => {
        let event = null;
        try { event = JSON.parse(message.data || "{}"); } catch { event = null; }
        if (!event || event.clientId === collaborationClientIdRef.current) return;
        if (event.type === "graph.committed") {
          scheduleWorkspaceRemoteRefresh(event);
          return;
        }
        if (event.type === "runtime.committed") {
          scheduleWorkspaceRemoteRefresh(event);
          return;
        }
        if (String(event.type || "").startsWith("file.")) {
          void loadFiles();
          return;
        }
        if (String(event.type || "").startsWith("run.")) {
          void refreshWorkspaceRunStatus();
        }
      };
      events.onerror = () => {
        closeEvents();
        if (!cancelled && !document.hidden) {
          reconnectTimer = window.setTimeout(connect, 5000);
        }
      };
    };
    const handleVisibilityChange = () => {
      if (document.hidden) {
        closeEvents();
        return;
      }
      scheduleWorkspaceRemoteRefresh({ type: "visibility.resume" });
      connect();
    };

    connect();
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      closeEvents();
      if (workspaceRemoteRefreshTimerRef.current) {
        window.clearTimeout(workspaceRemoteRefreshTimerRef.current);
        workspaceRemoteRefreshTimerRef.current = null;
      }
      workspaceRemoteRefreshQueuedRef.current = false;
    };
  }, [flowParams, isWorkflowMode, loadFiles, refreshWorkspaceRunStatus, scheduleWorkspaceRemoteRefresh]);

  useEffect(() => {
    if (workspaceCanvasInteractionActiveRef.current) return undefined;
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
    refreshNodeInternals(changedIds);
    return undefined;
  }, [displayCanvasNodes, hydratedNodes, refreshNodeInternals]);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId) || null,
    [nodes, selectedNodeId],
  );
  const selectedNodePropSnapshotRef = useRef({ id: "", draft: null });
  const selectedNodePropSignature = useMemo(() => {
    const draft = nodeToPropDraft(selectedNode);
    return draft ? JSON.stringify(draft) : "";
  }, [selectedNode?.data, selectedNode?.id]);

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
    nodePropDraft?.scriptRef,
    nodePropDraft?.implementationRef,
    nodePropDraft?.implementationMode,
    JSON.stringify(nodePropDraft?.inputs || []),
    JSON.stringify(nodePropDraft?.outputs || []),
    applyNodeProperties,
    selectedNode?.id,
    workspaceWritable,
  ]);

  const edgeNodeDataCacheRef = useRef({ refs: new Map(), nodeDataById: new Map() });
  const edgeNodeDataById = useMemo(() => {
    const previous = edgeNodeDataCacheRef.current;
    let changed = previous.refs.size !== nodes.length;
    const nextRefs = new Map();
    for (const node of nodes) {
      nextRefs.set(node.id, node.data);
      if (!previous.refs.has(node.id) || previous.refs.get(node.id) !== node.data) changed = true;
    }
    if (!changed) return previous.nodeDataById;
    const nodeDataById = new Map(nodes.map((node) => [node.id, node.data]));
    edgeNodeDataCacheRef.current = { refs: nextRefs, nodeDataById };
    return nodeDataById;
  }, [nodes]);

  const coloredEdges = useMemo(() => {
    return edges.map((edge) => {
      const srcData = edgeNodeDataById.get(edge.source);
      const tgtData = edgeNodeDataById.get(edge.target);
      const sm = /^output-(\d+)$/.exec(edge.sourceHandle || "");
      const tm = /^input-(\d+)$/.exec(edge.targetHandle || "");
      const srcSlot = srcData && sm ? srcData.outputs?.[parseInt(sm[1], 10)] : null;
      const tgtSlot = tgtData && tm ? tgtData.inputs?.[parseInt(tm[1], 10)] : null;
      const hue = srcSlot?.type ? getHandleColor(srcSlot.type) : tgtSlot?.type ? getHandleColor(tgtSlot.type) : "";
      if (!hue) return edge;
      return {
        ...edge,
        style: { ...(edge.style || {}), stroke: hue, strokeWidth: 2 },
        markerEnd: { type: MarkerType.ArrowClosed, color: hue },
      };
    });
  }, [edgeNodeDataById, edges]);

  const canvasNodes = isDisplayMode ? displayCanvasNodes : hydratedNodes;
  const canvasEdges = isDisplayMode ? [] : coloredEdges;
  const canvasNodesRef = useRef(canvasNodes);
  const transientCanvasNodesRef = useRef([]);
  const pendingTransientCanvasNodeChangesRef = useRef([]);
  const transientCanvasFrameRef = useRef(null);
  if (!workspaceCanvasInteractionActiveRef.current) {
    canvasNodesRef.current = canvasNodes;
  }
  const jumpPaletteNodes = useMemo(() => (
    isDisplayMode
      ? displayCanvasNodes
        .filter((node) => !isWorkspaceGroupNode(node))
        .map((node) => ({ ...node, id: sourceIdFromDisplayRefId(node.id) }))
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

  useEffect(() => {
    const focusNodeId = String(initialFocusNodeIdRef.current || "").trim();
    if (!focusNodeId || !loadedRef.current || workspaceMode !== "workspace") return;
    if (!hydratedNodes.some((node) => node.id === focusNodeId)) return;
    initialFocusNodeIdRef.current = "";
    skipNextWorkspaceAutosaveRef.current = true;
    jumpToWorkspaceNodeById(focusNodeId);
  }, [hydratedNodes, jumpToWorkspaceNodeById, workspaceMode]);

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
      try {
        window.localStorage.setItem(workspaceViewportStorageKey, JSON.stringify(normalized));
      } catch {
        /* ignore storage */
      }
      setStatus("已固定 Workspace 进入视角");
      return;
    }
    saveGraph(nodesRef.current, edgesRef.current).catch((e) => setStatus(String(e.message || e)));
  }, [isDisplayMode, reactFlow, saveGraph, workspaceViewportStorageKey]);

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

  const selectedWorkspaceFile = useMemo(
    () => findWorkspaceFileItem(files, selectedWorkspaceFilePath),
    [files, selectedWorkspaceFilePath],
  );
  const selectedWorkspaceTargetDir = selectedWorkspaceFile?.type === "directory"
    ? selectedWorkspaceFile.path
    : workspaceParentDir(selectedWorkspaceFile?.path || "");
  const clearWorkspaceFileSelection = useCallback((event) => {
    if (event.target?.closest?.(".af-work-file")) return;
    setSelectedWorkspaceFilePath("");
  }, []);

  const modelOptions = [
    ...(modelLists.cursor || []).map((m) => ({ label: `Cursor · ${m.split(" - ")[0]}`, value: `cursor:${m.split(" - ")[0]}` })),
    ...(modelLists.opencode || []).map((m) => ({ label: `OpenCode · ${m.split(" - ")[0]}`, value: `opencode:${m.split(" - ")[0]}` })),
    ...(modelLists.claudeCode || []).map((m) => ({ label: `Claude · ${m.split(" - ")[0]}`, value: `claude-code:${m.split(" - ")[0]}` })),
    ...(modelLists.codex || []).map((m) => ({ label: `Codex · ${m.split(" - ")[0]}`, value: `codex:${m.split(" - ")[0]}` })),
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

  const createWorkspaceGroupFromSelection = useCallback(() => {
    if (isDisplayMode) return;
    if (!workspaceWritable) {
      setStatus("Readonly workspace");
      return;
    }
    const selectedNodes = (nodesRef.current || []).filter((node) => node?.selected && !isWorkspaceGroupNode(node));
    if (selectedNodes.length < 2) {
      setStatus("选择至少两个节点后按 G 创建 Group");
      return;
    }
    const bounds = selectedNodes.reduce((acc, node) => {
      const x = Number(node.position?.x || 0);
      const y = Number(node.position?.y || 0);
      const width = Number(node.measured?.width || node.width || node.data?.nodeSize?.width || node.data?.displaySize?.width || DEFAULT_WORKSPACE_NODE_WIDTH);
      const height = Number(node.measured?.height || node.height || node.data?.nodeSize?.height || node.data?.displaySize?.height || MIN_WORKSPACE_NODE_HEIGHT);
      return {
        minX: Math.min(acc.minX, x),
        minY: Math.min(acc.minY, y),
        maxX: Math.max(acc.maxX, x + width),
        maxY: Math.max(acc.maxY, y + height),
      };
    }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
    if (!Number.isFinite(bounds.minX) || !Number.isFinite(bounds.minY)) return;
    const used = new Set((nodesRef.current || []).map((node) => node.id));
    let index = 1;
    let id = `group_${index}`;
    while (used.has(id)) {
      index += 1;
      id = `group_${index}`;
    }
    const size = normalizeWorkspaceGroupSize({
      width: bounds.maxX - bounds.minX + WORKSPACE_GROUP_PADDING * 2,
      height: bounds.maxY - bounds.minY + WORKSPACE_GROUP_PADDING * 2,
    }) || { width: MIN_WORKSPACE_GROUP_WIDTH, height: MIN_WORKSPACE_GROUP_HEIGHT };
    const groupNode = {
      id,
      type: FLOW_NODE_TYPE,
      position: { x: bounds.minX - WORKSPACE_GROUP_PADDING, y: bounds.minY - WORKSPACE_GROUP_PADDING },
      width: size.width,
      height: size.height,
      selected: true,
      draggable: true,
      selectable: true,
      zIndex: 0,
      data: {
        isWorkspaceGroup: true,
        label: workspaceGroupTitle(index - 1),
        title: workspaceGroupTitle(index - 1),
        color: "purple",
        nodeIds: selectedNodes.map((node) => node.id),
        nodeSize: size,
      },
    };
    setNodes((list) => [groupNode, ...list.map((node) => ({ ...node, selected: false }))]);
    setEdges((list) => list.map((edge) => ({ ...edge, selected: false })));
    setSelectedNodeId("");
    setStatus(`Created group for ${selectedNodes.length} nodes`);
  }, [isDisplayMode, setEdges, setNodes, workspaceWritable]);

  const workspaceDisplayNodes = useMemo(
    () => nodes.filter((node) => workspaceDisplayKindFromData(node?.data)),
    [nodes],
  );

  const selectedWorkspaceDisplayNodeIds = useMemo(
    () => selectedCanvasNodes.filter((node) => workspaceDisplayKindFromData(node?.data)).map((node) => node.id),
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

  const openWorkflowProjectView = useCallback((project, mode = "workspace") => {
    if (!project?.flowId) return;
    const q = flowParamsQuery({
      ...flowParams,
      flowId: project.flowId,
      flowSource: project.flowSource || "user",
      workspaceId: project.workspaceId || "",
      archived: project.archived === true,
      workflowShare: "",
      workflowDemo: false,
    });
    const nextMode = mode === "display" ? "display" : mode === "workflow" ? "workflow" : "workspace";
    if (nextMode !== "workspace") q.set("view", nextMode);
    if (workflowTapdId.trim()) q.set("tapdId", workflowTapdId.trim());
    window.location.assign(`/workspace?${q.toString()}`);
  }, [flowParams, workflowTapdId]);

  const switchWorkspaceMode = useCallback((mode) => {
    const nextMode = mode === "display" ? "display" : mode === "workflow" ? "workflow" : "workspace";
    if (isWorkflowMode && !flowParams.flowId && nextMode !== "workflow") {
      if (workflowProjectBindings.length === 1) {
        openWorkflowProjectView(workflowProjectBindings[0], nextMode);
      } else {
        setWorkflowProjectPendingMode(nextMode);
        setWorkflowProjectBindingOpen(true);
      }
      return;
    }
    setWorkspaceMode(nextMode);
    setSelectedNodeId("");
    setSelectedDisplayNodeIds([]);
    setConnectionMenu(null);
    setQuickAddOpen(false);
    setDisplayPickerOpen(false);
    const q = flowParamsQuery(flowParams);
    if (nextMode === "display") q.set("view", "display");
    if (nextMode === "workflow") {
      q.set("view", "workflow");
      if (workflowTapdId.trim()) q.set("tapdId", workflowTapdId.trim());
    }
    const url = `/workspace${q.toString() ? `?${q.toString()}` : ""}`;
    window.history.pushState({}, "", url);
  }, [flowParams, isWorkflowMode, openWorkflowProjectView, workflowProjectBindings, workflowTapdId]);

  const addDisplayPageNode = useCallback((sourceId) => {
    const id = String(sourceId || "").trim();
    if (!id) return;
    const sourceNode = nodesRef.current.find((node) => node.id === id);
    if (!sourceNode || !workspaceDisplayKindFromData(sourceNode.data)) {
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
          <small>{workspaceDisplayKindFromData(node.data)} · {node.id}</small>
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
    const insertedNodeIds = flow.nodes.map((node) => node.id);
    const insertedNodes = flow.nodes.map((node) => ({ ...node, selected: true }));
    instancesRef.current = { ...instancesRef.current, ...flow.instances };
    setInstances(instancesRef.current);
    setNodes((list) => [...list.map((node) => ({ ...node, selected: false })), ...insertedNodes]);
    setEdges((list) => [
      ...list.map((edge) => ({ ...edge, selected: false })),
      ...flow.edges.map((edge) => ({ ...edge, selected: false })),
    ]);
    setSelectedNodeId("");
    setSelectedDisplayNodeIds([]);
    setStatus(`已添加流程片段：${snippetEntry.displayName || snippetEntry.id}（已选中 ${insertedNodeIds.length} 个节点）`);
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

  const shareWorkspaceWithUser = useCallback(async () => {
    const username = workspaceShareUsername.trim();
    if (!username) return;
    setWorkspaceShareBusy(true);
    setWorkspaceShareError("");
    try {
      const res = await fetch("/api/workspace/collaboration/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...flowParams, username, role: "editor" }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "添加协作成员失败");
      setWorkspaceCollaboration(json.workspace || null);
      setWorkspaceShareUsername("");
      setStatus(`已将 Workspace 分享给 ${json.member?.username || username}`);
    } catch (e) {
      setWorkspaceShareError(String(e.message || e));
    } finally {
      setWorkspaceShareBusy(false);
    }
  }, [flowParams, workspaceShareUsername]);

  const openWorkspaceShareDialog = useCallback(() => {
    setWorkspaceShareError("");
    setWorkspaceShareOpen(true);
    fetch("/api/teams/me")
      .then((response) => response.json().then((payload) => ({ response, payload })))
      .then(({ response, payload }) => {
        if (!response.ok) throw new Error(payload.error || "读取团队失败");
        const nextTeam = payload.team || null;
        setWorkspaceShareTeam(nextTeam);
        const existing = workspaceCollaboration?.teamShares?.find((share) => share.teamId === nextTeam?.id);
        setWorkspaceShareTeamRole(existing?.role === "editor" ? "editor" : "viewer");
      })
      .catch((error) => setWorkspaceShareError(String(error.message || error)));
  }, [workspaceCollaboration?.teamShares]);

  const updateWorkspaceTeamShare = useCallback(async (remove = false) => {
    if (!workspaceShareTeam?.id) return;
    setWorkspaceShareTeamBusy(true);
    setWorkspaceShareError("");
    try {
      const response = await fetch("/api/workspace/collaboration/team-share", {
        method: remove ? "DELETE" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...flowParams, teamId: workspaceShareTeam.id, role: workspaceShareTeamRole }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || (remove ? "取消团队分享失败" : "分享到团队失败"));
      setWorkspaceCollaboration(payload.workspace || null);
      setStatus(remove ? `已取消对「${workspaceShareTeam.name}」的分享` : `已分享到「${workspaceShareTeam.name}」`);
    } catch (error) {
      setWorkspaceShareError(String(error.message || error));
    } finally {
      setWorkspaceShareTeamBusy(false);
    }
  }, [flowParams, workspaceShareTeam, workspaceShareTeamRole]);

  const removeWorkspaceSharedMember = useCallback(async (member) => {
    const memberUserId = String(member?.userId || "").trim();
    if (!memberUserId || memberUserId === workspaceCollaboration?.ownerId) return;
    setWorkspaceShareRemovingUserId(memberUserId);
    setWorkspaceShareError("");
    try {
      const res = await fetch("/api/workspace/collaboration/share", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...flowParams, memberUserId }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "取消成员分享失败");
      setWorkspaceCollaboration(json.workspace || null);
      setStatus(`已取消对 ${member?.username || memberUserId} 的分享`);
    } catch (error) {
      setWorkspaceShareError(String(error.message || error));
    } finally {
      setWorkspaceShareRemovingUserId("");
    }
  }, [flowParams, workspaceCollaboration?.ownerId]);

  const backupDraftAndReloadWorkspace = useCallback(async () => {
    const graph = flowToGraph(nodesRef.current, edgesRef.current, instancesRef.current);
    graph.ui = {
      ...(graph.ui || {}),
      ...(workspaceViewportRef.current ? { viewport: workspaceViewportRef.current } : {}),
      displayPage: displayPageForGraph(displayPageRef.current, nodesRef.current),
    };
    const blob = new Blob([`${JSON.stringify(graph, null, 2)}\n`], { type: "application/json" });
    const href = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = href;
    anchor.download = `${flowParams.flowId || "workspace"}-conflict-draft-${Date.now()}.json`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(href);
    await loadWorkspace();
    setWorkspaceConflict(null);
    setWorkspaceConflictOpen(false);
    setStatus("已备份本地草稿并载入远端最新版本");
  }, [edgesRef, flowParams.flowId, loadWorkspace, nodesRef]);

  const resolveWorkspaceConflict = useCallback(async () => {
    const conflictItems = Array.isArray(workspaceConflict?.conflictItems)
      ? workspaceConflict.conflictItems
      : [];
    if (!conflictItems.length || !workspaceConflict?.mergeGraph || !workspaceConflict?.currentGraph) {
      setWorkspaceConflictError("当前冲突缺少字段合并数据，请改用“备份并载入远端”。");
      return;
    }
    let resolvedGraph = workspaceConflict.mergeGraph;
    try {
      conflictItems.forEach((item, index) => {
        const choice = workspaceConflictChoices[String(index)] || { mode: "local" };
        let value;
        let exists = true;
        if (choice.mode === "remote") {
          value = item.current;
          exists = item.hasCurrent !== false;
        } else if (choice.mode === "manual") {
          value = JSON.parse(String(choice.manual || ""));
        } else {
          value = item.incoming;
          exists = item.hasIncoming !== false;
        }
        resolvedGraph = applyWorkspaceConflictPath(resolvedGraph, item.pathParts, value, exists);
      });
    } catch (error) {
      setWorkspaceConflictError(`手动值不是有效 JSON：${String(error.message || error)}`);
      return;
    }

    setWorkspaceConflictBusy(true);
    setWorkspaceConflictError("");
    setWorkspaceSyncPhase("saving");
    setWorkspaceSyncDetail("正在提交冲突解决结果");
    const queuedResolve = workspaceSaveChainRef.current
      .catch(() => undefined)
      .then(async () => {
        const res = await fetch("/api/workspace/graph", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...flowParams,
            graph: resolvedGraph,
            baseRevision: workspaceConflict.currentRevision,
            baseGraph: workspaceConflict.currentGraph,
            clientId: collaborationClientIdRef.current,
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          if (res.status === 409 && Array.isArray(json.conflictItems)) {
            const conflictItemsNext = json.conflictItems;
            setWorkspaceConflict({
              currentRevision: String(json.currentRevision || ""),
              message: json.error || "Workspace 再次出现冲突",
              conflictPaths: Array.isArray(json.conflictPaths) ? json.conflictPaths : [],
              conflictItems: conflictItemsNext,
              mergeGraph: json.mergeGraph || null,
              currentGraph: json.currentGraph || null,
            });
            setWorkspaceConflictChoices(Object.fromEntries(conflictItemsNext.map((item, index) => [
              String(index),
              { mode: "local", manual: workspaceConflictManualText(item) },
            ])));
          }
          throw new Error(json.error || "提交冲突解决结果失败");
        }
        await loadWorkspace();
        setWorkspaceConflict(null);
        setWorkspaceConflictOpen(false);
        setStatus("冲突已解决并保存");
      });
    workspaceSaveChainRef.current = queuedResolve;
    try {
      await queuedResolve;
    } catch (error) {
      setWorkspaceConflictError(String(error.message || error));
      setWorkspaceSyncPhase("error");
      setWorkspaceSyncDetail(String(error.message || error));
    } finally {
      setWorkspaceConflictBusy(false);
    }
  }, [flowParams, loadWorkspace, workspaceConflict, workspaceConflictChoices]);

  const openDisplayShareDialog = useCallback(() => {
    if (workspaceDisplayNodes.length === 0) {
      setStatus("当前 workspace 没有 display 节点");
      return;
    }
    const defaultNodeIds = selectedWorkspaceDisplayNodeIds.length > 0 ? selectedWorkspaceDisplayNodeIds : workspaceDisplayNodes.map((node) => node.id);
    const title = flowParams.flowId ? `${flowParams.flowId} 展示页` : "AgentFlow Display";
    setDisplayShareDraft(defaultDisplayShareDraft({ title, layout: "gallery", nodeIds: defaultNodeIds, mode: "multi-node" }));
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

  const loadDisplayShares = useCallback(async () => {
    setDisplaySharesLoading(true);
    setDisplaySharesError("");
    try {
      const res = await fetch("/api/display/shares");
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || "读取分享列表失败");
      setDisplayShares(Array.isArray(json.shares) ? json.shares : []);
    } catch (e) {
      setDisplaySharesError(String(e.message || e));
      setDisplayShares([]);
    } finally {
      setDisplaySharesLoading(false);
    }
  }, []);

  const openDisplaySharesPanel = useCallback(() => {
    setDisplaySharesOpen(true);
    setDisplayShareCopyId("");
    void loadDisplayShares();
  }, [loadDisplayShares]);

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
          ...displayShareExpiryPayload(displayShareDraft),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.ok === false) throw new Error(json.error || "发布展示页失败");
      const absoluteUrl = new URL(json.url || `/display/${json.share?.id || ""}`, window.location.origin).href;
      setDisplayShareResult({ ...json, absoluteUrl });
      setStatus(json.share?.expiresAt ? "展示页已生成" : "展示页已生成：永久有效");
      if (displaySharesOpen) void loadDisplayShares();
    } catch (e) {
      setDisplayShareError(String(e.message || e));
    } finally {
      setDisplayShareBusy(false);
    }
  }, [displayShareDraft, displaySharesOpen, edges, flowParams, loadDisplayShares, nodes, saveGraph]);

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
          ...displayShareExpiryPayload(displayShareDraft),
        }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.ok === false) throw new Error(json.error || "生成展示链接失败");
      const absoluteUrl = new URL(json.url || `/display/${json.share?.id || ""}`, window.location.origin).href;
      setDisplayShareResult({ ...json, absoluteUrl });
      setDisplayLinkOpen(true);
      setStatus(json.share?.expiresAt ? "展示链接已生成" : "展示链接已生成：永久有效");
      if (displaySharesOpen) void loadDisplayShares();
    } catch (e) {
      const message = String(e.message || e);
      setDisplayShareError(message);
      setStatus(message);
    } finally {
      setDisplayShareBusy(false);
    }
  }, [displayPage.nodeIds, displayShareDraft, displaySharesOpen, edges, flowParams, loadDisplayShares, nodes, saveGraph]);

  const copyDisplayShareUrl = useCallback(async () => {
    const url = displayShareResult?.absoluteUrl;
    if (!url) return;
    const ok = await copyTextToClipboard(url);
    setDisplayLinkCopyState(ok ? "copied" : "failed");
    window.setTimeout(() => setDisplayLinkCopyState(""), 1600);
  }, [displayShareResult?.absoluteUrl]);

  const copyDisplayShareListUrl = useCallback(async (share) => {
    const url = displayShareUrl(share);
    const ok = await copyTextToClipboard(url);
    setDisplayShareCopyId(ok ? String(share?.id || "") : "failed");
    window.setTimeout(() => setDisplayShareCopyId(""), 1600);
  }, []);

  const updateDisplayShareExpiry = useCallback(async (share, value) => {
    const id = String(share?.id || "");
    if (!id) return;
    setDisplayShareUpdatingId(id);
    setDisplaySharesError("");
    try {
      const body = value === "permanent"
        ? { id, expiresMode: "permanent", permanent: true }
        : { id, expiresMode: "days", expiresInDays: Number(value || 30) };
      const res = await fetch("/api/display/share", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.ok === false) throw new Error(json.error || "更新分享有效期失败");
      await loadDisplayShares();
      setStatus("分享有效期已更新");
    } catch (e) {
      setDisplaySharesError(String(e.message || e));
    } finally {
      setDisplayShareUpdatingId("");
    }
  }, [loadDisplayShares]);

  const revokeDisplayShare = useCallback(async (share) => {
    const id = String(share?.id || "");
    if (!id) return;
    setDisplayShareUpdatingId(id);
    setDisplaySharesError("");
    try {
      const res = await fetch(`/api/display/share?id=${encodeURIComponent(id)}`, { method: "DELETE" });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || json.ok === false) throw new Error(json.error || "撤销分享失败");
      await loadDisplayShares();
      setStatus("分享已撤销");
    } catch (e) {
      setDisplaySharesError(String(e.message || e));
    } finally {
      setDisplayShareUpdatingId("");
    }
  }, [loadDisplayShares]);

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

  const applyCanvasNodeChanges = useCallback((changes) => {
    const interaction = workspaceCanvasInteractionPhase(changes);
    if (interaction.active) {
      workspaceCanvasInteractionActiveRef.current = true;
    }
    if (interaction.finished) {
      workspaceCanvasInteractionActiveRef.current = false;
      workspaceFlushAfterInteractionRef.current = true;
    }
    if (workspaceCanvasInteractionCommitsChanges(changes)) markWorkspaceDirty();
    if (workspaceMode === "display") {
      setDisplayPage((prev) => {
        let nodePositions = prev.nodePositions;
        let nodeSizes = prev.nodeSizes;
        for (const change of changes || []) {
          const sourceId = sourceIdFromDisplayRefId(change?.id);
          if (!sourceId || !prev.nodeIds.includes(sourceId)) continue;
          if (change.type === "select") continue;
          if (change.type === "position" && change.position) {
            const current = nodePositions[sourceId];
            if (current?.x === change.position.x && current?.y === change.position.y) continue;
            if (nodePositions === prev.nodePositions) nodePositions = { ...prev.nodePositions };
            nodePositions[sourceId] = { x: change.position.x, y: change.position.y };
            continue;
          }
          if (change.type === "dimensions" && change.dimensions?.width && change.dimensions?.height) {
            const size = normalizeWorkspaceNodeSize({
              width: Math.round(Number(change.dimensions.width)),
              height: Math.round(Number(change.dimensions.height)),
            }, { display: true });
            if (size) {
              const current = nodeSizes[sourceId];
              if (current?.width === size.width && current?.height === size.height) continue;
              if (nodeSizes === prev.nodeSizes) nodeSizes = { ...prev.nodeSizes };
              nodeSizes[sourceId] = size;
            }
          }
        }
        if (nodePositions === prev.nodePositions && nodeSizes === prev.nodeSizes) return prev;
        const next = { ...prev, nodePositions, nodeSizes };
        displayPageRef.current = next;
        return next;
      });
      const selectionChanges = (changes || []).filter((change) => change?.type === "select");
      if (selectionChanges.length > 0) {
        setSelectedDisplayNodeIds((current) => {
          const next = new Set(current);
          for (const change of selectionChanges) {
            const sourceId = sourceIdFromDisplayRefId(change?.id);
            if (!sourceId) continue;
            if (change.selected) next.add(sourceId);
            else next.delete(sourceId);
          }
          const result = Array.from(next);
          return result.length === current.length && result.every((id, index) => id === current[index])
            ? current
            : result;
        });
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
    // Selection is React Flow UI state, not part of the persisted workspace graph.
    // Without this guard, pressing a node schedules an autosave before its first
    // drag event. That save can rerender the controlled canvas with the old
    // persisted position while the new position still lives only in React Flow's
    // transient store, making the node jump back during a drag.
    const dimensionChanges = (changes || []).filter(
      (change) => change?.type === "dimensions" && change.dimensions?.width && change.dimensions?.height,
    );
    setNodes((current) => {
      const resized = new Map();
      if (dimensionChanges.length > 0) {
        const currentById = new Map(current.map((node) => [node.id, node]));
        for (const change of dimensionChanges) {
          const node = currentById.get(change.id);
          const rawSize = {
            width: Math.round(Number(change.dimensions.width)),
            height: Math.round(Number(change.dimensions.height)),
          };
          const size = isWorkspaceGroupNode(node)
            ? normalizeWorkspaceGroupSize(rawSize)
            : normalizeWorkspaceNodeSize(rawSize, { display: Boolean(workspaceDisplayKindFromData(node?.data)) });
          if (size) resized.set(change.id, size);
        }
      }
      const applied = applyNodeChanges(changes, current);
      const next = resized.size === 0
        ? applied
        : applied.map((node) => {
            const size = resized.get(node.id);
            if (!size) return node;
            const nextData = {
              ...node.data,
              nodeSize: size,
            };
            if (workspaceDisplayKindFromData(node.data)) nextData.displaySize = size;
            return {
              ...node,
              width: size.width,
              height: size.height,
              data: nextData,
            };
          });
      if (!interaction.mutated) {
        workspaceAutosaveSuppressedStateRef.current = {
          nodes: next,
          edges: edgesRef.current,
          displayPage: displayPageRef.current,
        };
      }
      nodesRef.current = next;
      return next;
    });
    if (dimensionChanges.length > 0) {
      refreshNodeInternals(dimensionChanges.map((change) => change.id));
    }
  }, [markWorkspaceDirty, refreshNodeInternals, setNodes, workspaceMode, workspaceWritable]);

  const flushPendingCanvasNodeChanges = useCallback((extraChanges = [], { finish = false } = {}) => {
    const merged = finish
      ? finalizeWorkspaceCanvasChanges([
          ...lastActiveCanvasNodeChangesRef.current,
          ...extraChanges,
        ])
      : coalesceWorkspaceCanvasChanges(extraChanges);
    if (finish) lastActiveCanvasNodeChangesRef.current = [];
    if (merged.length > 0) applyCanvasNodeChanges(merged);
  }, [applyCanvasNodeChanges]);

  const cancelPendingTransientCanvasFrame = useCallback(() => {
    if (transientCanvasFrameRef.current != null) {
      window.cancelAnimationFrame(transientCanvasFrameRef.current);
      transientCanvasFrameRef.current = null;
    }
    pendingTransientCanvasNodeChangesRef.current = [];
  }, []);

  const flushTransientCanvasNodeChanges = useCallback(() => {
    transientCanvasFrameRef.current = null;
    const pending = pendingTransientCanvasNodeChangesRef.current;
    pendingTransientCanvasNodeChangesRef.current = [];
    if (pending.length === 0) return;
    const nextTransientNodes = applyNodeChanges(
      pending,
      transientCanvasNodesRef.current,
    );
    transientCanvasNodesRef.current = nextTransientNodes;
    reactFlowStore.getState().setNodes(nextTransientNodes);
  }, [reactFlowStore]);

  const scheduleTransientCanvasNodeChanges = useCallback((changes) => {
    pendingTransientCanvasNodeChangesRef.current = coalesceWorkspaceCanvasChanges([
      ...pendingTransientCanvasNodeChangesRef.current,
      ...changes,
    ]);
    if (transientCanvasFrameRef.current != null) return;
    transientCanvasFrameRef.current = window.requestAnimationFrame(flushTransientCanvasNodeChanges);
  }, [flushTransientCanvasNodeChanges]);

  const handleNodesChange = useCallback((changes) => {
    const expandedChanges = workspaceMode === "display"
      ? changes
      : expandWorkspaceGroupPositionChanges(
          changes,
          transientCanvasNodesRef.current.length > 0 ? transientCanvasNodesRef.current : canvasNodesRef.current,
        );
    const {
      transient,
      committed,
      finishesInteraction,
    } = partitionWorkspaceCanvasChanges(expandedChanges);
    if (transient.length > 0) {
      setWorkspaceNodeInteractionUiActive(true);
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      if (!workspaceCanvasInteractionActiveRef.current) {
        workspaceCanvasInteractionActiveRef.current = true;
        transientCanvasNodesRef.current = canvasNodesRef.current;
      }
      lastActiveCanvasNodeChangesRef.current = coalesceWorkspaceCanvasChanges([
        ...lastActiveCanvasNodeChangesRef.current,
        ...transient,
      ]);
      scheduleTransientCanvasNodeChanges(transient);
    }
    if (finishesInteraction) {
      setWorkspaceNodeInteractionUiActive(false);
      cancelPendingTransientCanvasFrame();
      transientCanvasNodesRef.current = [];
      flushPendingCanvasNodeChanges(committed, { finish: true });
      return;
    }
    if (committed.length > 0) applyCanvasNodeChanges(committed);
  }, [applyCanvasNodeChanges, cancelPendingTransientCanvasFrame, flushPendingCanvasNodeChanges, scheduleTransientCanvasNodeChanges, workspaceMode]);

  const settleWorkspaceCanvasInteraction = useCallback(() => {
    if (
      workspaceCanvasPointerIdsRef.current.size > 0
      || workspaceViewportInteractionActiveRef.current
    ) {
      return;
    }
    if (
      workspaceCanvasInteractionActiveRef.current
      || lastActiveCanvasNodeChangesRef.current.length > 0
    ) {
      setWorkspaceNodeInteractionUiActive(false);
      cancelPendingTransientCanvasFrame();
      flushPendingCanvasNodeChanges([], { finish: true });
      transientCanvasNodesRef.current = [];
    }
    if (workspaceRemoteRefreshQueuedRef.current) {
      scheduleWorkspaceRemoteRefresh({ type: "interaction.finished" });
    }
  }, [cancelPendingTransientCanvasFrame, flushPendingCanvasNodeChanges, scheduleWorkspaceRemoteRefresh]);

  const trackWorkspaceCanvasPointer = useCallback((event) => {
    if (event?.pointerId == null) return;
    workspaceCanvasPointerIdsRef.current.add(event.pointerId);
  }, []);

  const finishWorkspaceCanvasPointer = useCallback((event) => {
    if (event?.pointerId != null) {
      workspaceCanvasPointerIdsRef.current.delete(event.pointerId);
    }
    window.queueMicrotask(settleWorkspaceCanvasInteraction);
  }, [settleWorkspaceCanvasInteraction]);

  const handleWorkspaceViewportMoveStart = useCallback(() => {
    workspaceViewportInteractionActiveRef.current = true;
  }, []);

  const handleWorkspaceViewportMoveEnd = useCallback(() => {
    workspaceViewportInteractionActiveRef.current = false;
    window.queueMicrotask(settleWorkspaceCanvasInteraction);
  }, [settleWorkspaceCanvasInteraction]);

  useEffect(() => {
    const finishInterruptedInteraction = () => {
      workspaceCanvasPointerIdsRef.current.clear();
      workspaceViewportInteractionActiveRef.current = false;
      settleWorkspaceCanvasInteraction();
    };
    const finishWhenHidden = () => {
      if (document.visibilityState === "hidden") finishInterruptedInteraction();
    };
    window.addEventListener("pointerup", finishWorkspaceCanvasPointer, true);
    window.addEventListener("pointercancel", finishWorkspaceCanvasPointer, true);
    window.addEventListener("lostpointercapture", finishWorkspaceCanvasPointer, true);
    window.addEventListener("blur", finishInterruptedInteraction);
    document.addEventListener("visibilitychange", finishWhenHidden);
    return () => {
      window.removeEventListener("pointerup", finishWorkspaceCanvasPointer, true);
      window.removeEventListener("pointercancel", finishWorkspaceCanvasPointer, true);
      window.removeEventListener("lostpointercapture", finishWorkspaceCanvasPointer, true);
      window.removeEventListener("blur", finishInterruptedInteraction);
      document.removeEventListener("visibilitychange", finishWhenHidden);
      workspaceCanvasPointerIdsRef.current.clear();
      workspaceViewportInteractionActiveRef.current = false;
      lastActiveCanvasNodeChangesRef.current = [];
      cancelPendingTransientCanvasFrame();
      transientCanvasNodesRef.current = [];
    };
  }, [cancelPendingTransientCanvasFrame, finishWorkspaceCanvasPointer, settleWorkspaceCanvasInteraction]);

  const handleEdgesChange = useCallback((changes) => {
    if (workspaceMode === "display") return;
    if (!workspaceWritable) {
      const selectionChanges = (changes || []).filter((change) => change?.type === "select");
      if (selectionChanges.length > 0) {
        setEdges((current) => {
          const next = applyEdgeChanges(selectionChanges, current);
          edgesRef.current = next;
          return next;
        });
      }
      return;
    }
    if ((changes || []).some((change) => change?.type !== "select")) markWorkspaceDirty();
    setEdges((current) => {
      const next = applyEdgeChanges(changes, current);
      edgesRef.current = next;
      return next;
    });
  }, [markWorkspaceDirty, setEdges, workspaceMode, workspaceWritable]);

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
    const runtimeScript = scriptFromMarketplaceRuntime(def);
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
      ...(overrides.script || runtimeScript ? { script: overrides.script || runtimeScript } : {}),
      ...(overrides.scriptRef ? { scriptRef: overrides.scriptRef } : {}),
      ...(overrides.implementationRef ? { implementationRef: overrides.implementationRef } : {}),
      ...(overrides.implementationMode ? { implementationMode: overrides.implementationMode } : {}),
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
        ...(instance.script ? { script: instance.script } : {}),
        ...(instance.scriptRef ? { scriptRef: instance.scriptRef } : {}),
        ...(instance.implementationRef ? { implementationRef: instance.implementationRef } : {}),
        ...(instance.implementationMode ? { implementationMode: instance.implementationMode } : {}),
        inputs: instance.input,
        outputs: instance.output,
      },
    };
    const merged = { ...mergeNodeWithPalette(node, { ...instancesRef.current, [id]: instance }, palette), selected: true };
    markWorkspaceDirty();
    setNodes((list) => [...list.map((item) => ({ ...item, selected: false })), merged]);
    if (overrides.openProperties) setSelectedNodeId(id);
    return id;
  }, [defaultWorkspaceNodePosition, markWorkspaceDirty, nodes, palette, setNodes, workspaceWritable]);

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
    markWorkspaceDirty();
    setNodes((current) => revealConnectedSlots(current, params));
    setEdges((current) => {
      const filtered = current.filter(
        (edge) => !(edge.target === params.target && edge.targetHandle === params.targetHandle)
      );
      const next = addEdge({ ...params, markerEnd: { type: MarkerType.ArrowClosed } }, filtered);
      edgesRef.current = next;
      return next;
    });
  }, [markWorkspaceDirty, setEdges, setNodes, workspaceWritable]);

  const handleConnectStart = useCallback((event, params) => {
    if (!workspaceWritable) return;
    const draft = buildWorkspaceConnectionDraft(params, nodesRef.current);
    connectionStartRef.current = draft ? { ...draft, preferExisting: Boolean(event?.shiftKey) } : null;
    setConnectionMenu(null);
  }, [workspaceWritable]);

  const handleConnectEnd = useCallback((event, connectionState) => {
    if (!workspaceWritable) return;
    const draft = connectionStartRef.current;
    connectionStartRef.current = null;
    if (!draft) return;
    if (connectionState?.toNode) return;
    const candidates = buildWorkspaceConnectionCandidates(palette, draft);
    const existingCandidates = buildWorkspaceExistingConnectionCandidates(nodesRef.current, edgesRef.current, draft);
    if (candidates.length === 0 && existingCandidates.length === 0) {
      setStatus(`没有匹配 ${draft.slotType} 端口的节点`);
      return;
    }
    const preferExisting = Boolean(event?.shiftKey || draft.preferExisting);
    const defaultMode = preferExisting
      ? (existingCandidates.length > 0 ? "existing" : "create")
      : (candidates.length > 0 ? "create" : "existing");
    const clientX = event?.changedTouches?.[0]?.clientX ?? event?.clientX;
    const clientY = event?.changedTouches?.[0]?.clientY ?? event?.clientY;
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
    const wrap = document.querySelector(".af-workspace-canvas .react-flow");
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    const menuWidth = 320;
    const maxCandidateCount = Math.max(candidates.length, existingCandidates.length);
    const menuHeight = Math.min(480, 150 + maxCandidateCount * 58);
    const left = Math.max(12, Math.min(clientX - rect.left, rect.width - menuWidth - 12));
    const top = Math.max(12, Math.min(clientY - rect.top, rect.height - menuHeight - 12));
    setConnectionMenu({
      left,
      top,
      flowPosition: reactFlow.screenToFlowPosition({ x: clientX, y: clientY }),
      draft,
      candidates,
      existingCandidates,
      mode: defaultMode,
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
      const next = addEdge({ ...nextConnection, markerEnd: { type: MarkerType.ArrowClosed } }, filtered);
      edgesRef.current = next;
      return next;
    });
    setConnectionMenu(null);
  }, [addNodeFromDefinition, setEdges, workspaceWritable]);

  const handleConnectionMenuExistingSelect = useCallback((candidate) => {
    if (!workspaceWritable) {
      setStatus("Readonly workspace");
      setConnectionMenu(null);
      return;
    }
    const nextConnection = candidate?.connection;
    if (!nextConnection || !workspaceConnectionCompatible(nextConnection, nodesRef.current)) {
      setStatus("端口类型不匹配，已取消连线");
      setConnectionMenu(null);
      return;
    }
    setNodes((current) => revealConnectedSlots(current, nextConnection));
    setEdges((current) => {
      const filtered = current.filter(
        (edge) => !(edge.target === nextConnection.target && edge.targetHandle === nextConnection.targetHandle)
      );
      const next = addEdge({ ...nextConnection, markerEnd: { type: MarkerType.ArrowClosed } }, filtered);
      edgesRef.current = next;
      return next;
    });
    setConnectionMenu(null);
  }, [setEdges, setNodes, workspaceWritable]);

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

  const focusWorkspaceCanvasForShortcuts = useCallback((event) => {
    if (isDisplayMode || isWorkflowMode) return;
    const target = event?.target;
    if (isEditableShortcutTarget(target)) return;
    if (target?.closest?.("button, a, [role='button'], .react-flow__handle")) return;
    workspaceCanvasRef.current?.focus?.({ preventScroll: true });
  }, [isDisplayMode, isWorkflowMode]);

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
          persistWorkspaceCanvasClipboard(clip);
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
        const canvasClipboard = canvasClipboardRef.current || readPersistedWorkspaceCanvasClipboard();
        if (canvasClipboard && !canvasClipboardRef.current) canvasClipboardRef.current = canvasClipboard;
        const pasted = pasteCanvasClipboard(canvasClipboard, nodesRef.current, edgesRef.current, instancesRef.current);
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
      if (shortcutKey === "g" && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        createWorkspaceGroupFromSelection();
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
  }, [createWorkspaceGroupFromSelection, isDisplayMode, jumpPaletteOpen, lockCurrentViewport, redoCanvas, saveGraph, shortcutsOpen, setEdges, setNodes, undoCanvas, workspaceWritable]);

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
    const displayDefinitionId = ["jsx", "tsx", "js"].includes(ext)
      ? "display_react_app"
      : ext === "html"
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

  const downloadWorkspaceFile = useCallback((item) => {
    if (!item?.path || item.type === "directory") return;
    const url = workspaceRawFileUrl(item.path, flowParams, { download: true });
    if (!url) return;
    const link = document.createElement("a");
    link.href = url;
    link.download = item.name || item.path.split("/").pop() || "download";
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
  }, [flowParams]);

  const submitWorkspaceAi = useCallback(async () => {
    if (!workspaceWritable) {
      setStatus("Readonly workspace");
      return;
    }
    const prompt = composerText.trim();
    const targetSessionId = activeComposerSessionId;
    const targetRunSession = composerRunSessions.find((session) => session.id === targetSessionId) || null;
    if (!prompt || composerRunning || targetRunSession?.status === "running" || targetRunSession?.status === "stopping") return;
    const previousMessages = targetRunSession
      ? (Array.isArray(targetRunSession.messages) ? targetRunSession.messages : [])
      : composerMessages;
    const graph = flowToGraph(nodes, edges, instancesRef.current);
    setComposerText("");
    setComposerRunning(true);
    setComposerSidebarOpen(true);
    setWorkspaceRunLogsTarget(null);
    const userMessage = { role: "user", text: prompt, at: Date.now() };
    if (targetRunSession) {
      setComposerRunSessions((list) => list.map((session) => (
        session.id === targetSessionId
          ? {
              ...session,
              status: "running",
              messages: [...(Array.isArray(session.messages) ? session.messages : []), userMessage].slice(-180),
            }
          : session
      )));
    } else {
      setActiveComposerSessionId("workspace");
      setComposerMessages((list) => [...list, userMessage]);
    }
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
          messages: previousMessages,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "生成失败");
      const text = String(json.content || "").trim();
      const assistantMessage = { role: "assistant", kind: "assistant", text, at: Date.now() };
      if (targetRunSession) {
        setComposerRunSessions((list) => list.map((session) => (
          session.id === targetSessionId
            ? {
                ...session,
                status: "done",
                messages: [...(Array.isArray(session.messages) ? session.messages : []), assistantMessage].slice(-180),
              }
            : session
        )));
      } else {
        setComposerMessages((list) => [...list, assistantMessage]);
      }
      await loadWorkspace();
      setStatus("AI 生成完成");
    } catch (e) {
      const message = String(e.message || e);
      const errorMessage = { role: "assistant", text: message, error: true, at: Date.now() };
      if (targetRunSession) {
        setComposerRunSessions((list) => list.map((session) => (
          session.id === targetSessionId
            ? {
                ...session,
                status: "failed",
                messages: [...(Array.isArray(session.messages) ? session.messages : []), errorMessage].slice(-180),
              }
            : session
        )));
      } else {
        setComposerMessages((list) => [...list, errorMessage]);
      }
      setStatus(message);
    } finally {
      setComposerRunning(false);
    }
  }, [activeComposerSessionId, composerMessages, composerModel, composerRunSessions, composerRunning, composerText, edges, flowParams, loadWorkspace, nodes, saveGraph, selectedCanvasNodeIds, selectedSkills, workspaceWritable]);

  const activeRunSession = composerRunSessions.find((session) => session.id === activeComposerSessionId) || null;
  const activeComposerMessages = activeRunSession ? (Array.isArray(activeRunSession.messages) ? activeRunSession.messages : []) : composerMessages;
  const activeComposerRunning = activeRunSession
    ? (activeRunSession.status === "running" || activeRunSession.status === "stopping" || composerRunning)
    : composerRunning;
  const activeComposerConversationMessages = workspaceComposerConversationMessages(activeComposerMessages, activeComposerRunning);
  const activeComposerTechnicalMessages = workspaceComposerTechnicalMessages(activeComposerMessages);
  const activeComposerStatus = activeRunSession
    ? activeRunSession.status === "stopping"
      ? `${activeRunSession.label} stopping`
      : activeRunSession.status === "running"
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
  useEffect(() => {
    if (activeComposerSessionId === "workspace") return;
    if (composerRunSessions.some((session) => session.id === activeComposerSessionId)) return;
    setActiveComposerSessionId(latestComposerSessionId());
  }, [activeComposerSessionId, composerRunSessions, latestComposerSessionId]);
  useEffect(() => {
    if (!composerSidebarOpen) return;
    const frame = window.requestAnimationFrame(() => {
      const thread = composerSidebarThreadRef.current;
      if (thread) thread.scrollTop = thread.scrollHeight;
      composerActiveSessionTabRef.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [
    activeComposerMessages.length,
    activeComposerSessionId,
    activeComposerStatus,
    activeComposerTechnicalMessages.length,
    composerSidebarOpen,
  ]);
  const workspaceProjectTitle = String(flowParams.flowId || "").trim() || "Workspace";
  const singleNodeDisplayShare = displayShareDraft?.mode === "single-node";
  const displayShareSourceNode = singleNodeDisplayShare
    ? workspaceDisplayNodes.find((node) => node.id === displayShareDraft.sourceNodeId || displayShareDraft.nodeIds?.includes(node.id)) || null
    : null;
  const displayShareSelectableNodes = singleNodeDisplayShare && displayShareSourceNode
    ? [displayShareSourceNode]
    : workspaceDisplayNodes;
  const workspaceBackTarget = flowParams.adminOwnerId
    ? "/admin/usage"
    : flowParams.returnTo || (workspaceMode === "workflow" ? "/workflows" : "/projects");

  return (
    <div className="af-workspace-page">
      {!isWorkflowShareView ? (
        <header className="af-pipeline-top af-workspace-top">
        <div className="af-pipeline-top-left">
          <button
            type="button"
            className="af-icon-btn af-pipeline-back"
            onClick={() => navigate(workspaceBackTarget)}
            aria-label="返回"
          >
            <span className="material-symbols-outlined">arrow_back</span>
          </button>
          <div className="af-pipeline-brand" title={flowParams.flowId ? `${flowParams.flowId} · ${workspaceRoot}` : workspaceRoot || "PROJECT"}>
            <span className="af-pipeline-brand-name">{workspaceProjectTitle}</span>
            <span className="af-pipeline-brand-ver">V{APP_VERSION}-STABLE</span>
          </div>
          {adminReview ? (
            <span className="af-workspace-admin-review-badge" title="管理员审阅模式不会修改、运行或加入该 Workspace">
              <span className="material-symbols-outlined" aria-hidden>visibility</span>
              只读查看 · {adminReview.ownerUsername || adminReview.ownerUserId}
            </span>
          ) : null}
          <div className="af-view-switch" aria-label="视图切换">
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
            <button
              type="button"
              className={workspaceMode === "workflow" ? "af-view-switch__active" : ""}
              onClick={() => switchWorkspaceMode("workflow")}
            >
              Workflow
            </button>
          </div>
        </div>
        <div className="af-pipeline-top-right af-workspace-actions">
          {!isWorkflowMode ? (
            <span
              className={`af-workspace-sync-light is-${workspaceSyncIndicator.phase}`}
              title={`${workspaceSyncIndicator.label} · ${workspaceSyncIndicator.detail}`}
              role="status"
              aria-label={`${workspaceSyncIndicator.label}：${workspaceSyncIndicator.detail}`}
            >
              <span className="af-workspace-sync-light__dot" aria-hidden />
            </span>
          ) : null}
          {!isWorkflowMode && workspaceConflict ? (
            <button
              type="button"
              className="af-workspace-display-share-btn"
              onClick={() => {
                if (workspaceConflict.conflictItems?.length) {
                  setWorkspaceConflictOpen(true);
                } else {
                  void backupDraftAndReloadWorkspace();
                }
              }}
              title={[
                "先下载当前本地草稿，再载入远端最新版本",
                ...(workspaceConflict.conflictPaths || []),
              ].join("\n")}
            >
              <span className="material-symbols-outlined" aria-hidden>difference</span>
              处理冲突
            </button>
          ) : null}
          {isDisplayMode ? (
            <>
              <button
                type="button"
                className="af-workspace-display-share-btn"
                disabled={!workspaceWritable || displayShareBusy || (!displayShareResult?.absoluteUrl && displayPage.nodeIds.length === 0)}
                onClick={() => {
                  setDisplayLinkCopyState("");
                  setDisplayLinkOpen(true);
                }}
                title={displayShareResult?.absoluteUrl ? "查看展示链接" : displayPage.nodeIds.length === 0 ? "先添加展示节点" : "生成展示链接"}
              >
                <span className="material-symbols-outlined" aria-hidden>{displayShareBusy ? "hourglass_empty" : "ios_share"}</span>
                {displayShareBusy ? "生成中" : displayShareResult?.absoluteUrl ? "展示链接" : "生成链接"}
              </button>
              <button
                type="button"
                className="af-workspace-display-share-btn"
                disabled={!workspaceWritable || availableDisplayNodes.length === 0}
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
            className="af-workspace-display-share-btn"
            disabled={isWorkflowMode
              ? !workflowTapdId
              : !workspaceWritable || Boolean(workspaceCollaboration?.role && workspaceCollaboration.role !== "owner")}
            onClick={() => {
              if (isWorkflowMode) {
                setWorkflowCollaborationOpenRequest((request) => request + 1);
              } else {
                openWorkspaceShareDialog();
              }
            }}
            title={isWorkflowMode
              ? !workflowTapdId
                ? "先读取一个 TAPD 需求"
                : "管理当前需求的成员权限和只读链接"
              : workspaceCollaboration?.role && workspaceCollaboration.role !== "owner"
                ? "仅 Workspace 所有者可以管理项目协作"
                : "管理项目的团队和成员协作"}
          >
            <span className="material-symbols-outlined" aria-hidden>group_add</span>
            协作
          </button>
          {isWorkflowMode && authUser?.isAdmin === true && !flowParams.workflowShare && !flowParams.workflowDemo ? (
            <button
              type="button"
              className="af-workspace-display-share-btn af-workspace-display-share-btn--danger"
              disabled={!workflowTapdId || workflowDeleteBusy}
              onClick={() => void deleteWorkflowAsAdmin()}
              title="清理测试 Workflow 及其运行快照"
            >
              <span className="material-symbols-outlined" aria-hidden>{workflowDeleteBusy ? "hourglass_empty" : "delete_forever"}</span>
              {workflowDeleteBusy ? "清理中" : "清理 Workflow"}
            </button>
          ) : null}
          {!adminReview && !isWorkflowMode ? (
            <button
              type="button"
              className="af-workspace-display-share-btn"
              onClick={openDisplaySharesPanel}
              title="查看我的展示分享"
            >
              <span className="material-symbols-outlined" aria-hidden>folder_shared</span>
              我的分享
            </button>
          ) : null}
          {!isWorkflowMode ? (
            <>
              <button
                type="button"
                className="af-icon-btn"
                disabled={!canManageCurrentFlow}
                onClick={() => setArchiveModalOpen(true)}
                aria-label={t("project:archiveModal.title")}
                title={t("project:archiveModal.title")}
              >
                <span className="material-symbols-outlined">archive</span>
              </button>
              <button
                type="button"
                className="af-icon-btn af-icon-btn--danger"
                disabled={!canManageCurrentFlow && !canLeaveSharedFlow}
                onClick={() => setDeleteModalOpen(true)}
                aria-label={canLeaveSharedFlow ? "退出共享 Workspace" : t("flow:topbar.deletePipeline")}
                title={canLeaveSharedFlow ? "退出共享 Workspace" : t("flow:topbar.deletePipeline")}
              >
                <span className="material-symbols-outlined">{canLeaveSharedFlow ? "logout" : "delete_forever"}</span>
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
            className={"af-composer-topbar-btn" + (isWorkflowMode ? " af-composer-topbar-btn--workflow" : "") + (composerSidebarOpen ? " af-composer-topbar-btn--active" : "") + (composerRunning ? " af-composer-topbar-btn--running" : "")}
            disabled={isDisplayMode || (isWorkflowMode ? !workflowTapdId || Boolean(flowParams.workflowShare) : !workspaceWritable)}
            onClick={() => {
              if (isWorkflowMode) {
                setWorkflowAssistantOpenRequest((request) => request + 1);
                return;
              }
              setWorkspaceRunLogsTarget(null);
              setComposerSidebarOpen((v) => {
                if (!v) setActiveComposerSessionId(latestComposerSessionId());
                return !v;
              });
            }}
            title={isWorkflowMode ? "结合需求上下文和绑定代码仓库进行 AI 问答" : "打开 Workspace AI"}
          >
            {isWorkflowMode ? <span className="material-symbols-outlined" aria-hidden>auto_awesome</span> : null}
            {isWorkflowMode ? "需求 AI" : "AI"}
          </button>
          {!isWorkflowMode ? (
            <button type="button" className="af-btn-primary af-btn-primary--lg" disabled={!workspaceWritable} onClick={() => saveGraph().catch((e) => setStatus(String(e.message || e)))}>
              Save
            </button>
          ) : null}
        </div>
        </header>
      ) : null}
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
	          (!isDisplayMode && !isWorkflowMode && (composerSidebarOpen || nodePropDraft) ? " af-workspace-body--drawer" : "") +
	          (!isDisplayMode && !isWorkflowMode && workspaceSidebarCollapsed ? " af-workspace-body--sidebar-collapsed" : "") +
	          (isDisplayMode ? " af-workspace-body--display-mode" : "") +
	          (isWorkflowMode ? " af-workspace-body--workflow-mode" : "")
	        }
	      >
        {!isDisplayMode && !isWorkflowMode && workspaceSidebarCollapsed ? (
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
        {!isDisplayMode && !isWorkflowMode ? <aside
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
                <button type="button" className="af-icon-btn" disabled={!workspaceWritable} onClick={() => createWorkspaceFile(selectedWorkspaceTargetDir)} aria-label="新增文件" title={selectedWorkspaceTargetDir ? `在 ${selectedWorkspaceTargetDir} 新增文件` : "新增文件"}>
                  <span className="material-symbols-outlined">note_add</span>
                </button>
                <button type="button" className="af-icon-btn" disabled={!workspaceWritable} onClick={() => createWorkspaceFolder(selectedWorkspaceTargetDir)} aria-label="新增文件夹" title={selectedWorkspaceTargetDir ? `在 ${selectedWorkspaceTargetDir} 新增文件夹` : "新增文件夹"}>
                  <span className="material-symbols-outlined">create_new_folder</span>
                </button>
                <button type="button" className="af-icon-btn" disabled={!workspaceWritable || workspaceFileUploading} onClick={() => triggerWorkspaceFileUpload(selectedWorkspaceTargetDir)} aria-label="上传文件" title={selectedWorkspaceTargetDir ? `上传到 ${selectedWorkspaceTargetDir}` : "上传文件"}>
                  <span className="material-symbols-outlined">{workspaceFileUploading ? "hourglass_top" : "upload_file"}</span>
                </button>
                <button type="button" className="af-icon-btn" onClick={() => void loadFiles()} aria-label="刷新文件" title="刷新文件">
                  <span className="material-symbols-outlined">refresh</span>
                </button>
                <input
                  ref={workspaceFileUploadInputRef}
                  type="file"
                  multiple
                  className="af-visually-hidden"
                  onChange={handleWorkspaceFileUploadInput}
                />
              </div>
            </div>
            <input className="af-workspace-search" value={fileFilter} onChange={(e) => setFileFilter(e.target.value)} placeholder="搜索文件..." />
            <div className="af-workspace-files-scroll" onClick={clearWorkspaceFileSelection}>
              <FileTree items={filteredFiles} onOpen={openFileNode} selectedPath={selectedWorkspaceFilePath} collapsedDirs={collapsedDirs} onToggleDir={toggleDir} onSelect={(item) => setSelectedWorkspaceFilePath(item.path || "")} onFileDragStart={handleFileDragStart} onDelete={deleteWorkspacePath} onDownload={downloadWorkspaceFile} />
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

        {isWorkflowMode ? (
          <PrdWorkflowTimelinePanel
            flowParams={flowParams}
            tapdId={workflowTapdId}
            setTapdId={setWorkflowTapdId}
            collaborationOpenRequest={workflowCollaborationOpenRequest}
            assistantOpenRequest={workflowAssistantOpenRequest}
            snapshot={workflowSnapshot}
            loading={workflowLoading}
            error={workflowError}
            actionRunning={workflowActionRunning}
            actionOutput={workflowActionOutput}
            pendingConfirm={workflowPendingConfirm}
            conflict={workflowConflict}
            reviewPublishing={workflowReviewPublishing}
            onRefresh={() => loadPrdWorkflowSnapshot(workflowTapdId)}
            onRunDryRun={runPrdWorkflowDryRun}
            onConfirmAction={confirmPrdWorkflowAction}
            onRetryConflict={retryPrdWorkflowConflict}
            onPublishReview={publishPrdWorkflowReviewLink}
          />
        ) : (
        <main
          ref={workspaceCanvasRef}
          className="af-workspace-canvas"
          tabIndex={-1}
          onPointerDownCapture={(event) => {
            focusWorkspaceCanvasForShortcuts(event);
            trackWorkspaceCanvasPointer(event);
          }}
          onLostPointerCaptureCapture={finishWorkspaceCanvasPointer}
        >
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
            onMoveStart={handleWorkspaceViewportMoveStart}
            onMoveEnd={handleWorkspaceViewportMoveEnd}
            onConnect={isDisplayMode ? undefined : handleConnect}
            onConnectStart={isDisplayMode ? undefined : handleConnectStart}
            onConnectEnd={isDisplayMode ? undefined : handleConnectEnd}
            isValidConnection={isDisplayMode ? undefined : isValidConnection}
            onNodeClick={(event, node) => {
              if (isDisplayMode) {
                if (isWorkspaceGroupNode(node)) return;
                setSelectedDisplayNodeIds([sourceIdFromDisplayRefId(node.id)]);
                return;
              }
              if (node?.data?.isWorkspaceGroup) {
                setSelectedNodeId("");
                return;
              }
              if (event.detail >= 3) {
                setComposerSidebarOpen(false);
                setNodes((list) => list.map((item) => ({ ...item, selected: item.id === node.id })));
                setEdges((list) => list.map((item) => ({ ...item, selected: false })));
                setSelectedNodeId(node.id);
                return;
              }
              // React Flow handles selection on click. If the properties drawer is already open,
              // keep it in sync with the clicked node; otherwise opening requires triple click.
              if (selectedNodeId) setSelectedNodeId(node.id);
            }}
            onNodeDoubleClick={(event) => {
              event.preventDefault();
            }}
            onPaneClick={() => {
              if (isDisplayMode) setSelectedDisplayNodeIds([]);
              else setSelectedNodeId("");
            }}
            onDrop={isDisplayMode ? undefined : handleWorkspaceDrop}
            onDragOver={isDisplayMode ? undefined : handleWorkspaceDragOver}
            nodesDraggable={workspaceWritable}
            nodesConnectable={isDisplayMode ? false : workspaceWritable}
            edgesReconnectable={isDisplayMode ? false : workspaceWritable}
            onlyRenderVisibleElements={canvasNodes.length >= 80}
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
            const activeMode = connectionMenu.mode === "create" ? "create" : "existing";
            const createCandidates = Array.isArray(connectionMenu.candidates) ? connectionMenu.candidates : [];
            const existingCandidates = Array.isArray(connectionMenu.existingCandidates) ? connectionMenu.existingCandidates : [];
            const visibleCreateCandidates = q
              ? createCandidates.filter((candidate) =>
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
              : createCandidates;
            const visibleExistingCandidates = q
              ? existingCandidates.filter((candidate) =>
                  [
                    candidate.nodeId,
                    candidate.nodeLabel,
                    candidate.definitionId,
                    candidate.slot?.name,
                    candidate.slot?.type,
                  ]
                    .filter(Boolean)
                    .some((value) => String(value).toLowerCase().includes(q))
                )
              : existingCandidates;
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
                <div className="af-connect-node-menu__tabs" role="tablist" aria-label="连接方式">
                  <button
                    type="button"
                    className={activeMode === "existing" ? "af-connect-node-menu__tab af-connect-node-menu__tab--active" : "af-connect-node-menu__tab"}
                    disabled={existingCandidates.length === 0}
                    onClick={() => setConnectionMenu((menu) => menu ? { ...menu, mode: "existing", query: "" } : menu)}
                  >
                    连接已有 <span>{existingCandidates.length}</span>
                  </button>
                  <button
                    type="button"
                    className={activeMode === "create" ? "af-connect-node-menu__tab af-connect-node-menu__tab--active" : "af-connect-node-menu__tab"}
                    disabled={createCandidates.length === 0}
                    onClick={() => setConnectionMenu((menu) => menu ? { ...menu, mode: "create", query: "" } : menu)}
                  >
                    新建节点 <span>{createCandidates.length}</span>
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
                  {activeMode === "create" ? visibleCreateCandidates.map((candidate) => {
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
                  }) : visibleExistingCandidates.map((candidate) => {
                    const label = candidate.nodeLabel || candidate.nodeId;
                    const slotLabel = paletteSlotLabel(candidate.slot, candidate.slotIndex);
                    return (
                      <button
                        key={`${candidate.nodeId}-${candidate.handleId}`}
                        type="button"
                        className="af-connect-node-menu__item"
                        onClick={() => handleConnectionMenuExistingSelect(candidate)}
                        title={`${candidate.definitionId || candidate.nodeId} · ${slotLabel}`}
                      >
                        <span className="af-connect-node-menu__item-main">
                          <span className="af-connect-node-menu__item-label">{label}</span>
                          <span className="af-connect-node-menu__item-id">
                            {candidate.definitionId ? `${candidate.definitionId} · ` : ""}{candidate.nodeId}
                          </span>
                        </span>
                        <span className="af-connect-node-menu__port">
                          <span>{portKind}</span>
                          <span
                            className="af-connect-node-menu__port-dot"
                            style={{ background: getHandleColor(candidate.slot?.type) }}
                            aria-hidden
                          />
                          <span className="af-connect-node-menu__port-name">{slotLabel}</span>
                          {candidate.occupied ? <span className="af-connect-node-menu__port-badge">替换</span> : null}
                        </span>
                      </button>
                    );
                  })}
                  {(activeMode === "create" ? visibleCreateCandidates.length : visibleExistingCandidates.length) === 0 ? (
                    <div className="af-connect-node-menu__empty">没有匹配结果</div>
                  ) : null}
                </div>
              </div>
            );
          })() : null}

          {!isDisplayMode && !isWorkflowMode && !composerMinimized ? (
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
          ) : !isDisplayMode && !isWorkflowMode ? (
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
        )}
        {!isDisplayMode && !isWorkflowMode && composerSidebarOpen ? (
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
                  ref={activeComposerSessionId === "workspace" ? composerActiveSessionTabRef : null}
                  onClick={() => setActiveComposerSessionId("workspace")}
                >
                  <span className="af-composer-session-label">Workspace</span>
                </button>
                {composerRunSessions.map((session) => (
                  <div
                    key={session.id}
                    role="tab"
                    tabIndex={0}
                    ref={activeComposerSessionId === session.id ? composerActiveSessionTabRef : null}
                    className={
                      "af-composer-session-tab" +
                      (activeComposerSessionId === session.id ? " af-composer-session-tab--active" : "") +
                      (session.status === "running" || session.status === "stopping" ? " af-composer-session-tab--running" : "")
                    }
                    onClick={() => setActiveComposerSessionId(session.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setActiveComposerSessionId(session.id);
                      }
                    }}
                    title={session.runNodeId || session.label}
                  >
                    <span className="af-composer-session-label">{session.label}</span>
                    <button
                      type="button"
                      className="af-composer-session-close"
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        closeComposerRunSession(session.id);
                      }}
                      aria-label={`关闭 ${session.label}`}
                      title="关闭 tab"
                    >
                      <span className="material-symbols-outlined" aria-hidden>close</span>
                    </button>
                  </div>
                ))}
              </div>
              <div
                className={"af-composer-sidebar-status" + (activeComposerRunning ? " af-composer-sidebar-status--running" : "")}
                role="status"
                aria-live="polite"
              >
                {activeComposerStatus}
              </div>
              <div className="af-composer-sidebar-thread" ref={composerSidebarThreadRef}>
                <WorkspaceComposerThread
                  messages={activeComposerConversationMessages}
                  running={activeComposerRunning}
                  showRunningIndicator={!activeRunSession}
                />
                <WorkspaceComposerThread
                  messages={activeComposerTechnicalMessages}
                  running={activeComposerRunning}
                  showRunningIndicator={false}
                  technical
                />
              </div>
              <ComposerAssistantInput
                value={composerText}
                onChange={setComposerText}
                onSend={() => void submitWorkspaceAi()}
                placeholder={activeRunSession ? "继续追问、总结或要求调整这次结果" : "继续描述你想让 AI 在 Workspace 中做什么"}
                disabled={!workspaceWritable}
                busy={activeComposerRunning}
              />
            </div>
          </aside>
        ) : !isDisplayMode && !isWorkflowMode && nodePropDraft && selectedNode ? (
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
        {!isDisplayMode && !isWorkflowMode && workspaceRunLogsTarget ? createPortal(
          <div className="af-workspace-run-logs-overlay" role="presentation" onMouseDown={() => setWorkspaceRunLogsTarget(null)}>
            <aside className="af-workspace-run-logs-drawer" aria-label="Workspace Run Logs" onMouseDown={(event) => event.stopPropagation()}>
              <WorkspaceRunLogsDrawer
                flowParams={flowParams}
                scheduleNodeId={workspaceRunLogsTarget.scheduleNodeId}
                runNodeId={workspaceRunLogsTarget.runNodeId}
                lastRunId={workspaceRunLogsTarget.lastRunId}
                label={workspaceRunLogsTarget.label}
                onClose={() => setWorkspaceRunLogsTarget(null)}
              />
            </aside>
          </div>,
          document.body,
        ) : null}
        <KeyboardShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
        <NodeJumpPalette
          open={jumpPaletteOpen}
          onClose={() => setJumpPaletteOpen(false)}
          onJump={jumpToWorkspaceNodeById}
          nodes={jumpPaletteNodes}
        />
        <ArchivePipelineModal
          open={archiveModalOpen}
          onClose={() => setArchiveModalOpen(false)}
          flowId={flowParams.flowId || ""}
          flowSource={flowSource}
          onArchived={() => {
            setArchiveModalOpen(false);
            navigate("/projects?tab=archived");
          }}
        />
        <DeletePipelineModal
          open={deleteModalOpen && Boolean(flowParams.flowId)}
          onClose={() => setDeleteModalOpen(false)}
          flowId={flowParams.flowId || ""}
          flowSource={flowSource}
          flowArchived={Boolean(flowParams.archived)}
          workspaceId={flowParams.workspaceId || ""}
          leaveShared={canLeaveSharedFlow}
          onDeleted={async () => {
            setDeleteModalOpen(false);
            navigate("/projects");
          }}
        />
        {workflowProjectBindingOpen && isWorkflowMode ? createPortal(
          <div className="af-flow-snippet-modal-overlay">
            <div className="af-flow-snippet-modal af-workflow-project-modal" role="dialog" aria-modal="true" aria-label="迭代绑定的 Projects">
              <div className="af-flow-snippet-modal__head">
                <span className="af-flow-snippet-modal__title">
                  <span className="material-symbols-outlined" aria-hidden>hub</span>
                  迭代绑定的 Projects
                </span>
                <button
                  type="button"
                  className="af-flow-snippet-modal__close"
                  onClick={() => setWorkflowProjectBindingOpen(false)}
                  aria-label="关闭"
                >
                  <span className="material-symbols-outlined" aria-hidden>close</span>
                </button>
              </div>
              <div className="af-flow-snippet-modal__body">
                <p className="af-workflow-project-modal__lead">
                  Workspace 和 Display 属于 Project。只有主动绑定后，全局迭代才能进入对应的 Project 视图。
                </p>
                {workflowProjectBindingError ? (
                  <p className="af-workflow-project-modal__error">{workflowProjectBindingError}</p>
                ) : null}
                <section className="af-workflow-project-modal__section">
                  <div className="af-workflow-project-modal__section-head">
                    <strong>已绑定</strong>
                    <span>{workflowProjectBindings.length}</span>
                  </div>
                  {workflowProjectBindings.length ? (
                    <div className="af-workflow-project-modal__list">
                      {workflowProjectBindings.map((project) => (
                        <article key={project.workspaceId} className="af-workflow-project-modal__item">
                          <div>
                            <strong>{project.label || project.flowId}</strong>
                            <small>{project.description || `${project.flowSource || "user"} · ${project.role || "member"}`}</small>
                          </div>
                          <div className="af-workflow-project-modal__actions">
                            <button type="button" onClick={() => openWorkflowProjectView(project, "workspace")}>Workspace</button>
                            <button type="button" onClick={() => openWorkflowProjectView(project, "display")}>Display</button>
                            {project.canManage ? (
                              <button
                                type="button"
                                className="af-workflow-project-modal__unbind"
                                disabled={workflowProjectBindingBusy}
                                onClick={() => void unbindWorkflowProject(project)}
                              >
                                解绑
                              </button>
                            ) : null}
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : (
                    <p className="af-display-link-modal__empty">当前迭代尚未绑定 Project。</p>
                  )}
                </section>
                <section className="af-workflow-project-modal__section">
                  <div className="af-workflow-project-modal__section-head">
                    <strong>绑定 Project</strong>
                    <span>Owner / Editor</span>
                  </div>
                  {workflowAvailableProjects.length ? (
                    <div className="af-workflow-project-modal__bind-row">
                      <select
                        value={workflowProjectSelection}
                        disabled={workflowProjectBindingBusy}
                        onChange={(event) => setWorkflowProjectSelection(event.target.value)}
                        aria-label="选择要绑定的 Project"
                      >
                        {workflowAvailableProjects.map((project) => (
                          <option key={workflowProjectBindingKey(project)} value={workflowProjectBindingKey(project)}>
                            {project.label || project.flowId}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className="af-flow-snippet-modal__btn af-flow-snippet-modal__btn--primary"
                        disabled={workflowProjectBindingBusy || !workflowProjectSelection}
                        onClick={() => void bindWorkflowProject()}
                      >
                        {workflowProjectBindingBusy ? "处理中…" : "确认绑定"}
                      </button>
                    </div>
                  ) : (
                    <p className="af-display-link-modal__empty">没有你可编辑且尚未绑定的 Project。</p>
                  )}
                </section>
              </div>
              <div className="af-flow-snippet-modal__foot">
                <button type="button" className="af-flow-snippet-modal__btn" onClick={() => setWorkflowProjectBindingOpen(false)}>关闭</button>
                {workflowProjectBindings.length === 1 ? (
                  <button
                    type="button"
                    className="af-flow-snippet-modal__btn af-flow-snippet-modal__btn--primary"
                    onClick={() => openWorkflowProjectView(workflowProjectBindings[0], workflowProjectPendingMode)}
                  >
                    {workflowProjectPendingMode === "display" ? "进入 Display" : "进入 Workspace"}
                  </button>
                ) : null}
              </div>
            </div>
          </div>,
          document.body,
        ) : null}
        {workspaceConflictOpen && workspaceConflict ? createPortal(
          <div className="af-flow-snippet-modal-overlay">
            <div className="af-flow-snippet-modal af-workspace-conflict-modal" role="dialog" aria-modal="true" aria-label="解决 Workspace 冲突">
              <div className="af-flow-snippet-modal__head">
                <span className="af-flow-snippet-modal__title">
                  <span className="material-symbols-outlined" aria-hidden>difference</span>
                  解决 {workspaceConflict.conflictItems?.length || 0} 处字段冲突
                </span>
                <button
                  type="button"
                  className="af-flow-snippet-modal__close"
                  onClick={() => setWorkspaceConflictOpen(false)}
                  aria-label="关闭"
                >
                  <span className="material-symbols-outlined" aria-hidden>close</span>
                </button>
              </div>
              <div className="af-flow-snippet-modal__body">
                <div className="af-workspace-conflict-summary">
                  未冲突的改动已经自动合并。这里只需要决定双方同时修改的字段。
                  <div className="af-workspace-conflict-bulk">
                    <button
                      type="button"
                      onClick={() => setWorkspaceConflictChoices(Object.fromEntries(
                        (workspaceConflict.conflictItems || []).map((item, index) => [
                          String(index),
                          { mode: "local", manual: workspaceConflictManualText(item) },
                        ]),
                      ))}
                    >
                      全部保留我的
                    </button>
                    <button
                      type="button"
                      onClick={() => setWorkspaceConflictChoices(Object.fromEntries(
                        (workspaceConflict.conflictItems || []).map((item, index) => [
                          String(index),
                          { mode: "remote", manual: workspaceConflictManualText(item) },
                        ]),
                      ))}
                    >
                      全部使用远端
                    </button>
                  </div>
                </div>
                {(workspaceConflict.conflictItems || []).map((item, index) => {
                  const choice = workspaceConflictChoices[String(index)] || {
                    mode: "local",
                    manual: workspaceConflictManualText(item),
                  };
                  return (
                    <section className="af-workspace-conflict-item" key={`${item.path || "conflict"}-${index}`}>
                      <code className="af-workspace-conflict-path">{item.path}</code>
                      <div className="af-workspace-conflict-options">
                        {[
                          ["local", "保留我的"],
                          ["remote", "使用远端"],
                          ["manual", "手动编辑"],
                        ].map(([mode, label]) => (
                          <button
                            type="button"
                            key={mode}
                            className={choice.mode === mode ? "is-active" : ""}
                            onClick={() => setWorkspaceConflictChoices((current) => ({
                              ...current,
                              [String(index)]: { ...choice, mode },
                            }))}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                      <div className="af-workspace-conflict-values">
                        <div className={choice.mode === "local" ? "is-selected" : ""}>
                          <span>我的修改</span>
                          <pre>{workspaceConflictValueText(item, "incoming")}</pre>
                        </div>
                        <div className={choice.mode === "remote" ? "is-selected" : ""}>
                          <span>远端修改</span>
                          <pre>{workspaceConflictValueText(item, "current")}</pre>
                        </div>
                      </div>
                      {choice.mode === "manual" ? (
                        <label className="af-workspace-conflict-manual">
                          <span>最终值（JSON）</span>
                          <textarea
                            value={choice.manual}
                            onChange={(event) => setWorkspaceConflictChoices((current) => ({
                              ...current,
                              [String(index)]: { ...choice, manual: event.target.value },
                            }))}
                            rows={5}
                          />
                        </label>
                      ) : null}
                    </section>
                  );
                })}
                {workspaceConflictError ? <div className="af-flow-snippet-error">{workspaceConflictError}</div> : null}
              </div>
              <div className="af-flow-snippet-modal__foot af-workspace-conflict-foot">
                <button
                  type="button"
                  className="af-flow-snippet-modal__btn"
                  disabled={workspaceConflictBusy}
                  onClick={() => void backupDraftAndReloadWorkspace()}
                >
                  备份并载入远端
                </button>
                <span className="af-workspace-conflict-foot__spacer" />
                <button
                  type="button"
                  className="af-flow-snippet-modal__btn"
                  disabled={workspaceConflictBusy}
                  onClick={() => setWorkspaceConflictOpen(false)}
                >
                  稍后处理
                </button>
                <button
                  type="button"
                  className="af-flow-snippet-modal__btn af-flow-snippet-modal__btn--primary"
                  disabled={workspaceConflictBusy || !(workspaceConflict.conflictItems || []).length}
                  onClick={() => void resolveWorkspaceConflict()}
                >
                  {workspaceConflictBusy ? "保存中..." : "应用选择并保存"}
                </button>
              </div>
            </div>
          </div>,
          document.body,
        ) : null}
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
        {displayPreviewNode ? (
          <DisplayFullscreenPreview node={displayPreviewNode} onClose={() => setDisplayPreviewNodeId("")} />
        ) : null}
        {displayShareOpen ? createPortal(
          <div className="af-flow-snippet-modal-overlay">
            <div className="af-flow-snippet-modal af-display-share-modal" role="dialog" aria-modal="true" aria-label={singleNodeDisplayShare ? "新建分享" : "发布展示页"}>
              <div className="af-flow-snippet-modal__head">
                <span className="af-flow-snippet-modal__title">
                  <span className="material-symbols-outlined" aria-hidden>present_to_all</span>
                  {singleNodeDisplayShare ? "新建分享" : "发布展示页"}
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
                {!singleNodeDisplayShare ? (
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
                ) : null}
                <label className="af-flow-snippet-field">
                  <span>有效期</span>
                  <select
                    className="af-display-share-select"
                    value={displayShareExpiryValue(displayShareDraft)}
                    onChange={(event) => {
                      const value = event.target.value;
                      setDisplayShareDraft((prev) => ({
                        ...prev,
                        permanent: value === "permanent",
                        expiresInDays: value === "permanent" ? prev.expiresInDays || 30 : Number(value),
                      }));
                    }}
                  >
                    {DISPLAY_SHARE_EXPIRY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
                <div className="af-display-share-node-list" role="group" aria-label={singleNodeDisplayShare ? "分享内容" : "选择展示节点"}>
                  {singleNodeDisplayShare ? <span className="af-display-share-node-list__label">分享内容</span> : null}
                  {displayShareSelectableNodes.map((node) => {
                    const checked = Array.isArray(displayShareDraft.nodeIds) && displayShareDraft.nodeIds.includes(node.id);
                    return (
                      <label key={node.id} className="af-display-share-node-row">
                        <input
                          type="checkbox"
                          checked={checked}
                          disabled={singleNodeDisplayShare}
                          onChange={() => toggleDisplayShareNode(node.id)}
                        />
                        <span className="af-display-share-node-row__main">
                          <strong>{node.data?.label || node.id}</strong>
                          <small>{workspaceDisplayKindFromData(node.data)} · {node.id}</small>
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
                <label className="af-flow-snippet-field">
                  <span>新链接有效期</span>
                  <select
                    className="af-display-share-select"
                    value={displayShareExpiryValue(displayShareDraft)}
                    onChange={(event) => {
                      const value = event.target.value;
                      setDisplayShareDraft((prev) => ({
                        ...prev,
                        permanent: value === "permanent",
                        expiresInDays: value === "permanent" ? prev.expiresInDays || 30 : Number(value),
                      }));
                    }}
                  >
                    {DISPLAY_SHARE_EXPIRY_OPTIONS.map((option) => (
                      <option key={option.value} value={option.value}>{option.label}</option>
                    ))}
                  </select>
                </label>
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
        {workspaceShareOpen ? createPortal(
          <div className="af-flow-snippet-modal-overlay">
            <div className="af-flow-snippet-modal af-display-share-modal" role="dialog" aria-modal="true" aria-label="项目协作">
              <div className="af-flow-snippet-modal__head">
                <span className="af-flow-snippet-modal__title">
                  <span className="material-symbols-outlined" aria-hidden>group_add</span>
                  项目协作
                </span>
                <button
                  type="button"
                  className="af-flow-snippet-modal__close"
                  onClick={() => setWorkspaceShareOpen(false)}
                  aria-label="关闭"
                >
                  <span className="material-symbols-outlined" aria-hidden>close</span>
                </button>
              </div>
              <div className="af-flow-snippet-modal__body">
                <div className="af-workspace-team-share">
                  <div className="af-workspace-team-share__head">
                    <strong>分享到团队</strong>
                    <span>{workspaceShareTeam ? workspaceShareTeam.name : "尚未加入团队"}</span>
                  </div>
                  {workspaceShareTeam ? (
                    <div className="af-workspace-team-share__actions">
                      <select value={workspaceShareTeamRole} onChange={(event) => setWorkspaceShareTeamRole(event.target.value)} aria-label="团队权限">
                        <option value="viewer">只读</option>
                        <option value="editor">可编辑和运行</option>
                      </select>
                      {workspaceCollaboration?.teamShares?.some((share) => share.teamId === workspaceShareTeam.id) ? (
                        <>
                          <button type="button" disabled={workspaceShareTeamBusy} onClick={() => void updateWorkspaceTeamShare(false)}>{workspaceShareTeamBusy ? "处理中..." : "更新权限"}</button>
                          <button type="button" disabled={workspaceShareTeamBusy} onClick={() => void updateWorkspaceTeamShare(true)}>取消分享</button>
                        </>
                      ) : (
                        <button type="button" disabled={workspaceShareTeamBusy} onClick={() => void updateWorkspaceTeamShare(false)}>{workspaceShareTeamBusy ? "分享中..." : "分享到团队"}</button>
                      )}
                    </div>
                  ) : <p className="af-display-link-modal__empty">联系超级管理员将你加入团队后，即可在这里分享。</p>}
                </div>
                <p className="af-display-link-modal__empty">
                  输入已注册用户名。添加后，这个 Workspace 会直接出现在对方的项目列表中。
                </p>
                <div className="af-workspace-member-add">
                  <input
                    type="text"
                    value={workspaceShareUsername}
                    onChange={(event) => setWorkspaceShareUsername(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && workspaceShareUsername.trim() && !workspaceShareBusy) {
                        event.preventDefault();
                        void shareWorkspaceWithUser();
                      }
                    }}
                    placeholder="输入用户名"
                    autoFocus
                  />
                  <button
                    type="button"
                    disabled={workspaceShareBusy || !workspaceShareUsername.trim()}
                    onClick={() => void shareWorkspaceWithUser()}
                  >
                    {workspaceShareBusy ? "添加中..." : "添加成员"}
                  </button>
                </div>
                {workspaceShareError ? <div className="af-flow-snippet-error">{workspaceShareError}</div> : null}
                <div className="af-workspace-member-list">
                  {(workspaceCollaboration?.members || []).map((member) => {
                    const isOwner = member.userId === workspaceCollaboration?.ownerId || member.role === "owner";
                    return (
                      <div className="af-workspace-member-row" key={member.userId}>
                        <span className="material-symbols-outlined" aria-hidden>{isOwner ? "shield_person" : "person"}</span>
                        <div>
                          <strong>{member.username || member.userId}</strong>
                          <small>{isOwner ? "所有者" : member.role === "viewer" ? "只读成员" : "编辑成员"}</small>
                        </div>
                        {!isOwner ? (
                          <button
                            type="button"
                            disabled={workspaceShareRemovingUserId === member.userId}
                            onClick={() => void removeWorkspaceSharedMember(member)}
                          >
                            {workspaceShareRemovingUserId === member.userId ? "移除中..." : "取消分享"}
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              </div>
              <div className="af-flow-snippet-modal__foot">
                <button
                  type="button"
                  className="af-flow-snippet-modal__btn"
                  onClick={() => setWorkspaceShareOpen(false)}
                >
                  完成
                </button>
              </div>
            </div>
          </div>,
          document.body,
        ) : null}
        {displaySharesOpen ? createPortal(
          <div className="af-flow-snippet-modal-overlay">
            <div className="af-flow-snippet-modal af-display-shares-modal" role="dialog" aria-modal="true" aria-label="我的分享">
              <div className="af-flow-snippet-modal__head">
                <span className="af-flow-snippet-modal__title">
                  <span className="material-symbols-outlined" aria-hidden>folder_shared</span>
                  我的分享
                </span>
                <button
                  type="button"
                  className="af-flow-snippet-modal__close"
                  onClick={() => setDisplaySharesOpen(false)}
                  aria-label="关闭"
                >
                  <span className="material-symbols-outlined" aria-hidden>close</span>
                </button>
              </div>
              <div className="af-flow-snippet-modal__body">
                <div className="af-display-shares-toolbar">
                  <span>{displayShares.length ? `${displayShares.length} 个分享` : "暂无分享"}</span>
                  <button type="button" onClick={() => void loadDisplayShares()} disabled={displaySharesLoading}>
                    <span className="material-symbols-outlined" aria-hidden>refresh</span>
                    刷新
                  </button>
                </div>
                {displaySharesError ? <div className="af-flow-snippet-error">{displaySharesError}</div> : null}
                {displaySharesLoading ? <div className="af-display-link-modal__empty">正在读取展示分享…</div> : null}
                {!displaySharesLoading && displayShares.length === 0 ? (
                  <div className="af-display-link-modal__empty">还没有创建过展示分享</div>
                ) : null}
                <div className="af-display-shares-list">
                  {displayShares.map((share) => {
                    const url = displayShareUrl(share);
                    const busy = displayShareUpdatingId === share.id;
                    const expiryValue = !share.expiresAt ? "permanent" : String(share.expiresInDays || 30);
                    return (
                      <article key={share.id} className="af-display-share-item">
                        <div className="af-display-share-item__main">
                          <strong>{share.title || "AgentFlow Display"}</strong>
                          <span>{share.flowId || "-"} · {share.layout || "gallery"} · {Array.isArray(share.nodeIds) ? share.nodeIds.length : 0} nodes</span>
                          <small>{formatDisplayShareExpiry(share)}</small>
                        </div>
                        <input className="af-display-share-item__url" type="text" readOnly value={url} onFocus={(event) => event.target.select()} />
                        <select
                          className="af-display-share-select"
                          value={expiryValue}
                          disabled={busy}
                          onChange={(event) => void updateDisplayShareExpiry(share, event.target.value)}
                          aria-label="修改分享有效期"
                        >
                          {DISPLAY_SHARE_EXPIRY_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>{option.label}</option>
                          ))}
                        </select>
                        <div className="af-display-share-item__actions">
                          <button type="button" onClick={() => window.open(url, "_blank", "noopener,noreferrer")}>
                            <span className="material-symbols-outlined" aria-hidden>open_in_new</span>
                            打开
                          </button>
                          <button type="button" onClick={() => void copyDisplayShareListUrl(share)}>
                            <span className="material-symbols-outlined" aria-hidden>{displayShareCopyId === share.id ? "check" : "content_copy"}</span>
                            {displayShareCopyId === share.id ? "已复制" : "复制"}
                          </button>
                          <button type="button" className="af-display-share-item__danger" disabled={busy} onClick={() => void revokeDisplayShare(share)}>
                            <span className="material-symbols-outlined" aria-hidden>{busy ? "hourglass_empty" : "link_off"}</span>
                            撤销
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
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
        {provideFilePicker.nodeId ? createPortal(
          <WorkspaceFilePickerModal
            files={files}
            query={provideFilePicker.query}
            onQueryChange={(query) => setProvideFilePicker((prev) => ({ ...prev, query }))}
            onSelect={selectProvideFile}
            onUpload={triggerWorkspaceFileUpload}
            onClose={closeProvideFilePicker}
          />,
          document.body,
        ) : null}
        {!isDisplayMode && !isWorkflowMode && quickAddOpen ? createPortal(
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
