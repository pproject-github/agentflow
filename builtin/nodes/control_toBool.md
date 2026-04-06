---
# 内置节点：转布尔
description: 根据下文的执行任务内容，得到 bool 结果后，将 "true" 或 "false" 写入到 ${prediction} ，且仅仅写入 true 或者 false。
displayName: ToBool
input:
  - type: 节点
    name: prev
    default: ""
  - type: 文本
    name: value
    default: ""
output:
  - type: 节点
    name: next
    default: ""
  - type: bool
    name: prediction
    default: ""
---
${USER_PROMPT}
