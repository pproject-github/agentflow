---
# 内置节点：醒目输出
description: Output content to user with special font style
displayName: Print
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: content
    default: ""
    required: true
    showOnNode: true
output:
  - type: node
    name: next
    default: ""
---
Print `${content}` to the user.
