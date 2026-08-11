import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { lintWorkspaceFlowDir, migrateFlowDirToDsl } from "../bin/lib/flow-dsl/cli.mjs";
import { publishNodePackage, resolveMarketplaceNodePackage } from "../bin/lib/marketplace.mjs";
import { isRuntimeArtifactPath } from "../bin/lib/workspace-flow-store.mjs";

const temp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-pkg-")));

const INDEX_MJS = `import fs from "node:fs/promises";

export default {
  id: "count_lines",
  version: "1.0.0",
  name: "统计行数",
  description: "读一个文本文件，统计行数",
  inputs: { filePath: { type: "text", required: true } },
  outputs: { total: { type: "text" } },
};

export async function run(inputs, outputs) {
  const text = await fs.readFile(inputs.filePath, "utf-8");
  await fs.writeFile(outputs.total, String(text.split("\\n").length));
}
`;

test("index.mjs 声明的节点包可以发布，并且能解析回来", () => {
  const root = temp();
  const src = path.join(root, "pkg");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "index.mjs"), INDEX_MJS, "utf-8");
  assert.ok(!fs.existsSync(path.join(src, "node.yaml")), "这个包故意没有 node.yaml");

  const published = publishNodePackage(path.join(root, "ws"), src);
  assert.equal(published.ok, true, published.error);
  assert.equal(published.id, "count_lines");
  assert.equal(published.version, "1.0.0");
  assert.ok(fs.existsSync(path.join(published.packageDir, "index.mjs")), "实现文件要跟着发布");

  const resolved = resolveMarketplaceNodePackage(path.join(root, "ws"), "", "marketplace:count_lines@1.0.0");
  assert.ok(resolved, "发布完解析不回来");
  assert.equal(resolved.runtime.mode, "module");
});

test("既没有 index.mjs 也没有 node.yaml 的目录发布失败，报错说清缺什么", () => {
  const root = temp();
  const src = path.join(root, "pkg");
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, "README.md"), "# 不是节点包\n", "utf-8");

  const published = publishNodePackage(path.join(root, "ws"), src);
  assert.equal(published.ok, false);
  assert.match(published.error, /index\.mjs/);
  assert.match(published.error, /node\.yaml/);
});

test("运行产物的路径判断只认这两类，不误伤同名的作者文件", () => {
  assert.equal(isRuntimeArtifactPath("workspace.state.json"), true);
  assert.equal(isRuntimeArtifactPath("nodes/say/history.md"), true);
  assert.equal(isRuntimeArtifactPath("./nodes/say/history.md"), true);

  assert.equal(isRuntimeArtifactPath("workspace.flow.js"), false);
  assert.equal(isRuntimeArtifactPath("workspace.layout.json"), false);
  assert.equal(isRuntimeArtifactPath("docs/workspace.state.json"), false, "只有根目录那个是运行态");
  assert.equal(isRuntimeArtifactPath("nodes/say/index.mjs"), false, "代码节点实现不是运行产物");
  assert.equal(isRuntimeArtifactPath("nodes/say/deep/history.md"), false, "* 只吃一层");
  assert.equal(isRuntimeArtifactPath("history.md"), false);
});

test("validate 对 Workspace 图走 lint，两种存储形态结论一致", () => {
  const graph = {
    version: 1,
    instances: {
      run_1: {
        definitionId: "workspace_run", label: "Run",
        input: [{ type: "node", name: "prev", value: "" }],
        output: [{ type: "node", name: "next", value: "" }],
      },
      say: {
        definitionId: "tool_nodejs", label: "打招呼", script: "node -e \"console.log(1)\"",
        input: [{ type: "node", name: "prev", value: "" }],
        output: [{ type: "node", name: "next", value: "" }, { type: "text", name: "result", value: "" }],
      },
    },
    edges: [{ source: "run_1", target: "say", sourceHandle: "output-0", targetHandle: "input-0" }],
    ui: { nodePositions: {} },
  };

  const legacy = temp();
  fs.writeFileSync(path.join(legacy, "workspace.graph.json"), JSON.stringify(graph, null, 2), "utf-8");
  const legacyResult = lintWorkspaceFlowDir(legacy);
  assert.equal(legacyResult.format, "json");
  assert.deepEqual(legacyResult.errors, []);
  assert.ok(fs.existsSync(path.join(legacy, "workspace.graph.json")), "校验是只读的，不该顺手迁移");
  assert.ok(!fs.existsSync(path.join(legacy, "workspace.flow.js")));

  const coded = temp();
  fs.writeFileSync(path.join(coded, "workspace.graph.json"), JSON.stringify(graph, null, 2), "utf-8");
  assert.equal(migrateFlowDirToDsl(coded).format, "dsl");
  const codedResult = lintWorkspaceFlowDir(coded);
  assert.equal(codedResult.format, "dsl");
  assert.deepEqual(codedResult.errors, legacyResult.errors);
  assert.deepEqual(codedResult.warnings, legacyResult.warnings);
});

test("validate 对没有 Workspace 图的目录不接管，留给 flow.yaml 那条老路", () => {
  const dir = temp();
  fs.writeFileSync(path.join(dir, "flow.yaml"), "instances: {}\nedges: []\n", "utf-8");
  assert.equal(lintWorkspaceFlowDir(dir).format, "empty");
});

test("引脚名写错在两种存储形态下都会被查出来——这正是 flow.yaml 校验查不到的", () => {
  const bad = {
    version: 1,
    instances: {
      cd_1: {
        definitionId: "control_cd_workspace", label: "进目录",
        input: [
          { type: "node", name: "prev", value: "" },
          { type: "text", name: "target", value: "." },
        ],
        output: [{ type: "node", name: "next", value: "" }],
      },
    },
    edges: [],
    ui: { nodePositions: {} },
  };

  const seed = () => {
    const dir = temp();
    fs.writeFileSync(path.join(dir, "workspace.graph.json"), JSON.stringify(bad, null, 2), "utf-8");
    return dir;
  };

  const legacy = seed();
  const legacyResult = lintWorkspaceFlowDir(legacy);
  assert.equal(legacyResult.format, "json");

  const coded = seed();
  assert.equal(migrateFlowDirToDsl(coded).format, "dsl");
  const codedResult = lintWorkspaceFlowDir(coded);
  assert.equal(codedResult.format, "dsl");

  for (const [label, result] of [["历史 JSON", legacyResult], ["代码", codedResult]]) {
    assert.ok(
      result.errors.some((e) => /target/.test(e)),
      `${label}形态应当报出 target 不是 control_cd_workspace 的引脚，实际：${JSON.stringify(result.errors)}`,
    );
  }
  assert.deepEqual(codedResult.errors, legacyResult.errors, "两种形态的结论必须一致");
});
