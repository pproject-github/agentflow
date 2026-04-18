---
# 内置节点：AI 转布尔（agent 执行）
description: "AI-powered boolean judgment: an agent evaluates the input value and writes true/false to prediction. Use for non-deterministic scenarios requiring semantic understanding."
displayName: Agent ToBool
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: value
    default: ""
output:
  - type: node
    name: next
    default: ""
  - type: bool
    name: prediction
    default: ""
---
${USER_PROMPT}
