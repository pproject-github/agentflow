---
# 内置节点：延迟等待
runtime: none
palette: hidden
description: Persistently wait for a relative duration, then continue when scheduler resumes this run.
displayName: Delay
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: duration
    default: "10m"
    required: true
    showOnNode: true
output:
  - type: node
    name: next
    default: ""
  - type: text
    name: waitId
    default: ""
    required: true
    showOnNode: true
  - type: text
    name: wakeAt
    default: ""
    required: true
    showOnNode: true
---
${USER_PROMPT}
