import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  WORKSPACE_STATE_FILENAME,
  isEmptyWorkspaceState,
  mergeWorkspaceState,
  splitWorkspaceGraph,
} from "../bin/lib/workspace-state.mjs";

const canon = (v) => (
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon(v[k])]))
      : v
);

function assertRoundTrip(graph, label) {
  const { design, state } = splitWorkspaceGraph(graph);
  const back = mergeWorkspaceState(design, state);
  assert.deepEqual(canon(back), canon(graph), `${label}: 拆分再合并不等于原图`);
  // 幂等：对合并结果再拆一次，两个文件都不能变
  const again = splitWorkspaceGraph(back);
  assert.deepEqual(canon(again.design), canon(design), `${label}: design 不幂等`);
  assert.deepEqual(canon(again.state), canon(state), `${label}: state 不幂等`);
  return { design, state };
}

test("非 provide 节点的输出值外移，provide 的留在设计里", () => {
  const graph = {
    version: 1,
    instances: {
      p1: {
        definitionId: "provide_str",
        output: [{ type: "node", name: "next" }, { type: "text", name: "value", value: "用户填的" }],
      },
      a1: {
        definitionId: "agent_subAgent",
        output: [{ type: "node", name: "next" }, { type: "text", name: "result", value: "跑出来的" }],
      },
    },
    edges: [],
    ui: { nodePositions: {} },
  };
  const { design, state } = assertRoundTrip(graph, "provide vs agent");

  assert.equal(design.instances.p1.output[1].value, "用户填的", "provide 的输出值是用户填的，必须留在设计里");
  assert.equal(design.instances.a1.output[1].value, undefined, "agent 的输出值应被外移");
  assert.equal(state.outputs.a1.result.value, "跑出来的");
  assert.equal(state.outputs.p1, undefined);
});

test("展示节点：有内容入边的 body 外移，没有的留在设计里", () => {
  const graph = {
    version: 1,
    instances: {
      src: { definitionId: "agent_subAgent", output: [{ type: "node", name: "next" }, { type: "text", name: "result" }] },
      wired: {
        definitionId: "display_markdown",
        body: "上次运行的产出",
        input: [{ type: "node", name: "prev" }, { type: "text", name: "content" }],
      },
      authored: {
        definitionId: "display_markdown",
        body: "作者手写的说明文档",
        input: [{ type: "node", name: "prev" }, { type: "text", name: "content" }],
      },
      ctrlOnly: {
        definitionId: "display_markdown",
        body: "只有控制入边，仍是作者手写",
        input: [{ type: "node", name: "prev" }, { type: "text", name: "content" }],
      },
    },
    edges: [
      { source: "src", target: "wired", sourceHandle: "output-1", targetHandle: "input-1" },
      { source: "src", target: "ctrlOnly", sourceHandle: "output-0", targetHandle: "input-0" },
    ],
    ui: { nodePositions: {} },
  };
  const { design, state } = assertRoundTrip(graph, "display body");

  assert.equal(design.instances.wired.body, undefined);
  assert.equal(state.displayBodies.wired, "上次运行的产出");
  assert.equal(design.instances.authored.body, "作者手写的说明文档", "无入边的展示节点内容不可外移");
  assert.equal(design.instances.ctrlOnly.body, "只有控制入边，仍是作者手写", "prev 是语义槽，不算内容入边");
  assert.equal(state.displayBodies.authored, undefined);
  assert.equal(state.displayBodies.ctrlOnly, undefined);
});

test("槽位顺序不规范时仍按槽名判断语义槽，而不是按 input-0", () => {
  // content 在 index 0、prev 在 index 1 —— 简单按 targetHandle !== "input-0" 会判反
  const graph = {
    version: 1,
    instances: {
      src: { definitionId: "agent_subAgent", output: [{ type: "node", name: "next" }] },
      d: {
        definitionId: "display_markdown",
        body: "运行产出",
        input: [{ type: "text", name: "content" }, { type: "node", name: "prev" }],
      },
      d2: {
        definitionId: "display_markdown",
        body: "作者手写",
        input: [{ type: "text", name: "content" }, { type: "node", name: "prev" }],
      },
    },
    edges: [
      { source: "src", target: "d", sourceHandle: "output-0", targetHandle: "input-0" },
      { source: "src", target: "d2", sourceHandle: "output-0", targetHandle: "input-1" },
    ],
    ui: { nodePositions: {} },
  };
  const { design, state } = assertRoundTrip(graph, "非规范槽序");
  assert.equal(state.displayBodies.d, "运行产出", "input-0 指向 content，是内容入边");
  assert.equal(design.instances.d2.body, "作者手写", "input-1 指向 prev，是语义槽");
});

test("输出槽重名时整个实例放弃外移，不丢值", () => {
  const graph = {
    version: 1,
    instances: {
      weird: {
        definitionId: "tool_nodejs",
        output: [
          { type: "text", name: "out", value: "第一个" },
          { type: "text", name: "out", value: "第二个" },
        ],
      },
    },
    edges: [],
    ui: { nodePositions: {} },
  };
  const { design, state } = assertRoundTrip(graph, "重名输出槽");
  assert.equal(design.instances.weird.output[0].value, "第一个");
  assert.equal(design.instances.weird.output[1].value, "第二个");
  assert.equal(state.outputs, undefined);
});

test("displayReloadKey 与 ui.viewport 外移，nodePositions 留下", () => {
  const graph = {
    version: 1,
    instances: { d: { definitionId: "display_markdown", displayReloadKey: 7 } },
    edges: [],
    ui: { nodePositions: { d: { x: 1, y: 2 } }, viewport: { x: 10, y: 20, zoom: 1.5 } },
  };
  const { design, state } = assertRoundTrip(graph, "reloadKey/viewport");
  assert.equal(design.instances.d.displayReloadKey, undefined);
  assert.equal(design.ui.viewport, undefined);
  assert.deepEqual(design.ui.nodePositions, { d: { x: 1, y: 2 } });
  assert.equal(state.displayReloadKeys.d, 7);
  assert.deepEqual(state.viewport, { x: 10, y: 20, zoom: 1.5 });
});

test("纯设计图拆出来的运行态是空的", () => {
  const graph = {
    version: 1,
    instances: { a: { definitionId: "agent_subAgent", body: "干活", output: [{ type: "node", name: "next" }] } },
    edges: [],
    ui: { nodePositions: { a: { x: 0, y: 0 } } },
  };
  const { state } = assertRoundTrip(graph, "纯设计");
  assert.equal(isEmptyWorkspaceState(state), true);
});

test("没有 state 文件时合并是恒等操作（旧图直接可读）", () => {
  const legacy = {
    version: 1,
    instances: { a: { definitionId: "agent_subAgent", output: [{ type: "text", name: "result", value: "内联的老产出" }] } },
    edges: [],
    ui: { nodePositions: {}, viewport: { x: 1, y: 1, zoom: 1 } },
  };
  assert.deepEqual(mergeWorkspaceState(legacy, null), legacy);
  assert.deepEqual(mergeWorkspaceState(legacy, undefined), legacy);
});

/** 确定性伪随机——固定种子，失败可复现（真实语料含内网业务内容，不入库）。 */
function makeRng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function randomGraph(seed) {
  const rnd = makeRng(seed);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const defIds = [
    "agent_subAgent", "tool_nodejs", "control_if", "provide_str", "provide_bool",
    "display_markdown", "display_table", "display_chart", "control_load_skills", "workspace_run",
  ];
  const slotNames = ["result", "content", "next", "value", "total", "url", "shareId"];
  const nodeCount = 2 + Math.floor(rnd() * 8);
  const instances = {};
  const ids = [];
  for (let i = 0; i < nodeCount; i++) {
    const id = `n${i}`;
    ids.push(id);
    const definitionId = pick(defIds);
    const outCount = 1 + Math.floor(rnd() * 3);
    const used = new Set();
    const output = [];
    for (let k = 0; k < outCount; k++) {
      const name = k === 0 ? "next" : pick(slotNames);
      if (used.has(name)) continue;
      used.add(name);
      const slot = { type: k === 0 ? "node" : "text", name };
      if (rnd() < 0.7) slot.value = `产出-${seed}-${i}-${k}`;
      if (rnd() < 0.3) slot.default = "";
      if (rnd() < 0.4) slot.showOnNode = rnd() < 0.5;
      output.push(slot);
    }
    // 一半概率把槽位顺序打乱，覆盖非规范排列
    const input = rnd() < 0.5
      ? [{ type: "node", name: "prev" }, { type: "text", name: "content" }]
      : [{ type: "text", name: "content" }, { type: "node", name: "prev" }];
    instances[id] = { definitionId, label: `节点 ${i}`, input, output };
    if (rnd() < 0.5) instances[id].body = `正文-${seed}-${i}`;
    if (rnd() < 0.2) instances[id].displayReloadKey = Math.floor(rnd() * 100);
  }
  const edges = [];
  for (let i = 1; i < ids.length; i++) {
    if (rnd() < 0.7) {
      edges.push({
        source: ids[i - 1],
        target: ids[i],
        sourceHandle: "output-0",
        targetHandle: rnd() < 0.5 ? "input-0" : "input-1",
      });
    }
  }
  const ui = { nodePositions: Object.fromEntries(ids.map((id, i) => [id, { x: i * 280, y: 300 }])) };
  if (rnd() < 0.5) ui.viewport = { x: rnd() * 100, y: rnd() * 100, zoom: 1 };
  return { version: 1, instances, edges, ui };
}

test("随机图属性测试：拆分-合并恒等且幂等", () => {
  for (let seed = 1; seed <= 200; seed++) {
    assertRoundTrip(randomGraph(seed), `seed=${seed}`);
  }
});

test("随机图属性测试：设计态不含任何运行产出", () => {
  for (let seed = 1; seed <= 200; seed++) {
    const graph = randomGraph(seed);
    const { design, state } = splitWorkspaceGraph(graph);
    const driven = new Set(Object.keys(state.displayBodies || {}));
    for (const [id, inst] of Object.entries(design.instances)) {
      assert.equal(inst.displayReloadKey, undefined, `seed=${seed} ${id}: displayReloadKey 未外移`);
      if (driven.has(id)) assert.equal(inst.body, undefined, `seed=${seed} ${id}: 运行产出正文未外移`);
      if (String(inst.definitionId).startsWith("provide_")) continue;
      const names = inst.output.map((s) => s.name);
      if (new Set(names).size !== names.length) continue;   // 重名实例整体不外移
      for (const slot of inst.output) {
        assert.equal(slot.value, undefined, `seed=${seed} ${id}.${slot.name}: value 未外移`);
        assert.equal(slot.default, undefined, `seed=${seed} ${id}.${slot.name}: default 未外移`);
      }
    }
    assert.equal(design.ui.viewport, undefined, `seed=${seed}: viewport 未外移`);
  }
});

test("HTTP：存图后磁盘上两个文件分开，读回来与存入语义一致", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-state-split-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?state-split=${nonce}`),
      import(`../bin/lib/ui-server.mjs?state-split=${nonce}`),
    ]);
    const user = loginOrCreateUser("state-split-owner", "state-split-password");
    server = await startUiServer({
      workspaceRoot: path.join(tempRoot, "workspace"),
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const auth = { Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" };
    const flowId = "state-flow";

    const created = await fetch(`${baseUrl}/api/flows`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ flowId, targetSpace: "user" }),
    });
    assert.equal(created.status, 200, `建流程失败: ${await created.text()}`);

    const graph = {
      version: 1,
      instances: {
        agent_1: {
          definitionId: "agent_subAgent",
          label: "干活",
          body: "写一段东西",
          input: [{ type: "node", name: "prev", value: "" }],
          output: [
            { type: "node", name: "next", value: "" },
            { type: "text", name: "result", value: "上次跑出来的一大段产出" },
          ],
        },
        display_1: {
          definitionId: "display_markdown",
          label: "展示",
          body: "上次运行的产出正文",
          input: [
            { type: "node", name: "prev", value: "" },
            { type: "text", name: "content", value: "" },
          ],
          output: [{ type: "node", name: "next", value: "" }],
        },
        doc_1: {
          definitionId: "display_markdown",
          label: "说明",
          body: "作者手写的使用说明，不该被当成运行产出",
          input: [
            { type: "node", name: "prev", value: "" },
            { type: "text", name: "content", value: "" },
          ],
          output: [{ type: "node", name: "next", value: "" }],
        },
      },
      edges: [
        { source: "agent_1", target: "display_1", sourceHandle: "output-1", targetHandle: "input-1" },
      ],
      ui: { nodePositions: { agent_1: { x: 0, y: 0 }, display_1: { x: 300, y: 0 }, doc_1: { x: 600, y: 0 } } },
    };

    const saved = await fetch(`${baseUrl}/api/workspace/graph`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ flowId, flowSource: "user", graph }),
    });
    assert.equal(saved.status, 200, `存图失败: ${await saved.text()}`);

    const readBack = await fetch(
      `${baseUrl}/api/workspace/graph?flowId=${encodeURIComponent(flowId)}&flowSource=user`,
      { headers: auth },
    );
    assert.equal(readBack.status, 200);
    const payload = await readBack.json();
    const flowDir = payload.root;

    // 磁盘上：设计态是代码，且不含运行产出
    const sourcePath = path.join(flowDir, "workspace.flow.js");
    assert.ok(fs.existsSync(sourcePath), "没有生成 workspace.flow.js");
    assert.ok(!fs.existsSync(path.join(flowDir, "workspace.graph.json")), "迁移后不该再留着 graph.json");
    const source = fs.readFileSync(sourcePath, "utf-8");
    assert.ok(!source.includes("上次跑出来的一大段产出"), "运行产出不该出现在 flow.js 里");
    assert.ok(!source.includes("上次运行的产出正文"), "有内容入边的展示内容不该出现在 flow.js 里");
    assert.ok(
      source.includes("作者手写的使用说明，不该被当成运行产出"),
      "无内容入边的展示节点正文必须留在 flow.js 里",
    );
    assert.ok(source.includes("写一段东西"), "agent 的提示词是设计态");

    // 磁盘上：运行态在 state 文件里
    const statePath = path.join(flowDir, WORKSPACE_STATE_FILENAME);
    assert.ok(fs.existsSync(statePath), "没有生成 workspace.state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    assert.equal(state.outputs.agent_1.result.value, "上次跑出来的一大段产出");
    assert.equal(state.displayBodies.display_1, "上次运行的产出正文");
    assert.equal(state.displayBodies.doc_1, undefined);

    // 读回来是合并后的完整图
    const back = payload.graph;
    assert.equal(back.instances.agent_1.output[1].value, "上次跑出来的一大段产出");
    assert.equal(back.instances.display_1.body, "上次运行的产出正文");
    assert.equal(back.instances.doc_1.body, "作者手写的使用说明，不该被当成运行产出");

    // 旧图迁移：只留一个装着全部内容的 graph.json（拆分前、代码化前的形态），仍应完整读出
    for (const name of ["workspace.flow.js", "workspace.layout.json", "workspace.nodes.json"]) {
      fs.rmSync(path.join(flowDir, name), { force: true });
    }
    fs.writeFileSync(path.join(flowDir, "workspace.graph.json"), JSON.stringify(graph, null, 2), "utf-8");
    fs.rmSync(statePath);
    const legacyRead = await fetch(
      `${baseUrl}/api/workspace/graph?flowId=${encodeURIComponent(flowId)}&flowSource=user`,
      { headers: auth },
    );
    assert.equal(legacyRead.status, 200);
    const legacyGraph = (await legacyRead.json()).graph;
    assert.equal(legacyGraph.instances.agent_1.output[1].value, "上次跑出来的一大段产出");
    assert.equal(legacyGraph.instances.display_1.body, "上次运行的产出正文");

    // 损坏的 state 文件不能让整张图打不开
    fs.writeFileSync(statePath, "{ 这不是 JSON", "utf-8");
    const brokenRead = await fetch(
      `${baseUrl}/api/workspace/graph?flowId=${encodeURIComponent(flowId)}&flowSource=user`,
      { headers: auth },
    );
    assert.equal(brokenRead.status, 200, "state 文件损坏时应降级而不是 500");
    assert.ok((await brokenRead.json()).graph.instances.agent_1, "设计态仍应读得出来");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
