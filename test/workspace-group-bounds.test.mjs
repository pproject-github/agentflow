import assert from "node:assert/strict";
import test from "node:test";

import {
  expandWorkspaceGroupPositionChanges,
  expandWorkspaceGroupsToMembers,
} from "../builtin/web-ui/src/workspaceGroups.js";

function group(overrides = {}) {
  return {
    id: "group-quality",
    position: { x: 40, y: 40 },
    width: 500,
    height: 300,
    data: {
      isWorkspaceGroup: true,
      nodeIds: ["html", "table"],
      nodeSize: { width: 500, height: 300 },
    },
    ...overrides,
  };
}

test("group expands around members after display content is measured", () => {
  const original = group();
  const nodes = [
    original,
    {
      id: "html",
      position: { x: 100, y: 100 },
      measured: { width: 720, height: 650 },
      data: { definitionId: "display_html" },
    },
    {
      id: "table",
      position: { x: 900, y: 100 },
      measured: { width: 640, height: 580 },
      data: { definitionId: "display_table" },
    },
  ];
  const next = expandWorkspaceGroupsToMembers(nodes);
  assert.notEqual(next, nodes);
  assert.equal(next[0].position.x, 40);
  assert.equal(next[0].position.y, 40);
  assert.equal(next[0].width, 1552);
  assert.equal(next[0].height, 762);
  assert.deepEqual(next[0].data.nodeSize, { width: 1552, height: 762 });
});

test("group keeps deliberate extra space and returns stable references", () => {
  const original = group({
    position: { x: 0, y: 0 },
    width: 1800,
    height: 900,
    data: {
      isWorkspaceGroup: true,
      nodeIds: ["html"],
      nodeSize: { width: 1800, height: 900 },
    },
  });
  const nodes = [
    original,
    {
      id: "html",
      position: { x: 100, y: 100 },
      data: { definitionId: "display_html" },
    },
  ];
  assert.equal(expandWorkspaceGroupsToMembers(nodes), nodes);
});

test("group uses display defaults before the browser reports measurements", () => {
  const nodes = [
    group({
      position: { x: 40, y: 40 },
      width: 300,
      height: 180,
      data: {
        isWorkspaceGroup: true,
        nodeIds: ["html"],
        nodeSize: { width: 300, height: 180 },
      },
    }),
    {
      id: "html",
      position: { x: 100, y: 100 },
      data: { definitionId: "display_html" },
    },
  ];
  const next = expandWorkspaceGroupsToMembers(nodes);
  assert.equal(next[0].width, 832);
  assert.equal(next[0].height, 632);
});

test("group drag uses one stable origin so asynchronous frames cannot make members drift", () => {
  const nodes = [
    group({
      data: {
        isWorkspaceGroup: true,
        nodeIds: ["html", "table"],
        nodeSize: { width: 500, height: 300 },
      },
    }),
    { id: "html", position: { x: 100, y: 100 }, data: {} },
    { id: "table", position: { x: 300, y: 160 }, data: {} },
  ];
  const origins = new Map();

  const first = expandWorkspaceGroupPositionChanges([
    { type: "position", id: "group-quality", position: { x: 60, y: 50 }, dragging: true },
  ], nodes, origins);
  assert.deepEqual(first.slice(1).map(({ id, position }) => ({ id, position })), [
    { id: "html", position: { x: 120, y: 110 } },
    { id: "table", position: { x: 320, y: 170 } },
  ]);

  // Deliberately pass the stale pointer-down node list again. The next frame is
  // still calculated from the same origin instead of accumulating another delta.
  const final = expandWorkspaceGroupPositionChanges([
    { type: "position", id: "group-quality", position: { x: 90, y: 70 }, dragging: false },
  ], nodes, origins);
  assert.deepEqual(final.slice(1).map(({ id, position }) => ({ id, position })), [
    { id: "html", position: { x: 150, y: 130 } },
    { id: "table", position: { x: 350, y: 190 } },
  ]);
  assert.equal(origins.size, 0);
});
