/**
 * 包路径与 CLI 常量（供 bin/agentflow 与各 lib 模块使用）。
 */
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

/** 项目内 runBuild 根目录：`<workspaceRoot>/.workspace/agentflow/runBuild` */
export function getWorkspaceRunBuildRoot(workspaceRoot) {
  const root =
    workspaceRoot != null && String(workspaceRoot).trim() !== ""
      ? path.resolve(String(workspaceRoot))
      : process.cwd();
  return path.join(root, ".workspace/agentflow/runBuild");
}

/** 旧版用户目录 runBuild 根目录：`~/agentflow/runBuild`（仅用于历史兼容读取） */
export function getLegacyUserRunBuildRoot() {
  return path.join(getAgentflowDataRoot(), "runBuild");
}

/** 单次 run 目录：`<workspaceRoot>/.workspace/agentflow/runBuild/<flowName>/<uuid>` */
export function getRunDir(workspaceRoot, flowName, uuid) {
  return path.join(getWorkspaceRunBuildRoot(workspaceRoot), flowName, uuid);
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
