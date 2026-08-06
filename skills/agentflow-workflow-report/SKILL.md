---
name: agentflow-workflow-report
description: Safely synchronize TAPD-derived Workflow access, then read, merge, and report AgentFlow Workflow actions, artifacts, producer-owned global state, and generic timeline projections through the AgentFlow CLI and HTTP protocol. Use when an AI agent or producer such as prd-flow needs to integrate Workflow reporting, map TAPD Owner and participants, publish progress or evidence, update globalState, assign version/sprint/milestone timeline membership, clear projections, or resolve revision and idempotency conflicts.
---

# AgentFlow Workflow Report

Treat Workflow reporting as one canonical producer-adapter protocol. The producer reports facts through `POST /api/workflows/report`; AgentFlow alone materializes and returns `snapshot`. Do not introduce producer-specific write endpoints for new integrations.

Action Checklist is a generic optional Action capability, not a prd-flow extension. Producers own the stable checklist definition through the canonical Report endpoint; AgentFlow owns per-item interactive state through `GET/PATCH /api/workflows/checklist`. Keep those two ownership domains separate so a producer refresh cannot erase user-entered status, notes, or evidence.

## Prerequisites

Use the Workflow Report client bundled with the sibling `agentflow-cli` skill. The CLI is its command-line wrapper for AI, scripts, and local verification:

```bash
node skills/agentflow-cli/scripts/agentflow-cli.mjs <command> [options]
```

If the script is unavailable, install `agentflow-cli` beside this skill. Require `AGENTFLOW_TOKEN` or `AGENTFLOW_SESSION_TOKEN`; never print either token. Use `AGENTFLOW_BASE_URL` only when overriding the default service.

Read [references/protocol.md](references/protocol.md) completely before implementing a producer, changing the report contract, constructing a payload, or answering questions about parameters, permissions, merge behavior, custom panels, and visible UI results.

## Required sequence

1. Resolve a canonical Workflow reference such as `tapd:1015046`. The report schema is producer-generic, but the current AgentFlow identity adapter accepts only the `tapd` namespace. Do not claim that arbitrary Workflow namespaces already work.
2. If the Adapter reads TAPD personnel, synchronize its authority snapshot with `POST /api/workflows/access/sync` before reporting: TAPD Owner becomes Workflow Owner and matched TAPD participants become derived Viewers. Keep this permission control-plane call separate from runtime report data.
3. Read the current materialized state and retain `snapshot.resourceVersions` for every resource key the operation will touch:

```bash
node skills/agentflow-cli/scripts/agentflow-cli.mjs workflow-get \
  --workflow tapd:1015046 \
  --runtime-only
```

4. Compute only the intended semantic update. Choose one stable lowercase `source` for the business adapter (for example `prd-flow` or `release-bot`). `agentflow-cli` is only transport and must not replace the real producer identity.
5. Preserve unrelated `globalState` fields. Never infer or rewrite a producer's private schema.
6. When timeline membership changes, derive the complete producer-owned `projections.timeline` slice. AgentFlow preserves entries owned by other sources; use `[]` to clear only the current source's memberships.
7. Put `expectedVersions` for every touched Action, Artifact, GlobalState path, Projection, Extension path, or Observation into the JSON payload. Use `"absent"` when creating a new key. Report it with a stable operation key:

```bash
node skills/agentflow-cli/scripts/agentflow-cli.mjs workflow-report \
  --workflow tapd:1015046 \
  --file workflow-report.json \
  --idempotency-key 'implementation-finished:android:issue-2:v1'
```

8. On HTTP 409, refresh only the resource keys listed in `conflict.conflicts`, recompute the intended update, and retry once with their new versions. Never send a client field named `snapshot`; use `observation.state` for a complete producer observation and treat returned `snapshot` as server output.

## Report selection

Include at least one capability:

- `observation`: report the producer's complete current observation when it computes a deterministic workflow view.
- `action`: report a stable progress or lifecycle event.
- `action.checklist`: declare stable executable items when a stage needs human or agent follow-up; cards show progress/titles and the dedicated document page shows details.
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
- Give every checklist item a stable Action-local `key`. A producer may update item titles/details, but must not report mutable item execution state inside the Action definition.
- Send a stable lowercase `source` on every report and Markdown publish; it is required. Action, idempotency, Artifact, Projection, Extension, Observation, and GlobalState ownership are isolated by source-aware resource keys.
- Give every timeline entry stable `kind` and `id` values.
- Base a timeline `id` and `key` on the scheduled business object itself. Keep platform, team, and
  other filter facets in `dimensions`; if one version/sprint/milestone spans multiple platforms,
  report one entry with a dimension array instead of creating one identity per platform.
- Treat `dimensions` as opaque facets; do not hardcode Android, iOS, version, or prd-flow fields into AgentFlow state.
- Treat `globalState` as the source of truth owned by the producer; treat projections as replaceable derived views.
- Send the complete current source-owned timeline slice whenever changing it. Omitting `projections` means no projection change.
- Use `expectedVersions` for key-level concurrency and a stable `idempotencyKey` for every logical operation. `expectedRevision` remains a whole-Workflow compatibility lock only when `expectedVersions` is absent.
- Do not include credentials, tokens, cookies, or private environment values in actions, artifacts, state, projections, or logs.

## Permissions and overwrite semantics

- Treat TAPD personnel as derived authority when the Adapter can read them: TAPD Owner maps to Workflow Owner and registered TAPD participants map to Viewer.
- Keep explicit grants separate from derived TAPD membership. Allow Owner and explicit Reporter writes. Treat TAPD participant Viewer, explicit Viewer, same-team Viewer, share-link Viewer, and ordinary admin review as read-only. The only admin write exception is an explicit audited `adminOperation=repair-version-membership` Report containing only `kind=version` timeline projections, with required `expectedRevision` and `idempotencyKey`; it must never admit Action, Artifact, Observation, GlobalState, Extension, Checklist, or non-version projection writes. Accept legacy `editor` only as a compatibility alias for Reporter.
- An admin obtaining the strict revision for that repair must explicitly read state with
  `adminOperation=repair-version-membership` (CLI: `workflow-get --runtime-only --admin-operation repair-version-membership`). The server resolves only that read as `admin-version-repair`; it does not grant ordinary admin CLI access to unrelated Workflows.
- Admin management UI must provide a concise `adminReason` for the audit event. Keep it optional for legacy CLI compatibility, but never omit it from new interactive management flows.
- `observation.state` replaces the complete previous observation for the same `clientId`.
- `globalState.patch` recursively merges objects; arrays and scalars replace; `null` and `remove` delete explicit paths. The first reporting source to write a path owns it; another source cannot overwrite an owned path.
- Reusing an `action.key` updates the same semantic stage. Do not create a new key for refreshes or retries.
- Checklist state is keyed by `checklist:<source>:<action.key>:<item.key>`. Owner/Reporter may update it through the generic Checklist API; Viewer/team/share/admin review remain read-only. Re-reporting the Action definition preserves this state.
- `projections.timeline` replaces only the current source's entries; AgentFlow preserves other sources atomically.
- `extensions` can update only `extensions[source]`; objects recursively merge, arrays/scalars replace, and `null` deletes producer-owned fields.
- Publishing Markdown creates or updates a preview Artifact and review copy; it does not confirm a document or advance an Action.

## Failure handling

- Missing token: stop and ask the user to configure `AGENTFLOW_TOKEN`.
- HTTP 401/403: stop; do not retry with a token printed in a command or answer.
- HTTP 409: inspect `workflow-resource-conflict` or `workflow-resource-ownership-conflict`, refresh the listed keys, and follow the single read-merge-retry sequence.
- HTTP 400: fix the payload against the protocol reference; do not weaken validation.
- Replayed idempotency key from the same `source`: accept `alreadyApplied: true` as success. Markdown publish returns the previously created preview instead of creating another copy.
