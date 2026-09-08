import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { inferReleaseBatch, normalizeReleaseMinorVersion, releaseMajorVersion, selectReleaseWorkflow } from "../../shared/release-workflow-config.js";

function safePart(value, fallback = "unknown") {
  const text = String(value || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return text || fallback;
}

export function releaseStateKey(context = {}, workspaceId = "workspace") {
  return [workspaceId, context.businessLine, context.platform, releaseMajorVersion(context.version)].map((value) => safePart(value)).join("__");
}

export function releaseStatePath(workspaceRoot, context = {}, workspaceId = "workspace") {
  return path.join(path.resolve(workspaceRoot), ".workspace", "release-runtime", `${releaseStateKey(context, workspaceId)}.json`);
}

export function createReleaseInitialization(context = {}, workspacePath = "") {
  const businessLine = String(context.businessLine || "likee");
  const platform = String(context.platform || "android");
  const version = normalizeReleaseMinorVersion(context.version || "1.0.0");
  const batch = inferReleaseBatch(version, context.batch || "");
  const timestamp = Date.now();
  const workflow = selectReleaseWorkflow(context);
  const scopeKey = `${String(context.businessLine || businessLine).toLowerCase()}/${String(context.platform || platform).toLowerCase()}/${version}/${batch}`;
  return {
    id: "release-initialization",
    nodeId: "release-initialization",
    title: "初始化状态",
    description: `初始化发版上下文：${businessLine} / ${platform} / ${version}`,
    category: "发版初始化",
    status: "completed",
    // 活动发版上下文由服务端在首次读取状态时同步准备；完成后由 bootstrap 回填结果。
    // 用户需求点: 首包初始化自动准备活动上下文；补包必须由“开始补包 & 发送通知”节点显式触发上下文。
    contextPreparationStatus: batch === "supplemental" ? "deferred" : "pending",
    progress: 100,
    createdAt: timestamp,
    startedAt: timestamp,
    completedAt: timestamp,
    durationMs: 0,
    operator: "系统初始化",
    workflowId: workflow?.id || "",
    scopeKey,
    contextSnapshot: { ...context, businessLine, platform, version, batch },
    inputs: { businessLine, platform, version, workspace: workspacePath },
  };
}

export function emptyReleaseState(context = {}, workspacePath = "") {
  const normalizedContext = {
    ...context,
    version: normalizeReleaseMinorVersion(context.version || "1.0.0"),
  };
  normalizedContext.batch = inferReleaseBatch(normalizedContext.version, context.batch || "");
  const initialization = createReleaseInitialization(normalizedContext, workspacePath);
  return {
    context: normalizedContext,
    // 用户需求点: 首次进入页面时上下文已完成声明，初始化节点直接作为已完成时间线的起点。
    timeline: [initialization],
    pending: [],
    dismissedNodeIds: [],
    customNodes: [],
    runs: {},
  };
}

// 用户需求点: 首包和补包共用大版本时间线，但每次读取仍需规范化当前小版本/批次供状态机隔离执行。
export function readReleaseState(workspaceRoot, context = {}, workspaceId = "workspace", workspacePath = "") {
  const filePath = releaseStatePath(workspaceRoot, context, workspaceId);
  const normalizedContext = {
    ...context,
    version: normalizeReleaseMinorVersion(context.version || "1.0.0"),
  };
  normalizedContext.batch = inferReleaseBatch(normalizedContext.version, context.batch || "");
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object") return emptyReleaseState(normalizedContext, workspacePath);
    const state = {
      ...emptyReleaseState(normalizedContext, workspacePath),
      ...parsed,
      // 同一大版本文件会被首包和补包共同读取，当前请求上下文应覆盖旧批次上下文；历史节点自身仍保留 contextSnapshot。
      context: { ...(parsed.context || {}), ...normalizedContext },
      timeline: Array.isArray(parsed.timeline) ? parsed.timeline : [],
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
      dismissedNodeIds: Array.isArray(parsed.dismissedNodeIds)
        ? [...new Set(parsed.dismissedNodeIds.map((value) => String(value || "").trim()).filter(Boolean))]
        : [],
      customNodes: Array.isArray(parsed.customNodes) ? parsed.customNodes : [],
      runs: parsed.runs && typeof parsed.runs === "object" ? parsed.runs : {},
    };
    return state;
  } catch {
    return emptyReleaseState(normalizedContext, workspacePath);
  }
}

function releaseRunManifestPath(workspaceRoot, runId) {
  const id = String(runId || "").trim();
  if (!id || id.includes("/") || id.includes("\\") || id.includes("..")) return "";
  return path.join(path.resolve(workspaceRoot), ".workspace", "agentflow", "run-manifests", `${id}.json`);
}

function readReleaseRunManifest(workspaceRoot, runId) {
  const filePath = releaseRunManifestPath(workspaceRoot, runId);
  if (!filePath) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

function terminalReleaseManifestStatus(manifest) {
  const status = String(manifest?.status || "").trim().toLowerCase();
  if (["completed", "success", "succeeded", "done"].includes(status)) return "completed";
  if (["failed", "error", "cancelled", "canceled", "stopped", "timeout", "timed_out"].includes(status)) return "failed";
  return "";
}

/**
 * Prefer an Agent-authored run status over a bare Workspace run-manifest
 * terminal status. Force/capability runs often leave the manifest as
 * `completed` while the Agent result is still `waiting` (e.g. open MR).
 */
function preferredAgentReleaseStatus(runRecord) {
  if (!runRecord || typeof runRecord !== "object") return "";
  const status = String(runRecord.status || "").trim().toLowerCase();
  const outputStatus = String(runRecord.output?.status || "").trim().toLowerCase();
  if (status === "waiting" || outputStatus === "waiting") return "waiting";
  if ((status === "completed" || status === "failed") && runRecord.output !== undefined) return status;
  if ((outputStatus === "completed" || outputStatus === "failed") && runRecord.output !== undefined) return outputStatus;
  return "";
}

function agentReleaseFields(runRecord) {
  if (!runRecord || typeof runRecord !== "object") return {};
  return {
    ...(runRecord.output !== undefined ? { output: runRecord.output } : {}),
    ...(runRecord.details !== undefined ? { details: runRecord.details } : {}),
    ...(runRecord.waiting !== undefined ? { waiting: runRecord.waiting } : {}),
  };
}

/**
 * Reconcile persisted release cards with AgentFlow run manifests.
 *
 * A release page can outlive the server process that launched an AgentFlow
 * run. In that case the JSON state still says `running` forever even though
 * the manifest has completed, or no worker is left to finish it. The active
 * run IDs are supplied by the route layer so a live run is never treated as
 * stale merely because this function is called while it is executing.
 */
export function releasePendingDismissalKey(item) {
  if (!item) return "";
  if (isCustomReleasePendingItem(item)) {
    return String(item.id || item.nodeId || "").trim();
  }
  return String(item?.sourcePresetId || "").trim() || String(item?.nodeId || "").trim();
}

export function isCustomReleasePendingItem(item) {
  const id = String(item?.id || "");
  const nodeId = String(item?.nodeId || "");
  return id.startsWith("custom-") || nodeId.startsWith("custom-");
}

export function filterDismissedReleasePending(stateInput = {}) {
  const dismissed = new Set((Array.isArray(stateInput?.dismissedNodeIds) ? stateInput.dismissedNodeIds : [])
    .map((value) => String(value || "").trim()).filter(Boolean));
  if (!dismissed.size) return { pending: Array.isArray(stateInput?.pending) ? [...stateInput.pending] : [], changed: false };
  const runningStatuses = new Set(["running", "previewing", "awaiting_confirmation", "ready", "blocked"]);
  const pending = (Array.isArray(stateInput?.pending) ? stateInput.pending : [])
    .filter((item) => {
      if (runningStatuses.has(String(item?.status || "").toLowerCase())) return true;
      const key = releasePendingDismissalKey(item);
      return !key || !dismissed.has(key);
    });
  const changed = pending.length !== (Array.isArray(stateInput?.pending) ? stateInput.pending.length : 0);
  return { pending, changed };
}

export function reconcileReleaseState(workspaceRoot, context = {}, workspaceId = "workspace", stateInput = {}, options = {}) {
  const state = {
    ...(stateInput && typeof stateInput === "object" ? stateInput : {}),
    context: { ...context, ...((stateInput && typeof stateInput.context === "object") ? stateInput.context : {}) },
    timeline: Array.isArray(stateInput?.timeline) ? [...stateInput.timeline] : [],
    pending: Array.isArray(stateInput?.pending) ? [...stateInput.pending] : [],
    runs: stateInput?.runs && typeof stateInput.runs === "object" ? { ...stateInput.runs } : {},
  };
  const activeRunIds = new Set((Array.isArray(options.activeRunIds) ? options.activeRunIds : options.activeRunIds instanceof Set ? [...options.activeRunIds] : [])
    .map((value) => String(value || "").trim()).filter(Boolean));
  const now = Number(options.now) || Date.now();
  const staleAfterMs = Math.max(30_000, Number(options.staleAfterMs) || 5 * 60 * 1000);
  let changed = false;
  const pending = [];
  for (const originalItem of state.pending) {
    const item = originalItem && typeof originalItem === "object" ? { ...originalItem } : originalItem;
    if (!item || String(item.status || "").toLowerCase() !== "running" || !item.runId) {
      pending.push(item);
      continue;
    }
    const runId = String(item.runId);
    if (activeRunIds.has(runId)) {
      pending.push(item);
      continue;
    }
    const manifest = readReleaseRunManifest(workspaceRoot, runId);
    const manifestStatus = terminalReleaseManifestStatus(manifest);
    const manifestTime = Date.parse(String(manifest?.updatedAt || manifest?.finishedAt || ""));
    const stale = !manifest || (String(manifest?.status || "").toLowerCase() === "running"
      && (!Number.isFinite(manifestTime) || now - manifestTime >= staleAfterMs));
    if (!manifestStatus && !stale) {
      pending.push(item);
      continue;
    }
    const runRecord = state.runs[runId] && typeof state.runs[runId] === "object" ? state.runs[runId] : {};
    const agentStatus = preferredAgentReleaseStatus(runRecord);
    if (agentStatus === "waiting") {
      // 用户需求点: waiting 不能伪装完成；保留待执行卡片，避免无交互节点推进状态机。
      const agentFields = agentReleaseFields(runRecord);
      const startedAt = Number(item.startedAt || runRecord.startedAt || (Number.isFinite(Date.parse(String(manifest?.startedAt || ""))) ? Date.parse(String(manifest.startedAt)) : 0));
      const finishedAt = Number.isFinite(Date.parse(String(manifest?.finishedAt || manifest?.updatedAt || "")))
        ? Date.parse(String(manifest.finishedAt || manifest.updatedAt))
        : now;
      const timing = {
        ...(startedAt > 0 ? { startedAt } : {}),
        completedAt: finishedAt,
        ...(startedAt > 0 ? { durationMs: Math.max(0, finishedAt - startedAt) } : {}),
      };
      const reconciled = {
        ...item,
        status: "waiting",
        progress: 0,
        error: "",
        failedAt: undefined,
        ...timing,
        ...agentFields,
      };
      state.runs[runId] = { ...runRecord, ...reconciled, status: "waiting", ...timing, ...agentFields };
      pending.push(reconciled);
      changed = true;
      continue;
    }
    const startedAt = Number(item.startedAt || runRecord.startedAt || (Number.isFinite(Date.parse(String(manifest?.startedAt || ""))) ? Date.parse(String(manifest.startedAt)) : 0));
    const finishedAt = Number.isFinite(Date.parse(String(manifest?.finishedAt || manifest?.updatedAt || "")))
      ? Date.parse(String(manifest.finishedAt || manifest.updatedAt))
      : now;
    const timing = {
      ...(startedAt > 0 ? { startedAt } : {}),
      completedAt: finishedAt,
      ...(startedAt > 0 ? { durationMs: Math.max(0, finishedAt - startedAt) } : {}),
    };
    const status = agentStatus || manifestStatus || "failed";
    const agentFields = agentStatus ? agentReleaseFields(runRecord) : {};
    const error = status === "failed"
      ? String(runRecord.error || manifest?.error || "AgentFlow 运行在服务重启后失联，未能完成").trim()
      : "";
    const reconciled = {
      ...item,
      status,
      progress: status === "completed" ? 100 : 0,
      ...timing,
      ...(status === "completed" ? { error: "", failedAt: undefined } : { failedAt: finishedAt, error }),
      ...(agentStatus
        ? agentFields
        : (manifest?.output !== undefined ? { output: manifest.output } : {})),
    };
    state.runs[runId] = { ...runRecord, ...reconciled, status, ...timing, ...(status === "failed" ? { error } : {}), ...agentFields };
    if (status === "completed") {
      state.timeline = [...state.timeline.filter((entry) => (
        (entry?.id !== reconciled.id && entry?.nodeId !== reconciled.nodeId) || entry?.runId !== runId
      )), reconciled];
    } else {
      pending.push(reconciled);
    }
    changed = true;
  }
  if (changed) state.pending = pending;

  // Keep historical run records consistent as well. They are not rendered as
  // cards today, but stale `running` records otherwise make diagnostics look
  // like work is still active after the owning server has gone away.
  const pendingRunIds = new Set(state.pending.map((item) => String(item?.runId || "").trim()).filter(Boolean));
  for (const [runId, originalRun] of Object.entries(state.runs)) {
    if (!originalRun || String(originalRun.status || "").toLowerCase() !== "running" || pendingRunIds.has(runId) || activeRunIds.has(runId)) continue;
    const agentStatus = preferredAgentReleaseStatus(originalRun);
    if (agentStatus === "waiting") {
      const agentFields = agentReleaseFields(originalRun);
      state.runs[runId] = { ...originalRun, status: "waiting", ...agentFields };
      changed = true;
      continue;
    }
    const manifest = readReleaseRunManifest(workspaceRoot, runId);
    const manifestStatus = terminalReleaseManifestStatus(manifest);
    const manifestTime = Date.parse(String(manifest?.updatedAt || manifest?.finishedAt || ""));
    const stale = !manifest || (String(manifest?.status || "").toLowerCase() === "running"
      && (!Number.isFinite(manifestTime) || now - manifestTime >= staleAfterMs));
    if (!manifestStatus && !stale) continue;
    const finishedAt = Number.isFinite(Date.parse(String(manifest?.finishedAt || manifest?.updatedAt || "")))
      ? Date.parse(String(manifest.finishedAt || manifest.updatedAt))
      : now;
    const startedAt = Number(originalRun.startedAt || (Number.isFinite(Date.parse(String(manifest?.startedAt || ""))) ? Date.parse(String(manifest.startedAt)) : 0));
    const status = agentStatus || manifestStatus || "failed";
    const agentFields = agentStatus ? agentReleaseFields(originalRun) : {};
    const error = status === "failed"
      ? String(originalRun.error || manifest?.error || "AgentFlow 运行在服务重启后失联，未能完成").trim()
      : "";
    state.runs[runId] = {
      ...originalRun,
      status,
      ...(startedAt > 0 ? { startedAt } : {}),
      completedAt: finishedAt,
      ...(startedAt > 0 ? { durationMs: Math.max(0, finishedAt - startedAt) } : {}),
      ...(status === "completed" ? { progress: 100, error: "", failedAt: undefined } : { progress: 0, error, failedAt: finishedAt }),
      ...agentFields,
    };
    changed = true;
  }

  // A previous read may already have moved a run into the timeline before a
  // later refresh discovers the terminal manifest. Normalize that projection
  // too (notably clear an old failure message on a run that ultimately
  // completed after a retry).
  state.timeline = state.timeline.map((entry) => {
    const runId = String(entry?.runId || "").trim();
    if (!runId || activeRunIds.has(runId)) return entry;
    const manifest = readReleaseRunManifest(workspaceRoot, runId);
    const manifestStatus = terminalReleaseManifestStatus(manifest);
    if (!manifestStatus) return entry;
    const finishedAt = Number.isFinite(Date.parse(String(manifest?.finishedAt || manifest?.updatedAt || "")))
      ? Date.parse(String(manifest.finishedAt || manifest.updatedAt))
      : Number(entry.completedAt) || now;
    const startedAt = Number(entry.startedAt) || (Number.isFinite(Date.parse(String(manifest?.startedAt || ""))) ? Date.parse(String(manifest.startedAt)) : 0);
    const next = {
      ...entry,
      status: manifestStatus,
      progress: manifestStatus === "completed" ? 100 : 0,
      ...(startedAt > 0 ? { startedAt } : {}),
      completedAt: finishedAt,
      ...(startedAt > 0 ? { durationMs: Math.max(0, finishedAt - startedAt) } : {}),
      ...(manifestStatus === "completed" ? { error: "", failedAt: undefined } : { failedAt: finishedAt, error: String(manifest?.error || entry.error || "发版 Agent 执行失败") }),
    };
    if (JSON.stringify(next) !== JSON.stringify(entry)) changed = true;
    return next;
  });
  const dismissedPending = filterDismissedReleasePending(state);
  if (dismissedPending.changed) {
    state.pending = dismissedPending.pending;
    changed = true;
  }
  return { state, changed };
}

export function writeReleaseState(workspaceRoot, context, workspaceId, state) {
  const filePath = releaseStatePath(workspaceRoot, context, workspaceId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
  return { path: filePath, state };
}
