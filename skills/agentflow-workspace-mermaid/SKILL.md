---
name: agentflow-workspace-mermaid
description: >-
  AgentFlow Workspace Mermaid 展示技能。用于生成流程图、架构图、依赖图等
  Mermaid 源码，并写入 workspace.flow.js 的 display.mermaid 节点。
---

# AgentFlow Workspace Mermaid

在 Workspace 视图中需要展示流程图、架构图、调用链、状态机或依赖关系图时使用本技能。

## 生成节点

在 `workspace.flow.js` 里新增或更新一个 `display.mermaid` 节点：

```js
const chart = display.mermaid("流程图", {
  content: `flowchart TD
  A[Start] --> B[Analyze]`,
});
```

`body`、`input.content.value`、`output.content.value` 使用同一份 Mermaid 源码。

## Mermaid 规则

- 只写 Mermaid 源码，不要包 ```mermaid 代码围栏。
- 优先使用 `flowchart TD`、`sequenceDiagram`、`stateDiagram-v2`。
- 节点文案避免复杂引号和未转义括号，减少渲染失败。
- 如果图太复杂，拆成多个 display_mermaid 节点。

## 布局建议

- 默认宽度 760，高度 480。
- 与相关 Markdown 分析节点相邻放置。
