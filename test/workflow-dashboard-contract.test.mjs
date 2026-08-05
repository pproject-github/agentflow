import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appPath = new URL("../builtin/web-ui/src/App.jsx", import.meta.url);
const sidebarPath = new URL("../builtin/web-ui/src/layout/Sidebar.jsx", import.meta.url);
const pagePath = new URL("../builtin/web-ui/src/pages/WorkflowsPage.jsx", import.meta.url);
const cssPath = new URL("../builtin/web-ui/src/index.css", import.meta.url);

test("Workflow Dashboard is reachable from the main navigation", async () => {
  const [app, sidebar] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(sidebarPath, "utf8"),
  ]);

  assert.match(app, /import WorkflowsPage from "\.\/pages\/WorkflowsPage\.jsx";/);
  assert.match(app, /if \(path === "\/workflows"\) return <WorkflowsPage \/>;/);
  assert.match(sidebar, /\{ to: "\/workflows", label: "迭代", icon: "timeline" \}/);
});

test("Workflow Dashboard lists user workflows and opens the existing Workflow view", async () => {
  const [page, css] = await Promise.all([
    readFile(pagePath, "utf8"),
    readFile(cssPath, "utf8"),
  ]);

  assert.match(page, /fetch\(`\/api\/prd-workflows\?view=\$\{encodeURIComponent\(view\)\}`\)/);
  assert.match(page, />个人迭代<\/button>/);
  assert.match(page, />团队迭代<\/button>/);
  assert.match(page, /view: "workflow"/);
  assert.match(page, /tapdId: String\(workflow\?\.tapdId \|\| ""\)/);
  assert.match(page, /returnTo: "\/workflows"/);
  assert.match(page, /workflowDemo/);
  assert.match(page, /createWorkflowDemoSnapshot/);
  assert.match(page, /查看示例/);
  assert.match(page, /scope === "owned"/);
  assert.match(page, /scope === "collaborating"/);
  assert.match(page, /payload\.timeline/);
  assert.match(page, /迭代时间线/);
  assert.match(page, /timelineKey === "unassigned"/);
  assert.match(page, /function createWorkflowDemo\(\)/);
  assert.match(page, /载入本地示例时间线/);
  assert.match(page, /本地示例/);
  assert.match(page, /function timelineStatus\(entry\)/);
  assert.match(page, /const TIMELINE_WINDOW_SIZE = 8;/);
  assert.match(page, /const TIMELINE_WINDOW_MAX = 24;/);
  assert.match(page, /function initialTimelineWindow\(entries\)/);
  assert.match(page, /onScroll=\{handleTimelineScroll\}/);
  assert.doesNotMatch(page, /timelineViewport/);
  assert.doesNotMatch(page, />更早</);
  assert.doesNotMatch(page, />更晚</);
  assert.doesNotMatch(page, /className="af-workflows-summary"/);
  assert.doesNotMatch(page, /<p>\{workflow\.pointer/);
  assert.match(css, /\.af-workflow-card\s*\{/);
  assert.match(css, /\.af-workflows-toolbar\s*\{/);
  assert.match(css, /\.af-workflows-timeline\s*\{/);
  assert.match(css, /\.af-workflows-timeline__rail > button::after/);
  assert.doesNotMatch(css, /\.af-workflows-timeline__range\s*\{/);
  assert.match(css, /scroll-snap-type: x proximity;/);
  assert.match(css, /\.af-workflows-demo-button\s*\{/);
});
