import test from "node:test";
import assert from "node:assert/strict";

import {
  createInitializationNode,
  createCompletionMetadata,
  resolveReleaseContext,
  seedInitializationState,
  ensureInitializationFirst,
  seedNextRecommendations,
  createPresetInstance,
  selectPresetNodes,
} from "../builtin/web-ui/src/lib/releaseWorkflowModel.js";
import { RELEASE_WORKFLOW_CONFIG } from "../shared/release-workflow-config.js";

test("uses navigation parameters as the immutable release context", () => {
  const context = resolveReleaseContext(
    { businessLine: "likee", platform: "android", version: "1.0.0" },
    "?businessLine=Hello&platform=iOS&version=2.3.4",
  );

  assert.deepEqual(context, { businessLine: "hello", platform: "ios", version: "2.3.4" });
});

test("creates an initialization node with the active release context", () => {
  const node = createInitializationNode(
    { businessLine: "likee", platform: "android", version: "6.2.1" },
    { path: "/workspace/likee" },
  );

  assert.equal(node.id, "release-initialization");
  assert.equal(node.title, "初始化状态");
  assert.deepEqual(node.inputs, {
    businessLine: "likee",
    platform: "android",
    version: "6.2.1",
    workspace: "/workspace/likee",
  });
  assert.match(node.description, /likee/);
  assert.match(node.description, /android/);
  assert.match(node.description, /6\.2\.1/);
});

test("seeds initialization as completed when the release context has no state", () => {
  const node = createInitializationNode(
    { businessLine: "hello", platform: "ios", version: "1.0.0" },
    { label: "Hello" },
  );
  const seeded = seedInitializationState(
    { timeline: [], pending: [], customNodes: [] },
    node,
  );

  assert.equal(seeded.timeline.length, 1);
  assert.equal(seeded.timeline[0].nodeId, node.id);
  assert.equal(seeded.timeline[0].status, "completed");
  assert.deepEqual(seeded.timeline[0].inputs, node.inputs);
  assert.equal(seeded.pending.length, 0);

  const unchanged = seedInitializationState(seeded, node);
  assert.equal(unchanged, seeded);
});

test("recommends the first available node after completed initialization", () => {
  const node = createInitializationNode({ businessLine: "likee", platform: "android", version: "5.63.2" });
  const next = {
    id: "release-git:create-release-branch",
    title: "Create Release Branch",
    description: "create",
    category: "发版准备",
    inputSchema: [{ key: "release_branch", defaultValue: "release/v5.63" }],
    nextNodeIds: [],
  };
  const state = seedNextRecommendations(seedInitializationState({ timeline: [], pending: [], customNodes: [] }, node), [node, next]);

  assert.deepEqual(state.pending.map((item) => item.nodeId), [next.id]);
  assert.deepEqual(state.pending[0].inputs, { release_branch: "release/v5.63" });
  assert.equal(state.pending[0].scopeKey, "likee/android/5.63.2/initial");
});

test("seeds recommendations from the supplied workflow configuration", () => {
  const context = { businessLine: "likee", platform: "android", version: "5.63.2", batch: "initial" };
  const initialization = createInitializationNode(context);
  const next = { id: "release-git:create-release-branch", title: "Create Release Branch", businessLines: ["likee"], platforms: ["android"] };
  const config = {
    ...RELEASE_WORKFLOW_CONFIG,
    workflows: RELEASE_WORKFLOW_CONFIG.workflows.map((workflow) => ({
      ...workflow,
      stages: workflow.stages.map((stage) => ({ ...stage, nodes: stage.nodes.filter((entry) => entry.id !== next.id) })),
    })),
  };
  const state = seedNextRecommendations(
    { ...seedInitializationState({ timeline: [], pending: [], customNodes: [] }, initialization), context },
    [initialization, next],
    config,
  );

  assert.equal(state.pending.some((item) => item.nodeId === next.id), false);
});

test("ignores a pending node from another release scope when seeding recommendations", () => {
  const context = { businessLine: "likee", platform: "android", version: "5.63.2", batch: "initial" };
  const node = createInitializationNode(context);
  const next = {
    id: "release-git:create-release-branch",
    title: "创建发版分支",
    processId: "preparation",
    processOrder: 10,
    businessLines: ["likee"],
    platforms: ["android"],
    contextSnapshot: context,
  };
  const state = seedNextRecommendations({
    ...seedInitializationState({ timeline: [], pending: [], customNodes: [] }, node),
    context,
    pending: [{ nodeId: "foreign-node", status: "pending", scopeKey: "likee/ios/5.63.2/initial" }],
  }, [node, next]);

  assert.deepEqual(state.pending.map((item) => item.nodeId), ["foreign-node", next.id]);
});

test("continues within a process before recommending the next process", () => {
  const context = { businessLine: "likee", platform: "android", version: "5.63.2", batch: "initial" };
  const initialization = createInitializationNode(context);
  const preparationNode = {
    id: "release-git:create-release-branch",
    title: "创建发版分支",
    processId: "preparation",
    processOrder: 10,
    businessLines: ["likee"],
    platforms: ["android"],
    contextSnapshot: context,
  };
  const preparationNext = {
    id: "release-management:register-release-branch",
    title: "创建分支",
    processId: "preparation",
    processOrder: 20,
    businessLines: ["likee"],
    platforms: ["android"],
    contextSnapshot: context,
  };
  const approval = {
    id: "release-approval:create-initial-release-approval",
    title: "全量审核",
    processId: "approval",
    processOrder: 10,
    businessLines: ["likee"],
    platforms: ["android"],
    contextSnapshot: context,
  };
  const nodes = [initialization, preparationNode, preparationNext, approval];
  const firstCompleted = seedInitializationState({ timeline: [], pending: [], customNodes: [] }, initialization);
  const afterFirst = seedNextRecommendations({ ...firstCompleted, context }, nodes);
  assert.deepEqual(afterFirst.pending.map((item) => item.nodeId), [preparationNode.id]);
  const afterPreparation = seedNextRecommendations({
    context,
    timeline: [firstCompleted.timeline[0], { nodeId: preparationNode.id, status: "completed" }],
    pending: [],
    customNodes: [],
  }, nodes);
  assert.deepEqual(afterPreparation.pending.map((item) => item.nodeId), [preparationNext.id]);
  const afterAllPreparation = seedNextRecommendations({
    context,
    timeline: [
      firstCompleted.timeline[0],
      { nodeId: preparationNode.id, status: "completed" },
      { nodeId: preparationNext.id, status: "completed" },
    ],
    pending: [],
    customNodes: [],
  }, nodes);
  assert.deepEqual(afterAllPreparation.pending.map((item) => item.nodeId), [approval.id]);
  assert.equal(afterAllPreparation.processStates["preparation-initial"], "completed");
});

test("does not recommend a node outside the selected release scope", () => {
  const node = createInitializationNode({ businessLine: "likee", platform: "android", version: "5.63.2" });
  const other = { id: "release-ios-only", title: "iOS", businessLines: ["likee"], platforms: ["ios"], nextNodeIds: [] };
  const state = seedNextRecommendations(seedInitializationState({ timeline: [], pending: [], customNodes: [] }, node), [node, other]);

  assert.equal(state.pending.length, 0);
});

test("prepends a completed initialization node when legacy timeline data has no initialization", () => {
  const node = createInitializationNode(
    { businessLine: "likee", platform: "android", version: "6.2.1" },
    { path: "/workspace/likee" },
  );
  const legacy = {
    timeline: [{ nodeId: "release-setup", title: "接入发版工程", completedAt: 2_000 }],
    pending: [{ nodeId: "release-management", title: "确认发版上下文" }],
    customNodes: [],
  };

  const migrated = ensureInitializationFirst(legacy, node);

  assert.equal(migrated.timeline[0].nodeId, node.id);
  assert.equal(migrated.timeline[0].status, "completed");
  assert.equal(migrated.timeline[0].operator, "历史数据");
  assert.equal(migrated.timeline[1].nodeId, "release-setup");
  assert.equal(migrated.pending[0].nodeId, "release-management");
});

test("moves a legacy pending initialization ahead of already completed history", () => {
  const node = createInitializationNode({ businessLine: "likee", platform: "ios", version: "4.0.0" });
  const state = ensureInitializationFirst({
    timeline: [{ nodeId: "release-setup", completedAt: 4_000 }],
    pending: [{ nodeId: node.id, title: node.title, status: "pending" }],
    customNodes: [],
  }, node);

  assert.equal(state.timeline[0].nodeId, node.id);
  assert.equal(state.timeline[0].status, "completed");
  assert.equal(state.pending.some((item) => item.nodeId === node.id), false);
});

test("promotes a pending initialization to completed when no history exists", () => {
  const node = createInitializationNode({ businessLine: "likee", platform: "android", version: "4.0.0" });
  const state = ensureInitializationFirst({
    timeline: [],
    pending: [{ nodeId: node.id, title: node.title, status: "pending", inputs: node.inputs }],
    customNodes: [],
  }, node);

  assert.equal(state.timeline.length, 1);
  assert.equal(state.timeline[0].nodeId, node.id);
  assert.equal(state.timeline[0].status, "completed");
  assert.equal(state.pending.length, 0);
});

test("selects preset definitions without creating a custom title or description", () => {
  const presets = [
    { id: "release-git", title: "准备发版分支与合并", description: "复用预置描述" },
    { id: "release-records", title: "登记发版记录", description: "登记摘要" },
  ];

  assert.deepEqual(selectPresetNodes(presets, ["release-records", "missing"]), [presets[1]]);
});

test("stores operator and elapsed time when a release node completes", () => {
  const metadata = createCompletionMetadata({
    operator: "alice",
    startedAt: 1_000,
    completedAt: 2_500,
  });

  assert.deepEqual(metadata, {
    operator: "alice",
    startedAt: 1_000,
    completedAt: 2_500,
    durationMs: 1_500,
  });
});

test("creates repeatable custom instances from one preset definition", () => {
  const preset = { id: "release-records", title: "登记发版记录", description: "预置描述", category: "版本全量", templateId: "likee-android-supplemental-release", templateStepId: "likee-android-supplemental-release:5", inputSchema: [{ key: "batch", label: "批次", required: true }] };
  const first = createPresetInstance(preset);
  const second = createPresetInstance(preset);

  assert.notEqual(first.id, second.id);
  assert.notEqual(first.id, preset.id);
  assert.equal(first.sourcePresetId, preset.id);
  assert.equal(first.title, preset.title);
  assert.equal(first.description, preset.description);
  assert.deepEqual(first.inputSchema, preset.inputSchema);
  assert.equal(first.templateId, preset.templateId);
  assert.equal(first.templateStepId, preset.templateStepId);
});
