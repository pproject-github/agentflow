import assert from "node:assert/strict";
import test from "node:test";

import {
  workspaceNodeSlotOutputKey,
  workspaceOutputSlotValueForEdge,
} from "../bin/lib/workspace-server.mjs";

// control_agent_toBool 的图形：prediction 是第一个非控制输出槽，于是被判成"主输出槽"。
function toBoolGraph() {
  return {
    instances: {
      toBool: {
        instanceId: "toBool",
        definitionId: "control_agent_toBool",
        output: [
          { name: "next", type: "node" },
          { name: "prediction", type: "bool", value: "false" },
        ],
      },
      gate: {
        instanceId: "gate",
        definitionId: "control_if",
        input: [
          { name: "prev", type: "node" },
          { name: "prediction", type: "bool" },
        ],
      },
    },
    edges: [{ source: "toBool", sourceHandle: "output-1", target: "gate", targetHandle: "input-1" }],
  };
}

// 用户需求点: Agent 信封里写了 outParams.prediction: true，下游 control_if 却恒定走 false ——
// prediction 恰好是第一个非控制输出槽，被当成主输出，于是那篇 result 正文顶掉了点名给的值。
test("an explicitly named output slot beats the generic result body", () => {
  const graph = toBoolGraph();
  const report = "# 邮件侵权巡检判定结果\n\n**prediction = True**\n\n范围内发现 1 封侵权邮件。";
  const outputs = new Map([
    ["toBool", report],
    [workspaceNodeSlotOutputKey("toBool", "prediction"), "true"],
  ]);
  assert.equal(workspaceOutputSlotValueForEdge(graph, outputs, graph.edges[0]), "true");
});

test("without a named value the primary slot still carries the result body", () => {
  const graph = toBoolGraph();
  const outputs = new Map([["toBool", "自由文本结果"]]);
  assert.equal(workspaceOutputSlotValueForEdge(graph, outputs, graph.edges[0]), "自由文本结果");
});

test("a stale slot default never shadows this run's result", () => {
  const graph = toBoolGraph();
  // 槽里 value: "false" 是上一次运行留下的；本次没有点名值，就不该拿它当结果。
  const outputs = new Map([["toBool", "本次的结果正文"]]);
  assert.equal(workspaceOutputSlotValueForEdge(graph, outputs, graph.edges[0]), "本次的结果正文");
});

test("a result-named slot keeps taking the result body", () => {
  const graph = {
    instances: {
      agent: {
        instanceId: "agent",
        definitionId: "agent_subAgent",
        output: [{ name: "next", type: "node" }, { name: "result", type: "text" }],
      },
      show: { instanceId: "show", definitionId: "display_markdown", input: [{ name: "content", type: "text" }] },
    },
    edges: [{ source: "agent", sourceHandle: "output-1", target: "show", targetHandle: "input-0" }],
  };
  const outputs = new Map([["agent", "# 报告正文"]]);
  assert.equal(workspaceOutputSlotValueForEdge(graph, outputs, graph.edges[0]), "# 报告正文");
});
