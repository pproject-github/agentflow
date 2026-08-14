import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { flowFilesToGraph, graphToFlowFiles, parseFlowSource } from "../bin/lib/flow-dsl/index.mjs";
import { lintFlowDir } from "../bin/lib/flow-dsl/lint.mjs";
import { runWorkspaceGraph, workspaceRunPlan } from "../bin/lib/workspace-server.mjs";

const source = `import { agent, context, control, flow, provide } from "agentflow/flow";

const knowledge = context.knowledge("产品知识", {
  workspaceIds: ["current"],
});

const skills = context.skills("研发技能", {
  skills: ["agentflow-flow-dsl"],
});

const workspace = context.workspace("执行仓", {
  workspaceId: "current",
  access: "read-write",
});

const prdContext = context.bundle("PRD 上下文", {
  knowledge,
  skills,
  workspace,
});

const childContext = flow.input("context", "context");
const analyse = agent.subAgent("分析需求", { context: childContext.value }, "分析输入需求");
export const analyseFlow = flow.subflow(
  "分析子流程",
  { context: childContext },
  flow(analyse),
  { result: analyse.result },
);

const call = flow.call("调用分析", analyseFlow, { context: prdContext });
export const run = flow("Run", call);
`;

function edgeNames(graph) {
  const index = (handle) => Number(/-(\d+)$/.exec(String(handle || ""))?.[1] || 0);
  return new Set((graph.edges || []).map((edge) => {
    const from = graph.instances[edge.source]?.output?.[index(edge.sourceHandle)]?.name;
    const to = graph.instances[edge.target]?.input?.[index(edge.targetHandle)]?.name;
    return `${edge.source}.${from}->${edge.target}.${to}`;
  }));
}

test("context resources compile to typed data edges and round-trip as first-class DSL", () => {
  const ir = parseFlowSource(source);
  assert.deepEqual(ir.unresolved, []);
  assert.equal(ir.nodes.knowledge.definitionId, "context_knowledge");
  assert.equal(ir.nodes.skills.definitionId, "context_skills");
  assert.equal(ir.nodes.workspace.definitionId, "context_workspace");
  assert.equal(ir.nodes.prdContext.definitionId, "context_bundle");
  assert.ok(ir.edges.includes("prdContext|context|call|context"));
  assert.equal(ir.subflows.analyseFlow.inputs.context.type, "context");

  const graph = flowFilesToGraph({ source, layout: {}, nodeMeta: {}, files: {} });
  assert.equal(graph.instances.prdContext.output.find((slot) => slot.name === "context")?.type, "context");
  assert.equal(graph.instances.call.input.find((slot) => slot.name === "context")?.type, "context");
  const generated = graphToFlowFiles(graph).source;
  assert.match(generated, /context\.knowledge\("产品知识"/);
  assert.match(generated, /context\.bundle\("PRD 上下文", \{[\s\S]*knowledge: knowledge,[\s\S]*skills: skills,[\s\S]*workspace: workspace/);
  assert.match(generated, /flow\.call\("调用分析", analyseFlow, \{[\s\S]*context: prdContext/);

  const again = flowFilesToGraph({ source: generated, layout: {}, nodeMeta: {}, files: {} });
  assert.deepEqual([...edgeNames(again)].sort(), [...edgeNames(graph)].sort());
  assert.equal(graphToFlowFiles(again).source, generated);
});

test("context DSL lints cleanly and resources stay outside the control chain", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-context-lint-"));
  try {
    fs.writeFileSync(path.join(root, "workspace.flow.js"), source, "utf-8");
    const result = lintFlowDir(root);
    assert.deepEqual(result.errors, []);
    assert.ok(!result.ir.edges.some((edge) => /^(knowledge|skills|workspace|prdContext)\|next\|/.test(edge)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("context DSL only accepts authenticated Workspace catalog IDs", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-context-secret-"));
  try {
    fs.writeFileSync(path.join(root, "workspace.flow.js"), `import { agent, context, flow } from "agentflow/flow";
const knowledge = context.knowledge("Unsafe knowledge", {
  workspaceIds: [{ id: "current", token: "must-not-be-here" }],
});
const runtimeContext = context.bundle("Runtime context", { knowledge });
const analyse = agent.subAgent("Analyse", { context: runtimeContext }, "Analyse safely");
export const run = flow("Run", analyse);
`, "utf-8");
    const result = lintFlowDir(root);
    assert.ok(result.errors.some((error) => /workspaceIds 只能包含非空字符串 ID/i.test(error)));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("While captures a typed Context once and keeps it out of loop state", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-context-runtime-"));
  const previousAgentflowHome = process.env.AGENTFLOW_HOME;
  try {
    const agentflowHome = path.join(root, "agentflow-home");
    const knowledgeRoot = path.join(root, "product-knowledge");
    fs.mkdirSync(agentflowHome, { recursive: true });
    fs.mkdirSync(knowledgeRoot, { recursive: true });
    fs.writeFileSync(path.join(agentflowHome, "workspaces.json"), JSON.stringify({
      version: 1,
      workspaces: [{ id: "product-docs", label: "Product docs", kind: "local", path: knowledgeRoot }],
    }), "utf-8");
    process.env.AGENTFLOW_HOME = agentflowHome;
    fs.writeFileSync(path.join(root, "step.mjs"), `
console.log(JSON.stringify({ decision: "done", summary: "context-ready" }));
`, "utf-8");
    const runtimeSource = `import { context, control, flow, provide } from "agentflow/flow";
const knowledge = context.knowledge("Flow knowledge", { workspaceIds: ["product-docs"] });
const workspace = context.workspace("Flow workspace", { workspaceId: "current", access: "read-write" });
const runtimeContext = context.bundle("Runtime context", { knowledge, workspace });
const initial = provide.json("Initial", { value: { cursor: 0 } });
const loop = control.while("One round", {
  context: runtimeContext,
  state: initial.value,
  maxIterations: 2,
  timeout: "10s",
}, \`node \${flowDir}/step.mjs\`);
export const run = flow("Run", loop);
`;
    const graph = flowFilesToGraph({ source: runtimeSource, layout: {}, nodeMeta: {}, files: {} });
    const order = workspaceRunPlan(graph, "run", root, { ignoreCache: true }).order;
    assert.ok(order.indexOf("workspace") < order.indexOf("runtimeContext"));
    assert.ok(order.indexOf("runtimeContext") < order.indexOf("loop"));

    const result = await runWorkspaceGraph(root, root, {
      graph,
      runNodeId: "run",
      runId: "context-runtime-test",
      ignoreCache: true,
    }, { userId: "context-runtime-test" });
    const bundleText = result.graph.instances.runtimeContext.output.find((slot) => slot.name === "context")?.value || "";
    const bundle = JSON.parse(bundleText);
    assert.equal(bundle.version, 1);
    assert.equal(JSON.parse(bundle.knowledgeContext).sources[0].path, knowledgeRoot);
    assert.equal(JSON.parse(bundle.workspaceContext).workspaceRoot, root);
    const state = JSON.parse(result.graph.instances.loop.output.find((slot) => slot.name === "state")?.value || "null");
    assert.deepEqual(state, { cursor: 0 }, "Context must not be copied into While state/checkpoint");
  } finally {
    if (previousAgentflowHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousAgentflowHome;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
