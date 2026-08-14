import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const graph = {
  version: 1,
  instances: {
    run: {
      definitionId: "workspace_run",
      label: "Run",
      input: [{ type: "node", name: "prev", value: "" }],
      output: [{ type: "node", name: "next", value: "" }],
    },
    manualResult: {
      definitionId: "display_markdown",
      label: "Manual result",
      body: "draft ran",
      input: [
        { type: "node", name: "prev", value: "" },
        { type: "text", name: "content", value: "draft ran" },
      ],
      output: [
        { type: "node", name: "next", value: "" },
        { type: "text", name: "content", value: "" },
      ],
    },
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
    scheduledResult: {
      definitionId: "display_markdown",
      label: "Scheduled result",
      body: "scheduled graph",
      input: [
        { type: "node", name: "prev", value: "" },
        { type: "text", name: "content", value: "scheduled graph" },
      ],
      output: [
        { type: "node", name: "next", value: "" },
        { type: "text", name: "content", value: "" },
      ],
    },
  },
  edges: [
    { source: "run", sourceHandle: "output-0", target: "manualResult", targetHandle: "input-0" },
    { source: "daily", sourceHandle: "output-0", target: "scheduledResult", targetHandle: "input-0" },
  ],
  ui: { nodePositions: {} },
};

test("draft is hidden, editable, runnable, schedule-suppressed, and promotable", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-workspace-draft-api-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?workspace-draft-api=${nonce}`),
      import(`../bin/lib/ui-server.mjs?workspace-draft-api=${nonce}`),
    ]);
    const user = loginOrCreateUser("draft-owner", "draft-password");
    server = await startUiServer({
      workspaceRoot: path.join(tempRoot, "workspace"),
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

    const created = await request("POST", "/api/workspace/draft", { graph, title: "Runnable draft", ttlSeconds: 600 });
    assert.equal(created.status, 200, created.text);
    assert.equal(created.body.draft, true);
    assert.equal(created.body.schedulesSuppressed, true);
    const draftId = created.body.draftId;

    const missingRevision = await request("POST", "/api/workspace/draft", { draftId, graph });
    assert.equal(missingRevision.status, 428, missingRevision.text);
    assert.equal(missingRevision.body.conflict, "missing-base-revision");

    const staleRevision = await request("POST", "/api/workspace/draft", {
      draftId,
      graph,
      baseRevision: "stale-revision",
    });
    assert.equal(staleRevision.status, 409, staleRevision.text);
    assert.equal(staleRevision.body.currentRevision, created.body.revision);

    const updatedDraft = await request("POST", "/api/workspace/draft", {
      draftId,
      graph,
      baseRevision: created.body.revision,
    });
    assert.equal(updatedDraft.status, 200, updatedDraft.text);

    const flows = await request("GET", "/api/flows");
    assert.equal((flows.body || []).some((item) => item.id === draftId), false, "draft must stay out of the formal flow list");

    const loaded = await request("GET", `/api/workspace/graph?flowId=${encodeURIComponent(draftId)}&flowSource=user`);
    assert.equal(loaded.status, 200, loaded.text);
    assert.equal(loaded.body.draft, true);
    assert.equal(loaded.body.writable, true);

    loaded.body.graph.instances.manualResult.body = "updated in draft";
    const saved = await request("POST", "/api/workspace/graph", {
      flowId: draftId,
      flowSource: "user",
      graph: loaded.body.graph,
    });
    assert.equal(saved.status, 200, saved.text);
    assert.deepEqual(saved.body.workspaceSchedules, [], "saving a draft must not arm its schedule");

    const run = await request("POST", "/api/workspace/run", {
      flowId: draftId,
      flowSource: "user",
      runNodeId: "run",
      graph: saved.body.graph,
    });
    assert.equal(run.status, 200, run.text);
    assert.equal(run.body.ok, true);
    assert.equal(run.body.graph.instances.manualResult.body, "updated in draft");

    const draftSchedules = await request("GET", `/api/workspace/schedules?flowId=${encodeURIComponent(draftId)}&flowSource=user`);
    assert.deepEqual(draftSchedules.body.schedules, []);

    const promoted = await request("POST", "/api/workspace/draft/publish", {
      draftId,
      flowId: "publishedDraft",
      targetSpace: "personal",
      scheduleMode: "enabled",
    });
    assert.equal(promoted.status, 200, promoted.text);
    assert.equal(promoted.body.workspaceSchedules.length, 1);
    assert.equal(promoted.body.workspaceSchedules[0].enabled, true);
    assert.ok(promoted.body.workspaceSchedules[0].nextRunAt);

    const finalFlows = await request("GET", "/api/flows");
    assert.equal(finalFlows.body.some((item) => item.id === "publishedDraft"), true);
    assert.equal(finalFlows.body.some((item) => item.id === draftId), false);

    const disabled = await request("POST", "/api/workspace/schedule/config", {
      flowId: "publishedDraft",
      flowSource: "user",
      scheduleNodeId: "daily",
      enabled: false,
    });
    assert.equal(disabled.status, 200, disabled.text);
    assert.equal(disabled.body.schedule.enabled, false);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
