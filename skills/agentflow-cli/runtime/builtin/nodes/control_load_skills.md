---
# 内置节点：Load Skills
runtime: native
type: control
description: |
  Load the currently selected Workspace skill collection for downstream agent nodes.

  Set `skillKeys` to skill names or registry keys, then connect `skillsContext` to
  downstream agent/tool nodes. Loaded skills are injected into the node prompt under
  "已加载 Skills"。

  Skill key examples:
  - `agentflow-flow-add-instances`
  - `workspace-agents:agentflow-flow-edit-node-fields`
  - `global-codex:some-skill`
displayName: Load Skills
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: skillKeys
    default: ""
    required: true
    showOnNode: true
output:
  - type: node
    name: next
    default: ""
  - type: text
    name: skillsContext
    default: ""
    showOnNode: true
---
Load public skills `${skillKeys}` and pass them to downstream nodes.
