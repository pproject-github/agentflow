import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("PRD Workflow review links are readable without authentication", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-prd-review-api-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "project");
  fs.mkdirSync(workspaceRoot, { recursive: true });

  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = dataRoot;
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?prd-review-api=${nonce}`),
      import(`../bin/lib/ui-server.mjs?prd-review-api=${nonce}`),
    ]);
    const owner = loginOrCreateUser("review-owner", "owner-password");
    server = await startUiServer({
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
    });
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const created = await fetch(`${baseUrl}/api/prd-workflow/review-link`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${owner.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        tapdId: "1133202860001017765",
        title: "礼物列表缓存完整性方案",
        markdown: "# 匿名可读 Review\n\nReview 正文",
      }),
    });
    const createdPayload = await created.json();
    assert.equal(created.status, 200, JSON.stringify(createdPayload));

    const anonymous = await fetch(createdPayload.review.url);
    const anonymousHtml = await anonymous.text();
    assert.equal(anonymous.status, 200, anonymousHtml);
    assert.match(anonymousHtml, /匿名可读 Review/);
    assert.match(anonymousHtml, /Review 正文/);

    const rawUrl = new URL(createdPayload.review.url);
    rawUrl.searchParams.set("raw", "1");
    const anonymousRaw = await fetch(rawUrl);
    assert.equal(anonymousRaw.status, 200);
    assert.equal(await anonymousRaw.text(), "# 匿名可读 Review\n\nReview 正文\n");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome == null) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("legacy PRD Workflow review links are discovered and indexed anonymously", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-prd-review-legacy-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "project");
  const reviewDir = path.join(
    dataRoot,
    "users",
    "legacy-owner",
    ".workspace",
    "prd-flow",
    "reviews",
    "legacy-tapd",
  );
  fs.mkdirSync(reviewDir, { recursive: true });
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.writeFileSync(path.join(reviewDir, "r-legacy.md"), "# Legacy Review\n", "utf-8");
  fs.writeFileSync(
    path.join(reviewDir, "r-legacy.json"),
    JSON.stringify({ id: "r-legacy", tapdId: "legacy-tapd", title: "Legacy Review" }),
    "utf-8",
  );

  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = dataRoot;
  let server;
  try {
    const { startUiServer } = await import(`../bin/lib/ui-server.mjs?prd-review-legacy=${Date.now()}`);
    server = await startUiServer({
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
    });
    const address = server.address();
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/prd-workflow/review/legacy-tapd/r-legacy?raw=1`,
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "# Legacy Review\n");
    assert.equal(
      fs.existsSync(path.join(dataRoot, "prd-workflow-review-index", "legacy-tapd", "r-legacy.json")),
      true,
    );
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome == null) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
