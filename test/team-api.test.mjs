import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("team APIs manage membership and expose team-scoped iterations and projects", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-team-api-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = dataRoot;
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }, workflows] = await Promise.all([
      import(`../bin/lib/auth.mjs?team-api=${nonce}`),
      import(`../bin/lib/ui-server.mjs?team-api=${nonce}`),
      import(`../bin/lib/prd-workflow-collaboration.mjs?team-api=${nonce}`),
    ]);
    const admin = loginOrCreateUser("team-admin", "admin-password");
    const guest = loginOrCreateUser("team-guest", "guest-password");
    server = await startUiServer({ workspaceRoot, host: "127.0.0.1", port: 0, staticDir: path.join(tempRoot, "static") });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const request = async (token, pathname, init = {}) => fetch(`${baseUrl}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    });

    const forbidden = await request(guest.token, "/api/admin/teams");
    assert.equal(forbidden.status, 403);

    const create = await request(admin.token, "/api/admin/teams", {
      method: "POST",
      body: JSON.stringify({ name: "Platform" }),
    });
    const created = await create.json();
    assert.equal(create.status, 200, JSON.stringify(created));
    const teamId = created.team.id;

    const assign = await request(admin.token, "/api/admin/teams", {
      method: "PUT",
      body: JSON.stringify({ teamId, members: [admin.user.userId, guest.user.userId] }),
    });
    assert.equal(assign.status, 200, await assign.text());

    const mine = await request(guest.token, "/api/teams/me");
    const minePayload = await mine.json();
    assert.equal(minePayload.team.id, teamId);
    assert.equal(minePayload.team.members.some((member) => member.userId === guest.user.userId), true);

    const personalFlowDir = path.join(dataRoot, "users", admin.user.userId, "pipelines", "team-shared-flow");
    fs.mkdirSync(personalFlowDir, { recursive: true });
    fs.writeFileSync(path.join(personalFlowDir, "flow.yaml"), "version: 1\ninstances: {}\nedges: []\n", "utf-8");

    const share = await request(admin.token, "/api/workspace/collaboration/team-share", {
      method: "POST",
      body: JSON.stringify({ flowId: "team-shared-flow", flowSource: "user", teamId, role: "viewer" }),
    });
    const sharePayload = await share.json();
    assert.equal(share.status, 200, JSON.stringify(sharePayload));
    assert.equal(sharePayload.workspace.teamShares[0].teamId, teamId);

    const teamFlows = await request(guest.token, "/api/flows?view=team");
    const teamFlowRows = await teamFlows.json();
    assert.equal(teamFlowRows.some((flow) => flow.id === "team-shared-flow" && flow.collaboration.accessSource === "team"), true);
    const personalFlows = await request(guest.token, "/api/flows?view=personal");
    const personalFlowRows = await personalFlows.json();
    assert.equal(personalFlowRows.some((flow) => flow.id === "team-shared-flow"), false);

    workflows.ensurePrdWorkflowCollaboration({ tapdId: "778899", userId: admin.user.userId });
    const projectionReport = await request(admin.token, "/api/workflows/report", {
      method: "POST",
      body: JSON.stringify({
        workflow: { namespace: "tapd", id: "778899" },
        projections: {
          timeline: [{
            kind: "release",
            id: "platform-august",
            title: "Platform August",
            date: "2026-08-20",
            source: "prd-flow",
            dimensions: { platform: "all" },
          }],
        },
        idempotencyKey: "team-api-projection",
      }),
    });
    assert.equal(projectionReport.status, 200, await projectionReport.text());
    const teamIterations = await request(guest.token, "/api/prd-workflows?view=team");
    const teamIterationPayload = await teamIterations.json();
    assert.equal(teamIterationPayload.team.id, teamId);
    assert.equal(teamIterationPayload.workflows.some((workflow) => workflow.tapdId === "778899"), true);
    assert.equal(teamIterationPayload.timeline[0].id, "platform-august");
    assert.equal(teamIterationPayload.timeline[0].workflowCount, 1);
    const personalIterations = await request(guest.token, "/api/prd-workflows?view=personal");
    const personalIterationPayload = await personalIterations.json();
    assert.equal(personalIterationPayload.workflows.some((workflow) => workflow.tapdId === "778899"), false);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome == null) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
