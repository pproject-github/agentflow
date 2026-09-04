import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("release write APIs require operators membership while reads stay open", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-release-acl-")));
  const skillsRoot = path.join(tempRoot, "release-skills");
  const skillDir = path.join(skillsRoot, "release-git", "scripts");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillsRoot, "release-git", "SKILL.md"), `---\nname: release-git\ndescription: Demo\nactions:\n  - name: create-release-branch\n    platforms: [android]\n---\n`);
  fs.writeFileSync(path.join(skillDir, "run.py"), "print('ok')\n");

  const previous = {
    skills: process.env.AGENTFLOW_RELEASE_SKILLS_ROOT,
    projects: process.env.AGENTFLOW_RELEASE_PROJECTS_JSON,
    nodeEnv: process.env.NODE_ENV,
  };
  process.env.AGENTFLOW_RELEASE_SKILLS_ROOT = skillsRoot;
  process.env.NODE_ENV = "production";
  process.env.AGENTFLOW_RELEASE_PROJECTS_JSON = JSON.stringify({
    projects: [{
      id: "likee-android-prod",
      businessLine: "likee",
      platform: "android",
      workspaceRoot: tempRoot,
      skillRoots: [skillsRoot],
    }],
    operators: {
      likee: {
        android: ["release-writer"],
        ios: ["ios-writer"],
      },
    },
  });

  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?release-acl=${nonce}`),
      import(`../bin/lib/ui-server.mjs?release-acl=${nonce}`),
    ]);
    const writer = loginOrCreateUser("release-writer", "release-password");
    const guest = loginOrCreateUser("release-guest", "release-password");
    server = await startUiServer({
      workspaceRoot: path.join(tempRoot, "workspace"),
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
      enableWorkspaceScheduler: false,
    });
    const base = `http://127.0.0.1:${server.address().port}`;
    const request = async (token, method, pathname, body) => {
      const response = await fetch(base + pathname, {
        method,
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      let payload = null;
      try { payload = JSON.parse(text); } catch {}
      return { status: response.status, body: payload, text };
    };

    const guestState = await request(guest.token, "GET", "/api/release/state?businessLine=likee&platform=android&batch=initial&version=5.63.2&workspaceId=likee-android-prod");
    assert.equal(guestState.status, 200, guestState.text);
    assert.equal(guestState.body.releaseAccess?.canWrite, false);
    assert.equal(guestState.body.releaseAccess?.membership, null);

    const guestRun = await request(guest.token, "POST", "/api/release/nodes/run", {
      workspaceId: "likee-android-prod",
      businessLine: "likee",
      platform: "android",
      version: "5.63.2",
      batch: "initial",
      actionId: "composite:create-release-branch",
      itemId: "guest-item",
      inputs: {},
    });
    assert.equal(guestRun.status, 403, guestRun.text);
    assert.equal(guestRun.body.code, "RELEASE_OPERATOR_FORBIDDEN");

    const writerState = await request(writer.token, "GET", "/api/release/state?businessLine=likee&platform=android&batch=initial&version=5.63.2&workspaceId=likee-android-prod");
    assert.equal(writerState.status, 200, writerState.text);
    assert.equal(writerState.body.releaseAccess?.canWrite, true);
    assert.deepEqual(writerState.body.releaseAccess?.membership, { businessLine: "likee", platform: "android" });

    const crossPlatform = await request(writer.token, "POST", "/api/release/nodes/run", {
      workspaceId: "likee-android-prod",
      businessLine: "likee",
      platform: "ios",
      version: "5.63.2",
      batch: "initial",
      actionId: "composite:create-release-branch",
      itemId: "cross-item",
      inputs: {},
    });
    assert.equal(crossPlatform.status, 403, crossPlatform.text);
    assert.equal(crossPlatform.body.code, "RELEASE_OPERATOR_FORBIDDEN");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previous.skills === undefined) delete process.env.AGENTFLOW_RELEASE_SKILLS_ROOT;
    else process.env.AGENTFLOW_RELEASE_SKILLS_ROOT = previous.skills;
    if (previous.projects === undefined) delete process.env.AGENTFLOW_RELEASE_PROJECTS_JSON;
    else process.env.AGENTFLOW_RELEASE_PROJECTS_JSON = previous.projects;
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous.nodeEnv;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
