import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("generic Workflow reports materialize beside legacy PRD events", async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-workflow-report-"));
  const dataRoot = path.join(tempRoot, "data");
  const workspaceRoot = path.join(tempRoot, "project");
  fs.mkdirSync(workspaceRoot, { recursive: true });
  const workflowStateRoot = path.join(workspaceRoot, ".workspace", "prd-flow", "workflow-state");
  fs.mkdirSync(workflowStateRoot, { recursive: true });
  fs.writeFileSync(
    path.join(workflowStateRoot, "1015046.events.json"),
    JSON.stringify({
      version: 1,
      tapdId: "1015046",
      events: [{
        id: "stage_gift-cache_implementation_mr",
        type: "workflow-marker",
        action: "mark",
        stageKey: "implementation_mr",
        issueKey: "gift-cache",
        platform: "Android",
        title: "实现 MR 已记录",
        status: "done",
        artifacts: [
          {
            key: "gitlab-issue:gift-cache:android",
            kind: "gitlab-issue",
            url: "https://git.example/project/issues/1",
          },
          {
            key: "gitlab-mr:gift-cache:implementation",
            kind: "gitlab-mr",
            url: "https://git.example/project/merge_requests/2",
          },
        ],
      }],
    }),
    "utf-8",
  );

  const previousHome = process.env.AGENTFLOW_HOME;
  process.env.AGENTFLOW_HOME = dataRoot;
  let server;
  try {
    const nonce = Date.now();
    const [{ loginOrCreateUser }, { startUiServer }] = await Promise.all([
      import(`../bin/lib/auth.mjs?workflow-report=${nonce}`),
      import(`../bin/lib/ui-server.mjs?workflow-report=${nonce}`),
    ]);
    const user = loginOrCreateUser("workflow-reporter", "reporter-password");
    server = await startUiServer({
      workspaceRoot,
      host: "127.0.0.1",
      port: 0,
      staticDir: path.join(tempRoot, "static"),
    });
    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const request = async (pathname, init = {}, authenticated = true) => fetch(`${baseUrl}${pathname}`, {
      ...init,
      headers: {
        ...(authenticated ? { Authorization: `Bearer ${user.token}` } : {}),
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers || {}),
      },
    });
    const reportPayload = {
      schemaVersion: 1,
      workflow: { namespace: "tapd", id: "1015046" },
      source: "prd-flow",
      action: {
        key: "implementation:android:issue-2",
        title: "Android 实现",
        status: "done",
        group: "implementation",
        platform: "android",
        issueKey: "issue-2",
      },
      artifacts: [{
        key: "mr-943",
        type: "gitlab-mr",
        title: "实现 MR !943",
        url: "https://git.example/mr/943",
      }],
      globalState: {
        mode: "merge",
        patch: {
          title: "双端 Remote Config",
          status: { label: "开发中" },
          sections: {
            android: {
              title: "Android",
              fields: {
                owner: { label: "负责人", type: "user", value: "workflow-reporter" },
              },
            },
          },
        },
      },
      projections: {
        timeline: [{
          kind: "version",
          id: "android-5.63.0",
          title: "Android 5.63.0",
          date: "2026-08-20",
          source: "prd-flow",
          dimensions: { platform: "android" },
        }],
      },
      idempotencyKey: "report-1015046-issue-2",
    };

    const unauthorized = await request("/api/workflows/report", {
      method: "POST",
      body: JSON.stringify(reportPayload),
    }, false);
    assert.equal(unauthorized.status, 401);

    const response = await request("/api/workflows/report", {
      method: "POST",
      body: JSON.stringify(reportPayload),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.snapshot.globalState.title, "双端 Remote Config");
    assert.equal(result.snapshot.globalState.status.label, "开发中");
    assert.equal(result.snapshot.globalState.sections.android.fields.owner.value, "workflow-reporter");
    assert.equal(result.snapshot.projections.timeline[0].id, "android-5.63.0");
    assert.match(result.snapshot.runtimeRevision, /^runtime:/);
    assert.equal(result.event.actor.userId, user.user.userId);
    assert.equal(result.event.artifacts[0].url, "https://git.example/mr/943");
    const migratedMarker = result.snapshot.runtimeEvents.find(
      (event) => event.stageKey === "implementation:gift-cache",
    );
    assert.equal(migratedMarker.action, "implementation");
    assert.deepEqual(
      migratedMarker.artifacts.map((artifact) => artifact.kind),
      ["gitlab-mr"],
    );

    const dashboard = await request("/api/prd-workflows?view=personal");
    const dashboardResult = await dashboard.json();
    assert.equal(dashboard.status, 200, JSON.stringify(dashboardResult));
    assert.equal(dashboardResult.timeline.length, 1);
    assert.equal(dashboardResult.timeline[0].key, "prd-flow:version:android-5.63.0");
    assert.equal(dashboardResult.timeline[0].workflowCount, 1);
    assert.equal(dashboardResult.workflows[0].timeline[0].dimensions.platform, "android");
    assert.equal(dashboardResult.unassignedCount, 0);

    const replay = await request("/api/workflows/report", {
      method: "POST",
      body: JSON.stringify(reportPayload),
    });
    const replayResult = await replay.json();
    assert.equal(replay.status, 200, JSON.stringify(replayResult));
    assert.equal(replayResult.alreadyApplied, true);

    const replayWithStaleRevision = await request("/api/workflows/report", {
      method: "POST",
      body: JSON.stringify({ ...reportPayload, expectedRevision: "runtime:stale" }),
    });
    const replayWithStaleRevisionResult = await replayWithStaleRevision.json();
    assert.equal(replayWithStaleRevision.status, 200, JSON.stringify(replayWithStaleRevisionResult));
    assert.equal(replayWithStaleRevisionResult.alreadyApplied, true);

    const otherProducer = await request("/api/workflows/report", {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        workflow: { namespace: "tapd", id: "1015046" },
        source: "release-bot",
        action: {
          key: "implementation:android:issue-2",
          title: "Release Bot 校验完成",
          status: "done",
          group: "implementation",
          platform: "android",
          issueKey: "issue-2",
        },
        artifacts: [{
          key: "mr-943",
          type: "release-check",
          title: "Release check",
          url: "https://example.test/release-check/943",
        }],
        idempotencyKey: "report-1015046-issue-2",
      }),
    });
    const otherProducerResult = await otherProducer.json();
    assert.equal(otherProducer.status, 200, JSON.stringify(otherProducerResult));
    assert.notEqual(otherProducerResult.alreadyApplied, true);
    assert.equal(otherProducerResult.event.source, "release-bot");
    assert.equal(
      otherProducerResult.snapshot.runtimeEvents.filter((event) => event.issueKey === "issue-2").length,
      2,
    );

    const stale = await request("/api/workflows/report", {
      method: "POST",
      body: JSON.stringify({
        ...reportPayload,
        idempotencyKey: "report-1015046-stale",
        expectedRevision: "runtime:stale",
      }),
    });
    assert.equal(stale.status, 409);

    const observationReport = await request("/api/workflows/report", {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        workflow: { namespace: "tapd", id: "1015046" },
        source: "prd-flow",
        observation: {
          schema: "prd-flow/v1",
          clientId: "prd-flow-test",
          observedAt: "2026-08-04T10:00:00.000Z",
          state: {
            tapdId: "1015046",
            phase: "testing",
            pointer: "Android 已提测",
            actions: [{ key: "submit-test", title: "提交测试", status: "done" }],
          },
        },
        extensions: {
          "prd-flow": {
            issues: [{ key: "gift-cache", title: "Gift Cache", platform: "android" }],
            aiDocs: [{ key: "tech-design", title: "技术方案" }],
          },
        },
        idempotencyKey: "prd-flow-observation-1015046-v1",
      }),
    });
    const observationResult = await observationReport.json();
    assert.equal(observationReport.status, 200, JSON.stringify(observationResult));
    assert.equal(observationResult.observation.accepted, true);
    assert.equal(observationResult.observation.schema, "prd-flow/v1");
    assert.equal(observationResult.snapshot.phase, "testing");
    assert.equal(observationResult.snapshot.pointer, "Android 已提测");
    assert.equal(observationResult.snapshot.extensions["prd-flow"].aiDocs[0].key, "tech-design");
    assert.equal(observationResult.snapshot.issues[0].key, "gift-cache");

    const legacy = await request("/api/prd-workflow/event", {
      method: "POST",
      body: JSON.stringify({
        tapdId: "1015046",
        event: {
          stageKey: "submit-test",
          title: "已提测",
          status: "done",
          overallPatch: {
            requirement: {
              title: "双端 Remote Config",
              status: { label: "已提测" },
            },
          },
        },
      }),
    });
    const legacyResult = await legacy.json();
    assert.equal(legacy.status, 200, JSON.stringify(legacyResult));
    assert.equal(legacy.headers.get("deprecation"), "true");
    assert.equal(legacyResult.compatibility.replacement, "/api/workflows/report with action/artifacts/extensions");
    assert.equal(legacyResult.snapshot.overall.requirement.status.label, "已提测");
    assert.equal(legacyResult.snapshot.globalState.status.label, "已提测");
    assert.ok(legacyResult.snapshot.runtimeEvents.some((event) => event.stageKey === "submit-test"));

    const rawMarker = await request("/api/prd-workflow/event", {
      method: "POST",
      body: JSON.stringify({
        tapdId: "1015046",
        event: {
          type: "workflow-marker",
          action: "mark",
          stageKey: "implementation_mr",
          issueKey: "gift-cache",
          platform: "Android",
          title: "实现 MR 已记录",
          status: "done",
          artifacts: [
            {
              key: "gitlab-epic:requirement",
              kind: "gitlab-epic",
              url: "https://git.example/groups/likee/-/epics/1",
            },
            {
              key: "gitlab-issue:gift-cache:android",
              kind: "gitlab-issue",
              url: "https://git.example/project/issues/1",
            },
            {
              key: "gitlab-mr:gift-cache:implementation",
              kind: "gitlab-mr",
              url: "https://git.example/project/merge_requests/2",
            },
          ],
        },
      }),
    });
    const rawMarkerResult = await rawMarker.json();
    assert.equal(rawMarker.status, 200, JSON.stringify(rawMarkerResult));
    assert.equal(rawMarkerResult.event.stageKey, "implementation:gift-cache");
    assert.equal(rawMarkerResult.event.action, "implementation");
    assert.deepEqual(
      rawMarkerResult.event.artifacts.map((artifact) => artifact.kind),
      ["gitlab-mr"],
    );

    const reviewLink = await request("/api/workflow-artifacts/publish", {
      method: "POST",
      body: JSON.stringify({
        workflow: { namespace: "tapd", id: "1015046" },
        source: "prsrc",
        reviewId: "code-review-1015046-gift-cache-android",
        title: "Gift Cache Code Review",
        markdown: "# Code Review\n\n审查通过",
        stage: "code-review:gift-cache",
        stageKey: "code-review:gift-cache",
        action: "CODE_REVIEW_COMPLETED",
        issueKey: "gift-cache",
        platform: "android",
        artifactKey: "code-review:gift-cache:android",
        artifactLabel: "Code Review 报告",
        durability: "temporary",
      }),
    });
    const reviewLinkResult = await reviewLink.json();
    assert.equal(reviewLink.status, 200, JSON.stringify(reviewLinkResult));
    assert.equal(reviewLink.headers.get("deprecation"), null);
    assert.equal(reviewLinkResult.artifact.key, "code-review:gift-cache:android");
    assert.equal(reviewLinkResult.event.aggregateByStage, false);
    assert.equal(
      reviewLinkResult.event.id,
      "review-link:code-review:gift-cache:android",
    );
    assert.equal(
      reviewLinkResult.event.artifacts[0].stageKey,
      "implementation:gift-cache",
    );
    assert.equal(reviewLinkResult.event.stageKey, "implementation:gift-cache");

    const reviewBacklink = await request("/api/prd-workflow/event", {
      method: "POST",
      body: JSON.stringify({
        tapdId: "1015046",
        event: {
          id: "review-link:code-review:gift-cache:android",
          type: "code-review-link",
          source: "prsrc",
          auxiliary: true,
          aggregateByStage: false,
          action: "implementation",
          stageKey: "implementation:gift-cache",
          issueKey: "gift-cache",
          platform: "android",
          status: "done",
          artifacts: [{
            key: "code-review:gift-cache:android",
            label: "Code Review 报告",
            kind: "code-review",
            url: reviewLinkResult.review.shortUrl || reviewLinkResult.review.url,
            issueKey: "gift-cache",
            platform: "android",
            mrUrl: "https://git.example/project/merge_requests/2",
            mrIid: "2",
            commitSha: "abc123",
            stageKey: "implementation:gift-cache",
          }],
        },
      }),
    });
    const reviewBacklinkResult = await reviewBacklink.json();
    assert.equal(reviewBacklink.status, 200, JSON.stringify(reviewBacklinkResult));
    const linkedArtifact = reviewBacklinkResult.event.artifacts[0];
    assert.equal(linkedArtifact.key, "code-review:gift-cache:android");
    assert.equal(linkedArtifact.issueKey, "gift-cache");
    assert.equal(linkedArtifact.platform, "android");
    assert.equal(linkedArtifact.mrIid, "2");
    assert.equal(linkedArtifact.commitSha, "abc123");
    assert.equal(linkedArtifact.stageKey, "implementation:gift-cache");
    const linkedReviewEvents = reviewBacklinkResult.snapshot.runtimeEvents.filter(
      (event) => event.id === "review-link:code-review:gift-cache:android",
    );
    assert.equal(linkedReviewEvents.length, 1);
    assert.equal(linkedReviewEvents[0].artifacts[0].commitSha, "abc123");
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    if (previousHome === undefined) delete process.env.AGENTFLOW_HOME;
    else process.env.AGENTFLOW_HOME = previousHome;
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});
