/**
 * 包路径与 CLI 常量（供 bin/agentflow 与各 lib 模块使用）。
 */
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
/** bin/ 目录（含 pipeline 子目录） */
export const BIN_DIR = path.resolve(__dirname, "..");
export const PACKAGE_ROOT = path.resolve(BIN_DIR, "..");

/** 节点执行区域分割线（开始/结束标识用） */
export const NODE_SEP = "════════════════════════════════════════════════════════════════";

/** agentflow 包根目录（CLI 所在包的 node_modules 用于解析脚本依赖，如 js-yaml） */
export const PACKAGE_AGENTS_DIR = path.join(PACKAGE_ROOT, "agents");
/** 包内 agents 元数据 JSON */
export const PACKAGE_AGENTS_JSON = path.join(PACKAGE_AGENTS_DIR, "agents.json");

/**
 * 用户级 AgentFlow 数据根目录：`AGENTFLOW_HOME` 或 `~/agentflow`。
 * 与项目根 workspaceRoot 分离；run、pipelines、agents 等均落盘于此。
 */
export function getAgentflowDataRoot() {
  const env = process.env.AGENTFLOW_HOME;
  if (env != null && String(env).trim() !== "") {
    let raw = String(env).trim();
    if (raw === "~") raw = os.homedir();
    else if (raw.startsWith("~/")) raw = path.join(os.homedir(), raw.slice(2));
    return path.resolve(raw);
  }
  return path.join(os.homedir(), "agentflow");
}

/** 项目内 runBuild 根目录：`<workspaceRoot>/.workspace/agentflow/runBuild`（legacy：写入路径已迁至 `<flowDir>/runBuild`，仅用于兼容读取） */
export function getWorkspaceRunBuildRoot(workspaceRoot) {
  const root =
    workspaceRoot != null && String(workspaceRoot).trim() !== ""
      ? path.resolve(String(workspaceRoot))
      : process.cwd();
  return path.join(root, ".workspace/agentflow/runBuild");
}

/** 旧版用户目录 runBuild 根目录：`~/agentflow/runBuild`（legacy：仅用于历史兼容读取） */
export function getLegacyUserRunBuildRoot() {
  return path.join(getAgentflowDataRoot(), "runBuild");
}

/**
 * 统一 runtime root：每个 flow 的 pipeline 源、scripts、runBuild 共用一个根目录。
 * - 若 `~/agentflow/pipelines/<name>/flow.yaml` 存在 → user-scope：`~/agentflow/pipelines/<name>`
 * - 若 `<ws>/.workspace/agentflow/pipelines/<name>/flow.yaml` 存在 → workspace-scope：`<ws>/.workspace/agentflow/pipelines/<name>`
 * - archived（`_archived/<name>`）按对应 scope 返回
 * - 其他（builtin 只读 / 不存在）→ 默认 user-scope 路径（首次 run 时自动创建，builtin 源仍从包内读取但 runBuild 落到用户目录）
 */
export function getFlowRuntimeRoot(workspaceRoot, flowName) {
  const root =
    workspaceRoot != null && String(workspaceRoot).trim() !== ""
      ? path.resolve(String(workspaceRoot))
      : process.cwd();
  const userRoot = getUserPipelinesRoot();
  const userDir = path.join(userRoot, flowName);
  if (fs.existsSync(path.join(userDir, "flow.yaml"))) return userDir;
  const userArchived = path.join(userRoot, ARCHIVED_PIPELINES_DIR_NAME, flowName);
  if (fs.existsSync(path.join(userArchived, "flow.yaml"))) return userArchived;
  const wsDir = path.join(root, PIPELINES_DIR, flowName);
  if (fs.existsSync(path.join(wsDir, "flow.yaml"))) return wsDir;
  const wsArchived = path.join(root, PIPELINES_DIR, ARCHIVED_PIPELINES_DIR_NAME, flowName);
  if (fs.existsSync(path.join(wsArchived, "flow.yaml"))) return wsArchived;
  // builtin / legacy / 尚未落盘 → 默认 user 目录，runBuild 首次写入时创建
  return userDir;
}

/**
 * 单次 run 目录。
 * 新运行走 `<flowRuntimeRoot>/runBuild/<uuid>`；
 * 若该 uuid 在旧位置（legacy workspace/user runBuild 根）已存在，则返回旧位置，保留 resume 兼容。
 */
export function getRunDir(workspaceRoot, flowName, uuid) {
  const candidates = getRunDirCandidates(workspaceRoot, flowName, uuid);
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  return candidates[0];
}

/**
 * 枚举候选 run 目录（新/旧位置）供 UI 读取历史 run。
 * 返回数组按"最优先 → 最兜底"排序：
 *   1. 新 per-flow：<flowRuntimeRoot>/runBuild/<uuid>
 *   2. 旧 workspace：<ws>/.workspace/agentflow/runBuild/<flow>/<uuid>
 *   3. 旧 user：~/agentflow/runBuild/<flow>/<uuid>
 */
export function getRunDirCandidates(workspaceRoot, flowName, uuid) {
  const candidates = [
    path.join(getFlowRuntimeRoot(workspaceRoot, flowName), "runBuild", uuid),
    path.join(getWorkspaceRunBuildRoot(workspaceRoot), flowName, uuid),
    path.join(getLegacyUserRunBuildRoot(), flowName, uuid),
  ];
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    const r = path.resolve(c);
    if (seen.has(r)) continue;
    seen.add(r);
    out.push(r);
  }
  return out;
}

export function getUserPipelinesRoot() {
  return path.join(getAgentflowDataRoot(), "pipelines");
}

export function getReferenceRootAbs() {
  return path.join(getAgentflowDataRoot(), "reference");
}

export function getUserAgentsDirAbs() {
  return path.join(getAgentflowDataRoot(), "agents");
}

export function getUserAgentsJsonAbs() {
  return path.join(getAgentflowDataRoot(), "agents.json");
}

export function getModelListsAbs() {
  return path.join(getAgentflowDataRoot(), "model-lists.json");
}

export function getAgentflowUserConfigAbs() {
  return path.join(getAgentflowDataRoot(), "config.json");
}

/** CLI / UI 文案用 */
export const USER_AGENTFLOW_DIR_LABEL = "~/agentflow";
export const USER_AGENTFLOW_PIPELINES_LABEL = "~/agentflow/pipelines";
export const USER_AGENTFLOW_AGENTS_LABEL = "~/agentflow/agents";

/** agents.json 中 user 角色 filepath 展示前缀（相对数据根） */
export const USER_AGENTS_FILEPATH_PREFIX = "agentflow/agents";

/** apply/replay 流水线脚本目录（随包发布） */
export const PIPELINE_SCRIPTS_DIR = path.join(BIN_DIR, "pipeline");
/** apply -ai 允许调用的单步脚本名（不含 .mjs） */
export const APPLY_AI_STEPS = [
  "ensure-run-dir",
  "parse-flow",
  "get-ready-nodes",
  "pre-process-node",
  "post-process-node",
  "write-result",
  "run-tool-nodejs",
  "get-env",
  "validate-flow",
  "collect-nodes",
  "gc",
  "extract-thinking",
];
/** 项目内流水线根目录（写入与主读取路径） */
export const PIPELINES_DIR = ".workspace/agentflow/pipelines";
/** 用户目录或工作区 pipelines 下存放已归档流水线的子目录名 */
export const ARCHIVED_PIPELINES_DIR_NAME = "_archived";
/** 旧版项目内路径；仅用于读取回退 */
export const LEGACY_PIPELINES_DIR = ".cursor/agentflow/pipelines";

/** 项目内 AgentFlow 根目录（相对 workspaceRoot） */
export const WORKSPACE_AGENTFLOW_ROOT = ".workspace/agentflow";
/** 项目内自定义节点 .md 目录（主路径；与包内 builtin/nodes 区分） */
export const PROJECT_NODES_DIR = ".workspace/agentflow/nodes";
/** 旧版项目内节点目录；仅用于读取回退 */
export const LEGACY_NODES_DIR = ".cursor/agentflow/nodes";
/** Web UI 模型映射等项目内配置（主路径） */
export const MODEL_CONFIG_REL = ".workspace/agentflow/models.json";
/** 旧版 models.json；仅用于读取回退 */
export const LEGACY_MODEL_CONFIG_REL = ".cursor/agentflow/models.json";

export const RUN_LOG_REL = "logs/log.txt";

/** 包内 reference 目录 */
export const PACKAGE_REFERENCE_DIR = path.join(PACKAGE_ROOT, "reference");
/** 包内内置节点与流水线 */
export const PACKAGE_BUILTIN_NODES_DIR = path.join(PACKAGE_ROOT, "builtin", "nodes");
export const PACKAGE_BUILTIN_PIPELINES_DIR = path.join(PACKAGE_ROOT, "builtin", "pipelines");

export const MAX_LOOP_ROUNDS = 10000;

/** 去掉 ANSI 转义码，便于解析 Cursor/OpenCode models 输出 */
export const CURSOR_NON_MODEL_PATTERNS = [
  /^loading\s+models/i,
  /^available\s+models$/i,
  /^tip:\s*use\s+--model/i,
];

/** 仅 pre+post、不执行任何命令的节点类型 */
export const LOCAL_ONLY_DEFINITION_IDS = new Set([
  "control_if",
  "control_start",
  "control_end",
  "tool_print",
  "tool_user_check",
  "tool_user_ask",
  "provide_str",
  "provide_file",
]);

/** 仅 pre+post 且由 CLI 负责写终态的节点 */
export const LOCAL_ONLY_TERMINAL_SUCCESS_IDS = new Set([
  "control_start",
  "control_end",
  "tool_print",
  "provide_str",
  "provide_file",
]);
