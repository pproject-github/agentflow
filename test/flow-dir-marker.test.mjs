/**
 * 「这个目录是不是一个流程」只有一条判据。
 *
 * `flow.yaml` 的执行栈退休之后，它悄悄退化成了目录哨兵：内容是死的，存在却承重——十来处
 * 各写了一遍 `existsSync(dir + "/flow.yaml")`，没有它的目录在列表、路径解析、改名归档里
 * 全都不存在。这套断言盯住两件事：判据只有一条（`isFlowDir`），以及只有代码的流程目录
 * 是一等公民。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { unzipSync, zipSync } from "fflate";

import { collectPublishableFlowFiles } from "../bin/lib/hub-publish.mjs";
import { normalizeZipToPipelineFiles } from "../bin/lib/flow-import.mjs";
import { readPipelineListDescription, resolveFlowDirAbs } from "../bin/lib/catalog-flows.mjs";
import { FLOW_MARKER_FILENAMES, isFlowDir } from "../bin/lib/paths.mjs";
import { readWorkspaceGraphFiles } from "../bin/lib/workspace-flow-store.mjs";

const tmpdir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-marker-")));

const SOURCE = `import { display, flow, provide } from "agentflow/flow";

const greeting = provide.str("问候语", { value: "hello" });
const show = display.markdown("展示", { content: greeting.value });

export const run = flow("Run", show);
`;

/** 只有代码、一行 yaml 都没有的流程目录。 */
function seedCodeOnlyFlow(dir, { description = "只有代码的流程" } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "workspace.flow.js"), SOURCE, "utf-8");
  fs.writeFileSync(path.join(dir, "workspace.layout.json"), JSON.stringify({
    version: 1,
    description,
    nodes: { greeting: { x: 80, y: 80 }, show: { x: 420, y: 80 }, run: { x: 80, y: 300 } },
  }, null, 2), "utf-8");
  return dir;
}

test("三种标记文件任一都算流程目录，都没有就不算", () => {
  assert.deepEqual(FLOW_MARKER_FILENAMES, ["workspace.flow.js", "workspace.graph.json", "flow.yaml"]);
  for (const marker of FLOW_MARKER_FILENAMES) {
    const dir = tmpdir();
    assert.equal(isFlowDir(dir), false, "空目录不该算流程");
    fs.writeFileSync(path.join(dir, marker), "", "utf-8");
    assert.equal(isFlowDir(dir), true, `${marker} 应当能标记流程目录`);
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const notAFlow = tmpdir();
  fs.writeFileSync(path.join(notAFlow, "README.md"), "x", "utf-8");
  assert.equal(isFlowDir(notAFlow), false);
  assert.equal(isFlowDir(""), false);
  assert.equal(isFlowDir(path.join(notAFlow, "不存在")), false);
});

test("解析流程目录不再要求 flow.yaml", () => {
  const home = tmpdir();
  const workspaceRoot = tmpdir();
  const flowDir = seedCodeOnlyFlow(path.join(workspaceRoot, ".workspace", "agentflow", "pipelines", "codeOnly"));

  const resolved = resolveFlowDirAbs(workspaceRoot, "codeOnly", "workspace", {});
  assert.equal(resolved.dir, flowDir, resolved.error || "");
  assert.deepEqual(
    resolveFlowDirAbs(workspaceRoot, "nope", "workspace", {}),
    { error: "Flow not found: nope" },
  );
  fs.rmSync(home, { recursive: true, force: true });
});

test("列表说明对代码化的流程从 layout.json 读，老流程仍从 flow.yaml 读", () => {
  const codeDir = seedCodeOnlyFlow(path.join(tmpdir(), "code"), { description: "代码流程的说明" });
  assert.equal(readPipelineListDescription(codeDir), "代码流程的说明");

  const yamlDir = tmpdir();
  fs.writeFileSync(path.join(yamlDir, "flow.yaml"), "instances: {}\nedges: []\nui:\n  description: 老流程的说明\n", "utf-8");
  assert.equal(readPipelineListDescription(yamlDir), "老流程的说明");

  // 两个都有时以代码为准——代码是权威存储
  fs.writeFileSync(path.join(codeDir, "flow.yaml"), "instances: {}\nedges: []\nui:\n  description: 过时的说明\n", "utf-8");
  assert.equal(readPipelineListDescription(codeDir), "代码流程的说明");

  // 说明为空不该冒充成空字符串
  const bare = seedCodeOnlyFlow(path.join(tmpdir(), "bare"), { description: "   " });
  assert.equal(readPipelineListDescription(bare), undefined);
});

test("只有代码的流程目录，图读得出来", () => {
  const dir = seedCodeOnlyFlow(path.join(tmpdir(), "codeOnly"));
  const read = readWorkspaceGraphFiles(dir);
  assert.equal(read.format, "dsl");
  assert.deepEqual(Object.keys(read.graph.instances).sort(), ["greeting", "run", "show"]);
  assert.equal(read.graph.ui.description, "只有代码的流程", "说明要跟着 layout 回到图里");
});

test("发布代码化的流程时补一个 flow.yaml，包还能被导入认出来", () => {
  const dir = seedCodeOnlyFlow(path.join(tmpdir(), "toPublish"));
  const packaged = collectPublishableFlowFiles(dir);
  assert.deepEqual(
    packaged.map((e) => e.rel).sort(),
    ["workspace.flow.js", "workspace.layout.json"],
    "目录里本来就没有 flow.yaml",
  );

  // hubPublish 在打包时补的那一份（这里复刻同样的内容，避免测试去联网）
  const entries = Object.fromEntries(packaged.map((e) => [e.rel, new Uint8Array(fs.readFileSync(e.abs))]));
  entries["flow.yaml"] = new Uint8Array(Buffer.from("instances: {}\nedges: []\nui:\n  description: 只有代码的流程\n", "utf8"));

  const normalized = normalizeZipToPipelineFiles(unzipSync(zipSync(entries, { level: 6 })));
  assert.ok(!normalized.error, normalized.error || "");
  assert.ok(normalized.files.has("flow.yaml"), "缺 flow.yaml 的包导入端会直接拒收");
  assert.ok(normalized.files.has("workspace.flow.js"), "真正的图必须还在包里");
});
