---
# 内置节点：Load MCP
runtime: native
type: control
description: 加载所选 Cursor MCP Server 的工具清单，通过 mcpContext 传给下游 agent 节点。
displayName: Load MCP
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: serverNames
    default: ""
    showOnNode: false
output:
  - type: node
    name: next
    default: ""
  - type: text
    name: mcpContext
    default: ""
    showOnNode: true
---
Load selected Cursor MCP server tool manifests for downstream agent nodes.
