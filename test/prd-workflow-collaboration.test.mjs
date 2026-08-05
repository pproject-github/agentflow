import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("PRD Workflow sharing is keyed by TAPD ID instead of Project", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-prd-collab-"));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = tempRoot;
  try {
    const moduleUrl = new URL(`../bin/lib/prd-workflow-collaboration.mjs?test=${Date.now()}`, import.meta.url);
    const {
      addPrdWorkflowCollaborationMember,
      ensurePrdWorkflowCollaboration,
      getPrdWorkflowCollaborationForUser,
      prdWorkflowCollaborationAccess,
      removePrdWorkflowCollaborationMember,
      syncPrdWorkflowAuthority,
    } = await import(moduleUrl);

    const created = ensurePrdWorkflowCollaboration({
      tapdId: "1015046",
      userId: "owner",
    });
    assert.equal(created.created, true);
    assert.equal(created.workflow.tapdId, "1015046");
    assert.equal(created.workflow.role, "owner");

    const added = addPrdWorkflowCollaborationMember({
      workflowId: created.workflow.id,
      userId: "owner",
      memberUserId: "guest",
    });
    assert.equal(added.workflow.members.some((member) => member.userId === "guest"), true);

    const shared = getPrdWorkflowCollaborationForUser("1015046", "guest");
    assert.equal(shared.id, created.workflow.id);
    assert.equal(prdWorkflowCollaborationAccess(shared, "guest").writable, true);
    assert.equal(prdWorkflowCollaborationAccess(shared, "guest").role, "reporter");

    const unrelated = getPrdWorkflowCollaborationForUser("1015046", "outsider");
    assert.equal(unrelated, null);

    const left = removePrdWorkflowCollaborationMember({
      workflowId: created.workflow.id,
      userId: "guest",
    });
    assert.equal(left.left, true);
    assert.equal(getPrdWorkflowCollaborationForUser("1015046", "guest"), null);

    const synced = syncPrdWorkflowAuthority({
      tapdId: "10001",
      userId: "tapd-owner",
      ownerUserId: "tapd-owner",
      ownerIdentity: "tapd-owner",
      participantUserIds: ["participant", "tapd-owner"],
      participantIdentities: ["participant", "missing-user"],
      unresolvedParticipants: ["missing-user"],
      observedAt: "2026-08-05T10:00:00+08:00",
      revision: "tapd-r1",
    });
    assert.equal(synced.created, true);
    assert.equal(synced.workflow.ownerSource, "tapd");
    assert.equal(prdWorkflowCollaborationAccess(synced.record, "participant").role, "viewer");
    assert.equal(prdWorkflowCollaborationAccess(synced.record, "participant").source, "tapd");
    assert.equal(prdWorkflowCollaborationAccess(synced.record, "participant").writable, false);

    const promoted = addPrdWorkflowCollaborationMember({
      workflowId: synced.record.id,
      userId: "tapd-owner",
      memberUserId: "participant",
      role: "reporter",
    });
    assert.equal(promoted.error, undefined);
    assert.equal(addPrdWorkflowCollaborationMember({
      workflowId: synced.record.id,
      userId: "tapd-owner",
      memberUserId: "another-user",
      role: "owner",
    }).status, 400);
    const promotedRecord = getPrdWorkflowCollaborationForUser("10001", "participant");
    assert.equal(prdWorkflowCollaborationAccess(promotedRecord, "participant").role, "reporter");
    assert.equal(prdWorkflowCollaborationAccess(promotedRecord, "participant").source, "explicit");

    const demoted = removePrdWorkflowCollaborationMember({
      workflowId: synced.record.id,
      userId: "tapd-owner",
      memberUserId: "participant",
    });
    assert.equal(demoted.error, undefined);
    const demotedRecord = getPrdWorkflowCollaborationForUser("10001", "participant");
    assert.equal(prdWorkflowCollaborationAccess(demotedRecord, "participant").role, "viewer");
    assert.equal(prdWorkflowCollaborationAccess(demotedRecord, "participant").source, "tapd");
  } finally {
    if (previousHome == null) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("a TAPD ID has one canonical shared Workflow owner", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-prd-collab-conflict-"));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = tempRoot;
  try {
    const moduleUrl = new URL(`../bin/lib/prd-workflow-collaboration.mjs?test=${Date.now()}-conflict`, import.meta.url);
    const {
      addPrdWorkflowCollaborationMember,
      ensurePrdWorkflowCollaboration,
    } = await import(moduleUrl);
    const first = ensurePrdWorkflowCollaboration({ tapdId: "1015046", userId: "owner-a" });
    const second = ensurePrdWorkflowCollaboration({ tapdId: "1015046", userId: "owner-b" });
    assert.equal(second.status, 403);
    assert.match(second.error, /another owner/);
    assert.equal(addPrdWorkflowCollaborationMember({
      workflowId: first.workflow.id,
      userId: "owner-a",
      memberUserId: "guest",
    }).error, undefined);
    assert.equal(first.workflow.tapdId, "1015046");
  } finally {
    if (previousHome == null) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("PRD Workflow share links are opaque, stable, and revocable", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-prd-share-link-"));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = tempRoot;
  try {
    const moduleUrl = new URL(`../bin/lib/prd-workflow-collaboration.mjs?test=${Date.now()}-share-link`, import.meta.url);
    const {
      ensurePrdWorkflowShareLink,
      getPrdWorkflowCollaborationByShareToken,
      revokePrdWorkflowShareLink,
    } = await import(moduleUrl);

    const created = ensurePrdWorkflowShareLink({ tapdId: "1015046", userId: "owner" });
    assert.equal(created.created, true);
    assert.match(created.shareToken, /^[A-Za-z0-9_-]{32}$/);
    assert.equal(getPrdWorkflowCollaborationByShareToken(created.shareToken)?.ownerId, "owner");

    const repeated = ensurePrdWorkflowShareLink({ tapdId: "1015046", userId: "owner" });
    assert.equal(repeated.created, false);
    assert.equal(repeated.shareToken, created.shareToken);

    const revoked = revokePrdWorkflowShareLink({ tapdId: "1015046", userId: "owner" });
    assert.equal(revoked.revoked, true);
    assert.equal(getPrdWorkflowCollaborationByShareToken(created.shareToken), null);
  } finally {
    if (previousHome == null) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("TAPD authority sync protects bootstrap, stale snapshots, and owner transfer", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-prd-authority-"));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = tempRoot;
  try {
    const moduleUrl = new URL(`../bin/lib/prd-workflow-collaboration.mjs?test=${Date.now()}-authority`, import.meta.url);
    const {
      getPrdWorkflowCollaborationByTapdId,
      prdWorkflowCollaborationAccess,
      syncPrdWorkflowAuthority,
    } = await import(moduleUrl);
    const denied = syncPrdWorkflowAuthority({
      tapdId: "20001",
      userId: "participant",
      ownerUserId: "owner-a",
      participantUserIds: ["participant"],
    });
    assert.equal(denied.status, 403);

    const created = syncPrdWorkflowAuthority({
      tapdId: "20001",
      userId: "owner-a",
      ownerUserId: "owner-a",
      participantUserIds: ["participant"],
      observedAt: "2026-08-05T10:00:00+08:00",
    });
    assert.equal(created.created, true);

    const stale = syncPrdWorkflowAuthority({
      tapdId: "20001",
      userId: "owner-a",
      ownerUserId: "owner-a",
      participantUserIds: [],
      observedAt: "2026-08-05T09:59:59+08:00",
    });
    assert.equal(stale.status, 409);
    assert.equal(prdWorkflowCollaborationAccess(getPrdWorkflowCollaborationByTapdId("20001"), "participant").role, "viewer");

    const transferred = syncPrdWorkflowAuthority({
      tapdId: "20001",
      userId: "owner-a",
      ownerUserId: "owner-b",
      participantUserIds: ["owner-a"],
      observedAt: "2026-08-05T11:00:00+08:00",
    });
    assert.equal(transferred.ownerChanged, true);
    assert.equal(transferred.previousOwnerId, "owner-a");
    const record = getPrdWorkflowCollaborationByTapdId("20001");
    assert.equal(record.ownerId, "owner-b");
    assert.equal(prdWorkflowCollaborationAccess(record, "owner-b").role, "owner");
    assert.equal(prdWorkflowCollaborationAccess(record, "owner-a").role, "viewer");
  } finally {
    if (previousHome == null) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
