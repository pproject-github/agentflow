import test from "node:test";
import assert from "node:assert/strict";

import {
  RELEASE_WORKFLOW_CONFIG,
  selectReleaseWorkflow,
  workflowActionIds,
  compositeWorkflows,
  selectReleaseCompositeWorkflow,
  compositeActionIds,
  validateReleaseWorkflowConfig,
  releaseActionProcessMetadata,
} from "../shared/release-workflow-config.js";

test("selects the Likee Android workflow and filters initial batch nodes", () => {
  const workflow = selectReleaseWorkflow({ businessLine: "likee", platform: "android", batch: "initial" });
  assert.equal(workflow.id, "likee-android-release");
  assert.equal(workflowActionIds(workflow, { batch: "initial" }).has("release-git:create-release-branch"), true);
  assert.equal(workflowActionIds(workflow, { batch: "initial" }).has("release-management:append-release-batch"), false);
});

test("selects iOS workflow and retains optional nodes", () => {
  const workflow = selectReleaseWorkflow({ businessLine: "LIKEE", platform: "IOS", batch: "initial" });
  assert.equal(workflow.id, "likee-ios-release");
  const ids = workflowActionIds(workflow, { batch: "initial" });
  assert.equal(ids.has("release-release-notes:upload-ios-release-notes"), true);
  assert.equal(ids.has("release-google-play:submit-aab-internal-testing"), false);
  assert.equal(ids.has("release-google-play:preview-aab-submission"), false);
});

test("returns process metadata from configured stage and action fallback", () => {
  const metadata = releaseActionProcessMetadata("release-git:create-release-branch");
  assert.deepEqual(metadata, { processId: "preparation-initial", processOrder: 60, processTitle: "首包准备" });
});

test("resolves process metadata from a caller-supplied workflow config", () => {
  const config = {
    workflows: [{
      id: "custom",
      businessLines: ["demo"],
      platforms: ["android"],
      batches: ["initial"],
      stages: [{ id: "custom-stage", title: "自定义阶段", nodes: [{ id: "demo:action" }] }],
    }],
  };
  assert.deepEqual(releaseActionProcessMetadata("demo:action", {}, config), {
    processId: "custom-stage",
    processOrder: 1000,
    processTitle: "自定义阶段",
  });
});

test("selects the batch-enabled stage when resolving process metadata", () => {
  const config = {
    workflows: [{
      id: "demo",
      businessLines: ["demo"],
      platforms: ["android"],
      batches: ["initial", "supplemental"],
      stages: [
        { id: "initial-stage", title: "首包阶段", batches: ["initial"], nodes: [{ id: "demo:action" }] },
        { id: "supplemental-stage", title: "补包阶段", batches: ["supplemental"], nodes: [{ id: "demo:action" }] },
      ],
    }],
  };
  assert.deepEqual(releaseActionProcessMetadata("demo:action", {}, config, { businessLine: "demo", platform: "android", batch: "supplemental" }), {
    processId: "supplemental-stage",
    processOrder: 1000,
    processTitle: "补包阶段",
  });
});

test("uses stage nodes as the canonical action references when nodeIds disagree", () => {
  const workflow = {
    businessLines: ["demo"],
    platforms: ["android"],
    batches: ["initial"],
    stages: [{ id: "stage", title: "阶段", nodes: [{ id: "canonical:action" }], nodeIds: ["legacy:action"] }],
  };
  assert.deepEqual([...workflowActionIds(workflow, { batch: "initial" })], ["canonical:action"]);
});

test("rejects duplicate Action references inside one workflow", () => {
  const result = validateReleaseWorkflowConfig({ workflows: [{ id: "demo", businessLines: ["likee"], platforms: ["android"], batches: ["initial"], stages: [{ id: "one", nodes: [{ id: "x" }, { id: "x" }] }] }] });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /duplicate|重复/i);
});

test("rejects empty scope, duplicate stage IDs, and invalid optional references", () => {
  const result = validateReleaseWorkflowConfig({ workflows: [{ id: "demo", businessLines: [], platforms: ["android"], batches: ["initial"], stages: [{ id: "one", nodes: [{ id: "x" }], optionalNodeIds: ["missing"] }, { id: "one", nodes: [{ id: "y" }] }] }] });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /scope|范围|stage|阶段|optional|可选/i);
});

test("ships a valid shared configuration with workflow maps", () => {
  const result = validateReleaseWorkflowConfig(RELEASE_WORKFLOW_CONFIG);
  assert.equal(result.valid, true, result.errors.join("\n"));
  assert.ok(Array.isArray(RELEASE_WORKFLOW_CONFIG.processOrder));
  assert.ok(RELEASE_WORKFLOW_CONFIG.processTitles.preparation);
  assert.ok(RELEASE_WORKFLOW_CONFIG.skillProcessMap["release-git"]);
  assert.equal(typeof RELEASE_WORKFLOW_CONFIG.actionOrder, "object");
  assert.equal(Object.isFrozen(RELEASE_WORKFLOW_CONFIG.workflows), true);
  assert.equal(Object.isFrozen(RELEASE_WORKFLOW_CONFIG.workflows[0]), true);
  assert.equal(Object.isFrozen(RELEASE_WORKFLOW_CONFIG.workflows[0].stages), true);
  assert.equal(Object.isFrozen(RELEASE_WORKFLOW_CONFIG.workflows[0].stages[0].nodes), true);
});

test("selects a scoped composite workflow and preserves ordered internal Actions", () => {
  const composite = selectReleaseCompositeWorkflow({
    businessLine: "likee",
    platform: "android",
    batch: "initial",
    compositeId: "localization-download-merge-notify",
  });
  assert.equal(composite.id, "localization-download-merge-notify");
  assert.equal(composite.default, true);
  assert.deepEqual([...compositeActionIds(composite, { platform: "android", batch: "initial" })], [
    "release-localization:prepare-translation-archive",
    "release-localization:apply-translations",
    "release-localization:commit-localization-changes",
    "release-notification:send-notification",
  ]);
});

test("filters composite workflows by platform and batch scope", () => {
  assert.equal(selectReleaseCompositeWorkflow({
    businessLine: "likee",
    platform: "ios",
    batch: "initial",
    compositeId: "android-channel-packages",
  }), null);
  assert.equal(selectReleaseCompositeWorkflow({
    businessLine: "likee",
    platform: "android",
    batch: "supplemental",
    compositeId: "android-channel-packages",
  })?.id, "android-channel-packages");
  assert.equal(selectReleaseCompositeWorkflow({
    businessLine: "bigolive",
    platform: "android",
    batch: "initial",
    compositeId: "localization-upload-notify",
  }), null);
});

test("rejects duplicate and unknown internal composite Actions", () => {
  const result = validateReleaseWorkflowConfig({
    workflows: [{
      id: "demo",
      businessLines: ["demo"],
      platforms: ["android"],
      batches: ["initial"],
      stages: [{ id: "one", nodes: [{ id: "demo:known" }] }],
    }],
    compositeWorkflows: [{
      id: "demo-composite",
      businessLines: ["demo"],
      platforms: ["android"],
      batches: ["initial"],
      actions: [{ id: "demo:known" }, { id: "demo:known" }, { id: "missing:action" }],
    }],
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /duplicate.*Action/i);
  assert.match(result.errors.join("\n"), /unknown|不存在|未配置/i);
});

test("references default composites from Android and iOS localization and channel stages", () => {
  assert.ok(Array.isArray(compositeWorkflows));
  const android = RELEASE_WORKFLOW_CONFIG.workflows.find((workflow) => workflow.id === "likee-android-release");
  const ios = RELEASE_WORKFLOW_CONFIG.workflows.find((workflow) => workflow.id === "likee-ios-release");
  for (const workflow of [android, ios]) {
    const localization = workflow.stages.find((stage) => stage.id === "localization");
    assert.deepEqual(localization.defaultCompositeIds, ["localization-upload-notify", "localization-download-merge-notify"]);
    assert.deepEqual(localization.compositeIds, localization.defaultCompositeIds);
    const records = workflow.stages.find((stage) => stage.id === "records");
    assert.deepEqual(records.defaultCompositeIds, ["release-summary-record"]);
  }
  const channel = android.stages.find((stage) => stage.id === "channel-packages");
  assert.deepEqual(channel.defaultCompositeIds, ["android-channel-packages"]);
  assert.deepEqual(channel.compositeIds, channel.defaultCompositeIds);
  assert.equal(ios.stages.some((stage) => stage.defaultCompositeIds?.includes("android-channel-packages")), false);
});

test("rejects scope arrays containing blank entries", () => {
  for (const key of ["businessLines", "platforms", "batches"]) {
    const config = {
      workflows: [{ id: "demo", businessLines: ["likee"], platforms: ["android"], batches: ["initial"], stages: [{ id: "one", nodes: [{ id: "x" }] }] }],
    };
    config.workflows[0][key] = [" "];
    const result = validateReleaseWorkflowConfig(config);
    assert.equal(result.valid, false, `${key} blank scope should be rejected`);
    assert.match(result.errors.join("\n"), /scope|范围/i);
  }
});

test("rejects non-array optional node references without throwing", () => {
  const result = validateReleaseWorkflowConfig({
    workflows: [{ id: "demo", businessLines: ["likee"], platforms: ["android"], batches: ["initial"], stages: [{ id: "one", nodes: [{ id: "x" }], optionalNodeIds: 42 }] }],
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /optional|可选/i);
});

test("rejects duplicate workflow IDs and malformed node entries", () => {
  const result = validateReleaseWorkflowConfig({
    workflows: [
      { id: "demo", businessLines: ["likee"], platforms: ["android"], batches: ["initial"], stages: [{ id: "one", nodes: [{ id: "x" }, null] }] },
      { id: "demo", businessLines: ["likee"], platforms: ["ios"], batches: ["initial"], stages: [{ id: "two", nodes: [{ id: "y" }] }] },
    ],
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /duplicate workflow|重复.*workflow/i);
  assert.match(result.errors.join("\n"), /malformed node|节点/i);
});

test("returns null for an unmatched business line or platform", () => {
  assert.equal(selectReleaseWorkflow({ businessLine: "bigolive", platform: "android", batch: "initial" }), null);
  assert.equal(selectReleaseWorkflow({ businessLine: "likee", platform: "windows", batch: "initial" }), null);
});

test("every configured action has a static catalog definition for its workflow scope", async () => {
  const { getReleaseNodes } = await import(`../builtin/web-ui/src/lib/releaseNodeCatalog.js?config-parity=${Date.now()}`);
  for (const workflow of RELEASE_WORKFLOW_CONFIG.workflows) {
    for (const platform of workflow.platforms) {
      const nodes = getReleaseNodes({ businessLine: workflow.businessLines[0], platform, batch: workflow.batches[0] });
      const ids = new Set(nodes.map((node) => node.id));
      assert.equal(ids.has("release-localization:send-upload-notification"), false);
      for (const stage of workflow.stages) {
        if (stage.batches && !stage.batches.includes(workflow.batches[0])) continue;
        for (const node of stage.nodes) assert.ok(ids.has(node.id), `${workflow.id} missing ${node.id}`);
      }
    }
  }
});
