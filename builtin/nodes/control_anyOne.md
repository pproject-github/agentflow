---
# 内置节点：任一满足
description: Continues to next when any upstream input is ready
displayName: AnyOne
input:
  - type: node
    name: prev1
    default: ""
  - type: node
    name: prev2
    default: ""
output:
  - type: node
    name: next
    default: ""
---
${USER_PROMPT}
