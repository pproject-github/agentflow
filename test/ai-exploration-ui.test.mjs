import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const panelPath = new URL("../builtin/web-ui/src/components/AiExplorationPanel.jsx", import.meta.url);
const workspacePath = new URL("../builtin/web-ui/src/pages/WorkspacePage.jsx", import.meta.url);
const cssPath = new URL("../builtin/web-ui/src/index.css", import.meta.url);

test("Workspace AI exploration separates Plan, dry-run, Actual Trace and DSL materialization", async () => {
  const [panel, workspace, css] = await Promise.all([
    readFile(panelPath, "utf8"),
    readFile(workspacePath, "utf8"),
    readFile(cssPath, "utf8"),
  ]);

  assert.match(workspace, /<AiExplorationPanel/);
  assert.match(workspace, />\s*探索\s*<\/button>/);
  assert.match(panel, /生成预计运行图/);
  assert.match(panel, /Dry-run 策略预检/);
  assert.match(panel, /ACTUAL/);
  assert.match(panel, /固化为 Workspace DSL/);
  assert.match(panel, /approveSideEffects: sideEffectsApproved/);
  assert.match(panel, /\/api\/workspace\/exploration\/events/);
  assert.match(css, /\.af-ai-trace__event\s*\{/);
});
