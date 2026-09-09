import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  runWorkspaceGraph,
  workspaceNodeExecutionLane,
  workspaceRunConcurrency,
  workspaceRunDependencyGraph,
} from "../bin/lib/workspace-server.mjs";

function tmpRoot(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `agentflow-${name}-`));
}

// 一个睡指定毫秒再退出的 tool_nodejs 节点。用它把执行窗口拉开，好观察是否重叠。
function sleepNode(ms) {
  return {
    definitionId: "tool_nodejs",
    label: `sleep ${ms}ms`,
    script: `node -e "setTimeout(() => process.exit(0), ${ms})"`,
    input: [{ type: "node", name: "prev" }],
    output: [{ type: "node", name: "next" }, { type: "text", name: "result", value: "" }],
  };
}

function runNode() {
  return {
    definitionId: "workspace_run",
    label: "Run",
    input: [{ type: "node", name: "prev" }],
    output: [{ type: "node", name: "next" }],
  };
}

function controlEdge(source, target) {
  return { source, target, sourceHandle: "next", targetHandle: "prev" };
}

// 从事件流里还原每个节点的执行窗口。
function windowsFrom(events) {
  const windows = new Map();
  for (const event of events) {
    const nodeId = String(event?.nodeId || "");
    if (!nodeId) continue;
    if (event.type === "node-start") windows.set(nodeId, { start: event.ts, end: null });
    if (event.type === "node-done" && windows.has(nodeId)) windows.get(nodeId).end = event.ts;
  }
  return windows;
}

function maxOverlap(windows, nodeIds) {
  const points = [];
  for (const id of nodeIds) {
    const w = windows.get(id);
    if (!w || w.end === null) continue;
    points.push({ t: w.start, delta: 1 });
    points.push({ t: w.end, delta: -1 });
  }
  // 同一时刻先减后加：相邻但不重叠的两个窗口不算并发。
  points.sort((a, b) => (a.t - b.t) || (a.delta - b.delta));
  let active = 0;
  let peak = 0;
  for (const point of points) {
    active += point.delta;
    peak = Math.max(peak, active);
  }
  return peak;
}

function fanOutGraph(count, ms) {
  const instances = { run: runNode() };
  const edges = [];
  for (let i = 0; i < count; i += 1) {
    instances[`n${i}`] = sleepNode(ms);
    edges.push(controlEdge("run", `n${i}`));
  }
  return { version: 1, instances, edges, ui: { nodePositions: {} } };
}

test("车道划分按资源代价而不是节点名", () => {
  assert.equal(workspaceNodeExecutionLane({ definitionId: "agent_subAgent" }), "agent");
  assert.equal(workspaceNodeExecutionLane({ definitionId: "control_while" }), "agent");
  assert.equal(workspaceNodeExecutionLane({ definitionId: "control_subflow_call" }), "agent");
  // 未收录的节点落最保守的一档。
  assert.equal(workspaceNodeExecutionLane({ definitionId: "some_future_node" }), "agent");

  assert.equal(workspaceNodeExecutionLane({ definitionId: "control_if" }), "tool");
  assert.equal(workspaceNodeExecutionLane({ definitionId: "display_markdown" }), "tool");
  assert.equal(workspaceNodeExecutionLane({ definitionId: "provide_str" }), "tool");

  // tool_nodejs 有 script 才是确定性子进程，没有就走通用 agent 路径。
  assert.equal(workspaceNodeExecutionLane({ definitionId: "tool_nodejs", script: "echo hi" }), "tool");
  assert.equal(workspaceNodeExecutionLane({ definitionId: "tool_nodejs", scriptRef: "scripts/x.mjs" }), "tool");
  assert.equal(workspaceNodeExecutionLane({ definitionId: "tool_nodejs" }), "agent");

  // 改运行级共享状态（cwd / runEnv / 工作树）的一律独占。
  for (const defId of [
    "tool_set_run_env",
    "control_cd_workspace",
    "control_user_workspace",
    "tool_git_checkout",
    "tool_git_worktree_load",
    "tool_git_worktree_unload",
  ]) {
    assert.equal(workspaceNodeExecutionLane({ definitionId: defId }), "exclusive", defId);
  }
});

test("并发上限默认 1，非法值回落默认，payload 压过 opts", () => {
  assert.deepEqual(workspaceRunConcurrency({}, {}), { agent: 1, tool: 1 });
  assert.deepEqual(workspaceRunConcurrency({ concurrency: { agent: 3, tool: 8 } }, {}), { agent: 3, tool: 8 });
  assert.deepEqual(
    workspaceRunConcurrency({ concurrency: { agent: 2 } }, { concurrency: { agent: 9, tool: 9 } }),
    { agent: 2, tool: 1 },
  );
  for (const bad of [0, -1, 1.5, "abc", null]) {
    assert.equal(workspaceRunConcurrency({ concurrency: { agent: bad } }, {}).agent, 1, String(bad));
  }
  assert.equal(workspaceRunConcurrency({ concurrency: { tool: 999 } }, {}).tool, 64);
});

test("依赖表去重重复边、忽略计划外的边和自环", () => {
  const graph = {
    edges: [
      { source: "a", target: "b", sourceHandle: "next", targetHandle: "prev" },
      { source: "a", target: "b", sourceHandle: "result", targetHandle: "value" },
      { source: "a", target: "a" },
      { source: "a", target: "outside" },
      { source: "b", target: "c" },
    ],
  };
  const { pending, dependents } = workspaceRunDependencyGraph(graph, ["a", "b", "c"]);
  assert.equal(pending.get("a"), 0);
  assert.equal(pending.get("b"), 1, "a→b 的两条边只算一次");
  assert.equal(pending.get("c"), 1);
  assert.deepEqual(dependents.get("a"), ["b"]);
});

test("默认档位下执行顺序恒等于 order", async () => {
  const root = tmpRoot("parallel-serial");
  const events = [];
  const result = await runWorkspaceGraph(root, root, {
    graph: fanOutGraph(3, 30),
    runNodeId: "run",
    runId: "parallel-serial",
    ignoreCache: true,
  }, { userId: "parallel-test" }, { runId: "parallel-serial", onEvent: (event) => events.push(event) });

  const started = events.filter((e) => e.type === "node-start").map((e) => e.nodeId);
  assert.deepEqual(started, result.order.filter((id) => id !== "run"));
  assert.equal(maxOverlap(windowsFrom(events), started), 1, "默认档位不得有任何重叠");
  assert.ok(!events.some((e) => String(e.line || "").startsWith("Parallel execution")));
});

test("tool 档放开后同层节点真的重叠，且不超过上限", async () => {
  const root = tmpRoot("parallel-tool");
  const events = [];
  await runWorkspaceGraph(root, root, {
    graph: fanOutGraph(3, 400),
    runNodeId: "run",
    runId: "parallel-tool",
    ignoreCache: true,
    concurrency: { agent: 1, tool: 2 },
  }, { userId: "parallel-test" }, { runId: "parallel-tool", onEvent: (event) => events.push(event) });

  const nodeIds = ["n0", "n1", "n2"];
  const peak = maxOverlap(windowsFrom(events), nodeIds);
  assert.equal(peak, 2, `tool 档为 2，实测峰值并发 ${peak}`);
  assert.ok(events.some((e) => String(e.line || "").startsWith("Parallel execution")));
});

test("exclusive 节点与同层兄弟不重叠", async () => {
  const root = tmpRoot("parallel-exclusive");
  const graph = {
    version: 1,
    instances: {
      run: runNode(),
      n0: sleepNode(300),
      n1: sleepNode(300),
      // order 里排在两个兄弟之后，因此它必须等它们排空才能起跑。
      env: {
        definitionId: "tool_set_run_env",
        label: "设置运行环境变量",
        input: [
          { type: "node", name: "prev" },
          { type: "text", name: "key", value: "AGENTFLOW_PARALLEL_TEST" },
          { type: "text", name: "value", value: "1" },
        ],
        output: [
          { type: "node", name: "next" },
          { type: "text", name: "keys", value: "" },
          { type: "text", name: "count", value: "" },
        ],
      },
    },
    edges: [controlEdge("run", "n0"), controlEdge("run", "n1"), controlEdge("run", "env")],
    ui: { nodePositions: {} },
  };
  const events = [];
  await runWorkspaceGraph(root, root, {
    graph,
    runNodeId: "run",
    runId: "parallel-exclusive",
    ignoreCache: true,
    concurrency: { agent: 1, tool: 4 },
  }, { userId: "parallel-test" }, { runId: "parallel-exclusive", onEvent: (event) => events.push(event) });

  const windows = windowsFrom(events);
  assert.equal(maxOverlap(windows, ["n0", "n1"]), 2, "两个 tool 兄弟应当重叠");
  const env = windows.get("env");
  for (const sibling of ["n0", "n1"]) {
    const other = windows.get(sibling);
    const overlaps = env.start < other.end && other.start < env.end;
    assert.ok(!overlaps, `exclusive 节点不得与 ${sibling} 重叠`);
  }
});

test("并行下 control_if 的未走分支仍被正确跳过", async () => {
  const root = tmpRoot("parallel-branch");
  const graph = {
    version: 1,
    instances: {
      run: runNode(),
      // provide_bool 是纯数据源：没有控制槽，靠数据边被拉进计划。
      flag: {
        definitionId: "provide_bool",
        input: [],
        output: [{ type: "bool", name: "value", value: "true" }],
      },
      gate: {
        definitionId: "control_if",
        input: [{ type: "node", name: "prev" }, { type: "bool", name: "prediction" }],
        output: [{ type: "node", name: "next1" }, { type: "node", name: "next2" }],
      },
      taken: sleepNode(50),
      skipped: sleepNode(50),
      sibling: sleepNode(200),
    },
    edges: [
      controlEdge("run", "gate"),
      { source: "flag", target: "gate", sourceHandle: "value", targetHandle: "prediction" },
      { source: "gate", target: "taken", sourceHandle: "next1", targetHandle: "prev" },
      { source: "gate", target: "skipped", sourceHandle: "next2", targetHandle: "prev" },
      controlEdge("run", "sibling"),
    ],
    ui: { nodePositions: {} },
  };
  const events = [];
  await runWorkspaceGraph(root, root, {
    graph,
    runNodeId: "run",
    runId: "parallel-branch",
    ignoreCache: true,
    concurrency: { agent: 1, tool: 4 },
  }, { userId: "parallel-test" }, { runId: "parallel-branch", onEvent: (event) => events.push(event) });

  const done = new Map(events.filter((e) => e.type === "node-done").map((e) => [e.nodeId, e]));
  assert.equal(done.get("taken")?.skipped, undefined, "true 分支应当真的跑过");
  assert.equal(done.get("skipped")?.skipped, true, "false 分支应当被跳过");
  assert.ok(done.has("sibling"), "并行的兄弟节点不受分支影响");
});

test("并行下首个失败冒泡，同批在跑的节点仍收尾", async () => {
  const root = tmpRoot("parallel-failure");
  const graph = fanOutGraph(2, 300);
  graph.instances.boom = {
    definitionId: "tool_nodejs",
    label: "失败",
    script: 'node -e "process.exit(3)"',
    input: [{ type: "node", name: "prev" }],
    output: [{ type: "node", name: "next" }, { type: "text", name: "result", value: "" }],
  };
  graph.instances.downstream = sleepNode(20);
  graph.edges.push(controlEdge("run", "boom"), controlEdge("boom", "downstream"));

  const events = [];
  await assert.rejects(runWorkspaceGraph(root, root, {
    graph,
    runNodeId: "run",
    runId: "parallel-failure",
    ignoreCache: true,
    concurrency: { agent: 1, tool: 4 },
  }, { userId: "parallel-test" }, { runId: "parallel-failure", onEvent: (event) => events.push(event) }));

  const done = new Set(events.filter((e) => e.type === "node-done").map((e) => e.nodeId));
  assert.ok(done.has("n0") && done.has("n1"), "已经在跑的兄弟节点应当自然收尾");
  assert.ok(!done.has("downstream"), "失败节点的下游不得被投放");
});
