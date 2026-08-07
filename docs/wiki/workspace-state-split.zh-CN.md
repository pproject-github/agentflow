# 设计态与运行态分离

Workspace 图现在落两个文件：

```
workspace.graph.json   设计态：节点、连线、位置、作者写的内容
workspace.state.json   运行态：输出槽产出、展示节点的运行内容、视口
```

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

## 什么算运行态

与 `workspace-graph-merge.mjs` 的 `isRuntimePath` 同一套判断：

| 内容 | 去向 | 说明 |
|------|------|------|
| 非 provide 节点的 `output[*].value` / `.default` | state | provide 节点的输出值是用户填的，属设计态 |
| `displayReloadKey` | state | |
| `ui.viewport` | state | `ui.nodePositions` 留在设计态 |
| **有内容入边**的展示节点 `body` | state | |
| 无内容入边的展示节点 `body` | **设计态** | 作者手写的文档 |

最后两行是唯一需要看图结构才能判断的。语料里有 **29 个**展示节点没有内容入边——它们的
`body` 是作者手写的说明文档（64 KB）。把它们当运行态外移就等于删掉。

判断规则逐字复刻 ui-server 的 `workspaceContentInputEdge`：收集入边，去掉指向语义槽的
（`type: node`、`prev`/`next`/`skillsContext`/`mcpContext`/`knowledgeContext`/
`workspaceContext`/`gitContext`），剩下任意一条就说明 `body` 是运行产出。

**不能简单按 `targetHandle !== "input-0"` 近似**——语料里有 32 个实例槽位顺序不规范，
`input-0` 未必是 `prev`。

## 写入顺序与失败处理

先落 `workspace.state.json` 再落 `workspace.graph.json`，两个都用「写临时文件再 rename」。
中途失败时设计态仍是上一版，不会出现「新设计 + 空运行态」这种展示内容凭空消失的组合。

`workspace.state.json` 解析失败时按「没有运行态」处理，图照常打开——产出重跑就有，
设计态才是不可再生的。

## 顺带修掉的

原本有 4 处 `fs.writeFileSync(graphPath, ...)` 绕过了原子写（展示分享、排程开关、
运行结束回写、预览上传）。现在全部走 `writeWorkspaceGraphAtomic`，既拿到拆分也拿到
原子性。

## 测试

`test/workspace-state-split.test.mjs`，含 200 个确定性随机图的属性测试（恒等 + 幂等 +
设计态不含任何运行产出）。真实语料含内网业务内容，不入库，用随机图覆盖同样的形状空间
（含非规范槽序、输出槽重名、缺失 body 等）。
