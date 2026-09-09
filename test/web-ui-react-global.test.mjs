import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const srcRoot = fileURLToPath(new URL("../builtin/web-ui/src/", import.meta.url));

async function sourceFiles(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...await sourceFiles(full));
    else if (/\.(jsx?|tsx?)$/.test(entry.name)) out.push(full);
  }
  return out;
}

test("没有 import React 的文件里不许出现 React.xxx", async () => {
  // 自动 JSX runtime 下 React 不在作用域里。`<React.Fragment>` 这种手滑写法
  // 编译期不报错、构建也过，只在那段 UI 真的渲染时炸成 ReferenceError——
  // 线上就是点开子流程才炸的。
  const offenders = [];
  for (const file of await sourceFiles(srcRoot)) {
    const source = await readFile(file, "utf8");
    if (/^import\s+React[\s,]/m.test(source)) continue;
    const stripped = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    const hit = stripped.match(/\bReact\.[A-Za-z_$]/);
    if (hit) offenders.push(`${path.relative(srcRoot, file)} → ${hit[0]}`);
  }
  assert.deepEqual(offenders, []);
});
