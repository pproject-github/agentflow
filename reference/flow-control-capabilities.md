# AgentFlow 常见流程控制能力

本文档供 AI 参考：Workspace 图中常用的控制节点及其用法、连线方式与典型模式。

**说明**：下文中的 handle（如 input-0、output-1）是**可变的**，由节点类或 instance 的 input/output 列表顺序决定；若槽位顺序有变动，须以实际 definition/instance 的 frontmatter 为准。

**约定**：内置节点（nodes 目录下的节点类）的 **description** 字段语义为 **agentSystemPrompt**（供执行时作为 agent 的系统 prompt），**不应被修改**；instance 中可覆盖或扩展用户区内容，但不改变该语义。

---

## 1. 入口

| 节点 | definitionId | 作用 |
|------|--------------|------|
| **Run** | workspace_run | 手动运行的入口。点 Run 时从它沿控制边向下游展开。 |
| **Scheduled Run** | workspace_scheduled_run | 定时运行的入口，按 cron 配置触发。 |

图不需要出口节点——控制链走到尽头即结束。

**旧版 `control_start` / `control_end` 已下线**，不要新增。

---

## 2. 条件分支（If）

- **control_if**：单节点双分支。根据 **prediction**（bool）：为 true 时沿 **next1**（output-0）继续，为 false 时沿 **next2**（output-1）继续。适用于「二选一」分支。

**典型用法**：上游接 **provide_bool**，把它的 bool 输出连到 If 的 **input-1**（prediction），再把两个分支分别连到 output-0 / output-1。

**control_if Handle**：
- input: prev → input-0, prediction → input-1
- output: next1 → output-0（条件为真时）, next2 → output-1（条件为假时）

---

## 3. 图必须是 DAG（无环），重复执行用 control_while

Workspace 运行计划做拓扑排序，**遇到环直接抛 `Workspace run graph contains a cycle`**，整次运行失败。

因此：

- **禁止**从下游节点连边回到上游节点。
- 「检查 → 修复 → 复检」涉及不同角色时要**向前展开**成多个节点，而不是回流成环。
- 同一个确定性动作需要反复推进时，用 `control_while`。它在单节点状态机里重复 step 命令，
  父图仍是 DAG；`continue` 继续、`wait` 暂停且不跑下游、`done` 放行下游、`fail` 失败。

step 的 stdout 必须严格是一个 JSON 对象：

```json
{"decision":"continue|wait|done|fail","state":{},"summary":"本轮摘要"}
```

循环上下文通过 `AGENTFLOW_WHILE_STATE`、绝对轮次 `AGENTFLOW_WHILE_ITERATION`、
`AGENTFLOW_WHILE_MAX_ITERATIONS`、`AGENTFLOW_WHILE_TIMEOUT_MS` 和稳定的逐轮
`AGENTFLOW_WHILE_IDEMPOTENCY_KEY` 注入。外部写操作应尽量把该幂等键传给目标 API。stdout
留给决策对象，普通进度写 stderr。`maxIterations` 默认 20，`timeout` 默认 30m，二者在
`wait` 后恢复时继续累计；checkpoint 同时保留 state、history、已用执行时间和下一轮编号。
输入变化会重置 checkpoint，指纹匹配但 checkpoint 损坏时会拒绝恢复，避免静默重放副作用。

旧版用于成环的 `control_anyOne` / `control_toBool` / `control_agent_toBool` / `control_interval_loop` 均已下线。

---

## 4. 子流程（Subflow）

可复用的一段节点拓扑用 `flow.input`、`flow.subflow` 和 `flow.call` 表达。子流程内部继续使用
标准 AgentFlow 节点与边，父流程只连接调用节点的契约引脚；禁止跨边界直接连内部节点。

每次调用拥有独立 `callFrameId`，内部事件同时带 `parentNodeId` 和 `subflowId`。禁止递归调用。
当前第一版不支持子流程内部 `wait/deferred`，遇到会明确失败；可恢复调用栈补齐后再开放。

---

## 5. 展示结果（Display）

把产出槽连到 `display_*` 节点的 `content` 输入即可在画布上渲染：

| definitionId | 内容形态 |
|--------------|----------|
| display_markdown | Markdown 正文 |
| display_html | 可直接放进 iframe 的 HTML |
| display_react_app | React 工程 JSON（title / entry / files） |
| display_table | `{"columns":[...],"rows":[...]}` |
| display_chart | ChartSpec JSON |
| display_mermaid | Mermaid 图表代码 |
| display_ascii | 纯文本 / ASCII 图 |
| display_image | 图片地址、data URL 或 base64 |

**旧版 `tool_print` 已下线**，改用 `display_markdown`。

---

## 6. 工具节点与 Agent 节点选型

**核心原则：能用工具节点确定性执行的，不要用 agent_subAgent。**

| 场景 | 推荐节点 | 原因 |
|------|----------|------|
| 执行已知命令/脚本（文件操作、数据处理等） | **tool_nodejs** + `script` 字段 | 直接执行，零 LLM 调用，毫秒级完成 |
| 向用户展示结果 | **display_\*** | 专用展示节点 |
| 需要 AI 理解上下文、做判断、生成内容 | **agent_subAgent** | 需要 LLM 推理能力 |

### 6.1 tool_nodejs 直接执行模式（推荐）

在 instance 中设置 `script` 字段，运行时**跳过 AI 直接 spawn 命令**：

```yaml
write_summary:
  definitionId: tool_nodejs
  label: 写摘要
  script: node ${flowDir}/scripts/write-summary.mjs --input ${value} --output ${summary}
  input:
    - { type: node, name: prev, value: '' }
    - { type: text, name: value, value: '' }
  output:
    - { type: node, name: next, value: '' }
    - { type: text, name: result, value: '' }
    - { type: file, name: summary, value: '' }
```

- `script` / `scriptRef` 支持 `${}` 占位符：`workspaceRoot` / `pipelineWorkspace` / `flowDir`（三者都解析为当前 scoped workspace 根）、`cwd`、`nodeRunDir`、`nodeTmpDir`、`outputsDir`、`scriptRef`，以及**所有 input / output 槽位名**。值自动 shell-quote，不要自己加引号。
- 适用于：运行已有脚本、文件复制/移动、数据格式转换等**确定性操作**。
- **成败判定**：以脚本进程 **exit code** 为准（0 = success，非 0 = failed）。
- **stdout → result**：脚本 stdout 直接作为 result 槽位内容，纯文本即可。**不要用 JSON 封装 stdout。**

### 6.2 判断标准

问自己：**"这个步骤的行为是否完全由输入决定，不需要 AI 推理？"**

- **是** → 用 `tool_nodejs` + `script`
  - 例：跑一个已有的 `.mjs` 脚本、格式化 JSON、复制产物
- **否** → 用 `agent_subAgent`
  - 例：根据需求撰写文档、分析代码并提出修改方案、理解上下文后做决策

### 6.3 `script` 与 `body` 的职责（必须遵守）

| 字段 | 职责 | 有 `script` 时 | 无 `script` 时 |
|------|------|---------------|---------------|
| `script` | 实际执行的 shell/node 命令 | 运行时直接 spawn 执行 | — |
| `body` | 纯文档说明（供人类阅读） | **完全忽略**，不参与执行 | 节点无法执行，必须改用 agent_subAgent |

**约束规则**：
1. `tool_nodejs` **必须写 `script` 或 `scriptRef`**，内容为完整可执行的命令
2. `script` 中的 `${}` 占位符自动 shell-quote，引用 input/output 槽位或运行时常量
3. **`script` 必须引用所有非 node 类型的 input 和 output 引脚**（validate-flow 硬性校验）：
   - input 引脚 `${slotName}` → 解析为上游数据值或文件路径
   - output 引脚 `${slotName}` → 解析为 output 文件的绝对路径，脚本应 `fs.writeFileSync(path, value)` 直接写入
   - **禁止使用 JSON stdout 封装**，用 exit code 0/非 0 决定成败
4. `body` 可选，仅用于文档说明，**禁止写期望被执行的逻辑**
5. 如果无法写出完整可执行的 `script`（需要 AI 理解/判断），**必须改用 `agent_subAgent`**
6. `script` 支持多行（YAML `|` 语法）和管道组合
7. **`scripts/` 下的脚本必须写成 `${flowDir}/scripts/xxx.mjs`**，不要硬编码 workspace 路径

**错误示范**（校验将报错）：
```yaml
# ❌ tool_nodejs 无 script，body 写自然语言 → 节点无法执行
bad_example:
  definitionId: tool_nodejs
  label: 获取数据
  body: |
    调用 API 获取数据，解析 JSON，提取关键字段保存到文件
```

### 6.4 常见误用

| 用户需求 | 错误做法 | 正确做法 |
|----------|----------|----------|
| 展示一段结果 | agent_subAgent + body 描述展示任务 | 产出槽连到 `display_markdown.content` |
| 执行已有脚本 | agent_subAgent + body 要求运行脚本 | tool_nodejs + `script: node ${flowDir}/scripts/xxx.mjs` |
| 注入密钥 | 写死在 flow 里 | `tool_set_run_env` 或运行时环境变量 |
| 复杂 AI 推理/生成 | tool_nodejs + body 写自然语言 | agent_subAgent（需 LLM 能力时必须用 agent） |

### 6.5 节点单一职责（必须遵守）

**每个节点只做一件事，工作内容保持专注和专一。**

- **不要把多个无关操作塞进同一个节点的 `body`**。如果一个任务包含多个可独立完成的步骤，应拆分为多个节点，通过边串联或并行。
- **每个 agent_subAgent 的 body 应聚焦于单一目标**：写一个文件、分析一段代码、做一次决策等。不要在一个 body 里要求"先做 A，再做 B，最后做 C"。
- **拆分的好处**：
  - 可调试：单个节点失败时容易定位问题
  - 可复用：拆出的节点可被其他流程引用
  - 可并行：无依赖的步骤拆开后可自动并行执行
  - AI 质量更高：小而明确的任务比大而模糊的任务生成质量更好

**示例**：用户要求"分析代码并生成测试"

| 做法 | 结构 |
|------|------|
| **错误**：一个 agent 节点，body 写"先分析代码找出关键函数，然后为每个函数写单元测试" | 单节点承担分析 + 生成两个职责 |
| **正确**：节点 A（分析代码，输出关键函数列表）→ 节点 B（根据函数列表生成测试） | 每个节点职责清晰、输入输出明确 |

---

## 7. 常见流程模式

1. **线性链**：Run → A → B → … → display
2. **条件分支**：… → provide_bool → **control_if** → next1 连分支A、next2 连分支B（true 走 output-0，false 走 output-1）
3. **控制扇出**：同一个 output 扇出到多个下游节点；当前 Workspace 运行时按拓扑序串行执行
4. **单步收敛**：Run → control_while（重复同一 step）→ 下游；wait 时停在 While
5. **检查 → 修复 → 复检**：不同角色向前排成多个节点。**不要连回上游**
6. **批量任务**：拆解节点产出清单 → control_while 每轮推进一项 → done 后汇总

---

## 8. Edge 与 Handle 注意点

- **Fan-out 允许，Fan-in 禁止**：一个 output handle 可连多个 input（扇出），但**一个 input handle 只允许一条入边**（禁止扇入）。同一 `target + targetHandle` 不得出现在多条 edge 中——运行时仅取首条匹配，其余静默丢失。若需替换连线，先删旧边再加新边。
- **禁止回流边**：任何从下游连回上游的边都会让运行计划判定成环，整次运行失败。
- 条件/分支节点有多输入时，必须在 edge 上写清 **targetHandle**（如 prediction 用 input-1）。
- 从 `provide_bool` 的 bool 输出连到 `control_if` 时：targetHandle 用 **input-1**。
- 多输出节点连到不同下游时，用不同 **sourceHandle**（output-0, output-1, …）区分槽位。
- **control_if** 必须写清：从 output-0 连到「条件为真」的后继、从 output-1 连到「条件为假」的后继。

---

## 9. 图与 USER_PROMPT 的读写一致性

${USER_PROMPT} 中描述的「读取」「写入」应与图中的 **handler 节点**（input/output 通过 edge 连接的节点）对应：描述的每项「读」应有节点的 input 入边，每项「写」应有节点的 output 出边。详见 [flow-prompt-handler-check.md](./flow-prompt-handler-check.md)。
