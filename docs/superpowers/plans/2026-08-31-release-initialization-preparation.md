# 发版初始化前置准备 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with review checkpoints. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 扩展初始化节点，使其在进入后先完成活动发版上下文准备，同时让初始化之后的推荐流程由状态机配置决定，而不是固定指向创建分支。

**Architecture:** 初始化节点保留业务线、平台、版本和批次快照，并增加一个可配置的活动发版准备子步骤。已有活动发版时只读复用；缺少时通过初始化节点收集发布日期并执行创建。初始化完成后状态机从当前 workflow 的第一个未完成流程推荐，因此后续可以是创建分支、多语言或其他流程。

**Tech Stack:** Node.js ESM、React JSX、Node test runner、release-skills Python dispatcher。

**Spec:** `docs/superpowers/specs/2026-08-31-release-workflow-state-machine-design.md`

## Global Constraints

- 初始化只在用户执行初始化节点时触发外部写入，不因打开页面自动创建活动发版。
- 不修改 `release-git` 的活动发版预检契约；创建分支后仍由独立流程登记分支。
- 初始化之后不固定推荐 `create-release-branch`，推荐结果必须来自当前业务线、平台、版本和批次的状态机。
- 不提交 `docs/likee-ai-doc/`、`runs/`、`output/` 或其他生成/个人文件。

### Task 1: 初始化模型与状态机入口

**Files:**
- Modify: `builtin/web-ui/src/lib/releaseWorkflowModel.js`
- Modify: `builtin/web-ui/src/lib/releaseWorkflowStateMachine.js`
- Modify: `builtin/web-ui/src/components/ReleaseWorkflowPanel.jsx`
- Modify: `shared/release-workflow-config.js`
- Test: `test/release-workflow-model.test.mjs`
- Test: `test/release-workflow-state-machine.test.mjs`

- [x] 先补测试：初始化节点声明前置准备输入；初始化完成后推荐 workflow 的首个合法节点；删除 `effectiveInitializationNode.nextNodeIds` 固定 catalog 首节点行为。
- [x] 实现初始化节点的 `publish_date` 输入和 preparation metadata；初始化 pending 时阻断普通推荐，完成后调用已有 `seedNextRecommendations`。
- [x] 在共享 workflow 配置中预留 `entryStageIds`，状态机按配置决定第一个流程，不依赖节点数组顺序。
- [x] 运行模型和状态机测试。

### Task 2: 初始化运行端点与 release-management 适配

**Files:**
- Modify: `bin/lib/release-runtime.mjs`
- Modify: `bin/lib/release-runtime-executor.mjs`
- Modify: `bin/lib/workspace-routes.mjs`
- Modify: `test/release-runtime-api.test.mjs`
- Modify: `test/release-runtime-integration.test.mjs`

- [x] 先补测试：初始化请求在已有活动发版时幂等完成；扩展 action 解析和执行参数映射。
- [x] 增加初始化专用 action 解析，复用 `/api/release/nodes/preview` 和 `/api/release/nodes/run` 的预览/执行与确认机制。
- [x] 扩展 release execution inputs，为 `create-active-release` 填充 `major_version`，同时保留业务线、平台、版本 scope 校验。
- [ ] runtime API 端到端测试待 Node 20 环境复核；当前环境 Node 18 导入既有 workspace-routes 时触发 `Invalid regular expression flags`。

### Task 3: UI 初始化交互与全量验证

**Files:**
- Modify: `builtin/web-ui/src/components/ReleaseWorkflowPanel.jsx`
- Modify: `test/release-workflow-panel-contract.test.mjs`

- [x] 初始化卡片展示发布日期输入、执行/重试和错误信息；初始化执行成功后才显示状态机推荐节点。
- [x] 确认自定义添加阶段仍从 workflow 过滤后的候选集合读取，后续流程可为任意配置 stage。
- [x] 运行 release 单元/集成测试和 JSX 静态转换，不运行 Android Gradle 编译。
- [x] 已检查本次 diff，未将生成产物和敏感未跟踪文件加入修改范围。
