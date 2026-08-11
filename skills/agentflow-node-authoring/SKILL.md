---
name: agentflow-node-authoring
description: >-
  编写 AgentFlow 代码节点包（nodes/<name>/index.mjs），在流程里用起来，并发布到
  marketplace 供其它流程复用。用户要求「加一个自定义节点」「把这段逻辑做成可复用节点」
  「把节点发布出去」时使用。
---

# AgentFlow 代码节点

**一个目录 = 一个节点 = 一个可发布的包。** `index.mjs` 同时是声明和实现。

```
<flowDir>/nodes/<name>/index.mjs
```

行为完全由输入决定、不需要 AI 推理的，就该是代码节点。需要理解和判断的用
`agent.subAgent`。

## 最小完整例子

```js
import fs from "node:fs/promises";

export default {
  id: "count_lines",              // 必填，构成 marketplace:count_lines@1.0.0
  version: "1.0.0",               // 必填，完整 semver
  name: "统计行数",
  description: "读一个文本文件，统计行数",
  inputs: {
    filePath: { type: "text", description: "文件路径", required: true },
  },
  outputs: {
    total: { type: "text" },
  },
};

export async function run(inputs, outputs, dirs) {
  const text = await fs.readFile(inputs.filePath, "utf-8");
  const total = text.split("\n").length;
  await fs.writeFile(outputs.total, String(total), "utf-8");
  console.log(`共 ${total} 行`);   // 进度而已
}
```

在图里就是一条 import：

```js
import countLines from "./nodes/count-lines";

const count = countLines("统计行数", { filePath: pick.result });
const show  = display.markdown("结果", { content: count.total });
```

## 三条硬约束

**① 声明必须是纯字面量。** `export default` 由 acorn **静态解析**——列节点面板、渲染画布、
校验槽位、算运行缓存指纹，全程不执行包里的代码。目录扫描期执行第三方代码既慢又不安全。

```js
const T = "text";
export default { inputs: { day: { type: T } } };        // ✗ 变量引用
export default { ...base, id: "x" };                     // ✗ 展开
export default { version: pkg.version };                 // ✗ 成员访问
```

违反时带位置报错（`export default.id: 只允许字面量，不允许 Identifier`），不会静默变成空
清单让节点从面板上消失。

**② `outputs.<name>` 是要写入的绝对路径，不是值。** 最容易搞错的一点。

```js
await fs.writeFile(outputs.total, String(total));   // ✓
outputs.total = String(total);                      // ✗ 什么都没发生
```

每个声明过的输出槽各自一个文件。**第一个非控制输出槽**承载节点的结果正文。stdout 只在你
**没有**为结果槽写文件时才当结果——所以 `console.log` 打进度不会盖掉你写进去的值。

`file` 类型的输出槽同理，把**文件内容本身**写到 `outputs.<name>` 上：

```js
await fs.writeFile(outputs.deduped, csvText, "utf-8");            // ✓
const p = path.join(dirs.outputsDir, "deduped.csv");
await fs.writeFile(p, csvText); await fs.writeFile(outputs.deduped, p);   // ✗
```

第二种在测试里看着能过（下游确实拿到一个存在的路径），但槽文件才是被当成产物管理的东西，
你自选的那个路径在真实运行时位于会被清理的临时目录里。

**③ 槽位顺序 = 画布 handle 顺序。** `inputs` / `outputs` 是有序映射，控制槽 `prev` / `next`
自动前置。改声明顺序等于改已有流程的接线，加槽位请往后加。

可用类型：`text` `file` `bool` `node` `image` `json`。未知类型直接报错。

## `run(inputs, outputs, dirs)`

| 参数 | 内容 |
|------|------|
| `inputs` | 槽位名 → 上游传来的值。`file` 槽拿到的是路径 |
| `outputs` | 槽位名 → **要写入的绝对路径** |
| `dirs` | `workspaceRoot` / `nodeRunDir` / `nodeTmpDir` / `outputsDir` |

失败 = 抛异常或非零退出。不要用 JSON 包裹 stdout，也不要自己造结果文件。

`index.mjs` 是**普通 Node 模块**，会被真执行：`for` / `if` / `await` / 第三方依赖随便写。
和 `workspace.flow.js` 那种「禁一切控制流」的结构文件完全两套规则。

## 验证

```bash
agentflow flow dsl lint <flowDir>     # 声明能不能静态解析、接线对不对
```

然后在画布上跑一次。节点会以 `marketplace:<id>@<version>` 出现在面板里。

## 发布给别的流程用

流程自带的 `nodes/<name>/` 只有那个流程能用。要复用就发布：

```bash
agentflow marketplace publish-node <flowDir>/nodes/<name>
agentflow marketplace list
```

包会被复制到 `.workspace/agentflow/marketplace/packages/nodes/<id>/<version>`。

解析 `marketplace:<id>@<version>` 的顺序是**流程本地 → 已发布 → 集合**：流程自己的实现永远
不会被同名的已发布包顶掉。

已发布的包在图里没有本地路径可 import，所以它的形态是「基础类型 + `marketplaceRef`」，引用
信息落在 `workspace.nodes.json` 里，不写进 `workspace.flow.js`。

## 别做的事

- **不要写 `node.yaml`。** 它只是已发布老包的回退清单，新包一律用 `index.mjs`。
- **不要写 `runtime.entry` / `scripts/run.mjs`。** 那是老 manifest 的字段，现在实现就在
  `index.mjs` 的 `run` 里。
- **不要找 `agentflow marketplace install-node`。** 它已经删了：写的是 `flow.yaml` 里的依赖
  钉，而代码化流程不读 flow.yaml。要用一个包，直接在 `workspace.flow.js` 里写 import（流程
  自带的包）或让节点带上 `marketplace:<id>@<version>`（已发布的包）。
- **不要用 `agentflow run` / `apply`。** Start/End Pipeline 执行栈已退休，运行走 Workspace。
- **不要把本机绝对路径或密钥写进包。**

## 相关

- `agentflow-flow-dsl`：图怎么写，import 代码节点的语法
- `agentflow-node-reference`：内置节点类型的槽位表
- `docs/wiki/code-node-packages.zh-CN.md`：更完整的说明
