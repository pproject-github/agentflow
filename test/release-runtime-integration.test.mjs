import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("release panel hydrates its catalog and state from Release Runtime APIs", () => {
  const source = fs.readFileSync(new URL("../builtin/web-ui/src/components/ReleaseWorkflowPanel.jsx", import.meta.url), "utf8");
  assert.match(source, /\/api\/release\/catalog/);
  assert.match(source, /\/api\/release\/state/);
  assert.match(source, /ReleaseNodeInspector/);
  assert.match(source, /confirmationFingerprint/);
  assert.match(source, /workspacePath/);
});

test("release context keeps batch in the immutable initialization snapshot", async () => {
  const { resolveReleaseContext, createInitializationNode } = await import("../builtin/web-ui/src/lib/releaseWorkflowModel.js");
  const context = resolveReleaseContext({}, "businessLine=likee&platform=android&version=5.63.2&batch=supplemental");
  const node = createInitializationNode(context, { path: "/workspace" });
  assert.equal(context.batch, "supplemental");
  assert.equal(node.inputs.batch, "supplemental");
});

test("runtime store initial state preserves workflow identity and scope", async () => {
  const { emptyReleaseState } = await import("../bin/lib/release-runtime-store.mjs");
  const context = { businessLine: "likee", platform: "android", version: "5.63.2", batch: "initial" };
  const state = emptyReleaseState(context, "/workspace/likee");
  assert.equal(state.timeline[0].workflowId, "likee-android-release");
  assert.equal(state.timeline[0].scopeKey, "likee/android/5.63.2/initial");
  assert.deepEqual(state.timeline[0].contextSnapshot, context);
});

test("workflow recommendations and custom candidates only expose configured actions", async () => {
  const { seedNextRecommendations } = await import("../builtin/web-ui/src/lib/releaseWorkflowModel.js");
  const { createReleaseProcessStateMachine, selectWorkflowProcessNodes } = await import("../builtin/web-ui/src/lib/releaseWorkflowStateMachine.js");
  const { RELEASE_WORKFLOW_CONFIG } = await import("../shared/release-workflow-config.js");
  const context = { businessLine: "likee", platform: "android", version: "5.63.0", batch: "initial" };
  const configuredId = "release-git:create-release-branch";
  const unconfiguredId = "release-management:append-release-batch";
  const nodes = [
    { id: configuredId, title: "Create Release Branch", skill: "release-git", businessLines: ["likee"], platforms: ["android"] },
    { id: unconfiguredId, title: "Append Release Batch", skill: "release-management", businessLines: ["likee"], platforms: ["android"] },
  ];
  const machine = createReleaseProcessStateMachine({ context, nodes });
  assert.equal(machine.workflowId, "likee-android-release");
  const candidates = selectWorkflowProcessNodes({ machine, nodes });
  assert.deepEqual(candidates.map((node) => node.id), [configuredId]);
  const seeded = seedNextRecommendations({ context, timeline: [{ nodeId: "release-initialization", status: "completed" }], pending: [] }, nodes);
  assert.deepEqual(seeded.pending.map((item) => item.nodeId), [configuredId]);

  const removedActionConfig = {
    ...RELEASE_WORKFLOW_CONFIG,
    workflows: RELEASE_WORKFLOW_CONFIG.workflows.map((workflow) => workflow.id === "likee-android-release"
      ? { ...workflow, stages: workflow.stages.map((stage) => ({ ...stage, nodes: stage.nodes.filter((node) => node.id !== configuredId) })) }
      : workflow),
  };
  const machineWithoutAction = createReleaseProcessStateMachine({ context, nodes, config: removedActionConfig });
  assert.equal(selectWorkflowProcessNodes({ machine: machineWithoutAction, nodes }).some((node) => node.id === configuredId), false);
  const seededWithoutAction = seedNextRecommendations({ context, timeline: [{ nodeId: "release-initialization", status: "completed" }], pending: [] }, nodes, removedActionConfig);
  assert.equal(seededWithoutAction.pending.some((item) => item.nodeId === configuredId), false);
});

test("generated recommendation records retain workflow identity through runtime state round trip", async () => {
  const { seedNextRecommendations } = await import("../builtin/web-ui/src/lib/releaseWorkflowModel.js");
  const { readReleaseState, writeReleaseState, releaseStatePath } = await import("../bin/lib/release-runtime-store.mjs");
  const tempRoot = await import("node:fs/promises").then(({ mkdtemp }) => mkdtemp("/tmp/release-runtime-task4-"));
  const context = { businessLine: "likee", platform: "android", version: "5.63.0", batch: "initial" };
  const nodes = [{ id: "release-git:create-release-branch", title: "Create Release Branch", skill: "release-git", businessLines: ["likee"], platforms: ["android"] }];
  const seeded = seedNextRecommendations({ context, timeline: [{ nodeId: "release-initialization", status: "completed" }], pending: [] }, nodes);
  assert.ok(seeded.pending[0].workflowId);
  const statePath = releaseStatePath(tempRoot, context, "task4");
  writeReleaseState(tempRoot, context, "task4", seeded);
  const roundTrip = readReleaseState(tempRoot, context, "task4");
  assert.equal(roundTrip.pending[0].workflowId, seeded.pending[0].workflowId);
  assert.equal(statePath.endsWith(".json"), true);
});

test("unmatched workflow exposes no executable candidates or recommendations", async () => {
  const { seedNextRecommendations } = await import("../builtin/web-ui/src/lib/releaseWorkflowModel.js");
  const { createReleaseProcessStateMachine, selectWorkflowProcessNodes } = await import("../builtin/web-ui/src/lib/releaseWorkflowStateMachine.js");
  const { filterReleaseActionsForWorkflow } = await import("../bin/lib/release-runtime.mjs");
  const context = { businessLine: "hello", platform: "ios", version: "1.0.0", batch: "initial" };
  const nodes = [{ id: "release-git:create-release-branch", title: "Create Release Branch", skill: "release-git" }];
  const machine = createReleaseProcessStateMachine({ context, nodes });
  assert.equal(machine.workflowId, "");
  assert.deepEqual(machine.nodes, []);
  assert.deepEqual(selectWorkflowProcessNodes({ machine, nodes }), []);
  assert.deepEqual(seedNextRecommendations({ context, timeline: [{ nodeId: "release-initialization", status: "completed" }], pending: [] }, nodes).pending, []);
  assert.deepEqual(filterReleaseActionsForWorkflow(nodes, context), []);
});
