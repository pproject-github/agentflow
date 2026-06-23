---
# 内置节点：CD Workspace
description: |
  Switch the runtime workspace context for downstream nodes without changing the AgentFlow pipeline workspace.

  Modes:
  - `set`: switch to target, keep previous stack unchanged.
  - `push`: switch to target and save the incoming context as previous.
  - `pop`: restore the previous context.

  `target` supports `${workspaceRoot}`, `${pipelineWorkspace}`, `${flowDir}`, absolute paths, and paths relative to current workspace context.
displayName: CD Workspace
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: target
    default: "${pipelineWorkspace}"
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
  - type: file
    name: cwd
    default: ""
  - type: text
    name: previous
    default: ""
---
Switch downstream execution to `${target}` using mode `${mode}`.
