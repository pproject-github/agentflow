---
name: agentflow-node-dsl
description: >-
  使用 AgentFlow Node DSL 编写代码节点包（节点目录中的 index.mjs），在流程里用起来，并发布到
  marketplace 供其它流程复用。用户要求「加一个自定义节点」「把这段逻辑做成可复用节点」
  「把节点发布出去」时使用。跨端搜索、上传、安装和 Flow 拉取/发布需配合
  agentflow-cli skill。
---

# AgentFlow Node DSL

**一个目录 = 一个节点 = 一个可发布的包。** `index.mjs` 同时是声明和实现。

```
<flowDir>/nodes/<name>/index.mjs
```

行为完全由输入决定、不需要 AI 推理的，就该是代码节点。需要理解和判断的用
`agent.subAgent`。

## CLI 前置条件

同时安装并读取 `agentflow-cli` skill。把其 `SKILL.md` 所在目录记为
`<agentflow-cli-skill-dir>`；不要假设当前项目包含 `skills/agentflow-cli`。先执行：

```bash
node <agentflow-cli-skill-dir>/scripts/agentflow-cli.mjs config
```

跨端节点操作要求 `localRuntime.available: true` 和有效 token；缺少 companion skill 或本地
AgentFlow runtime 时先停止并按 `agentflow-cli` 的安装说明修复。

写新包之前，先搜索服务端目录，避免重复造已有节点：

```bash
node <agentflow-cli-skill-dir>/scripts/agentflow-cli.mjs node-package-search --query "需要的能力"
```

结果包含固定版本 `specifier` 和输入/输出槽。满足需求时先 `node-package-install`，然后直接
import 返回的 `marketplace:<id>@<version>`；只有没有合适结果时才创建 `nodes/<name>/`。

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

`index.mjs` 是**普通 Node 模块**，会被真执行：`for` / `if` / `await` 都可以写。复杂实现可拆到
包内 `scripts/`，模板和资源可放 `templates/`、`assets/` 并用相对路径加载。不要提交
`node_modules`；跨端包当前只应依赖 Node 内置模块或包内自带源码。
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

要发给另一台机器或另一个 Agent workspace，上传和安装**整个包目录**：

```bash
node <agentflow-cli-skill-dir>/scripts/agentflow-cli.mjs node-package-publish --file <flowDir>/nodes/<name>
node <agentflow-cli-skill-dir>/scripts/agentflow-cli.mjs node-package-install \
  --node <id>@<version> --workspace-root <targetWorkspace>
```

流程和本地 `nodes/` 已经一起完成时，优先一键发布，避免漏传包或只传 `index.mjs`：

```bash
node <agentflow-cli-skill-dir>/scripts/agentflow-cli.mjs publish-flow \
  --flow-id <flow-id> --file <flowDir> --target-space personal --with-dependencies
```

命令上传所有包目录，并只在远端发布产物中把 `./nodes/<name>` 改为固定版本 import；本地
`workspace.flow.js` 保持不变。同版本不同内容会整批在上传前拒绝，必须先提升版本号。

如果已经有 `workspace.flow.js`，直接同步它声明的全部包：

```bash
node <agentflow-cli-skill-dir>/scripts/agentflow-cli.mjs node-package-sync \
  --flow <flowDir> --workspace-root <targetWorkspace>
```

如果流程本身还没落到本地，直接 pull；它会先同步包，再生成本地 DSL：

```bash
node <agentflow-cli-skill-dir>/scripts/agentflow-cli.mjs pull-flow \
  --flow-id <flow-id> --flow-source user --workspace-root <targetWorkspace>
```

传输格式是 ZIP，`scripts/`、`templates/`、`assets/` 都会随包传输；同一个 `id@version` 内容
不同会被拒绝，修改后必须提升版本号。

解析 `marketplace:<id>@<version>` 的顺序是**流程本地 → 已发布 → 集合**：流程自己的实现永远
不会被同名的已发布包顶掉。

已安装的包直接在 `workspace.flow.js` 里写版本化 import：

```js
import myNode from "marketplace:<id>@<version>";
```

存储层会把它投影成「基础类型 + `marketplaceRef`」，保存后仍保留这条 import。

## 别做的事

- **不要写 `node.yaml`。** 它只是已发布老包的回退清单，新包一律用 `index.mjs`。
- **不要写 `runtime.entry` / `scripts/run.mjs`。** 那是老 manifest 的字段，现在实现就在
  `index.mjs` 的 `run` 里。
- **不要找旧的 `agentflow marketplace install-node`。** 它写的是 `flow.yaml` 依赖钉。跨端安装
  使用 token-backed CLI 的 `node-package-install`；DSL 用 `marketplace:<id>@<version>` import。
- **不要用 `agentflow run` / `apply`。** Start/End Pipeline 执行栈已退休，运行走 Workspace。
- **不要把本机绝对路径或密钥写进包。**

## 相关

- `agentflow-flow-dsl`：图怎么写，import 代码节点的语法
- `agentflow-node-reference`：内置节点类型的槽位表
- `docs/wiki/code-node-packages.zh-CN.md`：更完整的说明
