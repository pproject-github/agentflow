import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-interrupt-"));
process.env.AGENTFLOW_HOME = root;

const {
  createWorkspaceInterrupt,
  readWorkspaceInterrupt,
  resolveWorkspaceInterrupt,
  consumeWorkspaceInterrupt,
} = await import("../bin/lib/workspace-interrupt.mjs");

test("workspace interrupt persists, resolves once, and consumes", () => {
  const runId = "run-interrupt-test";
  const created = createWorkspaceInterrupt(runId, {
    flowId: "demo",
    nodeId: "confirm_plan",
    reason: "plan_confirmation",
    value: { content: "plan", format: "markdown" },
    cursor: { runStateRevision: 3 },
    resumeSchema: { type: "object", required: ["approved"] },
    approvers: ["reviewer", "reviewer"],
    approvalMode: "any",
  });
  assert.equal(created.status, "waiting");
  assert.deepEqual(created.approvers, ["reviewer"]);
  assert.equal(created.approvalStatus, "pending");
  assert.equal(readWorkspaceInterrupt(runId).interruptId, created.interruptId);
  assert.throws(
    () => resolveWorkspaceInterrupt(runId, created.interruptId, {}, { expectedRunStateRevision: 3 }),
    /missing required field: approved/,
  );

  const resolved = resolveWorkspaceInterrupt(runId, created.interruptId, { approved: true }, {
    expectedRunStateRevision: 3,
    resolvedBy: "tester",
    idempotencyKey: "event-1",
  });
  assert.equal(resolved.status, "resuming");
  assert.equal(resolved.resume.approved, true);
  assert.equal(resolved.approvalStatus, "approved");

  const consumed = consumeWorkspaceInterrupt(runId, created.interruptId);
  assert.equal(consumed.status, "resolved");
  assert.equal(consumeWorkspaceInterrupt(runId, created.interruptId), null);
  assert.throws(
    () => resolveWorkspaceInterrupt(runId, created.interruptId, { approved: true }),
    (error) => error.code === "INTERRUPT_ALREADY_RESUMED",
  );
});

test("workspace interrupt rejects a stale revision", () => {
  const runId = "run-interrupt-conflict";
  const created = createWorkspaceInterrupt(runId, {
    nodeId: "confirm",
    cursor: { runStateRevision: 5 },
  });
  assert.throws(
    () => resolveWorkspaceInterrupt(runId, created.interruptId, { approved: true }, { expectedRunStateRevision: 4 }),
    (error) => error.code === "INTERRUPT_REVISION_CONFLICT",
  );
});

test("workspace interrupt records a rejected approval", () => {
  const runId = "run-interrupt-reject-test";
  const created = createWorkspaceInterrupt(runId, {
    nodeId: "confirm",
    resumeSchema: { type: "object", required: ["approved"] },
  });
  const resolved = resolveWorkspaceInterrupt(runId, created.interruptId, {
    approved: false,
    decision: "reject",
    comment: "需要补充风险说明",
  }, { resolvedBy: "tester" });
  assert.equal(resolved.approvalStatus, "rejected");
  assert.equal(resolved.reviewComment, "需要补充风险说明");
});
