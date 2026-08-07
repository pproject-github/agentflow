import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeStaticFlowPreview } from "../bin/lib/flow-static-preview.mjs";

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

test("local preview writes one self-contained HTML snapshot and exits", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-static-preview-"));
  try {
    const flowPath = path.join(tempRoot, "flow.yaml");
    const outputPath = path.join(tempRoot, "preview.html");
    const distDir = path.join(tempRoot, "dist");
    fs.mkdirSync(path.join(distDir, "assets"), { recursive: true });
    fs.writeFileSync(
      path.join(distDir, "index.html"),
      '<script type="module" src="/assets/app.js"></script><link rel="stylesheet" href="/assets/app.css">',
      "utf-8",
    );
    fs.writeFileSync(path.join(distDir, "assets", "app.js"), 'document.body.dataset.ready="yes";', "utf-8");
    fs.writeFileSync(path.join(distDir, "assets", "app.css"), "body{background:#111}", "utf-8");
    fs.writeFileSync(flowPath, "instances:\n  demo:\n    body: '</script><script>bad()</script>'\nedges: []\n", "utf-8");

    const result = writeStaticFlowPreview({
      flowId: "generated-demo",
      flowPath,
      outputPath,
      distDir,
      nodeCatalog: {
        nodes: [{ id: "tool_preview_only", displayName: "Preview only" }],
        pipelineTranslations: {},
      },
    });
    const html = fs.readFileSync(outputPath, "utf-8");

    assert.equal(result.outputPath, outputPath);
    assert.equal(fs.readdirSync(tempRoot).filter((name) => name.endsWith(".html")).length, 1);
    assert.match(html, /window\.__AGENTFLOW_STATIC_FLOW_PREVIEW__=/);
    assert.match(html, /agentflow-static-preview-v1/);
    assert.match(html, /tool_preview_only/);
    assert.match(html, /<style>body\{background:#111\}<\/style>/);
    assert.match(html, /<script type="module">document\.body\.dataset\.ready="yes";<\/script>/);
    assert.doesNotMatch(html, /src="\/assets\/app\.js"/);
    assert.doesNotMatch(html, /href="\/assets\/app\.css"/);
    assert.doesNotMatch(html, /<script>bad\(\)<\/script>/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("web UI routes embedded preview data to the shared read-only Flow editor", () => {
  const app = fs.readFileSync(path.join(repoRoot, "builtin/web-ui/src/App.jsx"), "utf-8");
  const editor = fs.readFileSync(path.join(repoRoot, "builtin/web-ui/src/pages/FlowEditorPage.jsx"), "utf-8");
  const css = fs.readFileSync(path.join(repoRoot, "builtin/web-ui/src/index.css"), "utf-8");
  const main = fs.readFileSync(path.join(repoRoot, "bin/lib/main.mjs"), "utf-8");
  const server = fs.readFileSync(path.join(repoRoot, "bin/lib/ui-server.mjs"), "utf-8");

  assert.match(app, /window\.__AGENTFLOW_STATIC_FLOW_PREVIEW__[\s\S]{0,100}<FlowEditorPage previewMode/);
  assert.match(editor, /staticPreview = previewMode && window\.__AGENTFLOW_STATIC_FLOW_PREVIEW__/);
  assert.match(editor, /flowYaml: String\(staticPreview\.flowYaml/);
  assert.match(editor, /paletteJson = staticPreview\.nodeCatalog/);
  assert.match(editor, /sp\.get\("flowId"\) \|\| \(previewMode \? flows\[0\]\?\.id : ""\)/);
  assert.match(editor, /readOnly=\{previewMode\}/);
  assert.match(editor, /data: \{ \.\.\.merged\.data, readOnly: true \}/);
  // 旧 flow AI Composer 已下线：编辑器不再有底部 Composer 停靠栏、右侧面板或 /api/composer-agent 调用。
  assert.doesNotMatch(editor, /af-bottom-composer-stack/);
  assert.doesNotMatch(editor, /rightPanel === "composer"/);
  assert.doesNotMatch(editor, /api\/composer-agent/);
  assert.doesNotMatch(editor, /重新读取/);
  // Flow 编辑器已收敛为只读预览渲染器：编辑/运行/调度类控件整体移除，不再靠 previewMode 分支隐藏。
  assert.doesNotMatch(editor, /handleSlotWarningsRefresh/);
  assert.match(css, /\.af-flow-preview-badge\s*\{/);
  assert.match(css, /\.af-pipeline-page--preview\s*\{[\s\S]{0,100}height: 100%/);
  assert.match(main, /writeStaticFlowPreview\(/);
  assert.match(main, /pathToFileURL\(result\.outputPath\)/);
  assert.doesNotMatch(server, /previewFlowPath/);
  assert.doesNotMatch(server, /Local preview is read-only/);
});
