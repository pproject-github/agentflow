---
name: agentflow-author-flow
description: Legacy Pipeline authoring is retired. Redirect new AgentFlow creation and editing requests to the Workspace Graph skill and server-side Workspace preview.
---

# Legacy Pipeline Authoring（已下线）

旧的 Flow/Pipeline (`flow.yaml` + `control_start/control_end`) 执行功能已经下线。此 skill 不再创建、发布或执行新的 Pipeline。

新任务统一使用：

- `agentflow-workspace-graph`：创建或修改 `workspace.graph.json`
- `agentflow-cli workspace-preview`：上传到服务器临时 Workspace，打开所见即所得画布
- Workspace 页面中的 `Run` / `Scheduled Run`：执行 Workspace 图

历史 `flow.yaml` 仅用于读取、迁移和审计，不得作为新功能的实现目标。不要调用 `agentflow apply`、`/api/flow/run` 或创建 `control_start/control_end`。
