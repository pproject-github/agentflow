---
# 内置节点：子 Agent
runtime: native
description: 利用子 Agent 执行任务；新流程优先接收一个强类型 context Bundle。knowledgeContext、workspaceContext、skillsContext、mcpContext 保留为旧流程兼容引脚。
displayName: 子 Agent
input:
  - type: node
    name: prev
    default: ""
  - type: context
    name: context
    default: ""
    showOnNode: true
  - type: text
    name: workspaceContext
    default: ""
  - type: text
    name: skillsContext
    default: ""
    showOnNode: true
  - type: text
    name: mcpContext
    default: ""
  - type: text
    name: knowledgeContext
    default: ""
    showOnNode: true
output:
  - type: node
    name: next
    default: ""
  - type: text
    name: result
    default: ""
    required: true
    showOnNode: true
---
${USER_PROMPT}
