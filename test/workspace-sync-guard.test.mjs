import assert from "node:assert/strict";
import test from "node:test";

import {
  coalesceWorkspaceSaveRequest,
  shouldSkipWorkspaceRemoteRefresh,
  workspaceCanvasInteractionPhase,
  workspaceBackgroundLoadSkipReason,
  workspaceLoadResourcePlan,
  workspaceSaveBaselineAfterSuccess,
} from "../builtin/web-ui/src/workspaceSyncGuard.js";

const cleanLoad = {
  background: true,
  requestId: 3,
  currentRequestId: 3,
  dirty: false,
  startedEditVersion: 7,
  currentEditVersion: 7,
  startedRevision: "revision-a",
  currentRevision: "revision-a",
};

test("background workspace refresh applies while the local graph stays clean", () => {
  assert.equal(workspaceBackgroundLoadSkipReason(cleanLoad), "");
});

test("background workspace refresh never overwrites edits made while its request is in flight", () => {
  assert.equal(workspaceBackgroundLoadSkipReason({ ...cleanLoad, dirty: true }), "local-edits");
  assert.equal(workspaceBackgroundLoadSkipReason({ ...cleanLoad, currentEditVersion: 8 }), "local-edits");
  assert.equal(workspaceBackgroundLoadSkipReason({ ...cleanLoad, currentRevision: "revision-b" }), "local-edits");
});

test("an older workspace refresh cannot overwrite a newer refresh", () => {
  assert.equal(
    workspaceBackgroundLoadSkipReason({ ...cleanLoad, requestId: 2 }),
    "superseded",
  );
});

test("a successful save always advances the baseline before a queued edit is saved", () => {
  const sentGraph = { ui: { nodePositions: { table: { x: 10, y: 20 } } } };
  const savedGraph = structuredClone(sentGraph);
  const baseline = workspaceSaveBaselineAfterSuccess({
    savedGraph,
    sentGraph,
    savedRevision: "revision-b",
    currentRevision: "revision-a",
  });

  assert.equal(baseline.revision, "revision-b");
  assert.deepEqual(baseline.graph, savedGraph);
});

test("node movement is active while dragging and finishes on mouse release", () => {
  assert.deepEqual(
    workspaceCanvasInteractionPhase([
      { type: "position", id: "table", position: { x: 20, y: 30 }, dragging: true },
    ]),
    { active: true, finished: false, mutated: true },
  );
  assert.deepEqual(
    workspaceCanvasInteractionPhase([
      { type: "position", id: "table", position: { x: 40, y: 50 }, dragging: false },
    ]),
    { active: false, finished: true, mutated: true },
  );
});

test("node resizing is active while resizing and finishes on mouse release", () => {
  assert.deepEqual(
    workspaceCanvasInteractionPhase([
      { type: "dimensions", id: "table", dimensions: { width: 640, height: 420 }, resizing: true },
    ]),
    { active: true, finished: false, mutated: true },
  );
  assert.deepEqual(
    workspaceCanvasInteractionPhase([
      { type: "dimensions", id: "table", dimensions: { width: 680, height: 460 }, resizing: false },
    ]),
    { active: false, finished: true, mutated: true },
  );
});

test("latest-only saves keep every waiter but replace the pending graph snapshot", () => {
  const firstWaiter = { id: "first" };
  const latestWaiter = { id: "latest" };
  const result = coalesceWorkspaceSaveRequest(
    { nextNodes: ["old"], saveEditVersion: 1, waiters: [firstWaiter] },
    { nextNodes: ["latest"], saveEditVersion: 2, waiters: [latestWaiter] },
  );

  assert.deepEqual(result.nextNodes, ["latest"]);
  assert.equal(result.saveEditVersion, 2);
  assert.deepEqual(result.waiters, [firstWaiter, latestWaiter]);
});

test("background workspace refresh only requests the graph", () => {
  assert.deepEqual(
    workspaceLoadResourcePlan({ background: true }),
    { graph: true, nodes: false, files: false },
  );
  assert.deepEqual(
    workspaceLoadResourcePlan({ background: false }),
    { graph: true, nodes: true, files: true },
  );
});

test("remote graph notifications skip current and already queued revisions", () => {
  assert.equal(shouldSkipWorkspaceRemoteRefresh({
    eventType: "graph.committed",
    revision: "revision-b",
    currentRevision: "revision-b",
  }), true);
  assert.equal(shouldSkipWorkspaceRemoteRefresh({
    eventType: "graph.committed",
    revision: "revision-c",
    currentRevision: "revision-b",
    targetRevision: "revision-c",
    refreshPending: true,
  }), true);
  assert.equal(shouldSkipWorkspaceRemoteRefresh({
    eventType: "graph.committed",
    revision: "revision-c",
    currentRevision: "revision-b",
    targetRevision: "revision-c",
    refreshPending: false,
  }), false);
  assert.equal(shouldSkipWorkspaceRemoteRefresh({
    eventType: "runtime.committed",
    revision: "revision-b",
    currentRevision: "revision-b",
    refreshPending: true,
  }), false);
});
