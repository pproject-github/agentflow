# 内置流程模板

`builtin/pipelines/` 下的模板是装了 AgentFlow 就有的东西，排在流程列表最前面。它们同时
是「这套系统该怎么用」的示范，所以必须真的能跑。

现在有两个：

| 目录 | 做什么 |
|------|--------|
| `new` | 新建流程：规划 → 人工确认 → 生成 `workspace.flow.js` → lint 修复 |
| `module-migrate` | 模块迁移：定范围 → 人工确认 → 建模块 → 迁移 → 静态检查 → 编译修复 → 出文档 |

## 它们曾经是死的

两个模板都建在 Start/End Pipeline 上——`control_start`、`control_end`、
`tool_user_check`、`control_anyOne`、`control_toBool`、`tool_print`、`tool_save_key` /
`tool_load_key`。这些节点的 `runtime:` 全是 `none`，退休的执行栈之外没有实现，连节点面板
都进不去。module-migrate 29 个节点里有 13 个是这类，new 21 个里有 7 个。

更直接的问题是：它们只有 `flow.yaml`，没有 `workspace.flow.js`，所以在画布上读出来是
**0 个节点**。用户点进去看到一张空画布。装了就有两个跑不起来的示例，比没有示例更糟。

`test/builtin-pipeline-templates.test.mjs` 现在盯着这几件事：图必须是代码、lint 无 error、
节点类型的 `runtime:` 不能是 `none`、保存一次不能退回 JSON、坐标不能堆成一坨、`script`
引用的脚本文件必须存在且不含绝对路径。

## 迁移时改掉的四类东西

### 1. 环 → 要么展开成固定轮次，要么用 control.while 收进节点里

Workspace 运行计划是 DAG，有环直接拒绝。原来那圈
`control_anyOne` + `control_toBool` + `control_if` 是在图上表达「改到通过为止」。

两种改法，按性质选：

- **换个角色才能继续的**（查出问题 → 换修复 agent → 再查），展开成固定两轮嵌套 gate。
  两轮都没过就落到「需要人工介入」的 display，不假装还能自动收敛。
- **同一个确定性动作反复推进的**，用 `control.while`。每轮 step 返回
  `continue / wait / done / fail`，并受跨 `wait` 累计的 `maxIterations` 与 `timeout` 保护；
  图上不产生回边。外部写操作使用逐轮稳定的 `AGENTFLOW_WHILE_IDEMPOTENCY_KEY` 去重。
- **同一个 agent 角色内部反复推理的**，仍可收进一个 agent 回合。原来那圈图纯属把节点内
  的逻辑摊到了图上。

module-migrate 的静态检查走第一种（两轮），编译走第二种（一个 `buildA` 节点里串行做完）。
节点数从 29 变成 32，但真正的分支只多了一层。

### 2. `tool_user_check` → `flow.resume`

Workspace 没有「暂停等用户点确认」的节点，但有 run-to-run 接力：

```js
export const scopeRun = flow("① 定范围", scope, showScope);
export const migrateRun = flow("② 建模块并迁移", newModule, migrate, /* … */);
flow.resume(showScope, migrateRun);
```

跑 ① 时执行计划走到 `migrateRun` 就停下（`pauseNodeIds`），结果显示在画布上，人看完点
② 才继续。这就是人工闸门。

### 3. `tool_save_key` / `tool_load_key` → 直接连线

原来用键值对在图的两端传 `newFlow`、`moduleName`。Workspace 的数据边就是干这个的，
一对 save/load 换成一条边。new 模板因此少了 4 个节点。

### 4. 硬编码 → 引脚

`iHeima/src/main/java/com/yy/iheima/push/` 这种业务路径原来写死在节点正文里。现在提成
`provide.str`，正文用插值引用：

```js
const sourcePath = provide.str("待迁移的源码路径", { value: "app/src/main/java/com/example/push/" });
const scope = agent.subAgent("确定迁移范围", {}, `确定 ${sourcePath.value} 的迁移范围。…`);
```

## 判定尽量交给脚本，别交给模型

`control.agentToBool` 是 `runtime: degraded`：没有任何东西约束模型输出，而 `parse-bool`
只认 `true` / `1` / `yes` / `on`——模型回「是」或「true（因为…）」都会静默变成 false。

能用脚本判的就用脚本。`control.if` 只看自己 `prediction` 槽（`bool` 类型）的值，上游是
什么节点无所谓，所以一个 `tool.nodejs` 往输出槽里写 `true` / `false` 就够了：

```js
const lint = tool.nodejs("lint 校验", { flowId: flowId.value },
  `node ${flowDir}/scripts/lint-flow.mjs ${flowId} ${ok} ${report}`);
const { ok, report } = lint;
const gate = control.if("过了吗", { prediction: ok }, flow(passed), flow(fix, /* … */));
```

脚本节点**总是 exit 0**：lint 没过不是这一步失败，是下一步要修的事。真正的失败只有
「命令跑不起来」。

module-migrate 里 `scripts/gate.mjs` 把脚本判定和 AI 判定合成一个 bool，同样是为了不让
`control.agentToBool` 决定流程走向。只有「从一段散文里判断编译过没过」这种真需要模型的
地方才留了 `control.agentToBool`，lint 会为它报两条 warning——那是提醒，不是错误。

## 不再带 flow.yaml

模板目录现在只有 `workspace.flow.js` + `workspace.layout.json` + `scripts/`。

一度还留着一个空壳 `flow.yaml`——因为「目录能不能被 catalog 认出来」和「列表说明从哪读」
当时都系在它身上。这两件事已经拆开了：目录识别走 `paths.mjs` 的 `isFlowDir`（三种标记文件
任一即可），列表说明走 `workspace.layout.json` 的 `description`（`ui.description` 往返时由
`extractLayout` 透传到那里）。所以空壳可以删了。
