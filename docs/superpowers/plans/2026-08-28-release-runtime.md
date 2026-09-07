# Release Skill AgentFlow Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task with review checkpoints. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace simulated release stages with Action-based release-skills nodes that execute through AgentFlow and expose read-only/editable node inspection.

**Architecture:** Parse release Skill frontmatter into a server-backed catalog, create an isolated AgentFlow workspace graph for each Action run, and persist release state and logs through authenticated Release Runtime APIs. The React panel consumes those APIs and opens a Workspace-style inspector with immutable completed nodes and editable pending/failed nodes.

**Tech Stack:** Node.js ESM HTTP routes, existing AgentFlow workspace runtime, Python `scripts/run.py` entrypoints from release-skills, React 18 hooks, Vite, Node test runner.

**Spec:** `docs/superpowers/specs/2026-08-28-release-runtime-design.md`

## Global Constraints

- Action definitions come from `SKILL.md` YAML frontmatter in the configured release-skills roots.
- `release-initialization` is immutable and remains the first node for each workspace/businessLine/platform/version/batch context.
- `requires_confirmation: true` actions require a preview and a second confirmation before external writes.
- Completed nodes are read-only; running nodes can be cancelled; failed nodes can be edited and retried; custom Action instances may repeat.
- Never expose or persist OAuth, Jenkins, GitLab, Google, or other credentials.
- Do not add runtime dependencies; use existing YAML/frontmatter utilities or a small safe parser already present in the repository.

---

### Task 1: Build a release Skill Action loader

**Files:**
- Create: `bin/lib/release-runtime.mjs`
- Modify: `builtin/web-ui/src/lib/releaseNodeCatalog.js`
- Test: `test/release-runtime-catalog.test.mjs`

**Interfaces:**
- `discoverReleaseActions({ roots, businessLine, platform, batch }) -> Promise<ActionDefinition[]>`
- `readReleaseAction(skillRoot, skillName, actionName) -> ActionDefinition`
- `releaseActionId(skillName, actionName) -> string`
- `getReleaseNodes(context) -> ActionDefinition[]` remains available to the browser and returns serializable copies.

- [ ] **Step 1: Write the failing loader tests**

Add fixtures under a temporary directory containing `release-approval/SKILL.md` with two actions and `release-google-play/SKILL.md` with Android-only actions. Assert action-level IDs, `requiresConfirmation`, `inputSchema`, `allowedBatches`, source paths, and platform filtering.

- [ ] **Step 2: Run the focused tests and verify the expected failure**

Run `node --test test/release-runtime-catalog.test.mjs`. It must fail because the loader module and Action-level catalog do not yet exist.

- [ ] **Step 3: Implement frontmatter discovery and normalization**

Read only `SKILL.md` files below configured roots, parse the frontmatter already used by the repository, normalize list/scalar forms, derive safe titles from action names, and mark missing scripts as `runnable: false` with an error rather than dropping the node. Preserve `businessLines` as `['likee', 'bigolive', 'hello']` until business-line presets are introduced.

- [ ] **Step 4: Replace the static browser catalog with the normalized Action shape**

Keep `release-initialization` in the UI model, map Action IDs to categories, and keep the current fallback catalog only when the API is unavailable. Remove the one-Skill/one-node assumption and include `action`, `requiresConfirmation`, `inputSchema`, `source`, and `nextNodeIds`.

- [ ] **Step 5: Run the focused tests and commit**

Run `node --test test/release-runtime-catalog.test.mjs`; expect all tests to pass. Commit with `feat(release): load release skill actions as nodes`.

### Task 2: Add the AgentFlow-backed execution adapter

**Files:**
- Create: `bin/lib/release-runtime-executor.mjs`
- Test: `test/release-runtime-executor.test.mjs`

**Interfaces:**
- `buildReleaseRunGraph(action, context, inputs) -> graph`
- `previewReleaseAction(action, context, inputs, userCtx) -> { preview, confirmationFingerprint }`
- `runReleaseAction(action, context, inputs, options) -> Promise<{ runId, status, output, logs }>`
- `stopReleaseAction(runId, userCtx) -> Promise<{ stopped: boolean }>`

- [ ] **Step 1: Write failing command-construction and confirmation tests**

Test that the generated graph contains one `tool_nodejs` node, points only to the discovered `scripts/run.py`, passes `--action`, serializes context/inputs without secrets, and rejects a confirmation fingerprint computed for different inputs.

- [ ] **Step 2: Run the focused tests and verify failure**

Run `node --test test/release-runtime-executor.test.mjs`; confirm the new adapter functions are missing.

- [ ] **Step 3: Implement isolated AgentFlow graph execution**

Generate a temporary release flow graph with a single executable node and display/log output slots. Invoke the existing `runWorkspaceGraph`/workspace run control instead of a second executor. Use `uv run python <script> --action <action>` with a fixed cwd and environment-provided JSON input; never concatenate user input into shell code.

- [ ] **Step 4: Implement preview and confirmation semantics**

For read-only actions execute immediately. For confirmed actions run the Skill in its preview mode, store the redacted preview and fingerprint, and require the exact fingerprint plus unchanged context/input hash before the live invocation. Return `status: 'preview'` without external write on the first call.

- [ ] **Step 5: Implement cancellation, timeout and log normalization**

Wire AgentFlow’s active child controller to `stopReleaseAction`; map non-zero exit to `failed`, abort to `stopped`, and unknown external results to `unknown`. Redact known secrets and cap log/output sizes before returning them.

- [ ] **Step 6: Run tests and commit**

Run `node --test test/release-runtime-executor.test.mjs`; expect all tests to pass. Commit with `feat(release): execute release actions through AgentFlow`.

### Task 3: Expose authenticated Release Runtime APIs and persistence

**Files:**
- Modify: `bin/lib/workspace-routes.mjs`
- Create: `bin/lib/release-runtime-store.mjs`
- Test: `test/release-runtime-api.test.mjs`

**Interfaces:**
- `GET /api/release/catalog`
- `GET /api/release/state`
- `PATCH /api/release/pending/:itemId`
- `POST /api/release/nodes/preview`
- `POST /api/release/nodes/run`
- `POST /api/release/runs/stop`
- `GET /api/release/runs/:runId`
- `GET /api/release/runs/:runId/logs`

- [ ] **Step 1: Write failing API tests**

Start the existing UI server with a temporary workspace and authenticated user. Assert catalog filtering, initialization state, pending input updates, preview-only behavior for confirmed actions, run completion persistence, failed run persistence, and stop behavior.

- [ ] **Step 2: Run the API tests and verify failure**

Run `node --test test/release-runtime-api.test.mjs`; confirm the endpoints return 404 before implementation.

- [ ] **Step 3: Implement workspace-scoped state storage**

Store context, timeline, pending items, custom instances, preview fingerprints, and run metadata under the workspace release runtime directory. Read legacy browser state only through an explicit migration payload; never trust client-supplied completed status or run output.

- [ ] **Step 4: Implement catalog/state endpoints and permission checks**

Resolve workspace scope using the existing helpers, verify the authenticated user can read/run the workspace, and return only nodes matching business line/platform/batch. Reject edits to completed items and initialization.

- [ ] **Step 5: Implement preview/run/stop/detail endpoints**

Validate Action IDs against the server catalog, validate each input schema, call the executor, append successful runs to timeline, infer downstream nodes, and retain failures/runs/logs for inspection. Use NDJSON or polling-compatible response fields (`runId`, `status`, `progress`, `output`, `logs`, `error`).

- [ ] **Step 6: Run API tests and commit**

Run `node --test test/release-runtime-api.test.mjs`; expect all tests to pass. Commit with `feat(release): add authenticated release runtime APIs`.

### Task 4: Implement the Workspace-style node inspector

**Files:**
- Create: `builtin/web-ui/src/components/ReleaseNodeInspector.jsx`
- Modify: `builtin/web-ui/src/components/ReleaseWorkflowPanel.jsx`
- Modify: `builtin/web-ui/src/index.css`
- Test: `test/release-node-inspector-contract.test.mjs`

**Interfaces:**
- `<ReleaseNodeInspector item node mode="completed" | "pending" | "failed" onClose onSave onPreview onRun onStop />`
- `mode="completed"` disables all editing and run controls.
- `mode="pending" | "failed"` enables schema-driven input editing and preview/run controls.

- [ ] **Step 1: Write failing UI contract tests**

Assert completed inspector renders definition/action/input/output/log/run metadata and has no enabled input or execute control; pending inspector renders editable inputs, preview/run buttons, maximize toggle, and log/output sections.

- [ ] **Step 2: Run the focused UI contract test and verify failure**

Run `node --test test/release-node-inspector-contract.test.mjs`; confirm the component and required markers are absent.

- [ ] **Step 3: Implement the inspector modal**

Reuse existing Workspace/Subflow Preview visual conventions, create a portal dialog with Escape close, maximize state, scrollable sections, copy output, and explicit read-only labels. Show confirmation preview and fingerprint before confirmed actions run.

- [ ] **Step 4: Wire panel cards to the inspector and Runtime API**

Clicking completed cards loads real run details in read-only mode. Clicking pending/failed cards opens editable mode; saving updates only that pending instance. Replace direct `runReleaseNode` timer calls with catalog/preview/run/stop API calls while retaining optimistic running state and polling fallback.

- [ ] **Step 5: Run UI tests and commit**

Run `node --test test/release-node-inspector-contract.test.mjs test/release-workflow-model.test.mjs test/release-workflow-panel-contract.test.mjs`; expect all tests to pass. Commit with `feat(release): inspect and edit release action runs`.

### Task 5: Integrate dynamic catalogs, migration and final verification

**Files:**
- Modify: `builtin/web-ui/src/pages/ReleasePage.jsx`
- Modify: `builtin/web-ui/src/lib/releaseWorkflowModel.js`
- Modify: `builtin/web-ui/src/lib/releaseNodeCatalog.js`
- Modify: `builtin/web-ui/src/index.css`
- Test: `test/release-runtime-integration.test.mjs`

- [ ] **Step 1: Write failing integration assertions**

Assert that the release page loads the server catalog, includes `release-google-play` when its extension root is enabled, preserves the initialization node, migrates legacy localStorage state, and renders completed/pending groups with the existing timeline layout.

- [ ] **Step 2: Run the integration test and verify failure**

Run `node --test test/release-runtime-integration.test.mjs`; confirm the dynamic catalog and API calls are not wired yet.

- [ ] **Step 3: Implement API hydration and localStorage migration**

Hydrate context and state from the server, send legacy localStorage once for migration, and keep a temporary memory fallback with a visible warning if the API is unavailable. Preserve custom-node repeatability and inferred-next-node behavior.

- [ ] **Step 4: Run full validation**

Run:

```bash
node --test test/release-runtime-catalog.test.mjs test/release-runtime-executor.test.mjs test/release-runtime-api.test.mjs test/release-node-inspector-contract.test.mjs test/release-runtime-integration.test.mjs
npm --prefix builtin/web-ui run lint
npm --prefix builtin/web-ui run build
git diff --check
```

Expected: all focused tests pass, lint exits 0 with only existing warnings, build exits 0, and `git diff --check` reports no errors.

- [ ] **Step 5: Commit final integration**

Commit with `feat(release): connect release timeline to AgentFlow runtime`.
