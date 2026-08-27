<p align="center">
  <img src="logo-256.png" width="128" alt="AgentFlow Logo" />
</p>

<h1 align="center">AgentFlow</h1>

<p align="center">让 AI Agent 自己干 12 小时，然后悄悄惊艳所有人</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
  <a href="https://agentflow-hub.com"><img src="https://img.shields.io/badge/Hub-浏览工作流-8252ec" alt="AgentFlow Hub" /></a>
</p>

<p align="center">
  <b>中文</b> | <a href="./README.md">English</a>
</p>

>
> 编排复杂、长时间运行的任务——模块迁移、AI 自动化、代码深度清理——以 Cursor / OpenCode / Claude Code / Codex 为可切换后端。

![AgentFlow Projects](docs/projects.png)

![Pipeline Editor](docs/pipeline.png)

![Running Status](docs/running.png)

### 术语边界

本仓库中的可执行节点图称为 **Flow**（编辑器中也显示为流水线），以
`flow.yaml` 保存。产品需求 **Workflow** 是另一套由 TAPD 驱动、使用
`tapd:<id>` 标识的需求实体；它不由 Flow 编辑器创建、归档或修改。

## 解决什么问题

Cursor、Claude Code、Codex 这些 Coding Agent 很好用——直到任务变长。

**1. 上下文窗口是硬天花板。**
跑 10 分钟的任务没问题，跑 10 小时的大型迁移？模型开始遗忘前面的步骤、重复已做过的工作、或悄悄偏离方向。上下文压缩能续命，但它是有损的——agent 看到的已经不是完整画面。

**2. 流程可靠性随时间衰减。**
你告诉 agent："step 1 结束后让我确认，step 2 完成后跑测试。"前几次没问题。三小时后，确认步骤被上下文压缩吃掉了，agent 就直接跳过了。这和之前[AI 误删用户邮件](https://www.reddit.com/r/ChatGPTPro/comments/1kcra9d/)是同一类问题——不是恶意，只是丢了上下文。

**3. Markdown 清单不是控制流。**
你可以在 prompt 里写编号计划，但你没法表达"循环直到编译通过"或"如果测试失败就回到第 3 步"。真实工作流需要真正的分支和循环——而不是一个扁平列表让模型自由发挥。

**AgentFlow 的做法：把编排逻辑从上下文里拿出来。** 工作流定义为节点图，有明确的边、循环和条件分支。每个节点在独立的 agent 会话中运行，只拿到自己的输入——没有会衰减的上下文。节点之间的状态持久化到磁盘，一个 10 小时的工作流就是一连串专注的 10 分钟任务。

## 核心特性

- **复用你的 AI 订阅** — Cursor Pro、OpenCode（阿里云等）、Claude Code、Codex；无需购买 LLM API key
- **可视化编辑器 + AI Composer** — 拖拽节点或用自然语言描述工作流
- **状态持久化** — 每个节点的输入输出缓存到磁盘（类似 Gradle task cache），任意节点失败可续跑
- **循环 / 分支 / 并行** — `control_if`、`control_anyOne`、`control_toBool` 实现真正的控制流
- **CI/CD 友好** — 确定性图结构、支持长时间运行、`--machine-readable` JSON 事件流

## 快速开始

**环境要求：** Node >= 18，以及 Cursor CLI (`agent`) / OpenCode CLI / Claude Code / Codex CLI 任一

```bash
# 安装
npm install -g @fieldwangai/agentflow

# 启动 Web UI（端口 8765）
agentflow ui

```

运行从 Web UI 的 Workspace 图发起；需要定时执行时在图里加 `workspace_scheduled_run` 节点。

从源码开发：`git clone` → `npm install` → `npm link`

## 创建流程

### 方式一：可视化编辑器

Web UI 中 — 新建流水线 → 从面板拖节点到画布 → 连线 → 保存。

### 方式二：AI Composer（推荐）

打开右侧 Composer 面板，用自然语言描述需求：

```
创建一个代码检查流程：
1. 扫描代码库找出问题
2. 自动修复
3. 重新检查
4. 没通过就继续修，直到全过
```

复杂流程分三阶段构建：拓扑 → 节点详情 → 连线校验（自动修复最多 5 次）。注意 Workspace 运行时执行的是 DAG，有环的图会被拒绝，所以「检查—修复—复检」要描述成向前推进的步骤，而不是回环。

## 运行

运行从 Workspace 图发起：在 Web UI 打开流程点 **Run**，或在图里加 `workspace_scheduled_run`
节点做定时执行。每个节点的输入、输出与状态都会持久化到该流程的 run 目录。

旧版 Start/End Pipeline 运行时已下线 —— `agentflow apply` / `resume` / `replay` 与
`/api/flow/run*` 接口不再执行任何流程。

```bash
# 查看某次运行的节点状态
agentflow run-status <FlowName> <uuid>

# 查看 agent 推理过程
agentflow extract-thinking <FlowName> <uuid>

# 校验流程定义
agentflow validate <FlowName>
```

## 技能

AgentFlow 提供专用技能用于常见操作：

| 技能 | 说明 |
|------|------|
| `agentflow-author-flow` | 在 Codex/Cursor 中根据自然语言生成 Flow，自动校验并打开静态预览；确认后发布到个人、Workspace 或团队 |
| `agentflow-cli` | 通过 token 直接查询、发布和运行平台 Flow，无需 MCP |
| `agentflow-flow-add-instances` | 向 flow.yaml 添加新节点，包括正确的 YAML 结构、连线设计和位置定位 |
| `agentflow-flow-edit-node-fields` | 编辑已有节点的允许字段（label、body、role、input/output 值）而不破坏拓扑 |
| `agentflow-flow-sync-ui` | 保存 flow.yaml 到磁盘后同步变更到 Web UI 画布 |
| `nestjs-route-order-debug` | 调试 NestJS 路由冲突（参数路由 `:id` 与具体路由之间） |

技能在检测到相关任务时自动加载，提供领域特定的指令和工作流。

例如直接对 Codex/Cursor 说：“用 `agentflow-author-flow` 生成一个 Jenkins 构建完成后通知企业微信的 Flow，先打开本地预览，我确认后发布到团队。” Agent 会处理本地文件、校验、预览和发布命令；用户只负责确认效果。

## 教程

- [快速上手：PR 流程自动化](docs/wiki/quickstart-pr-workflow.zh-CN.md)
- [模块迁移工作流](docs/wiki/module-migration-workflow.zh-CN.md)
- [Figma UI 还原工作流](docs/wiki/figma-ui-implementation-workflow.zh-CN.md)

## CLI 参考

| 命令 | 说明 |
|------|------|
| `list` | 列出所有流水线 |
| `ui` | 启动 Web UI |
| `apply` | 执行流程 |
| `validate` | 校验流程结构 |
| `resume` | 断点续跑 |
| `replay` | 重试单个节点 |
| `run-status` | 查看执行状态 |
| `extract-thinking` | 提取 agent 思考过程 |

### 选项

| 参数 | 说明 |
|------|------|
| `--workspace-root <path>` | 工作区根目录 |
| `--dry-run` | 只预览就绪节点，不执行 |
| `--model <name>` | 覆盖模型。可用 `opencode:<model>`、`claude-code:<model>`、`codex:<model>`、`api:<provider>/<model>` 前缀切换后端 |
| `--parallel` | 并行执行无依赖节点 |
| `--machine-readable` | JSON 事件流（供 UI/CI 集成） |
| `--lang <code>` | 语言（`zh` / `en`） |

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CURSOR_AGENT_CMD` | `agent` | Cursor CLI 命令 |
| `CURSOR_AGENT_MODEL` | — | 默认模型 |
| `OPENCODE_CMD` | `opencode` | OpenCode CLI 命令 |
| `CLAUDE_CODE_CMD` | `claude` | Claude Code CLI 命令 |
| `AGENTFLOW_CLAUDE_CODE_BYPASS_PERMISSIONS` | `1` | 向 Claude Code 传递 `--dangerously-skip-permissions`；设置 `0` 走交互式审批 |
| `AGENTFLOW_CLAUDE_CODE_STDERR_INHERIT` | `0` | Claude Code stderr 直接转发到终端用于调试 |
| `CODEX_CMD` | `codex` | Codex CLI 命令 |
| `CODEX_MODEL` | — | 未显式设置 `codex:<model>` 时使用的 Codex 默认模型 |
| `AGENTFLOW_CODEX_SANDBOX` | `workspace-write` | 传给 `codex exec` 的 sandbox 模式 |
| `AGENTFLOW_CODEX_APPROVAL` | `never` | 传给 Codex 的审批策略，位于 `exec` 前 |
| `AGENTFLOW_CODEX_DANGER` | `0` | 设置 `1` 时向 Codex 传递 `--dangerously-bypass-approvals-and-sandbox` |
| `AGENTFLOW_CODEX_SKIP_GIT_CHECK` | `auto` | 执行目录没有 `.git` 祖先时自动跳过 Codex git 检查；可设 `1`/`0` 强制 |
| `AGENTFLOW_CODEX_IGNORE_USER_CONFIG` | `1` | 使用 `--ignore-user-config` 启动 Codex，让 AgentFlow 任务只使用 AgentFlow 显式传入的 MCP/config；设 `0` 可同时加载用户 Codex 配置 |
| `AGENTFLOW_CODEX_STDERR_INHERIT` | `0` | Codex stderr 直接转发到终端用于调试 |
| `AGENTFLOW_HOME` | `~/agentflow` | 用户数据目录 |
| `AGENTFLOW_CAS_ENABLED` | `0` | 为普通 Web UI 用户启用 CAS；管理员继续使用 `/admin/login` |
| `AGENTFLOW_CAS_BASE_URL` | `https://auth.bigo.sg/cas/` | CAS 服务根地址 |
| `AGENTFLOW_CAS_SERVICE_URL` | 从 `AGENTFLOW_PUBLIC_BASE_URL` 推导 | CAS 回调 service 完整地址，通常为 `https://host/api/auth/cas/callback` |
| `AGENTFLOW_LEGACY_PASSWORD_LOGIN` | 启用 CAS 时为 `0` | 迁移期临时保留普通用户旧密码 API |
| `AGENTFLOW_PUBLIC_BASE_URL` | 请求 Origin | 反向代理后用于生成 CAS 回调地址的 Web UI 公网 Origin |

启用 CAS 后，普通用户首次 CAS 登录时自动创建，并直接采用 CAS 申请中的授权范围，不受 AgentFlow 本地用户白名单限制。CAS 用户可在“设置 → 同步旧账号”中用旧密码证明归属，自助迁移原 Project、协作关系和定时任务；旧账号随后停用，历史运行审计仍保留原执行人。管理员继续持有本地密码并从 `/admin/login` 登录，也可在“管理 → 用户与归属”中人工迁移单个 Project。

### Codex 后端

使用 `--model codex:<model>`，或在 Web UI 中选择 Codex 模型，即可让 Composer 或 agent 节点通过 `codex exec` 执行。需先执行 `codex login`，再用 `agentflow update-model-lists` 刷新模型列表，UI 才能展示 Codex 模型。

Composer 会复用 AgentFlow MCP 页面管理的 MCP server：运行 Codex 时把 Cursor MCP 配置翻译成 Codex `-c mcp_servers...` 临时覆盖参数。Stdio MCP 的私密 env 会通过 Codex 子进程环境变量传入；HTTP `Authorization: Bearer ...` header 会转换为 `bearer_token_env_var`。

MCP 页面会为每个 server 展示后端兼容矩阵。若某个 server 依赖 Codex 无法等价表达的能力，例如任意 HTTP headers 或 URL 级 env，Codex 会标记为 partial 并展示原因。

## 目录结构

```
~/agentflow/                          # 用户数据（流水线、agent、配置）
<workspace>/.workspace/agentflow/
  ├── pipelines/<flowId>/             # 项目内流水线副本
  ├── nodes/                          # 自定义节点定义
  └── runBuild/<flowId>/<uuid>/       # 运行产物 & 节点状态
```

## 国际化

- CLI：`--lang` 参数或 `LANG` 环境变量
- Web UI：自动检测浏览器语言
- Agent 提示词：`agents/<lang>/` 目录

支持：`zh`（中文）、`en`（English）

## 贡献

查看 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)。

## 许可证

[MIT](LICENSE)
