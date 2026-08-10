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

test("拆出去的子系统都不反向依赖 ui-server", () => {
  // 有环的话 ESM 靠函数提升还能跑，但初始化顺序会变成运气问题
  for (const file of ["prd-workflow-server.mjs", "prd-workflow-routes.mjs", "workspace-server.mjs", "workspace-routes.mjs"]) {
    const imports = localImports(read(file));
    assert.ok(!imports.some((s) => s.includes("ui-server")), `${file} 不该 import ui-server：${imports}`);
  }
});

test("两套路由在 ui-server 里各只剩一处派发", () => {
  const source = read("ui-server.mjs");
  assert.deepEqual(
    source.match(/"\/api\/(prd-workflow|workflows|workflow-)[^"]*"/g) || [],
    [], "PRD 的路径字面量应当只出现在 prd-workflow-routes.mjs 里",
  );
  assert.deepEqual(
    source.match(/"\/api\/(workspace|nodes|node-studio|node-package)[^"]*"/g) || [],
    [], "Workspace 的路径字面量应当只出现在 workspace-routes.mjs 里",
  );
  for (const fn of ["handlePrdWorkflowRoutes", "handleWorkspaceRoutes"]) {
    assert.equal(
      (source.match(new RegExp(`${fn}\\(`, "g")) || []).length, 1,
      `${fn} 的派发点应当只有一处；多一处就说明路由又开始往回长`,
    );
  }
});

test("Workspace 路由的派发点在鉴权闸门之后", () => {
  // 这条是安全约束，不是风格问题。路由链里那道
  // `startsWith("/api/") && !authUser -> 401` 是所有 /api/ 的兜底鉴权；
  // 把集中派发点提到它前面，等于让 37 条 Workspace 路由对未登录请求敞开。
  // 拆分时差点就这么干了——Workspace 路由原本跨在闸门两侧。
  const lines = read("ui-server.mjs").split("\n");
  const gate = lines.findIndex((l) => l.includes('startsWith("/api/") && !authUser'));
  const dispatch = lines.findIndex((l) => l.includes("handleWorkspaceRoutes(req, res"));
  assert.ok(gate > 0, "找不到鉴权闸门——它要是被改名了，这条断言就成了空转");
  assert.ok(dispatch > gate, `派发点 (L${dispatch + 1}) 必须在鉴权闸门 (L${gate + 1}) 之后`);
});

test("两个子系统的实现都不再回流到 ui-server", () => {
  const symbols = topLevelSymbols(read("ui-server.mjs"));
  const prd = symbols
    .filter((name) => /^(prd|workflow)/i.test(name))
    // 这个是 ui-server 自己的状态适配器（读 workspaces 注册表），不属于 PRD 子系统
    .filter((name) => name !== "workflowBindableWorkspaces");
  assert.deepEqual(prd, [], "新的 PRD workflow 函数请写进 prd-workflow-server.mjs");
  const ws = symbols.filter((name) => /^workspace[A-Z_]/.test(name) || /^(runWorkspace|hydrateWorkspace)/.test(name));
  assert.deepEqual(ws, [], "新的 Workspace 运行时函数请写进 workspace-server.mjs");
});

test("三个子系统模块互不依赖", () => {
  // Workspace 运行时和 PRD workflow 是两个产品，共用的只有 HTTP 路由和鉴权
  const ws = localImports(read("workspace-server.mjs"));
  assert.ok(!ws.some((s) => s.includes("prd-workflow")), `workspace-server 不该 import PRD：${ws}`);
  for (const file of ["prd-workflow-server.mjs", "prd-workflow-routes.mjs"]) {
    const imports = localImports(read(file));
    assert.ok(!imports.some((s) => s.includes("workspace-server")), `${file} 不该 import workspace-server`);
  }
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
  for (const file of ["ui-server.mjs", "prd-workflow-server.mjs", "prd-workflow-routes.mjs", "workspace-server.mjs", "workspace-routes.mjs"]) {
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
