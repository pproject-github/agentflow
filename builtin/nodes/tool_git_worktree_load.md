---
# Built-in node: Git Worktree Load
description: |
  Create or reuse a Git worktree and expose it as the downstream workspace context.

  - `repoPath` is required unless `gitContext.repoPath` is connected.
  - `workspaceContext` is required so the node can preserve the previous execution context.
  - `branch` is optional. When empty, AgentFlow creates a detached worktree at the current HEAD.
  - `worktreePath` is optional. When empty, AgentFlow creates a temporary worktree under the current run temp directory and removes it after the run finishes.
  - Set `worktreePath` only when you explicitly want a persistent worktree outside the run lifecycle.
  - Existing worktree paths are reused only when they are registered by `git worktree list` for the given repo.
  - `pruneMissing` defaults to true. When Git has a registered worktree whose directory is missing, AgentFlow runs `git worktree prune` before adding it again.
  - `force` defaults to false. When true, AgentFlow passes `--force` to `git worktree add`.
displayName: Load Worktree
input:
  - type: node
    name: prev
    default: ""
  - type: file
    name: repoPath
    default: ""
  - type: text
    name: branch
    default: ""
  - type: file
    name: worktreePath
    default: ""
  - type: bool
    name: pruneMissing
    default: "true"
    showOnNode: false
  - type: bool
    name: force
    default: "false"
    showOnNode: false
  - type: text
    name: gitContext
    default: ""
    required: true
    showOnNode: true
  - type: text
    name: workspaceContext
    default: ""
    required: true
    showOnNode: true
output:
  - type: node
    name: next
    default: ""
  - type: file
    name: worktreePath
    default: ""
  - type: text
    name: branch
    default: ""
  - type: text
    name: commit
    default: ""
  - type: text
    name: workspaceContext
    default: ""
    required: true
    showOnNode: true
  - type: text
    name: gitContext
    default: ""
    required: true
    showOnNode: true
---
Load a Git worktree from `${repoPath}` and switch downstream workspace context to it.
