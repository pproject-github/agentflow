---
# 内置节点：加载知识库
runtime: native
type: control
description: |
  Load one or more read-only knowledge sources for downstream Agent nodes.

  This node does not change the runtime cwd. It publishes `knowledgeContext`
  for reading/searching referenced repos or folders. `workspaceContext` and
  `cwd` are retained as legacy compatibility outputs for the first source.
displayName: 加载知识库
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: path
    default: ""
    showOnNode: false
  - type: text
    name: label
    default: ""
    showOnNode: false
  - type: text
    name: knowledgeContext
    default: ""
    showOnNode: false
  - type: text
    name: workspaceContext
    default: ""
    showOnNode: false
output:
  - type: node
    name: next
    default: ""
  - type: text
    name: knowledgeContext
    default: ""
    required: true
    showOnNode: true
  - type: text
    name: workspaceContext
    default: ""
    showOnNode: false
  - type: file
    name: cwd
    default: ""
    showOnNode: false
---
Load selected knowledge sources for downstream agents.
