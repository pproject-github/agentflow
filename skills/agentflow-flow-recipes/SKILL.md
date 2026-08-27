---
name: agentflow-flow-recipes
description: Workspace Graph recipes for AgentFlow canvas tasks (git analysis, display, branching).
---

# Workspace Graph Recipes

组合 Git Checkout、CD Workspace、Load Skills、Agent、Display 等节点时，先读
[recipes.md](references/recipes.md)，在 `workspace.flow.js` 中以 `flow(...)` 为入口组织节点，
再用 `agentflow-flow-dsl` 校验槽位和连线。

旧的 `Start → … → End` 流水线 recipe 已下线；不得生成 `control_start` / `control_end`
或其它已退役的节点类型（recipes.md 末尾列出了完整清单）。
