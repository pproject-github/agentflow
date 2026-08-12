import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { lintFlowDir } from "../bin/lib/flow-dsl/lint.mjs";
import { rewriteFlowLocalPackageImports, scanFlowLocalPackages } from "../bin/lib/flow-dsl/packages.mjs";
import { readWorkspaceGraphFiles, writeWorkspaceGraphFiles } from "../bin/lib/workspace-flow-store.mjs";
import { publishNodePackage } from "../bin/lib/marketplace.mjs";

const PACKAGE = `export default {
  id: "collect_metrics",
  version: "1.0.0",
  name: "统计语料",
  inputs: { date: { type: "text" } },
  outputs: { total: { type: "text" } },
};
export async function run() {}
`;

const SOURCE = `import { display, flow } from "agentflow/flow";
import collectMetrics from "./nodes/collect-metrics";

const collect = collectMetrics("统计语料", { date: "2026-08-09" });
const show = display.markdown("结果", { content: collect.total });

export const run = flow("Run", collect, show);
`;

/** 一个带流程本地代码节点包的目录，flow.js 按 skill 里教的写法写。 */
function seedFlowDir({ source = SOURCE, withPackage = true } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-dsl-pkg-")));
  if (withPackage) {
    fs.mkdirSync(path.join(dir, "nodes", "collect-metrics"), { recursive: true });
    fs.writeFileSync(path.join(dir, "nodes", "collect-metrics", "index.mjs"), PACKAGE, "utf-8");
  }
  fs.writeFileSync(path.join(dir, "workspace.flow.js"), source, "utf-8");
  return dir;
}

test("扫描认得流程目录里的代码节点包", () => {
  const dir = seedFlowDir();
  const packages = scanFlowLocalPackages(dir);
  const record = packages.bySpecifier["./nodes/collect-metrics"];
  assert.ok(record, "./nodes/collect-metrics 没扫到");
  assert.equal(record.id, "collect_metrics");
  assert.equal(record.marketplaceRef, "marketplace:collect_metrics@1.0.0");
  assert.equal(record.baseDefinitionId, "tool_nodejs", "包节点在图里应当是基础类型");
  assert.equal(packages.byRef["marketplace:collect_metrics@1.0.0"], record, "按引用也要能查回来");
  assert.ok(packages.bySpecifier["./nodes/collect-metrics/index.mjs"], "带 /index.mjs 的写法也要认");
});

test("发布转换只改静态节点包 import，不改本地 DSL 文件或相似文本", () => {
  const dir = seedFlowDir({
    source: `${SOURCE}\n// ./nodes/collect-metrics\nconst note = "./nodes/collect-metrics";\n`,
  });
  try {
    const original = fs.readFileSync(path.join(dir, "workspace.flow.js"), "utf-8");
    const portable = rewriteFlowLocalPackageImports(original, scanFlowLocalPackages(dir));
    assert.match(portable.source, /from "marketplace:collect_metrics@1\.0\.0"/);
    assert.match(portable.source, /\/\/ \.\/nodes\/collect-metrics/);
    assert.match(portable.source, /const note = "\.\/nodes\/collect-metrics"/);
    assert.deepEqual(portable.dependencies.map((item) => item.specifier), ["marketplace:collect_metrics@1.0.0"]);
    assert.deepEqual(portable.rewritten, [{
      specifier: "./nodes/collect-metrics",
      marketplaceRef: "marketplace:collect_metrics@1.0.0",
      line: 2,
    }]);
    assert.equal(fs.readFileSync(path.join(dir, "workspace.flow.js"), "utf-8"), original);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("import 写法读出来的图，和画布从面板拖出来的形状一致", () => {
  const dir = seedFlowDir();
  const graph = readWorkspaceGraphFiles(dir).graph;
  const collect = graph.instances.collect;

  assert.equal(collect.definitionId, "tool_nodejs", "definitionId 应当是基础类型，不是 pkg:...");
  assert.equal(collect.marketplaceRef, "marketplace:collect_metrics@1.0.0");
  assert.equal(collect.marketplacePackageId, "collect_metrics");
  assert.equal(collect.marketplaceVersion, "1.0.0");

  // 包声明的槽位必须真的建出来，否则控制边会串到第一个数据槽上
  assert.deepEqual(collect.input.map((s) => s.name), ["prev", "date"]);
  assert.ok(collect.output.some((s) => s.name === "total"), "包声明的 total 输出槽没建出来");

  const key = (e) => {
    const src = graph.instances[e.source];
    const dst = graph.instances[e.target];
    const from = src.output[Number(String(e.sourceHandle).split("-")[1])]?.name;
    const to = dst.input[Number(String(e.targetHandle).split("-")[1])]?.name;
    return `${e.source}.${from} -> ${e.target}.${to}`;
  };
  assert.deepEqual(graph.edges.map(key).sort(), [
    "collect.next -> show.prev",       // flow("Run", collect, show) 串起来的控制边
    "collect.total -> show.content",   // 包声明的输出槽，不是「第一个数据槽」
    "run.next -> collect.prev",
  ]);
});

test("保存一次仍然是代码，import 保留，不再退回 JSON", () => {
  const dir = seedFlowDir();
  const first = readWorkspaceGraphFiles(dir).graph;

  const saved = writeWorkspaceGraphFiles(dir, first);
  assert.equal(saved.format, "dsl", saved.degradedReason || "");
  assert.ok(!fs.existsSync(path.join(dir, "workspace.graph.json")));

  const source = fs.readFileSync(path.join(dir, "workspace.flow.js"), "utf-8");
  assert.match(source, /import collectMetrics from "\.\/nodes\/collect-metrics";/);
  assert.match(source, /collectMetrics\("统计语料"/);
  assert.match(source, /content: collect\.total/, "包声明的输出槽直接引用，不必解构");
  assert.ok(!source.includes("const { total }"), "包已经声明过 total，不该再解构一遍");

  const second = readWorkspaceGraphFiles(dir).graph;
  assert.deepEqual(Object.keys(second.instances).sort(), Object.keys(first.instances).sort());
  assert.equal(second.instances.collect.definitionId, "tool_nodejs");
});

test("推导出来的 bootstrap 命令不写进 flow.js", () => {
  const dir = seedFlowDir();
  const graph = readWorkspaceGraphFiles(dir).graph;
  // 模拟 hydrate 塞进来的那串本机绝对路径
  graph.instances.collect.script = "node '/Users/somebody/agentflow/bin/lib/node-package-bootstrap.mjs' '/Users/somebody/flow/nodes/collect-metrics/index.mjs'";

  assert.equal(writeWorkspaceGraphFiles(dir, graph).format, "dsl");
  const source = fs.readFileSync(path.join(dir, "workspace.flow.js"), "utf-8");
  assert.ok(!source.includes("/Users/somebody"), "流程文件里不该出现别人机器上的绝对路径");
  assert.ok(!source.includes("node-package-bootstrap"), "bootstrap 命令是推导出来的，不该落盘");
});

test("lint 和存储层对包节点的答案一致", () => {
  const dir = seedFlowDir();
  const lint = lintFlowDir(dir);
  assert.deepEqual(lint.errors, [], "lint 应当通过");

  // 曾经的病：lint 自己解析包所以绿灯，存储层不解析所以读出一张错图
  const graph = readWorkspaceGraphFiles(dir).graph;
  assert.equal(graph.instances.collect.definitionId, "tool_nodejs");
  assert.equal(lint.ir?.nodes?.collect?.definitionId, "tool_nodejs");
});

test("包不存在时 lint 报错，读图也不会假装它是个正常节点", () => {
  const dir = seedFlowDir({ withPackage: false });
  const lint = lintFlowDir(dir);
  assert.ok(
    lint.errors.some((e) => /节点包不存在/.test(e)),
    `应当报出节点包不存在，实际：${JSON.stringify(lint.errors)}`,
  );
  const graph = readWorkspaceGraphFiles(dir).graph;
  assert.match(
    String(graph.instances.collect.definitionId),
    /^pkg:/,
    "解析不出包时要留下 pkg: 前缀，让上层看得出这张图不完整",
  );
});

test("已安装 marketplace 节点能直接 import，lint、读图和保存使用同一份解析", () => {
  const packageFixture = seedFlowDir();
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-dsl-marketplace-"));
  const flowDir = path.join(workspaceRoot, ".workspace", "agentflow", "pipelines", "uses-marketplace");
  fs.mkdirSync(flowDir, { recursive: true });
  try {
    const published = publishNodePackage(workspaceRoot, path.join(packageFixture, "nodes", "collect-metrics"));
    assert.equal(published.ok, true, published.error || "publish failed");
    fs.writeFileSync(
      path.join(flowDir, "workspace.flow.js"),
      SOURCE.replace('"./nodes/collect-metrics"', '"marketplace:collect_metrics@1.0.0"'),
      "utf-8",
    );

    const lint = lintFlowDir(flowDir, { workspaceRoot });
    assert.deepEqual(lint.errors, []);
    const first = readWorkspaceGraphFiles(flowDir, { marketplaceRoot: workspaceRoot }).graph;
    assert.equal(first.instances.collect.marketplaceRef, "marketplace:collect_metrics@1.0.0");
    assert.deepEqual(first.instances.collect.output.map((slot) => slot.name), ["next", "total"]);

    const saved = writeWorkspaceGraphFiles(flowDir, first, { marketplaceRoot: workspaceRoot });
    assert.equal(saved.format, "dsl", saved.degradedReason || "");
    assert.match(fs.readFileSync(path.join(flowDir, "workspace.flow.js"), "utf-8"), /from "marketplace:collect_metrics@1\.0\.0"/);
  } finally {
    fs.rmSync(packageFixture, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
});
