import assert from "node:assert/strict";
import test from "node:test";

import {
  createReleaseProcessStateMachine,
  deriveProcessStates,
  deriveWorkflowCursor,
  recommendNextProcessNodes,
  selectWorkflowProcessNodes,
} from "../builtin/web-ui/src/lib/releaseWorkflowStateMachine.js";
import { RELEASE_WORKFLOW_CONFIG, selectReleaseWorkflow, workflowActionIds } from "../shared/release-workflow-config.js";

const context = {
  businessLine: "likee",
  platform: "android",
  version: "5.63.2",
  batch: "initial",
};
const androidSupplementalContext = {
  businessLine: "likee",
  platform: "android",
  version: "5.63.1",
  batch: "supplemental",
};

function node(id, processId, processOrder, extra = {}) {
  return {
    id,
    skill: id.split(":")[0],
    action: id.split(":")[1],
    processId,
    processOrder,
    businessLines: ["likee"],
    platforms: ["android"],
    contextSnapshot: { ...context },
    ...extra,
  };
}

function machine() {
  return createReleaseProcessStateMachine({
    context,
    nodes: [
      node("release-localization:upload-source-file", "localization", 10),
      node("release-localization:prepare-translation-archive", "localization", 20),
      node("release-approval:create-initial-release-approval", "approval", 10),
    ],
  });
}

test("groups release actions into ordered process stages", () => {
  const stateMachine = machine();

  assert.deepEqual(stateMachine.processes.map((process) => process.id), ["localization", "approval-initial"]);
  assert.deepEqual(stateMachine.processes[0].nodeIds, [
    "release-localization:upload-source-file",
    "release-localization:prepare-translation-archive",
  ]);
  assert.equal(stateMachine.nodeToProcess.get("release-approval:create-initial-release-approval"), "approval-initial");
});

test("recommends the next node within an incomplete process", () => {
  const stateMachine = machine();
  const recommendations = recommendNextProcessNodes({
    machine: stateMachine,
    timeline: [{ nodeId: "release-localization:upload-source-file", status: "completed" }],
    pending: [],
  });

  assert.deepEqual(recommendations.map((node) => node.id), ["release-localization:prepare-translation-archive"]);
});

test("moves to the next process only after every node in the current process completes", () => {
  const stateMachine = machine();
  const recommendations = recommendNextProcessNodes({
    machine: stateMachine,
    timeline: [
      { nodeId: "release-localization:upload-source-file", status: "completed" },
      { nodeId: "release-localization:prepare-translation-archive", status: "completed" },
    ],
    pending: [],
  });

  assert.deepEqual(recommendations.map((node) => node.id), ["release-approval:create-initial-release-approval"]);
});

test("does not advance a process while a node is running or failed", () => {
  const stateMachine = machine();

  assert.deepEqual(recommendNextProcessNodes({
    machine: stateMachine,
    timeline: [{ nodeId: "release-localization:upload-source-file", status: "completed" }],
    pending: [{ nodeId: "release-localization:prepare-translation-archive", status: "running" }],
  }), []);

  const states = deriveProcessStates({
    machine: stateMachine,
    timeline: [{ nodeId: "release-localization:upload-source-file", status: "failed" }],
    pending: [],
  });
  assert.equal(states.get("localization"), "failed");
});

test("treats runtime terminal statuses as completed and keeps completed timeline authoritative", () => {
  const stateMachine = machine();
  const states = deriveProcessStates({
    machine: stateMachine,
    timeline: [{ nodeId: "release-localization:upload-source-file", status: "succeeded" }],
    pending: [{ nodeId: "release-localization:upload-source-file", status: "running" }],
  });
  assert.equal(states.get("localization"), "pending");
  assert.deepEqual(recommendNextProcessNodes({
    machine: stateMachine,
    timeline: [
      { nodeId: "release-localization:upload-source-file", status: "succeeded" },
      { nodeId: "release-localization:prepare-translation-archive", status: "skipped" },
    ],
    pending: [],
  }).map((node) => node.id), ["release-approval:create-initial-release-approval"]);
});

test("excludes nodes outside the selected context", () => {
  const stateMachine = createReleaseProcessStateMachine({
    context,
    nodes: [
      node("release-localization:upload-source-file", "localization", 10),
      node("release-approval:create-full-rollout-approval", "approval", 10, {
        contextSnapshot: { ...context, version: "5.63.1" },
      }),
    ],
  });

  assert.deepEqual(recommendNextProcessNodes({
    machine: stateMachine,
    timeline: [{ nodeId: "release-localization:upload-source-file", status: "completed" }],
    pending: [],
  }).map((node) => node.id), []);
});

test("does not expose executable processes for an unmatched business line", () => {
  const stateMachine = createReleaseProcessStateMachine({
    context: { businessLine: "bigolive", platform: "android", version: "5.63.2", batch: "initial" },
    nodes: [{
      id: "release-approval:create-full-rollout-approval",
      skill: "release-approval",
      action: "create-full-rollout-approval",
      businessLines: ["bigolive"],
      platforms: ["android"],
      contextSnapshot: { businessLine: "bigolive", platform: "android", version: "5.63.2", batch: "initial" },
    }],
  });
  assert.equal(stateMachine.workflow, null);
  assert.deepEqual(stateMachine.processes, []);
  assert.deepEqual(stateMachine.nodes, []);
});

test("selects the history-derived workflow for the current platform and batch", () => {
  const stateMachine = createReleaseProcessStateMachine({
    context: { businessLine: "likee", platform: "android", version: "5.63.1", batch: "supplemental" },
    nodes: [
      node("release-management:append-release-batch", "preparation", 10, { contextSnapshot: { ...androidSupplementalContext } }),
      node("release-records:compose-update-summary", "records", 10, { contextSnapshot: { ...androidSupplementalContext } }),
      node("release-approval:create-full-rollout-approval", "approval", 10, { contextSnapshot: { ...androidSupplementalContext } }),
      node("release-channel-packages:plan-channel-packages", "channel-packages", 10, { contextSnapshot: { ...androidSupplementalContext } }),
    ],
  });

  assert.equal(stateMachine.workflow.id, "likee-android-release");
  assert.deepEqual(stateMachine.processes.map((process) => process.id), ["preparation-supplemental", "records-summary", "approval-full", "channel-packages"]);
  assert.equal(stateMachine.processes.find((process) => process.id === "metrics"), undefined);
});

test("uses one Android workflow while selecting only the initial batch stages", () => {
  const stateMachine = createReleaseProcessStateMachine({
    context,
    nodes: [
      node("release-management:append-release-batch", "preparation", 10, { contextSnapshot: { ...context } }),
      node("release-localization:upload-source-file", "localization", 10),
      node("release-approval:create-initial-release-approval", "approval", 10),
      node("release-approval:create-full-rollout-approval", "approval", 20),
    ],
  });

  assert.equal(stateMachine.workflow.id, "likee-android-release");
  assert.deepEqual(stateMachine.processes.map((process) => process.id), ["localization", "approval-initial", "approval-full"]);
  assert.equal(stateMachine.processes.find((process) => process.id === "preparation-supplemental"), undefined);
});

test("uses one Android workflow while selecting only the supplemental batch stages", () => {
  const stateMachine = createReleaseProcessStateMachine({
    context: androidSupplementalContext,
    nodes: [
      node("release-management:append-release-batch", "preparation", 10, { contextSnapshot: { ...androidSupplementalContext } }),
      node("release-localization:upload-source-file", "localization", 10, { contextSnapshot: { ...androidSupplementalContext } }),
      node("release-approval:create-full-rollout-approval", "approval", 20, { contextSnapshot: { ...androidSupplementalContext } }),
    ],
  });

  assert.equal(stateMachine.workflow.id, "likee-android-release");
  assert.deepEqual(stateMachine.processes.map((process) => process.id), ["preparation-supplemental", "approval-full"]);
  assert.equal(stateMachine.processes.find((process) => process.id === "localization"), undefined);
  assert.equal(stateMachine.processes.find((process) => process.id === "approval-initial"), undefined);
});

test("custom selection exposes only nodes in the current workflow stages", () => {
  const stateMachine = createReleaseProcessStateMachine({
    context,
    nodes: [
      node("release-localization:upload-source-file", "localization", 10),
      node("release-approval:create-initial-release-approval", "approval", 10),
      node("release-management:append-release-batch", "preparation", 10),
    ],
  });
  const options = selectWorkflowProcessNodes({
    machine: stateMachine,
    nodes: [...stateMachine.nodes, { ...stateMachine.nodes[0], title: "重复入口" }],
  });

  assert.deepEqual(options.map((item) => item.id), [
    "release-localization:upload-source-file",
    "release-approval:create-initial-release-approval",
  ]);
  assert.deepEqual(options.map((item) => item.workflowProcessId), ["localization", "approval-initial"]);
  assert.equal(options.some((item) => item.id === "release-management:append-release-batch"), false);
});

test("removes guide-current-release after initialization", () => {
  const stateMachine = createReleaseProcessStateMachine({
    context,
    nodes: [
      node("release-management:guide-current-release", "preparation", 10),
      node("release-management:create-active-release", "preparation", 20),
      node("release-git:create-release-branch", "preparation", 60),
    ],
  });

  assert.equal(stateMachine.processes.flatMap((process) => process.nodeIds).includes("release-management:guide-current-release"), false);
  assert.equal(selectWorkflowProcessNodes({ machine: stateMachine, nodes: stateMachine.nodes })
    .some((item) => item.id === "release-management:guide-current-release"), false);
});

test("removes create-active-release after initialization", () => {
  const stateMachine = createReleaseProcessStateMachine({
    context,
    nodes: [
      node("release-management:create-active-release", "preparation", 20),
      node("release-git:create-release-branch", "preparation", 60),
    ],
  });

  assert.equal(stateMachine.processes.flatMap((process) => process.nodeIds).includes("release-management:create-active-release"), false);
  assert.equal(selectWorkflowProcessNodes({ machine: stateMachine, nodes: stateMachine.nodes })
    .some((item) => item.id === "release-management:create-active-release"), false);
});

test("does not recommend optional supplemental metrics before the observed gray stage", () => {
  const context = androidSupplementalContext;
  const stateMachine = createReleaseProcessStateMachine({
    context,
    nodes: [
      node("release-management:append-release-batch", "preparation", 10, { contextSnapshot: { ...context } }),
      node("release-management:update-active-release", "preparation", 20, { contextSnapshot: { ...context } }),
      node("release-records:compose-update-summary", "records", 10, { contextSnapshot: { ...context } }),
      node("release-metrics:query-version-metrics", "metrics", 10, { contextSnapshot: { ...context } }),
      node("release-metrics:save-metrics-snapshot", "metrics", 20, { contextSnapshot: { ...context } }),
      node("release-gray-observe:observe-gray-dashboard", "gray-observe", 10, { contextSnapshot: { ...context } }),
    ],
  });
  const recommendations = recommendNextProcessNodes({
    machine: stateMachine,
    timeline: [
      { nodeId: "release-management:append-release-batch", status: "completed" },
      { nodeId: "release-management:update-active-release", status: "completed" },
      { nodeId: "release-records:compose-update-summary", status: "completed" },
    ],
    pending: [],
  });
  assert.deepEqual(recommendations.map((item) => item.id), ["release-gray-observe:observe-gray-dashboard"]);
});

test("exposes the current workflow stage and transition cursor", () => {
  const stateMachine = createReleaseProcessStateMachine({
    context,
    nodes: [
      node("release-localization:upload-source-file", "localization", 10),
      node("release-localization:prepare-translation-archive", "localization", 20),
      node("release-approval:create-initial-release-approval", "approval", 10),
    ],
  });
  const cursor = deriveWorkflowCursor({
    machine: stateMachine,
    timeline: [{ nodeId: "release-localization:upload-source-file", status: "completed" }],
    pending: [],
  });
  assert.equal(cursor.workflowId, "likee-android-release");
  assert.equal(cursor.currentProcessId, "localization");
  assert.equal(cursor.currentState, "pending");
  assert.equal(cursor.nextProcessId, "approval-initial");
});

test("uses the selected config for recommendations and custom candidates", () => {
  const workflow = selectReleaseWorkflow(context, {
    ...RELEASE_WORKFLOW_CONFIG,
    workflows: RELEASE_WORKFLOW_CONFIG.workflows.map((item) => ({
      ...item,
      stages: item.stages.map((stage) => ({
        ...stage,
        nodes: stage.nodes.filter((entry) => entry.id !== "release-git:create-release-branch"),
      })),
    })),
  });
  const stateMachine = createReleaseProcessStateMachine({
    context,
    config: { ...RELEASE_WORKFLOW_CONFIG, workflows: [workflow] },
    nodes: [
      node("release-git:create-release-branch", "preparation", 60),
      node("release-management:register-release-branch", "preparation", 40),
      node("release-localization:upload-source-file", "localization", 10),
    ],
  });

  assert.equal(stateMachine.workflow.id, workflow.id);
  assert.equal(stateMachine.nodes.some((item) => item.id === "release-git:create-release-branch"), false);
  assert.equal(selectWorkflowProcessNodes({ machine: stateMachine, nodes: stateMachine.nodes })
    .some((item) => item.id === "release-git:create-release-branch"), false);
  assert.deepEqual(recommendNextProcessNodes({ machine: stateMachine, timeline: [], pending: [] }).map((item) => item.id), [
    "release-management:register-release-branch",
  ]);
});

test("keeps Android-only configured nodes out of the iOS candidate set", () => {
  const iosWorkflow = selectReleaseWorkflow({ businessLine: "likee", platform: "ios", batch: "initial" });
  const androidOnlyId = "release-channel-packages:trigger-channel-packages-batch";
  const config = {
    ...RELEASE_WORKFLOW_CONFIG,
    workflows: RELEASE_WORKFLOW_CONFIG.workflows.map((item) => item.id === iosWorkflow.id
      ? { ...item, stages: item.stages.map((stage) => ({ ...stage, nodes: [...stage.nodes, { id: androidOnlyId }] })) }
      : item),
  };
  const stateMachine = createReleaseProcessStateMachine({
    context: { businessLine: "likee", platform: "ios", version: "5.63.2", batch: "initial" },
    config,
    nodes: [
      node("release-release-notes:upload-ios-release-notes", "store", 10, { platforms: ["ios"], contextSnapshot: { businessLine: "likee", platform: "ios", version: "5.63.2", batch: "initial" } }),
      node(androidOnlyId, "channel-packages", 30, { platforms: ["android"], contextSnapshot: { businessLine: "likee", platform: "android", version: "5.63.2", batch: "initial" } }),
    ],
  });

  assert.equal(selectWorkflowProcessNodes({ machine: stateMachine, nodes: stateMachine.nodes })
    .some((item) => item.id === androidOnlyId), false);
});

test("matches machine process and candidate action order with shared config", () => {
  const stateMachine = createReleaseProcessStateMachine({
    context,
    nodes: [
      node("release-localization:upload-source-file", "localization", 10),
      node("release-localization:send-upload-notification", "localization", 20),
      node("release-approval:create-initial-release-approval", "approval", 10),
    ],
  });
  const workflow = selectReleaseWorkflow(context);
  const configuredIds = [...workflowActionIds(workflow, context)];
  const machineIds = stateMachine.processes.flatMap((process) => process.nodeIds);
  assert.equal(stateMachine.workflow.id, workflow.id);
  assert.deepEqual(machineIds, configuredIds.filter((id) => machineIds.includes(id)));
  assert.deepEqual(selectWorkflowProcessNodes({ machine: stateMachine, nodes: stateMachine.nodes }).map((item) => item.id), machineIds);
});

test("uses the same canonical stage references as workflowActionIds", () => {
  const config = {
    ...RELEASE_WORKFLOW_CONFIG,
    workflows: [{
      ...RELEASE_WORKFLOW_CONFIG.workflows[0],
      stages: [{
        id: "canonical-stage",
        title: "Canonical",
        nodes: [{ id: "canonical:action" }],
        nodeIds: ["legacy:action"],
      }],
    }],
  };
  const stateMachine = createReleaseProcessStateMachine({
    context,
    config,
    nodes: [
      node("canonical:action", "other", 10),
      node("legacy:action", "other", 20),
    ],
  });
  assert.deepEqual([...workflowActionIds(config.workflows[0], context)], ["canonical:action"]);
  assert.deepEqual(stateMachine.processes[0].nodeIds, ["canonical:action"]);
});
