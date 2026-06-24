---
name: agentflow-workspace-ascii
description: >-
  AgentFlow Workspace ASCII 图展示技能。用于生成目录树、文本框图、流程草图等
  等宽 ASCII 内容，并写入 display_ascii 节点的 workspace.graph.json。
---

# AgentFlow Workspace ASCII

在 Workspace 视图中需要展示目录树、简洁结构图、文本框图或不适合 Mermaid 的草图时使用本技能。

## 生成节点

新增或更新 `workspace.graph.json` 中的 `display_ascii` instance：

```json
{
  "definitionId": "display_ascii",
  "label": "目录树",
  "body": "app/\n|-- src/\n|-- package.json",
  "input": [
    { "type": "node", "name": "prev", "value": "" },
    { "type": "text", "name": "content", "value": "app/\n|-- src/\n|-- package.json" }
  ],
  "output": [
    { "type": "text", "name": "content", "value": "app/\n|-- src/\n|-- package.json" }
  ]
}
```

`body`、`input.content.value`、`output.content.value` 使用同一份 ASCII 文本。

## ASCII 规则

- 只写纯文本 ASCII，避免 Unicode 线框字符，保证跨终端显示稳定。
- 目录树使用 `|--`、`` `-- ``、`|   ` 缩进。
- 框图尽量短行，避免超宽节点。

## 布局建议

- 默认宽度 640，高度 420。
- 适合作为 Markdown 分析节点旁边的辅助图。
