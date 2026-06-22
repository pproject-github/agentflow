---
# 内置节点：截止时间判断
description: Compute whether a deadline has expired. Use expired output with control_if.
displayName: Deadline
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: startAt
    default: ""
  - type: text
    name: duration
    default: ""
  - type: text
    name: deadlineAt
    default: ""
  - type: text
    name: timezone
    default: "Asia/Shanghai"
output:
  - type: node
    name: next
    default: ""
  - type: bool
    name: expired
    default: ""
  - type: text
    name: deadlineAt
    default: ""
---
${USER_PROMPT}
