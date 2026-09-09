/**
 * `flow.fork` 到底是什么。
 *
 * skill 里那句注释一度写着「并行」。它不是——图里根本没有 fork 这个东西，`flow.fork` 只是
 * 「一个 `next` 接多个下游」的写法（`flow(a, b, c)` 是线性的，写不出扇出）。运行计划仍然
 * 是一条一维的拓扑序，fork 不产生「并发单元」。
 *
 * 真正决定并行的是运行时的并发档位（`reference/flow-control-capabilities.md` §8.5）：
 * 默认 agent=1 / tool=1 时逐个投放，开了档位无依赖节点才重叠。所以「fork 不是并行原语」
 * 这句话依旧成立，只是原因要说准——不是运行时做不到，是 fork 这个写法与它无关。
 *
 * 这种「文档说的和运行时做的不一样」比缺功能更糟：用户按文档设计流程，跑出来时间对不上，
 * 而且没有任何报错。所以这里同时钉住两头——行为是什么，文档不许怎么说。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { flowFilesToGraph } from "../bin/lib/flow-dsl/index.mjs";
import { workspaceRunPlan } from "../bin/lib/workspace-server.mjs";

const FORK_SOURCE = `import { flow, tool } from "agentflow/flow";

const build = tool.nodejs("Build", {}, \`echo build\`);
const testA = tool.nodejs("A", {}, \`sleep 3\`);
const testB = tool.nodejs("B", {}, \`sleep 3\`);
const report = tool.nodejs("Report", {}, \`echo report\`);

export const run = flow("Run", build, flow.fork(flow(testA), flow(testB, report)));
`;

function forkGraph() {
  return flowFilesToGraph({ source: FORK_SOURCE, layout: {}, nodeMeta: {}, files: {} });
}

/** 一条边的可读身份：`源.槽 -> 目标.槽`。 */
function edgeNames(graph) {
  const idx = (h) => Number(/-(\d+)$/.exec(String(h || ""))?.[1] ?? 0);
  return (graph.edges || []).map((e) => {
    const from = graph.instances[e.source]?.output?.[idx(e.sourceHandle)]?.name;
    const to = graph.instances[e.target]?.input?.[idx(e.targetHandle)]?.name;
    return `${e.source}.${from} -> ${e.target}.${to}`;
  }).sort();
}

test("fork 编译出来就是控制边扇出，图里没有 fork 这个东西", () => {
  const graph = forkGraph();
  assert.deepEqual(edgeNames(graph), [
    "build.next -> testA.prev",
    "build.next -> testB.prev",
    "run.next -> build.prev",
    "testB.next -> report.prev",
  ]);
  // 没有多出一个 fork 节点，也没有任何实例带 fork 标记
  assert.deepEqual(
    Object.keys(graph.instances).sort(),
    ["build", "report", "run", "testA", "testB"],
  );
  for (const [id, instance] of Object.entries(graph.instances)) {
    assert.ok(!/fork/i.test(JSON.stringify(instance)), `${id} 里不该留下 fork 的痕迹`);
  }
});

test("两条分支进同一条一维计划，fork 本身不产生并发单元", () => {
  const plan = workspaceRunPlan(forkGraph(), "run", "");
  // 计划是一个扁平的有序数组。并发调度会需要「同一层可以一起跑」这种结构，现在没有
  assert.ok(Array.isArray(plan.order));
  assert.deepEqual([...plan.order].sort(), ["build", "report", "testA", "testB"]);
  const at = (id) => plan.order.indexOf(id);
  assert.ok(at("build") < at("testA") && at("build") < at("testB"), "扇出源必须排在两支之前");
  assert.ok(at("testB") < at("report"), "分支内部的顺序要保持");
  // testA 和 testB 之间没有依赖，却仍然一前一后——这就是「串行」的含义
  assert.notEqual(at("testA"), at("testB"));
});

test("文档不许再把 fork 说成并行", () => {
  // 唯一的错误承诺来源就是 skill 里那句注释；两份 wiki 现在都写明了它是扇出
  const read = (...p) => fs.readFileSync(path.resolve(import.meta.dirname, "..", ...p), "utf-8");
  const skill = read("skills", "agentflow-flow-dsl", "SKILL.md");
  const forkLine = skill.split("\n").find((line) => line.includes("flow.fork(") && line.includes("//"));
  assert.ok(forkLine, "skill 里应当保留 flow.fork 的示例");
  assert.ok(!/并行|parallel/i.test(forkLine), `示例注释不能说并行：${forkLine.trim()}`);
  assert.match(skill, /flow\.fork\D{0,8}不是并行/, "skill 要明说它不是并行");
  assert.match(read("docs", "wiki", "flow-dsl.zh-CN.md"), /不是并行原语/);
  assert.match(read("docs", "wiki", "flow-dsl.en.md"), /not a parallelism primitive/);

  // 说清「不是并行」还不够——得同时指出并行到底从哪来，否则读者会以为运行时做不到。
  assert.match(skill, /并发档位/, "skill 要说明并行由并发档位决定");
  assert.match(read("reference", "flow-control-capabilities.md"), /## 8\.5 并行执行/);

  // 汇合曾被一句「fan-in 禁止」堵死，实际禁的是同一个输入槽被连两次。
  assert.match(skill, /分支可以汇合/, "skill 要写清分支怎么汇合");
});
