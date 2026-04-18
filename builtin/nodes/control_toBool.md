---
# 内置节点：转布尔（本地脚本执行，★ 可扩展输入）
description: "Script-based boolean conversion: executes script to produce true/false prediction. Like tool_nodejs but enforces bool output. Must have script field."
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
extensible: true
---
${USER_PROMPT}
