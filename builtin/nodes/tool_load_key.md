---
# 内置节点：按 key 读取
description: Load key-value from global storage
displayName: LoadKey
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: key
    default: ""
    required: true
    showOnNode: true
output:
  - type: node
    name: next
    default: ""
  - type: text
    name: result
    default: ""
    required: true
    showOnNode: true
---
${USER_PROMPT}
