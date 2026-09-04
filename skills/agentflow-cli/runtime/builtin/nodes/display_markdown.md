---
# 内置节点：Markdown 展示
runtime: native
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
ui:
  card:
    template: details
    icon: article
    tone: green
    sections:
      - type: binding
        label: 展示内容
        input: content
      - type: summary
        label: 当前产物
        output: content
---
${content}
