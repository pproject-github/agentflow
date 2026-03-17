---
# 内置节点：按 key 读取环境/配置
description: "命令：agentflow apply -ai get-env <workspaceRoot> <flowName> <uuid> <instanceId> <execId> <key>。<key>传入 ${key}，并将结果写入 ${value}。"
displayName: GetEnv
input:
  - type: 文本
    name: key
    default: ""
output:
  - type: 文本
    name: value
    default: ""
---
${USER_PROMPT}
