import assert from "node:assert/strict";
import test from "node:test";

test("builds an AgentFlow tool graph for a release action without embedding raw input in code", async () => {
  const { buildReleaseRunGraph } = await import("../bin/lib/release-runtime-executor.mjs");
  const graph = buildReleaseRunGraph({
    id: "release-google-play:preview-aab-submission",
    skill: "release-google-play",
    action: "preview-aab-submission",
    source: { skillRoot: "/tmp/release-skills", scriptPath: "/tmp/release-skills/skills/release-google-play/scripts/run.py" },
  }, { businessLine: "likee", platform: "android", version: "5.63.2" }, { config: "a; rm -rf /" });
  const instance = graph.instances.release_action;
  assert.equal(instance.definitionId, "tool_nodejs");
  assert.match(instance.script, /uv run python/);
  assert.match(instance.script, /--action/);
  assert.match(instance.script, /cwd=/);
  assert.match(instance.script, /tmp\/release-skills/);
  assert.doesNotMatch(instance.script, /rm -rf/);
  assert.equal(graph.meta.releaseActionId, "release-google-play:preview-aab-submission");
});

test("requires a fresh confirmation fingerprint for external release actions", async () => {
  const { confirmationFingerprint, runReleaseAction, previewReleaseAction } = await import("../bin/lib/release-runtime-executor.mjs");
  const action = { id: "release-records:append-release-wiki-row", action: "append-release-wiki-row", requiresConfirmation: true, source: { scriptPath: "/tmp/run.py" } };
  const context = { businessLine: "likee", platform: "android", version: "5.63.2" };
  const inputs = { gray_percent: 10 };
  const preview = await previewReleaseAction(action, context, inputs);
  assert.equal(preview.confirmationFingerprint, confirmationFingerprint(action, context, inputs));
  await assert.rejects(
    () => runReleaseAction(action, context, { gray_percent: 20 }, { confirmationFingerprint: preview.confirmationFingerprint }),
    (error) => error.code === "RELEASE_CONFIRMATION_MISMATCH",
  );
});

test("routes release notifications to the debug bot only in local release test mode", async () => {
  const { buildReleaseRunGraph } = await import("../bin/lib/release-runtime-executor.mjs?notification-test-mode");
  const graph = buildReleaseRunGraph({
    id: "release-notification:send-notification",
    skill: "release-notification",
    action: "send-notification",
    source: { skillRoot: "/tmp/release-skills", scriptPath: "/tmp/release-skills/skills/release-notification/scripts/run.py" },
  });
  assert.match(graph.instances.release_action.script, /AGENTFLOW_RELEASE_TEST_MODE/);
  assert.match(graph.instances.release_action.script, /target.*debug/);
  assert.match(graph.instances.release_action.script, /bot.*debug/);
});

test("release execution inputs include immutable context aliases used by release skills", async () => {
  const { releaseExecutionInputs } = await import("../bin/lib/release-runtime-executor.mjs?context-inputs");
  const inputs = releaseExecutionInputs(
    { skill: "release-git", action: "create-release-branch" },
    { businessLine: "likee", platform: "android", version: "5.63.2", batch: "initial" },
    { release_branch: "release/5.63" },
  );
  assert.deepEqual(inputs, {
    release_branch: "release/5.63",
    product: "likee",
    platform: "android",
    minor_version: "5.63.2",
  });
});

test("compiles composite release workflow into ordered AgentFlow tool nodes with mapped inputs", async () => {
  const { buildCompositeReleaseRunGraph } = await import("../bin/lib/release-runtime-executor.mjs?composite-graph");
  const composite = {
    id: "localization-upload-notify",
    title: "多语言上传 & 通知",
    actions: [
      { stepId: "upload", id: "release-localization:upload-source-file", inputs: { source_path: { context: "source_path" } }, continueOn: ["completed"] },
      { stepId: "notify", id: "release-notification:send-notification", inputs: { event: "localization-uploaded", source_record_id: { fromStep: "upload", output: "record_id" } }, waitFor: { step: "upload", statuses: ["completed"] } },
    ],
  };
  const nodes = [
    { id: "release-localization:upload-source-file", skill: "release-localization", action: "upload-source-file", title: "Upload", source: { skillRoot: "/tmp/release-skills", scriptPath: "/tmp/upload.py" } },
    { id: "release-notification:send-notification", skill: "release-notification", action: "send-notification", title: "Notify", source: { skillRoot: "/tmp/release-skills", scriptPath: "/tmp/notify.py" } },
  ];
  const graph = buildCompositeReleaseRunGraph(composite, nodes, { businessLine: "likee", platform: "android", version: "5.63.2", batch: "initial" }, { source_path: "/tmp/source.yml" });
  assert.deepEqual(Object.keys(graph.instances), ["composite_upload", "composite_notify"]);
  assert.deepEqual(graph.meta.compositeActionIds, ["release-localization:upload-source-file", "release-notification:send-notification"]);
  assert.equal(graph.instances.composite_upload.definitionId, "tool_nodejs");
  assert.equal(graph.instances.composite_notify.input.find((slot) => slot.name === "event").value, "localization-uploaded");
  assert.equal(graph.edges.filter((edge) => edge.source === "composite_upload" && edge.target === "composite_notify").length, 2);
  assert.ok(graph.edges.some((edge) => edge.sourceHandle === "output-2" && edge.targetHandle === "input-2"));
  assert.equal(graph.instances.composite_notify.compositeStep.waitFor.step, "upload");
  assert.equal(graph.instances.composite_notify.compositeStep.waitFor.statuses[0], "completed");
});

test("composite confirmation fingerprint changes when internal action order changes", async () => {
  const { confirmationFingerprint } = await import("../bin/lib/release-runtime-executor.mjs?composite-fingerprint");
  const context = { businessLine: "likee", platform: "android", version: "5.63.2", batch: "initial" };
  const first = { id: "composite:demo", kind: "composite", actions: [{ id: "a" }, { id: "b" }] };
  const second = { id: "composite:demo", kind: "composite", actions: [{ id: "b" }, { id: "a" }] };
  assert.notEqual(confirmationFingerprint(first, context, { x: 1 }), confirmationFingerprint(second, context, { x: 1 }));
});

test("previewReleaseAction returns a non-executing composite graph and confirmation fingerprint", async () => {
  const { previewReleaseAction } = await import("../bin/lib/release-runtime-executor.mjs?composite-preview");
  const action = {
    id: "composite:demo",
    kind: "composite",
    compositeId: "demo",
    actions: [{ stepId: "one", id: "release-git:create-release-branch", source: { skillRoot: "/tmp", scriptPath: "/tmp/run.py" }, skill: "release-git", action: "create-release-branch", inputSchema: [] }],
  };
  const result = await previewReleaseAction(action, { businessLine: "likee", platform: "android", version: "1.0.0", batch: "initial" }, {});
  assert.equal(result.graph.meta.compositeId, "demo");
  assert.equal(result.graph.instances.composite_one.definitionId, "tool_nodejs");
  assert.ok(result.confirmationFingerprint);
});
