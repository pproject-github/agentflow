import test from "node:test";
import assert from "node:assert/strict";

import {
  RELEASE_WORKFLOW_CONFIG,
  selectReleaseWorkflow,
  workflowActionIds,
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
  assert.equal(Object.isFrozen(RELEASE_WORKFLOW_CONFIG.workflows[0].stages), true);
  assert.equal(Object.isFrozen(RELEASE_WORKFLOW_CONFIG.workflows[0].stages[0].nodes), true);
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
