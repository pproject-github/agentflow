# Flow graphs as code

A Workspace graph converts both ways between JSON and code:

```bash
agentflow flow dsl export <FlowName|dir> [--out <dir>]   # graph.json -> flow.js
agentflow flow dsl lint   <dir>                          # static validation
agentflow flow dsl import <dir> [--out <flowDir>]        # flow.js -> graph.json
```

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
workspace.nodes.json    what code can't express — pasted images, model, marketplaceRef
workspace.state.json    runtime state — owned by workspace-state.mjs, untouched by the DSL
prompts/ docs/ scripts/ text longer than 3 KB
```

The rule is **anything code can express stays out of the JSON**. Coordinates and base64
images in code would only bury the structure.

## Key design: edges by slot name, not index

In the IR — the shared intermediate representation for both codegen and parsing — an edge
is `sourceNode|sourceSlot|targetNode|targetSlot`.

This is forced: handle indices depend on the instance's own slot order, and slot order is
**per-instance** — 32 instances in the real corpus deviate from their definition. From
`{ content: agent_1.result }` you cannot recover whether that was `input-1` or `input-2`.
So indices are restored from `pinOrder` in `layout.json`, recorded only for instances that
deviate; everything else is rebuilt as "definition order + custom slots seen in the code".

## Never executed

`workspace.flow.js` is always read via acorn static parse. Canvas rendering, lint, and
import all take that path — executing a flow file just to draw a graph is both slow and
unsafe.

That is also why the structure file bans all control flow: the moment `for` / `if` /
`await` / `.map()` appears, static parsing can no longer recover the graph. Lint reports
them as errors and points at `nodes/<name>/index.mjs`, which is plain JS and unconstrained.

## What lint checks

| Layer | Checks |
|-------|--------|
| Syntax | banned control flow, computed member access, `file()` argument must be a literal and the file must exist |
| Semantics | node type exists; `runtime:` tier is usable (`none` errors, `degraded` warns); slots exist; custom output slots are declared via destructuring |
| Graph | fan-in, cycles, `control.if` prediction wired to a `bool`, orphan nodes, missing run entry |

Runtime support comes straight from each node's `runtime:` frontmatter (see
[node-definitions.en.md](node-definitions.en.md)) — not a second list.

`import` lints first and **refuses rather than writing half a graph**.

## Round-trip guarantee

Verified against 21 production flows (334 nodes / 332 edges), 21/21 on all three:

- **node set** identical
- **edge identity** identical — compared by slot name, not by count. This one bit before:
  an early version flattened `control_if` branches into serial execution and the edge
  **count** was unchanged, so a count-based audit missed it
- **idempotence** — regenerating from the restored graph produces byte-identical source

The real corpus contains internal business content and credentials and is not vendored;
tests cover the same shape space with synthetic graphs (branches, forks, schedules, custom
output slots, non-canonical slot order, externalized text, image metadata).

## Authoring by AI

`skills/agentflow-flow-dsl` is the language reference for models. Its node call table is
generated from `builtin/nodes/*.md` by
`scripts/generate-agentflow-skill-references.mjs` and lists only `runtime: native` types;
anything outside it is rejected by lint.

For code node packages see [code-node-packages.en.md](code-node-packages.en.md).
