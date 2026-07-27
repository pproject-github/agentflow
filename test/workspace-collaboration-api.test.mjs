import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("shared workspace rejects non-members, auto-merges independent edits, and reports field conflicts", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-collab-api-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "project");
  const flowDir = path.join(workspaceRoot, ".workspace", "agentflow", "pipelines", "shared-flow");
  fs.mkdirSync(flowDir, { recursive: true });
  fs.writeFileSync(path.join(flowDir, "flow.yaml"), "version: 1\ninstances: {}\nedges: []\n", "utf-8");
  fs.writeFileSync(
    path.join(flowDir, "workspace.graph.json"),
    JSON.stringify({ version: 1, instances: {}, edges: [], ui: { nodePositions: {} } }, null, 2) + "\n",
    "utf-8",
  );

  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = dataRoot;
  let server;
  try {
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?collab-api=${Date.now()}`),
      import(`../bin/lib/ui-server.mjs?collab-api=${Date.now()}`),
    ]);
    const owner = loginOrCreateUser("owner", "owner-password");
    const guest = loginOrCreateUser("guest", "guest-password");
    const outsider = loginOrCreateUser("outsider", "outsider-password");
    assert.equal(owner.ok, true);
    assert.equal(guest.ok, true);
    assert.equal(outsider.ok, true);

    server = await startUiServer({
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
    });
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const request = async (token, pathname, init = {}) => fetch(`${baseUrl}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    });

    const ownerGraph = await request(
      owner.token,
      "/api/workspace/graph?flowId=shared-flow&flowSource=workspace",
    );
    assert.equal(ownerGraph.status, 200);
    const initial = await ownerGraph.json();
    assert.ok(initial.revision);

    const shareResponse = await request(owner.token, "/api/workspace/collaboration/share", {
      method: "POST",
      body: JSON.stringify({ flowId: "shared-flow", flowSource: "workspace", username: "guest" }),
    });
    assert.equal(shareResponse.status, 200);
    const share = await shareResponse.json();
    assert.equal(share.member.username, "guest");

    const sharedGraph = await request(
      guest.token,
      "/api/workspace/graph?flowId=shared-flow&flowSource=workspace",
    );
    assert.equal(sharedGraph.status, 200);
    const denied = await request(
      outsider.token,
      "/api/workspace/graph?flowId=shared-flow&flowSource=workspace",
    );
    assert.equal(denied.status, 403);
    const guestFlows = await request(guest.token, "/api/flows");
    assert.equal(guestFlows.status, 200);
    assert.equal((await guestFlows.json()).some((flow) => flow.id === "shared-flow" && flow.source === "workspace"), true);
    const outsiderFlows = await request(outsider.token, "/api/flows");
    assert.equal(outsiderFlows.status, 200);
    assert.equal((await outsiderFlows.json()).some((flow) => flow.id === "shared-flow" && flow.source === "workspace"), false);

    const ownerSave = await request(owner.token, "/api/workspace/graph", {
      method: "POST",
      body: JSON.stringify({
        flowId: "shared-flow",
        flowSource: "workspace",
        baseRevision: initial.revision,
        baseGraph: initial.graph,
        graph: {
          version: 1,
          instances: { node_a: { definitionId: "control_start", label: "A" } },
          edges: [],
          ui: { nodePositions: { node_a: { x: 0, y: 0 } } },
        },
      }),
    });
    const ownerSaveJson = await ownerSave.json();
    assert.equal(ownerSave.status, 200, JSON.stringify(ownerSaveJson));

    const staleSave = await request(guest.token, "/api/workspace/graph", {
      method: "POST",
      body: JSON.stringify({
        flowId: "shared-flow",
        flowSource: "workspace",
        baseRevision: initial.revision,
        baseGraph: initial.graph,
        graph: {
          version: 1,
          instances: { node_b: { definitionId: "control_start", label: "B" } },
          edges: [],
          ui: { nodePositions: { node_b: { x: 10, y: 10 } } },
        },
      }),
    });
    const staleSaveJson = await staleSave.json();
    assert.equal(staleSave.status, 200, JSON.stringify(staleSaveJson));
    assert.equal(staleSaveJson.merged, true);
    assert.equal(staleSaveJson.graph.instances.node_a.label, "A");
    assert.equal(staleSaveJson.graph.instances.node_b.label, "B");

    const sharedBase = staleSaveJson.graph;
    const sharedRevision = staleSaveJson.revision;
    const ownerFieldSave = await request(owner.token, "/api/workspace/graph", {
      method: "POST",
      body: JSON.stringify({
        flowId: "shared-flow",
        flowSource: "workspace",
        baseRevision: sharedRevision,
        baseGraph: sharedBase,
        graph: {
          ...sharedBase,
          instances: {
            ...sharedBase.instances,
            node_a: { ...sharedBase.instances.node_a, label: "Owner changed A" },
          },
        },
      }),
    });
    const ownerFieldSaveJson = await ownerFieldSave.json();
    assert.equal(ownerFieldSave.status, 200, JSON.stringify(ownerFieldSaveJson));

    const guestFieldSave = await request(guest.token, "/api/workspace/graph", {
      method: "POST",
      body: JSON.stringify({
        flowId: "shared-flow",
        flowSource: "workspace",
        baseRevision: sharedRevision,
        baseGraph: sharedBase,
        graph: {
          ...sharedBase,
          instances: {
            ...sharedBase.instances,
            node_a: { ...sharedBase.instances.node_a, label: "Guest changed A" },
          },
        },
      }),
    });
    assert.equal(guestFieldSave.status, 409);
    const conflict = await guestFieldSave.json();
    assert.equal(conflict.conflict, "field-conflict");
    assert.deepEqual(conflict.conflictPaths, ["$.instances.node_a.label"]);
    assert.equal(conflict.conflictItems[0].current, "Owner changed A");
    assert.equal(conflict.conflictItems[0].incoming, "Guest changed A");
    assert.deepEqual(conflict.conflictItems[0].pathParts, ["instances", "node_a", "label"]);
    assert.equal(conflict.mergeGraph.instances.node_a.label, "Owner changed A");
    assert.equal(conflict.currentGraph.instances.node_a.label, "Owner changed A");

    const resolvedGraph = structuredClone(conflict.mergeGraph);
    resolvedGraph.instances.node_a.label = conflict.conflictItems[0].incoming;
    const resolvedSave = await request(guest.token, "/api/workspace/graph", {
      method: "POST",
      body: JSON.stringify({
        flowId: "shared-flow",
        flowSource: "workspace",
        baseRevision: conflict.currentRevision,
        baseGraph: conflict.currentGraph,
        graph: resolvedGraph,
      }),
    });
    const resolvedSaveJson = await resolvedSave.json();
    assert.equal(resolvedSave.status, 200, JSON.stringify(resolvedSaveJson));
    assert.equal(resolvedSaveJson.graph.instances.node_a.label, "Guest changed A");

    const leaveResponse = await request(guest.token, "/api/flow/delete", {
      method: "POST",
      body: JSON.stringify({
        flowId: "shared-flow",
        flowSource: "workspace",
        confirmFlowId: "shared-flow",
      }),
    });
    const leaveJson = await leaveResponse.json();
    assert.equal(leaveResponse.status, 200, JSON.stringify(leaveJson));
    assert.equal(leaveJson.left, true);
    assert.equal(fs.existsSync(flowDir), true);
    const guestFlowsAfterLeave = await request(guest.token, "/api/flows");
    assert.equal((await guestFlowsAfterLeave.json()).some((flow) => flow.id === "shared-flow" && flow.source === "workspace"), false);

    const personalFlowDir = path.join(dataRoot, "users", "owner", "pipelines", "personal-shared");
    fs.mkdirSync(personalFlowDir, { recursive: true });
    fs.writeFileSync(
      path.join(personalFlowDir, "flow.yaml"),
      "version: 1\ninstances: {}\nedges: []\n",
      "utf-8",
    );
    const sharePersonal = await request(owner.token, "/api/workspace/collaboration/share", {
      method: "POST",
      body: JSON.stringify({
        flowId: "personal-shared",
        flowSource: "user",
        username: "guest",
      }),
    });
    const sharePersonalJson = await sharePersonal.json();
    assert.equal(sharePersonal.status, 200, JSON.stringify(sharePersonalJson));
    const personalWorkspaceId = sharePersonalJson.workspace.id;
    const guestPersonalFlows = await request(guest.token, "/api/flows");
    const guestPersonalFlow = (await guestPersonalFlows.json()).find((flow) => (
      flow.id === "personal-shared" && flow.collaboration?.id === personalWorkspaceId
    ));
    assert.ok(guestPersonalFlow);
    assert.equal(guestPersonalFlow.collaboration.role, "editor");
    const guestPersonalGraph = await request(
      guest.token,
      `/api/workspace/graph?flowId=personal-shared&flowSource=user&workspaceId=${encodeURIComponent(personalWorkspaceId)}`,
    );
    assert.equal(guestPersonalGraph.status, 200);
    const leavePersonal = await request(guest.token, "/api/flow/delete", {
      method: "POST",
      body: JSON.stringify({
        flowId: "personal-shared",
        flowSource: "user",
        workspaceId: personalWorkspaceId,
        confirmFlowId: "personal-shared",
      }),
    });
    const leavePersonalJson = await leavePersonal.json();
    assert.equal(leavePersonal.status, 200, JSON.stringify(leavePersonalJson));
    assert.equal(leavePersonalJson.left, true);
    const ownerPersonalFlows = await request(owner.token, "/api/flows");
    assert.equal((await ownerPersonalFlows.json()).some((flow) => flow.id === "personal-shared" && flow.source === "user"), true);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome == null) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
