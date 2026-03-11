---
# 内置节点：按 key 写入
description: "由 agentflow apply 流程内部执行。命令：agentflow apply -ai run-tool-nodejs <workspaceRoot> <flowName> <uuid> <instanceId> <execId> -- node <path>/save-key.mjs <workspaceRoot> <flowName> <uuid> <key> <value>。返回（stdout 一行 JSON）：{ \"err_code\": 0, \"message\": { \"result\": \"<写入的 value>\" } }（err_code 0=成功 1=失败）。"
displayName: SaveKey
input:
  - type: 节点
    name: prev
    default: ""
  - type: 文本
    name: key
    default: ""
  - type: 文本
    name: value
    default: ""
output:
  - type: 节点
    name: next
    default: ""
---
${USER_PROMPT}
