---
# 内置节点：用户提问
description: 利用 **Ask user question** tool 询问用户以下问题
displayName: UserAsk
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