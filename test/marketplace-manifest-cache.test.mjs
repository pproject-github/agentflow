import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const PACKAGE = (version, name) => `export default {
  id: "cache_probe",
  version: ${JSON.stringify(version)},
  name: ${JSON.stringify(name)},
  inputs: { src: { type: "text" } },
  outputs: { out: { type: "text" } },
};
export async function run() {}
`;

async function seed(t) {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-manifest-cache-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  t.after(() => {
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });
  const marketplace = await import(`../bin/lib/marketplace.mjs?manifest-cache=${Date.now()}${Math.random()}`);
  const workspaceRoot = path.join(tempRoot, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const publish = (version, name) => {
    const dir = path.join(tempRoot, `pkg-${version}`);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "index.mjs"), PACKAGE(version, name), "utf-8");
    const result = marketplace.publishNodePackage(workspaceRoot, dir, { ownerUserId: "cache-owner" });
    assert.equal(result.ok, true, result.error || `发布 ${version} 应当成功`);
    return result;
  };
  return { marketplace, workspaceRoot, tempRoot, publish };
}

const nodeNames = (marketplace, root) =>
  marketplace.listMarketplaceNodes(root).map((n) => `${n.id}@${n.version}:${n.displayName || n.name || ""}`);

// 读一次清单要 acorn 解析 index.mjs；线上 102 个包一趟 100ms，而每读一张图都要扫一遍
// 全部包，仓库索引重建又要读 97 张图——97 × 100ms ≈ 10 秒单线程跑满，事件循环被按住，
// 连 accept 都来不及做。已发布的版本目录不可变，读一次就该一直用。
test("重复扫描不改变结果", async (t) => {
  const { marketplace, workspaceRoot, publish } = await seed(t);
  publish("1.0.0", "初版");
  const first = nodeNames(marketplace, workspaceRoot);
  assert.equal(first.length, 1);
  for (let i = 0; i < 5; i++) {
    assert.deepEqual(nodeNames(marketplace, workspaceRoot), first, "同样的磁盘状态必须给同样的答案");
  }
});

test("发布新版本立刻可见", async (t) => {
  const { marketplace, workspaceRoot, publish } = await seed(t);
  publish("1.0.0", "初版");
  assert.equal(nodeNames(marketplace, workspaceRoot).length, 1);
  publish("1.0.1", "改过");
  const after = nodeNames(marketplace, workspaceRoot);
  assert.equal(after.length, 2, `新版本必须被扫到，实际 ${after.join(", ")}`);
});

// 第一版缓存按目录 mtime 判失效，结果漏了这条：**改写目录里已有的文件不会改变目录的
// mtime**，可见性于是永远读到旧值。所以元数据不进缓存，只缓存声明。
test("原地改写元数据能被读到（不靠目录 mtime）", async (t) => {
  const { marketplace, workspaceRoot, publish } = await seed(t);
  const published = publish("1.0.0", "初版");
  const before = marketplace.listMarketplaceNodes(workspaceRoot)[0];
  assert.ok(before, "先要能扫到");

  const packageDir = published.packageDir || published.dir
    || marketplace.listMarketplaceNodes(workspaceRoot)[0]?.packageDir;
  assert.ok(packageDir, "拿不到包目录");
  const metaPath = path.join(packageDir, ".agentflow-package.json");
  const existing = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf-8")) : {};
  // 原地重写，目录 mtime 不变
  fs.writeFileSync(metaPath, JSON.stringify({ ...existing, visibility: "private" }, null, 2), "utf-8");

  const after = marketplace.listMarketplaceNodes(workspaceRoot)[0];
  assert.equal(after?.visibility, "private", "原地改写的元数据必须立刻生效");
});
