import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("CAS user verifies and self-migrates a legacy password account", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-cas-link-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  let appServer;
  try {
    process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
    const auth = await import(`../bin/lib/auth.mjs?cas-link=${Date.now()}`);
    const paths = await import(`../bin/lib/paths.mjs?cas-link=${Date.now()}`);
    const { startUiServer } = await import(`../bin/lib/ui-server.mjs?cas-link=${Date.now()}`);

    const admin = auth.loginAdminUser("root-admin", "admin-password");
    assert.equal(admin.ok, true);
    const legacy = auth.loginOrCreateUser("legacy-owner", "legacy-password");
    assert.equal(legacy.ok, true);
    const cas = auth.loginCasUser({ username: "cas-owner", attributes: { displayName: "CAS Owner" } });
    assert.equal(cas.ok, true);
    const rateLimitedCas = auth.loginCasUser({ username: "rate-owner", attributes: { displayName: "Rate Owner" } });
    assert.equal(rateLimitedCas.ok, true);

    const sourceRoot = paths.getUserPipelinesRoot("legacy-owner");
    const activeDir = path.join(sourceRoot, "daily-flow");
    const archivedDir = path.join(sourceRoot, paths.ARCHIVED_PIPELINES_DIR_NAME, "old-flow");
    for (const dir of [activeDir, archivedDir]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, "workspace.flow.js"), 'import { display, flow } from "agentflow/flow";\nconst result = display.markdown("Result", { content: "ok" });\nexport const main = flow("Legacy", result);\n', "utf8");
    }
    const targetConflictDir = path.join(paths.getUserPipelinesRoot("cas-owner"), "daily-flow");
    fs.mkdirSync(targetConflictDir, { recursive: true });
    fs.writeFileSync(path.join(targetConflictDir, "workspace.flow.js"), 'import { display, flow } from "agentflow/flow";\nconst result = display.markdown("Existing", { content: "keep" });\nexport const main = flow("Existing", result);\n', "utf8");

    appServer = await startUiServer({
      workspaceRoot: path.join(tempRoot, "workspace"),
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
    });
    const baseUrl = `http://127.0.0.1:${appServer.address().port}`;
    const casCookie = { Cookie: `af_session=${encodeURIComponent(cas.token)}` };
    const rateLimitedCookie = { Cookie: `af_session=${encodeURIComponent(rateLimitedCas.token)}` };

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const response = await fetch(`${baseUrl}/api/auth/legacy-account-link`, {
        method: "POST",
        headers: { ...rateLimitedCookie, "Content-Type": "application/json" },
        body: JSON.stringify({ username: "unknown-user", password: "wrong-password" }),
      });
      assert.equal(response.status, attempt < 5 ? 401 : 429);
    }

    const invalidResponse = await fetch(`${baseUrl}/api/auth/legacy-account-link`, {
      method: "POST",
      headers: { ...casCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ username: "legacy-owner", password: "wrong-password" }),
    });
    assert.equal(invalidResponse.status, 401);
    assert.equal(fs.existsSync(activeDir), true);

    const conflictResponse = await fetch(`${baseUrl}/api/auth/legacy-account-link`, {
      method: "POST",
      headers: { ...casCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ username: "legacy-owner", password: "legacy-password" }),
    });
    assert.equal(conflictResponse.status, 409);
    assert.equal(fs.existsSync(activeDir), true);
    assert.equal(fs.existsSync(archivedDir), true);
    fs.rmSync(targetConflictDir, { recursive: true, force: true });

    const linkResponse = await fetch(`${baseUrl}/api/auth/legacy-account-link`, {
      method: "POST",
      headers: { ...casCookie, "Content-Type": "application/json" },
      body: JSON.stringify({ username: "legacy-owner", password: "legacy-password" }),
    });
    const linked = await linkResponse.json();
    assert.equal(linkResponse.status, 200, JSON.stringify(linked));
    assert.equal(linked.transferredProjects, 2);
    assert.equal(fs.existsSync(activeDir), false);
    assert.equal(fs.existsSync(archivedDir), false);
    assert.equal(fs.existsSync(path.join(paths.getUserPipelinesRoot("cas-owner"), "daily-flow")), true);
    assert.equal(fs.existsSync(path.join(paths.getUserPipelinesRoot("cas-owner"), paths.ARCHIVED_PIPELINES_DIR_NAME, "old-flow")), true);

    const statusResponse = await fetch(`${baseUrl}/api/auth/legacy-account-link`, { headers: casCookie });
    const status = await statusResponse.json();
    assert.deepEqual(status.legacyUserIds, ["legacy-owner"]);

    const legacyMeResponse = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: `af_session=${encodeURIComponent(legacy.token)}` },
    });
    assert.equal((await legacyMeResponse.json()).authenticated, false);
    const oldPasswordLogin = auth.loginOrCreateUser("legacy-owner", "legacy-password");
    assert.equal(oldPasswordLogin.ok, false);
    assert.equal(oldPasswordLogin.status, 409);

    const users = auth.readAuthUsers();
    assert.equal(users["legacy-owner"].linkedToUserId, "cas-owner");
    assert.equal("hash" in users["legacy-owner"], false);
    assert.equal("salt" in users["legacy-owner"], false);
    const accountAudit = fs.readFileSync(path.join(process.env.AGENTFLOW_HOME, "auth", "legacy-account-links.jsonl"), "utf8");
    assert.match(accountAudit, /"action":"legacy_account_linked"/);
    assert.match(accountAudit, /"sourceUserId":"legacy-owner"/);
  } finally {
    if (appServer) await new Promise((resolve) => appServer.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
