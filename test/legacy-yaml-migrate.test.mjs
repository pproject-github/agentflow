/**
 * `flow.yaml` -> Workspace 图的迁移。
 *
 * Start/End 执行栈退休之后 yaml 流程变成了墓碑：目录哨兵认它所以还挂在列表里，读图那条路
 * 不认所以点开是空图——跑不了、编辑不了，里面的 body / prompt / script 只能干看着。没有这
 * 条迁移路，摘掉哨兵等于让这些内容从「坏的但看得见」变成「坏的且找不到」。
 *
 * 这套断言盯的是迁移唯一的卖点：**丢了什么，当场说清楚**。默认不许有损，报清单；认了才落盘。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { migrateFlowDirToDsl } from "../bin/lib/flow-dsl/cli.mjs";
import { legacyYamlToDesignGraph } from "../bin/lib/flow-dsl/legacy-yaml.mjs";
import { readWorkspaceGraphFiles } from "../bin/lib/workspace-flow-store.mjs";

const tmpdir = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-yamlmig-")));

/** control_start -> agent -> tool_print -> control_end：老流程最典型的形状。 */
const SIMPLE_YAML = `instances:
  start:
    definitionId: control_start
    label: Start
    input: []
    output: [{type: node, name: next}]
    body: 流程入口说明
  work:
    definitionId: agent_subAgent
    label: 干活
    input: [{type: node, name: prev}]
    output: [{type: node, name: next}, {type: text, name: summary}]
    body: 写一份说明到 \${summary}
  show:
    definitionId: tool_print
    label: 展示
    input: [{type: node, name: prev}, {type: file, name: summary}]
    output: [{type: node, name: next}]
  done:
    definitionId: control_end
    label: End
    input: [{type: node, name: prev}]
    output: []
edges:
  - {source: start, target: work, sourceHandle: output-0, targetHandle: input-0}
  - {source: work, target: show, sourceHandle: output-0, targetHandle: input-0}
  - {source: work, target: show, sourceHandle: output-1, targetHandle: input-1}
  - {source: show, target: done, sourceHandle: output-0, targetHandle: input-0}
ui:
  description: 老流程
  nodePositions:
    start: {x: 100, y: 300}
    work: {x: 380, y: 300}
    show: {x: 660, y: 300}
    done: {x: 940, y: 300}
`;

function seedYamlFlow(text = SIMPLE_YAML) {
  const dir = tmpdir();
  fs.writeFileSync(path.join(dir, "flow.yaml"), text, "utf-8");
  return dir;
}

test("换词按槽位名重接，不按索引", () => {
  const { graph, remapped } = legacyYamlToDesignGraph(SIMPLE_YAML);

  assert.equal(graph.instances.start.definitionId, "workspace_run");
  assert.equal(graph.instances.show.definitionId, "display_markdown");
  assert.equal(graph.instances.work.definitionId, "agent_subAgent", "native 节点原样留着");

  // tool_print 的 next 在 0 号位，display_markdown 的 next 在 1 号位（0 号位是 content
  // 输出）。照索引搬会把控制边接到内容槽上——图仍然连通，跑起来才发现错。
  const printOut = graph.instances.show.output.map((s) => s.name);
  assert.deepEqual(printOut, ["content", "next"]);

  // 老流程把内容槽改名叫 summary 了。展示节点的运行时按名字取 content，所以要真改名，
  // 并且改名要报出来。
  const showRemap = remapped.find((r) => r.id === "show");
  assert.deepEqual(showRemap.renamedSlots, ["summary -> content"]);
  const contentEdge = graph.edges.find((e) => e.target === "show" && e.targetHandle === "input-1");
  assert.equal(contentEdge.source, "work", "内容边要接到改名后的 content 上");
  assert.equal(graph.instances.show.input[1].type, "text", "类型跟新定义走，不留老的 file");
});

test("装不下的字段丢掉并报原文，而不是让整次迁移退回 JSON", () => {
  const { graph, remapped } = legacyYamlToDesignGraph(SIMPLE_YAML);
  const startRemap = remapped.find((r) => r.id === "start");
  // 运行节点生成的是 `flow("标签", ...)`，没有正文位置。留着的话往返比对过不去。
  assert.deepEqual(startRemap.droppedFields, [{ field: "body", text: "流程入口说明" }]);
  assert.equal(graph.instances.start.body, undefined);
});

test("control_end 丢了等于没丢，不该拦住迁移", () => {
  const dir = seedYamlFlow();
  const { dropped, droppedEdges } = legacyYamlToDesignGraph(SIMPLE_YAML);
  assert.deepEqual(dropped.map((d) => [d.id, d.benign]), [["done", true]]);
  assert.deepEqual(droppedEdges.map((e) => e.benign), [true]);

  // 全是 benign，所以不用 --allow-loss 就能过
  const result = migrateFlowDirToDsl(dir);
  assert.equal(result.migrated, true, result.degradedReason || "");
  assert.equal(result.source, "flow.yaml");

  const read = readWorkspaceGraphFiles(dir);
  assert.equal(read.format, "dsl");
  assert.deepEqual(Object.keys(read.graph.instances).sort(), ["show", "start", "work"]);
  assert.equal(read.graph.ui.description, "老流程", "说明要跟过来");
  assert.ok(fs.existsSync(path.join(dir, "flow.yaml")), "原文留着——出了问题还能对着看");
});

test("真有损时默认停手：磁盘不动，清单照给", () => {
  // control_anyOne 在 Workspace 里没有对等物（没有汇合原语，也不允许 fan-in）
  const dir = seedYamlFlow(`instances:
  start: {definitionId: control_start, output: [{type: node, name: next}]}
  join:
    definitionId: control_anyOne
    input: [{type: node, name: prev1}, {type: node, name: prev2}]
    output: [{type: node, name: next}]
  work: {definitionId: agent_subAgent, input: [{type: node, name: prev}], output: [{type: node, name: next}]}
edges:
  - {source: start, target: join, sourceHandle: output-0, targetHandle: input-0}
  - {source: join, target: work, sourceHandle: output-0, targetHandle: input-0}
ui: {nodePositions: {}}
`);
  const refused = migrateFlowDirToDsl(dir);
  assert.equal(refused.migrated, false);
  assert.equal(refused.format, "yaml");
  assert.match(refused.degradedReason, /--allow-loss/);
  assert.deepEqual(refused.dropped.map((d) => d.definitionId), ["control_anyOne"]);
  assert.equal(refused.dropped[0].benign, false);
  assert.equal(fs.readdirSync(dir).join(), "flow.yaml", "拒绝时磁盘一个字节都不该动");

  // 认了才落盘
  const forced = migrateFlowDirToDsl(dir, { force: true });
  assert.equal(forced.leftYaml, true, forced.degradedReason || "");
  assert.equal(readWorkspaceGraphFiles(dir).format !== "empty", true, "迁完就不再是空图");
});

test("control_toBool 换成 agent 判定时要单独提醒，并丢掉不再执行的 script", () => {
  const { remapped, graph } = legacyYamlToDesignGraph(`instances:
  gate:
    definitionId: control_toBool
    input: [{type: node, name: prev}, {type: text, name: value}]
    output: [{type: node, name: next}, {type: bool, name: prediction}]
    script: node \${flowDir}/scripts/control_toBool.mjs \${value} \${prediction}
edges: []
ui: {nodePositions: {}}
`);
  const gate = remapped.find((r) => r.id === "gate");
  assert.equal(gate.to, "control_agent_toBool");
  // parse-bool.mjs 只认 true/1/yes/on；模型答「是」会被当成 false，这个坑必须说出来
  assert.match(gate.caveat, /true\/1\/yes\/on/);
  assert.deepEqual(gate.droppedFields?.map((f) => f.field), ["script"]);
  assert.equal(graph.instances.gate.script, undefined);
});

test("够不着代码形态但离开了 yaml，也算成功", () => {
  // tool_nodejs 同时带 script 和 body：body 是文档、运行时忽略，但代码里只写得下 script，
  // 往返比对因此过不去 -> 退回 workspace.graph.json。这仍然是一次成功的迁移：
  // graph.json 读得出、画得出、跑得动，而 yaml 三样都不行。
  const dir = seedYamlFlow(`instances:
  start: {definitionId: control_start, output: [{type: node, name: next}]}
  step:
    definitionId: tool_nodejs
    input: [{type: node, name: prev}]
    output: [{type: node, name: next}, {type: text, name: result}]
    script: node -e "require('fs').writeFileSync(\${result}, 'x')"
    body: 这段说明在代码形态里没有位置放
edges:
  - {source: start, target: step, sourceHandle: output-0, targetHandle: input-0}
ui: {nodePositions: {}}
`);
  const result = migrateFlowDirToDsl(dir);
  assert.equal(result.format, "json");
  assert.equal(result.migrated, false, "没到代码形态");
  assert.equal(result.leftYaml, true, "但已经离开 yaml");
  assert.equal(readWorkspaceGraphFiles(dir).format, "json", "读得出来就不再是墓碑");
});

test("既没有图也没有 yaml 的目录，是真的没图", () => {
  const dir = tmpdir();
  const result = migrateFlowDirToDsl(dir);
  assert.equal(result.format, "empty");
  assert.equal(result.migrated, false);
  assert.deepEqual(result.dropped, []);
});
