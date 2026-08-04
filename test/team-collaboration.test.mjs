import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("teams enforce one active membership and drive project and iteration access", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-teams-"));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = tempRoot;
  try {
    const nonce = Date.now();
    const teams = await import(`../bin/lib/teams.mjs?teams=${nonce}`);
    const workspaces = await import(`../bin/lib/workspace-collaboration.mjs?teams=${nonce}`);
    const workflows = await import(`../bin/lib/prd-workflow-collaboration.mjs?teams=${nonce}`);

    const android = teams.createTeam({ name: "Android" }).team;
    const ios = teams.createTeam({ name: "iOS" }).team;
    assert.ok(android.id.startsWith("team_"));
    assert.equal(teams.createTeam({ name: "android" }).status, 409);

    teams.setTeamMembers(android.id, ["owner", "guest"]);
    assert.equal(teams.getTeamForUser("guest").id, android.id);
    teams.setTeamMembers(ios.id, ["other", "guest"]);
    assert.equal(teams.getTeamForUser("guest").id, ios.id);
    assert.equal(teams.getTeamById(android.id).members.includes("guest"), false);
    teams.setTeamMembers(android.id, ["owner", "guest"]);

    const project = workspaces.ensureWorkspaceCollaboration({
      flowId: "team-project",
      flowSource: "user",
      userId: "owner",
    });
    const shared = workspaces.setWorkspaceCollaborationTeamShare({
      workspaceId: project.workspace.id,
      userId: "owner",
      teamId: android.id,
      role: "viewer",
    });
    assert.equal(shared.workspace.teamShares[0].teamId, android.id);
    let storedProject = workspaces.getWorkspaceCollaborationById(project.workspace.id);
    assert.deepEqual(workspaces.workspaceCollaborationAccess(storedProject, "guest"), {
      allowed: true,
      writable: false,
      runnable: false,
      role: "viewer",
      source: "team",
      teamId: android.id,
    });
    assert.equal(workspaces.listWorkspaceCollaborationsForUser("guest").length, 1);
    workspaces.removeWorkspaceCollaborationTeamShare({
      workspaceId: project.workspace.id,
      userId: "owner",
      teamId: android.id,
    });
    storedProject = workspaces.getWorkspaceCollaborationById(project.workspace.id);
    assert.equal(workspaces.workspaceCollaborationAccess(storedProject, "guest").allowed, false);

    const iteration = workflows.ensurePrdWorkflowCollaboration({ tapdId: "12345", userId: "owner" });
    assert.equal(iteration.workflow.teamId, android.id);
    assert.equal(workflows.listPrdWorkflowCollaborationsForTeam(android.id).length, 1);
    assert.equal(workflows.listPrdWorkflowCollaborationsForUser("guest").length, 0);
    const iterationAccess = workflows.prdWorkflowCollaborationAccess(iteration.record, "guest");
    assert.equal(iterationAccess.allowed, true);
    assert.equal(iterationAccess.writable, false);
    assert.equal(iterationAccess.source, "team");

    assert.equal(teams.deleteTeam(android.id).status, 409);
    teams.setTeamMembers(android.id, []);
    assert.equal(teams.deleteTeam(android.id).deleted, true);
  } finally {
    if (previousHome == null) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
