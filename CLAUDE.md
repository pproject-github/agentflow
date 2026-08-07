# AgentFlow Project Guidelines

## Project Overview

AgentFlow is an orchestration system for long-running complex agent tasks. It uses graphs to encode dependencies and control flow, treating Cursor, OpenCode, and Claude Code as swappable execution backends.

**Core Philosophy:**
- **Orchestration, Not Dialogue**: Describe workflows with nodes and connections. Once defined, flows can be repeatedly executed.
- **Persistence, Not Volatility**: Every node's inputs, outputs, and execution state are recorded in intermediate files.
- **CI-Friendly**: Long-running, fixed workflows, recoverable—suitable for CI/CD integration.

## Execution Model

**Execution happens in the Workspace graph only.** Runs are started from the Web UI
(`/api/workspace/run`) or by a `workspace_scheduled_run` node. The graph lives in
`workspace.graph.json` inside the flow directory.

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
| `agentflow validate <FlowName>` | Validate flow structure |
| `agentflow flow preview <FlowName>` | Generate a single-file static canvas preview |
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
3. **No loops**: the Workspace run planner rejects cyclic graphs
   (`Workspace run graph contains a cycle`). The old `control_anyOne` + `control_toBool` +
   `control_if` check-fix-loop only worked under the retired Start/End runtime
4. **Node coverage**: the Workspace runtime has explicit handlers for `agent_subAgent`,
   `tool_nodejs`, `control_if`, `provide_*`, `control_cd_workspace`,
   `control_user_workspace`, `control_load_skills`, `control_load_mcp`,
   `tool_git_checkout`, `tool_git_worktree_load` / `_unload`, `tool_gitlab_create_mr`,
   `tool_set_run_env`, `tool_display_share_link`, `tool_wecom_send_*`,
   `workspace_run` / `workspace_scheduled_run`. Other builtin node types still appear in
   the palette but fall through to the generic agent path — they do **not** get their
   documented semantics

---

## Flow Editing Skills

### Editing Existing Node Fields (`agentflow-flow-edit-node-fields`)

When modifying **existing** `instances` in `flow.yaml` without changing topology:

**Allowed fields (whitelist):**
| Field | Description |
|-------|-------------|
| `label` | Canvas display name |
| `role` | Role category string |
| `body` | Node body content (agent task description) |
| `script` | **Only for `tool_nodejs`** — actual shell command to execute |
| `input[].value` | Default values for input slots (don't change `type`/`name`) |
| `output[].value` | Default values for output slots (don't change `type`/`name`) |

**Forbidden changes (blacklist):**
- `definitionId` — changing type requires add-new + delete-old + rewire flow
- `instanceId` — renaming requires updating all edges and ui.nodePositions
- `input`/`output` array structure — no adding/removing/reordering items
- `edges` — no modifications to connections
- Adding/removing entire instance blocks — use `agentflow-flow-add-instances`

**Critical `tool_nodejs` rule:**
- `script` field contains the actual command to execute
- `body` is documentation only — **ignored when `script` exists**
- Always write complete, executable commands in `script`, never natural language
- **`script` must reference ALL non-node input and output pins as `${slotName}`** (hard validation error):
  - Input pins: `${slotName}` resolves to upstream data value/path
  - Output pins: `${slotName}` resolves to output file path — script writes directly via `fs.writeFileSync(path, value)`
  - Use exit code for success/failure (0 = success, non-0 = failed). Do NOT use JSON stdout wrapping
- **Scripts under `scripts/` MUST be referenced via `${flowDir}/scripts/xxx.mjs`.** `${flowDir}` resolves to the flow's actual install location (user `~/agentflow/pipelines/`, workspace `.workspace/agentflow/pipelines/`, or package builtin). **Never hardcode `${workspaceRoot}/.workspace/agentflow/pipelines/${flowName}/scripts/...`** — that path only works for workspace-scope installs and breaks for Hub downloads / user-scope / builtin flows. `flow-write` and Hub import normalize known bad prefixes to `${flowDir}` automatically, but handwritten flows should still follow this rule.

### Adding New Instances (`agentflow-flow-add-instances`)

When adding **new nodes** to a flow:

**Node type selection:**
| Condition | Recommended `definitionId` |
|-----------|---------------------------|
| Behavior fully determined by input, no AI reasoning | `tool_nodejs` + `script` |
| Display prominent output to user | `tool_print` |
| Requires AI understanding, judgment, content generation | `agent_subAgent` |
| Pause and wait for the user to confirm/edit content | `tool_user_check` |
| Pause and let the user pick one of N branches (human-driven switch) | `tool_user_ask` |

**YAML structure:**
```yaml
instances:
  <instanceId>:
    definitionId: <builtin or existing definition>
    label: ...
    role: ...
    input: [ { type, name, value }, ... ]
    output: [ { type, name, value }, ... ]
    script: <optional, tool_nodejs only>
    body: | ...
edges:
  - source: <instanceId>
    target: <instanceId>
    sourceHandle: output-0
    targetHandle: input-0
ui:
  nodePositions:
    <instanceId>:
      x: <number>
      y: <number>
```

**Handle quick reference:**
| definitionId | Common outputs | Common inputs |
|--------------|----------------|---------------|
| control_start | next → output-0 | — |
| control_end | — | prev → input-0 |
| control_if | next1(TRUE) → output-0, next2(FALSE) → output-1 | prev → input-0, prediction → input-1 |
| control_toBool | next → output-0, prediction → output-1 | prev → input-0, value → input-1 |
| control_agent_toBool | next → output-0, prediction → output-1 | prev → input-0, value → input-1 |
| control_anyOne | next → output-0 | prev1 → input-0, prev2 → input-1 |
| tool_nodejs | next → output-0, result → output-1 | prev → input-0, [dynamic inputs] |
| tool_user_check | next → output-0, content → output-1 | prev → input-0, content → input-1 |
| tool_user_ask | option_0 → output-0, option_1 → output-1, ...（每个 output 槽位 = 一个选项，槽位 description 是选项文案） | prev → input-0, question → input-1 |

**Edge fan-out / fan-in rule:** One output can connect to multiple inputs (fan-out OK). One input can only have one incoming edge (fan-in forbidden). Never write two edges with the same `target + targetHandle` — runtime only uses the first match, the rest are silently ignored.

**Default node position:** Place new nodes starting at `x: 100, y: 300`. For linear/main-chain flows, increment `x` by **280** per node (e.g. `x: 100 + i * 280, y: 300`). For branches, offset `y` by **200** between paths. For parallel nodes, keep same `x` and offset `y` by **200**.

**Single responsibility principle:** Each node does one thing. Split multi-step tasks into separate nodes connected by edges.

### Sync Web UI After Flow Changes (`agentflow-flow-sync-ui`)

After writing `flow.yaml` to disk in Web UI + Composer context:

```bash
curl -sS -X POST http://127.0.0.1:<PORT>/api/flow-editor-sync \
  -H 'Content-Type: application/json' \
  -d '{"flowId":"<flowId>","flowSource":"user"}'
```

**`flowSource` values:**
- `user` — `~/agentflow/pipelines` directory
- `workspace` — `.workspace/agentflow/pipelines` in current project
- `builtin` — package's `builtin/pipelines` (read-only templates)

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
