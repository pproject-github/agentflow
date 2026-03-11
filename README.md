# AgentFlow

CLI to drive AgentFlow apply/replay from the command line. Node execution uses Cursor CLI with streaming output (`--output-format stream-json`).

## Install

```bash
npm install
# or link for development
npm link
```

## Requirements

- **Node** >= 18
- **Cursor CLI** (`agent` in PATH) for running agent nodes. Install and log in via Cursor; the `agent` command must be available.
- Apply/replay scripts are bundled in the agentflow package (`bin/apply/`); no workspace skill copy required.
- Node executor agents (e.g. `agentflow-node-executor.md`) are bundled in `agents/`; the CLI uses them first, then falls back to workspace `.cursor/agents/` if missing.

## 命令行驱动 (CLI)

### Commands

```bash
agentflow apply <FlowName> [uuid]
agentflow replay [flowName] <uuid> <instanceId>
agentflow --help
```

- **apply** — Build run dir, parse flow, then loop: get ready nodes → for each node run pre-process → execute (Cursor agent or direct command) → post-process. Uses Cursor CLI with `--print --output-format stream-json` when executing agent nodes.
- **replay** — Run a single node: pre-process → execute → post-process. With two args: `replay <uuid> <instanceId>` (flowName resolved from run dir under `.workspace/agentflow/runBuild/<flowName>/<uuid>/`). With three args: `replay <flowName> <uuid> <instanceId>`.

### Options

- `--workspace-root <path>` — Workspace root (default: current directory).
- `--dry-run` — (apply only) Print ready nodes and exit without running Cursor agent.
- `--model <name>` — Cursor CLI model (e.g. `claude-sonnet-4`). Run `agent models` to list. Use to avoid a model that hit usage limits (e.g. Opus).

### Environment

- `CURSOR_AGENT_CMD` — Override Cursor CLI command (default: `agent`).
- `CURSOR_AGENT_MODEL` — Default Cursor model when节点未在 flow 中声明 `model` 且未通过 `--model` 覆盖时使用。
- `OPENCODE_CMD` — Override OpenCode CLI command (default: `opencode`)，当节点声明的 `model` 映射到 OpenCode 平台时使用。

### Output

When an agent node runs, the CLI spawns Cursor with `--output-format stream-json`. Assistant text and tool-call events are forwarded to stdout; success/failure is determined from the final `result` event and process exit code.

### 运行按钮与展示正在执行的节点（Run button / UI）

若在 **AIWorkspace** 或其它 UI 中提供「运行」按钮，应执行 agentflow CLI，并根据输出展示当前执行的节点：

1. **执行命令**：在工作区根目录执行  
   `agentflow apply <FlowName> [uuid]`  
   若需在 UI 中解析「当前节点」，可加上 `--machine-readable`。

2. **`--machine-readable` 模式**：  
   使用 `agentflow apply <FlowName> [uuid] --machine-readable` 时，**stdout 仅输出一行一个 JSON 的事件**，便于程序解析；Cursor 的 agent 流式输出改写到 stderr。
   - 从 **stdout** 按行读取，每行解析为 JSON，字段含 `event`、`ts`，以及事件相关字段。
   - **事件类型与展示**：
     - `apply-start`：流程开始，可展示 flowName、uuid、runDir。
     - `node-start`：开始执行某节点，可展示「正在执行：\<label\> (\<instanceId\>)」；payload 含 `instanceId`、`label`、`model` 等。
     - `node-done`：节点成功结束，含 `instanceId`、`label`、`elapsed`、`total`。
     - `node-failed`：节点失败，含 `instanceId`、`label`、`error`。
     - `apply-done`：流程全部完成，含 `runDir`、`totalElapsed`。
     - `apply-paused`：流程因 pending 暂停，含 `pendingNodes`、`resumeExample`，可提示用户执行 resume 继续。

3. **示例**：运行按钮点击后 spawn `agentflow apply myFlow --machine-readable`，对 stdout 每行 `JSON.parse(line)`，根据 `event` 更新 UI：收到 `node-start` 时显示「正在执行：\<label\>」；收到 `node-done`/`node-failed` 更新该节点状态；收到 `apply-done` 显示完成；收到 `apply-paused` 显示暂停与继续命令。

## Flow definition

See [.cursor/skills/agentflow-apply/SKILL.md](.cursor/skills/agentflow-apply/SKILL.md) for the full apply flow (Step 1–3) and parameters.
