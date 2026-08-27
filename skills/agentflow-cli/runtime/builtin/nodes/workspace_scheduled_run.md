---
# 内置节点：Scheduled Run
runtime: native
type: control
description: 定时运行入口。与 Run 相同的执行语义，区别是由调度器按节点 body 中的 JSON 排程配置触发。
displayName: Scheduled Run
input:
  - type: node
    name: prev
    default: ""
output:
  - type: node
    name: next
    default: ""
---
Run the downstream workspace subgraph on a schedule.
