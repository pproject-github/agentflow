import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("runtime infrastructure settings are admin-only", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-settings-permissions-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "project");
  fs.mkdirSync(workspaceRoot, { recursive: true });

  const previousHome = process.env.AGENTFLOW_HOME;
  const previousCursorAgentCommand = process.env.CURSOR_AGENT_CMD;
  process.env.AGENTFLOW_HOME = dataRoot;
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { readUserEnvRows, writeGlobalEnvRows, writeUserEnvRows }, cursorPool, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?settings-permissions=${nonce}`),
      import(`../bin/lib/user-env.mjs?settings-permissions=${nonce}`),
      import("../bin/lib/cursor-api-key-pool.mjs"),
      import(`../bin/lib/ui-server.mjs?settings-permissions=${nonce}`),
    ]);
    const admin = loginOrCreateUser("settings-admin", "admin-password");
    const ordinary = loginOrCreateUser("settings-user", "user-password");
    writeUserEnvRows(ordinary.user.userId, [
      { key: "CURSOR_API_KEYS", value: "[{\"key\":\"legacy-secret\"}]" },
      { key: "SAFE_USER_SETTING", value: "kept" },
    ]);
    writeGlobalEnvRows([
      {
        key: "CURSOR_API_KEYS",
        value: JSON.stringify([{ id: "global-key", name: "Global Key", key: "global-secret", createdAt: "2026-08-25T00:00:00.000Z" }]),
      },
    ]);
    cursorPool.resetCursorApiKeyPoolForTests();
    cursorPool.markCursorApiKeyLaneBlocked({ id: "global-key" }, "auto", 30, "429 Too Many Requests");

    server = await startUiServer({
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
    });
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const request = (token, pathname, init = {}) => fetch(`${baseUrl}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    });

    const ordinaryContext = await request(ordinary.token, "/api/ui-context");
    const ordinaryContextBody = await ordinaryContext.json();
    assert.equal(ordinaryContext.status, 200);
    assert.equal(Object.hasOwn(ordinaryContextBody, "workspaceRoot"), false);

    const adminContext = await request(admin.token, "/api/ui-context");
    const adminContextBody = await adminContext.json();
    assert.equal(adminContext.status, 200);
    assert.equal(adminContextBody.workspaceRoot, workspaceRoot);

    const modelLists = await request(ordinary.token, "/api/model-lists");
    assert.equal(modelLists.status, 200);

    const configRead = await request(ordinary.token, "/api/agentflow-config");
    assert.equal(configRead.status, 403);
    const configWrite = await request(ordinary.token, "/api/agentflow-config", {
      method: "POST",
      body: JSON.stringify({ opencodeProvider: "forbidden" }),
    });
    assert.equal(configWrite.status, 403);
    const refresh = await request(ordinary.token, "/api/update-model-lists", {
      method: "POST",
      body: JSON.stringify({}),
    });
    assert.equal(refresh.status, 403);

    const ordinaryEnv = await request(ordinary.token, "/api/user-env");
    const ordinaryEnvBody = await ordinaryEnv.json();
    assert.equal(ordinaryEnv.status, 200);
    assert.deepEqual(ordinaryEnvBody.env, [{ key: "SAFE_USER_SETTING", value: "kept" }]);

    const forbiddenEnv = await request(ordinary.token, "/api/user-env", {
      method: "POST",
      body: JSON.stringify({ env: [{ key: "CURSOR_API_KEYS", value: "new-secret" }] }),
    });
    assert.equal(forbiddenEnv.status, 403);

    const safeEnv = await request(ordinary.token, "/api/user-env", {
      method: "POST",
      body: JSON.stringify({ env: [{ key: "SAFE_USER_SETTING", value: "updated" }] }),
    });
    const safeEnvBody = await safeEnv.json();
    assert.equal(safeEnv.status, 200, JSON.stringify(safeEnvBody));
    assert.deepEqual(safeEnvBody.env, [{ key: "SAFE_USER_SETTING", value: "updated" }]);
    assert.deepEqual(readUserEnvRows(ordinary.user.userId), [
      { key: "CURSOR_API_KEYS", value: "[{\"key\":\"legacy-secret\"}]" },
      { key: "SAFE_USER_SETTING", value: "updated" },
    ]);

    const adminConfig = await request(admin.token, "/api/agentflow-config");
    assert.equal(adminConfig.status, 200);
    const adminEnv = await request(admin.token, "/api/user-env");
    assert.equal(adminEnv.status, 200);

    const forbiddenCursorStatus = await request(ordinary.token, "/api/admin/cursor-api-keys/status?scope=global");
    assert.equal(forbiddenCursorStatus.status, 403);

    const cursorStatus = await request(admin.token, "/api/admin/cursor-api-keys/status?scope=global");
    const cursorStatusBody = await cursorStatus.json();
    assert.equal(cursorStatus.status, 200);
    assert.equal(cursorStatusBody.keys[0].status, "cooling_down");
    assert.equal(cursorStatusBody.keys[0].maskedKey.endsWith("cret"), true);
    assert.equal(JSON.stringify(cursorStatusBody).includes("global-secret"), false);

    const released = await request(admin.token, "/api/admin/cursor-api-keys/cooldown", {
      method: "PATCH",
      body: JSON.stringify({ id: "global-key", scope: "global" }),
    });
    const releasedBody = await released.json();
    assert.equal(released.status, 200);
    assert.equal(releasedBody.keys[0].status, "available");

    const mockCursorAgent = path.join(tempRoot, "mock-cursor-agent.mjs");
    fs.writeFileSync(mockCursorAgent, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (!args.includes("--mode") || args[args.indexOf("--mode") + 1] !== "ask" || args.includes("--force") || args.includes("--sandbox") || args.includes("--approve-mcps")) {
  console.error("probe must use ask mode without force, sandbox override, or MCP approval");
  process.exit(2);
}
console.log(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "你好" }));
`, "utf8");
    fs.chmodSync(mockCursorAgent, 0o755);
    process.env.CURSOR_AGENT_CMD = mockCursorAgent;
    const tested = await request(admin.token, "/api/admin/cursor-api-keys/test", {
      method: "POST",
      body: JSON.stringify({ id: "global-key", scope: "global" }),
    });
    const testedBody = await tested.json();
    assert.equal(tested.status, 200, JSON.stringify(testedBody));
    assert.equal(testedBody.result.success, true);
    assert.equal(testedBody.result.replyPreview, "你好");
    assert.equal(typeof testedBody.keys[0].lastUsedAt, "string");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    if (previousCursorAgentCommand === undefined) delete process.env.CURSOR_AGENT_CMD;
    else process.env.CURSOR_AGENT_CMD = previousCursorAgentCommand;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
