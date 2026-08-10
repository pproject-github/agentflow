import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  workspaceAssertRequiredInputs,
  workspaceKnowledgeSourcesFromText,
  workspaceMaterializeNodeInputFiles,
} from "../bin/lib/workspace-server.mjs";

test("large inline HTML input is materialized and replaced by a mounted path", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-inline-input-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nodeRunDir = path.join(root, "node");
  fs.mkdirSync(nodeRunDir, { recursive: true });
  const html = `<!DOCTYPE html><html><body>${"内容".repeat(3000)}</body></html>`;

  const result = workspaceMaterializeNodeInputFiles(nodeRunDir, root, { tapdContent: html });

  assert.equal(result.values.tapdContent, "inputs/tapdContent/tapdContent.html");
  assert.equal(result.mounts.tapdContent.inline, true);
  assert.equal(result.mounts.tapdContent.bytes, Buffer.byteLength(html, "utf-8"));
  assert.match(result.mounts.tapdContent.sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    fs.readFileSync(path.join(nodeRunDir, result.values.tapdContent), "utf-8"),
    html,
  );
});

test("small inline input remains inline", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-small-input-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const nodeRunDir = path.join(root, "node");
  fs.mkdirSync(nodeRunDir, { recursive: true });

  const result = workspaceMaterializeNodeInputFiles(nodeRunDir, root, { title: "短文本" });

  assert.deepEqual(result.values, {});
  assert.deepEqual(result.mounts, {});
});

test("missing referenced input fails before the agent starts", () => {
  assert.throws(
    () => workspaceAssertRequiredInputs("需求内容：${tapdContent}", {}, "subAgent_1"),
    /subAgent_1 缺少必需输入：tapdContent/,
  );
  assert.doesNotThrow(
    () => workspaceAssertRequiredInputs("需求内容：${tapdContent}", { tapdContent: "<p>ok</p>" }, "subAgent_1"),
  );
});

test("inline HTML is never accepted as a knowledge-base path", () => {
  assert.deepEqual(
    workspaceKnowledgeSourcesFromText("<!DOCTYPE html><html><body>正文</body></html>", "/tmp", "/tmp"),
    [],
  );
  assert.deepEqual(
    workspaceKnowledgeSourcesFromText(
      JSON.stringify({ sources: [{ kind: "local", path: "<!DOCTYPE html><html>正文</html>" }] }),
      "/tmp",
      "/tmp",
    ),
    [],
  );
});
