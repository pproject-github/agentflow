# 发版流程与节点状态机 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with verification checkpoints.

**Goal:** 在前端维护由 release-skills Profile/Action 生成的业务平台发版流程状态机，以流程为推荐单位、以 Action 为执行节点，并根据已执行 timeline 推导当前流程和下一推荐。

**Architecture:** 新增纯函数状态机模块，将流程定义、节点归属、状态推导和推荐策略集中维护。ReleaseWorkflowPanel 只负责加载状态、执行节点和渲染；其 timeline/pending 继续作为持久化兼容格式，并通过 processId 映射到流程状态。动态 release catalog 负责提供 Profile 过滤后的 Action 节点及流程元数据，静态 catalog 保留兼容兜底。

**Tech Stack:** Node.js ESM、React 18、Node test runner、js-yaml。

**Spec:** `docs/superpowers/specs/2026-08-31-release-workflow-state-machine-design.md`

## Global Constraints

- 推荐单位是流程/阶段，不是任意跨流程的单个 Action。
- 流程内 Action 必须按顺序完成；未完成流程不能推荐下一流程。
- 只允许当前 businessLine、platform、version、batch 和 Profile 范围内节点。
- 保留旧 timeline/pending 数据兼容；无法映射的历史节点只展示，不参与新推荐。
- 不运行 Android Gradle 编译任务；使用 Node 测试和 Web UI 静态语法检查。
- 不清理或回滚工作区中已有的无关改动和生成文件。

### Task 1: 定义流程状态机纯函数接口

**Files:**
- Create: `builtin/web-ui/src/lib/releaseWorkflowStateMachine.js`
- Test: `test/release-workflow-state-machine.test.mjs`

**Interfaces:**
- `createReleaseProcessStateMachine({ nodes, context }) -> { processes, nodeToProcess, context }`
- `deriveProcessStates({ machine, timeline, pending }) -> Map<processId, state>`
- `recommendNextProcessNodes({ machine, timeline, pending }) -> node[]`
- `processIdForNode(node) -> string`

- [ ] **Step 1: Write failing tests**

  Cover:
  - Likee Android process definitions group multiple Action nodes into one process.
  - An incomplete process recommends only its next ordered node.
  - A completed process recommends the first node of the next process.
  - Failed/running nodes keep the process active and do not advance.
  - Nodes outside the current context are excluded.
  - No legal next process produces an empty recommendation.

- [ ] **Step 2: Run tests and verify expected failure**

  Run:

  ```bash
  npx -y node@20 --test test/release-workflow-state-machine.test.mjs
  ```

  Expected: failure because the state-machine module and exported functions do not exist.

- [ ] **Step 3: Implement the minimal state-machine module**

  - Define process metadata for the release flow (`preparation`, `localization`, `approval`, `metrics`, `records`, `notification`, plus platform-specific branches).
  - Resolve Action membership using explicit node `processId`/`processOrder` first, then Skill/Action fallback mappings.
  - Build ordered node lists per process and process transition edges from the filtered node catalog.
  - Calculate process state from completed/running/failed/pending node records.
  - Recommend only the next incomplete node in the active process; after process completion, recommend the first node in the next legal process.

- [ ] **Step 4: Run state-machine tests**

  ```bash
  npx -y node@20 --test test/release-workflow-state-machine.test.mjs
  ```

  Expected: PASS.

### Task 2: Add process metadata to dynamic and static catalogs

**Files:**
- Modify: `bin/lib/release-runtime.mjs`
- Modify: `builtin/web-ui/src/lib/releaseNodeCatalog.js`
- Modify: `test/release-runtime-catalog.test.mjs`
- Modify: `test/release-workflow-state-machine.test.mjs`

**Interfaces:**
- Every discovered/static node exposes `processId` and `processOrder` where the process mapping is known.
- Existing `scopeKey`, `contextSnapshot`, Profile filtering, and `nextNodeIds` remain available for compatibility.

- [ ] **Step 1: Add failing catalog assertions**

  Assert that selected Likee Android Actions contain the expected process metadata and that an unreferenced extension Action has no eligible process membership.

- [ ] **Step 2: Run the focused catalog tests**

  ```bash
  npx -y node@20 --test test/release-runtime-catalog.test.mjs test/release-workflow-state-machine.test.mjs
  ```

  Expected: metadata assertions fail.

- [ ] **Step 3: Implement metadata enrichment**

  Add a single mapping table in the runtime catalog loader and mirror the same mapping in the static fallback catalog. Preserve explicit metadata supplied by future Skill definitions, then use the fallback mapping only when absent.

- [ ] **Step 4: Run focused tests**

  ```bash
  npx -y node@20 --test test/release-runtime-catalog.test.mjs test/release-workflow-state-machine.test.mjs
  ```

  Expected: PASS.

### Task 3: Integrate state-machine recommendation into ReleaseWorkflowPanel

**Files:**
- Modify: `builtin/web-ui/src/components/ReleaseWorkflowPanel.jsx`
- Modify: `builtin/web-ui/src/lib/releaseWorkflowModel.js`
- Modify: `test/release-workflow-model.test.mjs`
- Modify: `test/release-runtime-integration.test.mjs`

**Interfaces:**
- `ReleaseWorkflowPanel` calls `recommendNextProcessNodes()` after initialization, API hydration, catalog refresh, and successful node completion.
- Pending entries retain `processId` and `processOrder` for rendering, persistence, and legacy migration.

- [ ] **Step 1: Add failing integration/model assertions**

  Cover initialization → first process node, process-internal continuation, process completion → next process, and failed/aborted node not advancing the process.

- [ ] **Step 2: Run focused tests**

  ```bash
  npx -y node@20 --test test/release-workflow-model.test.mjs test/release-runtime-integration.test.mjs
  ```

  Expected: failures because the panel still uses direct `nextNodeIds` recommendation.

- [ ] **Step 3: Replace direct recommendation calls**

  - Keep `nextNodeIds` as catalog compatibility data but route recommendation decisions through the state-machine module.
  - Store `processId`/`processOrder` on generated pending and completed records.
  - On completion, recompute process states from the updated timeline/pending state and append only state-machine recommendations.
  - Preserve custom node behavior while requiring its source preset to belong to the current context.

- [ ] **Step 4: Run focused tests and JSX static check**

  ```bash
  npx -y node@20 --test test/release-workflow-model.test.mjs test/release-runtime-integration.test.mjs
  node_modules/.bin/esbuild builtin/web-ui/src/components/ReleaseWorkflowPanel.jsx --loader:.jsx=jsx --outfile=/tmp/ReleaseWorkflowPanel.js
  ```

  Expected: PASS and successful JSX transform.

### Task 4: Persist and validate process metadata without breaking old state

**Files:**
- Modify: `bin/lib/release-runtime-store.mjs`
- Modify: `bin/lib/workspace-routes.mjs`
- Modify: `test/release-runtime-api.test.mjs`

**Interfaces:**
- API state keeps existing `timeline`/`pending` shape and accepts optional `processId`/`processOrder` fields.
- Existing clients without `scopeKey` remain compatible; supplied scope and process metadata are validated.

- [ ] **Step 1: Add failing API/state assertions**

  Assert process metadata survives state round-trip and an execution request cannot submit a node from another process/context.

- [ ] **Step 2: Run API tests**

  ```bash
  npx -y node@20 --test test/release-runtime-api.test.mjs
  ```

  Expected: new assertions fail.

- [ ] **Step 3: Implement minimal persistence/validation**

  - Preserve process metadata during initialization normalization and state writes.
  - Keep backend scope validation already added.
  - Reject a supplied process ID that does not match the discovered Action’s process metadata.

- [ ] **Step 4: Run API tests**

  ```bash
  npx -y node@20 --test test/release-runtime-api.test.mjs
  ```

  Expected: PASS.

### Task 5: Full verification and cleanup review

**Files:**
- Test only: existing release workflow tests.

- [ ] **Step 1: Run all related tests**

  ```bash
  npx -y node@20 --test \
    test/release-workflow-state-machine.test.mjs \
    test/release-workflow-model.test.mjs \
    test/release-runtime-catalog.test.mjs \
    test/release-runtime-api.test.mjs \
    test/release-runtime-integration.test.mjs \
    test/release-runtime-executor.test.mjs
  ```

- [ ] **Step 2: Run static checks**

  ```bash
  git diff --check
  node_modules/.bin/esbuild builtin/web-ui/src/components/ReleaseWorkflowPanel.jsx --loader:.jsx=jsx --outfile=/tmp/ReleaseWorkflowPanel.js
  ```

- [ ] **Step 3: Review the diff**

  Verify no generated dist files, diagnostics, docs checkouts, or unrelated pre-existing changes are staged or modified by this implementation.
