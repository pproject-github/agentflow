---
# 内置节点：子流程输入
runtime: native
type: control
palette: hidden
description: 子流程调用帧的输入代理。只允许通过 flow.input 创建，不在节点面板中展示。
displayName: Subflow Input
input: []
output:
  - type: text
    name: value
    default: ""
---
Expose one value injected by a flow.call invocation.
