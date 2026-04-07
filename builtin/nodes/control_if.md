---
# 内置节点：If 分支
description: Has exactly one bool type input. Continues to next1 if true, next2 if false
displayName: If
input:
  - type: node
    name: prev
    default: ""
  - type: bool
    name: prediction
    default: ""
output:
  - type: node
    name: next1
    default: ""
  - type: node
    name: next2
    default: ""
---
${USER_PROMPT}
