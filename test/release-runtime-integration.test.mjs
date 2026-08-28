import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("release panel hydrates its catalog and state from Release Runtime APIs", () => {
  const source = fs.readFileSync(new URL("../builtin/web-ui/src/components/ReleaseWorkflowPanel.jsx", import.meta.url), "utf8");
  assert.match(source, /\/api\/release\/catalog/);
  assert.match(source, /\/api\/release\/state/);
  assert.match(source, /ReleaseNodeInspector/);
  assert.match(source, /confirmationFingerprint/);
  assert.match(source, /workspacePath/);
});

test("release context keeps batch in the immutable initialization snapshot", async () => {
  const { resolveReleaseContext, createInitializationNode } = await import("../builtin/web-ui/src/lib/releaseWorkflowModel.js");
  const context = resolveReleaseContext({}, "businessLine=likee&platform=android&version=5.63.2&batch=supplemental");
  const node = createInitializationNode(context, { path: "/workspace" });
  assert.equal(context.batch, "supplemental");
  assert.equal(node.inputs.batch, "supplemental");
});
