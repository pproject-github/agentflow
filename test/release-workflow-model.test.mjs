import test from "node:test";
import assert from "node:assert/strict";

import {
  createInitializationNode,
  createInitializationPreparationNode,
  seedInitializationPreparationState,
  createCompletionMetadata,
  resolveReleaseContext,
  seedInitializationState,
  ensureInitializationFirst,
  seedNextRecommendations,
  createPresetInstance,
  selectPresetNodes,
  normalizeCompositeSteps,
  externalInputSchemaForNode,
  defaultInputsForNode,
  removePendingNode,
  filterDismissedPending,
  isPendingDismissed,
} from "../builtin/web-ui/src/lib/releaseWorkflowModel.js";
import { RELEASE_WORKFLOW_CONFIG } from "../shared/release-workflow-config.js";

test("removes localization source paths so the Skill discovers the complete file set", () => {
  const node = {
    id: "release-localization:upload-source-file",
    inputSchema: [{ key: "source_path", defaultValue: "iHeima/res/values/strings.xml" }],
  };
  assert.deepEqual(defaultInputsForNode(node, {
    source_path: "/Users/duanfengyuan/migration-workspace/test/likee_android",
  }), {});
  assert.deepEqual(defaultInputsForNode(node, { source_path: "iHeima/reslive/values/livestrings.xml" }), {});
  assert.equal(defaultInputsForNode({
    id: "composite:localization-upload-notify",
    platforms: ["android"],
    inputSchema: [{ key: "source_path" }],
  }, { source_path: "/legacy/project-root" }).source_path, undefined);
});

test("does not expose a source path for localization on either platform", () => {
  const node = {
    id: "custom-release-localization:upload-source-file-test",
    platforms: ["ios", "android"],
    inputSchema: [{ key: "source_path", defaultValue: "iHeima/res/values/strings.xml" }],
  };
  assert.equal(defaultInputsForNode(node, {}, { platform: "android" }).source_path, undefined);
  assert.equal(defaultInputsForNode(node, {}, { platform: "ios" }).source_path, undefined);
});

test("uses navigation parameters as the immutable release context", () => {
  const context = resolveReleaseContext(
    { businessLine: "likee", platform: "android", version: "1.0.0" },
    "?businessLine=Hello&platform=iOS&version=2.3.4",
  );

  assert.deepEqual(context, { businessLine: "hello", platform: "ios", version: "2.3.4", batch: "supplemental" });
});

test("normalizes a major version URL and infers initial batch when batch is omitted", () => {
  assert.deepEqual(resolveReleaseContext({}, "?businessLine=likee&platform=android&version=5.64"), {
    businessLine: "likee",
    platform: "android",
    version: "5.64.0",
    batch: "initial",
  });
});

test("infers supplemental batch from a minor version when batch is omitted", () => {
  assert.deepEqual(resolveReleaseContext({}, "?businessLine=likee&platform=android&version=5.64.1"), {
    businessLine: "likee",
    platform: "android",
    version: "5.64.1",
    batch: "supplemental",
  });
});

test("uses only the current batch for recommendations while retaining prior batches in the timeline", () => {
  const context = { businessLine: "likee", platform: "android", version: "5.64.1", batch: "supplemental" };
  const initialization = createInitializationNode({ ...context, version: "5.64.0", batch: "initial" });
  const start = { id: "start-supplemental-release-notify", title: "开始补包 & 发送通知", description: "", category: "发版", processId: "entry", processOrder: 0, businessLines: ["likee"], platforms: ["android"], contextSnapshot: { ...context } };
  const build = { id: "build-package", title: "构建发版包", description: "", category: "构建", processId: "build", processOrder: 1, businessLines: ["likee"], platforms: ["android"], contextSnapshot: { ...context } };
  const state = seedNextRecommendations({
    context,
    timeline: [{ ...initialization, id: "initialization", status: "completed" }, { id: "initial-build", nodeId: "build-package", status: "completed", contextSnapshot: { ...context, version: "5.64.0", batch: "initial" }, scopeKey: "likee/android/5.64.0/initial" }],
    pending: [],
    customNodes: [],
  }, [start, build]);
  assert.equal(state.timeline.length, 2);
  assert.equal(state.pending[0]?.nodeId, "start-supplemental-release-notify");
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
  assert.equal(node.workflowId, "likee-android-release");
  assert.equal(node.scopeKey, "likee/android/6.2.1/initial");
  assert.deepEqual(node.contextSnapshot, node.inputs);
  assert.deepEqual(node.nextNodeIds, []);
});

test("initialization is the only fixed context node", () => {
  const context = { businessLine: "likee", platform: "android", version: "5.63.2", batch: "initial" };
  const node = createInitializationNode(context, { path: "/workspace/likee" });
  const seeded = seedInitializationState({ timeline: [], pending: [], customNodes: [] }, node);
  assert.equal(seeded.timeline[0].nodeId, "release-initialization");
  assert.deepEqual(seeded.pending, []);
  const ready = seedNextRecommendations(seeded, [node, {
    id: "composite:create-release-branch",
    title: "Create Release Branch",
    businessLines: ["likee"],
    platforms: ["android"],
  }]);
  assert.equal(ready.pending.length, 1);
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
  assert.equal(seeded.timeline[0].workflowId, "");
  assert.equal(seeded.timeline[0].scopeKey, "hello/ios/1.0.0/initial");
  assert.deepEqual(seeded.timeline[0].contextSnapshot, node.contextSnapshot);
  assert.equal(seeded.pending.length, 0);

  const unchanged = seedInitializationState(seeded, node);
  assert.equal(unchanged, seeded);
});

test("does not re-block a legacy timeline that already has release actions", () => {
  const context = { businessLine: "likee", platform: "android", version: "5.63.2", batch: "initial" };
  const node = createInitializationNode(context);
  const preparation = createInitializationPreparationNode(context);
  const state = seedInitializationPreparationState({
    timeline: [{ nodeId: node.id, status: "completed" }, { nodeId: "release-git:create-release-branch", status: "completed" }],
    pending: [],
    customNodes: [],
  }, node, preparation);
  assert.equal(state.initialization.status, "completed");
  assert.deepEqual(state.pending, []);
});

test("recommends the first available node after completed initialization", () => {
  const node = createInitializationNode({ businessLine: "likee", platform: "android", version: "5.63.2" });
  const next = {
    id: "composite:create-release-branch",
    title: "Create Release Branch",
    description: "create",
    category: "发版准备",
    inputSchema: [{ key: "release_branch", defaultValue: "release/v5.63" }],
    nextNodeIds: [],
  };
  const state = seedNextRecommendations(seedInitializationState({ timeline: [], pending: [], customNodes: [] }, node), [node, next]);

  assert.deepEqual(state.pending.map((item) => item.nodeId), [next.id]);
  assert.equal(state.pending[0].id, `${next.id}-recommended`);
  assert.deepEqual(state.pending[0].inputs, { release_branch: "release/v5.63" });
  assert.equal(state.pending[0].scopeKey, "likee/android/5.63.2/initial");
  const again = seedNextRecommendations(state, [node, next]);
  assert.equal(again.pending.length, 1);
  assert.equal(again.pending[0].id, state.pending[0].id);
});

test("removing a system recommendation records the dismissal and recommends the next node", () => {
  const context = { businessLine: "likee", platform: "android", version: "5.63.2", batch: "initial" };
  const initialization = createInitializationNode(context);
  const first = { id: "composite:localization-upload-notify", title: "多语言上传 & 通知", processId: "entry", processOrder: 10, businessLines: ["likee"], platforms: ["android"], contextSnapshot: context };
  const second = { id: "composite:create-release-branch", title: "创建发版分支", processId: "entry", processOrder: 20, businessLines: ["likee"], platforms: ["android"], contextSnapshot: context };
  const state = seedNextRecommendations(seedInitializationState({ timeline: [], pending: [], customNodes: [] }, initialization), [initialization, first, second]);
  const removed = removePendingNode(state, state.pending[0]);
  const next = seedNextRecommendations(removed, [initialization, first, second]);

  assert.deepEqual(next.dismissedNodeIds, [first.id]);
  assert.deepEqual(next.pending.map((item) => item.nodeId), [second.id]);
});

test("removing failed system and custom preset instances is allowed, but running nodes stay protected", () => {
  const failed = { id: "failed-item", nodeId: "release-git:create-release-branch", status: "failed" };
  const running = { id: "running-item", nodeId: "release-git:create-release-branch", status: "running" };
  const custom = { id: "custom-item", nodeId: "custom-composite:localization-upload-notify-abc", status: "failed", sourcePresetId: "composite:localization-upload-notify" };
  const state = { timeline: [], pending: [failed, running, custom], customNodes: [], dismissedNodeIds: [] };

  assert.equal(removePendingNode(state, failed).pending.some((item) => item.id === failed.id), false);
  assert.equal(removePendingNode(state, running), state);
  const removedCustom = removePendingNode(state, custom);
  assert.equal(removedCustom.pending.some((item) => item.id === custom.id), false);
  assert.deepEqual(removedCustom.dismissedNodeIds, [custom.id]);
});

test("filterDismissedPending hides dismissed cards during server sync", () => {
  const pending = [
    { id: "old-failed", nodeId: "release-initialization:prepare-context", status: "failed" },
    { id: "active", nodeId: "composite:localization-upload-notify", status: "running" },
  ];
  const filtered = filterDismissedPending(pending, ["release-initialization:prepare-context"]);
  assert.deepEqual(filtered.map((item) => item.id), ["active"]);
  assert.equal(isPendingDismissed(pending[0], ["release-initialization:prepare-context"]), true);
});

test("createPresetInstance pending cards keep sourcePresetId for execution and deletion", () => {
  const preset = {
    id: "composite:localization-upload-notify",
    title: "多语言上传 & 通知",
    kind: "composite",
    compositeId: "localization-upload-notify",
    businessLines: ["likee"],
    platforms: ["android"],
  };
  const instance = createPresetInstance(preset);
  assert.match(instance.id, /^custom-composite:localization-upload-notify-/);
  assert.equal(instance.sourcePresetId, preset.id);
  assert.notEqual(instance.id, preset.id);
});

test("seeds recommendations from the supplied workflow configuration", () => {
  const context = { businessLine: "likee", platform: "android", version: "5.63.2", batch: "initial" };
  const initialization = createInitializationNode(context);
  const next = { id: "composite:create-release-branch", title: "Create Release Branch", businessLines: ["likee"], platforms: ["android"] };
  const config = {
    ...RELEASE_WORKFLOW_CONFIG,
    workflows: RELEASE_WORKFLOW_CONFIG.workflows.map((workflow) => ({
      ...workflow,
      stages: workflow.stages.map((stage) => ({ ...stage, nodes: stage.nodes.filter((entry) => entry.id !== "create-release-branch") })),
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
    id: "composite:create-release-branch",
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
    id: "composite:localization-upload-notify",
    title: "创建发版分支",
    processId: "preparation",
    processOrder: 10,
    businessLines: ["likee"],
    platforms: ["android"],
    contextSnapshot: context,
  };
  const preparationNext = {
    id: "composite:create-release-branch",
    title: "创建分支",
    processId: "entry",
    processOrder: 20,
    businessLines: ["likee"],
    platforms: ["android"],
    contextSnapshot: context,
  };
  const approval = {
    id: "composite:submit-approval",
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
  assert.equal(afterAllPreparation.processStates.entry, "completed");
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

test("normalizes composite internal step details for timeline persistence", () => {
  const steps = normalizeCompositeSteps([
    { stepId: "upload", actionId: "release-localization:upload-source-file", status: "succeeded", startedAt: 10, completedAt: 25, output: { record_id: "r1" } },
    { stepId: "notify", actionId: "release-notification:send-notification", status: "failed", error: "webhook timeout" },
    { action: "prepare-translation-archive", status: "skipped_already_succeeded", note: "already done" },
  ]);
  assert.equal(steps.length, 3);
  assert.deepEqual(steps[0], {
    stepId: "upload",
    actionId: "release-localization:upload-source-file",
    title: "上传源多语言",
    status: "succeeded",
    startedAt: 10,
    completedAt: 25,
    durationMs: 15,
    output: { record_id: "r1" },
    error: "",
  });
  assert.equal(steps[1].status, "failed");
  assert.equal(steps[1].error, "webhook timeout");
  assert.equal(steps[1].title, "发送发版通知");
  assert.equal(steps[2].action, "prepare-translation-archive");
  assert.equal(steps[2].actionId, "prepare-translation-archive");
  assert.equal(steps[2].title, "准备翻译归档");
  assert.equal(steps[2].note, "already done");
});

test("composite input schema hides internal step mappings", () => {
  const node = {
    kind: "composite",
    inputSchema: [
      { key: "source_path", label: "源文件" },
      { key: "record_id", label: "内部记录" },
      { key: "event", label: "事件" },
    ],
    actions: [
      { inputs: { source_path: { context: "source_path" }, record_id: { fromStep: "upload", output: "record_id" }, event: "localization-uploaded" } },
    ],
  };
  assert.deepEqual(externalInputSchemaForNode(node).map((entry) => entry.key), ["source_path"]);
});

test("agent-driven composite input schema keeps declared external inputs", () => {
  const node = {
    kind: "composite",
    compositeId: "free-prompt-agent",
    inputSchema: [
      { key: "prompt", label: "任务说明", type: "textarea", required: true },
      { key: "skill_hints", label: "Skill 提示", type: "text" },
    ],
  };
  assert.deepEqual(externalInputSchemaForNode(node).map((entry) => entry.key), ["prompt", "skill_hints"]);
});

test("static release catalog exposes free-prompt agent without putting it in default stage ids", async () => {
  const { getReleaseNodes } = await import("../builtin/web-ui/src/lib/releaseNodeCatalog.js");
  const nodes = getReleaseNodes({ businessLine: "likee", platform: "android", version: "1.3.0", batch: "initial" });
  const free = nodes.find((node) => node.compositeId === "free-prompt-agent");
  assert.ok(free);
  assert.equal(free.insertableInAnyStage, true);
  assert.equal(free.kind, "composite");
  assert.ok(free.inputSchema.some((input) => input.key === "prompt"));
});

test("static release catalog does not expose the initialization context as an addable node", async () => {
  const { getReleaseNodes } = await import("../builtin/web-ui/src/lib/releaseNodeCatalog.js");
  const nodes = getReleaseNodes({ businessLine: "likee", platform: "android", version: "1.3.0", batch: "initial" });
  const preparation = nodes.filter((node) => node.id === "release-initialization:prepare-context");
  assert.equal(preparation.length, 0);
  assert.equal(nodes.some((node) => node.id === "release-initialization"), false);
  assert.equal(nodes.some((node) => node.id === "localization-upload-notify"), false);
});
