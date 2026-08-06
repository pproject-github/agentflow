import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("admin may assign a new password while preserving user data and revoking old sessions", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-password-reset-")));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });

  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = dataRoot;
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?admin-password-reset=${nonce}`),
      import(`../bin/lib/ui-server.mjs?admin-password-reset=${nonce}`),
    ]);
    const admin = loginOrCreateUser("password-admin", "admin-password");
    const ordinary = loginOrCreateUser("forgotten-user", "old-password");
    const sentinelPath = path.join(dataRoot, "users", ordinary.user.userId, "pipelines", "keep-me", "flow.yaml");
    fs.mkdirSync(path.dirname(sentinelPath), { recursive: true });
    fs.writeFileSync(sentinelPath, "instances: {}\nedges: []\n", "utf8");

    server = await startUiServer({
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const request = (token, pathname, init = {}) => fetch(`${baseUrl}${pathname}`, {
      ...init,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    });

    const deniedList = await request(ordinary.token, "/api/admin/users");
    assert.equal(deniedList.status, 403);

    const listResponse = await request(admin.token, "/api/admin/users");
    const listPayload = await listResponse.json();
    assert.equal(listResponse.status, 200);
    const listedUser = listPayload.users.find((user) => user.userId === ordinary.user.userId);
    assert.equal(listedUser.username, "forgotten-user");
    assert.equal(Object.hasOwn(listedUser, "hash"), false);
    assert.equal(Object.hasOwn(listedUser, "salt"), false);

    const selfReset = await request(admin.token, "/api/admin/users/reset-password", {
      method: "POST",
      body: JSON.stringify({ userId: admin.user.userId, password: "replacement" }),
    });
    assert.equal(selfReset.status, 400);

    const resetResponse = await request(admin.token, "/api/admin/users/reset-password", {
      method: "POST",
      body: JSON.stringify({ userId: ordinary.user.userId, password: "new-password" }),
    });
    const resetPayload = await resetResponse.json();
    assert.equal(resetResponse.status, 200, JSON.stringify(resetPayload));
    assert.equal(resetPayload.ok, true);
    assert.equal(resetPayload.user.userId, ordinary.user.userId);
    assert.equal(resetPayload.revokedSessions, 1);
    assert.equal(fs.existsSync(sentinelPath), true);

    const oldSession = await request(ordinary.token, "/api/auth/me");
    const oldSessionPayload = await oldSession.json();
    assert.equal(oldSessionPayload.authenticated, false);

    const oldPassword = await request("", "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "forgotten-user", password: "old-password" }),
    });
    assert.equal(oldPassword.status, 401);

    const newPassword = await request("", "/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username: "forgotten-user", password: "new-password" }),
    });
    const newPasswordPayload = await newPassword.json();
    assert.equal(newPassword.status, 200, JSON.stringify(newPasswordPayload));
    assert.equal(newPasswordPayload.user.userId, ordinary.user.userId);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
