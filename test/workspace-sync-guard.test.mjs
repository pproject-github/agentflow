import assert from "node:assert/strict";
import test from "node:test";

import {
  workspaceBackgroundLoadSkipReason,
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
