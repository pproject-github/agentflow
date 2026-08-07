# 流程图的代码表示

一张 Workspace 图可以在 JSON 和代码之间双向转换：

```bash
agentflow flow dsl export <FlowName|dir> [--out <dir>]   # graph.json -> flow.js
agentflow flow dsl lint   <dir>                          # 静态校验
agentflow flow dsl import <dir> [--out <flowDir>]        # flow.js -> graph.json
```

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
workspace.nodes.json    代码里说不清的——粘贴的图片、model、marketplaceRef
workspace.state.json    运行态——由 workspace-state.mjs 管，DSL 不碰
prompts/ docs/ scripts/ 超过 3 KB 的长文本
```

划分原则是**代码里说得清的就不进 JSON**。坐标和图片 base64 写进代码只会淹没结构。

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

## lint 检查什么

| 层 | 检查 |
|----|------|
| 语法 | 禁用的控制流、动态属性访问、`file()` 参数必须是字面量且文件存在 |
| 语义 | 节点类型是否存在；`runtime:` 分级是否可用（`none` 报错、`degraded` 警告）；槽位是否存在；自定义输出槽是否解构声明过 |
| 图 | fan-in、环、`control.if` 的 prediction 是否接了 `bool` 类型、孤立节点、有无 run 入口 |

运行时支持程度直接读各节点 `.md` 的 `runtime:` 字段（见
[node-definitions.zh-CN.md](node-definitions.zh-CN.md)），不是第二份清单。

`import` 会先 lint，**不过就拒绝，不写出半张图**。

## 往返保证

用 21 个线上流程（334 节点 / 332 边）验证，三项都是 21/21：

- **节点集合**一致
- **边身份**一致——按槽名比，不是比数量。这点踩过坑：曾经把 `control_if` 的两个分支
  拍平成串行执行，边的**数量**完全一样，只比数量的审计发现不了
- **幂等**——还原出来的图再生成一次，源码逐字相同

真实语料含内网业务内容和凭据，不入库；测试用等价形状的合成图覆盖（分支、分叉、
排程、自定义输出槽、非规范槽序、外置长文本、图片元数据）。

## AI 编写

`skills/agentflow-flow-dsl` 是给模型看的语言参考，其中的节点调用表由
`scripts/generate-agentflow-skill-references.mjs` 从 `builtin/nodes/*.md` 生成，
只列 `runtime: native` 的类型，用了表外的会被 lint 挡下。

代码节点包的写法见 [code-node-packages.zh-CN.md](code-node-packages.zh-CN.md)。
