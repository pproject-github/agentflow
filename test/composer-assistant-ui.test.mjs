import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const componentPath = new URL(
  "../builtin/web-ui/src/components/ComposerAssistant.jsx",
  import.meta.url,
);
const flowEditorPath = new URL(
  "../builtin/web-ui/src/pages/FlowEditorPage.jsx",
  import.meta.url,
);
const workspacePath = new URL(
  "../builtin/web-ui/src/pages/WorkspacePage.jsx",
  import.meta.url,
);
const cssPath = new URL("../builtin/web-ui/src/index.css", import.meta.url);

test("AI Composer uses the shared Assistant conversation surface", async () => {
  const [component, flowEditor, workspace] = await Promise.all([
    readFile(componentPath, "utf8"),
    readFile(flowEditorPath, "utf8"),
    readFile(workspacePath, "utf8"),
  ]);

  assert.match(component, /MarkdownDisplayContent/);
  assert.match(component, /af-workflow-assistant-message--user/);
  assert.match(component, /af-workflow-assistant-message--assistant/);
  assert.match(component, /af-workflow-assistant-copy/);
  assert.match(component, /af-composer-assistant-activity/);
  assert.match(component, /Enter 发送 · Shift \+ Enter 换行/);

  assert.match(flowEditor, /ComposerAssistantTurn/);
  assert.match(flowEditor, /ComposerAssistantActivity/);
  assert.match(flowEditor, /pendingLabel=\{responseText \? "仍在生成并同步工作流"/);
  assert.match(flowEditor, /label="执行过程"/);

  assert.match(workspace, /ComposerAssistantTurn/);
  assert.match(workspace, /ComposerAssistantActivity/);
  assert.match(workspace, /ComposerAssistantInput/);
  assert.match(workspace, /technical/);
});

test("Composer Assistant styling keeps technical activity secondary to the conversation", async () => {
  const css = await readFile(cssPath, "utf8");

  assert.match(css, /\.af-composer-assistant-thread\s*\{/);
  assert.match(css, /\.af-composer-assistant-activity\s*\{/);
  assert.match(css, /\.af-composer-assistant-activity--running \.af-composer-assistant-activity__pulse/);
  assert.match(css, /\.af-composer-sidebar-input--assistant\s*\{/);
  assert.match(css, /\.af-workflow-assistant-message--error \.af-workflow-assistant-message__bubble/);
});
