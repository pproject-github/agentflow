# 一个目录凭什么算流程

## 曾经的答案：`flow.yaml` 存在

Start/End Pipeline 执行栈退休之后，`flow.yaml` 的**内容**就是死的了。但它的**存在**还承重：

```js
// catalog-flows.mjs
.filter((e) => fs.existsSync(path.join(dirPath, e.name, "flow.yaml")))
```

这一行在十来处各写了一遍——`auth.mjs`、`paths.mjs`、`workspace.mjs`、`flow-write.mjs`、
`marketplace.mjs`、`catalog-agents.mjs`、`admin-builtin-pipelines.mjs`、`ui-server.mjs`。
没有 `flow.yaml` 的目录在列表、路径解析、改名、归档里全都不存在，哪怕它有一份完整的
`workspace.flow.js`。

所以新建流程时还得写一个空壳 yaml，只为让目录「存在」。这不是设计，是遗留物长进了承重墙。

## 现在的答案：三种标记文件任一

`paths.mjs` 里一条判据，别处不再自己写：

```js
export const FLOW_MARKER_FILENAMES = ["workspace.flow.js", "workspace.graph.json", "flow.yaml"];
export function isFlowDir(dir) { return flowMarkerPath(dir) !== ""; }
```

顺序即权威顺序：代码 > 只读的遗留 JSON > 已退休的 yaml。

## 顺带拆开的两处耦合

**目录解析和 yaml 解析。** `getFlowYamlAbs` 以前是唯一的入口：它按
user → workspace → legacy 的顺序找目录，然后拼上 `/flow.yaml` 返回。可多数调用方紧接着就
`path.dirname(...)` 把 yaml 名去掉——它们要的一直是**目录**。于是「改个名」这种和 yaml 毫无
关系的操作也被 yaml 是否存在卡住。

现在拆成两个：

- `resolveFlowDirAbs(...)` → 目录，用 `isFlowDir` 判存在
- `getFlowYamlAbs(...)` → 目录 + `/flow.yaml`，**只给真的要读 yaml 内容的调用方**

改名、归档、删除、schedule 解析都改走前者。

**列表说明。** 那一行说明以前只能从 `flow.yaml` 的 `ui.description` 读。代码化的图里，
`ui.description` 往返时由 `extractLayout` 透传到 `workspace.layout.json` 的顶层，所以
`readPipelineListDescription` 先看 layout，读不到再退回 yaml。两者都有时以代码为准。

## 结果：新流程生下来就是代码

`createEmptyFlow` 取代了 `buildEmptyUserFlowYaml` + `writeFlowYaml`。新建一个流程得到：

```
workspace.flow.js      只有一行 import 的空图
workspace.layout.json  { version, description }
```

没有 `flow.yaml`。两个内置模板也删掉了各自的空壳。

## Hub 那一侧还没动

线上包格式仍要求包里有 `flow.yaml`——`flow-import.mjs` 找不到它就直接拒收，下载侧也按它
认包。所以 `agentflow publish` 在打包代码化的流程时会**补一份只带说明的空壳 yaml**，真正的
图照旧以 `workspace.flow.js` 发出去；装回来时 `isFlowDir` 优先认代码。

这是个桥，不是终点。要让 yaml 彻底消失，得改 Hub 的收发两端。

## 还认 flow.yaml 的地方

这些是**真的要读 yaml 内容**，不是拿它当哨兵，所以留着：

| 位置 | 干什么 | 代码化流程下的表现 |
|------|--------|--------------------|
| `flow-import.mjs` / `hub-remote.mjs` | Hub 包格式 | 见上，publish 侧补壳 |
| `marketplace.mjs` install-node | 把节点依赖写进 flow.yaml | 对代码化流程无效，应改成写 import |
| `main.mjs` `flow preview` | 老版静态预览 | Workspace 图走 `flow dsl` 那条路 |
| `catalog-flows.mjs` `readFlowJson` | 读 legacy 图 | 只在没有 Workspace 图时才走到 |
