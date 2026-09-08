import assert from "node:assert/strict";
import test from "node:test";

import { reconcileGraphSlots, reconcileInstanceSlots } from "../bin/lib/workspace-slot-reconcile.mjs";
import { edgesWithSlotNames } from "../shared/slot-handles.js";
import { withControlSlot } from "../bin/lib/node-package-manifest.mjs";

const names = (slots) => slots.map((s) => s.name);

test("定义里有、图里没有的槽会补回来", () => {
  // 线上真实形态：这个 agent 节点存图时定义还没有 context 一族，之后定义加了槽，
  // 图里的快照不会跟着变——连 prev 都没有的节点就是这么来的。
  const inst = reconcileInstanceSlots({
    definitionId: "agent_subAgent",
    input: [{ type: "text", name: "prompt", value: "写点什么" }],
    output: [],
  });
  assert.ok(names(inst.input).includes("prev"), "控制槽必须回来，否则控制边无处可接");
  assert.ok(names(inst.input).includes("knowledgeContext"));
  assert.ok(names(inst.output).includes("next"));
  assert.equal(inst.input.find((s) => s.name === "prompt").value, "写点什么", "作者填的值不能丢");
});

test("槽的类型、说明、必填以定义为准，图里的旧快照被刷新", () => {
  const inst = reconcileInstanceSlots({
    definitionId: "display_markdown",
    input: [{ type: "file", name: "content", value: "正文", description: "早就改过的旧说明" }],
    output: [],
  });
  const content = inst.input.find((s) => s.name === "content");
  assert.equal(content.type, "text", "类型归定义");
  assert.notEqual(content.description, "早就改过的旧说明");
  assert.equal(content.value, "正文");
});

test("槽序归定义序，自定义槽排在后面并保持图里的先后", () => {
  const inst = reconcileInstanceSlots({
    definitionId: "display_markdown",
    input: [
      { type: "text", name: "myB", value: "b" },
      { type: "text", name: "content", value: "正文" },
      { type: "text", name: "myA", value: "a" },
      { type: "node", name: "prev", value: "" },
    ],
    output: [],
  });
  assert.deepEqual(names(inst.input), ["prev", "content", "myB", "myA"]);
});

test("定义里没有的槽原样保留，一个字段都不动", () => {
  const custom = { type: "json", name: "payload", value: "{}", description: "作者自己写的", required: true };
  const inst = reconcileInstanceSlots({ definitionId: "display_markdown", input: [custom], output: [] });
  assert.deepEqual(inst.input.find((s) => s.name === "payload"), custom);
});

test("显不显示在卡片上是实例自己的选择，定义的其他元数据照抄", () => {
  const inst = reconcileInstanceSlots({
    definitionId: "agent_subAgent",
    input: [{ type: "text", name: "mcpContext", value: "", showOnNode: true }],
    output: [],
  });
  assert.equal(inst.input.find((s) => s.name === "mcpContext").showOnNode, true, "实例显式写过就照写");
  // 没写过的随定义——包括定义里明写的 false。少这个键会让这张表和运行时注水补出来的
  // 那张差一个字段，revision 跟着对不上。
  assert.equal(inst.input.find((s) => s.name === "workspaceContext").showOnNode, false);
});

test("定义表读不到时一个字都不改，绝不按空表把引脚删光", () => {
  const instance = {
    definitionId: "totally_unknown_kind",
    input: [{ type: "text", name: "whatever", value: "x" }],
    output: [{ type: "text", name: "out", value: "" }],
  };
  assert.equal(reconcileInstanceSlots(instance), instance);

  // 包还没装上的时刻是真实存在的：resolvePackage 给不出槽位表就当作读不到
  const packaged = {
    definitionId: "tool_nodejs",
    marketplaceRef: "marketplace:not_installed@1.0.0",
    input: [{ type: "text", name: "onlyMine", value: "" }],
    output: [],
  };
  assert.equal(reconcileInstanceSlots(packaged, () => null), packaged);
});

test("代码节点包的槽位表归包所有", () => {
  const resolvePackage = (ref) => (ref === "marketplace:demo@1.0.0"
    ? { input: [{ type: "node", name: "prev" }, { type: "text", name: "src" }], output: [{ type: "node", name: "next" }, { type: "text", name: "total" }] }
    : null);
  const inst = reconcileInstanceSlots({
    definitionId: "tool_nodejs",
    marketplaceRef: "marketplace:demo@1.0.0",
    input: [{ type: "text", name: "src", value: "a.txt" }],
    output: [],
  }, resolvePackage);
  assert.deepEqual(names(inst.input), ["prev", "src"]);
  assert.deepEqual(names(inst.output), ["next", "total"]);
  assert.equal(inst.input.find((s) => s.name === "src").value, "a.txt");
});

test("子流程节点的槽位表由实例自己定义，对账不碰", () => {
  for (const definitionId of ["control_subflow_call", "workspace_subflow_input"]) {
    const instance = {
      definitionId,
      input: [{ type: "node", name: "prev", value: "" }, { type: "text", name: "issueId", value: "" }],
      output: [{ type: "node", name: "next", value: "" }],
    };
    assert.equal(reconcileInstanceSlots(instance), instance);
  }
});

// 这是整改里最容易搞反的一步：边的句柄必须**先**译成槽位名，再对账槽位表。
// 反过来等于拿新槽位表解释旧下标，85 个线上流程的演练里有 5 个会被改指向。
test("边按槽位名记录时，对账不会改变任何一条边的指向", () => {
  const graph = {
    instances: {
      a: { definitionId: "display_markdown", input: [{ type: "text", name: "content", value: "" }], output: [] },
      b: { definitionId: "agent_subAgent", input: [{ type: "text", name: "prompt", value: "" }], output: [] },
    },
    edges: [{ source: "a", target: "b", sourceHandle: "content", targetHandle: "prompt" }],
  };
  const before = edgesWithSlotNames(graph);
  const after = edgesWithSlotNames(reconcileGraphSlots(graph));
  assert.deepEqual(after, before);
});

test("对账两次和一次结果相同", () => {
  const graph = {
    instances: { a: { definitionId: "agent_subAgent", input: [{ type: "text", name: "prompt", value: "x" }], output: [] } },
    edges: [],
  };
  const once = reconcileGraphSlots(graph);
  assert.deepEqual(reconcileGraphSlots(once), once);
});

// node.yaml 那条老路不走 slotMapToList，槽位表原样落到 manifest 上——线上因此有节点连
// prev 都没有，控制边只能错接到数据槽上。
test("包的槽位表首位一定是控制槽", () => {
  assert.deepEqual(
    withControlSlot([{ type: "text", name: "src" }], "input").map((s) => s.name),
    ["prev", "src"],
  );
  assert.deepEqual(
    withControlSlot([{ type: "node", name: "next" }, { type: "text", name: "total" }], "output").map((s) => s.name),
    ["next", "total"],
    "已经有了就别再加一个",
  );
});
