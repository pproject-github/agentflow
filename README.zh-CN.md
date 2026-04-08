<p align="center">
  <img src="logo-256.png" width="128" alt="AgentFlow Logo" />
</p>

<h1 align="center">AgentFlow</h1>

<p align="center">让 AI Agent 自己干 12 小时，然后悄悄惊艳所有人</p>

<p align="center">
  <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
</p>

<p align="center">
  <b>中文</b> | <a href="./README.md">English</a>
</p>

>
> 把 Cursor / OpenCode / Claude Code 当执行后端，串起来跑，能停，能续。

![AgentFlow Projects](docs/projects.png)

![Pipeline Editor](docs/pipeline.png)

![Running Status](docs/running.png)

## 解决什么问题

Cursor、Claude Code 这些 Coding Agent 很好用——直到任务变长。

**1. 上下文窗口是硬天花板。**
跑 10 分钟的任务没问题，跑 10 小时的大型迁移？模型开始遗忘前面的步骤、重复已做过的工作、或悄悄偏离方向。上下文压缩能续命，但它是有损的——agent 看到的已经不是完整画面。

**2. 流程可靠性随时间衰减。**
你告诉 agent："step 1 结束后让我确认，step 2 完成后跑测试。"前几次没问题。三小时后，确认步骤被上下文压缩吃掉了，agent 就直接跳过了。这和之前[AI 误删用户邮件](https://www.reddit.com/r/ChatGPTPro/comments/1kcra9d/)是同一类问题——不是恶意，只是丢了上下文。

**3. Markdown 清单不是控制流。**
你可以在 prompt 里写编号计划，但你没法表达"循环直到编译通过"或"如果测试失败就回到第 3 步"。真实工作流需要真正的分支和循环——而不是一个扁平列表让模型自由发挥。

**AgentFlow 的做法：把编排逻辑从上下文里拿出来。** 工作流定义为节点图，有明确的边、循环和条件分支。每个节点在独立的 agent 会话中运行，只拿到自己的输入——没有会衰减的上下文。节点之间的状态持久化到磁盘，一个 10 小时的工作流就是一连串专注的 10 分钟任务。

## 核心特性

- **复用现有 agent** — Cursor、OpenCode、Claude Code 可互换，不用迁移平台
- **可视化编辑器 + AI Composer** — 拖拽节点或用自然语言描述工作流
- **状态持久化** — 每个节点的输入输出缓存到磁盘（类似 Gradle task cache），任意节点失败可续跑
- **循环 / 分支 / 并行** — `control_if`、`control_anyOne`、`control_toBool` 实现真正的控制流
- **CI/CD 友好** — 确定性图结构、支持长时间运行、`--machine-readable` JSON 事件流

## 快速开始

**环境要求：** Node >= 18，以及 Cursor CLI (`agent`) / OpenCode CLI / Claude Code 任一

```bash
# 安装
npm install -g agentflow

# 启动 Web UI（端口 8765）
agentflow ui

# 或直接运行流程
agentflow apply <FlowName>
```

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

Composer 会自动识别循环模式，生成正确的控制流节点。复杂流程分三阶段构建：拓扑 → 节点详情 → 连线校验（自动修复最多 5 次）。

## 运行与恢复

```bash
# 执行
agentflow apply <FlowName>

# 查看状态
agentflow run-status <FlowName> <uuid>

# 断点续跑
agentflow resume <FlowName> <uuid>

# 重试单个节点
agentflow replay <FlowName> <uuid> <instanceId>

# 查看 agent 推理过程
agentflow extract-thinking <FlowName> <uuid>
```

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
| `--model <name>` | 覆盖模型 |
| `--parallel` | 并行执行无依赖节点 |
| `--machine-readable` | JSON 事件流（供 UI/CI 集成） |
| `--lang <code>` | 语言（`zh` / `en`） |

### 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CURSOR_AGENT_CMD` | `agent` | Cursor CLI 命令 |
| `CURSOR_AGENT_MODEL` | — | 默认模型 |
| `AGENTFLOW_HOME` | `~/agentflow` | 用户数据目录 |

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

查看 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 许可证

[MIT](LICENSE)
