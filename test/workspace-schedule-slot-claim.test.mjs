import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/** 一个跑得够久的定时流程：足够让"运行中"的状态被观察到。 */
function slowScheduledGraph(markerPath) {
  return {
    version: 1,
    instances: {
      daily: {
        definitionId: "workspace_scheduled_run",
        label: "Daily",
        body: JSON.stringify({
          enabled: true,
          cron: "*/30 * * * *",
          timezone: "Asia/Shanghai",
          overlapPolicy: "skip",
        }),
        input: [{ type: "node", name: "prev", value: "" }],
        output: [{ type: "node", name: "next", value: "" }],
      },
      slow: {
        definitionId: "tool_nodejs",
        label: "Slow",
        script: `node -e "require('fs').writeFileSync(${JSON.stringify(JSON.stringify(markerPath))}, 'started'); setTimeout(() => {}, 2500)" ; true`,
        input: [{ type: "node", name: "prev", value: "" }],
        output: [{ type: "node", name: "next", value: "" }],
      },
    },
    edges: [{ source: "daily", sourceHandle: "next", target: "slow", targetHandle: "prev" }],
    ui: { nodePositions: {} },
  };
}

// 用户需求点：定时每 30 分钟一次，可是"最近执行"里每个整点都是一条 failed 加一条
// skipped。skipped 不是别的 Run 撞上来，是同一个 cron 槽位被轮询重复触发了自己。
test("定时开跑的那一刻就用掉这个 cron 槽位，不会被下一次轮询重复触发", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-schedule-claim-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }, workspaceServer] = await Promise.all([
      import(`../bin/lib/auth.mjs?schedule-claim=${nonce}`),
      import(`../bin/lib/ui-server.mjs?schedule-claim=${nonce}`),
      import("../bin/lib/workspace-server.mjs"),
    ]);
    const user = loginOrCreateUser("schedule-claim-owner", "schedule-claim-password");
    const workspaceRoot = path.join(tempRoot, "workspace");
    server = await startUiServer({
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
      enableWorkspaceScheduler: false,
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" };
    const request = async (method, pathname, body) => {
      const response = await fetch(base + pathname, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let payload = null;
      try { payload = JSON.parse(text); } catch {}
      return { status: response.status, body: payload, text };
    };

    const markerPath = path.join(tempRoot, "started.txt");
    const created = await request("POST", "/api/flows", { flowId: "schedule-claim", targetSpace: "user" });
    assert.equal(created.status, 200, created.text);
    const saved = await request("POST", "/api/workspace/graph", {
      flowId: "schedule-claim",
      flowSource: "user",
      graph: slowScheduledGraph(markerPath),
    });
    assert.equal(saved.status, 200, saved.text);
    const published = await request("POST", "/api/workspace/releases/publish", {
      flowId: "schedule-claim",
      flowSource: "user",
      runNodeId: "daily",
      expectedRevision: saved.body.revision,
    });
    assert.equal(published.status, 200, published.text);

    const entry = published.body.workspaceSchedules[0];
    // 还原轮询触发时的真实状态：nextRunAt 已经到点了（发布时它被 arm 到了未来，
    // 直接跑的话这条断言会永远成立，测不出东西）。
    workspaceServer.updateWorkspaceScheduleEntry(entry.key, { nextRunAt: Date.now() - 1000 });
    const running = workspaceServer.runWorkspaceScheduledEntry(workspaceRoot, entry);

    // 等到这条 Run 真的进入运行中，再看槽位有没有被用掉。
    let claimed = null;
    for (let i = 0; i < 200 && !claimed; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      const registry = workspaceServer.readWorkspaceScheduleRegistry();
      const current = registry.schedules?.[entry.key];
      if (current?.lastStatus === "running") claimed = current;
    }
    assert.ok(claimed, "没等到 Run 进入 running 状态");
    assert.ok(
      Number(claimed.nextRunAt) > Date.now(),
      `开跑时 nextRunAt 必须已经指向下一个槽位，否则 30 秒后的轮询会重复触发；实际 ${claimed.nextRunAt}`,
    );

    await running;
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
