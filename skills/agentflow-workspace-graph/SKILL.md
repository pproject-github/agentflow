---
name: agentflow-workspace-graph
description: >-
  AgentFlow Workspace 画布编辑技能。用于在 Workspace 视图中创建或修改
  workspace.graph.json，新增展示节点、上下文节点和连线；不修改正式 flow.yaml。
---

# AgentFlow Workspace Graph

在 Workspace 视图中需要创建临时工作画布、保存分析结果、组织上下文节点或连接展示节点时使用本技能。

## 目标文件

优先修改当前 Workspace 项目目录下的 `workspace.graph.json`。不要修改历史 `flow.yaml`，除非用户明确要求迁移或审计。

`workspace.graph.json` 结构：

```json
{
  "version": 1,
  "instances": {
    "node_id": {
      "definitionId": "display_markdown",
      "label": "标题",
      "body": "展示内容",
      "input": [
        { "type": "node", "name": "prev", "value": "" },
        { "type": "text", "name": "content", "value": "展示内容" }
      ],
      "output": [
        { "type": "text", "name": "content", "value": "展示内容" }
      ]
    }
  },
  "edges": [
    { "source": "a", "target": "b", "sourceHandle": "output-0", "targetHandle": "input-0" }
  ],
  "ui": {
    "nodePositions": { "node_id": { "x": 320, "y": 180 } },
    "nodeSizes": { "node_id": { "width": 760, "height": 520 } }
  }
}
```

## 节点使用规则

- 用 `display_markdown` 展示 Markdown 正文、分析报告、会议纪要、代码结构说明。
- 用 `display_mermaid` 展示 Mermaid 图源码。
- 用 `display_ascii` 展示 ASCII 图。
- 用 `display_html` 展示可交互 HTML 原型或富 UI 片段。
- 用 `display_image` 展示图片 URL、data URL 或图片路径。
- 用 `display_chart` 展示 ChartSpec JSON 图表。
- 用 `display_table` 展示结构化表格数据。
- 用普通 Workspace 节点作为上下文节点时，保持 `instances` 结构与节点定义一致；它只属于 workspace graph。
- 每个新增 instance 必须有 `ui.nodePositions`。
- 展示节点建议写 `ui.nodeSizes`，避免内容区域过小。

## 连接语义

展示节点的输入：

- `input[0]` / `targetHandle: "input-0"`：node prev，用于连接上游上下文。
- `input[1]`：text content，展示内容。

展示节点的输出：

- `output[0]` / `sourceHandle: "output-0"`：text content，可作为后续 agent 的上下文输入。

## 输出要求

当用户要求“生成/展示/放到 workspace 画布”时，直接编辑 `workspace.graph.json`。如果用户要求所见即所得的线上画布，随后使用 `agentflow-cli workspace-preview` 上传到服务器临时 Workspace；不要把临时项目当作正式源版本。完成后简要说明新增或修改了哪些 workspace 节点。
