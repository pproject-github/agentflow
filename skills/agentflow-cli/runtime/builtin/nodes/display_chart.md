---
# Built-in node: Chart Display
runtime: native
description: Display a JSON ChartSpec with ECharts in workspace canvas; passes the JSON downstream as text
displayName: Chart Display
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
