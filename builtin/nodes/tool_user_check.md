---
# 内置节点：用户确认
description: 等待用户确认，流程暂停。展示确认内容给用户，用户可编辑/AI修改后保存，回复 "继续" 后重启流程。
displayName: UserCheck
input:
  - type: node
    name: prev
    default: ""
  - type: file
    name: content
    description: 要展示给用户确认的内容（Markdown 格式）
    default: ""
output:
  - type: node
    name: next
    default: ""
  - type: file
    name: content
    description: 用户确认后的内容（可能已编辑/AI修改）
    default: ""
---
${USER_PROMPT}