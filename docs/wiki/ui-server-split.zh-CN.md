# 把 PRD workflow 从 ui-server 拆出去

## 起因

`ui-server.mjs` 两万行，里面挤着**两个互不相干的产品**：

| | 行数 | 顶层符号 |
|---|---|---|
| Workspace 运行时 | ~3,900 | `workspace*` 169 个 |
| PRD workflow | ~4,900 | `prd*` / `workflow*` 197 个 |
| HTTP 路由（`startUiServer` 一个函数） | ~7,000 | 142 条路由 |
| 其余（鉴权、团队、模型配置、终端…） | 余下 | |

两个子系统除了共用 HTTP 路由和鉴权没有任何关系，却共享同一个 diff 面：改 Workspace 运行时
要在两万行里定位，PRD 的改动跟着一起进 review。

## 耦合方向早就是单向的

先量，再动。PRD 那一坨依赖 ui-server 内部的符号只有 **4 个**：

```
htmlEscapeAttribute   11 个 prd 函数在用
execFileBuffered       1 个
runtimeEnvForUser      1 个
readUserWorkspaces     1 个（workflowBindableWorkspaces）
```

反方向 74 个，但**几乎全被 `startUiServer` 一个函数调用**——那就是路由层，本来就该调子系统。

所以这不是解耦，是搬运。

## 怎么处理那 4 个

- `htmlEscapeAttribute` / `execFileBuffered` 各自成一个小模块（`html-escape.mjs`、
  `exec-buffered.mjs`），两边 import 同一份
- `runtimeEnvForUser` 移进 `user-env.mjs`——它本来就只是 `readMergedEnvObject` 的一层包装，
  那里才是它的家
- `readUserWorkspaces` 是 ui-server 的状态访问器，不动。用它的
  `workflowBindableWorkspaces` 只有 4 行，留在 ui-server 当适配器

## 搬运本身是脚本做的，不是手改的

四千八百行手动搬会漏。做法：

1. 解析顶层符号表，每个符号的区间**向上吃掉紧贴的注释块**（不然 JSDoc 会留在原地）
2. 种子 = 名字以 `prd` / `workflow` 开头的符号 + `runPrdWorkflowCommand`
3. 取闭包：只被搬走集合引用的符号一起搬（这次是 0 个，说明边界本来就干净）
4. 算新文件需要哪些 import、ui-server 要 import 回来哪些
5. 原样复制区间，只在需要导出时加 `export`

搬完做等价性验证：**197 个符号逐个和原文件按字节比对，只允许多一个 `export` 前缀**。
结果 0 处差异、0 个遗漏、ui-server 里 0 处残留。

### 路上踩的两个坑

**多行 import 的边界。** 两个脚本都用「最后一行以 `import ` 开头」当 import 区块的结尾——
可多行 import 的 `import {` 那行也以它开头。一次导致插入点落在语句中间（语法错误，立刻发现），
一次导致后半段 import 全被漏掉，新文件里 `materializeWorkflowGlobalState` 成了未定义
（HTTP 500，测试才发现）。锚点必须是**语句结尾**：`^(import .* from |\} from )"…";$`。

**扫引用时的字符串。** `"x.cache.json"` 会让 `json` 冒充成一个依赖。抹掉引号字符串再扫，
剩下的两处（对象键 `json: ""`、模板串里的 `--json`）逐个看过才进白名单。

## 结果

```
ui-server.mjs          20,609 -> 15,789   (-23%)
prd-workflow-server.mjs         4,884
html-escape.mjs / exec-buffered.mjs   19 + 32
```

顺带清掉 13 个搬完之后没人用的 import（其中 `getFlowYamlAbs`、`FLOW_YAML_FILENAME` 是上一次
目录哨兵改动留下的）。

## 第二刀：路由也搬过去

子系统实现搬走之后，`startUiServer` 里还留着它的 31 条路由（2,765 行，占那个七千行请求回调
的 40%）。这一刀把路由也搬进 `prd-workflow-routes.mjs`。

难点在于路由体是**闭包代码**：直接引用请求回调里的 `url` / `userCtx`，也直接调 `json(res,…)`。
硬搬要么改写每一行，要么放弃「逐字节可验证」这个性质。两个约定绕开了它：

**命中与否看 `res.headersSent`。** 路由体里的 `return;` 一律不动——它们在原地就是「已经回过
响应，别再往下走」。外层：

```js
export async function handlePrdWorkflowRoutes(req, res, ctx) {
  await prdWorkflowRoutes(req, res, ctx);
  return res.headersSent;
}
```

换成把 `return;` 改写成 `return true` 就得逐个甄别哪些 `return` 在嵌套回调里——那正是这类
搬运最容易出错的地方。

**闭包变量在函数头解构回同名标识符。**

```js
async function prdWorkflowRoutes(req, res, ctx) {
  const { url, authUser, userCtx, root, host, uiPort, resolveWorkspaceScopeRoot, … } = ctx;
```

于是路由体里的写法完全不变。这一串解构就是路由层对 ui-server 的**真实耦合面**——18 个名字：
6 个请求上下文（`url` / `authUser` / `userCtx` / `root` / `host` / `uiPort`）+ 12 个两边都在用
的函数。`json` / `readBody` 不在里面，它们抽成了 `http-util.mjs`，两边 import 同名。

18 个是多了点，但这是当下真实的耦合，写出来比藏在闭包里强——下次谁想减，看这一行就知道减什么。

### 顺序安全性要先证明

搬运把散落在第 5～36 位的 31 条路由集中提到第 5 位。这会改变匹配优先级，除非：

- 中间的非 PRD 路由没有前缀/正则匹配（查了：0 条）
- 没有 (method, path) 在 PRD 组和非 PRD 组之间重复（查了：140 个路由里 4 处重复，全在组内）

两条都成立，所以提前是安全的。

### 结果

```
ui-server.mjs          15,789 -> 12,780
prd-workflow-routes.mjs         2,949
startUiServer           7,010 ->  4,251
```

31 个路由块逐字节比对：31/31 原样出现在新文件里，ui-server 里 0 处残留。顺带清掉 95 个
搬完之后没人用的 import。

7 个只被这些路由用到的 helper 跟着搬了过去（119 行）。另有 4 个本来也能搬，最后留下：
`serverPublicBaseUrl`、`resolvePrdWorkflowScope`、`workflowBindableWorkspaces`、
`prepareWorkflowKnowledgeWorktrees` 自己就用到 ctx 传进来的依赖，而搬走的 helper 落在模块
顶层，看不到路由函数里那句解构。这条规则写进了脚本，不是靠人记——第一次没写，跑出来一个
`normalizePublicBaseUrl is not defined` 的 500。

`startUiServer` 还剩 4,251 行 / 121 条路由——`/api/workspace` 27 条是下一个候选。

## 守住边界

`test/module-boundaries.test.mjs` 五条：

1. 实现和路由两个模块都不 import ui-server（有环的话 ESM 靠函数提升还能跑，但初始化顺序会
   变成运气）
2. PRD 的路径字面量在 ui-server 里一个都不剩，派发点只有一处——多一处就说明路由又开始往回长
3. ui-server 里不再声明 `prd*` / `workflow*` 顶层符号
4. 三个共享小工具全仓库只有一处声明——拆分最容易犯的错是两边各留一份
5. 两个文件都不留没人用的 import

最后一条写的时候本身踩了坑：抹字符串会把模板串
`` `href="${htmlEscapeAttribute(x)}"` `` 里的真调用一起吃掉，误报成死 import。改成不抹字符串
——宁可把「只在字符串里出现的名字」也算用过，这条断言要抓的是「哪儿都没出现」的死 import，
不是精确可达性分析。
