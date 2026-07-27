import assert from "node:assert/strict";
import test from "node:test";

import {
  mergeWorkspaceGraphs,
  workspaceDesignRevision,
} from "../bin/lib/workspace-graph-merge.mjs";

function graph(instances = {}, edges = [], ui = { nodePositions: {} }) {
  return { version: 1, instances, edges, ui };
}

test("design revision ignores runtime outputs and personal viewport", () => {
  const base = graph({
    agent: {
      definitionId: "agent_prompt",
      output: [{ name: "result", type: "text", value: "old" }],
    },
  });
  const runtimeChanged = structuredClone(base);
  runtimeChanged.instances.agent.output[0].value = "new";
  runtimeChanged.ui.viewport = { x: 10, y: 20, zoom: 1.2 };

  assert.equal(workspaceDesignRevision(runtimeChanged), workspaceDesignRevision(base));
});

test("design revision includes provide node values", () => {
  const base = graph({
    input: {
      definitionId: "provide_text",
      output: [{ name: "value", type: "text", value: "one" }],
    },
  });
  const changed = structuredClone(base);
  changed.instances.input.output[0].value = "two";

  assert.notEqual(workspaceDesignRevision(changed), workspaceDesignRevision(base));
});

test("three-way merge combines different nodes and different fields", () => {
  const base = graph({
    a: { definitionId: "agent_prompt", label: "A", model: "one" },
    b: { definitionId: "agent_prompt", label: "B", model: "one" },
  });
  const current = structuredClone(base);
  current.instances.a.label = "A remote";
  const incoming = structuredClone(base);
  incoming.instances.b.model = "two";

  const result = mergeWorkspaceGraphs({ baseGraph: base, currentGraph: current, incomingGraph: incoming });
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.graph.instances.a.label, "A remote");
  assert.equal(result.graph.instances.b.model, "two");

  const sameNodeCurrent = structuredClone(base);
  sameNodeCurrent.instances.a.label = "A remote";
  const sameNodeIncoming = structuredClone(base);
  sameNodeIncoming.instances.a.model = "two";
  const sameNodeResult = mergeWorkspaceGraphs({
    baseGraph: base,
    currentGraph: sameNodeCurrent,
    incomingGraph: sameNodeIncoming,
  });
  assert.deepEqual(sameNodeResult.conflicts, []);
  assert.equal(sameNodeResult.graph.instances.a.label, "A remote");
  assert.equal(sameNodeResult.graph.instances.a.model, "two");
});

test("three-way merge reports exact same-field conflict", () => {
  const base = graph({ a: { definitionId: "agent_prompt", label: "A" } });
  const current = structuredClone(base);
  current.instances.a.label = "remote";
  const incoming = structuredClone(base);
  incoming.instances.a.label = "local";

  const result = mergeWorkspaceGraphs({ baseGraph: base, currentGraph: current, incomingGraph: incoming });
  assert.deepEqual(result.conflicts.map((item) => item.path), ["$.instances.a.label"]);
  assert.deepEqual(result.conflicts[0].pathParts, ["instances", "a", "label"]);
  assert.equal(result.conflicts[0].current, "remote");
  assert.equal(result.conflicts[0].incoming, "local");
  assert.equal(result.graph.instances.a.label, "remote");
});

test("three-way merge combines independent edge additions", () => {
  const base = graph({
    a: { definitionId: "control_start" },
    b: { definitionId: "agent_prompt" },
    c: { definitionId: "agent_prompt" },
  });
  const current = structuredClone(base);
  current.edges.push({ source: "a", target: "b", sourceHandle: "out", targetHandle: "in" });
  const incoming = structuredClone(base);
  incoming.edges.push({ source: "a", target: "c", sourceHandle: "out", targetHandle: "in" });

  const result = mergeWorkspaceGraphs({ baseGraph: base, currentGraph: current, incomingGraph: incoming });
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.graph.edges.length, 2);
});

test("runtime output changes survive a concurrent design save", () => {
  const base = graph({
    a: {
      definitionId: "agent_prompt",
      label: "A",
      output: [{ name: "result", type: "text", value: "old" }],
    },
  });
  const current = structuredClone(base);
  current.instances.a.output[0].value = "run result";
  const incoming = structuredClone(base);
  incoming.instances.a.label = "A edited";

  const result = mergeWorkspaceGraphs({ baseGraph: base, currentGraph: current, incomingGraph: incoming });
  assert.deepEqual(result.conflicts, []);
  assert.equal(result.graph.instances.a.label, "A edited");
  assert.equal(result.graph.instances.a.output[0].value, "run result");
});
