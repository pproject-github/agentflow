import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  WorkspaceFlowParseError,
  designFingerprint,
  readWorkspaceDesign,
  writeWorkspaceDesign,
} from "../bin/lib/workspace-flow-store.mjs";
import { splitWorkspaceGraph } from "../bin/lib/workspace-state.mjs";

function tempDir() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-flow-store-")));
  return dir;
}

const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), "utf-8");
const exists = (dir, rel) => fs.existsSync(path.join(dir, rel));

/** 一张覆盖分支、自定义输出槽、外置长文本、图片的图。 */
function sampleGraph() {
  const long = "长提示词。".repeat(700);
  return {
    version: 1,
    instances: {
      run_1: {
        definitionId: "workspace_run",
        label: "Run",
        input: [{ type: "node", name: "prev", value: "" }],
        output: [{ type: "node", name: "next", value: "" }],
      },
      plan: {
        definitionId: "agent_subAgent",
        label: "规划",
        model: "claude-opus",
        body: long,
        input: [{ type: "node", name: "prev", value: "" }],
        output: [
          { type: "node", name: "next", value: "" },
          { type: "text", name: "result", value: "" },
          { type: "text", name: "storyId", value: "" },
        ],
      },
      gate: {
        definitionId: "control_if",
        label: "判断",
        input: [
          { type: "node", name: "prev", value: "" },
          { type: "bool", name: "prediction", value: "" },
        ],
        output: [
          { type: "node", name: "next1", value: "" },
          { type: "node", name: "next2", value: "" },
        ],
      },
      ok: {
        definitionId: "display_markdown",
        label: "通过",
        body: "# 手写的说明，不是运行产出",
        input: [
          { type: "node", name: "prev", value: "" },
          { type: "text", name: "content", value: "# 手写的说明，不是运行产出" },
        ],
        output: [
          { type: "text", name: "content", value: "" },
          { type: "node", name: "next", value: "" },
        ],
      },
      pic: {
        definitionId: "display_image",
        label: "图",
        images: [{ name: "a.png", dataUrl: "data:image/png;base64,AAAA" }],
        input: [
          { type: "node", name: "prev", value: "" },
          { type: "text", name: "src", value: "outputs/a.png" },
        ],
        output: [
          { type: "text", name: "src", value: "" },
          { type: "node", name: "next", value: "" },
        ],
      },
    },
    edges: [
      { source: "run_1", target: "plan", sourceHandle: "output-0", targetHandle: "input-0" },
      { source: "plan", target: "gate", sourceHandle: "output-0", targetHandle: "input-0" },
      { source: "gate", target: "ok", sourceHandle: "output-0", targetHandle: "input-0" },
      { source: "gate", target: "pic", sourceHandle: "output-1", targetHandle: "input-0" },
    ],
    ui: {
      nodePositions: { run_1: { x: 0, y: 0 }, plan: { x: 280, y: 0 }, gate: { x: 560, y: 0 }, ok: { x: 840, y: -100 }, pic: { x: 840, y: 100 } },
      nodeSizes: { ok: { width: 760, height: 520 } },
    },
  };
}

test("设计态写成代码，长文本外置，历史 graph.json 退场", () => {
  const dir = tempDir();
  const design = splitWorkspaceGraph(sampleGraph()).design;
  fs.writeFileSync(path.join(dir, "workspace.graph.json"), JSON.stringify(design), "utf-8");

  const result = writeWorkspaceDesign(dir, design);
  assert.equal(result.format, "dsl");
  assert.equal(result.degradedReason, null);
  assert.ok(exists(dir, "workspace.flow.js"));
  assert.ok(exists(dir, "workspace.layout.json"));
  assert.ok(exists(dir, "workspace.nodes.json"), "images / model 要落到 nodes.json");
  assert.ok(!exists(dir, "workspace.graph.json"), "迁移成功后历史文件必须删掉");

  assert.deepEqual(result.externals, ["prompts/plan.md"]);
  assert.ok(read(dir, "prompts/plan.md").startsWith("长提示词。"));
  assert.ok(read(dir, "workspace.flow.js").includes('file("prompts/plan.md")'));
  assert.ok(!read(dir, "workspace.flow.js").includes("data:image/png"), "图片 base64 不该进代码");
});

test("读回来与写进去是同一张图", () => {
  const dir = tempDir();
  const design = splitWorkspaceGraph(sampleGraph()).design;
  writeWorkspaceDesign(dir, design);
  const back = readWorkspaceDesign(dir);
  assert.equal(back.format, "dsl");
  assert.equal(designFingerprint(back.graph), designFingerprint(design));
});

test("子流程 Start 和 Return 的人工布局能随代码化流程往返", () => {
  const dir = tempDir();
  const design = splitWorkspaceGraph(sampleGraph()).design;
  design.ui.subflowBoundaryPositions = {
    "subflow-start:inspectIssue": { x: 120, y: 460 },
    "subflow-return:inspectIssue": { x: 1380, y: 620 },
  };

  writeWorkspaceDesign(dir, design);
  const back = readWorkspaceDesign(dir).graph;
  assert.deepEqual(back.ui.subflowBoundaryPositions, design.ui.subflowBoundaryPositions);
});

test("再写一次不产生任何 diff", () => {
  const dir = tempDir();
  const design = splitWorkspaceGraph(sampleGraph()).design;
  writeWorkspaceDesign(dir, design);
  const before = ["workspace.flow.js", "workspace.layout.json", "workspace.nodes.json", "prompts/plan.md"]
    .map((f) => read(dir, f));
  const again = writeWorkspaceDesign(dir, readWorkspaceDesign(dir).graph);
  assert.equal(again.changed, false, "内容没变时不该重写文件");
  const after = ["workspace.flow.js", "workspace.layout.json", "workspace.nodes.json", "prompts/plan.md"]
    .map((f) => read(dir, f));
  assert.deepEqual(after, before);
});

test("正文缩短到阈值以下时，上一次外置的文件被清掉", () => {
  const dir = tempDir();
  const design = splitWorkspaceGraph(sampleGraph()).design;
  writeWorkspaceDesign(dir, design);
  assert.ok(exists(dir, "prompts/plan.md"));

  design.instances.plan.body = "短了";
  const result = writeWorkspaceDesign(dir, design);
  assert.deepEqual(result.externals, []);
  assert.ok(!exists(dir, "prompts/plan.md"), "陈旧的外置文本必须删掉");
  assert.equal(readWorkspaceDesign(dir).graph.instances.plan.body, "短了");
});

test("清理只删自己写过的文件，不碰同目录下作者手写的脚本", () => {
  const dir = tempDir();
  const design = splitWorkspaceGraph(sampleGraph()).design;
  writeWorkspaceDesign(dir, design);
  fs.mkdirSync(path.join(dir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(dir, "scripts", "plan.sh"), "# 作者手写的", "utf-8");

  design.instances.plan.body = "短了";
  writeWorkspaceDesign(dir, design);
  assert.equal(read(dir, "scripts/plan.sh"), "# 作者手写的");
});

test("externals 清单被改成目录外的路径时不越界删除", () => {
  const dir = tempDir();
  const design = splitWorkspaceGraph(sampleGraph()).design;
  writeWorkspaceDesign(dir, design);

  const victim = path.join(dir, "..", `victim-${path.basename(dir)}.txt`);
  fs.writeFileSync(victim, "别删我", "utf-8");
  const meta = JSON.parse(read(dir, "workspace.nodes.json"));
  meta.externals = [...meta.externals, `prompts/../../${path.basename(victim)}`, "/etc/hosts"];
  fs.writeFileSync(path.join(dir, "workspace.nodes.json"), JSON.stringify(meta), "utf-8");

  design.instances.plan.body = "短了";
  writeWorkspaceDesign(dir, design);
  assert.ok(fs.existsSync(victim), "清理不能逃出流程目录");
  fs.rmSync(victim, { force: true });
});

test("没有 flow.js 时回落读历史 graph.json", () => {
  const dir = tempDir();
  const design = splitWorkspaceGraph(sampleGraph()).design;
  fs.writeFileSync(path.join(dir, "workspace.graph.json"), JSON.stringify(design, null, 2), "utf-8");
  const back = readWorkspaceDesign(dir);
  assert.equal(back.format, "json");
  assert.equal(designFingerprint(back.graph), designFingerprint(design));
});

test("flow.js 里出现表达不了的语句时抛错，绝不降级成空图", () => {
  const dir = tempDir();
  writeWorkspaceDesign(dir, splitWorkspaceGraph(sampleGraph()).design);
  const source = read(dir, "workspace.flow.js");
  fs.writeFileSync(
    path.join(dir, "workspace.flow.js"),
    `${source}\nfor (const x of []) { console.log(x); }\n`,
    "utf-8",
  );
  assert.throws(() => readWorkspaceDesign(dir), WorkspaceFlowParseError);
});

test("生成的代码解析不回原图时退回 graph.json，不留下残缺的 flow.js", () => {
  const dir = tempDir();
  const design = splitWorkspaceGraph(sampleGraph()).design;
  // definitionId 不在定义表里 —— 代码里无法表达成任何一种调用
  design.instances.plan.definitionId = "totally_unknown_kind";

  const result = writeWorkspaceDesign(dir, design);
  assert.equal(result.format, "json");
  assert.ok(result.degradedReason, "退回时必须说明原因");
  assert.ok(!exists(dir, "workspace.flow.js"), "退回时不能留下优先级更高的 flow.js");
  assert.equal(designFingerprint(readWorkspaceDesign(dir).graph), designFingerprint(design));
});

test("已经是代码形态的流程退回 JSON 时，旧的 flow.js 必须被清掉", () => {
  const dir = tempDir();
  const design = splitWorkspaceGraph(sampleGraph()).design;
  assert.equal(writeWorkspaceDesign(dir, design).format, "dsl");

  design.instances.plan.definitionId = "totally_unknown_kind";
  const result = writeWorkspaceDesign(dir, design);
  assert.equal(result.format, "json");
  // 留着上一版 flow.js 最危险：它优先级更高，读回来就是那张过时的图
  for (const stale of ["workspace.flow.js", "workspace.layout.json", "workspace.nodes.json"]) {
    assert.ok(!exists(dir, stale), `退回 JSON 时 ${stale} 必须删掉`);
  }
  const back = readWorkspaceDesign(dir);
  assert.equal(back.format, "json");
  assert.equal(designFingerprint(back.graph), designFingerprint(design));
});

test("迁移历史图：运行产出还内联在 graph.json 里也能转成代码", async () => {
  const { migrateFlowDirToDsl } = await import("../bin/lib/flow-dsl/cli.mjs");
  const dir = tempDir();
  const full = sampleGraph();
  // 拆分前的形态：运行产出、上下文注入值都还在实例里
  full.instances.plan.output[1].value = "上次跑出来的一大段产出";
  full.instances.plan.input.push({ type: "text", name: "workspaceContext", value: "运行时灌进来的工作区摘要" });
  fs.writeFileSync(path.join(dir, "workspace.graph.json"), JSON.stringify(full, null, 2), "utf-8");

  const result = migrateFlowDirToDsl(dir);
  assert.equal(result.format, "dsl", result.degradedReason || "");
  assert.ok(!exists(dir, "workspace.graph.json"));
  assert.ok(!read(dir, "workspace.flow.js").includes("上次跑出来的一大段产出"), "运行产出不该进代码");

  const state = JSON.parse(read(dir, "workspace.state.json"));
  assert.equal(state.outputs.plan.result.value, "上次跑出来的一大段产出");
  assert.equal(state.inputs.plan.workspaceContext.value, "运行时灌进来的工作区摘要");

  // 重新读回来的完整图与迁移前语义一致
  const { readWorkspaceGraphFiles } = await import("../bin/lib/workspace-flow-store.mjs");
  assert.equal(designFingerprint(readWorkspaceGraphFiles(dir).graph), designFingerprint(full));

  assert.equal(migrateFlowDirToDsl(dir).migrated, false, "已经是代码形态时不该重复迁移");
});

test("指纹认出真实差异，不被表示差异干扰", () => {
  const base = splitWorkspaceGraph(sampleGraph()).design;
  const same = JSON.parse(JSON.stringify(base));
  same.instances.plan.role = "normal";              // 等价于没写
  same.instances.plan.scriptRef = "";               // 等价于没写
  same.instances.ok.input[1].showOnNode = true;     // 定义表里就是 true
  assert.equal(designFingerprint(same), designFingerprint(base));

  for (const mutate of [
    (g) => { g.instances.plan.body += "!"; },
    (g) => { g.instances.plan.model = "别的模型"; },
    (g) => { g.instances.ok.label = "别的名字"; },
    (g) => { g.edges.pop(); },
    (g) => { g.edges[0].targetHandle = "input-1"; },
    (g) => { delete g.instances.pic; },
    (g) => { g.ui.nodePositions.plan.x = 999; },
    (g) => { g.instances.pic.images = null; },
    (g) => { g.instances.ok.input[1].required = false; },
  ]) {
    const mutated = JSON.parse(JSON.stringify(base));
    mutate(mutated);
    assert.notEqual(designFingerprint(mutated), designFingerprint(base), `${mutate} 应当被指纹识别为差异`);
  }
});
