---
name: agentflow-workflow-report
description: Safely read, merge, and report AgentFlow Workflow actions, artifacts, producer-owned global state, and generic timeline projections through the AgentFlow CLI and HTTP protocol. Use when an AI agent or producer such as prd-flow needs to integrate Workflow reporting, publish progress or evidence, update globalState, assign version/sprint/milestone timeline membership, clear projections, or resolve revision and idempotency conflicts.
---

# AgentFlow Workflow Report

Treat Workflow reporting as a read-modify-report protocol. Keep producer business state opaque to AgentFlow and publish only generic dashboard indexes through projections.

## Prerequisites

Use the CLI bundled with the sibling `agentflow-cli` skill:

```bash
node skills/agentflow-cli/scripts/agentflow-cli.mjs <command> [options]
```

If the script is unavailable, install `agentflow-cli` beside this skill. Require `AGENTFLOW_TOKEN` or `AGENTFLOW_SESSION_TOKEN`; never print either token. Use `AGENTFLOW_BASE_URL` only when overriding the default service.

Read [references/protocol.md](references/protocol.md) completely before implementing a producer, changing the report contract, or constructing a payload beyond the quick pattern below.

## Required sequence

1. Resolve a canonical Workflow reference such as `tapd:1015046`.
2. Read the current materialized state and retain `snapshot.runtimeRevision`:

```bash
node skills/agentflow-cli/scripts/agentflow-cli.mjs workflow-get \
  --workflow tapd:1015046 \
  --runtime-only
```

3. Compute only the intended semantic update.
4. Preserve unrelated `globalState` fields. Never infer or rewrite a producer's private schema.
5. When timeline membership changes, derive the complete current `projections.timeline` array from producer state. Use `[]` to clear it.
6. Write the payload to a JSON file and report it with the retained revision and a stable operation key:

```bash
node skills/agentflow-cli/scripts/agentflow-cli.mjs workflow-report \
  --workflow tapd:1015046 \
  --file workflow-report.json \
  --expected-revision 'runtime:current-revision' \
  --idempotency-key 'implementation-finished:android:issue-2:v1'
```

7. On HTTP 409, fetch the latest state, reapply the intended semantic update, and retry once with the new revision. Never resend a stale full snapshot.

## Report selection

Include at least one capability:

- `action`: report a stable progress or lifecycle event.
- `artifacts`: attach evidence; use stable artifact keys.
- `globalState`: merge producer-owned durable state or remove explicit paths.
- `projections`: replace generic derived indexes used by AgentFlow dashboards.

Use projection-only reports when the producer state is already current and only dashboard membership needs synchronization.

## Non-negotiable rules

- Keep `schemaVersion` at `1` unless the server advertises another version.
- Give every action a stable `key`.
- Give every timeline entry stable `kind` and `id` values.
- Treat `dimensions` as opaque facets; do not hardcode Android, iOS, version, or prd-flow fields into AgentFlow state.
- Treat `globalState` as the source of truth owned by the producer; treat projections as replaceable derived views.
- Send the complete current timeline array whenever changing it. Omitting `projections` means no projection change.
- Use `expectedRevision` for state or projection changes and a stable `idempotencyKey` for every logical operation.
- Do not include credentials, tokens, cookies, or private environment values in actions, artifacts, state, projections, or logs.

## Failure handling

- Missing token: stop and ask the user to configure `AGENTFLOW_TOKEN`.
- HTTP 401/403: stop; do not retry with a token printed in a command or answer.
- HTTP 409: follow the single read-merge-retry sequence.
- HTTP 400: fix the payload against the protocol reference; do not weaken validation.
- Replayed idempotency key: accept `alreadyApplied: true` as success.

