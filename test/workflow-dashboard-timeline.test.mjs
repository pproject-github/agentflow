import assert from "node:assert/strict";
import test from "node:test";

import { prdWorkflowDashboardTimeline } from "../bin/lib/ui-server.mjs";

test("Workflow Dashboard merges platform variants of the same scheduled iteration", () => {
  const shared = {
    kind: "iteration",
    title: "Likee Android&IOS V5.63 (8月)",
    date: "2026-08-11",
    source: "prd-flow",
  };
  const result = prdWorkflowDashboardTimeline([
    {
      id: "workflow-a",
      state: "active",
      timeline: [
        { ...shared, key: "prd-flow:iteration:android:563", id: "android:563", dimensions: { platform: "android", workspace: "33202860" } },
        { ...shared, key: "prd-flow:iteration:ios:563", id: "ios:563", dimensions: { platform: "ios", workspace: "33202860" } },
      ],
    },
    {
      id: "workflow-b",
      state: "completed",
      timeline: [
        { ...shared, key: "prd-flow:iteration:ios:563", id: "ios:563", dimensions: { platform: "ios", workspace: "33202860" } },
      ],
    },
  ]);

  assert.equal(result.timeline.length, 1);
  assert.equal(result.timeline[0].id, "563");
  assert.deepEqual(result.timeline[0].dimensions.platform, ["android", "ios"]);
  assert.equal(result.timeline[0].dimensions.workspace, "33202860");
  assert.equal(result.timeline[0].workflowCount, 2, "one Workflow assigned to both platforms is counted once");
  assert.equal(result.timeline[0].completedCount, 1);
  assert.deepEqual(result.timeline[0].workflowIds, ["workflow-a", "workflow-b"]);
  assert.deepEqual(result.timeline[0].memberKeys, ["prd-flow:iteration:android:563", "prd-flow:iteration:ios:563"]);
});

test("Workflow Dashboard keeps identically named iterations from different workspaces separate", () => {
  const shared = {
    kind: "iteration",
    title: "Likee Android&IOS V5.63 (8月)",
    date: "2026-08-11",
    source: "prd-flow",
  };
  const result = prdWorkflowDashboardTimeline([
    { id: "workflow-a", state: "active", timeline: [{ ...shared, key: "a", id: "a", dimensions: { platform: "android", workspace: "33202860" } }] },
    { id: "workflow-b", state: "active", timeline: [{ ...shared, key: "b", id: "b", dimensions: { platform: "ios", workspace: "778899" } }] },
  ]);

  assert.equal(result.timeline.length, 2);
});

test("Workflow Dashboard does not merge different iteration IDs that share a title and date", () => {
  const shared = {
    kind: "version",
    title: "同名迭代",
    date: "2026-08-11",
    source: "prd-flow",
    dimensions: { platform: ["android", "ios"], workspace: "33202860" },
  };
  const result = prdWorkflowDashboardTimeline([
    { id: "workflow-a", state: "active", timeline: [{ ...shared, key: "version:1001", id: "1001" }] },
    { id: "workflow-b", state: "active", timeline: [{ ...shared, key: "version:1002", id: "1002" }] },
  ]);

  assert.equal(result.timeline.length, 2);
});
