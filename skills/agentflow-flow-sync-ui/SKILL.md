---
name: agentflow-flow-sync-ui
description: Legacy flow.yaml canvas sync is retired. Workspace Graph saves are synchronized through the Workspace API automatically.
---

# Legacy Flow Canvas Sync（已下线）

旧的 `flow.yaml` + `/api/flow-editor-sync` 刷新链路不再用于新功能。Workspace 图请直接保存 `workspace.graph.json`，或使用 Workspace Graph 页面/API 的保存机制；需要所见即所得预览时使用 `agentflow-cli workspace-preview`。
