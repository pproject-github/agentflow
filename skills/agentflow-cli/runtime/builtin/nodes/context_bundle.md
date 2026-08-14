---
# Built-in node: Context Bundle
runtime: native
type: provide
description: Compose knowledge, skills, workspace, and MCP resources into one strongly typed Context value that can cross Agent, Subflow, and While boundaries.
displayName: Context Bundle
ui:
  card:
    template: context-resource
    icon: hub
    tone: purple
    sections:
      - type: context
        label: Context resources
        inputs:
          - name: knowledgeContext
            label: Knowledge
          - name: skillsContext
            label: Skills
          - name: workspaceContext
            label: Workspace
          - name: mcpContext
            label: MCP
input:
  - type: text
    name: knowledgeContext
    default: ""
  - type: text
    name: skillsContext
    default: ""
  - type: text
    name: workspaceContext
    default: ""
  - type: text
    name: mcpContext
    default: ""
output:
  - type: context
    name: context
    default: ""
    required: true
    showOnNode: true
---
Compose Context resources without putting their content or credentials into the business data flow.
