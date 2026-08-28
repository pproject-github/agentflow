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
