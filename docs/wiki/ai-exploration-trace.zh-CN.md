# AI 探索运行图与 Trace 接入

Workspace 右上角的「探索」用于把 AI 执行过程分成四层保存和审核：

- `PLAN`：只读 Agent 生成的预计步骤，不执行工具、不修改 Workspace。
- `DRY-RUN`：副作用策略预检。当前版本只验证权限和副作用标记，不执行真实工具。
- `ACTUAL`：Agent 实际发生的工具、命令、文件和产物事件。
- `DSL`：审核后固化到 `workspace.flow.js` 的调整态，可继续试运行并按正常发布流程进入稳定态。

每次探索保存在当前流程目录的 `.workspace/agentflow/explorations/<session-id>/`。`trace.jsonl` 是追加写的事件日志，`materialization.json` 记录 Trace 与 DSL 节点的来源关系。

## 外部 Agent 接入

外部 Codex、Agent SDK 或其他执行器使用与 Web UI 相同的 Bearer Token。先创建 Session：

```http
POST /api/workspace/exploration
Authorization: Bearer <token>
Content-Type: application/json

{
  "title": "Codex 修复探索",
  "goal": "定位失败任务并生成修复流程",
  "mode": "observed",
  "status": "running",
  "source": { "provider": "codex", "agent": "external" }
}
```

响应中的 `exploration.id` 用于持续追加 Trace：

```http
POST /api/workspace/exploration/events
Authorization: Bearer <token>
Content-Type: application/json

{
  "id": "exp_xxx",
  "phase": "observed",
  "events": [
    {
      "id": "tool_1",
      "spanId": "tool_1",
      "parentSpanId": "turn_1",
      "type": "tool",
      "name": "exec_command",
      "summary": "读取失败日志",
      "status": "success",
      "sideEffect": "read",
      "inputPreview": "agentflow logs ...",
      "outputPreview": "发现超时错误"
    }
  ]
}
```

`type` 支持 `run / turn / decision / agent / tool / command / file / artifact / status`；`sideEffect` 支持 `none / read / write / external`。写入和外部操作会自动标记为需要审核。请求体也可以带 `status: "completed"` 和 `summary` 结束一次外部运行。

服务端会截断过长预览、过滤常见 Token/密钥格式，并将单次 Session 限制为 5000 个事件。不要把完整敏感输入作为 Trace 上报。
