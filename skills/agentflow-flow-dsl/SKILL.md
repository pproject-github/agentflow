---
name: agentflow-flow-dsl
description: >-
  用 workspace.flow.js（受限 ESM）编写 AgentFlow Workspace 流程图。适用于新建流程、
  修改流程结构、添加或删除节点、修改连线、控制顺序、分支和定时入口；自定义代码节点包
  改用 agentflow-node-dsl。
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
agentflow flow dsl lint <flowDir>
agentflow flow dsl layout <flowDir>
```

lint 不通过先修结构，不要排版。`layout` 默认只给缺坐标的新节点补位置，保留用户手工布局。
新建流程，或用户明确要求整理整张图时，使用 `agentflow flow dsl layout <flowDir> --all`。
不要直接编辑 `workspace.layout.json` 里的 x/y。

## 自动排版是交付步骤

只生成正确连线还不算完成。AI 新建或改完流程后，必须保证节点在 UI 中可读：

1. `lint` 校验节点、引脚和拓扑
2. `layout` 生成或补齐坐标
3. 如果本地 UI 已打开，再刷新或按 UI 同步 skill 通知画布加载磁盘结果

自动排版按依赖从左到右放置，控制主链保持同一视觉轴，数据源放在上方，展示节点与同层主链
错开，分支纵向展开。不要为了“看起来差不多”自行猜坐标。

## 交付状态与用户验收

`lint`、`layout`、自动化测试和 Mock 外部服务都属于 **Agent 测试环境**。完成这些只能说
“开发验证通过，待生产同构验收”，不能说“可上线”。

完成流程后必须主动请用户在真实或生产同构环境做最终验收。给出精确的启动/输入步骤、
预期路径和结果、需要回传的日志或截图，并要求实际跑到流程终点。涉及 Jenkins、企业微信、
GitLab 等外部系统时，必须验证真实请求、账号权限、网络、环境变量、输出以及下游连线；Mock 结果
不能代替这一步。需要凭证或会产生外部副作用时，先获得用户确认。

用户明确确认实际流程跑通后，才能将状态更新为“生产同构验收通过，可发布/可上线”。如果流程里有
自定义代码节点，同时遵守 `agentflow-node-dsl` 里更严格的两级验证闸门。

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
| 第 3 个参数（字符串） | body：agent 是 prompt，`tool.nodejs` 是 shell 命令 |
| `const 变量名` | **节点 id**。改名 = 重命名节点 |
| `x.slotName` | 引用上游输出引脚 = 连一条数据线 |

`provide.*` 只是数据源，没有 prev/next 槽，**不要放进 `flow(...)` 链**——被谁引用就跟谁跑。

## 四条铁律

1. 节点全部声明在**模块顶层**，不要写进函数
2. `flow(...)` 里的顺序 = 控制流顺序；声明顺序不代表执行顺序
3. **结构文件禁一切控制流**：`if` / `for` / `while` / `?:` / `.map()` / `await` /
   箭头函数 / `new` / 动态属性。要写逻辑就建代码节点
4. 一个输出可接多个输入（fan-out 允许）；**一个输入只能接一条边**（fan-in 禁止）；
   不能成环，没有循环原语

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

**没有循环**。「改到通过为止」只能展开成固定轮次的嵌套 gate。

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
| 给用户看结果 | `display.markdown` / `.html` / `.chart` / `.table` |
| 加载 skills 给下游 agent | `control.loadSkills` → `skillsContext` |
| 加载知识库 / 代码仓 | `control.cdWorkspace` → `knowledgeContext` |
| 固定文本 / 密钥 | `provide.str` / `provide.password` |
| 文本转 bool 做分支 | `control.agentToBool` → `prediction` |

`display.*` 的内容一般来自连线；写字面量则是手写文档节点（也合法，且不会被运行覆盖）。

## 全部可用节点

见 [node-calls.md](references/node-calls.md)。该表由
`scripts/generate-agentflow-skill-references.mjs` 从 `builtin/nodes/*.md` 生成，
只列运行时真正支持的类型——用了表外的类型 lint 会直接报错。
