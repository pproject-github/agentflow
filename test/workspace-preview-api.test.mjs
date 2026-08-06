import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("workspace-preview uploads a hidden TTL-bound graph and returns a Workspace URL", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-workspace-preview-api-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?workspace-preview-api=${nonce}`),
      import(`../bin/lib/ui-server.mjs?workspace-preview-api=${nonce}`),
    ]);
    const user = loginOrCreateUser("preview-owner", "preview-password");
    server = await startUiServer({
      workspaceRoot: path.join(tempRoot, "workspace"),
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const graph = {
      version: 1,
      instances: {
        workspace_run_1: {
          definitionId: "workspace_run",
          label: "Run",
          input: [{ type: "node", name: "prev", value: "" }],
          output: [{ type: "node", name: "next", value: "" }],
        },
      },
      edges: [],
      ui: { nodePositions: { workspace_run_1: { x: 100, y: 100 } } },
    };
    const response = await fetch(`${baseUrl}/api/workspace/preview`, {
      method: "POST",
      headers: { Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ graph, title: "Hello World Preview", ttlSeconds: 60 }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.preview, true);
    assert.equal(payload.flowSource, "user");
    assert.match(payload.url, new RegExp(`/workspace\\?flowId=${payload.flowId}\\&flowSource=user`));

    const graphResponse = await fetch(`${baseUrl}/api/workspace/graph?flowId=${encodeURIComponent(payload.flowId)}&flowSource=user`, {
      headers: { Authorization: `Bearer ${user.token}` },
    });
    assert.equal(graphResponse.status, 200);
    assert.deepEqual((await graphResponse.json()).graph.instances, graph.instances);

    const flowsResponse = await fetch(`${baseUrl}/api/flows`, { headers: { Authorization: `Bearer ${user.token}` } });
    assert.equal((await flowsResponse.json()).some((item) => item.id === payload.flowId), false);

    const retiredRunResponse = await fetch(`${baseUrl}/api/flow/run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ flowId: payload.flowId, flowSource: "user" }),
    });
    assert.equal(retiredRunResponse.status, 410);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
