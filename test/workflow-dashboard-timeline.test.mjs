import assert from "node:assert/strict";
import test from "node:test";

import {
  prdWorkflowDashboardPage,
  prdWorkflowDashboardTimeline,
  prdWorkflowDefaultTimelineKey,
} from "../bin/lib/ui-server.mjs";

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
  assert.equal(result.timeline[0].projectionId, "563");
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

test("Workflow Dashboard preserves the original projection ID for admin reassignment", () => {
  const result = prdWorkflowDashboardTimeline([{
    id: "workflow-a",
    state: "active",
    timeline: [{
      key: "release-bot:version:Release-Candidate-A",
      kind: "version",
      id: "Release-Candidate-A",
      title: "Release Candidate A",
      date: "2026-08-11",
      source: "release-bot",
    }],
  }]);

  assert.equal(result.timeline[0].id, "release-candidate-a");
  assert.equal(result.timeline[0].projectionId, "Release-Candidate-A");
});

test("Workflow Dashboard defaults to the iteration covering today or the nearest upcoming date", () => {
  const timeline = [
    { key: "past", startDate: "2026-07-01", endDate: "2026-07-24", date: "2026-07-24" },
    { key: "current", startDate: "2026-07-25", endDate: "2026-08-11", date: "2026-08-11" },
    { key: "future", startDate: "2026-08-12", endDate: "2026-08-30", date: "2026-08-30" },
  ];
  assert.equal(
    prdWorkflowDefaultTimelineKey(timeline, Date.parse("2026-08-05T12:00:00Z")),
    "current",
  );
  assert.equal(
    prdWorkflowDefaultTimelineKey(timeline.map(({ startDate, endDate, ...entry }) => entry), Date.parse("2026-08-05T12:00:00Z")),
    "current",
  );
});

test("Workflow Dashboard filters before applying server-side pagination while preserving full timeline totals", () => {
  const workflows = Array.from({ length: 25 }, (_, index) => ({
    id: `workflow-${index + 1}`,
    tapdId: String(1000000 + index),
    title: `需求 ${index + 1}`,
    role: index % 2 === 0 ? "owner" : "viewer",
    state: index === 0 ? "blocked" : "active",
    timeline: [{ key: "version-current", kind: "version", id: "current", date: "2026-08-11" }],
  }));
  const dashboardTimeline = prdWorkflowDashboardTimeline(workflows);
  const result = prdWorkflowDashboardPage(workflows, dashboardTimeline, {
    now: Date.parse("2026-08-05T12:00:00Z"),
    timelineKey: "version-current",
    page: 2,
    pageSize: 20,
  });

  assert.equal(dashboardTimeline.timeline[0].workflowCount, 25);
  assert.equal(result.selectedTimelineKey, "version-current");
  assert.equal(result.pagination.total, 25);
  assert.equal(result.pagination.totalPages, 2);
  assert.equal(result.workflows.length, 5);

  const filtered = prdWorkflowDashboardPage(workflows, dashboardTimeline, {
    now: Date.parse("2026-08-05T12:00:00Z"),
    scope: "owned",
    state: "blocked",
    page: 1,
    pageSize: 20,
  });
  assert.equal(filtered.pagination.total, 1);
  assert.equal(filtered.workflows[0].id, "workflow-1");
  assert.equal(dashboardTimeline.timeline[0].workflowCount, 25);
});
