import assert from "node:assert/strict";
import test from "node:test";

import {
  legacyOverallToGlobalState,
  materializeWorkflowGlobalState,
  mergeWorkflowArtifactLists,
  mergeWorkflowGlobalState,
  normalizeWorkflowReference,
  normalizeWorkflowReport,
} from "../bin/lib/workflow-report.mjs";

test("normalizes action, artifacts, and global state into one runtime event", () => {
  const report = normalizeWorkflowReport({
    schemaVersion: 1,
    workflow: { namespace: "tapd", id: "1015046" },
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
    idempotencyKey: "issue-2-mr-943",
  });

  assert.equal(report.workflow.key, "tapd:1015046");
  assert.equal(report.action.status, "done");
  assert.equal(report.event.action, "implementation:android:issue-2");
  assert.equal(report.event.stageKey, "implementation:android:issue-2");
  assert.equal(report.event.artifacts[0].scope, "action");
  assert.equal(report.event.globalStatePatch.title, "Remote Config");
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
    /requires action/,
  );
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
