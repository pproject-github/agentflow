---
# Built-in node: Workspace Context Resource
runtime: native
type: provide
description: Bind one authenticated Workspace catalog entry as execution context. The Flow stores only workspaceId; paths and credentials remain runtime-owned.
displayName: Workspace Context
ui:
  card:
    template: context-resource
    icon: folder_open
    tone: green
    sections:
      - type: binding
        label: Workspace ID
        input: workspaceId
      - type: binding
        label: Access
        input: access
input:
  - type: text
    name: workspaceId
    default: current
    required: true
    showOnNode: false
  - type: text
    name: access
    default: read-write
    showOnNode: false
output:
  - type: text
    name: workspaceContext
    default: ""
    required: true
    showOnNode: true
---
Resolve the runtime-owned Workspace catalog entry for downstream Context consumers.
