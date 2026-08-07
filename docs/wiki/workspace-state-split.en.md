# Splitting design state from runtime state

A Workspace graph is now stored as two files:

```
workspace.graph.json   design: nodes, edges, positions, authored content
workspace.state.json   runtime: output slot results, display run output, viewport
```

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

## What counts as runtime state

Same definition as `isRuntimePath` in `workspace-graph-merge.mjs`:

| Content | Goes to | Note |
|---------|---------|------|
| `output[*].value` / `.default` on non-provide nodes | state | provide outputs are user-entered, so they are design |
| `displayReloadKey` | state | |
| `ui.viewport` | state | `ui.nodePositions` stays in design |
| `body` of a display node **with a content input edge** | state | |
| `body` of a display node **without** one | **design** | authored documentation |

The last two rows are the only ones that require looking at graph structure. The corpus
contains **29** display nodes with no content input edge — their `body` is authored
documentation (64 KB). Treating those as runtime state deletes them.

The predicate mirrors ui-server's `workspaceContentInputEdge` exactly: collect incoming
edges, drop the ones targeting semantic slots (`type: node`, `prev`/`next`/`skillsContext`/
`mcpContext`/`knowledgeContext`/`workspaceContext`/`gitContext`); any edge left means `body`
is run output.

**Approximating this with `targetHandle !== "input-0"` is wrong** — 32 instances in the
corpus have non-canonical slot order, so `input-0` is not necessarily `prev`.

## Write order and failure handling

`workspace.state.json` is written first, then `workspace.graph.json`, both via
write-temp-then-rename. If the process dies in between, the design file is still the
previous version — you never get "new design + empty runtime state", which would make
display content vanish.

If `workspace.state.json` fails to parse it is treated as absent and the graph still opens.
Run output is regenerable; the design is not.

## Fixed along the way

Four sites used to call `fs.writeFileSync(graphPath, ...)` directly, bypassing the atomic
write (display share, schedule toggle, post-run writeback, preview upload). All now go
through `writeWorkspaceGraphAtomic`, which gets them both the split and atomicity.

## Tests

`test/workspace-state-split.test.mjs`, including a property test over 200 deterministic
random graphs (identity + idempotence + design contains no run output). The real corpus
contains internal business content and is not vendored; the random graphs cover the same
shape space (non-canonical slot order, duplicate output slot names, missing bodies).
