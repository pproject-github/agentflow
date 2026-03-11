---
# 内置节点：转布尔
description: 获取下文中 AgentSubAgent 运行的结果，得到布尔结论后写入 ${prediction}。prediction 槽位类型为 bool，写入 output 文件时，文件内容必须仅为 "true" 或 "false"，不得写入说明、统计、结论等整段 markdown。
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
