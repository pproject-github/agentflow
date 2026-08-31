import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("release runtime API exposes filtered catalog and initialization state", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-release-api-")));
  const skillsRoot = path.join(tempRoot, "release-skills");
  const skillDir = path.join(skillsRoot, "release-git", "scripts");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillsRoot, "release-git", "SKILL.md"), `---\nname: release-git\ndescription: Demo release action\nactions:\n  - name: create-release-branch\n    inputs: [version]\n    platforms: [android]\n    requires_confirmation: false\n---\n`);
  fs.writeFileSync(path.join(skillDir, "run.py"), "print('ok')\n");
  const previousRoot = process.env.AGENTFLOW_RELEASE_SKILLS_ROOT;
  process.env.AGENTFLOW_RELEASE_SKILLS_ROOT = skillsRoot;
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?release-api=${nonce}`),
      import(`../bin/lib/ui-server.mjs?release-api=${nonce}`),
    ]);
    const user = loginOrCreateUser("release-api-owner", "release-password");
    server = await startUiServer({ workspaceRoot: path.join(tempRoot, "workspace"), host: "127.0.0.1", port: 0, staticDir: path.join(tempRoot, "static"), enableWorkspaceScheduler: false });
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" };
    const request = async (method, pathname, body) => {
      const response = await fetch(base + pathname, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      const text = await response.text();
      let payload = null;
      try { payload = JSON.parse(text); } catch {}
      return { status: response.status, body: payload, text };
    };
    const catalog = await request("GET", "/api/release/catalog?businessLine=likee&platform=android&batch=initial&workspaceId=release-api");
    assert.equal(catalog.status, 200, catalog.text);
    assert.equal(catalog.body.nodes[0].id, "release-git:create-release-branch");
    const state = await request("GET", "/api/release/state?businessLine=likee&platform=android&batch=initial&version=5.63.2&workspaceId=release-api");
    assert.equal(state.status, 200, state.text);
    assert.equal(state.body.state.timeline[0].nodeId, "release-initialization");
    assert.equal(state.body.state.timeline[0].status, "completed");
    assert.equal(state.body.state.pending.length, 0);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousRoot === undefined) delete process.env.AGENTFLOW_RELEASE_SKILLS_ROOT;
    else process.env.AGENTFLOW_RELEASE_SKILLS_ROOT = previousRoot;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("release runtime executes a read-only Action through the AgentFlow graph", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-release-run-")));
  const skillsRoot = path.join(tempRoot, "release-skills");
  const skillDir = path.join(skillsRoot, "release-git", "scripts");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillsRoot, "release-git", "SKILL.md"), `---\nname: release-git\ndescription: Demo release action\nactions:\n  - name: create-release-branch\n    inputs: [version]\n    platforms: [android]\n    requires_confirmation: false\n---\n`);
  fs.writeFileSync(path.join(skillDir, "run.py"), "import argparse\np=argparse.ArgumentParser(); p.add_argument('--action'); p.add_argument('--input', action='append', default=[]); a=p.parse_args(); print(a.action + ':' + ','.join(a.input))\n");
  const previousRoot = process.env.AGENTFLOW_RELEASE_SKILLS_ROOT;
  process.env.AGENTFLOW_RELEASE_SKILLS_ROOT = skillsRoot;
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?release-run=${nonce}`),
      import(`../bin/lib/ui-server.mjs?release-run=${nonce}`),
    ]);
    const user = loginOrCreateUser("release-run-owner", "release-password");
    server = await startUiServer({ workspaceRoot: path.join(tempRoot, "workspace"), host: "127.0.0.1", port: 0, staticDir: path.join(tempRoot, "static"), enableWorkspaceScheduler: false });
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" };
    const response = await fetch(base + "/api/release/nodes/run", { method: "POST", headers, body: JSON.stringify({ workspaceId: "release-run", businessLine: "likee", platform: "android", version: "5.63.2", actionId: "release-git:create-release-branch", inputs: { version: "5.63.2" } }) });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.status, "completed");
    assert.ok(payload.state.timeline.some((item) => item.nodeId === "release-git:create-release-branch"));
    const completedAction = payload.state.timeline.find((item) => item.nodeId === "release-git:create-release-branch");
    assert.equal(completedAction.processId, "preparation-initial");
    assert.ok(completedAction.durationMs > 0);
    assert.ok(completedAction.completedAt >= completedAction.startedAt);
    const scriptFinish = payload.result.events.find((event) => event.type === "script-finish");
    assert.match(scriptFinish.stdout, /product=likee/);
    assert.match(scriptFinish.stdout, /platform=android/);
    const scopeMismatch = await fetch(base + "/api/release/nodes/run", {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId: "release-run",
        businessLine: "likee",
        platform: "android",
        version: "5.63.2",
        actionId: "release-git:create-release-branch",
        scopeKey: "likee/ios/5.63.2/initial",
      }),
    });
    const scopeMismatchPayload = await scopeMismatch.json();
    assert.equal(scopeMismatch.status, 409, JSON.stringify(scopeMismatchPayload));
    assert.equal(scopeMismatchPayload.code, "RELEASE_SCOPE_MISMATCH");
    const processMismatch = await fetch(base + "/api/release/nodes/run", {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId: "release-run",
        businessLine: "likee",
        platform: "android",
        version: "5.63.2",
        actionId: "release-git:create-release-branch",
        processId: "approval",
      }),
    });
    const processMismatchPayload = await processMismatch.json();
    assert.equal(processMismatch.status, 409, JSON.stringify(processMismatchPayload));
    assert.equal(processMismatchPayload.code, "RELEASE_PROCESS_MISMATCH");
    const logsResponse = await fetch(base + `/api/release/runs/${encodeURIComponent(payload.runId)}/logs?workspaceId=release-run&businessLine=likee&platform=android&version=5.63.2&batch=initial`, { headers });
    const logsPayload = await logsResponse.json();
    assert.equal(logsResponse.status, 200, JSON.stringify(logsPayload));
    assert.equal(logsPayload.run.runId, payload.runId);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousRoot === undefined) delete process.env.AGENTFLOW_RELEASE_SKILLS_ROOT;
    else process.env.AGENTFLOW_RELEASE_SKILLS_ROOT = previousRoot;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("release runtime treats a zero-exit preflight_failed result as a failed pending node", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-release-preflight-")));
  const skillsRoot = path.join(tempRoot, "release-skills");
  const skillDir = path.join(skillsRoot, "release-metrics", "scripts");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillsRoot, "release-metrics", "SKILL.md"), `---\nname: release-metrics\ndescription: Demo release action\nactions:\n  - name: query-version-metrics\n    inputs: []\n    platforms: [android]\n    requires_confirmation: false\n---\n`);
  fs.writeFileSync(path.join(skillDir, "run.py"), "print('status: preflight_failed\\nerror: platform_selection_required')\n");
  const previousRoot = process.env.AGENTFLOW_RELEASE_SKILLS_ROOT;
  process.env.AGENTFLOW_RELEASE_SKILLS_ROOT = skillsRoot;
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?release-preflight=${nonce}`),
      import(`../bin/lib/ui-server.mjs?release-preflight=${nonce}`),
    ]);
    const user = loginOrCreateUser("release-preflight-owner", "release-password");
    server = await startUiServer({ workspaceRoot: path.join(tempRoot, "workspace"), host: "127.0.0.1", port: 0, staticDir: path.join(tempRoot, "static"), enableWorkspaceScheduler: false });
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" };
    const response = await fetch(base + "/api/release/nodes/run", {
      method: "POST",
      headers,
      body: JSON.stringify({ workspaceId: "release-preflight", businessLine: "likee", platform: "android", version: "5.63.2", actionId: "release-metrics:query-version-metrics" }),
    });
    const payload = await response.json();
    assert.equal(response.status, 422, JSON.stringify(payload));
    assert.equal(payload.code, "RELEASE_PREFLIGHT_FAILED");
    assert.equal(payload.state.timeline.some((item) => item.nodeId === "release-metrics:query-version-metrics"), false);
    const failed = payload.state.pending.find((item) => item.nodeId === "release-metrics:query-version-metrics");
    assert.equal(failed.status, "failed");
    assert.match(failed.error, /platform_selection_required/);
    assert.ok(failed.durationMs >= 0);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousRoot === undefined) delete process.env.AGENTFLOW_RELEASE_SKILLS_ROOT;
    else process.env.AGENTFLOW_RELEASE_SKILLS_ROOT = previousRoot;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("release runtime catalog and execution reject actions outside the selected workflow", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-release-allowlist-api-")));
  const skillsRoot = path.join(tempRoot, "release-skills");
  const configuredDir = path.join(skillsRoot, "release-git", "scripts");
  const extraDir = path.join(skillsRoot, "release-demo", "scripts");
  fs.mkdirSync(configuredDir, { recursive: true });
  fs.mkdirSync(extraDir, { recursive: true });
  fs.writeFileSync(path.join(skillsRoot, "release-git", "SKILL.md"), `---\nname: release-git\ndescription: Git\nactions:\n  - name: create-release-branch\n    platforms: [android]\n    requires_confirmation: false\n---\n`);
  fs.writeFileSync(path.join(skillsRoot, "release-demo", "SKILL.md"), `---\nname: release-demo\ndescription: Extra\nactions:\n  - name: extra\n    platforms: [android]\n    requires_confirmation: false\n---\n`);
  fs.writeFileSync(path.join(configuredDir, "run.py"), "print('configured')\n");
  fs.writeFileSync(path.join(extraDir, "run.py"), "print('extra')\n");
  const previousRoot = process.env.AGENTFLOW_RELEASE_SKILLS_ROOT;
  process.env.AGENTFLOW_RELEASE_SKILLS_ROOT = skillsRoot;
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?release-allowlist=${nonce}`),
      import(`../bin/lib/ui-server.mjs?release-allowlist=${nonce}`),
    ]);
    const user = loginOrCreateUser("release-allowlist-owner", "release-password");
    server = await startUiServer({ workspaceRoot: path.join(tempRoot, "workspace"), host: "127.0.0.1", port: 0, staticDir: path.join(tempRoot, "static"), enableWorkspaceScheduler: false });
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" };
    const catalogResponse = await fetch(`${base}/api/release/catalog?businessLine=likee&platform=android&version=5.63.2&batch=initial&workspaceId=release-allowlist`, { headers });
    const catalog = await catalogResponse.json();
    assert.equal(catalogResponse.status, 200, JSON.stringify(catalog));
    assert.deepEqual(catalog.nodes.map((node) => node.id), ["release-git:create-release-branch"]);
    const configured = catalog.nodes[0];
    assert.ok(Array.isArray(configured.inputSchema));
    assert.equal(configured.source.scriptPath, path.join(configuredDir, "run.py"));
    assert.equal(configured.scopeKey, "likee/android/5.63.2/initial");
    assert.equal(configured.requiresConfirmation, false);
    assert.ok(Array.isArray(configured.nextNodeIds));

    const runResponse = await fetch(`${base}/api/release/nodes/run`, {
      method: "POST",
      headers,
      body: JSON.stringify({ workspaceId: "release-allowlist", businessLine: "likee", platform: "android", version: "5.63.2", batch: "initial", actionId: "release-demo:extra" }),
    });
    const run = await runResponse.json();
    assert.equal(runResponse.status, 409, JSON.stringify(run));
    assert.equal(run.code, "RELEASE_WORKFLOW_NODE_NOT_ALLOWED");

    const previewResponse = await fetch(`${base}/api/release/nodes/preview`, {
      method: "POST",
      headers,
      body: JSON.stringify({ workspaceId: "release-allowlist", businessLine: "likee", platform: "android", version: "5.63.2", batch: "initial", actionId: "release-demo:extra" }),
    });
    const preview = await previewResponse.json();
    assert.equal(previewResponse.status, 409, JSON.stringify(preview));
    assert.equal(preview.code, "RELEASE_WORKFLOW_NODE_NOT_ALLOWED");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousRoot === undefined) delete process.env.AGENTFLOW_RELEASE_SKILLS_ROOT;
    else process.env.AGENTFLOW_RELEASE_SKILLS_ROOT = previousRoot;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("release catalog exposes composites and rejects composites with invalid internal membership", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-release-composite-api-")));
  const skillsRoot = path.join(tempRoot, "release-skills");
  const writeSkill = (skill, action) => {
    const dir = path.join(skillsRoot, skill, "scripts");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(skillsRoot, skill, "SKILL.md"), `---\nname: ${skill}\nactions:\n  - name: ${action}\n    platforms: [android]\n    requires_confirmation: false\n---\n`);
    fs.writeFileSync(path.join(dir, "run.py"), "print('ok')\n");
  };
  writeSkill("release-localization", "upload-source-file");
  writeSkill("release-notification", "send-notification");
  const previousRoot = process.env.AGENTFLOW_RELEASE_SKILLS_ROOT;
  process.env.AGENTFLOW_RELEASE_SKILLS_ROOT = skillsRoot;
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?release-composite-api=${nonce}`),
      import(`../bin/lib/ui-server.mjs?release-composite-api=${nonce}`),
    ]);
    const user = loginOrCreateUser("release-composite-owner", "release-password");
    server = await startUiServer({ workspaceRoot: path.join(tempRoot, "workspace"), host: "127.0.0.1", port: 0, staticDir: path.join(tempRoot, "static"), enableWorkspaceScheduler: false });
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" };
    const response = await fetch(`${base}/api/release/catalog?businessLine=likee&platform=android&version=5.63.2&batch=initial&workspaceId=release-composite`, { headers });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    const composite = payload.nodes.find((node) => node.id === "composite:localization-upload-notify");
    assert.ok(composite);
    assert.equal(composite.kind, "composite");
    assert.equal(composite.actions.length, 2);
    const runResponse = await fetch(`${base}/api/release/nodes/run`, {
      method: "POST",
      headers,
      body: JSON.stringify({ workspaceId: "release-composite", businessLine: "likee", platform: "android", version: "5.63.2", batch: "initial", actionId: composite.id, inputs: { source_path: "translations.yml" } }),
    });
    const runPayload = await runResponse.json();
    assert.equal(runResponse.status, 200, JSON.stringify(runPayload));
    assert.equal(runPayload.status, "completed");
    assert.deepEqual(runPayload.result.order, ["composite_upload", "composite_notify"]);
    assert.deepEqual(runPayload.details.steps.map((step) => step.actionId), [
      "release-localization:upload-source-file",
      "release-notification:send-notification",
    ]);
    assert.ok(runPayload.state.timeline.find((item) => item.nodeId === composite.id)?.details?.steps?.length >= 2);
    const invalid = await fetch(`${base}/api/release/nodes/run`, {
      method: "POST",
      headers,
      body: JSON.stringify({ workspaceId: "release-composite", businessLine: "likee", platform: "android", version: "5.63.2", batch: "initial", actionId: "composite:android-channel-packages" }),
    });
    const invalidPayload = await invalid.json();
    assert.equal(invalid.status, 409, JSON.stringify(invalidPayload));
    assert.equal(invalidPayload.code, "RELEASE_WORKFLOW_NODE_NOT_ALLOWED");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousRoot === undefined) delete process.env.AGENTFLOW_RELEASE_SKILLS_ROOT;
    else process.env.AGENTFLOW_RELEASE_SKILLS_ROOT = previousRoot;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
