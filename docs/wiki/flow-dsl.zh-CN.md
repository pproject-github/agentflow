# 流程图的代码表示

**`workspace.flow.js` 就是 Workspace 图的权威存储格式。** Web UI 保存画布写的是它，
打开画布读的也是它；`workspace.graph.json` 降级为只读的历史格式。

```bash
agentflow flow dsl migrate <FlowName|dir> [--allow-loss]  # graph.json / flow.yaml -> flow.js，就地迁移
agentflow flow dsl lint    <dir>                          # 静态校验
agentflow flow dsl layout  <dir> [--all]                  # 自动排版；默认只补缺失坐标
agentflow flow dsl export  <FlowName|dir> [--out <dir>]   # 导出一份到别处
agentflow flow dsl import  <dir> [--out <flowDir>]        # 反向生成 graph.json（审计用）
```

存量流程不用手动迁移：没有 `workspace.flow.js` 时照常读 `workspace.graph.json`，下一次
保存自动转成代码。`migrate` 只是让这件事提前发生。

## 从 flow.yaml 迁进来

`flow.yaml` 是另一回事。Start/End 执行栈退休之后它变成了一块**墓碑**：目录哨兵认它，所以
流程还挂在列表里；读图那条路不认它，所以点开是空图——跑不了、编辑不了，里面的 body /
prompt / script 只能干看着。

两种格式的结构其实完全相同（`instances` / `edges` / `ui`，`output-N` 索引式 handle），
差的是**节点词汇表**：yaml 用的一批节点在 Workspace 运行时里 `runtime: none`。所以迁移做的
是换词：

| yaml 节点 | 迁成 | 说明 |
|---|---|---|
| `control_start` | `workspace_run` | 老流程的入口就是 Workspace 的运行节点 |
| `control_end` | 丢弃 | Workspace 跑到没有后继就结束，终点节点没有对应物 |
| `tool_print` | `display_markdown` | |
| `control_toBool` | `control_agent_toBool` | ⚠️ 判定从确定性解析变成 agent 判定 |
| `control_anyOne` / `tool_user_check` / `tool_user_ask` / 其余 `runtime: none` | **无对等物** | 只能丢 |

边按**槽位名**重接，不按索引——`tool_print` 的 `next` 在 0 号位，`display_markdown` 的
`next` 在 1 号位（0 号位是 `content` 输出），照索引搬会把控制边接到内容槽上，图仍然连通，
跑起来才发现错。老流程改过名的槽位（比如内容槽叫 `summary`）会真的改名并报出来，因为展示
节点的运行时是按名字取 `content` 的。

**默认拒绝有损迁移**：只要有节点或边接不过去，就停下来把清单打出来，磁盘一个字节都不动。
看过清单认了，再加 `--allow-loss`。`control_end` 和指向它的边是唯一的例外——丢了等于没丢，
不拦。

`flow.yaml` 原文不删。迁完 `workspace.flow.js` 成为权威（读图先看它），yaml 退到一边当原始
材料。

够不着代码形态也算成功：`tool_nodejs` 同时带 `script` 和 `body`、`control_if` 带 `body`
这类字段在代码里没有位置放，往返比对过不去，于是退回 `workspace.graph.json`。那仍然是一次
成功的迁移——`graph.json` 读得出、画得出、跑得动，而 yaml 三样都不行。

### 平台上的流程

服务端启动时会在监听 HTTP 和启动 scheduler **之前**检查独立的存储结构版本，自动扫描实际
`AGENTFLOW_HOME`、所有用户 pipelines、当前 `workspaceRoot` 和归档目录。无损的
`workspace.graph.json` / `flow.yaml` 会就地迁移；需要丢节点或边的 YAML 原样保留，只记入
`needsDecision`，绝不自动接受损耗。

版本、每个存储根的迁移结果和待决清单写在：

```text
<AGENTFLOW_HOME>/admin/storage-migrations.json
```

启动迁移带文件锁，避免多个服务进程同时修改一个数据卷。`flow.yaml` 原文始终保留；无人值守
转换 `workspace.graph.json` 前还会备份到流程目录的
`.agentflow-migrations/workspace-flow-dsl-v1/`。同一版本重复启动直接跳过；同一个数据根换了新的
`workspaceRoot` 时，只补迁新的 Workspace。

下面的 HTTP/CLI 出口用于人工处理 `needsDecision` 或排障，不是正常上线的必做步骤：

```bash
agentflow-cli migrate-flow --flow-id <id> [--flow-source user] [--archived] [--allow-loss]
```

对应 `POST /api/workspace/migrate`，语义和本地命令完全一致（默认拒绝有损、返回同一份清单、
不删 yaml）。`builtin` 与 `admin` 是只读目录，拒绝迁移。

**归档流程默认也不写**，要显式传 `allowArchived`。这是唯一一处和保存路径不同的策略：保存
一律拒绝归档流程，迁移给了一条路。理由是归档流程没人会再打开保存，不给路就等于把它们永远
锁死在老格式上——而「归档 + 仅 yaml」恰恰是日后摘掉哨兵时会凭空消失的那一类。迁移换的是
存储格式不是内容，往返比对闸门保证图等价。

### 一键升级

```bash
agentflow-cli migrate-all [--include-archived] [--allow-loss] [--dry-run]
```

手工遍历这个账号能看到的所有流程，**无损的全做掉，有损的一个不碰**。服务端启动自动迁移后，
它主要用于补迁和核对。两类活儿风险完全不同：

- `graph.json -> 代码`：换存储格式，节点词汇表不变，往返比对闸门保证图等价——无损
- `flow.yaml -> 代码`：要换词，可能丢东西——默认拒绝，把清单摆出来

跑完看 `needsDecision`：要人做决定的就那几个，对它们单独跑 `migrate-flow --allow-loss`。
重复跑幂等（已经是代码形态的直接跳过）。报告里的 `skipped` 会如实列出只读目录和被跳过的
归档流程——「跑完了」不等于「全覆盖了」。

## 为什么要代码

流程编排本质上就是「main 调用一串 func、连线传数据」。JSON 里的一条边长这样：

```json
{ "source": "agent_1", "target": "display_1", "sourceHandle": "output-1", "targetHandle": "input-1" }
```

`output-1` 指哪个槽，取决于 `agent_1` 自己的槽位数组顺序——人读不出来，模型更猜不准。
同一件事写成代码是：

```js
const display_1 = display.markdown("展示", { content: agent_1.result });
```

这样 AI 的编码能力可以直接用上，lint 能做语法校验，diff 能看懂。

## 四个文件

```
workspace.flow.js       图结构——节点、连线、作者写的内容（受限 ESM）
workspace.layout.json   画布状态——坐标、尺寸、引脚显隐与顺序
workspace.nodes.json    代码里说不清的——粘贴的图片、model、marketplaceRef、外置文件清单
workspace.state.json    运行态——由 workspace-state.mjs 管，DSL 不碰
prompts/ docs/ scripts/ 超过 3 KB 的长文本
```

划分原则是**代码里说得清的就不进 JSON**。坐标和图片 base64 写进代码只会淹没结构。

`workspace.nodes.json` 里的 `externals` 是上一次生成的外置文本清单。正文缩短到阈值以下
或者节点被删时，靠它精确删掉不再需要的文件——不靠文件名猜，免得误删 `scripts/` 下作者
手写的脚本。清单里越出流程目录的路径一律忽略。

## 关键设计：边按槽名，不按下标

IR（代码生成和解析的共同中间表示）里，一条边是
`源节点|源槽名|目标节点|目标槽名`。

必须如此：句柄下标依赖实例自己的槽位顺序，而槽位顺序是**实例级**的——真实语料里
有 32 个实例的顺序偏离定义表。从 `{ content: agent_1.result }` 反推不出 `input-1`
还是 `input-2`。所以下标交给 `layout.json` 的 `pinOrder` 恢复：只有偏离规范序的实例
才记一条，其余按「定义表顺序 + 代码里出现的自定义槽」重建。

**画布的加载入口不止一个。** 磁盘和 API 上边的身份是槽位名，React Flow 的句柄是引脚在
渲染那张槽位表里的下标（`FlowNodePortRail` 按数组下标发 `output-<i>`，隐藏的槽也占位置）。
换算走 `edgesWithCanvasHandles`，只有 `graphToFlow` 一处调它 —— 曾经有第二份长得一模一样
的代码（`flowFormat.js` 里给已退休的 `flow.yaml` 编辑器用的 `deserializeFromFlowYaml`，
早就没人调了），0.1.190 把边的身份换成槽位名时改的正是那份死代码，活着的那个入口因此
没人看，上线后整张图的连线全不见：句柄名对不上任何一个渲染出来的 handle，React Flow
留着边但一条都画不出来。死代码已删——**留着一份没人跑的同形代码，就是留着一个让人改错
地方的靶子**。还原下标用**边写下时**那张表，换算成下标用**现在渲染**
那张，两者不是一回事（合并定义表会补槽、会改顺序）。

**渲染 bug 不该有删数据的能力。** 画布把边丢了（换算漏了一处、handle 匹配不上…），
它手里就是一张没有边的图，用户随后**任何一次保存**都把这个状态写回磁盘。0.1.190 就是
这样让 3 个线上流程的连线永久消失的，服务端没有任何快照能恢复。所以存图会分辨
「人删了线」和「线在别处丢了」：人删线一条一条来，渲染失败是**一次全没、节点一个不少**。
后者直接 409 拒绝（`edgeWipeWithoutNodeDeletion`）。真想清空全部连线的人先删掉任意
一个节点即可——宁可让这种罕见操作多一步，也不能让一次静默保存抹掉别人的图。

**读一张图 = 扫一遍全部节点包，所以包清单必须缓存。** `readWorkspaceDesign` 要解析
`import x from "marketplace:..."`，就得知道每个包声明了哪些槽位，而读清单要 acorn 解析
`index.mjs`。线上 102 个包一趟 100ms，读一张图 104ms 里有 101ms 花在这儿；流程仓库索引
重建又要读 97 张图 —— **97 × 104ms ≈ 10 秒，单线程跑满**，事件循环被按住，连新连接都来不及
accept（`Recv-Q` 堆到 27），那一刻所有请求一起卡。线上 `/projects` 每 20 次有 1 次超过
8 秒就是这么来的。

已发布的版本目录是不可变的（改内容必须换版本号），所以声明读一次就能一直用。缓存**只放
声明**，元数据（可见性等）每次重读 —— 因为**原地改写目录里已有的文件不会改变目录的 mtime**，
按目录 mtime 判失效会让可见性永远读到旧值。

## 关键设计：槽位表归节点定义所有

图里存的槽位表只是**上一次落盘时定义表长什么样**的快照。定义改了，快照不会跟着改，
于是同一个 `agent_subAgent` 在不同流程里引脚各不相同：线上有节点连 `prev` 都没有
（那一版定义还没这个槽），控制边无处可接；也有一批节点带着早就改过的旧说明文字。

所以读图和落盘前都按定义对账一遍：**定义槽的存在、类型、说明、必填由定义说了算**，
顺序也归定义（定义槽在前，自定义槽按图里的先后排在后面）。图只保留自己那份数据——
槽位的值、画布上显不显示（`showOnNode`）、以及定义里没有的自定义槽。

代码节点包的槽位表归**包**所有，不归它的运行方式（`tool_nodejs` 只是怎么跑，不决定
有哪些引脚）。包的槽位表首位一定是控制槽——`node.yaml` 那条老路不走 `slotMapToList`，
所以在扫描处统一补。

这个「谁说了算」的答案有**六处**要用到，必须是同一个（`definitionSlotsOf`）：
`graphToIr` 判断哪些是自定义槽、`codegen` 排引脚顺序、`parser.readPins` 判断代码里
写的引脚是不是自定义槽、`irToGraph` 重建槽位表、`extractLayout` 记偏离、
`designFingerprint` 解析缺省元数据。只要有一处拿运行方式的定义表去回答，它和另外五处
就会对不上——「包里没声明、运行方式里有」的槽两头落空，接在上面的边往返一次直接消失。
逐处改过来的实测：改 1 处 84→74，改 2 处 84→61，六处都改 84→85。

例外只有控制槽（`prev` / `next` / `next1` / `next2`），按**名字**排除而不是按类型：
`prev` 往返一趟类型会从 `node` 退化成 `text`，只看类型会把它当成自定义槽写出一个
`prev: null`，再生成一次源码就变了。

对账**必须在边的句柄译成槽位名之后**做。图里存的 `input-3` 是按落盘时那张槽位表写的，
先对账再译下标就是拿新表解释旧下标；85 个线上流程的演练里，顺序反过来会让 5 个流程
的边改指向。

定义表读不到时（节点包还没装上）一个字都不改：宁可不动，也不能凭一张空表把引脚删光。

## 正文插值：一个 `${}` 的两种含义

运行时的正文占位符只认槽名——`workspaceBodyPlaceholderNames` 的正则是
`\$\{([A-Za-z_][A-Za-z0-9_-]*)\}`，里面没有 `.`。所以代码里写
`` `分析 ${dateStr.value} 的数据` `` 不能原样落进正文，它会被编译成：

- 正文 `分析 ${dateStr} 的数据`
- 一条 `dateStr.value -> 本节点.dateStr` 的数据边

槽名取引用表达式的**根标识符**。写回时只有「槽名 == 根标识符」才折叠回 JS 插值，
否则保持「显式引脚 + 转义的 `\${slot}`」——不然解析回来槽名会变成根标识符，往返对不上。

判定顺序：

1. 本节点已有同名引脚（或 `tool_nodejs` 脚本里的 `${flowDir}` 等常量、自己的输出槽）
   → 运行时占位符，原样保留
2. `${x.y}` 或解构出来的变量 → 上游引用，建槽 + 连边
3. 都不是 → 记进 `unresolved`

第 3 条以前是**静默丢整段正文**：`stringOf` 读不出模板字符串就返回 null，而正文那条
分支只判 `if (body !== null)`，读不懂等于没写。保存一次，磁盘上就真没了。

同理，引脚值现在收 `true` / `42` 这类非字符串字面量（图里统一存成字符串）。写回时按槽的
`type` 决定加不加引号：`bool` 槽写裸 `true`，其余写字符串。自定义槽的 `bool` 类型跟着
IR 走一趟，所以 `pullIfExists: true` 存回来还是 `true`，不会退化成 `"true"`。

## 绝不执行

`workspace.flow.js` 全程用 acorn 静态解析。渲染画布、lint、导入都走这条路径——
为了画一张图去执行流程文件，既慢又不安全。

这也是结构文件禁用一切控制流的原因：`for` / `if` / `await` / `.map()` 一旦出现，
静态解析就还原不出图。lint 把它们列为错误，并提示「节点实现请放
`nodes/<name>/index.mjs`」——那里是普通 JS，不受约束。

## 两道防止丢图的闸门

作为存储格式，「读的时候少读出一个节点」等价于「用户下一次保存时那个节点就没了」。
所以：

**解析器认不出的东西一律记账，绝不静默跳过。** 顶层多出一条 `for`、引脚值写成函数调用、
一条 `const` 声明两个节点——每一处都进 `unresolved`。读图时（严格模式）直接抛
`WorkspaceFlowParseError`，`/api/workspace/graph` 回 422 并带上行号；lint 则把它们逐条列出来。
绝不降级成「能读多少读多少」。

**写之前先把生成的代码解析回来跟原图逐字段比对。** 比不上就退回写
`workspace.graph.json`，并把已有的 `workspace.flow.js` 删掉（它优先级更高，留着就等于让
残缺的那张图接管）。比对用规范化指纹：抹平键顺序、`undefined`/`null`/`""` 三种缺省写法、
`role: normal` 等价于没写、以及缺省时继承定义表的 `showOnNode` / `required`——只抹平表示
差异，不抹平内容。85 个线上流程全部通过闸门，最大的一张 save+read 5.4 ms。

**降级必须被听见。** 过去这件事只写进服务端 stdout，而且不说是哪张图——线上攒了 900
多条没人能追。现在告警带流程目录，`/api/workspace/graph` 的响应也带 `format` 和
`degradedReason`，画布上直接说「已保存（退回 JSON 格式）：<原因>」。用户看到「保存成功」
而流程悄悄丢掉代码形态（连带 diff、lint、AI 编辑），是这条链路上最贵的一种沉默。

## `flow.fork` 只是扇出的写法

图里没有 fork 这个东西。`flow(a, b, c)` 是线性的，写不出「一个 `next` 接多个下游」，所以
补了这个语法：

```js
flow("Run", build, flow.fork(flow(testA), flow(testB, report)))
```

解析出来就是两条控制边，仅此而已：

```
build.next → testA.prev
build.next → testB.prev
```

codegen 反过来——一个节点的 `next` 有 ≥2 个下游、且它不是 `control_if`，就打印成
`flow.fork(...)`。纯粹为了往返能对上。

**它本身仍然不是并行原语**，只是扇出的写法；**并行与否由运行时的并发档位决定**。
默认 `agent=1 / tool=1` 时按拓扑序串行执行，两个各睡 3 秒的分支跑完仍是 6 秒。
开了并发（`{"concurrency":{"agent":2,"tool":4}}` 或对应环境变量）之后，无依赖的分支
才真正并发，见 `reference/flow-control-capabilities.md` §8.5。

分支之间依然没有隔离：任何一个节点失败整个 run 就结束。并行下的差别是——失败会
**停止投放新节点**，但同批已经在跑的兄弟节点会自然收尾（不半路杀子进程，否则会留下
写了一半的产物和已发生的外部副作用）。

## 同 Workspace 子流程

子流程不是脚本别名，而是一段有正式输入/输出契约的标准节点拓扑：

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

IR 在顶层保存 `subflows`：成员节点、控制入口、输入代理和输出绑定都显式记录。父图只调度
`control_subflow_call`；运行时为每次调用构造独立 frame，把输入灌入代理节点，再用同一套
Workspace 节点执行器运行内部 DAG，最后按输出绑定回填调用节点。内部事件带
`parentNodeId`、`subflowId` 和 `callFrameId`，因此日志不会变成黑盒。

边界规则：一个节点只能属于一个子流程；父流程不能直接连内部节点；子流程之间也不能直接跨线，
只能通过 `flow.call` 契约传值；递归调用禁止。子流程内部的 `wait/deferred` 会冒泡到父流程调用节点，
并通过同一调用帧 checkpoint 恢复。

## lint 检查什么

| 层 | 检查 |
|----|------|
| 语法 | 禁用的控制流、动态属性访问、`file()` 参数必须是字面量且文件存在 |
| 语义 | 节点类型是否存在；`runtime:` 分级是否可用（`none` 报错、`degraded` 警告）；槽位是否存在；自定义输出槽是否解构声明过 |
| 图 | fan-in、环、控制槽是否真的存在、`control.if` 的 prediction 是否接了 `bool` 类型、孤立节点、有无 run 入口 |

「控制槽是否真的存在」这条是后加的：`provide.*` 和 `tool.getEnv` 没有 `prev` / `next`，
写进 `flow(...)` 链里那条边落不下去，会在往返时无声消失。skill 里的示例自己就犯过这个错。

运行时支持程度直接读各节点 `.md` 的 `runtime:` 字段（见
[node-definitions.zh-CN.md](node-definitions.zh-CN.md)），不是第二份清单。

`import` 会先 lint，**不过就拒绝，不写出半张图**。

## 代码节点包

流程目录里的 `nodes/<name>/index.mjs` 在代码里就是一条 import：

```js
import collectMetrics from "./nodes/collect-metrics";

const collect = collectMetrics("统计语料", { date: "2026-08-09" });
const show = display.markdown("结果", { content: collect.total });
```

**图里的形态与画布从面板拖出来的完全一致**：`definitionId` 是基础类型（`tool_nodejs`
等），包的身份放 `marketplaceRef`，槽位以包的声明为准（不是基础类型的——`tool_nodejs`
带着 `skillsContext` 这些上下文槽，代码节点没有）。import 只是同一件事的可读写法。

包声明过的输出槽不必再 `const { total } = collect` 解构一遍，直接 `collect.total` 引用。

跑起来要用的 bootstrap 命令是**推导出来的**（`marketplaceRef` → 本机绝对路径），
每次读图重新算，不写进 `flow.js`——否则流程文件会带上某个人的主目录，发布出去就是错的。

lint 和存储层用**同一份包扫描**（`flow-dsl/packages.mjs`）。分成两份的后果实际发生过：
lint 自己解析包、看到的是对的图，存储层不解析、把 import 读成一个槽位表为空的节点，
于是控制边落到第一个数据槽上、两条边撞同一个句柄——AI 照文档写完 lint 绿灯，画布上却是
一张错图，一保存就冻结成 JSON。

## 版本号必须描述磁盘上那张图

代码化会做规范化：槽位补齐、`role: normal` 省掉、槽序归位。所以**存进去的那张图和读出来
的那张图不一定逐字相同**——而协作靠的正是 `designRevision` 这个逐字段哈希。

`/api/workspace/graph` 存图返回的 `revision`，算的是**落盘后读回来的那一版**，不是客户端
提交的那一版（`writeWorkspaceDesign` 顺手把往返验证时解析回来的图返回出来，不额外花钱）。
否则客户端存完手里就攥着一个磁盘上根本不存在的版本号，下一次保存直接被判成「合并基线与
baseRevision 不匹配」——协作场景里意味着谁都存不进去。真实语料里 21/21 会踩中，其中 3 个
反复存也不收敛。

## 往返保证

用 21 个线上流程（334 节点 / 332 边）验证，三项都是 21/21：

- **节点集合**一致
- **边身份**一致——按槽名比，不是比数量。这点踩过坑：曾经把 `control_if` 的两个分支
  拍平成串行执行，边的**数量**完全一样，只比数量的审计发现不了
- **幂等**——还原出来的图再生成一次，源码逐字相同（内容没变时连文件都不重写）

真实语料含内网业务内容和凭据，不入库；测试用等价形状的合成图覆盖（分支、分叉、
排程、自定义输出槽、非规范槽序、外置长文本、图片元数据）。

## AI 编写

`skills/agentflow-flow-dsl` 是给模型看的语言参考，其中的节点调用表由
`scripts/generate-agentflow-skill-references.mjs` 从 `builtin/nodes/*.md` 生成，
只列 `runtime: native` 的类型，用了表外的会被 lint 挡下。

代码节点包的写法见 [code-node-packages.zh-CN.md](code-node-packages.zh-CN.md)。
