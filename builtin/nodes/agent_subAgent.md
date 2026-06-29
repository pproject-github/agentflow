---
# 内置节点：子 Agent
description: 利用子 Agent 执行任务；可接收 workspaceContext 切换执行工作区，并接收 skillsContext / mcpContext 注入已加载 skills 与 MCP 工具清单。
displayName: 子 Agent
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: workspaceContext
    default: ""
  - type: text
    name: skillsContext
    default: ""
  - type: text
    name: mcpContext
    default: ""
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
