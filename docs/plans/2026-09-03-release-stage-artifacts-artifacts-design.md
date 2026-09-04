# Release stage outcomes & artifacts (design)

## Problem

Operators cannot tell where a release run stopped by glancing at the timeline:

1. Completed / waiting cards only show title + timing — no summary, no MR/links.
2. Artifacts and conclusions live only inside the Inspector, and only if `output`/`details` were persisted.
3. `reconcileReleaseState` treats Workspace run-manifest `completed` as release-node completion. Agent `waiting` (e.g. MR still open) can be written as an empty timeline `completed` with no `output`/`details`. Same `nodeId` then shadows the real waiting pending card on the client.

Evidence: force run `release-force-31373838-c72b9dfa` (14:54) has full waiting summary + MR !1142 in `runs[...]`, but timeline shows empty completed.

## Decision (option C)

**Both surfaces:**

| Surface | Role |
|---------|------|
| Timeline card | One-glance: status badge, ≤2-line summary, up to 3 artifact chips (+N), waiting reason + link |
| Inspector | Full Markdown summary, full artifact list, steps, records, waiting block; hydrate from `runs[runId]` when the card itself is empty |

## Persistence rules

1. Agent result status (`waiting` / `failed` / `completed`) is authoritative — never promote to empty timeline completed solely because the Workspace manifest finished successfully.
2. `reconcileReleaseState`: if `runs[runId]` already has terminal Agent status (especially `waiting`) with summary/artifacts, keep pending waiting and do not overwrite with empty completed. If pending is still `running` but runs already terminal, backfill from runs (output, details, waiting).
3. Client merge must not drop waiting pending solely because a hollow completed timeline entry exists for the same `nodeId` when runs say waiting — prefer runs hydrate or remove hollow completed.
4. Historical empty completed: on load/sync, if timeline entry lacks summary and `runs[runId]` has data, hydrate for display (memory first; optional persist later).

## Card UI rules

- Status: `已完成` / `等待中` / `失败` (waiting must not look like completed).
- Summary: from `output.summary` or `details.summary`; truncate to 2 lines; “查看详情” opens Inspector.
- Chips: prefer MR (`!iid` + state) with URL; then notification/branch links; max 3 + `+N`.
- Waiting: show readable reason + link `waiting.operator_url` when present.
- No summary and no artifacts: keep current minimal card (no empty chrome).

## Inspector UI rules

1. Hero: full Markdown conclusion (no truncation).
2. Artifacts section visible for both completed and waiting (not completed-only).
3. Steps → records → waiting → meta.
4. On open, if item lacks output but `runs[runId]` (or remote state) has it → hydrate before render.

## Out of scope

- Changing Skill/Agent output schema beyond using existing `summary` / `artifacts` / `waiting`.
- Rewriting all historical state files on disk (display hydrate is enough for v1).
- New side-rail progress chrome (rejected approach 3).

## Success criteria

- After a localization download that opens an MR, the card shows waiting + MR chip + short summary without opening Inspector.
- Inspector for the same item shows full conclusion and artifact list.
- Force-run style race no longer produces empty completed that hides waiting.
