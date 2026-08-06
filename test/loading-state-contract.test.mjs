import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../builtin/web-ui/src/", import.meta.url);

test("page-level data loading uses the shared AgentFlow loading state", async () => {
  const [component, display, schedules, checklist, mcp, feedback, admin, css] = await Promise.all([
    readFile(new URL("components/LoadingState.jsx", root), "utf8"),
    readFile(new URL("pages/DisplayPage.jsx", root), "utf8"),
    readFile(new URL("pages/SchedulesPage.jsx", root), "utf8"),
    readFile(new URL("pages/WorkflowChecklistPage.jsx", root), "utf8"),
    readFile(new URL("pages/McpPage.jsx", root), "utf8"),
    readFile(new URL("pages/FeedbackPage.jsx", root), "utf8"),
    readFile(new URL("pages/AdminUsagePage.jsx", root), "utf8"),
    readFile(new URL("index.css", root), "utf8"),
  ]);

  assert.match(component, /role="status" aria-live="polite"/);
  assert.match(component, /af-loading-state__skeleton/);
  assert.match(display, /<LoadingState variant="page" title="正在打开展示页"/);
  assert.match(schedules, /<LoadingState title="正在读取定时任务"/);
  assert.match(schedules, /!loading \? <div className="af-schedules-list">/);
  assert.match(checklist, /title="正在读取 Checklist"/);
  assert.match(mcp, /variant="compact" title="正在读取 MCP 服务"/);
  assert.match(feedback, /title="正在读取反馈"/);
  assert.match(admin, /title="正在读取使用统计"/);
  assert.doesNotMatch(display, />Loading\.\.\.</);
  assert.doesNotMatch(schedules, />Loading\.\.\.</);
  assert.match(css, /\.af-loading-state--page\s*\{/);
  assert.match(css, /\.af-loading-state--compact\s*\{/);
});

test("local log and share surfaces do not fall back to generic English loading text", async () => {
  const [logViewer, workspaceLogs, workspacePage] = await Promise.all([
    readFile(new URL("components/LogViewer.jsx", root), "utf8"),
    readFile(new URL("components/WorkspaceRunLogsDrawer.jsx", root), "utf8"),
    readFile(new URL("pages/WorkspacePage.jsx", root), "utf8"),
  ]);

  assert.match(logViewer, /正在读取执行记录…/);
  assert.match(logViewer, /正在读取日志详情…/);
  assert.match(workspaceLogs, /正在读取执行记录…/);
  assert.match(workspaceLogs, /正在读取日志详情…/);
  assert.match(workspacePage, /正在读取展示分享…/);
  assert.doesNotMatch(`${logViewer}\n${workspaceLogs}`, />Loading(?:…|\.\.\.)</);
});
