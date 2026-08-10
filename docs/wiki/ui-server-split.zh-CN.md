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

`startUiServer` 仍是 7,010 行 142 条路由——那是下一刀的事，这次只搬子系统实现。

## 守住边界

`test/module-boundaries.test.mjs` 四条：

1. PRD 模块不 import ui-server（有环的话 ESM 靠函数提升还能跑，但初始化顺序会变成运气）
2. ui-server 里不再声明 `prd*` / `workflow*` 顶层符号
3. 三个共享小工具全仓库只有一处声明——拆分最容易犯的错是两边各留一份
4. 两个文件都不留没人用的 import

第 4 条写的时候本身踩了坑：抹字符串会把模板串
`` `href="${htmlEscapeAttribute(x)}"` `` 里的真调用一起吃掉，误报成死 import。改成不抹字符串
——宁可把「只在字符串里出现的名字」也算用过，这条断言要抓的是「哪儿都没出现」的死 import，
不是精确可达性分析。
