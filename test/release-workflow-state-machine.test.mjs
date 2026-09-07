import assert from "node:assert/strict";
import test from "node:test";

import {
  createReleaseProcessStateMachine,
  deriveProcessStates,
  deriveWorkflowCursor,
  recommendNextProcessNodes,
  selectWorkflowProcessNodes,
  createSupplementalBatch,
} from "../builtin/web-ui/src/lib/releaseWorkflowStateMachine.js";
import { RELEASE_WORKFLOW_CONFIG, selectReleaseWorkflow, workflowActionIds } from "../shared/release-workflow-config.js";

const initialContext = {
  businessLine: "likee", platform: "android", version: "5.63.2", batch: "initial", batchIndex: 0,
};
const supplementalContext = { ...initialContext, version: "5.63.1", batch: "supplemental", batchIndex: 1 };

function node(id, context = initialContext, extra = {}) {
  return {
    id,
    title: id,
    skill: "release-agent",
    businessLines: [context.businessLine],
    platforms: [context.platform],
    contextSnapshot: { ...context },
    ...extra,
  };
}

function machine(context = initialContext, ids) {
  const workflow = selectReleaseWorkflow(context) || RELEASE_WORKFLOW_CONFIG.workflows[0];
  const resolvedIds = ids || workflowActionIds(workflow, context);
  return createReleaseProcessStateMachine({
    context,
    nodes: [...resolvedIds].map((id) => node(id, context)),
  });
}

test("groups configured capability nodes into ordered stages", () => {
  const stateMachine = machine(initialContext, [
    "localization-upload-notify", "create-release-branch", "localization-download-merge-notify", "build-package",
  ]);
  assert.deepEqual(stateMachine.processes.map((process) => process.id), ["entry", "localization", "build"]);
  assert.deepEqual(stateMachine.processes[0].nodeIds, ["localization-upload-notify", "create-release-branch"]);
  assert.equal(stateMachine.nodeToProcess.get("localization-download-merge-notify"), "localization");
});

test("uses the same Likee Android workflow for initial and supplemental batches", () => {
  assert.equal(machine(initialContext).workflow.id, "likee-android-release");
  assert.equal(machine(supplementalContext).workflow.id, "likee-android-release");
  assert.deepEqual(machine(supplementalContext).processes.map((process) => process.id), [
    "entry", "build", "publish", "rollout", "full-rollout",
  ]);
});

test("supplemental entry recommends start-supplemental-release-notify after initialization", () => {
  const stateMachine = machine(supplementalContext);
  assert.deepEqual(recommendNextProcessNodes({
    machine: stateMachine,
    timeline: [{ nodeId: "release-initialization", status: "completed", contextPreparationStatus: "deferred" }],
    pending: [],
  }).map((item) => item.id), ["start-supplemental-release-notify"]);
});

test("supplemental entry remains executable when the platform timeline has no history", () => {
  const stateMachine = machine(supplementalContext);
  assert.deepEqual(recommendNextProcessNodes({
    machine: stateMachine,
    timeline: [],
    pending: [],
  }).map((item) => item.id), ["start-supplemental-release-notify"]);
});

test("creating a supplemental batch keeps the major-version timeline and advances the minor version", () => {
  const completedInitial = { id: "initial-build", nodeId: "build-package", status: "completed" };
  const next = createSupplementalBatch({
    context: initialContext,
    timeline: [completedInitial],
    pending: [],
    runs: { old: { status: "completed" } },
  });
  assert.equal(next.context.version, "5.63.1");
  assert.equal(next.context.batch, "supplemental");
  assert.deepEqual(next.state.timeline, [completedInitial]);

  const nextAgain = createSupplementalBatch({ context: next.context, timeline: next.state.timeline, pending: [] });
  assert.equal(nextAgain.context.version, "5.63.2");
  assert.equal(nextAgain.context.batchIndex, 2);
});

test("uses Likee iOS workflow without rollout for initial and supplemental batches", () => {
  const iosInitial = { businessLine: "likee", platform: "ios", version: "5.63.2", batch: "initial", batchIndex: 0 };
  const iosSupplemental = { ...iosInitial, batch: "supplemental", batchIndex: 1 };
  assert.equal(machine(iosInitial).workflow.id, "likee-ios-release");
  assert.equal(machine(iosSupplemental).workflow.id, "likee-ios-release");
  assert.deepEqual(machine(iosInitial).processes.map((process) => process.id), [
    "entry", "localization", "merge-master", "build", "approval", "publish", "full-rollout",
  ]);
  assert.deepEqual(machine(iosSupplemental).processes.map((process) => process.id), [
    "entry", "build", "publish", "full-rollout",
  ]);
  const transitions = machine(iosInitial).workflow.transitions;
  assert.ok(transitions.some((item) => item.from === "publish" && item.to === "create_supplemental_batch"));
  assert.ok(transitions.some((item) => item.from === "full-rollout" && item.to === "create_supplemental_batch"));
  assert.equal(transitions.some((item) => item.from === "rollout"), false);
});

test("recommends the next capability within the current stage before advancing", () => {
  const stateMachine = machine(initialContext, ["localization-upload-notify", "create-release-branch", "localization-download-merge-notify"]);
  assert.deepEqual(recommendNextProcessNodes({ machine: stateMachine, timeline: [], pending: [] }).map((item) => item.id), [
    "localization-upload-notify",
  ]);
  assert.deepEqual(recommendNextProcessNodes({
    machine: stateMachine,
    timeline: [{ nodeId: "localization-upload-notify", status: "completed" }],
    pending: [],
  }).map((item) => item.id), ["create-release-branch"]);
  assert.deepEqual(recommendNextProcessNodes({
    machine: stateMachine,
    timeline: [
      { nodeId: "localization-upload-notify", status: "completed" },
      { nodeId: "create-release-branch", status: "completed" },
    ],
    pending: [],
  }).map((item) => item.id), ["localization-download-merge-notify"]);
});

test("does not advance while a capability is running or failed; waiting counts as success", () => {
  const stateMachine = machine(initialContext, ["localization-upload-notify", "create-release-branch"]);
  for (const status of ["running", "failed"]) {
    const recommendations = recommendNextProcessNodes({
      machine: stateMachine,
      timeline: [{ nodeId: "localization-upload-notify", status }],
      pending: [],
    });
    assert.deepEqual(recommendations, [], status);
  }
  // waiting = 人工闸说明项，按成功完成推进下一节点
  assert.deepEqual(recommendNextProcessNodes({
    machine: stateMachine,
    timeline: [{ nodeId: "localization-upload-notify", status: "waiting" }],
    pending: [],
  }).map((item) => item.id), ["create-release-branch"]);
  assert.equal(deriveProcessStates({
    machine: stateMachine,
    timeline: [
      { nodeId: "localization-upload-notify", status: "waiting" },
      { nodeId: "create-release-branch", status: "completed" },
    ],
    pending: [],
  }).get("entry"), "completed");
  assert.equal(deriveProcessStates({
    machine: stateMachine,
    timeline: [{ nodeId: "localization-upload-notify", status: "failed" }],
    pending: [],
  }).get("entry"), "failed");
});

test("maps custom instance and composite aliases onto capability status", () => {
  const stateMachine = createReleaseProcessStateMachine({
    context: initialContext,
    nodes: [
      node("composite:localization-download-merge-notify", initialContext, {
        kind: "composite",
        compositeId: "localization-download-merge-notify",
      }),
    ],
  });
  assert.ok(stateMachine.processes.find((process) => process.id === "localization"));

  // custom waiting 视为该能力已成功完成
  assert.equal(deriveProcessStates({
    machine: stateMachine,
    timeline: [],
    pending: [{
      nodeId: "custom-composite:localization-download-merge-notify-abc",
      sourcePresetId: "composite:localization-download-merge-notify",
      compositeId: "localization-download-merge-notify",
      status: "waiting",
    }],
  }).get("localization"), "completed");

  assert.equal(deriveProcessStates({
    machine: stateMachine,
    timeline: [{ nodeId: "composite:localization-download-merge-notify", status: "completed" }],
    pending: [],
  }).get("localization"), "completed");
});

test("treats completed timeline as authoritative over stale pending state", () => {
  const stateMachine = machine(initialContext, ["localization-upload-notify", "create-release-branch"]);
  const states = deriveProcessStates({
    machine: stateMachine,
    timeline: [{ nodeId: "localization-upload-notify", status: "completed" }],
    pending: [{ nodeId: "localization-upload-notify", status: "running" }],
  });
  assert.equal(states.get("entry"), "pending");
  assert.deepEqual(recommendNextProcessNodes({
    machine: stateMachine,
    timeline: [{ nodeId: "localization-upload-notify", status: "completed" }, { nodeId: "create-release-branch", status: "completed" }],
    pending: [],
  }), []);
});

test("exposes configured rollout and full-rollout supplemental transitions", () => {
  const transitions = machine().workflow.transitions;
  assert.ok(transitions.some((item) => item.from === "rollout" && item.to === "create_supplemental_batch"));
  assert.ok(transitions.some((item) => item.from === "full-rollout" && item.to === "create_supplemental_batch"));
  assert.ok(transitions.every((item) => item.repeatable === true));
});

test("custom selection only exposes current workflow capability nodes", () => {
  const stateMachine = machine(initialContext, ["localization-upload-notify", "create-release-branch"]);
  const selected = selectWorkflowProcessNodes({
    machine: stateMachine,
    nodes: [
      node("localization-upload-notify"),
      node("create-release-branch"),
      node("unknown-capability"),
      node("create-release-branch", initialContext, { id: "create-release-branch" }),
    ],
  });
  assert.deepEqual(selected.map((item) => item.id), ["localization-upload-notify", "create-release-branch"]);
  assert.ok(selected.every((item) => item.workflowId === "likee-android-release"));
});

test("filters nodes from another context and removes retired initialization capabilities", () => {
  const stateMachine = createReleaseProcessStateMachine({
    context: initialContext,
    nodes: [
      node("localization-upload-notify"),
      node("localization-upload-notify", { ...initialContext, version: "other" }),
      node("release-management:guide-current-release"),
      node("release-management:create-active-release"),
    ],
  });
  assert.deepEqual(stateMachine.nodes.map((item) => item.id), ["localization-upload-notify"]);
});

test("uses a caller-supplied capability workflow for recommendations", () => {
  const config = {
    capabilities: [{
      id: "custom-capability", title: "Custom", description: "Custom", businessLines: ["demo"], platforms: ["android"],
      batches: ["initial"], stageId: "custom-stage", skillHints: ["release-demo"], inputs: [], outputs: [],
      promptTemplate: "businessLine=${businessLine}",
    }],
    workflows: [{
      id: "custom-workflow", title: "Custom", businessLines: ["demo"], platforms: ["android"], batches: ["initial"],
      entryStageIds: ["custom-stage"], stages: [{ id: "custom-stage", title: "Custom", nodes: [{ id: "custom-capability" }] }],
    }],
  };
  const context = { businessLine: "demo", platform: "android", version: "1.0.0", batch: "initial" };
  const stateMachine = createReleaseProcessStateMachine({ context, config, nodes: [node("custom-capability", context)] });
  assert.equal(stateMachine.workflow.id, "custom-workflow");
  assert.deepEqual(recommendNextProcessNodes({ machine: stateMachine, timeline: [], pending: [] }).map((item) => item.id), ["custom-capability"]);
});
