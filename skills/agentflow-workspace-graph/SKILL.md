---
name: agentflow-workspace-graph
description: >-
  AgentFlow Workspace 画布编辑技能。用于在 Workspace 视图中创建或修改
  workspace.flow.js，新增展示节点、上下文节点和连线；不修改正式 flow.yaml。
---

# AgentFlow Workspace Graph

在 Workspace 视图中需要创建临时工作画布、保存分析结果、组织上下文节点或连接展示节点时使用本技能。

## 目标文件

画布就是代码：改当前 Workspace 项目目录下的 **`workspace.flow.js`**。不要修改历史
`flow.yaml`，也不要写 `workspace.graph.json`——那是已经退役的格式，写了不会被读。

```
workspace.flow.js      ← 改这个
workspace.layout.json    坐标，平台维护，别碰
workspace.nodes.json     图片等机器属性，平台维护，别碰
workspace.state.json     运行产出，平台维护，别碰
```

坐标不用管：新节点平台会自动排布，写死坐标反而会覆盖用户调过的位置。

## 写法

```js
import { agent, control, display, flow } from "agentflow/flow";

const notes = display.markdown("项目结构分析", {
  content: `# 项目结构分析

- src/ 业务代码
- bin/ CLI 入口`,
});
```

| 位置 | 含义 |
|------|------|
| 第 1 个参数（字符串） | 节点显示名 |
| 第 2 个参数（对象） | 输入引脚，每个键都是引脚名 |
| 第 3 个参数（字符串） | body：agent 的 prompt、`tool.nodejs` 的命令 |
| `const 变量名` | 节点 id |
| `x.slotName` | 引用上游输出引脚 = 连一条数据线 |

连线和控制流：

```js
const summary = agent.subAgent("总结", { source: notes.content }, `把上面的结构讲清楚`);
const show    = display.markdown("总结", { content: summary.result });
export const run = flow("Run", summary, show);
```

只放一个展示节点、不需要跑的，不用写 `flow(...)`，声明出来就行。

## 铁律

1. 节点全部声明在**模块顶层**
2. **禁一切控制流**：`if` / `for` / `while` / `?:` / `.map()` / `await` / 箭头函数 /
   动态属性。这个文件永不执行、只被静态解析，出现这些就还原不出图。要写逻辑就建代码
   节点 `nodes/<name>/index.mjs`
3. 一个输出可接多个输入；**一个输入只能接一条边**；不能成环
4. 改完跑 `agentflow flow dsl lint <flowDir>` 自查

完整语法和全部可用节点见 **agentflow-flow-dsl** skill。

## 展示节点选型

- `display.markdown` — Markdown 正文、分析报告、会议纪要、代码结构说明
- `display.mermaid` — Mermaid 图源码
- `display.ascii` — ASCII 图
- `display.html` — 可交互 HTML 原型或富 UI 片段
- `display.image` — 图片 URL、data URL 或图片路径
- `display.chart` — ChartSpec JSON 图表
- `display.table` — 结构化表格数据

内容写在 `content` 引脚上；平台会同时把它当作节点正文。展示节点的 `content` 输出可以
接给后续 agent 当上下文。

## 输出要求

用户要求「生成/展示/放到 workspace 画布」时，直接编辑 `workspace.flow.js`。需要所见即所得
的线上画布，再用 `agentflow-cli workspace-preview --file <flowDir>` 上传到服务器临时
Workspace；不要把临时项目当作正式源版本。完成后简要说明新增或修改了哪些节点。
