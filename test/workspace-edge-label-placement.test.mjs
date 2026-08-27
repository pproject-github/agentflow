import assert from "node:assert/strict";
import test from "node:test";

import { placeWorkspaceRelationLabel } from "../builtin/web-ui/src/workspaceEdgeLabelPlacement.js";

function overlaps(point, rect, width = 176, height = 30) {
  return point.x + width / 2 > rect.x
    && point.x - width / 2 < rect.x + rect.width
    && point.y + height / 2 > rect.y
    && point.y - height / 2 < rect.y + rect.height;
}

test("virtual relation label keeps the normal midpoint when no node blocks it", () => {
  const result = placeWorkspaceRelationLabel({
    edgePath: "M0,0 C100,0 200,0 300,0",
    fallbackX: 150,
    fallbackY: 0,
  });
  assert.deepEqual(result, { x: 150, y: 0 });
});

test("virtual relation label moves away when the bezier midpoint crosses a node", () => {
  const node = { x: 90, y: -55, width: 120, height: 110 };
  const result = placeWorkspaceRelationLabel({
    edgePath: "M0,0 C100,0 200,0 300,0",
    fallbackX: 150,
    fallbackY: 0,
    nodeRects: [node],
  });
  assert.equal(overlaps(result, node), false);
  assert.notDeepEqual(result, { x: 150, y: 0 });
});

test("virtual relation label accounts for node safety padding", () => {
  const node = { x: 106, y: 20, width: 88, height: 30 };
  const result = placeWorkspaceRelationLabel({
    edgePath: "M0,0 C100,0 200,0 300,0",
    fallbackX: 150,
    fallbackY: 0,
    nodeRects: [node],
    nodePadding: 16,
  });
  const paddedNode = { x: 90, y: 4, width: 120, height: 62 };
  assert.equal(overlaps(result, paddedNode), false);
});
