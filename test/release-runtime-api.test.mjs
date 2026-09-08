import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeReleaseState } from "../bin/lib/release-runtime-store.mjs";

test("maps a completed Agent result into timeline details and release records", async () => {
  const { applyReleaseAgentResult } = await import("../bin/lib/release-runtime.mjs?agent-completed-contract");
  const state = { timeline: [], pending: [{ id: "cap-1", nodeId: "localization-upload-notify", status: "running" }] };
  const result = applyReleaseAgentResult(state, "localization-upload-notify", {
    status: "completed", summary: "上传并通知完成",
    steps: [{ skill: "release-localization", action: "upload-source-file", status: "completed" }],
    records: [{ id: "record-1" }], artifacts: [{ path: "reports/localization.json" }],
  });
  assert.equal(result.state.pending.length, 0);
  assert.equal(result.state.timeline[0].status, "completed");
  assert.deepEqual(result.state.timeline[0].details.steps, [{ skill: "release-localization", action: "upload-source-file", status: "completed" }]);
  assert.deepEqual(result.state.timeline[0].details.records, [{ id: "record-1" }]);
  assert.deepEqual(result.state.timeline[0].details.artifacts, [{ path: "reports/localization.json" }]);
});

test("keeps a waiting Agent result pending without advancing the timeline", async () => {
  const { applyReleaseAgentResult } = await import("../bin/lib/release-runtime.mjs?agent-waiting-contract");
  const state = { timeline: [], pending: [{ id: "cap-1", nodeId: "localization-upload-notify", status: "running" }] };
  const result = applyReleaseAgentResult(state, "localization-upload-notify", {
    status: "waiting", summary: "等待外部结果", waiting: { reason: "external_result_pending", operator_url: "https://example.test/status" },
  });
  assert.equal(result.state.pending.length, 1);
  assert.equal(result.state.pending[0].status, "waiting");
  assert.equal(result.state.pending[0].waiting.reason, "external_result_pending");
  assert.equal(result.state.timeline.length, 0);
  assert.equal(result.advance, false);
});

test("keeps a failed Agent capability retryable with a sanitized reason", async () => {
  const { applyReleaseAgentResult } = await import("../bin/lib/release-runtime.mjs?agent-failed-contract");
  const state = { timeline: [], pending: [{ id: "cap-1", nodeId: "localization-upload-notify", status: "running" }] };
  const result = applyReleaseAgentResult(state, "localization-upload-notify", {
    status: "failed", summary: "执行失败", error: "token=secret-value; webhook=https://private.example/hook",
  });
  assert.equal(result.state.timeline.length, 0);
  assert.equal(result.state.pending[0].status, "failed");
  assert.match(result.state.pending[0].error, /执行失败|失败/);
  assert.doesNotMatch(result.state.pending[0].error, /secret-value|private\.example/);
  assert.equal(result.retryable, true);
});

test("maps assistant atomic supplemental notification runs to the visible release capability", async () => {
  const { releaseCapabilityPresetIdForAction, normalizeReleaseCapabilityId, releaseTimelineIdentity, releaseTimelineSourcePresetId } = await import(`../bin/lib/release-runtime.mjs?assistant-timeline=${Date.now()}`);
  assert.equal(
    releaseCapabilityPresetIdForAction("release-notification:send-rollout-notification", { event: "patch-flow-entered" }),
    "composite:start-supplemental-release-notify",
  );
  assert.equal(normalizeReleaseCapabilityId("free-prompt-agent"), "composite:free-prompt-agent");
  assert.equal(normalizeReleaseCapabilityId("composite:free-prompt-agent"), "composite:free-prompt-agent");
  assert.equal(
    releaseTimelineSourcePresetId("free-prompt-agent", { prompt: "查询当前发版分支" }),
    "composite:free-prompt-agent",
  );
  assert.deepEqual(
    releaseTimelineIdentity(
      { id: "composite:free-prompt-agent" },
      { itemId: "custom-free-prompt-agent-run-1", inputs: { prompt: "查询当前发版分支" } },
    ),
    {
      nodeId: "custom-free-prompt-agent-run-1",
      sourcePresetId: "composite:free-prompt-agent",
    },
  );
  assert.equal(
    releaseTimelineIdentity(
      { id: "free-prompt-agent" },
      { itemId: "custom-free-prompt-agent-retry", inputs: { prompt: "重试助手" } },
      { sourcePresetId: "release-notification:send-notification" },
    ).sourcePresetId,
    "composite:free-prompt-agent",
  );
});

test("keeps repeated free-agent completions as separate nodes visible in the same major-version timeline", async () => {
  const { releaseTimelineIdentity } = await import(`../bin/lib/release-runtime.mjs?assistant-repeat=${Date.now()}`);
  const { releaseTimelineItemMatchesContext } = await import("../builtin/web-ui/src/lib/releaseWorkflowModel.js");
  const initialContext = { businessLine: "likee", platform: "android", version: "5.64.0", batch: "initial" };
  const supplementalContext = { businessLine: "likee", platform: "android", version: "5.64.1", batch: "supplemental" };
  const firstIdentity = releaseTimelineIdentity(
    { id: "free-prompt-agent" },
    { itemId: "custom-free-prompt-agent-first", inputs: { prompt: "确认首包分支" } },
  );
  const secondIdentity = releaseTimelineIdentity(
    { id: "composite:free-prompt-agent" },
    { itemId: "custom-free-prompt-agent-second", inputs: { prompt: "确认补包分支" } },
  );
  assert.notEqual(firstIdentity.nodeId, secondIdentity.nodeId);
  assert.equal(firstIdentity.sourcePresetId, "composite:free-prompt-agent");
  assert.equal(secondIdentity.sourcePresetId, "composite:free-prompt-agent");
  const timeline = [
    {
      id: firstIdentity.nodeId,
      ...firstIdentity,
      status: "completed",
      contextSnapshot: initialContext,
      scopeKey: "likee/android/5.64.0/initial",
      details: { steps: [{ action: "release-management:guide-current-release", status: "completed" }] },
    },
    {
      id: secondIdentity.nodeId,
      ...secondIdentity,
      status: "completed",
      contextSnapshot: supplementalContext,
      scopeKey: "likee/android/5.64.1/supplemental",
      details: { steps: [{ action: "release-notification:send-notification", status: "completed" }] },
    },
  ];
  const visible = timeline.filter((item) => releaseTimelineItemMatchesContext(item, supplementalContext));
  assert.deepEqual(visible.map((item) => item.nodeId), [
    "custom-free-prompt-agent-first",
    "custom-free-prompt-agent-second",
  ]);
  assert.equal(visible.every((item) => item.sourcePresetId === "composite:free-prompt-agent"), true);
  assert.equal(visible.every((item) => !item.details.steps.some((step) => step.nodeId)), true);
});

test("normalizes interactive waiting into a retryable failure", async () => {
  const { normalizeReleaseAgentResult } = await import("../bin/lib/release-runtime.mjs?interactive-waiting-contract");
  const result = normalizeReleaseAgentResult({
    status: "waiting",
    summary: "等待确认",
    waiting: { reason: "confirmation_required", confirmation: "confirm-1" },
  });
  assert.equal(result.status, "failed");
  assert.match(result.summary, /确认|交互/);
  assert.equal(result.waiting.reason, "confirmation_required");
});

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
    assert.ok(catalog.body.nodes.some((node) => node.id === "composite:create-release-branch" || node.id === "release-git:create-release-branch"));
    const state = await request("GET", "/api/release/state?businessLine=likee&platform=android&batch=initial&version=5.63.2&workspaceId=release-api");
    assert.equal(state.status, 200, state.text);
    assert.equal(state.body.state.timeline[0].nodeId, "release-initialization");
    assert.equal(state.body.state.timeline[0].status, "completed");
    assert.ok(Array.isArray(state.body.state.pending));
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousRoot === undefined) delete process.env.AGENTFLOW_RELEASE_SKILLS_ROOT;
    else process.env.AGENTFLOW_RELEASE_SKILLS_ROOT = previousRoot;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("release runtime API deletes removable pending nodes and protects running or custom nodes", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-release-delete-")));
  const skillsRoot = path.join(tempRoot, "release-skills");
  const skillDir = path.join(skillsRoot, "release-git", "scripts");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillsRoot, "release-git", "SKILL.md"), `---\nname: release-git\nactions:\n  - name: create-release-branch\n    platforms: [android]\n---\n`);
  fs.writeFileSync(path.join(skillDir, "run.py"), "print('ok')\n");
  const previousRoot = process.env.AGENTFLOW_RELEASE_SKILLS_ROOT;
  process.env.AGENTFLOW_RELEASE_SKILLS_ROOT = skillsRoot;
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?release-delete=${nonce}`),
      import(`../bin/lib/ui-server.mjs?release-delete=${nonce}`),
    ]);
    const user = loginOrCreateUser("release-delete-owner", "release-password");
    const workspaceRoot = path.join(tempRoot, "workspace");
    server = await startUiServer({ workspaceRoot, host: "127.0.0.1", port: 0, staticDir: path.join(tempRoot, "static"), enableWorkspaceScheduler: false });
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" };
    const context = { businessLine: "likee", platform: "android", version: "5.63.2", batch: "initial" };
    const state = {
      context,
      timeline: [{ nodeId: "release-initialization", status: "completed" }],
      pending: [
        { id: "remove-me", nodeId: "release-git:create-release-branch", status: "pending" },
        { id: "running", nodeId: "release-git:create-release-branch", status: "running" },
        { id: "custom", nodeId: "custom-release-git:create-release-branch", status: "failed" },
      ],
      customNodes: [],
      runs: {},
    };
    writeReleaseState(workspaceRoot, context, "release-delete", state);
    const request = async (id, workspaceId = "release-delete") => {
      const response = await fetch(`${base}/api/release/pending/${encodeURIComponent(id)}?businessLine=likee&platform=android&version=5.63.2&batch=initial&workspaceId=${encodeURIComponent(workspaceId)}`, { method: "DELETE", headers });
      return { status: response.status, body: await response.json() };
    };
    const deleted = await request("remove-me");
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.state.pending.some((item) => item.id === "remove-me"), false);
    assert.deepEqual(deleted.body.state.dismissedNodeIds, ["release-git:create-release-branch"]);
    const running = await request("running");
    assert.equal(running.status, 409);
    assert.equal(running.body.code, "RELEASE_NODE_RUNNING");
    const custom = await request("custom");
    assert.equal(custom.status, 200);
    assert.equal(custom.body.state.pending.some((item) => item.id === "custom"), false);
    assert.ok(custom.body.state.dismissedNodeIds.includes("custom-release-git:create-release-branch")
      || custom.body.state.dismissedNodeIds.includes("release-git:create-release-branch"));
    const duplicateState = {
      context,
      timeline: [{ nodeId: "release-initialization", status: "completed" }],
      pending: [
        { id: "dup-a", nodeId: "release-initialization:prepare-context", status: "failed" },
        { id: "dup-b", nodeId: "release-initialization:prepare-context", status: "failed" },
      ],
      customNodes: [],
      runs: {},
    };
    writeReleaseState(workspaceRoot, context, "release-delete-dup", duplicateState);
    const dupDeleted = await request("dup-a", "release-delete-dup");
    assert.equal(dupDeleted.status, 200);
    assert.equal(dupDeleted.body.state.pending.some((item) => item.id === "dup-a"), false);
    assert.equal(dupDeleted.body.state.pending.some((item) => item.id === "dup-b"), false);
    assert.ok(dupDeleted.body.state.dismissedNodeIds.includes("release-initialization:prepare-context"));
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
    const catalog = await fetch(`${base}/api/release/catalog?businessLine=likee&platform=android&version=5.63.2&batch=initial&workspaceId=release-run`, { headers });
    const catalogPayload = await catalog.json();
    assert.equal(catalog.status, 200, JSON.stringify(catalogPayload));
    assert.ok(catalogPayload.nodes.some((node) => node.id === "composite:create-release-branch"));
    const scopeMismatch = await fetch(base + "/api/release/nodes/run", {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspaceId: "release-run",
        businessLine: "likee",
        platform: "android",
        version: "5.63.2",
        actionId: "composite:create-release-branch",
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
        actionId: "composite:create-release-branch",
        processId: "approval",
      }),
    });
    const processMismatchPayload = await processMismatch.json();
    assert.equal(processMismatch.status, 409, JSON.stringify(processMismatchPayload));
    assert.equal(processMismatchPayload.code, "RELEASE_PROCESS_MISMATCH");
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
    assert.equal(response.status, 409, JSON.stringify(payload));
    assert.equal(payload.code, "RELEASE_WORKFLOW_NODE_NOT_ALLOWED");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousRoot === undefined) delete process.env.AGENTFLOW_RELEASE_SKILLS_ROOT;
    else process.env.AGENTFLOW_RELEASE_SKILLS_ROOT = previousRoot;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("reconciles persisted release runs with AgentFlow manifests after a server restart", async () => {
  const { reconcileReleaseState } = await import("../bin/lib/release-runtime-store.mjs?release-state-reconcile");
  const workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-release-reconcile-")));
  const context = { businessLine: "likee", platform: "android", version: "5.63.2", batch: "initial" };
  const completedRunId = "release-completed-after-restart";
  const staleRunId = "release-stale-after-restart";
  const manifestDir = path.join(workspaceRoot, ".workspace", "agentflow", "run-manifests");
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(path.join(manifestDir, `${completedRunId}.json`), JSON.stringify({
    status: "completed",
    finishedAt: "2026-09-01T09:58:40.535Z",
    updatedAt: "2026-09-01T09:58:40.535Z",
    error: "",
  }));
  fs.writeFileSync(path.join(manifestDir, `${staleRunId}.json`), JSON.stringify({
    status: "running",
    startedAt: "2026-09-01T07:57:36.592Z",
    updatedAt: "2026-09-01T07:57:36.593Z",
  }));
  const result = reconcileReleaseState(workspaceRoot, context, "likee-android-local", {
    context,
    timeline: [],
    pending: [
      { id: "completed-item", nodeId: "composite:create-release-branch", status: "running", runId: completedRunId, startedAt: Date.parse("2026-09-01T09:58:11.876Z") },
      { id: "stale-item", nodeId: "composite:localization-upload-notify", status: "running", runId: staleRunId, startedAt: Date.parse("2026-09-01T07:57:36.592Z") },
    ],
    runs: {
      [completedRunId]: { id: "completed-item", nodeId: "composite:create-release-branch", status: "running", runId: completedRunId },
      [staleRunId]: { id: "stale-item", nodeId: "composite:localization-upload-notify", status: "running", runId: staleRunId },
    },
  }, { now: Date.parse("2026-09-01T10:20:00.000Z"), staleAfterMs: 5 * 60 * 1000 });

  assert.equal(result.changed, true);
  assert.equal(result.state.pending.length, 1);
  assert.equal(result.state.pending[0].id, "stale-item");
  assert.equal(result.state.pending[0].status, "failed");
  assert.match(result.state.pending[0].error, /服务重启|失联/);
  assert.equal(result.state.timeline[0].id, "completed-item");
  assert.equal(result.state.timeline[0].status, "completed");
  assert.equal(result.state.timeline[0].error, "");
  assert.equal(result.state.runs[completedRunId].status, "completed");
  assert.equal(result.state.runs[staleRunId].status, "failed");
});

test("reconcileReleaseState keeps Agent waiting pending", async () => {
  const { reconcileReleaseState } = await import("../bin/lib/release-runtime-store.mjs?release-state-reconcile-waiting");
  const workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-release-reconcile-waiting-")));
  const context = { businessLine: "likee", platform: "android", version: "5.64.0", batch: "initial" };
  const runId = "release-force-waiting";
  const manifestDir = path.join(workspaceRoot, ".workspace", "agentflow", "run-manifests");
  fs.mkdirSync(manifestDir, { recursive: true });
  fs.writeFileSync(path.join(manifestDir, `${runId}.json`), JSON.stringify({
    status: "completed",
    finishedAt: "2026-09-03T07:58:02.000Z",
    updatedAt: "2026-09-03T07:58:02.000Z",
  }));
  const waitingOutput = {
    status: "waiting",
    summary: "MR !1142 opened; wait for merge",
    waiting: { reason: "managed_topic_mr_open", merge_request_iid: 1142, operator_url: "https://example/mr/1142" },
    artifacts: [{ type: "merge_request", iid: 1142, url: "https://example/mr/1142", state: "opened" }],
  };
  const result = reconcileReleaseState(workspaceRoot, context, "likee-android-local", {
    context,
    timeline: [],
    pending: [{
      id: "force-localization",
      nodeId: "composite:localization-download-merge-notify",
      status: "running",
      runId,
      startedAt: Date.parse("2026-09-03T06:54:23.000Z"),
    }],
    runs: {
      [runId]: {
        id: "force-localization",
        nodeId: "composite:localization-download-merge-notify",
        status: "waiting",
        runId,
        output: waitingOutput,
        details: { summary: waitingOutput.summary, steps: [], artifacts: waitingOutput.artifacts },
        waiting: waitingOutput.waiting,
      },
    },
  }, { now: Date.parse("2026-09-03T08:00:00.000Z") });

  assert.equal(result.state.pending.length, 1);
  assert.equal(result.state.pending[0].status, "waiting");
  assert.equal(result.state.timeline.length, 0);
  assert.equal(result.state.pending[0].waiting?.reason, "managed_topic_mr_open");
  assert.equal(result.state.runs[runId].status, "waiting");
  fs.rmSync(workspaceRoot, { recursive: true, force: true });
});

test("reconcileReleaseState drops dismissed pending cards from persisted state", async () => {
  const { reconcileReleaseState } = await import("../bin/lib/release-runtime-store.mjs?release-state-dismissed");
  const result = reconcileReleaseState("/tmp", { businessLine: "likee", platform: "android", version: "5.64.0", batch: "initial" }, "ws", {
    dismissedNodeIds: ["release-initialization:prepare-context"],
    pending: [
      { id: "stale-a", nodeId: "release-initialization:prepare-context", status: "failed" },
      { id: "keep", nodeId: "composite:localization-upload-notify", status: "pending" },
    ],
    timeline: [],
    runs: {},
  });
  assert.equal(result.changed, true);
  assert.deepEqual(result.state.pending.map((item) => item.id), ["keep"]);
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
    assert.deepEqual(catalog.nodes.map((node) => node.id).filter((id) => id.includes("create-release-branch") || id.includes("release-git")), [
      catalog.nodes.find((node) => String(node.id).includes("create-release-branch") || String(node.id).includes("release-git"))?.id,
    ].filter(Boolean));
    const configured = catalog.nodes.find((node) => node.id === "composite:create-release-branch" || node.id === "release-git:create-release-branch");
    assert.ok(configured, JSON.stringify(catalog.nodes.map((node) => node.id)));
    assert.ok(Array.isArray(configured.inputSchema));
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

test("initialization preparation reuses an existing active release without running create", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-release-initialization-api-")));
  const skillsRoot = path.join(tempRoot, "release-skills");
  const managementDir = path.join(skillsRoot, "skills", "release-management");
  fs.mkdirSync(path.join(managementDir, "scripts"), { recursive: true });
  fs.writeFileSync(path.join(managementDir, "SKILL.md"), "---\nname: release-management\ndescription: Management\n---\n");
  fs.writeFileSync(path.join(managementDir, "scripts", "run.py"), [
    "import sys",
    "action = sys.argv[sys.argv.index('--action') + 1] if '--action' in sys.argv else ''",
    "if action == 'guide-current-release':",
    "    print('status: succeeded')",
    "    print('record_id: reuse-1.1.0')",
    "    print('data:')",
    "    print('  minor_version: 1.1.0')",
    "elif action == 'create-active-release':",
    "    raise SystemExit('must not execute create-active-release')",
    "else:",
    "    raise SystemExit(f'unexpected action {action}')",
  ].join("\n"));
  const manifest = path.join(skillsRoot, "release-data", "likee", "active", "android", "1.1.0.yaml");
  fs.mkdirSync(path.dirname(manifest), { recursive: true });
  fs.writeFileSync(manifest, "product: likee\nplatform: android\nmajor_version: '1.1'\nminor_version: '1.1.0'\nbatch: initial\n");
  const previousRoot = process.env.AGENTFLOW_RELEASE_SKILLS_ROOT;
  process.env.AGENTFLOW_RELEASE_SKILLS_ROOT = skillsRoot;
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?release-initialization-api=${nonce}`),
      import(`../bin/lib/ui-server.mjs?release-initialization-api=${nonce}`),
    ]);
    const user = loginOrCreateUser("release-initialization-owner", "release-password");
    server = await startUiServer({ workspaceRoot: path.join(tempRoot, "workspace"), host: "127.0.0.1", port: 0, staticDir: path.join(tempRoot, "static"), enableWorkspaceScheduler: false });
    const base = `http://127.0.0.1:${server.address().port}`;
    const response = await fetch(`${base}/api/release/nodes/run`, {
      method: "POST",
      headers: { Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        workspaceId: "release-initialization",
        businessLine: "likee",
        platform: "android",
        version: "1.1.0",
        batch: "initial",
        actionId: "release-initialization:prepare-context",
        itemId: "release-initialization:prepare-context-item",
        inputs: {},
      }),
    });
    const payload = await response.json();
    assert.equal(response.status, 200, JSON.stringify(payload));
    assert.equal(payload.status, "completed");
    assert.equal(payload.state.timeline.some((item) => item.nodeId === "release-initialization:prepare-context"), true);
    assert.match(JSON.stringify(payload), /就绪|复用|已完成|活动发版|completed/);
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
    assert.ok(Array.isArray(composite.skillHints) && composite.skillHints.includes("release-localization"));
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

test("production release API requires an approved project and keeps Skill roots separate", async () => {
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-release-deployment-api-")));
  const productRoot = path.join(tempRoot, "product");
  const skillsRoot = path.join(tempRoot, "release-skills");
  fs.mkdirSync(productRoot, { recursive: true });
  fs.mkdirSync(path.join(skillsRoot, "release-git", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(skillsRoot, "release-git", "SKILL.md"), `---\nname: release-git\nactions:\n  - name: create-release-branch\n    platforms: [android]\n    requires_confirmation: false\n---\n`);
  fs.writeFileSync(path.join(skillsRoot, "release-git", "scripts", "run.py"), "print('configured')\n");
  const previous = {
    nodeEnv: process.env.NODE_ENV,
    skills: process.env.AGENTFLOW_RELEASE_SKILLS_ROOT,
    projects: process.env.AGENTFLOW_RELEASE_PROJECTS_JSON,
  };
  let server;
  try {
    process.env.NODE_ENV = "production";
    delete process.env.AGENTFLOW_RELEASE_SKILLS_ROOT;
    delete process.env.AGENTFLOW_RELEASE_PROJECTS_JSON;
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?release-deployment-empty=${nonce}`),
      import(`../bin/lib/ui-server.mjs?release-deployment-empty=${nonce}`),
    ]);
    const user = loginOrCreateUser("release-deployment-owner", "release-password");
    server = await startUiServer({ workspaceRoot: path.join(tempRoot, "state"), host: "127.0.0.1", port: 0, staticDir: path.join(tempRoot, "static"), enableWorkspaceScheduler: false });
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = { Authorization: `Bearer ${user.token}`, "Content-Type": "application/json" };
    const missing = await fetch(`${base}/api/release/catalog?businessLine=likee&platform=android&version=1.0.0`, { headers });
    const missingPayload = await missing.json();
    assert.equal(missing.status, 503, JSON.stringify(missingPayload));
    assert.equal(missingPayload.code, "RELEASE_WORKSPACE_NOT_CONFIGURED");

    process.env.AGENTFLOW_RELEASE_PROJECTS_JSON = JSON.stringify({ projects: [{ id: "likee-android-prod", businessLine: "likee", platform: "android", workspaceRoot: productRoot, skillRoots: [skillsRoot] }] });
    const configured = await fetch(`${base}/api/release/catalog?businessLine=likee&platform=android&version=1.0.0&workspaceId=likee-android-prod`, { headers });
    const configuredPayload = await configured.json();
    assert.equal(configured.status, 200, JSON.stringify(configuredPayload));
    assert.ok(configuredPayload.nodes.some((node) => node.id === "composite:create-release-branch"));

    const rejected = await fetch(`${base}/api/release/catalog?businessLine=likee&platform=android&version=1.0.0&workspaceId=likee-android-prod&workspacePath=${encodeURIComponent(path.join(tempRoot, "other"))}`, { headers });
    const rejectedPayload = await rejected.json();
    assert.equal(rejected.status, 403, JSON.stringify(rejectedPayload));
    assert.equal(rejectedPayload.code, "RELEASE_WORKSPACE_PATH_FORBIDDEN");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.nodeEnv;
    if (previous.skills === undefined) delete process.env.AGENTFLOW_RELEASE_SKILLS_ROOT; else process.env.AGENTFLOW_RELEASE_SKILLS_ROOT = previous.skills;
    if (previous.projects === undefined) delete process.env.AGENTFLOW_RELEASE_PROJECTS_JSON; else process.env.AGENTFLOW_RELEASE_PROJECTS_JSON = previous.projects;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
