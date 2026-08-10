/**
 * 模块边界。
 *
 * `ui-server.mjs` 一度是两万行，里面挤着两个互不相干的产品：Workspace 运行时和 PRD
 * workflow。两者除了共用 HTTP 路由和鉴权没有任何关系，却共享同一个 diff 面——改一边要在
 * 两万行里定位，另一边的改动跟着一起进 review。
 *
 * 拆开之后靠这几条断言守住，别再长回去。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const LIB = path.resolve(import.meta.dirname, "..", "bin", "lib");
const read = (name) => fs.readFileSync(path.join(LIB, name), "utf-8");

/** 一个文件 import 了哪些本地模块。 */
function localImports(source) {
  return [...source.matchAll(/^import\s+(?:.+?\s+from\s+)?"(\.[^"]+)";/gms)].map((m) => m[1]);
}

/** 顶层声明的符号名。 */
function topLevelSymbols(source) {
  return source.split("\n")
    .map((line) => /^(?:export )?(?:async )?(?:function|const|class) ([a-zA-Z_][\w]*)/.exec(line)?.[1])
    .filter(Boolean);
}

test("PRD workflow 模块不反向依赖 ui-server", () => {
  // 有环的话 ESM 靠函数提升还能跑，但初始化顺序会变成运气问题
  const imports = localImports(read("prd-workflow-server.mjs"));
  assert.ok(!imports.some((s) => s.includes("ui-server")), `不该 import ui-server：${imports}`);
});

test("PRD workflow 的实现不再回流到 ui-server", () => {
  const strays = topLevelSymbols(read("ui-server.mjs"))
    .filter((name) => /^(prd|workflow)/i.test(name))
    // 这个是 ui-server 自己的状态适配器（读 workspaces 注册表），不属于 PRD 子系统
    .filter((name) => name !== "workflowBindableWorkspaces");
  assert.deepEqual(strays, [], "新的 PRD workflow 函数请写进 prd-workflow-server.mjs");
});

test("三个共享小工具只有一份实现", () => {
  // 拆分时最容易犯的错：两边各留一份，改了一边另一边还是老的
  for (const [name, home] of [
    ["htmlEscapeAttribute", "html-escape.mjs"],
    ["execFileBuffered", "exec-buffered.mjs"],
    ["runtimeEnvForUser", "user-env.mjs"],
  ]) {
    const owners = fs.readdirSync(LIB)
      .filter((f) => f.endsWith(".mjs"))
      .filter((f) => topLevelSymbols(read(f)).includes(name));
    assert.deepEqual(owners, [home], `${name} 应当只在 ${home} 里声明一次`);
  }
});

test("ui-server 里不留没人用的 import", () => {
  // 大规模搬运之后最常见的残留。留着不报错，但下一个人无从判断哪些依赖是真的
  for (const file of ["ui-server.mjs", "prd-workflow-server.mjs"]) {
    const source = read(file);
    const imported = [...source.matchAll(/^import\s+(.+?)\s+from\s+"[^"]+";/gms)]
      .flatMap((m) => {
        const clause = m[1].trim();
        return clause.startsWith("{")
          ? clause.slice(1, -1).split(",").map((x) => x.trim().split(" as ").pop().trim()).filter(Boolean)
          : [clause];
      });
    // 不抹字符串：模板串里 `href="${htmlEscapeAttribute(x)}"` 的引号会被当成字符串边界，
    // 把真调用一起吃掉。宁可把「只在字符串里出现的名字」也算成用过——这条断言的目的是
    // 抓「哪儿都没出现」的死 import，不是做精确的可达性分析
    const body = source.replace(/^import\s+.+?\s+from\s+"[^"]+";/gms, "");
    const words = new Set([...body.matchAll(/\b([a-zA-Z_][\w]*)\b/g)].map((m) => m[1]));
    const unused = [...new Set(imported)].filter((name) => !words.has(name));
    assert.deepEqual(unused, [], `${file} 有没用上的 import`);
  }
});
