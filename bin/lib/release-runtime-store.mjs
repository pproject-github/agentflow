import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

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
    inputs: { businessLine, platform, version, workspace: workspacePath },
  };
}

export function emptyReleaseState(context = {}, workspacePath = "") {
  const initialization = createReleaseInitialization(context, workspacePath);
  return {
    context: { ...context },
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
    return state;
  } catch {
    return emptyReleaseState(context, workspacePath);
  }
}

export function writeReleaseState(workspaceRoot, context, workspaceId, state) {
  const filePath = releaseStatePath(workspaceRoot, context, workspaceId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
  return { path: filePath, state };
}
