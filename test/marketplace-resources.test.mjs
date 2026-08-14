import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  listMarketplaceFlows,
  listMarketplacePackages,
  publishMarketplaceFlow,
  publishNodePackage,
  readMarketplaceFlow,
  setMarketplaceVisibility,
} from "../bin/lib/marketplace.mjs";
import {
  appendMarketplaceUsageEvent,
  marketplaceResourcesForRun,
  recordMarketplaceRunUsage,
  writeMarketplaceFlowOrigin,
} from "../bin/lib/marketplace-usage.mjs";

function tempWorkspace() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-marketplace-resources-")));
}

function writeNodePackage(root, id, version) {
  const dir = path.join(root, `${id}-${version}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.mjs"), `export default {
  id: ${JSON.stringify(id)},
  version: ${JSON.stringify(version)},
  name: ${JSON.stringify(id)},
  inputs: {},
  outputs: { result: { type: "text" } },
};
export async function run() {}
`, "utf-8");
  return dir;
}

test("marketplace 节点公开可查、可私有化，并返回去重后的使用统计", () => {
  const root = tempWorkspace();
  const published = publishNodePackage(root, writeNodePackage(root, "shared_node", "1.0.0"), {
    ownerUserId: "owner-1",
    immutable: true,
  });
  assert.equal(published.ok, true);

  appendMarketplaceUsageEvent(root, {
    kind: "node",
    id: "shared_node",
    version: "1.0.0",
    action: "install",
    actorUserId: "consumer-1",
    eventId: "install:node:shared_node@1.0.0:consumer-1",
  });
  appendMarketplaceUsageEvent(root, {
    kind: "node",
    id: "shared_node",
    version: "1.0.0",
    action: "install",
    actorUserId: "consumer-1",
    eventId: "install:node:shared_node@1.0.0:consumer-1",
  });
  recordMarketplaceRunUsage(root, [{ kind: "node", id: "shared_node", version: "1.0.0" }], {
    status: "success",
    runId: "run-1",
    userId: "consumer-1",
  });

  const publicNode = listMarketplacePackages(root, { userId: "consumer-1", marketplaceScope: "all" }).nodes[0];
  assert.equal(publicNode.visibility, "public");
  assert.equal(publicNode.installCount, 1);
  assert.equal(publicNode.useCount, 1);
  assert.equal(publicNode.uniqueUserCount, 1);

  assert.equal(setMarketplaceVisibility(root, "node", "shared_node", "1.0.0", "private", { userId: "owner-1" }).ok, true);
  assert.equal(listMarketplacePackages(root, { userId: "consumer-1", marketplaceScope: "all" }).nodes.length, 0);
  assert.equal(listMarketplacePackages(root, { userId: "owner-1", marketplaceScope: "owned" }).nodes[0].visibility, "private");
});

test("完整 Flow 以关闭定时入口的市场快照发布，安装副本保留来源并累计使用次数", () => {
  const root = tempWorkspace();
  const graph = {
    instances: {
      run: { definitionId: "workspace_run", label: "Run", input: [], output: [] },
      node: { definitionId: "marketplace:shared_node@1.0.0", marketplaceRef: "marketplace:shared_node@1.0.0", input: [], output: [] },
    },
    edges: [],
  };
  const published = publishMarketplaceFlow(root, {
    id: "shared-flow",
    version: "1.0.0",
    displayName: "Shared Flow",
    visibility: "public",
    graph,
  }, { userId: "owner-1" });
  assert.equal(published.ok, true);
  assert.equal(listMarketplaceFlows(root, { userId: "consumer-1" }).flows.length, 1);
  assert.deepEqual(readMarketplaceFlow(root, "shared-flow", "1.0.0", { userId: "consumer-1" }).graph, graph);

  const installedDir = path.join(root, "installed-flow");
  fs.mkdirSync(installedDir, { recursive: true });
  writeMarketplaceFlowOrigin(installedDir, { id: "shared-flow", version: "1.0.0" });
  const resources = marketplaceResourcesForRun(installedDir, graph, ["node"]);
  assert.deepEqual(resources, [
    { kind: "flow", id: "shared-flow", version: "1.0.0" },
    { kind: "node", id: "shared_node", version: "1.0.0" },
  ]);
  recordMarketplaceRunUsage(root, resources, { status: "success", runId: "run-2", userId: "consumer-1" });
  assert.equal(listMarketplaceFlows(root, { userId: "consumer-1" }).flows[0].useCount, 1);

  assert.equal(setMarketplaceVisibility(root, "flow", "shared-flow", "1.0.0", "private", { userId: "owner-1" }).ok, true);
  assert.equal(listMarketplaceFlows(root, { userId: "consumer-1" }).flows.length, 0);
  assert.equal(listMarketplaceFlows(root, { userId: "owner-1", marketplaceScope: "owned" }).flows[0].visibility, "private");
});

test("市场查询 API 默认按使用次数倒序，并把统计字段返回给调用方", async () => {
  const root = tempWorkspace();
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(root, "data");
  let server;
  try {
    const nonce = `${Date.now()}-${Math.random()}`;
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?marketplace-api=${nonce}`),
      import(`../bin/lib/ui-server.mjs?marketplace-api=${nonce}`),
    ]);
    const owner = loginOrCreateUser("market-owner", "market-owner-password");
    const consumer = loginOrCreateUser("market-consumer", "market-consumer-password");
    assert.equal(owner.ok, true);
    assert.equal(consumer.ok, true);
    publishMarketplaceFlow(root, {
      id: "less-used",
      version: "1.0.0",
      graph: { instances: {}, edges: [] },
    }, { userId: owner.user.userId });
    publishMarketplaceFlow(root, {
      id: "more-used",
      version: "1.0.0",
      graph: { instances: {}, edges: [] },
    }, { userId: owner.user.userId });
    recordMarketplaceRunUsage(root, [{ kind: "flow", id: "more-used", version: "1.0.0" }], {
      status: "success",
      runId: "market-run-1",
      userId: consumer.user.userId,
    });
    recordMarketplaceRunUsage(root, [{ kind: "flow", id: "more-used", version: "1.0.0" }], {
      status: "success",
      runId: "market-run-2",
      userId: consumer.user.userId,
    });
    server = await startUiServer({
      workspaceRoot: root,
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(root, "static"),
    });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/marketplace/resources?kind=flow`, {
      headers: { Authorization: `Bearer ${consumer.token}` },
    });
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.sort, "useCount");
    assert.equal(body.order, "desc");
    assert.deepEqual(body.items.map((item) => item.id), ["more-used", "less-used"]);
    assert.equal(body.items[0].useCount, 2);
    assert.equal(body.items[0].installCount, 0);
    assert.equal(body.items[0].uniqueUserCount, 1);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
  }
});
