import assert from "node:assert/strict";
import test from "node:test";
import {
  activeSubflowCanvas,
  applySubflowBoundaryConnection,
  createWhileSubflowScaffold,
  parentWorkspaceCanvas,
  reconcileSubflowCallOutputs,
  removeSubflowOutput,
  renameSubflowOutput,
} from "../builtin/web-ui/src/workspaceSubflowEditing.js";
import { flowFilesToGraph, graphToFlowFiles } from "../bin/lib/flow-dsl/index.mjs";

test("While scaffold creates fixed runtime inputs without exposing output bindings", () => {
  const made = createWhileSubflowScaffold({
    whileId: "loop",
    instance: { definitionId: "control_while" },
    instances: { loop: {} },
    subflows: {},
  });
  assert.equal(made.instance.conditionSubflowId, "loopCondition");
  assert.deepEqual(Object.keys(made.subflows.loopCondition.inputs), ["state", "iteration"]);
  assert.deepEqual(Object.keys(made.subflows.loopBody.inputs), ["state", "iteration", "idempotencyKey"]);
  assert.deepEqual(made.subflows.loopCondition.outputs, {});
});

test("Boundary connections persist as subflow roots, proxy edges and output bindings", () => {
  const graph = {
    instances: {
      stateProxy: { definitionId: "workspace_subflow_input", output: [{ name: "value", type: "json" }] },
      step: {
        input: [{ name: "prev", type: "node" }, { name: "state", type: "json" }],
        output: [{ name: "next", type: "node" }, { name: "decision", type: "text" }],
      },
    },
    subflows: {
      cond: {
        nodeIds: ["stateProxy", "step"],
        roots: [],
        inputs: { state: { nodeId: "stateProxy", slot: "value", type: "json" } },
        outputs: {},
      },
    },
    edges: [],
  };
  const start = { data: { isSubflowBoundary: true, boundaryKind: "start", subflowId: "cond", subflowRole: "condition" } };
  const ret = { data: { isSubflowBoundary: true, boundaryKind: "return", subflowId: "cond", subflowRole: "condition" } };
  let applied = applySubflowBoundaryConnection({
    graph,
    sourceNode: start,
    targetNode: { id: "step", data: {} },
    params: { source: "subflow-start:cond", sourceHandle: "output-0", target: "step", targetHandle: "input-0" },
  });
  assert.deepEqual(applied.graph.subflows.cond.roots, ["step"]);
  applied = applySubflowBoundaryConnection({
    graph: applied.graph,
    sourceNode: start,
    targetNode: { id: "step", data: {} },
    params: { source: "subflow-start:cond", sourceHandle: "output-1", target: "step", targetHandle: "input-1" },
  });
  assert.equal(applied.graph.edges[0].source, "stateProxy");
  applied = applySubflowBoundaryConnection({
    graph: applied.graph,
    sourceNode: { id: "step", data: {} },
    targetNode: ret,
    params: { source: "step", sourceHandle: "output-1", target: "subflow-return:cond", targetHandle: "input-1" },
  });
  assert.deepEqual(applied.graph.subflows.cond.outputs.decision, { nodeId: "step", slot: "decision", type: "text" });
});

test("Return control accepts only a terminal subflow node", () => {
  const graph = {
    instances: {
      first: { output: [{ name: "next", type: "node" }] },
      last: { input: [{ name: "prev", type: "node" }], output: [{ name: "next", type: "node" }] },
    },
    subflows: { body: { nodeIds: ["first", "last"], roots: ["first"], inputs: {}, outputs: {} } },
    edges: [{ source: "first", sourceHandle: "output-0", target: "last", targetHandle: "input-0" }],
  };
  const ret = { data: { isSubflowBoundary: true, boundaryKind: "return", subflowId: "body", subflowRole: "body" } };
  const rejected = applySubflowBoundaryConnection({
    graph,
    sourceNode: { id: "first", data: {} },
    targetNode: ret,
    params: { source: "first", sourceHandle: "output-0", target: "subflow-return:body", targetHandle: "input-0" },
  });
  assert.match(rejected.error, /末端节点/);
  const accepted = applySubflowBoundaryConnection({
    graph,
    sourceNode: { id: "last", data: {} },
    targetNode: ret,
    params: { source: "last", sourceHandle: "output-0", target: "subflow-return:body", targetHandle: "input-0" },
  });
  assert.equal(accepted.error, undefined);
});

test("Generic Return can create, rename and remove a typed output binding", () => {
  const graph = {
    instances: {
      step: { output: [{ name: "result", type: "json" }] },
      call: {
        definitionId: "control_subflow_call",
        subflowId: "child",
        output: [{ name: "next", type: "node" }],
      },
    },
    subflows: { child: { nodeIds: ["step"], roots: ["step"], inputs: {}, outputs: {} } },
    edges: [],
  };
  const ret = {
    data: {
      isSubflowBoundary: true,
      boundaryKind: "return",
      subflowId: "child",
      subflowRole: "call",
      contract: [],
    },
  };
  const added = applySubflowBoundaryConnection({
    graph,
    sourceNode: { id: "step", data: {} },
    targetNode: ret,
    params: { source: "step", sourceHandle: "output-0", target: "subflow-return:child", targetHandle: "input-1" },
  });
  assert.equal(added.addedOutputName, "result");
  assert.deepEqual(added.graph.subflows.child.outputs.result, { nodeId: "step", slot: "result", type: "json" });
  assert.deepEqual(added.graph.instances.call.output.map(({ name, type }) => ({ name, type })), [
    { name: "next", type: "node" },
    { name: "result", type: "json" },
  ]);
  const renamed = renameSubflowOutput(added.graph.subflows, "child", "result", "payload");
  assert.deepEqual(renamed.subflows.child.outputs.payload, { nodeId: "step", slot: "result", type: "json" });
  const renamedGraph = reconcileSubflowCallOutputs({ ...added.graph, subflows: renamed.subflows }, "child", { result: "payload" });
  assert.equal(renamedGraph.instances.call.output[1].name, "payload");
  const removed = removeSubflowOutput(renamed.subflows, "child", "payload");
  assert.deepEqual(removed.subflows.child.outputs, {});
  const removedGraph = reconcileSubflowCallOutputs({ ...renamedGraph, subflows: removed.subflows }, "child");
  assert.deepEqual(removedGraph.instances.call.output.map((slot) => slot.name), ["next"]);
});

test("A UI-added Generic Return output round-trips through DSL and its caller contract", () => {
  const source = `import { flow, provide, tool } from "agentflow/flow";
const stateIn = flow.input("state", "json");
const step = tool.nodejs("Step", { state: stateIn.value }, "node -e 'process.stdout.write(JSON.stringify({}))'");
export const child = flow.subflow("Child", { state: stateIn }, flow(step), { state: step.result });
const initial = provide.json({ value: "{}" });
const call = flow.call("Call", child, { state: initial.value });
const { state } = call;
export const run = flow("Run", call);
`;
  const graph = flowFilesToGraph({ source, layout: {}, nodeMeta: {}, files: {}, strict: true });
  const resultIndex = graph.instances.step.output.findIndex((slot) => slot.name === "result");
  const added = applySubflowBoundaryConnection({
    graph,
    sourceNode: { id: "step", data: {} },
    targetNode: {
      data: {
        isSubflowBoundary: true,
        boundaryKind: "return",
        subflowId: "child",
        subflowRole: "call",
        contract: [{ name: "state", type: "text" }],
      },
    },
    params: {
      source: "step",
      sourceHandle: `output-${resultIndex}`,
      target: "subflow-return:child",
      targetHandle: "input-2",
    },
  });
  const renamed = renameSubflowOutput(added.graph.subflows, "child", "result", "raw");
  const reconciled = reconcileSubflowCallOutputs(
    { ...added.graph, subflows: renamed.subflows },
    "child",
    { result: "raw" },
  );
  const files = graphToFlowFiles(reconciled);
  const parsed = flowFilesToGraph({
    source: files.source,
    layout: files.layout,
    nodeMeta: files.nodeMeta,
    files: files.files,
    strict: true,
  });
  assert.deepEqual(Object.keys(parsed.subflows.child.outputs), ["state", "raw"]);
  assert.ok(parsed.instances.call.output.some((slot) => slot.name === "raw"));
});

test("Subflow edit canvas contains only members and its two boundaries", () => {
  const nodes = [
    { id: "a", data: {} },
    { id: "b", data: {} },
    { id: "outside", data: {} },
    { id: "subflow-start:s", data: { isSubflowBoundary: true } },
    { id: "subflow-return:s", data: { isSubflowBoundary: true } },
  ];
  const edges = [{ source: "a", target: "b" }, { source: "outside", target: "b" }];
  const view = activeSubflowCanvas({ nodes, edges, subflow: { nodeIds: ["a", "b"] }, subflowId: "s" });
  assert.deepEqual(view.nodes.map((node) => node.id), ["a", "b", "subflow-start:s", "subflow-return:s"]);
  assert.deepEqual(view.edges, [{ source: "a", target: "b" }]);
});

test("Parent canvas hides subflow members, boundaries, groups and virtual relations", () => {
  const nodes = [
    { id: "while", data: {} },
    { id: "inside", data: {} },
    { id: "outside", data: {} },
    { id: "subflow-start:s", data: { isSubflowBoundary: true } },
    { id: "subflow-return:s", data: { isSubflowBoundary: true } },
    { id: "subflow-group:s", data: { isSubflowGroup: true } },
  ];
  const edges = [
    { source: "outside", target: "while" },
    { source: "inside", target: "subflow-return:s", data: { virtualSubflowBoundary: true } },
    { source: "while", target: "subflow-start:s", data: { virtualSubflowCall: true } },
  ];
  const view = parentWorkspaceCanvas({ nodes, edges, subflows: { s: { nodeIds: ["inside"] } } });
  assert.deepEqual(view.nodes.map((node) => node.id), ["while", "outside"]);
  assert.deepEqual(view.edges, [{ source: "outside", target: "while" }]);
});

test("an unwired While scaffold remains round-trippable as an editable DSL draft", () => {
  const loop = {
    definitionId: "control_while",
    label: "Loop",
    input: [
      { type: "node", name: "prev", value: "" },
      { type: "json", name: "state", value: "null" },
      { type: "text", name: "maxIterations", value: "10" },
      { type: "text", name: "timeout", value: "2m" },
    ],
    output: [{ type: "node", name: "next", value: "" }, { type: "json", name: "state", value: "" }],
  };
  const made = createWhileSubflowScaffold({ whileId: "loop", instance: loop, instances: { loop }, subflows: {} });
  const graph = {
    version: 1,
    instances: { loop: made.instance, ...made.instances },
    edges: [],
    subflows: made.subflows,
    ui: { nodePositions: { loop: { x: 100, y: 100 } }, nodeSizes: {} },
  };
  const files = graphToFlowFiles(graph);
  const parsed = flowFilesToGraph({
    source: files.source,
    layout: files.layout,
    nodeMeta: files.nodeMeta,
    files: files.files,
    strict: true,
  });
  assert.equal(parsed.instances.loop.conditionSubflowId, "loopCondition");
  assert.deepEqual(parsed.subflows.loopCondition.roots, []);
});
