# AI Exploration protocol

## Commands

All commands return JSON:

```text
config
auth start | complete | status | logout
list [workspace scope]
get --id <session-id> [workspace scope]
create [--title] [--goal] [--mode observed|planned] [workspace scope]
plan --goal <text> [--model <key>] [workspace scope]
append --id <session-id> (--file <json> | --event <json> | --stdin) [--phase <phase>] [workspace scope]
finish --id <session-id> [--status completed|failed] [--summary <text>] [workspace scope]
dry-run --id <session-id> [workspace scope]
materialize --id <session-id> [--model <key>] [--approve-side-effects] [workspace scope]
```

Workspace scope options are `--flow-id`, `--flow-source`, `--admin-owner-id`, and `--archived`.

Configuration order:

1. `--base-url`, `--token`
2. `AGENTFLOW_BASE_URL`, `AGENTFLOW_TOKEN`, `AGENTFLOW_SESSION_TOKEN`
3. `AGENTFLOW_ENV_FILE`, `.env`, `.agentflow.env`, `~/.agentflow.env`
4. `~/.agentflow/auth.json`

Default server: `http://ai.mengma.bigo.inner/`.

## Trace event

An append file may be one event, an event array, or `{ "events": [...] }`:

```json
{
  "id": "read_log_complete",
  "traceId": "",
  "spanId": "read_log",
  "parentSpanId": "turn_1",
  "type": "tool",
  "name": "Read failure log",
  "summary": "Found a timeout in the delivery request",
  "status": "success",
  "sideEffect": "read",
  "requiresApproval": false,
  "startedAt": "2026-08-25T10:00:00.000Z",
  "endedAt": "2026-08-25T10:00:01.000Z",
  "inputPreview": "run-id: workspace_123",
  "outputPreview": "request timeout after 60s",
  "artifacts": [
    { "kind": "log", "path": "logs/failure.txt", "label": "Failure log" }
  ]
}
```

Allowed values:

- `phase`: `planned`, `simulated`, `observed`, `materialized`
- `type`: `run`, `turn`, `decision`, `agent`, `tool`, `command`, `file`, `artifact`, `status`
- `status`: `planned`, `running`, `success`, `error`, `blocked`, `skipped`
- `sideEffect`: `none`, `read`, `write`, `external`

The server assigns `traceId`, sequence, and timestamps when omitted. It limits a Session to 5000 events and truncates previews. `write` and `external` automatically imply approval.

For a long operation, reuse the same `spanId` across start and terminal events while giving each event a unique `id`:

```json
[
  {
    "id": "command_1_start",
    "spanId": "command_1",
    "type": "command",
    "name": "Run tests",
    "status": "running",
    "sideEffect": "read"
  },
  {
    "id": "command_1_finish",
    "spanId": "command_1",
    "type": "command",
    "name": "Run tests",
    "summary": "256 tests passed",
    "status": "success",
    "sideEffect": "read"
  }
]
```

## HTTP mapping

The bundled CLI maps to these authenticated endpoints:

| Operation | Endpoint |
| --- | --- |
| list | `GET /api/workspace/explorations` |
| get | `GET /api/workspace/exploration` |
| create | `POST /api/workspace/exploration` |
| append / finish | `POST /api/workspace/exploration/events` |
| plan | `POST /api/workspace/exploration/plan` |
| dry-run | `POST /api/workspace/exploration/dry-run` |
| materialize | `POST /api/workspace/exploration/materialize` |

Use the CLI unless integrating a runtime that cannot launch Node. Direct HTTP clients must send the same Bearer Token and Workspace scope fields.

## Semantics

- Plan uses a read-only agent configuration where the selected backend supports it and returns expected spans only.
- Dry-run is a deterministic side-effect policy check. It does not call tools.
- Observed Trace records what actually happened; it must not rewrite planned events.
- Materialization prefers planned spans when present, otherwise observed spans. Simulated events are never converted into DSL nodes.
- Materialization writes the editable adjustment state only. Stable release, execution, publication, and schedule activation remain separate operations.

## Error handling

- `401/403`: reauthorize or verify Workspace ownership; never retry with a copied credential.
- `404`: verify Session ID and the exact Workspace scope used to create it.
- `409` from materialize: inspect the returned side effects, ask for explicit approval, then rerun with `--approve-side-effects` only if approved.
- Failed Plan: inspect the returned `explorationId`; the failed Session remains available for audit.
- Failed materialization: the Session is marked failed and retains the observed error event. Do not publish the partial DSL.
