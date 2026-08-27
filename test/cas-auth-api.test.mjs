import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function cookieValue(response, name) {
  const header = String(response.headers.get("set-cookie") || "");
  const match = header.match(new RegExp(`(?:^|[,;]\\s*)${name}=([^;,]*)`));
  return match ? decodeURIComponent(match[1]) : "";
}

test("CAS users bypass the local allowlist while admin keeps a separate password login path", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-cas-auth-")));
  const previous = Object.fromEntries([
    "AGENTFLOW_HOME",
    "AGENTFLOW_CAS_ENABLED",
    "AGENTFLOW_CAS_BASE_URL",
    "AGENTFLOW_CAS_SERVICE_URL",
    "AGENTFLOW_LEGACY_PASSWORD_LOGIN",
    "AGENTFLOW_USER_WHITELIST",
  ].map((key) => [key, process.env[key]]));
  let casServer;
  let appServer;
  try {
    let validatedService = "";
    casServer = http.createServer((req, res) => {
      const url = new URL(req.url || "/", "http://127.0.0.1");
      if (url.pathname === "/cas/p3/serviceValidate") {
        validatedService = url.searchParams.get("service") || "";
        assert.equal(url.searchParams.get("ticket"), "ST-valid-ticket");
        res.writeHead(200, { "Content-Type": "application/xml" });
        res.end(`<?xml version="1.0"?><cas:serviceResponse xmlns:cas="http://www.yale.edu/tp/cas"><cas:authenticationSuccess><cas:user>cas-user</cas:user><cas:attributes><cas:displayName>CAS User</cas:displayName></cas:attributes></cas:authenticationSuccess></cas:serviceResponse>`);
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise((resolve) => casServer.listen(0, "127.0.0.1", resolve));
    process.env.AGENTFLOW_HOME = path.join(tempRoot, "data");
    process.env.AGENTFLOW_CAS_ENABLED = "true";
    process.env.AGENTFLOW_CAS_BASE_URL = `http://127.0.0.1:${casServer.address().port}/cas/`;
    delete process.env.AGENTFLOW_CAS_SERVICE_URL;
    process.env.AGENTFLOW_LEGACY_PASSWORD_LOGIN = "false";
    process.env.AGENTFLOW_USER_WHITELIST = "some-other-local-user";

    const { startUiServer } = await import(`../bin/lib/ui-server.mjs?cas-auth-api=${Date.now()}`);
    appServer = await startUiServer({
      workspaceRoot: path.join(tempRoot, "workspace"),
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
    });
    const baseUrl = `http://127.0.0.1:${appServer.address().port}`;

    const meResponse = await fetch(`${baseUrl}/api/auth/me`);
    const me = await meResponse.json();
    assert.equal(me.casEnabled, true);
    assert.equal(me.legacyPasswordLoginEnabled, false);
    assert.equal(me.adminLoginPath, "/admin/login");
    assert.equal(me.setupRequired, true);

    const adminResponse = await fetch(`${baseUrl}/api/admin/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "root-admin", password: "admin-password" }),
    });
    const admin = await adminResponse.json();
    assert.equal(adminResponse.status, 200, JSON.stringify(admin));
    assert.equal(admin.user.isAdmin, true);
    assert.equal(admin.user.authProvider, "password");

    const legacyResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "legacy-user", password: "legacy-password" }),
    });
    assert.equal(legacyResponse.status, 410);

    const loginResponse = await fetch(`${baseUrl}/api/auth/cas/login?returnTo=${encodeURIComponent("/projects?view=mine")}`, { redirect: "manual" });
    assert.equal(loginResponse.status, 302);
    const flowCookie = cookieValue(loginResponse, "af_cas_flow");
    assert.ok(flowCookie);
    const loginUrl = new URL(loginResponse.headers.get("location"));
    assert.equal(loginUrl.pathname, "/cas/login");
    assert.equal(loginUrl.searchParams.get("service"), `${baseUrl}/api/auth/cas/callback`);

    const callbackResponse = await fetch(`${baseUrl}/api/auth/cas/callback?ticket=ST-valid-ticket`, {
      headers: { Cookie: `af_cas_flow=${encodeURIComponent(flowCookie)}` },
      redirect: "manual",
    });
    assert.equal(callbackResponse.status, 303);
    assert.equal(callbackResponse.headers.get("location"), "/projects?view=mine");
    assert.equal(validatedService, `${baseUrl}/api/auth/cas/callback`);
    const session = cookieValue(callbackResponse, "af_session");
    assert.ok(session);

    const reusedCallback = await fetch(`${baseUrl}/api/auth/cas/callback?ticket=ST-valid-ticket`, {
      headers: { Cookie: `af_cas_flow=${encodeURIComponent(flowCookie)}` },
      redirect: "manual",
    });
    assert.equal(reusedCallback.status, 303);
    assert.equal(reusedCallback.headers.get("location"), "/projects?authError=cas_flow_expired");

    const casMeResponse = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: `af_session=${encodeURIComponent(session)}` } });
    const casMe = await casMeResponse.json();
    assert.equal(casMe.authenticated, true);
    assert.equal(casMe.user.userId, "cas-user");
    assert.equal(casMe.user.username, "CAS User");
    assert.equal(casMe.user.isAdmin, false);
    assert.equal(casMe.user.authProvider, "cas");

    const adminSession = cookieValue(adminResponse, "af_session");
    const usersResponse = await fetch(`${baseUrl}/api/admin/users`, { headers: { Cookie: `af_session=${encodeURIComponent(adminSession)}` } });
    const users = await usersResponse.json();
    assert.equal(users.users.find((user) => user.userId === "cas-user")?.authProvider, "cas");
  } finally {
    if (appServer) await new Promise((resolve) => appServer.close(resolve));
    if (casServer) await new Promise((resolve) => casServer.close(resolve));
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
