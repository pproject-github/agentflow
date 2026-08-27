---
name: agentflow-flow-sync-ui
description: Legacy flow.yaml canvas sync is retired. Workspace Graph saves are synchronized through the Workspace API automatically.
---

# Legacy Flow Canvas Sync（已下线）

旧的 `flow.yaml` + `/api/flow-editor-sync` 刷新链路不再用于新功能。Workspace 图请按 **agentflow-flow-dsl** 编辑 `workspace.flow.js`，或使用 Workspace 页面/API 的保存机制；需要可编辑、可试运行的远端画布时使用 **agentflow-author-flow** 的 Draft，纯只读分享才使用 `agentflow-cli workspace-preview --file <flowDir>`。
