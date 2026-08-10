# 让 AI 生成自定义节点

## 之前为什么走不通

两处各自断了一半。

**给 AI 看的参考是错的。** `skills/agentflow-node-authoring` 长期教的是 `node.yaml` +
`runtime.entry` + `scripts/run.mjs`，还让人跑已经退休的 `agentflow run`、以及对代码流程无效的
`marketplace install-node`。而运行时早就换成了 `index.mjs`——声明和实现同一个文件，acorn 静态
解析。文档 wiki 改了，skill 没跟上。

后果不是「文档不准」这么轻：**AI 读哪份就写出哪种格式**，写出来的包扫描不到，面板上什么都
不出现，而且没有任何报错——因为那个目录压根不被认成节点包。

**Node Studio 是个完整的 mockup。** `POST /api/node-studio/draft` 把提示词存下来，回一句写死
的「已记录需求，下一步会由节点 Agent 更新 manifest、脚本和 UI schema」；Test 是 900ms 的
`setTimeout`；Publish 的 onClick 是空的；测试输入框硬编码成 `project` / `date` 且 `readOnly`。
整个 workspace 路由里只有两处真起 Agent（`/api/workspace/generate` 生成 display 正文、
`/api/workspace/node-chat` 改 display 内容），节点生成没接。

## 现在的闭环

```
描述需求 → Agent 写 index.mjs → acorn 解析回填清单 → 真跑一次 → 发布进市场
```

四个环节都落在**运行时同一条路径**上，没有第二套实现：

| 环节 | 走的是 |
|---|---|
| 解析清单 | `readNodePackageManifest` —— 和节点面板、画布、缓存指纹同一个 |
| 执行测试 | `node-package-bootstrap.mjs` —— 和 Workspace 跑节点同一个 |
| 发布 | `publishNodePackage` —— 和 `agentflow marketplace publish-node` 同一个 |

「Node Studio 里跑得过、画布上跑不过」的测试不如没有，所以这三处都不另写。

### 草稿目录

```
<userDataRoot>/node-studio/drafts/<id>/
  draft.json        对话、清单投影、测试记录
  package/          真正的包目录
    index.mjs
```

包放在 `package/` 子目录而不是和 `draft.json` 同级：`publishNodePackage` 是整目录 `cpSync`，
同级的话草稿元数据会被一起发布出去。

Agent 的 `cliWorkspace` 就是这个包目录——它的工作目录即它要写的地方，不必在提示里报绝对路径，
也就写不到别处去。

### 清单是投影，不是第二份真相

`draft.manifest` 每次都从 `index.mjs` 重新解析。草稿自己不存一份手写的清单——存了就会和声明
对不上，而面板、画布、运行时读的都是声明那一份。

解析失败时**不保留上一次的旧清单**，而是把错误写进 `draft.parseError` 并显示在预览区。留着旧
清单假装没事，等于让用户对着一个已经不存在的契约调试。

## 发布前必须解析得过

```
POST /api/node-studio/publish
  → 没有 index.mjs        400 「还没有 index.mjs，先让 Agent 生成」
  → export default 读不出  400 「export default.inputs.a: 只允许字面量，不允许 Identifier」
  → 通过                   publishNodePackage
```

发布一个读不出声明的包，等于往市场里放一个在面板上根本不出现的条目——问题会推迟到别人安装
它的时候才暴露，那时已经离现场很远了。

## 测试阶段就点出来的两件事

**声明了却没写文件的输出槽。** 下游会拿到空值，而节点自己一声不吭。

**`file` 槽里写的是路径而不是内容。** 这条是真实生成的节点踩出来的：让它写一个「CSV 按列去重」
节点，它把去重结果写到自选路径，再把那个路径当字符串写进 `outputs.outputFile`：

```js
await fs.writeFile(outputPath, csvText);            // 写到自选位置
await fs.writeFile(outputs.outputFile, outputPath); // 槽里只放了一个路径
```

在测试里看着能过——路径确实存在。但槽文件才是被当成产物管理的东西，自选的那个路径在真实
运行时位于会被清理的临时目录里，产物就丢了。

修了两处：生成提示里明写这一条，测试日志里对 `file` 槽的绝对路径内容发警告。

## skill 怎么防止再漂

`test/node-authoring-skill.test.mjs` 不比对字符串，而是**把 skill 里的示例真的喂给解析器**：

1. 第一个 ```js 代码块写进临时目录，`readNodePackageManifest` 必须读出
   `count_lines@1.0.0`、槽位 `[prev, filePath]` / `[next, total]`，且导出了 `run`
2. skill 里演示的三种错误写法（变量引用、展开、成员访问）必须真的抛错，且报错以
   `export default` 开头——带位置，不是一句「解析失败」
3. 「别做的事」之前的正文里不许出现 `node.yaml` 必需、`runtime.entry`、`agentflow run`、
   `install-node`；而「别做的事」一节必须点名这四样

第 3 条分两半是有原因的：只扫全文的话，一句「不要用 `agentflow run`」也会被判成违规——等于
禁止 skill 警告用户别踩坑。

## 还是 mockup 的部分

Node Studio 里这些没有接，也没有假装接上：

- **UI schema / card variant**：原来那套 `configSchema.fields`、`ui.card.actions`、定时卡片
  预览，代码节点声明里根本没有对应字段。已从页面移除，不留一个填不进东西的空壳
- **多草稿管理**：只有一个下拉切换，没有新建/删除/重命名
- **版本**：发布同一个 `id@version` 会直接覆盖，没有版本冲突提示
