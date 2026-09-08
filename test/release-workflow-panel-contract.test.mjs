import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const panelPath = new URL("../builtin/web-ui/src/components/ReleaseWorkflowPanel.jsx", import.meta.url);
const cssPath = new URL("../builtin/web-ui/src/index.css", import.meta.url);

test("release stages stack vertically with a directional dashed handoff into 添加阶段", async () => {
  const [source, css] = await Promise.all([
    readFile(panelPath, "utf8"),
    readFile(cssPath, "utf8"),
  ]);

  assert.match(source, /className="af-release-stage-group af-release-stage-group--completed"/);
  assert.match(source, /className="af-release-stage-group af-release-stage-group--pending"/);
  assert.match(source, /<h3>添加阶段<\/h3>/);
  assert.match(source, /<span>下一阶段<\/span>/);
  assert.doesNotMatch(source, /<span>进入添加阶段<\/span>/);
  assert.doesNotMatch(source, /<h3>待执行阶段<\/h3>/);
  assert.match(source, /selectWorkflowProcessNodes/);
  assert.match(source, /createInitializationPreparationNode/);
  assert.match(source, /seedInitializationPreparationState/);
  assert.doesNotMatch(source, /nextNodeIds:\s*\[catalogNodes\[0\]\.id\]/);
  assert.match(source, /af-release-add-node__group/);
  assert.match(css, /\.af-release-add-node__group\s*\{/);
  assert.match(css, /\.af-release-flow-groups\s*\{[^}]*grid-template-columns:\s*1fr/s);
  assert.match(css, /\.af-release-stage-group--completed\s*\{[^}]*border:\s*1px solid/s);
  assert.match(css, /\.af-release-stage-group--pending\s*\{[^}]*border:\s*1px dashed/s);
  assert.match(css, /\.af-release-group-bridge::before\s*\{[^}]*repeating-linear-gradient\(to bottom/s);
  assert.match(css, /\.af-release-group-bridge::after\s*\{[^}]*border-right:[^}]*border-bottom:/s);
  assert.doesNotMatch(source, /className="material-symbols-outlined">arrow_downward<\/i>/);
  assert.doesNotMatch(css, /\.af-release-group-bridge i\s*\{/);
});

test("completed stages use a wrapping snake track instead of disconnected grid arrows", async () => {
  const [source, css] = await Promise.all([
    readFile(panelPath, "utf8"),
    readFile(cssPath, "utf8"),
  ]);

  assert.match(source, /function groupCompletedTimelineRows\(items, rowSize = 3\)/);
  assert.match(source, /af-release-completed-row/);
  assert.match(source, /af-release-completed-turn/);
  assert.match(css, /\.af-release-completed-row::before\s*\{/);
  assert.match(css, /\.af-release-completed-row::before\s*\{[^}]*background:\s*rgba\(109, 229, 159/s);
  assert.match(css, /\.af-release-timeline-card__dot::after\s*\{[^}]*border-left:\s*1px dashed/s);
  assert.match(css, /\.af-release-completed-arrow\s*\{[^}]*background:\s*transparent/s);
  assert.doesNotMatch(css, /\.af-release-completed-arrow\s*\{[^}]*border:\s*1px/s);
  assert.match(css, /\.af-release-completed-row\.is-reverse\s*\{[^}]*flex-direction:\s*row-reverse/s);
  assert.match(css, /\.af-release-completed-turn\s*\{[^}]*border-top:[^}]*border-right:[^}]*border-bottom:[^}]*border-radius:/s);
  assert.match(css, /\.af-release-completed-turn::before\s*\{/);
  assert.match(css, /\.af-release-completed-turn::after\s*\{/);
  assert.match(css, /\.af-release-completed-flow \.af-release-timeline-card::after\s*\{[^}]*display:\s*none/s);
});

test("release branch inputs render their context-derived default value", async () => {
  const [panel, inspector] = await Promise.all([
    readFile(panelPath, "utf8"),
    readFile(new URL("../builtin/web-ui/src/components/ReleaseNodeInspector.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(panel, /const rawValue = renderedInputs\?\.\[schema\.key\] \?\? schema\.defaultValue \?\? ""/);
  assert.match(panel, /value=\{rawValue\}/);
  assert.match(inspector, /defaultInputsForNode\(node, item\?\.inputs, context\)/);
});

test("persisted localization inputs are normalized before card rendering", async () => {
  const source = await readFile(panelPath, "utf8");
  assert.match(source, /const renderedInputs = defaultInputsForNode\(node, item\.inputs \|\| \{\}, context\)/);
  assert.match(source, /const rawValue = renderedInputs\?\.\[schema\.key\] \?\? schema\.defaultValue \?\? ""/);
  assert.match(source, /value=\{rawValue\}/);
});

test("execution validates and sends schema defaults when a remote snapshot omitted inputs", async () => {
  const source = await readFile(panelPath, "utf8");
  assert.match(source, /const value = item\?\.inputs\?\.\[schema\.key\] \?\? schema\.defaultValue/);
  assert.match(source, /const normalizedInputs = defaultInputsForNode\(node, item\.inputs \|\| \{\}, context\)/);
  assert.match(source, /inputs: normalizedInputs/);
});

test("idempotent initialization preview completion is committed to the timeline", async () => {
  const source = await readFile(panelPath, "utf8");
  assert.match(source, /if \(previewPayload\.status !== "completed"\)/);
  assert.match(source, /const rawMessage = previewPayload\.message/);
  assert.match(source, /result = \{[\s\S]*\.\.\.previewPayload,[\s\S]*message: typeof rawMessage/);
  assert.match(source, /if \(!result\) \{/);
});

test("confirmation-required execution opens the node inspector after preview", async () => {
  const source = await readFile(panelPath, "utf8");
  assert.match(source, /const previewItem = \{/);
  assert.match(source, /confirmationFingerprint: previewPayload\.confirmationFingerprint/);
  assert.match(source, /setInspector\(\{ item: previewItem, node, mode: "pending" \}\);/);
});

test("release records preserve workflow identity and picker derives from machine", async () => {
  const source = await readFile(panelPath, "utf8");
  assert.match(source, /workflowId:\s*stringValue\(value\.workflowId\)/);
  assert.match(source, /selectWorkflowProcessNodes\(\{ machine: workflowMachine, nodes: catalogNodes \}\)/);
  assert.match(source, /workflowId: currentItem\.workflowId/);
  assert.match(source, /customNodeOptions\.map|customNodeGroups\.map/);
});

test("composite nodes are sent by composite identity and persist internal step details", async () => {
  const [panel, inspector, model] = await Promise.all([
    readFile(panelPath, "utf8"),
    readFile(new URL("../builtin/web-ui/src/components/ReleaseNodeInspector.jsx", import.meta.url), "utf8"),
    readFile(new URL("../builtin/web-ui/src/lib/releaseWorkflowModel.js", import.meta.url), "utf8"),
  ]);
  assert.match(panel, /kind: currentItem\.kind \|\| node\.kind/);
  assert.match(panel, /compositeId: currentItem\.compositeId \|\| node\.compositeId/);
  assert.match(panel, /details:[\s\S]*normalizeCompositeSteps/);
  assert.match(panel, /actionId = item\.sourcePresetId \|\| node\.sourcePresetId \|\| node\.id/);
  assert.doesNotMatch(panel, /resumeFromStep:/);
  assert.match(inspector, /内部执行步骤/);
  assert.match(inspector, /compositeSteps\.map/);
  assert.match(inspector, /externalInputSchemaForNode/);
  assert.match(model, /export function normalizeCompositeSteps/);
  assert.match(model, /export function externalInputSchemaForNode/);
});

test("free-prompt appears once under assistant group, not every stage", async () => {
  const source = await readFile(panelPath, "utf8");
  assert.match(source, /insertableInAnyStage/);
  assert.match(source, /free-prompt-agent/);
  assert.match(source, /助手驱动/);
  assert.match(source, /只出现一次/);
  assert.doesNotMatch(source, /每个流程分组都挂一份/);
});

test("client keeps waiting results out of the completed timeline", async () => {
  const source = await readFile(panelPath, "utf8");
  assert.match(source, /function sanitizeReleaseNodeOutput/);
  assert.match(source, /sanitizeReleaseNodeOutput\(/);
  assert.match(source, /hydrateReleaseOutputEnvelope/);
  assert.match(source, /parseLeadingJsonValue/);
  assert.match(source, /af-release-node__checkbox/);
  assert.match(source, /type === "checkbox"/);
  assert.match(source, /String\(result\.status \|\| ""\)\.toLowerCase\(\) === "waiting"/);
  assert.match(source, /status: "waiting"/);
  assert.match(source, /humanizeWaitingMatter/);
  assert.match(source, /待办：/);
  assert.doesNotMatch(source, /promoteWaitingItemToCompleted/);
});

test("hydrates hollow timeline entries from runs", async () => {
  const source = await readFile(panelPath, "utf8");
  assert.match(source, /hydrateTimelineFromRuns|function hydrateReleaseItemFromRuns/);
  assert.match(source, /hydrateReleaseItemFromRuns\(/);
});

test("openInspector hydrates item from runs", async () => {
  const panel = await readFile(panelPath, "utf8");
  assert.match(panel, /const openInspector = |function openInspector|openInspector\s*=/);
  // hydrate must be used when opening inspector
  assert.match(panel, /const openInspector = useCallback\(\(item\) => \{[\s\S]*?hydrateReleaseItemFromRuns\(item,\s*state\.runs/);
});

test("stage outcome strip renders summary and artifact chips on cards", async () => {
  const source = await readFile(panelPath, "utf8");
  assert.match(source, /function renderStageOutcome/);
  assert.match(source, /renderStageOutcome\(item\)/);
  assert.match(source, /af-release-stage-outcome/);
  assert.match(source, /af-release-artifact-chip/);
});

test("write actions require canWrite and surface readonly state", async () => {
  const [panel, inspector] = await Promise.all([
    readFile(panelPath, "utf8"),
    readFile(new URL("../builtin/web-ui/src/components/ReleaseNodeInspector.jsx", import.meta.url), "utf8"),
  ]);
  assert.match(panel, /canWrite = true/);
  assert.match(panel, /if \(!canWrite\)/);
  assert.match(panel, /无发版操作权限/);
  assert.match(panel, /canWrite && item\.status/);
  // 用户需求点: 自由 Agent 与聊天助手最终都走同一写 API；无权限时前后端都要给出明确文案。
  assert.match(panel, /RELEASE_OPERATOR_FORBIDDEN/);
  assert.match(panel, /页面与助手都不能触发发版运行/);
  assert.match(inspector, /canWrite = true/);
  assert.match(inspector, /mode === "completed" \|\| !canWrite/);
});

test("retry re-executes from a fresh pending item without resume", async () => {
  const source = await readFile(panelPath, "utf8");
  assert.match(source, /const freshItem = \{/);
  assert.match(source, /status: "pending"/);
  assert.match(source, /不携带 resumeFromStep/);
  assert.doesNotMatch(source, /retrying: true/);
  assert.match(source, /onClick=\{\(event\) => \{ event\.stopPropagation\(\); retryNode\(item\); \}\}/);
  assert.match(source, /setMessage\(`\$\{item\.title \|\| item\.nodeId \|\| "发版节点"\} 定义已失效/);
});

test("blocks adding or executing a second card while the same capability is running", async () => {
  const source = await readFile(panelPath, "utf8");
  assert.match(source, /capabilityKeysForItem/);
  assert.match(source, /findBusyCapabilitySibling/);
  assert.match(source, /同能力已有/);
  assert.match(source, /if \(!\["running"\]\.includes\(status\)\) return false/);
  assert.match(source, /findBusyCapabilitySibling\(state\.pending/);
});

test("pending stage cards delete through the server and stay removed during sync", async () => {
  const source = await readFile(panelPath, "utf8");
  assert.match(source, /const deleteNode = useCallback/);
  assert.match(source, /method: "DELETE"/);
  assert.match(source, /item\.status !== "running"/);
  assert.match(source, /applyServerState\(payload\.state\)/);
  assert.match(source, /filterDismissedPending/);
  assert.match(source, /mergeRemotePending/);
  assert.match(source, /response\.status === 404/);
  assert.match(source, /removePendingNode\(previous, item\)/);
  assert.match(source, /item\.sourcePresetId \|\| node\.sourcePresetId \|\| node\.id/);
  assert.match(source, /onClick=\{\(event\) => \{ event\.stopPropagation\(\); void deleteNode\(item\); \}\}/);
  assert.match(source, /aria-label=\{`删除\$\{item\.title\}`\}/);
});

test("release runtime heartbeats preserve custom pending node identity", async () => {
  const routes = await readFile(new URL("../bin/lib/workspace-routes.mjs", import.meta.url), "utf8");
  assert.match(routes, /releasePendingNodeId\(/);
  assert.match(routes, /nodeId:\s*releasePendingNodeId\(/);
  assert.doesNotMatch(routes, /const runningItem = \{[\s\S]*?nodeId:\s*action\.id,/);
});

test("local-only initialization and custom nodes execute without a server-side pending PATCH", async () => {
  const source = await readFile(panelPath, "utf8");
  assert.match(source, /localOnly.*initializationPreparationNode/);
  assert.match(source, /localOnly \? Promise\.resolve\(\) : saveInspectorItem\(nextItem\)/);
});

test("release runtime completion persistence keeps workflow and scope metadata", async () => {
  const routes = await readFile(new URL("../bin/lib/workspace-routes.mjs", import.meta.url), "utf8");
  assert.match(routes, /const failedItem = \{/);
  assert.match(routes, /const completedItem = \{/);
  assert.match(routes, /\[\.\.\.activeReleaseRuns\.values\(\)\]\.find/);
  assert.match(routes, /itemId: String\(payload\.itemId \|\| ""\)/);
  assert.match(routes, /workflowId:\s*action\.workflowId/);
  assert.match(routes, /scopeKey:\s*requestedScopeKey\s*\|\|\s*expectedScopeKey/);
  assert.match(routes, /contextSnapshot:\s*\{\s*\.\.\.requestContext\s*\}/);
});

test("release runtime uses a bounded controller and binds the active Agent child", async () => {
  const routes = await readFile(new URL("../bin/lib/workspace-routes.mjs", import.meta.url), "utf8");
  const server = await readFile(new URL("../bin/lib/workspace-server.mjs", import.meta.url), "utf8");
  const composer = await readFile(new URL("../bin/lib/composer-agent.mjs", import.meta.url), "utf8");
  assert.match(routes, /createWorkspaceRunController/);
  assert.match(routes, /timeoutMs:\s*releaseRunTimeoutMs/);
  assert.match(routes, /onActiveChild:\s*\(child\)/);
  assert.match(server, /disableMcp:\s*Boolean\(opts\.releaseRuntime\)/);
  assert.match(server, /workspaceReleaseHistoryNodeId|releaseAgent\?\.capabilityId/);
  assert.match(composer, /disableMcp/);
  assert.match(composer, /materializeHomeCursorHermeticIsolation/);
  assert.match(composer, /mcpServers:\s*\{\}/);
});

test("release panel polls server state while an Agent node is running", async () => {
  const panel = await readFile(new URL("../builtin/web-ui/src/components/ReleaseWorkflowPanel.jsx", import.meta.url), "utf8");
  assert.match(panel, /setInterval\(/);
  assert.match(panel, /lastEventAt/);
});

test("unchanged remote catalogs keep their reference to avoid refetch loops", async () => {
  const { mergeRemoteCatalog } = await import("../builtin/web-ui/src/lib/releaseWorkflowModel.js?catalog-reference");
  const previous = [{ id: "release-git:create-release-branch", title: "创建发版分支" }];
  assert.strictEqual(mergeRemoteCatalog(previous, [{ id: "release-git:create-release-branch", title: "创建发版分支" }]), previous);
  assert.notStrictEqual(mergeRemoteCatalog(previous, [{ id: "release-git:create-release-branch", title: "创建发版分支（更新）" }]), previous);
});

test("release panel preserves local recommendations across remote sync and uses stable effect keys", async () => {
  const panel = await readFile(new URL("../builtin/web-ui/src/components/ReleaseWorkflowPanel.jsx", import.meta.url), "utf8");
  assert.match(panel, /localRecommendedPending/);
  assert.match(panel, /catalogSignature/);
  assert.match(panel, /contextKey/);
});
