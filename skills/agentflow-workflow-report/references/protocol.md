# AgentFlow Workflow Report Protocol

## Contents

1. Contract boundary
2. Transport and authentication
3. Read endpoint
4. Report envelope
5. Action model
6. Artifact model
7. Global-state model
8. Timeline projection model
9. Concurrency and idempotency
10. Producer integration procedure
11. Examples
12. Acceptance checklist

## 1. Contract boundary

AgentFlow owns transport, validation, event persistence, materialization, permissions, optimistic concurrency, idempotency, and dashboard aggregation.

The producer owns the meaning and internal schema of `globalState`. AgentFlow must not parse private fields to infer version, sprint, release, or milestone membership.

The producer derives `projections` from its current state. Projections are replaceable indexes for generic AgentFlow views, not a second source of truth.

## 2. Transport and authentication

Default service URL:

```text
http://ai.mengma.bigo.inner/
```

Use bearer authentication through `AGENTFLOW_TOKEN` or `AGENTFLOW_SESSION_TOKEN`. For local testing only, set `AGENTFLOW_BASE_URL` to the local server URL.

Preferred transport is the bundled CLI because it resolves env files and auth headers without exposing tokens. Direct HTTP integrations may call the endpoints below with `Authorization: Bearer <token>` and `Content-Type: application/json`.

## 3. Read endpoint

CLI:

```bash
node skills/agentflow-cli/scripts/agentflow-cli.mjs workflow-get \
  --workflow tapd:1015046 \
  --runtime-only
```

HTTP:

```http
GET /api/workflows/state?workflow=tapd%3A1015046&runtimeOnly=1
```

Use the returned `snapshot.runtimeRevision` as `expectedRevision`. Read the existing `snapshot.globalState` before producing a patch and the existing `snapshot.projections.timeline` before replacing timeline membership.

The deployed server currently supports the `tapd` Workflow namespace. The reference object remains namespaced for future producers:

```json
{
  "namespace": "tapd",
  "id": "1015046"
}
```

## 4. Report envelope

Endpoint:

```http
POST /api/workflows/report
```

Top-level fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `schemaVersion` | No | Protocol version; defaults to `1` |
| `workflow` | Yes | `{ namespace, id }` or canonical key |
| `action` | Conditional | One lifecycle/progress update |
| `artifacts` | Conditional | Evidence associated with the action or global state |
| `globalState` | Conditional | Producer-owned merge patch and removals |
| `projections` | Conditional | Generic replaceable dashboard indexes |
| `expectedRevision` | For mutations | Revision returned by the latest read |
| `idempotencyKey` | Recommended | Stable identity of the logical operation |
| `source` | No | Reporting producer, default `agentflow-cli` |
| `flowId` | No | Related AgentFlow project identifier |
| `flowSource` | No | Related project source, default `user` |

Include at least one of `action`, `artifacts`, `globalState`, or `projections`.

## 5. Action model

```json
{
  "key": "implementation:android:issue-2",
  "title": "Android 实现完成",
  "detail": "Remote Config 拉取频控已实现",
  "status": "done",
  "group": "implementation",
  "scope": "remote-config-android",
  "platform": "android",
  "issueKey": "issue-2",
  "tags": ["remote-config"],
  "occurredAt": "2026-08-04T08:00:00.000Z"
}
```

`key` is required and stable. Supported normalized statuses are `pending`, `running`, `done`, `error`, `conflict`, `skipped`, `cancelled`, and `observed`. Common aliases such as `completed` and `success` normalize to `done`.

Repeated reports for the same stage may update its visible timeline entry. Use a new action key only for a semantically different action.

## 6. Artifact model

```json
{
  "key": "implementation-mr:issue-2:android",
  "type": "gitlab-mr",
  "title": "Android 实现 MR",
  "url": "https://git.example.test/group/project/-/merge_requests/123",
  "scope": "action",
  "status": "ready"
}
```

Use stable keys. `scope` is `action` or `global`. Action-scoped artifacts appear with an action; global artifacts appear in the related-artifacts area. URL and path aliases may be deduplicated, but producers must not rely on title-based identity.

## 7. Global-state model

AgentFlow defines only the update operation:

```json
{
  "mode": "merge",
  "patch": {
    "producerDefined": {
      "anySafeJsonShape": true
    }
  },
  "remove": ["obsolete.path"]
}
```

Rules:

- `mode` must be `merge`.
- `patch` recursively merges objects; arrays and scalar values replace the existing value.
- `null` removes a field during merge.
- `remove` contains dot-separated paths and is applied after the patch.
- Never send the entire state unless the producer intentionally owns and has reconciled every field.
- AgentFlow does not require Android/iOS sections or any prd-flow-specific layout.

## 8. Timeline projection model

Timeline projections give generic personal and team dashboards enough metadata to group Workflows without reading producer state:

```json
{
  "timeline": [
    {
      "kind": "version",
      "id": "android-5.63.0",
      "title": "Likee Android 5.63.0",
      "date": "2026-08-20",
      "source": "prd-flow",
      "dimensions": {
        "platform": "android"
      },
      "order": 0
    }
  ]
}
```

Fields:

| Field | Required | Meaning |
| --- | --- | --- |
| `kind` | Yes | Generic membership type, such as `version`, `release`, `sprint`, or `milestone` |
| `id` | Yes | Stable producer identity within the kind |
| `title` | No | Display title; defaults to `id` |
| `date` | No | ISO-compatible target date used for timeline sorting |
| `source` | No | Producer namespace, such as `prd-flow` |
| `dimensions` | No | Opaque grouping and filtering facets |
| `order` | No | Stable fallback ordering when dates are absent or equal |
| `key` | No | Explicit aggregate key; otherwise derived from `source`, `kind`, and `id` |

Replacement semantics:

- When `projections.timeline` is present, it is the complete current timeline membership and replaces the previous array.
- `"timeline": []` explicitly clears all membership.
- Omitting `projections` leaves the previous projection unchanged.
- Multiple entries allow one Workflow to belong to multiple generic timelines.
- Unknown `kind` and `dimensions` values remain valid and opaque.

Dashboard aggregation uses the explicit `key` when supplied; otherwise it derives one from `source + kind + id`. Invalid entries without `kind` or `id` are rejected on report.

## 9. Concurrency and idempotency

Use optimistic concurrency for every state or projection mutation:

1. Read the Workflow.
2. Retain `snapshot.runtimeRevision`.
3. Compute the semantic patch and complete derived projection.
4. Report with `expectedRevision`.
5. On 409, read again, reapply the same semantic intent, and retry once.

Do not blindly replace remote state after a conflict.

Use an idempotency key that identifies the logical operation, not the HTTP attempt:

```text
<operation>:<scope>:<entity>:<semantic-version>
```

Examples:

```text
implementation-finished:android:issue-2:v1
timeline-membership:tapd-1015046:android-5.63.0:v1
```

A replay may return `alreadyApplied: true`; treat it as successful completion.

## 10. Producer integration procedure

Implement the producer adapter in this order:

1. Define its private `globalState` schema outside AgentFlow.
2. Define a deterministic function from current producer state to the complete `projections.timeline` array.
3. Make projection identities stable across title and date changes.
4. Read the current materialized Workflow before reporting.
5. Patch only owned global-state fields.
6. Report the complete derived projection with the same operation when relevant.
7. Persist or derive a stable idempotency key.
8. Handle one revision-conflict retry.
9. Verify the returned materialized state and projection.
10. Confirm the personal and team iteration views group the Workflow correctly.

## 11. Examples

### Action, artifact, state, and timeline together

```json
{
  "schemaVersion": 1,
  "workflow": { "namespace": "tapd", "id": "1015046" },
  "source": "prd-flow",
  "action": {
    "key": "implementation:android:issue-2",
    "title": "Android 实现完成",
    "status": "done",
    "group": "implementation",
    "platform": "android",
    "issueKey": "issue-2"
  },
  "artifacts": [
    {
      "key": "implementation-mr:issue-2:android",
      "type": "gitlab-mr",
      "title": "Android 实现 MR",
      "url": "https://git.example.test/group/project/-/merge_requests/123",
      "scope": "action",
      "status": "ready"
    }
  ],
  "globalState": {
    "mode": "merge",
    "patch": {
      "prdFlowOwnedState": {
        "status": "implementing"
      }
    },
    "remove": []
  },
  "projections": {
    "timeline": [
      {
        "kind": "version",
        "id": "android-5.63.0",
        "title": "Likee Android 5.63.0",
        "date": "2026-08-20",
        "source": "prd-flow",
        "dimensions": { "platform": "android" }
      }
    ]
  },
  "expectedRevision": "runtime:replace-with-current-revision",
  "idempotencyKey": "implementation-finished:android:issue-2:v1"
}
```

### Projection-only synchronization

```json
{
  "workflow": { "namespace": "tapd", "id": "1015046" },
  "source": "prd-flow",
  "projections": {
    "timeline": [
      {
        "kind": "sprint",
        "id": "2026-w32",
        "title": "2026 第 32 周",
        "date": "2026-08-03",
        "source": "prd-flow",
        "dimensions": { "team": "client" }
      }
    ]
  },
  "expectedRevision": "runtime:replace-with-current-revision",
  "idempotencyKey": "timeline-membership:tapd-1015046:2026-w32:v1"
}
```

### Clear timeline membership

```json
{
  "workflow": { "namespace": "tapd", "id": "1015046" },
  "projections": { "timeline": [] },
  "expectedRevision": "runtime:replace-with-current-revision",
  "idempotencyKey": "timeline-membership-clear:tapd-1015046:v1"
}
```

## 12. Acceptance checklist

- The producer can read the current Workflow using only token-backed configuration.
- The producer never prints or stores the token in report data.
- Global-state changes preserve unrelated fields.
- Actions and artifacts use stable keys.
- Timeline entries use stable `kind` and `id` values.
- Timeline replacement and explicit clearing both work.
- Revision conflicts trigger one read-merge-retry cycle.
- Replaying an idempotency key does not duplicate visible state.
- Returned `snapshot.runtimeRevision` changes after a real update.
- Personal and team iteration pages show the same canonical grouping for accessible Workflows.
