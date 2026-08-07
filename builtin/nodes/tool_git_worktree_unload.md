---
# Built-in node: Git Worktree Unload
runtime: native
description: |
  Remove a Git worktree.

  - `workspaceContext` is required. Its `cwd` is used as the worktree to remove.
  - `repoPath`, `worktreePath` and `gitContext` are optional compatibility overrides.
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
  - type: file
    name: worktreePath
    default: ""
  - type: text
    name: gitContext
    default: ""
  - type: text
    name: workspaceContext
    default: ""
    required: true
    showOnNode: true
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
    required: true
    showOnNode: true
  - type: text
    name: message
    default: ""
---
Remove Git worktree `${worktreePath}` from repository `${repoPath}`.
