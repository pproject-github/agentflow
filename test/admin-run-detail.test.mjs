import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  parseAdminPipelineRunLog,
  redactAdminRunText,
} from "../bin/lib/admin-run-detail.mjs";

test("admin run log parsing classifies thinking and redacts secrets", () => {
  const parsed = parseAdminPipelineRunLog([
    '[2026-07-29T08:00:00.000Z] [cli] {"event":"node-start","instanceId":"agent_1","token":"secret-token"}',
    '[2026-07-29T08:00:01.000Z] [cursor-stdout-raw] {"type":"thinking","subtype":"delta","text":"先读取输入"}',
    '[2026-07-29T08:00:02.000Z] [cursor-stdout-raw] {"type":"thinking","subtype":"delta","text":"，再执行查询"}',
    "[2026-07-29T08:00:03.000Z] [stderr] Authorization: Bearer abc.def.ghi",
  ].join("\n"));

  assert.equal(parsed.events[0].nodeId, "agent_1");
  assert.equal(parsed.events[1].kind, "thinking");
  assert.equal(parsed.events[1].text, "先读取输入，再执行查询");
  assert.doesNotMatch(parsed.rawLines.join("\n"), /secret-token|abc\.def\.ghi/);
  assert.match(redactAdminRunText("api_key=my-key"), /api_key=\*\*\*/);
});

test("admin run detail API is admin-only and reads another user's pipeline log", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-admin-run-detail-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "project");
  fs.mkdirSync(workspaceRoot, { recursive: true });

  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = dataRoot;
  let server;
  try {
    const nonce = Date.now();
    const [
      { loginOrCreateUser },
      { getUserPipelinesRoot },
      {
        appendWorkspaceRunLogEvent,
        createWorkspaceRunLogSession,
        finishWorkspaceRunLogSession,
      },
      { startUiServer },
    ] = await Promise.all([
      import(`../bin/lib/auth.mjs?admin-run-detail=${nonce}`),
      import(`../bin/lib/paths.mjs?admin-run-detail=${nonce}`),
      import(`../bin/lib/workspace-run-logs.mjs?admin-run-detail=${nonce}`),
      import(`../bin/lib/ui-server.mjs?admin-run-detail=${nonce}`),
    ]);
    const admin = loginOrCreateUser("run-detail-admin", "admin-password");
    const ordinary = loginOrCreateUser("run-detail-user", "user-password");
    const runDir = path.join(
      getUserPipelinesRoot(ordinary.user.userId),
      "daily_report",
      "runBuild",
      "run-detail-1",
    );
    fs.mkdirSync(path.join(runDir, "logs"), { recursive: true });
    fs.writeFileSync(
      path.join(runDir, "logs", "log.txt"),
      [
        '[2026-07-29T08:00:00.000Z] [cli] {"event":"node-start","instanceId":"agent_1"}',
        '[2026-07-29T08:00:01.000Z] [natural] {"kind":"thinking","text":"检查日报数据","apiKey":"must-not-leak"}',
      ].join("\n") + "\n",
      "utf-8",
    );
    createWorkspaceRunLogSession({
      runId: "workspace-detail-1",
      userId: ordinary.user.userId,
      username: ordinary.user.username,
      flowId: "workspace_report",
      flowSource: "user",
      runNodeId: "run_1",
      label: "Workspace Report",
      startedAt: Date.now() - 2_000,
    });
    appendWorkspaceRunLogEvent("workspace-detail-1", {
      type: "natural",
      kind: "thinking",
      nodeId: "agent_1",
      text: "分析 Workspace 数据",
      password: "workspace-secret",
    });
    finishWorkspaceRunLogSession("workspace-detail-1", "success");

    server = await startUiServer({
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
    });
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const query = new URLSearchParams({
      runType: "pipeline",
      userId: ordinary.user.userId,
      flowId: "daily_report",
      flowSource: "user",
      runId: "run-detail-1",
    });
    const request = (token, pathname) => fetch(`${baseUrl}${pathname}`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    const forbidden = await request(ordinary.token, `/api/admin/run-detail?${query}`);
    assert.equal(forbidden.status, 403);

    const allowed = await request(admin.token, `/api/admin/run-detail?${query}`);
    const detail = await allowed.json();
    assert.equal(allowed.status, 200, JSON.stringify(detail));
    assert.equal(detail.run.userId, ordinary.user.userId);
    assert.equal(detail.events.some((event) => event.kind === "thinking"), true);
    assert.doesNotMatch(JSON.stringify(detail), /must-not-leak/);

    const traversal = new URLSearchParams(query);
    traversal.set("runId", "../../outside");
    const missing = await request(admin.token, `/api/admin/run-detail?${traversal}`);
    assert.equal(missing.status, 404);

    const workspaceQuery = new URLSearchParams({
      runType: "workspace",
      userId: ordinary.user.userId,
      flowId: "workspace_report",
      flowSource: "user",
      runId: "workspace-detail-1",
    });
    const workspaceResponse = await request(admin.token, `/api/admin/run-detail?${workspaceQuery}`);
    const workspaceDetail = await workspaceResponse.json();
    assert.equal(workspaceResponse.status, 200, JSON.stringify(workspaceDetail));
    assert.equal(workspaceDetail.run.runType, "workspace");
    assert.equal(workspaceDetail.events.some((event) => event.kind === "thinking"), true);
    assert.doesNotMatch(JSON.stringify(workspaceDetail), /workspace-secret/);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
