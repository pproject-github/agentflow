---
runtime: native
palette: standard
description: |
  创建一个持久化人工中断。首次执行时把请求内容展示给外部渠道并暂停 Run；
  通过同一个 runId 调用 resume 后，节点输出恢复值并继续下游。
displayName: Interrupt
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: value
    description: 展示给用户或外部系统的内容
    default: ""
    required: true
  - type: text
    name: reason
    description: 中断原因
    default: user_confirmation
  - type: text
    name: resumeSchema
    description: 恢复输入 JSON Schema（简化版）
    default: '{"type":"object"}'
  - type: text
    name: resumeToken
    description: 可选。与外部审核链接绑定的一次性 token
    default: ""
  - type: text
    name: approvers
    description: 可选。审批人 userId/用户名，支持 JSON 数组或逗号分隔；为空表示仅外部审核链接
    default: "[]"
    showOnNode: true
  - type: text
    name: approvalMode
    description: 审批模式：any 任一审批人通过（当前支持）
    default: "any"
    showOnNode: true
output:
  - type: node
    name: next
    default: ""
  - type: text
    name: resume
    description: 用户恢复时提交的 JSON 或文本
    default: ""
  - type: text
    name: interruptId
    default: ""
ui:
  card:
    template: state-machine
    icon: pending_actions
    tone: amber
    sections:
      - type: binding
        label: 等待确认内容
        input: value
      - type: binding
        label: 审批人
        input: approvers
      - type: binding
        label: 审批模式
        input: approvalMode
      - type: decision
        label: 人工审批结果
        output: resume
        options:
          - value: confirmed
            label: 已确认，继续执行
            tone: green
          - value: rejected
            label: 已驳回，等待修改
            tone: red
      - type: summary
        label: 中断实例
        output: interruptId
---
${USER_PROMPT}
