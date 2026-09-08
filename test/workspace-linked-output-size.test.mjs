import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { workspaceResolveLinkedOutputForTarget } from "../bin/lib/workspace-server.mjs";

function flowWithOutput(t, relPath, content) {
  const flowDir = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-linked-output-"));
  t.after(() => fs.rmSync(flowDir, { recursive: true, force: true }));
  const abs = path.join(flowDir, relPath);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf-8");
  return flowDir;
}

// 用户需求点: Agent 产出的 HTML 报告在磁盘上是完整的，但流到 display_html 时被按
// prompt 的尺寸截断，界面反而提示"可能是生成或保存时被截断"。
test("a large linked HTML report reaches the display node intact", (t) => {
  const body = "<p>行</p>\n".repeat(40000);
  const html = `<!doctype html>\n<html>\n<body>\n${body}</body>\n</html>\n`;
  assert.ok(html.length > 200000, "构造的报告要比旧的 120000 上限大");
  const flowDir = flowWithOutput(t, "outputs/subAgent_1/result.html", html);

  const resolved = workspaceResolveLinkedOutputForTarget(
    "outputs/subAgent_1/result.html",
    { name: "content", type: "text" },
    flowDir,
  );
  assert.equal(resolved, html);
  assert.ok(!resolved.includes("[truncated"), "不应该带截断标记");
  assert.match(resolved, /<\/html>\s*$/);
});

test("a path-typed target slot still receives the path, not the file body", (t) => {
  const flowDir = flowWithOutput(t, "outputs/subAgent_1/result.html", "<!doctype html><html></html>");
  for (const slot of [{ name: "filePath", type: "text" }, { name: "content", type: "file" }]) {
    assert.equal(
      workspaceResolveLinkedOutputForTarget("outputs/subAgent_1/result.html", slot, flowDir),
      "outputs/subAgent_1/result.html",
    );
  }
});

test("a runaway file is still bounded and says so", (t) => {
  const huge = "x".repeat(5_000_050);
  const flowDir = flowWithOutput(t, "outputs/subAgent_1/result.html", huge);
  const resolved = workspaceResolveLinkedOutputForTarget(
    "outputs/subAgent_1/result.html",
    { name: "content", type: "text" },
    flowDir,
  );
  assert.ok(resolved.length < huge.length);
  assert.match(resolved, /\[truncated 50 chars\]$/);
});
