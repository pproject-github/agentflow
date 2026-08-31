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

test("release records preserve workflow identity and picker derives from machine", async () => {
  const source = await readFile(panelPath, "utf8");
  assert.match(source, /workflowId:\s*stringValue\(value\.workflowId\)/);
  assert.match(source, /workflowVersion:\s*stringValue\(value\.workflowVersion\)/);
  assert.match(source, /selectWorkflowProcessNodes\(\{ machine: workflowMachine, nodes: catalogNodes \}\)/);
  assert.match(source, /customNodeOptions\.map|customNodeGroups\.map/);
});
