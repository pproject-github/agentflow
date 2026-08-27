import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const scheduledGraph = {
  version: 1,
  instances: {
    daily: {
      definitionId: "workspace_scheduled_run",
      label: "Daily",
      body: JSON.stringify({
        enabled: true,
        cron: "0 8 * * *",
        timezone: "Asia/Shanghai",
        overlapPolicy: "skip",
      }),
      input: [{ type: "node", name: "prev", value: "" }],
      output: [{ type: "node", name: "next", value: "" }],
    },
    result: {
      definitionId: "display_markdown",
      label: "Result",
      body: "scheduled",
      input: [
        { type: "node", name: "prev", value: "" },
        { type: "text", name: "content", value: "scheduled" },
      ],
      output: [{ type: "node", name: "next", value: "" }],
    },
  },
  edges: [{ source: "daily", sourceHandle: "output-0", target: "result", targetHandle: "input-0" }],
  ui: { nodePositions: {} },
};

test("admin lists and toggles every user's schedules while ordinary users stay scoped", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-admin-schedules-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?admin-schedules=${nonce}`),
      import(`../bin/lib/ui-server.mjs?admin-schedules=${nonce}`),
    ]);
    const admin = loginOrCreateUser("schedule-admin", "admin-password");
    const member = loginOrCreateUser("schedule-member", "member-password");
    server = await startUiServer({
      workspaceRoot: path.join(tempRoot, "workspace"),
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
      enableWorkspaceScheduler: false,
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (token, method, pathname, body) => {
      const response = await fetch(base + pathname, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    };
    const publishScheduledDraft = async (account, flowId) => {
      const created = await request(account.token, "POST", "/api/workspace/draft", { graph: scheduledGraph });
      assert.equal(created.status, 200);
      const published = await request(account.token, "POST", "/api/workspace/draft/publish", {
        draftId: created.body.draftId,
        flowId,
        targetSpace: "personal",
        scheduleMode: "enabled",
      });
      assert.equal(published.status, 200);
    };

    await publishScheduledDraft(admin, "admin-scheduled-flow");
    await publishScheduledDraft(member, "member-scheduled-flow");

    const memberList = await request(member.token, "GET", "/api/schedules");
    assert.equal(memberList.status, 200);
    assert.equal(memberList.body.adminView, false);
    assert.deepEqual(memberList.body.schedules.map((item) => item.flowId), ["member-scheduled-flow"]);

    const adminList = await request(admin.token, "GET", "/api/schedules");
    assert.equal(adminList.status, 200);
    assert.equal(adminList.body.adminView, true);
    assert.deepEqual(new Set(adminList.body.schedules.map((item) => item.flowId)), new Set(["admin-scheduled-flow", "member-scheduled-flow"]));
    const memberSchedule = adminList.body.schedules.find((item) => item.flowId === "member-scheduled-flow");
    assert.equal(memberSchedule.ownerUserId, member.user.userId);
    assert.equal(memberSchedule.ownerUsername, "schedule-member");

    const denied = await request(member.token, "POST", "/api/schedule/toggle", {
      kind: "workspace",
      flowId: "admin-scheduled-flow",
      flowSource: "user",
      scheduleNodeId: "daily",
      ownerUserId: admin.user.userId,
      enabled: false,
    });
    assert.equal(denied.status, 403);

    const toggled = await request(admin.token, "POST", "/api/schedule/toggle", {
      kind: "workspace",
      flowId: memberSchedule.flowId,
      flowSource: memberSchedule.flowSource,
      scheduleNodeId: memberSchedule.scheduleNodeId,
      ownerUserId: memberSchedule.ownerUserId,
      enabled: false,
    });
    assert.equal(toggled.status, 200);

    const memberAfterToggle = await request(member.token, "GET", "/api/schedules");
    assert.equal(memberAfterToggle.body.schedules[0].enabled, false);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
