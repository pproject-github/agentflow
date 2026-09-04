import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function scheduledGraph({ enabled = true, content = "v1" } = {}) {
  return {
    version: 1,
    instances: {
      daily: {
        definitionId: "workspace_scheduled_run",
        label: "Daily",
        body: JSON.stringify({ enabled, cron: "0 8 * * *", timezone: "Asia/Shanghai", overlapPolicy: "skip" }),
        input: [{ type: "node", name: "prev", value: "" }],
        output: [{ type: "node", name: "next", value: "" }],
      },
      result: {
        definitionId: "display_markdown",
        label: "Result",
        body: content,
        input: [{ type: "node", name: "prev", value: "" }],
        output: [{ type: "node", name: "next", value: "" }],
      },
    },
    edges: [{ source: "daily", sourceHandle: "output-0", target: "result", targetHandle: "input-0" }],
    ui: { nodePositions: {} },
  };
}

function multiRunGraph({ first = "first-v1", second = "second-v1" } = {}) {
  return {
    version: 1,
    instances: {
      run_first: {
        definitionId: "workspace_run",
        label: "First Run",
        body: "",
        input: [{ type: "node", name: "prev", value: "" }],
        output: [{ type: "node", name: "next", value: "" }],
      },
      first_result: {
        definitionId: "display_markdown",
        label: "First Result",
        body: first,
        input: [{ type: "node", name: "prev", value: "" }],
        output: [{ type: "node", name: "next", value: "" }],
      },
      run_second: {
        definitionId: "workspace_scheduled_run",
        label: "Second Run",
        body: JSON.stringify({ enabled: true, cron: "0 9 * * *", timezone: "Asia/Shanghai", overlapPolicy: "skip" }),
        input: [{ type: "node", name: "prev", value: "" }],
        output: [{ type: "node", name: "next", value: "" }],
      },
      second_result: {
        definitionId: "display_markdown",
        label: "Second Result",
        body: second,
        input: [{ type: "node", name: "prev", value: "" }],
        output: [{ type: "node", name: "next", value: "" }],
      },
    },
    edges: [
      { source: "run_first", sourceHandle: "output-0", target: "first_result", targetHandle: "input-0" },
      { source: "run_second", sourceHandle: "output-0", target: "second_result", targetHandle: "input-0" },
    ],
    ui: { nodePositions: {} },
  };
}

test("each Run in one Workspace owns an independent Stable history", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-run-release-")));
  try {
    const {
      publishWorkspaceRelease,
      readWorkspaceReleaseStatus,
      readWorkspaceStableRelease,
      rollbackWorkspaceRelease,
      writeWorkspaceGraph,
    } = await import("../bin/lib/workspace-server.mjs");
    const graphV1 = multiRunGraph();
    writeWorkspaceGraph(tempRoot, graphV1, tempRoot);

    assert.match(publishWorkspaceRelease(tempRoot, tempRoot).error, /请选择要发布的 Run/);

    const firstV1 = publishWorkspaceRelease(tempRoot, tempRoot, { runNodeId: "run_first", createdBy: "tester" });
    assert.equal(firstV1.release.id, "v1");
    assert.equal(firstV1.release.entryNodeId, "run_first");
    let status = readWorkspaceReleaseStatus(tempRoot, tempRoot);
    assert.equal(status.entries.find((entry) => entry.entryNodeId === "run_first").stableReleaseId, "v1");
    assert.equal(status.entries.find((entry) => entry.entryNodeId === "run_second").enabled, false);

    const graphV2 = multiRunGraph({ second: "second-v2" });
    writeWorkspaceGraph(tempRoot, graphV2, tempRoot);
    status = readWorkspaceReleaseStatus(tempRoot, tempRoot);
    assert.equal(status.entries.find((entry) => entry.entryNodeId === "run_first").hasDraftChanges, false);

    const secondV2 = publishWorkspaceRelease(tempRoot, tempRoot, { runNodeId: "run_second", createdBy: "tester" });
    assert.equal(secondV2.release.id, "v2");
    assert.equal(readWorkspaceStableRelease(tempRoot, tempRoot, "run_first").release.id, "v1");
    assert.equal(readWorkspaceStableRelease(tempRoot, tempRoot, "run_second").release.id, "v2");

    writeWorkspaceGraph(tempRoot, multiRunGraph({ first: "first-v3", second: "second-v2" }), tempRoot);
    status = readWorkspaceReleaseStatus(tempRoot, tempRoot);
    assert.equal(status.entries.find((entry) => entry.entryNodeId === "run_first").hasDraftChanges, true);
    assert.equal(status.entries.find((entry) => entry.entryNodeId === "run_second").hasDraftChanges, false);
    const firstV3 = publishWorkspaceRelease(tempRoot, tempRoot, { runNodeId: "run_first", createdBy: "tester" });
    assert.equal(firstV3.release.id, "v3");

    const rollback = rollbackWorkspaceRelease(tempRoot, "v1", tempRoot, "run_first");
    assert.equal(rollback.status.stableReleaseId, "v1");
    assert.equal(readWorkspaceStableRelease(tempRoot, tempRoot, "run_second").release.id, "v2");
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("workspace releases keep stable schedules isolated from draft edits and support rollback", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-workspace-release-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }, { runWorkspaceScheduledEntry }] = await Promise.all([
      import(`../bin/lib/auth.mjs?workspace-release=${nonce}`),
      import(`../bin/lib/ui-server.mjs?workspace-release=${nonce}`),
      import("../bin/lib/workspace-server.mjs"),
    ]);
    const user = loginOrCreateUser("release-owner", "release-password");
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

    const created = await request("POST", "/api/flows", { flowId: "release-flow", targetSpace: "user" });
    assert.equal(created.status, 200, created.text);
    const initial = await request("GET", "/api/workspace/graph?flowId=release-flow&flowSource=user");
    const firstSave = await request("POST", "/api/workspace/graph", {
      flowId: "release-flow",
      flowSource: "user",
      graph: scheduledGraph({ enabled: true, content: "stable v1" }),
    });
    assert.equal(firstSave.status, 200, firstSave.text);
    assert.equal(initial.body.release.enabled, false);

    const v1 = await request("POST", "/api/workspace/releases/publish", {
      flowId: "release-flow",
      flowSource: "user",
      expectedRevision: firstSave.body.revision,
      notes: "first stable",
    });
    assert.equal(v1.status, 200, v1.text);
    assert.equal(v1.body.release.id, "v1");
    assert.equal(v1.body.status.stableReleaseId, "v1");
    assert.equal(v1.body.status.hasDraftChanges, false);
    assert.equal(v1.body.workspaceSchedules[0].enabled, true);

    const draftSave = await request("POST", "/api/workspace/graph", {
      flowId: "release-flow",
      flowSource: "user",
      graph: scheduledGraph({ enabled: false, content: "draft v2" }),
    });
    assert.equal(draftSave.status, 200, draftSave.text);
    assert.equal(draftSave.body.workspaceSchedules[0].enabled, true, "draft schedule changes must not affect Stable");

    const draftStatus = await request("GET", "/api/workspace/releases?flowId=release-flow&flowSource=user");
    assert.equal(draftStatus.status, 200, draftStatus.text);
    assert.equal(draftStatus.body.release.hasDraftChanges, true);

    await runWorkspaceScheduledEntry(path.join(tempRoot, "workspace"), v1.body.workspaceSchedules[0]);
    const runLogs = await request("GET", "/api/workspace/run-logs?flowId=release-flow&flowSource=user&limit=10");
    assert.equal(runLogs.status, 200, runLogs.text);
    assert.equal(runLogs.body.runs[0].status, "success");
    assert.equal(runLogs.body.runs[0].releaseId, "v1");
    assert.ok(runLogs.body.runs[0].designRevision);
    assert.ok(fs.existsSync(path.join(
      initial.body.root,
      ".workspace",
      "agentflow",
      "releases",
      "v1",
      "runtime",
      "workspace.state.json",
    )));
    const runDetail = await request(
      "GET",
      `/api/workspace/run-logs/${encodeURIComponent(runLogs.body.runs[0].runId)}?flowId=release-flow&flowSource=user`,
    );
    assert.equal(runDetail.status, 200, runDetail.text);
    const releaseResolved = runDetail.body.events.find((event) => event.type === "release-resolved");
    assert.equal(releaseResolved.releaseId, "v1");
    assert.equal(releaseResolved.source, "stable");

    const v2 = await request("POST", "/api/workspace/releases/publish", {
      flowId: "release-flow",
      flowSource: "user",
      expectedRevision: draftSave.body.revision,
      notes: "disable schedule",
    });
    assert.equal(v2.status, 200, v2.text);
    assert.equal(v2.body.release.id, "v2");
    assert.equal(v2.body.workspaceSchedules[0].enabled, false);

    const rollback = await request("POST", "/api/workspace/releases/rollback", {
      flowId: "release-flow",
      flowSource: "user",
      releaseId: "v1",
    });
    assert.equal(rollback.status, 200, rollback.text);
    assert.equal(rollback.body.status.stableReleaseId, "v1");
    assert.equal(rollback.body.workspaceSchedules[0].enabled, true);

    const finalGraph = await request("GET", "/api/workspace/graph?flowId=release-flow&flowSource=user");
    assert.equal(finalGraph.body.graph.instances.result.body, "draft v2", "rollback must not overwrite the Draft");
    assert.equal(finalGraph.body.release.stableReleaseId, "v1");
    assert.equal(finalGraph.body.release.hasDraftChanges, true);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
