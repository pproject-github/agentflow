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

test("renders a modified function with real source context and pseudocode", () => {
  const html = prdWorkflowReviewMarkdownToHtml([
    "## TODO Actions",
    "",
    "- [ ] A1（统一保存缓存基线）",
    "  - 要解决的问题: 当前缓存字段分开提交。",
    "  - 准备怎么解决:",
    "    #change modify",
    "    #target function",
    "    #file iHeima/src/main/java/sg/bigo/live/model/utils/GiftUtils.java",
    "    #symbol GiftUtils#onGetGiftList",
    "    #base story/1017765@5293ee034e6e",
    "    #reference line241-245",
    "    if (resCode == RESCODE_SUCCESS) {",
    "        saveGifts(context, giftList, true);",
    "    }",
    "    #referenceend",
    "    #proposal pseudocode",
    "    convertedGifts = 转换完整礼物列表",
    "    如果保存失败",
    "        保留旧缓存并返回",
    "    #proposalend",
    "    #changeend",
  ].join("\n"));

  assert.match(html, /class="change-intent is-modify"/);
  assert.match(html, /data-target="function"/);
  assert.match(html, /修改方法/);
  assert.match(html, /GiftUtils#onGetGiftList/);
  assert.match(html, /基于.*story\/1017765@5293ee034e6e/);
  assert.match(html, /当前上下文/);
  assert.match(html, /class="change-intent__line-anchor">L241–L245<\/span>/);
  assert.match(html, /class="change-intent__source-number">241<\/span>/);
  assert.match(html, /方案伪代码/);
  assert.doesNotMatch(html, /class="change-intent__proposal[^"]*"[\s\S]*class="change-intent__source-number"/);
  assert.doesNotMatch(html, /#change|#reference|#proposal/);
});

test("renders a new function with an insertion neighbor and natural proposal", () => {
  const html = prdWorkflowReviewMarkdownToHtml([
    "#change add",
    "#target function",
    "#file modules/config/src/main/java/example/RemoteConfigRepository.kt",
    "#symbol RemoteConfigRepository#decideFetch",
    "#base story/1234567@7b41d109eaf2",
    "#insert-near RemoteConfigRepository#refresh",
    "#proposal natural",
    "新增纯决策方法，不在方法内发起网络请求。",
    "",
    "- 输入国家和上次成功时间",
    "- 返回明确的拉取决策",
    "#proposalend",
    "#changeend",
  ].join("\n"));

  assert.match(html, /class="change-intent is-add"/);
  assert.match(html, /新增方法/);
  assert.match(html, /建议位置.*RemoteConfigRepository#refresh.*附近/);
  assert.match(html, /自然语言方案/);
  assert.match(html, /<li>输入国家和上次成功时间<\/li>/);
  assert.doesNotMatch(html, /当前上下文|change-intent__line-anchor/);
});

test("renders proposed code with plus markers but no fake source lines", () => {
  const html = prdWorkflowReviewMarkdownToHtml([
    "#change add",
    "#target file",
    "#file modules/config/src/main/java/example/FetchPolicy.kt",
    "#base story/1234567@7b41d109eaf2",
    "#proposal code",
    "internal class FetchPolicy",
    "#proposalend",
    "#changeend",
  ].join("\n"));

  assert.match(html, /拟议代码 · 未写入/);
  assert.match(html, /class="change-intent__proposal-mark">\+<\/span>/);
  assert.match(html, /internal class FetchPolicy/);
  assert.doesNotMatch(html, /change-intent__source-number|L\d+/);
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
