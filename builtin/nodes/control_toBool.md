---
# 内置节点：转布尔
description: Convert execution task result to boolean and write to prediction slot
displayName: ToBool
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: value
    default: ""
output:
  - type: node
    name: next
    default: ""
  - type: bool
    name: prediction
    default: ""
---
${USER_PROMPT}
