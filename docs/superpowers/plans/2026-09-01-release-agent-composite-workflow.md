# Agent-Driven Release Composite Workflow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace hard-coded multi-Action release composites with one AgentFlow `agent_subAgent` per capability, using a unified Likee Android initial/supplemental state machine with rollout/full-rollout loops into new supplemental batches.

**Architecture:** The shared release configuration will describe bounded business capabilities with prompt templates, skill hints, scopes, inputs/outputs, and transitions, but no atomic Action graph. The release executor will materialize one `agent_subAgent` graph whose prompt contains the release context, all discovered `release-*` Skill paths, capability goal, and upstream artifacts; the Agent will read and orchestrate the current Skills. The release route and UI will persist the Agent’s structured `completed`/`waiting`/`failed` result and batch-specific timeline without expanding internal tool nodes.

**Tech Stack:** Node.js ESM, AgentFlow `agent_subAgent`, existing Workspace graph runner/output protocol, shared JavaScript workflow configuration, React release panel, Node test runner.

**Spec:** `docs/superpowers/specs/2026-09-01-release-agent-composite-design.md`

## Global Constraints

- Composite execution must materialize exactly one `agent_subAgent`; no `composite_upload_*`, `tool_nodejs`, or hard-coded atomic Action fan-out.
- The Agent must read the latest Skill files from the selected release Skill root; source-file enumeration remains owned by `release-localization` Skill profiles.
- The Agent may read all current `release-*` Skills; `skillHints` only prioritize relevant Skills and never replace Skill safety, preflight, confirmation, idempotency, or recovery rules.
- Likee Android initial and supplemental releases share one state machine; `batch` and `batchIndex` select capability behavior and inputs.
- Rollout and full rollout are repeatable batch transitions; creating a supplemental batch creates new stage instances while preserving previous batch history.
- Missing store-publish capability must produce `waiting` or `failed`, never a false successful publish.
- Secrets, webhooks, tokens, absolute credential values, and raw external credentials must never enter prompts or release records.
- Preserve unrelated user changes in the dirty worktree; only stage files belonging to the current task when committing.

### Task 1: Add failing contracts for Agent-driven composites

**Files:**
- Modify: `test/release-runtime-executor.test.mjs`
- Modify: `test/release-runtime-config.test.mjs` (create if the existing config tests are split elsewhere)
- Modify: `test/release-runtime-api.test.mjs`
- Modify: `test/release-workflow-state-machine.test.mjs`

**Interfaces:**
- Consumes: current `buildCompositeReleaseRunGraph`, `previewReleaseAction`, release catalog, and state-machine helpers.
- Produces: regression contracts requiring a single Agent node, prompt context, structured status mapping, and batch-loop transitions.

- [ ] **Step 1: Write the failing graph contract.**

  Add a test that builds the `localization-upload-notify` capability with current Android context and asserts:

  ```js
  assert.deepEqual(Object.values(graph.instances).map((node) => node.definitionId), ["agent_subAgent"]);
  assert.equal(Object.keys(graph.instances).some((id) => id.startsWith("composite_upload")), false);
  assert.match(graph.instances.release_agent.body, /多语言上传.*通知/);
  assert.match(graph.instances.release_agent.body, /businessLine.*likee/);
  assert.match(graph.instances.release_agent.body, /读取.*release-localization.*SKILL\.md/);
  ```

  Also assert the prompt does not contain a literal source-file list or an atomic step sequence.

- [ ] **Step 2: Run the focused test and verify the expected failure.**

  Run:

  ```bash
  node --test test/release-runtime-executor.test.mjs --test-name-pattern='single Agent'
  ```

  Expected: FAIL because the current graph contains `tool_nodejs` and expanded composite upload nodes.

- [ ] **Step 3: Add failing structured-result contracts.**

  Add API tests covering Agent output envelopes:

  - `status=completed` moves the capability to timeline and stores `steps`, `records`, and `artifacts`.
  - `status=waiting` leaves the capability pending with a waiting reason and does not advance the state machine.
  - `status=failed` leaves a retryable failed pending node with the sanitized reason.

- [ ] **Step 4: Add failing unified-batch contracts.**

  Add state-machine tests asserting the same Likee Android workflow is selected for both batches, that rollout and full-rollout expose a `create_supplemental_batch` transition, and that a new supplemental batch receives new capability instance IDs without mutating the completed initial batch.

- [ ] **Step 5: Run the new tests and verify they fail for the intended missing behavior.**

  Run:

  ```bash
  node --test test/release-runtime-executor.test.mjs test/release-runtime-api.test.mjs test/release-workflow-state-machine.test.mjs --test-name-pattern='Agent|batch|supplemental|waiting|structured'
  ```

### Task 2: Refactor shared configuration to capability prompts and one Android state machine

**Files:**
- Modify: `shared/release-workflow-config.js`
- Modify: `test/release-workflow-config.test.mjs`

**Interfaces:**
- Consumes: existing workflow selection, scope validation, and composite selection helpers.
- Produces: capability definitions with `promptTemplate`, `skillHints`, `inputs`, `outputs`, `batches`, and explicit batch-loop transitions.

- [ ] **Step 1: Replace Action-sequence composite fixtures in tests.**

  Assert that each configured capability has no `actions` or `expandSourceFiles`, has a non-empty prompt template, and declares only the supported Likee Android capability IDs:

  ```js
  assert.equal(capability.actions, undefined);
  assert.equal(capability.expandSourceFiles, undefined);
  assert.ok(capability.promptTemplate.includes("${businessLine}"));
  assert.ok(capability.skillHints.every((key) => key.startsWith("release-")));
  ```

- [ ] **Step 2: Run the config tests to confirm the old schema still fails the new contract.**

  Run:

  ```bash
  node --test test/release-workflow-config.test.mjs --test-name-pattern='capability|prompt|composite'
  ```

- [ ] **Step 3: Define the Likee Android capability catalog.**

  Add the 10 capability IDs and prompt metadata for:

  - localization upload and notification;
  - create/reuse release branch;
  - localization download, apply, commit/MR, and notification;
  - release branch merge to master;
  - build package;
  - submit approval;
  - initial/supplemental publish and notification;
  - supplemental notification;
  - rollout;
  - full rollout.

  Each prompt must tell the Agent to read all current `release-*` Skills, prioritize the declared hints, use current context, perform real Skill entrypoints, honor confirmation/preflight, and return the structured result envelope.

- [ ] **Step 4: Make initial and supplemental paths one workflow.**

  Update `likee-android-release` stages so `batch` scopes control capability availability and prompt wording. Add explicit transitions from `rollout` and `full` to `create_supplemental_batch`, with the transition producing a new supplemental batch context instead of rewriting the current batch.

- [ ] **Step 5: Implement and test config selection.**

  Keep `selectReleaseWorkflow`, `selectReleaseCompositeWorkflow`, and scope validation APIs stable where possible; update tests for capability scope, duplicate detection, and one shared workflow across both batches.

- [ ] **Step 6: Run the config suite.**

  Run:

  ```bash
  node --test test/release-workflow-config.test.mjs test/release-workflow-state-machine.test.mjs
  ```

### Task 3: Replace composite graph expansion with one AgentFlow Agent graph

**Files:**
- Modify: `bin/lib/release-runtime-executor.mjs`
- Modify: `bin/lib/release-runtime.mjs`
- Modify: `test/release-runtime-executor.test.mjs`
- Modify: `test/release-runtime-catalog.test.mjs`

**Interfaces:**
- Consumes: capability configuration, discovered Skill roots, release context, user inputs, and existing Workspace Agent output protocol.
- Produces: `buildAgentReleaseRunGraph`/updated `buildCompositeReleaseRunGraph` returning one `agent_subAgent` instance with prompt and structured output slots.

- [ ] **Step 1: Add the minimal prompt builder under test.**

  Add a test for a pure prompt builder that receives `{ capability, context, inputs, skillRoots, upstreamOutputs }` and includes:

  - all four release context fields plus batch index;
  - project and Skill root paths without secrets;
  - capability title/goal and skill hints;
  - upstream records/artifacts;
  - the exact JSON result protocol and “do not claim success without evidence” rule.

- [ ] **Step 2: Implement prompt interpolation and sanitization.**

  Implement a small, deterministic interpolation helper for `${businessLine}`, `${platform}`, `${version}`, `${batch}`, `${batchIndex}`, and `${capabilityGoal}`. Reject or redact secret-looking input keys before embedding them. Do not read source-file profiles or construct atomic Action lists in this layer.

- [ ] **Step 3: Replace `buildCompositeReleaseRunGraph` internals.**

  Materialize one instance such as `release_agent`:

  ```js
  {
    definitionId: "agent_subAgent",
    label: capability.title,
    body: renderedPrompt,
    input: [
      { type: "node", name: "prev", value: "" },
      { type: "text", name: "skillsContext", value: skillManifest, showOnNode: false },
      { type: "text", name: "releaseContext", value: JSON.stringify(context), showOnNode: false },
      { type: "text", name: "inputs", value: JSON.stringify(inputs), showOnNode: false }
    ],
    output: [
      { type: "node", name: "next", value: "" },
      { type: "text", name: "result", value: "" }
    ]
  }
  ```

  Use the existing AgentFlow semantic context path so the Agent can read the discovered Skill manifest. Do not create `tool_nodejs` instances or per-file aliases. Keep the public function signature compatible for route callers, but ignore atomic Action expansion data.

- [ ] **Step 4: Remove expansion-only resume logic.**

  Replace `resumeCompositeReleaseGraph` behavior with Agent-run resume context: the previous structured result and waiting reason are appended to the next prompt. No step IDs are deleted or remapped in a generated graph.

- [ ] **Step 5: Verify the graph contract turns green.**

  Run:

  ```bash
  node --test test/release-runtime-executor.test.mjs test/release-runtime-catalog.test.mjs --test-name-pattern='Agent|composite|prompt|source file'
  ```

### Task 4: Add generic Agent result normalization and release route persistence

**Files:**
- Modify: `bin/lib/workspace-routes.mjs`
- Modify: `bin/lib/release-runtime-executor.mjs`
- Modify: `bin/lib/release-runtime-store.mjs`
- Modify: `test/release-runtime-api.test.mjs`
- Modify: `test/release-runtime-integration.test.mjs`

**Interfaces:**
- Consumes: AgentFlow run events and structured Agent envelope.
- Produces: one capability-level run record with normalized status, steps, records, artifacts, waiting metadata, and retry/resume context.

- [ ] **Step 1: Add failing normalization tests.**

  Cover JSON in `result`, fenced JSON, and plain-text fallback. Assert status precedence:

  1. explicit envelope status;
  2. AgentFlow exception/abort;
  3. plain successful output defaults to `completed` only when no failure marker exists.

- [ ] **Step 2: Implement a generic envelope parser.**

  Parse and sanitize `status`, `summary`, `steps`, `records`, `artifacts`, `waiting`, and `next_action`. Preserve only relative artifact paths and non-secret record metadata. Convert unknown status values to `failed` with a diagnostic reason.

- [ ] **Step 3: Update run handling.**

  Use the Agent node ID as the graph run target. On completion, persist the structured result and advance the current capability. On waiting, persist the run as waiting/blocked without adding it to completed timeline. On failure or cancellation, persist a retryable failed item with the original prompt, sanitized error, and run ID.

- [ ] **Step 4: Update detail materialization.**

  Change `releaseCompositeDetails` to read `details.steps` from the Agent envelope. If no steps are returned, expose one `agent` step with the Agent run summary and logs. Remove assumptions that each configured `action` has a corresponding `composite_<stepId>` node.

- [ ] **Step 5: Add generic Agent resume.**

  When retrying a waiting or failed capability, include the previous run summary, waiting confirmation data, records, and artifacts in the new prompt. Never automatically re-run a Skill operation that the Skill marks as external-result-unknown without an explicit user action.

- [ ] **Step 6: Run API and integration tests.**

  Run:

  ```bash
  node --test test/release-runtime-api.test.mjs test/release-runtime-integration.test.mjs
  ```

### Task 5: Implement unified batch creation and capability filtering in the UI model

**Files:**
- Modify: `builtin/web-ui/src/lib/releaseWorkflowStateMachine.js`
- Modify: `builtin/web-ui/src/lib/releaseWorkflowModel.js`
- Modify: `builtin/web-ui/src/lib/releaseNodeCatalog.js`
- Modify: `builtin/web-ui/src/components/ReleaseWorkflowPanel.jsx`
- Modify: `builtin/web-ui/src/components/ReleaseNodeInspector.jsx`
- Modify: `test/release-workflow-model.test.mjs`
- Modify: `test/release-workflow-panel-contract.test.mjs`

**Interfaces:**
- Consumes: unified capability catalog, batch transitions, normalized Agent run records.
- Produces: batch-aware pending/completed/failed/waiting UI, capability-only custom add menu, and one-stage Agent detail view.

- [ ] **Step 1: Add failing model tests.**

  Assert:

  - initial and supplemental contexts use the same workflow ID;
  - custom add menu contains only capabilities allowed for current batch/platform/business line;
  - a rollout/full action creates a new supplemental batch without deleting completed history;
  - repeated capability additions receive distinct instance IDs;
  - waiting and failed Agent nodes remain retryable, running nodes remain undeletable.

- [ ] **Step 2: Implement batch-aware state transitions.**

  Represent the active batch separately from prior batch records. Add a transition helper that appends a new supplemental batch context and materializes its first pending capability. Keep historical nodes immutable.

- [ ] **Step 3: Replace composite action display assumptions.**

  Render one Agent capability card and show returned Agent steps only inside the inspector. Remove upload-file count and atomic-step labels from the card.

- [ ] **Step 4: Update custom capability selection.**

  Use the state-machine capability catalog, not discovered atomic Actions, for the custom add menu. Keep duplicate capability selection allowed and generate a new instance each time.

- [ ] **Step 5: Verify UI contract tests.**

  Run:

  ```bash
  node --test test/release-workflow-model.test.mjs test/release-workflow-panel-contract.test.mjs
  ```

### Task 6: Add prompt fixtures and end-to-end capability checks

**Files:**
- Create: `test/fixtures/release-agent-prompts/likee-android.json`
- Modify: `test/release-runtime-executor.test.mjs`
- Modify: `test/release-runtime-api.test.mjs`
- Modify: `docs/release-local-processes.md`

**Interfaces:**
- Consumes: final capability configuration and Agent result protocol.
- Produces: reviewable prompt snapshots and end-to-end checks for the Likee Android initial/supplemental lifecycle.

- [ ] **Step 1: Add prompt fixture assertions.**

  Snapshot the normalized prompt metadata (capability ID, skill hints, context placeholders, required output keys) without storing absolute paths or secrets. Assert that changing a Skill profile does not change the generated prompt’s hard-coded source-file list because none exists.

- [ ] **Step 2: Add lifecycle integration scenarios.**

  Exercise:

  1. initial batch through full rollout;
  2. supplemental batch created from rollout;
  3. supplemental batch created from full rollout;
  4. waiting Agent result followed by explicit resume;
  5. failed Agent result followed by retry.

- [ ] **Step 3: Update the process documentation.**

  Document one unified Android state machine, the two batch entry modes, the rollout/full loop, the capability list, and the fact that Agent execution—not executor Action expansion—owns atomic Skill orchestration.

- [ ] **Step 4: Run the complete release regression suite.**

  Run:

  ```bash
  node --test \
    test/release-runtime-executor.test.mjs \
    test/release-runtime-catalog.test.mjs \
    test/release-runtime-api.test.mjs \
    test/release-runtime-integration.test.mjs \
    test/release-workflow-config.test.mjs \
    test/release-workflow-model.test.mjs \
    test/release-workflow-state-machine.test.mjs \
    test/release-workflow-panel-contract.test.mjs
  npm --prefix builtin/web-ui run build
  git diff --check
  ```

  Expected: all targeted tests pass, the web build exits 0, and `git diff --check` reports no whitespace errors.

### Task 7: Documentation and handoff

**Files:**
- Modify: `docs/superpowers/specs/2026-09-01-release-agent-composite-design.md` only if implementation decisions materially change the approved design.
- Modify: `docs/release-local-processes.md`

- [ ] **Step 1: Review the final diff against the approved spec.**

  Confirm no production path still expands a composite into atomic tool nodes and no source-file list is embedded in executor code.

- [ ] **Step 2: Record verification evidence.**

  Capture the exact test count, build result, and any known limitation (current external release-skills has no standalone store-publish Skill).

- [ ] **Step 3: Commit only the implementation files for this feature.**

  Use a focused commit message:

  ```bash
  git add bin/lib/release-runtime-executor.mjs \
    bin/lib/release-runtime.mjs \
    bin/lib/release-runtime-store.mjs \
    bin/lib/workspace-routes.mjs \
    shared/release-workflow-config.js \
    builtin/web-ui/src/lib/releaseWorkflowStateMachine.js \
    builtin/web-ui/src/lib/releaseWorkflowModel.js \
    builtin/web-ui/src/lib/releaseNodeCatalog.js \
    builtin/web-ui/src/components/ReleaseWorkflowPanel.jsx \
    builtin/web-ui/src/components/ReleaseNodeInspector.jsx \
    test/release-runtime-executor.test.mjs \
    test/release-runtime-catalog.test.mjs \
    test/release-runtime-api.test.mjs \
    test/release-runtime-integration.test.mjs \
    test/release-workflow-config.test.mjs \
    test/release-workflow-model.test.mjs \
    test/release-workflow-state-machine.test.mjs \
    test/release-workflow-panel-contract.test.mjs \
    docs/release-local-processes.md \
    test/fixtures/release-agent-prompts/likee-android.json
  git commit -m "feat: run release composites through agent skills"
  ```

