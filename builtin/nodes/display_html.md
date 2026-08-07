---
# Built-in node: HTML Display
runtime: native
description: Display HTML content in workspace canvas; passes HTML downstream as text
displayName: HTML Display
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
