# AgentFlow

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![中文](https://img.shields.io/badge/lang-中文-red.svg)](./README.zh-CN.md)
[![English](https://img.shields.io/badge/lang-English-blue.svg)](./README.md)

> **长时间复杂任务的 agent 编排系统。**  
> AgentFlow 用图描述依赖与控制流，把 Cursor、OpenCode、Claude Code（适配中）等 Coding Agent 当作**可替换的执行后端**。它已在**大型工程**里扛过长周期、多阶段任务——不是演示脚本，而是能跑完、能停、能续的运行时。

## 缘起：从痛点到解决方案

### 那个让我崩溃的迁移任务

作为一个天天用 Cursor、OpenCode 的开发者，我习惯了这样的工作模式：小改动直接让它改，稍大一点的任务用 plan 模式规划一下，大部分时候都能搞定。直到有一天，我需要把主模块的代码迁移到子模块——这个看似简单的需求，让我意识到现有工具的边界。

迁移、编译、树型依赖、发现新依赖、再迁移、再编译……这是一个循环往复的过程。Cursor 或 OpenCode 能帮我在单个环节上做得很好，比如"把这个文件移过去"、"编译一下看看报错"。但整个流程像是一场无休止的接力赛：AI 跑一段，我发现问题，人工介入调整，AI 再跑一段，我又发现问题……**人工依然承担了大量协调和决策工作，效率提升很有限。**

我需要的不是一个更聪明的 AI 助手，而是一个能**把这些环节串联起来、自动循环执行、出了问题知道在哪停在哪续**的系统。于是 AgentFlow 诞生了。

### AgentFlow 的设计理念

AgentFlow 不是要取代 Cursor 或 OpenCode，而是**站在它们的肩膀上**：

**复用而非重建**：公司可能只买了 Cursor 的订阅，我已经积累了很多 skills 和 prompt。AgentFlow 直接调用现有 Coding Agent 作为执行后端，不需要迁移到新的 AI 平台，已有的能力可以直接编排复用。

**编排而非对话**：像 ComfyUI 那样用节点和连线描述工作流。流程一旦定义，就可以反复执行，不再是"每次对话都是新的开始"。核心是 **coding 流程**而非 AI 对话，因此没有上下文长度限制，可以无限跑下去。

**持久化而非易失**：每个节点的输入输出、执行状态都记录在中间文件中，参考 Gradle task 的 cache 系统。支持断点续跑——昨晚跑到一半的任务，今天可以从失败的地方继续，而不是从头开始。

**CI 友好**：长时间运行、流程固定、可恢复，这些特性让 AgentFlow 特别适合集成到 CI/CD 中。不是"人工监控 AI 执行"，而是"AI 流程自动跑，出问题再人工介入"。

## 核心特性

- **基于现有 Agent**：支持 Cursor、OpenCode 等 Coding Agent，复用已有 skills 和 prompt，无需迁移到新平台
- **节点编排系统**：可视化拖拽编排，流程固定化、可复用，像搭积木一样组合复杂工作流
- **无限上下文运行**：基于中间文件和 cache 系统持久化状态，突破对话式 AI 的上下文限制，支持小时级乃至更长任务
- **断点续跑**：每个节点状态落盘，失败后可精准定位问题节点，单点重试或整体恢复，不必从零开始
- **CI/CD 就绪**：流程固定、执行可重复、支持长时间运行，天然适合持续集成场景

## 常见场景

**1. 大项目重构 / 迁移**  
把「动一下就可能炸」的巨石变更，拆成可审计的链路与检查点：扫描 → 方案 → 分批改造 → 校验，任一步失败都有明确现场与回滚叙事。

**2. 项目代码深度清理**  
在规模面前，手工清单会崩。用循环与批处理节点驱动清理与规范化，让技术债偿还变成**可度量、可暂停、可续跑**的工程过程。

**3. AI Test 持续自动跑**  
把测试与回归从「偶尔跑一次」变成**可持续燃烧**的闭环：定时或循环触发、节点级报告与失败定位，让质量飞轮在后台自己转。

## 实战案例

详细教程见 Wiki 文档：

**1. [模块迁移工作流](docs/wiki/module-migration-workflow.md)**  
将主模块代码迁移到子模块：扫描 → 分析依赖 → 迁移 → 编译验证 → 循环修复。演示如何用 `control_anyOne` + `control_if` 实现"检查-修复-检查"循环模式，支持断点续跑和单节点重试。

**2. [Figma UI 还原工作流](docs/wiki/figma-ui-implementation-workflow.md)**  
一次性还原复杂 Figma 设计稿：解析设计稿 → 拆分组件 → 生成代码 → 截图对比 → 循环优化。演示如何分阶段生成代码、自动化 UI 验证、持续迭代直到还原准确度达标。

## 使用说明

以下为最短路径：从安装到第一条流水线、再到验证、运行与排障续跑。

### 1. 安装

环境要求：Node >= 18，已安装 Cursor CLI（`agent` 命令可用）

```bash
# 从 npm 全局安装（发布后即可，无需克隆仓库）
npm install -g agentflow

# 验证安装
agentflow --help
```

从源码参与开发时：`git clone` 仓库后在该目录执行 `npm install` 与 `npm link`。

### 2. 新建流程

```bash
# 查看内置流水线
agentflow list

# 启动 Web UI（默认端口 8765）
agentflow ui
```

#### 方式一：可视化编排（适合入门）

在 Web UI 中：
1. 点击新建流水线，选择空白模板或复制现有模板
2. 从左侧节点面板拖拽节点到画布
3. 连接节点边，配置节点参数
4. 保存得到 `flow.yaml`

#### 方式二：AI 编排模式（推荐用于复杂流程）

在 Web UI 右侧 Composer 输入框中，直接用自然语言描述需求，AI 自动生成流程：

**示例 1：简单线性流程**
```
创建一个流程：读取用户需求文档，生成代码实现，最后运行测试验证
```

**示例 2：带循环校验的流程**
```
新建一个代码检查流程：
1. 扫描代码库找出问题
2. 自动修复问题
3. 重新检查是否通过
4. 如果未通过则继续修复，直到全部通过为止
```
AI 会自动识别"检查-修复-循环"模式，生成包含 `control_anyOne` + `control_toBool` + `control_if` 的环路结构。

**示例 3：todolist 批量处理流程**
```
创建一个大文件拆解流程：
1. 将大文件拆解为 todolist
2. 逐个处理 todolist 中的子任务
3. 每完成一项打勾标记
4. 直到所有任务完成
```
AI 会采用 todolist 模式：拆解节点 → 循环逐项执行 → 判断是否全部完成。

**Composer 工作原理**：
- **分阶段生成**：复杂流程自动拆解为三阶段
  - 流转规划：建立整体框架、节点类型、主链拓扑
  - 节点补充：完善每个节点的具体内容（body、script 等）
  - 流程完善：补全连线、优化布局、校验修复
- **智能识别循环**：检测到"检查"、"验证"、"批量"等关键词时自动生成环路
- **自动验证修复**：生成后自动校验 flow.yaml，最多尝试 5 次修复错误

### 3. 新建 Loop 及验证

对需要循环/分支的复杂流程：

```bash
# 校验流程结构是否正确
agentflow validate <FlowName>
```

常用控制节点（在 UI 中添加）：
- `control_if` — 条件分支
- `control_toBool` — 转换为布尔值供 If 使用
- `control_anyOne` — 多路任一完成即继续

### 4. 运行

```bash
# 应用（apply）流程
agentflow apply <FlowName>

# 查看运行状态
agentflow run-status <FlowName> <uuid>
```

流程会按节点依赖顺序自动执行，每个 Agent 节点调用 Cursor CLI 流式输出。

### 5. 问题查询及断点续跑

```bash
# 查看运行日志
cat .workspace/agentflow/runBuild/<FlowName>/<uuid>/logs/log.txt

# 提取思考过程
agentflow extract-thinking <FlowName> <uuid>

# 从断点继续（pending 或 failed 节点被标记为已确认后继续）
agentflow resume <FlowName> <uuid>

# 单独重试某个节点
agentflow replay <FlowName> <uuid> <instanceId>
```

---

## 快速参考

### 命令子命令

| 命令 | 说明 |
|------|------|
| `list` | 列出所有流水线 |
| `ui` | 启动 Web UI 编排工具 |
| `apply` | 执行流程 |
| `validate` | 校验流程结构 |
| `resume` | 从断点继续执行 |
| `replay` | 单独重试某个节点 |
| `run-status` | 查看节点执行状态 |
| `extract-thinking` | 提取并整理 Agent 思考过程 |

### 常用选项

- `--workspace-root <path>` — 工作区根目录
- `--dry-run` — 预览就绪节点，不执行
- `--model <name>` — 指定 Cursor 模型
- `--parallel` — 并行执行同轮节点
- `--machine-readable` — JSON 事件流输出（供 UI 集成）
- `--lang <code>` — 设置语言

### 环境变量

- `CURSOR_AGENT_CMD` — Cursor CLI 命令（默认 `agent`）
- `CURSOR_AGENT_MODEL` — 默认模型
- `AGENTFLOW_HOME` — 覆盖用户数据目录（默认 `~/agentflow`；runBuild 已改为工作区本地目录）

## 用户数据目录

- 默认用户数据目录：**`~/agentflow/`** (`pipelines/`、`agents/`、`model-lists.json` 等)
- 运行构建目录（主路径）：**`<workspaceRoot>/.workspace/agentflow/runBuild/<flowId>/<uuid>/`**
- 旧版 runBuild 兼容读取路径：**`~/agentflow/runBuild/`**
- 项目内流水线副本：**`<workspaceRoot>/.workspace/agentflow/pipelines/<flowId>/`**
- 项目内自定义节点：**`<workspaceRoot>/.workspace/agentflow/nodes/`**

## 流程定义

查看 [reference/flow-control-capabilities.md](reference/flow-control-capabilities.md) 了解控制节点与典型连线模式。

## 国际化 (i18n)

AgentFlow 在三个层面支持多语言：

1. **CLI 语言**：`--lang` 参数或 `LANG` 环境变量
2. **Web UI 语言**：自动检测浏览器语言
3. **Agent 定义**：`agents/<lang>/` 目录下的多语言提示词

支持语言：`zh` (中文), `en` (English)

## 贡献

查看 [CONTRIBUTING.md](CONTRIBUTING.md) 获取详情。

## 许可证

[MIT](LICENSE)
