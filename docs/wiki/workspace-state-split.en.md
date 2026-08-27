# Splitting design state from runtime state

A Workspace graph keeps design state and runtime state in separate files:

```
workspace.flow.js      design: nodes, edges, authored content (see flow-dsl.en.md)
workspace.layout.json  design: positions, sizes, pin visibility
workspace.state.json   runtime: in/out slot results, display run output, viewport
```

This page is only about **where the boundary is**; for the format of the design files see
[flow-dsl.en.md](flow-dsl.en.md).

## Why

In the real corpus, run output accounts for **33.6%** of the bytes — 465 KB out of 1.38 MB
across 21 production flows, all of it churning on every run. Keeping it in one file has
three consequences:

- diffs are pure noise; you cannot see what changed structurally
- an AI-generated graph cannot be compared against one that has been run
- exporting or sharing a flow drags the last run's output along with it

## This is a storage-layer change only

`readWorkspaceGraph()` merges the two files and returns a graph **semantically identical**
to the pre-split one. Everything above it — `workspaceDesignRevision`, collaboration merge,
the web UI — sees no difference. The only change is the key position of `value` / `default`
inside slot objects: the merge appends them at the end.

**There is no migration step.** An old graph whose runtime state is still inline in
`graph.json` has no state file, so the merge is the identity — it reads normally and gets
split on the next write.

## One definition, three consumers

`workspaceRuntimeSurface()` is the single answer to "what counts as runtime state", shared by
the storage split, the three-way merge, and the revision:

| Consumer | What it needs it for |
|----------|----------------------|
| `splitWorkspaceGraph` | which values go into `workspace.state.json` |
| `isRuntimePath` in `mergeWorkspaceGraphs` | when both sides touched the same spot: conflict, or just take theirs |
| `workspaceDesignRevision` | whether "the graph changed" — this value *is* the collaboration baseline |

They have to agree, or you get bugs that are very hard to see. `isRuntimePath` used to carry
its own copy covering only output values and `displayReloadKey`, missing edge-driven input
values and display bodies. The results:

- **one run bumped `designRevision`**, invalidating every collaborator's baseline even though
  nobody edited the graph
- two people each running the flow turned the same output slot into a **field conflict**, a
  dialog asking a human to pick between two values that a re-run would regenerate

## What counts as runtime state

Same definition as `isRuntimePath` in `workspace-graph-merge.mjs`:

| Content | Goes to | Note |
|---------|---------|------|
| `output[*].value` / `.default` on non-provide nodes | state | provide outputs are user-entered, so they are design |
| `input[*].value` / `.default` on a slot **with a non-semantic incoming edge** | state | overwritten by the upstream on every run |
| `input[*].value` on a context-injection slot | state | `skillsContext` / `mcpContext` / `knowledgeContext` / `workspaceContext` / `gitContext`, edge or no edge |
| `input[*].value` on a slot with no incoming edge | **design** | an author-entered default |
| `displayReloadKey` | state | |
| `ui.viewport` | state | `ui.nodePositions` stays in design |
| `body` of a display node **with a content input edge** | state | |
| `body` of a display node **without** one | **design** | authored documentation |

The rows that turn on "does it have an incoming edge" are the ones that require looking at
graph structure. The corpus contains **29** display nodes with no content input edge — their
`body` is authored documentation (64 KB). Treating those as runtime state deletes them.

The predicate mirrors ui-server's `workspaceContentInputEdge` exactly: collect incoming
edges, drop the ones targeting semantic slots (`type: node`, `prev`/`next`/`skillsContext`/
`mcpContext`/`knowledgeContext`/`workspaceContext`/`gitContext`); any edge left means that
slot's value is run output.

Context-injection slots get their own row because the runtime always fills them in — the
corpus has a 15 KB HTML body copied into `workspaceContext`, which is plainly not an
author-entered default.

**Approximating this with `targetHandle !== "input-0"` is wrong** — 32 instances in the
corpus have non-canonical slot order, so `input-0` is not necessarily `prev`.

## Write order and failure handling

`workspace.state.json` is written first, then the design files, all via
write-temp-then-rename. If the process dies in between, the design file is still the
previous version — you never get "new design + empty runtime state", which would make
display content vanish.

If `workspace.state.json` fails to parse it is treated as absent and the graph still opens.
Run output is regenerable; the design is not.

## Fixed along the way

Four sites used to call `fs.writeFileSync(graphPath, ...)` directly, bypassing the atomic
write (display share, schedule toggle, post-run writeback, preview upload). All now go
through `writeWorkspaceGraph`, which gets them both the split and atomicity.

## Tests

`test/workspace-state-split.test.mjs`, including a property test over 200 deterministic
random graphs (identity + idempotence + design contains no run output). The real corpus
contains internal business content and is not vendored; the random graphs cover the same
shape space (non-canonical slot order, duplicate output slot names, missing bodies).
