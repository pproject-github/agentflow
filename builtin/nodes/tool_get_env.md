---
# 内置节点：按 key 读取环境/配置
description: Get environment variable value
displayName: GetEnv
input:
  - type: text
    name: key
    default: ""
    required: true
    showOnNode: true
output:
  - type: text
    name: value
    default: ""
    required: true
    showOnNode: true
---
${USER_PROMPT}
