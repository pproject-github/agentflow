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
  assert.match(panel, /item\.inputs\?\.\[schema\.key\] \?\? schema\.defaultValue \?\? ""/);
  assert.match(inspector, /defaultInputsForNode\(node, item\?\.inputs\)/);
});

test("execution validates and sends schema defaults when a remote snapshot omitted inputs", async () => {
  const source = await readFile(panelPath, "utf8");
  assert.match(source, /const value = item\?\.inputs\?\.\[schema\.key\] \?\? schema\.defaultValue/);
  assert.match(source, /const normalizedInputs = defaultInputsForNode\(node, item\.inputs \|\| \{\}\)/);
  assert.match(source, /inputs: normalizedInputs/);
});

test("idempotent initialization preview completion is committed to the timeline", async () => {
  const source = await readFile(panelPath, "utf8");
  assert.match(source, /if \(previewPayload\.status !== "completed"\)/);
  assert.match(source, /const rawMessage = previewPayload\.message/);
  assert.match(source, /result = \{[\s\S]*\.\.\.previewPayload,[\s\S]*message: typeof rawMessage/);
  assert.match(source, /if \(!result\) \{/);
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
  assert.match(panel, /actionId = node\.sourcePresetId \|\| node\.id/);
  assert.match(panel, /resumeFromStep: item\.details\?\.steps\?\.find/);
  assert.match(inspector, /内部执行步骤/);
  assert.match(inspector, /compositeSteps\.map/);
  assert.match(inspector, /externalInputSchemaForNode/);
  assert.match(model, /export function normalizeCompositeSteps/);
  assert.match(model, /export function externalInputSchemaForNode/);
});

test("retry keeps failed execution context and does not bubble into card navigation", async () => {
  const source = await readFile(panelPath, "utf8");
  assert.match(source, /const retryItem = \{ \.\.\.item, status: "failed", retrying: true/);
  assert.match(source, /item\.status === "failed" \|\| item\.retrying/);
  assert.match(source, /onClick=\{\(event\) => \{ event\.stopPropagation\(\); retryNode\(item\); \}\}/);
  assert.match(source, /setMessage\(`\$\{item\.title \|\| item\.nodeId \|\| "发版节点"\} 定义已失效/);
});

test("release runtime completion persistence keeps workflow and scope metadata", async () => {
  const routes = await readFile(new URL("../bin/lib/workspace-routes.mjs", import.meta.url), "utf8");
  assert.match(routes, /const failedItem = \{/);
  assert.match(routes, /const completedItem = \{/);
  assert.match(routes, /workflowId:\s*action\.workflowId/);
  assert.match(routes, /scopeKey:\s*requestedScopeKey\s*\|\|\s*expectedScopeKey/);
  assert.match(routes, /contextSnapshot:\s*\{\s*\.\.\.requestContext\s*\}/);
});
