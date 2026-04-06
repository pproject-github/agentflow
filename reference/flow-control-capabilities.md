# AgentFlow 常见流程控制能力

本文档供 AI 参考：流程中常用的控制节点及其用法、连线方式与典型模式。

**说明**：下文中的 handle（如 input-0、output-1）是**可变的**，由节点类或 instance 的 input/output 列表顺序决定；若槽位顺序有变动，须以实际 definition/instance 的 frontmatter 为准。

**约定**：内置节点（nodes 目录下的节点类）的 **description** 字段语义为 **agentSystemPrompt**（供执行时作为 agent 的系统 prompt），**不应被修改**；instance 中可覆盖或扩展用户区内容，但不改变该语义。

---

## 1. 入口与出口

| 节点 | definitionId   | 作用 |
|------|----------------|------|
| **Start** | control_start | 流程唯一入口，无 input，只有 output `next`（output-0）。所有边从 start 连出到第一个执行节点。 |
| **End**   | control_end   | 流程唯一出口，只有 input `prev`（input-0），无 output。所有最终节点连到 end。 |

**约定**：每个 flow 必须包含且仅包含一个 control_start、一个 control_end。

---

## 2. 条件分支（If）

- **control_if**：单节点双分支。根据 **prediction**（bool）：为 true 时沿 **next1**（output-0）继续，为 false 时沿 **next2**（output-1）继续。适用于「二选一」分支。

**典型用法**：上游接一个能输出布尔值的节点（如 **control_toBool** 或 agent 输出 bool），把布尔槽位连到 If 的 **input-1**（prediction），再根据需要连到不同分支。

**control_if Handle**：
- input: prev → input-0, prediction → input-1  
- output: next1 → output-0（条件为真时）, next2 → output-1（条件为假时）

---

## 3. 转布尔（ToBool）

- **definitionId**: control_toBool  
- **作用**：将上游的 **value**（文本等）转为布尔结果，写入 **prediction**，供 If 使用。

**Handle**：
- input: prev → input-0, value → input-1  
- output: next → output-0, prediction → output-1  

常见：上游为 agent 或 tool 输出一段文本，ToBool 解析后得到 true/false，再连到 If 的 prediction。

**约定**：写入 **prediction**（output-1）的**文件内容必须仅为 true 或 false**，供下游 control_if 等解析；不得写入长文本或 markdown 报告。

---

## 4. 多路汇合（AnyOne）

- **definitionId**: control_anyOne  
- **作用**：多个上游分支中**任意一个**就绪（success）时，即从 **next** 继续，常用于「多路并行、任一路完成即进入下一步」的场景。

**Handle**：
- input: prev1 → input-0, prev2 → input-1（可扩展更多输入槽位时按 input-2, input-3… 约定）  
- output: next → output-0  

---

## 5. 全局存储与环境（LoadKey / SaveKey / GetEnv）

用于**当前 flow 在一次 run 内的全局信息保存与读取**：按 key 在 run 目录下的 memory 存储中写入或读取文本，供多节点共享状态、跨分支传递结果。**GetEnv** 从系统环境变量与用户目录 `~/.cursor/config.json` 按 key 读取，用于注入 API Key、工作区配置等。

| 节点 | definitionId   | 作用 |
|------|----------------|------|
| **LoadKey** | tool_load_key | 按 **key** 从当前 run 的存储中读取一个值，结果输出到 **result** 槽位，可连到下游节点的 input。 |
| **SaveKey** | tool_save_key | 按 **key** 将 **value** 写入当前 run 的存储；value 可为字面文本，或 run 内相对路径（如 `output/node_xxx_result.md`），脚本会读文件内容后写入。 |
| **GetEnv** | tool_get_env | 按 **key** 从系统环境变量与 `~/.cursor/config.json` 读取一个值（优先环境变量）；key 支持点号路径如 `openai.apiKey` 读取 config 嵌套字段；结果输出到 **value** 槽位。 |

**Handle**：

- **LoadKey**  
  - input: prev → input-0, key → input-1  
  - output: next → output-0, result → output-1  
- **SaveKey**  
  - input: prev → input-0, key → input-1, value → input-2  
  - output: next → output-0  
- **GetEnv**
  - input: key → input-0
  - output: value → output-0

**典型用法**：

1. **保存后再读**：某节点产出结果 → SaveKey（key 固定如 `flowName`，value 接上游 output）→ 下游分支中 LoadKey（同一 key）→ result 连到后续 agent/tool。
2. **跨分支共享**：并行分支中一路用 SaveKey 写入（如「选中的方案名」），汇合后或另一分支用 LoadKey 读取，保证全 flow 看到同一份全局信息。
3. **占位符**：instance 中 key/value 可写占位符（如 `${output/node_plan_result.md}`），由 apply 在 resolvedInputs 中解析后传入脚本。
4. **环境/配置注入**：GetEnv（key 如 `OPENAI_API_KEY` 或 `openai.apiKey`）→ value 连到下游 agent 的 input，用于从环境或 `~/.cursor/config.json` 读取密钥或配置，避免写死在 flow 中。

存储由 apply 通过 `agentflow apply -ai run-tool-nodejs` 调用 load-key/save-key 实现；GetEnv 由 `agentflow apply -ai get-env <workspaceRoot> <flowName> <uuid> <instanceId> <execId> <key>` 直接执行，run 上下文通过命令行参数传入，不再经 run-tool-nodejs。LoadKey/SaveKey 数据仅在**当前 run**（同一 uuid 的 `~/agentflow/runBuild/<FlowName>/<uuid>/`）内有效；GetEnv 读取的是系统环境与用户级 `~/.cursor/config.json`，不随 run 隔离。

---

## 6. 工具节点与 Agent 节点选型

**核心原则：能用工具节点确定性执行的，不要用 agent_subAgent。**

| 场景 | 推荐节点 | 原因 |
|------|----------|------|
| 执行已知命令/脚本（打印、文件操作、数据处理等） | **tool_nodejs** + `script` 字段 | 直接执行，零 LLM 调用，毫秒级完成 |
| 向用户输出醒目信息 | **tool_print** | 专用输出节点 |
| 需要 AI 理解上下文、做判断、生成内容 | **agent_subAgent** | 需要 LLM 推理能力 |

### 6.1 tool_nodejs 直接执行模式（推荐）

在 instance 中设置 `script` 字段，流水线**跳过 AI 直接执行命令**：

```yaml
print_hello:
  definitionId: tool_nodejs
  label: 打印Hello
  script: node -e "console.log(${value})"
  input:
    - type: 节点
      name: prev
      value: ''
    - type: 文本
      name: value
      value: ''
  output:
    - type: 节点
      name: next
      value: ''
    - type: 文本
      name: result
      value: ''
```

- `script` 支持 `${}` 占位符（workspaceRoot、flowName、runDir 及所有 input 槽位），值自动 shell-quote。
- 适用于：打印文本、运行已有脚本、文件复制/移动、数据格式转换等**确定性操作**。
- input 可按需添加额外的文本/文件槽位（如上例的 `value`），供 `script` 中 `${value}` 引用。
- **成败判定**：以脚本进程 **exit code** 为准（0 = success，非 0 = failed）。
- **stdout → result**：脚本 stdout 直接作为 result 槽位内容，纯文本即可（如 `console.log("hello")`）。
- **JSON 兼容（可选）**：stdout 为 `{"err_code":0,"message":{"result":"..."}}` 时，err_code 覆盖 exit code 语义——仅在需要与 exit code 不同的成败语义时使用。

### 6.2 判断标准

问自己：**"这个步骤的行为是否完全由输入决定，不需要 AI 推理？"**

- **是** → 用 `tool_nodejs` + `script`，或 `tool_print`
  - 例：打印一段文字、执行 `agentflow apply -ai validate-flow`、跑一个已有的 `.mjs` 脚本
- **否** → 用 `agent_subAgent`
  - 例：根据需求撰写文档、分析代码并提出修改方案、理解上下文后做决策

### 6.3 `script` 与 `body` 的职责（必须遵守）

| 字段 | 职责 | 有 `script` 时 | 无 `script` 时 |
|------|------|---------------|---------------|
| `script` | 实际执行的 shell/node 命令 | 流水线直接 spawn 执行 | — |
| `body` | 纯文档说明（供人类阅读） | **完全忽略**，不参与执行 | 作为 AI 指令兜底（AI 执行模式） |

**约束规则**：
1. `tool_nodejs` **必须写 `script` 字段**，内容为完整可执行的命令
2. `script` 中的 `${}` 占位符自动 shell-quote，引用 input 槽位或系统变量
3. `body` 可选，仅用于文档说明，**禁止写期望被执行的逻辑**
4. 如果无法写出完整可执行的 `script`（需要 AI 理解/判断），**必须改用 `agent_subAgent`**
5. `script` 支持多行（YAML `|` 语法）和管道组合

**复杂脚本示例（API 调用 + JSON 处理）**：

```yaml
fetch_user_list:
  definitionId: tool_nodejs
  label: 获取用户列表
  script: |
    curl -s -H "Authorization: Bearer ${token}" "${apiUrl}/users" | node -e "
      let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
        const res=JSON.parse(d);
        console.log(JSON.stringify(res.data.map(u=>({id:u.id,name:u.name}))));
      });"
  body: |
    调用 API 获取用户列表并提取 id 和 name
  input:
    - { type: 节点, name: prev, value: '' }
    - { type: 文本, name: apiUrl, value: '' }
    - { type: 文本, name: token, value: '' }
  output:
    - { type: 节点, name: next, value: '' }
    - { type: 文本, name: result, value: '' }
```

**错误示范**（校验将报 warning）：
```yaml
# ❌ tool_nodejs 无 script，body 写自然语言 → 节点无法正确执行
bad_example:
  definitionId: tool_nodejs
  label: 获取数据
  body: |
    调用 API 获取数据，解析 JSON，提取关键字段保存到文件
```

### 6.4 常见误用

| 用户需求 | 错误做法 | 正确做法 |
|----------|----------|----------|
| 打印一段文字 | agent_subAgent + body 描述打印任务 | tool_nodejs + `script: node -e "console.log(${value})"` |
| 执行已有脚本 | agent_subAgent + body 要求运行脚本 | tool_nodejs + `script: node scripts/xxx.mjs` |
| 读取环境变量 | agent_subAgent + body 要求读环境变量 | tool_get_env（专用节点） |
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

## 7. 常见流程模式简述

1. **线性链**：Start → A → B → … → End  
2. **条件分支**：  
   - **单节点 If**：… → ToBool → **control_if** → next1 连分支A、next2 连分支B（true 走 output-0，false 走 output-1）。  
3. **多路任一**：分支1、分支2 均连到 AnyOne（prev1/prev2），AnyOne 的 next 再连到后续或 End。  
4. **用户确认**：在需要暂停处插入 **tool_user_check**，用户确认后再继续。  
5. **全局存储**：用 **SaveKey** 写入、**LoadKey** 读取当前 flow 的全局信息（见上节）。  
6. **检查 → 修改 → 检查 → 修改**：见下节。

---

### 8 入环 → 检查 → 修复 → 检查 → 修复 → 检查 → 出环

该流程可概括为：**入环 → 检查 → 修复 → 检查 → 修复 → … → 检查通过 → 出环**。参考 **builtin/pipelines/module-migrate** 的连线方式。

- **入环**：用 **control_anyOne** 汇合两条路——「首次进入」与「上一轮修复完成后再检查」。prev1 / prev2 任一路就绪即从 next 继续，进入**检查**。
- **检查**：执行检查节点（可并行、可汇总），结果经 **control_toBool** 转为布尔，再接到 **control_if**。
- **分支**：**control_if** 的 next1（true，通过）→ 出环到后续或 End；next2（false，未通过）→ 进入**修复**。
- **修复**：修复节点消费检查结果，修改后通过边回到「检查」上游或回到 **AnyOne** 的 prev2，形成环；可再套一层 ToBool + If 判断「是否修完」，未修完再修复、修完再回检查。
- **出环**：当 **control_if** 为 true 时，从 next1 连到环外节点，不再回到 AnyOne。

要点：**AnyOne** 做入环/复入环汇合；**ToBool + If** 做通过/未通过二选一；未通过 → 修复 → 回到检查或 AnyOne（成环）；通过 → 连到环外即出环。

---

## 9. Edge 与 Handle 注意点

- 条件/分支节点有多输入时，必须在 edge 上写清 **targetHandle**（如 prediction 用 input-1）。  
- 从 ToBool 的 prediction 连到 If（control_if）时：sourceHandle 用 **output-1**，targetHandle 用 **input-1**。  
- 多输出节点连到不同下游时，用不同 **sourceHandle**（output-0, output-1, …）区分槽位。
- **control_if** 必须写清：从 output-0 连到「条件为真」的后继、从 output-1 连到「条件为假」的后继，否则 get-ready-nodes 无法正确解锁分支。

---

## 10. 图与 USER_PROMPT 的读写一致性

${USER_PROMPT} 中描述的「读取」「写入」应与图中的 **handler 节点**（input/output 通过 edge 连接的节点）对应：描述的每项「读」应有节点的 input 入边，每项「写」应有节点的 output 出边。详见 [flow-prompt-handler-check.md](./flow-prompt-handler-check.md)。
