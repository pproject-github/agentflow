import { log } from "./log.mjs";
import { t } from "./i18n.mjs";

export function printHelp() {
  const lang = process.env.AGENTFLOW_LANG || "zh";
  const isZh = lang === "zh";

  // 根据语言输出不同的帮助文本
  if (isZh) {
    log.info(`
AgentFlow CLI — 使用 Cursor 或 OpenCode CLI 流式输出驱动 apply/replay。

用法：
  agentflow list                              列出所有流水线
  agentflow ui [--port <n>] [--no-open]       本地 HTTP：流水线列表 + React Flow 节点流程图编辑保存（默认端口 8765）
  agentflow apply <FlowName> [uuid]            或 agentflow apply <uuid>（由 uuid 反查 pipeline）
  agentflow validate <FlowName> [uuid]        校验流程；终端下输出易读结果，--json 或管道时输出 JSON；传 uuid 时写入 runDir/intermediate/validation.json
  agentflow resume <FlowName> <uuid> [instanceId]  将 pending 与 failed 节点标为已确认并继续 apply
  agentflow replay [flowName] <uuid> <instanceId>
  agentflow run-status <flowName> <uuid>  输出该次运行的节点状态 JSON（供 UI 展示 success/pending 等角标）
  agentflow extract-thinking <flowName> <uuid>  从该次 run 的 logs/log.txt 提取 thinking，写入 logs/thinking_by_session_and_nodes.md
  agentflow extract-thinking -list             列出所有存在 logs/log.txt 的 run（可接 --json）
  agentflow update-model-lists            拉取 Cursor / OpenCode 模型列表并写入 ~/agentflow/model-lists.json；--json 时输出 { cursor, opencode }
  agentflow write-flow <flowId> --json --flow-source <user|workspace>   从 stdin 读入 YAML 写入用户目录或工作区（builtin 已弃用，将视为 workspace）
  agentflow --help

选项：
  --workspace-root <path>  工作区根目录（默认：当前目录）
  --dry-run                （仅 apply）打印就绪节点后退出，不执行 Cursor agent
  --model <name>           Cursor CLI 模型（如 claude-sonnet）。覆盖 CURSOR_AGENT_MODEL。运行 'agent models' 查看列表。
  --input <name>=<value>   （仅 apply）覆盖 flow 中 provide 节点的值。value 前缀 file: 表示文件路径。可多次使用。
  --debug                  显示调试日志（灰色，低优先级）
  --force                  传递 --force/--trust 给 Cursor；设置 OPENCODE_PERMISSION 允许 OpenCode 的 external_directory（默认开启）。使用 --no-force 禁用。
  --parallel               并行运行同轮就绪节点（默认关闭）。多个 Cursor CLI 进程可能竞争 ~/.cursor/cli-config.json。
  --machine-readable       向 stdout 每行输出一个 JSON 事件（apply-start/node-start/node-done/node-failed/apply-done/apply-paused）。供 UI 运行按钮使用：解析 stdout 显示当前节点；Cursor agent 输出转到 stderr。
  --lang <code>            设置语言：en、zh（默认：zh，或从 LANG 环境变量检测）

路径说明：
  runBuild 主目录：<workspaceRoot>/.workspace/agentflow/runBuild
  旧 runBuild 目录：~/agentflow/runBuild（仅历史兼容读取）

Apply：构建运行目录，解析流程，循环运行就绪节点。
  使用 -ai / --ai：运行单步供外部（AI）多轮控制：
    agentflow apply -ai ensure-run-dir <workspaceRoot> [uuid] <flowName>
    agentflow apply -ai parse-flow <workspaceRoot> <flowName> <uuid> [flowDir]
    agentflow apply -ai get-ready-nodes <workspaceRoot> <flowName> <uuid>
    agentflow apply -ai pre-process-node <workspaceRoot> <flowName> <uuid> <instanceId>
    agentflow apply -ai post-process-node <workspaceRoot> <flowName> <uuid> <instanceId> [execId]
    agentflow apply -ai write-result <workspaceRoot> <flowName> <uuid> <instanceId> --json '<JSON>'
    agentflow apply -ai run-tool-nodejs <workspaceRoot> <flowName> <uuid> <instanceId> [execId] -- <scriptCmd> [args...]
    agentflow apply -ai get-env <workspaceRoot> <flowName> <uuid> <instanceId> <execId> <key>
    agentflow apply -ai validate-flow <workspaceRoot> <flowName> <flowDir> [uuid]
    agentflow apply -ai collect-nodes <workspaceRoot> <flowName> [runDir]
    agentflow apply -ai gc <workspaceRoot> [--list] [--dry-run] [--delete] [--keep N] [--older-than N]
    agentflow apply -ai extract-thinking <workspaceRoot> <flowName> <uuid>
Resume：将 pending 和 failed 节点标记为成功（例如 UserCheck 确认后或重试失败后），然后继续 apply。
Replay：运行单个节点（pre-process → execute → post-process）。

需要：Node >=18，Cursor CLI（'agent'）在 PATH 中用于节点执行。
Apply/replay 脚本已打包在 agentflow 包中（bin/pipeline/）。
`);
  } else {
    // 英文版本
    log.info(`
AgentFlow CLI — drive apply/replay with Cursor or OpenCode CLI streaming.

Usage:
  agentflow list                              List all pipelines
  agentflow ui [--port <n>] [--no-open]       Local HTTP: pipeline list + React Flow node diagram editor (default port 8765)
  agentflow apply <FlowName> [uuid]            Or agentflow apply <uuid> (resolve pipeline from uuid)
  agentflow validate <FlowName> [uuid]        Validate flow; readable output in terminal, JSON with --json or pipe; writes to runDir/intermediate/validation.json when uuid provided
  agentflow resume <FlowName> <uuid> [instanceId]  Mark pending and failed nodes as acknowledged and continue apply
  agentflow replay [flowName] <uuid> <instanceId>
  agentflow run-status <flowName> <uuid>  Output node status JSON for this run (for UI success/pending badges)
  agentflow extract-thinking <flowName> <uuid>  Extract thinking from run logs/log.txt, write to logs/thinking_by_session_and_nodes.md
  agentflow extract-thinking -list             List all runs with logs/log.txt (use --json)
  agentflow update-model-lists            Fetch Cursor / OpenCode model lists to ~/agentflow/model-lists.json; --json outputs { cursor, opencode }
  agentflow write-flow <flowId> --json --flow-source <user|workspace>   Read YAML from stdin and write to user dir or workspace (builtin deprecated, treated as workspace)
  agentflow --help

Options:
  --workspace-root <path>  Workspace root (default: cwd)
  --dry-run                (apply only) Print ready nodes and exit without running Cursor agent
  --model <name>           Cursor CLI model (e.g. claude-sonnet). Overrides CURSOR_AGENT_MODEL. Run 'agent models' to list.
  --input <name>=<value>   (apply only) Override provide node values in flow. Prefix value with file: for file paths. Can be used multiple times.
  --debug                  Show debug logs (gray, low priority)
  --force                  Pass --force/--trust to Cursor; set OPENCODE_PERMISSION to allow external_directory for OpenCode (default: on). Use --no-force to disable.
  --parallel               Run same-round ready nodes in parallel (default: off). Multiple Cursor CLI processes may race on ~/.cursor/cli-config.json.
  --machine-readable       Emit one JSON event per line to stdout (apply-start/node-start/node-done/node-failed/apply-done/apply-paused). For UI run button: parse stdout to show current node; Cursor agent output goes to stderr.
  --lang <code>            Set language: en, zh (default: en, or auto-detect from LANG env)

Path notes:
  Primary runBuild dir: <workspaceRoot>/.workspace/agentflow/runBuild
  Legacy runBuild dir: ~/agentflow/runBuild (read-only compatibility)

Apply: builds run dir, parses flow, runs ready nodes in a loop.
  With -ai / --ai: run a single step for external (AI) multi-round control:
    agentflow apply -ai ensure-run-dir <workspaceRoot> [uuid] <flowName>
    agentflow apply -ai parse-flow <workspaceRoot> <flowName> <uuid> [flowDir]
    agentflow apply -ai get-ready-nodes <workspaceRoot> <flowName> <uuid>
    agentflow apply -ai pre-process-node <workspaceRoot> <flowName> <uuid> <instanceId>
    agentflow apply -ai post-process-node <workspaceRoot> <flowName> <uuid> <instanceId> [execId]
    agentflow apply -ai write-result <workspaceRoot> <flowName> <uuid> <instanceId> --json '<JSON>'
    agentflow apply -ai run-tool-nodejs <workspaceRoot> <flowName> <uuid> <instanceId> [execId] -- <scriptCmd> [args...]
    agentflow apply -ai get-env <workspaceRoot> <flowName> <uuid> <instanceId> <execId> <key>
    agentflow apply -ai validate-flow <workspaceRoot> <flowName> <flowDir> [uuid]
    agentflow apply -ai collect-nodes <workspaceRoot> <flowName> [runDir]
    agentflow apply -ai gc <workspaceRoot> [--list] [--dry-run] [--delete] [--keep N] [--older-than N]
    agentflow apply -ai extract-thinking <workspaceRoot> <flowName> <uuid>
Resume: marks pending and failed node(s) as success (e.g. after UserCheck confirm or retry failed), then continues apply.
Replay: runs a single node (pre-process → execute → post-process).

Requires: Node >=18, Cursor CLI ('agent') in PATH for node execution.
Apply/replay scripts are bundled in the agentflow package (bin/pipeline/).
`);
  }
}
