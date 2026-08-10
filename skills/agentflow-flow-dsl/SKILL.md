---
name: agentflow-flow-dsl
description: >-
  用 workspace.flow.js（受限 ESM）编写 AgentFlow Workspace 流程图，用
  nodes/<name>/index.mjs 编写代码节点。适用于新建流程、改流程结构、加节点、
  改连线，以及把节点实现和图一起生成出来。
---

# AgentFlow Flow DSL

流程图就是代码：`flow()` 是 main，节点是 func，连线是传参。

## 目录结构

```
<flowDir>/
  workspace.flow.js        图结构。受限 JS，永不执行，只被静态解析
  nodes/<name>/index.mjs   代码节点。普通 JS，会被真执行
  prompts/*.md docs/*.html 超过 3000 字符的长文本
  workspace.layout.json    画布坐标，别碰
  workspace.nodes.json     图片和机器管理属性，别碰
  workspace.state.json     运行产出，别碰
```

**两类文件规则完全不同**：`workspace.flow.js` 里禁一切控制流；`nodes/*/index.mjs`
是普通 Node 模块，`for` / `if` / `await` 随便写。

写完跑 `agentflow flow dsl lint <flowDir>` 自查。

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

## 代码节点：nodes/&lt;name&gt;/index.mjs

行为完全由输入决定、不需要 AI 推理的，建代码节点。**一个文件夹 = 一个节点 = 一个
可发布的包**。

```js
import fs from "node:fs/promises";

// ── 定义：必须是纯对象字面量（平台静态解析，不执行）──────────
export default {
  id: "collect_metrics",
  version: "1.0.0",
  name: "统计流程语料",
  description: "扫描 corpus 目录，统计每个流程的节点数",
  inputs:  { date: { type: "text", description: "查询日期 YYYY-MM-DD" } },
  outputs: { result: { type: "text", description: "明细 JSON" },
             total:  { type: "text", description: "节点总数" } },
};

// ── 实现：普通 JS，for / if / await 随便写 ──────────────────
export async function run({ date }, { result, total }, { workspaceRoot }) {
  const rows = [];
  for (const f of await fs.readdir(workspaceRoot)) { /* ... */ }
  await fs.writeFile(result, JSON.stringify(rows, null, 2), "utf-8");
  await fs.writeFile(total, String(rows.length), "utf-8");
  console.log(`扫描 ${rows.length} 个流程`);          // stdout 成为节点 result
}
```

- `run(inputs, outputs, dirs)`：**入参 = 输入引脚的值**，
  **出参 = 输出引脚对应的可写文件路径（是路径，不是值）**，
  第三个是 `workspaceRoot` / `nodeRunDir` / `nodeTmpDir` / `outputsDir`
- `prev` / `next` 控制引脚平台自动补，定义里不用写
- 成败看 exit code；抛异常即失败
- 定义里**不要**用 `defineNode()` / `text()` 之类辅助函数——运行时未定义，会崩
- 定义里不能有变量引用、函数调用、展开运算，静态解析会直接报错

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
