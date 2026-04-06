---
name: agentflow-flow-edit-node-fields
description: >-
  仅修改 AgentFlow flow.yaml 中已有实例的允许字段（label、body、role、
  input/output 的 value 等）；禁止改 definitionId、instanceId、IO 结构与顺序、
  不增删边与实例。用于改文案、占位符、角色标签而不破坏图拓扑与 handle。
---

# AgentFlow：仅修改已有节点（白名单字段）

在 **不增加/删除节点与边、不改编译拓扑** 的前提下，修改一个或多个 **已有** `instances` 条目时使用本技能。

**路径说明**：`npx skills add` 后本文件不在 AgentFlow 仓库内；`reference/` 相对 **AgentFlow 仓库根目录**。

**权威参考**：`reference/flow-control-capabilities.md`（内置 description 语义）、`reference/flow-prompt-handler-check.md`（改 `body` 后与图一致）。

---

## 允许修改的字段（白名单）

对每个已存在的 **`<instanceId>`** 块，**仅**可改下列内容：

| 字段 | 说明 |
|------|------|
| **`label`** | 画布显示名 |
| **`role`** | 角色分类字符串 |
| **`body`** | 节点用户区正文（agent 任务描述等）；改后核对与边的数据流是否仍一致 |
| **`script`** | **仅限 `definitionId: tool_nodejs`**——实际执行的 shell/node 命令（`body` 有 script 时不执行）。必须写完整可执行命令，禁止写自然语言 |
| **`input[].value`** | 各输入槽的默认值 / 占位路径 / 字面量（**不改** 该项的 `type`、`name`） |
| **`output[].value`** | 各输出槽默认值（**不改** `type`、`name`） |

### tool_nodejs 特殊规则（关键）

`definitionId: tool_nodejs` 的节点**核心是 `script` 字段**，不是 `body`：
- **`script`**：流水线直接执行的命令代码，stdout 作为 result，exit code 决定成败
- **`body`**：有 `script` 时仅作为人类可读的注释说明，**不会被执行**
- **禁止** `tool_nodejs` 只有 `body` 没有 `script`——自然语言描述不会被执行，节点必定失败
- 如果无法写出完整可执行的 `script`，必须把 `definitionId` 改为 `agent_subAgent`（此变更不在本技能范围，需用 `agentflow-flow-add-instances` 技能）

**`instances.*.description`** 已废弃：不要在 flow.yaml 中写入；agent 系统说明以 **`definitionId` 对应节点定义 `.md`** 的 frontmatter **`description`** 为准。需要补充说明性文字时用 **`body`** 或 **`label`**。

---

## 禁止修改（黑名单）

- **`definitionId`**：换类型会错 handle，须走「新增实例 + 删旧实例 + 改边」流程，**不在**本技能范围。  
- **`instanceId` 键名**：改名必须同步改 **所有 `edges` 的 source/target** 与 **`ui.nodePositions` 键**，否则图断裂；**不在**本技能范围。  
- **`input` / `output` 数组**：不得 **增删条目**、**改顺序**、**改 `name` / `type`**（会导致 `input-0` / `output-1` 与边不对应）。  
- **`edges`**：不得增删改（含 `sourceHandle` / `targetHandle`）。  
- **新增或删除整个 instance 块**：使用技能 **`agentflow-flow-add-instances`** 或其它流程。  
- **`ui.nodePositions`**：本技能默认 **不** 改；仅当用户明确要求「只动坐标」时可单独改对应 instance 的 `x` / `y`，且 **不** 改其它字段。

---

## 操作建议

1. 用搜索定位目标 **`instanceId`**，只改上表白名单字段。  
2. 修改 **`body`** 或 **`value`** 后，若涉及「读哪些文件 / 写哪些结果」，对照 **`reference/flow-prompt-handler-check.md`**，确保仍与当前 **edges** 上的 handler 一致（本技能不改边，但若文案宣称的读写与图不符，应提示用户需另改图）。  
3. 批量改多个节点时，对每个实例重复上述约束，**不要**顺带重构 YAML 结构。

---

## 保存后同步 Web UI

将 `flow.yaml` 写入磁盘后，在 **Web UI + Composer** 场景下应通知浏览器刷新画布，见 `skills/agentflow-flow-sync-ui/SKILL.md`。

---

## 安装（vercel-labs [skills](https://github.com/vercel-labs/skills)）

在 AgentFlow 仓库根目录：

```bash
npx skills add ./skills --agent cursor --skill agentflow-flow-edit-node-fields -y
# 或安装本包全部技能：
npx skills add ./skills --agent cursor -y
```

项目内默认 **`.agents/skills/`**；全局加 **`-g`**。
