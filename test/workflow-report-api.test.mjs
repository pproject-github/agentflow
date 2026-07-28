import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("generic Workflow reports materialize beside legacy PRD events", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-workflow-report-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "project");
  fs.mkdirSync(workspaceRoot, { recursive: true });

  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = dataRoot;
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?workflow-report=${nonce}`),
      import(`../bin/lib/ui-server.mjs?workflow-report=${nonce}`),
    ]);
    const user = loginOrCreateUser("workflow-reporter", "reporter-password");
    server = await startUiServer({
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
    });
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const request = async (pathname, init = {}, authenticated = true) => fetch(`${baseUrl}${pathname}`, {
      ...init,
      headers: {
        ...(authenticated ? { Authorization: `Bearer ${user.token}` } : {}),
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    });
    const reportPayload = {
      schemaVersion: 1,
      workflow: { namespace: "tapd", id: "1015046" },
      action: {
        key: "implementation:android:issue-2",
        title: "Android 实现",
        status: "done",
        group: "implementation",
        platform: "android",
        issueKey: "issue-2",
      },
      artifacts: [{
        key: "mr-943",
        type: "gitlab-mr",
        title: "实现 MR !943",
        url: "https://git.example/mr/943",
      }],
      globalState: {
        mode: "merge",
        patch: {
          title: "双端 Remote Config",
          status: { label: "开发中" },
          sections: {
            android: {
              title: "Android",
              fields: {
                owner: { label: "负责人", type: "user", value: "workflow-reporter" },
              },
            },
          },
        },
      },
      idempotencyKey: "report-1015046-issue-2",
    };

    const unauthorized = await request("/api/workflows/report", {
      method: "POST",
      body: JSON.stringify(reportPayload),
    }, false);
    assert.equal(unauthorized.status, 401);

    const response = await request("/api/workflows/report", {
      method: "POST",
      body: JSON.stringify(reportPayload),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.snapshot.globalState.title, "双端 Remote Config");
    assert.equal(result.snapshot.globalState.status.label, "开发中");
    assert.equal(result.snapshot.globalState.sections.android.fields.owner.value, "workflow-reporter");
    assert.match(result.snapshot.runtimeRevision, /^runtime:/);
    assert.equal(result.event.actor.userId, user.user.userId);
    assert.equal(result.event.artifacts[0].url, "https://git.example/mr/943");

    const replay = await request("/api/workflows/report", {
      method: "POST",
      body: JSON.stringify(reportPayload),
    });
    const replayResult = await replay.json();
    assert.equal(replay.status, 200, JSON.stringify(replayResult));
    assert.equal(replayResult.alreadyApplied, true);

    const stale = await request("/api/workflows/report", {
      method: "POST",
      body: JSON.stringify({
        ...reportPayload,
        idempotencyKey: "report-1015046-stale",
        expectedRevision: "runtime:stale",
      }),
    });
    assert.equal(stale.status, 409);

    const legacy = await request("/api/prd-workflow/event", {
      method: "POST",
      body: JSON.stringify({
        tapdId: "1015046",
        event: {
          stageKey: "submit-test",
          title: "已提测",
          status: "done",
          overallPatch: {
            requirement: {
              title: "双端 Remote Config",
              status: { label: "已提测" },
            },
          },
        },
      }),
    });
    const legacyResult = await legacy.json();
    assert.equal(legacy.status, 200, JSON.stringify(legacyResult));
    assert.equal(legacyResult.snapshot.overall.requirement.status.label, "已提测");
    assert.equal(legacyResult.snapshot.globalState.status.label, "已提测");
    assert.ok(legacyResult.snapshot.runtimeEvents.some((event) => event.stageKey === "submit-test"));
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

