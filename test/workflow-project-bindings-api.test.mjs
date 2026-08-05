import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function writeProject(dataRoot, userId, flowId) {
  const flowDir = path.join(dataRoot, "users", userId, "pipelines", flowId);
  fs.mkdirSync(flowDir, { recursive: true });
  fs.writeFileSync(path.join(flowDir, "flow.yaml"), "version: 1\ninstances: {}\nedges: []\n", "utf-8");
}

test("iterations are explicitly bound to Projects and expose only stored bindings", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-workflow-project-bindings-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = dataRoot;
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?workflow-project-bindings=${nonce}`),
      import(`../bin/lib/ui-server.mjs?workflow-project-bindings=${nonce}`),
    ]);
    const owner = loginOrCreateUser("binding-owner", "binding-password");
    const outsider = loginOrCreateUser("binding-outsider", "binding-password");
    writeProject(dataRoot, owner.user.userId, "project-a");
    writeProject(dataRoot, owner.user.userId, "project-b");
    writeProject(dataRoot, outsider.user.userId, "outsider-project");
    server = await startUiServer({
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const request = (pathname, init = {}, authenticated = true) => fetch(`${baseUrl}${pathname}`, {
      ...init,
      headers: {
        ...(authenticated ? { Authorization: `Bearer ${owner.token}` } : {}),
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    });

    const reported = await request("/api/prd-workflow/snapshot", {
      method: "POST",
      body: JSON.stringify({
        tapdId: "1019001",
        snapshot: {
          tapdId: "1019001",
          phase: "planning",
          pointer: "Explicit binding test",
          actions: [],
          issues: [],
        },
      }),
    });
    assert.equal(reported.status, 200, await reported.text());

    const initial = await request("/api/workflows/project-bindings?tapdId=1019001");
    const initialPayload = await initial.json();
    assert.equal(initial.status, 200, JSON.stringify(initialPayload));
    assert.deepEqual(initialPayload.bindings, []);
    assert.deepEqual(
      initialPayload.availableProjects.map((project) => project.flowId).sort(),
      ["project-a", "project-b"],
    );

    const outsiderBind = await fetch(`${baseUrl}/api/workflows/project-bindings`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${outsider.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ tapdId: "1019001", flowId: "outsider-project", flowSource: "user" }),
    });
    assert.equal(outsiderBind.status, 403);

    const bindA = await request("/api/workflows/project-bindings", {
      method: "POST",
      body: JSON.stringify({ tapdId: "1019001", flowId: "project-a", flowSource: "user" }),
    });
    const bindAPayload = await bindA.json();
    assert.equal(bindA.status, 200, JSON.stringify(bindAPayload));
    assert.equal(bindAPayload.created, true);
    assert.equal(bindAPayload.bindings.length, 1);
    assert.equal(bindAPayload.bindings[0].flowId, "project-a");
    assert.match(bindAPayload.bindings[0].workspaceId, /^ws_/);

    const bindAAgain = await request("/api/workflows/project-bindings", {
      method: "POST",
      body: JSON.stringify({
        tapdId: "1019001",
        flowId: "project-a",
        flowSource: "user",
        workspaceId: bindAPayload.bindings[0].workspaceId,
      }),
    });
    const bindAAgainPayload = await bindAAgain.json();
    assert.equal(bindAAgain.status, 200, JSON.stringify(bindAAgainPayload));
    assert.equal(bindAAgainPayload.created, false);
    assert.deepEqual(bindAAgainPayload.bindings.map((project) => project.flowId), ["project-a"]);

    const bindB = await request("/api/workflows/project-bindings", {
      method: "POST",
      body: JSON.stringify({ tapdId: "1019001", flowId: "project-b", flowSource: "user" }),
    });
    const bindBPayload = await bindB.json();
    assert.equal(bindB.status, 200, JSON.stringify(bindBPayload));
    assert.deepEqual(bindBPayload.bindings.map((project) => project.flowId).sort(), ["project-a", "project-b"]);

    const dashboard = await request("/api/prd-workflows?view=personal");
    const dashboardPayload = await dashboard.json();
    assert.equal(dashboard.status, 200, JSON.stringify(dashboardPayload));
    assert.deepEqual(
      dashboardPayload.workflows[0].projectBindings.map((project) => project.flowId).sort(),
      ["project-a", "project-b"],
    );

    const unbindA = await request("/api/workflows/project-bindings", {
      method: "DELETE",
      body: JSON.stringify({
        tapdId: "1019001",
        workspaceId: bindAPayload.bindings[0].workspaceId,
      }),
    });
    const unbindAPayload = await unbindA.json();
    assert.equal(unbindA.status, 200, JSON.stringify(unbindAPayload));
    assert.deepEqual(unbindAPayload.bindings.map((project) => project.flowId), ["project-b"]);

    const anonymous = await request("/api/workflows/project-bindings?tapdId=1019001", {}, false);
    assert.equal(anonymous.status, 401);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome == null) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
  }
});
