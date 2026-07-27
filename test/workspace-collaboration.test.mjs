import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("workspace collaboration supports legacy invites and persistent member add, revoke, and leave", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-collab-"));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = tempRoot;
  try {
    const moduleUrl = new URL(`../bin/lib/workspace-collaboration.mjs?test=${Date.now()}`, import.meta.url);
    const {
      acceptWorkspaceCollaborationInvite,
      addWorkspaceCollaborationMember,
      createWorkspaceCollaborationInvite,
      ensureWorkspaceCollaboration,
      getWorkspaceCollaborationByFlow,
      removeWorkspaceCollaborationMember,
      updateWorkspaceCollaborationFlow,
      workspaceCollaborationAccess,
    } = await import(moduleUrl);

    const created = ensureWorkspaceCollaboration({
      flowId: "shared-flow",
      userId: "owner",
    });
    assert.equal(created.created, true);
    assert.equal(created.workspace.role, "owner");

    const denied = workspaceCollaborationAccess(created.record, "guest");
    assert.equal(denied.allowed, false);

    const invite = createWorkspaceCollaborationInvite({
      workspaceId: created.workspace.id,
      userId: "owner",
      role: "editor",
    });
    assert.ok(invite.token);

    const accepted = acceptWorkspaceCollaborationInvite({
      token: invite.token,
      userId: "guest",
    });
    assert.equal(accepted.workspace.role, "editor");

    const stored = getWorkspaceCollaborationByFlow("shared-flow");
    assert.equal(workspaceCollaborationAccess(stored, "guest").writable, true);

    const added = addWorkspaceCollaborationMember({
      workspaceId: created.workspace.id,
      userId: "owner",
      memberUserId: "second-guest",
    });
    assert.equal(added.workspace.members.some((member) => member.userId === "second-guest"), true);
    assert.equal(workspaceCollaborationAccess(getWorkspaceCollaborationByFlow("shared-flow"), "second-guest").writable, true);

    const left = removeWorkspaceCollaborationMember({
      workspaceId: created.workspace.id,
      userId: "second-guest",
    });
    assert.equal(left.left, true);
    assert.equal(workspaceCollaborationAccess(getWorkspaceCollaborationByFlow("shared-flow"), "second-guest").allowed, false);

    addWorkspaceCollaborationMember({
      workspaceId: created.workspace.id,
      userId: "owner",
      memberUserId: "second-guest",
    });
    const revoked = removeWorkspaceCollaborationMember({
      workspaceId: created.workspace.id,
      userId: "owner",
      memberUserId: "second-guest",
    });
    assert.equal(revoked.left, false);
    assert.equal(revoked.removedUserId, "second-guest");

    updateWorkspaceCollaborationFlow({
      previousFlowId: "shared-flow",
      flowId: "renamed-flow",
      archived: true,
    });
    assert.equal(getWorkspaceCollaborationByFlow("shared-flow"), null);
    assert.equal(getWorkspaceCollaborationByFlow("renamed-flow", true)?.ownerId, "owner");
  } finally {
    if (previousHome == null) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
