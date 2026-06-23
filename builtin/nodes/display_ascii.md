---
# 内置节点：ASCII 图展示
description: Display ASCII diagram content in workspace canvas; passes diagram text downstream as text
displayName: ASCII Display
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
