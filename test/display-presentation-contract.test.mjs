import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../builtin/web-ui/src/", import.meta.url);
const workspaceSource = await readFile(new URL("pages/WorkspacePage.jsx", root), "utf8");
const workspaceGroupsSource = await readFile(new URL("workspaceGroups.js", root), "utf8");
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
  assert.match(workspaceSource, /expandWorkspaceGroupPositionChanges/);
  assert.match(workspaceGroupsSource, /export function expandWorkspaceGroupPositionChanges/);
  assert.match(workspaceSource, /displayGroupBounds\(group, displayPage, displaySourceNodeById\)/);
  assert.match(workspaceSource, /af-work-group-node--presentation/);
  assert.match(serverSource, /const groups = \(Array\.isArray\(graph\.ui\?\.groups\)/);
  assert.match(serverSource, /const inferredMemberIds =/);
  assert.match(serverSource, /nodes,\s*groups,/);
  assert.match(displaySource, /type: "publicDisplayGroup"/);
  assert.match(css, /\.af-public-display-group\s*\{/);
});

test("Group 缩放使用实时尺寸，解组动作不会伪装成删除", () => {
  assert.match(workspaceSource, /const \[resizingGroup, setResizingGroup\] = useState\(false\)/);
  assert.match(workspaceSource, /liveSize: normalizeWorkspaceGroupSize\(\{ width, height \}\)/);
  assert.match(workspaceSource, /onResizeStart=\{\(\) => setResizingGroup\(true\)\}/);
  assert.match(workspaceSource, /aria-label="解组"/);
  assert.match(workspaceSource, /title="解组（保留内部节点）"/);
  assert.match(workspaceSource, />ungroup<\/span>/);
});

test("Mermaid 卡片和所有展示面只显示渲染结果", () => {
  assert.doesNotMatch(workspaceSource, /af-work-display-mermaid-source/);
  assert.doesNotMatch(workspaceSource, /查看 Mermaid 源码/);
  assert.doesNotMatch(workspaceSource, /showMermaidSource/);
  assert.doesNotMatch(workspaceSource, /<div className="af-display-picker-preview__diagram">[\s\S]*?<pre>\{content\}<\/pre>/);
  assert.match(rendererSource, /export function MermaidDisplayBlock/);
  assert.match(displaySource, /node\.kind === "mermaid" \? <MermaidDisplayBlock code=\{content\} \/>/);
  assert.doesNotMatch(displaySource, /node\.kind === "mermaid" \|\| node\.kind === "ascii"/);
});

test("Mermaid 全屏预览提供显式源码编辑模式", () => {
  assert.match(workspaceSource, /const editableTextKind = kind === "markdown" \|\| kind === "mermaid"/);
  assert.match(workspaceSource, /aria-label=\{`编辑 \$\{sourceLabel\} 源码`\}/);
  assert.match(workspaceSource, /placeholder=\{kind === "mermaid" \? "输入 Mermaid 源码" : "输入 Markdown 内容"\}/);
  assert.match(workspaceSource, /await saveTextDisplayEdit\(\{[\s\S]*?kind,[\s\S]*?setFileContent: setSourceFileContent/);
  assert.match(workspaceSource, /const problem = validateDisplayContentForWrite\(kind, content\)/);
});

test("Mermaid 使用单层自适应 SVG，不再由内部容器裁切", () => {
  assert.match(workspaceSource, /MermaidDisplayBlock code=\{content\}/);
  assert.match(workspaceSource, /af-work-display-body af-work-display-body--mermaid/);
  assert.match(rendererSource, /className="af-md-mermaid-preview"[\s\S]*?width=\{maxX\}[\s\S]*?height=\{maxY\}/);
  assert.match(rendererSource, /const isSequence = \/\^sequenceDiagram/);
  assert.match(rendererSource, /edge\.label \? <text/);
  assert.match(rendererSource, /const reverse = horizontal \? b\.x <= a\.x : b\.y <= a\.y/);
  assert.match(rendererSource, /return ensure\(match\[1\], match\[2\] \|\| match\[3\] \|\| match\[4\] \|\| ""\)/);
  assert.doesNotMatch(workspaceSource, /function MermaidPreview/);
});

test("Table 展示允许换行并使用固定列布局", () => {
  assert.match(css, /\.af-work-display-body--table \.af-work-display-table th,[\s\S]*?white-space: normal;[\s\S]*?overflow-wrap: anywhere;/);
  assert.match(css, /\.af-work-display-body--table \.af-work-display-table\s*\{[\s\S]*?table-layout: fixed;/);
  assert.match(css, /\.af-public-display-table\s*\{[\s\S]*?table-layout: fixed;/);
});

test("Markdown 放大后切换为居中限宽的阅读模式", () => {
  assert.match(workspaceSource, /readingMode=\{kind === "markdown"\}/);
  assert.match(workspaceSource, /<article className="af-markdown-reading-surface">/);
  assert.match(css, /\.af-markdown-reading-surface\s*\{[\s\S]*?width: min\(100%, 72rem\);[\s\S]*?margin: 0 auto;/);
  assert.match(css, /\.af-display-preview-content--reading \.af-visible-scroll-frame__scroller\.af-work-display-body--markdown\s*\{[\s\S]*?line-height: 1\.78;/);
});

test("Mermaid 放大后支持拖动画布、拖动节点、滚轮缩放和视图复位", () => {
  assert.match(workspaceSource, /interactiveMermaid=\{kind === "mermaid"\}/);
  assert.match(workspaceSource, /<MermaidDisplayBlock code=\{content\} interactive \/>/);
  assert.match(rendererSource, /function MermaidInteractiveViewport/);
  assert.match(rendererSource, /onPointerMove=/);
  assert.match(rendererSource, /onWheel=/);
  assert.match(rendererSource, /fitDiagram/);
  assert.match(rendererSource, /function MermaidFlowchartPreview\(\{ code, interactive = false \}\)/);
  assert.match(rendererSource, /const \[positionOverrides, setPositionOverrides\] = useState\(\{\}\)/);
  assert.match(rendererSource, /af-md-mermaid-node--draggable/);
  assert.match(rendererSource, /setPointerCapture/);
  assert.match(rendererSource, /MermaidFlowchartPreview code=\{text\} interactive=\{interactive\}/);
  assert.match(css, /\.af-mermaid-interactive\s*\{[\s\S]*?cursor: grab;[\s\S]*?touch-action: none;/);
  assert.match(css, /\.af-md-mermaid-node--draggable\s*\{[\s\S]*?cursor: grab;/);
});
