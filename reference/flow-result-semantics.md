# AgentFlow Result 语义

供 AI 与流程编写参考：**intermediate 中的 result 文档表示节点自身执行状态**。

## 约定

- **result.status**：表示**本节点是否执行成功**，不是「业务结果是否通过」。
  - **success**：节点已正常执行完毕（脚本跑完且输出合法、或逻辑完成）。
  - **failed**：节点执行失败，例如依赖的输入不存在（配置错误）、脚本异常或输出格式非法。

## 示例

- **agent_ai_check_tool**：若依赖的输入文件（如 `output/node_AI_CHECK_FILE_value.md`）不存在，属配置错误 → 应写 **failed**，message 如「找不到依赖的输入文件」。
- **tool_check（tool_nodejs）**：脚本 stdout 为合法 JSON、output 已写入后，后处理根据脚本返回的 **err_code** 写 result.status：**err_code 0 → success**，**err_code 1 → failed**。节点执行结果即由 err_code 表示。
