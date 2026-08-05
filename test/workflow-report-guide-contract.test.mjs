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
  assert.match(page, /Workflow 接入文档/);
  const workflowsPage = await readFile(new URL("../builtin/web-ui/src/pages/WorkflowsPage.jsx", import.meta.url), "utf8");
  assert.match(workflowsPage, /navigate\("\/workflow-report"\)/);
  assert.match(workflowsPage, /接入说明/);
  assert.match(page, /给 AI 的接入引导/);
  assert.match(page, /\$agentflow-workflow-report/);
  assert.match(page, /POST \/api\/workflows\/report/);
  assert.match(page, /GET \/api\/workflows\/state/);
  assert.match(page, /POST \/api\/workflow-artifacts\/publish/);
  assert.match(page, /projections\.timeline/);
  assert.match(page, /正式接口只有三个/);
  assert.match(page, /5 分钟跑通一次上报/);
  assert.match(page, /当前服务端的 Workflow 身份适配器只支持 TAPD/);
  assert.match(page, /可直接执行的三步命令/);
  assert.match(page, /成功响应/);
  assert.match(page, /Observation 参数/);
  assert.match(page, /Global State 参数/);
  assert.match(page, /Timeline Projection 参数/);
  assert.match(page, /source \+ key/);
  assert.match(page, /id="ai"/);
  assert.match(page, /PrdFlowExtensionPreview/);
  assert.match(page, /先决定数据进入哪个区域/);
  assert.match(page, /全局区域/);
  assert.match(page, /Action 时间轴/);
  assert.match(page, /自定义区域/);
  assert.match(page, /当前可直接使用的通用渲染器/);
  assert.match(page, /普通自定义信息不要放进 extensions/);
  assert.match(page, /globalState\.sections 上报示例/);
  assert.match(page, /text\/user\/chips\/list\/link/);
  assert.match(page, /当前唯一已注册的专用 extension renderer/);
  assert.match(page, /其他 namespace 当前如何显示/);
  assert.match(page, /接口与参数参考/);
  assert.match(page, /Envelope/);
  assert.match(page, /Workflow state query 参数/);
  assert.match(page, /Workflow Report 顶层参数/);
  assert.match(page, /Action 参数/);
  assert.match(page, /Artifact 参数/);
  assert.match(page, /Artifact Publish 参数/);
  assert.match(page, /三个关键接入场景/);
  assert.match(page, /更新迭代：绑定或切换版本/);
  assert.match(page, /上报 Action 和产物链接/);
  assert.match(page, /上报自定义文档区 \/ Issue 区/);
  assert.match(page, /权限矩阵/);
  assert.match(page, /覆盖矩阵/);
  assert.match(page, /同团队成员/);
  assert.match(page, /整数组替换/);
  assert.match(page, /"prd-flow":/);
  assert.match(page, /Workflow Report Client/);
  assert.match(page, /observation\.state/);
  assert.match(page, /服务端返回的数据才叫.*snapshot/);
  assert.match(page, /服务端不能访问调用方本地路径/);
  assert.match(page, /不会确认方案、修改原文件、提交 ai-doc/);
  assert.match(page, /tapdCurrentVersion/);
  assert.match(page, /prd-flow:version:/);
  assert.match(page, /prd-flow 仅作为 TAPD 研发场景的参考实现/);
  assert.match(page, /read → merge → report → verify/);
  assert.match(page, /保留其他生产方条目/);
  assert.match(css, /\.af-wr-page\s*\{/);
  assert.match(css, /\.af-wr-endpoint-grid\s*\{/);
  assert.match(css, /\.af-wr-region-grid\s*\{/);
  assert.match(css, /\.af-wr-renderer-feature\s*\{/);
  assert.match(css, /\.af-wr-renderer-grid\s*\{/);
  assert.match(css, /\.af-wr-extension-registry\s*\{/);
  assert.match(css, /\.af-wr-table__row\s*\{/);
  assert.match(css, /\.af-wr-scenario\s*\{/);
  assert.match(css, /\.af-wr-runtime\s*\{/);
});

test("Workflow reporting specification is isolated in its own skill", async () => {
  const [skill, protocol, cliSkill] = await Promise.all([
    readFile(workflowSkillPath, "utf8"),
    readFile(protocolPath, "utf8"),
    readFile(cliSkillPath, "utf8"),
  ]);

  assert.match(skill, /^---\nname: agentflow-workflow-report\n/);
  assert.match(skill, /references\/protocol\.md/);
  assert.match(skill, /one canonical producer-adapter protocol/);
  assert.match(protocol, /AgentFlow 服务才负责鉴权、存储、合并和展示/);
  assert.match(protocol, /observation：完整生产方观察/);
  assert.match(protocol, /extensions：自定义区域/);
  assert.match(protocol, /发布 Markdown 预览/);
  assert.match(protocol, /POST \/api\/workflow-artifacts\/publish/);
  assert.match(protocol, /数据区域模型/);
  assert.match(protocol, /当前可直接使用的通用渲染器/);
  assert.match(protocol, /globalState\.sections/);
  assert.match(protocol, /当前唯一注册的 extension renderer/);
  assert.match(protocol, /section key 为 `progress` 时使用紧凑响应式网格/);
  assert.match(protocol, /覆盖、合并与删除规则/);
  assert.match(protocol, /Workflow owner/);
  assert.match(protocol, /显式 editor/);
  assert.match(protocol, /整数组替换/);
  assert.match(protocol, /expectedRevision/);
  assert.match(protocol, /idempotencyKey/);
  assert.match(protocol, /当前身份适配器的边界/);
  assert.match(protocol, /source \+ action\.key/);
  assert.match(protocol, /不会先生成一个新文件再去重/);
  assert.match(cliSkill, /separate \[`agentflow-workflow-report`\]/);
  assert.doesNotMatch(cliSkill, /Timeline projections are a generic dashboard index/);
});
