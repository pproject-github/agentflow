import assert from "node:assert/strict";
import test from "node:test";

import {
  legacyOverallToGlobalState,
  materializeWorkflowExtensions,
  materializeWorkflowGlobalState,
  materializeWorkflowProjections,
  mergeWorkflowArtifactLists,
  mergeWorkflowGlobalState,
  normalizeWorkflowReference,
  normalizeWorkflowReport,
} from "../bin/lib/workflow-report.mjs";

test("normalizes action, artifacts, and global state into one runtime event", () => {
  const report = normalizeWorkflowReport({
    schemaVersion: 1,
    workflow: { namespace: "tapd", id: "1015046" },
    source: "prd-flow",
    action: {
      key: "implementation:android:issue-2",
      title: "Android 实现",
      status: "completed",
      group: "implementation",
      platform: "android",
      issueKey: "issue-2",
      tags: ["Android", "Issue2"],
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
        title: "Remote Config",
        sections: {
          android: {
            title: "Android",
            fields: {
              owner: { label: "负责人", type: "user", value: "wangfang" },
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
    idempotencyKey: "issue-2-mr-943",
  });

  assert.equal(report.workflow.key, "tapd:1015046");
  assert.equal(report.action.status, "done");
  assert.equal(report.event.action, "implementation:android:issue-2");
  assert.equal(report.event.stageKey, "implementation:android:issue-2");
  assert.equal(report.event.artifacts[0].scope, "action");
  assert.equal(report.event.artifacts[0].producer, "prd-flow");
  assert.equal(report.event.globalStatePatch.title, "Remote Config");
  assert.equal(report.event.projections.timeline[0].key, "prd-flow:version:android-5.63.0");
  assert.equal(report.event.idempotencyKey, "issue-2-mr-943");
});

test("supports global-only reports and rejects malformed reports", () => {
  const report = normalizeWorkflowReport({
    workflow: { namespace: "tapd", id: "1015046" },
    artifacts: [{
      type: "dashboard",
      title: "结果看板",
      url: "https://example.test/dashboard",
    }],
  });
  assert.equal(report.event.aggregateByStage, false);
  assert.equal(report.event.auxiliary, true);
  assert.equal(report.event.artifacts[0].scope, "global");

  assert.match(
    normalizeWorkflowReport({ workflow: { namespace: "tapd", id: "1015046" }, action: { title: "missing key" } }).error,
    /stable key/,
  );
  assert.match(
    normalizeWorkflowReport({ workflow: { namespace: "tapd", id: "1015046" } }).error,
    /requires observation, action/,
  );
  assert.match(
    normalizeWorkflowReport({
      workflow: { namespace: "tapd", id: "1015046" },
      projections: { timeline: [{ title: "missing identity" }] },
    }).error,
    /requires kind and id/,
  );
});

test("normalizes observations and materializes namespaced extensions", () => {
  const report = normalizeWorkflowReport({
    workflow: { namespace: "tapd", id: "1015046" },
    observation: {
      schema: "prd-flow/v1",
      clientId: "prd-flow-local",
      observedAt: "2026-08-04T10:00:00.000Z",
      state: { phase: "implementing", pointer: "Android 实现中" },
    },
    extensions: {
      "prd-flow": {
        issues: [{ key: "runtime-hook", title: "Runtime Hook" }],
        aiDocs: [{ key: "tech-design", title: "技术方案" }],
      },
    },
  });
  assert.equal(report.observation.schema, "prd-flow/v1");
  assert.equal(report.observation.state.phase, "implementing");
  assert.equal(report.event.extensionsPatch["prd-flow"].issues[0].key, "runtime-hook");

  const extensions = materializeWorkflowExtensions({}, [report.event]);
  assert.equal(extensions["prd-flow"].aiDocs[0].title, "技术方案");
});

test("materializes producer-owned timeline projections with replace semantics", () => {
  const base = {
    projections: {
      timeline: [{ kind: "sprint", id: "sprint-1", title: "Sprint 1" }],
    },
  };
  const projected = materializeWorkflowProjections(base, [{
    occurredAt: "2026-08-01T00:00:00.000Z",
    projections: {
      timeline: [{
        kind: "version",
        id: "ios-5.63.0",
        title: "iOS 5.63.0",
        date: "2026-08-22",
        dimensions: { platform: "ios", train: "stable" },
      }],
    },
  }]);
  assert.equal(projected.timeline.length, 1);
  assert.equal(projected.timeline[0].kind, "version");
  assert.equal(projected.timeline[0].dimensions.train, "stable");

  const cleared = materializeWorkflowProjections({ projections: projected }, [{
    occurredAt: "2026-08-02T00:00:00.000Z",
    projections: { timeline: [] },
  }]);
  assert.deepEqual(cleared.timeline, []);
});

test("materializes legacy Overall and generic patches into one global state", () => {
  const overall = {
    requirement: {
      tapdId: "1015046",
      title: "Remote Config",
      tapdUrl: "https://tapd.example/1015046",
      status: { label: "开发中" },
    },
    platforms: {
      android: {
        owner: { username: "android-owner" },
        tags: ["firebase"],
      },
    },
  };
  const legacy = legacyOverallToGlobalState("1015046", overall);
  assert.equal(legacy.title, "Remote Config");
  assert.equal(legacy.sections.android.fields.tags.value[0], "firebase");

  const state = materializeWorkflowGlobalState("1015046", {}, [{
    globalStatePatch: {
      status: { label: "已提测" },
      sections: {
        ios: {
          title: "iOS",
          fields: {
            owner: { label: "负责人", type: "user", value: "ios-owner" },
          },
        },
      },
    },
  }], overall);
  assert.equal(state.status.label, "已提测");
  assert.equal(state.sections.android.fields.owner.value.username, "android-owner");
  assert.equal(state.sections.ios.fields.owner.value, "ios-owner");
});

test("deduplicates artifacts by stable key while accepting updates", () => {
  const artifacts = mergeWorkflowArtifactLists(
    [{ key: "mr-943", type: "gitlab-mr", title: "MR", url: "https://example.test/old", status: "running" }],
    [{ key: "mr-943", type: "gitlab-mr", title: "MR !943", url: "https://example.test/new", status: "ready" }],
  );
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].url, "https://example.test/new");
  assert.equal(artifacts[0].status, "ready");
});

test("deduplicates keyless legacy artifacts after a stable key is introduced", () => {
  const artifacts = mergeWorkflowArtifactLists(
    [{
      type: "gitlab-issue",
      title: "GitLab Issue",
      url: "https://example.test/issues/1?legacy=1",
    }],
    [{
      key: "gitlab-issue:gift-cache:android",
      type: "gitlab-issue",
      title: "GitLab Issue",
      url: "https://example.test/issues/1",
    }],
  );
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].key, "gitlab-issue:gift-cache:android");
});

test("keeps identical artifact keys isolated between report producers", () => {
  const artifacts = mergeWorkflowArtifactLists(
    [{ key: "build", producer: "adapter-a", url: "https://example.test/a" }],
    [{ key: "build", producer: "adapter-b", url: "https://example.test/b" }],
  );
  assert.equal(artifacts.length, 2);
  assert.deepEqual(artifacts.map((item) => item.producer), ["adapter-a", "adapter-b"]);
});

test("requires a stable normalized report source", () => {
  assert.match(normalizeWorkflowReport({
    workflow: { namespace: "tapd", id: "1015046" },
    source: "Invalid Source",
    action: { key: "implementation", status: "done" },
  }).error, /Invalid workflow report source/);
});

test("accepts canonical workflow keys and ignores unsafe state keys", () => {
  assert.deepEqual(normalizeWorkflowReference({ workflow: { key: "tapd:1015046" } }), {
    namespace: "tapd",
    id: "1015046",
    key: "tapd:1015046",
  });
  const patch = JSON.parse('{"safe":{"value":"kept"},"__proto__":{"polluted":true}}');
  const merged = mergeWorkflowGlobalState({}, patch);
  assert.equal(merged.safe.value, "kept");
  assert.equal(merged.polluted, undefined);
  assert.equal({}.polluted, undefined);
});
