---
name: agentflow-cli
description: Direct AgentFlow operation through a bundled token-backed CLI, without MCP. Use when Codex needs to search, publish, install, or synchronize versioned node packages; pull or publish portable Workspace DSL flows; upload previews; run or inspect Workspace graphs; or read logs and display outputs through AgentFlow HTTP APIs using AGENTFLOW_TOKEN from env or .env.
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

Use this skill when the task is to operate AgentFlow itself from an AI agent. Do not configure or call MCP for this skill. Resolve `<skill-dir>` as the directory containing this `SKILL.md`, then use the bundled CLI script:

```bash
node <skill-dir>/scripts/agentflow-cli.mjs <command> [options]
```

Never assume the current project contains `skills/agentflow-cli`.

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

Install or update the `@fieldwangai/agentflow` CLI as the local runtime and keep `agentflow` on
`PATH`. The bundled skill intentionally does not copy AgentFlow's parser/runtime modules. It locates
the runtime from an explicit `--agentflow-package-root`, `AGENTFLOW_PACKAGE_ROOT`, the current
project's `node_modules`, or the `agentflow` executable on `PATH`.

Verify both token and runtime discovery before local DSL or node-package work:

```bash
node <skill-dir>/scripts/agentflow-cli.mjs config
```

Require `localRuntime.available: true`. Pure remote reporting commands can still run without a local
runtime, but package creation, installation, Flow pull/publish, and Workspace graph parsing cannot.

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
node <skill-dir>/scripts/agentflow-cli.mjs list-workspace
```

List flows:

```bash
node <skill-dir>/scripts/agentflow-cli.mjs list-flows
```

For a package used only in the current local checkout, use the packaged AgentFlow CLI (the
Node DSL workflow is documented in `agentflow-node-dsl`):

```bash
agentflow marketplace list --json
agentflow marketplace publish-node ./my-node --json
agentflow validate MyFlow --json
```

These commands copy a package only into the current workspace marketplace.

To distribute a complete package directory (including `scripts/`, `templates/`, or assets) through
an AgentFlow server, use the token-backed commands. The CLI packs the directory as ZIP; `index.mjs`
must be at the package root. The server validates all paths/files and keeps each `id@version`
immutable:

```bash
node <skill-dir>/scripts/agentflow-cli.mjs node-package-publish --file ./my-node
node <skill-dir>/scripts/agentflow-cli.mjs node-package-list
node <skill-dir>/scripts/agentflow-cli.mjs node-package-install \
  --node my_node@1.0.0 \
  --workspace-root "$PWD"
```

Before authoring a new code node, search the remote catalog. The result is structured JSON with the
exact import specifier, input/output slots, content hash, and install hint:

```bash
node <skill-dir>/scripts/agentflow-cli.mjs node-package-search --query "read csv"
```

Prefer an existing suitable exact version. Install it and import its returned `specifier`; create a
new local package only when no result meets the requested behavior.

When a Flow already declares its dependencies, do not install packages one by one. Synchronize the
whole Flow from its versioned imports:

```bash
node <skill-dir>/scripts/agentflow-cli.mjs node-package-sync \
  --flow .workspace/agentflow/pipelines/<flow-id> \
  --workspace-root "$PWD"
```

The command reports `installed`, `unchanged`, `missing`, and `conflicts`. It downloads and verifies
every required ZIP before writing any package, records the server and hashes in each installed
package's metadata, and exits with code 2 when dependencies cannot be satisfied.

After installation, local AI can author a portable DSL reference directly in `workspace.flow.js`:

```js
import myNode from "marketplace:my_node@1.0.0";
const result = myNode("My node", { input: "value" });
```

Run `agentflow flow dsl lint <flowDir>` with that workspace as the current project before publishing
the flow. `publish-flow` also checks that the server contains every exact imported version before it
writes the Flow. Do not unpack ZIPs by hand or copy only `index.mjs`; relative package files are part
of the node's versioned content.

Publish a new local Flow after the user has reviewed it:

```bash
node <skill-dir>/scripts/agentflow-cli.mjs publish-flow \
  --flow-id release-check \
  --file .workspace/agentflow/pipelines/release-check/flow.yaml \
  --target-space personal
```

When the reviewed code Flow contains `nodes/`, publish the Flow and all complete package directories
in one operation:

```bash
node <skill-dir>/scripts/agentflow-cli.mjs publish-flow \
  --flow-id release-check \
  --file .workspace/agentflow/pipelines/release-check \
  --target-space personal \
  --with-dependencies
```

This validates every package before any upload, rejects same-version content conflicts, uploads ZIPs,
and rewrites relative node imports only in the upload payload. It never edits local
`workspace.flow.js`. Without `--with-dependencies`, `publish-flow` continues to reject Flow directories
that contain `nodes/` or `workspace.nodes.json` rather than silently dropping them.

Destinations are `personal`, `workspace`, and `team`. `team` creates a workspace Flow and shares it as editor with the current account's active team. Publishing is create-only by default. If the exact Flow already exists, stop and ask whether to update it; only after explicit confirmation rerun with `--replace`. Replacement first reads the server revision and submits it with the update.

Read one flow graph:

```bash
node <skill-dir>/scripts/agentflow-cli.mjs get-graph --flow-id TestNodes --flow-source user
```

To make a server Flow locally editable, pull it instead of copying graph JSON. Pull synchronizes and
verifies all exact node-package dependencies first, removes remote runtime state, then writes the
canonical local DSL:

```bash
node <skill-dir>/scripts/agentflow-cli.mjs pull-flow \
  --flow-id TestNodes \
  --flow-source user \
  --workspace-root "$PWD"
```

The default target is `.workspace/agentflow/pipelines/<flow-id>`. A non-empty target is refused; use
`--replace` only after the user has explicitly approved updating its managed Flow files.

The AgentFlow server automatically performs all lossless storage migrations before it starts
listening. Use the following commands only to inspect or repair an older deployment, or to resolve a
Flow listed in the server's `storage-migrations.json` report.

Migrate one flow that is still stored as `flow.yaml`:

```bash
node <skill-dir>/scripts/agentflow-cli.mjs migrate-flow --flow-id <id> --flow-source user
```

Lossy migration is refused by default: nodes with no Workspace equivalent
(`control_anyOne`, the two human-gate nodes, …) come back in a `dropped` list
and nothing is written. Show the user that list and get explicit confirmation
before rerunning with `--allow-loss`. The `flow.yaml` original is never deleted.

Manually rescan everything visible to the current account (does the lossless ones, reports the rest):

```bash
node <skill-dir>/scripts/agentflow-cli.mjs migrate-all --dry-run
node <skill-dir>/scripts/agentflow-cli.mjs migrate-all
```

Read `needsDecision` and `skipped` in the output before telling the user it is
done — read-only catalogs (`builtin`, `admin`) and archived flows are skipped
unless `--include-archived` is passed.

Upload a Workspace graph to a server-side temporary preview project (the
server returns a Workspace URL and cleans the project after its TTL):

```bash
node <skill-dir>/scripts/agentflow-cli.mjs workspace-preview \
  --file .workspace/agentflow/pipelines/<flow-id> \
  --ttl-seconds 7200
```

This is for visual review only. It does not publish a formal Flow/Pipeline or
create schedules. The returned temporary project is hidden from the normal
Flow list and must not be treated as a durable source of truth.

Run a Workspace graph:

```bash
node <skill-dir>/scripts/agentflow-cli.mjs run --flow-id TestNodes --flow-source user
```

The legacy `agentflow apply`, `/api/flow/run`, and Start/End Pipeline execution
path are retired. Do not use them for new work.

Run a specific run node with inputs:

```bash
node <skill-dir>/scripts/agentflow-cli.mjs run \
  --flow-id TestNodes \
  --flow-source user \
  --run-node-id workspace_run_1 \
  --input topic=hello \
  --input date=today
```

List runs for a flow or workspace alias:

```bash
node <skill-dir>/scripts/agentflow-cli.mjs list-run-by-workspace --workspace TestNodes --limit 20
```

Read run logs:

```bash
node <skill-dir>/scripts/agentflow-cli.mjs logs --run-id workspace-123
```

Get active run status:

```bash
node <skill-dir>/scripts/agentflow-cli.mjs status --flow-id TestNodes --flow-source user
```

Extract display outputs from a flow:

```bash
node <skill-dir>/scripts/agentflow-cli.mjs display-outputs --flow-id TestNodes --flow-source user
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
2. Use `list-workspace` or `list-flows` to discover Flow/Pipeline targets only. Use `node-package-search` before creating a new code node. Use `publish-flow` only after a local Flow has passed validation and the user has confirmed the preview.
3. Use `run` to start the flow. If the task needs the generated page/text, inspect returned `displayOutputs` or call `display-outputs`.
4. Use `status`, `list-run-by-workspace`, and `logs` when a run is active, failed, or needs debugging.

## Failure Handling

- If the CLI says the token is missing, ask the user to set `AGENTFLOW_TOKEN` in env or `.env`.
- If `publish-flow` returns 409, do not add `--replace` automatically. Ask the user to confirm updating the existing Flow.
- If team publishing says no active team is assigned, keep the local draft and ask the user to choose personal/workspace or have an admin assign the account to a team.
- If the API returns 401/403, do not retry with a printed token. Ask the user to refresh the token.
- If `run` fails because a flow is already running, call `status` and `list-run-by-workspace` before retrying.
- If local debugging is needed, override `AGENTFLOW_BASE_URL`; otherwise keep the default internal URL.
