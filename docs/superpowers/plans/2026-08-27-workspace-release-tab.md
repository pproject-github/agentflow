# Workspace Release Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with review checkpoints.

**Goal:** Add a functional “发版” tab to `/workspaces` with platform/business-line-aware release nodes, a persistent timeline, manual execution/cancel/retry, inferred next stages, and custom nodes.

**Architecture:** Keep `WorkspacesPage` responsible for workspace loading and tab/context selection. Put release node definitions and the local execution adapter in focused modules, and render the release experience in a dedicated `ReleaseWorkflowPanel` component. Persist only release state in `localStorage`; expose the executor as an async function so a future AgentFlow run API can replace the simulator without changing the UI.

**Tech Stack:** React 18 hooks, Vite, existing CSS in `builtin/web-ui/src/index.css`, browser `localStorage`, `AbortController`.

**Spec:** `docs/superpowers/specs/2026-08-27-workspace-release-tab-design.md`

## Global Constraints

- Preserve the existing `/workspaces` route and current knowledge-base CRUD behavior.
- Use the release-skill names under `/Users/duanfengyuan/migration-workspace/test/likee_android/.workspace/release-skills` as the source vocabulary for node definitions.
- Keep `businessLines` and `platforms` on every node definition even when a node is currently shared.
- Completed timeline entries are read-only; running and failed entries remain executable/cancellable according to state rules.
- Do not add runtime dependencies.

### Task 1: Build the release node catalog and simulator

**Files:**
- Create: `builtin/web-ui/src/lib/releaseNodeCatalog.js`

**Interfaces:**
- Produces `RELEASE_NODE_CATALOG`, an array of node definitions with `id`, `title`, `description`, `skill`, `category`, `businessLines`, `platforms`, `durationMs`, and `nextNodeIds`.
- Produces `getReleaseNodes({ businessLine, platform })`, returning only nodes matching both dimensions.
- Produces `inferReleaseContext(workspace)`, returning `{ businessLine, platform, version }`.
- Produces `runReleaseNode(node, context, { signal, onProgress } = {})`, resolving `{ runId, message }` or rejecting with an `Error`; aborting rejects with an `AbortError`.

- [ ] **Step 1: Encode the shared and platform-specific node definitions**

  Map the documented skills to nodes: `release-setup`, `release-management`, `release-git`, `release-localization`, `release-approval`, `release-release-notes`, `release-metrics`, `release-gray-observe`, `release-records`, `release-channel-packages`, and `release-notification`. Mark iOS-only nodes (`release-notes`, first approval) and Android-only nodes (补包记录, 渠道包) via `platforms`.

- [ ] **Step 2: Add context inference and filtering helpers**

  Normalize labels/paths to lowercase; detect `bigolive`, `hello`, or `likee`, detect `ios`/`iphone` versus Android, and use `1.0.0` when no version is discoverable. Return copies from `getReleaseNodes` so UI code cannot mutate the catalog.

- [ ] **Step 3: Add an abortable local executor**

  Use a short timer (default `durationMs` capped for local testing) and call `onProgress` at 0/50/100. Wire `AbortSignal` to clear the timer and reject with `name === "AbortError"`. Generate a stable-looking `runId` without external services.

- [ ] **Step 4: Run lint for the new module**

  Run: `npm --prefix builtin/web-ui run lint -- --no-warn-ignored`

  Expected: exit 0.

### Task 2: Implement the release workflow panel state machine

**Files:**
- Create: `builtin/web-ui/src/components/ReleaseWorkflowPanel.jsx`

**Interfaces:**
- Consumes `workspace` and optional `onContextChange` props.
- Uses `getReleaseNodes`, `inferReleaseContext`, and `runReleaseNode` from Task 1.
- Renders context controls, timeline, pending cards, custom-node form, and status/error messaging.

- [ ] **Step 1: Add persistence helpers and initial state**

  Key storage by workspace identity, business line, platform, and version. Safely parse malformed values and fall back to `{ timeline: [], pending: [], customNodes: [] }`. Persist after every state mutation and expose a non-blocking “本地状态暂不可保存” notice on storage errors.

- [ ] **Step 2: Add node lifecycle handlers**

  Implement `enqueueNode(nodeId)`, `executeNode(item)`, `cancelNode(item)`, and `retryNode(item)`. Guard completed nodes from enqueue/execute; allow failed nodes to retry; keep a `Map` of active `AbortController`s. On success append a completed timeline item, remove the pending item, infer up to two `nextNodeIds`, and enqueue only nodes not already completed/running/pending. On failure keep the item with `status: "failed"` and a readable error. On cancel return it to `pending` without adding timeline history.

- [ ] **Step 3: Add custom-node creation flow**

  Provide an inline form for title/description and a checkbox list of currently available catalog nodes. On save create a custom node definition with `skill: "custom"`, selected node IDs in `nextNodeIds`, and enqueue it. Reset the form after save so multiple custom nodes can be added.

- [ ] **Step 4: Render the interactive UI**

  Render a context header with business-line select, platform toggle, version input, and counts. Render completed timeline entries as disabled cards, running cards with the `af-release-node--running` class and cancel button, failed cards with red styling and error text, and pending cards with execute buttons. Include an empty state and an “全部阶段” picker for manually adding catalog nodes.

- [ ] **Step 5: Run lint for the panel**

  Run: `npm --prefix builtin/web-ui run lint -- --no-warn-ignored`

  Expected: exit 0.

### Task 3: Integrate the tab into WorkspacesPage

**Files:**
- Modify: `builtin/web-ui/src/pages/WorkspacesPage.jsx`

**Interfaces:**
- Import and render `ReleaseWorkflowPanel`.
- Preserve all existing workspace list/editor handlers and API calls unchanged.

- [ ] **Step 1: Track the active tab and selected workspace context**

  Add `activeTab` state defaulting to `"iterations"`; derive `releaseWorkspace` from the selected custom workspace, selected builtin workspace, or the first available workspace. Keep the current selected workspace when switching tabs.

- [ ] **Step 2: Add the tab strip and conditional content**

  Render buttons labeled `迭代` and `发版` below the page hero. Keep the current summary/list/editor layout under `迭代`; render `<ReleaseWorkflowPanel workspace={releaseWorkspace} />` under `发版`. When no workspace exists, pass a fallback object so the release panel still opens with inferred Likee/Android context.

- [ ] **Step 3: Add an explicit workspace hint for release context**

  Show the selected workspace label/path in the release tab header and allow the panel’s context controls to override inferred values without mutating workspace configuration.

- [ ] **Step 4: Run a production build**

  Run: `npm --prefix builtin/web-ui run build`

  Expected: exit 0 with Vite output in `builtin/web-ui/dist`.

### Task 4: Add release-specific styles

**Files:**
- Modify: `builtin/web-ui/src/index.css`

**Interfaces:**
- Provides all `af-release-*` classes consumed by `ReleaseWorkflowPanel`.

- [ ] **Step 1: Add layout and context styles**

  Define responsive panel, context grid, tab strip, timeline/pending columns, and compact form controls using existing color variables and spacing conventions.

- [ ] **Step 2: Add node state styles and animation**

  Define completed/failed/running/pending variants, red failure labels, disabled completed cards, and a `@keyframes af-release-breathe` animation for running nodes. Respect `prefers-reduced-motion` by disabling the animation.

- [ ] **Step 3: Run lint and build after CSS integration**

  Run: `npm --prefix builtin/web-ui run lint && npm --prefix builtin/web-ui run build`

  Expected: both commands exit 0.

### Task 5: Verify the local user flow

**Files:**
- No source changes expected.

- [ ] **Step 1: Start the local UI**

  Run: `npm --prefix builtin/web-ui run dev -- --host 127.0.0.1`

  Expected: Vite serves the UI on a localhost port (use the printed port; project default is 5173 unless configured otherwise).

- [ ] **Step 2: Exercise the release tab manually**

  Open `/workspaces`, switch to `发版`, verify inferred Likee/Android context, change platform to iOS, edit the version, add a catalog node, execute it, cancel a running node, retry a failed node, and add a custom node. Confirm completed cards cannot be executed and refresh preserves state.

- [ ] **Step 3: Capture final verification output**

  Run: `git diff --check && npm --prefix builtin/web-ui run lint && npm --prefix builtin/web-ui run build`

  Expected: all commands exit 0 and `git diff --check` prints no whitespace errors.

