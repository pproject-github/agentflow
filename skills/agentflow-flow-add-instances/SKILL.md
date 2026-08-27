---
name: agentflow-flow-add-instances
description: Legacy Pipeline node authoring is retired. Redirect requests to add nodes to agentflow-flow-dsl.
---

# Legacy Flow Node Authoring（已下线）

此 skill 原用于向 `flow.yaml` 添加实例，但旧 Pipeline 的 `Start/End` 执行模式已经下线，不再新增或编辑正式 `flow.yaml`。

用户要在画布中加节点时，请改用 `agentflow-flow-dsl`，编辑：

```text
.workspace/agentflow/pipelines/<id>/workspace.flow.js
```

Workspace 图的入口使用 `workspace_run` 或 `workspace_scheduled_run`，不要创建 `control_start`、`control_end`，也不要修改旧 Pipeline 拓扑来实现新需求。
