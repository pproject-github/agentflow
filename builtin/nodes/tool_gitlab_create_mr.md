---
# Built-in node: GitLab Create MR
description: |
  Create or reuse a GitLab merge request for the current branch.

  - `gitContext` and `workspaceContext` can be connected from Git Checkout / Load Worktree.
  - `repoPath` is optional. When empty, AgentFlow uses `gitContext.worktreePath`, `gitContext.repoPath`, or `workspaceContext.cwd`.
  - `sourceBranch`, `targetBranch`, `title`, `description`, `draft`, and `labels` are optional. When empty, AgentFlow derives sensible defaults from git.
  - `tokenEnv` is optional. Defaults to `GITLAB_TOKEN,GITLAB_PRIVATE_TOKEN`.
  - `gitlabApiBase` is optional. When empty, AgentFlow uses `https://${gitContext.host}/api/v4`.
displayName: Create GitLab MR
input:
  - type: node
    name: prev
    default: ""
  - type: file
    name: repoPath
    default: ""
    showOnNode: false
  - type: text
    name: gitContext
    default: ""
    showOnNode: true
  - type: text
    name: workspaceContext
    default: ""
    showOnNode: false
  - type: text
    name: sourceBranch
    default: ""
    showOnNode: false
  - type: text
    name: targetBranch
    default: ""
    showOnNode: false
  - type: text
    name: title
    default: ""
    showOnNode: false
  - type: text
    name: description
    default: ""
    showOnNode: false
  - type: bool
    name: draft
    default: "false"
    showOnNode: false
  - type: text
    name: labels
    default: ""
    showOnNode: false
  - type: bool
    name: push
    default: "true"
    showOnNode: false
  - type: text
    name: remote
    default: "origin"
    showOnNode: false
  - type: text
    name: tokenEnv
    default: ""
    showOnNode: false
  - type: text
    name: gitlabApiBase
    default: ""
    showOnNode: false
  - type: bool
    name: removeSourceBranch
    default: "false"
    showOnNode: false
  - type: bool
    name: squash
    default: "false"
    showOnNode: false
output:
  - type: node
    name: next
    default: ""
  - type: text
    name: mrUrl
    default: ""
    required: true
  - type: bool
    name: created
    default: ""
    showOnNode: false
  - type: text
    name: mrIid
    default: ""
    showOnNode: false
  - type: text
    name: projectId
    default: ""
    showOnNode: false
  - type: text
    name: sourceBranch
    default: ""
    showOnNode: false
  - type: text
    name: targetBranch
    default: ""
    showOnNode: false
  - type: text
    name: title
    default: ""
    showOnNode: false
  - type: text
    name: message
    default: ""
    showOnNode: false
---
Create or reuse a GitLab merge request and output `${mrUrl}`.
