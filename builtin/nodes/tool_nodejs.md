---
# 内置节点：执行 Node.js
description: |
  使用 agentflow apply -ai run-tool-nodejs 执行脚本。

  **成败判定：** 以脚本进程的 **exit code** 为准——0 = success，非 0 = failed。
  **结果输出：** 脚本 stdout 直接作为 result 槽位内容（纯文本即可，如 `console.log("hello")`）。
  stdout 为空且 exit code 非 0 时，stderr 信息会写入失败消息。

  **JSON 兼容（可选）：** 若 stdout 为 `{"err_code":0,"message":{"result":"..."}}` 格式，err_code 将覆盖 exit code 语义、message.result 写入 result 槽位。仅在需要与 exit code 不同的成败语义时使用。

  **直接执行模式（推荐）：** 在 flow.yaml 实例中设置 `script` 字段，流水线将跳过 AI 直接执行。
  `script` 支持 ${} 占位符（workspaceRoot、flowName、runDir、flowDir 及所有 input/output 槽位），值自动 shell-quote。
  flowDir 为当前流水线 flow.yaml 所在目录的绝对路径，可用于引用同目录下的脚本文件。
  示例：`script: node ${flowDir}/scripts/my-check.mjs --root ${workspaceRoot} --input ${todo}`

  **引脚路径约束（重要）：** 脚本读取的文件路径和写入的文件路径**必须通过引脚传入**，禁止在脚本内部自行拼接输出路径。
  - 所有 input 类型为「文件」的槽位（如 `figma_tree`、`semantic_outline`）由流水线解析上游连线后注入，脚本通过命令行参数接收。
  - 所有 output 类型为「文件」的槽位（如 `restore_todolist`、`screenshot_map`）由流水线按 `output/<instanceId>/node_<instanceId>_<slot>.md` 约定生成绝对路径，脚本同样通过命令行参数接收后直接写入。
  - `script` 字段中用 `${槽位名}` 引用即可获得正确路径，如 `--figma-tree ${figma_tree} --output ${restore_todolist}`。
  - **禁止**在脚本中用 `outDirForNode`、手写 `node_<instance>_xxx.json` 等方式自行构造路径——这会导致脚本产物路径与流水线解析器约定不一致，下游节点找不到文件。

  **AI 执行模式（兼容）：** 无 `script` 字段时，由 AI agent 读取 body 并手动执行命令。

  **底层用法：**
  agentflow apply -ai run-tool-nodejs <workspaceRoot> <flowName> <uuid> <instanceId> [execId] -- <scriptCmd> [args...]
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
