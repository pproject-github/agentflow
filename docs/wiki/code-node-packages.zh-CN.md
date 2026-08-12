# 代码节点包

一个代码节点是一个**完整目录包**。`index.mjs` 是根入口和声明来源，但实现可以拆到
`scripts/`，模板和静态资源也可以放在 `templates/`、`assets/`。目录可以直接放在流程里
（`<flowDir>/nodes/<name>/`），也可以打成 ZIP 发布到 marketplace；ZIP 只是传输形式，包目录
才是运行单元。

```js
// nodes/count-lines/index.mjs
import fs from "node:fs/promises";

export default {
  id: "count_lines",              // 必填，构成 marketplace:count_lines@1.0.0
  version: "1.0.0",               // 必填
  name: "统计行数",
  description: "读一个文本文件，统计行数",
  inputs:  { filePath: { type: "text", description: "文件路径", required: true } },
  outputs: { total: { type: "text" } },
};

export async function run(inputs, outputs, dirs) {
  const text = await fs.readFile(inputs.filePath, "utf-8");
  await fs.writeFile(outputs.total, String(text.split("\n").length));
  console.log(`共 ${text.split("\n").length} 行`);   // stdout 即节点 result
}
```

## 声明为什么必须是纯字面量

`export default` 由 acorn **静态解析**——列节点面板、渲染画布、校验槽位，全程不执行包
里的代码。目录扫描期执行第三方代码既慢又不安全，所以这是硬约束，不是风格偏好。

代价是声明里不能有变量引用、函数调用、展开运算。违反时会带位置报错：

```
export default.id: 只允许字面量，不允许 Identifier
```

而不是静默变成空清单让节点从面板上消失。

`node.yaml` 仍作为回退——已发布的老包不受影响。

发布也走同一条读取路径：`agentflow marketplace publish-node <dir>` 认 `index.mjs`，不需要额外写一份
`node.yaml`。

## 跨端分发

本地复制和跨端分发是两条明确的命令：

AI 新建包之前先查远端目录；返回值带固定版本 import、槽位和安装提示：

```bash
node skills/agentflow-cli/scripts/agentflow-cli.mjs node-package-search --query "需要的能力"
```

```bash
# 只复制到当前 workspace 的 marketplace
agentflow marketplace publish-node ./my-node

# ZIP 上传到 AgentFlow 服务，再下载安装到另一个 workspace
node skills/agentflow-cli/scripts/agentflow-cli.mjs node-package-publish --file ./my-node
node skills/agentflow-cli/scripts/agentflow-cli.mjs node-package-list
node skills/agentflow-cli/scripts/agentflow-cli.mjs node-package-install \
  --node my_node@1.0.0 --workspace-root /path/to/target-workspace
```

当拿到的是一个 Flow 时，不需要逐个安装。DSL 里的版本化 import 就是依赖清单：

```bash
node skills/agentflow-cli/scripts/agentflow-cli.mjs node-package-sync \
  --flow .workspace/agentflow/pipelines/<flow-id> \
  --workspace-root "$PWD"
```

命令静态扫描全部 `marketplace:` import，先检查远端版本和本地冲突，再下载并校验全部 ZIP，
最后安装。输出分为 `installed`、`unchanged`、`missing`、`conflicts`；依赖不完整时退出码为 2。
安装元数据记录服务地址、内容哈希和安装时间。

Flow 还在平台时，用 `pull-flow` 一次完成“取图 → 同步全部精确版本包 → 去掉远端运行态 →
生成本地 DSL”：

```bash
node skills/agentflow-cli/scripts/agentflow-cli.mjs pull-flow \
  --flow-id <flow-id> --flow-source user --workspace-root "$PWD"
```

默认写入 `.workspace/agentflow/pipelines/<flow-id>`；非空目录默认拒绝，明确需要更新时才传
`--replace`。

上传、下载的是整个目录，不只是 `index.mjs`。ZIP 必须以 `index.mjs` 为包根；允许相对脚本、
模板、资源，拒绝路径穿越、符号链接、`node_modules`、`.env`、私钥等敏感内容。解压后最多
500 个文件、8MB，ZIP 最大 10MB。

远端仓库的 `id@version` 不可变：相同内容重复上传是幂等成功；内容变了必须提升版本号。安装
完成后，DSL 直接把包身份写进代码：

```js
import myNode from "marketplace:my_node@1.0.0";
const result = myNode("执行", { input: "value" });
```

`publish-flow` 上传前也会向服务端预检这些精确版本；服务端的单文件导入和图更新接口再检查
一次。缺包时 Flow 不落盘，并直接返回需要先上传的 `marketplace:id@version`。

本地 DSL 仍使用 `./nodes/<name>` 时，可以一键上传 Flow 和所有完整包：

```bash
node skills/agentflow-cli/scripts/agentflow-cli.mjs publish-flow \
  --flow-id <flow-id> --file <flowDir> --target-space personal --with-dependencies
```

所有本地包会先整体校验、检查远端同版本冲突，再逐包上传；相对 import 只在上传产物里改成
`marketplace:<id>@<version>`，不会修改本地 `workspace.flow.js`。不带该参数时，含 `nodes/` 的
目录仍会被拒绝，避免静默发布残缺流程。

## 槽位

`inputs` / `outputs` 是**有序映射**，槽位顺序 = 声明顺序，控制槽 `prev` / `next` 自动
前置。这一点很重要：图里的连线用的是位置句柄（`input-0`、`output-1`），改声明顺序等于
改接线。

可用类型：`text` `file` `bool` `node` `image` `json`。未知类型直接报错。

## `run(inputs, outputs, dirs)`

| 参数 | 内容 |
|------|------|
| `inputs` | 槽位名 → 上游传来的值 |
| `outputs` | 槽位名 → **要写入的绝对路径**（不是值） |
| `dirs` | `workspaceRoot` / `nodeRunDir` / `nodeTmpDir` / `outputsDir` |

`outputs.total` 是路径不是值——这是最容易搞错的一点。

失败方式就是抛错或非零退出，没有别的协议。

## 输出怎么回到槽里

每个声明的输出槽有自己的文件，写进去就落到那个槽。**第一个非控制输出槽**承载节点的
结果正文——注意是「第一个非控制槽」，不是下标 0：规范槽序是 `[next, total]`，下标 0 是
控制槽 `next`。这条判断以前在 ui-server 里写了 6 遍，判据都是 `index === 0`，于是名字
不叫 `result` / `content` 的输出槽在写文件那层被当成结果、在回填那层又不被认，值卡在
中间谁也拿不到。现在收敛成一份。

**stdout 只在结果槽没写文件时才当结果正文。** 写文件是明确动作，`console.log` 常常只是
进度；让打印盖掉写入是反直觉的，上面那个范例正好同时做了两件事。

下游拿到的是**内容**还是**路径**，取决于目标槽的类型：`text` 槽自动读成内容，
`file` / `image` 这类槽保持路径。

## 为什么需要 bootstrap

`index.mjs` 是**模块**不是脚本，`node index.mjs` 只会把定义执行完就退出，`run` 永远
不会被调用。

所以清单里带 `runtime.mode = "module"` 的包，生成的命令是：

```
node bin/lib/node-package-bootstrap.mjs <包目录>/index.mjs
```

bootstrap 负责把运行时的环境契约（`AGENTFLOW_INPUTS_JSON` /
`AGENTFLOW_OUTPUTS_ABS_JSON` / `AGENTFLOW_NODE_RUN_DIR` …）翻译成 `run()` 的三个参数。
入口路径的包含性校验发生在这之前，越界的 `entry` 仍然被拒。

## 解析顺序

解析 `marketplace:<id>@<version>` 时：

1. `<flowDir>/nodes/*/` —— 流程自带的实现
2. `<workspace>/marketplace/packages/nodes/<id>/<version>/` —— 已发布的包
3. 依赖的 collection

**流程自带的实现永远不会被同名的已发布包顶掉。** 反过来，`agentflow.lock.json` 里
锁定的版本仍然生效：版本对不上就跳过本地包，不会错误命中。

## 相关

- 节点定义（builtin 节点）的单一来源见 [node-definitions.zh-CN.md](node-definitions.zh-CN.md)
- 测试：`test/node-package-runtime.test.mjs`（静态解析 + bootstrap 执行）、
  `test/node-package-graph-hydration.test.mjs`（HTTP 运行链路）、
  `test/node-package-distribution.test.mjs`（ZIP 上传、跨 workspace 安装、DSL 和执行全链路）
