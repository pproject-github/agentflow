---
# 内置节点：SubAgent
description: 利用 SubAgent 执行任务；可接收 workspaceContext 切换执行工作区，并接收 skillsContext 注入已加载 skills。
displayName: SubAgent
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
output:
  - type: node
    name: next
    default: ""
---
${USER_PROMPT}
