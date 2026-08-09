# 流程图的代码表示

**`workspace.flow.js` 就是 Workspace 图的权威存储格式。** Web UI 保存画布写的是它，
打开画布读的也是它；`workspace.graph.json` 降级为只读的历史格式。

```bash
agentflow flow dsl migrate <FlowName|dir>                # graph.json -> flow.js，就地迁移
agentflow flow dsl lint    <dir>                         # 静态校验
agentflow flow dsl export  <FlowName|dir> [--out <dir>]  # 导出一份到别处
agentflow flow dsl import  <dir> [--out <flowDir>]       # 反向生成 graph.json（审计用）
```

存量流程不用手动迁移：没有 `workspace.flow.js` 时照常读 `workspace.graph.json`，下一次
保存自动转成代码。`migrate` 只是让这件事提前发生。

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
差异，不抹平内容。21 个线上流程全部通过闸门，最大的一张 save+read 5.4 ms。

## lint 检查什么

| 层 | 检查 |
|----|------|
| 语法 | 禁用的控制流、动态属性访问、`file()` 参数必须是字面量且文件存在 |
| 语义 | 节点类型是否存在；`runtime:` 分级是否可用（`none` 报错、`degraded` 警告）；槽位是否存在；自定义输出槽是否解构声明过 |
| 图 | fan-in、环、`control.if` 的 prediction 是否接了 `bool` 类型、孤立节点、有无 run 入口 |

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
