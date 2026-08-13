import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  controlWhileCheckpointFingerprint,
  controlWhileIdempotencyKey,
  normalizeControlWhileConfig,
  normalizeControlWhileHistory,
  normalizeControlWhileInitialState,
  parseControlWhileStepResult,
  resolveControlWhileCheckpoint,
  runControlWhile,
} from "../bin/lib/control-while.mjs";
import { flowFilesToGraph, graphToFlowFiles } from "../bin/lib/flow-dsl/index.mjs";
import { lintFlowDir } from "../bin/lib/flow-dsl/lint.mjs";
import { runWorkspaceGraph, workspaceNodeInputFingerprint } from "../bin/lib/workspace-server.mjs";

function whileGraph(downstreamFile = "downstream.txt") {
  return {
    version: 1,
    instances: {
      run: {
        definitionId: "workspace_run",
        label: "Run",
        input: [{ type: "node", name: "prev" }],
        output: [{ type: "node", name: "next" }],
      },
      loop: {
        definitionId: "control_while",
        label: "推进到人工边界",
        script: "node ${flowDir}/step.mjs",
        input: [
          { type: "node", name: "prev" },
          { type: "json", name: "state", value: '{"last":0}' },
          { type: "text", name: "maxIterations", value: "5" },
          { type: "text", name: "timeout", value: "10s" },
        ],
        output: [
          { type: "node", name: "next" },
          { type: "json", name: "result", value: "" },
          { type: "json", name: "state", value: "null" },
          { type: "text", name: "decision", value: "" },
          { type: "text", name: "iterations", value: "0" },
          { type: "text", name: "summary", value: "" },
          { type: "json", name: "history", value: "[]" },
          { type: "text", name: "checkpointFingerprint", value: "" },
        ],
      },
      downstream: {
        definitionId: "tool_nodejs",
        label: "下游",
        script: `echo reached > \${workspaceRoot}/${downstreamFile}`,
        input: [{ type: "node", name: "prev" }],
        output: [{ type: "node", name: "next" }, { type: "text", name: "result", value: "" }],
      },
    },
    edges: [
      { source: "run", target: "loop", sourceHandle: "output-0", targetHandle: "input-0" },
      { source: "loop", target: "downstream", sourceHandle: "output-0", targetHandle: "input-0" },
    ],
    ui: { nodePositions: {} },
  };
}

function outputValues(instance) {
  return Object.fromEntries((instance.output || []).map((slot) => [slot.name, slot.value ?? slot.default ?? ""]));
}

function subflowWhileSource({ timeout = "10s" } = {}) {
  return `import { control, flow, provide, tool } from "agentflow/flow";

const conditionState = flow.input("state", "json");
const conditionIteration = flow.input("iteration", "text");
const conditionStep = tool.nodejs("Check condition", {
  state: conditionState.value,
  iteration: conditionIteration.value,
}, \`node \${flowDir}/condition.mjs\`);

export const conditionFlow = flow.subflow(
  "Condition",
  { state: conditionState, iteration: conditionIteration },
  flow(conditionStep),
  { decision: conditionStep.result },
);

const bodyState = flow.input("state", "json");
const bodyIteration = flow.input("iteration", "text");
const bodyIdempotencyKey = flow.input("idempotencyKey", "text");
const bodyStep = tool.nodejs("Run body", {
  state: bodyState.value,
  iteration: bodyIteration.value,
  idempotencyKey: bodyIdempotencyKey.value,
}, \`node \${flowDir}/body.mjs\`);

const bodyNextState = control.parseJson("Validate next state", {
  value: bodyStep.result,
});

export const bodyFlow = flow.subflow(
  "Body",
  { state: bodyState, iteration: bodyIteration, idempotencyKey: bodyIdempotencyKey },
  flow(bodyStep, bodyNextState),
  { state: bodyNextState.result },
);

const initialState = provide.json("Initial state", {
  value: "{\\"n\\":0}",
});

const loop = control.while("Advance", {
  state: initialState.value,
  maxIterations: "5",
  timeout: "${timeout}",
}, conditionFlow, bodyFlow);

const downstream = tool.nodejs("Downstream", {}, \`echo reached > \${workspaceRoot}/downstream.txt\`);
export const run = flow("Run", loop, downstream);
`;
}

test("control.while config and decision contract are strict", async () => {
  assert.deepEqual(normalizeControlWhileConfig({ maxIterations: "3", timeout: "2m" }), {
    maxIterations: 3,
    timeoutMs: 120_000,
  });
  assert.deepEqual(parseControlWhileStepResult('{"decision":"done","state":{"ok":true}}'), {
    decision: "done",
    state: { ok: true },
    summary: "",
  });
  assert.throws(() => parseControlWhileStepResult("progress\n{}"), /exactly one JSON object/);
  assert.throws(() => parseControlWhileStepResult('{"decision":"DONE"}'), /continue, wait, done, or fail/);
  assert.throws(() => parseControlWhileStepResult('{"decision":"done","message":"legacy"}'), /unsupported fields/);
  assert.throws(() => parseControlWhileStepResult('{"decision":"done","summary":42}'), /summary must be a string/);
  assert.throws(() => normalizeControlWhileInitialState("not-json"), /state must be valid JSON/);
  assert.throws(() => normalizeControlWhileConfig({ maxIterations: "0" }), /between 1 and 1000/);

  const limited = await runControlWhile({
    initialState: { n: 0 },
    maxIterations: 2,
    timeoutMs: 1000,
    executeStep: async ({ iteration }) => JSON.stringify({ decision: "continue", state: { n: iteration } }),
  });
  assert.equal(limited.decision, "fail");
  assert.equal(limited.reason, "max_iterations");
  assert.equal(limited.iterations, 2);
  assert.deepEqual(limited.state, { n: 2 });
});

test("control.while resumes cumulative limits with stable iteration idempotency keys", async () => {
  const fingerprint = controlWhileCheckpointFingerprint({
    inputFingerprint: "input-v1",
    initialState: { n: 0 },
  });
  const priorHistory = [
    {
      iteration: 1,
      decision: "continue",
      summary: "first",
      elapsedMs: 10,
      idempotencyKey: controlWhileIdempotencyKey({ checkpointFingerprint: fingerprint, nodeId: "loop", iteration: 1 }),
    },
    {
      iteration: 2,
      decision: "wait",
      summary: "approval",
      elapsedMs: 20,
      idempotencyKey: controlWhileIdempotencyKey({ checkpointFingerprint: fingerprint, nodeId: "loop", iteration: 2 }),
    },
  ];
  const seen = [];
  const resumed = await runControlWhile({
    initialState: { n: 2 },
    initialHistory: priorHistory,
    initialElapsedMs: 30,
    startIteration: 3,
    maxIterations: 3,
    timeoutMs: 1000,
    now: () => 100,
    idempotencyKeyForIteration: ({ iteration }) => controlWhileIdempotencyKey({
      checkpointFingerprint: fingerprint,
      nodeId: "loop",
      iteration,
    }),
    executeStep: async ({ iteration, idempotencyKey }) => {
      seen.push({ iteration, idempotencyKey });
      return JSON.stringify({ decision: "done", state: { n: iteration }, summary: "finished" });
    },
  });

  assert.equal(resumed.iterations, 3);
  assert.equal(resumed.history.length, 3);
  assert.deepEqual(resumed.history.slice(0, 2), priorHistory);
  assert.deepEqual(seen, [{
    iteration: 3,
    idempotencyKey: controlWhileIdempotencyKey({ checkpointFingerprint: fingerprint, nodeId: "loop", iteration: 3 }),
  }]);

  let executed = false;
  const exhausted = await runControlWhile({
    initialState: { n: 2 },
    initialHistory: priorHistory,
    initialElapsedMs: 30,
    startIteration: 3,
    maxIterations: 2,
    timeoutMs: 1000,
    executeStep: async () => {
      executed = true;
      return '{"decision":"done"}';
    },
  });
  assert.equal(exhausted.decision, "fail");
  assert.equal(exhausted.reason, "max_iterations");
  assert.equal(exhausted.iterations, 2);
  assert.equal(executed, false, "maxIterations must be cumulative across wait/resume");

  const timedOut = await runControlWhile({
    initialState: { n: 2 },
    initialHistory: priorHistory,
    initialElapsedMs: 1000,
    startIteration: 3,
    maxIterations: 3,
    timeoutMs: 1000,
    now: () => 100,
    executeStep: async () => {
      executed = true;
      return '{"decision":"done"}';
    },
  });
  assert.equal(timedOut.reason, "timeout");
  assert.equal(timedOut.iterations, 2);
});

test("control.while validates waiting checkpoints before resuming", () => {
  const fingerprint = controlWhileCheckpointFingerprint({ inputFingerprint: "v1", initialState: { n: 0 } });
  const history = [{ iteration: 1, decision: "wait", summary: "pause", elapsedMs: 7 }];
  assert.deepEqual(resolveControlWhileCheckpoint({
    previousDecision: "wait",
    state: '{"n":1}',
    history: JSON.stringify(history),
    iterations: "1",
    fingerprint,
    expectedFingerprint: fingerprint,
  }), {
    resumable: true,
    reason: "waiting_checkpoint",
    state: { n: 1 },
    history,
    nextIteration: 2,
    elapsedMs: 7,
  });
  assert.deepEqual(resolveControlWhileCheckpoint({
    previousDecision: "wait",
    fingerprint: "old",
    expectedFingerprint: fingerprint,
  }), { resumable: false, reason: "fingerprint_mismatch" });
  assert.throws(() => resolveControlWhileCheckpoint({
    previousDecision: "wait",
    state: '{"n":1}',
    history: "[]",
    iterations: "1",
    fingerprint,
    expectedFingerprint: fingerprint,
  }), /checkpoint is corrupt/);
  assert.throws(() => normalizeControlWhileHistory('[{"iteration":2,"decision":"wait"},{"iteration":1,"decision":"done"}]'), /strictly increasing/);
});

test("control.while DSL round-trips as a script-backed DAG node", () => {
  const source = `import { control, flow } from "agentflow/flow";

const loop = control.while("推进", {
  state: "{}",
  maxIterations: "20",
  timeout: "30m",
}, \`node \${flowDir}/scripts/advance-prd-step.mjs\`);

export const run = flow("Run", loop);
`;
  const graph = flowFilesToGraph({ source, layout: {}, nodeMeta: {}, files: {} });
  assert.equal(graph.instances.loop.definitionId, "control_while");
  assert.equal(graph.instances.loop.script, "node ${flowDir}/scripts/advance-prd-step.mjs");
  const generated = graphToFlowFiles(graph);
  const back = flowFilesToGraph(generated);
  assert.equal(back.instances.loop.script, graph.instances.loop.script);
  assert.equal(graphToFlowFiles(back).source, generated.source);
});

test("control.while DSL round-trips explicit Condition and Body subflows", () => {
  const source = subflowWhileSource();
  const graph = flowFilesToGraph({ source, layout: {}, nodeMeta: {}, files: {} });
  assert.equal(graph.instances.loop.conditionSubflowId, "conditionFlow");
  assert.equal(graph.instances.loop.bodySubflowId, "bodyFlow");
  assert.equal(graph.instances.loop.script, undefined);

  const generated = graphToFlowFiles(graph);
  assert.match(generated.source, /control\.while\("Advance",[\s\S]*conditionFlow, bodyFlow\)/);
  const back = flowFilesToGraph(generated);
  assert.equal(back.instances.loop.conditionSubflowId, "conditionFlow");
  assert.equal(back.instances.loop.bodySubflowId, "bodyFlow");
  assert.equal(graphToFlowFiles(back).source, generated.source);

  const before = workspaceNodeInputFingerprint(graph, "loop");
  graph.instances.conditionStep.script += " ";
  const after = workspaceNodeInputFingerprint(graph, "loop");
  assert.notEqual(after, before, "Condition 子流程变更必须使 waiting checkpoint 失效");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-control-while-subflow-lint-"));
  try {
    fs.writeFileSync(path.join(root, "workspace.flow.js"), source, "utf-8");
    assert.deepEqual(lintFlowDir(root).errors, []);
    const invalid = source.replace(
      "{ state: bodyState, iteration: bodyIteration, idempotencyKey: bodyIdempotencyKey },",
      "{ state: bodyState, iteration: bodyIteration },",
    );
    fs.writeFileSync(path.join(root, "workspace.flow.js"), invalid, "utf-8");
    assert.ok(lintFlowDir(root).errors.some((error) => error.includes("Body 子流程 bodyFlow 缺少输入 idempotencyKey")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("control.while executes Condition then Body subflows and resumes after wait", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-control-while-subflows-"));
  try {
    fs.writeFileSync(path.join(root, "workspace.flow.js"), subflowWhileSource(), "utf-8");
    fs.writeFileSync(path.join(root, "condition.mjs"), `
import fs from "node:fs";
import path from "node:path";
const inputs = JSON.parse(process.env.AGENTFLOW_INPUTS_JSON || "{}");
const state = JSON.parse(inputs.state || "null");
const approved = fs.existsSync(path.join(process.env.AGENTFLOW_WORKSPACE_ROOT, "approved"));
process.stdout.write(state.n === 0 ? "continue" : approved ? "done" : "wait");
`, "utf-8");
    fs.writeFileSync(path.join(root, "body.mjs"), `
const inputs = JSON.parse(process.env.AGENTFLOW_INPUTS_JSON || "{}");
const state = JSON.parse(inputs.state || "null");
process.stdout.write(JSON.stringify({
  n: state.n + 1,
  bodyIteration: Number(inputs.iteration),
  idempotencyKey: inputs.idempotencyKey,
}));
`, "utf-8");

    const graph = flowFilesToGraph({
      source: fs.readFileSync(path.join(root, "workspace.flow.js"), "utf-8"),
      layout: {},
      nodeMeta: {},
      files: {},
    });
    const events = [];
    const waiting = await runWorkspaceGraph(root, root, {
      graph,
      runNodeId: "run",
      runId: "while-subflow-wait",
      ignoreCache: true,
    }, { userId: "while-subflow-test" }, { onEvent: (event) => events.push(event) });
    const waitingOutput = outputValues(waiting.graph.instances.loop);
    assert.equal(waitingOutput.decision, "wait");
    assert.equal(waitingOutput.iterations, "2");
    assert.equal(JSON.parse(waitingOutput.state).n, 1);
    assert.deepEqual(waiting.pauseNodeIds, ["loop"]);
    assert.equal(fs.existsSync(path.join(root, "downstream.txt")), false);
    assert.equal(events.filter((event) => event.type === "subflow-start" && event.whileRole === "condition").length, 2);
    assert.equal(events.filter((event) => event.type === "subflow-start" && event.whileRole === "body").length, 1);
    const waitingHistory = JSON.parse(waitingOutput.history);
    assert.equal(waitingHistory[0].decision, "continue");
    assert.equal(waitingHistory[1].decision, "wait");
    assert.equal(
      JSON.parse(waitingOutput.state).idempotencyKey,
      controlWhileIdempotencyKey({
        checkpointFingerprint: waitingOutput.checkpointFingerprint,
        nodeId: "loop",
        iteration: 1,
      }),
    );

    fs.writeFileSync(path.join(root, "approved"), "ok\n", "utf-8");
    const resumedEvents = [];
    const resumed = await runWorkspaceGraph(root, root, {
      graph: waiting.graph,
      runNodeId: "run",
      runId: "while-subflow-resume",
    }, { userId: "while-subflow-test" }, { onEvent: (event) => resumedEvents.push(event) });
    const resumedOutput = outputValues(resumed.graph.instances.loop);
    assert.equal(resumedOutput.decision, "done");
    assert.equal(resumedOutput.iterations, "3");
    assert.equal(JSON.parse(resumedOutput.state).n, 1, "done 不应再执行 Body");
    assert.equal(JSON.parse(resumedOutput.history).length, 3);
    assert.equal(resumedEvents.filter((event) => event.type === "subflow-start" && event.whileRole === "condition").length, 1);
    assert.equal(resumedEvents.filter((event) => event.type === "subflow-start" && event.whileRole === "body").length, 0);
    assert.equal(fs.readFileSync(path.join(root, "downstream.txt"), "utf-8").trim(), "reached");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("wait pauses before downstream and keeps per-iteration history", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-control-while-wait-"));
  try {
    fs.writeFileSync(path.join(root, "step.mjs"), `
const iteration = Number(process.env.AGENTFLOW_WHILE_ITERATION);
console.log(JSON.stringify({
  decision: iteration < 2 ? "continue" : "wait",
  state: { last: iteration },
  summary: \`round \${iteration}\`,
}));
`, "utf-8");
    const result = await runWorkspaceGraph(root, root, {
      graph: whileGraph(),
      runNodeId: "run",
      runId: "while-wait-test",
    }, { userId: "while-test" }, { runId: "while-wait-test" });

    const output = outputValues(result.graph.instances.loop);
    assert.equal(output.decision, "wait");
    assert.equal(output.iterations, "2");
    assert.equal(output.state, '{"last":2}');
    const firstHistory = JSON.parse(output.history);
    assert.equal(firstHistory.length, 2);
    assert.equal(
      output.checkpointFingerprint,
      controlWhileCheckpointFingerprint({
        inputFingerprint: workspaceNodeInputFingerprint(result.graph, "loop"),
        initialState: { last: 0 },
      }),
      "waiting checkpoint must bind both graph inputs and the resolved initial state",
    );
    assert.equal(firstHistory[0].idempotencyKey, controlWhileIdempotencyKey({
      checkpointFingerprint: output.checkpointFingerprint,
      nodeId: "loop",
      iteration: 1,
    }));
    assert.deepEqual(result.pauseNodeIds, ["loop"]);
    assert.equal(fs.existsSync(path.join(root, "downstream.txt")), false, "wait must stop before downstream");
    assert.equal(result.events.filter((event) => event.type === "while-iteration-done").length, 2);

    fs.writeFileSync(path.join(root, "step.mjs"), `
const previous = JSON.parse(process.env.AGENTFLOW_WHILE_STATE);
const next = previous.last + 1;
console.log(JSON.stringify({
  decision: "done",
  state: { last: next, iteration: Number(process.env.AGENTFLOW_WHILE_ITERATION), key: process.env.AGENTFLOW_WHILE_IDEMPOTENCY_KEY },
  summary: \`round \${next}\`,
}));
`, "utf-8");
    const resumed = await runWorkspaceGraph(root, root, {
      graph: result.graph,
      runNodeId: "run",
      runId: "while-resume-test",
    }, { userId: "while-test" }, { runId: "while-resume-test" });
    const resumedOutput = outputValues(resumed.graph.instances.loop);
    assert.equal(resumedOutput.decision, "done");
    const resumedState = JSON.parse(resumedOutput.state);
    assert.equal(resumedState.last, 3, "resume must start from the waiting checkpoint, not the original input");
    assert.equal(resumedState.iteration, 3, "resume must continue with the absolute iteration number");
    assert.equal(resumedOutput.iterations, "3");
    const resumedHistory = JSON.parse(resumedOutput.history);
    assert.deepEqual(resumedHistory.slice(0, 2), firstHistory, "resume must preserve earlier iteration history");
    assert.equal(resumedHistory[2].idempotencyKey, resumedState.key);
    assert.equal(fs.readFileSync(path.join(root, "downstream.txt"), "utf-8").trim(), "reached");

    const changedInputGraph = structuredClone(result.graph);
    changedInputGraph.instances.loop.input.find((slot) => slot.name === "state").value = '{"last":10}';
    const reset = await runWorkspaceGraph(root, root, {
      graph: changedInputGraph,
      runNodeId: "run",
      runId: "while-reset-test",
    }, { userId: "while-test" }, { runId: "while-reset-test" });
    assert.equal(
      JSON.parse(outputValues(reset.graph.instances.loop).state).last,
      11,
      "changed inputs must reset a stale waiting checkpoint",
    );
    assert.equal(outputValues(reset.graph.instances.loop).iterations, "1");

    const corruptCheckpointGraph = structuredClone(result.graph);
    corruptCheckpointGraph.instances.loop.output.find((slot) => slot.name === "history").value = "[]";
    await assert.rejects(
      runWorkspaceGraph(root, root, {
        graph: corruptCheckpointGraph,
        runNodeId: "run",
        runId: "while-corrupt-test",
      }, { userId: "while-test" }, { runId: "while-corrupt-test" }),
      /checkpoint is corrupt/,
      "a matching but corrupt checkpoint must fail closed instead of repeating side effects",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("done continues to downstream", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-control-while-done-"));
  try {
    fs.writeFileSync(path.join(root, "step.mjs"), `
const iteration = Number(process.env.AGENTFLOW_WHILE_ITERATION);
console.log(JSON.stringify({
  decision: iteration < 3 ? "continue" : "done",
  state: { last: iteration },
  summary: \`round \${iteration}\`,
}));
`, "utf-8");
    const result = await runWorkspaceGraph(root, root, {
      graph: whileGraph(),
      runNodeId: "run",
      runId: "while-done-test",
    }, { userId: "while-test" }, { runId: "while-done-test" });

    const output = outputValues(result.graph.instances.loop);
    assert.equal(output.decision, "done");
    assert.equal(output.iterations, "3");
    assert.deepEqual(result.pauseNodeIds, []);
    assert.equal(fs.readFileSync(path.join(root, "downstream.txt"), "utf-8").trim(), "reached");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("timeout terminates a running step instead of waiting for the command", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-control-while-timeout-"));
  try {
    fs.writeFileSync(path.join(root, "step.mjs"), `
setTimeout(() => console.log(JSON.stringify({ decision: "done", state: {} })), 5000);
`, "utf-8");
    const graph = whileGraph();
    graph.instances.loop.input.find((slot) => slot.name === "timeout").value = "100ms";
    const startedAt = Date.now();
    await assert.rejects(
      runWorkspaceGraph(root, root, {
        graph,
        runNodeId: "run",
        runId: "while-timeout-test",
      }, { userId: "while-test" }, { runId: "while-timeout-test" }),
      /Reached timeout after 100ms/,
    );
    assert.ok(Date.now() - startedAt < 2000, "timed-out step process must be terminated promptly");
    assert.equal(fs.existsSync(path.join(root, "downstream.txt")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
