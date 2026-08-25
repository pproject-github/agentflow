import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  listMarketplaceFlows,
  listMarketplacePackages,
  publishMarketplaceFlow,
  publishFlowSnippet,
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
    const [
      { loginOrCreateUser },
      { getUserPipelinesRoot, PIPELINES_DIR },
      { ensureWorkspaceCollaboration },
      { appendWorkspaceRunFinished, appendWorkspaceRunStarted, publishWorkspaceRelease },
      { startUiServer },
    ] = await Promise.all([
      import(`../bin/lib/auth.mjs?marketplace-api=${nonce}`),
      import(`../bin/lib/paths.mjs?marketplace-api=${nonce}`),
      import(`../bin/lib/workspace-collaboration.mjs?marketplace-api=${nonce}`),
      import(`../bin/lib/workspace-server.mjs?marketplace-api=${nonce}`),
      import(`../bin/lib/ui-server.mjs?marketplace-api=${nonce}`),
    ]);
    const owner = loginOrCreateUser("market-owner", "market-owner-password");
    const consumer = loginOrCreateUser("market-consumer", "market-consumer-password");
    assert.equal(owner.ok, true);
    assert.equal(consumer.ok, true);
    const runnableProjectDir = path.join(getUserPipelinesRoot(owner.user.userId), "auto-runnable-flow");
    fs.mkdirSync(runnableProjectDir, { recursive: true });
    fs.writeFileSync(path.join(runnableProjectDir, "flow.yaml"), "version: 1\ninstances: {}\nedges: []\n", "utf-8");
    fs.writeFileSync(path.join(runnableProjectDir, "workspace.graph.json"), `${JSON.stringify({
      version: 1,
      instances: {
        run: { instanceId: "run", definitionId: "workspace_run", label: "Run", input: [], output: [{ name: "next", type: "node" }] },
        work: { instanceId: "work", definitionId: "provide_text", label: "Work", input: [{ name: "prev", type: "node" }], output: [] },
        unrelated: { instanceId: "unrelated", definitionId: "provide_text", label: "Unrelated project note", input: [], output: [] },
      },
      edges: [{ source: "run", sourceHandle: "output-0", target: "work", targetHandle: "input-0" }],
      ui: { description: "Automatically visible runnable project" },
    }, null, 2)}\n`, "utf-8");
    const stableRelease = publishWorkspaceRelease(runnableProjectDir, root, { createdBy: owner.user.userId });
    assert.equal(stableRelease.ok, true);
    const directRun = {
      runId: "direct-project-run-1",
      userId: owner.user.userId,
      username: owner.user.username,
      flowId: "auto-runnable-flow",
      flowSource: "user",
      runNodeId: "run",
      startedAt: Date.now() - 500,
      endedAt: Date.now(),
      workspaceRoot: root,
    };
    appendWorkspaceRunStarted(directRun);
    appendWorkspaceRunFinished(directRun, "success");
    const nonRunnableProjectDir = path.join(getUserPipelinesRoot(owner.user.userId), "not-runnable-flow");
    fs.mkdirSync(nonRunnableProjectDir, { recursive: true });
    fs.writeFileSync(path.join(nonRunnableProjectDir, "flow.yaml"), "version: 1\ninstances: {}\nedges: []\n", "utf-8");
    fs.writeFileSync(path.join(nonRunnableProjectDir, "workspace.graph.json"), `${JSON.stringify({
      version: 1,
      instances: {
        empty_run: { instanceId: "empty_run", definitionId: "workspace_run", label: "Run", input: [], output: [{ name: "next", type: "node" }] },
        work: { instanceId: "work", definitionId: "provide_text", label: "Work", input: [], output: [] },
      },
      edges: [],
    }, null, 2)}\n`, "utf-8");
    const multiRunnableProjectDir = path.join(getUserPipelinesRoot(owner.user.userId), "multi-runnable-flow");
    fs.mkdirSync(multiRunnableProjectDir, { recursive: true });
    fs.writeFileSync(path.join(multiRunnableProjectDir, "flow.yaml"), "version: 1\ninstances: {}\nedges: []\n", "utf-8");
    fs.writeFileSync(path.join(multiRunnableProjectDir, "workspace.graph.json"), `${JSON.stringify({
      version: 1,
      instances: {
        run_a: { instanceId: "run_a", definitionId: "workspace_run", label: "Morning", input: [], output: [{ name: "next", type: "node" }] },
        work_a: { instanceId: "work_a", definitionId: "provide_text", label: "Morning work", input: [{ name: "prev", type: "node" }], output: [] },
        run_b: { instanceId: "run_b", definitionId: "workspace_scheduled_run", label: "Nightly", input: [], output: [{ name: "next", type: "node" }] },
        work_b: { instanceId: "work_b", definitionId: "provide_text", label: "Nightly work", input: [{ name: "prev", type: "node" }], output: [] },
        note: { instanceId: "note", definitionId: "provide_text", label: "Project note", input: [], output: [] },
      },
      edges: [
        { source: "run_a", sourceHandle: "output-0", target: "work_a", targetHandle: "input-0" },
        { source: "run_b", sourceHandle: "output-0", target: "work_b", targetHandle: "input-0" },
      ],
    }, null, 2)}\n`, "utf-8");
    const sharedRunnableDir = path.join(root, PIPELINES_DIR, "shared-runnable-flow");
    fs.mkdirSync(sharedRunnableDir, { recursive: true });
    fs.writeFileSync(path.join(sharedRunnableDir, "flow.yaml"), "version: 1\ninstances: {}\nedges: []\n", "utf-8");
    fs.writeFileSync(path.join(sharedRunnableDir, "workspace.graph.json"), `${JSON.stringify({
      version: 1,
      instances: {
        scheduled: { instanceId: "scheduled", definitionId: "workspace_scheduled_run", label: "Scheduled Run", input: [], output: [{ name: "next", type: "node" }] },
        work: { instanceId: "work", definitionId: "provide_text", label: "Scheduled work", input: [{ name: "prev", type: "node" }], output: [] },
      },
      edges: [{ source: "scheduled", sourceHandle: "output-0", target: "work", targetHandle: "input-0" }],
    }, null, 2)}\n`, "utf-8");
    const sharedCollaboration = ensureWorkspaceCollaboration({
      flowId: "shared-runnable-flow",
      flowSource: "workspace",
      userId: owner.user.userId,
    });
    assert.equal(sharedCollaboration.created, true);
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
    publishFlowSnippet(root, {
      id: "useful-snippet",
      version: "1.0.0",
      displayName: "Useful Snippet",
      snippet: {
        instances: { first: { definitionId: "a" }, second: { definitionId: "b" } },
        edges: [{ source: "first", target: "second" }],
      },
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
    assert.deepEqual(
      body.items.filter((item) => item.resourceType === "flow" && !item.projectFlow).map((item) => item.id),
      ["more-used", "less-used"],
    );
    assert.equal(body.items[0].useCount, 2);
    assert.equal(body.items[0].installCount, 0);
    assert.equal(body.items[0].uniqueUserCount, 1);
    const automaticFlow = body.items.find((item) => item.displayName === "auto-runnable-flow");
    assert.equal(automaticFlow.displayName, "auto-runnable-flow");
    assert.equal(automaticFlow.visibility, "public");
    assert.equal(automaticFlow.versionLabel, "Stable v1");
    assert.equal(automaticFlow.useCount, 1, "successful source runs must count as flow usage");
    const sharedAutomaticFlow = body.items.find((item) => item.displayName === "shared-runnable-flow");
    assert.equal(sharedAutomaticFlow.liveFlowSource, "workspace");
    assert.equal(sharedAutomaticFlow.liveWorkspaceId, sharedCollaboration.record.id);
    assert.equal(body.items.some((item) => item.displayName === "not-runnable-flow"), false);
    const multiFlows = body.items.filter((item) => String(item.displayName || "").startsWith("multi-runnable-flow ·"));
    assert.equal(multiFlows.length, 2, "each connected Run entry must become one flow card");
    assert.deepEqual(multiFlows.map((item) => item.nodeCount).sort(), [2, 2]);
    assert.deepEqual(new Set(multiFlows.map((item) => item.runModeLabel)), new Set(["手动运行", "定时运行"]));

    const previewParams = new URLSearchParams({
      id: automaticFlow.id,
      version: automaticFlow.version,
      projectFlow: "1",
    });
    const previewResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/marketplace/flows/preview?${previewParams}`, {
      headers: { Authorization: `Bearer ${consumer.token}` },
    });
    const previewBody = await previewResponse.json();
    assert.equal(previewResponse.status, 200, JSON.stringify(previewBody));
    assert.equal(previewBody.flow.versionLabel, "Stable v1");
    assert.equal(previewBody.flow.owned, false);
    assert.equal(previewBody.graph.instances.run.definitionId, "workspace_run");
    assert.equal(previewBody.graph.instances.work.definitionId, "provide_text");
    assert.equal(Object.prototype.hasOwnProperty.call(previewBody.graph.instances, "unrelated"), false);
    assert.equal(Object.prototype.hasOwnProperty.call(previewBody.flow, "_graph"), false);

    const workspacePreviewResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/marketplace/flows/workspace-preview`, {
      method: "POST",
      headers: { Authorization: `Bearer ${consumer.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: automaticFlow.id, version: automaticFlow.version, projectFlow: true }),
    });
    const workspacePreviewBody = await workspacePreviewResponse.json();
    assert.equal(workspacePreviewResponse.status, 200, JSON.stringify(workspacePreviewBody));
    const workspacePreviewUrl = new URL(workspacePreviewBody.url, `http://127.0.0.1:${server.address().port}`);
    assert.equal(workspacePreviewUrl.pathname, "/workspace");
    assert.equal(workspacePreviewUrl.searchParams.get("marketplacePreview"), "1");
    const readonlyGraphResponse = await fetch(`${workspacePreviewUrl.origin}/api/workspace/graph?flowId=${encodeURIComponent(workspacePreviewUrl.searchParams.get("flowId"))}&flowSource=workspace&archived=1`, {
      headers: { Authorization: `Bearer ${consumer.token}` },
    });
    const readonlyGraph = await readonlyGraphResponse.json();
    assert.equal(readonlyGraphResponse.status, 200, JSON.stringify(readonlyGraph));
    assert.equal(readonlyGraph.writable, false);
    assert.equal(readonlyGraph.graph.instances.run.definitionId, "workspace_run");
    assert.equal(Object.prototype.hasOwnProperty.call(readonlyGraph.graph.instances, "unrelated"), false);

    const privateResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/marketplace/visibility`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "project-flow",
        id: automaticFlow.id,
        version: automaticFlow.version,
        visibility: "private",
      }),
    });
    assert.equal(privateResponse.status, 200, await privateResponse.text());
    const hiddenResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/marketplace/resources?kind=flow`, {
      headers: { Authorization: `Bearer ${consumer.token}` },
    });
    const hiddenBody = await hiddenResponse.json();
    assert.equal(hiddenResponse.status, 200, JSON.stringify(hiddenBody));
    assert.equal(hiddenBody.items.some((item) => item.id === automaticFlow.id), false);
    const hiddenPreviewResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/marketplace/flows/preview?${previewParams}`, {
      headers: { Authorization: `Bearer ${consumer.token}` },
    });
    assert.equal(hiddenPreviewResponse.status, 404);

    const publicResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/marketplace/visibility`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${owner.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "project-flow",
        id: automaticFlow.id,
        version: automaticFlow.version,
        visibility: "public",
      }),
    });
    assert.equal(publicResponse.status, 200, await publicResponse.text());

    for (let index = 0; index < 2; index += 1) {
      const snippetUseResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/marketplace/flow-snippets/use`, {
        method: "POST",
        headers: { Authorization: `Bearer ${consumer.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ id: "useful-snippet", version: "1.0.0", eventId: "insert-1" }),
      });
      assert.equal(snippetUseResponse.status, 200);
    }
    const snippetStatsResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/marketplace/resources?kind=flow&q=useful-snippet`, {
      headers: { Authorization: `Bearer ${consumer.token}` },
    });
    assert.equal(snippetStatsResponse.status, 200);
    const snippetStats = await snippetStatsResponse.json();
    assert.equal(snippetStats.items[0].resourceType, "flow-snippet");
    assert.equal(snippetStats.items[0].useCount, 1, "same insertion event must be counted once");
    assert.equal(snippetStats.items[0].uniqueUserCount, 1);
    const snippetWorkspacePreviewResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/marketplace/flows/workspace-preview`, {
      method: "POST",
      headers: { Authorization: `Bearer ${consumer.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "useful-snippet", version: "1.0.0", kind: "snippet" }),
    });
    const snippetWorkspacePreview = await snippetWorkspacePreviewResponse.json();
    assert.equal(snippetWorkspacePreviewResponse.status, 200, JSON.stringify(snippetWorkspacePreview));
    const snippetWorkspaceUrl = new URL(snippetWorkspacePreview.url, `http://127.0.0.1:${server.address().port}`);
    assert.equal(snippetWorkspaceUrl.pathname, "/workspace");
    assert.equal(snippetWorkspaceUrl.searchParams.get("marketplaceAction"), "add-snippet");
    assert.equal(snippetWorkspaceUrl.searchParams.get("marketplaceKind"), "snippet");

    const ownedResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/marketplace/resources?kind=flow&scope=owned&q=snippet`, {
      headers: { Authorization: `Bearer ${owner.token}` },
    });
    assert.equal(ownedResponse.status, 200);
    const ownedBody = await ownedResponse.json();
    assert.equal(ownedBody.items.length, 1);
    assert.equal(ownedBody.items[0].resourceType, "flow-snippet");

    const installResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/marketplace/flows/install`, {
      method: "POST",
      headers: { Authorization: `Bearer ${consumer.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: "more-used", version: "1.0.0", flowId: "installed-market-flow" }),
    });
    assert.equal(installResponse.status, 201);
    const installedResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/marketplace/resources?kind=flow&scope=installed`, {
      headers: { Authorization: `Bearer ${consumer.token}` },
    });
    assert.equal(installedResponse.status, 200);
    const installedBody = await installedResponse.json();
    assert.deepEqual(installedBody.items.map((item) => item.id), ["more-used"]);
    assert.deepEqual(installedBody.items[0].installedFlowIds, ["installed-market-flow"]);

    const installAutomaticResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/marketplace/flows/install`, {
      method: "POST",
      headers: { Authorization: `Bearer ${consumer.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        id: automaticFlow.id,
        version: automaticFlow.version,
        flowId: "installed-runnable-project",
        projectFlow: true,
      }),
    });
    assert.equal(installAutomaticResponse.status, 201, await installAutomaticResponse.text());
    assert.deepEqual(
      marketplaceResourcesForRun(
        path.join(getUserPipelinesRoot(consumer.user.userId), "installed-runnable-project"),
        { instances: {}, edges: [] },
      ),
      [{ kind: "project-flow", id: automaticFlow.id, version: automaticFlow.version }],
    );
    const installedAutomaticResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/marketplace/resources?kind=flow&scope=installed`, {
      headers: { Authorization: `Bearer ${consumer.token}` },
    });
    const installedAutomaticBody = await installedAutomaticResponse.json();
    assert.equal(installedAutomaticResponse.status, 200, JSON.stringify(installedAutomaticBody));
    assert.equal(
      installedAutomaticBody.items.find((item) => item.id === automaticFlow.id)?.installedFlowIds?.[0],
      "installed-runnable-project",
    );

    const installedNodesResponse = await fetch(`http://127.0.0.1:${server.address().port}/api/marketplace/resources?kind=node&scope=installed`, {
      headers: { Authorization: `Bearer ${consumer.token}` },
    });
    assert.equal(installedNodesResponse.status, 200);
    const installedNodesBody = await installedNodesResponse.json();
    assert.ok(installedNodesBody.items.some((item) => item.localCatalog === true));
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
  }
});
