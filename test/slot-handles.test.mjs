import assert from "node:assert/strict";
import test from "node:test";

import {
  edgesWithCanvasHandles,
  edgesWithSlotNames,
  indexHandleFromSlotName,
  isIndexSlotHandle,
  slotNameFromHandle,
} from "../shared/slot-handles.js";

const markdown = {
  definitionId: "display_markdown",
  input: [{ name: "prev", type: "node" }, { name: "content", type: "text" }],
  output: [{ name: "content", type: "text" }, { name: "next", type: "node" }],
};

test("an index handle resolves against the slot table it was written for", () => {
  assert.equal(slotNameFromHandle("output-0", markdown.output), "content");
  assert.equal(slotNameFromHandle("output-1", markdown.output), "next");
  assert.equal(slotNameFromHandle("input-0", markdown.input), "prev");
});

test("a name handle passes straight through", () => {
  assert.equal(slotNameFromHandle("next", markdown.output), "next");
  assert.equal(slotNameFromHandle("content", markdown.input), "content");
});

test("an index past the end of the slot table resolves to nothing", () => {
  assert.equal(slotNameFromHandle("output-7", markdown.output), "");
});

// 历史图里句柄缺省就是"第一个槽"，不是"没有指向"——按没有指向处理会把边丢掉。
test("an absent handle keeps meaning the first slot", () => {
  assert.equal(slotNameFromHandle("", markdown.output), "content");
  assert.equal(slotNameFromHandle(undefined, markdown.input), "prev");
  assert.equal(slotNameFromHandle(null, []), "");
});

test("index handles are recognised, names are not", () => {
  assert.equal(isIndexSlotHandle("output-2"), true);
  assert.equal(isIndexSlotHandle("input-0"), true);
  assert.equal(isIndexSlotHandle("next"), false);
  assert.equal(isIndexSlotHandle("output-next"), false);
});

test("the canvas can go back to an index handle", () => {
  assert.equal(indexHandleFromSlotName("next", markdown.output, "output"), "output-1");
  assert.equal(indexHandleFromSlotName("prev", markdown.input, "input"), "input-0");
  assert.equal(indexHandleFromSlotName("missing", markdown.output, "output"), "");
});

// 用户需求点: display_markdown 的 0 号输出是 content 不是 next，照下标搬会把控制边接到内容槽上。
test("a whole graph normalises to names, keeping what each index meant at the time", () => {
  const graph = {
    instances: { a: markdown, b: markdown },
    edges: [
      { source: "a", target: "b", sourceHandle: "output-1", targetHandle: "input-0" },
      { source: "a", target: "b", sourceHandle: "output-0", targetHandle: "input-1" },
    ],
  };
  assert.deepEqual(edgesWithSlotNames(graph), [
    { source: "a", target: "b", sourceHandle: "next", targetHandle: "prev" },
    { source: "a", target: "b", sourceHandle: "content", targetHandle: "content" },
  ]);
});

test("edges to a node that no longer exists are dropped", () => {
  const graph = {
    instances: { a: markdown },
    edges: [{ source: "a", target: "gone", sourceHandle: "output-1", targetHandle: "input-0" }],
  };
  assert.deepEqual(edgesWithSlotNames(graph), []);
});

test("normalising twice is a no-op", () => {
  const graph = {
    instances: { a: markdown, b: markdown },
    edges: [{ source: "a", target: "b", sourceHandle: "output-1", targetHandle: "input-0" }],
  };
  const once = edgesWithSlotNames(graph);
  const twice = edgesWithSlotNames({ instances: graph.instances, edges: once });
  assert.deepEqual(twice, once);
});

// 画布有不止一个加载入口。磁盘上边的身份是槽位名，React Flow 的句柄是引脚下标；
// 漏掉任何一个入口的换算，那个入口下整张图的连线全不见——句柄名对不上任何一个渲染出来的
// handle，React Flow 留着边但一条都画不出来。线上就这么发生过。
test("边换算成画布句柄：名字进，下标出", () => {
  const slots = { a: markdown, b: markdown };
  const edges = [
    { source: "a", target: "b", sourceHandle: "next", targetHandle: "prev" },
    { source: "a", target: "b", sourceHandle: "content", targetHandle: "content" },
  ];
  assert.deepEqual(edgesWithCanvasHandles(edges, (id) => slots[id]), [
    { source: "a", target: "b", sourceHandle: "output-1", targetHandle: "input-0" },
    { source: "a", target: "b", sourceHandle: "output-0", targetHandle: "input-1" },
  ]);
});

test("历史下标形态进来也照样能换算", () => {
  const slots = { a: markdown, b: markdown };
  assert.deepEqual(
    edgesWithCanvasHandles([{ source: "a", target: "b", sourceHandle: "output-1", targetHandle: "input-0" }], (id) => slots[id]),
    [{ source: "a", target: "b", sourceHandle: "output-1", targetHandle: "input-0" }],
  );
});

// 渲染用的槽位表和边写下时那张不是一回事：合并定义表会补槽、会改顺序。
// 还原下标要用旧表，换算成下标要用新表——反过来每条边都可能指到别的引脚上。
test("还原用旧槽位表，换算用渲染那张", () => {
  const stored = { a: markdown, b: { input: [{ name: "content", type: "text" }], output: [] } };
  // 合并后 b 补回了 prev，排在 content 前面，下标整体后移一位
  const rendered = { a: markdown, b: markdown };
  assert.deepEqual(
    edgesWithCanvasHandles(
      [{ source: "a", target: "b", sourceHandle: "output-0", targetHandle: "input-0" }],
      (id) => stored[id],
      (id) => rendered[id],
    ),
    [{ source: "a", target: "b", sourceHandle: "output-0", targetHandle: "input-1" }],
    "旧表里 input-0 是 content，新表里 content 排在 1 号位",
  );
});

test("换算不出来的句柄留 undefined，不硬凑一个下标", () => {
  const slots = { a: markdown, b: markdown };
  assert.deepEqual(
    edgesWithCanvasHandles([{ source: "a", target: "b", sourceHandle: "没有这个槽", targetHandle: "prev" }], (id) => slots[id]),
    [{ source: "a", target: "b", sourceHandle: undefined, targetHandle: "input-0" }],
  );
});
