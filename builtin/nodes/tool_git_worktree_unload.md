---
# Built-in node: Git Worktree Unload
description: |
  Remove a Git worktree.

  - `repoPath` is required unless `gitContext.repoPath` is connected.
  - `worktreePath` is required unless `gitContext.worktreePath` is connected.
  - `workspaceContext` is required so the node can restore the previous execution context.
  - By default `force` is false; dirty worktrees fail instead of being removed.
  - By default `prune` is true.
displayName: Unload Worktree
input:
  - type: node
    name: prev
    default: ""
  - type: file
    name: repoPath
    default: ""
    showOnNode: true
  - type: file
    name: worktreePath
    default: ""
    showOnNode: true
  - type: text
    name: gitContext
    default: ""
  - type: text
    name: workspaceContext
    default: ""
    required: true
  - type: bool
    name: force
    default: "false"
  - type: bool
    name: prune
    default: "true"
output:
  - type: node
    name: next
    default: ""
  - type: bool
    name: removed
    default: ""
  - type: text
    name: workspaceContext
    default: ""
  - type: text
    name: message
    default: ""
---
Remove Git worktree `${worktreePath}` from repository `${repoPath}`.
