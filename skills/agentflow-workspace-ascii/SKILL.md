---
name: agentflow-workspace-ascii
description: >-
  AgentFlow Workspace ASCII 图展示技能。用于生成目录树、文本框图、流程草图等
  等宽 ASCII 内容，并写入 workspace.flow.js 的 display.ascii 节点。
---

# AgentFlow Workspace ASCII

在 Workspace 视图中需要展示目录树、简洁结构图、文本框图或不适合 Mermaid 的草图时使用本技能。

## 生成节点

在 `workspace.flow.js` 里新增或更新一个 `display.ascii` 节点：

```js
const tree = display.ascii("目录树", {
  content: `app/
|-- src/
|-- package.json`,
});
```

`body`、`input.content.value`、`output.content.value` 使用同一份 ASCII 文本。

## ASCII 规则

- 只写纯文本 ASCII，避免 Unicode 线框字符，保证跨终端显示稳定。
- 目录树使用 `|--`、`` `-- ``、`|   ` 缩进。
- 框图尽量短行，避免超宽节点。

## 布局建议

- 默认宽度 640，高度 420。
- 适合作为 Markdown 分析节点旁边的辅助图。
