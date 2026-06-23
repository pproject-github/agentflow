---
# 内置节点：Load Skills
description: |
  Load selected public Skills from the AgentFlow skill registry into the current workspace context.

  Connect `workspaceContext` from CD Workspace, set `skillKeys` to skill names or registry keys, then connect `skillsContext` to downstream agent/tool nodes. Loaded skills are injected into the node prompt under "已加载 Skills" while downstream execution still uses the CD Workspace context.

  Skill key examples:
  - `agentflow-flow-add-instances`
  - `workspace-agents:agentflow-flow-edit-node-fields`
  - `global-codex:some-skill`

  Merge modes:
  - `replace`
  - `append`
  - `prepend`
displayName: Load Skills
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: skillKeys
    default: ""
  - type: text
    name: mergeMode
    default: "replace"
  - type: text
    name: workspaceContext
    default: ""
  - type: text
    name: skillsContext
    default: ""
output:
  - type: node
    name: next
    default: ""
  - type: text
    name: skillsContext
    default: ""
  - type: text
    name: loadedCount
    default: ""
  - type: text
    name: summary
    default: ""
---
Load public skills `${skillKeys}` into `${workspaceContext}` and pass them to downstream nodes.
