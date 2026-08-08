# AgentFlow Workspace Graph Recipes

These recipes target `workspace.flow.js` and the Workspace runtime. The old
`control_start → … → control_end` pipeline recipes are retired — see the note at the end.

## Git Project Analysis

Use when the user asks to clone/pull a repository, enter it, ask an agent what it does, and
show the result.

Recommended graph:

```text
workspace_run
  -> tool_git_checkout
  -> control_cd_workspace
  -> control_load_skills
  -> agent_subAgent
  -> display_markdown
```

Minimum required values:

- `tool_git_checkout.repoUrl`: repository URL.
- `tool_git_checkout.pullIfExists`: `true`.
- `tool_git_checkout.includeSubmodules`: `true` only when the user asks to pull submodules.
- `control_cd_workspace.target`: `.`.
- `control_load_skills.source`: `all` or `current-workspace`.
- `agent_subAgent.body`: ask the agent to inspect README, package/build files, source
  directories, and entry points.

Required context edges:

- Git Checkout `next` -> CD Workspace `prev`
- Git Checkout `workspaceContext` -> CD Workspace `workspaceContext`
- CD Workspace `next` -> Load Skills `prev`
- CD Workspace `workspaceContext` -> Load Skills `workspaceContext`
- Load Skills `next` -> Agent `prev`
- CD Workspace `workspaceContext` -> Agent `workspaceContext`
- Load Skills `skillsContext` -> Agent `skillsContext`
- Agent content output -> Display `content`

Notes:

- Do not connect `repoPath:file` to CD `target:text`.
- If the agent node has no custom file output slot, use its result body, or add a text/file
  output slot intentionally.
- For private/internal Git repositories, local credentials must already work.

## Show A Result

Connect the producing slot into a `display_*` node:

```text
agent.output.summary -> display_markdown.input.content
```

Pick the display type that matches the payload: `display_markdown`, `display_html`,
`display_table`, `display_chart`, `display_mermaid`, `display_ascii`, `display_image`,
`display_react_app`.

## Branching

`control_if` is the branch primitive. Feed its `prediction` input from a `provide_bool`
output; the taken branch runs and the other is skipped.

## No Loops

The Workspace run planner rejects cyclic graphs (`Workspace run graph contains a cycle`).
Express "check → fix → re-check" as forward steps, or put the retry loop **inside** a single
node (the agent's body, or the `tool_nodejs` script). Never draw an edge from a downstream
node back to an upstream one.

## Edit The Graph

- New nodes/edges: `agentflow-flow-add-instances`
- Existing node text/value edits only: `agentflow-flow-edit-node-fields`
- After saving in UI Composer: `agentflow-flow-sync-ui`

## Retired

`control_start`, `control_end`, `control_anyOne`, `control_toBool`, `control_agent_toBool`,
`control_interval_loop`, `control_delay`, `control_wait_until`, `control_cancelled`,
`tool_user_check`, `tool_user_ask`, `tool_print`, `tool_load_key`, `tool_save_key`,
`tool_get_env` and `tool_jenkins_build` only ever ran under the retired Start/End runtime.
They are no longer offered in the node palette; do not generate them.
