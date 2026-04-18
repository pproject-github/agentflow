---
name: agentflow-flow-add-instances
description: >-
  向 AgentFlow 的 flow.yaml 新增实例：说明 instances/edges/ui 的 YAML 结构、
  从内置定义拷贝 instance、设计连接点与内容；新增节点的 ui.nodePositions
  默认放在画布视觉中心附近。不用于仅改已有节点文案或占位值。
---

# AgentFlow：新增 instances

在 **向现有 flow 增加新节点（一个或多个）** 时使用本技能。

**路径说明**：`npx skills add` 后本文件不在 AgentFlow 仓库内；文中 `reference/`、`builtin/` 均相对 **AgentFlow 仓库根目录**，请在以该仓库为工作区时打开文件。

**权威参考**（仓库根）：

- `reference/flow-control-capabilities.md` — handle、边、控制节点语义  
- `reference/flow-layout.md` — 整体布局原则（本技能对「新增」默认用**中心落点**，再按需微调）  
- `reference/flow-prompt-handler-check.md` — 增边后 USER_PROMPT 与 handler 一致  

---

## flow.yaml 顶层结构

```yaml
instances:
  <instanceId>:
    definitionId: <内置或已存在定义 id>
    label: ...
    role: ...
    input: [ { type, name, value }, ... ]
    output: [ { type, name, value }, ... ]
    script: <可选，tool_nodejs 直接执行的命令，支持 ${} 占位符>
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
      'y': <number>
  description: 可选
```

- **`instances`**：键为 **instanceId**（全图唯一），值为该次运行的节点实例；**不要**写 **`description`**（系统说明由 `definitionId` 对应节点 `.md` 的 frontmatter 提供）。  
- **`script`**（仅 `tool_nodejs`）：指定直接执行的命令，流水线将跳过 AI 直接运行 `run-tool-nodejs` 执行。支持 `${workspaceRoot}`、`${flowName}`、`${runDir}`、`${flowDir}` 及所有 input 槽位占位符，值自动 shell-quote。**引用 flow 自带脚本必须用 `${flowDir}/scripts/xxx.mjs`**（`${flowDir}` 指向 flow 当前所在目录，兼容 user/workspace/builtin 三种安装位置），**禁止**硬编码 `${workspaceRoot}/.workspace/agentflow/pipelines/${flowName}/scripts/...`（flow 安装到 `~/agentflow/pipelines/` 或 builtin 时会 Cannot find module）。脚本 stdout 须输出 `{"err_code":0,"message":{"result":"..."}}`。无 `script` 时回退到 AI 执行。  
- **`edges`**：有向边；多输入/多输出必须写对 **`targetHandle` / `sourceHandle`**（见下表）。  
- **`ui.nodePositions`**：编辑器坐标；**每个新 instanceId 必须新增一项**，否则画布会堆叠。

---

## 节点类型选择（必读）

新增实例时，**首先判断该步骤应使用哪种节点类型**。核心原则：**能用 tool 节点确定性执行的，不要用 agent_subAgent。**

| 判断条件 | 推荐 definitionId | 说明 |
|----------|-------------------|------|
| 行为完全由输入决定，不需要 AI 推理 | **tool_nodejs** + `script` 字段 | 打印文本、运行已有脚本、文件操作、数据转换等 |
| 向用户输出醒目信息 | **tool_print** | 专用输出节点 |
| 需要 AI 理解上下文、做判断、生成内容 | **agent_subAgent** | 撰写文档、分析代码、理解语义后做决策 |

**tool_nodejs + script 示例**（打印文本）：

```yaml
print_haha:
  definitionId: tool_nodejs
  label: 打印哈哈哈
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

- `script` 支持 `${}` 占位符引用 input 槽位，值自动 shell-quote。
- input/output 须与 `tool_nodejs` 节点定义一致（prev/next + result），可按需添加额外文本/文件槽位供 `script` 引用。
- **成败判定**：以脚本进程 **exit code** 为准（0 = success，非 0 = failed）。
- **stdout → result**：脚本 stdout 直接作为 result 槽位内容，纯文本即可（如 `console.log("hello")`）。无需输出 JSON。
- **JSON 兼容（可选）**：stdout 为 `{"err_code":0,"message":{"result":"..."}}` 时，err_code 覆盖 exit code；仅旧脚本或需要特殊成败语义时使用。

**常见误用**：用 `agent_subAgent` 做「打印一段文字」「执行一个已知命令」「跑一个已有脚本」—— 这些都应该用 `tool_nodejs` + `script`。

### tool_nodejs 的 `script` 与 `body` 区分（关键规则）

| 字段 | 作用 | 执行时行为 |
|------|------|-----------|
| `script` | **实际执行的 shell/node 命令** | 流水线直接 spawn 执行，stdout 作为 result |
| `body` | **纯文档说明**（可选） | 有 `script` 时完全忽略；无 `script` 时作为 AI 指令（兜底） |

**关键约束**：
1. **`tool_nodejs` 必须写 `script` 字段**，内容为完整可执行的命令或脚本，禁止用自然语言描述
2. `script` 中可通过 `${}` 引用 input 槽位和系统变量，值自动 shell-quote
3. **`script` 必须引用所有非 node 类型的 input 和 output 引脚**（硬性校验，validate-flow 会报错）：
   - 所有 input 引脚（type ≠ node）必须在 script 中出现 `${slotName}`，用于接收上游数据
   - 所有 output 引脚（type ≠ node）必须在 script 中出现 `${slotName}`，系统将解析为 output 文件路径，脚本应直接 `fs.writeFileSync(path, value)` 写入
   - **禁止使用 JSON stdout 封装**（`{"err_code":0,"message":{...}}`），直接写文件、用 exit code 决定成败
4. `body` 仅用于给人类阅读的注释说明，**不会被执行**
5. 如果无法写出完整可执行的 `script`（如需要 AI 理解/判断），**必须改用 `agent_subAgent`**
6. **禁止**在 `script` 中写自然语言，**禁止**在 `body` 中写期望被执行的代码逻辑

### tool_nodejs 复杂脚本示例

**多行脚本（API 调用 + 数据处理）**：
```yaml
fetch_api_data:
  definitionId: tool_nodejs
  label: 调用API获取数据
  script: |
    curl -s -H "Authorization: Bearer ${token}" "https://api.example.com/data" | node -e "
      let d=''; process.stdin.on('data',c=>d+=c); process.stdin.on('end',()=>{
        const res=JSON.parse(d);
        const items=res.data.map(i=>({id:i.id,name:i.name}));
        console.log(JSON.stringify(items,null,2));
      });"
  body: |
    调用 Example API 获取数据列表并提取 id 和 name 字段
  input:
    - { type: 节点, name: prev, value: '' }
    - { type: 文本, name: token, value: '' }
  output:
    - { type: 节点, name: next, value: '' }
    - { type: 文本, name: result, value: '' }
```

**文件读写 + JSON 处理**：
```yaml
merge_json_files:
  definitionId: tool_nodejs
  label: 合并JSON
  script: |
    node -e "
      const fs=require('fs');
      const a=JSON.parse(fs.readFileSync(${fileA},'utf8'));
      const b=JSON.parse(fs.readFileSync(${fileB},'utf8'));
      console.log(JSON.stringify({...a,...b},null,2));
    "
  body: |
    合并两个 JSON 文件的内容
  input:
    - { type: 节点, name: prev, value: '' }
    - { type: 文件, name: fileA, value: '' }
    - { type: 文件, name: fileB, value: '' }
  output:
    - { type: 节点, name: next, value: '' }
    - { type: 文本, name: result, value: '' }
```

**错误示范**（禁止）：
```yaml
# ❌ 错误：tool_nodejs 却没有 script，body 是自然语言
bad_node:
  definitionId: tool_nodejs
  label: 获取截图
  body: |
    调用 Figma REST API 获取整体 UI 截图
    - 解析 figmaUrl 提取 fileKey
    - 调用 GET /v1/images/:fileKey 获取截图
    - 将截图保存到 ${result}
```
上例应改为：写出完整可执行的 `script`，或改用 `agent_subAgent`（由 AI 执行复杂操作）。

**节点单一职责**：**每个节点只做一件事，工作内容保持专注和专一。** 不要把多个无关操作塞进同一个 `body`。如果任务包含多个可独立完成的步骤，应拆分为多个节点通过边串联。例如"分析代码并生成测试"应拆为两个节点：节点 A 分析代码 → 节点 B 生成测试。拆分后可调试、可复用、可并行，AI 生成质量也更高。

详见 `reference/flow-control-capabilities.md` 第 6 节。

---

## 新增 instance 的步骤

1. 从 **`builtin/pipelines/new/flow.yaml`** 或同仓库已有 flow 中，拷贝**同类** `definitionId` 的实例块作为模板，改 **`instanceId`**、`label`，按需改 `body` / `value`。  
2. **不要**自造 `input`/`output` 的 **顺序、name、type**；须与节点类定义一致，否则 handle 索引会错。  
3. **默认不连线**：仅新增 `instances` 和 `ui.nodePositions`，**不写 `edges`**，重点关注节点内容与连接点的正确性设计。  
4. **仅当用户明确说「连线」「接到 X」「插入到 A 和 B 之间」等指令时**，才在 `edges` 中增加对应的边，并写 **`sourceHandle` / `targetHandle`**。  
5. 在 **`ui.nodePositions`** 中为该 instanceId 写入坐标（见下一节「屏幕中间」）。  
6. 每个 flow 仍只能有一个 **`control_start`**、一个 **`control_end`** 实例（勿重复新增入口/出口）。

**`control_toBool`**（本地确定性：parseBool 解析 true/1/yes/on → true，其余 → false，不调用 AI）和 **`control_agent_toBool`**（AI agent 语义判断，适用于不确定场景）的 prediction 输出文件内容必须仅为 **`true`** 或 **`false`**。

---

## Handle 速查（新增边时必填）

| definitionId | 常用 output | 常用 input |
|--------------|-------------|------------|
| control_start | next → output-0 | — |
| control_end | — | prev → input-0 |
| control_if | next1(**TRUE**) → output-0, next2(**FALSE**) → output-1 | prev → input-0, prediction → input-1 |
| control_toBool | next → output-0, prediction → output-1 | prev → input-0, value → input-1 |
| control_agent_toBool | next → output-0, prediction → output-1 | prev → input-0, value → input-1 |
| control_anyOne | next → output-0 | prev1 → input-0, prev2 → input-1 |
| tool_load_key | next → output-0, result → output-1 | prev → input-0, key → input-1 |
| tool_save_key | next → output-0 | prev → input-0, key → input-1, value → input-2 |
| tool_get_env | value → output-0 | key → input-0 |

**ToBool → If**：`output-1` → `input-1`（prediction）。**If**：`output-0` = 真分支，`output-1` = 假分支。

更多见 `reference/flow-control-capabilities.md` 第 8 节。

---

## 新增节点的 `ui.nodePositions`：放在屏幕中间

目标：新节点出现在画布**视区中心附近**，避免默认 (0,0) 挤在角落或与旧图重叠。

- **单个新节点**：使用中心基准，例如 **`x: 400`**、**`y: 300`**（可按项目里现有节点的 x/y 范围微调；若已有图，可取现有 `nodePositions` 的 **x、y 中位数** 作为中心再落点）。  
- **多个新节点（主链/线性）**：主链节点从左到右排列，每个节点 **x 递增 280**，y 保持一致：  
  `x: 100 + i * 280`，`y: 300`。  
- **分支节点**：分支的不同路径在 y 方向**错开 200**，例如 if 的两路分别 `y: 200` 和 `y: 400`。  
- **并行节点**：并行的节点保持相同 x，y 方向每个错开 200。  
- 后续若要融入主链/分支布局，再按 `reference/flow-layout.md` 做 x 递进、y 错开。

---

## 连线（仅用户明确要求时）

**Fan-out / Fan-in 规则**：  
- **一个 output 可连多个 input**（fan-out 允许）。  
- **一个 input 只能有一条入边**（fan-in 禁止）。同一个 `target + targetHandle` 不得出现在多条 edge 中；若需替换连线，先删旧边再加新边。违反此规则会导致运行时只有一条边生效，其余静默丢失。

**中间插入**：删 `A → B`，改为 `A → N`（N 的 `input-0`）、`N → B`（保持原 handle 语义）。  
**追加到 End**：删 `X → control_end`，改为 `X → Y → control_end`（常见 `output-0` / `input-0`）。  
**If 分支**：增加 `control_toBool`（确定性）或 `control_agent_toBool`（AI 判断）+ `control_if`，prediction 边与两条分支出边按上表连接。

完整图示例：`builtin/pipelines/new/flow.yaml`。

---

## 保存后同步 Web UI

将 `flow.yaml` 写入磁盘后，在 **Web UI + Composer** 场景下应通知浏览器刷新画布，见 `skills/agentflow-flow-sync-ui/SKILL.md`。

---

## 安装（vercel-labs [skills](https://github.com/vercel-labs/skills)）

在 AgentFlow 仓库根目录：

```bash
npx skills add ./skills --agent cursor --skill agentflow-flow-add-instances -y
# 或安装本包全部技能：
npx skills add ./skills --agent cursor -y
```

项目内默认 **`.agents/skills/`**；全局加 **`-g`** → **`~/.cursor/skills/`**。
