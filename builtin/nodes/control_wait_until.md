---
# 内置节点：等待到指定时间
description: Persistently wait until an absolute time, then continue when scheduler resumes this run.
displayName: WaitUntil
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: until
    default: ""
  - type: text
    name: timezone
    default: "Asia/Shanghai"
output:
  - type: node
    name: next
    default: ""
  - type: text
    name: wakeAt
    default: ""
---
${USER_PROMPT}
