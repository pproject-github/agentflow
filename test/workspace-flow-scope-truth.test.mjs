import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getPipelineFiles } from "../bin/lib/workspace-tree.mjs";

const PIPELINES_REL = path.join(".workspace", "agentflow", "pipelines");

function makeRoots(t) {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-scope-truth-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  t.after(() => {
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  const workspaceRoot = path.join(tempRoot, "workspace");
  fs.mkdirSync(path.join(workspaceRoot, PIPELINES_REL), { recursive: true });
  return { tempRoot, workspaceRoot };
}

function writeFlow(dir) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "workspace.flow.js"), "export const main = null;\n", "utf-8");
}

// 用户需求点: flowSource 是 URL 参数而不是流程属性。个人空间找不到就改道共享空间的兜底，
// 让写错的 flowSource=user 静默生效，定时登记、运行记录、admin 链接全部继承这个错标签，
// 形成一套平行的错误身份——线上 hello-overall-watch 因此同时挂了两条定时，重复执行两天。
test("a user-scoped lookup that lands in the shared space reports the shared scope", (t) => {
  const { workspaceRoot } = makeRoots(t);
  writeFlow(path.join(workspaceRoot, PIPELINES_REL, "hello-overall-watch"));

  const result = getPipelineFiles(workspaceRoot, "hello-overall-watch", "user", false, { userId: "wangqi" });
  assert.ok(result.path, "兜底改道要能找到目录");
  assert.equal(result.path, path.join(workspaceRoot, PIPELINES_REL, "hello-overall-watch"));
  assert.equal(result.flowSource, "workspace", "报出来的必须是真实落地的作用域");
});

test("a flow that really is personal keeps reporting the personal scope", async (t) => {
  const { tempRoot, workspaceRoot } = makeRoots(t);
  const { getUserPipelinesRoot } = await import(`../bin/lib/paths.mjs?scope-truth=${Date.now()}`);
  writeFlow(path.join(getUserPipelinesRoot("wangqi"), "my-own-flow"));
  assert.ok(tempRoot);

  const result = getPipelineFiles(workspaceRoot, "my-own-flow", "user", false, { userId: "wangqi" });
  assert.ok(result.path);
  assert.equal(result.flowSource, "user");
});

test("a shared-scope lookup keeps reporting the shared scope", (t) => {
  const { workspaceRoot } = makeRoots(t);
  writeFlow(path.join(workspaceRoot, PIPELINES_REL, "shared-flow"));

  const result = getPipelineFiles(workspaceRoot, "shared-flow", "workspace", false, { userId: "wangqi" });
  assert.ok(result.path);
  assert.equal(result.flowSource, "workspace");
});

test("a missing flow reports the error, not a scope", (t) => {
  const { workspaceRoot } = makeRoots(t);
  const result = getPipelineFiles(workspaceRoot, "nope", "user", false, { userId: "wangqi" });
  assert.equal(result.error, "Pipeline directory not found");
  assert.equal(result.path, undefined);
});
