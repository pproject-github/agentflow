import assert from "node:assert/strict";
import test from "node:test";
import {
  prdWorkflowReviewHtml,
  prdWorkflowReviewMarkdownToHtml,
} from "../bin/lib/ui-server.mjs";

test("renders TODO actions as separate navigable cards", () => {
  const html = prdWorkflowReviewMarkdownToHtml([
    "## TODO Actions",
    "",
    "执行说明。",
    "",
    "- [ ] A1（统一拉取决策）在 `Helper.run()`",
    "  内完成统一门控。",
    "  - 位置: `Helper.java`",
    "  - 逻辑:",
    "    ```text",
    "    fetch -> decide",
    "    ```",
    "",
    "- [x] A2（监听生命周期）",
    "  - 位置: `Listener.java`",
    "",
    "## 完成标准",
    "",
    "- A1 和 A2 完成。",
  ].join("\n"));

  assert.match(html, /class="action-index"/);
  assert.match(html, /href="#action-a1"/);
  assert.match(html, /href="#action-a2"/);
  assert.match(html, /class="action-card" id="action-a1"/);
  assert.match(html, /class="action-card is-complete" id="action-a2"/);
  assert.match(html, /统一拉取决策.*Helper\.run\(\).*内完成统一门控/);
  assert.match(html, /class="action-card__status">待完成/);
  assert.match(html, /class="action-card__status is-complete">已完成/);
  assert.match(html, /<h2>完成标准<\/h2>/);
  assert.doesNotMatch(html, /id="action-a1-2"/);
});

test("keeps ordinary markdown lists unchanged outside an actions section", () => {
  const html = prdWorkflowReviewMarkdownToHtml([
    "## 场景",
    "",
    "- A1 is only a reference here",
    "- regular item",
  ].join("\n"));

  assert.doesNotMatch(html, /action-card/);
  assert.match(html, /<ul><li>A1 is only a reference here<\/li><li>regular item<\/li><\/ul>/);
});

test("uses a terminal-inspired document palette with semantic accent colors", () => {
  const html = prdWorkflowReviewHtml("Preview", "## TODO Actions\n\n- [ ] A1 Test");

  assert.match(html, /--bg: #1a1b26/);
  assert.match(html, /--panel: #1f2335/);
  assert.match(html, /--heading: #f4f4f5/);
  assert.match(html, /--body: #d4d4d8/);
  assert.match(html, /--interactive: #7aa2f7/);
  assert.match(html, /--link: #7dcfff/);
  assert.match(html, /--pending-text: #e0af68/);
  assert.match(html, /--complete-text: #9ece6a/);
  assert.match(html, /background: var\(--bg\)/);
  assert.match(html, /\.action-card:target \{ border-color: var\(--interactive\)/);
  assert.doesNotMatch(html, /radial-gradient/);
  assert.doesNotMatch(html, /border-left: 3px solid var\(--action-accent\)/);
});

test("promotes the leading markdown H1 to the single page title", () => {
  const html = prdWorkflowReviewHtml(
    "Payload fallback title",
    [
      "---",
      "tapd_id: 1015046",
      "---",
      "",
      "# **Markdown** `Review` Title",
      "",
      "正文内容。",
      "",
      "## 审查范围",
    ].join("\n"),
  );

  assert.match(html, /<title>Markdown Review Title<\/title>/);
  assert.match(html, /<h1>Markdown Review Title<\/h1>/);
  assert.equal((html.match(/<h1>/g) || []).length, 1);
  assert.doesNotMatch(html, /Payload fallback title/);
  assert.doesNotMatch(html, /<article>[\s\S]*<h1>/);
  assert.match(html, /<article>[\s\S]*正文内容。[\s\S]*<h2>审查范围<\/h2>/);
});

test("uses the payload title when markdown does not start with an H1", () => {
  const html = prdWorkflowReviewHtml(
    "Payload fallback title",
    "正文在前。\n\n# Later heading",
  );

  assert.match(html, /<title>Payload fallback title<\/title>/);
  assert.match(html, /<h1>Payload fallback title<\/h1>/);
  assert.match(html, /<article>[\s\S]*<h1>Later heading<\/h1>/);
});
