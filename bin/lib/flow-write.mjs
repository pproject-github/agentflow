/**
 * 写入 flow.yaml（仅 user / workspace）。
 * - user → ~/agentflow/pipelines/<flowId>/flow.yaml
 * - workspace → <workspaceRoot>/.workspace/agentflow/pipelines/<flowId>/flow.yaml
 * 包内 builtin/pipelines 不可直接覆盖写入。
 */
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import {
  ARCHIVED_PIPELINES_DIR_NAME,
  getAgentflowDataRoot,
  getUserPipelinesRoot,
  LEGACY_PIPELINES_DIR,
  PIPELINES_DIR,
} from "./paths.mjs";
import { getFlowYamlAbs } from "./catalog-flows.mjs";

export const FLOW_YAML_FILENAME = "flow.yaml";

/** @typedef {"user" | "workspace"} FlowWriteSource */

/** 用户新建流水线 ID：英文字母开头，仅字母、数字、下划线、连字符 */
export const USER_PIPELINE_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

const USER_PIPELINE_ID_MAX = 128;

/**
 * @param {string} flowId
 * @returns {{ ok: true, flowId: string } | { ok: false, error: string }}
 */
export function validateUserPipelineId(flowId) {
  if (flowId == null || typeof flowId !== "string") {
    return { ok: false, error: "缺少流水线名称" };
  }
  const t = flowId.trim();
  if (!t) {
    return { ok: false, error: "流水线名称不能为空" };
  }
  if (t.length > USER_PIPELINE_ID_MAX) {
    return { ok: false, error: `流水线名称过长（最多 ${USER_PIPELINE_ID_MAX} 字符）` };
  }
  if (!USER_PIPELINE_ID_RE.test(t)) {
    return {
      ok: false,
      error: "名称须以英文字母开头，仅可使用字母、数字、下划线 _ 与连字符 -",
    };
  }
  return { ok: true, flowId: t };
}

/**
 * 空流水线 flow.yaml（instances / edges 为空；介绍写入 ui.description）
 * @param {{ description?: string }} [options]
 */
export function buildEmptyUserFlowYaml(options = {}) {
  /** @type {Record<string, unknown>} */
  const ui = { nodePositions: {} };
  const d = options.description;
  if (d != null && String(d).trim() !== "") {
    ui.description = String(d).trim();
  }
  return yaml.dump({ instances: {}, edges: [], ui }, { lineWidth: -1 });
}

/**
 * @param {string} workspaceRoot
 * @param {FlowWriteSource} source
 */
function getPipelinesRootByWriteSource(workspaceRoot, source) {
  if (source === "workspace") {
    return path.join(path.resolve(workspaceRoot), PIPELINES_DIR);
  }
  return getUserPipelinesRoot();
}

/**
 * 工作区内已存在的流水线目录（新路径优先，其次旧版 .cursor 路径）。
 * @returns {string | null}
 */
function resolveExistingWorkspaceFlowDir(workspaceRoot, flowId) {
  const root = path.resolve(workspaceRoot);
  for (const rel of [PIPELINES_DIR, LEGACY_PIPELINES_DIR]) {
    const d = path.join(root, rel, flowId);
    if (fs.existsSync(path.join(d, FLOW_YAML_FILENAME))) return d;
  }
  return null;
}

/**
 * @param {string} workspaceRoot
 * @param {string} flowId
 * @param {FlowWriteSource} flowSource
 * @returns {{ flowDir: string, error?: string }}
 */
export function resolveFlowDirForWrite(workspaceRoot, flowId, flowSource) {
  if (!workspaceRoot || !flowId) {
    return { flowDir: "", error: "workspaceRoot and flowId are required" };
  }
  if (/[/\\.]/.test(flowId) || flowId === "..") {
    return { flowDir: "", error: "invalid flowId" };
  }
  if (flowSource === "builtin") {
    return { flowDir: "", error: "cannot write package builtin pipelines; use workspace or user" };
  }
  if (flowSource !== "user" && flowSource !== "workspace") {
    return { flowDir: "", error: "flowSource must be user or workspace" };
  }

  let boundariesBase;
  if (flowSource === "user") {
    boundariesBase = path.resolve(getAgentflowDataRoot());
    try {
      if (fs.existsSync(boundariesBase)) boundariesBase = fs.realpathSync(boundariesBase);
    } catch (_) {
      /* keep boundariesBase */
    }
  } else {
    const normalized = path.normalize(workspaceRoot);
    try {
      boundariesBase = fs.realpathSync(normalized);
    } catch {
      return { flowDir: "", error: "base path does not exist or is inaccessible" };
    }
  }

  const pipelinesRoot = getPipelinesRootByWriteSource(workspaceRoot, flowSource);
  const flowDir = path.join(pipelinesRoot, flowId);
  const resolvedFlowDir = path.resolve(flowDir);
  const baseWithSep = boundariesBase.endsWith(path.sep) ? boundariesBase : boundariesBase + path.sep;
  if (resolvedFlowDir !== boundariesBase && !resolvedFlowDir.startsWith(baseWithSep)) {
    return { flowDir: "", error: "flow path is outside base path" };
  }
  return { flowDir };
}

/**
 * @param {string} workspaceRoot
 * @param {string} flowId
 * @param {FlowWriteSource} flowSource
 * @param {string} flowYaml
 * @returns {{ success: true } | { success: false, error: string }}
 */
/**
 * @param {string} workspaceRoot
 * @param {string} flowId
 * @param {FlowWriteSource} flowSource
 * @returns {{ flowDir: string, error?: string }}
 */
export function resolveArchivedFlowDirForWrite(workspaceRoot, flowId, flowSource) {
  if (!workspaceRoot || !flowId) {
    return { flowDir: "", error: "workspaceRoot and flowId are required" };
  }
  if (/[/\\.]/.test(flowId) || flowId === "..") {
    return { flowDir: "", error: "invalid flowId" };
  }
  if (flowSource !== "user" && flowSource !== "workspace") {
    return { flowDir: "", error: "flowSource must be user or workspace" };
  }

  let boundariesBase;
  if (flowSource === "user") {
    boundariesBase = path.resolve(getAgentflowDataRoot());
    try {
      if (fs.existsSync(boundariesBase)) boundariesBase = fs.realpathSync(boundariesBase);
    } catch (_) {
      /* keep */
    }
  } else {
    const normalized = path.normalize(workspaceRoot);
    try {
      boundariesBase = fs.realpathSync(normalized);
    } catch {
      return { flowDir: "", error: "base path does not exist or is inaccessible" };
    }
  }

  const pipelinesRoot = getPipelinesRootByWriteSource(workspaceRoot, flowSource);
  const flowDir = path.join(pipelinesRoot, ARCHIVED_PIPELINES_DIR_NAME, flowId);
  const resolvedFlowDir = path.resolve(flowDir);
  const baseWithSep = boundariesBase.endsWith(path.sep) ? boundariesBase : boundariesBase + path.sep;
  if (resolvedFlowDir !== boundariesBase && !resolvedFlowDir.startsWith(baseWithSep)) {
    return { flowDir: "", error: "flow path is outside base path" };
  }
  return { flowDir };
}

/**
 * @param {string} workspaceRoot
 * @param {string} flowId
 * @param {FlowWriteSource} flowSource
 * @param {string} flowYaml
 * @param {{ archived?: boolean }} [opts]
 * @returns {{ success: true } | { success: false, error: string }}
 */
export function writeFlowYaml(workspaceRoot, flowId, flowSource, flowYaml, opts = {}) {
  const archived = Boolean(opts.archived);
  const { flowDir, error } = archived
    ? resolveArchivedFlowDirForWrite(workspaceRoot, flowId, flowSource)
    : resolveFlowDirForWrite(workspaceRoot, flowId, flowSource);
  if (error) return { success: false, error };
  try {
    fs.mkdirSync(flowDir, { recursive: true });
    fs.writeFileSync(path.join(flowDir, FLOW_YAML_FILENAME), flowYaml ?? "", "utf-8");
    return { success: true };
  } catch (e) {
    return { success: false, error: (e && e.message) || String(e) };
  }
}

/**
 * 将活跃流水线目录移入 `pipelines/_archived/<flowId>/`（仅 user / workspace）。
 * @param {string} workspaceRoot
 * @param {string} flowId
 * @param {FlowWriteSource} flowSource
 * @returns {{ success: true } | { success: false, error: string }}
 */
export function archiveFlowPipeline(workspaceRoot, flowId, flowSource) {
  if (flowSource !== "user" && flowSource !== "workspace") {
    return { success: false, error: "仅支持用户目录或工作区流水线归档" };
  }
  const yamlRes = getFlowYamlAbs(workspaceRoot, flowId, flowSource, { archived: false });
  if (yamlRes.error || !yamlRes.path) {
    return { success: false, error: yamlRes.error || "找不到流水线" };
  }
  const fromDir = path.dirname(yamlRes.path);
  const sep = path.sep;
  if (fromDir.split(sep).includes(ARCHIVED_PIPELINES_DIR_NAME)) {
    return { success: false, error: "该流水线已在归档目录中" };
  }
  const toRes = resolveArchivedFlowDirForWrite(workspaceRoot, flowId, flowSource);
  if (toRes.error || !toRes.flowDir) {
    return { success: false, error: toRes.error || "无法解析归档路径" };
  }
  const toDir = toRes.flowDir;
  if (fs.existsSync(toDir)) {
    return { success: false, error: "归档位置已存在同名目录" };
  }
  try {
    fs.mkdirSync(path.dirname(toDir), { recursive: true });
    fs.renameSync(fromDir, toDir);
  } catch (e) {
    return { success: false, error: (e && e.message) || String(e) };
  }
  return { success: true };
}

/**
 * 在用户目录与工作区之间移动整个流水线目录（含 nodes 等）。
 * @param {string} workspaceRoot
 * @param {string} flowId
 * @param {"user" | "workspace"} fromSource
 * @param {"user" | "workspace"} toSource
 * @returns {{ success: true, flowSource: "user" | "workspace" } | { success: false, error: string }}
 */
export function moveFlowDirectory(workspaceRoot, flowId, fromSource, toSource) {
  if (fromSource === toSource) {
    return { success: false, error: "fromSource and toSource must differ" };
  }
  if (
    (fromSource !== "user" && fromSource !== "workspace") ||
    (toSource !== "user" && toSource !== "workspace")
  ) {
    return { success: false, error: "only user and workspace are allowed for move" };
  }
  let fromDir;
  if (fromSource === "workspace") {
    const w = resolveFlowDirForWrite(workspaceRoot, flowId, "workspace");
    if (w.error || !w.flowDir) return { success: false, error: w.error || "invalid source path" };
    fromDir = resolveExistingWorkspaceFlowDir(workspaceRoot, flowId);
    if (!fromDir) return { success: false, error: "source flow not found" };
  } else {
    const fromRes = resolveFlowDirForWrite(workspaceRoot, flowId, fromSource);
    if (fromRes.error || !fromRes.flowDir) return { success: false, error: fromRes.error || "invalid source path" };
    fromDir = fromRes.flowDir;
  }
  const toRes = resolveFlowDirForWrite(workspaceRoot, flowId, toSource);
  if (toRes.error || !toRes.flowDir) return { success: false, error: toRes.error || "invalid target path" };
  const toDir = toRes.flowDir;
  if (!fs.existsSync(path.join(fromDir, FLOW_YAML_FILENAME))) {
    return { success: false, error: "source flow not found" };
  }
  if (fs.existsSync(toDir)) {
    return { success: false, error: "target location already exists" };
  }
  try {
    fs.mkdirSync(path.dirname(toDir), { recursive: true });
    fs.renameSync(fromDir, toDir);
  } catch (e) {
    return { success: false, error: (e && e.message) || String(e) };
  }
  return { success: true, flowSource: toSource };
}

/**
 * @param {string} flowDir
 * @param {string} workspaceRoot
 * @param {FlowWriteSource} flowSource
 * @param {string} flowId
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function assertFlowDirIsSafeToDelete(flowDir, workspaceRoot, flowSource, flowId) {
  let realDir;
  try {
    realDir = fs.realpathSync(flowDir);
  } catch {
    return { ok: false, error: "流水线目录不可访问" };
  }
  if (path.basename(realDir) !== flowId) {
    return { ok: false, error: "目录与流水线 ID 不匹配" };
  }
  const root = path.resolve(workspaceRoot);
  /** @type {string[]} */
  const allowedRoots = [];
  if (flowSource === "user") {
    try {
      allowedRoots.push(fs.realpathSync(getUserPipelinesRoot()));
    } catch {
      allowedRoots.push(path.resolve(getUserPipelinesRoot()));
    }
    for (const rel of [PIPELINES_DIR, LEGACY_PIPELINES_DIR]) {
      const base = path.join(root, rel);
      if (fs.existsSync(base)) {
        try {
          allowedRoots.push(fs.realpathSync(base));
        } catch {
          allowedRoots.push(path.resolve(base));
        }
      }
    }
  } else {
    for (const rel of [PIPELINES_DIR, LEGACY_PIPELINES_DIR]) {
      const base = path.join(root, rel);
      if (fs.existsSync(base)) {
        try {
          allowedRoots.push(fs.realpathSync(base));
        } catch {
          allowedRoots.push(path.resolve(base));
        }
      }
    }
  }

  for (const allowed of allowedRoots) {
    const sep = allowed.endsWith(path.sep) ? allowed : allowed + path.sep;
    if (realDir !== allowed && !realDir.startsWith(sep)) continue;
    const rel = path.relative(allowed, realDir);
    const parts = rel.split(path.sep).filter(Boolean);
    if (parts.length === 1 && parts[0] === flowId) return { ok: true };
    if (
      parts.length === 2 &&
      parts[0] === ARCHIVED_PIPELINES_DIR_NAME &&
      parts[1] === flowId
    ) {
      return { ok: true };
    }
  }
  return { ok: false, error: "拒绝删除：路径不在允许的 pipelines 目录内" };
}

/**
 * 永久删除流水线目录（含 flow.yaml、scripts 等）。仅 user / workspace；内置只读不可删。
 * @param {string} workspaceRoot
 * @param {string} flowId
 * @param {FlowWriteSource} flowSource
 * @param {{ archived?: boolean }} [opts]
 * @returns {{ success: true } | { success: false, error: string }}
 */
export function deleteFlowPipeline(workspaceRoot, flowId, flowSource, opts = {}) {
  if (flowSource === "builtin") {
    return { success: false, error: "内置流水线不可删除" };
  }
  if (flowSource !== "user" && flowSource !== "workspace") {
    return { success: false, error: "仅支持删除用户目录或工作区流水线" };
  }
  if (!flowId || typeof flowId !== "string" || /[/\\.]/.test(flowId) || flowId === "..") {
    return { success: false, error: "invalid flowId" };
  }
  const archived = Boolean(opts.archived);
  const yamlRes = getFlowYamlAbs(workspaceRoot, flowId, flowSource, { archived });
  if (yamlRes.error || !yamlRes.path) {
    return { success: false, error: yamlRes.error || "找不到流水线" };
  }
  const flowDir = path.dirname(yamlRes.path);
  const guard = assertFlowDirIsSafeToDelete(flowDir, workspaceRoot, flowSource, flowId);
  if (!guard.ok) return { success: false, error: guard.error };
  try {
    fs.rmSync(flowDir, { recursive: true, force: true });
    return { success: true };
  } catch (e) {
    return { success: false, error: (e && e.message) || String(e) };
  }
}
