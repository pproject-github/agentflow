# Single source of truth for node definitions

`builtin/nodes/<definitionId>.md` is the **only** place a node type is defined. The web UI
hardcodes nothing, and the Composer node reference is generated from these files.

## Why this had to be consolidated

Node definitions used to live in three places, with no way to tell which one was right:

| Location | State at the time |
|----------|-------------------|
| `builtin/nodes/*.md` | `control_load_skills` declared `mergeMode` / `loadedCount` / `summary`; the runtime reads none of them |
| `WorkspacePage.jsx` | Hardcoded 6 definitions, then used `HIDDEN_WORKSPACE_DEFS` to mask the `.md` versions |
| `scripts/generate-agentflow-skill-references.mjs` | Its `localOnly` set was missing `control_load_mcp`, `tool_gitlab_create_mr`, and every `display_*` |

The consequence was worse than stale docs: `workspace_run`, `workspace_scheduled_run`,
`workspace_one_click_task` and `control_load_mcp` **did not exist server-side at all** —
they lived only in the React bundle. `/api/nodes` returned 27 nodes, and the node reference
the Composer reads did not even contain the flow's run entry node, so it could not generate
a runnable graph.

## Frontmatter contract

```yaml
---
# 内置节点：Run
runtime: native        # required: how well the Workspace runtime supports this type
type: control          # optional: overrides category inference from the id prefix
palette: hidden        # optional: keep out of the node palette
description: ...
displayName: Run
input:
  - type: node
    name: prev
    default: ""
output:
  - type: node
    name: next
    default: ""
---
Node body (the prompt for agent nodes; documentation only for tool_nodejs)
```

### `runtime:` tiers

| Value | Meaning |
|-------|---------|
| `native` | The run loop in `ui-server.mjs` has a dedicated handler |
| `degraded` | No dedicated handler; works through the generic agent path plus the output envelope, so the documented semantics hold only by convention |
| `none` | No implementation. The definition exists only so historical graphs still parse |

Absent means `native`, which keeps existing project-local custom node `.md` files working.

The only `degraded` node today is `control_agent_toBool`. It does run, but nothing
constrains the model's `prediction`, and `bin/pipeline/parse-bool.mjs` accepts only
`true` / `1` / `yes` / `on` — answering `是` or `true（because…）` silently yields false.

### `type:` and `palette:`

`type:` is one of `control` / `provide` / `agent`. Without it the category is inferred from
the id prefix, so prefix-less types like `workspace_run` must declare it or they land under
`agent`.

Nodes with `palette: hidden` never appear in the node palette, `/api/nodes`, or the
Composer node reference. Every id in `RETIRED_NODE_IDS` must carry this marker — a test
enforces it.

## After editing a definition

The node reference is generated. Rerun it:

```bash
node scripts/generate-agentflow-skill-references.mjs
```

`test/node-definition-single-source.test.mjs` reruns the generator and diffs the output, so
forgetting turns the suite red.

## Guardrails

The sharpest check in `test/node-definition-single-source.test.mjs` scans every
`defId === "..."` branch in `ui-server.mjs` and cross-references the matching `.md`:

```
ui-server 里有 tool_nodejs 的 handler，但 builtin/nodes/tool_nodejs.md 写着 runtime: none
```

So **adding a handler without updating the `.md`, or removing one without downgrading the
tier, fails immediately** — rather than surfacing when a user drags out a node that cannot
run.

## See also

- The code node package contract (`nodes/<name>/index.mjs`) is documented under
  "Code node packages" in `CLAUDE.md`
- Generated node reference: `skills/agentflow-node-reference/references/builtin-nodes.md`
