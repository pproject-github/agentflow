import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const workspacePagePath = new URL("../builtin/web-ui/src/pages/WorkspacePage.jsx", import.meta.url);
const nodePropsPath = new URL("../builtin/web-ui/src/NodePropertiesPanel.jsx", import.meta.url);
const cssPath = new URL("../builtin/web-ui/src/index.css", import.meta.url);

function ruleBody(css, selector) {
  const start = css.indexOf(`\n${selector} {`);
  assert.notEqual(start, -1, `找不到 CSS 规则 ${selector}`);
  const end = css.indexOf("\n}", start);
  return css.slice(start, end);
}

test("分组框体让画布事件穿过去，只有标题条和缩放柄可交互", async () => {
  const [source, css] = await Promise.all([
    readFile(workspacePagePath, "utf8"),
    readFile(cssPath, "utf8"),
  ]);

  // React Flow 的节点外壳自己会写 pointer-events: all（因为分组可选中），
  // 只有 node.style 能盖过它——CSS 改内层没用。
  assert.match(source, /dragHandle: "\.af-work-group-node__drag-handle",[\s\S]{0,400}?style: \{ pointerEvents: "none" \}/);

  assert.match(ruleBody(css, ".af-work-group-node"), /pointer-events:\s*none/);
  assert.match(ruleBody(css, ".af-work-group-node__title"), /pointer-events:\s*auto/);
  assert.match(ruleBody(css, ".af-work-group-node__resize"), /pointer-events:\s*auto/);
});

test("双击节点先看配置，只读流程也一样", async () => {
  const source = await readFile(nodePropsPath, "utf8");

  assert.match(source, /useState\("config"\)/);
  // 只读预览没有执行记录，开在执行内容页就是一片空白，看上去像双击没反应。
  assert.doesNotMatch(source, /setPanelTab\(disabled \? "review" : "config"\)/);
  assert.doesNotMatch(source, /useState\(disabled \? "review" : "config"\)/);
  assert.match(source, /setPanelTab\("review"\)/); // 执行内容仍然只差一次点击
});
