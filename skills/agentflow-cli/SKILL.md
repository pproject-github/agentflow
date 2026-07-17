---
name: agentflow-cli
description: Direct AgentFlow platform operation through a bundled token-backed CLI, without MCP. Use when Codex needs to list AgentFlow workspaces or flows, start a flow run, inspect run status/logs, or fetch display outputs through AgentFlow HTTP APIs using AGENTFLOW_TOKEN from env or .env. Default AgentFlow base URL is http://ai.mengma.bigo.inner/.
---

# AgentFlow CLI

Use this skill when the task is to operate AgentFlow itself from an AI agent. Do not configure or call MCP for this skill. Use the bundled CLI script instead:

```bash
node skills/agentflow-cli/scripts/agentflow-cli.mjs <command> [options]
```

If the skill is installed outside this repository, resolve the script path relative to this `SKILL.md`.

## Installation

Install from SkillHub before using this skill in another agent environment:

```bash
skillhub install agentflow-cli --global --agent codex
```

For a project-local install:

```bash
skillhub install agentflow-cli --dir .agents/skills
```

For other SkillHub-supported agents, change the agent name:

```bash
skillhub install agentflow-cli --global --agent claude-code
```

After installation, configure only the direct API token. Do not add an MCP server for this skill.

## Configuration

The CLI reads configuration in this order:

1. CLI flags: `--base-url`, `--token`
2. Environment variables: `AGENTFLOW_BASE_URL`, `AGENTFLOW_TOKEN`, `AGENTFLOW_SESSION_TOKEN`
3. Env files: `AGENTFLOW_ENV_FILE`, then `.env`, `.agentflow.env`, then `~/.agentflow.env`

Default base URL: `http://ai.mengma.bigo.inner/`.

Required token: `AGENTFLOW_TOKEN` or `AGENTFLOW_SESSION_TOKEN`. Never print the token in the final answer or logs.

Example `.env`:

```dotenv
AGENTFLOW_TOKEN=replace-with-token
# Optional for local debug only:
# AGENTFLOW_BASE_URL=http://127.0.0.1:8875
```

## Commands

Prefer JSON output and let the CLI handle auth headers.

List knowledge/workspace entries:

```bash
node skills/agentflow-cli/scripts/agentflow-cli.mjs list-workspace
```

List flows:

```bash
node skills/agentflow-cli/scripts/agentflow-cli.mjs list-flows
```

Read one flow graph:

```bash
node skills/agentflow-cli/scripts/agentflow-cli.mjs get-graph --flow-id TestNodes --flow-source user
```

Run a flow:

```bash
node skills/agentflow-cli/scripts/agentflow-cli.mjs run --flow-id TestNodes --flow-source user
```

Run a specific run node with inputs:

```bash
node skills/agentflow-cli/scripts/agentflow-cli.mjs run \
  --flow-id TestNodes \
  --flow-source user \
  --run-node-id workspace_run_1 \
  --input topic=hello \
  --input date=today
```

List runs for a flow or workspace alias:

```bash
node skills/agentflow-cli/scripts/agentflow-cli.mjs list-run-by-workspace --workspace TestNodes --limit 20
```

Read run logs:

```bash
node skills/agentflow-cli/scripts/agentflow-cli.mjs logs --run-id workspace-123
```

Get active run status:

```bash
node skills/agentflow-cli/scripts/agentflow-cli.mjs status --flow-id TestNodes --flow-source user
```

Extract display outputs from a flow:

```bash
node skills/agentflow-cli/scripts/agentflow-cli.mjs display-outputs --flow-id TestNodes --flow-source user
```

## Workflow

1. Check token availability with `config`.
2. Use `list-workspace` or `list-flows` to discover targets.
3. Use `run` to start the flow. If the task needs the generated page/text, inspect returned `displayOutputs` or call `display-outputs`.
4. Use `status`, `list-run-by-workspace`, and `logs` when a run is active, failed, or needs debugging.

## Failure Handling

- If the CLI says the token is missing, ask the user to set `AGENTFLOW_TOKEN` in env or `.env`.
- If the API returns 401/403, do not retry with a printed token. Ask the user to refresh the token.
- If `run` fails because a flow is already running, call `status` and `list-run-by-workspace` before retrying.
- If local debugging is needed, override `AGENTFLOW_BASE_URL`; otherwise keep the default internal URL.
