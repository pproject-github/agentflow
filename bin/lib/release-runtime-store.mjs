import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { selectReleaseWorkflow } from "../../shared/release-workflow-config.js";

function safePart(value, fallback = "unknown") {
  const text = String(value || "").trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return text || fallback;
}

export function releaseStateKey(context = {}, workspaceId = "workspace") {
  return [workspaceId, context.businessLine, context.platform, context.version, context.batch || "initial"].map((value) => safePart(value)).join("__");
}

export function releaseStatePath(workspaceRoot, context = {}, workspaceId = "workspace") {
  return path.join(path.resolve(workspaceRoot), ".workspace", "release-runtime", `${releaseStateKey(context, workspaceId)}.json`);
}

export function createReleaseInitialization(context = {}, workspacePath = "") {
  const businessLine = String(context.businessLine || "likee");
  const platform = String(context.platform || "android");
  const version = String(context.version || "1.0.0");
  const timestamp = Date.now();
  const workflow = selectReleaseWorkflow(context);
  return {
    id: "release-initialization",
    nodeId: "release-initialization",
    title: "初始化状态",
    description: `初始化发版上下文：${businessLine} / ${platform} / ${version}`,
    category: "发版初始化",
    status: "completed",
    progress: 100,
    createdAt: timestamp,
    startedAt: timestamp,
    completedAt: timestamp,
    durationMs: 0,
    operator: "系统初始化",
    workflowId: workflow?.id || "",
    workflowVersion: "1",
    inputs: { businessLine, platform, version, workspace: workspacePath },
  };
}

export function emptyReleaseState(context = {}, workspacePath = "") {
  const initialization = createReleaseInitialization(context, workspacePath);
  const workflow = selectReleaseWorkflow(context);
  return {
    context: { ...context },
    workflowId: workflow?.id || "",
    workflowVersion: "1",
    // 用户需求点: 首次进入页面时上下文已完成声明，初始化节点直接作为已完成时间线的起点。
    timeline: [initialization],
    pending: [],
    customNodes: [],
    runs: {},
  };
}

export function readReleaseState(workspaceRoot, context = {}, workspaceId = "workspace", workspacePath = "") {
  const filePath = releaseStatePath(workspaceRoot, context, workspaceId);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!parsed || typeof parsed !== "object") return emptyReleaseState(context, workspacePath);
    const state = {
      ...emptyReleaseState(context, workspacePath),
      ...parsed,
      context: { ...context, ...(parsed.context || {}) },
      timeline: Array.isArray(parsed.timeline) ? parsed.timeline : [],
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
      customNodes: Array.isArray(parsed.customNodes) ? parsed.customNodes : [],
      runs: parsed.runs && typeof parsed.runs === "object" ? parsed.runs : {},
    };
    return normalizeWorkflowState(normalizeInitializationState(state, context, workspacePath), context);
  } catch {
    return emptyReleaseState(context, workspacePath);
  }
}

// 用户需求点: 历史记录可继续查看，但不能让不属于当前状态机的节点重新进入可执行候选集合。
function normalizeWorkflowState(state, context = {}) {
  const workflow = selectReleaseWorkflow(context);
  const workflowId = String(state.workflowId || workflow?.id || "");
  const workflowVersion = String(state.workflowVersion || "1");
  const withIdentity = (item) => item && {
    ...item,
    workflowId: String(item.workflowId || workflowId),
    workflowVersion: String(item.workflowVersion || workflowVersion),
  };
  return {
    ...state,
    workflowId,
    workflowVersion,
    timeline: (Array.isArray(state.timeline) ? state.timeline : []).map(withIdentity),
    pending: (Array.isArray(state.pending) ? state.pending : []).map(withIdentity),
    customNodes: (Array.isArray(state.customNodes) ? state.customNodes : []).map(withIdentity),
  };
}

// 用户需求点: 进入发版页即完成上下文声明，历史 pending 初始化也必须迁移到已完成时间线，避免再次触发一个无实际动作的执行节点。
function normalizeInitializationState(state, context, workspacePath) {
  const timeline = Array.isArray(state.timeline) ? state.timeline : [];
  const pending = Array.isArray(state.pending) ? state.pending : [];
  const timelineInitialization = timeline.find((item) => item?.nodeId === "release-initialization");
  const pendingInitialization = pending.find((item) => item?.nodeId === "release-initialization");
  const initialization = timelineInitialization || pendingInitialization || createReleaseInitialization(context, workspacePath);
  const timestamp = Number(initialization.createdAt) || Date.now();
  const completed = {
    ...createReleaseInitialization(context, workspacePath),
    ...initialization,
    id: initialization.id || "release-initialization",
    nodeId: "release-initialization",
    status: "completed",
    progress: 100,
    createdAt: timestamp,
    startedAt: Number(initialization.startedAt) || timestamp,
    completedAt: Number(initialization.completedAt) || timestamp,
    durationMs: Number.isFinite(Number(initialization.durationMs)) ? Number(initialization.durationMs) : 0,
    operator: initialization.operator && initialization.operator !== "未记录" ? initialization.operator : "系统初始化",
  };
  return {
    ...state,
    timeline: [completed, ...timeline.filter((item) => item?.nodeId !== "release-initialization")],
    pending: pending.filter((item) => item?.nodeId !== "release-initialization"),
  };
}

export function writeReleaseState(workspaceRoot, context, workspaceId, state) {
  const filePath = releaseStatePath(workspaceRoot, context, workspaceId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
  return { path: filePath, state };
}
