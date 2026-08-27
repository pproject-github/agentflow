/**
 * 包里自带的流程模板必须真的能用。
 *
 * 之前这两个模板烂了很久也没人发现：它们建在 `runtime: none` 的节点上（`control_start`、
 * `tool_user_check`、`control_anyOne`…），骨架是 Workspace 运行时直接拒绝的环，而且只有
 * `flow.yaml` 没有 `workspace.flow.js`——用户点进去是一张空画布。装了就有两个跑不起来的
 * 示例，比没有示例更糟。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { DEFINITIONS, definitionOf } from "../bin/lib/flow-dsl/defs.mjs";
import { isFlowDir } from "../bin/lib/paths.mjs";
import { readPipelineListDescription } from "../bin/lib/catalog-flows.mjs";
import { lintFlowDir } from "../bin/lib/flow-dsl/lint.mjs";
import { readWorkspaceGraphFiles, writeWorkspaceGraphFiles } from "../bin/lib/workspace-flow-store.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const PIPELINES = path.join(ROOT, "builtin", "pipelines");

const templates = fs.readdirSync(PIPELINES, { withFileTypes: true })
  .filter((e) => e.isDirectory() && isFlowDir(path.join(PIPELINES, e.name)))
  .map((e) => e.name);

test("能找到内置模板（找不到说明这套断言在空转）", () => {
  assert.ok(templates.length > 0, "builtin/pipelines 下一个模板都没有");
});

for (const name of templates) {
  const dir = path.join(PIPELINES, name);

  test(`${name}: 图存在且是代码，不是空画布`, () => {
    assert.ok(
      fs.existsSync(path.join(dir, "workspace.flow.js")),
      "只有 flow.yaml 的模板在画布上是空的——Workspace 图必须是 workspace.flow.js",
    );
    const graph = readWorkspaceGraphFiles(dir).graph;
    assert.ok(Object.keys(graph.instances || {}).length > 0, "读出来 0 个节点");
  });

  test(`${name}: lint 无 error`, () => {
    assert.deepEqual(lintFlowDir(dir).errors, []);
  });

  test(`${name}: 每个节点类型运行时都有实现`, () => {
    const graph = readWorkspaceGraphFiles(dir).graph;
    const dead = [];
    for (const [id, instance] of Object.entries(graph.instances)) {
      const definitionId = String(instance.definitionId || "");
      // 未知类型交给 lint 报；这里只管「类型存在但运行时没实现」
      if (!DEFINITIONS[definitionId]) continue;
      if (definitionOf(definitionId).runtime === "none") dead.push(`${id}[${definitionId}]`);
    }
    assert.deepEqual(dead, [], "模板不能建在没有 Workspace 实现的节点上");
  });

  test(`${name}: 画布保存一次不会退回 JSON`, () => {
    const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-tpl-")));
    fs.cpSync(dir, tmp, { recursive: true });
    const before = readWorkspaceGraphFiles(tmp).graph;
    const saved = writeWorkspaceGraphFiles(tmp, before);
    assert.equal(saved.format, "dsl", saved.degradedReason || "");
    const after = readWorkspaceGraphFiles(tmp).graph;
    assert.deepEqual(Object.keys(after.instances).sort(), Object.keys(before.instances).sort());
    assert.equal(after.edges.length, before.edges.length);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test(`${name}: 不再带 flow.yaml，列表说明来自 layout`, () => {
    // 目录识别和列表说明都不再经过 yaml（见 flow-dir-marker.test.mjs），
    // 留着一个空壳只会让人以为那里还有一份图
    assert.ok(!fs.existsSync(path.join(dir, "flow.yaml")), "退休的格式不该继续躺在模板里");
    assert.ok(String(readPipelineListDescription(dir) || "").trim(), "列表里那一行说明不能空");
  });

  test(`${name}: 节点在画布上不会堆成一坨`, () => {
    const graph = readWorkspaceGraphFiles(dir).graph;
    const positions = Object.values(graph.ui?.nodePositions || {});
    assert.equal(positions.length, Object.keys(graph.instances).length, "有节点没有坐标");
    const distinct = new Set(positions.map((p) => `${p.x},${p.y}`));
    assert.equal(distinct.size, positions.length, "有节点坐标重合");
  });

  test(`${name}: script 引用的脚本文件都在`, () => {
    const graph = readWorkspaceGraphFiles(dir).graph;
    for (const [id, instance] of Object.entries(graph.instances)) {
      const script = String(instance.script || "");
      for (const m of script.matchAll(/\$\{flowDir\}\/([\w./-]+)/g)) {
        assert.ok(fs.existsSync(path.join(dir, m[1])), `${id} 引用的 ${m[1]} 不存在`);
      }
      // 别人机器上的绝对路径不该出现在发布出去的模板里
      assert.ok(!/\/(Users|home)\//.test(script), `${id} 的 script 里有绝对路径`);
    }
  });
}
