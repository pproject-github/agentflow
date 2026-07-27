import assert from "node:assert/strict";
import test from "node:test";

import {
  diffWorkspaceGraphsForUi,
  reconcileWorkspaceEdges,
  reconcileWorkspaceInstances,
  reconcileWorkspaceNodes,
} from "../builtin/web-ui/src/workspaceGraphDelta.js";

function graph({
  instances = {},
  edges = [],
  nodePositions = {},
  nodeSizes = {},
  groups = [],
  displayPage = null,
} = {}) {
  return {
    version: 1,
    instances,
    edges,
    ui: {
      nodePositions,
      nodeSizes,
      groups,
      ...(displayPage ? { displayPage } : {}),
    },
  };
}

test("workspace graph diff identifies only the moved node", () => {
  const base = graph({
    instances: {
      a: { definitionId: "display_table", label: "A" },
      b: { definitionId: "agent_prompt", label: "B" },
    },
    nodePositions: {
      a: { x: 10, y: 20 },
      b: { x: 30, y: 40 },
    },
  });
  const next = structuredClone(base);
  next.ui.nodePositions.a = { x: 100, y: 200 };

  const delta = diffWorkspaceGraphsForUi(base, next);
  assert.equal(delta.safe, true);
  assert.deepEqual(delta.changedNodeIds, ["a"]);
  assert.equal(delta.nodesChanged, true);
  assert.equal(delta.edgesChanged, false);
  assert.equal(delta.displayPageChanged, false);
});

test("workspace node reconciliation preserves unchanged references and selection", () => {
  const currentA = { id: "a", position: { x: 10, y: 20 }, selected: true };
  const currentB = { id: "b", position: { x: 30, y: 40 }, selected: false };
  const nextA = { id: "a", position: { x: 100, y: 200 }, selected: false };
  const nextB = { id: "b", position: { x: 30, y: 40 }, selected: false };

  const reconciled = reconcileWorkspaceNodes(
    [currentA, currentB],
    [nextA, nextB],
    ["a"],
  );

  assert.notEqual(reconciled[0], currentA);
  assert.equal(reconciled[0].selected, true);
  assert.equal(reconciled[1], currentB);
});

test("workspace instance reconciliation preserves unchanged instance references", () => {
  const currentA = { definitionId: "display_table", label: "Old" };
  const currentB = { definitionId: "agent_prompt", label: "Stable" };
  const nextA = { definitionId: "display_table", label: "New" };
  const nextB = { definitionId: "agent_prompt", label: "Stable" };

  const reconciled = reconcileWorkspaceInstances(
    { a: currentA, b: currentB },
    { a: nextA, b: nextB },
    ["a"],
  );

  assert.equal(reconciled.a, nextA);
  assert.equal(reconciled.b, currentB);
});

test("workspace edge diff and reconciliation only replace changed edges", () => {
  const base = graph({
    instances: {
      a: { definitionId: "control_start" },
      b: { definitionId: "agent_prompt" },
      c: { definitionId: "agent_prompt" },
    },
    edges: [{ source: "a", target: "b", sourceHandle: "out", targetHandle: "in" }],
  });
  const next = structuredClone(base);
  next.edges.push({ source: "a", target: "c", sourceHandle: "out", targetHandle: "in" });
  const delta = diffWorkspaceGraphsForUi(base, next);

  assert.equal(delta.nodesChanged, false);
  assert.equal(delta.edgesChanged, true);

  const currentEdge = {
    id: "a-b",
    source: "a",
    target: "b",
    sourceHandle: "out",
    targetHandle: "in",
    selected: true,
  };
  const reconciled = reconcileWorkspaceEdges(
    [currentEdge],
    [
      { ...currentEdge, selected: false },
      { id: "a-c", source: "a", target: "c", sourceHandle: "out", targetHandle: "in" },
    ],
  );
  assert.equal(reconciled[0], currentEdge);
  assert.equal(reconciled.length, 2);
});

test("workspace graph diff tracks display changes and rejects missing baselines", () => {
  const base = graph({
    displayPage: { nodeIds: [], nodePositions: {}, nodeSizes: {} },
  });
  const next = graph({
    displayPage: { nodeIds: ["table"], nodePositions: { table: { x: 1, y: 2 } }, nodeSizes: {} },
  });

  assert.equal(diffWorkspaceGraphsForUi(base, next).displayPageChanged, true);
  assert.equal(diffWorkspaceGraphsForUi(null, next).safe, false);

  const unknownUiChange = structuredClone(base);
  unknownUiChange.ui.futureLayout = { enabled: true };
  assert.equal(diffWorkspaceGraphsForUi(base, unknownUiChange).safe, false);
});
