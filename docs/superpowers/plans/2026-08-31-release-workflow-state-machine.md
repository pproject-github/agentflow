# 配置驱动发版状态机 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or superpowers:subagent-driven-development) to implement this plan task-by-task with review checkpoints. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将发版状态机的流程顺序、业务线/平台/批次差异和可执行节点集合抽离到一份共享配置中，让前端推荐、自定义阶段候选、后端执行校验和流程状态推导使用同一份定义。

**Architecture:** 新增纯数据模块 `shared/release-workflow-config.js`，集中保存 workflow、stage、Action 引用、可选节点和兼容排序映射，并导出选择、校验和节点白名单函数。前端 `releaseWorkflowStateMachine.js` 与后端 `release-runtime.mjs` 共同读取该模块；release-skill catalog 仍提供脚本、输入 schema 和确认事实，只有“动态 catalog ∩ 当前 workflow 配置”才可推荐、自定义添加或执行。

**Tech Stack:** Node.js ESM、React 18、Vite、Node test runner、纯 JavaScript 配置对象。

**Spec:** `docs/superpowers/specs/2026-08-31-release-workflow-state-machine-design.md`

## Global Constraints

- 状态机配置同时决定流程流转和当前业务线、平台、批次的可执行节点集合。
- 前端与后端必须读取同一份配置；不得复制两套 workflow/stage 定义。
- release-skill catalog 只提供 Action 的执行事实；运行节点必须同时满足 catalog 和 workflow 配置白名单。
- 同一 Action 可以在不同 workflow 或 stage 出现，但同一 workflow 内不得重复。
- 保留 Likee Android 首包/补包和 Likee iOS 首包/补包现有行为；不恢复 `Configure Target`、`Guide Current Release` 或 `Create Active Release`。
- 当前仍处于开发阶段，本次不新增旧 timeline/pending 迁移、workflowVersion 或历史数据兼容分支；已有读取逻辑可保留但不作为验收重点。
- 不删除或回滚工作区已有的无关改动、生成文件和历史记录；不执行真实远端发版操作。

### Task 1: 创建共享 workflow 配置与校验器

**Files:**
- Create: `shared/release-workflow-config.js`
- Create: `test/release-workflow-config.test.mjs`

**Interfaces:**
- `RELEASE_WORKFLOW_CONFIG`：包含 `workflows`、`processOrder`、`processTitles`、`skillProcessMap`、`actionOrder`。
- `selectReleaseWorkflow(context, config = RELEASE_WORKFLOW_CONFIG) -> workflow | null`
- `workflowActionIds(workflow, context) -> Set<string>`
- `validateReleaseWorkflowConfig(config) -> { valid: boolean, errors: string[] }`
- `releaseActionProcessMetadata(actionId, node) -> { processId, processOrder, processTitle }`

- [ ] **Step 1: Write the failing tests**

  在 `test/release-workflow-config.test.mjs` 中写真实配置行为断言：

  ```js
  test("selects the Likee Android workflow and filters initial batch nodes", () => {
    const workflow = selectReleaseWorkflow({ businessLine: "likee", platform: "android", batch: "initial" });
    assert.equal(workflow.id, "likee-android-release");
    assert.equal(workflowActionIds(workflow, { batch: "initial" }).has("release-git:create-release-branch"), true);
    assert.equal(workflowActionIds(workflow, { batch: "initial" }).has("release-management:append-release-batch"), false);
  });

  test("rejects duplicate Action references inside one workflow", () => {
    const result = validateReleaseWorkflowConfig({ workflows: [{ id: "demo", businessLines: ["likee"], platforms: ["android"], batches: ["initial"], stages: [{ id: "one", nodes: [{ id: "x" }, { id: "x" }] }] }] });
    assert.equal(result.valid, false);
    assert.match(result.errors.join("\\n"), /duplicate|重复/i);
  });
  ```

- [ ] **Step 2: Run tests to verify RED**

  Run: `node --test test/release-workflow-config.test.mjs`

  Expected: FAIL because `shared/release-workflow-config.js` and its exports do not exist.

- [ ] **Step 3: Implement the configuration and validator**

  Move the current Likee Android and Likee iOS workflow definitions into `RELEASE_WORKFLOW_CONFIG.workflows`, preserving every stage, batch filter, node order, optional node and evidence field. Move the process order/title and Skill/Action fallback mappings into the same config object. Implement deterministic context normalization, workflow selection, batch-filtered Action ID collection, and validation for empty scope, duplicate workflow/stage/Action IDs, invalid optional references, and malformed node entries.

  Add the requirement comment above the config selector: `// 用户需求点: 同一份配置同时决定状态流转和自定义阶段可执行节点集合，前后端必须按同一上下文选择 workflow。`

- [ ] **Step 4: Run tests to verify GREEN**

  Run: `node --test test/release-workflow-config.test.mjs`

  Expected: PASS with selection, batch filtering, optional-node and validation assertions.

- [ ] **Step 5: Commit**

  ```bash
  git add shared/release-workflow-config.js test/release-workflow-config.test.mjs
  git commit -m "feat(release): add shared workflow configuration"
  ```

### Task 2: Make the frontend state machine consume shared configuration

**Files:**
- Modify: `builtin/web-ui/src/lib/releaseWorkflowStateMachine.js`
- Modify: `test/release-workflow-state-machine.test.mjs`
- Modify: `test/release-workflow-model.test.mjs`

**Interfaces:**
- Existing exports from `releaseWorkflowStateMachine.js` keep their names and return shapes.
- `createReleaseProcessStateMachine({ nodes, context })` uses `selectReleaseWorkflow()` and `workflowActionIds()` from shared config.
- `selectWorkflowProcessNodes({ machine, nodes })` returns only nodes present in the selected workflow/stage configuration and current batch.

- [ ] **Step 1: Write the failing tests**

  Add tests that pass a cloned config with `release-git:create-release-branch` removed to `selectReleaseWorkflow()` and assert both recommendations and custom candidate nodes omit it; add a test that an Android-only node is absent from the iOS candidate set even when the dynamic catalog contains it. Add a parity assertion that the machine’s `workflow.id`, ordered process IDs, and candidate Action IDs match the shared config.

- [ ] **Step 2: Run focused tests to verify RED**

  Run: `node --test test/release-workflow-state-machine.test.mjs test/release-workflow-model.test.mjs`

  Expected: the new config mutation/parity assertions fail because the state machine still owns hardcoded definitions and does not expose a config-driven candidate filter.

- [ ] **Step 3: Replace hardcoded definitions with shared config adapters**

  Remove the duplicated workflow array from `releaseWorkflowStateMachine.js`. Keep only generic normalization, status derivation and recommendation algorithms. Build processes by reading the selected config stages, resolving each configured Action ID against the filtered dynamic/static node catalog, preserving configured order and optional flags. When no workflow matches, return an empty executable machine and ensure `selectWorkflowProcessNodes()` never falls back to the entire catalog.

  Add the requirement comment above the process builder: `// 用户需求点: 配置引用的节点才是当前业务线、平台和批次的可执行集合，自定义阶段不能平铺整个 catalog。`

- [ ] **Step 4: Run focused tests to verify GREEN**

  Run: `node --test test/release-workflow-state-machine.test.mjs test/release-workflow-model.test.mjs`

  Expected: PASS, including existing Android/iOS, initial/supplemental, failure and legacy-state tests.

- [ ] **Step 5: Commit**

  ```bash
  git add builtin/web-ui/src/lib/releaseWorkflowStateMachine.js test/release-workflow-state-machine.test.mjs test/release-workflow-model.test.mjs
  git commit -m "refactor(release): drive frontend state machine from config"
  ```

### Task 3: Make the backend catalog and execution enforce the same node whitelist

**Files:**
- Modify: `bin/lib/release-runtime.mjs`
- Modify: `bin/lib/workspace-routes.mjs`
- Modify: `test/release-runtime-catalog.test.mjs`
- Modify: `test/release-runtime-api.test.mjs`

**Interfaces:**
- `discoverReleaseActions()` keeps discovering release-skill Actions and enriching them with input/runtime facts, but process metadata comes from `releaseActionProcessMetadata()`.
- Add `filterReleaseActionsForWorkflow(nodes, context) -> nodes` in `bin/lib/release-runtime.mjs`; when a workflow matches, it returns only configured Action IDs while preserving configured stage and Action order metadata.
- `/api/release/catalog` returns the filtered executable node collection.
- `/api/release/nodes/preview` and `/api/release/nodes/run` reject an Action not present in the selected workflow with `RELEASE_WORKFLOW_NODE_NOT_ALLOWED`.

- [ ] **Step 1: Write the failing API/catalog tests**

  Add a temporary catalog containing one configured ID (`release-git:create-release-branch`) and one unconfigured ID (`release-demo:extra`). Assert catalog filtering returns only the configured node. Add an execution request for `release-demo:extra` and assert HTTP 409 with code `RELEASE_WORKFLOW_NODE_NOT_ALLOWED`. Add a parity test that filtered server nodes and frontend `selectWorkflowProcessNodes()` expose the same IDs for Likee Android initial.

- [ ] **Step 2: Run focused tests to verify RED**

  Run: `node --test test/release-runtime-catalog.test.mjs test/release-runtime-api.test.mjs`

  Expected: FAIL because runtime catalog currently returns all discovered Profile Actions and route validation only checks scope/process metadata.

- [ ] **Step 3: Implement shared-config filtering and route validation**

  Import the shared config adapter from the backend runtime. Keep Profile filtering first, then intersect with the selected workflow configuration. Sort returned nodes by configured stage order and Action order while retaining all existing `inputSchema`, `source`, `scopeKey`, `requiresConfirmation` and `nextNodeIds` fields. In preview/run routes, resolve the workflow from the request context before accepting `actionId`; reject unknown configured membership before building or running an AgentFlow graph.

  Add the requirement comment above the route guard: `// 用户需求点: 状态机配置不仅用于推荐，也必须阻止未纳入当前业务/平台流程的节点被执行。`

- [ ] **Step 4: Run focused tests to verify GREEN**

  Run: `node --test test/release-runtime-catalog.test.mjs test/release-runtime-api.test.mjs`

  Expected: PASS, with existing scope/process/confirmation behavior unchanged.

- [ ] **Step 5: Commit**

  ```bash
  git add bin/lib/release-runtime.mjs bin/lib/workspace-routes.mjs test/release-runtime-catalog.test.mjs test/release-runtime-api.test.mjs
  git commit -m "feat(release): enforce workflow node allowlist in runtime"
  ```

### Task 4: Keep UI recommendations, custom candidates and persisted records aligned

**Files:**
- Modify: `builtin/web-ui/src/components/ReleaseWorkflowPanel.jsx`
- Modify: `builtin/web-ui/src/lib/releaseWorkflowModel.js`
- Modify: `bin/lib/release-runtime-store.mjs`
- Modify: `test/release-runtime-integration.test.mjs`
- Modify: `test/release-workflow-panel-contract.test.mjs`

**Interfaces:**
- `seedNextRecommendations()` and `selectWorkflowProcessNodes()` use the same machine-selected node set.
- Generated pending/timeline records retain `workflowId`, `processId`, `processOrder`, `processTitle`, `scopeKey` and `contextSnapshot` where available.
- Custom node creation copies only a node returned by `selectWorkflowProcessNodes()`; repeated selection remains allowed.

- [ ] **Step 1: Write the failing integration/contract tests**

  Assert that the add-stage groups contain only configured IDs for the selected business/platform/batch, that removing an Action from a workflow config removes it from both recommendations and the add-stage picker, and that a persisted pending/completed record keeps `workflowId` after a state round trip.

- [ ] **Step 2: Run focused tests to verify RED**

  Run: `node --test test/release-runtime-integration.test.mjs test/release-workflow-panel-contract.test.mjs`

  Expected: FAIL because generated records currently store process metadata but not workflow identity, and the panel does not assert configuration membership at persistence boundaries.

- [ ] **Step 3: Implement alignment and migration**

  Add `workflowId` to the machine snapshot and generated records without changing existing timeline/pending field names. Do not add migration/version branches for legacy data in this development-stage change. Ensure all panel add-stage options are produced from the machine, not the raw remote catalog.

  Add the requirement comment above legacy hydration: `// 用户需求点: 历史记录可继续查看，但不能让不属于当前状态机的节点重新进入可执行候选集合。`

- [ ] **Step 4: Run focused tests and JSX static check**

  ```bash
  node --test test/release-runtime-integration.test.mjs test/release-workflow-panel-contract.test.mjs
  node_modules/.bin/esbuild builtin/web-ui/src/components/ReleaseWorkflowPanel.jsx --loader:.jsx=jsx --outfile=/tmp/ReleaseWorkflowPanel.js
  ```

  Expected: PASS and successful JSX transformation.

- [ ] **Step 5: Commit**

  ```bash
  git add builtin/web-ui/src/components/ReleaseWorkflowPanel.jsx builtin/web-ui/src/lib/releaseWorkflowModel.js bin/lib/release-runtime-store.mjs test/release-runtime-integration.test.mjs test/release-workflow-panel-contract.test.mjs
  git commit -m "refactor(release): align candidates and persisted workflow state"
  ```

### Task 5: Full verification and handoff

**Files:**
- Test only: existing release workflow and runtime tests.
- Build output: generated files from `npm run build:web-ui` are inspected but not independently staged over unrelated user changes.

- [ ] **Step 1: Run all release tests**

  ```bash
  node --test \
    test/release-workflow-config.test.mjs \
    test/release-workflow-state-machine.test.mjs \
    test/release-workflow-model.test.mjs \
    test/release-workflow-panel-contract.test.mjs \
    test/release-runtime-catalog.test.mjs \
    test/release-runtime-api.test.mjs \
    test/release-runtime-integration.test.mjs \
    test/release-runtime-executor.test.mjs
  ```

  Expected: all tests pass with zero failures.

- [ ] **Step 2: Run frontend build and diff checks**

  ```bash
  npm run build:web-ui
  git diff --check
  ```

  Expected: Vite exits 0; `git diff --check` emits no whitespace errors.

- [ ] **Step 3: Verify runtime/frontend parity without executing a release**

  Query the local catalog for `businessLine=likee&platform=android&version=1.1.0&batch=initial`, compare its Action IDs with the machine-selected candidates, and verify `release-git:create-release-branch` remains present while unconfigured Actions are absent. Do not confirm or run a real branch-creation request.

- [ ] **Step 4: Review the diff and commit only implementation files**

  Confirm existing unrelated dirty files and generated assets remain untouched by staging. Commit only files listed in completed tasks, then report commit IDs, test counts, build result, and files intentionally left uncommitted because they predated this change.
