import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { mergeWorkspaceGraphs, workspaceDesignRevision } from "../bin/lib/workspace-graph-merge.mjs";

/**
 * 一张同时含有四种运行产出位置的图：
 * agent 的输出值、被连线驱动的入槽值、上下文注入槽值、展示节点正文。
 * `role: "normal"` 和非规范槽序是老 UI 存出来的形状，用来逼出代码化时的规范化。
 */
function seedGraph() {
  return {
    version: 1,
    instances: {
      agent_1: {
        definitionId: "agent_subAgent",
        label: "干活",
        role: "normal",
        body: "写一段东西",
        input: [
          { type: "node", name: "prev", value: "" },
          { type: "text", name: "workspaceContext", value: "上次灌进来的工作区摘要" },
        ],
        output: [
          { type: "node", name: "next", value: "" },
          { type: "text", name: "result", value: "上次跑出来的产出" },
        ],
      },
      display_1: {
        definitionId: "display_markdown",
        label: "展示",
        role: "normal",
        body: "上次运行的展示正文",
        input: [
          { type: "text", name: "content", value: "上次运行的展示正文" },
          { type: "node", name: "prev", value: "" },
        ],
        output: [{ type: "node", name: "next", value: "" }],
      },
    },
    edges: [
      { source: "agent_1", target: "display_1", sourceHandle: "output-0", targetHandle: "input-1" },
      { source: "agent_1", target: "display_1", sourceHandle: "output-1", targetHandle: "input-0" },
    ],
    ui: { nodePositions: { agent_1: { x: 0, y: 0 }, display_1: { x: 280, y: 0 } } },
  };
}

/** 把一张图上所有「运行产出」位置改掉，设计部分一个字不动。 */
function applyRunOutput(graph, marker) {
  const next = structuredClone(graph);
  const agent = next.instances.agent_1;
  agent.output.find((s) => s.name === "result").value = `${marker} 的产出`;
  agent.input.find((s) => s.name === "workspaceContext").value = `${marker} 的上下文`;
  const display = next.instances.display_1;
  display.body = `${marker} 的展示正文`;
  display.input.find((s) => s.name === "content").value = `${marker} 的展示正文`;
  return next;
}

async function withServer(run) {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-collab-rev-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?collab-rev=${nonce}`),
      import(`../bin/lib/ui-server.mjs?collab-rev=${nonce}`),
    ]);
    const user = loginOrCreateUser("collab-rev-owner", "collab-rev-password");
    server = await startUiServer({
      workspaceRoot: path.join(tempRoot, "workspace"),
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const auth = { Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" };
    const api = {
      get: async (p) => (await fetch(baseUrl + p, { headers: auth })).json(),
      post: async (p, body) => {
        const res = await fetch(baseUrl + p, { method: "POST", headers: auth, body: JSON.stringify(body) });
        return { status: res.status, body: await res.json() };
      },
    };
    await api.post("/api/flows", { flowId: "rev-flow", targetSpace: "user" });
    const seeded = await api.get("/api/workspace/graph?flowId=rev-flow&flowSource=user");
    // 播成迁移前的历史格式：整张图都还在 workspace.graph.json 里
    fs.writeFileSync(path.join(seeded.root, "workspace.graph.json"), JSON.stringify(seedGraph(), null, 2), "utf-8");
    await run(api, seeded.root);
  } finally {
    if (server) server.close();
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

test("存图返回的 revision 就是磁盘上那张图的 revision", async () => {
  await withServer(async (api) => {
    const before = await api.get("/api/workspace/graph?flowId=rev-flow&flowSource=user");
    const saved = await api.post("/api/workspace/graph", {
      flowId: "rev-flow", flowSource: "user",
      graph: before.graph, baseRevision: before.revision, baseGraph: before.graph,
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));

    const after = await api.get("/api/workspace/graph?flowId=rev-flow&flowSource=user");
    // 代码化会做规范化，所以存进去的和读出来的不一定逐字相同——但返回的 revision
    // 必须描述磁盘上那一版，否则客户端手里的基线一存就废
    assert.equal(saved.body.revision, after.revision, "POST 返回的 revision 与随后 GET 的对不上");
    assert.equal(workspaceDesignRevision(saved.body.graph), after.revision);

    // 拿 POST 返回的 revision 当基线立刻再存一次，必须能存进去
    const again = await api.post("/api/workspace/graph", {
      flowId: "rev-flow", flowSource: "user",
      graph: saved.body.graph, baseRevision: saved.body.revision, baseGraph: saved.body.graph,
    });
    assert.equal(again.status, 200, JSON.stringify(again.body));
  });
});

test("只产生运行产出的一次运行不改变 designRevision，协作者的基线仍然有效", async () => {
  await withServer(async (api) => {
    await api.post("/api/workspace/graph", { flowId: "rev-flow", flowSource: "user", graph: seedGraph() });
    const shared = await api.get("/api/workspace/graph?flowId=rev-flow&flowSource=user");

    // 甲跑了一次流程：只有运行产出变了
    const ran = await api.post("/api/workspace/graph", {
      flowId: "rev-flow", flowSource: "user",
      graph: applyRunOutput(shared.graph, "甲"),
      baseRevision: shared.revision, baseGraph: shared.graph,
    });
    assert.equal(ran.status, 200, JSON.stringify(ran.body));
    assert.equal(ran.body.revision, shared.revision, "跑一次流程不该改变设计版本号");
    assert.notEqual(ran.body.runtimeRevision, shared.runtimeRevision, "运行版本号应当变了");

    // 乙手里还是跑之前的基线，改一个真正的设计字段，必须能干净存进去
    const edited = structuredClone(shared.graph);
    edited.instances.agent_1.label = "乙改的名字";
    const guestSave = await api.post("/api/workspace/graph", {
      flowId: "rev-flow", flowSource: "user",
      graph: edited, baseRevision: shared.revision, baseGraph: shared.graph,
    });
    assert.equal(guestSave.status, 200, JSON.stringify(guestSave.body));
    assert.equal(guestSave.body.graph.instances.agent_1.label, "乙改的名字");
    // 甲跑出来的产出不能被乙这次保存冲掉
    assert.equal(
      guestSave.body.graph.instances.agent_1.output.find((s) => s.name === "result").value,
      "甲 的产出",
    );
    assert.equal(guestSave.body.graph.instances.display_1.body, "甲 的展示正文");
  });
});

test("两边同时跑出不同产出不算冲突，设计字段冲突照报", () => {
  const base = seedGraph();
  const runtimeOnly = mergeWorkspaceGraphs({
    baseGraph: base,
    currentGraph: applyRunOutput(base, "甲"),
    incomingGraph: applyRunOutput(base, "乙"),
  });
  assert.deepEqual(runtimeOnly.conflicts.map((c) => c.path), [], "运行产出撞车不该当成冲突");
  const merged = runtimeOnly.graph;
  assert.equal(merged.instances.agent_1.output.find((s) => s.name === "result").value, "乙 的产出");
  assert.equal(merged.instances.agent_1.input.find((s) => s.name === "workspaceContext").value, "乙 的上下文");
  assert.equal(merged.instances.display_1.body, "乙 的展示正文");
  assert.equal(merged.instances.display_1.input.find((s) => s.name === "content").value, "乙 的展示正文");

  const currentEdit = structuredClone(base);
  currentEdit.instances.agent_1.body = "甲写的提示词";
  const incomingEdit = structuredClone(base);
  incomingEdit.instances.agent_1.body = "乙写的提示词";
  const designClash = mergeWorkspaceGraphs({
    baseGraph: base, currentGraph: currentEdit, incomingGraph: incomingEdit,
  });
  assert.deepEqual(designClash.conflicts.map((c) => c.path), ["$.instances.agent_1.body"]);
});

test("没有入边的入槽值是设计态，两边改不同值仍然是冲突", () => {
  const base = seedGraph();
  // provide 节点的输出值、以及没有入边的普通入槽值，都是作者填的
  base.instances.agent_1.input.push({ type: "text", name: "topic", value: "原来的主题" });
  const current = structuredClone(base);
  current.instances.agent_1.input.find((s) => s.name === "topic").value = "甲的主题";
  const incoming = structuredClone(base);
  incoming.instances.agent_1.input.find((s) => s.name === "topic").value = "乙的主题";

  const result = mergeWorkspaceGraphs({ baseGraph: base, currentGraph: current, incomingGraph: incoming });
  assert.equal(result.conflicts.length, 1, JSON.stringify(result.conflicts));
  assert.equal(result.conflicts[0].current, "甲的主题");
  assert.equal(result.conflicts[0].incoming, "乙的主题");
});
