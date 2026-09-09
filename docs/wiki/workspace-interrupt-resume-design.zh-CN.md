# Workspace Interrupt / Resume 设计（第二项 Todo）

## 结论

AgentFlow 当前已经具备“可持久化等待”的底座，但尚未具备 LangGraph 意义上的统一人工中断/恢复协议。

现有能力可以概括为：

- `Run State`：按 `runId` 保存共享业务状态、revision、事件和 checkpoint 历史。
- `control.while`：节点返回 `wait` 时保存循环状态；再次以相同输入运行时，可从下一轮继续。
- Jenkins deferred：服务端保存队列/构建 checkpoint，后台轮询后自动继续。
- UI：可以展示 `waiting`、节点等待状态和 Run State，但没有通用的“提交恢复值”入口。

因此，当前状态是“等待机制分散且部分自动恢复”，不是完整的 interrupt/resume。

## 与 LangGraph 的语义对照

| LangGraph | AgentFlow 当前 | 差距 |
| --- | --- | --- |
| `thread_id` 隔离状态和 checkpoint | `runId` 隔离 Run State、日志和运行目录 | 基本对应，但没有统一的恢复协议 |
| `interrupt(value)` 返回结构化中断值 | `control.while` 的 `wait` 或 Jenkins deferred | 缺少通用中断 payload 和 reason/type |
| `Command(resume=value)` | 没有统一的 Workspace resume API | 核心缺口 |
| checkpoint 保存下一步位置和状态 | Run State checkpoint + 节点输出缓存 | 没有明确的 resume cursor / pending interrupt |
| 同一 thread 恢复，已完成节点不重复执行 | 依赖节点输入 fingerprint/cache | 对人工中断没有明确的重放/幂等约束 |
| interrupt 节点恢复时从节点开头重新执行 | `control.while` wait 恢复下一轮；其它节点无通用定义 | 语义不统一 |
| checkpointer 支持历史、回溯、fork/time-travel | 只有 Run State checkpoint 历史 | 尚无 checkpoint 选择、fork、time-travel |
| 子图可 interrupt/resume | `control_subflow_call` 遇到 pause/deferred 会失败 | 明确缺口 |
| 每个 superstep 可检查点 | 当前主要在节点完成/等待时记录 | 检查点粒度较粗 |

## 目标协议

### 1. 中断记录

每个可中断 Run 在 `runId` 下保存一个 pending interrupt：

```json
{
  "version": 1,
  "runId": "run_...",
  "nodeId": "confirm_plan",
  "kind": "user_input",
  "reason": "plan_confirmation",
  "value": {
    "content": "...",
    "format": "markdown"
  },
  "resumeSchema": {
    "type": "object",
    "required": ["approved"]
  },
  "checkpoint": {
    "runStateRevision": 3,
    "graphRevision": "..."
  },
  "status": "waiting",
  "createdAt": "..."
}
```

`value` 是展示给用户或外部系统的请求；`resumeSchema` 约束恢复输入。敏感字段仍按 Run State 规则脱敏。

### 2. 恢复请求

统一使用同一个 `runId`，而不是新建一个 Run：

```http
POST /api/workspace/run/resume
```

```json
{
  "flowId": "...",
  "flowSource": "user",
  "runId": "run_...",
  "resume": {
    "approved": true,
    "content": "用户修改后的计划"
  },
  "expectedRunStateRevision": 3
}
```

服务端必须：

1. 校验该 `runId` 处于 waiting，且 pending interrupt 存在。
2. 校验 `nodeId`、Run State revision 和恢复 payload schema。
3. 原子写入 resume 记录，防止重复提交。
4. 从保存的 resume cursor 继续执行；已完成节点不得重新执行。
5. 产生 `run-resumed`、`interrupt-resolved`、后续节点事件。
6. 服务重启后仍可恢复；恢复失败时保留原 checkpoint 和错误原因。

### 3. 节点 DSL 形态

第一版建议提供显式的可复用节点，而不是让所有 `tool.nodejs` 自己猜协议：

```js
const approval = control.interrupt("确认方案", {
  kind: "user_input",
  reason: "plan_confirmation",
  value: plan.result,
  resumeSchema: { type: "object", required: ["approved", "content"] },
});
```

节点恢复时得到结构化 `resume` 值，并通过输出槽继续下游。节点本身应保证：

- 中断前的外部副作用可重复或使用幂等键。
- 恢复值写入 Run State 的位置明确。
- 同一 pending interrupt 只能消费一次。

已有 `control.while` 保留为“循环等待”专用能力，不把它继续扩展成人工审批协议。

## 第一阶段实现范围（可验收 MVP）

只实现人工确认这一条闭环：

1. 新增通用 `control.interrupt` 节点（单输入、单输出，支持 Markdown/JSON 请求内容）。
2. 新增 pending-interrupt 持久化文件，与 Run State 同一 `runId` 目录管理。
3. 新增 `/api/workspace/run/resume`，支持同一 Run 恢复。
4. 恢复时保留原 Run State revision，并把用户输入作为节点输出和可选 State patch 注入。
5. 工作台展示：等待原因、请求内容、恢复表单、恢复后 checkpoint/事件。
6. 服务重启后用同一 Run ID 恢复。
7. 子流程、并行 fork、time-travel 暂不纳入 MVP，避免把多个语义混在一起。

## 验收场景

### 场景 A：确认后继续

`生成计划 → interrupt(确认计划) → 执行计划 → 汇总报告`

- 首次运行：生成计划成功，Run 状态为 waiting，后续节点不执行。
- 工作台显示 interrupt payload 和恢复输入框。
- 提交 `approved=true`：同一 `runId` 恢复，只执行 interrupt 后面的节点。
- Run 日志中出现 `run-waiting → run-resumed → run-finished`。

### 场景 B：用户修改后继续

- 恢复 payload 携带修改后的 Markdown。
- 下游节点收到修改后的内容，而不是原始计划。
- Run State checkpoint 能看到恢复前后的 revision 和 changed keys。

### 场景 C：重复提交和服务重启

- 同一 pending interrupt 的第二次 resume 返回冲突，不重复执行下游。
- 服务重启后 waiting Run 仍能查询、恢复，且不会丢失运行目录和 checkpoint。

## 暂不承诺

- 不把当前 `control.while wait` 宣称为完整 LangGraph interrupt。
- 不在第一阶段实现任意节点级 time-travel、checkpoint fork 或真正并行恢复。
- 不把旧 `tool_user_check/tool_user_ask` 直接恢复到 Workspace；它们目前仍属于 retired legacy runtime，需要新协议适配。

## HTTP API MVP

外部系统使用以下接口（生产环境必须通过网关/API Token 鉴权）：

```http
GET  /api/v1/flows/{flowId}/runs/{runId}
GET  /api/v1/flows/{flowId}/runs/{runId}/interrupts
POST /api/v1/flows/{flowId}/runs/{runId}/resume
```

恢复请求示例：

```json
{
  "interruptId": "int_abc123",
  "input": {
    "approved": true,
    "content": "用户修改后的计划"
  },
  "idempotencyKey": "wecom-event-98231"
}
```

当前实现已提供持久化 interrupt 记录、查询接口和统一 resume 路由；企业微信适配器仍应在网关层完成签名校验、用户映射和卡片回调转换。

## 审核链接：谁发的，什么时候才生效

外部审核入口是 `/review/plan?token=<reviewToken>`。token 由
`tool_display_share_link` 节点在建分享记录时生成，**但让它生效的中断记录是下游
`control_interrupt` 节点执行时才写的**。两件事分属两个节点，中间隔着的任何一次
失败、停止或进程重启，都会留下一条永远打不开的链接。

因此：

- `tool_display_share_link` 的 `url` 跟着图走——只有当某个 `control_interrupt`
  节点用 `resumeToken` 接了本节点的 `reviewToken` 输出时，它才是审核入口；否则
  它就是展示分享页 `/display/<shareId>`。审核入口另有 `reviewUrl` 输出。
  没有中断节点消费的审核链接不是「过期」，是**从发出去就打不开**。
- 分享记录写入 `runId`，token 一发出去就能反查是哪一次运行。
- `/review/plan` 按 token 状态分开回答，不再用一句「已失效或已处理」打发所有情况：

  | 状态 | 页面 | `/api/v1/public/reviews/:token` |
  | --- | --- | --- |
  | 中断在等 | 审核页 | 200 |
  | 已被处理 | 谁批的、何时、同意还是驳回 | 410 |
  | Run 还没跑到审批节点 | 每 10 秒自动刷新 | 425 |
  | Run 在到达审批节点前已结束 | 说明链接不会再生效，带失败原因 | 410 |
  | 有分享记录但从无审批登记 | 302 跳 `/display/<shareId>` | — |
  | token 不属于本机 | 链接无效 | 404 |

  「Run 还在跑」的判定看运行日志索引的最后动静：超过 10 分钟没有进展，就按
  「已中断」处理，免得页面永远劝人再刷新一次。
