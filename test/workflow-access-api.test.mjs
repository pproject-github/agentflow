import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("Workflow access sync derives TAPD viewers and preserves state across owner transfer", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-workflow-access-api-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = dataRoot;
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?workflow-access=${nonce}`),
      import(`../bin/lib/ui-server.mjs?workflow-access=${nonce}`),
    ]);
    const owner = loginOrCreateUser("tapd-owner", "owner-password");
    const participant = loginOrCreateUser("tapd-participant", "participant-password");
    const nextOwner = loginOrCreateUser("tapd-next-owner", "next-owner-password");
    server = await startUiServer({
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const request = (token, pathname, init = {}) => fetch(`${baseUrl}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    });
    const syncBody = {
      workflow: { namespace: "tapd", id: "30001" },
      authority: {
        type: "tapd",
        owner: { username: "tapd-owner" },
        participants: ["tapd-participant", "not-registered"],
        observedAt: "2026-08-05T10:00:00+08:00",
        revision: "tapd-30001-r1",
      },
    };

    const denied = await request(participant.token, "/api/workflows/access/sync", {
      method: "POST",
      body: JSON.stringify(syncBody),
    });
    assert.equal(denied.status, 403);

    const synced = await request(owner.token, "/api/workflows/access/sync", {
      method: "POST",
      body: JSON.stringify(syncBody),
    });
    const syncedPayload = await synced.json();
    assert.equal(synced.status, 200, JSON.stringify(syncedPayload));
    assert.equal(syncedPayload.collaboration.ownerUsername, "tapd-owner");
    assert.equal(syncedPayload.collaboration.ownerSource, "tapd");
    assert.deepEqual(syncedPayload.unresolvedParticipants, ["not-registered"]);
    assert.equal(
      syncedPayload.collaboration.members.find((member) => member.username === "tapd-participant")?.role,
      "viewer",
    );

    const participantDashboard = await request(participant.token, "/api/prd-workflows");
    const participantDashboardPayload = await participantDashboard.json();
    assert.equal(participantDashboard.status, 200, JSON.stringify(participantDashboardPayload));
    assert.equal(participantDashboardPayload.workflows[0].role, "viewer");

    const promoted = await request(owner.token, "/api/prd-workflow/collaboration/share", {
      method: "POST",
      body: JSON.stringify({ tapdId: "30001", username: "tapd-participant", role: "reporter" }),
    });
    const promotedPayload = await promoted.json();
    assert.equal(promoted.status, 200, JSON.stringify(promotedPayload));
    assert.equal(promotedPayload.member.role, "reporter");
    assert.equal(promotedPayload.collaboration.members.find((member) => member.userId === participant.user.userId)?.source, "explicit");

    const report = await request(participant.token, "/api/workflows/report", {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        workflow: { namespace: "tapd", id: "30001" },
        source: "access-api-test",
        globalState: { mode: "merge", patch: { title: "TAPD authority state" } },
      }),
    });
    const reportPayload = await report.json();
    assert.equal(report.status, 200, JSON.stringify(reportPayload));

    const transferred = await request(owner.token, "/api/workflows/access/sync", {
      method: "POST",
      body: JSON.stringify({
        workflow: { namespace: "tapd", id: "30001" },
        authority: {
          type: "tapd",
          owner: "tapd-next-owner",
          participants: ["tapd-owner", "tapd-participant"],
          observedAt: "2026-08-05T11:00:00+08:00",
          revision: "tapd-30001-r2",
        },
      }),
    });
    const transferredPayload = await transferred.json();
    assert.equal(transferred.status, 200, JSON.stringify(transferredPayload));
    assert.equal(transferredPayload.ownerChanged, true);
    assert.equal(transferredPayload.collaboration.ownerUsername, "tapd-next-owner");

    const state = await request(nextOwner.token, "/api/workflows/state?workflow=tapd%3A30001");
    const statePayload = await state.json();
    assert.equal(state.status, 200, JSON.stringify(statePayload));
    assert.equal(statePayload.snapshot.globalState.title, "TAPD authority state");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome == null) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
