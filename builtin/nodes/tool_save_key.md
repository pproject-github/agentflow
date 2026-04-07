---
# 内置节点：按 key 写入
description: Save key-value pair to global storage
displayName: SaveKey
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: key
    default: ""
  - type: text
    name: value
    default: ""
output:
  - type: node
    name: next
    default: ""
---
${USER_PROMPT}
