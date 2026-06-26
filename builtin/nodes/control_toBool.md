---
# 内置节点：代码转布尔（本地脚本执行，★ 可扩展输入）
description: "Script-based boolean conversion: executes script to produce true/false prediction. Like tool_nodejs but enforces bool output. Must have script field."
displayName: Code ToBool
input:
  - type: node
    name: prev
    default: ""
  - type: text
    name: value
    default: ""
    required: true
    showOnNode: true
output:
  - type: node
    name: next
    default: ""
  - type: bool
    name: prediction
    default: ""
    required: true
    showOnNode: true
extensible: true
---
${USER_PROMPT}
