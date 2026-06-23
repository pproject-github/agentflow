# AgentFlow Builtin Nodes Reference

> Generated from `builtin/nodes/*.md` by `scripts/generate-agentflow-skill-references.mjs`.

## Rules Of Thumb

- `tool_nodejs` needs an executable `script`; `body` is documentation when `script` exists.
- `agent_subAgent` is for semantic/code/text reasoning tasks.
- Local-only nodes are executed by AgentFlow runtime and do not call an agent.
- Edge handles are positional: `input-0`, `output-0`, etc. Match slot order exactly.

## agent

### agent_subAgent

- Display: SubAgent
- Description: 利用 SubAgent 执行任务；可接收 workspaceContext 切换执行工作区，并接收 skillsContext 注入已加载 skills。
- Runtime: agent/runner
- Inputs: 0. `prev`:node; 1. `workspaceContext`:text; 2. `skillsContext`:text
- Outputs: 0. `next`:node

## control

### control_agent_toBool

- Display: Agent ToBool
- Description: AI-powered boolean judgment: an agent evaluates the input value and writes true/false to prediction. Use for non-deterministic scenarios requiring semantic understanding.
- Runtime: agent/runner
- Inputs: 0. `prev`:node; 1. `value`:text
- Outputs: 0. `next`:node; 1. `prediction`:bool

### control_anyOne

- Display: AnyOne
- Description: Continues to next when any upstream input is ready
- Runtime: agent/runner
- Inputs: 0. `prev1`:node; 1. `prev2`:node
- Outputs: 0. `next`:node

### control_cancelled

- Display: Cancelled
- Description: Check whether the current run/watch has been cancelled. Use cancelled output with control_if.
- Runtime: local-only
- Inputs: 0. `prev`:node; 1. `watchId`:text
- Outputs: 0. `next`:node; 1. `cancelled`:bool

### control_cd_workspace

- Display: CD Workspace
- Description: Switch the runtime workspace context for downstream nodes without changing the AgentFlow pipeline workspace. Modes: - `set`: switch to target, keep previous stack unchanged. - `push`: switch to target and save the incoming context as previous. - `pop`: restore the previous context. `target` supports `${workspaceRoot}`, `${pipelineWorkspace}`, `${flowDir}`, absolute paths, and paths relative to current workspace context.
- Runtime: local-only
- Inputs: 0. `prev`:node; 1. `target`:text = ${pipelineWorkspace}; 2. `mode`:text = set; 3. `label`:text; 4. `workspaceContext`:text
- Outputs: 0. `next`:node; 1. `workspaceContext`:text; 2. `cwd`:file; 3. `previous`:text

### control_deadline

- Display: Deadline
- Description: Compute whether a deadline has expired. Use expired output with control_if.
- Runtime: local-only
- Inputs: 0. `prev`:node; 1. `startAt`:text; 2. `duration`:text; 3. `deadlineAt`:text; 4. `timezone`:text = Asia/Shanghai
- Outputs: 0. `next`:node; 1. `expired`:bool; 2. `deadlineAt`:text

### control_delay

- Display: Delay
- Description: Persistently wait for a relative duration, then continue when scheduler resumes this run.
- Runtime: local-only
- Inputs: 0. `prev`:node; 1. `duration`:text = 10m
- Outputs: 0. `next`:node; 1. `wakeAt`:text

### control_end

- Display: End
- Description: End point of AgentFlow, flow terminates after this node
- Runtime: local-only
- Inputs: 0. `prev`:node
- Outputs: 无

### control_if

- Display: If
- Description: Has exactly one bool type input. Continues to next1 if true, next2 if false
- Runtime: local-only
- Inputs: 0. `prev`:node; 1. `prediction`:bool
- Outputs: 0. `next1`:node; 1. `next2`:node

### control_interval_loop

- Display: IntervalLoop
- Description: Wait by interval and branch to continue, done, timeout, or cancelled for watch-style flows.
- Runtime: local-only
- Inputs: 0. `prev`:node; 1. `done`:bool; 2. `cancelled`:bool; 3. `interval`:text = 10m; 4. `startAt`:text; 5. `duration`:text; 6. `deadlineAt`:text; 7. `timezone`:text = Asia/Shanghai
- Outputs: 0. `continue`:node; 1. `done`:node; 2. `timeout`:node; 3. `cancelled`:node; 4. `wakeAt`:text; 5. `expired`:bool; 6. `deadlineAt`:text

### control_load_skills

- Display: Load Skills
- Description: Load SKILL.md files from the current workspace context, pipeline workspace, explicit paths, or both. The output `skillsContext` can be connected to downstream agent nodes. Loaded skills are injected into the node prompt under "已加载 Skills". Sources: - `current-workspace` - `pipeline-workspace` - `explicit-paths` - `all` Merge modes: - `replace` - `append` - `prepend`
- Runtime: local-only
- Inputs: 0. `prev`:node; 1. `source`:text = current-workspace; 2. `paths`:text; 3. `include`:text; 4. `exclude`:text; 5. `mergeMode`:text = replace; 6. `workspaceContext`:text; 7. `skillsContext`:text
- Outputs: 0. `next`:node; 1. `skillsContext`:text; 2. `loadedCount`:text; 3. `summary`:text

### control_start

- Display: Start
- Description: Entry point of AgentFlow, all flows should start from this node
- Runtime: local-only
- Inputs: 无
- Outputs: 0. `next`:node

### control_toBool

- Display: ToBool
- Description: Script-based boolean conversion: executes script to produce true/false prediction. Like tool_nodejs but enforces bool output. Must have script field.
- Runtime: agent/runner
- Inputs: 0. `prev`:node; 1. `value`:text
- Outputs: 0. `next`:node; 1. `prediction`:bool

### control_wait_until

- Display: WaitUntil
- Description: Persistently wait until an absolute time, then continue when scheduler resumes this run.
- Runtime: local-only
- Inputs: 0. `prev`:node; 1. `until`:text; 2. `timezone`:text = Asia/Shanghai
- Outputs: 0. `next`:node; 1. `wakeAt`:text

## tool

### tool_get_env

- Display: GetEnv
- Description: Get environment variable value
- Runtime: agent/runner
- Inputs: 0. `key`:text
- Outputs: 0. `value`:text

### tool_git_checkout

- Display: Git Checkout
- Description: Clone or update a Git repository and expose it as a workspace context for downstream nodes. - `repoUrl` is required. - `targetDir` may be absolute or relative to the current workspace context. - If `targetDir` is empty, the repository is cloned into `${pipelineWorkspace}/.workspace/agentflow/git-repos/<repo-name>`. - Set `includeSubmodules` to `true` to clone/update Git submodules recursively. - The `workspaceContext` output can be connected to CD Workspace, Load Skills, agent, or tool nodes.
- Runtime: local-only
- Inputs: 0. `prev`:node; 1. `repoUrl`:text; 2. `branch`:text; 3. `targetDir`:text; 4. `pullIfExists`:bool = true; 5. `includeSubmodules`:bool = false; 6. `workspaceContext`:text
- Outputs: 0. `next`:node; 1. `repoPath`:file; 2. `branch`:text; 3. `commit`:text; 4. `changed`:bool; 5. `workspaceContext`:text

### tool_load_key

- Display: LoadKey
- Description: Load key-value from global storage
- Runtime: agent/runner
- Inputs: 0. `prev`:node; 1. `key`:text
- Outputs: 0. `next`:node; 1. `result`:text

### tool_nodejs

- Display: NodeJs
- Description: Execute Node.js script via agentflow apply -ai run-tool-nodejs. **Success/Failure:** Determined by script process **exit code**—0 = success, non-0 = failed. **Result Output:** Script stdout directly becomes result slot content (plain text, e.g., `console.log("hello")`). When stdout is empty and exit code is non-0, stderr info will be written to failure message. **JSON Compatible (Optional):** If stdout is `{"err_code":0,"message":{"result":"..."}}` format, err_code will override exit code semantics, message.result writes to result slot. Only use when needing different success/failure semantics than exit code. **Direct Execution Mode (Recommended):** Set `script` field in flow.yaml instance, pipeline will skip AI and execute directly. `script` supports ${} placeholders (workspaceRoot, pipelineWorkspace, flowName, runDir, flowDir and all input/output slots), values are auto shell-quoted. When a CD Workspace node is connected, `workspaceRoot` is the current execution workspace; `pipelineWorkspace` is the original pipeline workspace. flowDir is absolute path of current pipeline flow.yaml directory, can be used to reference scripts in same directory. Example: `script: node ${flowDir}/scripts/my-check.mjs --root ${workspaceRoot} --input ${todo}` **Pin Path Constraint (Important):** File paths read/written by script **must be passed via pins**, forbidden to construct output paths inside script. - All input slots with type 'file' (e.g., `figma_tree`, `semantic_outline`) are parsed from upstream connections by pipeline, script receives via CLI args. - All output slots with type 'file' (e.g., `restore_todolist`, `screenshot_map`) are generated by pipeline as absolute paths following `output/<instanceId>/node_<instanceId>_<slot>.md` convention, script receives via CLI args and writes directly. - Use `${slotName}` in `script` field to get correct path, e.g., `--figma-tree ${figma_tree} --output ${restore_todolist}`. - **Forbidden** to use `outDirForNode`, manually write `node_<instance>_xxx.json` etc. in script—this causes script output path mismatch with pipeline parser convention, downstream nodes cannot find files. **AI Execution Mode (Legacy):** Without `script` field, AI agent reads body and manually executes commands. **Underlying Usage:** agentflow apply -ai run-tool-nodejs <workspaceRoot> <flowName> <uuid> <instanceId> [execId] -- <scriptCmd> [args...]
- Runtime: direct script when script exists, otherwise agent
- Inputs: 0. `prev`:node; 1. `workspaceContext`:text; 2. `skillsContext`:text
- Outputs: 0. `next`:node; 1. `result`:text

### tool_print

- Display: Print
- Description: Output content to user with special font style
- Runtime: local-only
- Inputs: 0. `prev`:node; 1. `content`:text
- Outputs: 0. `next`:node

### tool_save_key

- Display: SaveKey
- Description: Save key-value pair to global storage
- Runtime: agent/runner
- Inputs: 0. `prev`:node; 1. `key`:text; 2. `value`:text
- Outputs: 0. `next`:node

### tool_user_ask

- Display: UserAsk
- Description: 等待用户从多个选项中选择一个，流程暂停；按用户选择沿对应出边分支继续。每个 output 槽位对应一条分支，槽位的 description 作为选项文案。
- Runtime: local-only
- Inputs: 0. `prev`:node; 1. `question`:file
- Outputs: 0. `option_0`:node; 1. `option_1`:node

### tool_user_check

- Display: UserCheck
- Description: 等待用户确认，流程暂停。展示确认内容给用户，用户可编辑/AI修改后保存，回复 "继续" 后重启流程。
- Runtime: local-only
- Inputs: 0. `prev`:node; 1. `content`:file
- Outputs: 0. `next`:node; 1. `content`:file

## provide

### provide_file

- Display: File
- Description: Provide file path or content directly, value will be passed to downstream as-is
- Runtime: local-only
- Inputs: 无
- Outputs: 0. `value`:file

### provide_str

- Display: String
- Description: Provide a text value directly, value will be passed to downstream as-is
- Runtime: local-only
- Inputs: 无
- Outputs: 0. `value`:text
