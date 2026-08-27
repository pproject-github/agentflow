---
# Built-in node: Git Worktree Load
runtime: native
description: |
  Create or reuse a Git worktree and expose it as the downstream workspace context.

  - `repoPath` is required unless `gitContext.repoPath` is connected.
  - `workspaceContext` is required so the node can preserve the previous execution context.
  - `branch` is optional. When empty, AgentFlow creates a detached worktree at the current HEAD.
  - `worktreePath` is optional. When empty, AgentFlow creates a managed execution worktree under `.workspace/agentflow/run-workspaces/`, separate from node temp files and durable `outputs/` artifacts.
  - A `wait` checkpoint retains the execution worktree. The next run reuses the retained output path so loop state and code changes remain available while resuming.
  - On terminal completion or stop, AgentFlow removes clean managed worktrees. Dirty worktrees are preserved with a warning instead of being force-deleted.
  - Existing registered worktrees under the current flow workspace are managed by the same lifecycle policy.
  - Existing registered worktrees outside the current flow workspace are reused and not removed automatically unless this run created them.
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
