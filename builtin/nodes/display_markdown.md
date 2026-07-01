---
# 内置节点：Markdown 展示
description: Display Markdown content in workspace canvas; passes content downstream as text
displayName: Markdown Display
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: content
    default: ""
    required: true
    showOnNode: true
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
