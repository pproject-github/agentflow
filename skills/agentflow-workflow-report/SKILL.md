---
name: agentflow-workflow-report
description: Safely read, merge, and report AgentFlow Workflow actions, artifacts, producer-owned global state, and generic timeline projections through the AgentFlow CLI and HTTP protocol. Use when an AI agent or producer such as prd-flow needs to integrate Workflow reporting, publish progress or evidence, update globalState, assign version/sprint/milestone timeline membership, clear projections, or resolve revision and idempotency conflicts.
---

# AgentFlow Workflow Report

Treat Workflow reporting as one canonical producer-adapter protocol. The producer reports facts through `POST /api/workflows/report`; AgentFlow alone materializes and returns `snapshot`. Do not introduce producer-specific write endpoints for new integrations.

## Prerequisites

Use the Workflow Report client bundled with the sibling `agentflow-cli` skill. The CLI is its command-line wrapper for AI, scripts, and local verification:

```bash
node skills/agentflow-cli/scripts/agentflow-cli.mjs <command> [options]
```

If the script is unavailable, install `agentflow-cli` beside this skill. Require `AGENTFLOW_TOKEN` or `AGENTFLOW_SESSION_TOKEN`; never print either token. Use `AGENTFLOW_BASE_URL` only when overriding the default service.

Read [references/protocol.md](references/protocol.md) completely before implementing a producer, changing the report contract, constructing a payload, or answering questions about parameters, permissions, merge behavior, custom panels, and visible UI results.

## Required sequence

1. Resolve a canonical Workflow reference such as `tapd:1015046`. The report schema is producer-generic, but the current AgentFlow identity adapter accepts only the `tapd` namespace. Do not claim that arbitrary Workflow namespaces already work.
2. Read the current materialized state and retain `snapshot.runtimeRevision`:

```bash
node skills/agentflow-cli/scripts/agentflow-cli.mjs workflow-get \
  --workflow tapd:1015046 \
  --runtime-only
```

3. Compute only the intended semantic update. Choose one stable lowercase `source` for the business adapter (for example `prd-flow` or `release-bot`). `agentflow-cli` is only transport and must not replace the real producer identity.
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

7. On HTTP 409, fetch the latest state, reapply the intended semantic update, and retry once with the new revision. Never send a client field named `snapshot`; use `observation.state` for a complete producer observation and treat returned `snapshot` as server output.

## Report selection

Include at least one capability:

- `observation`: report the producer's complete current observation when it computes a deterministic workflow view.
- `action`: report a stable progress or lifecycle event.
- `artifacts`: attach evidence; use stable artifact keys.
- `globalState`: merge producer-owned durable state or remove explicit paths.
- `projections`: replace generic derived indexes used by AgentFlow dashboards.
- `extensions`: report namespaced data for a registered specialized renderer, such as `extensions["prd-flow"].issues`.

Map data to the visible page deliberately:

- Global area: `observation.state`, incremental producer facts in `globalState`, and iteration membership in `projections.timeline`.
- Action timeline: stable `action.key` plus Action-scoped `artifacts`.
- Generic custom cards: use `globalState.sections` with built-in `text`, `user`, `chips`, `list`, and `link` field renderers.
- Specialized custom area: use namespaced `extensions` only when built-in renderers cannot express the layout. Saving an extension does not create a UI by itself; currently only `extensions["prd-flow"]` has a registered AI Docs / Issues renderer.

Use projection-only reports when the producer state is already current and only dashboard membership needs synchronization.

For local Markdown or other content that must become a browser URL, publish it first with `workflow-artifact-publish` (`POST /api/workflow-artifacts/publish`), then use the returned Artifact in the same Workflow. Do not use `/api/prd-workflow/review-link` for new integrations.

## Non-negotiable rules

- Keep `schemaVersion` at `1` unless the server advertises another version.
- Keep the runtime chain singular: producer adapter → Workflow Report client → AgentFlow. The Skill is guidance, not a transport hop.
- Give every action a stable `key`.
- Send a stable lowercase `source` on every report and Markdown publish. Action, idempotency, and Artifact identities are isolated by `source + key`; `globalState` and the complete timeline remain shared read-merge-write regions.
- Give every timeline entry stable `kind` and `id` values.
- Treat `dimensions` as opaque facets; do not hardcode Android, iOS, version, or prd-flow fields into AgentFlow state.
- Treat `globalState` as the source of truth owned by the producer; treat projections as replaceable derived views.
- Send the complete current timeline array whenever changing it. Omitting `projections` means no projection change.
- Use `expectedRevision` for state or projection changes and a stable `idempotencyKey` for every logical operation.
- Do not include credentials, tokens, cookies, or private environment values in actions, artifacts, state, projections, or logs.

## Permissions and overwrite semantics

- Treat the first authenticated reporter as owner when the Workflow has no collaboration record.
- Allow owner and explicit editor writes. Treat explicit viewer, same-team viewer, share-link viewer, and admin review as read-only.
- `observation.state` replaces the complete previous observation for the same `clientId`.
- `globalState.patch` recursively merges objects; arrays and scalars replace; `null` and `remove` delete explicit paths.
- Reusing an `action.key` updates the same semantic stage. Do not create a new key for refreshes or retries.
- `projections.timeline` replaces the complete array. Read first and preserve entries outside the producer's ownership.
- `extensions` recursively merge within valid namespaces; arrays and scalars replace, and `null` deletes producer-owned fields.
- Publishing Markdown creates or updates a preview Artifact and review copy; it does not confirm a document or advance an Action.

## Failure handling

- Missing token: stop and ask the user to configure `AGENTFLOW_TOKEN`.
- HTTP 401/403: stop; do not retry with a token printed in a command or answer.
- HTTP 409: follow the single read-merge-retry sequence.
- HTTP 400: fix the payload against the protocol reference; do not weaken validation.
- Replayed idempotency key from the same `source`: accept `alreadyApplied: true` as success. Markdown publish returns the previously created preview instead of creating another copy.
