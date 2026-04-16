---
# 内置节点：用户选择（Switch 分支）
description: 等待用户从多个选项中选择一个，流程暂停；按用户选择沿对应出边分支继续。每个 output 槽位对应一条分支，槽位的 description 作为选项文案。
displayName: UserAsk
input:
  - type: node
    name: prev
    default: ""
  - type: file
    name: question
    description: 要展示给用户的问题（Markdown 格式，可选）
    default: ""
output:
  - type: node
    name: option_0
    description: 选项 0
    default: ""
  - type: node
    name: option_1
    description: 选项 1
    default: ""
---
${USER_PROMPT}
