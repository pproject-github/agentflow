---
# 内置节点：Git Checkout
description: |
  Clone or update a Git repository and expose it as a workspace context for downstream nodes.

  - `repoUrl` is required.
  - `targetDir` may be absolute or relative to the current workspace context.
  - If `targetDir` is empty, the repository is cloned into `${pipelineWorkspace}/.workspace/agentflow/git-repos/<repo-name>`.
  - Set `includeSubmodules` to `true` to clone/update Git submodules recursively.
  - The `workspaceContext` output can be connected to CD Workspace, Load Skills, agent, or tool nodes.
displayName: Git Checkout
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: repoUrl
    default: ""
  - type: text
    name: branch
    default: ""
  - type: text
    name: targetDir
    default: ""
  - type: bool
    name: pullIfExists
    default: "true"
  - type: bool
    name: includeSubmodules
    default: "false"
  - type: text
    name: workspaceContext
    default: ""
output:
  - type: node
    name: next
    default: ""
  - type: file
    name: repoPath
    default: ""
  - type: text
    name: branch
    default: ""
  - type: text
    name: commit
    default: ""
  - type: bool
    name: changed
    default: ""
  - type: text
    name: workspaceContext
    default: ""
---
Clone or update `${repoUrl}` and output a workspace context for the checked-out repository.
