---
# Built-in node: User Workspace
description: Output a workspace context pointing to the current user's home directory.
displayName: User Workspace
input:
  - type: node
    name: prev
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
---
Use the current user's home directory as downstream workspace context.
