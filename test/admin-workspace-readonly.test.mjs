import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("admin can review another user's Workspace but cannot modify or run it", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-admin-workspace-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "project");
  const staticDir = path.join(tempRoot, "static");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(staticDir, { recursive: true });

  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = dataRoot;
  let server;
  try {
    const nonce = Date.now();
    const [
      { loginOrCreateUser },
      { getUserPipelinesRoot, PIPELINES_DIR },
      { ensureWorkspaceCollaboration },
      { startUiServer },
    ] = await Promise.all([
      import(`../bin/lib/auth.mjs?admin-workspace=${nonce}`),
      import(`../bin/lib/paths.mjs?admin-workspace=${nonce}`),
      import(`../bin/lib/workspace-collaboration.mjs?admin-workspace=${nonce}`),
      import(`../bin/lib/ui-server.mjs?admin-workspace=${nonce}`),
    ]);

    const admin = loginOrCreateUser("workspace-review-admin", "admin-password");
    const owner = loginOrCreateUser("workspace-review-owner", "owner-password");
    const flowDir = path.join(getUserPipelinesRoot(owner.user.userId), "owner_project");
    fs.mkdirSync(flowDir, { recursive: true });
    fs.writeFileSync(
      path.join(flowDir, "flow.yaml"),
      [
        "version: 1",
        "ui:",
        "  description: Owner-only project",
        "instances: {}",
        "edges: []",
        "",
      ].join("\n"),
      "utf-8",
    );
    const originalGraph = {
      version: 1,
      instances: {
        note_1: {
          instanceId: "note_1",
          definitionId: "provide_text",
          label: "Owner note",
          input: [],
          output: [],
        },
      },
      edges: [],
      ui: { nodePositions: { note_1: { x: 120, y: 80 } } },
    };
    fs.writeFileSync(
      path.join(flowDir, "workspace.graph.json"),
      `${JSON.stringify(originalGraph, null, 2)}\n`,
      "utf-8",
    );
    fs.writeFileSync(path.join(flowDir, "owner-note.md"), "owner workspace content\n", "utf-8");

    const sharedFlowDir = path.join(workspaceRoot, PIPELINES_DIR, "shared_project");
    fs.mkdirSync(sharedFlowDir, { recursive: true });
    fs.writeFileSync(
      path.join(sharedFlowDir, "flow.yaml"),
      [
        "version: 1",
        "ui:",
        "  description: Shared owner project",
        "instances: {}",
        "edges: []",
        "",
      ].join("\n"),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(sharedFlowDir, "workspace.graph.json"),
      `${JSON.stringify({
        ...originalGraph,
        instances: {
          shared_note: {
            instanceId: "shared_note",
            definitionId: "provide_text",
            label: "Shared owner note",
            input: [],
            output: [],
          },
        },
      }, null, 2)}\n`,
      "utf-8",
    );
    fs.writeFileSync(path.join(sharedFlowDir, "shared-note.md"), "shared workspace content\n", "utf-8");
    const sharedWorkspace = ensureWorkspaceCollaboration({
      flowId: "shared_project",
      flowSource: "workspace",
      userId: owner.user.userId,
    });
    assert.equal(sharedWorkspace.created, true);

    server = await startUiServer({
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      staticDir,
    });
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const request = (token, pathname, options = {}) => fetch(`${baseUrl}${pathname}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });

    const listQuery = new URLSearchParams({ userId: owner.user.userId });
    const deniedList = await request(owner.token, `/api/admin/user-workspaces?${listQuery}`);
    assert.equal(deniedList.status, 403);

    const allowedList = await request(admin.token, `/api/admin/user-workspaces?${listQuery}`);
    const listed = await allowedList.json();
    assert.equal(allowedList.status, 200, JSON.stringify(listed));
    assert.equal(listed.owner.userId, owner.user.userId);
    assert.deepEqual(
      listed.workspaces.map((workspace) => workspace.id),
      ["owner_project"],
    );
    assert.equal(listed.workspaces[0].adminReadonly, true);
    assert.equal(Object.prototype.hasOwnProperty.call(listed.workspaces[0], "path"), false);

    const reviewQuery = new URLSearchParams({
      flowId: "owner_project",
      flowSource: "user",
      adminOwnerId: owner.user.userId,
    });
    const deniedGraph = await request(owner.token, `/api/workspace/graph?${reviewQuery}`);
    assert.equal(deniedGraph.status, 403);

    const allowedGraph = await request(admin.token, `/api/workspace/graph?${reviewQuery}`);
    const graph = await allowedGraph.json();
    assert.equal(allowedGraph.status, 200, JSON.stringify(graph));
    assert.equal(graph.writable, false);
    assert.equal(graph.adminReview.readonly, true);
    assert.equal(graph.adminReview.ownerUserId, owner.user.userId);
    assert.equal(graph.graph.instances.note_1.label, "Owner note");

    const sharedReviewQuery = new URLSearchParams({
      flowId: "shared_project",
      flowSource: "workspace",
      adminOwnerId: owner.user.userId,
    });
    const allowedSharedGraph = await request(admin.token, `/api/workspace/graph?${sharedReviewQuery}`);
    const sharedGraph = await allowedSharedGraph.json();
    assert.equal(allowedSharedGraph.status, 200, JSON.stringify(sharedGraph));
    assert.equal(sharedGraph.writable, false);
    assert.equal(sharedGraph.adminReview.readonly, true);
    assert.equal(sharedGraph.adminReview.ownerUserId, owner.user.userId);
    assert.equal(sharedGraph.graph.instances.shared_note.label, "Shared owner note");
    const sharedFileQuery = new URLSearchParams(sharedReviewQuery);
    sharedFileQuery.set("path", "shared-note.md");
    const allowedSharedFile = await request(admin.token, `/api/workspace/file?${sharedFileQuery}`);
    const sharedFile = await allowedSharedFile.json();
    assert.equal(allowedSharedFile.status, 200, JSON.stringify(sharedFile));
    assert.equal(sharedFile.content, "shared workspace content\n");

    const sharedWriteAttempt = await request(admin.token, "/api/workspace/graph", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        flowId: "shared_project",
        flowSource: "workspace",
        adminOwnerId: owner.user.userId,
        graph: { ...originalGraph, instances: {} },
      }),
    });
    assert.equal(sharedWriteAttempt.status >= 400, true);

    const fileQuery = new URLSearchParams(reviewQuery);
    fileQuery.set("path", "owner-note.md");
    const allowedFile = await request(admin.token, `/api/workspace/file?${fileQuery}`);
    const file = await allowedFile.json();
    assert.equal(allowedFile.status, 200, JSON.stringify(file));
    assert.equal(file.content, "owner workspace content\n");

    const writeAttempt = await request(admin.token, "/api/workspace/graph", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        flowId: "owner_project",
        flowSource: "user",
        adminOwnerId: owner.user.userId,
        graph: { ...originalGraph, instances: {} },
      }),
    });
    assert.equal(writeAttempt.status >= 400, true);

    const runAttempt = await request(admin.token, "/api/workspace/run/plan", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        flowId: "owner_project",
        flowSource: "user",
        adminOwnerId: owner.user.userId,
        graph: originalGraph,
        runNodeId: "note_1",
      }),
    });
    assert.equal(runAttempt.status, 403);

    // 启动迁移可能已经把历史 workspace.graph.json 转成 workspace.flow.js；通过权威读取
    // 接口验证只读访问没有改图，不再把权限测试绑定到旧存储文件名。
    const storedResponse = await request(admin.token, `/api/workspace/graph?${reviewQuery}`);
    const stored = await storedResponse.json();
    assert.equal(storedResponse.status, 200, JSON.stringify(stored));
    assert.equal(stored.graph.instances.note_1.label, "Owner note");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
