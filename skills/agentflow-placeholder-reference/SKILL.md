---
name: agentflow-placeholder-reference
description: >-
  AgentFlow Workspace 节点占位符参考。用于编写 body/script 中的 ${workspaceRoot}、${pipelineWorkspace}、
  ${flowDir}、${runDir}、${input.xxx}、${output.xxx} 等变量。
---

# AgentFlow Placeholder Reference

使用本技能处理这些问题：

- 编写或修复 `tool_nodejs.script`、agent body、节点默认值中的 `${...}`。
- CD Workspace 后确认路径应该用 `workspaceRoot` 还是 `pipelineWorkspace`。
- 解决脚本里路径多了一层引号、找不到 flow scripts、输出路径不对的问题。

## 必读规则

- 读 [placeholders.md](references/placeholders.md)。
- 不要在 `script` 中给 `${workspaceRoot}` 这类占位符再包一层双引号；AgentFlow 会 shell-quote。
- Workspace 节点脚本优先使用 `${workspaceRoot}`；`${flowDir}` / `${pipelineWorkspace}` 仅兼容历史 Pipeline 资源。

## Reference

- [Placeholder reference](references/placeholders.md)
