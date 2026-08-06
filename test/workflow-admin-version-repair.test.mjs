import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("admin may repair version membership without gaining general Workflow write access", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-admin-version-repair-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "workspace");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = dataRoot;
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?admin-version-repair=${nonce}`),
      import(`../bin/lib/ui-server.mjs?admin-version-repair=${nonce}`),
    ]);
    const admin = loginOrCreateUser("version-repair-admin", "admin-password");
    const owner = loginOrCreateUser("version-repair-owner", "owner-password");
    server = await startUiServer({
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
    });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const request = (token, pathname, init = {}) => fetch(`${baseUrl}${pathname}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    });

    const initial = await request(owner.token, "/api/workflows/report", {
      method: "POST",
      body: JSON.stringify({
        workflow: "tapd:1013667",
        source: "prd-flow",
        idempotencyKey: "initial-version-membership",
        projections: {
          timeline: [
            { kind: "version", id: "1012886", title: "V5.62", date: "2026-07-24" },
            { kind: "milestone", id: "code-freeze", title: "封板", date: "2026-08-08" },
          ],
        },
      }),
    });
    const initialResult = await initial.json();
    assert.equal(initial.status, 200, JSON.stringify(initialResult));

    const ordinaryAdminWrite = await request(admin.token, "/api/workflows/report", {
      method: "POST",
      body: JSON.stringify({
        workflow: "tapd:1013667",
        source: "prd-flow",
        action: { key: "admin-action", title: "不应允许", status: "done" },
      }),
    });
    assert.equal(ordinaryAdminWrite.status, 403);

    const mixedRepair = await request(admin.token, "/api/workflows/report", {
      method: "POST",
      body: JSON.stringify({
        workflow: "tapd:1013667",
        source: "prd-flow",
        adminOperation: "repair-version-membership",
        expectedRevision: initialResult.snapshot.runtimeRevision,
        idempotencyKey: "invalid-mixed-repair",
        action: { key: "admin-action", title: "不应允许", status: "done" },
        projections: { timeline: [{ kind: "version", id: "1013667", title: "V5.63", date: "2026-08-11" }] },
      }),
    });
    const mixedRepairResult = await mixedRepair.json();
    assert.equal(mixedRepair.status, 400, JSON.stringify(mixedRepairResult));
    assert.match(mixedRepairResult.error, /only update projections\.timeline/);

    const nonAdminRepair = await request(owner.token, "/api/workflows/report", {
      method: "POST",
      body: JSON.stringify({
        workflow: "tapd:1013667",
        source: "prd-flow",
        adminOperation: "repair-version-membership",
        expectedRevision: initialResult.snapshot.runtimeRevision,
        idempotencyKey: "owner-cannot-use-admin-repair",
        projections: { timeline: [{ kind: "version", id: "1013667", title: "V5.63", date: "2026-08-11" }] },
      }),
    });
    assert.equal(nonAdminRepair.status, 403);

    const repaired = await request(admin.token, "/api/workflows/report", {
      method: "POST",
      body: JSON.stringify({
        workflow: "tapd:1013667",
        source: "prd-flow",
        adminOperation: "repair-version-membership",
        expectedRevision: initialResult.snapshot.runtimeRevision,
        idempotencyKey: "repair-version-membership-v563",
        projections: { timeline: [{ kind: "version", id: "1013667", title: "V5.63", date: "2026-08-11" }] },
      }),
    });
    const repairedResult = await repaired.json();
    assert.equal(repaired.status, 200, JSON.stringify(repairedResult));
    assert.deepEqual(repairedResult.administrativeRepair, {
      kind: "version-attribution",
      operation: "repair-version-membership",
    });
    assert.equal(repairedResult.event.actor.userId, admin.user.userId);
    assert.equal(repairedResult.event.administrativeRepair.kind, "version-attribution");
    assert.deepEqual(
      repairedResult.snapshot.projections.timeline.map((entry) => `${entry.kind}:${entry.id}`).sort(),
      ["milestone:code-freeze", "version:1013667"],
    );

    const staleRepair = await request(admin.token, "/api/workflows/report", {
      method: "POST",
      body: JSON.stringify({
        workflow: "tapd:1013667",
        source: "prd-flow",
        adminOperation: "repair-version-membership",
        expectedRevision: initialResult.snapshot.runtimeRevision,
        idempotencyKey: "stale-version-repair",
        projections: { timeline: [{ kind: "version", id: "1014709", title: "V5.64", date: "2026-09-01" }] },
      }),
    });
    assert.equal(staleRepair.status, 409);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome == null) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
