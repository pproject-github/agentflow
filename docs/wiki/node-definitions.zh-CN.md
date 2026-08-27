# 节点定义的单一来源

`builtin/nodes/<definitionId>.md` 是**唯一**的节点定义来源。前端不再硬编码任何节点，
Composer 的节点参考由脚本从这些文件生成。

## 为什么必须收敛

节点定义曾经散在三个地方，谁也不知道哪份是对的：

| 位置 | 当时的状态 |
|------|-----------|
| `builtin/nodes/*.md` | `control_load_skills` 声明了 `mergeMode` / `loadedCount` / `summary`，运行时一个都不读 |
| `WorkspacePage.jsx` | 硬编码 6 个定义，再用 `HIDDEN_WORKSPACE_DEFS` 盖掉 `.md` 版本 |
| `scripts/generate-agentflow-skill-references.mjs` | `localOnly` 集合漏掉了 `control_load_mcp`、`tool_gitlab_create_mr`、全部 `display_*` |

后果不是「文档不一致」这种小事：`workspace_run`、`workspace_scheduled_run`、
`workspace_one_click_task`、`control_load_mcp` 在服务端目录里**根本不存在**，只活在
React bundle 里。`/api/nodes` 只返回 27 个节点，Composer 读到的节点参考里连流程的运行
入口节点都没有——它没法生成一张能跑的图。

## frontmatter 契约

```yaml
---
# 内置节点：Run
runtime: native        # 必填：Workspace 运行时的支持程度
type: control          # 可选：覆盖按 id 前缀的分类推断
palette: hidden        # 可选：不进节点面板
description: ...
displayName: Run
input:
  - type: node
    name: prev
    default: ""
output:
  - type: node
    name: next
    default: ""
---
节点正文（agent 节点的提示词；tool_nodejs 的正文只是文档）
```

### `runtime:` 分级

| 值 | 含义 |
|----|------|
| `native` | `ui-server.mjs` 的运行循环里有专用 handler |
| `degraded` | 没有专用 handler，靠通用 agent 路径 + 输出信封工作，文档承诺的语义只靠约定成立 |
| `none` | 没有实现。定义留着只为让历史图仍能解析出元数据 |

未声明按 `native` 处理，兼容项目里已有的自定义节点 `.md`。

目前唯一的 `degraded` 是 `control_agent_toBool`：它确实会跑，但没有任何东西约束模型
输出的 `prediction`，而 `bin/pipeline/parse-bool.mjs` 只认 `true` / `1` / `yes` / `on`
——回答 `是` 或 `true（因为…）` 会静默变成 false。

### `type:` 与 `palette:`

`type:` 取 `control` / `provide` / `agent`。不写就按 id 前缀推断，所以 `workspace_run`
这类不带前缀的节点必须显式声明，否则会被归到 `agent`。

`palette: hidden` 的节点不出现在节点面板、`/api/nodes` 和 Composer 的节点参考里。
`RETIRED_NODE_IDS` 里的每个 id 都必须带这个标记（有测试强制）。

## 改完之后

节点参考是生成物，改完 `.md` 必须重跑：

```bash
node scripts/generate-agentflow-skill-references.mjs
```

`test/node-definition-single-source.test.mjs` 会重跑生成器比对产物，忘了就红。

## 护栏

`test/node-definition-single-source.test.mjs` 里最关键的一条会扫 `ui-server.mjs` 里所有
`defId === "..."` 分支，比对对应 `.md` 的 `runtime:`：

```
ui-server 里有 tool_nodejs 的 handler，但 builtin/nodes/tool_nodejs.md 写着 runtime: none
```

也就是说**加了 handler 忘改 `.md`，或者删了 handler 忘降级，都会直接失败**，而不是等到
用户拖出一个跑不了的节点才发现。

## 相关

- 代码节点包（`nodes/<name>/index.mjs`）的契约见 `CLAUDE.md` 的
  「Code node packages」一节
- 生成的节点参考：`skills/agentflow-node-reference/references/builtin-nodes.md`
