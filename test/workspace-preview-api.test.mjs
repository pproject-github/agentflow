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
    const reviewer = loginOrCreateUser("preview-reviewer", "preview-password");
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
          // showOnNode 与 builtin/nodes/workspace_run.md 的定义一致；否则读取时会被
          // hydrateWorkspaceSlotMetaFromDefinitions 回填，往返就不是恒等
          input: [{ type: "node", name: "prev", value: "", showOnNode: true }],
          output: [{ type: "node", name: "next", value: "", showOnNode: true }],
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
    assert.equal(payload.flowSource, "workspace");
    assert.equal(payload.archived, true);
    assert.match(payload.url, new RegExp(`/workspace\\?flowId=${payload.flowId}\\&flowSource=workspace\\&archived=1`));

    // 预览不是 personal Flow：创建者与浏览器当前登录用户可以不同。链接本身随机且带 TTL，
    // 服务端把它作为 archived Workspace 只读暴露。
    const graphResponse = await fetch(`${baseUrl}/api/workspace/graph?flowId=${encodeURIComponent(payload.flowId)}&flowSource=workspace&archived=1`, {
      headers: { Authorization: `Bearer ${reviewer.token}` },
    });
    assert.equal(graphResponse.status, 200);
    const graphPayload = await graphResponse.json();
    assert.deepEqual(graphPayload.graph.instances, graph.instances);
    assert.equal(graphPayload.writable, false);

    const flowsResponse = await fetch(`${baseUrl}/api/flows`, { headers: { Authorization: `Bearer ${user.token}` } });
    assert.equal((await flowsResponse.json()).some((item) => item.id === payload.flowId), false);

    const writeResponse = await fetch(`${baseUrl}/api/workspace/graph`, {
      method: "POST",
      headers: { Authorization: `Bearer ${reviewer.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ flowId: payload.flowId, flowSource: "workspace", archived: true, graph }),
    });
    assert.equal(writeResponse.status, 400);

    const runResponse = await fetch(`${baseUrl}/api/workspace/run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${reviewer.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ flowId: payload.flowId, flowSource: "workspace", archived: true }),
    });
    assert.equal(runResponse.status, 400);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
