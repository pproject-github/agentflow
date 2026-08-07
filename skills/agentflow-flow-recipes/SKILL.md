---
name: agentflow-flow-recipes
description: Legacy Pipeline recipes are retired. Use Workspace Graph recipes for new AgentFlow canvas tasks.
---

# Legacy Flow Recipes（已下线）

旧的 `Start → … → End` 流水线 recipe 不再用于新任务。需要组合 Git Checkout、CD Workspace、Load Skills、Agent、Print 时，请在 `workspace.graph.json` 中以 `workspace_run` 为入口组织节点，并使用 `agentflow-workspace-graph` 校验槽位和连线。

历史 recipes 仅供迁移参考，不得生成 `control_start` 或 `control_end`。
