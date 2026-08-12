import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../builtin/web-ui/src/", import.meta.url);
const workspaceSource = await readFile(new URL("pages/WorkspacePage.jsx", root), "utf8");
const displaySource = await readFile(new URL("pages/DisplayPage.jsx", root), "utf8");
const rendererSource = await readFile(new URL("displayRenderers.jsx", root), "utf8");
const css = await readFile(new URL("index.css", root), "utf8");
const serverSource = await readFile(new URL("../bin/lib/ui-server.mjs", import.meta.url), "utf8");

test("Display 卡片根据真实连线弱化边界，并在展示态隐藏开发类型", () => {
  assert.match(workspaceSource, /connectedWorkspaceNodeIds/);
  assert.match(workspaceSource, /hasConnections: connectedWorkspaceNodeIds\.has\(node\.id\)/);
  assert.match(workspaceSource, /af-work-display-card--connected/);
  assert.match(css, /\.af-work-display-card\s*\{[\s\S]*?border: 1px solid transparent;/);
  assert.match(css, /\.af-work-display-card--connected\s*\{/);
  assert.match(css, /\.af-work-display-card--presentation \.af-work-display-card__title span:last-child\s*\{[\s\S]*?display: none;/);
});

test("Group 保存成员、移动成员，并投影到 Display 与公开 Canvas", () => {
  assert.match(workspaceSource, /nodeIds: selectedNodes\.map\(\(node\) => node\.id\)/);
  assert.match(workspaceSource, /function inferredWorkspaceGroupNodeIds/);
  assert.match(workspaceSource, /function expandWorkspaceGroupPositionChanges/);
  assert.match(workspaceSource, /displayGroupBounds\(group, displayPage, displaySourceNodeById\)/);
  assert.match(workspaceSource, /af-work-group-node--presentation/);
  assert.match(serverSource, /const groups = \(Array\.isArray\(graph\.ui\?\.groups\)/);
  assert.match(serverSource, /const inferredMemberIds =/);
  assert.match(serverSource, /nodes,\s*groups,/);
  assert.match(displaySource, /type: "publicDisplayGroup"/);
  assert.match(css, /\.af-public-display-group\s*\{/);
});

test("Mermaid 展示图优先且源码折叠，公开页不再退化成源码", () => {
  assert.match(workspaceSource, /<details className="af-work-display-mermaid-source">/);
  assert.match(rendererSource, /export function MermaidDisplayBlock/);
  assert.match(displaySource, /node\.kind === "mermaid" \? <MermaidDisplayBlock code=\{content\} \/>/);
  assert.doesNotMatch(displaySource, /node\.kind === "mermaid" \|\| node\.kind === "ascii"/);
});

test("Table 展示允许换行并使用固定列布局", () => {
  assert.match(css, /\.af-work-display-body--table \.af-work-display-table th,[\s\S]*?white-space: normal;[\s\S]*?overflow-wrap: anywhere;/);
  assert.match(css, /\.af-work-display-body--table \.af-work-display-table\s*\{[\s\S]*?table-layout: fixed;/);
  assert.match(css, /\.af-public-display-table\s*\{[\s\S]*?table-layout: fixed;/);
});
