# 发版复合流程 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在发版状态机中加入由多个 release-skill 原子 Action 组成的 AgentFlow 复合节点，并默认推荐复合节点。

**Architecture:** 共享配置增加复合流程定义，前后端通过同一选择器解析复合节点及其内部 Action。后端把复合节点编译为串行 AgentFlow tool graph，运行态在一个 timeline 节点下保存内部步骤；前端状态机和节点详情展示复合节点，同时保留原子节点作为显式补救能力。

**Tech Stack:** Node.js ESM、React/Vite、AgentFlow Workspace graph、现有 release runtime store/API、Node test runner。

**Spec:** `docs/superpowers/specs/2026-08-31-release-composite-workflows-design.md`

## Global Constraints

- 共享配置同时决定状态流转、默认推荐、自定义节点集合和后端执行白名单。
- 复合节点身份统一为 `composite:<id>`；内部 Action 使用 `skill:action`。
- 默认推荐复合节点；原子节点只作为显式自定义补救项。
- 复合节点必须按配置顺序通过 AgentFlow 真实执行，失败/等待支持继续和重试。
- 当前仍处于开发阶段，不新增旧数据迁移或 `workflowVersion`。
- 不执行真实远端发版、GitLab、Google Play 或商店写入。
- 保留工作区已有 dirty 文件和生成文件，不 reset/checkout/clean。

### Task 1: Extend shared composite workflow configuration

**Files:**
- Modify: `shared/release-workflow-config.js`
- Modify: `test/release-workflow-config.test.mjs`

**Interfaces:**
- Produce `compositeWorkflows`, `selectReleaseCompositeWorkflow(context, config)`, `compositeActionIds(composite, context)`, `validateReleaseWorkflowConfig` composite validation.

- [ ] **Step 1: Write failing tests** for composite selection, duplicate internal Action rejection, batch/platform filtering, and default composite references in Android/iOS localization/channel stages.
- [ ] **Step 2: Run focused tests and verify RED.**
- [ ] **Step 3: Add four composite definitions and selectors.** Each definition must reference existing Action IDs only and expose `default: true` where it replaces atomic recommendation.
- [ ] **Step 4: Update stage representation** to allow `compositeIds`/`defaultCompositeIds` while retaining atomic fallback references.
- [ ] **Step 5: Run config tests and commit** `feat(release): define composite workflow configuration`.

### Task 2: Build composite AgentFlow runtime and API catalog

**Files:**
- Modify: `bin/lib/release-runtime.mjs`
- Modify: `bin/lib/release-runtime-executor.mjs`
- Modify: `bin/lib/workspace-routes.mjs`
- Modify: `test/release-runtime-catalog.test.mjs`
- Modify: `test/release-runtime-api.test.mjs`
- Modify: `test/release-runtime-executor.test.mjs`

**Interfaces:**
- Produce `discoverReleaseCompositeActions(context, nodes, config)`, `buildCompositeReleaseRunGraph(composite, atomicNodes, context, inputs)`, and composite-aware preview/run allowlist behavior.

- [ ] **Step 1: Add failing tests** asserting catalog shape, composite allowlist rejection, graph node ordering, input propagation, and composite confirmation fingerprint.
- [ ] **Step 2: Run focused runtime tests and verify RED.**
- [ ] **Step 3: Implement catalog materialization** with `kind`, `compositeId`, `actions`, aggregated input schema, process metadata and context scope.
- [ ] **Step 4: Implement graph compilation** into serial `tool_nodejs` nodes with explicit edges and internal step metadata; no raw user input embedded in generated source.
- [ ] **Step 5: Wire preview/run routes** to resolve composite actions, validate every internal Action against current workflow, and return 409 for invalid composite membership.
- [ ] **Step 6: Run runtime tests and commit** `feat(release): execute composite release workflows through AgentFlow`.

### Task 3: Align state machine, persistence and UI inspector

**Files:**
- Modify: `builtin/web-ui/src/lib/releaseWorkflowStateMachine.js`
- Modify: `builtin/web-ui/src/lib/releaseWorkflowModel.js`
- Modify: `builtin/web-ui/src/components/ReleaseWorkflowPanel.jsx`
- Modify: `builtin/web-ui/src/components/ReleaseNodeInspector.jsx`
- Modify: `bin/lib/release-runtime-store.mjs`
- Modify: `test/release-workflow-state-machine.test.mjs`
- Modify: `test/release-workflow-model.test.mjs`
- Modify: `test/release-workflow-panel-contract.test.mjs`
- Modify: `test/release-runtime-integration.test.mjs`

**Interfaces:**
- Composite records use `nodeId: composite:<id>`, `kind: "composite"`, `details.steps[]`, and preserve workflow/scope metadata.

- [ ] **Step 1: Add failing tests** for default composite recommendations, atomic fallback candidates, composite persistence, completed read-only inspector and failed retry display.
- [ ] **Step 2: Run focused UI/model tests and verify RED.**
- [ ] **Step 3: Update machine/model** to collapse configured default atomic sequences into composite nodes while leaving non-default atomic nodes selectable.
- [ ] **Step 4: Update panel execution state** to send composite IDs, hydrate internal steps, merge partial failures, and resume from the failed step.
- [ ] **Step 5: Update inspector UI contract** to render internal step timeline and editable aggregate inputs only for pending/failed composites.
- [ ] **Step 6: Run UI/model/integration tests and JSX transform; commit** `feat(release): surface composite workflow nodes in timeline`.

### Task 4: Verification and final review

**Files:**
- Test only: release workflow/runtime test suites.
- Docs: update task reports and SDD ledger.

- [ ] **Step 1: Run all release tests** with `node --test test/release-*.test.mjs`.
- [ ] **Step 2: Run `npm run build:web-ui`.**
- [ ] **Step 3: Run `git diff --check`.**
- [ ] **Step 4: Verify action ID parity** between shared composite config, backend catalog, AgentFlow graph and frontend picker.
- [ ] **Step 5: Dispatch whole-branch review** and address only load-bearing findings with one scoped fix round.
- [ ] **Step 6: Record final verification and keep branch as-is unless the user explicitly requests merge/push.**
