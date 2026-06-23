---
name: agentflow-runtime-reference
description: >-
  AgentFlow 运行时参考。用于理解 pipeline/workspace 目录、runBuild、
  intermediate/output/result 文件、workspaceContext/skillsContext 传递和 CD Workspace 行为。
---

# AgentFlow Runtime Reference

使用本技能处理这些问题：

- 解释或调试 AgentFlow 运行目录和产物。
- 设计 Git Checkout、CD Workspace、Load Skills、Agent、Print 的工作区切换链路。
- 判断 `${workspaceRoot}` 与 `${pipelineWorkspace}` 在 CD Workspace 前后的差异。
- 排查上游 output 文件、result.md、cache.json、skillsContext 没传到下游的问题。

## 必读规则

- 读 [runtime.md](references/runtime.md) 了解目录与上下文。
- 下游 agent/tool 的当前执行目录由 `workspaceContext` 决定。
- pipeline 自己的文件永远通过 `pipelineWorkspace` / `flowDir` 找，不要在 CD 后误用 `workspaceRoot`。

## Reference

- [Runtime reference](references/runtime.md)
