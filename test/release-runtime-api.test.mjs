import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("release runtime API exposes filtered catalog and initialization state", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-release-api-")));
  const skillsRoot = path.join(tempRoot, "release-skills");
  const skillDir = path.join(skillsRoot, "release-demo", "scripts");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillsRoot, "release-demo", "SKILL.md"), `---\nname: release-demo\ndescription: Demo release action\nactions:\n  - name: inspect\n    inputs: [version]\n    platforms: [android]\n    requires_confirmation: false\n---\n`);
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
    assert.equal(catalog.body.nodes[0].id, "release-demo:inspect");
    const state = await request("GET", "/api/release/state?businessLine=likee&platform=android&batch=initial&version=5.63.2&workspaceId=release-api");
    assert.equal(state.status, 200, state.text);
    assert.equal(state.body.state.pending[0].nodeId, "release-initialization");
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
  const skillDir = path.join(skillsRoot, "release-demo", "scripts");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillsRoot, "release-demo", "SKILL.md"), `---\nname: release-demo\ndescription: Demo release action\nactions:\n  - name: inspect\n    inputs: [version]\n    platforms: [android]\n    requires_confirmation: false\n---\n`);
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
    const response = await fetch(base + "/api/release/nodes/run", { method: "POST", headers, body: JSON.stringify({ workspaceId: "release-run", businessLine: "likee", platform: "android", version: "5.63.2", actionId: "release-demo:inspect", inputs: { version: "5.63.2" } }) });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.status, "completed");
    assert.ok(payload.state.timeline.some((item) => item.nodeId === "release-demo:inspect"));
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
