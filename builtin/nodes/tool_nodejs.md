---
# 内置节点：执行 Node.js
description: |
  使用 agentflow apply -ai run-tool-nodejs 执行脚本。约定格式为 {"err_code":0,"message":{"result":"..."}}；err_code 为节点执行结果（0=成功、1=失败），后处理据此写 result.status。message 仅含 result（文本），无 next。执行器校验 stdout 并提取 message.result 写入 ${result}。脚本异常或格式非法时节点为 failed。

  **用法：**
  agentflow apply -ai run-tool-nodejs <workspaceRoot> <flowName> <uuid> <instanceId> [execId] -- <scriptCmd> [args...]

  **参数：** workspaceRoot 工作区根；flowName、uuid、instanceId 从 resultPath 解析；可选 execId 为本轮 execId（第二轮起必须传）；-- 后为脚本命令，如 node path/to/script.mjs [args...]。仅当 prompt 中给出「请直接执行以下命令」时使用，按 prompt 中的完整命令执行即可。

  **返回值：** 成功 exit code 0；失败非 0。
displayName: NodeJs
input:
  - type: 节点
    name: prev
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
