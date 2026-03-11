---
# 内置节点：开始
description: agentflow 的入口，所有流程应从这个节点开始
displayName: Start
input: []
output:
  - type: 节点
    name: next
    default: ""
---
${USER_PROMPT}