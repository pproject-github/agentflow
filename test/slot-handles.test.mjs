import assert from "node:assert/strict";
import test from "node:test";

import {
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
