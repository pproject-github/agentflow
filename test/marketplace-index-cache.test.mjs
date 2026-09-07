import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// 用户需求点: 流程仓库列表和预览每次都强制重建仓库索引（线上 74 个流程约 0.8s 同步阻塞），
// 因为存图时没有让索引失效。存图标脏之后，读接口必须走缓存。
test("marketplace reads reuse the repository index and a graph save invalidates it", async (t) => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-marketplace-index-")));
  const workspaceRoot = path.join(tempRoot, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");

  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const nonce = Date.now();
  const [{ loginOrCreateUser }, { getUserPipelinesRoot }, { startUiServer }] = await Promise.all([
    import(`../bin/lib/auth.mjs?marketplace-index-cache=${nonce}`),
    import(`../bin/lib/paths.mjs?marketplace-index-cache=${nonce}`),
    import(`../bin/lib/ui-server.mjs?marketplace-index-cache=${nonce}`),
  ]);

  const owner = loginOrCreateUser("index-cache-owner", "index-cache-password");
  const flowId = "index-cache-flow";
  const flowDir = path.join(getUserPipelinesRoot(owner.user.userId), flowId);
  fs.mkdirSync(flowDir, { recursive: true });
  const graphOf = (label) => ({
    version: 1,
    instances: {
      run: { instanceId: "run", definitionId: "workspace_run", label: "Run", input: [], output: [{ name: "next", type: "node" }] },
      work: { instanceId: "work", definitionId: "provide_text", label, input: [{ name: "prev", type: "node" }], output: [] },
    },
    edges: [{ source: "run", sourceHandle: "output-0", target: "work", targetHandle: "input-0" }],
  });
  fs.writeFileSync(path.join(flowDir, "flow.yaml"), "version: 1\ninstances: {}\nedges: []\n", "utf-8");
  fs.writeFileSync(
    path.join(flowDir, "workspace.graph.json"),
    `${JSON.stringify(graphOf("Work"), null, 2)}\n`,
    "utf-8",
  );

  server = await startUiServer({
    workspaceRoot,
    host: "127.0.0.1",
    port: 0,
    staticDir: path.join(tempRoot, "static"),
    enableWorkspaceScheduler: false,
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const authHeaders = { Authorization: `Bearer ${owner.token}` };
  const listResources = async () => {
    const response = await fetch(`${base}/api/marketplace/resources?kind=flow&scope=all`, { headers: authHeaders });
    assert.equal(response.status, 200);
    return response.json();
  };

  const first = await listResources();
  const listed = first.items.find((item) => item.liveFlowId === flowId);
  assert.ok(listed, "自己的可运行流程应当出现在流程仓库里");

  // 连续两次列表请求不能各自重建一次索引。
  const second = await listResources();
  assert.equal(second.index.generatedAt, first.index.generatedAt);

  // 预览同样是读路径，也不该触发重建。
  const preview = await fetch(
    `${base}/api/marketplace/flows/preview?id=${encodeURIComponent(listed.id)}&version=${encodeURIComponent(listed.version)}&projectFlow=1`,
    { headers: authHeaders },
  );
  assert.equal(preview.status, 200);
  const previewBody = await preview.json();
  assert.ok(previewBody.graph?.instances?.run, "预览要返回入口节点");
  const afterPreview = await listResources();
  assert.equal(afterPreview.index.generatedAt, first.index.generatedAt);

  // 存图是索引过期的时刻：保存后列表必须自己看到新版本，不需要读接口强制重建。
  const save = await fetch(`${base}/api/workspace/graph`, {
    method: "POST",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ flowId, flowSource: "user", graph: graphOf("Work renamed") }),
  });
  assert.equal(save.status, 200);

  let refreshed = null;
  for (let attempt = 0; attempt < 40; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    refreshed = await listResources();
    if (refreshed.index.generatedAt !== first.index.generatedAt) break;
  }
  assert.notEqual(refreshed.index.generatedAt, first.index.generatedAt, "存图后索引应当被重建");
  const refreshedItem = refreshed.items.find((item) => item.liveFlowId === flowId);
  assert.ok(refreshedItem);
  assert.notEqual(refreshedItem.version, listed.version, "改了图之后版本号应当变化");
});
