import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("release list is shared and TAPD sync imports version iterations", async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-release-list-")));
  const previousHome = process.env.AGENTFLOW_HOME;
  const previousSeed = process.env.AGENTFLOW_RELEASE_SEED_PROJECTS;
  const previousTapdToken = process.env.TAPD_TEST_ACCESS_TOKEN;
  process.env.AGENTFLOW_HOME = root;
  process.env.AGENTFLOW_RELEASE_SEED_PROJECTS = "0";
  const workspaceRoot = path.join(root, "workspace");
  const tapdServer = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ status: 1, data: [{ Iteration: { id: "it-564", name: "Likee Android&iOS V5.64", startdate: "2026-08-12", enddate: "2026-09-02" } }] }));
  });
  await new Promise((resolve) => tapdServer.listen(0, "127.0.0.1", resolve));
  const tapdApiBaseUrl = `http://127.0.0.1:${tapdServer.address().port}`;
  process.env.TAPD_TEST_ACCESS_TOKEN = "tapd-test-token";
  fs.writeFileSync(path.join(root, "release-projects.json"), JSON.stringify({
    projects: [{ id: "likee-android", businessLine: "likee", platform: "android", workspaceRoot, tapd: { workspaceId: "33202860", apiBaseUrl: tapdApiBaseUrl, accessTokenEnv: "TAPD_TEST_ACCESS_TOKEN" } }],
    operators: { likee: { android: [], ios: [] } },
  }));
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?release-list=${nonce}`),
      import(`../bin/lib/ui-server.mjs?release-list=${nonce}`),
    ]);
    const admin = loginOrCreateUser("release-list-admin", "password");
    const viewer = loginOrCreateUser("release-list-viewer", "password");
    server = await startUiServer({ workspaceRoot, host: "127.0.0.1", port: 0, staticDir: path.join(root, "static"), enableWorkspaceScheduler: false });
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (token, method, pathname, body) => {
      const response = await fetch(base + pathname, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json() };
    };
    const created = await request(admin.token, "POST", "/api/releases", { project: "Likee", platform: "Android", version: "5.63", releaseDate: "2026-08-11" });
    assert.equal(created.status, 201);
    const viewerList = await request(viewer.token, "GET", "/api/releases?project=Likee&platform=Android");
    assert.equal(viewerList.status, 200);
    assert.equal(viewerList.body.releases.some((item) => item.version === "5.63"), true);
    const syncedList = await request(viewer.token, "GET", "/api/releases?project=Likee&platform=Android&syncTapd=1");
    assert.equal(syncedList.status, 200, JSON.stringify(syncedList.body));
    assert.equal(syncedList.body.releases.some((item) => item.version === "5.64"), true);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME; else process.env.AGENTFLOW_HOME = previousHome;
    if (previousSeed === undefined) delete process.env.AGENTFLOW_RELEASE_SEED_PROJECTS; else process.env.AGENTFLOW_RELEASE_SEED_PROJECTS = previousSeed;
    if (previousTapdToken === undefined) delete process.env.TAPD_TEST_ACCESS_TOKEN; else process.env.TAPD_TEST_ACCESS_TOKEN = previousTapdToken;
    await new Promise((resolve) => tapdServer.close(resolve));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
