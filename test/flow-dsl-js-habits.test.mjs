/**
 * 让 DSL 尽量吃得下 JS 的自然写法：模板插值、非字符串字面量。
 *
 * 这两条都不是「加个语法糖」——模板插值以前会**静默丢掉整段正文**，而 `true` 只能写成
 * `"true"`。AI 按 JS 习惯写出来的代码，存一次就变形或者少东西。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { lintFlowDir } from "../bin/lib/flow-dsl/lint.mjs";
import { readWorkspaceGraphFiles, writeWorkspaceGraphFiles } from "../bin/lib/workspace-flow-store.mjs";

function seed(source) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-habits-")));
  fs.writeFileSync(path.join(dir, "workspace.flow.js"), source, "utf-8");
  return dir;
}

const slotNames = (inst) => inst.input.map((s) => s.name);
const edgeKeys = (graph) => graph.edges.map((e) => {
  const src = graph.instances[e.source];
  const dst = graph.instances[e.target];
  const from = src.output[Number(String(e.sourceHandle).split("-")[1])]?.name;
  const to = dst.input[Number(String(e.targetHandle).split("-")[1])]?.name;
  return `${e.source}.${from} -> ${e.target}.${to}`;
}).sort();

/** 存一次再读回来，顺便断言没退回 JSON。 */
function saveAndReread(dir, graph) {
  const saved = writeWorkspaceGraphFiles(dir, graph);
  assert.equal(saved.format, "dsl", saved.degradedReason || "");
  return {
    source: fs.readFileSync(path.join(dir, "workspace.flow.js"), "utf-8"),
    graph: readWorkspaceGraphFiles(dir).graph,
  };
}

test("模板插值编译成占位符正文加一条数据边", () => {
  const dir = seed(`import { agent, flow, provide } from "agentflow/flow";
const dateStr = provide.str("日期", { value: "2026-08-09" });
const plan = agent.subAgent("规划", {}, \`分析 \${dateStr.value} 的数据\`);
export const run = flow("Run", plan);
`);
  assert.deepEqual(lintFlowDir(dir).errors, []);
  const graph = readWorkspaceGraphFiles(dir).graph;

  // 运行时的占位符正则不认 `.`，所以正文里必须是槽名而不是 `dateStr.value`
  assert.equal(graph.instances.plan.body, "分析 ${dateStr} 的数据");
  assert.ok(slotNames(graph.instances.plan).includes("dateStr"), "插值要建出同名输入槽");
  assert.ok(
    edgeKeys(graph).includes("dateStr.value -> plan.dateStr"),
    `插值要连出数据边，实际：${JSON.stringify(edgeKeys(graph))}`,
  );

  // 槽名 == 引用的根标识符，写回时折叠成 JS 插值，AI 看到的还是自己写的那行
  const { source, graph: again } = saveAndReread(dir, graph);
  assert.match(source, /`分析 \$\{dateStr\.value\} 的数据`/);
  // 折进正文的槽在引脚对象里应当彻底消失——留个 `dateStr: null` 虽然还能往返，
  // 但那是 AI 下一轮要照抄的噪音
  assert.match(source, /agent\.subAgent\("规划", \{\}, `分析/, `引脚对象应当是空的，实际：\n${source}`);
  assert.equal(again.instances.plan.body, graph.instances.plan.body);
  assert.deepEqual(edgeKeys(again), edgeKeys(graph));
});

test("槽名和引用的根标识符不一致时不折叠，改走显式引脚", () => {
  // 画布上把槽改名成 d，上游节点仍叫 dateStr：折叠了就会被解析成槽 dateStr，往返对不上
  const dir = seed(`import { agent, flow, provide } from "agentflow/flow";
const dateStr = provide.str("日期", { value: "2026-08-09" });
const plan = agent.subAgent("规划", { d: dateStr.value }, \`分析 \\\${d} 的数据\`);
export const run = flow("Run", plan);
`);
  const graph = readWorkspaceGraphFiles(dir).graph;
  assert.equal(graph.instances.plan.body, "分析 ${d} 的数据");

  const { source, graph: again } = saveAndReread(dir, graph);
  assert.match(source, /d: dateStr\.value/, "槽名对不上，必须保留显式引脚");
  assert.match(source, /\\\$\{d\}/, "正文里的占位符要转义，它不是 JS 表达式");
  assert.equal(again.instances.plan.body, "分析 ${d} 的数据");
  assert.deepEqual(edgeKeys(again), edgeKeys(graph));
});

test("`${slot}` 指向本节点已有的引脚时按运行时占位符处理，不再建新边", () => {
  const dir = seed(`import { agent, flow } from "agentflow/flow";
const collect = agent.subAgent("采集", {}, "采");
const analyse = agent.subAgent("解读", { metrics: collect.result }, \`读 \${metrics} 指出趋势\`);
export const run = flow("Run", collect, analyse);
`);
  assert.deepEqual(lintFlowDir(dir).errors, []);
  const graph = readWorkspaceGraphFiles(dir).graph;
  assert.equal(graph.instances.analyse.body, "读 ${metrics} 指出趋势");
  assert.deepEqual(edgeKeys(graph), [
    "collect.next -> analyse.prev",
    "collect.result -> analyse.metrics",
    "run.next -> collect.prev",
  ], "metrics 已经是自己的槽，不该再多出一条 collect -> analyse.collect 的边");
});

test("tool_nodejs 脚本里的常量和输出槽占位符原样保留", () => {
  const dir = seed(`import { flow, provide, tool } from "agentflow/flow";
const day = provide.str("日期", { value: "2026-08-09" });
const job = tool.nodejs("跑", { date: day.value }, \`node \${flowDir}/scripts/x.mjs --date \${date} > \${total}\`);
const { total } = job;
export const run = flow("Run", job);
`);
  assert.deepEqual(lintFlowDir(dir).errors, []);
  const graph = readWorkspaceGraphFiles(dir).graph;
  // flowDir 是运行时常量、total 是自己的输出槽，两者都不是上游引用
  assert.equal(graph.instances.job.script, "node ${flowDir}/scripts/x.mjs --date ${date} > ${total}");
  assert.deepEqual(
    edgeKeys(graph).filter((k) => k.includes("job")),
    ["day.value -> job.date", "run.next -> job.prev"],
  );
  assert.equal(saveAndReread(dir, graph).graph.instances.job.script, graph.instances.job.script);
});

test("正文读不出来时报错，不再静默丢掉整段", () => {
  const dir = seed(`import { agent, flow } from "agentflow/flow";
const plan = agent.subAgent("规划", {}, someUnknownThing);
export const run = flow("Run", plan);
`);
  assert.ok(
    lintFlowDir(dir).errors.some((e) => /plan: 正文/.test(e)),
    `应当报出正文读不懂，实际：${JSON.stringify(lintFlowDir(dir).errors)}`,
  );
  assert.throws(() => readWorkspaceGraphFiles(dir), /解析失败/);
});

test("插值引用不出来、或与已有引脚撞名，都要报错", () => {
  const dangling = seed(`import { agent, flow } from "agentflow/flow";
const plan = agent.subAgent("规划", {}, \`看 \${someVar} 一眼\`);
export const run = flow("Run", plan);
`);
  assert.ok(lintFlowDir(dangling).errors.some((e) => /模板插值只能引用上游节点/.test(e)));

  const clash = seed(`import { agent, flow } from "agentflow/flow";
const date = agent.subAgent("日期", {}, "今天");
const plan = agent.subAgent("规划", { date: "写死的" }, \`分析 \${date.result}\`);
export const run = flow("Run", date, plan);
`);
  assert.ok(
    lintFlowDir(clash).errors.some((e) => /模板插值要占用的槽已经在引脚对象里写过了/.test(e)),
    `撞名要报出来而不是猜，实际：${JSON.stringify(lintFlowDir(clash).errors)}`,
  );
});

test("引脚值收得下 true / 数字，bool 槽写回还是裸 true", () => {
  const dir = seed(`import { agent, flow } from "agentflow/flow";
const plan = agent.subAgent("规划", { pullIfExists: true, skip: false, retries: 3 }, "干活");
export const run = flow("Run", plan);
`);
  assert.deepEqual(lintFlowDir(dir).errors, []);
  const graph = readWorkspaceGraphFiles(dir).graph;
  const slot = (name) => graph.instances.plan.input.find((s) => s.name === name);
  assert.equal(slot("pullIfExists").value, "true");
  assert.equal(slot("pullIfExists").type, "bool", "布尔字面量要把槽建成 bool，否则往返退化成文本");
  assert.equal(slot("skip").value, "false");
  assert.equal(slot("retries").value, "3");
  assert.equal(slot("retries").type, "text", "数字没有对应的槽类型，按文本存");

  const { source, graph: again } = saveAndReread(dir, graph);
  assert.match(source, /pullIfExists: true/);
  assert.match(source, /skip: false/);
  assert.match(source, /retries: "3"/, "文本槽写回加引号，图里存的就是字符串");
  assert.equal(again.instances.plan.input.find((s) => s.name === "pullIfExists").type, "bool");
});

test("两个节点各有一个同名自定义输出槽，生成的代码不能重复声明", () => {
  // 两个 tool.nodejs 都吐 ok/report 是完全正常的图。以前 outVar 按槽名发号、不查重，
  // 会生成两条 `const { ok } = ...`，文件解析不回来，整张图退回 JSON
  const dir = seed(`import { control, display, flow, tool } from "agentflow/flow";
const first = tool.nodejs("查一遍", {}, \`node check.mjs \${ok} \${report}\`);
const { ok, report } = first;
const second = tool.nodejs("再查一遍", {}, \`node check.mjs \${ok} \${report}\`);
const { ok: ok2, report: report2 } = second;
const good = display.markdown("过了", { content: report });
const bad = display.markdown("没过", { content: report2 });
const gate = control.if("过了吗", { prediction: ok }, flow(good), flow(bad));
export const run = flow("Run", first, second, gate);
`);
  assert.deepEqual(lintFlowDir(dir).errors, []);
  const graph = readWorkspaceGraphFiles(dir).graph;

  const { source, graph: again } = saveAndReread(dir, graph);
  const declared = [...source.matchAll(/const \{([^}]*)\} =/g)]
    .flatMap((m) => m[1].split(",").map((s) => s.split(":").pop().trim()));
  assert.equal(new Set(declared).size, declared.length, `解构出来的变量名重了：${declared.join(", ")}`);
  assert.deepEqual(Object.keys(again.instances).sort(), Object.keys(graph.instances).sort());
  assert.equal(
    again.instances.second.output.filter((s) => s.name === "ok").length, 1,
    "第二个节点自己的 ok 槽要还在",
  );
});

test("折叠正文插值不能打乱自定义槽的顺序", () => {
  // repoRoot 是第一个自定义槽，折进正文后解析回来会被追加到末尾 -> 槽序变了 -> 退回 JSON。
  // 所以只有末尾那一段能折
  const dir = seed(`import { flow, provide, tool } from "agentflow/flow";
const root = provide.str("根目录", { value: "." });
const src = provide.str("源清单", { value: "a.kt" });
const job = tool.nodejs("检查", { repoRoot: root.value, before: src.value }, \`node c.mjs \${repoRoot} \${before} \${result}\`);
export const run = flow("Run", job);
`);
  const graph = readWorkspaceGraphFiles(dir).graph;
  const names = (g) => g.instances.job.input.map((s) => s.name);
  assert.deepEqual(names(graph).slice(-2), ["repoRoot", "before"]);

  const { source, graph: again } = saveAndReread(dir, graph);
  assert.deepEqual(names(again), names(graph), `槽序变了：\n${source}`);
  assert.match(source, /repoRoot: root\.value/, "repoRoot 不在末尾，只能保留显式引脚");
});

test("没有 prev/next 的节点接进控制链要报错", () => {
  // provide.* 是纯数据源。这条边在图里落不下去，往返时会无声消失
  const dir = seed(`import { agent, flow, provide } from "agentflow/flow";
const dateStr = provide.str("日期", { value: "2026-08-09" });
const plan = agent.subAgent("规划", { d: dateStr.value }, "干活");
export const run = flow("Run", dateStr, plan);
`);
  const errors = lintFlowDir(dir).errors;
  assert.ok(
    errors.some((e) => /dateStr\[provide_str\] 没有 prev 槽/.test(e)),
    `应当报出 provide 节点接不进控制链，实际：${JSON.stringify(errors)}`,
  );

  // 同一张图去掉链上的 dateStr 就该干净
  fs.writeFileSync(path.join(dir, "workspace.flow.js"), `import { agent, flow, provide } from "agentflow/flow";
const dateStr = provide.str("日期", { value: "2026-08-09" });
const plan = agent.subAgent("规划", { d: dateStr.value }, "干活");
export const run = flow("Run", plan);
`, "utf-8");
  assert.deepEqual(lintFlowDir(dir).errors, []);
});
