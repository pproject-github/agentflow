---
name: agentflow-flow-dsl
description: >-
  用 workspace.flow.js（受限 ESM）编写 AgentFlow Workspace 流程图。适用于新建流程、
  在现有 Workspace 画布中添加或删除节点、修改字段和连线，以及编排控制顺序、分支、
  子流程、受控循环和定时入口；自定义代码节点包改用 agentflow-node-dsl。
---

# AgentFlow Flow DSL

流程图就是代码：`flow()` 是 main，节点是 func，连线是传参。

## 目录结构

```
<flowDir>/
  workspace.flow.js        图结构。受限 JS，永不执行，只被静态解析
  nodes/<name>/index.mjs   代码节点。普通 JS，会被真执行
  prompts/*.md docs/*.html 超过 3000 字符的长文本
  workspace.layout.json    画布坐标，由 layout 命令生成，不手写
  workspace.nodes.json     图片和机器管理属性，别碰
  workspace.state.json     运行产出，别碰
```

**两类文件规则完全不同**：本 skill 负责 `workspace.flow.js`，并在完成后调用排版命令；需要
编写 `nodes/*/index.mjs` 时读取 `agentflow-node-dsl`。

写完必须依次执行：

```bash
node <agentflow-cli-skill-dir>/scripts/agentflow-cli.mjs dsl-lint --file <flowDir>
node <agentflow-cli-skill-dir>/scripts/agentflow-cli.mjs dsl-layout --file <flowDir>
```

先安装并读取 `agentflow-cli` Skill，把它的 `SKILL.md` 所在目录记为
`<agentflow-cli-skill-dir>`。CLI/DSL Runtime 已随该 Skill 分发，不要安装 npm 包。
lint 不通过先修结构，不要排版。`layout` 默认只给缺坐标的新节点补位置，保留用户手工布局。
新建流程，或用户明确要求整理整张图时，在 `dsl-layout` 命令末尾加 `--all`。
不要直接编辑 `workspace.layout.json` 里的 x/y。

## 自动排版是交付步骤

只生成正确连线还不算完成。AI 新建或改完流程后，必须保证节点在 UI 中可读：

1. `lint` 校验节点、引脚和拓扑
2. `layout` 生成或补齐坐标
3. 如果本地 UI 已打开，刷新画布加载磁盘结果；需要远端审图和试运行时交给
   `agentflow-author-flow` 创建可运行 Draft

自动排版按依赖从左到右放置，控制主链保持同一视觉轴，数据源放在上方，展示节点与同层主链
错开，分支纵向展开。不要为了“看起来差不多”自行猜坐标。

## 直接修改现有 Workspace

用户明确要求在现有画布中加节点、改字段或连线时，先读当前 `workspace.flow.js`，只修改目标
节点和相关引用，不要重建整张图。保留未涉及的节点 id、控制顺序、数据边、子流程契约和用户
已有布局；新增节点再由 `layout` 补坐标。

- 只放展示内容且不需要执行的 `display.*` 节点可以不写进 `flow(...)`。
- `display.*` 的字面量写在 `content` 输入；连接上游时引用 `source.slot`。它的 `content`
  输出仍可接给后续 agent 作为上下文。
- 不直接编辑 `workspace.layout.json`、`workspace.nodes.json` 或 `workspace.state.json`。
- 本地改完仍必须执行 `lint` 和 `layout`。需要可保存、可试运行的远端画布时，交给
  `agentflow-author-flow` 创建 Draft；只读分享才使用 `workspace-preview`。

## 交付状态与用户验收

`lint`、`layout`、自动化测试和 Mock 外部服务都属于 **Agent 测试环境**。完成这些只能说
“开发验证通过，待生产同构验收”，不能说“可上线”。

完成流程后必须主动请用户在真实或生产同构环境做最终验收。给出精确的启动/输入步骤、
预期路径和结果、需要回传的日志或截图，并要求实际跑到流程终点。涉及 Jenkins、企业微信、
GitLab 等外部系统时，必须验证真实请求、账号权限、网络、环境变量、输出以及下游连线；Mock 结果
不能代替这一步。需要凭证或会产生外部副作用时，先获得用户确认。

用户明确确认实际流程跑通后，才能将状态更新为“生产同构验收通过，可发布/可上线”。如果流程里有
自定义代码节点，同时遵守 `agentflow-node-dsl` 里更严格的两级验证闸门。

面向用户的新流程不要直接正式发布。完成 lint/layout 后使用 `agentflow-author-flow` 的
Draft → 试运行 → 动态修改 → 明确确认 → 发布/定时流程；只读 `workspace-preview` 不能代替试运行。

## 图结构：workspace.flow.js

```js
import { agent, control, display, file, flow, provide, tool } from "agentflow/flow";
import collectMetrics from "./nodes/collect-metrics";      // 代码节点

const dateStr = provide.str("查询日期", { value: "2026-08-06" });
const collect = collectMetrics("统计语料", { date: dateStr.value });
const analyse = agent.subAgent("解读", { metrics: collect.result }, `读 metrics 指出趋势与异常。`);
const chart   = display.chart("规模分布", { content: analyse.result });

export const run = flow("Run", collect, analyse, chart);
```

| 位置 | 含义 |
|------|------|
| 第 1 个参数（字符串） | 节点显示名。可省略 |
| 第 2 个参数（对象） | **输入引脚**。每个键都是引脚名，没有例外 |
| 第 3 个参数 | 一般是 body；`control.while` 优先传 Condition 子流程，旧模式才传 step 脚本 |
| 第 4 个参数 | 仅双子流程 `control.while` 使用：Body 子流程 |
| `const 变量名` | **节点 id**。改名 = 重命名节点 |
| `x.slotName` | 引用上游输出引脚 = 连一条数据线 |

`provide.*` 只是数据源，没有 prev/next 槽，**不要放进 `flow(...)` 链**——被谁引用就跟谁跑。

## 四条铁律

1. 节点全部声明在**模块顶层**，不要写进函数
2. `flow(...)` 里的顺序 = 控制流顺序；声明顺序不代表执行顺序
3. **结构文件禁一切控制流**：`if` / `for` / `while` / `?:` / `.map()` / `await` /
   箭头函数 / `new` / 动态属性。要写逻辑就建代码节点
4. 一个输出可接多个输入（fan-out 允许）；**一个输入只能接一条边**（fan-in 禁止）；
   图不能成环；重复执行用 `control.while`，不要画回边

## 控制流

```js
export const run1 = flow("Run", a, b, c);                       // 顺序

export const nightly = flow.schedule("每日",                     // 定时
  `{"enabled":true,"cron":"0 8 * * *","timezone":"Asia/Shanghai","overlapPolicy":"skip"}`,
  fetchData, sendReport,
);

const ok   = control.agentToBool("判断", { value: review.result }, `合格返回 true`);
const gate = control.if("是否通过", { prediction: ok.prediction },  // 分支
  flow(publish, notifySuccess),                                   // then
  flow(rollback, notifyFail),                                     // else
);
export const run2 = flow("Run", review, ok, gate);

export const run3 = flow("Run", build, flow.fork(flow(testA), flow(testB, report)));  // 控制边扇出

flow.resume(showPlan, stage2);          // 闸门：跑到这停，人点第二个 run 才继续
flow.detached(draftA, draftB);          // 有控制链但没 run 入口
```

### 同 Workspace 子流程

需要把一段标准节点拓扑复用为可调用单元时，用 `flow.input` + `flow.subflow` 声明契约，
再由父流程用 `flow.call` 调用。子流程内部仍然是 AgentFlow 节点和连线，不要包装成一个脚本：

创建、修改或验收普通子流程、`control.while` 或其画布投影时，必须读取
[子流程与 While 编写规范](references/subflow-authoring.md)。该规范同时约束 DSL 契约、状态流、
Start / Return 边界投影和父子流程引脚映射；不要手工创建边界节点或输入代理连线。

```js
const stateIn = flow.input("state", "json");
const inspect = agent.subAgent("检查下一项", { state: stateIn.value }, `只处理一项并返回 JSON`);
const save = tool.nodejs("规范化状态", { value: inspect.result }, `node ${flowDir}/scripts/normalize.mjs`);

export const advanceOne = flow.subflow(
  "推进一项",
  { state: stateIn },
  flow(inspect, save),
  { state: save.result },
);

const advance = flow.call("调用推进子流程", advanceOne, { state: read.result });
const { state } = advance;
export const run = flow("Run", read, advance, show);
```

- `flow.input(name, type)` 只能作为某个子流程的输入代理。
- `flow.subflow(label, inputs, flow(...), outputs)` 的输入值引用 `flow.input`，输出值引用内部节点输出。
- `flow.call(label, subflow, pins)` 是父流程里的真实控制节点，动态引脚由契约生成。
- 禁止父流程和内部节点直接跨边界连线；所有值必须经过 `flow.call`。
- 禁止递归调用。当前第一版也不允许子流程内部 `wait/deferred`；调用帧恢复能力补齐前会明确失败。

**`flow.fork` 不是并行。** 它是「一个 `next` 接多个下游」的写法——`flow(a, b, c)` 是线性的，
没法在链里写出扇出，所以有了它。编译出来就是两条边，图里不存在 fork 这个东西：

```
build.next → testA.prev
build.next → testB.prev
```

运行时把两条分支的节点都收进计划，然后**按拓扑序串行执行**。两个各睡 3 秒的分支跑完要
6 秒，不是 3 秒。分支之间也没有隔离：任何一个节点失败，整个 run 就结束，另一支不会跑。

用它的理由是画布结构（两件事都挂在 build 后面、互不依赖），不是省时间。

**分支不能汇合**——fan-in 禁止，`control.anyOne` 运行时没实现。两条分支各自收尾。

### 受控循环

**图仍然不能成环。** 重复执行时用 `control.while` 把循环收进一个有上限、超时和 checkpoint 的
状态机节点；不要画回边，也不要用 DSL 的 JavaScript `while`。优先传入显式 Condition/Body 子流程：

```js
const advance = control.while("推进到人工边界", {
  state: initial.value,
  maxIterations: "20",
  timeout: "30m",
}, shouldContinue, advanceOne);
export const run4 = flow("Run", advance, report); // done 才继续；wait 会暂停
```

- Condition 固定输出 `decision`，Body 固定输出下一版 `state`；两者都可选输出 `summary`。
- `state` 是用户可见的业务状态载体。`iteration`、`idempotencyKey` 由运行时注入，保留在 DSL
  契约中，但不要要求普通用户在画布上配置或连接。
- `maxIterations` 和 `timeout` 必须显式设置。新流程不要使用旧的脚本式 While，除非用户要求兼容。
- Condition/Body 的完整声明、状态迁移、固定输出和手动画布编辑方式都在专项规范中；不要凭记忆简写。

`control.agentToBool` 是 `runtime: degraded`：它靠通用 agent 路径工作，没有任何东西
约束模型输出，而 `parse-bool` 只认 `true` / `1` / `yes` / `on`。prompt 里必须写死
「只回 true 或 false，多一个字都会被判成 false」。

## 引脚值与正文插值

引脚值可以写字符串、`file(...)`、上游引用，也可以写 `true` / `42`——非字符串会规范成
字符串存图；只有定义表里声明为 `bool` 的槽（以及你自己用 `true`/`false` 建的槽）写回时
还是裸的 `true`。

正文（第 3 个参数）里的 `${...}` 有两种含义，按这个顺序判定：

```js
// 1) 本节点已有同名引脚 -> 运行时占位符，跑的时候换成该槽的值
const a = agent.subAgent("解读", { metrics: collect.result }, `读 ${metrics} 指出趋势`);

// 2) 引用上游 -> 自动建一个同名引脚并连线，等价于上面那种写法
const b = agent.subAgent("解读", {}, `分析 ${dateStr.value} 的数据`);
//   => 引脚 dateStr 接到 dateStr.value，正文存成 `分析 ${dateStr} 的数据`
```

第 2 种的槽名取**引用表达式的根标识符**（`dateStr.value` -> `dateStr`）。想让槽叫别的名字，
就用第 1 种写法显式写引脚。插值只在正文里生效，引脚值里的 `${}` 运行时不会替换。

## 自定义代码节点

行为完全由输入决定、不需要 AI 推理时，创建代码节点。不要在本 skill 中推断节点包协议；
读取 `agentflow-node-dsl`，由它负责 `nodes/<name>/index.mjs` 的声明、实现、测试和发布规则。

## 自定义输出槽（agent 节点）

`agent.subAgent` 想多吐一个值，两件事都要做：

```js
const breakdown = agent.subAgent("需求拆解", { tapdId: story.result },
  `拆解需求……

因为本节点有额外输出槽，回复必须只包含一个信封，不要有其它内容：
---agentflow
result: |
  <完整结果，每行缩进两个空格>
outParams:
  storyId: <值>
---end`,
);
const { storyId } = breakdown;              // 声明额外输出槽，下游直接用

const notify = tool.wecomSendAppMarkdown("通知", { markdown: breakdown.result, toUser: storyId });
```

没有额外输出槽的 agent **不要**写信封，直接回正文。

`agent.subAgent` 可以自由加自定义**输入**槽，当实参写就行。声明了但暂时不接线的
写 `{ url: null }`，否则这个槽不会存在。

## 超长文本外置

body 或引脚值超过 3000 字符，抽成文件：

```js
const plan = agent.subAgent("规划", { skillsContext }, file("prompts/plan.md"));
const doc  = display.html("使用说明", { content: file("docs/guide.html") });
```

## 节点选型

| 场景 | 用 |
|------|----|
| 要 AI 理解 / 判断 / 生成 | `agent.subAgent` |
| 行为由输入完全决定，逻辑复杂 | **建代码节点** `nodes/<name>/index.mjs` |
| 一行 shell 就能搞定 | `tool.nodejs("名字", {}, \`node -e "..."\`)` |
| 给用户看结果 | `display.markdown` / `.code` / `.html` / `.chart` / `.table` |
| 加载 skills 给下游 agent | `control.loadSkills` → `skillsContext` |
| 加载知识库 / 代码仓 | `control.cdWorkspace` → `knowledgeContext` |
| 固定文本 / JSON / 密钥 | `provide.str` / `provide.json` / `provide.password` |
| 文本显式解析为 JSON | `control.parseJson` |
| 文本转 bool 做分支 | `control.agentToBool` → `prediction` |
| 复用一段标准节点拓扑 | `flow.subflow` + `flow.call` |
| 重复执行显式条件与单轮拓扑 | `control.while(..., conditionFlow, bodyFlow)` |

`display.*` 的内容一般来自连线；写字面量则是手写文档节点（也合法，且不会被运行覆盖）。

## 全部可用节点

见 [node-calls.md](references/node-calls.md)。该表由
`scripts/generate-agentflow-skill-references.mjs` 从 `builtin/nodes/*.md` 生成，
只列运行时真正支持的类型——用了表外的类型 lint 会直接报错。
