import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

test("CLI browser authorization issues a separate saved credential and revokes it", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-cli-auth-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?cli-auth=${nonce}`),
      import(`../bin/lib/ui-server.mjs?cli-auth=${nonce}`),
    ]);
    loginOrCreateUser("browser-cli-user", "browser-cli-password");
    server = await startUiServer({
      workspaceRoot: path.join(tempRoot, "workspace"),
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
      enableWorkspaceScheduler: false,
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const authFile = path.join(tempRoot, "client-home", ".agentflow", "auth.json");
    const cliPath = path.resolve("skills/agentflow-cli/scripts/agentflow-cli.mjs");
    const cliEnv = { ...process.env, HOME: path.join(tempRoot, "client-home"), AGENTFLOW_AUTH_FILE: authFile };
    delete cliEnv.AGENTFLOW_TOKEN;
    delete cliEnv.AGENTFLOW_SESSION_TOKEN;
    delete cliEnv.AGENTFLOW_ENV_FILE;
    const cli = async (...extra) => {
      const { stdout } = await execFileAsync(process.execPath, [cliPath, ...extra, "--base-url", baseUrl], {
        cwd: tempRoot,
        env: cliEnv,
      });
      return JSON.parse(stdout);
    };

    const started = await cli("auth", "start");
    assert.equal(started.status, "authorization_required");
    assert.match(started.verificationUrl, new RegExp(`^${baseUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/cli/authorize\\?request=`));
    assert.equal(Object.hasOwn(started, "deviceCode"), false);
    const pendingStore = JSON.parse(fs.readFileSync(authFile, "utf-8"));
    const pending = pendingStore.pending[baseUrl];
    assert.ok(pending.deviceCode);
    assert.equal(fs.statSync(authFile).mode & 0o777, 0o600);

    const pendingExchange = await fetch(`${baseUrl}/api/auth/cli/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceCode: pending.deviceCode }),
    });
    assert.equal(pendingExchange.status, 202);
    assert.equal((await pendingExchange.json()).code, "authorization_pending");

    const loginPageResponse = await fetch(started.verificationUrl);
    const loginPage = await loginPageResponse.text();
    assert.equal(loginPageResponse.status, 200);
    assert.match(loginPage, /登录后授权 AgentFlow CLI/);
    assert.doesNotMatch(loginPage, new RegExp(pending.deviceCode));

    const loginResponse = await fetch(`${baseUrl}/cli/authorize/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        request: started.requestId,
        username: "browser-cli-user",
        password: "browser-cli-password",
      }),
    });
    assert.equal(loginResponse.status, 303);
    const cookie = String(loginResponse.headers.get("set-cookie") || "").split(";")[0];
    assert.match(cookie, /^af_session=/);

    const approvalPageResponse = await fetch(new URL(loginResponse.headers.get("location"), baseUrl), {
      headers: { Cookie: cookie },
    });
    const approvalPage = await approvalPageResponse.text();
    assert.match(approvalPage, /允许 AgentFlow CLI 访问/);
    assert.match(approvalPage, /browser-cli-user/);
    const approvalNonce = approvalPage.match(/name="approvalNonce" value="([^"]+)"/)?.[1] || "";
    assert.ok(approvalNonce);

    const invalidDecision = await fetch(`${baseUrl}/cli/authorize/decision`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ request: started.requestId, approvalNonce: "invalid", decision: "approve" }),
    });
    assert.equal(invalidDecision.status, 403);

    const decisionResponse = await fetch(`${baseUrl}/cli/authorize/decision`, {
      method: "POST",
      headers: { Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        request: started.requestId,
        approvalNonce,
        decision: "approve",
      }),
    });
    assert.equal(decisionResponse.status, 200);
    assert.match(await decisionResponse.text(), /授权完成/);

    const completed = await cli("auth", "complete");
    assert.equal(completed.status, "authenticated");
    assert.equal(completed.user.username, "browser-cli-user");
    assert.equal(Object.hasOwn(completed, "token"), false);
    const authenticatedStore = JSON.parse(fs.readFileSync(authFile, "utf-8"));
    const cliToken = authenticatedStore.profiles[baseUrl].token;
    assert.ok(cliToken);
    assert.equal(authenticatedStore.pending[baseUrl], undefined);

    const configured = await cli("config");
    assert.equal(configured.hasToken, true);
    assert.equal(configured.tokenSource, "saved-auth");
    const status = await cli("auth", "status");
    assert.equal(status.authenticated, true);
    assert.equal(status.user.username, "browser-cli-user");
    const workspaces = await cli("list-workspaces");
    assert.ok(Array.isArray(workspaces.workspaces));

    const reused = await fetch(`${baseUrl}/api/auth/cli/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deviceCode: pending.deviceCode }),
    });
    assert.equal(reused.status, 410);

    const loggedOut = await cli("auth", "logout");
    assert.equal(loggedOut.authenticated, false);
    assert.equal(loggedOut.revoked, true);
    const afterLogout = await cli("config");
    assert.equal(afterLogout.hasToken, false);
    const revokedMe = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Authorization: `Bearer ${cliToken}` },
    });
    assert.equal((await revokedMe.json()).authenticated, false);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
