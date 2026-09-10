import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/** 一张只有定时节点的图；节点 id 由调用方决定，用来区分「这是谁那份流程」 */
function scheduledGraph(scheduleNodeId, cron = "0 8 * * *") {
  return {
    version: 1,
    instances: {
      [scheduleNodeId]: {
        definitionId: "workspace_scheduled_run",
        label: "Daily",
        body: JSON.stringify({
          enabled: true,
          cron,
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
    edges: [{ source: scheduleNodeId, sourceHandle: "next", target: "result", targetHandle: "prev" }],
    ui: { nodePositions: {} },
  };
}

// 用户需求点：Admin「最近运行」里一批定时运行挂在 xingqiwei 名下，实际是 wangqi 配的。
// 归属只按 flowId 找协作登记，两个人各有一份同名个人流程时会判成对方——登记、调度身份、
// 运行记录一起改姓，而且后保存的那个人还会把前一个人的登记删掉。
test("同名的个人流程，各自的定时登记在各自名下，互不覆盖", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-schedule-owner-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  const dataRoot = path.join(tempRoot, "data");
  process.env.AGENTFLOW_HOME = dataRoot;
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?schedule-owner=${nonce}`),
      import(`../bin/lib/ui-server.mjs?schedule-owner=${nonce}`),
    ]);
    const sharer = loginOrCreateUser("schedule-owner-sharer", "sharer-password");
    const mate = loginOrCreateUser("schedule-owner-mate", "mate-password");
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
    const publishPersonal = async (account, flowId, scheduleNodeId) => {
      const created = await request(account.token, "POST", "/api/workspace/draft", {
        graph: scheduledGraph(scheduleNodeId),
      });
      assert.equal(created.status, 200, JSON.stringify(created.body));
      const published = await request(account.token, "POST", "/api/workspace/draft/publish", {
        draftId: created.body.draftId,
        flowId,
        targetSpace: "personal",
        scheduleMode: "enabled",
      });
      assert.equal(published.status, 200, JSON.stringify(published.body));
    };

    // 分享方先有一份 hello-overall-watch，并且分享给了 mate：协作登记里从此有一条
    // 「hello-overall-watch 属于 sharer」。
    await publishPersonal(sharer, "hello-overall-watch", "sharerSchedule");
    const shared = await request(sharer.token, "POST", "/api/workspace/collaboration/share", {
      flowId: "hello-overall-watch",
      flowSource: "user",
      username: "schedule-owner-mate",
    });
    assert.equal(shared.status, 200, JSON.stringify(shared.body));

    // mate 自己也有一份同名流程，配上自己的定时。
    await publishPersonal(mate, "hello-overall-watch", "mateSchedule");

    const mateSchedules = await request(mate.token, "GET", "/api/schedules");
    assert.equal(mateSchedules.status, 200);
    const mateRow = mateSchedules.body.schedules.find((row) => row.scheduleNodeId === "mateSchedule");
    assert.ok(mateRow, JSON.stringify(mateSchedules.body.schedules));
    assert.equal(mateRow.ownerUserId, mate.user.userId);
    assert.equal(mateRow.registered, true);

    // 分享方那条不能被顶掉。
    const sharerSchedules = await request(sharer.token, "GET", "/api/schedules");
    const sharerRow = sharerSchedules.body.schedules.find((row) => row.scheduleNodeId === "sharerSchedule");
    assert.ok(sharerRow, JSON.stringify(sharerSchedules.body.schedules));
    assert.equal(sharerRow.ownerUserId, sharer.user.userId);
    assert.equal(sharerRow.registered, true);

    // 登记表里两条并存，各自 userId 正确。
    const registry = JSON.parse(fs.readFileSync(path.join(dataRoot, "workspace-schedules.json"), "utf-8"));
    const entries = Object.values(registry.schedules);
    const byNode = new Map(entries.map((entry) => [entry.scheduleNodeId, entry]));
    assert.equal(byNode.get("mateSchedule")?.userId, mate.user.userId);
    assert.equal(byNode.get("sharerSchedule")?.userId, sharer.user.userId);
    for (const entry of entries) assert.equal(entry.username, entry.userId === mate.user.userId ? "schedule-owner-mate" : "schedule-owner-sharer");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

// 用户需求点：定时任务页把一条共享流程的定时写着「用户：chenjunlun」，本人从没打开过它。
// 管理员视图是逐个用户枚举出来的，共享流程人人可见，拿枚举到的这个人兜底 = 记在字典序
// 最靠前的账号头上。
test("没有归属的共享流程定时，不会挂到随便一个用户头上", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-schedule-unowned-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }, { writeWorkspaceGraphFiles }, { PIPELINES_DIR }] = await Promise.all([
      import(`../bin/lib/auth.mjs?schedule-unowned=${nonce}`),
      import(`../bin/lib/ui-server.mjs?schedule-unowned=${nonce}`),
      import("../bin/lib/workspace-flow-store.mjs"),
      import("../bin/lib/paths.mjs"),
    ]);
    const admin = loginOrCreateUser("aaa-schedule-admin", "admin-password");
    loginOrCreateUser("zzz-schedule-bystander", "bystander-password");
    const workspaceRoot = path.join(tempRoot, "workspace");
    // 共享作用域里一份没有协作登记、也没进过定时登记表的流程：历史遗留、直接拷目录、
    // 或者 CLI 发布出来的都长这样。
    writeWorkspaceGraphFiles(
      path.join(workspaceRoot, PIPELINES_DIR, "hello-overall-watch-publish-tmp"),
      scheduledGraph("watchSchedule", "0 10,18 * * *"),
    );
    server = await startUiServer({
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
      enableWorkspaceScheduler: false,
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/api/schedules`, {
      headers: { Authorization: `Bearer ${admin.token}` },
    });
    const payload = await response.json();
    assert.equal(response.status, 200);
    assert.equal(payload.adminView, true);
    const row = payload.schedules.find((item) => item.flowId === "hello-overall-watch-publish-tmp");
    assert.ok(row, JSON.stringify(payload.schedules));
    assert.equal(row.registered, false);
    assert.equal(row.ownerUserId, "");
    assert.equal(row.ownerUsername, "");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("启动迁移把判错主的定时登记按目录认回来，且只改能证伪的那条", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-schedule-repair-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  const dataRoot = path.join(tempRoot, "data");
  process.env.AGENTFLOW_HOME = dataRoot;
  try {
    const [{ writeWorkspaceGraphFiles }, { runStartupStorageMigrations }] = await Promise.all([
      import("../bin/lib/workspace-flow-store.mjs"),
      import("../bin/lib/startup-storage-migrations.mjs"),
    ]);
    const flowFor = (userId) => path.join(dataRoot, "users", userId, "pipelines", "hello-overall-watch");
    writeWorkspaceGraphFiles(flowFor("xingqiwei"), scheduledGraph("sched_x"));
    writeWorkspaceGraphFiles(flowFor("wangqi"), scheduledGraph("sched_w"));
    fs.mkdirSync(path.join(dataRoot, "auth"), { recursive: true });
    fs.writeFileSync(
      path.join(dataRoot, "auth", "users.json"),
      JSON.stringify({ xingqiwei: { username: "xingqiwei" }, wangqi: { username: "wangqi" } }),
      "utf-8",
    );
    const entry = (userId, username, scheduleNodeId) => ({
      key: `${userId}:user:hello-overall-watch:${scheduleNodeId}`,
      enabled: true,
      userId,
      username,
      flowId: "hello-overall-watch",
      flowSource: "user",
      scheduleNodeId,
      cron: "0,30 * * * *",
      timezone: "Asia/Shanghai",
    });
    fs.writeFileSync(
      path.join(dataRoot, "workspace-schedules.json"),
      JSON.stringify({
        version: 1,
        schedules: {
          // 判错主的那条：节点在 wangqi 的图里，却挂在 xingqiwei 名下
          "xingqiwei:user:hello-overall-watch:sched_w": entry("xingqiwei", "wangqi", "sched_w"),
          "xingqiwei:user:hello-overall-watch:sched_x": entry("xingqiwei", "xingqiwei", "sched_x"),
        },
      }),
      "utf-8",
    );

    const result = runStartupStorageMigrations({ dataRoot, workspaceRoot: path.join(tempRoot, "workspace") });
    assert.equal(result.scheduleOwners.repaired.length, 1);
    assert.deepEqual(
      { from: result.scheduleOwners.repaired[0].from, to: result.scheduleOwners.repaired[0].to },
      { from: "xingqiwei", to: "wangqi" },
    );
    const registry = JSON.parse(fs.readFileSync(path.join(dataRoot, "workspace-schedules.json"), "utf-8"));
    assert.deepEqual(Object.keys(registry.schedules).sort(), [
      "wangqi:user:hello-overall-watch:sched_w",
      "xingqiwei:user:hello-overall-watch:sched_x",
    ]);
    assert.equal(registry.schedules["wangqi:user:hello-overall-watch:sched_w"].username, "wangqi");

    // 幂等：第二次启动不再重跑
    const again = runStartupStorageMigrations({ dataRoot, workspaceRoot: path.join(tempRoot, "workspace") });
    assert.equal(again.scheduleOwners.rerun, false);

    // 正主那条已经在了时，判错主留下的是重复登记：丢掉重复的，保留正主原样。
    fs.writeFileSync(
      path.join(dataRoot, "workspace-schedules.json"),
      JSON.stringify({
        version: 1,
        schedules: {
          "xingqiwei:user:hello-overall-watch:sched_w": entry("xingqiwei", "wangqi", "sched_w"),
          "wangqi:user:hello-overall-watch:sched_w": { ...entry("wangqi", "wangqi", "sched_w"), cron: "0 7 * * *" },
        },
      }),
      "utf-8",
    );
    const forced = runStartupStorageMigrations({ dataRoot, workspaceRoot: path.join(tempRoot, "workspace"), force: true });
    assert.equal(forced.scheduleOwners.repaired.length, 0);
    assert.equal(forced.scheduleOwners.dropped.length, 1);
    const afterDrop = JSON.parse(fs.readFileSync(path.join(dataRoot, "workspace-schedules.json"), "utf-8"));
    assert.deepEqual(Object.keys(afterDrop.schedules), ["wangqi:user:hello-overall-watch:sched_w"]);
    assert.equal(afterDrop.schedules["wangqi:user:hello-overall-watch:sched_w"].cron, "0 7 * * *");
  } finally {
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
