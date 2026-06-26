---
# Built-in node: Git Worktree Load
description: |
  Create or reuse a Git worktree and expose it as the downstream workspace context.

  - `repoPath` is required unless `gitContext.repoPath` is connected.
  - `workspaceContext` is required so the node can preserve the previous execution context.
  - `branch` is optional. When empty, AgentFlow creates a detached worktree at the current HEAD.
  - `worktreePath` is optional. When empty, AgentFlow creates a path under `${pipelineWorkspace}/.workspace/agentflow/worktrees`.
  - Existing worktree paths are reused only when they are registered by `git worktree list` for the given repo.
displayName: Load Worktree
input:
  - type: node
    name: prev
    default: ""
  - type: file
    name: repoPath
    default: ""
    showOnNode: true
  - type: text
    name: branch
    default: ""
    showOnNode: true
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
  - type: text
    name: gitContext
    default: ""
---
Load a Git worktree from `${repoPath}` and switch downstream workspace context to it.
