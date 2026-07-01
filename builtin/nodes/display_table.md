---
# Built-in node: Table Display
description: Display table data in workspace canvas; accepts JSON, Markdown table, CSV, or TSV and passes the text downstream
displayName: Table Display
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: content
    default: ""
    required: true
    showOnNode: true
  - type: file
    name: filePath
    default: ""
    showOnNode: false
  - type: text
    name: workspaceContext
    default: ""
    showOnNode: false
output:
  - type: text
    name: content
    default: ""
    showOnNode: true
  - type: node
    name: next
    default: ""
---
${content}
