---
name: agentflow-flow-recipes
description: >-
  AgentFlow 常见流程模板。用于新建 Git 项目分析、加载项目 skills、打印结果、
  以及组合 Git Checkout → CD Workspace → Load Skills → Agent → Print 的标准流水线。
---

# AgentFlow Flow Recipes

使用本技能处理这些问题：

- 用户要求“新建流水线拉仓库、cd 进去、让 agent 分析、print 结果”。
- 需要把 Git 项目作为工作区分析，并可加载项目自身 skills。
- 需要避免临场猜 slot/handle，按标准 recipe 搭图。

## 必读规则

- 读 [recipes.md](references/recipes.md)。
- Git 项目分析的标准链路是：`Start → Git Checkout → CD Workspace → Load Skills → Agent → Print → End`。
- `tool_print.content` 应接 agent 输出内容；没有接 content 时才 fallback 打印上游 result。

## Reference

- [Flow recipes](references/recipes.md)
