import assert from "node:assert/strict";
import test from "node:test";

import { flowFilesToGraph, graphToFlowFiles } from "../bin/lib/flow-dsl/index.mjs";

// 用户需求点: 线上错误日志里 67 次「生成的代码解析不回来：Identifier 'workspace_scheduled_run_1'
// has already been declared」。边的归类只看目标槽名（不叫 prev 就算数据边），run 的 next 连到
// content 这类槽时，run 会以"上游数据依赖"的身份被当普通节点再声明一次，与 run 入口那行同名。
// 代码解析不回来 → 整张图退回 workspace.graph.json。
function scheduledRunFeedingNonPrevSlot() {
  return {
    version: 1,
    instances: {
      workspace_scheduled_run_1: {
        instanceId: "workspace_scheduled_run_1",
        definitionId: "workspace_scheduled_run",
        label: "Daily",
        body: JSON.stringify({ enabled: true, cron: "0 8 * * *" }),
        input: [],
        output: [{ name: "next", type: "node" }],
      },
      show: {
        instanceId: "show",
        definitionId: "display_markdown",
        label: "展示",
        input: [{ name: "content", type: "text" }],
        output: [{ name: "next", type: "node" }],
      },
    },
    edges: [{
      source: "workspace_scheduled_run_1",
      sourceHandle: "output-0",
      target: "show",
      targetHandle: "input-0",
    }],
    ui: { nodePositions: {} },
  };
}

test("a Run entry is declared once even when it feeds a non-control slot", () => {
  const generated = graphToFlowFiles(scheduledRunFeedingNonPrevSlot());
  const declarations = generated.source
    .split("\n")
    .filter((line) => /^(?:export )?const workspace_scheduled_run_1\b/.test(line));
  assert.equal(declarations.length, 1, `重复声明:\n${generated.source}`);
  assert.match(declarations[0], /flow\.schedule\(/);
});

test("the generated code parses back into the same graph", () => {
  const graph = scheduledRunFeedingNonPrevSlot();
  const generated = graphToFlowFiles(graph);
  const parsed = flowFilesToGraph({
    source: generated.source,
    layout: generated.layout,
    nodeMeta: generated.nodeMeta,
    files: Object.fromEntries(generated.files.map((f) => [f.path, f.text])),
  });
  assert.deepEqual(Object.keys(parsed.instances).sort(), ["show", "workspace_scheduled_run_1"]);
  assert.equal(parsed.instances.workspace_scheduled_run_1.definitionId, "workspace_scheduled_run");
  assert.equal(parsed.edges.length, 1);
});

test("an ordinary control chain from a Run still round-trips", () => {
  const graph = scheduledRunFeedingNonPrevSlot();
  graph.instances.show.input = [{ name: "prev", type: "node" }];
  const generated = graphToFlowFiles(graph);
  const declarations = generated.source
    .split("\n")
    .filter((line) => /^(?:export )?const workspace_scheduled_run_1\b/.test(line));
  assert.equal(declarations.length, 1);
  const parsed = flowFilesToGraph({
    source: generated.source,
    layout: generated.layout,
    nodeMeta: generated.nodeMeta,
    files: Object.fromEntries(generated.files.map((f) => [f.path, f.text])),
  });
  assert.deepEqual(Object.keys(parsed.instances).sort(), ["show", "workspace_scheduled_run_1"]);
});
