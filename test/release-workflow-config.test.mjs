import test from "node:test";
import assert from "node:assert/strict";

import {
  RELEASE_WORKFLOW_CONFIG,
  compositeWorkflows,
  selectReleaseWorkflow,
  workflowActionIds,
  workflowStageNodeIds,
  selectReleaseCompositeWorkflow,
  selectReleaseCompositeForStage,
  validateReleaseWorkflowConfig,
  releaseActionProcessMetadata,
} from "../shared/release-workflow-config.js";

const initialContext = { businessLine: "likee", platform: "android", version: "5.63.2", batch: "initial" };
const supplementalContext = { ...initialContext, batch: "supplemental", batchIndex: 1 };

function capability(id = "demo-capability", overrides = {}) {
  return {
    id,
    title: "Demo capability",
    description: "Execute a demo release capability.",
    businessLines: ["demo"],
    platforms: ["android"],
    batches: ["initial"],
    stageId: "stage",
    skillHints: ["release-demo"],
    inputs: [],
    outputs: [],
    promptTemplate: "businessLine=${businessLine} platform=${platform} version=${version} batch=${batch}",
    ...overrides,
  };
}

function workflow(overrides = {}) {
  return {
    id: "demo-workflow",
    title: "Demo workflow",
    businessLines: ["demo"],
    platforms: ["android"],
    batches: ["initial"],
    stages: [{ id: "stage", title: "Demo stage", nodes: [{ id: "demo-capability" }] }],
    ...overrides,
  };
}

test("defines exactly the supported Likee Android capabilities", () => {
  const ids = compositeWorkflows.map((item) => item.id);
  assert.equal(ids.length, 13);
  assert.deepEqual(ids, [
    "release-initialization:prepare-context",
    "localization-upload-notify",
    "create-release-branch",
    "localization-download-merge-notify",
    "merge-release-to-master",
    "build-package",
    "submit-approval",
    "publish-and-notify",
    "supplemental-notification",
    "rollout",
    "submit-full-rollout-approval",
    "full-rollout",
    "free-prompt-agent",
  ]);
});

test("capabilities use Agent prompts and never embed atomic action graphs", () => {
  for (const item of compositeWorkflows) {
    assert.equal(item.actions, undefined, item.id);
    assert.equal(item.expandSourceFiles, undefined, item.id);
    assert.ok(item.promptTemplate.includes("${businessLine}"), item.id);
    assert.ok(item.promptTemplate.includes("${platform}"), item.id);
    assert.ok(item.promptTemplate.includes("${version}"), item.id);
    assert.ok(item.skillHints.length > 0, item.id);
    assert.ok(item.skillHints.every((skill) => skill.startsWith("release-")), item.id);
    assert.ok(Array.isArray(item.inputs), item.id);
    assert.ok(Array.isArray(item.outputs), item.id);
  }
});

test("localization download exposes optional force_rerun and hides resume record ids", () => {
  const download = compositeWorkflows.find((item) => item.id === "localization-download-merge-notify");
  const merge = compositeWorkflows.find((item) => item.id === "merge-release-to-master");
  assert.deepEqual((download?.inputs || []).map((item) => item.key), ["force_rerun"]);
  assert.equal(download.inputs[0].type, "checkbox");
  assert.equal((merge?.inputs || []).some((item) => /record_id/i.test(item.key)), false);
});

test("selects one Likee Android workflow for both initial and supplemental batches", () => {
  const initial = selectReleaseWorkflow(initialContext);
  const supplemental = selectReleaseWorkflow(supplementalContext);
  assert.equal(initial?.id, "likee-android-release");
  assert.equal(supplemental?.id, initial?.id);
  assert.deepEqual([...workflowActionIds(initial, initialContext)], [
    "release-initialization:prepare-context",
    "localization-upload-notify", "create-release-branch", "localization-download-merge-notify",
    "merge-release-to-master", "build-package", "submit-approval", "publish-and-notify", "rollout",
    "submit-full-rollout-approval", "full-rollout",
  ]);
  assert.deepEqual([...workflowActionIds(supplemental, supplementalContext)], [
    "release-initialization:prepare-context", "supplemental-notification", "build-package", "publish-and-notify", "rollout",
    "submit-full-rollout-approval", "full-rollout",
  ]);
});

test("selects scoped capabilities and stage-specific capabilities", () => {
  assert.equal(selectReleaseCompositeWorkflow({ ...initialContext, capabilityId: "build-package" })?.id, "build-package");
  assert.equal(selectReleaseCompositeWorkflow({ ...initialContext, capabilityId: "supplemental-notification" }), null);
  const stage = RELEASE_WORKFLOW_CONFIG.workflows[0].stages.find((item) => item.id === "localization");
  assert.equal(selectReleaseCompositeForStage({ ...initialContext }, stage)?.id, "localization-download-merge-notify");
  assert.equal(selectReleaseCompositeWorkflow({ ...initialContext, capabilityId: "build-package", platform: "ios" })?.id, "build-package");
  assert.equal(selectReleaseCompositeWorkflow({ ...initialContext, capabilityId: "rollout", platform: "ios" }), null);
});

test("resolves process metadata from the configured capability stage", () => {
  assert.deepEqual(releaseActionProcessMetadata("create-release-branch", {}, RELEASE_WORKFLOW_CONFIG, initialContext), {
    processId: "entry",
    processOrder: 0,
    processTitle: "发版入口",
  });
});

test("uses stage references as the canonical capability IDs", () => {
  const stage = { id: "stage", nodes: [{ id: "canonical" }], nodeIds: ["legacy"] };
  assert.deepEqual(workflowStageNodeIds(stage), ["canonical"]);
});

test("validates the shared capability/workflow configuration", () => {
  const result = validateReleaseWorkflowConfig(RELEASE_WORKFLOW_CONFIG);
  assert.deepEqual(result, { valid: true, errors: [] });
  assert.ok(Object.isFrozen(RELEASE_WORKFLOW_CONFIG.capabilities));
  assert.ok(Object.isFrozen(RELEASE_WORKFLOW_CONFIG.workflows[0].stages));
});

test("free-prompt-agent is insertable anywhere and not part of default workflow action ids", async () => {
  const { insertableReleaseCapabilities } = await import("../shared/release-workflow-config.js");
  const free = selectReleaseCompositeWorkflow({ ...initialContext, capabilityId: "free-prompt-agent" });
  assert.equal(free?.id, "free-prompt-agent");
  assert.equal(free.insertableInAnyStage, true);
  assert.ok(free.inputs.some((input) => input.key === "prompt" && input.required));
  assert.ok(free.promptTemplate.includes("${prompt}"));
  assert.equal(insertableReleaseCapabilities(initialContext).some((item) => item.id === "free-prompt-agent"), true);
  assert.equal(workflowActionIds(selectReleaseWorkflow(initialContext), initialContext).has("free-prompt-agent"), false);
});

test("rejects duplicate, unknown, and out-of-scope capability references", () => {
  const result = validateReleaseWorkflowConfig({
    capabilities: [capability()],
    workflows: [workflow({
      stages: [{ id: "stage", title: "Demo stage", nodes: [{ id: "demo-capability" }, { id: "demo-capability" }, { id: "missing" }] }],
    })],
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /duplicate capability reference/i);
  assert.match(result.errors.join("\n"), /unknown capability reference/i);
});

test("rejects malformed capability scopes, prompts, hints, and legacy graph fields", () => {
  const result = validateReleaseWorkflowConfig({
    capabilities: [capability("bad", {
      businessLines: [], platforms: [" "], batches: [], skillHints: ["custom-skill"],
      promptTemplate: "missing context", actions: [], expandSourceFiles: true,
    })],
    workflows: [workflow({ stages: [{ id: "stage", nodes: [{ id: "bad" }] }] })],
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /scope/i);
  assert.match(result.errors.join("\n"), /promptTemplate/i);
  assert.match(result.errors.join("\n"), /skillHints/i);
  assert.match(result.errors.join("\n"), /must not define actions/i);
  assert.match(result.errors.join("\n"), /expandSourceFiles/i);
});

test("validates batch-loop transitions", () => {
  const valid = validateReleaseWorkflowConfig({
    capabilities: [capability()],
    workflows: [workflow({ batches: ["initial", "supplemental"], transitions: [
      { id: "create_supplemental_batch", from: "stage", to: "create_supplemental_batch", targetBatch: "supplemental", repeatable: true },
    ] })],
  });
  assert.equal(valid.valid, true, valid.errors.join("\n"));
  const invalid = validateReleaseWorkflowConfig({
    capabilities: [capability()],
    workflows: [workflow({ batches: ["initial"], transitions: [
      { id: "bad", from: "stage", to: "create_supplemental_batch", targetBatch: "supplemental" },
    ] })],
  });
  assert.equal(invalid.valid, false);
  assert.match(invalid.errors.join("\n"), /target batch/i);
});

test("does not select a workflow outside the configured business line or platform", () => {
  assert.equal(selectReleaseWorkflow({ ...initialContext, businessLine: "bigolive" }), null);
  assert.equal(selectReleaseWorkflow({ ...initialContext, platform: "web" }), null);
});

test("selects Likee iOS workflow without gray rollout and with publish supplemental transitions", () => {
  const iosInitial = { businessLine: "likee", platform: "ios", version: "5.63.2", batch: "initial" };
  const iosSupplemental = { ...iosInitial, batch: "supplemental", batchIndex: 1 };
  const initial = selectReleaseWorkflow(iosInitial);
  const supplemental = selectReleaseWorkflow(iosSupplemental);
  assert.equal(initial?.id, "likee-ios-release");
  assert.equal(supplemental?.id, initial?.id);
  assert.deepEqual(initial.stages.map((item) => item.id), [
    "entry", "localization", "merge-master", "build", "approval", "publish", "full-rollout",
  ]);
  assert.equal(initial.stages.some((item) => item.id === "rollout"), false);
  assert.deepEqual([...workflowActionIds(initial, iosInitial)], [
    "release-initialization:prepare-context",
    "localization-upload-notify", "create-release-branch", "localization-download-merge-notify",
    "merge-release-to-master", "build-package", "submit-approval", "publish-and-notify",
    "submit-full-rollout-approval", "full-rollout",
  ]);
  assert.equal(workflowActionIds(initial, iosInitial).has("rollout"), false);
  assert.deepEqual([...workflowActionIds(supplemental, iosSupplemental)], [
    "release-initialization:prepare-context", "supplemental-notification", "build-package", "publish-and-notify",
    "submit-full-rollout-approval", "full-rollout",
  ]);
  assert.ok(initial.transitions.some((item) => item.from === "publish" && item.to === "create_supplemental_batch"));
  assert.ok(initial.transitions.some((item) => item.from === "full-rollout" && item.to === "create_supplemental_batch"));
  assert.equal(initial.transitions.some((item) => item.from === "rollout"), false);
  assert.ok(compositeWorkflows.find((item) => item.id === "rollout")?.platforms.includes("android"));
  assert.equal(compositeWorkflows.find((item) => item.id === "rollout")?.platforms.includes("ios"), false);
  assert.ok(compositeWorkflows.find((item) => item.id === "build-package")?.platforms.includes("ios"));
  assert.ok(compositeWorkflows.find((item) => item.id === "build-package")?.skillHints.includes("release-build"));
  assert.ok(compositeWorkflows.find((item) => item.id === "publish-and-notify")?.skillHints.includes("release-release-notes"));
});
