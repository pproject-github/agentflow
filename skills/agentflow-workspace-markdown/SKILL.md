---
name: agentflow-workspace-markdown
description: >-
  AgentFlow Workspace Markdown 展示技能。用于把分析、总结、文档、代码结构说明
  生成 display.markdown 节点并写入 workspace.flow.js，作为后续 agent 上下文。
---

# AgentFlow Workspace Markdown

在 Workspace 视图中需要生成 Markdown 报告、说明文档、分析结果或总结卡片时使用本技能。

## 生成节点

在 `workspace.flow.js` 里新增或更新一个 `display.markdown` 节点：

```js
const structure = display.markdown("项目结构分析", {
  content: `# 项目结构分析

- src/ 业务代码`,
});
```

超过 3000 字符的正文抽成文件，写 `file("docs/structure.md")`。画布语法见
**agentflow-flow-dsl**。

## 内容规范

- 生成真正可展示的 Markdown，不要包在代码块里，除非用户要求展示原始 Markdown。
- 表格必须使用标准 Markdown 表格：表头、分隔行、数据行各自独立成行。
- Mermaid 内容不要放进 Markdown 节点；用 `display_mermaid`。
- ASCII 图不要放进 Markdown 节点；用 `display_ascii`。

## 布局

坐标和尺寸由平台维护（`workspace.layout.json`），不要手写。label 放短标题，正文放
`content`。
