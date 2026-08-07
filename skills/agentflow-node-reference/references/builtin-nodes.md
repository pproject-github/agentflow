# AgentFlow Builtin Nodes Reference

> Generated from `builtin/nodes/*.md` by `scripts/generate-agentflow-skill-references.mjs`.

## Rules Of Thumb

- `tool_nodejs` needs an executable `script`; `body` is documentation when `script` exists.
- `agent_subAgent` is for semantic/code/text reasoning tasks.
- Local-only nodes are executed by AgentFlow runtime and do not call an agent.
- The Workspace runtime executes a DAG; cyclic graphs are rejected. Express check-then-fix as forward steps.
- Edge handles are positional: `input-0`, `output-0`, etc. Match slot order exactly.

## agent

### agent_subAgent

- Display: 子 Agent
- Description: 利用子 Agent 执行任务；可接收 knowledgeContext 读取知识库，可接收 workspaceContext 切换执行工作区，并接收 skillsContext / mcpContext 注入已加载 skills 与 MCP 工具清单。
- Runtime: agent/runner
- Inputs: 0. `prev`:node; 1. `workspaceContext`:text; 2. `skillsContext`:text; 3. `mcpContext`:text; 4. `knowledgeContext`:text
- Outputs: 0. `next`:node; 1. `result`:text

## control

### control_cd_workspace

- Display: 加载知识库
- Description: Load one or more read-only knowledge sources for downstream Agent nodes. This node does not change the runtime cwd. It publishes `knowledgeContext` for reading/searching referenced repos or folders. `workspaceContext` and `cwd` are retained as legacy compatibility outputs for the first source.
- Runtime: local-only
- Inputs: 0. `prev`:node; 1. `knowledgeContext`:text; 2. `path`:text; 3. `mode`:text = set; 4. `label`:text; 5. `workspaceContext`:text
- Outputs: 0. `next`:node; 1. `knowledgeContext`:text; 2. `workspaceContext`:text; 3. `cwd`:file; 4. `previous`:text

### control_if

- Display: If
- Description: Has exactly one bool type input. Continues to next1 if true, next2 if false
- Runtime: local-only
- Inputs: 0. `prev`:node; 1. `prediction`:bool
- Outputs: 0. `next1`:node; 1. `next2`:node

### control_load_skills

- Display: Load Skills
- Description: Load selected public Skills from the AgentFlow skill registry into the current workspace context. Connect `workspaceContext` from CD Workspace, set `skillKeys` to skill names or registry keys, then connect `skillsContext` to downstream agent/tool nodes. Loaded skills are injected into the node prompt under "已加载 Skills" while downstream execution still uses the CD Workspace context. Skill key examples: - `agentflow-flow-add-instances` - `workspace-agents:agentflow-flow-edit-node-fields` - `global-codex:some-skill` Merge modes: - `replace` - `append` - `prepend`
- Runtime: local-only
- Inputs: 0. `prev`:node; 1. `skillKeys`:text; 2. `mergeMode`:text = replace; 3. `workspaceContext`:text; 4. `skillsContext`:text
- Outputs: 0. `next`:node; 1. `skillsContext`:text; 2. `loadedCount`:text; 3. `summary`:text

### control_user_workspace

- Display: User Workspace
- Description: Output a workspace context pointing to the current user's home directory.
- Runtime: local-only
- Inputs: 0. `prev`:node
- Outputs: 0. `next`:node; 1. `workspaceContext`:text; 2. `cwd`:file

## tool

### tool_display_share_link

- Display: Display Share Link
- Description: Create a public share link for upstream Display nodes
- Runtime: local-only
- Inputs: 0. `prev`:node; 1. `title`:text; 2. `layout`:text = single; 3. `nodeIds`:text; 4. `baseUrl`:text
- Outputs: 0. `next`:node; 1. `url`:text; 2. `shareId`:text; 3. `expiresAt`:text

### tool_git_checkout

- Display: Git Checkout
- Description: Clone or update a Git repository and expose it as a workspace context for downstream nodes. - `repoUrl` is required. - `targetDir` may be absolute or relative to the current workspace context. - If `targetDir` is empty, the repository is cloned into `${pipelineWorkspace}/.workspace/agentflow/git-repos/<repo-name>`. For user pipelines, `${pipelineWorkspace}` follows the Admin Settings AgentFlow Data Root. - Set `includeSubmodules` to `true` to clone/update Git submodules recursively. - The `workspaceContext` output can be connected to CD Workspace, Load Skills, agent, or tool nodes. - The `gitContext` output can be connected to Worktree, GitLab MR, or other Git nodes.
- Runtime: local-only
- Inputs: 0. `prev`:node; 1. `repoUrl`:text; 2. `branch`:text; 3. `targetDir`:text; 4. `pullIfExists`:bool = true; 5. `includeSubmodules`:bool = false; 6. `remote`:text = origin; 7. `workspaceContext`:text
- Outputs: 0. `next`:node; 1. `repoPath`:file; 2. `branch`:text; 3. `commit`:text; 4. `changed`:bool; 5. `workspaceContext`:text; 6. `gitContext`:text

### tool_git_worktree_load

- Display: Load Worktree
- Description: Create or reuse a Git worktree and expose it as the downstream workspace context. - `repoPath` is required unless `gitContext.repoPath` is connected. - `workspaceContext` is required so the node can preserve the previous execution context. - `branch` is optional. When empty, AgentFlow creates a detached worktree at the current HEAD. - `worktreePath` is optional. When empty, AgentFlow creates a temporary worktree under the current run temp directory. - A worktree created by this node during the current Workspace run is removed when the run finishes or is stopped, even when `worktreePath` is explicitly set. - Existing registered worktrees under the current flow workspace are also removed after the run, covering leftovers from previous interrupted runs. - Existing registered worktrees outside the current flow workspace are reused and not removed automatically unless this run created them. - Existing worktree paths are reused only when they are registered by `git worktree list` for the given repo. - `pruneMissing` defaults to true. When Git has a registered worktree whose directory is missing, AgentFlow runs `git worktree prune` before adding it again. - `force` defaults to false. When true, AgentFlow passes `--force` to `git worktree add`.
- Runtime: local-only
- Inputs: 0. `prev`:node; 1. `repoPath`:file; 2. `branch`:text; 3. `worktreePath`:file; 4. `pruneMissing`:bool = true; 5. `force`:bool = false; 6. `gitContext`:text; 7. `workspaceContext`:text
- Outputs: 0. `next`:node; 1. `worktreePath`:file; 2. `branch`:text; 3. `commit`:text; 4. `workspaceContext`:text; 5. `gitContext`:text

### tool_git_worktree_unload

- Display: Unload Worktree
- Description: Remove a Git worktree. - `workspaceContext` is required. Its `cwd` is used as the worktree to remove. - `repoPath`, `worktreePath` and `gitContext` are optional compatibility overrides. - By default `force` is false; dirty worktrees fail instead of being removed. - By default `prune` is true.
- Runtime: local-only
- Inputs: 0. `prev`:node; 1. `repoPath`:file; 2. `worktreePath`:file; 3. `gitContext`:text; 4. `workspaceContext`:text; 5. `force`:bool = false; 6. `prune`:bool = true
- Outputs: 0. `next`:node; 1. `removed`:bool; 2. `workspaceContext`:text; 3. `message`:text

### tool_gitlab_create_mr

- Display: Create GitLab MR
- Description: Create or reuse a GitLab merge request for the current branch. - `gitContext` and `workspaceContext` can be connected from Git Checkout / Load Worktree. - `repoPath` is optional. When empty, AgentFlow uses `gitContext.worktreePath`, `gitContext.repoPath`, or `workspaceContext.cwd`. - `sourceBranch`, `targetBranch`, `title`, `description`, `draft`, and `labels` are optional. When empty, AgentFlow derives sensible defaults from git. - `tokenEnv` is optional. Defaults to `GITLAB_TOKEN,GITLAB_PRIVATE_TOKEN`. - `gitlabApiBase` is optional. When empty, AgentFlow uses `https://${gitContext.host}/api/v4`.
- Runtime: agent/runner
- Inputs: 0. `prev`:node; 1. `repoPath`:file; 2. `gitContext`:text; 3. `workspaceContext`:text; 4. `sourceBranch`:text; 5. `targetBranch`:text; 6. `title`:text; 7. `description`:text; 8. `draft`:bool = false; 9. `labels`:text; 10. `push`:bool = true; 11. `remote`:text = origin; 12. `tokenEnv`:text; 13. `gitlabApiBase`:text; 14. `removeSourceBranch`:bool = false; 15. `squash`:bool = false
- Outputs: 0. `next`:node; 1. `mrUrl`:text; 2. `created`:bool; 3. `mrIid`:text; 4. `projectId`:text; 5. `sourceBranch`:text; 6. `targetBranch`:text; 7. `title`:text; 8. `message`:text

### tool_nodejs

- Display: NodeJs
- Description: Execute a Node.js script. The Workspace runtime spawns the command directly — no agent involved. **Success/Failure:** Determined by the script process **exit code** — 0 = success, non-0 = failed. **Result Output:** Script stdout becomes the `result` slot content (plain text, e.g. `console.log("hello")`). When stdout is empty and the exit code is non-0, stderr is written to the failure message. Do **not** wrap stdout in a JSON envelope. **Script placeholders:** `script` (inline) or `scriptRef` (file) support `${}` placeholders — `workspaceRoot` / `pipelineWorkspace` / `flowDir` (all three resolve to the scoped workspace root), `cwd`, `nodeRunDir`, `nodeTmpDir`, `outputsDir`, `scriptRef`, plus every input and output slot name. Values are auto shell-quoted, so do not add your own quotes. Example: `script: node ${flowDir}/scripts/my-check.mjs --root ${workspaceRoot} --input ${todo}` **Pin Path Constraint (Important):** File paths read/written by the script **must be passed via pins**; never construct output paths inside the script. - Input slots of type `file` are resolved from upstream connections; the script receives them as CLI args. - Output slots of type `file` are resolved to absolute paths by the runtime; the script writes to them directly. - Reference them with `${slotName}` in `script`, e.g. `--figma-tree ${figma_tree} --output ${restore_todolist}`. - **Forbidden** to invent output paths inside the script — downstream nodes will not find the files. **Scripts under `scripts/` must be referenced as `${flowDir}/scripts/xxx.mjs`.**
- Runtime: direct script when script exists, otherwise agent
- Inputs: 0. `prev`:node; 1. `workspaceContext`:text; 2. `skillsContext`:text; 3. `mcpContext`:text
- Outputs: 0. `next`:node; 1. `result`:text

### tool_set_run_env

- Display: Set Run Env
- Description: Set environment variables for downstream nodes in the current workspace run
- Runtime: local-only
- Inputs: 0. `prev`:node; 1. `key`:text; 2. `value`:text; 3. `variables`:text
- Outputs: 0. `next`:node; 1. `keys`:text; 2. `count`:text

### tool_wecom_send_app_markdown

- Display: WeCom Direct Markdown
- Description: Send Markdown message to WeCom users through an enterprise application
- Runtime: agent/runner
- Inputs: 0. `prev`:node; 1. `markdown`:text; 2. `toUser`:text; 3. `corpId`:text; 4. `corpSecret`:text; 5. `agentId`:text; 6. `accessToken`:text
- Outputs: 0. `next`:node; 1. `sent`:bool; 2. `message`:text; 3. `response`:text

### tool_wecom_send_group_markdown

- Display: WeCom Group Chat Markdown
- Description: Send Markdown message to a WeCom group robot webhook
- Runtime: agent/runner
- Inputs: 0. `prev`:node; 1. `markdown`:text; 2. `webhookUrl`:text; 3. `webhookKey`:text
- Outputs: 0. `next`:node; 1. `sent`:bool; 2. `message`:text; 3. `response`:text

## provide

### provide_bool

- Display: Boolean
- Description: Provide a boolean value directly, value will be passed to downstream as true or false
- Runtime: local-only
- Inputs: 无
- Outputs: 0. `value`:bool = false

### provide_file

- Display: File
- Description: Provide file path or content directly, value will be passed to downstream as-is
- Runtime: local-only
- Inputs: 无
- Outputs: 0. `value`:file

### provide_password

- Display: Password
- Description: Provide a secret text value without showing it on the node card
- Runtime: local-only
- Inputs: 无
- Outputs: 0. `value`:text

### provide_str

- Display: String
- Description: Provide a text value directly, value will be passed to downstream as-is
- Runtime: local-only
- Inputs: 无
- Outputs: 0. `value`:text

## other

### display_ascii

- Display: ASCII Display
- Description: Display ASCII diagram content in workspace canvas; passes diagram text downstream as text
- Runtime: agent/runner
- Inputs: 0. `prev`:node; 1. `content`:text
- Outputs: 0. `content`:text; 1. `next`:node

### display_chart

- Display: Chart Display
- Description: Display a JSON ChartSpec with ECharts in workspace canvas; passes the JSON downstream as text
- Runtime: agent/runner
- Inputs: 0. `prev`:node; 1. `content`:text; 2. `filePath`:file; 3. `workspaceContext`:text
- Outputs: 0. `content`:text; 1. `next`:node

### display_html

- Display: HTML Display
- Description: Display HTML content in workspace canvas; passes HTML downstream as text
- Runtime: agent/runner
- Inputs: 0. `prev`:node; 1. `content`:text; 2. `filePath`:file; 3. `workspaceContext`:text
- Outputs: 0. `content`:text; 1. `next`:node

### display_image

- Display: Image Display
- Description: Display an image URL, data URL, or image path in workspace canvas; passes source downstream as text
- Runtime: agent/runner
- Inputs: 0. `prev`:node; 1. `src`:text; 2. `filePath`:file; 3. `alt`:text; 4. `workspaceContext`:text
- Outputs: 0. `src`:text; 1. `next`:node

### display_markdown

- Display: Markdown Display
- Description: Display Markdown content in workspace canvas; passes content downstream as text
- Runtime: agent/runner
- Inputs: 0. `prev`:node; 1. `content`:text
- Outputs: 0. `content`:text; 1. `next`:node

### display_mermaid

- Display: Mermaid Display
- Description: Display Mermaid diagram source in workspace canvas; passes diagram source downstream as text
- Runtime: agent/runner
- Inputs: 0. `prev`:node; 1. `content`:text
- Outputs: 0. `content`:text; 1. `next`:node

### display_react_app

- Display: React App
- Description: Display a small React project in a sandboxed workspace iframe and pass the project JSON downstream
- Runtime: agent/runner
- Inputs: 0. `prev`:node; 1. `content`:text; 2. `filePath`:file; 3. `workspaceContext`:text
- Outputs: 0. `content`:text; 1. `next`:node

### display_table

- Display: Table Display
- Description: Display table data in workspace canvas; accepts JSON, Markdown table, CSV, or TSV and passes the text downstream
- Runtime: agent/runner
- Inputs: 0. `prev`:node; 1. `content`:text; 2. `filePath`:file; 3. `workspaceContext`:text
- Outputs: 0. `content`:text; 1. `next`:node
