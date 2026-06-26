---
# 内置节点：CD Workspace
description: |
  Switch the runtime workspace context for downstream nodes without changing the AgentFlow pipeline workspace.

  Modes:
  - `set`: switch to path, keep previous stack unchanged.
  - `push`: switch to path and save the incoming context as previous.
  - `pop`: restore the previous context.

  `path` supports `${workspaceRoot}`, `${pipelineWorkspace}`, `${flowDir}`, absolute paths, and paths relative to the input workspace context.
displayName: CD Workspace
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: path
    default: ""
    required: true
    showOnNode: true
  - type: text
    name: mode
    default: "set"
  - type: text
    name: label
    default: ""
  - type: text
    name: workspaceContext
    default: ""
output:
  - type: node
    name: next
    default: ""
  - type: text
    name: workspaceContext
    default: ""
    required: true
    showOnNode: true
  - type: file
    name: cwd
    default: ""
  - type: text
    name: previous
    default: ""
---
Switch downstream execution to `${path}` using mode `${mode}`.
