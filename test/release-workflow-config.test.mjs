import test from "node:test";
import assert from "node:assert/strict";

import {
  RELEASE_WORKFLOW_CONFIG,
  selectReleaseWorkflow,
  workflowActionIds,
  compositeWorkflows,
  selectReleaseCompositeWorkflow,
  selectReleaseCompositeForStage,
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
  assert.deepEqual([...compositeActionIds(composite, { businessLine: "likee", platform: "android", batch: "initial" })], [
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

test("compositeActionIds returns no Actions when the composite scope does not match context", () => {
  const androidComposite = compositeWorkflows.find((item) => item.id === "android-channel-packages");
  assert.deepEqual([...compositeActionIds(androidComposite, { businessLine: "likee", platform: "ios", batch: "initial" })], []);
  assert.ok(compositeActionIds(androidComposite, { businessLine: "likee", platform: "android", batch: "initial" }).size > 0);
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

test("selects a default composite by stage and intent without guessing between multiple defaults", () => {
  const stage = RELEASE_WORKFLOW_CONFIG.workflows.find((workflow) => workflow.id === "likee-android-release")
    .stages.find((item) => item.id === "localization");
  assert.equal(selectReleaseCompositeWorkflow({ businessLine: "likee", platform: "android", batch: "initial" }), null);
  assert.equal(selectReleaseCompositeForStage({ businessLine: "likee", platform: "android", batch: "initial", intent: "upload" }, stage)?.id, "localization-upload-notify");
  assert.equal(selectReleaseCompositeForStage({ businessLine: "likee", platform: "android", batch: "initial", intent: "download" }, stage)?.id, "localization-download-merge-notify");
});

test("declares consumed atomic Actions and validates replacement references against the stage", () => {
  const localization = RELEASE_WORKFLOW_CONFIG.workflows.find((workflow) => workflow.id === "likee-ios-release")
    .stages.find((item) => item.id === "localization");
  const upload = compositeWorkflows.find((item) => item.id === "localization-upload-notify");
  assert.deepEqual(upload.consumesAtomicActionIds, ["release-localization:upload-source-file", "release-notification:send-notification"]);
  assert.deepEqual(compositeWorkflows.find((item) => item.id === "localization-download-merge-notify").consumesAtomicActionIds, [
    "release-localization:prepare-translation-archive",
    "release-localization:apply-translations",
    "release-localization:commit-localization-changes",
    "release-notification:send-notification",
  ]);
  assert.deepEqual(compositeWorkflows.find((item) => item.id === "release-summary-record").consumesAtomicActionIds, [
    "release-records:compose-update-summary",
    "release-records:append-release-wiki-row",
  ]);
  assert.deepEqual(compositeWorkflows.find((item) => item.id === "android-channel-packages").consumesAtomicActionIds, [
    "release-channel-packages:plan-channel-packages",
    "release-channel-packages:trigger-channel-packages-batch",
    "release-channel-packages:refresh-channel-package-build",
  ]);
  assert.equal(localization.defaultCompositeIds.includes(upload.id), true);
  const result = validateReleaseWorkflowConfig({
    workflows: [{ id: "demo", businessLines: ["demo"], platforms: ["android"], batches: ["initial"], stages: [{ id: "one", nodes: [{ id: "demo:known" }], compositeIds: ["bad"] }] }],
    compositeWorkflows: [{ id: "bad", businessLines: ["demo"], platforms: ["android"], batches: ["initial"], actions: [{ stepId: "known", id: "demo:known", inputs: {} }], consumesAtomicActionIds: ["missing:action"] }],
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /replacement|consumes|stage|阶段/i);
});

test("declares step input mappings and explicit confirmation/wait boundaries", () => {
  const upload = compositeWorkflows.find((item) => item.id === "localization-upload-notify");
  const uploadStep = upload.actions[0];
  const uploadNotify = upload.actions[1];
  assert.deepEqual(uploadStep.inputs.source_path, { context: "source_path" });
  assert.deepEqual(uploadNotify.inputs.source_record_id, { fromStep: "upload", output: "record_id" });
  assert.deepEqual(uploadNotify.waitFor, { step: "upload", statuses: ["completed", "confirmed"] });
  const download = compositeWorkflows.find((item) => item.id === "localization-download-merge-notify");
  const apply = download.actions.find((item) => item.stepId === "apply");
  assert.equal(apply.requiresConfirmation, true);
  assert.deepEqual(apply.continueOn, ["completed", "confirmed"]);
  assert.deepEqual(apply.waitFor, { step: "prepare", statuses: ["completed", "confirmed"] });
  assert.deepEqual(apply.inputs.prepare_record_id, { fromStep: "prepare", output: "record_id" });
  const commit = download.actions.find((item) => item.stepId === "commit");
  assert.deepEqual(commit.inputs.apply_record_id, { fromStep: "apply", output: "record_id" });
  assert.equal(commit.requiresConfirmation, true);
  assert.deepEqual(commit.continueOn, ["merged", "confirmed"]);
  const notify = download.actions.at(-1);
  assert.deepEqual(notify.inputs.merge_request_url, { fromStep: "commit", output: "operator_url" });
  assert.deepEqual(notify.waitFor, { step: "commit", statuses: ["merged", "confirmed"] });
  const summary = compositeWorkflows.find((item) => item.id === "release-summary-record");
  assert.equal(summary.actions.at(-1).requiresConfirmation, true);
  assert.deepEqual(summary.actions.at(-1).inputs.updates_text, { fromStep: "summary", output: "updates_text" });
  assert.equal(Object.hasOwn(summary.actions.at(-1).inputs, "digest_record_id"), false);
  assert.deepEqual(summary.actions.at(-1).waitFor, { step: "summary", statuses: ["confirmed"] });
});

test("declares the six-item Android channel package fan-out", () => {
  const channels = compositeWorkflows.find((item) => item.id === "android-channel-packages");
  assert.equal(channels.expectedCount, 6);
  assert.equal(channels.actions.find((item) => item.stepId === "trigger").requiresConfirmation, true);
  assert.deepEqual(channels.actions.at(-1).forEach, { source: "planned_items", expectedCount: 6, itemInput: "item_id" });
});

test("rejects composites whose scope does not intersect the referenced workflow stage", () => {
  const result = validateReleaseWorkflowConfig({
    workflows: [{ id: "demo", businessLines: ["demo"], platforms: ["ios"], batches: ["initial"], stages: [{ id: "one", nodes: [{ id: "demo:known" }], compositeIds: ["android-only"] }] }],
    compositeWorkflows: [{ id: "android-only", businessLines: ["demo"], platforms: ["android"], batches: ["initial"], actions: [{ id: "demo:known", inputs: {} }] }],
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /scope|范围|intersect|交集/i);
});

test("rejects a composite Action whose workflow scope does not cover the composite scope", () => {
  const result = validateReleaseWorkflowConfig({
    workflows: [{ id: "other-android", businessLines: ["other"], platforms: ["android"], batches: ["initial"], stages: [{ id: "one", nodes: [{ id: "other:action" }], compositeIds: ["likee-ios"] }] }],
    compositeWorkflows: [{ id: "likee-ios", businessLines: ["likee"], platforms: ["ios"], batches: ["initial"], stageIds: ["one"], actions: [{ stepId: "action", id: "other:action", inputs: {} }] }],
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /Action.*scope|作用域|workflow/i);
});

test("rejects a stage composite reference when composite stageIds omit the current stage", () => {
  const result = validateReleaseWorkflowConfig({
    workflows: [{ id: "demo", businessLines: ["demo"], platforms: ["android"], batches: ["initial"], stages: [{ id: "one", nodes: [{ id: "demo:action" }], compositeIds: ["composite"] }] }],
    compositeWorkflows: [{ id: "composite", businessLines: ["demo"], platforms: ["android"], batches: ["initial"], stageIds: ["two"], actions: [{ stepId: "action", id: "demo:action", inputs: {} }] }],
  });
  assert.equal(result.valid, false);
  assert.match(result.errors.join("\n"), /stageIds|stage|阶段/i);
});

test("exposes normalized internal status aliases for composite waits", () => {
  assert.deepEqual(RELEASE_WORKFLOW_CONFIG.statusAliases, {
    succeeded: "completed",
    managed_mr_merged: "merged",
  });
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
