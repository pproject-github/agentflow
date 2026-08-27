import assert from "node:assert/strict";
import test from "node:test";

import {
  buildWorkspaceSubflowProjection,
  workspaceSubflowCallRelations,
  workspaceSubflowReturnNodeId,
  workspaceSubflowStartNodeId,
} from "../builtin/web-ui/src/workspaceSubflowProjection.js";

const instances = {
  issueIn: {
    definitionId: "workspace_subflow_input",
    input: [],
    output: [{ name: "value", type: "text" }],
  },
  inspect: {
    definitionId: "agent_subAgent",
    input: [{ name: "prev", type: "node" }, { name: "issue", type: "text" }],
    output: [{ name: "next", type: "node" }, { name: "result", type: "text" }],
  },
  normalize: {
    definitionId: "tool_nodejs",
    input: [{ name: "prev", type: "node" }, { name: "analysis", type: "text" }],
    output: [{ name: "next", type: "node" }, { name: "result", type: "text" }],
  },
};

const subflows = {
  inspectIssue: {
    id: "inspectIssue",
    label: "Issue 单项分析",
    roots: ["inspect"],
    nodeIds: ["issueIn", "inspect", "normalize"],
    inputs: { issue: { nodeId: "issueIn", slot: "value", type: "text" } },
    outputs: {
      summary: { nodeId: "normalize", slot: "result", type: "text" },
      raw: { nodeId: "inspect", slot: "result", type: "text" },
    },
  },
};

const edges = [
  { source: "issueIn", target: "inspect", sourceHandle: "output-0", targetHandle: "input-1" },
  { source: "inspect", target: "normalize", sourceHandle: "output-0", targetHandle: "input-0" },
  { source: "inspect", target: "normalize", sourceHandle: "output-1", targetHandle: "input-1" },
];

test("子流程投影补出可拖动的 Start、Return 和完整控制链", () => {
  const projection = buildWorkspaceSubflowProjection({
    instances,
    subflows,
    edges,
    positions: {
      issueIn: { x: 100, y: 650 },
      inspect: { x: 500, y: 650 },
      normalize: { x: 900, y: 650 },
    },
    sizes: {
      inspect: { width: 320, height: 180 },
      normalize: { width: 320, height: 120 },
    },
  });

  const startId = workspaceSubflowStartNodeId("inspectIssue");
  const returnId = workspaceSubflowReturnNodeId("inspectIssue");
  assert.deepEqual(projection.nodes.map((node) => node.id), [startId, returnId]);
  assert.equal(projection.nodes[0].draggable, true);
  assert.equal(projection.nodes[1].draggable, true);
  assert.equal(projection.nodes[0].data.boundaryKind, "start");
  assert.deepEqual(projection.nodes[0].data.inputs, [{ name: "calls", type: "node" }]);
  assert.deepEqual(projection.nodes[0].data.outputs, [
    { name: "next", type: "node" },
    { name: "issue", type: "text" },
  ]);
  assert.deepEqual(projection.nodes[0].data.contract, [{ name: "issue", type: "text" }]);
  assert.equal(projection.nodes[1].data.boundaryKind, "return");
  assert.deepEqual(projection.nodes[1].data.inputs, [
    { name: "prev", type: "node" },
    { name: "summary", type: "text" },
    { name: "raw", type: "text" },
    { name: "add output", type: "any", addOutput: true },
  ]);
  assert.deepEqual(projection.nodes[1].data.outputs, []);
  assert.deepEqual(projection.nodes[1].data.contract, [
    { name: "summary", type: "text" },
    { name: "raw", type: "text" },
  ]);
  assert.deepEqual(projection.groupMemberIds.inspectIssue, [startId, returnId]);
  assert.deepEqual(projection.hiddenNodeIds, ["issueIn"]);

  assert.ok(projection.edges.some((edge) => (
    edge.source === startId && edge.target === "inspect" && edge.sourceHandle === "output-0" && edge.targetHandle === "input-0"
  )));
  assert.ok(projection.edges.some((edge) => (
    edge.source === startId && edge.target === "inspect" && edge.sourceHandle === "output-1" && edge.targetHandle === "input-1"
  )));
  assert.ok(projection.edges.some((edge) => (
    edge.source === "normalize" && edge.target === returnId && edge.sourceHandle === "output-0" && edge.targetHandle === "input-0"
  )));
  assert.ok(projection.edges.some((edge) => (
    edge.source === "normalize" && edge.target === returnId && edge.sourceHandle === "output-1" && edge.targetHandle === "input-1"
  )));
  assert.ok(projection.edges.some((edge) => (
    edge.source === "inspect" && edge.target === returnId && edge.sourceHandle === "output-1" && edge.targetHandle === "input-2"
  )));
  assert.ok(projection.edges.every((edge) => edge.data.virtualSubflowBoundary === true));
});

test("子流程边界优先采用用户拖动后保存的 UI 坐标", () => {
  const startId = workspaceSubflowStartNodeId("inspectIssue");
  const returnId = workspaceSubflowReturnNodeId("inspectIssue");
  const projection = buildWorkspaceSubflowProjection({
    instances,
    subflows,
    edges,
    positions: {
      issueIn: { x: 100, y: 650 },
      inspect: { x: 500, y: 650 },
      normalize: { x: 900, y: 650 },
    },
    boundaryPositions: {
      [startId]: { x: 240, y: 480 },
      [returnId]: { x: 1380, y: 720 },
    },
  });

  assert.deepEqual(projection.nodes[0].position, { x: 240, y: 480 });
  assert.deepEqual(projection.nodes[1].position, { x: 1380, y: 720 });
});

test("While Condition 只把业务 state 投影成 Start 数据输出引脚", () => {
  const conditionInstances = {
    conditionState: {
      definitionId: "workspace_subflow_input",
      input: [],
      output: [{ name: "value", type: "json" }],
    },
    conditionIteration: {
      definitionId: "workspace_subflow_input",
      input: [],
      output: [{ name: "value", type: "text" }],
    },
    checkBoundary: {
      definitionId: "tool_nodejs",
      input: [
        { name: "prev", type: "node" },
        { name: "state", type: "json" },
        { name: "iteration", type: "text" },
      ],
      output: [{ name: "next", type: "node" }, { name: "result", type: "text" }],
    },
    loop: {
      definitionId: "control_while",
      label: "推进到人工边界",
      conditionSubflowId: "condition",
      bodySubflowId: "",
      input: [{ name: "prev", type: "node" }, { name: "state", type: "json" }],
      output: [{ name: "next", type: "node" }, { name: "decision", type: "text" }],
    },
  };
  const projection = buildWorkspaceSubflowProjection({
    instances: conditionInstances,
    subflows: {
      condition: {
        id: "condition",
        label: "是否继续推进",
        roots: ["checkBoundary"],
        nodeIds: ["conditionState", "conditionIteration", "checkBoundary"],
        inputs: {
          state: { nodeId: "conditionState", slot: "value", type: "json" },
          iteration: { nodeId: "conditionIteration", slot: "value", type: "text" },
        },
        outputs: { decision: { nodeId: "checkBoundary", slot: "result", type: "text" } },
      },
    },
    edges: [
      { source: "conditionState", target: "checkBoundary", sourceHandle: "output-0", targetHandle: "input-1" },
      { source: "conditionIteration", target: "checkBoundary", sourceHandle: "output-0", targetHandle: "input-2" },
    ],
    positions: { checkBoundary: { x: 500, y: 300 } },
  });

  const start = projection.nodes.find((node) => node.id === workspaceSubflowStartNodeId("condition"));
  assert.deepEqual(start.data.inputs.map((slot) => slot.name), ["calls"]);
  assert.deepEqual(start.data.outputs.map((slot) => slot.name), ["next", "state"]);
  assert.deepEqual(start.data.contract, [
    { name: "state", type: "json" },
  ]);
  assert.deepEqual(start.data.callRelations[0].inputMappings.map((mapping) => ({
    name: mapping.name,
    from: mapping.from,
    fromShort: mapping.fromShort,
  })), [
    { name: "state", from: "推进到人工边界.state", fromShort: "While.state" },
  ]);
  assert.ok(projection.edges.some((edge) => edge.sourceHandle === "output-1" && edge.targetHandle === "input-1"));
  assert.ok(!projection.edges.some((edge) => edge.targetHandle === "input-2"));
  assert.deepEqual(projection.hiddenInputHandles, ["checkBoundary\u0000input-2"]);

  const [relation] = workspaceSubflowCallRelations(conditionInstances, {
    condition: {
      label: "是否继续推进",
      inputs: {
        state: { type: "json" },
        iteration: { type: "text" },
      },
      outputs: { decision: { type: "text" } },
    },
  });
  assert.equal(relation.id, "while-subflow:loop:condition:condition");
  assert.deepEqual(relation.outputMappings.map((mapping) => ({ name: mapping.name, toShort: mapping.toShort })), [
    { name: "decision", toShort: "While.decision" },
  ]);
});

test("While Body Return 投影当前 state 的字段结构", () => {
  const projection = buildWorkspaceSubflowProjection({
    instances: {
      nextState: {
        definitionId: "control_parse_json",
        input: [{ name: "prev", type: "node" }],
        output: [
          { name: "next", type: "node" },
          { name: "result", type: "json", value: '{"cursor":3,"valid":["U-001"]}' },
        ],
      },
      loop: {
        definitionId: "control_while",
        conditionSubflowId: "",
        bodySubflowId: "body",
        output: [{ name: "next", type: "node" }, { name: "state", type: "json" }],
      },
    },
    subflows: {
      body: {
        roots: ["nextState"],
        nodeIds: ["nextState"],
        inputs: {},
        outputs: { state: { nodeId: "nextState", slot: "result", type: "json" } },
      },
    },
    positions: { nextState: { x: 500, y: 300 } },
  });
  const ret = projection.nodes.find((node) => node.id === workspaceSubflowReturnNodeId("body"));
  assert.equal(ret.data.fixedContract, true);
  assert.equal(ret.data.statePreview.sourceNodeId, "nextState");
  assert.deepEqual(ret.data.statePreview.fields.map(({ name, type }) => ({ name, type })), [
    { name: "cursor", type: "number" },
    { name: "valid", type: "array(1)" },
  ]);
});

test("没有有效 root 的子流程不会制造假的运行入口", () => {
  const projection = buildWorkspaceSubflowProjection({
    instances,
    subflows: { broken: { nodeIds: ["inspect"], roots: [], inputs: {}, outputs: {} } },
  });
  assert.deepEqual(projection, { nodes: [], edges: [], groupMemberIds: {}, hiddenNodeIds: [], hiddenInputHandles: [] });
});
