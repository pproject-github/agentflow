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
- Workspace must contain `.cursor/skills/agentflow-apply/` (this repo or a workspace that includes it).

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
- `CURSOR_AGENT_MODEL` — Force one Cursor model for all nodes; overridden by `--model`.
- `CURSOR_AGENT_MODEL_<modelType>` — Override Cursor model per node modelType (e.g. `CURSOR_AGENT_MODEL_规划=claude-sonnet-4`). modelType comes from the flow (Auto / 规划 / Code / 前端). If unset, the CLI uses an internal mapping (see `MODEL_TYPE_TO_CURSOR_MODEL` in `bin/agentflow.mjs`); set to a non-Opus model to avoid usage limits.

### Output

When an agent node runs, the CLI spawns Cursor with `--output-format stream-json`. Assistant text and tool-call events are forwarded to stdout; success/failure is determined from the final `result` event and process exit code.

## Flow definition

See [.cursor/skills/agentflow-apply/SKILL.md](.cursor/skills/agentflow-apply/SKILL.md) for the full apply flow (Step 1–3) and parameters.
