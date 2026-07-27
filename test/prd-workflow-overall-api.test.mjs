import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("PRD Overall is reduced from authenticated stage patches", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-prd-overall-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "project");
  fs.mkdirSync(workspaceRoot, { recursive: true });

  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = dataRoot;
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?prd-overall=${nonce}`),
      import(`../bin/lib/ui-server.mjs?prd-overall=${nonce}`),
    ]);
    const user = loginOrCreateUser("android-owner", "owner-password");
    server = await startUiServer({
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
    });
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const request = async (pathname, init = {}) => fetch(`${baseUrl}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${user.token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    });
    const postEvent = async (event) => {
      const response = await request("/api/prd-workflow/event", {
        method: "POST",
        body: JSON.stringify({ tapdId: "1015046", event }),
      });
      const payload = await response.json();
      assert.equal(response.status, 200, JSON.stringify(payload));
      return payload;
    };

    await postEvent({
      scope: "requirement",
      stage: "tech-design",
      status: "done",
      overallPatch: {
        requirement: {
          title: "双端接入 Firebase Remote Config",
          tapdUrl: "https://www.tapd.cn/33202860/prong/stories/view/1015046",
          status: { code: "status_4", label: "开发中" },
        },
      },
    });
    const planResult = await postEvent({
      scope: "issue",
      issueKey: "firebase-fetch-control-android",
      platform: "android",
      stage: "submit-plan:firebase-fetch-control-android",
      status: "done",
      overallOwnerFromActor: true,
      planVersion: "version2",
      actor: { userId: "spoofed", username: "spoofed" },
    });
    assert.equal(planResult.event.actor.userId, user.user.userId);
    assert.equal(planResult.event.actor.username, "android-owner");

    await postEvent({
      scope: "issue",
      issueKey: "firebase-fetch-control-android",
      issueTitle: "Android Remote Config 拉取和频控",
      platform: "android",
      stage: "implementation_mr",
      status: "done",
      changes: { impl_mr: "https://git.example/mr/943" },
      implementationMetadata: {
        status: "implemented",
        tags: ["firebase_remote_config"],
        experiments: [{ key: "firebase_fetch_control", groups: ["control", "experiment"] }],
        settings: [{ key: "fetch_interval_sec", defaultValue: 3600 }],
        filters: {
          countries: ["allowlist"],
          users: ["experiment-users"],
          versions: ["5.50+"],
        },
        rules: ["频控拒绝时不更新时间戳"],
      },
    });

    const response = await request("/api/prd-workflow/snapshot?tapdId=1015046&runtimeOnly=1");
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    const overall = payload.snapshot.overall;
    assert.equal(overall.requirement.title, "双端接入 Firebase Remote Config");
    assert.equal(overall.requirement.status.label, "开发中");
    assert.equal(overall.platforms.android.owner.username, "android-owner");
    assert.equal(overall.platforms.android.owner.planVersion, "version2");
    assert.deepEqual(overall.platforms.android.tags, ["firebase_remote_config"]);
    assert.deepEqual(overall.platforms.android.filters.countries, ["allowlist"]);
    assert.deepEqual(overall.platforms.android.filters.users, ["experiment-users"]);
    assert.deepEqual(overall.platforms.android.filters.versions, ["5.50+"]);
    assert.deepEqual(overall.platforms.android.rules, ["频控拒绝时不更新时间戳"]);
    assert.equal(
      overall.platforms.android.issues["firebase-fetch-control-android"].mr,
      "https://git.example/mr/943",
    );

    await postEvent({
      scope: "issue",
      issueKey: "firebase-fetch-control-android",
      issueTitle: "Android Remote Config 拉取和频控",
      platform: "android",
      stage: "implementation_mr",
      status: "done",
      changes: { impl_mr: "https://git.example/mr/943" },
      implementationMetadata: {
        tags: ["firebase_remote_config", "launch_frequency_control"],
      },
    });

    const refreshedResponse = await request("/api/prd-workflow/snapshot?tapdId=1015046&runtimeOnly=1");
    const refreshedPayload = await refreshedResponse.json();
    assert.equal(refreshedResponse.status, 200, JSON.stringify(refreshedPayload));
    const refreshedImplementation =
      refreshedPayload.snapshot.overall.platforms.android.issues["firebase-fetch-control-android"].implementation;
    assert.deepEqual(
      refreshedPayload.snapshot.overall.platforms.android.tags,
      ["firebase_remote_config", "launch_frequency_control"],
    );
    assert.deepEqual(
      refreshedImplementation.settings,
      [{ key: "fetch_interval_sec", defaultValue: 3600 }],
    );
    assert.deepEqual(refreshedImplementation.filters, {
      countries: ["allowlist"],
      users: ["experiment-users"],
      versions: ["5.50+"],
    });
    assert.deepEqual(refreshedImplementation.rules, ["频控拒绝时不更新时间戳"]);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome == null) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
