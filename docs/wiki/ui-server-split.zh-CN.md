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

## 第三刀：Workspace 运行时

轮到 Workspace 时先量了一遍，结论和 PRD 不一样：**路由不能先搬**。

`/api/workspace` 那批路由依赖 45 个 ui-server 顶层符号——运行计划、图 hydrate、协作广播、
run controller 状态。它们同时被闸门之前的 `/api/display/share*` 路由和调度器用着，所以
不是「路由的依赖」，是**运行时本身**。顺序反了：得先搬实现，再搬路由（PRD 就是这个顺序，
只是当时没意识到那是必要条件而不是偶然）。

改成先量运行时：291 个符号 / 5,984 行，对 ui-server 其余部分的依赖 **0 个**，要 export
回去 75 个。和 PRD 一样干净，同一套脚本直接跑。

闭包要迭代三轮才收敛：`workspace*` 开头的 252 个 → 带出 15 个小工具（`sleepMs`、
`parseJsonText`、display 分享那几个）→ 又带出 7 个 → 再带出 1 个。每一轮都是「只有这批在用」
才收，不是按名字猜。

### 途中发现的一件事

差点搬出一个鉴权漏洞。ui-server 的路由链里有一道硬闸门：

```js
if (url.pathname.startsWith("/api/") && !authUser) { json(res, 401, …); return; }
```

它在第 12 位。Workspace 路由散在第 7～92 位——**跨着闸门**。集中派发点如果放在闸门前面，
闸门后面那 38 条路由就等于对未登录请求敞开了。

回头查了上一刀：PRD 的 31 条路由原本全在第 5～36 位，闸门在第 42 位，全在闸门**之前**
（它们本来就自带 token / share 鉴权），所以提到第 5 位没有跨界。虚惊一场，但这条约束现在
写进了脚本：派发点必须落在闸门之后，闸门之前的路由不参与搬运。

### 结果

```
ui-server.mjs          12,780 -> 6,859
workspace-server.mjs            6,035
```

291 个符号逐字节比对：0 处改动、0 个遗漏、ui-server 里 0 处残留。又清掉 24 个死 import
（这次的清理脚本得处理单行 `import { a } from "x";` 和多行两种写法——只按 `  name,` 逐行
删会漏掉前者）。

三刀合计：**20,609 -> 6,859（-67%）**。

| 文件 | 行数 |
|------|------|
| `ui-server.mjs` | 6,859 |
| `workspace-server.mjs` | 6,035 |
| `prd-workflow-server.mjs` | 4,884 |
| `prd-workflow-routes.mjs` | 2,949 |
| `http-util` / `html-escape` / `exec-buffered` | 100 |

## 第四刀：Workspace 路由

实现就位之后，路由那 45 个「未安置依赖」只剩 1 个（`listConfiguredWorkspaces`）——其余全部
变成从 `workspace-server.mjs` import。这就是「先搬实现再搬路由」的意义：第一次量出来的
45 个耦合，有 44 个根本不是耦合，是顺序错了。

37 条路由 / 1,904 行，外加 23 个只被它们用到的 helper / 538 行。派发点落在鉴权闸门之后
（脚本里的硬约束）。37 个路由块逐字节比对全部原样，ui-server 里 0 处残留。

清掉 64 个死 import——搬走两大块之后 ui-server 的 import 表里近三分之一已经没人用了。

### 结果

```
ui-server.mjs          6,859 -> 4,338
workspace-routes.mjs           2,498
startUiServer          4,251 -> 2,353
```

四刀合计：**20,609 -> 4,338（-79%）**。

| 文件 | 行数 | 内容 |
|------|------|------|
| `ui-server.mjs` | 4,338 | 鉴权、团队、模型配置、终端、静态文件、flow 目录管理 |
| `workspace-server.mjs` | 6,035 | Workspace 运行时 |
| `prd-workflow-server.mjs` | 4,884 | PRD workflow 实现 |
| `prd-workflow-routes.mjs` | 2,949 | PRD workflow 路由 |
| `workspace-routes.mjs` | 2,498 | Workspace 路由 |
| 三个共享小工具 | 100 | |

`startUiServer` 2,353 行 / 84 条路由，剩下的是真正跨子系统的东西（鉴权、团队、静态文件），
没有明显的下一刀。

## 守住边界

`test/module-boundaries.test.mjs` 七条：

1. 四个拆出去的模块都不 import ui-server（有环的话 ESM 靠函数提升还能跑，但初始化顺序会
   变成运气）
2. 两套路由的路径字面量在 ui-server 里一个都不剩，派发点各只有一处——多一处就说明路由又
   开始往回长
3. **Workspace 派发点必须在鉴权闸门之后**。这条是安全约束不是风格：把它提到闸门前面，
   37 条路由就对未登录请求敞开了。变异测试验证过——真挪过去会被咬住
4. 两个子系统的实现都不再回流到 ui-server
5. 三个子系统模块互不依赖（Workspace 和 PRD 是两个产品）
6. 三个共享小工具全仓库只有一处声明——拆分最容易犯的错是两边各留一份
7. 五个文件都不留没人用的 import

最后一条写的时候本身踩了坑：抹字符串会把模板串
`` `href="${htmlEscapeAttribute(x)}"` `` 里的真调用一起吃掉，误报成死 import。改成不抹字符串
——宁可把「只在字符串里出现的名字」也算用过，这条断言要抓的是「哪儿都没出现」的死 import，
不是精确可达性分析。
