---
# 内置节点：延迟等待
description: Persistently wait for a relative duration, then continue when scheduler resumes this run.
displayName: Delay
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: duration
    default: "10m"
output:
  - type: node
    name: next
    default: ""
  - type: text
    name: wakeAt
    default: ""
---
${USER_PROMPT}
