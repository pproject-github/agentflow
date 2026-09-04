import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function writeFlow(dataRoot, userId, flowId) {
  const flowDir = path.join(dataRoot, "users", userId, "pipelines", flowId);
  fs.mkdirSync(flowDir, { recursive: true });
  fs.writeFileSync(path.join(flowDir, "workspace.graph.json"), `${JSON.stringify({ version: 1, instances: {}, edges: [], ui: {} }, null, 2)}\n`, "utf8");
  return flowDir;
}

test("admin reassigns a legacy Project to a CAS user without losing schedule or collaboration ownership", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-project-owner-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  let server;
  try {
    const nonce = Date.now();
    const [{ loginAdminUser, loginOrCreateUser, loginCasUser }, collaboration, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?project-owner=${nonce}`),
      import(`../bin/lib/workspace-collaboration.mjs?project-owner=${nonce}`),
      import(`../bin/lib/ui-server.mjs?project-owner=${nonce}`),
    ]);
    const admin = loginAdminUser("owner-admin", "admin-password");
    const legacy = loginOrCreateUser("legacy-owner", "legacy-password");
    const target = loginCasUser({ username: "cas-owner", attributes: { displayName: "CAS Owner" } });
    const sourceDir = writeFlow(process.env.AGENTFLOW_HOME, legacy.user.userId, "daily-report");
    const collab = collaboration.ensureWorkspaceCollaboration({
      flowId: "daily-report",
      flowSource: "user",
      archived: false,
      userId: legacy.user.userId,
    });
    const scheduleKey = `${legacy.user.userId}:user:daily-report:schedule`;
    fs.writeFileSync(path.join(process.env.AGENTFLOW_HOME, "workspace-schedules.json"), `${JSON.stringify({
      version: 1,
      schedules: {
        [scheduleKey]: {
          key: scheduleKey,
          userId: legacy.user.userId,
          username: legacy.user.username,
          flowId: "daily-report",
          flowSource: "user",
          scheduleNodeId: "schedule",
          runNodeId: "schedule",
          enabled: true,
        },
      },
    }, null, 2)}\n`, "utf8");

    server = await startUiServer({
      workspaceRoot: path.join(tempRoot, "workspace"),
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
      enableWorkspaceScheduler: false,
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const headers = { Authorization: `Bearer ${admin.token}`, "Content-Type": "application/json" };

    const directoryResponse = await fetch(`${baseUrl}/api/admin/users?includeProjects=1`, { headers });
    const directory = await directoryResponse.json();
    assert.equal(directory.users.find((user) => user.userId === target.user.userId)?.authProvider, "cas");
    assert.ok(directory.projects.some((project) => project.userId === legacy.user.userId && project.flowId === "daily-report"));

    const transferResponse = await fetch(`${baseUrl}/api/admin/projects/reassign`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sourceUserId: legacy.user.userId, targetUserId: target.user.userId, flowId: "daily-report" }),
    });
    const transfer = await transferResponse.json();
    assert.equal(transferResponse.status, 200, JSON.stringify(transfer));
    assert.equal(transfer.schedulesChanged, 1);
    assert.equal(fs.existsSync(sourceDir), false);
    const targetDir = path.join(process.env.AGENTFLOW_HOME, "users", target.user.userId, "pipelines", "daily-report");
    assert.equal(fs.existsSync(targetDir), true);
    assert.equal(["workspace.flow.js", "workspace.graph.json", "flow.yaml"].some((name) => fs.existsSync(path.join(targetDir, name))), true);
    assert.equal(collaboration.getWorkspaceCollaborationById(collab.workspace.id)?.ownerId, target.user.userId);
    const schedules = JSON.parse(fs.readFileSync(path.join(process.env.AGENTFLOW_HOME, "workspace-schedules.json"), "utf8"));
    const targetScheduleKey = `${target.user.userId}:user:daily-report:schedule`;
    assert.equal(schedules.schedules[scheduleKey], undefined);
    assert.equal(schedules.schedules[targetScheduleKey]?.userId, target.user.userId);
    const audit = fs.readFileSync(path.join(process.env.AGENTFLOW_HOME, "admin", "project-owner-transfers.jsonl"), "utf8");
    assert.match(audit, /"action":"project_owner_reassigned"/);
    assert.match(audit, /"flowId":"daily-report"/);

    const conflictSource = writeFlow(process.env.AGENTFLOW_HOME, legacy.user.userId, "same-name");
    writeFlow(process.env.AGENTFLOW_HOME, target.user.userId, "same-name");
    const conflictResponse = await fetch(`${baseUrl}/api/admin/projects/reassign`, {
      method: "POST",
      headers,
      body: JSON.stringify({ sourceUserId: legacy.user.userId, targetUserId: target.user.userId, flowId: "same-name" }),
    });
    assert.equal(conflictResponse.status, 409);
    assert.equal(fs.existsSync(conflictSource), true);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
