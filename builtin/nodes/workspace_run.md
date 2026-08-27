---
# 内置节点：Run
runtime: native
type: control
description: Workspace 图的运行入口。点击运行时，从本节点出发沿控制边选出子图并执行；本节点自身不产生输出。
displayName: Run
input:
  - type: node
    name: prev
    default: ""
output:
  - type: node
    name: next
    default: ""
---
Run the downstream workspace subgraph connected from this node.
