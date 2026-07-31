import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

function writeFlow(dataRoot, userId, flowId) {
  const flowDir = path.join(dataRoot, "users", userId, "pipelines", flowId);
  fs.mkdirSync(flowDir, { recursive: true });
  fs.writeFileSync(path.join(flowDir, "flow.yaml"), "version: 1\ninstances: {}\nedges: []\n", "utf-8");
  return flowDir;
}

test("shared PRD Workflow state follows TAPD ID across different Projects", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-prd-collab-api-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "project");
  const ownerFlowDir = writeFlow(dataRoot, "owner", "owner-project");
  writeFlow(dataRoot, "guest", "guest-project");
  fs.mkdirSync(workspaceRoot, { recursive: true });

  const legacyStateDir = path.join(ownerFlowDir, ".workspace", "prd-flow", "workflow-state");
  fs.mkdirSync(legacyStateDir, { recursive: true });
  fs.writeFileSync(
    path.join(legacyStateDir, "1015046.cache.json"),
    JSON.stringify({
      version: 1,
      tapdId: "1015046",
      snapshot: {
        tapdId: "1015046",
        phase: "implementing",
        pointer: "Owner shared Workflow",
        revision: "revision-owner",
        actions: [],
        issues: [],
      },
    }, null, 2) + "\n",
    "utf-8",
  );

  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = dataRoot;
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?prd-collab-api=${nonce}`),
      import(`../bin/lib/ui-server.mjs?prd-collab-api=${nonce}`),
    ]);
    const owner = loginOrCreateUser("owner", "owner-password");
    const guest = loginOrCreateUser("guest", "guest-password");
    const outsider = loginOrCreateUser("outsider", "outsider-password");
    server = await startUiServer({
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
    });
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const request = async (token, pathname, init = {}) => fetch(`${baseUrl}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    });

    const invalidReport = await request(owner.token, "/api/prd-workflow/snapshot", {
      method: "POST",
      body: JSON.stringify({ tapdId: "1015046" }),
    });
    assert.equal(invalidReport.status, 400);
    const beforeReport = await request(owner.token, "/api/prd-workflow/share?tapdId=1015046");
    const beforeReportPayload = await beforeReport.json();
    assert.equal(beforeReport.status, 200, JSON.stringify(beforeReportPayload));
    assert.equal(beforeReportPayload.share, null);

    const reported = await request(owner.token, "/api/prd-workflow/snapshot", {
      method: "POST",
      body: JSON.stringify({
        tapdId: "1015046",
        snapshot: {
          tapdId: "1015046",
          phase: "implementing",
          pointer: "Owner shared Workflow",
          revision: "revision-owner",
          actions: [],
          issues: [],
        },
      }),
    });
    const reportedPayload = await reported.json();
    assert.equal(reported.status, 200, JSON.stringify(reportedPayload));
    assert.equal(reportedPayload.workflowShare.tapdId, "1015046");
    assert.equal(reportedPayload.workflowShare.readOnly, true);
    assert.match(reportedPayload.workflowShare.shortUrl, /\/w\/[A-Za-z0-9_-]{32}$/);
    assert.equal(reportedPayload.shareUrl, reportedPayload.workflowShare.shortUrl);
    const reportedUrl = new URL(reportedPayload.workflowShare.url);
    assert.equal(reportedUrl.searchParams.get("tapdId"), "1015046");
    assert.equal(reportedUrl.searchParams.get("view"), "workflow");
    assert.equal(reportedUrl.searchParams.get("flowId"), null);
    assert.equal(reportedUrl.searchParams.get("flowSource"), null);
    const workflowShare = reportedUrl.searchParams.get("workflowShare");
    assert.ok(workflowShare);
    const addedGuest = await request(owner.token, "/api/prd-workflow/collaboration/share", {
      method: "POST",
      body: JSON.stringify({
        tapdId: "1015046",
        username: "guest",
        role: "viewer",
      }),
    });
    assert.equal(addedGuest.status, 200, await addedGuest.text());

    const ownerDashboard = await request(owner.token, "/api/prd-workflows");
    const ownerDashboardPayload = await ownerDashboard.json();
    assert.equal(ownerDashboard.status, 200, JSON.stringify(ownerDashboardPayload));
    assert.equal(ownerDashboardPayload.workflows.length, 1);
    assert.equal(ownerDashboardPayload.workflows[0].tapdId, "1015046");
    assert.equal(ownerDashboardPayload.workflows[0].pointer, "Owner shared Workflow");
    assert.equal(ownerDashboardPayload.workflows[0].role, "owner");
    assert.equal(ownerDashboardPayload.workflows[0].shareActive, true);

    const guestDashboard = await request(guest.token, "/api/prd-workflows");
    const guestDashboardPayload = await guestDashboard.json();
    assert.equal(guestDashboard.status, 200, JSON.stringify(guestDashboardPayload));
    assert.equal(guestDashboardPayload.workflows.length, 1);
    assert.equal(guestDashboardPayload.workflows[0].role, "viewer");

    const outsiderDashboard = await request(outsider.token, "/api/prd-workflows");
    const outsiderDashboardPayload = await outsiderDashboard.json();
    assert.equal(outsiderDashboard.status, 200, JSON.stringify(outsiderDashboardPayload));
    assert.deepEqual(outsiderDashboardPayload.workflows, []);

    const anonymousDashboard = await fetch(`${baseUrl}/api/prd-workflows`);
    assert.equal(anonymousDashboard.status, 401);

    const shortRedirect = await fetch(reportedPayload.workflowShare.shortUrl, { redirect: "manual" });
    assert.equal(shortRedirect.status, 302);
    assert.equal(shortRedirect.headers.get("location"), `${reportedUrl.pathname}${reportedUrl.search}`);
    const anonymousShare = await fetch(
      `${baseUrl}/api/prd-workflow/share?tapdId=1015046&workflowShare=${encodeURIComponent(workflowShare)}`,
    );
    assert.equal(anonymousShare.status, 200);
    const anonymousSharePayload = await anonymousShare.json();
    assert.equal(anonymousSharePayload.share.readOnly, true);
    assert.equal(anonymousSharePayload.share.canManage, false);

    const anonymousSnapshot = await fetch(
      `${baseUrl}/api/prd-workflow/snapshot?tapdId=1015046&runtimeOnly=1&workflowShare=${encodeURIComponent(workflowShare)}`,
    );
    assert.equal(anonymousSnapshot.status, 200);
    const anonymousSnapshotPayload = await anonymousSnapshot.json();
    assert.equal(anonymousSnapshotPayload.snapshot.pointer, "Owner shared Workflow");

    const invalidAnonymousSnapshot = await fetch(
      `${baseUrl}/api/prd-workflow/snapshot?tapdId=1015046&runtimeOnly=1&workflowShare=invalid-share-token`,
    );
    assert.equal(invalidAnonymousSnapshot.status, 404);

    const issue2ObservedAt = "2026-07-29T21:01:35+08:00";
    const issue2Snapshot = {
      tapdId: "1015046",
      phase: "PLAN_DRAFT_MISSING",
      pointer: "开始 Issue2 功能点实现",
      revision: "revision-issue-2",
      actions: [{
        id: "issue-plan:issue-2",
        stageKey: "issue-plan:issue-2",
        issueKey: "issue-2",
        platform: "android",
        title: "起草 Issue2 方案",
        status: "current",
      }],
      issues: [],
    };
    const issue2Report = await request(owner.token, "/api/prd-workflow/snapshot", {
      method: "POST",
      body: JSON.stringify({
        tapdId: "1015046",
        clientId: "prd-flow:test-owner",
        observedAt: issue2ObservedAt,
        snapshot: issue2Snapshot,
      }),
    });
    const issue2Payload = await issue2Report.json();
    assert.equal(issue2Report.status, 200, JSON.stringify(issue2Payload));
    assert.equal(issue2Payload.snapshot.actions[0].stageEnteredAt, issue2ObservedAt);
    const updatedDashboard = await request(owner.token, "/api/prd-workflows");
    const updatedDashboardPayload = await updatedDashboard.json();
    assert.equal(updatedDashboard.status, 200, JSON.stringify(updatedDashboardPayload));
    assert.equal(updatedDashboardPayload.workflows[0].latestAction.title, "起草 Issue2 方案");
    assert.equal(updatedDashboardPayload.workflows[0].latestAction.at, "2026-07-29T13:01:35.000Z");
    assert.ok(issue2Payload.snapshot.snapshotAudit.some((entry) => (
      entry.type === "snapshot-action-change" &&
      entry.change === "added" &&
      entry.stageKey === "issue-plan:issue-2" &&
      entry.actionAt === issue2ObservedAt
    )));

    const repeatedIssue2Report = await request(owner.token, "/api/prd-workflow/snapshot", {
      method: "POST",
      body: JSON.stringify({
        tapdId: "1015046",
        clientId: "prd-flow:test-owner",
        observedAt: "2026-07-30T09:00:00+08:00",
        snapshot: issue2Snapshot,
      }),
    });
    const repeatedIssue2Payload = await repeatedIssue2Report.json();
    assert.equal(repeatedIssue2Report.status, 200, JSON.stringify(repeatedIssue2Payload));
    assert.equal(repeatedIssue2Payload.snapshot.actions[0].stageEnteredAt, issue2ObservedAt);
    const actionAuditPath = path.join(
      dataRoot,
      "users",
      "owner",
      ".workspace",
      "prd-flow",
      "workflow-state",
      "1015046.audit.jsonl",
    );
    const actionAudit = fs.readFileSync(actionAuditPath, "utf-8")
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line))
      .filter((entry) => (
        entry.type === "snapshot-action-change" &&
        entry.stageKey === "issue-plan:issue-2"
      ));
    assert.equal(actionAudit.length, 1);

    const correctedIssue2Report = await request(owner.token, "/api/prd-workflow/snapshot", {
      method: "POST",
      body: JSON.stringify({
        tapdId: "1015046",
        clientId: "prd-flow:test-owner",
        observedAt: "2026-07-30T09:01:00+08:00",
        snapshot: {
          ...issue2Snapshot,
          actions: [{
            ...issue2Snapshot.actions[0],
            at: "2026-07-29T21:01:34+08:00",
            createdAt: "2026-07-29T21:01:34+08:00",
          }],
        },
      }),
    });
    const correctedIssue2Payload = await correctedIssue2Report.json();
    assert.equal(correctedIssue2Report.status, 200, JSON.stringify(correctedIssue2Payload));
    assert.ok(correctedIssue2Payload.snapshot.snapshotAudit.some((entry) => (
      entry.type === "snapshot-action-change" &&
      entry.change === "time-changed" &&
      entry.stageKey === "issue-plan:issue-2" &&
      entry.actionAt === issue2ObservedAt &&
      entry.previousSourceActionAt === "" &&
      entry.sourceActionAt === "2026-07-29T21:01:34+08:00"
    )));

    const otherClientReport = await request(owner.token, "/api/prd-workflow/snapshot", {
      method: "POST",
      body: JSON.stringify({
        tapdId: "1015046",
        clientId: "prd-flow:second-client",
        observedAt: "2026-07-31T09:00:00+08:00",
        snapshot: issue2Snapshot,
      }),
    });
    const otherClientPayload = await otherClientReport.json();
    assert.equal(otherClientReport.status, 200, JSON.stringify(otherClientPayload));
    assert.equal(otherClientPayload.snapshot.actions[0].stageEnteredAt, issue2ObservedAt);

    const shared = await request(owner.token, "/api/prd-workflow/share", {
      method: "POST",
      body: JSON.stringify({
        tapdId: "1015046",
        flowId: "owner-project",
        flowSource: "user",
      }),
    });
    const sharedPayload = await shared.json();
    assert.equal(shared.status, 200, JSON.stringify(sharedPayload));
    assert.equal(sharedPayload.share.tapdId, "1015046");
    assert.equal(sharedPayload.share.readOnly, true);
    assert.equal(sharedPayload.created, false);
    assert.equal(sharedPayload.share.url, reportedPayload.workflowShare.url);
    assert.equal(sharedPayload.share.shortUrl, reportedPayload.workflowShare.shortUrl);

    const current = await request(
      owner.token,
      "/api/prd-workflow/snapshot?tapdId=1015046&runtimeOnly=1",
    );
    const currentPayload = await current.json();
    assert.equal(current.status, 200, JSON.stringify(currentPayload));
    assert.equal(currentPayload.workflowShare.url, reportedPayload.workflowShare.url);
    assert.equal(currentPayload.workflowShare.shortUrl, reportedPayload.workflowShare.shortUrl);
    assert.equal(currentPayload.shareUrl, reportedPayload.workflowShare.shortUrl);

    const guestSnapshot = await request(
      guest.token,
      `/api/prd-workflow/snapshot?tapdId=1015046&runtimeOnly=1&workflowShare=${encodeURIComponent(workflowShare)}`,
    );
    const guestPayload = await guestSnapshot.json();
    assert.equal(guestSnapshot.status, 200, JSON.stringify(guestPayload));
    assert.equal(guestPayload.snapshot.pointer, "开始 Issue2 功能点实现");

    const outsiderSnapshot = await request(
      outsider.token,
      "/api/prd-workflow/snapshot?tapdId=1015046&runtimeOnly=1",
    );
    const outsiderPayload = await outsiderSnapshot.json();
    assert.equal(outsiderSnapshot.status, 200);
    assert.notEqual(outsiderPayload.snapshot.pointer, "开始 Issue2 功能点实现");

    const canonicalCache = path.join(
      dataRoot,
      "users",
      "owner",
      ".workspace",
      "prd-flow",
      "workflow-state",
      "1015046.cache.json",
    );
    assert.equal(fs.existsSync(canonicalCache), true);

    const revoked = await request(owner.token, "/api/prd-workflow/share", {
      method: "DELETE",
      body: JSON.stringify({ tapdId: "1015046" }),
    });
    assert.equal(revoked.status, 200);
    const revokedSnapshot = await request(
      guest.token,
      `/api/prd-workflow/snapshot?tapdId=1015046&runtimeOnly=1&workflowShare=${encodeURIComponent(workflowShare)}`,
    );
    assert.equal(revokedSnapshot.status, 404);
    const revokedShortLink = await fetch(reportedPayload.workflowShare.shortUrl, { redirect: "manual" });
    assert.equal(revokedShortLink.status, 404);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome == null) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
