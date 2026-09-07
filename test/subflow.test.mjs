import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { generateFlowSource } from "../bin/lib/flow-dsl/codegen.mjs";
import { irToGraph } from "../bin/lib/flow-dsl/ir.mjs";
import { lintFlowDir } from "../bin/lib/flow-dsl/lint.mjs";
import { parseFlowSource } from "../bin/lib/flow-dsl/parser.mjs";
import { runWorkspaceGraph, workspaceNodeInputFingerprint } from "../bin/lib/workspace-server.mjs";
import { consumeWorkspaceInterrupt, readWorkspaceInterrupt } from "../bin/lib/workspace-interrupt.mjs";

const SOURCE = `import { agent, control, display, file, flow, provide, tool, workspace } from "agentflow/flow";

const stateIn = flow.input("state", "json");
const step = tool.nodejs("Advance one", { state: stateIn.value }, \`node -e 'process.stdout.write(JSON.stringify({done:true}))'\`);
const { result } = step;

export const advanceOne = flow.subflow(
  "Advance one item",
  { state: stateIn },
  flow(step),
  { state: step.result },
);

const initial = provide.json({ value: "{\\\"done\\\":false}" });
const call = flow.call("Call advance", advanceOne, { state: initial.value });
const { state } = call;
const board = display.markdown({ content: call.state });
export const run = flow("Run", call, board);
`;

const INTERRUPT_SOURCE = `import { control, display, flow, provide } from "agentflow/flow";
const input = flow.input("topic", "text");
const wait = control.interrupt("等待确认", { value: input.value, resumeSchema: '{"type":"object"}' });
export const child = flow.subflow("等待子流程", { topic: input }, flow(wait), { resume: wait.resume });
const topic = provide.str("主题", { value: "hello" });
const call = flow.call("调用等待子流程", child, { topic: topic.value });
const report = display.markdown("结果", { content: call.resume });
export const run = flow("Run", call, report);
`;

test("subflow DSL parses and round-trips its contract", () => {
  const ir = parseFlowSource(SOURCE);
  assert.deepEqual(ir.unresolved, []);
  assert.equal(ir.nodes.call.definitionId, "control_subflow_call");
  assert.equal(ir.nodes.call.attrs.subflowId, "advanceOne");
  assert.deepEqual(Object.keys(ir.subflows.advanceOne.inputs), ["state"]);
  assert.deepEqual(Object.keys(ir.subflows.advanceOne.outputs), ["state"]);
  assert.deepEqual(ir.subflows.advanceOne.roots, ["step"]);
  assert.ok(ir.subflows.advanceOne.nodeIds.includes("step"));
  assert.ok(ir.subflows.advanceOne.nodeIds.includes("stateIn"));

  const generated = generateFlowSource(ir).source;
  const reparsed = parseFlowSource(generated);
  assert.deepEqual(reparsed.unresolved, [], generated);
  assert.deepEqual(reparsed.subflows, ir.subflows);
  assert.deepEqual(reparsed.edges, ir.edges);
});

test("subflow contract passes lint without exposing internal edges to the parent", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-subflow-lint-"));
  try {
    fs.writeFileSync(path.join(root, "workspace.flow.js"), SOURCE);
    const lint = lintFlowDir(root);
    assert.deepEqual(lint.errors, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("flow.call cache fingerprint changes when an internal node changes", () => {
  const graph = irToGraph(parseFlowSource(SOURCE));
  const before = workspaceNodeInputFingerprint(graph, "call");
  graph.instances.step.script += " ";
  const after = workspaceNodeInputFingerprint(graph, "call");
  assert.notEqual(after, before);
});

test("flow.call executes standard child nodes in an isolated frame and maps outputs", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-subflow-"));
  try {
    const graph = irToGraph(parseFlowSource(SOURCE));
    const events = [];
    const result = await runWorkspaceGraph(root, root, {
      graph,
      runNodeId: "run",
      runId: "subflow-test",
      ignoreCache: true,
    }, { userId: "subflow-test" }, { onEvent: (event) => events.push(event) });
    const callState = result.graph.instances.call.output.find((slot) => slot.name === "state");
    assert.equal(callState.value, JSON.stringify({ done: true }));
    assert.ok(events.some((event) => event.type === "subflow-start" && event.nodeId === "call"));
    assert.ok(events.some((event) => event.type === "node-done" && event.nodeId === "step" && event.parentNodeId === "call"));
    assert.ok(events.some((event) => event.type === "subflow-done" && event.nodeId === "call"));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("flow.call propagates a child interrupt and resumes the same call frame", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-subflow-interrupt-"));
  const runId = `subflow-interrupt-${process.pid}`;
  try {
    const graph = irToGraph(parseFlowSource(INTERRUPT_SOURCE));
    const first = await runWorkspaceGraph(root, root, {
      graph,
      runNodeId: "run",
      runId,
      ignoreCache: true,
    }, { userId: "subflow-interrupt-test" });
    assert.deepEqual(first.pauseNodeIds, ["call"]);
    assert.ok(first.events.some((event) => event.type === "subflow-waiting" && event.nodeId === "call"));
    const waiting = readWorkspaceInterrupt(runId);
    assert.ok(waiting?.interruptId);
    const waitingCheckpoint = [...(first.runStateHistory || [])].reverse().find((event) => event.recordType === "checkpoint" && event.callFrame?.callFrameId && event.callFrame.status === "waiting");
    assert.equal(waitingCheckpoint?.callFrame?.parentNodeId, "call");
    assert.equal(waitingCheckpoint?.callFrame?.status, "waiting");

    const resumed = await runWorkspaceGraph(root, root, {
      graph: first.graph,
      runNodeId: "run",
      runId,
      resume: { interruptId: waiting.interruptId, resume: { approved: true } },
      ignoreCache: true,
    }, { userId: "subflow-interrupt-test" });
    assert.deepEqual(resumed.pauseNodeIds, []);
    assert.ok(resumed.events.some((event) => event.type === "subflow-done" && event.nodeId === "call"));
    assert.equal(readWorkspaceInterrupt(runId)?.status, "resolved");
  } finally {
    consumeWorkspaceInterrupt(runId, "");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
