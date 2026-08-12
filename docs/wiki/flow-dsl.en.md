# Flow graphs as code

**`workspace.flow.js` is the authoritative storage format for a Workspace graph.** Saving
the canvas writes it; opening the canvas reads it. `workspace.graph.json` is demoted to a
read-only legacy format.

```bash
agentflow flow dsl migrate <FlowName|dir> [--allow-loss]  # graph.json / flow.yaml -> flow.js, in place
agentflow flow dsl lint    <dir>                          # static validation
agentflow flow dsl layout  <dir> [--all]                  # auto-layout; missing positions by default
agentflow flow dsl export  <FlowName|dir> [--out <dir>]   # write a copy elsewhere
agentflow flow dsl import  <dir> [--out <flowDir>]        # back to graph.json (for audits)
```

Existing flows need no manual migration: with no `workspace.flow.js`, `workspace.graph.json`
is read as before and the next save converts it. `migrate` just makes that happen sooner.

## Migrating in from flow.yaml

`flow.yaml` is a different story. Since the Start/End execution stack was retired it has become
a **tombstone**: the directory sentinel recognizes it, so the flow still shows up in the list;
the graph reader does not, so opening it shows an empty canvas — it cannot run and cannot be
edited, and the body / prompt / script inside are stranded.

The two formats have an identical shape (`instances` / `edges` / `ui`, index-based `output-N`
handles); what differs is the **node vocabulary**: a set of nodes yaml uses is `runtime: none`
in the Workspace runtime. So migration is a rewording:

| yaml node | becomes | note |
|---|---|---|
| `control_start` | `workspace_run` | the legacy entry point *is* the Workspace run node |
| `control_end` | dropped | Workspace ends when nothing follows; no end node to express |
| `tool_print` | `display_markdown` | |
| `control_toBool` | `control_agent_toBool` | ⚠️ deterministic parsing becomes an agent judgment |
| `control_anyOne` / `tool_user_check` / `tool_user_ask` / other `runtime: none` | **no equivalent** | dropped |

Edges are rewired **by slot name**, not by index — `tool_print`'s `next` sits at index 0 while
`display_markdown`'s `next` sits at index 1 (index 0 is the `content` output). Copying indices
would attach a control edge to a content slot: the graph still looks connected and only breaks
at run time. Slots the legacy flow renamed (e.g. a content slot called `summary`) are genuinely
renamed and reported, because the display runtime resolves `content` by name.

**Lossy migration is refused by default**: if any node or edge cannot be carried over, the
command stops, prints the list, and does not touch a single byte on disk. Review it, then pass
`--allow-loss`. `control_end` and edges into it are the one exception — dropping them loses
nothing, so they never block.

The `flow.yaml` original is kept. After migration `workspace.flow.js` is authoritative (the
reader looks there first) and the yaml stays behind as source material.

Falling short of code form still counts as success: fields like a `tool_nodejs` node carrying
both `script` and `body`, or a `control_if` with a `body`, have nowhere to live in code, so the
round-trip gate sends the flow back to `workspace.graph.json`. That is still a successful
migration — `graph.json` can be read, rendered and run, and yaml can do none of the three.

### Flows on the platform

Before accepting HTTP requests or starting the scheduler, the server checks a dedicated storage
schema version and scans the effective `AGENTFLOW_HOME`, every user pipeline root, the current
`workspaceRoot`, and archived pipelines. Lossless `workspace.graph.json` and `flow.yaml` projects are
migrated in place. A YAML graph that would lose nodes or edges is left untouched and recorded under
`needsDecision`; startup never opts into data loss.

The version, per-root results, and pending decisions are stored at:

```text
<AGENTFLOW_HOME>/admin/storage-migrations.json
```

A filesystem lock prevents two server processes from migrating the same volume concurrently.
`flow.yaml` is always retained, while unattended `workspace.graph.json` conversion also creates a
backup under `.agentflow-migrations/workspace-flow-dsl-v1/` in the Flow directory. Repeated startup
at the same version is a no-op. Reusing the data root with a new `workspaceRoot` migrates only that
new Workspace.

The HTTP/CLI path below remains available for pending decisions and troubleshooting; it is no longer
a required deployment step:

```bash
agentflow-cli migrate-flow --flow-id <id> [--flow-source user] [--archived] [--allow-loss]
```

It maps to `POST /api/workspace/migrate` with identical semantics (refuses loss by default,
returns the same report, keeps the yaml). `builtin` and `admin` are read-only catalogs and are
refused.

**Archived flows are also refused by default**; pass `allowArchived` to migrate one. This is the
one place migration diverges from the save path, which refuses archived flows outright. Nobody
will ever open an archived flow and save it, so without an escape hatch they stay on the dead
format forever — and "archived + yaml-only" is exactly the class that would silently vanish once
the sentinel goes. Migration converts storage format, not content; the round-trip gate keeps the
graph equivalent.

### One-shot upgrade

```bash
agentflow-cli migrate-all [--include-archived] [--allow-loss] [--dry-run]
```

Manually walks every flow this account can see and **does all the lossless ones, touching none of the
lossy ones**. After startup migration it is mainly useful for repair and verification. The two jobs
carry very different risk:

- `graph.json -> code`: storage format only, same node vocabulary, round-trip gated — lossless
- `flow.yaml -> code`: needs rewording, may drop things — refused by default, with a report

Read `needsDecision` afterwards: those are the only ones needing a human, and each is handled
with `migrate-flow --allow-loss`. Reruns are idempotent (flows already in code form are skipped).
The report's `skipped` field lists read-only catalogs and skipped archived flows — "it finished"
is not the same as "it covered everything".

## Why code

Flow orchestration is fundamentally "a main that calls a series of funcs, with edges
passing data". In JSON an edge looks like this:

```json
{ "source": "agent_1", "target": "display_1", "sourceHandle": "output-1", "targetHandle": "input-1" }
```

Which slot `output-1` refers to depends on `agent_1`'s own slot array order — unreadable
for humans, unguessable for models. The same thing as code:

```js
const display_1 = display.markdown("展示", { content: agent_1.result });
```

Now a model's coding ability applies directly, lint can validate it, and diffs are legible.

## Four files

```
workspace.flow.js       structure — nodes, edges, authored content (restricted ESM)
workspace.layout.json   canvas — positions, sizes, pin visibility and order
workspace.nodes.json    what code can't express — pasted images, model, marketplaceRef, external-file manifest
workspace.state.json    runtime state — owned by workspace-state.mjs, untouched by the DSL
prompts/ docs/ scripts/ text longer than 3 KB
```

The rule is **anything code can express stays out of the JSON**. Coordinates and base64
images in code would only bury the structure.

`externals` in `workspace.nodes.json` lists the external text files written last time. When
a body drops below the threshold or a node is deleted, it is what makes the cleanup exact —
no filename guessing, so an author-written script under `scripts/` is never collected.
Manifest entries that resolve outside the flow directory are ignored.

## Key design: edges by slot name, not index

In the IR — the shared intermediate representation for both codegen and parsing — an edge
is `sourceNode|sourceSlot|targetNode|targetSlot`.

This is forced: handle indices depend on the instance's own slot order, and slot order is
**per-instance** — 32 instances in the real corpus deviate from their definition. From
`{ content: agent_1.result }` you cannot recover whether that was `input-1` or `input-2`.
So indices are restored from `pinOrder` in `layout.json`, recorded only for instances that
deviate; everything else is rebuilt as "definition order + custom slots seen in the code".

## Body interpolation: one `${}`, two meanings

The runtime's body placeholders only understand slot names — the regex in
`workspaceBodyPlaceholderNames` is `\$\{([A-Za-z_][A-Za-z0-9_-]*)\}`, no `.` in it. So
`` `analyse ${dateStr.value}` `` cannot land in the body verbatim. It compiles to:

- body `analyse ${dateStr}`
- a data edge `dateStr.value -> thisNode.dateStr`

The slot name is the **root identifier** of the reference expression. On the way back it
folds into JS interpolation only when slot name == root identifier; otherwise it stays as
"explicit pin + escaped `\${slot}`", because otherwise the round trip would rename the slot.

Resolution order:

1. This node already has a slot by that name (or, in a `tool_nodejs` script, one of the
   `${flowDir}`-style constants or its own output slots) → runtime placeholder, kept as is
2. `${x.y}` or a destructured variable → upstream reference, slot created and wired
3. Neither → recorded in `unresolved`

Case 3 used to **silently drop the whole body**: `stringOf` returned null for a template
literal, and the body branch only tested `if (body !== null)`. One save and it was gone
from disk.

Pin values likewise now accept non-string literals such as `true` / `42` (stored as strings
in the graph). Codegen re-emits them according to the slot's `type`: a `bool` slot gets a
bare `true`, everything else a string. Custom slots carry their `bool` type through the IR,
so `pullIfExists: true` comes back as `true`, not `"true"`.

## Never executed

`workspace.flow.js` is always read via acorn static parse. Canvas rendering, lint, and
import all take that path — executing a flow file just to draw a graph is both slow and
unsafe.

That is also why the structure file bans all control flow: the moment `for` / `if` /
`await` / `.map()` appears, static parsing can no longer recover the graph. Lint reports
them as errors and points at `nodes/<name>/index.mjs`, which is plain JS and unconstrained.

## Two gates against losing a graph

For a storage format, "read one node fewer" is the same thing as "that node is gone on the
user's next save". Hence:

**Anything the parser cannot account for is recorded, never silently skipped.** A stray
top-level `for`, a pin value written as a function call, one `const` declaring two nodes —
each lands in `unresolved`. Reading (strict mode) throws `WorkspaceFlowParseError`;
`/api/workspace/graph` answers 422 with the line number, and lint lists every occurrence.
There is no "read as much as you can" fallback.

**Before writing, the generated code is parsed back and compared field by field.** On a
mismatch the write falls back to `workspace.graph.json` and deletes any existing
`workspace.flow.js` — it has higher read priority, so leaving it would hand the canvas to the
lossy version. The comparison uses a normalized fingerprint that flattens key order, the
three ways of writing "absent" (`undefined`/`null`/`""`), `role: normal` vs unset, and
`showOnNode` / `required` inherited from the definition table — representation differences
only, never content. All 21 production flows pass the gate; the largest takes 5.4 ms to
save + read.

## `flow.fork` is only the syntax for fan-out

There is no fork in the graph. `flow(a, b, c)` is linear and cannot express "one `next` feeding
several downstream nodes", so this syntax fills the gap:

```js
flow("Run", build, flow.fork(flow(testA), flow(testB, report)))
```

It parses into two control edges and nothing else:

```
build.next → testA.prev
build.next → testB.prev
```

Codegen goes the other way — when a node's `next` has two or more downstream targets and it is
not a `control_if`, it prints `flow.fork(...)`. Purely so the round trip matches.

**It is not a parallelism primitive.** The runtime pulls both branches' nodes into the plan and
executes them in topological order, **sequentially** (`for (const nodeId of order)`); two
branches sleeping 3 seconds each take 6 seconds. There is no isolation between branches either:
any node failing ends the whole run, and the other branch never starts.

A comment in the skill used to say "parallel" — that was the single source of the false promise.
Real concurrency means changing the scheduler: indegree-driven dispatch with a concurrency cap,
plus handling in-place graph mutation during the run, per-node conflict detection, the abort
path, and event ordering. A separate piece of work, unrelated to `flow.fork`.

## What lint checks

| Layer | Checks |
|-------|--------|
| Syntax | banned control flow, computed member access, `file()` argument must be a literal and the file must exist |
| Semantics | node type exists; `runtime:` tier is usable (`none` errors, `degraded` warns); slots exist; custom output slots are declared via destructuring |
| Graph | fan-in, cycles, control slots actually exist, `control.if` prediction wired to a `bool`, orphan nodes, missing run entry |

"Control slots actually exist" was added later: `provide.*` and `tool.getEnv` have no
`prev` / `next`, so putting them in a `flow(...)` chain produces an edge with nowhere to
land, which then vanishes silently on the round trip. The skill's own example had this bug.

Runtime support comes straight from each node's `runtime:` frontmatter (see
[node-definitions.en.md](node-definitions.en.md)) — not a second list.

`import` lints first and **refuses rather than writing half a graph**.

## Code node packages

A `nodes/<name>/index.mjs` inside the flow directory is just an import:

```js
import collectMetrics from "./nodes/collect-metrics";

const collect = collectMetrics("统计语料", { date: "2026-08-09" });
const show = display.markdown("结果", { content: collect.total });
```

**The graph shape is identical to what the palette produces**: `definitionId` is the base
type (`tool_nodejs` etc.), the package identity lives in `marketplaceRef`, and the slots come
from the package declaration — not from the base type, which carries context slots like
`skillsContext` that a code node does not have. The import is only the readable spelling.

Outputs the package declares need no `const { total } = collect` line; reference
`collect.total` directly.

The bootstrap command needed to run it is **derived** (`marketplaceRef` → absolute local
paths), recomputed on every read and never written into `flow.js` — otherwise the flow file
would carry somebody's home directory and break the moment it is shared.

Lint and the storage layer use **one package scan** (`flow-dsl/packages.mjs`). Splitting them
actually happened: lint resolved packages and saw the right graph while the store did not,
reading the import as a node with an empty slot table — so the control edge landed on the
first data pin and two edges collided on one handle. An AI following the documented pattern
got a green lint and a broken canvas, frozen into JSON on the next save.

## The revision has to describe what is on disk

Generating code normalizes: slots get filled in, `role: normal` is dropped, slot order is
canonicalized. So **the graph you write and the graph you read back are not byte-identical** —
and collaboration hangs on `designRevision`, a field-exact hash.

The `revision` returned by a `/api/workspace/graph` save is computed on **what a subsequent
read would produce**, not on what the client submitted (`writeWorkspaceDesign` hands back the
graph it already reparsed for the verification gate, so this costs nothing). Otherwise the
client walks away holding a revision that does not exist on disk, and its next save is
rejected as "merge base does not match baseRevision" — in a shared workspace, nobody can save
at all. All 21 production flows hit this; 3 of them never converge no matter how many times
you save.

## Round-trip guarantee

Verified against 21 production flows (334 nodes / 332 edges), 21/21 on all three:

- **node set** identical
- **edge identity** identical — compared by slot name, not by count. This one bit before:
  an early version flattened `control_if` branches into serial execution and the edge
  **count** was unchanged, so a count-based audit missed it
- **idempotence** — regenerating from the restored graph produces byte-identical source
  (and when nothing changed, the files are not rewritten at all)

The real corpus contains internal business content and credentials and is not vendored;
tests cover the same shape space with synthetic graphs (branches, forks, schedules, custom
output slots, non-canonical slot order, externalized text, image metadata).

## Authoring by AI

`skills/agentflow-flow-dsl` is the language reference for models. Its node call table is
generated from `builtin/nodes/*.md` by
`scripts/generate-agentflow-skill-references.mjs` and lists only `runtime: native` types;
anything outside it is rejected by lint.

For code node packages see [code-node-packages.en.md](code-node-packages.en.md).
