---
# 内置节点：Mermaid 展示
description: Display Mermaid diagram source in workspace canvas; passes diagram source downstream as text
displayName: Mermaid Display
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
  - type: node
    name: next
    default: ""
---
${content}
