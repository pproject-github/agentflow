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
  assert.match(app, /if \(path === "\/workflows"\) return <WorkflowsPage authUser=\{authUser\} \/>;/);
  assert.match(sidebar, /\{ to: "\/workflows", label: "迭代", icon: "timeline" \}/);
});

test("Workflow Dashboard lists user workflows and opens the existing Workflow view", async () => {
  const [page, css] = await Promise.all([
    readFile(pagePath, "utf8"),
    readFile(cssPath, "utf8"),
  ]);

  assert.match(page, /fetch\(`\/api\/prd-workflows\?\$\{params\.toString\(\)\}`\)/);
  assert.match(page, /setLoading\(true\);\s*setError\(""\);\s*setWorkflows\(\[\]\);/);
  assert.match(page, /function WorkflowLoading\(\)/);
  assert.match(page, /const \[loading, setLoading\] = useState\(\(\) => !initialDemo\)/);
  assert.match(page, /loading \? <WorkflowLoading \/> : null/);
  assert.match(page, /!loading \? <div className="af-workflows-list">/);
  assert.match(page, />个人迭代<\/button>/);
  assert.match(page, />团队迭代<\/button>/);
  assert.match(page, /view: "workflow"/);
  assert.match(page, /tapdId: String\(workflow\?\.tapdId \|\| ""\)/);
  assert.match(page, /function workflowUrl\(workflow, returnTo = "\/workflows"\)/);
  assert.match(page, /projectBindings\.length === 1/);
  assert.match(page, /query\.set\("workspaceId", String\(project\.workspaceId\)\)/);
  assert.match(page, /Project · \{project\.label \|\| project\.flowId\}/);
  assert.match(page, /workflowDemo/);
  assert.match(page, /createWorkflowDemoSnapshot/);
  assert.match(page, /withWorkflowChecklistProgress\(WORKFLOW_CHECKLIST_DEMO_ACTION\)/);
  assert.match(page, /checklist: checklistAction\.checklist/);
  assert.match(page, /查看示例/);
  assert.match(page, /scope === "owned"/);
  assert.match(page, /scope === "collaborating"/);
  assert.match(page, /payload\.timeline/);
  assert.match(page, /迭代时间线/);
  assert.match(page, /timelineKey === "unassigned"/);
  assert.match(page, /function createWorkflowDemo\(\)/);
  assert.match(page, /载入本地示例时间线/);
  assert.match(page, /本地示例/);
  assert.match(page, /if \(demoMode\) return;\s*void loadWorkflows\(\);/);
  assert.match(page, /function timelineStatus\(entry\)/);
  assert.match(page, /const TIMELINE_WINDOW_SIZE = 8;/);
  assert.match(page, /const TIMELINE_WINDOW_MAX = 24;/);
  assert.match(page, /function initialTimelineWindow\(entries, focusKey = ""\)/);
  assert.match(page, /setTimelineFocusKey\(nextDefaultTimelineKey\)/);
  assert.match(page, /previousElementSibling\?\.dataset\?\.timelineKey/);
  assert.match(page, /rail\.scrollLeft = Math\.max\(0, previousNode\.offsetLeft - railPadding\)/);
  assert.match(page, /function loadWorkflowPageState\(\)/);
  assert.match(page, /function isLocalWorkflowRuntime\(\)/);
  assert.match(page, /\["127\.0\.0\.1", "localhost", "::1"\]/);
  assert.match(page, /requestedDemo === null && isLocalWorkflowRuntime\(\)/);
  assert.match(page, /initialPageState\.demo \? createWorkflowDemo\(\) : null/);
  assert.match(page, /if \(demoMode\) params\.set\("demo", "1"\)/);
  assert.match(page, /else if \(view === "personal" && isLocalWorkflowRuntime\(\)\) params\.set\("demo", "0"\)/);
  assert.match(page, /demoMode \? "退出示例" : "本地示例"/);
  assert.match(page, /onClick=\{demoMode \? exitDemo : loadDemo\}/);
  assert.match(page, /view === "personal" && isLocalWorkflowRuntime\(\) \?/);
  assert.match(page, /\{isLocalWorkflowRuntime\(\) \? \(\s*<button type="button" className="af-workflows-demo-button"/);
  assert.match(page, /setDemoMode\(false\); setView\("team"\)/);
  assert.match(page, /payload\.selectedTimelineKey/);
  assert.match(page, /className="af-workflows-pagination"/);
  assert.match(page, /function AdminIterationManager/);
  assert.match(page, /authUser\?\.isAdmin && !demoMode/);
  assert.match(page, /管理迭代/);
  assert.match(page, /adminOperation: "repair-version-membership"/);
  assert.match(page, /adminReason: reason\.trim\(\)/);
  assert.match(page, /expectedRevision: revision/);
  assert.match(page, /reportResponse\.status === 409 && attempt < 1/);
  assert.match(page, /移至未归属/);
  assert.match(page, /变更预览/);
  assert.match(page, /WORKFLOW_PAGE_SIZES = \[20, 50, 100\]/);
  assert.match(page, /onScroll=\{handleTimelineScroll\}/);
  assert.doesNotMatch(page, /timelineViewport/);
  assert.doesNotMatch(page, />更早</);
  assert.doesNotMatch(page, />更晚</);
  assert.doesNotMatch(page, /className="af-workflows-summary"/);
  assert.doesNotMatch(page, /<p>\{workflow\.pointer/);
  assert.match(css, /\.af-workflow-card\s*\{/);
  assert.match(css, /\.af-workflows-toolbar\s*\{/);
  assert.match(css, /\.af-workflows-loading\s*\{/);
  assert.match(css, /\.af-workflows-timeline\s*\{/);
  assert.match(css, /\.af-workflows-timeline__rail > button::after/);
  assert.doesNotMatch(css, /\.af-workflows-timeline__range\s*\{/);
  assert.match(css, /scroll-snap-type: x proximity;/);
  assert.match(css, /\.af-workflows-demo-button\s*\{/);
  assert.match(css, /\.af-workflows-demo-toggle\.is-active\s*\{/);
  assert.match(css, /\.af-workflows-pagination\s*\{/);
  assert.match(css, /\.af-workflows-admin-backdrop\s*\{/);
  assert.match(css, /\.af-workflows-admin-dialog\s*\{/);
  assert.match(css, /\.af-workflows-admin-preview\s*\{/);
});
