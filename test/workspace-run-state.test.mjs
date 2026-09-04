import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import os from "node:os";
import path from "node:path";

import {
  appendWorkspaceRunState,
  appendWorkspaceRunStateCheckpoint,
  createWorkspaceRunState,
  getWorkspaceRunStateValue,
  patchWorkspaceRunState,
  readWorkspaceRunState,
  readWorkspaceRunStateEvents,
  replaceWorkspaceRunState,
  workspaceRunStateEventsPath,
  workspaceRunStateCheckpointsPath,
  workspaceRunStatePath,
  readWorkspaceRunStateCheckpoint,
} from "../bin/lib/workspace-run-state.mjs";

test("Run State supports isolated patch, replace, append and redaction", () => {
  const runId = `state-test-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const previousRoot = process.env.AGENTFLOW_RUN_STATE_ROOT;
  const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-run-state-test-"));
  process.env.AGENTFLOW_RUN_STATE_ROOT = testRoot;
  try {
    createWorkspaceRunState(runId, { plan: { version: 1 }, tasks: [], token: "do-not-store" }, {
      schema: { version: 1, initial: { plan: {}, tasks: [] }, reducers: { plan: "replace", tasks: "append" } },
    });
    const patched = patchWorkspaceRunState(runId, { plan: { approved: true }, tasks: [{ id: "t1" }] }, { nodeId: "planner" });
    assert.equal(patched.revision, 1);
    assert.equal(getWorkspaceRunStateValue(runId, "plan.approved"), true);
    assert.equal(getWorkspaceRunStateValue(runId, "token"), "***");
    const appended = appendWorkspaceRunState(runId, "tasks", { id: "t2", password: "hidden" }, { nodeId: "worker" });
    assert.equal(appended.revision, 2);
    assert.equal(readWorkspaceRunState(runId).state.tasks.length, 2);
    assert.equal(readWorkspaceRunState(runId).state.tasks[1].password, "***");
    const replaced = replaceWorkspaceRunState(runId, { done: true }, { nodeId: "final" });
    assert.equal(replaced.revision, 3);
    assert.deepEqual(readWorkspaceRunState(runId).state, { done: true });
    const events = readWorkspaceRunStateEvents(runId);
    assert.equal(events.filter((event) => event.type === "run-state-updated").length, 3);
    assert.ok(events.every((event) => !JSON.stringify(event).includes("do-not-store")));
    assert.throws(() => patchWorkspaceRunState(runId, { late: true }, { expectedRevision: 0 }), /revision conflict/);
    const checkpoint = appendWorkspaceRunStateCheckpoint(runId, {
      nodeId: "final",
      status: "completed",
      graphRevision: "graph-7",
      cursor: { completedNodeIds: ["final"], nextNodeIds: [] },
    });
    assert.equal(checkpoint.version, 2);
    assert.equal(checkpoint.recordType, "checkpoint");
    assert.match(checkpoint.checkpointId, /^ckpt_/);
    assert.equal(checkpoint.graphRevision, "graph-7");
    assert.deepEqual(checkpoint.cursor.nextNodeIds, []);
    assert.equal(readWorkspaceRunStateCheckpoint(runId, checkpoint.checkpointId).checkpointId, checkpoint.checkpointId);
    const finished = appendWorkspaceRunStateCheckpoint(runId, { nodeId: "", status: "finished" });
    assert.equal(finished.parentCheckpointId, checkpoint.checkpointId);
    const checkpointLines = fs.readFileSync(workspaceRunStateCheckpointsPath(runId), "utf-8").trim().split(/\r?\n/);
    assert.equal(JSON.parse(checkpointLines[0]).status, "completed");
  } finally {
    fs.rmSync(workspaceRunStatePath(runId), { force: true });
    fs.rmSync(workspaceRunStateEventsPath(runId), { force: true });
    fs.rmSync(workspaceRunStateCheckpointsPath(runId), { force: true });
    fs.rmSync(testRoot, { recursive: true, force: true });
    if (previousRoot == null) delete process.env.AGENTFLOW_RUN_STATE_ROOT;
    else process.env.AGENTFLOW_RUN_STATE_ROOT = previousRoot;
  }
});
