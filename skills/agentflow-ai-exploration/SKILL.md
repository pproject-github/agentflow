---
name: agentflow-ai-exploration
description: Plan, visualize, audit, and archive AI execution through AgentFlow without MCP. Use when Codex or another agent needs to create a read-only expected execution graph, stream planned or actual Trace/Span events into a Workspace, perform a side-effect-safe dry-run policy check, inspect an external agent run, or materialize an approved exploration as editable workspace.flow.js DSL without running or publishing it.
---

# AgentFlow AI Exploration

Use the bundled browser-authorized CLI to turn an AI plan or live agent run into an auditable AgentFlow Trace. Resolve `<skill-dir>` as the directory containing this file:

```bash
node <skill-dir>/scripts/agentflow-ai-exploration.mjs <command> [options]
```

Do not configure MCP or install npm dependencies.

## Authorize

Check configuration first:

```bash
node <skill-dir>/scripts/agentflow-ai-exploration.mjs config
```

If `hasToken` is false, start browser authorization and return the `verificationUrl` to the user. Never ask them to paste a Token:

```bash
node <skill-dir>/scripts/agentflow-ai-exploration.mjs auth start
node <skill-dir>/scripts/agentflow-ai-exploration.mjs auth complete
```

The CLI shares the owner-only `~/.agentflow/auth.json` profile with `agentflow-cli`. Never print credentials.

## Choose the workflow

- For “先给我计划 / dry-run / 提前看看怎么执行”, generate a server Plan, inspect it, optionally run the policy check, and stop. Do not execute the task.
- For “把这次 Codex/Agent 执行可视化”, create an observed Session before work, append meaningful events as actions occur, and finish the Session at the end.
- For “把探索结果变成流程”, inspect the Trace, review side effects, then materialize it into the current Workspace adjustment state. Do not publish, run, or enable schedules.
- For read-only review, use `list` and `get`; do not create or append anything.

## Generate an expected graph

Call the read-only Plan endpoint:

```bash
node <skill-dir>/scripts/agentflow-ai-exploration.mjs plan \
  --goal "分析失败任务并生成修复步骤" \
  --flow-id <flow-id>
```

Read every planned event before reporting. Distinguish `none/read` steps from `write/external` steps and call out `requiresApproval` entries. Plan means expected behavior, never completed behavior.

To check policy without running tools:

```bash
node <skill-dir>/scripts/agentflow-ai-exploration.mjs dry-run \
  --id <session-id> \
  --flow-id <flow-id>
```

This dry-run only classifies and blocks side effects. Always say `executedTools: false`; never describe it as a sandbox execution.

## Trace an external agent run

Create one Session before acting:

```bash
node <skill-dir>/scripts/agentflow-ai-exploration.mjs create \
  --title "Codex 修复探索" \
  --goal "定位失败并形成可复用流程" \
  --flow-id <flow-id>
```

Keep the returned `exploration.id`. Append one event per meaningful decision, tool call, file change, command, or artifact. Prefer `--file` for reliable JSON:

```bash
node <skill-dir>/scripts/agentflow-ai-exploration.mjs append \
  --id <session-id> \
  --flow-id <flow-id> \
  --phase observed \
  --file /absolute/path/to/events.json
```

Use stable `spanId` and `parentSpanId` values. Mark events `running` until their outcome is known, then append the completion/error event. Do not claim success at tool start. Classify side effects conservatively:

- `none`: reasoning or local decision only
- `read`: local search, inspection, or read-only query
- `write`: files, git state, configuration, or local mutation
- `external`: HTTP writes, messages, publishing, deployment, or remote mutation

Do not emit hidden reasoning, every streamed token, complete secret-bearing inputs, or noisy low-level status. The server redacts common secrets, but omit them before upload.

Always close the Session, including failure paths:

```bash
node <skill-dir>/scripts/agentflow-ai-exploration.mjs finish \
  --id <session-id> \
  --flow-id <flow-id> \
  --status completed \
  --summary "完成定位并生成修复建议"
```

Use `--status failed` with a concise error summary when execution fails.

## Materialize reviewed Trace

First read the complete Session:

```bash
node <skill-dir>/scripts/agentflow-ai-exploration.mjs get --id <session-id> --flow-id <flow-id>
```

If materializable events include `write`, `external`, or `requiresApproval: true`, show their names and effects to the user. Pass `--approve-side-effects` only after the user explicitly approves those listed effects:

```bash
node <skill-dir>/scripts/agentflow-ai-exploration.mjs materialize \
  --id <session-id> \
  --flow-id <flow-id> \
  --approve-side-effects
```

Materialization edits the Workspace DSL adjustment state and records provenance. It does not execute, publish, replace a stable release, or activate Scheduled Run. Use `agentflow-author-flow` afterward when the user asks to test and publish the generated graph.

## Target the right Workspace

Omit `--flow-id` only when operating the server's current Workspace root. For stored flows, pass the exact `--flow-id` and `--flow-source`. Do not guess an owner or target. Admin read scope may use `--admin-owner-id`, but write endpoints still enforce Workspace permissions.

Read [references/protocol.md](references/protocol.md) when constructing custom events, integrating another Agent SDK, or diagnosing API/CLI errors.
