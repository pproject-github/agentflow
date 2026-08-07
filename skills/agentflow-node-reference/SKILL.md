---
name: agentflow-node-reference
description: >-
  AgentFlow Workspace 节点参考。用于选择节点类型、确认 builtin node 的 input/output 槽位、
  判断 local-only/script/agent 执行方式，以及避免 handle 类型和顺序接错。
---

# AgentFlow Node Reference

使用本技能处理这些问题：

- 选择 `agent_subAgent`、`tool_nodejs`、`tool_git_checkout`、`control_cd_workspace`、`display_markdown` 等节点。
- 创建或修改 Workspace Graph 时需要确认 input/output 名称、类型、顺序和 handle 索引。
- 判断节点是否 local-only，是否会调用 agent，是否需要 `script`。

## 必读规则

- 先读 [builtin-nodes.md](references/builtin-nodes.md)，再改 `workspace.graph.json` 的 `definitionId`、`input`、`output` 或 `edges`。
- 新图入口使用 `workspace_run` / `workspace_scheduled_run`，不要新增 `control_start` / `control_end`。
- `input-N` / `output-N` 必须与节点定义中的槽位顺序一致。
- `tool_nodejs` 只有写了完整 `script` 才会确定性执行；自然语言任务用 `agent_subAgent`。
- local-only 节点由 AgentFlow runtime 执行，不会调用 agent。

## Reference

- [Builtin nodes reference](references/builtin-nodes.md)
