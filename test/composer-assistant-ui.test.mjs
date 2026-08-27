import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const componentPath = new URL(
  "../builtin/web-ui/src/components/ComposerAssistant.jsx",
  import.meta.url,
);
const workspacePath = new URL(
  "../builtin/web-ui/src/pages/WorkspacePage.jsx",
  import.meta.url,
);
const auditPanelPath = new URL(
  "../builtin/web-ui/src/components/WorkspaceRunAuditPanel.jsx",
  import.meta.url,
);
const cssPath = new URL("../builtin/web-ui/src/index.css", import.meta.url);

test("AI Composer uses the shared Assistant conversation surface", async () => {
  const [component, workspace] = await Promise.all([
    readFile(componentPath, "utf8"),
    readFile(workspacePath, "utf8"),
  ]);

  assert.match(component, /MarkdownDisplayContent/);
  assert.match(component, /af-workflow-assistant-message--user/);
  assert.match(component, /af-workflow-assistant-message--assistant/);
  assert.match(component, /af-workflow-assistant-copy/);
  assert.match(component, /af-composer-assistant-activity/);
  assert.match(component, /Enter 发送 · Shift \+ Enter 换行/);

  // 旧 flow 编辑器整个删掉了（它唯一的入口随静态预览一起消失），所以这里只剩 Workspace 一处。
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

test("Composer keeps one Runs tab and switches individual runs inside it", async () => {
  const [workspace, css] = await Promise.all([
    readFile(workspacePath, "utf8"),
    readFile(cssPath, "utf8"),
  ]);
  const tabsStart = workspace.indexOf('<div className="af-composer-session-tabs"');
  const switcherStart = workspace.indexOf('<div className="af-composer-run-switcher">', tabsStart);
  assert.ok(tabsStart >= 0 && switcherStart > tabsStart);
  const topTabs = workspace.slice(tabsStart, switcherStart);

  assert.match(topTabs, />Workspace</);
  assert.match(topTabs, />Runs</);
  assert.doesNotMatch(topTabs, /composerRunSessions\.map/);
  assert.match(workspace.slice(switcherStart), /aria-label="选择 Run"/);
  assert.match(workspace.slice(switcherStart), /<optgroup label="运行中">/);
  assert.match(workspace.slice(switcherStart), /<optgroup label="最近完成">/);
  assert.match(css, /\.af-composer-run-switcher\s*\{/);
  assert.match(css, /\.af-composer-session-count\s*\{/);
});

test("Runs exposes the shared Turn timeline audit view instead of hiding it in logs", async () => {
  const [workspace, auditPanel, css] = await Promise.all([
    readFile(workspacePath, "utf8"),
    readFile(auditPanelPath, "utf8"),
    readFile(cssPath, "utf8"),
  ]);

  assert.match(workspace, /WorkspaceRunAuditPanel/);
  assert.match(workspace, />\s*结果\s*</);
  assert.match(workspace, />\s*审核图\s*</);
  assert.match(workspace, /stripAgentflowReceipt/);
  assert.match(auditPanel, /<RunInspector/);
  assert.match(auditPanel, /compact/);
  assert.match(auditPanel, /api\/workspace\/run-logs/);
  assert.match(css, /\.af-composer-run-viewbar\s*\{/);
  assert.match(css, /\.af-run-inspector--compact\s*\{/);
});
