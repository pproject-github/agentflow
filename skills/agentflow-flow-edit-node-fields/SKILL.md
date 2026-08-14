---
name: agentflow-flow-edit-node-fields
description: Legacy Pipeline field editing is retired. Use agentflow-flow-dsl for Workspace node field changes.
---

# Legacy Flow Node Field Editing（已下线）

此 skill 原用于修改 `flow.yaml` 的实例字段。当前新建和操作统一发生在 Workspace 图中，节点字段应修改 `workspace.flow.js` 的节点调用（见 **agentflow-flow-dsl**），并通过 Workspace 保存/Draft 链路同步。

不要修改 `flow.yaml`、`control_start/control_end` 或调用旧 Pipeline 执行接口来完成新需求。请改用 `agentflow-flow-dsl`。
