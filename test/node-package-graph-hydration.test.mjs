import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const PACKAGE_SOURCE = `import fs from "node:fs/promises";

export default {
  id: "count_lines",
  version: "1.0.0",
  name: "统计行数",
  inputs: { filePath: { type: "text" } },
  outputs: { total: { type: "text" } },
};

export async function run({ filePath }, outputs) {
  const text = await fs.readFile(filePath, "utf-8");
  await fs.writeFile(outputs.total, String(text.split("\\n").length));
}
`;

test("flow 自带的代码节点包在读图时被 hydrate 成 bootstrap 命令", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-node-pkg-graph-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?node-pkg-graph=${nonce}`),
      import(`../bin/lib/ui-server.mjs?node-pkg-graph=${nonce}`),
    ]);
    const user = loginOrCreateUser("node-pkg-owner", "node-pkg-password");
    server = await startUiServer({
      workspaceRoot: path.join(tempRoot, "workspace"),
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const auth = { Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" };

    // 建一个 user flow，然后把代码节点包写进它的 nodes/ 目录
    const flowId = "pkg-flow";
    const createRes = await fetch(`${baseUrl}/api/flows`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ flowId, targetSpace: "user" }),
    });
    assert.equal(createRes.status, 200, `建流程失败: ${await createRes.text()}`);

    const graphRes0 = await fetch(
      `${baseUrl}/api/workspace/graph?flowId=${encodeURIComponent(flowId)}&flowSource=user`,
      { headers: auth },
    );
    assert.equal(graphRes0.status, 200);
    const flowDir = (await graphRes0.json()).root;
    assert.ok(flowDir, "拿不到 flow 目录");

    const pkgDir = path.join(flowDir, "nodes", "count-lines");
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, "index.mjs"), PACKAGE_SOURCE, "utf-8");

    // 节点包应出现在该流程的节点目录里
    const nodesRes = await fetch(
      `${baseUrl}/api/nodes?flowId=${encodeURIComponent(flowId)}&flowSource=user`,
      { headers: auth },
    );
    assert.equal(nodesRes.status, 200);
    const nodesJson = await nodesRes.json();
    const nodes = Array.isArray(nodesJson) ? nodesJson : nodesJson.nodes || [];
    const pkgDef = nodes.find((n) => n.id === "marketplace:count_lines@1.0.0");
    assert.ok(pkgDef, "flow 自带的节点包没进 /api/nodes");
    assert.equal(pkgDef.baseDefinitionId, "tool_nodejs");
    assert.deepEqual(pkgDef.inputs.map((s) => s.name), ["prev", "filePath"]);
    assert.deepEqual(pkgDef.outputs.map((s) => s.name), ["next", "total"]);

    // 存一张引用该包的图
    const saveRes = await fetch(`${baseUrl}/api/workspace/graph`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        flowId,
        flowSource: "user",
        graph: {
          version: 1,
          instances: {
            count_1: {
              definitionId: "marketplace:count_lines@1.0.0",
              label: "统计行数",
              input: [
                { type: "node", name: "prev", value: "" },
                { type: "text", name: "filePath", value: "/tmp/whatever.txt" },
              ],
              output: [
                { type: "node", name: "next", value: "" },
                { type: "text", name: "total", value: "" },
              ],
            },
          },
          edges: [],
          ui: { nodePositions: { count_1: { x: 100, y: 100 } } },
        },
      }),
    });
    assert.equal(saveRes.status, 200, `存图失败: ${await saveRes.text()}`);

    // 读回来：definitionId 归一成 tool_nodejs，script 是 bootstrap 命令
    const graphRes = await fetch(
      `${baseUrl}/api/workspace/graph?flowId=${encodeURIComponent(flowId)}&flowSource=user`,
      { headers: auth },
    );
    assert.equal(graphRes.status, 200);
    const instance = (await graphRes.json()).graph.instances.count_1;
    assert.equal(instance.definitionId, "tool_nodejs");
    assert.equal(instance.marketplaceRef, "marketplace:count_lines@1.0.0");
    assert.match(instance.script, /node .*node-package-bootstrap\.mjs/);
    assert.match(instance.script, /count-lines\/index\.mjs/);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
