/**
 * 运行缓存的失效判据。
 *
 * 「槽里有值」曾经就等于「不用重跑」。于是改了上游节点的脚本再点运行，上游根本不进
 * 执行计划，下游拿到的还是上一版的产出——只有删掉 `outputs/` 下的文件才能挣脱。
 *
 * 现在多一道指纹：命中要求「有值」**且**「这套输入的指纹和上次成功执行时记录的一致」。
 * 指纹是 Merkle 式的（上游用指纹而不是值参与哈希），所以脏传播是算出来的，不是另写一遍。
 */
import assert from "node:assert/strict";
import test from "node:test";

import { workspaceDesignRevision } from "../bin/lib/workspace-graph-merge.mjs";
import { workspaceNodeInputFingerprint, workspaceRunPlan } from "../bin/lib/workspace-server.mjs";
import { mergeWorkspaceState, splitWorkspaceGraph } from "../bin/lib/workspace-state.mjs";

/** run → b，且 a.result → b.got。a 只靠数据边被拉进来，是缓存唯一起作用的位置。 */
function chainGraph({ scriptA = "echo one", valueA = "one", fingerprintA = undefined } = {}) {
  const a = {
    definitionId: "tool_nodejs",
    label: "A",
    script: scriptA,
    input: [{ type: "node", name: "prev" }],
    output: [{ type: "node", name: "next" }, { type: "text", name: "result", value: valueA }],
  };
  if (fingerprintA !== undefined) a.runFingerprint = fingerprintA;
  return {
    version: 1,
    instances: {
      run: { definitionId: "workspace_run", label: "Run", output: [{ type: "node", name: "next" }] },
      a,
      b: {
        definitionId: "tool_nodejs",
        label: "B",
        script: "echo ${got}",
        input: [{ type: "node", name: "prev" }, { type: "text", name: "got", value: "" }],
        output: [{ type: "node", name: "next" }, { type: "text", name: "result", value: "" }],
      },
    },
    edges: [
      { source: "run", target: "b", sourceHandle: "output-0", targetHandle: "input-0" },
      { source: "a", target: "b", sourceHandle: "output-1", targetHandle: "input-1" },
    ],
  };
}

/** 图跑过一轮之后的样子：a 的指纹已经落盘。 */
function ranOnce(overrides = {}) {
  const fresh = chainGraph(overrides);
  return chainGraph({ ...overrides, fingerprintA: workspaceNodeInputFingerprint(fresh, "a") });
}

const orderOf = (graph, opts) => workspaceRunPlan(graph, "run", "", opts).order;

test("指纹跟着节点自己的脚本走", () => {
  const one = workspaceNodeInputFingerprint(chainGraph({ scriptA: "echo one" }), "a");
  const two = workspaceNodeInputFingerprint(chainGraph({ scriptA: "echo two" }), "a");
  assert.notEqual(one, two, "改了脚本指纹还一样，缓存就永远不会失效");
});

test("上游一变，下游指纹跟着变——脏传播是算出来的", () => {
  // b 自己一个字没改，但它的输入来自 a
  const before = workspaceNodeInputFingerprint(chainGraph({ scriptA: "echo one" }), "b");
  const after = workspaceNodeInputFingerprint(chainGraph({ scriptA: "echo two" }), "b");
  assert.notEqual(before, after, "上游改了下游指纹不变，等于要再手写一遍脏传播");
});

test("产出不进指纹——不然 agent 节点永远不命中", () => {
  // agent 同样输入重跑本来就给不同结果；把结果算进输入指纹，缓存直接失去意义
  const one = workspaceNodeInputFingerprint(chainGraph({ valueA: "one" }), "a");
  const two = workspaceNodeInputFingerprint(chainGraph({ valueA: "完全不同的产出" }), "a");
  assert.equal(one, two);
});

test("包节点推导出来的 script 不进指纹——换台机器不该全部失效", () => {
  const withRef = (script) => ({
    version: 1,
    instances: {
      run: { definitionId: "workspace_run", output: [{ type: "node", name: "next" }] },
      pkg: {
        definitionId: "tool_nodejs",
        marketplaceRef: "marketplace:row_count@1.0.0",
        script,
        input: [{ type: "node", name: "prev" }],
        output: [{ type: "node", name: "next" }, { type: "text", name: "total", value: "3" }],
      },
    },
    edges: [],
  });
  assert.equal(
    workspaceNodeInputFingerprint(withRef("node '/Users/a/pkg/index.mjs'"), "pkg"),
    workspaceNodeInputFingerprint(withRef("node '/home/b/pkg/index.mjs'"), "pkg"),
    "推导脚本里带着本机绝对路径，算进指纹等于换台机器缓存全废",
  );
  assert.notEqual(
    workspaceNodeInputFingerprint(withRef("x"), "pkg"),
    workspaceNodeInputFingerprint({
      ...withRef("x"),
      instances: {
        ...withRef("x").instances,
        pkg: { ...withRef("x").instances.pkg, marketplaceRef: "marketplace:row_count@2.0.0" },
      },
    }, "pkg"),
    "包版本升了必须失效",
  );
});

test("有值 + 指纹对得上 → 上游不重跑", () => {
  assert.deepEqual(orderOf(ranOnce()), ["b"]);
});

test("改了上游的脚本 → 上游重跑", () => {
  // 跑完之后把 a 的脚本改掉，值和指纹都还是上一版的
  const ran = ranOnce();
  ran.instances.a.script = "echo two";
  assert.deepEqual(orderOf(ran), ["a", "b"], "这正是修之前的 bug：a 不跑，b 拿到上一版的值");
});

test("没有指纹记录（老流程升级上来）→ 重跑", () => {
  // 安全方向：宁可多跑一次，也不拿一个来路不明的值往下传
  assert.deepEqual(orderOf(chainGraph()), ["a", "b"]);
});

test("指纹对得上但产出文件没了 → 重跑", () => {
  const ran = ranOnce({ valueA: "outputs/a/result.txt" });
  assert.deepEqual(orderOf(ran), ["a", "b"], "槽里记着一个不存在的文件路径，不能当命中");
});

test("forceNodeIds 无视缓存", () => {
  const ran = ranOnce();
  assert.deepEqual(orderOf(ran), ["b"], "前提：不加 force 时是命中的");
  assert.deepEqual(orderOf(ran, { forceNodeIds: ["a"] }), ["a", "b"]);
});

test("ignoreCache 整张图重跑", () => {
  // 不能用「forceNodeIds 填上所有节点」代替：能填进去的只有计划里已有的节点，
  // 而被缓存挡掉的那些恰恰不在计划里——a 就是这种
  const ran = ranOnce();
  assert.deepEqual(orderOf(ran, { forceNodeIds: orderOf(ran) }), ["b"], "枚举计划里的节点挡不住 a 被缓存");
  assert.deepEqual(orderOf(ran, { ignoreCache: true }), ["a", "b"]);
});

test("provide.* 不需要指纹——它不执行，没有「上次跑出来的」这回事", () => {
  const graph = chainGraph();
  graph.instances.a = {
    definitionId: "provide_str",
    output: [{ type: "node", name: "next" }, { type: "text", name: "value", value: "用户填的" }],
  };
  assert.deepEqual(orderOf(graph), ["b"]);
});

test("指纹存进 state，不进设计态", () => {
  const graph = ranOnce();
  const { design, state } = splitWorkspaceGraph(graph);
  assert.equal(typeof state.fingerprints.a, "string");
  assert.equal(design.instances.a.runFingerprint, undefined, "指纹是运行态，写进代码文件就会污染 diff");
  assert.deepEqual(
    mergeWorkspaceState(design, state).instances.a.runFingerprint,
    graph.instances.a.runFingerprint,
    "合回来要一字不差，否则下一次判定必然落空",
  );
});

test("designRevision 不因指纹变化", () => {
  // 跑一次就让协作者手里的基线作废，是这套设计最容易犯的错
  const before = workspaceDesignRevision(chainGraph());
  const after = workspaceDesignRevision(ranOnce());
  assert.equal(before, after);
});
