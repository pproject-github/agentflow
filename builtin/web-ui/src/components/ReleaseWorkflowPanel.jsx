import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getReleaseNodes, inferReleaseContext, runReleaseNode } from "../lib/releaseNodeCatalog.js";
import {
  artifactHref,
  artifactLabel,
  humanizeWaitingMatter,
  resolveStageArtifacts,
  resolveStageSummary,
  resolveWaitingInfo,
  truncateSummary,
} from "../lib/releaseStageOutcome.js";
import { createCompletionMetadata, createInitializationNode, createInitializationPreparationNode, createPresetInstance, defaultInputsForNode, ensureInitializationFirst, externalInputSchemaForNode, filterDismissedPending, mergeRemoteCatalog, normalizeCompositeSteps, removePendingNode, resolveReleaseContext, seedInitializationPreparationState, seedNextRecommendations } from "../lib/releaseWorkflowModel.js";
import { capabilityKeysForItem, createReleaseProcessStateMachine, processTitleForId, selectWorkflowProcessNodes } from "../lib/releaseWorkflowStateMachine.js";
import ReleaseNodeInspector from "./ReleaseNodeInspector.jsx";

function findBusyCapabilitySibling(pending, itemOrPreset, { excludeId } = {}) {
  const keys = capabilityKeysForItem({
    nodeId: itemOrPreset?.nodeId || itemOrPreset?.id,
    sourcePresetId: itemOrPreset?.sourcePresetId || itemOrPreset?.id,
    compositeId: itemOrPreset?.compositeId,
  });
  if (!keys.size) return null;
  return (Array.isArray(pending) ? pending : []).find((entry) => {
    if (!entry || (excludeId && entry.id === excludeId)) return false;
    const status = String(entry.status || "").toLowerCase();
    if (!["running"].includes(status)) return false;
    for (const key of capabilityKeysForItem(entry)) {
      if (keys.has(key)) return true;
    }
    return false;
  }) || null;
}

function emptyState() {
  return { timeline: [], pending: [], dismissedNodeIds: [], customNodes: [] };
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value, fallback = "") {
  return typeof value === "string" ? value : fallback;
}

function timestampValue(value) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 ? timestamp : undefined;
}

function safeInputs(value) {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, entry]) =>
    typeof entry === "string" || typeof entry === "number" || typeof entry === "boolean"));
}

function normalizeTimelineItem(value, index) {
  if (!isRecord(value) || typeof value.nodeId !== "string" || !value.nodeId.trim()) return null;
  const nodeId = value.nodeId.trim();
  return {
    id: stringValue(value.id).trim() || `${nodeId}-timeline-${index}`,
    nodeId,
    title: stringValue(value.title, nodeId),
    description: stringValue(value.description),
    category: stringValue(value.category, "发版阶段"),
    status: "completed",
    progress: 100,
    createdAt: timestampValue(value.createdAt),
    startedAt: timestampValue(value.startedAt),
    completedAt: timestampValue(value.completedAt),
    failedAt: timestampValue(value.failedAt),
    lastEventAt: timestampValue(value.lastEventAt),
    lastEvent: stringValue(value.lastEvent),
    durationMs: Number.isFinite(Number(value.durationMs)) ? Number(value.durationMs) : undefined,
    operator: stringValue(value.operator, "未记录"),
    runId: stringValue(value.runId),
    message: stringValue(value.message),
    error: stringValue(value.error),
    inputs: safeInputs(value.inputs),
    output: value.output,
    logs: Array.isArray(value.logs) ? value.logs : value.log,
    action: stringValue(value.action),
    skill: stringValue(value.skill),
    preview: value.preview,
    confirmationFingerprint: stringValue(value.confirmationFingerprint),
    scopeKey: stringValue(value.scopeKey),
    contextSnapshot: isRecord(value.contextSnapshot) ? { ...value.contextSnapshot } : undefined,
    processId: stringValue(value.processId),
    processOrder: Number.isFinite(Number(value.processOrder)) ? Number(value.processOrder) : undefined,
    processTitle: stringValue(value.processTitle),
    workflowId: stringValue(value.workflowId),
    templateId: stringValue(value.templateId),
    templateStepId: stringValue(value.templateStepId),
    kind: stringValue(value.kind),
    compositeId: stringValue(value.compositeId),
    sourcePresetId: stringValue(value.sourcePresetId),
    waiting: isRecord(value.waiting) ? { ...value.waiting } : value.waiting,
    details: isRecord(value.details) ? { ...value.details, steps: normalizeCompositeSteps(value.details.steps) } : undefined,
  };
}

function normalizePendingItem(value, index) {
  if (!isRecord(value) || typeof value.nodeId !== "string" || !value.nodeId.trim()) return null;
  const nodeId = value.nodeId.trim();
  // waiting 必须保留：远端/本地确认态不能在同步时被压成 pending，否则 hollow completed 会把它从待执行挤掉。
  const status = ["pending", "running", "failed", "waiting"].includes(value.status) ? value.status : "pending";
  return {
    id: stringValue(value.id).trim() || `${nodeId}-pending-${index}`,
    nodeId,
    title: stringValue(value.title, nodeId),
    description: stringValue(value.description),
    category: stringValue(value.category, "发版阶段"),
    // 正在执行的节点必须保持运行态；否则刷新后会被误判为待执行并暴露删除操作。
    status,
    progress: Math.min(Math.max(Number(value.progress) || 0, 0), 100),
    createdAt: timestampValue(value.createdAt) || Date.now(),
    startedAt: timestampValue(value.startedAt),
    completedAt: timestampValue(value.completedAt),
    failedAt: timestampValue(value.failedAt),
    lastEventAt: timestampValue(value.lastEventAt),
    lastEvent: stringValue(value.lastEvent),
    operator: stringValue(value.operator, "未记录"),
    runId: stringValue(value.runId),
    error: stringValue(value.error),
    message: stringValue(value.message),
    waiting: isRecord(value.waiting) ? { ...value.waiting } : value.waiting,
    inputs: safeInputs(value.inputs),
    output: value.output,
    logs: Array.isArray(value.logs) ? value.logs : value.log,
    action: stringValue(value.action),
    skill: stringValue(value.skill),
    preview: value.preview,
    confirmationFingerprint: stringValue(value.confirmationFingerprint),
    scopeKey: stringValue(value.scopeKey),
    contextSnapshot: isRecord(value.contextSnapshot) ? { ...value.contextSnapshot } : undefined,
    processId: stringValue(value.processId),
    processOrder: Number.isFinite(Number(value.processOrder)) ? Number(value.processOrder) : undefined,
    processTitle: stringValue(value.processTitle),
    workflowId: stringValue(value.workflowId),
    templateId: stringValue(value.templateId),
    templateStepId: stringValue(value.templateStepId),
    kind: stringValue(value.kind),
    compositeId: stringValue(value.compositeId),
    sourcePresetId: stringValue(value.sourcePresetId),
    details: isRecord(value.details) ? { ...value.details, steps: normalizeCompositeSteps(value.details.steps) } : undefined,
  };
}

function normalizeCustomNode(value) {
  if (!isRecord(value) || typeof value.id !== "string" || !value.id.trim() || !value.id.startsWith("custom-") || typeof value.title !== "string" || !value.title.trim()) return null;
  const asStringArray = (entry) => Array.isArray(entry) ? entry.filter((item) => typeof item === "string" && item.trim()) : [];
  return {
    id: value.id,
    title: value.title,
    description: stringValue(value.description, "自定义发版阶段"),
    skill: stringValue(value.skill, "custom"),
    category: stringValue(value.category, "自定义阶段"),
    businessLines: asStringArray(value.businessLines),
    platforms: asStringArray(value.platforms),
    sourcePresetId: stringValue(value.sourcePresetId),
    templateId: stringValue(value.templateId),
    templateStepId: stringValue(value.templateStepId),
    templateStepIndex: Number.isFinite(Number(value.templateStepIndex)) ? Number(value.templateStepIndex) : undefined,
    durationMs: Number.isFinite(Number(value.durationMs)) ? Number(value.durationMs) : 600,
    nextNodeIds: asStringArray(value.nextNodeIds),
    inputSchema: Array.isArray(value.inputSchema) ? value.inputSchema.filter(isRecord).map((input) => ({ ...input })) : [],
    kind: stringValue(value.kind),
    compositeId: stringValue(value.compositeId),
    promptTemplate: stringValue(value.promptTemplate),
    skillHints: asStringArray(value.skillHints),
    requiresConfirmation: value.requiresConfirmation === true,
    insertableInAnyStage: value.insertableInAnyStage === true,
    scopeKey: stringValue(value.scopeKey),
    contextSnapshot: isRecord(value.contextSnapshot) ? { ...value.contextSnapshot } : undefined,
    processId: stringValue(value.processId),
    processOrder: Number.isFinite(Number(value.processOrder)) ? Number(value.processOrder) : undefined,
    processTitle: stringValue(value.processTitle),
    workflowId: stringValue(value.workflowId),
  };
}

function uniqueByNodeId(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.nodeId)) return false;
    seen.add(item.nodeId);
    return true;
  });
}

function uniqueById(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
}

function workspaceIdentity(workspace) {
  if (workspace == null) return "workspace";
  if (typeof workspace === "string") return workspace;
  return workspace.id || workspace.path || workspace.repoUrl || workspace.label || "workspace";
}

function storageKey(workspace, context) {
  return ["agentflow-release", workspaceIdentity(workspace), context.businessLine, context.platform, context.version, context.batch || "initial"]
    .map((value) => encodeURIComponent(String(value || "")))
    .join(":");
}

function mergeDismissedNodeIds(...lists) {
  return [...new Set(lists.flatMap((list) => (Array.isArray(list) ? list : []))
    .map((item) => String(item || "").trim()).filter(Boolean))];
}

function releaseItemHasSummary(item) {
  return Boolean(
    (item?.output && typeof item.output === "object" && item.output.summary)
    || item?.details?.summary
    || item?.message,
  );
}

function isHollowCompletedReleaseItem(item) {
  return String(item?.status || "").toLowerCase() === "completed" && !releaseItemHasSummary(item);
}

function hydrateReleaseItemFromRuns(item, runs = {}) {
  const runId = String(item?.runId || "").trim();
  const run = runId && runs[runId] && typeof runs[runId] === "object" ? runs[runId] : null;
  if (!run) return item;
  const hasSummary = releaseItemHasSummary(item);
  if (hasSummary && item.status && item.status !== "completed") return item;
  const runStatus = String(run.status || run.output?.status || "").toLowerCase();
  const next = { ...item };
  if (!hasSummary) {
    if (run.output) next.output = run.output;
    if (run.details) next.details = { ...(item.details || {}), ...run.details };
    if (run.waiting) next.waiting = run.waiting;
    if (run.message) next.message = run.message;
  } else if (!next.waiting && run.waiting) {
    next.waiting = run.waiting;
  }
  // waiting 按成功展示：时间线条目保持 completed，待办挂在 waiting 字段。
  if (runStatus === "waiting" && String(item.status).toLowerCase() === "completed") {
    if (!next.waiting) next.waiting = run.waiting || run.output?.waiting || { reason: "待人工处理" };
  }
  return next;
}

function runSaysWaitingForNode(nodeId, runId, runs = {}) {
  const directId = String(runId || "").trim();
  const direct = directId && runs[directId] && typeof runs[directId] === "object" ? runs[directId] : null;
  if (direct && String(direct.status || direct.output?.status || "").toLowerCase() === "waiting") return true;
  const target = String(nodeId || "").trim();
  if (!target) return false;
  return Object.values(runs).some((run) => (
    run && typeof run === "object"
    && String(run.nodeId || "").trim() === target
    && String(run.status || run.output?.status || "").toLowerCase() === "waiting"
  ));
}

function promoteWaitingItemToCompleted(item) {
  return {
    ...item,
    status: "completed",
    progress: 100,
    completedAt: item.completedAt || item.lastEventAt || Date.now(),
    error: "",
    failedAt: undefined,
    waiting: item.waiting || item.output?.waiting || { reason: item.message || "待人工处理" },
  };
}

function mergeRemotePending(previous, remoteState, context, knownIds, localCustomPending = []) {
  const dismissedNodeIds = mergeDismissedNodeIds(previous.dismissedNodeIds, remoteState.dismissedNodeIds);
  const runs = isRecord(remoteState.runs) ? remoteState.runs : {};
  const hydratedTimeline = (Array.isArray(remoteState.timeline) ? remoteState.timeline : [])
    .map(normalizeTimelineItem)
    .filter(Boolean)
    .filter((item) => knownIds.has(item.nodeId) || knownIds.has(item.sourcePresetId))
    .map((item) => hydrateReleaseItemFromRuns(item, runs));
  const hydratedRemotePending = (Array.isArray(remoteState.pending) ? remoteState.pending : [])
    .map(normalizePendingItem)
    .filter(Boolean)
    .map((item) => hydrateReleaseItemFromRuns(item, runs));
  // 兼容旧快照：远端仍把 waiting 放在 pending 时，提升为时间线成功项。
  const promotedFromPending = [];
  const remotePendingKeep = [];
  for (const item of hydratedRemotePending) {
    if (String(item.status || "").toLowerCase() === "waiting") {
      promotedFromPending.push(promoteWaitingItemToCompleted(item));
      continue;
    }
    remotePendingKeep.push(item);
  }
  const remoteTimeline = [];
  for (const item of hydratedTimeline) {
    const status = String(item.status || "").toLowerCase();
    if (status === "waiting") {
      remoteTimeline.push(promoteWaitingItemToCompleted(item));
      continue;
    }
    if (isHollowCompletedReleaseItem(item) && runSaysWaitingForNode(item.nodeId, item.runId, runs)) {
      remoteTimeline.push(promoteWaitingItemToCompleted({
        ...item,
        waiting: item.waiting || runs[String(item.runId || "")]?.waiting || runs[String(item.runId || "")]?.output?.waiting,
      }));
      continue;
    }
    remoteTimeline.push(item);
  }
  for (const item of promotedFromPending) {
    if (!remoteTimeline.some((entry) => entry.nodeId === item.nodeId || entry.id === item.id)) {
      remoteTimeline.push(item);
    }
  }
  const completedIds = new Set(remoteTimeline.map((item) => item.nodeId));
  const remotePending = filterDismissedPending(
    remotePendingKeep
      .filter((item) => (knownIds.has(item.nodeId) || knownIds.has(item.sourcePresetId)) && itemMatchesContext(item, context) && !completedIds.has(item.nodeId)),
    dismissedNodeIds,
  );
  const remotePendingIds = new Set(remotePending.map((item) => item.id));
  const remotePendingNodeIds = new Set(remotePending.map((item) => item.nodeId));
  // 推荐节点只存在于浏览器；远端快照 pending 为空时不能每次同步都清掉再重建，否则卡片 key 抖动会整页闪烁。
  const localRecommendedPending = filterDismissedPending(
    (Array.isArray(previous.pending) ? previous.pending : [])
      .map(normalizePendingItem)
      .filter(Boolean)
      .map((item) => hydrateReleaseItemFromRuns(item, runs))
      .filter((item) => itemMatchesContext(item, context)
        && !completedIds.has(item.nodeId)
        && !remotePendingIds.has(item.id)
        && !remotePendingNodeIds.has(item.nodeId)
        && (knownIds.has(item.nodeId) || knownIds.has(item.sourcePresetId))
        && !String(item.nodeId || "").startsWith("custom-")
        && !localCustomPending.some((entry) => entry.id === item.id || entry.nodeId === item.nodeId)),
    dismissedNodeIds,
  );
  return {
    dismissedNodeIds,
    timeline: uniqueByNodeId(remoteTimeline.filter((item) => itemMatchesContext(item, context))),
    pending: uniqueById([
      ...remotePending,
      ...filterDismissedPending(localCustomPending, dismissedNodeIds),
      ...localRecommendedPending,
    ]),
  };
}

function readState(key, catalogNodeIds = null) {
  if (typeof window === "undefined" || !window.localStorage) return emptyState();
  try {
    const value = JSON.parse(window.localStorage.getItem(key) || "null");
    if (!isRecord(value)) return emptyState();
    const customNodes = uniqueById(Array.isArray(value.customNodes) ? value.customNodes.map(normalizeCustomNode).filter(Boolean) : []);
    const knownNodeIds = catalogNodeIds ? new Set([...catalogNodeIds, ...customNodes.map((item) => item.id)]) : null;
    const timeline = uniqueByNodeId(Array.isArray(value.timeline) ? value.timeline.map(normalizeTimelineItem).filter(Boolean) : [])
      .filter((item) => !knownNodeIds || knownNodeIds.has(item.nodeId) || knownNodeIds.has(item.sourcePresetId));
    const completedIds = new Set(timeline.map((item) => item.nodeId));
    const pending = uniqueById(Array.isArray(value.pending) ? value.pending.map(normalizePendingItem).filter(Boolean) : [])
      .filter((item) => !completedIds.has(item.nodeId) && (!knownNodeIds || knownNodeIds.has(item.nodeId) || knownNodeIds.has(item.sourcePresetId)));
    return {
      context: isRecord(value.context) ? { ...value.context } : undefined,
      workflowId: stringValue(value.workflowId),
      timeline,
      pending,
      dismissedNodeIds: Array.isArray(value.dismissedNodeIds)
        ? [...new Set(value.dismissedNodeIds.map((item) => String(item || "").trim()).filter(Boolean))]
        : [],
      customNodes,
    };
  } catch {
    return emptyState();
  }
}

function itemId(nodeId) {
  return `${nodeId}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function statusLabel(status) {
  // waiting 无 Agent 交互续跑：按成功展示，待办另述。
  return { completed: "成功", running: "执行中", failed: "失败", pending: "待执行", waiting: "成功" }[status] || status;
}

/** Compact summary + artifact chips for timeline/pending cards (Inspector keeps full detail). */
function renderStageOutcome(item) {
  const summary = truncateSummary(resolveStageSummary(item));
  const linkedArtifacts = resolveStageArtifacts(item).filter((artifact) => artifactHref(artifact));
  const waiting = resolveWaitingInfo(item);
  if (!summary && linkedArtifacts.length === 0 && !waiting) return null;
  const shown = linkedArtifacts.slice(0, 3);
  const rest = linkedArtifacts.length - shown.length;
  return (
    <div className="af-release-stage-outcome">
      {waiting ? (
        <div className="af-release-stage-outcome__waiting">
          <span>待办：{waiting.label || waiting.reason}</span>
          {waiting.operatorUrl ? (
            <a href={waiting.operatorUrl} target="_blank" rel="noreferrer" onClick={(event) => event.stopPropagation()}>打开</a>
          ) : null}
        </div>
      ) : null}
      {summary ? <p className="af-release-stage-outcome__summary">{summary}</p> : null}
      {shown.length > 0 ? (
        <div className="af-release-stage-outcome__artifacts">
          {shown.map((artifact, index) => {
            const href = artifactHref(artifact);
            return (
              <a
                key={`${href}-${index}`}
                className="af-release-artifact-chip"
                href={href}
                target="_blank"
                rel="noreferrer"
                onClick={(event) => event.stopPropagation()}
              >
                {artifactLabel(artifact)}
              </a>
            );
          })}
          {rest > 0 ? <span className="af-release-artifact-chip af-release-artifact-chip--more">+{rest}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function formatDateTime(value) {
  const timestamp = timestampValue(value);
  if (!timestamp) return "未记录";
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(timestamp);
}

function formatDuration(value) {
  const duration = Number(value);
  if (!Number.isFinite(duration) || duration < 0) return "未记录";
  if (duration < 1000) return `${duration}ms`;
  return `${(duration / 1000).toFixed(duration >= 10000 ? 0 : 1)}s`;
}

// 用户需求点: 页面只持久化可读结论，不能把 AgentFlow graph/instances 整棵写进 output。
function parseLeadingJsonValue(text) {
  const source = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  if (!source.startsWith("{") && !source.startsWith("[")) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (char === "\\") { escape = true; continue; }
      if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") { inString = true; continue; }
    if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) {
        try {
          return { value: JSON.parse(source.slice(0, index + 1)), rest: source.slice(index + 1).trim() };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function hydrateReleaseOutputEnvelope(candidate) {
  if (typeof candidate === "string") {
    const parsed = parseLeadingJsonValue(candidate);
    if (parsed?.value && typeof parsed.value === "object" && !Array.isArray(parsed.value)) {
      const trailing = String(parsed.rest || "").trim();
      const nestedSummary = String(parsed.value.summary || parsed.value.message || "").trim();
      const preferTrailing = trailing && (trailing.includes("**") || /\[[^\]]+\]\(https?:\/\//.test(trailing) || trailing.includes("\n"));
      return {
        ...parsed.value,
        summary: preferTrailing ? trailing : (nestedSummary || trailing || candidate),
      };
    }
    return candidate;
  }
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) return candidate;
  const summaryText = typeof candidate.summary === "string" ? candidate.summary.trim() : "";
  const nested = parseLeadingJsonValue(summaryText);
  if (!nested?.value || typeof nested.value !== "object" || Array.isArray(nested.value)) return candidate;
  const trailing = String(nested.rest || "").trim();
  const nestedSummary = String(nested.value.summary || nested.value.message || "").trim();
  const preferTrailing = trailing && (trailing.includes("**") || /\[[^\]]+\]\(https?:\/\//.test(trailing) || trailing.includes("\n"));
  return {
    ...candidate,
    ...nested.value,
    status: nested.value.status || candidate.status,
    summary: preferTrailing ? trailing : (nestedSummary || trailing || candidate.summary),
    steps: Array.isArray(nested.value.steps) && nested.value.steps.length ? nested.value.steps : candidate.steps,
    records: Array.isArray(nested.value.records) && nested.value.records.length ? nested.value.records : candidate.records,
    artifacts: Array.isArray(nested.value.artifacts) && nested.value.artifacts.length ? nested.value.artifacts : candidate.artifacts,
  };
}

function sanitizeReleaseNodeOutput(payload = {}) {
  const candidates = [
    payload?.result?.output,
    payload?.output,
    payload?.result && typeof payload.result === "object" && !payload.result.graph && !payload.result.instances ? payload.result : null,
    payload?.details && typeof payload.details === "object" ? {
      status: payload.status || payload.details.status,
      summary: payload.details.summary || payload.message,
      steps: payload.details.steps,
      records: payload.details.records,
      artifacts: payload.details.artifacts,
      waiting: payload.details.waiting || payload.waiting,
    } : null,
  ];
  for (const candidate of candidates) {
    if (candidate == null) continue;
    if (typeof candidate === "string") {
      const hydrated = hydrateReleaseOutputEnvelope(candidate);
      if (hydrated && typeof hydrated === "object") return hydrated;
      const text = candidate.trim();
      if (text) return text;
      continue;
    }
    if (typeof candidate !== "object" || Array.isArray(candidate)) continue;
    if (candidate.graph || candidate.instances || candidate.edges || candidate.ui) {
      const { graph, instances, edges, ui, version, meta, ...rest } = candidate;
      if (rest.summary || rest.status || rest.steps || rest.records || rest.artifacts || rest.waiting) {
        return hydrateReleaseOutputEnvelope(rest);
      }
      continue;
    }
    return hydrateReleaseOutputEnvelope(candidate);
  }
  if (typeof payload?.message === "string" && payload.message.trim()) {
    return { status: payload.status || "completed", summary: payload.message.trim() };
  }
  return { status: payload.status || "completed", summary: "已完成" };
}

function releaseResultMessage(payload = {}, fallback = "已完成") {
  const raw = payload.message || payload.result?.summary || payload.details?.summary
    || (typeof payload.result?.output === "string" ? payload.result.output : "")
    || (typeof payload.output === "string" ? payload.output : "")
    || payload.output?.summary;
  return typeof raw === "string" && raw.trim() ? raw.trim() : fallback;
}

function compositeDetailsFromResult(result, node, existing = {}) {
  if (node?.kind !== "composite" && existing?.steps?.length) return existing;
  const output = result?.output && typeof result.output === "object" && !Array.isArray(result.output) ? result.output : null;
  const payload = result?.result && typeof result.result === "object" && !Array.isArray(result.result) ? result.result : null;
  const details = {
    ...existing,
    ...(result?.details && typeof result.details === "object" ? result.details : {}),
    ...(output?.summary ? { summary: output.summary } : {}),
    ...(payload?.summary ? { summary: payload.summary } : {}),
    ...(result?.summary ? { summary: result.summary } : {}),
    ...(output?.records ? { records: output.records } : {}),
    ...(payload?.records ? { records: payload.records } : {}),
    ...(result?.details?.records ? { records: result.details.records } : {}),
    ...(output?.artifacts ? { artifacts: output.artifacts } : {}),
    ...(payload?.artifacts ? { artifacts: payload.artifacts } : {}),
    ...(result?.waiting ? { waiting: result.waiting } : {}),
    ...(output?.waiting ? { waiting: output.waiting } : {}),
  };
  const explicit = result?.details?.steps || result?.result?.details?.steps || result?.result?.steps || result?.steps || output?.steps;
  if (Array.isArray(explicit)) return { ...details, steps: normalizeCompositeSteps(explicit) };
  const graph = result?.result?.graph || result?.graph;
  const instances = graph?.instances;
  if (!instances || !Array.isArray(node?.actions)) return details;
  const steps = node.actions.map((action, index) => {
    const instance = instances[`composite_${action.stepId || index}`] || {};
    return {
      stepId: action.stepId,
      actionId: action.id,
      title: action.title,
      status: instance.status || "completed",
      runId: instance.runId,
      output: instance.output,
      error: instance.error || "",
    };
  });
  return { ...details, steps: normalizeCompositeSteps(steps) };
}

// 用户需求点: 已完成阶段不依赖横向拖动，要按执行顺序蛇形换行并保持连续方向轨迹。
function groupCompletedTimelineRows(items, rowSize = 3) {
  const rows = [];
  for (let index = 0; index < items.length; index += rowSize) {
    rows.push(items.slice(index, index + rowSize));
  }
  return rows;
}

// 用户需求点: 新增或推荐的 Create Release Branch 节点要直接带上标准分支名，操作员仍可在输入框中覆盖它。
function makePending(node, inputs = {}, context = {}) {
  return {
    id: itemId(node.id), nodeId: node.id, title: node.title, description: node.description,
    category: node.category, status: "pending", progress: 0, createdAt: Date.now(), error: "", operator: "未记录", inputs: defaultInputsForNode(node, safeInputs(inputs)),
    scopeKey: node.scopeKey || `${context.businessLine}/${context.platform}/${context.version}/${context.batch || "initial"}`,
    contextSnapshot: { ...context },
    processId: node.processId || "",
    processOrder: Number.isFinite(Number(node.processOrder)) ? Number(node.processOrder) : undefined,
    processTitle: node.processTitle || processTitleForId(node.processId),
    workflowId: node.workflowId || "",
    templateId: node.templateId || "",
    templateStepId: node.templateStepId || "",
    kind: node.kind || "",
    compositeId: node.compositeId || "",
    sourcePresetId: node.sourcePresetId || "",
    details: node.kind === "composite" ? { steps: [] } : undefined,
  };
}

function itemMatchesContext(item, context) {
  if (!item?.scopeKey) return true;
  return item.scopeKey === `${context.businessLine}/${context.platform}/${context.version}/${context.batch || "initial"}`;
}

function validateNodeInputs(node, item) {
  for (const schema of node?.inputSchema || []) {
    // 服务端旧快照或异步回填可能暂时没有保存输入；执行时应使用节点定义的默认值，
    // 否则页面虽显示默认参数，校验却仍会把它当成空值并提前返回，用户看起来像点击无反应。
    const value = item?.inputs?.[schema.key] ?? schema.defaultValue;
    if (schema.required && (value === undefined || value === null || String(value).trim() === "")) {
      return `请填写${schema.label}`;
    }
    if (schema.type === "number" && value !== undefined && String(value).trim() !== "") {
      const numberValue = Number(value);
      if (!Number.isFinite(numberValue)
        || (schema.integer && !Number.isInteger(numberValue))
        || (schema.min !== undefined && numberValue < schema.min)
        || (schema.max !== undefined && numberValue > schema.max)) {
        return `${schema.label}需为 ${schema.min}~${schema.max} 的整数`;
      }
    }
  }
  return "";
}

export default function ReleaseWorkflowPanel({
  workspace,
  releaseContext: navigationContext,
  operator = "未记录",
  canWrite = true,
  releaseAccess = null,
  onReleaseAccess,
}) {
  const inferred = useMemo(() => navigationContext
    ? resolveReleaseContext(workspace || {}, navigationContext)
    : inferReleaseContext(workspace || {}), [navigationContext, workspace]);
  const initialNode = useMemo(() => createInitializationNode(inferred, workspace), [inferred, workspace]);
  const initialPreparationNode = useMemo(() => createInitializationPreparationNode(inferred, workspace), [inferred, workspace]);
  const context = inferred;
  const [state, setState] = useState(() => seedNextRecommendations(
    seedInitializationPreparationState(
      ensureInitializationFirst(
        readState(
          storageKey(workspace, inferred),
          new Set([initialNode.id, initialPreparationNode.id, ...getReleaseNodes(inferred).map((node) => node.id)]),
        ),
        initialNode,
      ),
      initialNode,
      initialPreparationNode,
    ),
    [initialNode, initialPreparationNode, ...getReleaseNodes(inferred)],
  ));
  const [storageWarning, setStorageWarning] = useState("");
  const [message, setMessage] = useState("");
  const [selfTestFailure, setSelfTestFailure] = useState(false);
  const [addNodeOpen, setAddNodeOpen] = useState(false);
  const [remoteCatalog, setRemoteCatalog] = useState([]);
  const [inspector, setInspector] = useState(null);
  const controllers = useRef(new Map());
  const hydratedKey = useRef("");
  const activeKeyRef = useRef("");
  const runGenerationRef = useRef(0);
  const runSequenceRef = useRef(0);
  // 用户需求点: 本地新增或执行阶段后，迟到的远程旧状态不能覆盖当前发版操作结果。
  const localMutationRef = useRef(false);

  const key = useMemo(() => storageKey(workspace, context), [workspace, context]);
  activeKeyRef.current = key;
  const catalogNodes = useMemo(() => remoteCatalog.length > 0 ? remoteCatalog : getReleaseNodes(context), [context, remoteCatalog]);
  const workflowMachine = useMemo(() => createReleaseProcessStateMachine({ context, nodes: catalogNodes }), [catalogNodes, context]);
  const customNodeOptions = useMemo(() => selectWorkflowProcessNodes({ machine: workflowMachine, nodes: catalogNodes }), [catalogNodes, workflowMachine]);
  const customNodeGroups = useMemo(() => {
    const groups = [];
    const byProcess = new Map();
    for (const node of customNodeOptions) {
      const processId = node.workflowProcessId || node.processId || "other";
      let group = byProcess.get(processId);
      if (!group) {
        group = { id: processId, title: node.workflowProcessTitle || node.processTitle || processTitleForId(processId), nodes: [] };
        byProcess.set(processId, group);
        groups.push(group);
      }
      group.nodes.push(node);
    }
    // 用户需求点: 自由 Agent 可插入任意发版阶段；每个流程分组都挂一份同能力入口。
    const freePrompt = catalogNodes.find((node) => node.insertableInAnyStage === true || node.compositeId === "free-prompt-agent");
    if (freePrompt) {
      for (const group of groups) {
        if (group.nodes.some((node) => node.compositeId === freePrompt.compositeId || node.id === freePrompt.id)) continue;
        group.nodes.push({
          ...freePrompt,
          processId: group.id,
          processTitle: group.title,
          workflowProcessId: group.id,
          workflowProcessTitle: group.title,
          category: group.title,
        });
      }
      if (groups.length === 0) {
        groups.push({
          id: freePrompt.processId || "entry",
          title: freePrompt.processTitle || "助手驱动",
          nodes: [freePrompt],
        });
      }
    }
    return groups;
  }, [catalogNodes, customNodeOptions]);
  const initializationNode = useMemo(() => createInitializationNode(context, workspace), [context, workspace]);
  const initializationPreparationNode = useMemo(() => createInitializationPreparationNode(context, workspace), [context, workspace]);
  const allNodes = useMemo(() => [initializationNode, initializationPreparationNode, ...catalogNodes, ...state.customNodes], [catalogNodes, initializationNode, initializationPreparationNode, state.customNodes]);
  const knownNodeIds = useMemo(() => new Set(allNodes.map((node) => node.id)), [allNodes]);
  const visibleState = useMemo(() => {
    const timeline = state.timeline.filter((item) => (knownNodeIds.has(item.nodeId) || knownNodeIds.has(item.sourcePresetId)) && itemMatchesContext(item, context));
    const completedIds = new Set(timeline.map((item) => item.nodeId));
    const pending = state.pending
      .filter((item) => (knownNodeIds.has(item.nodeId) || knownNodeIds.has(item.sourcePresetId)) && itemMatchesContext(item, context) && !completedIds.has(item.nodeId));
    return { ...state, timeline, pending };
  }, [context, knownNodeIds, state]);
  const nodeById = useMemo(() => new Map(allNodes.map((node) => [node.id, node])), [allNodes]);
  const completedRows = useMemo(() => groupCompletedTimelineRows(visibleState.timeline), [visibleState.timeline]);
  const runningCount = visibleState.pending.filter((item) => item.status === "running").length;

  const contextKey = `${context.businessLine}/${context.platform}/${context.version}/${context.batch || "initial"}`;
  const catalogSignature = catalogNodes.map((node) => node.id).join("|");

  useEffect(() => {
    hydratedKey.current = "";
    const loaded = readState(key, new Set([initializationNode.id, initializationPreparationNode.id, ...catalogNodes.map((node) => node.id)]));
    if (!localMutationRef.current) {
      setState(seedNextRecommendations(seedInitializationPreparationState(ensureInitializationFirst(loaded, initializationNode), initializationNode, initializationPreparationNode), [initializationNode, initializationPreparationNode, ...catalogNodes]));
    }
    setStorageWarning("");
  }, [catalogSignature, contextKey, initializationNode, initializationPreparationNode, key]);

  useEffect(() => {
    localMutationRef.current = false;
  }, [key]);

  useEffect(() => {
    setState((previous) => seedNextRecommendations(
      { ...previous, context: { ...context } },
      [initializationNode, initializationPreparationNode, ...catalogNodes],
    ));
  }, [catalogSignature, contextKey, initializationNode, initializationPreparationNode]);

  useEffect(() => () => {
    runGenerationRef.current += 1;
    controllers.current.forEach((entry) => entry.controller?.abort());
    controllers.current.clear();
  }, [key]);

  useEffect(() => {
    if (hydratedKey.current !== key) {
      hydratedKey.current = key;
      return;
    }
    if (typeof window === "undefined" || !window.localStorage) return;
    try {
      window.localStorage.setItem(key, JSON.stringify(state));
      setStorageWarning("");
    } catch {
      setStorageWarning("本地状态暂不可保存");
    }
  }, [key, state]);

  useEffect(() => {
    let cancelled = false;
    const query = new URLSearchParams({
      workspaceId: workspaceIdentity(workspace),
      businessLine: context.businessLine,
      platform: context.platform,
      version: context.version,
      batch: context.batch || "initial",
    });
    Promise.all([
      fetch(`/api/release/catalog?${query.toString()}`).then((response) => response.ok ? response.json() : null).catch(() => null),
      fetch(`/api/release/state?${query.toString()}`).then((response) => response.ok ? response.json() : null).catch(() => null),
    ]).then(([catalogPayload, statePayload]) => {
      if (cancelled) return;
      const access = statePayload?.releaseAccess || catalogPayload?.releaseAccess;
      if (access && typeof access === "object") onReleaseAccess?.(access);
      if (Array.isArray(catalogPayload?.nodes) && catalogPayload.nodes.length > 0) {
        setRemoteCatalog((previous) => mergeRemoteCatalog(previous, catalogPayload.nodes));
      }
      if (statePayload?.state && isRecord(statePayload.state)) {
        setState((previous) => seedNextRecommendations(
          // 用户需求点: 用户操作优先，避免网络较慢时服务端旧快照抹掉刚添加或正在执行的节点。
          localMutationRef.current ? previous :
          seedInitializationPreparationState(ensureInitializationFirst((() => {
            const remoteState = statePayload.state;
            const sourceNodes = Array.isArray(catalogPayload?.nodes) && catalogPayload.nodes.length > 0 ? catalogPayload.nodes : catalogNodes;
            const knownIds = new Set([
              initializationNode.id,
              initializationPreparationNode.id,
              ...sourceNodes.map((node) => node.id),
              ...(Array.isArray(previous.customNodes) ? previous.customNodes : []).map((node) => node.id),
            ]);
            const localCustomNodes = Array.isArray(previous.customNodes) ? previous.customNodes : [];
            const localCustomPending = (Array.isArray(previous.pending) ? previous.pending : [])
              .filter((item) => localCustomNodes.some((node) => node.id === item.nodeId || node.id === item.id));
            const merged = mergeRemotePending(previous, remoteState, context, knownIds, localCustomPending);
            return {
              ...previous,
              ...remoteState,
              timeline: merged.timeline,
              pending: merged.pending,
              dismissedNodeIds: merged.dismissedNodeIds,
              customNodes: localCustomNodes,
              context: { ...context },
            };
          })(), initializationNode), initializationNode, initializationPreparationNode),
          [initializationNode, initializationPreparationNode, ...(Array.isArray(catalogPayload?.nodes) && catalogPayload.nodes.length > 0 ? catalogPayload.nodes : catalogNodes)],
        ));
      }
    });
    return () => { cancelled = true; };
    // catalogNodes / context 用签名依赖，避免远端 catalog 引用抖动反复拉 state 重建推荐卡片。
  }, [catalogSignature, contextKey, initializationNode, initializationPreparationNode, workspace]);

  // 用户需求点: Agent 执行期间页面不能只等待最终 HTTP 响应，需同步服务端心跳和失败状态。
  useEffect(() => {
    if (runningCount <= 0 || typeof window === "undefined") return undefined;
    let cancelled = false;
    const query = new URLSearchParams({
      workspaceId: workspaceIdentity(workspace),
      businessLine: context.businessLine,
      platform: context.platform,
      version: context.version,
      batch: context.batch || "initial",
    });
    const syncRunningState = async () => {
      const payload = await fetch(`/api/release/state?${query.toString()}`).then((response) => response.ok ? response.json() : null).catch(() => null);
      if (cancelled || !payload?.state || !isRecord(payload.state)) return;
      const sourceNodes = remoteCatalog.length ? remoteCatalog : catalogNodes;
      const knownIds = new Set([
        initializationNode.id,
        initializationPreparationNode.id,
        ...sourceNodes.map((node) => node.id),
        ...(Array.isArray(state.customNodes) ? state.customNodes : []).map((node) => node.id),
      ]);
      const merged = mergeRemotePending(state, payload.state, context, knownIds);
      setState((previous) => {
        const dismissedNodeIds = mergeDismissedNodeIds(previous.dismissedNodeIds, merged.dismissedNodeIds);
        const remoteById = new Map(merged.pending.map((item) => [item.id, item]));
        const timelineCompletedIds = new Set(merged.timeline.map((entry) => entry.nodeId));
        const timeline = uniqueByNodeId([
          ...previous.timeline,
          ...merged.timeline,
        ]);
        const pending = uniqueById(filterDismissedPending([
          ...previous.pending
            .filter((item) => !timelineCompletedIds.has(item.nodeId) && String(item.status || "").toLowerCase() !== "waiting")
            .map((item) => {
              if (!remoteById.has(item.id)) return item;
              const remote = remoteById.get(item.id);
              const mergedItem = { ...item, ...remote };
              if (String(mergedItem.status || "").toLowerCase() === "running") {
                mergedItem.error = "";
                mergedItem.failedAt = undefined;
              }
              return mergedItem;
            }),
          ...merged.pending.filter((item) => !previous.pending.some((entry) => entry.id === item.id)),
        ], dismissedNodeIds));
        return {
          ...previous,
          timeline,
          pending,
          dismissedNodeIds,
          ...(isRecord(payload.state.runs) ? { runs: payload.state.runs } : {}),
        };
      });
    };
    void syncRunningState();
    const timer = window.setInterval(() => { void syncRunningState(); }, 2_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [catalogNodes, contextKey, initializationNode, initializationPreparationNode, remoteCatalog, runningCount, state.customNodes, workspace]);

  // 用户需求点: 节点详情必须反映最新运行态，完成后立即切换为只读，不能继续显示执行按钮。
  useEffect(() => {
    setInspector((previous) => {
      if (!previous?.item?.id) return previous;
      const latest = [...(Array.isArray(state.timeline) ? state.timeline : []), ...(Array.isArray(state.pending) ? state.pending : [])]
        .find((entry) => entry.id === previous.item.id);
      if (!latest) return previous;
      const mode = latest.status === "completed" ? "completed" : latest.status === "failed" ? "failed" : "pending";
      return previous.item === latest && previous.mode === mode ? previous : { ...previous, item: latest, mode };
    });
  }, [state]);

  const executeNode = useCallback(async (item) => {
    if (!item || item.status === "completed" || controllers.current.has(item.id)) return;
    if (!canWrite) {
      setMessage("当前账号无发版操作权限");
      return;
    }
    const busy = findBusyCapabilitySibling(state.pending, item, { excludeId: item.id });
    if (busy) {
      setMessage(`同能力已有「${busy.title || busy.nodeId}」处于${statusLabel(busy.status)}，请先等待或取消后再执行`);
      return;
    }
    const node = nodeById.get(item.nodeId)
      || nodeById.get(item.sourcePresetId)
      || (item.sourcePresetId ? null : [...nodeById.values()].find((entry) => entry.sourcePresetId && entry.id === item.nodeId));
    if (!node) {
      setMessage(`${item.title || item.nodeId || "发版节点"} 定义已失效，请刷新节点列表后重试`);
      return;
    }
    if (!itemMatchesContext(item, context) || (node.scopeKey && node.scopeKey !== `${context.businessLine}/${context.platform}/${context.version}/${context.batch || "initial"}`)) {
      setMessage("节点不属于当前业务、平台和版本上下文");
      return;
    }
    const normalizedInputs = defaultInputsForNode(node, item.inputs || {}, context);
    const executionItem = normalizedInputs === item.inputs ? item : { ...item, inputs: normalizedInputs };
    const inputError = validateNodeInputs(node, executionItem);
    if (inputError) {
      setMessage(inputError);
      return;
    }
    const runKey = key;
    const runGeneration = runGenerationRef.current;
    const runToken = ++runSequenceRef.current;
    const isCurrentRun = () => runKey === activeKeyRef.current && runGeneration === runGenerationRef.current;
    const controller = new AbortController();
    const startedAt = Date.now();
    localMutationRef.current = true;
    controllers.current.set(item.id, { controller, token: runToken });
    setMessage(`${item.title} 正在启动 AgentFlow…`);
    setState((previous) => seedNextRecommendations({
      ...previous,
      pending: previous.pending.map((entry) => entry.id === item.id ? { ...entry, inputs: normalizedInputs, status: "running", startedAt, completedAt: undefined, failedAt: undefined, error: "", progress: 0, operator } : entry),
    }, [initializationNode, initializationPreparationNode, ...catalogNodes]));
    try {
      // 自定义实例卡片用 sourcePresetId 定位 catalog 能力；优先 item 上的预置 id，避免误把 custom-composite:* 当 actionId。
      const actionId = item.sourcePresetId || node.sourcePresetId || node.id;
      // 用户需求点: 浏览器只提交 workspaceId；产品工程绝对路径由服务端按业务线+平台 allowlist 解析。
      const requestPayload = {
        workspaceId: workspaceIdentity(workspace),
        businessLine: context.businessLine,
        platform: context.platform,
        version: context.version,
        batch: context.batch || "initial",
        actionId,
        itemId: item.id,
        inputs: normalizedInputs,
        confirmationFingerprint: item.confirmationFingerprint || "",
        scopeKey: node.scopeKey || `${context.businessLine}/${context.platform}/${context.version}/${context.batch || "initial"}`,
        processId: node.processId || item.processId || "",
        processTitle: node.processTitle || item.processTitle || "",
      };
      let result;
      let runDetails;
      if (typeof fetch === "function" && node.skill !== "custom") {
        if (node.requiresConfirmation && !item.confirmationFingerprint) {
          const previewResponse = await fetch("/api/release/nodes/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestPayload), signal: controller.signal });
          const previewPayload = await previewResponse.json().catch(() => ({}));
          if (!previewResponse.ok) {
            if (previewPayload?.releaseAccess) onReleaseAccess?.(previewPayload.releaseAccess);
            if (previewPayload?.code === "RELEASE_OPERATOR_FORBIDDEN") {
              throw new Error(previewPayload.error || "无发版操作权限：页面与助手都不能触发发版运行");
            }
            throw new Error(previewPayload.error || `HTTP ${previewResponse.status}`);
          }
          // 活动发版已存在时，服务端会在 preview 请求中直接幂等复用并返回 completed。
          // 不能把这个完成结果误当成普通预览，否则节点会一直停留在待执行，看起来像点击无反应。
          if (previewPayload.status !== "completed") {
            const previewItem = {
              ...item,
              inputs: normalizedInputs,
              status: "pending",
              preview: previewPayload.preview,
              confirmationFingerprint: previewPayload.confirmationFingerprint,
              runId: previewPayload.runId || item.runId,
            };
            setState((previous) => ({ ...previous, pending: previous.pending.map((entry) => entry.id === item.id ? { ...entry, ...previewItem } : entry) }));
            // 用户需求点: 需要确认的节点点击“执行”后必须立刻展示详情弹框，否则预览成功但用户看起来像没有反应。
            setInspector({ item: previewItem, node, mode: "pending" });
            setMessage("预览已生成，请在节点详情中确认后执行");
            controllers.current.delete(item.id);
            return;
          }
          const rawMessage = previewPayload.message || previewPayload.result?.output || previewPayload.result?.message;
          result = {
            ...previewPayload,
            runId: previewPayload.runId,
            message: typeof rawMessage === "string" && rawMessage.trim() ? rawMessage : `${node.title} 已完成`,
            output: sanitizeReleaseNodeOutput(previewPayload),
            details: compositeDetailsFromResult(previewPayload, node, previewPayload.details || {}),
          };
        }
        if (!result) {
          const response = await fetch("/api/release/nodes/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestPayload), signal: controller.signal });
          const payload = await response.json().catch(() => ({}));
          runDetails = payload.details || payload.result?.details || (Array.isArray(payload.result?.steps) ? { steps: payload.result.steps } : undefined);
          if (!response.ok) {
            if (payload?.releaseAccess) onReleaseAccess?.(payload.releaseAccess);
            const error = new Error(
              payload?.code === "RELEASE_OPERATOR_FORBIDDEN"
                ? (payload.error || "无发版操作权限：页面与助手都不能触发发版运行")
                : (payload.error || `HTTP ${response.status}`),
            );
            error.details = runDetails;
            error.code = payload?.code || "";
            throw error;
          }
          // 用户需求点: AgentFlow 返回的 graph 是对象，页面提示和时间线消息必须始终是可渲染文本，不能把运行图对象直接交给 React。
          result = {
            ...payload,
            runId: payload.runId,
            message: releaseResultMessage(payload, `${node.title} 已完成`),
            output: sanitizeReleaseNodeOutput(payload),
            details: compositeDetailsFromResult(payload, node, runDetails || {}),
            status: payload.status || payload.result?.status || "completed",
            waiting: payload.waiting || payload.result?.waiting || payload.details?.waiting,
          };
        }
      } else {
        result = await runReleaseNode(node, { ...context, inputs: item.inputs, simulateFailure: selfTestFailure }, {
        signal: controller.signal,
        onRunStart: (runId) => {
          if (!isCurrentRun()) return;
          setState((previous) => ({
            ...previous,
            pending: previous.pending.map((entry) => entry.id === item.id ? { ...entry, runId } : entry),
          }));
        },
        onProgress: (progress) => {
          if (!isCurrentRun()) return;
          setState((previous) => ({ ...previous, pending: previous.pending.map((entry) => entry.id === item.id ? { ...entry, progress } : entry) }));
        },
        });
      }
      // 工作空间列表异步回填时可能只改变了前端 storage key；只要本次请求没有被取消，
      // 仍应提交 AgentFlow 已返回的结果，不能静默丢弃导致节点看起来没有反应。
      if (controller.signal.aborted) return;
      // 用户需求点: waiting 无交互续跑——按成功写入时间线，卡片上只简明写出待办事项。
      if (String(result.status || "").toLowerCase() === "waiting") {
        const waitingPayload = result.waiting || result.output?.waiting || { reason: result.message || "待人工处理" };
        const waitingLabel = humanizeWaitingMatter(waitingPayload);
        const completedAt = Date.now();
        const successItem = {
          ...executionItem,
          inputs: normalizedInputs,
          status: "completed",
          progress: 100,
          message: result.message || `${node.title} 已成功`,
          output: sanitizeReleaseNodeOutput({ ...result, status: "waiting" }),
          waiting: waitingPayload,
          details: compositeDetailsFromResult(result, node, { ...(executionItem.details || {}), ...(result.details || {}) }),
          runId: result.runId || executionItem.runId,
          operator,
          kind: executionItem.kind || node.kind || "",
          compositeId: executionItem.compositeId || node.compositeId || "",
          ...createCompletionMetadata({
            operator,
            startedAt: executionItem.startedAt || startedAt,
            completedAt,
          }),
        };
        setState((previous) => {
          const withoutPending = previous.pending.filter((entry) => entry.id !== item.id);
          const timeline = [
            ...previous.timeline.filter((entry) => entry.id !== successItem.id && entry.nodeId !== successItem.nodeId),
            successItem,
          ];
          return seedNextRecommendations({
            ...previous,
            timeline,
            pending: withoutPending,
          }, [initializationNode, initializationPreparationNode, ...catalogNodes]);
        });
        setInspector({ item: successItem, node, mode: "completed" });
        setMessage(`${node.title} 已成功；${waitingLabel}`);
        return;
      }
      setState((previous) => {
        const completed = previous.timeline.some((entry) => (entry.nodeId || entry.id) === node.id);
        const currentItem = previous.pending.find((entry) => entry.id === item.id) || item;
        const persistedItem = { ...currentItem };
        const completedAt = Date.now();
        const currentOperator = currentItem.operator && currentItem.operator !== "未记录" ? currentItem.operator : operator;
        const timeline = completed ? previous.timeline : [...previous.timeline, {
          ...persistedItem,
          kind: currentItem.kind || node.kind || "",
          compositeId: currentItem.compositeId || node.compositeId || "",
          details: currentItem.kind === "composite" || node.kind === "composite"
            ? compositeDetailsFromResult(result, node, { ...(currentItem.details || {}), ...(result.details || {}) })
            : currentItem.details,
          processId: currentItem.processId || node.processId || "",
          processOrder: currentItem.processOrder ?? node.processOrder,
          processTitle: currentItem.processTitle || node.processTitle || processTitleForId(node.processId),
          workflowId: currentItem.workflowId || node.workflowId || previous.workflowId || "",
          scopeKey: currentItem.scopeKey || node.scopeKey || `${context.businessLine}/${context.platform}/${context.version}/${context.batch || "initial"}`,
          status: "completed",
          progress: 100,
          message: result.message,
          output: sanitizeReleaseNodeOutput(result),
          logs: result.logs || result.events || [],
          runId: result.runId || currentItem.runId,
          ...createCompletionMetadata({ operator: currentOperator, startedAt: currentItem.startedAt || startedAt, completedAt }),
        }];
        const pending = previous.pending.filter((entry) => entry.id !== item.id);
        return seedNextRecommendations(
          {
            ...previous,
            timeline,
            pending,
            context: { ...context },
            ...(node.id === initializationPreparationNode.id
              ? { initialization: { status: "completed", preparationNodeId: initializationPreparationNode.id } }
              : {}),
          },
          [initializationNode, initializationPreparationNode, ...catalogNodes],
        );
      });
      setMessage(result.message || `${node.title} 已完成`);
    } catch (error) {
      if (error?.name === "AbortError") return;
      let nextError = String(error?.message || error || "执行失败");
      let nextDetails = error?.details;
      // 长连接被服务重启/网络中断时，浏览器只报 Failed to fetch；回读服务端状态拿到真实失败原因。
      if (/failed to fetch|networkerror|load failed/i.test(nextError)) {
        try {
          const query = new URLSearchParams({
            workspaceId: workspaceIdentity(workspace),
            businessLine: context.businessLine,
            platform: context.platform,
            version: context.version,
            batch: context.batch || "initial",
          });
          const payload = await fetch(`/api/release/state?${query.toString()}`).then((response) => response.ok ? response.json() : null).catch(() => null);
          const remoteItem = (Array.isArray(payload?.state?.pending) ? payload.state.pending : []).find((entry) => entry?.id === item.id);
          if (remoteItem?.error) nextError = String(remoteItem.error);
          if (remoteItem?.details) nextDetails = remoteItem.details;
        } catch {
          // keep browser network error
        }
      }
      setState((previous) => seedNextRecommendations({
        ...previous,
        pending: previous.pending.map((entry) => entry.id === item.id ? { ...entry, status: "failed", error: nextError, failedAt: Date.now(), operator: entry.operator || operator, details: entry.kind === "composite" ? compositeDetailsFromResult({ details: nextDetails }, node, entry.details || {}) : entry.details } : entry),
      }, [initializationNode, initializationPreparationNode, ...catalogNodes]));
      setMessage(`${node.title} 执行失败`);
    } finally {
      if (controllers.current.get(item.id)?.token === runToken) controllers.current.delete(item.id);
    }
  }, [canWrite, catalogNodes, context, initializationNode, initializationPreparationNode, key, nodeById, onReleaseAccess, operator, selfTestFailure, state.pending, workspace]);

  const cancelNode = useCallback((item) => {
    localMutationRef.current = true;
    controllers.current.get(item?.id)?.controller?.abort();
    if (item?.runId) {
      void fetch("/api/release/runs/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId: item.runId }) }).catch(() => {});
    }
    if (!item) return;
    setState((previous) => seedNextRecommendations({
      ...previous,
      pending: previous.pending.map((entry) => entry.id === item.id ? { ...entry, status: "pending", progress: 0, error: "", failedAt: undefined, completedAt: undefined } : entry),
    }, [initializationNode, initializationPreparationNode, ...catalogNodes]));
    setMessage(`${item.title} 已取消`);
  }, [catalogNodes, initializationNode, initializationPreparationNode]);

  const retryNode = useCallback((item) => {
    if (!item || item.status !== "failed") return;
    localMutationRef.current = true;
    // 重试 = 全新执行：清空失败态与旧步骤详情，不携带 resumeFromStep。
    const freshItem = {
      ...item,
      status: "pending",
      error: "",
      failedAt: undefined,
      progress: 0,
      details: item.kind === "composite" ? { steps: [] } : undefined,
      output: undefined,
      waiting: undefined,
      message: "",
      runId: "",
    };
    setState((previous) => seedNextRecommendations({
      ...previous,
      pending: previous.pending.map((entry) => entry.id === item.id ? freshItem : entry),
    }, [initializationNode, initializationPreparationNode, ...catalogNodes]));
    void executeNode(freshItem);
  }, [catalogNodes, initializationNode, initializationPreparationNode, executeNode]);

  const deleteNode = useCallback(async (item) => {
    if (!item || item.status === "running") return;
    const query = new URLSearchParams({
      businessLine: context.businessLine,
      platform: context.platform,
      version: context.version,
      batch: context.batch || "initial",
      workspaceId: workspaceIdentity(workspace),
    });
    localMutationRef.current = true;
    const applyLocalRemoval = () => {
      setState((previous) => seedNextRecommendations(
        removePendingNode(previous, item),
        [initializationNode, initializationPreparationNode, ...catalogNodes],
      ));
      setInspector((previous) => previous?.item?.id === item.id ? null : previous);
      setMessage(`${item.title} 已删除`);
    };
    const applyServerState = (remoteState) => {
      const sourceNodes = remoteCatalog.length ? remoteCatalog : catalogNodes;
      const knownIds = new Set([
        initializationNode.id,
        initializationPreparationNode.id,
        ...sourceNodes.map((node) => node.id),
      ]);
      setState((previous) => seedNextRecommendations(
        ensureInitializationFirst({
          ...previous,
          ...remoteState,
          ...mergeRemotePending(previous, remoteState, context, knownIds),
          context: { ...context },
        }, initializationNode),
        [initializationNode, initializationPreparationNode, ...catalogNodes],
      ));
      setInspector((previous) => previous?.item?.id === item.id ? null : previous);
      setMessage(`${item.title} 已删除`);
    };
    try {
      const response = await fetch(`/api/release/pending/${encodeURIComponent(item.id)}?${query.toString()}`, { method: "DELETE" });
      const payload = await response.json().catch(() => ({}));
      if (response.status === 404) {
        applyLocalRemoval();
        return;
      }
      if (!response.ok) throw new Error(payload.error || `HTTP ${response.status}`);
      if (isRecord(payload.state)) applyServerState(payload.state);
      else applyLocalRemoval();
    } catch (error) {
      setMessage(String(error?.message || error));
    } finally {
      window.setTimeout(() => { localMutationRef.current = false; }, 1_500);
    }
  }, [catalogNodes, context, initializationNode, initializationPreparationNode, remoteCatalog, workspace]);

  const updateNodeInput = useCallback((itemIdValue, inputKey, value) => {
    localMutationRef.current = true;
    setState((previous) => ({
      ...previous,
      pending: previous.pending.map((entry) => entry.id === itemIdValue
        ? { ...entry, inputs: { ...entry.inputs, [inputKey]: value }, error: entry.status === "failed" ? "" : entry.error }
        : entry),
    }));
  }, []);

  const renderNodeInputs = (node, item) => externalInputSchemaForNode(node).length > 0 ? (() => {
    // 历史状态可能保存了工程绝对路径；卡片展示必须与执行前归一化保持一致，避免用户继续提交旧值。
    const renderedInputs = defaultInputsForNode(node, item.inputs || {}, context);
    return <div className="af-release-node__inputs">
      {externalInputSchemaForNode(node).map((schema) => {
        const rawValue = renderedInputs?.[schema.key] ?? schema.defaultValue ?? "";
        const checked = rawValue === true || ["1", "true", "yes", "on"].includes(String(rawValue).trim().toLowerCase());
        if (schema.type === "checkbox" || schema.type === "bool") {
          return (
            <label key={schema.key} className="af-release-node__checkbox">
              <input
                type="checkbox"
                checked={checked}
                disabled={item.status === "running"}
                onChange={(event) => updateNodeInput(item.id, schema.key, event.target.checked)}
              />
              <span>{schema.label}{schema.required ? " *" : ""}</span>
              {schema.placeholder ? <small>{schema.placeholder}</small> : null}
            </label>
          );
        }
        return (
          <label key={schema.key}>
            <span>{schema.label}{schema.required ? " *" : ""}</span>
            {schema.type === "textarea" ? (
              <textarea
                rows={3}
                placeholder={schema.placeholder}
                value={rawValue}
                disabled={item.status === "running"}
                onChange={(event) => updateNodeInput(item.id, schema.key, event.target.value)}
              />
            ) : (
              <input
                type={schema.type || "text"}
                min={schema.min}
                max={schema.max}
                step={schema.step}
                placeholder={schema.placeholder}
                value={rawValue}
                disabled={item.status === "running"}
                onChange={(event) => updateNodeInput(item.id, schema.key, event.target.value)}
              />
            )}
          </label>
        );
      })}
    </div>;
  })() : null;

  const renderInitializationContext = (item) => item.nodeId === initializationNode.id || item.nodeId === initializationPreparationNode.id ? (
    <div className="af-release-context-chips">
      <span>{context.businessLine}</span><span>{context.platform}</span><span>{context.version}</span>
    </div>
  ) : null;

  // 用户需求点: 自定义添加可重复开同能力卡片，但已有 running 实例时禁止再开并行副本。
  const addPresetNode = useCallback((preset) => {
    if (!preset) return;
    const busy = findBusyCapabilitySibling(state.pending, preset);
    if (busy) {
      setMessage(`同能力已有「${busy.title || busy.nodeId}」处于${statusLabel(busy.status)}，请先完成或取消后再添加`);
      setAddNodeOpen(false);
      return;
    }
    localMutationRef.current = true;
    const node = createPresetInstance(preset);
    setState((previous) => ({
      ...previous,
      customNodes: [...previous.customNodes, node],
      pending: [...previous.pending, makePending(node, {}, context)],
    }));
    setAddNodeOpen(false);
    setMessage(`${node.title} 已加入待执行阶段`);
  }, [context, state.pending]);

  const openInspector = useCallback((item) => {
    const node = nodeById.get(item?.nodeId) || nodeById.get(item?.sourcePresetId);
    if (!item || !node) return;
    const hydrated = hydrateReleaseItemFromRuns(item, state.runs || {});
    setInspector({
      item: hydrated,
      node,
      mode: hydrated.status === "completed" ? "completed" : hydrated.status === "failed" ? "failed" : "pending",
    });
  }, [nodeById, state.runs]);

  const saveInspectorItem = useCallback(async (nextItem) => {
    if (!nextItem || nextItem.status === "completed") return;
    const query = new URLSearchParams({ businessLine: context.businessLine, platform: context.platform, version: context.version, batch: context.batch || "initial", workspaceId: workspaceIdentity(workspace) });
    try {
      const response = await fetch(`/api/release/pending/${encodeURIComponent(nextItem.id)}?${query.toString()}`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ inputs: nextItem.inputs || {} }) });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        // 推荐节点可能只存在于本地状态，服务端尚未持久化时 PATCH 返回 404；执行仍应继续交给 AgentFlow。
        if (response.status === 404) return;
        throw new Error(payload.error || `HTTP ${response.status}`);
      }
      setState((previous) => ({ ...previous, pending: previous.pending.map((entry) => entry.id === nextItem.id ? { ...entry, inputs: nextItem.inputs || {} } : entry) }));
      setInspector((previous) => previous ? { ...previous, item: { ...previous.item, inputs: nextItem.inputs || {} } } : previous);
      setMessage("节点参数已保存");
    } catch (error) {
      setMessage(String(error?.message || error));
    }
  }, [context.batch, context.businessLine, context.platform, context.version, workspace]);

  const runInspectorItem = useCallback((nextItem) => {
    const localOnly = nextItem?.nodeId === initializationPreparationNode.id
      || String(nextItem?.nodeId || "").startsWith("custom-");
    void (localOnly ? Promise.resolve() : saveInspectorItem(nextItem)).then(() => executeNode(nextItem));
  }, [executeNode, initializationPreparationNode.id, saveInspectorItem]);

  return (
    <section className="af-release-panel">
      <header className="af-release-context">
        <div className="af-release-context__identity"><span className="af-release-eyebrow">发版时间线</span><h2>{workspace?.label || workspace?.name || "当前工作空间"}</h2><small>{workspace?.path || workspace?.repoUrl || "本地发版时间线"}</small><div className="af-release-context-chips"><span>{context.businessLine}</span><span>{context.platform}</span><span>{context.version}</span></div></div>
        <div className="af-release-counts"><span>已完成 {visibleState.timeline.length}</span><span>待执行 {visibleState.pending.filter((item) => item.status === "pending").length}</span><span>执行中 {runningCount}</span>{canWrite ? <label className="af-release-self-test"><input type="checkbox" checked={selfTestFailure} onChange={(event) => setSelfTestFailure(event.target.checked)} />模拟失败</label> : null}</div>
      </header>
      {storageWarning ? <div className="af-release-notice">{storageWarning}</div> : null}
      {message ? <div className="af-release-message" role="status">{message}</div> : null}
      <div className="af-release-flow-groups">
        <section className="af-release-stage-group af-release-stage-group--completed">
          <div className="af-release-section__heading"><div><h3>已完成阶段</h3><span>{visibleState.timeline.length} 个节点</span></div><small>按执行顺序记录发版轨迹</small></div>
          <div className="af-release-completed-flow">
            {completedRows.length === 0 ? <div className="af-release-empty">初始化节点或已完成阶段会从这里开始。</div> : completedRows.map((row, rowIndex) => (
              <div key={row[0]?.id || rowIndex} className={`af-release-completed-row${rowIndex % 2 === 1 ? " is-reverse" : ""}`}>
                {row.map((item, itemIndex) => (
                  <div key={item.id} className="af-release-completed-step">
                    <article className="af-release-timeline-card af-release-node--completed" role="button" tabIndex="0" onClick={() => openInspector(item)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") openInspector(item); }}><div className="af-release-timeline-card__dot" aria-hidden="true" /><div className="af-release-timeline-card__body"><div className="af-release-timeline-card__topline"><span>{item.category || "发版阶段"}</span><b>{statusLabel(item.status === "waiting" ? "waiting" : "completed")}</b></div><strong>{item.title}</strong><small>{item.description || "已完成发版阶段"}</small>{renderInitializationContext(item)}{renderStageOutcome(item)}<div className="af-release-timeline-card__meta"><span>完成 {formatDateTime(item.completedAt)}</span><span>耗时 {formatDuration(item.durationMs)}</span><span>操作人 {item.operator || "未记录"}</span></div></div></article>
                    {itemIndex < row.length - 1 ? <span className="af-release-completed-arrow material-symbols-outlined" aria-hidden="true">{rowIndex % 2 === 1 ? "arrow_back" : "arrow_forward"}</span> : null}
                  </div>
                ))}
                {rowIndex < completedRows.length - 1 ? <span className="af-release-completed-turn" aria-hidden="true"><i className="material-symbols-outlined">{rowIndex % 2 === 0 ? "arrow_back" : "arrow_forward"}</i></span> : null}
              </div>
            ))}
          </div>
        </section>
        <div className="af-release-group-bridge" aria-hidden="true"><span>下一阶段</span></div>
        <section className="af-release-stage-group af-release-stage-group--pending">
          <div className="af-release-section__heading"><div><h3>添加阶段</h3><span>{visibleState.pending.length} 个节点</span></div><small>平级添加与执行区，可执行、取消或重试</small></div>
          <div className="af-release-pending-grid">
            {visibleState.pending.length === 0 ? <div className="af-release-empty">暂无待执行阶段。</div> : visibleState.pending.map((item) => {
              const node = nodeById.get(item.nodeId);
              return <article key={item.id} className={`af-release-node af-release-node--${item.status}`} role="button" tabIndex="0" onClick={() => openInspector(item)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") openInspector(item); }}>
                <div><div className="af-release-node__topline"><span>{item.processTitle || item.category || "发版阶段"}</span><b>{statusLabel(item.status)}</b></div><strong>{item.title}</strong><small>{item.description}</small>{renderInitializationContext(item)}<div className="af-release-node__meta"><span>操作人 {item.operator || "未记录"}</span>{item.startedAt ? <span>开始 {formatDateTime(item.startedAt)}</span> : null}{item.status === "running" && item.lastEventAt ? <span>最近响应 {formatDateTime(item.lastEventAt)}</span> : null}{item.failedAt ? <span>失败 {formatDateTime(item.failedAt)}</span> : null}</div>{renderStageOutcome(item)}{renderNodeInputs(node, item)}{item.status === "failed" ? <em>{item.error}</em> : null}{item.status === "running" ? <progress aria-label={`${item.title} 执行进度`} max="100" value={item.progress || 0} /> : null}</div>
                <div className="af-release-node__actions">{canWrite && item.status === "running" ? <button type="button" onClick={(event) => { event.stopPropagation(); cancelNode(item); }}>取消</button> : null}{canWrite && item.status === "failed" ? <button type="button" onClick={(event) => { event.stopPropagation(); retryNode(item); }}>重试</button> : null}{canWrite && item.status !== "running" && item.status !== "failed" ? <button type="button" onClick={(event) => { event.stopPropagation(); executeNode(item); }}>执行</button> : null}{canWrite && item.status !== "running" ? <button type="button" className="af-release-node__delete" aria-label={`删除${item.title}`} onClick={(event) => { event.stopPropagation(); void deleteNode(item); }}>删除</button> : null}{!canWrite ? <span className="af-release-node__readonly">只读</span> : null}</div>
              </article>;
            })}
            <div className="af-release-add-node">
              {canWrite ? <button type="button" className="af-release-add-node__trigger" aria-expanded={addNodeOpen} onClick={() => setAddNodeOpen((open) => !open)} disabled={customNodeOptions.length === 0}><span className="af-release-add-node__icon" aria-hidden="true">+</span><span><strong>自定义添加阶段</strong><small>从当前业务线、平台和批次的流程节点中选择，可重复添加</small></span><span className="material-symbols-outlined" aria-hidden="true">{addNodeOpen ? "expand_less" : "expand_more"}</span></button> : <p className="af-release-readonly-hint">无操作权限，无法添加阶段</p>}
              {canWrite && addNodeOpen ? <div className="af-release-add-node__options">{customNodeGroups.map((group) => <section key={group.id} className="af-release-add-node__group"><h4>{group.title}</h4>{group.nodes.map((node) => <button key={node.id} type="button" onClick={() => addPresetNode(node)}><span><strong>{node.title}</strong><small>{node.description}</small></span><em>{node.category}</em></button>)}</section>)}</div> : null}
            </div>
          </div>
        </section>
      </div>
      {inspector ? <ReleaseNodeInspector
        item={inspector.item}
        node={inspector.node}
        mode={inspector.mode}
        canWrite={canWrite}
        onClose={() => setInspector(null)}
        onSave={canWrite ? saveInspectorItem : undefined}
        onPreview={canWrite ? executeNode : undefined}
        onRun={canWrite ? runInspectorItem : undefined}
        onStop={canWrite ? cancelNode : undefined}
        context={context}
      /> : null}
    </section>
  );
}
