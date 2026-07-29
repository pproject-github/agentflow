import assert from "node:assert/strict";
import test from "node:test";

import {
  coalesceWorkspaceCanvasChanges,
  coalesceWorkspaceSaveRequest,
  finalizeWorkspaceCanvasChanges,
  partitionWorkspaceCanvasChanges,
  shouldSkipWorkspaceRemoteRefresh,
  workspaceCanvasChangeFinishesInteraction,
  workspaceCanvasChangeIsContinuous,
  workspaceCanvasInteractionCommitsChanges,
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
  const dragging = [
    { type: "position", id: "table", position: { x: 20, y: 30 }, dragging: true },
  ];
  const released = [
    { type: "position", id: "table", position: { x: 40, y: 50 }, dragging: false },
  ];
  assert.deepEqual(
    workspaceCanvasInteractionPhase(dragging),
    { active: true, finished: false, mutated: true },
  );
  assert.deepEqual(
    workspaceCanvasInteractionPhase(released),
    { active: false, finished: true, mutated: true },
  );
  assert.equal(workspaceCanvasInteractionCommitsChanges(dragging), false);
  assert.equal(workspaceCanvasInteractionCommitsChanges(released), true);
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

test("continuous canvas changes keep only the latest value for each node and change type", () => {
  const selection = { type: "select", id: "table", selected: true };
  const result = coalesceWorkspaceCanvasChanges([
    { type: "position", id: "table", position: { x: 10, y: 20 }, dragging: true },
    selection,
    { type: "position", id: "chart", position: { x: 30, y: 40 }, dragging: true },
    { type: "position", id: "table", position: { x: 50, y: 60 }, dragging: true },
    { type: "dimensions", id: "table", dimensions: { width: 600, height: 400 }, resizing: true },
    { type: "dimensions", id: "table", dimensions: { width: 640, height: 420 }, resizing: true },
  ]);

  assert.deepEqual(result, [
    { type: "position", id: "table", position: { x: 50, y: 60 }, dragging: true },
    selection,
    { type: "position", id: "chart", position: { x: 30, y: 40 }, dragging: true },
    { type: "dimensions", id: "table", dimensions: { width: 640, height: 420 }, resizing: true },
  ]);
});

test("dragging stays transient until the final position is committed", () => {
  const dragging = { type: "position", id: "table", position: { x: 50, y: 60 }, dragging: true };
  const released = { type: "position", id: "table", position: { x: 70, y: 80 }, dragging: false };
  const selection = { type: "select", id: "table", selected: true };

  assert.deepEqual(partitionWorkspaceCanvasChanges([dragging]), {
    transient: [dragging],
    committed: [],
    finishesInteraction: false,
  });
  assert.deepEqual(partitionWorkspaceCanvasChanges([released, selection]), {
    transient: [],
    committed: [released, selection],
    finishesInteraction: true,
  });
});

test("finishing a canvas interaction commits queued positions and dimensions as final", () => {
  const result = finalizeWorkspaceCanvasChanges([
    { type: "position", id: "table", position: { x: 10, y: 20 }, dragging: true },
    { type: "position", id: "table", position: { x: 70, y: 80 }, dragging: false },
    { type: "dimensions", id: "chart", dimensions: { width: 700, height: 480 }, resizing: true },
  ]);

  assert.deepEqual(result, [
    { type: "position", id: "table", position: { x: 70, y: 80 }, dragging: false },
    { type: "dimensions", id: "chart", dimensions: { width: 700, height: 480 }, resizing: false },
  ]);
  assert.equal(workspaceCanvasChangeIsContinuous(result[0]), false);
  assert.equal(workspaceCanvasChangeFinishesInteraction(result[0]), true);
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
