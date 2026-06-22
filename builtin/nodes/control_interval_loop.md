---
# 内置节点：间隔循环
description: Wait by interval and branch to continue, done, timeout, or cancelled for watch-style flows.
displayName: IntervalLoop
input:
  - type: node
    name: prev
    default: ""
  - type: bool
    name: done
    default: ""
  - type: bool
    name: cancelled
    default: ""
  - type: text
    name: interval
    default: "10m"
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
    name: continue
    default: ""
  - type: node
    name: done
    default: ""
  - type: node
    name: timeout
    default: ""
  - type: node
    name: cancelled
    default: ""
  - type: text
    name: wakeAt
    default: ""
  - type: bool
    name: expired
    default: ""
  - type: text
    name: deadlineAt
    default: ""
---
${USER_PROMPT}
