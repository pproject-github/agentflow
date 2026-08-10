# Built-in flow templates

The templates under `builtin/pipelines/` ship with AgentFlow and sort first in the flow
list. They double as the demonstration of how the system is meant to be used, so they have
to actually run.

There are two:

| Directory | What it does |
|-----------|--------------|
| `new` | Author a flow: plan → human confirm → write `workspace.flow.js` → lint and fix |
| `module-migrate` | Migrate a module: define scope → human confirm → create module → migrate → static check → build and fix → write the doc |

## They used to be dead

Both were built on the Start/End Pipeline: `control_start`, `control_end`,
`tool_user_check`, `control_anyOne`, `control_toBool`, `tool_print`, `tool_save_key` /
`tool_load_key`. Every one of those is `runtime: none` — no implementation outside the
retired stack, not even reachable from the node palette. 13 of module-migrate's 29 nodes
were of that kind; 7 of `new`'s 21.

The blunter problem: they only had `flow.yaml`, no `workspace.flow.js`, so the canvas read
**zero nodes** out of them. Users clicking the template got a blank canvas. Two examples
that cannot run are worse than no examples.

`test/builtin-pipeline-templates.test.mjs` now watches for exactly this: the graph must be
code, lint must be error-free, no node type may be `runtime: none`, one save must not fall
back to JSON, coordinates must not collapse onto each other, and every script referenced by
a `script` field must exist and contain no absolute paths.

## Four kinds of change the migration required

### 1. Cycles → unroll to fixed rounds, or move the iteration inside a node

The Workspace run plan is a DAG and rejects cycles outright. The old
`control_anyOne` + `control_toBool` + `control_if` ring expressed "fix until it passes" on
the graph.

Two ways out, chosen by nature of the loop:

- **When continuing needs a different role** (check finds problems → hand to a fixer agent
  → check again): unroll into two fixed nested gates. If both rounds fail, land on a
  "needs a human" display rather than pretending it will still converge.
- **When it is the same role repeating** (compile one task, fix the failure, recompile):
  move it *inside a single node*. An agent can already loop within its own turn — that ring
  was node-internal logic spread out over the graph.

module-migrate's static check takes the first route (two rounds); the build takes the
second (one `buildA` node that works through the tasks serially). Node count went 29 → 32,
but only one extra layer of real branching.

### 2. `tool_user_check` → `flow.resume`

Workspace has no "pause and wait for a click" node, but it does have run-to-run relay:

```js
export const scopeRun = flow("① Define scope", scope, showScope);
export const migrateRun = flow("② Create module and migrate", newModule, migrate, /* … */);
flow.resume(showScope, migrateRun);
```

Running ① walks the plan until it reaches `migrateRun` and stops there (`pauseNodeIds`).
The result renders on the canvas; the human reads it and clicks ② to continue. That is the
gate.

### 3. `tool_save_key` / `tool_load_key` → just wire an edge

They were used to carry `newFlow` and `moduleName` across the graph via a key-value store.
That is what data edges are for; each save/load pair collapses into one edge. `new` lost
four nodes this way.

### 4. Hardcoded values → pins

Business paths like `iHeima/src/main/java/com/yy/iheima/push/` were baked into node bodies.
They are now `provide.str` nodes referenced by interpolation:

```js
const sourcePath = provide.str("Source path", { value: "app/src/main/java/com/example/push/" });
const scope = agent.subAgent("Define scope", {}, `Determine the migration scope of ${sourcePath.value}. …`);
```

## Decide with a script wherever you can, not with the model

`control.agentToBool` is `runtime: degraded`: nothing constrains the model's output, and
`parse-bool` accepts only `true` / `1` / `yes` / `on` — "yes it passed" or
"true (because …)" silently becomes false.

`control.if` only looks at the value of its own `prediction` slot (type `bool`); the
upstream node type is irrelevant. So a `tool.nodejs` writing `true` / `false` into an
output slot is enough:

```js
const lint = tool.nodejs("lint", { flowId: flowId.value },
  `node ${flowDir}/scripts/lint-flow.mjs ${flowId} ${ok} ${report}`);
const { ok, report } = lint;
const gate = control.if("Passed?", { prediction: ok }, flow(passed), flow(fix, /* … */));
```

Such script nodes **always exit 0**: a failing lint is not this step failing, it is the next
step's job. The only real failure is "the command could not run".

In module-migrate, `scripts/gate.mjs` folds the script verdict and the AI verdict into one
bool for the same reason. `control.agentToBool` survives only where a model genuinely is the
judge — reading pass/fail out of prose build output — and lint raises two warnings for it.
Those warnings are the reminder, not an error.

## flow.yaml is still there, with two jobs left

Whether a directory is recognised as a flow still depends on `flow.yaml` existing
(`catalog-flows.mjs` filters subdirectories by it), and the list description is read from
its `ui.description`. Both templates therefore keep a hollow `flow.yaml` with empty
`instances` / `edges`.

That is a legacy sentinel, not a design. It can go once directory detection accepts
`workspace.flow.js`.
