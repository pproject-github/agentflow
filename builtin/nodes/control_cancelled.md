---
# 内置节点：取消状态判断
description: Check whether the current run/watch has been cancelled. Use cancelled output with control_if.
displayName: Cancelled
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: watchId
    default: ""
output:
  - type: node
    name: next
    default: ""
  - type: bool
    name: cancelled
    default: ""
---
${USER_PROMPT}
