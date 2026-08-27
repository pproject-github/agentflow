---
# 内置节点：一键任务
runtime: native
type: agent
description: 输入任务描述，选择 Skills、workspace 上下文和输出类型后直接运行；等价于「Load Skills + 子 Agent + Display」的合并节点。
displayName: 一键任务
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: skillKeys
    default: ""
    showOnNode: false
  - type: bool
    name: includeWorkspaceContext
    default: "true"
    showOnNode: false
  - type: text
    name: displayType
    default: "markdown"
    showOnNode: false
  - type: text
    name: knowledgeContext
    default: ""
    showOnNode: false
  - type: text
    name: workspaceContext
    default: ""
    showOnNode: false
output:
  - type: node
    name: next
    default: ""
  - type: text
    name: content
    default: ""
    showOnNode: true
  - type: text
    name: displayType
    default: "markdown"
    showOnNode: false
---
输入任务，选择 Skills、workspace 上下文和输出类型后直接运行。
