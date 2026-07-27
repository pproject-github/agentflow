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

    const unrelated = getPrdWorkflowCollaborationForUser("1015046", "outsider");
    assert.equal(unrelated, null);

    const left = removePrdWorkflowCollaborationMember({
      workflowId: created.workflow.id,
      userId: "guest",
    });
    assert.equal(left.left, true);
    assert.equal(getPrdWorkflowCollaborationForUser("1015046", "guest"), null);
  } finally {
    if (previousHome == null) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("a user cannot join two shared Workflows for the same TAPD ID", async () => {
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
    assert.equal(addPrdWorkflowCollaborationMember({
      workflowId: first.workflow.id,
      userId: "owner-a",
      memberUserId: "guest",
    }).error, undefined);
    const conflict = addPrdWorkflowCollaborationMember({
      workflowId: second.workflow.id,
      userId: "owner-b",
      memberUserId: "guest",
    });
    assert.equal(conflict.status, 409);
  } finally {
    if (previousHome == null) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
