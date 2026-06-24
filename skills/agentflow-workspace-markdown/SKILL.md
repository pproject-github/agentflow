---
name: agentflow-workspace-markdown
description: >-
  AgentFlow Workspace Markdown 展示技能。用于把分析、总结、文档、代码结构说明
  生成 display_markdown 节点并写入 workspace.graph.json，作为后续 agent 上下文。
---

# AgentFlow Workspace Markdown

在 Workspace 视图中需要生成 Markdown 报告、说明文档、分析结果或总结卡片时使用本技能。

## 生成节点

新增或更新 `workspace.graph.json` 中的 `display_markdown` instance：

```json
{
  "definitionId": "display_markdown",
  "label": "项目结构分析",
  "body": "# 项目结构分析\n\n...",
  "input": [
    { "type": "node", "name": "prev", "value": "" },
    { "type": "text", "name": "content", "value": "# 项目结构分析\n\n..." }
  ],
  "output": [
    { "type": "text", "name": "content", "value": "# 项目结构分析\n\n..." }
  ]
}
```

`body`、`input.content.value`、`output.content.value` 使用同一份 Markdown 内容。

## 内容规范

- 生成真正可展示的 Markdown，不要包在代码块里，除非用户要求展示原始 Markdown。
- 表格必须使用标准 Markdown 表格：表头、分隔行、数据行各自独立成行。
- Mermaid 内容不要放进 Markdown 节点；用 `display_mermaid`。
- ASCII 图不要放进 Markdown 节点；用 `display_ascii`。

## 布局建议

- 默认宽度 760，高度 520。
- 多个 Markdown 节点按从左到右、从上到下排布。
- label 放短标题，正文放 body/content。
