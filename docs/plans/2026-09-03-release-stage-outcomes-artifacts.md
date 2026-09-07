# Release Stage Outcomes & Artifacts Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make each release stage’s conclusion and artifacts visible on timeline/pending cards and in the Inspector, and stop reconcile from turning Agent `waiting` into empty timeline `completed`.

**Architecture:** Prefer Agent result status over Workspace run-manifest status in `reconcileReleaseState`. Hydrate hollow timeline/pending items from `runs[runId]` on the client. Render a shared “stage outcome” strip (summary + artifact chips) on cards; Inspector always shows full artifacts for completed and waiting.

**Tech Stack:** Node test runner (`node --test`), React JSX in `builtin/web-ui`, release state in `bin/lib/release-runtime-store.mjs`.

**Design:** `docs/plans/2026-09-03-release-stage-outcomes-artifacts-design.md`

---

### Task 1: Reconcile prefers Agent `waiting` / run output

**Files:**
- Modify: `bin/lib/release-runtime-store.mjs` (`reconcileReleaseState`, ~144–210)
- Test: `test/release-runtime-api.test.mjs`

**Step 1: Write the failing test**

Add after the existing reconcile test:

```js
test("reconcileReleaseState keeps Agent waiting and does not write empty completed", async () => {
  const { reconcileReleaseState } = await import("../bin/lib/release-runtime-store.mjs?release-state-reconcile-waiting");
  const workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-release-reconcile-waiting-")));
  const context = { businessLine: "likee", platform: "android", version: "5.64.0", batch: "initial" };
  const runId = "release-force-waiting";
  const manifestDir = path.join(workspaceRoot, ".workspace", "agentflow", "run-manifests");
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(path.join(manifestDir, `${runId}.json`), JSON.stringify({
    status: "completed",
    finishedAt: "2026-09-03T07:58:02.000Z",
    updatedAt: "2026-09-03T07:58:02.000Z",
  }));
  const waitingOutput = {
    status: "waiting",
    summary: "MR !1142 opened; wait for merge",
    waiting: { reason: "managed_topic_mr_open", merge_request_iid: 1142, operator_url: "https://example/mr/1142" },
    artifacts: [{ type: "merge_request", iid: 1142, url: "https://example/mr/1142", state: "opened" }],
  };
  const result = reconcileReleaseState(workspaceRoot, context, "likee-android-local", {
    context,
    timeline: [],
    pending: [{
      id: "force-localization",
      nodeId: "composite:localization-download-merge-notify",
      status: "running",
      runId,
      startedAt: Date.parse("2026-09-03T06:54:23.000Z"),
    }],
    runs: {
      [runId]: {
        id: "force-localization",
        nodeId: "composite:localization-download-merge-notify",
        status: "waiting",
        runId,
        output: waitingOutput,
        details: { summary: waitingOutput.summary, steps: [], artifacts: waitingOutput.artifacts },
        waiting: waitingOutput.waiting,
      },
    },
  }, { now: Date.parse("2026-09-03T08:00:00.000Z") });

  assert.equal(result.state.timeline.some((e) => e.runId === runId && e.status === "completed"), false);
  assert.equal(result.state.pending[0].status, "waiting");
  assert.match(result.state.pending[0].output?.summary || "", /MR !1142/);
  assert.equal(result.state.runs[runId].status, "waiting");
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});
```

**Step 2: Run test to verify it fails**

Run: `node --test test/release-runtime-api.test.mjs --test-name-pattern "keeps Agent waiting"`

Expected: FAIL (pending promoted to empty completed or status overwritten).

**Step 3: Write minimal implementation**

In `reconcileReleaseState`, before treating manifest `completed` as release completed:

- Read `state.runs[runId]`.
- If `String(runRecord.status).toLowerCase() === "waiting"` (or `runRecord.output?.status === "waiting"`), set reconciled status to `waiting`, copy `output` / `details` / `waiting` from runRecord, push to **pending** (not timeline), and do **not** overwrite `runs[runId].status` to `completed`.
- If runRecord is already `completed`/`failed` with output, prefer that status+output over bare manifest.
- Only when runs has no terminal Agent status, keep today’s manifest→completed/failed behavior.

**Step 4: Run test to verify it passes**

Run: `node --test test/release-runtime-api.test.mjs --test-name-pattern "reconcileReleaseState|reconciles persisted"`

Expected: PASS (including existing restart reconcile tests).

**Step 5: Commit** (only if user asked to commit)

```bash
git add bin/lib/release-runtime-store.mjs test/release-runtime-api.test.mjs
git commit -m "$(cat <<'EOF'
fix: keep release waiting when reconciling completed manifests

EOF
)"
```

---

### Task 2: Client hydrate hollow timeline from `runs[runId]`

**Files:**
- Modify: `builtin/web-ui/src/components/ReleaseWorkflowPanel.jsx` (`mergeRemotePending` / state sync)
- Test: `test/release-workflow-panel-contract.test.mjs`

**Step 1: Write the failing contract assertions**

```js
test("hydrates hollow timeline entries from runs and surfaces stage outcomes on cards", async () => {
  const source = await readFile(panelPath, "utf8");
  assert.match(source, /hydrateTimelineFromRuns|function hydrateReleaseItemFromRuns/);
  assert.match(source, /af-release-stage-outcome/);
  assert.match(source, /af-release-artifact-chip/);
});
```

**Step 2: Run to verify fail**

Run: `node --test test/release-workflow-panel-contract.test.mjs --test-name-pattern "hydrates hollow"`

Expected: FAIL (symbols missing).

**Step 3: Implement hydrate helper**

```js
function hydrateReleaseItemFromRuns(item, runs = {}) {
  const runId = String(item?.runId || "").trim();
  const run = runId && runs[runId] && typeof runs[runId] === "object" ? runs[runId] : null;
  if (!run) return item;
  const hasSummary = Boolean(
    (item?.output && typeof item.output === "object" && item.output.summary)
    || item?.details?.summary
    || item?.message,
  );
  if (hasSummary && item.status && item.status !== "completed") return item;
  // Hollow completed + run waiting → prefer waiting pending semantics at display layer
  const runStatus = String(run.status || run.output?.status || "").toLowerCase();
  const next = { ...item };
  if (!hasSummary) {
    if (run.output) next.output = run.output;
    if (run.details) next.details = { ...(item.details || {}), ...run.details };
    if (run.waiting) next.waiting = run.waiting;
    if (run.message) next.message = run.message;
  }
  if (runStatus === "waiting" && String(item.status).toLowerCase() === "completed" && !hasSummary) {
    next.status = "waiting";
  }
  return next;
}
```

Apply when merging remote state: map timeline + pending through hydrate; if hydrated status is `waiting`, move from timeline into pending (filter hollow completed).

Also: when remote timeline has hollow completed for `nodeId` and pending has waiting for same node, **keep waiting pending** (do not filter by completedIds for that case).

**Step 4: Pass contract test**

Run: `node --test test/release-workflow-panel-contract.test.mjs --test-name-pattern "hydrates hollow|keeps waiting"`

**Step 5: Commit** (if requested)

---

### Task 3: Shared card outcome UI (timeline + pending)

**Files:**
- Modify: `builtin/web-ui/src/components/ReleaseWorkflowPanel.jsx`
- Modify: `builtin/web-ui/src/index.css`
- Test: `test/release-workflow-panel-contract.test.mjs` (extend Task 2 test)

**Step 1: Extend contract**

Assert render helper usage on both completed cards and pending cards:

```js
assert.match(source, /function renderStageOutcome/);
assert.match(source, /renderStageOutcome\(item\)/);
```

**Step 2: Implement `renderStageOutcome(item)`**

- Resolve summary via existing `pickSummary`-equivalent (reuse hydrate fields).
- Resolve artifacts via same rules as Inspector (`inferArtifactsFromText` / list from output.details) — either export small helpers to a shared `releaseStageOutcome.js` or duplicate minimally in panel (prefer extract to `builtin/web-ui/src/lib/releaseStageOutcome.js` if >40 lines).
- Truncate summary to ~120 chars / 2 lines CSS (`-webkit-line-clamp: 2`).
- Chips: max 3 links; `+N` for rest; `stopPropagation` on `<a>` so card click still opens Inspector elsewhere.
- Waiting reason line when `item.status === "waiting"`.

Wire into:
- Timeline `<article className="af-release-timeline-card ...">` after title/description.
- Pending `<article className="af-release-node ...">` after meta / before inputs.

**Step 3: CSS**

Add under existing release panel styles in `index.css`:

- `.af-release-stage-outcome` — compact block, surface_container_low
- `.af-release-artifact-chip` — secondary `#9ecaff` text, no heavy card chrome
- `.af-release-stage-outcome__summary` — line-clamp 2

Follow existing Orchestral Logic tokens (no new purple glow).

**Step 4: Rebuild UI**

Run: `cd builtin/web-ui && npm run build`

**Step 5: Commit** (if requested)

---

### Task 4: Inspector shows artifacts for waiting + hydrate on open

**Files:**
- Modify: `builtin/web-ui/src/components/ReleaseNodeInspector.jsx`
- Modify: `builtin/web-ui/src/components/ReleaseWorkflowPanel.jsx` (`openInspector`)
- Test: `test/release-node-inspector-contract.test.mjs`

**Step 1: Failing contract**

```js
test("inspector shows artifacts for waiting and hydrates empty output", async () => {
  const inspector = await readFile(new URL("../builtin/web-ui/src/components/ReleaseNodeInspector.jsx", import.meta.url), "utf8");
  assert.match(inspector, /artifacts\.length > 0/);
  // Artifacts not gated only on completedView
  assert.match(inspector, /waiting[\s\S]*ArtifactList|ArtifactList[\s\S]*waiting|!completedView && artifacts|artifacts\.length > 0 \? \(/);
});
```

Prefer explicit: show artifacts section when `artifacts.length > 0` regardless of `completedView` (remove `completedView &&` gate; keep Collapsible for pending/running if needed).

**Step 2: `openInspector` hydrate**

When opening, if panel holds `state.runs` or can read from last remote payload, pass hydrated item. Simplest: store `runs` on panel state from remote sync (`state.runs`), call `hydrateReleaseItemFromRuns(item, state.runs)` inside `openInspector`.

**Step 3: Run contracts + targeted runtime tests**

```bash
node --test test/release-runtime-api.test.mjs --test-name-pattern "reconcile"
node --test test/release-workflow-panel-contract.test.mjs test/release-node-inspector-contract.test.mjs
```

Expected: PASS.

**Step 4: Manual check**

Open `http://127.0.0.1:8765/releases?businessLine=likee&platform=android&version=5.64.0&batch=initial` (hard refresh). Confirm force-run era entry shows summary/MR or waiting card for !1142; Inspector shows full conclusion.

**Step 5: Commit** (if requested)

---

### Task 5: Docs touch-up

**Files:**
- Already created: `docs/plans/2026-09-03-release-stage-outcomes-artifacts-design.md`
- This plan: `docs/plans/2026-09-03-release-stage-outcomes-artifacts.md`

No extra product docs unless release operator docs exist — skip if none.

---

## Execution handoff

Plan saved to `docs/plans/2026-09-03-release-stage-outcomes-artifacts.md`.

**Which way do you want to execute?**

1. **Subagent-driven (this session)** — dispatch a fresh subagent per task, review between tasks  
2. **Inline (this session)** — run `executing-plans` and implement task-by-task in this chat  

Say **1** or **2**. Do not commit unless you explicitly ask.
