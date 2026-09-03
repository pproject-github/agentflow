import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const componentPath = new URL("../builtin/web-ui/src/components/ReleaseNodeInspector.jsx", import.meta.url);

test("release node inspector exposes read-only completed and editable pending modes", () => {
  assert.equal(fs.existsSync(componentPath), true);
  const source = fs.readFileSync(componentPath, "utf8");
  assert.match(source, /ReleaseNodeInspector/);
  assert.match(source, /completed/);
  assert.match(source, /readOnly|disabled/);
  assert.match(source, /最大化|maximize/);
  assert.match(source, /日志/);
  assert.match(source, /调试数据|原始输出|原始 JSON/);
  assert.match(source, /onSave/);
  assert.match(source, /onPreview/);
  assert.match(source, /ReactMarkdown/);
  assert.match(source, /af-release-inspector__hero/);
  assert.match(source, /textarea/);
  assert.match(source, /type === "checkbox"/);
  assert.match(source, /event\.target\.checked/);
  assert.match(source, /buildOutcomeMarkdown/);
  assert.match(source, /af-release-inspector__artifact-list/);
  assert.match(source, /af-release-inspector__record-list/);
  assert.match(source, /完成事项/);
  assert.match(source, /产物/);
  assert.match(source, /做了什么/);
  assert.match(source, /inferArtifactsFromText/);
  assert.match(source, /unwrapSummaryText/);
  assert.match(source, /parseLeadingJsonValue/);
  assert.match(source, /unwrapStructuredLists/);
});

test("failure reason is shown only for failed status, not while running with a stale error", () => {
  const source = fs.readFileSync(componentPath, "utf8");
  assert.match(source, /item\.error && \(mode === "failed" \|\| item\.status === "failed"\)/);
  assert.doesNotMatch(source, /\{item\.error \? <section className="af-release-inspector__section is-error">/);
});

test("inspector shows artifacts for waiting and not only completed", async () => {
  const inspector = await fs.promises.readFile(componentPath, "utf8");
  assert.match(inspector, /artifacts\.length > 0/);
  assert.doesNotMatch(inspector, /completedView && artifacts\.length > 0 \? \(/);
});
