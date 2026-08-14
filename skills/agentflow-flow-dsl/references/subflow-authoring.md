# 子流程与 `control.while` 编写规范

## 目录

1. 选型
2. 普通子流程 DSL
3. While 的状态模型
4. While DSL 契约
5. 用户可见画布语义
6. 手动编辑方式
7. 运行与 Preview 验收

## 1. 选型

按以下边界选型：

- 复用一段标准 AgentFlow 节点拓扑时，用 `flow.subflow` + `flow.call`。
- 按状态重复执行同一套 Condition/Body 拓扑时，用 `control.while`。
- 封装一个确定性计算或外部工具调用时，用代码节点，不要伪装成子流程。
- 多个角色、阶段或业务分支只执行一次时，继续使用父图中的普通节点和控制流，不要全部塞进 While。

子流程内部仍是普通 AgentFlow 节点。父流程通过显式输入/输出契约调用它，不得直接连接内部节点。

## 2. 普通子流程 DSL

按 `flow.input`、`flow.subflow`、`flow.call` 三层声明：

```js
const issueIn = flow.input("issue", "text");
const inspect = agent.subAgent(
  "分析单个 Issue",
  { issue: issueIn.value },
  `只分析本次输入的一个 Issue，给出目标、风险和下一步。`,
);
const normalize = agent.subAgent(
  "规范化交付摘要",
  { analysis: inspect.result },
  `输出父流程可直接展示的摘要。`,
);

export const inspectIssue = flow.subflow(
  "Issue 单项分析",
  { issue: issueIn },
  flow(inspect, normalize),
  { summary: normalize.result, raw: inspect.result },
);

const callInspect = flow.call(
  "调用 Issue 分析子流程",
  inspectIssue,
  { issue: pendingIssue.value },
);
const { summary, raw } = callInspect;
export const run = flow("Run", callInspect, showSummary);
```

遵守以下约束：

- 每个契约输入绑定一个 `flow.input(name, type)`，内部消费者读取它的 `.value`。
- `flow.subflow(label, inputs, flow(...), outputs)` 的第三个参数是非空内部控制链。
- 每个契约输出绑定内部成员节点的输出槽。
- `flow.call(label, subflow, pins)` 是父流程里的真实执行节点；动态数据引脚来自子流程契约。
- 一个内部节点只能属于一个子流程。禁止直接跨边界连线、跨子流程连线和递归调用。
- 当前子流程内部不接受 `wait/deferred`。需要暂停 While 时，由 Condition 返回 `wait`。

执行上下文跨子流程时使用强类型契约，不要拆回四根文本线，也不要跨边界直连：

```js
const contextIn = flow.input("context", "context");
const inspect = agent.subAgent("分析", { context: contextIn.value }, `使用已授权上下文分析。`);

export const inspectWithContext = flow.subflow(
  "带上下文的分析",
  { context: contextIn },
  flow(inspect),
  { result: inspect.result },
);

const callInspect = flow.call("调用分析", inspectWithContext, { context: prdContext });
```

`context` 只承载知识、Skills、Workspace、MCP 等执行资源；业务参数仍逐项声明。运行时传递已解析
Bundle，但凭证始终由环境持有，不写入 DSL 或子流程输出。

普通子流程的输出契约可以变化。画布编辑器中把某个内部数据输出拖到 Return 的 `add output`，再命名
输出；重命名或删除后，所有父图 `SUBFLOW CALL` 的同名输出及相关连线必须同步迁移或移除。

## 3. While 的状态模型

把 While 理解为以下状态迁移，而不是一条隐藏的回边：

```text
初始 state₀
  → Condition(stateₙ)
      ├─ continue → Body(stateₙ) → stateₙ₊₁ → 下一轮 Condition
      ├─ wait     → 保存 checkpoint，暂停 Run
      ├─ done     → 结束 While，继续父流程下游
      └─ fail     → While 失败
```

只把业务上需要跨轮保留的数据放入 `state`，例如：

```json
{
  "cursor": 2,
  "records": [{ "id": "U-001" }, { "id": "U-002" }],
  "valid": [{ "id": "U-001" }],
  "invalid": []
}
```

每轮 Body 必须返回完整的下一版 `state`。业务变量不要增加成 While 顶层输出，也不要依赖隐藏的
局部变量；把它们作为 `state` 的 JSON 字段显式更新。

`iteration` 是运行时绝对轮次，`idempotencyKey` 是逐轮稳定幂等键。它们属于执行上下文，不是业务
状态：DSL 契约必须声明，产品画布默认隐藏，普通用户不需要连接或配置。只有高级 DSL/代码节点确实
需要轮次或外部写幂等时，才在内部消费它们。

## 4. While DSL 契约

优先使用显式 Condition/Body 子流程：

```js
const conditionState = flow.input("state", "json");
const conditionContext = flow.input("context", "context");
const conditionIteration = flow.input("iteration", "text");
const check = agent.subAgent(
  "判断是否继续",
  { context: conditionContext.value, state: conditionState.value },
  `检查 state。只返回 continue、wait、done 或 fail 之一。`,
);

export const shouldContinue = flow.subflow(
  "是否继续",
  { context: conditionContext, state: conditionState, iteration: conditionIteration },
  flow(check),
  { decision: check.result },
);

const bodyState = flow.input("state", "json");
const bodyContext = flow.input("context", "context");
const bodyIteration = flow.input("iteration", "text");
const bodyKey = flow.input("idempotencyKey", "text");
const step = tool.nodejs(
  "推进一轮",
  { context: bodyContext.value, state: bodyState.value, idempotencyKey: bodyKey.value },
  `node ${flowDir}/scripts/advance-one.mjs`,
);
const nextState = control.parseJson("校验下一版状态", { value: step.result });

export const advanceOne = flow.subflow(
  "执行一轮",
  { context: bodyContext, state: bodyState, iteration: bodyIteration, idempotencyKey: bodyKey },
  flow(step, nextState),
  { state: nextState.result },
);

const initial = provide.json("初始状态", {
  value: "{\"cursor\":0,\"records\":[],\"valid\":[],\"invalid\":[]}",
});
const loop = control.while("逐条处理", {
  context: prdContext,
  state: initial.value,
  maxIterations: "20",
  timeout: "30m",
}, shouldContinue, advanceOne);

const summarize = agent.subAgent("生成最终摘要", { state: loop.state }, `把最终 state 整理成 Markdown。`);
const report = display.markdown("最终结果", { content: summarize.result });
export const run = flow("Run", loop, summarize, report);
```

固定契约如下：

| 子流程 | DSL 输入 | DSL 输出 | 产品画布中用户需要理解的部分 |
|--------|----------|----------|--------------------------------|
| Condition | `state:json`, `iteration:text`；可选 `context:context` | 必需 `decision:text`；可选 `summary:text` | `state → decision` |
| Body | `state:json`, `iteration:text`, `idempotencyKey:text`；可选 `context:context` | 必需 `state:json`；可选 `summary:text` | `stateₙ → stateₙ₊₁` |

`context:context` 是 Condition/Body 的可选显式输入。While 顶层连接 Context 后，运行时在循环开始时
捕获一次，并只转发给声明了该输入的子流程。它不属于业务状态，不进入 Return、history 或 checkpoint。

While Return 是固定契约：Condition 只能返回 `decision/summary`，Body 只能返回 `state/summary`。
不要在 While Return 添加任意顶层变量。普通 Subflow Return 才支持动态输出。

只在兼容旧流程时使用脚本式 While：

```js
const loop = control.while("推进", {
  state: initial.value,
  maxIterations: "20",
  timeout: "30m",
}, `node ${flowDir}/scripts/advance-one.mjs`);
```

旧脚本 stdout 只能是 `{"decision":"continue|wait|done|fail","state":{},"summary":"..."}`；日志写
stderr。新流程不要用脚本替代 Condition/Body 子流程。

## 5. 用户可见画布语义

保持“运行时完整、产品上不暴露噪音”：

- 父图把普通调用显示为独立的 **SUBFLOW CALL** 节点，动态输入/输出与声明契约同名。
- 父图把 While 显示为状态机卡片：左侧 `state` 是初始业务状态输入，右侧 `state` 是最终业务状态。
- While 卡片中的 Condition/Body 是可进入的子流程入口；`maxIterations` 和 `timeout` 可直接配置。
- While 卡片明确展示 `stateₙ → check → run → stateₙ₊₁`，运行后展示当前 state、最新结果和历史。
- `CHECKS`、`RUNS`、`CALLS` 虚线只表示调用关系，由系统生成，不是数据线或控制线，也不能手拉。
- 点击 Condition、Body 或普通 Subflow 卡片进入独立子流程编辑模式；不要删除父图的调用关系视图。
- 子图显示可拖动的 **SUBFLOW START** 和 **SUBFLOW RETURN**，复用普通节点的 Port Rail、Handle、
  选中和拖动规则。
- While 的 Start 只展示业务 `state`；隐藏 `iteration/idempotencyKey`。它们仍留在 DSL/IR 中由运行时注入。
- While Return 显示固定锁定契约。Body Return 有可用值时展示 state 字段、类型和预览，并可定位来源节点。
- 普通 Subflow Return 显示 `add output`，允许新增、重命名和删除契约输出。
- `workspace_subflow_input` 是 IR 输入代理，画布不重复显示；Start 的同名输出线代表它的真实绑定。

React 组件名、CSS 类名和像素尺寸属于实现细节，不写入 DSL。

## 6. 手动编辑方式

创建 While 后按以下方式操作：

1. 从普通 JSON 数据节点的输出引脚连接到 While 左侧 `state`。
2. 在 While 卡片中设置最大轮次和超时。
3. 点击 Condition 卡片进入编辑器，添加判断节点；连接 Start `next` 到首节点 `prev`，连接 Start
   `state` 到判断节点数据输入，连接末节点 `next` 到 Return `prev`，再把结果连到 Return `decision`。
4. 点击 Body 卡片进入编辑器，连接 Start `state` 到单轮处理节点，最后把完整下一版 JSON 状态连到
   Return `state`；文本结果先经过 `control.parseJson`。
5. 需要摘要时连接可选 `summary`。不要寻找或手工连接 `iteration/idempotencyKey` 产品引脚。
6. 需要知识库、Skills 或代码仓时，把 Context Bundle 接到 While 的紫色 `context` 引脚；在需要它的
   Condition/Body 子图 Start 契约中声明 `context`，再接到内部 Agent。不要把 Context 放进 state。
7. 返回父图，确认 Condition/Body 卡片、状态流说明和两条调用虚线仍存在。

创建普通子流程时，Start/Return 的控制线和数据线方式相同；区别是 Return 输出可以通过 `add output`
扩展，父图 SUBFLOW CALL 会同步出现同名输出。

## 7. 运行与 Preview 验收

完成 DSL 后执行：

```bash
agentflow flow dsl lint <flowDir>
agentflow flow dsl layout <flowDir>
```

涉及子流程或 While 时，不能只凭 lint、单元测试或 DSL 文本宣称完成。打开真实 Workspace Preview：

1. 确认父流程只通过 SUBFLOW CALL 或 While 调用子流程，没有直接跨边界线。
2. 确认调用虚线稳定落到对应 Start，且不会被误读成 `next` 控制线。
3. 确认 Start/Return 可拖动，保存刷新后位置和契约不丢失。
4. 确认普通子流程多输出在 Return 与 Call 两侧逐项对应。
5. 确认 While 只暴露业务 state，Condition/Body 固定输出正确，运行时字段没有泄露到普通 UI。
6. 确认节点高度随内容收敛，没有大面积空白、越界历史或重叠引脚。
7. 实际运行至少两轮，验证 `state` 确实变化；`continue` 才启动 Body，`done` 继续下游，`wait` 保存
   checkpoint 且不触发下游。
8. 重新运行等待中的 While，确认轮次、累计超时、历史和幂等键不重置。

任何一项失败，都先修正 DSL、投影或运行时，再重新 lint、测试和预览。
