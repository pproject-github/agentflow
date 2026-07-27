import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { startUiServer } from "../bin/lib/ui-server.mjs";


async function createServer(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-review-short-link-"));
  const staticDir = path.join(root, "static");
  fs.mkdirSync(staticDir, { recursive: true });
  fs.writeFileSync(path.join(staticDir, "index.html"), "<!doctype html><title>AgentFlow</title>", "utf-8");
  const server = await startUiServer({
    workspaceRoot: root,
    host: "127.0.0.1",
    port: 0,
    enableWorkspaceScheduler: false,
    staticDir,
  });
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const address = server.address();
  return {
    root,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}


async function publishReview(baseUrl, overrides = {}) {
  const response = await fetch(`${baseUrl}/api/prd-workflow/review-link`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      tapdId: "1015046",
      reviewId: "review-1015046-plan-doc",
      title: "Remote Config 方案",
      markdown: "# Review\n\n内容",
      stage: "plan-doc:remote-config",
      issueKey: "remote-config",
      durability: "durable",
      ...overrides,
    }),
  });
  assert.equal(response.status, 200);
  return response.json();
}


test("review-link returns a stable shortUrl and keeps the canonical url", async (t) => {
  const { baseUrl } = await createServer(t);

  const first = await publishReview(baseUrl);
  const second = await publishReview(baseUrl, { markdown: "# Review\n\n更新内容" });

  assert.match(first.review.url, /\/api\/prd-workflow\/review\/1015046\//);
  assert.match(first.review.shortUrl, /\/r\/[A-Za-z0-9_-]{8}$/);
  assert.equal(first.review.shortUrl, second.review.shortUrl);
  assert.equal(first.event.artifacts[0].url, first.review.shortUrl);
  assert.equal(first.event.artifacts[0].canonicalUrl, first.review.url);
});


test("short review url redirects to the canonical review and renders it", async (t) => {
  const { baseUrl } = await createServer(t);
  const result = await publishReview(baseUrl);

  const redirect = await fetch(result.review.shortUrl, { redirect: "manual" });
  assert.equal(redirect.status, 302);
  assert.equal(redirect.headers.get("location"), new URL(result.review.url).pathname);

  const rendered = await fetch(result.review.shortUrl);
  assert.equal(rendered.status, 200);
  assert.match(await rendered.text(), /Remote Config 方案/);
});


test("unknown and expired short review urls do not redirect", async (t) => {
  const { baseUrl } = await createServer(t);

  const missing = await fetch(`${baseUrl}/r/unknown1`, { redirect: "manual" });
  assert.equal(missing.status, 404);

  const expired = await publishReview(baseUrl, {
    durability: "temporary",
    expiresAt: "2020-01-01T00:00:00.000Z",
  });
  const expiredResponse = await fetch(expired.review.shortUrl, { redirect: "manual" });
  assert.equal(expiredResponse.status, 410);
});
