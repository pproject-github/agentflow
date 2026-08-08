# 设计态与运行态分离

Workspace 图的设计态和运行态分开存：

```
workspace.flow.js      设计态：节点、连线、作者写的内容（见 flow-dsl.zh-CN.md）
workspace.layout.json  设计态：坐标、尺寸、引脚显隐
workspace.state.json   运行态：入槽/出槽产出、展示节点的运行内容、视口
```

本文只讲**边界划在哪里**；设计态那几个文件的格式见
[flow-dsl.zh-CN.md](flow-dsl.zh-CN.md)。

## 为什么

真实语料里运行产出占 **33.6%**——21 个线上流程共 1.38 MB，其中 465 KB 是每跑一次就
变一次的东西。混在一个文件里有三个后果：

- diff 全是噪音，看不出图结构改了什么
- AI 生成的图和跑过的图没法比对
- 导出 / 分享一张流程图会连着上次的运行产出一起带走

## 这是纯存储层的改动

`readWorkspaceGraph()` 合并两个文件后返回的图与拆分前**语义完全相同**，上层（包括
`workspaceDesignRevision` 的计算、协作合并、前端）看不到任何区别。唯一的差异是槽位
对象里 `value` / `default` 的键位置——合并时追加在末尾。

**没有迁移步骤。** 旧图的运行态还内联在 `graph.json` 里、没有 state 文件，此时合并是
恒等操作，照常读；下次写入时自动拆开。

## 一份判断，三个用处

「什么算运行态」由 `workspaceRuntimeSurface()` 一处给出，存储拆分、三路合并、
版本号计算共用：

| 用处 | 依赖它做什么 |
|------|--------------|
| `splitWorkspaceGraph` | 决定哪些值写进 `workspace.state.json` |
| `mergeWorkspaceGraphs` 的 `isRuntimePath` | 双方都改了同一个位置时，是报冲突还是直接取对方的 |
| `workspaceDesignRevision` | 决定「图变了没有」——协作基线就是这个值 |

这三处必须一致，否则会得到很难查的错觉。原本 `isRuntimePath` 自己写了一份，只覆盖
output 值和 `displayReloadKey`，漏掉了接了入边的入槽值和展示节点正文，后果是：

- **跑一次流程，`designRevision` 就变**——所有协作者手里的基线同时作废，明明没人改过图
- 两个人各跑一次，同一个输出槽被判成**字段冲突**，弹窗让人手选一个重跑就有的值

## 什么算运行态

与 `workspace-graph-merge.mjs` 的 `isRuntimePath` 同一套判断：

| 内容 | 去向 | 说明 |
|------|------|------|
| 非 provide 节点的 `output[*].value` / `.default` | state | provide 节点的输出值是用户填的，属设计态 |
| **接了非语义入边**的 `input[*].value` / `.default` | state | 每次运行都会被上游覆写 |
| 上下文注入槽的 `input[*].value` | state | `skillsContext` / `mcpContext` / `knowledgeContext` / `workspaceContext` / `gitContext`，有没有入边都一样 |
| 没有入边的 `input[*].value` | **设计态** | 作者填的默认值 |
| `displayReloadKey` | state | |
| `ui.viewport` | state | `ui.nodePositions` 留在设计态 |
| **有内容入边**的展示节点 `body` | state | |
| 无内容入边的展示节点 `body` | **设计态** | 作者手写的文档 |

需要看图结构才能判断的是「有没有入边」这几行。语料里有 **29 个**展示节点没有内容入边
——它们的 `body` 是作者手写的说明文档（64 KB）。把它们当运行态外移就等于删掉。

判断规则逐字复刻 ui-server 的 `workspaceContentInputEdge`：收集入边，去掉指向语义槽的
（`type: node`、`prev`/`next`/`skillsContext`/`mcpContext`/`knowledgeContext`/
`workspaceContext`/`gitContext`），剩下任意一条就说明这个槽的值是运行产出。

上下文注入槽单列一行，是因为它们的值一律由运行时灌入——语料里见过 15 KB 的 HTML 正文
被复制进 `workspaceContext`，那显然不是作者手填的默认值。

**不能简单按 `targetHandle !== "input-0"` 近似**——语料里有 32 个实例槽位顺序不规范，
`input-0` 未必是 `prev`。

## 写入顺序与失败处理

先落 `workspace.state.json` 再落设计态，全部用「写临时文件再 rename」。中途失败时设计态
仍是上一版，不会出现「新设计 + 空运行态」这种展示内容凭空消失的组合。

`workspace.state.json` 解析失败时按「没有运行态」处理，图照常打开——产出重跑就有，
设计态才是不可再生的。

## 顺带修掉的

原本有 4 处 `fs.writeFileSync(graphPath, ...)` 绕过了原子写（展示分享、排程开关、
运行结束回写、预览上传）。现在全部走 `writeWorkspaceGraph`，既拿到拆分也拿到原子性。

## 测试

`test/workspace-state-split.test.mjs`，含 200 个确定性随机图的属性测试（恒等 + 幂等 +
设计态不含任何运行产出）。真实语料含内网业务内容，不入库，用随机图覆盖同样的形状空间
（含非规范槽序、输出槽重名、缺失 body 等）。
