import assert from "node:assert/strict";
import test from "node:test";

import {
  edgeWipeWithoutNodeDeletion,
  introducedWorkspaceGraphEdgeViolations,
  workspaceGraphEdgeViolations,
} from "../bin/lib/workspace-graph-edge-rules.mjs";

const md = () => ({
  definitionId: "display_markdown",
  input: [{ type: "node", name: "prev" }, { type: "text", name: "content" }],
  output: [{ type: "text", name: "content" }, { type: "node", name: "next" }],
});
const graph = (edges, extra = {}) => ({ instances: { a: md(), b: md(), ...extra }, edges });

test("合法的图没有违规", () => {
  assert.deepEqual(workspaceGraphEdgeViolations(graph([
    { source: "a", target: "b", sourceHandle: "next", targetHandle: "prev" },
    { source: "a", target: "b", sourceHandle: "content", targetHandle: "content" },
  ])), []);
});

// 线上真实形态：provide_str.value 落到了某个节点的 prev 上，图看着是连的，值从来没到过。
test("数据输出接进控制槽算类型不兼容", () => {
  const found = workspaceGraphEdgeViolations(graph([
    { source: "a", target: "b", sourceHandle: "content", targetHandle: "prev" },
  ]));
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "type_mismatch");
  assert.match(found[0].message, /a\.content\(text\) -> b\.prev\(node\)/);
});

test("一个输入槽两条入边算 fan-in 违规", () => {
  const found = workspaceGraphEdgeViolations({
    instances: { a: md(), b: md(), c: md() },
    edges: [
      { source: "a", target: "c", sourceHandle: "next", targetHandle: "prev" },
      { source: "b", target: "c", sourceHandle: "next", targetHandle: "prev" },
    ],
  });
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "fan_in");
  assert.match(found[0].message, /c\.prev/);
});

test("句柄指向不存在的槽算违规", () => {
  const found = workspaceGraphEdgeViolations(graph([
    { source: "a", target: "b", sourceHandle: "output-9", targetHandle: "prev" },
  ]));
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "slot_missing");
});

test("下标句柄按当时的槽位表解析，和名字形态判一样的结果", () => {
  // display_markdown 的 0 号输出是 content 不是 next——照下标搬会把控制边判成合法
  const byIndex = workspaceGraphEdgeViolations(graph([
    { source: "a", target: "b", sourceHandle: "output-0", targetHandle: "input-0" },
  ]));
  const byName = workspaceGraphEdgeViolations(graph([
    { source: "a", target: "b", sourceHandle: "content", targetHandle: "prev" },
  ]));
  assert.deepEqual(byIndex.map((v) => v.kind), byName.map((v) => v.kind));
  assert.equal(byIndex[0].kind, "type_mismatch");
});

test("两端节点已经不存在的边不算违规，落盘时自会丢掉", () => {
  assert.deepEqual(workspaceGraphEdgeViolations({
    instances: { a: md() },
    edges: [{ source: "a", target: "没了", sourceHandle: "next", targetHandle: "prev" }],
  }), []);
});

// 一刀切会让作者连改都改不动：图里已经有一条坏边，存不进去就没法修。
test("存量违规不拦，只拦这次新引入的", () => {
  const bad = { source: "a", target: "b", sourceHandle: "content", targetHandle: "prev" };
  const stored = graph([bad]);
  assert.deepEqual(introducedWorkspaceGraphEdgeViolations(stored, graph([bad])), [],
    "原样存回去必须放行");

  const alsoMoved = graph([bad, { source: "b", target: "a", sourceHandle: "content", targetHandle: "prev" }]);
  const introduced = introducedWorkspaceGraphEdgeViolations(stored, alsoMoved);
  assert.equal(introduced.length, 1);
  assert.match(introduced[0].message, /b\.content\(text\) -> a\.prev\(node\)/);
});

test("把坏边改对之后保存，放行", () => {
  const stored = graph([{ source: "a", target: "b", sourceHandle: "content", targetHandle: "prev" }]);
  const fixed = graph([{ source: "a", target: "b", sourceHandle: "next", targetHandle: "prev" }]);
  assert.deepEqual(introducedWorkspaceGraphEdgeViolations(stored, fixed), []);
});

// 0.1.190 的教训：画布加载时漏了一处句柄换算，React Flow 匹配不到 handle 丢掉全部边，
// 用户随后任何一次保存都把这个状态写回磁盘。3 个线上流程的连线因此永久没了，
// 服务端没有任何快照能恢复。渲染 bug 不该有删数据的能力。
test("节点全在、连线全没 —— 拦下来", () => {
  const stored = graph([
    { source: "a", target: "b", sourceHandle: "next", targetHandle: "prev" },
    { source: "a", target: "b", sourceHandle: "content", targetHandle: "content" },
  ]);
  const wiped = { instances: stored.instances, edges: [] };
  assert.deepEqual(edgeWipeWithoutNodeDeletion(stored, wiped), { removedEdges: 2, keptNodes: 2 });
});

test("删了节点连带没线，是正常编辑，放行", () => {
  const stored = graph([
    { source: "a", target: "b", sourceHandle: "next", targetHandle: "prev" },
    { source: "a", target: "b", sourceHandle: "content", targetHandle: "content" },
  ]);
  assert.equal(edgeWipeWithoutNodeDeletion(stored, { instances: { a: md() }, edges: [] }), null);
});

test("还剩线就不是这个形态，放行", () => {
  const stored = graph([
    { source: "a", target: "b", sourceHandle: "next", targetHandle: "prev" },
    { source: "a", target: "b", sourceHandle: "content", targetHandle: "content" },
  ]);
  const one = { instances: stored.instances, edges: [{ source: "a", target: "b", sourceHandle: "next", targetHandle: "prev" }] };
  assert.equal(edgeWipeWithoutNodeDeletion(stored, one), null);
});

// 只有一条线时，删掉它和「线丢了」分不开——那也只损失一条，人自己看得见。
test("原本只有一条线，不拦", () => {
  const stored = graph([{ source: "a", target: "b", sourceHandle: "next", targetHandle: "prev" }]);
  assert.equal(edgeWipeWithoutNodeDeletion(stored, { instances: stored.instances, edges: [] }), null);
});

test("本来就没有线的图，不拦", () => {
  const stored = graph([]);
  assert.equal(edgeWipeWithoutNodeDeletion(stored, { instances: stored.instances, edges: [] }), null);
});
