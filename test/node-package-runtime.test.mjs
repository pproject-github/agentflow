import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  isNodePackageDir,
  nodePackageExportsRun,
  readNodePackageDeclaration,
  readNodePackageManifest,
  slotMapToList,
} from "../bin/lib/node-package-manifest.mjs";
import { listNodePackagesInDir, resolveMarketplaceNodePackage } from "../bin/lib/marketplace.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BOOTSTRAP = path.join(repoRoot, "bin", "lib", "node-package-bootstrap.mjs");

const PACKAGE_SOURCE = `import fs from "node:fs/promises";

export default {
  id: "count_lines",
  version: "1.0.0",
  name: "统计行数",
  description: "读一个文本文件，统计行数与非空行数",
  inputs: { filePath: { type: "text", description: "要统计的文件路径", required: true } },
  outputs: { total: { type: "text" }, nonEmpty: { type: "text", description: "非空行数" } },
};

export async function run({ filePath }, outputs, { nodeRunDir }) {
  const text = await fs.readFile(filePath, "utf-8");
  const lines = text.split("\\n");
  const ne = lines.filter((l) => l.trim()).length;
  await fs.writeFile(outputs.total, String(lines.length));
  await fs.writeFile(outputs.nonEmpty, String(ne));
  console.log(\`lines=\${lines.length} nonEmpty=\${ne} runDir=\${nodeRunDir}\`);
}
`;

function makeFixture(source = PACKAGE_SOURCE, dirName = "count-lines") {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-node-pkg-")));
  const pkgDir = path.join(root, "flow", "nodes", dirName);
  fs.mkdirSync(pkgDir, { recursive: true });
  fs.writeFileSync(path.join(pkgDir, "index.mjs"), source, "utf-8");
  return { root, flowDir: path.join(root, "flow"), pkgDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("index.mjs 的声明被静态解析出来（不执行包代码）", () => {
  const fx = makeFixture();
  try {
    assert.equal(isNodePackageDir(fx.pkgDir), true);
    assert.equal(nodePackageExportsRun(path.join(fx.pkgDir, "index.mjs")), true);
    const manifest = readNodePackageManifest(fx.pkgDir, () => null);
    assert.equal(manifest.id, "count_lines");
    assert.equal(manifest.version, "1.0.0");
    assert.equal(manifest.displayName, "统计行数");
    assert.equal(manifest.baseDefinitionId, "tool_nodejs");
    assert.deepEqual(manifest.runtime, { type: "tool_nodejs", entry: "index.mjs", mode: "module" });
    // 槽位首位固定是控制槽，其余按声明顺序
    assert.deepEqual(manifest.input.map((s) => `${s.type}:${s.name}`), ["node:prev", "text:filePath"]);
    assert.deepEqual(manifest.output.map((s) => `${s.type}:${s.name}`), ["node:next", "text:total", "text:nonEmpty"]);
    assert.equal(manifest.input[1].required, true);
    assert.equal(manifest.output[2].description, "非空行数");
  } finally {
    fx.cleanup();
  }
});

test("声明不是纯字面量时明确报错，而不是静默变空", () => {
  const fx = makeFixture(`const ID = "x";\nexport default { id: ID, version: "1.0.0" };\nexport function run() {}\n`);
  try {
    assert.throws(() => readNodePackageDeclaration(path.join(fx.pkgDir, "index.mjs")), /只允许字面量/);
  } finally {
    fx.cleanup();
  }
});

test("入口有语法错误时报错带文件名", () => {
  const fx = makeFixture(`export default { id: "x",,, };\n`);
  try {
    assert.throws(() => readNodePackageDeclaration(path.join(fx.pkgDir, "index.mjs")), /index\.mjs 解析失败/);
  } finally {
    fx.cleanup();
  }
});

test("未知槽位类型被拒绝", () => {
  assert.throws(() => slotMapToList({ a: { type: "widget" } }, "input"), /未知类型 widget/);
});

test("node.yaml 仍然作为回退被读取", () => {
  const fx = makeFixture();
  try {
    fs.rmSync(path.join(fx.pkgDir, "index.mjs"));
    fs.writeFileSync(path.join(fx.pkgDir, "node.yaml"), "id: legacy_pkg\nversion: 2.0.0\n", "utf-8");
    assert.equal(isNodePackageDir(fx.pkgDir), true);
    const manifest = readNodePackageManifest(fx.pkgDir, (p) => JSON.parse(JSON.stringify({ id: "legacy_pkg", version: "2.0.0", __path: p })));
    assert.equal(manifest.id, "legacy_pkg");
  } finally {
    fx.cleanup();
  }
});

test("flow 目录自带的节点包能被列出并解析", () => {
  const fx = makeFixture();
  try {
    const listed = listNodePackagesInDir(path.join(fx.flowDir, "nodes"));
    assert.equal(listed.length, 1);
    assert.equal(listed[0].definitionId, "marketplace:count_lines@1.0.0");
    assert.equal(listed[0].source, "flow");

    const resolved = resolveMarketplaceNodePackage(
      path.join(fx.root, "ws"),
      fx.flowDir,
      "marketplace:count_lines@1.0.0",
      null,
      {},
    );
    assert.ok(resolved, "flow 目录里的节点包没被解析到");
    assert.equal(resolved.source, "flow");
    assert.equal(resolved.packageDir, fx.pkgDir);
    assert.equal(resolved.resolvedDefinitionId, "marketplace:count_lines@1.0.0");
  } finally {
    fx.cleanup();
  }
});

test("版本不匹配时不会错误命中 flow 本地包", () => {
  const fx = makeFixture();
  try {
    const resolved = resolveMarketplaceNodePackage(
      path.join(fx.root, "ws"),
      fx.flowDir,
      "marketplace:count_lines@9.9.9",
      null,
      {},
    );
    assert.equal(resolved, null);
  } finally {
    fx.cleanup();
  }
});

test("bootstrap 按运行时 env 契约调用 run()，输出槽写到指定绝对路径", () => {
  const fx = makeFixture();
  try {
    const runDir = path.join(fx.root, "run");
    const outDir = path.join(runDir, "outputs");
    fs.mkdirSync(outDir, { recursive: true });
    const target = path.join(fx.root, "sample.txt");
    fs.writeFileSync(target, "a\n\nb\nc\n\n", "utf-8");
    const outputsAbs = { total: path.join(outDir, "total.txt"), nonEmpty: path.join(outDir, "nonEmpty.txt") };

    const result = spawnSync(process.execPath, [BOOTSTRAP, path.join(fx.pkgDir, "index.mjs")], {
      cwd: runDir,
      encoding: "utf-8",
      env: {
        ...process.env,
        AGENTFLOW_INPUTS_JSON: JSON.stringify({ filePath: target }),
        AGENTFLOW_OUTPUTS_ABS_JSON: JSON.stringify(outputsAbs),
        AGENTFLOW_WORKSPACE_ROOT: fx.root,
        AGENTFLOW_NODE_RUN_DIR: runDir,
        AGENTFLOW_OUTPUTS_DIR: outDir,
        AGENTFLOW_NODE_TMP_DIR: path.join(runDir, "tmp"),
      },
    });

    assert.equal(result.status, 0, `bootstrap 非零退出：${result.stderr}`);
    assert.match(result.stdout, /lines=6 nonEmpty=3/);
    assert.match(result.stdout, new RegExp(`runDir=${runDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    assert.equal(fs.readFileSync(outputsAbs.total, "utf-8"), "6");
    assert.equal(fs.readFileSync(outputsAbs.nonEmpty, "utf-8"), "3");
  } finally {
    fx.cleanup();
  }
});

test("run() 抛错时 bootstrap 非零退出并把栈打到 stderr", () => {
  const fx = makeFixture(`export default { id: "boom", version: "1.0.0", inputs: {}, outputs: {} };
export async function run() { throw new Error("节点自己失败了"); }
`);
  try {
    const result = spawnSync(process.execPath, [BOOTSTRAP, path.join(fx.pkgDir, "index.mjs")], {
      cwd: fx.root,
      encoding: "utf-8",
      env: { ...process.env, AGENTFLOW_INPUTS_JSON: "{}", AGENTFLOW_OUTPUTS_ABS_JSON: "{}" },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /节点自己失败了/);
  } finally {
    fx.cleanup();
  }
});

test("入口没有导出 run() 时 bootstrap 明确报错", () => {
  const fx = makeFixture(`export default { id: "norun", version: "1.0.0", inputs: {}, outputs: {} };\n`);
  try {
    const result = spawnSync(process.execPath, [BOOTSTRAP, path.join(fx.pkgDir, "index.mjs")], {
      cwd: fx.root,
      encoding: "utf-8",
      env: { ...process.env, AGENTFLOW_INPUTS_JSON: "{}", AGENTFLOW_OUTPUTS_ABS_JSON: "{}" },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /没有导出 run\(\)/);
  } finally {
    fx.cleanup();
  }
});
