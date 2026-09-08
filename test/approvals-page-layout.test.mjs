import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const cssPath = new URL("../builtin/web-ui/src/index.css", import.meta.url);

function ruleBody(css, selector) {
  const start = css.indexOf(`\n${selector} {`);
  assert.notEqual(start, -1, `找不到 CSS 规则 ${selector}`);
  const end = css.indexOf("\n}", start);
  return css.slice(start, end);
}

test("审批卡片不会把页面撑出屏幕", async () => {
  const css = await readFile(cssPath, "utf8");

  // 卡片是 grid item，min-width 默认 auto，压不到自身 min-content 以下。
  assert.match(css, /\.af-approvals-list \{[^}]*grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(ruleBody(css, ".af-approval-card__main"), /min-width: 0/);

  // 单行省略的摘要，min-content 等于整行文字宽——固定 max-width 就是把下限钉死。
  const preview = ruleBody(css, ".af-approval-card__preview");
  assert.match(preview, /white-space: nowrap/);
  assert.match(preview, /max-width: 100%/);
  assert.doesNotMatch(preview, /max-width: \d+rem/);

  assert.match(css, /\.af-approval-card__actions \{[^}]*flex-wrap: wrap/);
});
