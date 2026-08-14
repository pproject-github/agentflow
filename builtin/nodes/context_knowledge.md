---
# Built-in node: Knowledge Context Resource
runtime: native
type: provide
description: Select one or more read-only knowledge sources by their authenticated Workspace catalog IDs. The runtime resolves IDs from the same catalog as GET /api/workspaces; paths and credentials are not stored in Flow DSL.
displayName: Knowledge Context
ui:
  card:
    template: context-resource
    icon: menu_book
    tone: cyan
    sections:
      - type: binding
        label: Workspace IDs
        input: workspaceIds
input:
  - type: json
    name: workspaceIds
    default: "[]"
    required: true
    showOnNode: false
output:
  - type: text
    name: knowledgeContext
    default: ""
    required: true
    showOnNode: true
---
Resolve authenticated Workspace catalog IDs into read-only knowledge sources for downstream Context consumers.
