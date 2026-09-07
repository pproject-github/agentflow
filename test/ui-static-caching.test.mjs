import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// 用户需求点: 构建产物文件名自带内容哈希，却一个缓存头都不发，每进一个入口都要重下 ~1MB。
test("static assets are cacheable and revalidate with ETag", async (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-ui-static-"));
  const staticDir = path.join(tempRoot, "static");
  fs.mkdirSync(path.join(staticDir, "assets"), { recursive: true });
  fs.writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><title>app</title>", "utf8");
  fs.writeFileSync(path.join(staticDir, "assets", "index-Drbndb0x.js"), "console.log('bundle')", "utf8");
  const workspaceRoot = path.join(tempRoot, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });

  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  let server;
  t.after(async () => {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  const { startUiServer } = await import(`../bin/lib/ui-server.mjs?ui-static-caching=${Date.now()}`);
  server = await startUiServer({
    workspaceRoot,
    host: "127.0.0.1",
    port: 0,
    staticDir,
    enableWorkspaceScheduler: false,
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const asset = await fetch(`${base}/assets/index-Drbndb0x.js`);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
  const etag = asset.headers.get("etag");
  assert.ok(etag, "内容哈希产物必须带 ETag");
  assert.equal(await asset.text(), "console.log('bundle')");

  const revalidated = await fetch(`${base}/assets/index-Drbndb0x.js`, {
    headers: { "If-None-Match": etag },
  });
  assert.equal(revalidated.status, 304);

  // index.html 必须每次校验，否则发版后客户端拿不到新的 bundle 文件名。
  const html = await fetch(`${base}/index.html`);
  assert.equal(html.status, 200);
  assert.equal(html.headers.get("cache-control"), "no-cache");
  assert.ok(html.headers.get("etag"));

  // 未知路径回退成 index.html，不能被当成不可变产物永久缓存。
  const spaRoute = await fetch(`${base}/assets/does-not-exist-abcdefgh.js`);
  assert.equal(spaRoute.status, 200);
  assert.equal(spaRoute.headers.get("cache-control"), "no-cache");
  assert.equal(await spaRoute.text(), "<!doctype html><title>app</title>");
});
