---
# 内置节点：直接提供 JSON
runtime: native
type: provide
description: 提供经过校验的 JSON 值，输出可以直接连接 json 类型输入。
displayName: JSON
output:
  - type: json
    name: value
    default: "null"
    required: true
    showOnNode: true
---
${USER_PROMPT}
