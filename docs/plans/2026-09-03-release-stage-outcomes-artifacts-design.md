# Release stage outcomes & artifacts (design)

## Problem

Operators cannot tell where a release run stopped by glancing at the timeline:

1. Completed / waiting cards only show title + timing — no summary, no MR/links.
2. Artifacts and conclusions live only inside the Inspector, and only if `output`/`details` were persisted.
3. `reconcileReleaseState` treats Workspace run-manifest `completed` as release-node completion. Agent `waiting` (e.g. MR still open) can be written as an empty timeline `completed` with no `output`/`details`. Same `nodeId` then shadows the real waiting pending card on the client.

## Decision (option C)

**Both surfaces:**

| Surface | Role |
|---------|------|
| Timeline / pending card | One-glance: status, ≤2-line summary, up to 3 artifact chips (+N), waiting reason + link |
| Inspector | Full Markdown summary, full artifact list, steps, records, waiting block; hydrate from `runs[runId]` when the card itself is empty |

## Persistence rules

1. Agent result status (`waiting` / `failed` / `completed`) is authoritative — never promote to empty timeline completed solely because the Workspace manifest finished successfully.
2. `reconcileReleaseState`: if `runs[runId]` already has terminal Agent status (especially `waiting`) with summary/artifacts, keep pending waiting and do not overwrite with empty completed.
3. Client merge must not drop waiting pending solely because a hollow completed timeline entry exists for the same `nodeId` when runs say waiting — hydrate from runs and prefer waiting.
4. Historical empty completed: on load/sync, if timeline entry lacks summary and `runs[runId]` has data, hydrate for display.

## Success criteria

- After a localization download that opens an MR, the card shows waiting + MR chip + short summary without opening Inspector.
- Inspector for the same item shows full conclusion and artifact list.
- Force-run style race no longer produces empty completed that hides waiting.
