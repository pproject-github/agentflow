---
# Built-in node: Skills Context Resource
runtime: native
type: provide
description: Declare versioned skills as a reusable Context resource. This is a data resource and does not participate in the prev/next control chain.
displayName: Skills Context
ui:
  card:
    template: context-resource
    icon: extension
    tone: purple
    sections:
      - type: binding
        label: Skills
        input: skills
input:
  - type: json
    name: skills
    default: "[]"
    required: true
    showOnNode: false
output:
  - type: text
    name: skillsContext
    default: ""
    required: true
    showOnNode: true
---
Load the declared skills for downstream Context consumers.
