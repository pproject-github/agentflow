import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyWorkspaceAutoLayout,
  layoutWorkspaceNodePositions,
} from "../bin/lib/workspace-auto-layout.mjs";
import { layoutWorkspaceFlowDir } from "../bin/lib/flow-dsl/cli.mjs";

function slot(type, name) {
  return { type, name };
}

function graphFixture(nodePositions = {}) {
  return {
    version: 1,
    instances: {
      run: {
        definitionId: "workspace_run",
        input: [slot("node", "prev")],
        output: [slot("node", "next")],
      },
      input: {
        definitionId: "provide_str",
        input: [slot("node", "prev")],
        output: [slot("node", "next"), slot("text", "value")],
      },
      work: {
        definitionId: "agent_subAgent",
        input: [slot("node", "prev"), slot("text", "source")],
        output: [slot("node", "next"), slot("text", "result")],
      },
      notify: {
        definitionId: "tool_wecomSendGroupMarkdown",
        input: [slot("node", "prev"), slot("text", "markdown"), slot("text", "webhookUrl")],
        output: [slot("node", "next")],
      },
      display: {
        definitionId: "display_markdown",
        input: [slot("node", "prev"), slot("text", "content")],
        output: [slot("node", "next")],
      },
    },
    edges: [
      { source: "run", target: "work", sourceHandle: "output-0", targetHandle: "input-0" },
      { source: "input", target: "work", sourceHandle: "output-1", targetHandle: "input-1" },
      { source: "work", target: "notify", sourceHandle: "output-0", targetHandle: "input-0" },
      { source: "work", target: "notify", sourceHandle: "output-1", targetHandle: "input-1" },
      { source: "work", target: "display", sourceHandle: "output-1", targetHandle: "input-1" },
    ],
    ui: { nodePositions },
  };
}

test("自动排版按依赖从左到右，并把数据源和展示节点错开", () => {
  const graph = graphFixture();
  const positions = layoutWorkspaceNodePositions(graph, { preserveExisting: false });

  assert.ok(positions.run.x < positions.work.x);
  assert.ok(positions.input.x < positions.work.x);
  assert.ok(positions.work.x < positions.notify.x);
  assert.ok(positions.work.x < positions.display.x);
  assert.notDeepEqual(positions.run, positions.input);
  assert.notEqual(positions.notify.y, positions.display.y);
  assert.equal(new Set(Object.values(positions).map((p) => `${p.x}:${p.y}`)).size, 5);
});

test("同层分支纵向分开，重排结果幂等", () => {
  const graph = graphFixture();
  graph.instances.branch = {
    definitionId: "display_markdown",
    input: [slot("node", "prev"), slot("text", "content")],
    output: [slot("node", "next")],
  };
  graph.edges.push({ source: "work", target: "branch", sourceHandle: "output-0", targetHandle: "input-0" });

  const once = applyWorkspaceAutoLayout(graph, { preserveExisting: false });
  const twice = applyWorkspaceAutoLayout(once, { preserveExisting: false });
  assert.equal(once.ui.nodePositions.notify.x, once.ui.nodePositions.branch.x);
  assert.notEqual(once.ui.nodePositions.notify.y, once.ui.nodePositions.branch.y);
  assert.deepEqual(twice.ui.nodePositions, once.ui.nodePositions);
});

test("默认只补缺失坐标并避开已有节点", () => {
  const graph = graphFixture({ run: { x: 536, y: 360 } });
  const positions = layoutWorkspaceNodePositions(graph);

  assert.deepEqual(positions.run, { x: 536, y: 360 });
  assert.notDeepEqual(positions.work, positions.run);
  assert.equal(Object.keys(positions).length, 5);
});

test("flow dsl layout 落盘；第二次补排不产生变化", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-layout-"));
  try {
    fs.writeFileSync(path.join(dir, "workspace.flow.js"), `import { agent, display, flow, provide } from "agentflow/flow";
export const topic = provide.str("主题", { value: "AgentFlow" });
const write = agent.subAgent("撰写", { topic: topic.value }, \`写一段介绍\`);
export const run = flow("Run", write);
export const result = display.markdown("结果", { content: write.result });
`, "utf8");

    const first = layoutWorkspaceFlowDir(dir, { all: true, workspaceRoot: process.cwd() });
    assert.equal(first.nodeCount, 4);
    assert.equal(first.positioned, 4);
    const layout = JSON.parse(fs.readFileSync(path.join(dir, "workspace.layout.json"), "utf8"));
    assert.equal(Object.keys(layout.nodes).length, 4);

    const second = layoutWorkspaceFlowDir(dir, { workspaceRoot: process.cwd() });
    assert.equal(second.positioned, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

