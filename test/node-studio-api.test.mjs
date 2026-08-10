/**
 * Node Studio 的生成 → 测试 → 发布闭环。
 *
 * 这个页面原来是个完整的 mockup：草稿接口把提示词存下来、回一句写死的「已记录需求，下一步
 * 会由节点 Agent 更新 manifest、脚本和 UI schema」，Test 是 900ms 的 setTimeout，Publish
 * 什么都不做。于是「让 AI 生成一个自定义节点」这条产品路径整条是空的。
 *
 * 生成那一步要真起 Agent，测不了；这里测的是它前后的两段——包目录读回来的清单必须是
 * `index.mjs` 声明的投影，测试必须走运行时同一套 bootstrap，发布必须先解析得过。
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const GOOD_PACKAGE = `import fs from "node:fs/promises";

export default {
  id: "line_count",
  version: "1.0.0",
  name: "统计行数",
  description: "数一数有几行",
  inputs: { text: { type: "text", description: "正文", required: true } },
  outputs: { total: { type: "text" } },
};

export async function run(inputs, outputs) {
  const total = String(inputs.text || "").split("\\n").length;
  await fs.writeFile(outputs.total, String(total), "utf-8");
  console.log("counted");
}
`;

/** 声明里引用了变量——acorn 静态解析读不出来，必须在发布前挡住。 */
const BAD_PACKAGE = `const T = "text";
export default { id: "broken", version: "1.0.0", inputs: { a: { type: T } } };
export async function run() {}
`;

async function withServer(fn) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-node-studio-"));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  let server;
  try {
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?node-studio=${Date.now()}`),
      import(`../bin/lib/ui-server.mjs?node-studio=${Date.now()}`),
    ]);
    const user = loginOrCreateUser("studio", "studio-password");
    assert.equal(user.ok, true);
    server = await startUiServer({
      workspaceRoot: path.join(tempRoot, "project"),
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const request = async (pathname, init = {}) => fetch(`${baseUrl}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${user.token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    });
    // 生成那一步要真起 Agent，测不起；直接把包放进草稿目录，模拟 Agent 刚写完的状态
    const plantPackage = (draftId, source) => {
      const dir = path.join(process.env.AGENTFLOW_HOME, "users", user.user.userId, "node-studio", "drafts", draftId);
      fs.mkdirSync(path.join(dir, "package"), { recursive: true });
      fs.writeFileSync(path.join(dir, "package", "index.mjs"), source, "utf-8");
      return dir;
    };
    await fn({ request, plantPackage, tempRoot });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

test("草稿的清单是 index.mjs 声明的投影，不是另存一份", async () => {
  await withServer(async ({ request, plantPackage }) => {
    // 先建草稿，再把包放进去，最后读回来
    await request("/api/node-studio/draft", { method: "POST", body: JSON.stringify({ id: "line_count" }) });
    plantPackage("line_count", GOOD_PACKAGE);
    // 触发一次落盘之外的读取：test 路由会重新解析包
    const res = await request("/api/node-studio/test", {
      method: "POST",
      body: JSON.stringify({ id: "line_count", inputs: { text: "a\nb\nc" } }),
    });
    const json = await res.json();
    assert.equal(res.status, 200, JSON.stringify(json));
    assert.equal(json.status, "passed", json.log?.join("\n"));
    // 真跑过 bootstrap：3 行
    assert.equal(json.outputs.total, "3");
    assert.ok(json.log.some((line) => line.includes("counted")), "stdout 应当进日志");
  });
});

test("测试走运行时同一套 bootstrap——节点抛错就是失败", async () => {
  await withServer(async ({ request, plantPackage }) => {
    await request("/api/node-studio/draft", { method: "POST", body: JSON.stringify({ id: "boom" }) });
    plantPackage("boom", `export default { id: "boom", version: "1.0.0", inputs: {}, outputs: { r: { type: "text" } } };
export async function run() { throw new Error("节点自己炸了"); }
`);
    const res = await request("/api/node-studio/test", { method: "POST", body: JSON.stringify({ id: "boom", inputs: {} }) });
    const json = await res.json();
    assert.equal(json.status, "failed");
    assert.ok(json.log.join("\n").includes("节点自己炸了"), "失败原因要能看见");
  });
});

test("声明没写文件的输出槽会被点出来", async () => {
  await withServer(async ({ request, plantPackage }) => {
    await request("/api/node-studio/draft", { method: "POST", body: JSON.stringify({ id: "lazy" }) });
    plantPackage("lazy", `export default { id: "lazy", version: "1.0.0", inputs: {}, outputs: { a: { type: "text" }, b: { type: "text" } } };
export async function run(inputs, outputs) { const fs = await import("node:fs/promises"); await fs.writeFile(outputs.a, "1"); }
`);
    const res = await request("/api/node-studio/test", { method: "POST", body: JSON.stringify({ id: "lazy", inputs: {} }) });
    const json = await res.json();
    assert.ok(json.log.some((line) => line.includes("没有写文件") && line.includes("b")), json.log.join("\n"));
  });
});

test("file 槽里写路径而不是内容，测试阶段就点出来", async () => {
  // 这条是真实生成的节点踩出来的：它把 CSV 写到自选路径，再把那个路径写进槽。测试里看着
  // 能过（路径确实存在），真实运行时那个位置是会被清理的临时目录，产物就丢了
  await withServer(async ({ request, plantPackage, tempRoot }) => {
    const stray = path.join(tempRoot, "stray.csv");
    fs.writeFileSync(stray, "a,b\n", "utf-8");
    await request("/api/node-studio/draft", { method: "POST", body: JSON.stringify({ id: "strayfile" }) });
    plantPackage("strayfile", `export default { id: "strayfile", version: "1.0.0", inputs: {}, outputs: { out: { type: "file" } } };
export async function run(inputs, outputs) {
  const fs = await import("node:fs/promises");
  await fs.writeFile(outputs.out, ${JSON.stringify(stray)});
}
`);
    const res = await request("/api/node-studio/test", { method: "POST", body: JSON.stringify({ id: "strayfile", inputs: {} }) });
    const json = await res.json();
    assert.ok(
      json.log.some((line) => line.includes("是 file 槽") && line.includes("out")),
      json.log.join("\n"),
    );
  });
});

test("解析不过的包发布不出去", async () => {
  // 发布一个读不出声明的包，等于往市场里放一个在面板上根本不出现的条目——
  // 问题会推迟到别人安装它的时候才暴露
  await withServer(async ({ request, plantPackage }) => {
    await request("/api/node-studio/draft", { method: "POST", body: JSON.stringify({ id: "broken" }) });
    plantPackage("broken", BAD_PACKAGE);
    const res = await request("/api/node-studio/publish", { method: "POST", body: JSON.stringify({ id: "broken" }) });
    const json = await res.json();
    assert.equal(res.status, 400);
    assert.match(String(json.error || ""), /^export default/, "报错要指出声明里的哪一处");
  });
});

test("还没生成就发布，给的是可操作的提示而不是 500", async () => {
  await withServer(async ({ request }) => {
    await request("/api/node-studio/draft", { method: "POST", body: JSON.stringify({ id: "empty_draft" }) });
    const res = await request("/api/node-studio/publish", { method: "POST", body: JSON.stringify({ id: "empty_draft" }) });
    const json = await res.json();
    assert.equal(res.status, 400);
    assert.match(String(json.error || ""), /index\.mjs/);
  });
});

test("解析得过的包能发布进 workspace 市场", async () => {
  await withServer(async ({ request, plantPackage, tempRoot }) => {
    await request("/api/node-studio/draft", { method: "POST", body: JSON.stringify({ id: "line_count" }) });
    plantPackage("line_count", GOOD_PACKAGE);
    const res = await request("/api/node-studio/publish", { method: "POST", body: JSON.stringify({ id: "line_count" }) });
    const json = await res.json();
    assert.equal(res.status, 200, JSON.stringify(json));
    assert.equal(json.definitionId, "marketplace:line_count@1.0.0");
    const published = path.join(tempRoot, "project", ".workspace", "agentflow", "marketplace", "packages", "nodes", "line_count", "1.0.0");
    assert.ok(fs.existsSync(path.join(published, "index.mjs")), "包体要真的落到市场目录");
    // 草稿元数据不该被一起发布出去——所以包放在 draft 目录下的 package/ 子目录里
    assert.ok(!fs.existsSync(path.join(published, "draft.json")), "draft.json 不该进包");
  });
});
