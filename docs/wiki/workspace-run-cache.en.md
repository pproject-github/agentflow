# Run cache: from "it has a value" to fingerprints

## Symptom

```
a's script is echo one  → run → b receives 'one'
change a to echo two    → run → a does not run at all, b still receives 'one'
```

This only affects nodes that are **not on the control chain** and get pulled into the plan by
a data edge. `flow("Run", b)` contains only `b`; `a` is pulled in by the `${got}` placeholder
in `b`'s body.

After the first run `a.result` holds a value, and from then on the check always hits — it only
asks whether the slot has a value, never whether `a` itself changed.

In the builtin templates:

| Flow | Data-edge upstream | Edit it, then press ② |
|---|---|---|
| `new` / buildRun | `skills`, `plan` | edit the planning prompt → still implements the old plan |
| `module-migrate` / migrateRun | `scope` | edit the scoping prompt → still migrates the old list |

The only escape was deleting files under `outputs/<node>/` by hand.

## Not a problem with the human gate

`flow.resume` is correct. Pressing ② *should not* re-run `plan` — ② means "implement the plan I
confirmed". To re-plan you press ①, where `plan` sits on the control chain and always runs.
Verified end to end: the confirmed value is not overwritten.

## The rule: add a fingerprint

A cache hit now requires the slot to have a value **and** the fingerprint of this set of inputs
to match what was recorded on the last successful execution.

```
fp(node) = sha256(
  definitionId, body, scriptRef, marketplaceRef, script, model,
  per input slot:  connected  → `name<=source.slot:fp(source)`
                   unconnected → `name=literal`
)
```

**Upstream contributes its fingerprint, not its value.** Two payoffs: no need to hash large
files, and a change upstream automatically changes everything downstream — dirty propagation is
computed, not written a second time.

### Three things stay out

- **Output slot values.** The fingerprint describes inputs, not products. An agent node returns
  something different each run given identical inputs; folding the product in would mean never
  hitting.
- **`script` derived from `marketplaceRef`.** It carries a machine-local absolute path
  (`node '/Users/…/index.mjs'`); including it would invalidate every cache on a different
  machine. The `marketplaceRef` itself is used instead, so a package version bump still
  invalidates.
- **The run-level model.** That is a knob for one run, not a property of the node. Including it
  would tear down the whole graph's cache on a model switch. A model override pinned on the node
  still counts.

### Two exemptions from the fingerprint

- **`provide.*`** never executes; its value is authored, so there is no "last produced" to speak
  of — the old value-presence check still applies
- **A missing product file** is not a hit even when the fingerprint matches (an `outputs/…` path
  must actually exist)

## Why not copy React

React's counterpart is `useMemo(fn, [deps])` plus bailout, and that half is exactly what we
want. The other halves do not transfer:

- **The virtual tree.** Reconciliation solves "structure is only known after render, so diff the
  old and new trees". Our structure *is* `workspace.flow.js` on disk — explicit, persistent,
  directly comparable. Building a shadow tree to diff a known structure is a wasted layer.
- **Reference equality.** `Object.is` works because one render happens in one process where
  object identity is stable. Our values cross processes, restarts and machines. No identity to
  compare — only content.

And one premise React relies on that we lack: **render is pure**, so skipping equals recomputing.
Agent nodes are not pure. Caching here is therefore not only a cost saving — pressing ② lands on
the plan you confirmed precisely *because* `plan` hit the cache. The direction is not to cache
less, it is to judge correctly.

The real reference is content-addressed build graphs: Bazel / Nix / Turborepo / Salsa.

## Where it lives

`runFingerprint` is an **instance-level runtime field**, travelling the same path as
`displayReloadKey`:

```
splitWorkspaceGraph    instance.runFingerprint  →  state.fingerprints[nodeId]
mergeWorkspaceState    merged back
isRuntimePath          treated as runtime on conflict, never blocks the user
```

So it never reaches `workspace.flow.js`, never pollutes a diff, and **does not change
`designRevision`** — invalidating every collaborator's baseline on each run is the easiest
mistake to make here, and an assertion guards it.

The check is server-authoritative: `hydrateWorkspaceGraphForRuntime` — the single funnel for both
planning and running — overwrites the field via `readWorkspaceRunFingerprints`. Whatever the
client submitted is discarded; otherwise "was this value actually produced?" would be the
caller's call, and hand-filling a value would skip execution outright.

Overwrite, not fill in: a node with no record on disk has the field removed, so the check falls
to re-running. Flows upgraded from before this change carry no fingerprints and recompute once —
the safe direction.

## Force re-run is required, not a nicety

Nodes read the repo, the network, environment variables — none of that fits in a fingerprint, so
the cache **will** be wrong sometimes. Bazel avoids this with sandboxing; we cannot.

Two granularities:

| Entry point | Effect |
|---|---|
| `restart_alt` button on the run node / `ignoreCache: true` in the body | whole graph ignores the cache |
| `forceNodeIds: [...]` in the body | named nodes ignore the cache |
| The existing "clean outputs" node action | deletes products, which invalidates that node |

`ignoreCache` cannot be replaced by "put every node in `forceNodeIds`": the only nodes you can
enumerate are the ones already in the plan, and the cached ones are precisely those that are not.

## Keeping it

`test/workspace-run-cache.test.mjs`, 13 assertions. The load-bearing ones:

1. Editing a node's own script changes its fingerprint
2. Editing only the upstream changes the downstream fingerprint (dirty propagation is computed)
3. Changing the product does not change the fingerprint (else agent nodes never hit)
4. A machine-local path in a derived script does not affect the fingerprint; a package version
   bump does
5. Editing an upstream script re-runs it — the original bug; mutation-tested, it bites
6. No recorded fingerprint → re-run
7. Fingerprint matches but the product file is gone → re-run
8. `designRevision` is unaffected by fingerprints
