---
# 内置节点：按 key 读取
description: "由 agentflow apply 流程内部执行。命令：agentflow apply -ai run-tool-nodejs <workspaceRoot> <flowName> <uuid> <instanceId> <execId> -- node <path>/load-key.mjs <workspaceRoot> <flowName> <uuid> <key>。返回（stdout 一行 JSON）：{ \"err_code\": 0, \"message\": { \"result\": \"<value>\" } }（err_code 0=成功 1=失败）；result 写入节点的 result 槽位。"
displayName: LoadKey
input:
  - type: 节点
    name: prev
    default: ""
  - type: 文本
    name: key
    default: ""
output:
  - type: 节点
    name: next
    default: ""
  - type: 文本
    name: result
    default: ""
---
${USER_PROMPT}
