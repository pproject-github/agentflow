import test from "node:test";
import assert from "node:assert/strict";

import {
  createInitializationNode,
  createCompletionMetadata,
  resolveReleaseContext,
  seedInitializationState,
  ensureInitializationFirst,
  createPresetInstance,
  selectPresetNodes,
} from "../builtin/web-ui/src/lib/releaseWorkflowModel.js";

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

test("seeds initialization only when the release context has no state", () => {
  const node = createInitializationNode(
    { businessLine: "hello", platform: "ios", version: "1.0.0" },
    { label: "Hello" },
  );
  const seeded = seedInitializationState(
    { timeline: [], pending: [], customNodes: [] },
    node,
  );

  assert.equal(seeded.pending.length, 1);
  assert.equal(seeded.pending[0].nodeId, node.id);
  assert.deepEqual(seeded.pending[0].inputs, node.inputs);

  const unchanged = seedInitializationState(seeded, node);
  assert.equal(unchanged, seeded);
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
  const preset = { id: "release-records", title: "登记发版记录", description: "预置描述", category: "版本全量", inputSchema: [{ key: "batch", label: "批次", required: true }] };
  const first = createPresetInstance(preset);
  const second = createPresetInstance(preset);

  assert.notEqual(first.id, second.id);
  assert.notEqual(first.id, preset.id);
  assert.equal(first.sourcePresetId, preset.id);
  assert.equal(first.title, preset.title);
  assert.equal(first.description, preset.description);
  assert.deepEqual(first.inputSchema, preset.inputSchema);
});
