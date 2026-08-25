import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("node review resolves scriptRef content and compares Draft with Stable", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-node-review-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  let server;
  try {
    const nonce = Date.now();
    const workspaceRoot = path.join(tempRoot, "workspace");
    const [{ loginOrCreateUser }, { startUiServer }, { publishNodePackage }] = await Promise.all([
      import(`../bin/lib/auth.mjs?node-review=${nonce}`),
      import(`../bin/lib/ui-server.mjs?node-review=${nonce}`),
      import("../bin/lib/marketplace.mjs"),
    ]);
    const user = loginOrCreateUser("node-review-owner", "node-review-password");
    const packageDir = path.join(tempRoot, "review-package");
    fs.mkdirSync(packageDir, { recursive: true });
    fs.writeFileSync(path.join(packageDir, "index.mjs"), `export default {
  id: "review_package",
  version: "1.0.0",
  name: "Review Package",
  inputs: {},
  outputs: { result: { type: "text" } },
};
export async function run() { return { result: "reviewable" }; }
`, "utf-8");
    const packagePublished = publishNodePackage(workspaceRoot, packageDir, {
      ownerUserId: user.userId,
      immutable: true,
    });
    assert.equal(packagePublished.ok, true);
    server = await startUiServer({
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
      enableWorkspaceScheduler: false,
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" };
    const request = async (method, pathname, body) => {
      const response = await fetch(base + pathname, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let payload = null;
      try { payload = JSON.parse(text); } catch {}
      return { status: response.status, body: payload, text };
    };

    assert.equal((await request("POST", "/api/flows", { flowId: "review-flow", targetSpace: "user" })).status, 200);
    const initial = await request("GET", "/api/workspace/graph?flowId=review-flow&flowSource=user");
    assert.equal(initial.status, 200, initial.text);
    const scriptPath = path.join(initial.body.root, "nodes", "worker", "script.mjs");
    fs.mkdirSync(path.dirname(scriptPath), { recursive: true });
    fs.writeFileSync(scriptPath, "export async function run() { return 'stable'; }\n", "utf-8");

    const graph = {
      version: 1,
      instances: {
        worker: {
          definitionId: "tool_nodejs",
          label: "Worker",
          scriptRef: "nodes/worker/script.mjs",
          input: [],
          output: [],
        },
        packaged: {
          definitionId: "marketplace:review_package@1.0.0",
          marketplaceRef: "marketplace:review_package@1.0.0",
          label: "Packaged",
          input: [],
          output: [],
        },
      },
      edges: [],
      ui: { nodePositions: { worker: { x: 120, y: 120 } } },
    };
    const saved = await request("POST", "/api/workspace/graph", {
      flowId: "review-flow",
      flowSource: "user",
      graph,
    });
    assert.equal(saved.status, 200, saved.text);
    const published = await request("POST", "/api/workspace/releases/publish", {
      flowId: "review-flow",
      flowSource: "user",
      expectedRevision: saved.body.revision,
    });
    assert.equal(published.status, 200, published.text);

    fs.writeFileSync(scriptPath, "export async function run() { return 'draft'; }\n", "utf-8");
    const review = await request("GET", "/api/workspace/node-review?flowId=review-flow&flowSource=user&nodeId=worker");
    assert.equal(review.status, 200, review.text);
    assert.equal(review.body.stableReleaseId, "v1");
    assert.equal(review.body.draft.reviewable, true);
    assert.equal(review.body.stable.reviewable, true);
    const draftScript = review.body.draft.sources.find((source) => source.path === "nodes/worker/script.mjs");
    const stableScript = review.body.stable.sources.find((source) => source.path === "nodes/worker/script.mjs");
    assert.match(draftScript.content, /draft/);
    assert.match(stableScript.content, /stable/);
    assert.notEqual(draftScript.sha256, stableScript.sha256);

    const packageReview = await request("GET", "/api/workspace/node-review?flowId=review-flow&flowSource=user&nodeId=packaged");
    assert.equal(packageReview.status, 200, packageReview.text);
    assert.equal(packageReview.body.draft.package.id, "review_package");
    assert.equal(packageReview.body.draft.package.version, "1.0.0");
    assert.match(packageReview.body.draft.package.contentSha256, /^[a-f0-9]{64}$/);
    assert.match(packageReview.body.draft.sources.find((source) => source.path === "index.mjs").content, /export async function run/);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
