import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appPath = new URL("../builtin/web-ui/src/App.jsx", import.meta.url);
const sidebarPath = new URL("../builtin/web-ui/src/layout/Sidebar.jsx", import.meta.url);
const pagePath = new URL("../builtin/web-ui/src/pages/WorkflowReportGuidePage.jsx", import.meta.url);
const cssPath = new URL("../builtin/web-ui/src/pages/WorkflowReportGuidePage.css", import.meta.url);
const workflowSkillPath = new URL("../skills/agentflow-workflow-report/SKILL.md", import.meta.url);
const protocolPath = new URL("../skills/agentflow-workflow-report/references/protocol.md", import.meta.url);
const cliSkillPath = new URL("../skills/agentflow-cli/SKILL.md", import.meta.url);

test("Workflow reporting has a dedicated route reached from the Dashboard", async () => {
  const [app, sidebar, page, css] = await Promise.all([
    readFile(appPath, "utf8"),
    readFile(sidebarPath, "utf8"),
    readFile(pagePath, "utf8"),
    readFile(cssPath, "utf8"),
  ]);

  assert.match(app, /import WorkflowReportGuidePage from "\.\/pages\/WorkflowReportGuidePage\.jsx";/);
  assert.match(app, /if \(path === "\/workflow-report"\) return <WorkflowReportGuidePage \/>;/);
  assert.doesNotMatch(sidebar, /to: "\/workflow-report"/);
  assert.match(page, /Workflow 上报接入/);
  const workflowsPage = await readFile(new URL("../builtin/web-ui/src/pages/WorkflowsPage.jsx", import.meta.url), "utf8");
  assert.match(workflowsPage, /navigate\("\/workflow-report"\)/);
  assert.match(workflowsPage, /接入说明/);
  assert.match(page, /给 AI 的接入引导/);
  assert.match(page, /\$agentflow-workflow-report/);
  assert.match(page, /POST \/api\/workflows\/report/);
  assert.match(page, /projections\.timeline/);
  assert.match(css, /\.af-wr-page\s*\{/);
});

test("Workflow reporting specification is isolated in its own skill", async () => {
  const [skill, protocol, cliSkill] = await Promise.all([
    readFile(workflowSkillPath, "utf8"),
    readFile(protocolPath, "utf8"),
    readFile(cliSkillPath, "utf8"),
  ]);

  assert.match(skill, /^---\nname: agentflow-workflow-report\n/);
  assert.match(skill, /references\/protocol\.md/);
  assert.match(skill, /read-modify-report protocol/);
  assert.match(protocol, /globalState.*source of truth/is);
  assert.match(protocol, /Timeline projection model/);
  assert.match(protocol, /expectedRevision/);
  assert.match(protocol, /idempotencyKey/);
  assert.match(cliSkill, /separate \[`agentflow-workflow-report`\]/);
  assert.doesNotMatch(cliSkill, /Timeline projections are a generic dashboard index/);
});
