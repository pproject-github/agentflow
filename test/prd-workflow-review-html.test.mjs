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

test("renders planned code blocks with file and source line anchors", () => {
  const html = prdWorkflowReviewMarkdownToHtml([
    "## TODO Actions",
    "",
    "- [ ] A1（保存缓存基线）",
    "  - 要解决的问题: 三个缓存字段当前分开提交。",
    "  - 准备怎么解决:",
    "    #file iHeima/src/main/java/sg/bigo/live/model/utils/GiftUtils.java",
    "    #code line245-246",
    "    List<VGiftInfoBean> convertedGifts = convertToVGiftInfoBeanList(giftList);",
    "    boolean success = saveFetchedGiftBaseline(context, convertedGifts, version);",
    "    #codeend",
    "",
    "    如果 success 为 false，保留旧缓存并允许下次重试。",
  ].join("\n"));

  assert.match(html, /class="planned-code"/);
  assert.match(html, /data-file="iHeima\/src\/main\/java\/sg\/bigo\/live\/model\/utils\/GiftUtils\.java"/);
  assert.match(html, /class="planned-code__anchor">L245–L246<\/span>/);
  assert.match(html, /class="planned-code__badge">计划代码 · 未写入<\/span>/);
  assert.match(html, /class="planned-code__number">245<\/span>/);
  assert.match(html, /class="planned-code__number">246<\/span>/);
  assert.match(html, /saveFetchedGiftBaseline/);
  assert.doesNotMatch(html, /#file|#codeend/);
  assert.match(html, /如果 success 为 false/);
});

test("escapes planned code paths and content", () => {
  const html = prdWorkflowReviewMarkdownToHtml([
    "#file src/<unsafe>.java",
    "#code line7",
    "<script>alert('x')</script>",
    "#codeend",
  ].join("\n"));

  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /data-file="src\/&lt;unsafe&gt;\.java"/);
  assert.match(html, /&lt;script&gt;alert\('x'\)&lt;\/script&gt;/);
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

test("hides legacy prd-flow metadata while preserving fenced examples", () => {
  const markdown = [
    "---",
    "tapd_id: 1133202860001017765",
    "---",
    "",
    "<!-- prd-flow-start",
    "issues:",
    "- key: gift-cache-integrity-validation",
    "  platform: android",
    "prd-flow-end -->",
    "",
    "# Gift cache design",
    "",
    "Visible content.",
    "",
    "```md",
    "<!-- prd-flow-start",
    "example: remains visible",
    "prd-flow-end -->",
    "```",
  ].join("\n");

  const rendered = prdWorkflowReviewMarkdownToHtml(markdown);
  const page = prdWorkflowReviewHtml("Fallback", markdown);

  assert.doesNotMatch(rendered, /gift-cache-integrity-validation/);
  assert.doesNotMatch(rendered, /platform: android/);
  assert.match(rendered, /example: remains visible/);
  assert.match(page, /<title>Gift cache design<\/title>/);
  assert.equal((page.match(/<h1>/g) || []).length, 1);
  assert.doesNotMatch(page, /gift-cache-integrity-validation/);
});
