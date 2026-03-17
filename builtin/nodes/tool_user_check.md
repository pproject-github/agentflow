---
# 内置节点：用户确认
description: 等待用户确认，流程暂停。需用户回复 "继续" 才重启流程。
displayName: UserCheck
input:
  - type: 节点
    name: prev
    default: ""
output:
  - type: 节点
    name: next
    default: ""
---
${USER_PROMPT}