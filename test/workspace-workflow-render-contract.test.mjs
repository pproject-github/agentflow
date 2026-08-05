import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workspacePagePath = new URL(
  "../builtin/web-ui/src/pages/WorkspacePage.jsx",
  import.meta.url,
);
const appPath = new URL("../builtin/web-ui/src/App.jsx", import.meta.url);
const workflowAssistantPath = new URL(
  "../builtin/web-ui/src/components/WorkflowAssistantThread.jsx",
  import.meta.url,
);

test("Workflow timeline receives flow params without relying on an undeclared variable", async () => {
  const source = await readFile(workspacePagePath, "utf8");

  assert.match(
    source,
    /function PrdWorkflowTimelinePanel\(\{\s*flowParams = \{\},/,
    "PrdWorkflowTimelinePanel must declare a safe flowParams prop",
  );
  assert.match(
    source,
    /<PrdWorkflowTimelinePanel\s+flowParams=\{flowParams\}/,
    "WorkspacePageInner must pass its URL-derived flowParams to the Workflow timeline",
  );
});

test("shared Workflow links render the Workflow content without the project top bar", async () => {
  const source = await readFile(workspacePagePath, "utf8");
  const appSource = await readFile(appPath, "utf8");

  assert.match(
    source,
    /const isWorkflowShareView = Boolean\(flowParams\.workflowShare\);/,
    "WorkspacePageInner must identify read-only Workflow share links",
  );
  assert.match(
    source,
    /if \(flowParams\.workflowShare\) return "workflow";/,
    "Workflow share links must always open in Workflow mode",
  );
  assert.match(
    source,
    /\{!isWorkflowShareView \? \(\s*<header className="af-pipeline-top af-workspace-top">/,
    "The project top bar must not render in the shared Workflow view",
  );
  assert.match(
    appSource,
    /function isWorkflowSharePath\(path\)[\s\S]*params\.get\("workflowShare"\)/,
    "The app must identify Workflow share routes before applying the login gate",
  );
  assert.match(
    appSource,
    /if \(isWorkflowSharePath\(path\)\) return <WorkspacePage \/>;/,
    "Workflow share routes must render without AuthGate",
  );
  assert.match(
    source,
    /if \(isWorkflowShareView\) \{\s*setAuthUser\(null\);\s*setAuthResolved\(true\);/,
    "The public Workflow view must skip authenticated Workspace bootstrap requests",
  );
});

test("Workflow details preserve an explicit Dashboard return route", async () => {
  const source = await readFile(workspacePagePath, "utf8");

  assert.match(source, /returnTo: returnTo === "\/workflows" \? returnTo : ""/);
  assert.match(source, /if \(params\.returnTo\) q\.set\("returnTo", params\.returnTo\)/);
  assert.match(
    source,
    /flowParams\.adminOwnerId \? "\/admin\/usage" : flowParams\.returnTo \|\| "\/projects"/,
  );
});

test("Workflow list and details use the TAPD requirement title instead of the current Action", async () => {
  const workspaceSource = await readFile(workspacePagePath, "utf8");
  const workflowsSource = await readFile(
    new URL("../builtin/web-ui/src/pages/WorkflowsPage.jsx", import.meta.url),
    "utf8",
  );

  assert.match(workspaceSource, /function prdWorkflowRequirementTitle\(snapshot, tapdId = ""\)/);
  assert.match(workspaceSource, /globalState\.title[\s\S]*requirement\.title/);
  assert.match(workspaceSource, /<h1>\{requirementTitle\}<\/h1>/);
  assert.doesNotMatch(workflowsSource, /workflow\.title \|\| workflow\.pointer/);
  assert.match(workflowsSource, /<h2>\{workflow\.title \|\| `TAPD \$\{workflow\.tapdId\}`\}<\/h2>/);
});

test("Workflow Project navigation requires an explicit binding", async () => {
  const source = await readFile(workspacePagePath, "utf8");

  assert.match(source, /fetch\(`\/api\/workflows\/project-bindings\?tapdId=/);
  assert.match(source, /method: "POST"[\s\S]*绑定 Project 失败/);
  assert.match(source, /method: "DELETE"[\s\S]*解除 Project 绑定失败/);
  assert.match(source, /workflowProjectBindings\.length === 1/);
  assert.match(source, /setWorkflowProjectBindingOpen\(true\)/);
  assert.match(source, /setWorkspaceMode\(view === "display" \|\| view === "workflow" \? view : "workspace"\)/);
  assert.match(source, /迭代绑定的 Projects/);
  assert.match(source, /只有主动绑定后，全局迭代才能进入对应的 Project 视图/);
});

test("Workflow details can render a read-only local demo snapshot", async () => {
  const source = await readFile(workspacePagePath, "utf8");

  assert.match(source, /workflowDemo: sp\.get\("workflowDemo"\) === "1"/);
  assert.match(source, /function readWorkflowDemoSnapshot\(tapdId\)/);
  assert.match(source, /if \(flowParams\.workflowDemo\) \{/);
  assert.match(source, /本地只读示例/);
  assert.match(source, /readOnly=\{flowParams\.workflowDemo\}/);
  assert.match(source, /isWorkflowMode\s*\? !workflowTapdId/);
});

test("Workflow details use the canonical Artifact publish endpoint and registered prd-flow extensions", async () => {
  const source = await readFile(workspacePagePath, "utf8");

  assert.match(source, /fetch\("\/api\/workflow-artifacts\/publish"/);
  assert.doesNotMatch(source, /fetch\("\/api\/prd-workflow\/review-link"/);
  assert.match(source, /snapshot\?\.extensions\?\.\["prd-flow"\]/);
  assert.match(source, /Array\.isArray\(prdFlowExtension\.aiDocs\)/);
});

test("Workflow share dialog manages explicit report permissions without hiding TAPD-derived viewers", async () => {
  const source = await readFile(workspacePagePath, "utf8");
  const css = await readFile(new URL("../builtin/web-ui/src/index.css", import.meta.url), "utf8");

  assert.match(source, /fetch\(`\/api\/prd-workflow\/collaboration\?tapdId=/);
  assert.match(source, /<option value="reporter">可上报<\/option>/);
  assert.match(source, /member\.source === "tapd"/);
  assert.match(source, /移除授权/);
  assert.match(source, /TAPD 参与人 · 只读/);
  assert.match(css, /\.af-display-share-modal\.af-display-link-modal\s*\{[^}]*width:\s*min\(48rem,/s);
  assert.match(css, /\.af-flow-snippet-modal__body\s*\{[^}]*overflow-y:\s*auto;/s);
});

test("the top collaboration entry opens the permission surface for the active scope", async () => {
  const source = await readFile(workspacePagePath, "utf8");

  assert.match(source, />\s*协作\s*<\/button>/);
  assert.match(source, /if \(isWorkflowMode\) \{\s*setWorkflowCollaborationOpenRequest/);
  assert.match(source, /collaborationOpenRequest=\{workflowCollaborationOpenRequest\}/);
  assert.match(source, /aria-label="需求协作"/);
  assert.match(source, /aria-label="项目协作"/);
  assert.doesNotMatch(source, />\s*协作分享\s*<\//);
  assert.doesNotMatch(source, /title=\{flowParams\.workflowDemo \? "本地示例不可分享" : "分享 Workflow"\}/);
  assert.doesNotMatch(source, /本地只读示例不能配置需求协作/);
});

test("Workflow AI uses owner-managed knowledge bindings and a dedicated query surface", async () => {
  const source = await readFile(workspacePagePath, "utf8");
  const assistantSource = await readFile(workflowAssistantPath, "utf8");
  const css = await readFile(new URL("../builtin/web-ui/src/index.css", import.meta.url), "utf8");

  assert.match(source, /fetch\(`\/api\/workflows\/knowledge-bindings\?tapdId=/);
  assert.match(source, /method: "PUT"[\s\S]*workspaceIds: knowledgeSelection/);
  assert.match(source, /fetch\("\/api\/workflows\/query"/);
  assert.match(source, /setWorkflowAssistantOpenRequest/);
  assert.match(source, /assistantOpenRequest=\{workflowAssistantOpenRequest\}/);
  assert.match(source, /AI 知识工作区/);
  assert.match(source, /需求与代码只读分析/);
  assert.match(source, /knowledgeBindings\.slice\(0, 3\)\.map/);
  assert.match(source, /className="af-prd-workflow-knowledge-chip"/);
  assert.match(source, /\[binding\.type, binding\.branch\]\.filter\(Boolean\)\.join\(" · "\)/);
  assert.match(source, /<WorkflowAssistantThread/);
  assert.match(assistantSource, /from "@assistant-ui\/react"/);
  assert.match(assistantSource, /useExternalStoreRuntime\(/);
  assert.match(assistantSource, /<ThreadPrimitive\.Viewport/);
  assert.match(assistantSource, /<ComposerPrimitive\.Input/);
  assert.match(assistantSource, /<MessagePrimitive\.Parts/);
  assert.match(assistantSource, /MarkdownDisplayContent/);
  assert.match(
    assistantSource,
    /const \{ text \} = useMessagePartText\(\);/,
    "assistant-ui returns a text-part state object; only its text field may be rendered",
  );
  assert.match(source, /af-composer-topbar-btn--workflow/);
  assert.match(source, /\{isWorkflowMode \? "需求 AI" : "AI"\}/);
  assert.match(source, /\{!isWorkflowMode \? \(\s*<button type="button" className="af-btn-primary af-btn-primary--lg"/s);
  assert.match(css, /\.af-workflow-ai-drawer\s*\{[^}]*position:\s*fixed;/s);
  assert.match(css, /\.af-workflow-assistant-viewport\s*\{/);
  assert.match(css, /\.af-workflow-assistant-composer\s*\{/);
  assert.match(css, /\.af-prd-workflow-collab \.af-prd-workflow-knowledge-chip\s*\{/);
  assert.match(css, /\.af-composer-topbar-btn--workflow\s*\{/);
});

test("Workflow progress fields use a compact responsive grid", async () => {
  const source = await readFile(workspacePagePath, "utf8");
  const css = await readFile(new URL("../builtin/web-ui/src/index.css", import.meta.url), "utf8");

  assert.match(
    source,
    /const compact = sectionKey === "progress";/,
    "Only the progress section should opt into the compact layout",
  );
  assert.match(
    source,
    /af-prd-overall-platform--compact/,
    "The progress section should expose a compact layout class",
  );
  assert.match(
    source,
    /className="af-prd-overall-platform__fields"/,
    "Global-state fields should share one layout container",
  );
  assert.match(
    css,
    /\.af-prd-overall-platform--compact \.af-prd-overall-platform__fields\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,/s,
    "Compact progress fields should flow horizontally and wrap responsively",
  );
});

test("Workflow overview keeps long status text from squeezing its title", async () => {
  const css = await readFile(new URL("../builtin/web-ui/src/index.css", import.meta.url), "utf8");

  assert.match(
    css,
    /\.af-prd-overall > \.af-prd-workflow-card__head\s*\{[^}]*flex-direction:\s*column;/s,
  );
  assert.match(
    css,
    /\.af-prd-workflow-card__head \.af-prd-overall__status\s*\{[^}]*max-width:\s*100%;[^}]*overflow-wrap:\s*anywhere;/s,
  );
});

test("Workflow action Issue metadata stays on one line", async () => {
  const source = await readFile(workspacePagePath, "utf8");
  const css = await readFile(new URL("../builtin/web-ui/src/index.css", import.meta.url), "utf8");

  assert.match(source, /className="af-prd-workflow-action__meta-value"/);
  assert.match(source, /title=\{`\$\{entry\.label\} · \$\{entry\.value\}`\}/);
  assert.match(
    css,
    /\.af-prd-workflow-action__meta-value\s*\{[^}]*text-overflow:\s*ellipsis;[^}]*white-space:\s*nowrap;/s,
  );
  assert.match(
    css,
    /\.af-prd-workflow-action__meta-item--issue\s*\{[^}]*flex:\s*0 1 auto;[^}]*max-width:\s*min\(28rem, 100%\);/s,
    "Issue metadata should size to its content instead of reserving a 28rem column",
  );
});

test("Workflow detail uses one neutral surface palette", async () => {
  const css = await readFile(new URL("../builtin/web-ui/src/index.css", import.meta.url), "utf8");

  assert.match(css, /--af-workflow-surface:\s*rgba\(30, 29, 33, 0\.9\)/);
  assert.match(
    css,
    /\.af-prd-workflow__status-main\s*\{[^}]*background:\s*var\(--af-workflow-surface\);/s,
  );
  assert.match(
    css,
    /\.af-prd-workflow-actions\s*\{[^}]*background:\s*var\(--af-workflow-surface\);/s,
  );
  assert.match(
    css,
    /\.af-prd-workflow-card\s*\{[^}]*background:\s*var\(--af-workflow-surface\);/s,
  );
});
