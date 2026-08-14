---
# 内置节点：取消判断
runtime: none
palette: hidden
description: Check whether the current wait/run has been cancelled. Use cancelled output with control_if.
displayName: Cancel Check
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: waitId
    default: ""
    required: true
    showOnNode: true
output:
  - type: node
    name: next
    default: ""
  - type: bool
    name: cancelled
    default: ""
    required: true
    showOnNode: true
---
${USER_PROMPT}
