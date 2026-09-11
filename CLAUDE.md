# AgentFlow Project Guidelines

## Project Overview

AgentFlow is an orchestration system for long-running complex agent tasks. It uses graphs to encode dependencies and control flow, treating Cursor, OpenCode, and Claude Code as swappable execution backends.

**Core Philosophy:**
- **Orchestration, Not Dialogue**: Describe workflows with nodes and connections. Once defined, flows can be repeatedly executed.
- **Persistence, Not Volatility**: Every node's inputs, outputs, and execution state are recorded in intermediate files.
- **CI-Friendly**: Long-running, fixed workflows, recoverable—suitable for CI/CD integration.

## Execution Model

**Execution happens in the Workspace graph only.** Runs are started from the Web UI
(`/api/workspace/run`) or by a `workspace_scheduled_run` node.

**The graph is code.** Inside the flow directory:

```
workspace.flow.js      graph structure — restricted ESM, never executed, only statically parsed
workspace.layout.json  canvas positions/sizes — machine-managed
workspace.nodes.json   images, model, marketplaceRef, external-file manifest — machine-managed
workspace.state.json   run output — machine-managed
prompts/ docs/ scripts/  authored text longer than 3 KB
```

`workspace.graph.json` is a **read-only legacy format**: it is still read when there is no
`workspace.flow.js`, and the next save converts the flow to code. Never write it.
See `docs/wiki/flow-dsl.zh-CN.md` and the `agentflow-flow-dsl` skill for the syntax.

The legacy Start/End Pipeline runtime (`flow.yaml` + `control_start` / `control_end`,
driven by `agentflow apply`) is **retired**. `agentflow apply` / `resume` / `replay` /
`scheduler` all fail with `Legacy Start/End Pipeline execution has been retired.`, and
`/api/flow/run`, `/api/flow/run/stop`, `/api/flow/run-config`, `/api/flow/schedule*`
all return HTTP 410. `flow.yaml` is now read/migrate/audit material only.

## Key Commands

| Command | Description |
|---------|-------------|
| `agentflow list` | List all pipelines |
| `agentflow ui` | Start Web UI (port 8765) |
| `agentflow validate <FlowName>` | Validate a flow — Workspace graphs go through `flow dsl lint`, legacy `flow.yaml` flows through the old validator |
| `agentflow flow dsl lint <flowDir>` | Static-check `workspace.flow.js` — run after editing it |
| `agentflow flow dsl migrate <FlowName\|dir> [--allow-loss]` | Convert a legacy `workspace.graph.json` **or `flow.yaml`** to code. The yaml path rewords `runtime: none` nodes and refuses lossy migration unless `--allow-loss`; `agentflow-cli migrate-flow` does the same over HTTP for platform flows |
| `agentflow run-status <FlowName> <uuid>` | View node execution status |
| `agentflow extract-thinking <FlowName> <uuid>` | Extract agent thinking process |

## Node Types and Execution Guidelines

When working with AgentFlow nodes, understand the node type and apply appropriate expertise:

### 1. Requirement Analysis Nodes (`agentflow-node-executor-requirement`)
- Focus on requirement analysis and decomposition
- Understand goals and constraints first, then break down into executable steps
- Output should be actionable items with clear deliverables

### 2. Planning Nodes (`agentflow-node-executor-planning`)
- **Model**: claude-4.6-opus-high-thinking
- First decompose goals into steps, clarify dependencies and order
- Then execute step by step and produce documented results
- Suitable for multi-step reasoning, solution design, task decomposition

### 3. Code Implementation Nodes (`agentflow-node-executor-code`)
- **Model**: gpt-5.3-codex
- Focus on code—write runnable code that conforms to project conventions
- Emphasize type safety, boundary handling, readability, and maintainability
- Suitable for implementing features, fixing bugs, refactoring, writing scripts/tools

### 4. Test/Regression Nodes (`agentflow-node-executor-test`)
- Focus on testing, verification, and regression
- Write or execute tests, verify results, document pass/fail status
- Output should include clear test results and any failure diagnostics

### 5. UI/Frontend Nodes (`agentflow-node-executor-ui`)
- **Model**: kimi-k2.5
- Implement layout, components, styles, and interactions per design specs
- Focus on visual consistency, spacing, hierarchy, responsive design, and RTL support
- Suitable for component implementation, style adjustments, design walkthroughs

### 6. General Nodes (`agentflow-node-executor`)
- General-purpose node executor
- Follow node context and task body to complete work

## Node Runtime Contract (Workspace)

### `tool_nodejs` script placeholders

`script` / `scriptRef` are resolved against these constants plus every input and output
slot name (`${slotName}`):

- `${workspaceRoot}` / `${pipelineWorkspace}` / `${flowDir}`: the scoped workspace root
- `${cwd}`: working directory for the node
- `${nodeRunDir}` / `${nodeTmpDir}` / `${outputsDir}`: per-node run, scratch, output dirs
- `${scriptRef}`: absolute path of the referenced script file

Success/failure is the process exit code (0 = success). Do **not** wrap stdout in JSON.

### Code node packages (`<dir>/nodes/<name>/index.mjs`)

A code node is a **directory**. `index.mjs` carries both the declaration and the
implementation:

```js
import fs from "node:fs/promises";

export default {
  id: "count_lines",              // required — becomes marketplace:count_lines@<version>
  version: "1.0.0",               // required
  name: "统计行数",
  description: "读一个文本文件，统计行数",
  inputs:  { filePath: { type: "text", description: "文件路径", required: true } },
  outputs: { total: { type: "text" } },
};

export async function run(inputs, outputs, dirs) {
  const text = await fs.readFile(inputs.filePath, "utf-8");
  await fs.writeFile(outputs.total, String(text.split("\n").length));
  console.log(`共 ${text.split("\n").length} 行`);   // stdout 即节点 result
}
```

- `export default` is read by **acorn static parse — the package is never executed** to
  list it in the palette or render the canvas. It must therefore be a **pure object
  literal**: any variable reference, function call, or spread is a hard error (with a
  message), not a silent empty manifest.
- `inputs` / `outputs` are ordered maps; slot order follows declaration order, and a
  control slot (`prev` / `next`) is prepended automatically. Slot types: `text`, `file`,
  `bool`, `node`, `image`, `json`.
- `run(inputs, outputs, dirs)` — `outputs.<name>` is the **absolute path to write**, not a
  value. `dirs` has `workspaceRoot` / `nodeRunDir` / `nodeTmpDir` / `outputsDir`.
- Each declared output slot gets its own file; whatever you write lands in that slot. The
  **first non-control output slot** carries the node's result body.
- Failure = throw or non-zero exit. stdout becomes the node result **only when the node did
  not write a file for the result slot** — a `console.log` progress line never clobbers a
  value you wrote deliberately.
- Search order when resolving `marketplace:<id>@<version>`: the flow's own
  `<flowDir>/nodes/*/` first, then published workspace packages, then collections. A
  flow's local implementation is never shadowed by a same-named published package.
- `node.yaml` still works as a fallback manifest for already-published packages.

### `agent_subAgent` output protocol

Agent nodes receive `AGENTFLOW_RESULT_FILE`, `AGENTFLOW_OUTPUTS_DIR`,
`AGENTFLOW_NODE_RUN_DIR`, `AGENTFLOW_NODE_TMP_DIR` and `AGENTFLOW_OUTPUT_FILES_JSON`
in the environment. Results are returned **in the reply**, not written by hand:

- No extra output slots → reply with the result body only. AgentFlow writes it to the
  result file itself; do not create that file and do not emit an envelope.
- With extra output slots → emit exactly one envelope, nothing else:

```
---agentflow
result: |
  <full result body, each line indented two spaces>
outParams:
  <slotName>: <short value>
---end
```

A node fails by failing — a non-zero exit or an error in the reply. There is no
`write-result` command in the workspace runtime.

## File Structure

```
AgentFlow/
├── agents/                          # Agent definitions
│   ├── agentflow-node-executor*.md  # Node executor prompts
│   └── en/ zh/                      # Localized agents
├── bin/                             # CLI entry points
├── builtin/                         # Built-in pipelines and nodes
├── .workspace/agentflow/            # Runtime data (per-workspace)
└── ~/agentflow/                     # User data directory
```

## Workflow Tips

1. **For complex flows**: Use AI Composer mode in Web UI with natural language descriptions
2. **Branching**: `control_if` is the branch primitive the Workspace runtime implements —
   the taken branch runs, the other is skipped
3. **Acyclic graph, explicit iteration**: the Workspace run planner rejects cyclic graphs
   (`Workspace run graph contains a cycle`). Use native `control_while` to repeat one
   deterministic step command inside a bounded node state machine; do not add a back edge.
   Its iteration/timeout limits are cumulative across `wait` resumes, and external writes
   should consume `AGENTFLOW_WHILE_IDEMPOTENCY_KEY` for deduplication.
   The old `control_anyOne` + `control_toBool` + `control_if` ring only worked under the
   retired Start/End runtime
4. **Node coverage**: every node type declares its own support tier in the `runtime:`
   frontmatter field of `builtin/nodes/<id>.md` — this is the single source of truth:
   - `native` — the Workspace runtime has an explicit handler
   - `degraded` — no dedicated handler; works via the generic agent path plus the output
     envelope, so the documented semantics hold only by convention
   - `none` — no implementation; the definition exists only so historical graphs still
     parse. These also carry `palette: hidden` and never reach the node palette,
     `/api/nodes`, or the Composer node reference

   `skills/agentflow-node-reference/references/builtin-nodes.md` is generated from these
   files by `scripts/generate-agentflow-skill-references.mjs`; rerun it after editing any
   node definition (a test enforces this)

---

## Authoring Workspace Graphs

Edit `workspace.flow.js`, then `agentflow flow dsl lint <flowDir>`. Syntax lives in
`docs/wiki/flow-dsl.zh-CN.md` and the `agentflow-flow-dsl` skill.

`flow.yaml` authoring is retired along with its runtime. The three skills that documented it
(`agentflow-flow-edit-node-fields`, `agentflow-flow-add-instances`, `agentflow-flow-sync-ui`)
are redirect stubs, and `/api/flow-editor-sync` is legacy. What follows is what still applies
to a Workspace graph.

**Node type selection:**

| Condition | `definitionId` |
|-----------|----------------|
| Behavior fully determined by input, no AI reasoning | `tool_nodejs` + `script` |
| Requires AI understanding, judgment, content generation | `agent_subAgent` |
| Display prominent output to the user | `display_markdown` |

`tool_print`, `tool_user_check` and `tool_user_ask` are `runtime: none` — they only ever ran
under the retired Start/End runtime. **Never put them in a Workspace graph.** Use
`display_markdown` instead of `tool_print`; there is no Workspace equivalent for the two
human-gate nodes.

`control_agent_toBool` is `runtime: degraded` — it does run, but only because the generic
agent path honors the output envelope. Nothing constrains the model's `prediction` value, and
`parse-bool.mjs` accepts only exactly `true` / `1` / `yes` / `on`; `是` or `true（因为…）`
silently yields false.

**Edges name slots, not positions.** A Workspace edge connects named slots
(`sourceHandle: next`, `targetHandle: prev`). Positional handles (`output-0`) are still read
so historical graphs parse, but never written — adding a slot to a definition shifts every
index past it onto a different pin.

**Fan-out / fan-in:** one output → many inputs is fine; one input takes **exactly one**
incoming edge. Two edges sharing `target + targetHandle` means the runtime uses the first and
silently ignores the rest.

**Scripts under `scripts/` MUST be referenced as `${flowDir}/scripts/xxx.mjs`.** `${flowDir}`
resolves to the flow's real install location (user `~/agentflow/pipelines/`, workspace
`.workspace/agentflow/pipelines/`, or package builtin). Never hardcode
`${workspaceRoot}/.workspace/agentflow/pipelines/${flowName}/scripts/...` — that path only
works for workspace-scope installs and breaks Hub downloads, user-scope and builtin flows.
`flow-write` and Hub import normalize known bad prefixes, but handwritten flows should follow
the rule.

**Layout:** new nodes start at `x: 100, y: 300`; linear chains step `x` by **280**; branches
and parallel nodes offset `y` by **200**.

**One node, one job.** Split multi-step tasks into separate nodes connected by edges.

---

## UI Design Standards: Orchestral Logic

Apply these design principles when working on AgentFlow Web UI:

**Core philosophy:** Treat data pipelines as a living score —高端 technical environment, not rigid corporate dashboard.

### Visual Principles

- **Intentional asymmetry**: Sidebars need not mirror; one side can favor density, the other whitespace
- **Tonal depth over lines**: No 1px borders dividing sections; use color weight and surface layers
- **Technical + organic**: Monospace rawness + large radii (`xl = 1.5rem`) + organic SVG curves

### Color & Surface Stack

| Token | Hex | Usage |
|-------|-----|-------|
| `surface` | `#131313` | Canvas (infinite base) |
| `surface_container_low` | `#1c1b1b` | Secondary areas, sidebars |
| `surface_container_high` | `#2a2a2a` | Node bodies (closer) |
| `surface_container_highest` | `#353534` | Floating menus with glass |
| `surface_container_lowest` | `#0e0e0e` | Sunken input backgrounds |
| `on_surface` | `#e5e2e1` | Body text and icons (**never** pure white) |

**Functional accent colors:**
- File/Stream: `secondary` `#9ecaff` (blue)
- Boolean/Logic: `tertiary` `#00e475` (green)
- Text/Strings: `primary_fixed` `#e8deff` (pale lavender)
- Node/Flow: `primary_container` `#7c4dff` (deep purple)

### Typography

- **Space Grotesk**: Headlines, labels
- **Inter**: Titles, body text
- **Monospace**: Port labels, code snippets (`label-sm = 0.6875rem`)

### Component Specs

**Nodes:**
- Container: `surface_container_high`, `rounded-xl` (1.5rem)
- Header bar: `surface_container_highest`, `rounded-t-xl`, no divider line
- Ports: Colored dots per function type; 2px `surface` gap around port

**Buttons:**
- Primary: `primary_container` bg + `on_primary_container` text, `rounded-full`
- Ghost: No bg, `primary` text, `outline_variant` @ 20% border

**Inputs:**
- Default: `surface_container_lowest` (sunken)
- Focus: `surface_bright` bg + subtle `primary` glow

**Connections (SVG):**
- Cubic Bezier curves, 2px stroke
- Gradient stroke from output port color to input port color

### Signature Interaction: The Pulse

When node is processing:
- Background breathes between `surface_container_high` and `surface_variant`
- ~2s cycle, `ease-in-out` sine wave
- Conveys life in pipeline,替代 harsh spinners

### Implementation Checklist

- [ ] Section divisions use surface tones only, no 1px lines
- [ ] Text uses `on_surface`, never `#FFFFFF`
- [ ] Selection uses tint glow, not hard borders
- [ ] Floating layers have blur + semi-transparent surface
- [ ] Ports have 2px gap; connections are 2px gradient Bezier
- [ ] Running state uses Pulse breathing, not spinning loaders
