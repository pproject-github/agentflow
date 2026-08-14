---
name: agentflow-author-flow
description: Create an AgentFlow from a user's idea, iterate in a private runnable Draft Workspace, show the preview URL, test and inspect outputs, then publish the approved graph and explicitly configure Scheduled Run activation. Use for end-to-end requests such as “创建一个流程”, “给我 Preview”, “试运行并动态修改”, “发布这个 Flow”, “配置定时运行”, “make a temporary flow”, or “run it on a schedule”.
---

# AgentFlow Flow Lifecycle

Orchestrate the complete authoring lifecycle. Use `agentflow-flow-dsl` for graph structure,
`agentflow-node-dsl` when deterministic custom code is needed, and `agentflow-cli` for Draft,
execution, publication, and schedule operations. Read those selected Skills completely before acting.

## Required lifecycle

1. Check `agentflow-cli config`. Require a token and `localRuntime.available: true`.
2. Translate the user's idea into a local `workspace.flow.js`. Search the remote node catalog before
   creating a custom node package.
3. Run DSL lint, then layout. Do not upload an invalid or unreadable graph.
4. Create a private runnable Draft:

```bash
node <agentflow-cli-skill-dir>/scripts/agentflow-cli.mjs draft-create \
  --file <flowDir> --ttl-seconds 7200
```

Add `--with-dependencies` when `<flowDir>/nodes/` exists. Return the Draft URL to the user. A Draft
is hidden from the formal Flow list, writable in the Workspace UI, and runnable. Its Scheduled Run
nodes are always suppressed and cannot trigger real Cron jobs.

5. Test the intended Run or Scheduled Run entry manually with `draft-run`. Inspect returned display
   outputs; use run status and logs for failures or long-running work. Obtain confirmation before a
   test that calls an external service or has business side effects.
6. Keep the revision returned by every Draft mutation. Apply feedback to the same Draft. If the user
   edited in the UI, pull the Draft before changing a stale local DSL:

```bash
node <agentflow-cli-skill-dir>/scripts/agentflow-cli.mjs draft-pull \
  --draft-id <draft-id> --output <flowDir> --replace
```

   Then edit locally, lint/layout again, and update against that exact revision:

```bash
node <agentflow-cli-skill-dir>/scripts/agentflow-cli.mjs draft-update \
  --draft-id <draft-id> \
  --base-revision <last-revision> \
  --file <flowDir>
```

On a revision conflict, stop and pull before reapplying the intended change; never overwrite UI
edits with a stale local graph. Repeat preview and execution until the user accepts the actual
output. Do not treat lint, Mock data, or a visual-only preview as production-equivalent acceptance.
7. Before publication, state the exact Draft ID, target Flow ID, destination, and schedule mode. Wait
   for explicit confirmation. Publication defaults to personal space and scheduling disabled.
8. Promote the exact tested Draft:

```bash
node <agentflow-cli-skill-dir>/scripts/agentflow-cli.mjs draft-publish \
  --draft-id <draft-id> \
  --flow-id <flow-id> \
  --target-space personal \
  --schedule disabled
```

Use `--schedule enabled` only when the user explicitly wants automatic execution. Promotion is
create-only; do not replace an existing Flow without a separate explicit decision.
9. When scheduling is enabled, verify the returned schedule and run `schedule-list --flow-id
   <flow-id>`. Report it as armed only when `enabled: true`, status is not invalid/error, and
   `nextRunAt` is present. Include Cron, timezone, overlap policy, and next run time in the handoff.

## Schedule changes after publication

Use `schedule-enable`, `schedule-disable`, or `schedule-set`; do not republish the whole graph merely
to flip an operational switch. Use `schedule-run-now` for a manual verification of the scheduled
entry. Re-read `schedule-list` after every mutation.

## Safety gates

- Keep read-only `workspace-preview` for sharing only. It cannot run or save; use a Draft for review
  plus execution.
- Never activate Draft schedules. Draft configuration is design data only.
- Do not embed tokens, passwords, cookies, or local absolute paths in DSL or node packages.
- Do not claim external integrations are ready from Mock execution. Require the user's real account,
  network, credentials, and downstream evidence.
- If the user requests publication but has not reviewed the Draft output, stop at the Draft and ask
  for confirmation.
