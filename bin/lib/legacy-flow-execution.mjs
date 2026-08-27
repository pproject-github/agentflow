export const LEGACY_FLOW_EXECUTION_DISABLED = true;

export const LEGACY_FLOW_EXECUTION_MESSAGE =
  "Legacy Start/End Pipeline execution has been retired. Use the Workspace graph with Run or Scheduled Run.";

export const LEGACY_FLOW_NODE_IDS = new Set(["control_start", "control_end"]);

/**
 * 只有旧 Start/End 运行时实现、Workspace 运行时没有对应 handler 的节点类型。
 *
 * 这些定义留在 `builtin/nodes/` 只为让历史 flow.yaml / workspace.graph.json 仍能解析出
 * 节点元数据；节点面板不再提供它们，避免用户新建出跑不了的图（拖出来只会落到通用
 * agent 路径，拿不到文档承诺的语义）。
 *
 * 想恢复某个类型，就在 ui-server 的 workspace 运行循环里补上 handler，再从这里删掉。
 */
export const WORKSPACE_UNSUPPORTED_NODE_IDS = new Set([
  // 循环 / 汇合：Workspace 运行计划是 DAG，有环会被直接拒绝
  "control_anyOne",
  "control_toBool",
  "control_agent_toBool",
  "control_interval_loop",
  // 时序与取消
  "control_delay",
  "control_wait_until",
  "control_cancelled",
  // 人工卡点
  "tool_user_check",
  "tool_user_ask",
  // 运行期键值 / 环境变量
  "tool_load_key",
  "tool_save_key",
  "tool_get_env",
  // 其它
  "tool_print",
]);

/** 节点面板与目录需要隐藏的全部 definitionId */
export const RETIRED_NODE_IDS = new Set([
  ...LEGACY_FLOW_NODE_IDS,
  ...WORKSPACE_UNSUPPORTED_NODE_IDS,
]);
