---
name: agentflow-cli
description: Direct AgentFlow Workspace operation through a bundled token-backed CLI, without MCP. Use when Codex needs to upload temporary Workspace previews, run or inspect Workspace graphs, read graphs and display outputs through AgentFlow HTTP APIs using AGENTFLOW_TOKEN from env or .env. Default AgentFlow base URL is http://ai.mengma.bigo.inner/.
---

# AgentFlow CLI

## Resource boundary: Flow/Pipeline vs Workflow

AgentFlow has two different resource families:

- **Flow/Pipeline**: historical `flow.yaml` resources. Start/End execution and
  new Pipeline authoring are retired; only read/migration operations remain.
- **Workspace**: the active node graph backed by `workspace.flow.js` (plus layout/nodes/state sidecars).
  `workspace-preview`, `get-graph`, `run`, and display-output commands target
  this family.
- **Workflow**: a TAPD-derived product/requirement record addressed as
  `tapd:<id>`. It is not a Flow/Pipeline and must be read or changed through
  the `workflow-*` commands and the `agentflow-workflow-report` protocol.

Never infer that a Flow with a similar name is the corresponding Workflow.
Never archive, delete, disable, or replace a Flow as a way to clean up or
change Workflow data. Before any Flow write, show the exact `flowId`, source,
and destination; before any Workflow write, resolve the canonical `tapd:<id>`
reference and follow the Workflow skill's read/merge/concurrency rules.

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

For local marketplace node authoring, use the packaged AgentFlow CLI (the
node-authoring workflow is documented in `agentflow-node-authoring`):

```bash
agentflow marketplace list --json
agentflow marketplace publish-node ./my-node --json
agentflow validate MyFlow --json
```

These commands operate on the local workspace marketplace. They are usable
after any Agent CLI (Cursor, Codex, Claude Code, or OpenCode) has generated the
node package; no MCP server is required for publishing.

Publish a new local Flow after the user has reviewed it:

```bash
node skills/agentflow-cli/scripts/agentflow-cli.mjs publish-flow \
  --flow-id release-check \
  --file .workspace/agentflow/pipelines/release-check/flow.yaml \
  --target-space personal
```

Destinations are `personal`, `workspace`, and `team`. `team` creates a workspace Flow and shares it as editor with the current account's active team. Publishing is create-only by default. If the exact Flow already exists, stop and ask whether to update it; only after explicit confirmation rerun with `--replace`. Replacement first reads the server revision and submits it with the update.

Read one flow graph:

```bash
node skills/agentflow-cli/scripts/agentflow-cli.mjs get-graph --flow-id TestNodes --flow-source user
```

Migrate a flow that is still stored as `flow.yaml`. These show up in the list
but open as an empty canvas — they cannot run or be edited until migrated:

```bash
node skills/agentflow-cli/scripts/agentflow-cli.mjs migrate-flow --flow-id <id> --flow-source user
```

Lossy migration is refused by default: nodes with no Workspace equivalent
(`control_anyOne`, the two human-gate nodes, …) come back in a `dropped` list
and nothing is written. Show the user that list and get explicit confirmation
before rerunning with `--allow-loss`. The `flow.yaml` original is never deleted.

Upload a Workspace graph to a server-side temporary preview project (the
server returns a Workspace URL and cleans the project after its TTL):

```bash
node skills/agentflow-cli/scripts/agentflow-cli.mjs workspace-preview \
  --file .workspace/agentflow/pipelines/<flow-id> \
  --ttl-seconds 7200
```

This is for visual review only. It does not publish a formal Flow/Pipeline or
create schedules. The returned temporary project is hidden from the normal
Flow list and must not be treated as a durable source of truth.

Run a Workspace graph:

```bash
node skills/agentflow-cli/scripts/agentflow-cli.mjs run --flow-id TestNodes --flow-source user
```

The legacy `agentflow apply`, `/api/flow/run`, and Start/End Pipeline execution
path are retired. Do not use them for new work.

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

## Workflow reporting

The reusable transport lives in `scripts/workflow-report-client.mjs`. The CLI exposes it through `workflow-access-sync`, `workflow-get`, `workflow-report`, and `workflow-artifact-publish`; their permission model, state model, extension contract, concurrency rules, and AI procedure belong to the separate [`agentflow-workflow-report`](../agentflow-workflow-report/SKILL.md) skill. Use that skill whenever synchronizing access or reading/mutating Workflow state; do not reconstruct the protocol from this general CLI guide.

Every write requires the real business adapter `source`. Put the key-level `expectedVersions` map in the JSON file; use `absent` for a new resource key. `--expected-revision` is retained only for legacy whole-Workflow locking and should not be used by new integrations.

The only admin write exception is audited version-membership repair. Read its strict revision with
`workflow-get --runtime-only --admin-operation repair-version-membership`, then send the matching
`workflow-report --admin-operation repair-version-membership` request as defined by
`agentflow-workflow-report`. This flag does not grant general Workflow read or write access.

## Workflow

1. Check token availability with `config`.
2. Use `list-workspace` or `list-flows` to discover Flow/Pipeline targets only. Use `publish-flow` only after a local Flow has passed validation and the user has confirmed the preview.
3. Use `run` to start the flow. If the task needs the generated page/text, inspect returned `displayOutputs` or call `display-outputs`.
4. Use `status`, `list-run-by-workspace`, and `logs` when a run is active, failed, or needs debugging.

## Failure Handling

- If the CLI says the token is missing, ask the user to set `AGENTFLOW_TOKEN` in env or `.env`.
- If `publish-flow` returns 409, do not add `--replace` automatically. Ask the user to confirm updating the existing Flow.
- If team publishing says no active team is assigned, keep the local draft and ask the user to choose personal/workspace or have an admin assign the account to a team.
- If the API returns 401/403, do not retry with a printed token. Ask the user to refresh the token.
- If `run` fails because a flow is already running, call `status` and `list-run-by-workspace` before retrying.
- If local debugging is needed, override `AGENTFLOW_BASE_URL`; otherwise keep the default internal URL.
