import assert from "node:assert/strict";
import test from "node:test";
import { RELEASE_WORKFLOW_CONFIG } from "../shared/release-workflow-config.js";

test("localization upload capability delegates file discovery to release-localization Skill", () => {
  const capability = RELEASE_WORKFLOW_CONFIG.capabilities.find((item) => item.id === "localization-upload-notify");
  assert.ok(capability);
  assert.deepEqual(capability.inputs, []);
  assert.match(capability.description, /受审源文件集合/);
  assert.doesNotMatch(capability.promptTemplate, /source_path/);
});

test("agent prompt carries the requested repository root without a source path", async () => {
  const { buildCompositeReleaseRunGraph } = await import("../bin/lib/release-runtime-executor.mjs?localization-agent-contract");
  const capability = RELEASE_WORKFLOW_CONFIG.capabilities.find((item) => item.id === "localization-upload-notify");
  const graph = buildCompositeReleaseRunGraph(capability, [], {
    businessLine: "likee",
    platform: "android",
    version: "1.3.0",
    batch: "initial",
    repositoryRoot: "/tmp/likee-android",
  }, { source_path: "iHeima/res/values/strings.xml" }, { skillRoots: ["/tmp/release-skills"] });
  const body = graph.instances.release_agent.body;
  assert.match(body, /repositoryRoot: \/tmp\/likee-android/);
  assert.match(body, /release-localization/);
  assert.doesNotMatch(body, /source_path/);
  assert.doesNotMatch(graph.instances.release_agent.input.find((slot) => slot.name === "inputs")?.value || "", /source_path/);
});

test("legacy localization source_path is removed before execution", async () => {
  const { defaultInputsForNode } = await import("../builtin/web-ui/src/lib/releaseWorkflowModel.js?localization-agent-contract");
  const node = { id: "composite:localization-upload-notify", kind: "composite", inputSchema: [] };
  assert.deepEqual(defaultInputsForNode(node, { source_path: "iHeima/res/values/strings.xml" }, { platform: "android" }), {});
});

test("pending PATCH 404 is treated as a local recommendation and execution continues", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("../builtin/web-ui/src/components/ReleaseWorkflowPanel.jsx", import.meta.url), "utf8");
  assert.match(source, /if \(response\.status === 404\) return;/);
});

test("release node routes use the request workspace path and skill roots", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("../bin/lib/workspace-routes.mjs", import.meta.url), "utf8");
  assert.match(source, /const requestWorkspacePath = requestResolution\.workspacePath/);
  assert.match(source, /const requestRoots = requestResolution\.roots/);
  assert.match(source, /resolveReleaseRequestWorkspace/);
  assert.match(source, /repositoryRoot: requestWorkspacePath/);
  assert.match(source, /skillRoots: requestRoots/);
  assert.match(source, /runWorkspaceGraph\(root, requestWorkspacePath/);
});

test("Cursor Agent receives the release project as an additional workspace root", async () => {
  const source = await (await import("node:fs/promises")).readFile(new URL("../bin/lib/agent-runners.mjs", import.meta.url), "utf8");
  assert.match(source, /for \(const dir of Array\.isArray\(options\.addDirs\)/);
  assert.match(source, /args\.push\("--add-dir", abs\)/);
});
