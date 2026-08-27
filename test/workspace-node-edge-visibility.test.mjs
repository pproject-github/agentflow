import assert from "node:assert/strict";
import test from "node:test";

import {
  filterValidEdges,
  mergeNodeWithPalette,
  revealConnectedSlotsForEdges,
} from "../builtin/web-ui/src/mergeFlowNodes.js";

const marketplaceRef = "marketplace:android_lint_scan@1.0.0";

const palette = [
  {
    id: "tool_nodejs",
    displayName: "NodeJs",
    inputs: [
      { type: "node", name: "prev", showOnNode: true },
      { type: "text", name: "workspaceContext", showOnNode: false },
      { type: "text", name: "skillsContext", showOnNode: false },
      { type: "text", name: "mcpContext", showOnNode: false },
    ],
    outputs: [
      { type: "node", name: "next", showOnNode: true },
      { type: "text", name: "result", showOnNode: true },
    ],
  },
  {
    id: marketplaceRef,
    marketplaceDefinitionId: marketplaceRef,
    baseDefinitionId: "tool_nodejs",
    packageId: "android_lint_scan",
    version: "1.0.0",
    displayName: "Android Lint 扫描",
    inputs: [
      { type: "node", name: "prev", showOnNode: true },
      { type: "text", name: "projectDir", required: true, showOnNode: true },
      { type: "text", name: "gradleTask", required: true, showOnNode: true },
      { type: "text", name: "maxIssues", required: true, showOnNode: true },
    ],
    outputs: [
      { type: "node", name: "next", showOnNode: true },
      { type: "text", name: "markdown", showOnNode: true },
      { type: "text", name: "issueCount", showOnNode: false },
    ],
  },
];

function lintInstance() {
  return {
    definitionId: "tool_nodejs",
    marketplaceRef,
    marketplacePackageId: "android_lint_scan",
    marketplaceVersion: "1.0.0",
    input: [
      { type: "node", name: "prev", value: "" },
      { type: "text", name: "projectDir", value: "", required: true },
      { type: "text", name: "gradleTask", value: "", required: true },
      { type: "text", name: "maxIssues", value: "", required: true },
    ],
    output: [
      { type: "node", name: "next", value: "" },
      { type: "text", name: "markdown", value: "" },
      { type: "text", name: "issueCount", value: "" },
    ],
  };
}

test("marketplace 节点用包定义合并引脚，同时保留基础 runtime definitionId", () => {
  const instance = lintInstance();
  const node = mergeNodeWithPalette({
    id: "lintScan",
    data: { definitionId: "tool_nodejs", marketplaceRef },
  }, { lintScan: instance }, palette);

  assert.equal(node.data.definitionId, "tool_nodejs");
  assert.equal(node.data.marketplaceRef, marketplaceRef);
  assert.equal(node.data.definitionDisplayName, "Android Lint 扫描");
  assert.deepEqual(node.data.inputs.map((slot) => slot.name), [
    "prev",
    "projectDir",
    "gradleTask",
    "maxIssues",
  ]);
  assert.deepEqual(node.data.inputs.map((slot) => slot.showOnNode), [true, true, true, true]);
  assert.deepEqual(node.data.outputs.map((slot) => slot.name), ["next", "markdown", "issueCount"]);
});

test("首次加载已有边时显露每条边的 source 和 target handle", () => {
  const nodes = [
    {
      id: "source",
      data: {
        inputs: [],
        outputs: [
          { type: "node", name: "next", showOnNode: true },
          { type: "text", name: "result", showOnNode: false },
        ],
      },
    },
    {
      id: "target",
      data: {
        inputs: [
          { type: "node", name: "prev", showOnNode: false },
          { type: "text", name: "content", showOnNode: false },
          { type: "text", name: "unused", showOnNode: false },
        ],
        outputs: [],
      },
    },
  ];
  const edges = [
    {
      source: "source",
      target: "target",
      sourceHandle: "output-1",
      targetHandle: "input-1",
    },
  ];

  const revealed = revealConnectedSlotsForEdges(nodes, edges);
  assert.equal(revealed[0].data.outputs[1].showOnNode, true);
  assert.equal(revealed[1].data.inputs[1].showOnNode, true);
  assert.equal(revealed[1].data.inputs[0].showOnNode, false);
  assert.equal(revealed[1].data.inputs[2].showOnNode, false);
  assert.equal(filterValidEdges(edges, revealed).length, 1);
});

test("空边集合不制造新的节点显隐覆盖", () => {
  const nodes = [{ id: "n", data: { inputs: [], outputs: [] } }];
  assert.equal(revealConnectedSlotsForEdges(nodes, []), nodes);
});

test("Subflow Call 始终展示完整输入输出契约，不因未连线隐藏 raw", () => {
  const node = mergeNodeWithPalette({
    id: "callInspect",
    data: { definitionId: "control_subflow_call" },
  }, {
    callInspect: {
      definitionId: "control_subflow_call",
      input: [
        { type: "node", name: "prev", value: "", showOnNode: true },
        { type: "text", name: "issue", value: "", showOnNode: false },
      ],
      output: [
        { type: "node", name: "next", value: "", showOnNode: true },
        { type: "text", name: "summary", value: "", showOnNode: true },
        { type: "text", name: "raw", value: "", showOnNode: false },
      ],
    },
  }, [{
    id: "control_subflow_call",
    inputs: [{ type: "node", name: "prev" }],
    outputs: [{ type: "node", name: "next" }],
  }]);

  assert.deepEqual(node.data.inputs.map((slot) => [slot.name, slot.showOnNode]), [
    ["prev", true],
    ["issue", true],
  ]);
  assert.deepEqual(node.data.outputs.map((slot) => [slot.name, slot.showOnNode]), [
    ["next", true],
    ["summary", true],
    ["raw", true],
  ]);
});
