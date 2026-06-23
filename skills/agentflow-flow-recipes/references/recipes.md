# AgentFlow Flow Recipes

## Git Project Analysis

Use when the user asks to clone/pull a repository, enter it, ask an agent what it does, and print the result.

Recommended graph:

```text
control_start
  -> tool_git_checkout
  -> control_cd_workspace
  -> control_load_skills
  -> agent_subAgent
  -> tool_print
  -> control_end
```

Minimum required values:

- `tool_git_checkout.repoUrl`: repository URL.
- `tool_git_checkout.pullIfExists`: `true`.
- `tool_git_checkout.includeSubmodules`: `true` only when the user asks to pull submodules.
- `control_cd_workspace.target`: `.`.
- `control_load_skills.source`: `all` or `current-workspace`.
- `agent_subAgent.body`: ask the agent to inspect README, package/build files, source directories, and entry points.
- `tool_print.content`: connect from the agent output content.

Required context edges:

- Git Checkout `next` -> CD Workspace `prev`
- Git Checkout `workspaceContext` -> CD Workspace `workspaceContext`
- CD Workspace `next` -> Load Skills `prev`
- CD Workspace `workspaceContext` -> Load Skills `workspaceContext`
- Load Skills `next` -> Agent `prev`
- CD Workspace `workspaceContext` -> Agent `workspaceContext`
- Load Skills `skillsContext` -> Agent `skillsContext`
- Agent content output -> Print `content`
- Print `next` -> End `prev`

Notes:

- Do not connect `repoPath:file` to CD `target:text`.
- If the agent node has no custom file output slot, use its result body and let Print fallback, or add a text/file output slot intentionally.
- For private/internal Git repositories, local credentials must already work.

## Edit Current Flow

Use existing flow editing skills:

- New nodes/edges: `agentflow-flow-add-instances`
- Existing node text/value edits only: `agentflow-flow-edit-node-fields`
- After saving in UI Composer: `agentflow-flow-sync-ui`

## Print Result

Prefer explicit content:

```text
agent.output.summary -> tool_print.input.content
```

Fallback behavior exists, but explicit content keeps the graph self-documenting.
