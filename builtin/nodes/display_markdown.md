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
output:
  - type: text
    name: content
    default: ""
---
${content}
