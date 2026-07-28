import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function writeFlow(dataRoot, userId, flowId) {
  const flowDir = path.join(dataRoot, "users", userId, "pipelines", flowId);
  fs.mkdirSync(flowDir, { recursive: true });
  fs.writeFileSync(path.join(flowDir, "flow.yaml"), "version: 1\ninstances: {}\nedges: []\n", "utf-8");
  return flowDir;
}

test("shared PRD Workflow state follows TAPD ID across different Projects", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-prd-collab-api-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "project");
  const ownerFlowDir = writeFlow(dataRoot, "owner", "owner-project");
  writeFlow(dataRoot, "guest", "guest-project");
  fs.mkdirSync(workspaceRoot, { recursive: true });

  const legacyStateDir = path.join(ownerFlowDir, ".workspace", "prd-flow", "workflow-state");
  fs.mkdirSync(legacyStateDir, { recursive: true });
  fs.writeFileSync(
    path.join(legacyStateDir, "1015046.cache.json"),
    JSON.stringify({
      version: 1,
      tapdId: "1015046",
      snapshot: {
        tapdId: "1015046",
        phase: "implementing",
        pointer: "Owner shared Workflow",
        revision: "revision-owner",
        actions: [],
        issues: [],
      },
    }, null, 2) + "\n",
    "utf-8",
  );

  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = dataRoot;
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?prd-collab-api=${nonce}`),
      import(`../bin/lib/ui-server.mjs?prd-collab-api=${nonce}`),
    ]);
    const owner = loginOrCreateUser("owner", "owner-password");
    const guest = loginOrCreateUser("guest", "guest-password");
    const outsider = loginOrCreateUser("outsider", "outsider-password");
    server = await startUiServer({
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
    });
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const request = async (token, pathname, init = {}) => fetch(`${baseUrl}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    });

    const shared = await request(owner.token, "/api/prd-workflow/share", {
      method: "POST",
      body: JSON.stringify({
        tapdId: "1015046",
        flowId: "owner-project",
        flowSource: "user",
      }),
    });
    const sharedPayload = await shared.json();
    assert.equal(shared.status, 200, JSON.stringify(sharedPayload));
    assert.equal(sharedPayload.share.tapdId, "1015046");
    assert.equal(sharedPayload.share.readOnly, true);
    const workflowShare = new URL(sharedPayload.share.url).searchParams.get("workflowShare");
    assert.ok(workflowShare);

    const guestSnapshot = await request(
      guest.token,
      `/api/prd-workflow/snapshot?tapdId=1015046&runtimeOnly=1&workflowShare=${encodeURIComponent(workflowShare)}`,
    );
    const guestPayload = await guestSnapshot.json();
    assert.equal(guestSnapshot.status, 200, JSON.stringify(guestPayload));
    assert.equal(guestPayload.snapshot.pointer, "Owner shared Workflow");

    const outsiderSnapshot = await request(
      outsider.token,
      "/api/prd-workflow/snapshot?tapdId=1015046&runtimeOnly=1",
    );
    const outsiderPayload = await outsiderSnapshot.json();
    assert.equal(outsiderSnapshot.status, 200);
    assert.notEqual(outsiderPayload.snapshot.pointer, "Owner shared Workflow");

    const canonicalCache = path.join(
      dataRoot,
      "users",
      "owner",
      ".workspace",
      "prd-flow",
      "workflow-state",
      "1015046.cache.json",
    );
    assert.equal(fs.existsSync(canonicalCache), true);

    const revoked = await request(owner.token, "/api/prd-workflow/share", {
      method: "DELETE",
      body: JSON.stringify({ tapdId: "1015046" }),
    });
    assert.equal(revoked.status, 200);
    const revokedSnapshot = await request(
      guest.token,
      `/api/prd-workflow/snapshot?tapdId=1015046&runtimeOnly=1&workflowShare=${encodeURIComponent(workflowShare)}`,
    );
    assert.equal(revokedSnapshot.status, 404);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome == null) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
