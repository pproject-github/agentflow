---
# 内置节点：调用子流程
runtime: native
type: control
palette: hidden
description: |
  调用 workspace.flow.js 中由 flow.subflow 声明的同 Workspace 子流程。
  输入和输出槽来自子流程契约；每次调用使用独立调用帧，内部节点仍按标准 AgentFlow DSL 和运行时执行。
displayName: Call Subflow
ui:
  card:
    template: details
    icon: account_tree
    tone: purple
    sections:
      - type: subflow
        label: Called subflow
input:
  - type: node
    name: prev
    default: ""
output:
  - type: node
    name: next
    default: ""
---
Execute the referenced inline subflow using its declared input and output contract.
