import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-review-token-"));
process.env.AGENTFLOW_HOME = home;

const { createWorkspaceInterrupt, resolveWorkspaceInterrupt, consumeWorkspaceInterrupt } =
  await import("../bin/lib/workspace-interrupt.mjs");
const { createDisplayShareRecord, resolveWorkspaceReviewToken, findDisplayShareByReviewToken, readDisplayShares, writeDisplayShares } =
  await import("../bin/lib/workspace-server.mjs");
const { createWorkspaceRunLogSession, finishWorkspaceRunLogSession } =
  await import("../bin/lib/workspace-run-logs.mjs");

function share(runId, token) {
  return createDisplayShareRecord({
    userId: "owner",
    flowId: "demo-flow",
    flowSource: "user",
    title: "Plan",
    layout: "single",
    nodeIds: ["plan"],
    reviewToken: token,
    runId,
  });
}

function interrupt(runId, token) {
  return createWorkspaceInterrupt(runId, {
    flowId: "demo-flow",
    userId: "owner",
    nodeId: "approval",
    reason: "plan_confirmation",
    resumeToken: token,
    value: { content: "plan", format: "markdown" },
  });
}

test("an unknown token stays unknown", () => {
  assert.equal(resolveWorkspaceReviewToken("no-such-token").state, "unknown");
  assert.equal(resolveWorkspaceReviewToken("").state, "unknown");
});

test("a waiting interrupt is open", () => {
  const token = "token-open";
  share("run-open", token);
  interrupt("run-open", token);
  const view = resolveWorkspaceReviewToken(token);
  assert.equal(view.state, "open");
  assert.equal(view.interrupt.runId, "run-open");
});

test("a handled interrupt reports who handled it, not a dead link", () => {
  const token = "token-handled";
  share("run-handled", token);
  const created = interrupt("run-handled", token);
  resolveWorkspaceInterrupt("run-handled", created.interruptId, { decision: "reject", comment: "先不发" }, {
    resolvedBy: "reviewer-a",
  });
  consumeWorkspaceInterrupt("run-handled", created.interruptId);
  const view = resolveWorkspaceReviewToken(token);
  assert.equal(view.state, "resolved");
  assert.equal(view.interrupt.approvalStatus, "rejected");
  assert.equal(view.interrupt.reviewer, "reviewer-a");
});

test("a link sent before the approval node is pending, not expired", () => {
  const token = "token-pending";
  share("run-pending", token);
  createWorkspaceRunLogSession({ runId: "run-pending", flowId: "demo-flow", userId: "owner" });
  const view = resolveWorkspaceReviewToken(token);
  assert.equal(view.state, "pending");
  assert.equal(view.run.status, "running");
});

test("a run that died before the approval node loses the link", () => {
  const token = "token-lost";
  share("run-lost", token);
  createWorkspaceRunLogSession({ runId: "run-lost", flowId: "demo-flow", userId: "owner" });
  finishWorkspaceRunLogSession("run-lost", "failed", { error: "node exploded" });
  const view = resolveWorkspaceReviewToken(token);
  assert.equal(view.state, "lost");
  assert.equal(view.run.status, "failed");
  assert.equal(view.run.error, "node exploded");
});

test("a legacy share with no run binding is lost, not forever pending", () => {
  const token = "token-legacy";
  const record = share("", token);
  const shares = readDisplayShares();
  shares[record.id] = { ...shares[record.id], runId: "", createdAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() };
  writeDisplayShares(shares);
  assert.equal(resolveWorkspaceReviewToken(token).state, "lost");
});

test("a share record carries the run that issued the review token", () => {
  const token = "token-binding";
  share("run-binding", token);
  const found = findDisplayShareByReviewToken(token);
  assert.equal(found.runId, "run-binding");
  assert.equal(found.reviewToken, token);
});
