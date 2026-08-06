import test from "node:test";
import assert from "node:assert/strict";

import {
  canonicalPrdWorkflowStageKey,
  isPrdWorkflowGlobalEvent,
  isPrdWorkflowReviewLink,
  isPrdWorkflowPlanAction,
  mergePrdWorkflowActionLists,
  selectCurrentPrdWorkflowActionLinks,
} from "../builtin/web-ui/src/prdWorkflowActionLinks.js";

const reviewUrl = (id) => `http://ai.example.test/api/prd-workflow/review/1015046/${id}`;

test("recognizes issue plan actions by their canonical stage", () => {
  assert.equal(isPrdWorkflowPlanAction({
    stage: "issue-plan:firebase-remote-config-fetch-control-android",
  }), true);
  assert.equal(isPrdWorkflowPlanAction({
    stage: "implementation:firebase-remote-config-fetch-control-android",
  }), false);
});

test("canonicalizes legacy marker stages into registered action slots", () => {
  const issueKey = "gift-cache-integrity-validation";
  assert.equal(
    canonicalPrdWorkflowStageKey({
      stage: "implementation_mr",
      action: "mark",
      issueKey,
    }),
    `implementation:${issueKey}`,
  );
  assert.equal(
    canonicalPrdWorkflowStageKey({
      stageKey: "fix_mr",
      issueKey,
    }),
    `bugfix:${issueKey}`,
  );
  assert.equal(
    canonicalPrdWorkflowStageKey({
      stage: "integration_mr",
      issueKey,
    }),
    `integration:${issueKey}`,
  );
  assert.equal(
    canonicalPrdWorkflowStageKey({
      stage: "implementation:android:issue-2",
      issueKey: "issue-2",
    }),
    "implementation:android:issue-2",
  );
  assert.equal(
    canonicalPrdWorkflowStageKey({
      type: "review-link",
      stage: `code-review:${issueKey}`,
      action: "CODE_REVIEW_COMPLETED",
      issueKey,
    }),
    `implementation:${issueKey}`,
  );
});

test("classifies global-only reports as auxiliary timeline events", () => {
  assert.equal(isPrdWorkflowGlobalEvent({
    type: "workflow-report",
    aggregateByStage: false,
    artifactScope: "global",
  }), true);
  assert.equal(isPrdWorkflowGlobalEvent({
    type: "workflow-report",
    action: "implementation:gift-cache",
    artifactScope: "action",
  }), false);
});

test("plan action keeps only the latest durable review and the formal document", () => {
  const document = {
    label: "方案文档",
    href: "file://stories/1015046/android/plan.md",
    kind: "ai-doc",
    persistence: "ai-doc",
  };
  const links = [
    {
      label: "临时 Markdown 预览",
      href: reviewUrl("temporary-1"),
      kind: "temporary-review",
      durability: "temporary",
      source: { kind: "local-draft" },
    },
    {
      label: "方案文档预览",
      href: reviewUrl("durable-1"),
      kind: "review",
      durability: "durable",
      source: { kind: "ai-doc" },
    },
    {
      label: "临时 Markdown 预览",
      href: reviewUrl("temporary-2"),
      kind: "temporary-review",
      durability: "temporary",
      source: { kind: "local-draft" },
    },
    {
      label: "方案文档预览",
      href: reviewUrl("durable-2"),
      kind: "review",
      durability: "durable",
      source: { kind: "ai-doc" },
    },
    document,
  ];

  assert.deepEqual(
    selectCurrentPrdWorkflowActionLinks(links, {
      stage: "issue-plan:firebase-remote-config-fetch-control-android",
    }),
    [links[3], document],
  );
});

test("plan action without a formal document keeps only the latest temporary review", () => {
  const links = [
    {
      label: "临时 Markdown 预览",
      href: reviewUrl("temporary-1"),
      kind: "temporary-review",
      durability: "temporary",
    },
    {
      label: "临时 Markdown 预览",
      href: reviewUrl("temporary-2"),
      kind: "temporary-review",
      durability: "temporary",
    },
  ];

  assert.deepEqual(
    selectCurrentPrdWorkflowActionLinks(links, {
      stage: "plan-doc:firebase-remote-config-fetch-control-android",
    }),
    [links[1]],
  );
});

test("stable artifact keys collapse short-link aliases and keep the newest target", () => {
  const key = "prd-review:1015046:remote-config:android:issue-plan:temporary";
  const links = [
    {
      key,
      label: "临时 Markdown 预览",
      href: "http://ai.example.test/r/temporary1",
      canonicalUrl: reviewUrl("temporary-1"),
      kind: "temporary-review",
      durability: "temporary",
    },
    {
      key,
      label: "Markdown Review",
      href: "http://ai.example.test/r/temporary2",
      canonicalUrl: reviewUrl("temporary-2"),
      kind: "temporary-review",
      durability: "temporary",
    },
    {
      key,
      label: "预览",
      href: "http://ai.example.test/r/temporary3",
      canonicalUrl: reviewUrl("temporary-3"),
      kind: "temporary-review",
      durability: "temporary",
    },
  ];

  assert.deepEqual(
    selectCurrentPrdWorkflowActionLinks(links, {
      stage: "issue-plan:remote-config",
    }),
    [{
      ...links[2],
      label: "临时 Markdown 预览",
    }],
  );
});

test("legacy short links deduplicate through canonicalUrl without an artifact key", () => {
  const links = [
    {
      label: "临时 Markdown 预览",
      href: "http://ai.example.test/r/temporary1",
      canonicalUrl: reviewUrl("temporary-1"),
      kind: "temporary-review",
      durability: "temporary",
    },
    {
      label: "Markdown Review",
      href: "http://ai.example.test/r/temporary1",
      canonicalUrl: reviewUrl("temporary-1"),
      kind: "temporary-review",
      durability: "temporary",
    },
  ];

  assert.deepEqual(
    selectCurrentPrdWorkflowActionLinks(links, {
      stage: "issue-plan:remote-config",
    }),
    [{
      ...links[1],
      label: "临时 Markdown 预览",
    }],
  );
});

test("review aliases keep the business label instead of a generic Markdown Review label", () => {
  const key = "prd-review:1021708:self-test:android:st-01";
  const specific = {
    key,
    label: "ST-01 自测证据",
    href: "http://ai.example.test/r/selftest01",
    canonicalUrl: reviewUrl("selftest-01"),
    kind: "review",
  };
  const generic = {
    key,
    label: "Markdown Review",
    href: "http://ai.example.test/r/selftest01",
    canonicalUrl: reviewUrl("selftest-01"),
    kind: "review",
  };

  for (const links of [[specific, generic], [generic, specific]]) {
    const selected = selectCurrentPrdWorkflowActionLinks(links, { stage: "self-test:android" });
    assert.equal(selected.length, 1);
    assert.equal(selected[0].label, "ST-01 自测证据");
  }
});

test("review aliases use a specific title when the label is generic", () => {
  const selected = selectCurrentPrdWorkflowActionLinks([{
    key: "prd-review:1021708:self-test:android:st-02",
    label: "Markdown Review",
    title: "ST-02 自测证据（含根因定位）",
    href: "http://ai.example.test/r/selftest02",
    kind: "review",
  }], { stage: "self-test:android" });

  assert.equal(selected[0].label, "ST-02 自测证据（含根因定位）");
});

test("formal plan without a durable preview hides stale temporary reviews", () => {
  const document = {
    label: "方案文档",
    href: "file://stories/1015046/android/plan.md",
    kind: "ai-doc",
  };
  const links = [
    {
      label: "临时 Markdown 预览",
      href: reviewUrl("temporary-1"),
      kind: "temporary-review",
      durability: "temporary",
    },
    document,
  ];

  assert.deepEqual(
    selectCurrentPrdWorkflowActionLinks(links, {
      stage: "issue-plan:firebase-remote-config-fetch-control-android",
    }),
    [document],
  );
});

test("non-plan actions retain all unrelated review links", () => {
  const links = [
    { label: "代码审查", href: reviewUrl("code-review-1"), kind: "review" },
    { label: "代码审查", href: reviewUrl("code-review-2"), kind: "review" },
  ];

  assert.deepEqual(
    selectCurrentPrdWorkflowActionLinks(links, {
      stage: "code-review:firebase-remote-config-fetch-control-android",
    }),
    links,
  );
});

test("short review URLs are recognized from review metadata", () => {
  assert.equal(isPrdWorkflowReviewLink({
    href: "http://ai.example.test/r/AbCd1234",
    kind: "temporary-review",
  }), true);
  assert.equal(isPrdWorkflowReviewLink({
    href: "http://ai.example.test/r/AbCd1234",
    canonicalUrl: reviewUrl("temporary-1"),
  }), true);
});

test("plan action deduplicates short review URLs by review semantics", () => {
  const links = [
    {
      key: "ai-doc:plan:gift-cache:android",
      label: "临时 Markdown 预览",
      href: "http://ai.example.test/r/temporary",
      kind: "temporary-review",
      durability: "temporary",
    },
    {
      key: "ai-doc:plan:gift-cache:android",
      label: "方案文档预览",
      href: "http://ai.example.test/r/durable",
      kind: "review",
      durability: "durable",
    },
  ];

  const merged = mergePrdWorkflowActionLists([links[0]], [links[1]]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].href, "http://ai.example.test/r/durable");
  assert.equal(merged[0].kind, "review");
});

test("stable artifact key replaces the complete stale artifact", () => {
  const merged = mergePrdWorkflowActionLists(
    [{
      key: "ai-doc:plan:gift-cache:android",
      label: "临时 Markdown 预览",
      href: "http://ai.example.test/r/old",
      source: { kind: "local-draft" },
    }],
    [{
      key: "ai-doc:plan:gift-cache:android",
      label: "方案文档预览",
      href: "http://ai.example.test/r/new",
      durability: "durable",
    }],
  );

  assert.deepEqual(merged, [{
    key: "ai-doc:plan:gift-cache:android",
    label: "方案文档预览",
    href: "http://ai.example.test/r/new",
    durability: "durable",
  }]);
});

test("post-enrichment stable artifact replaces a keyless legacy URL alias", () => {
  const merged = mergePrdWorkflowActionLists(
    [{
      label: "GitLab Issue",
      kind: "gitlab-issue",
      url: "https://git.example/project/issues/1?from=runtime",
    }],
    [{
      key: "gitlab-issue:gift-cache:android",
      label: "GitLab Issue",
      kind: "gitlab-issue",
      url: "https://git.example/project/issues/1",
    }],
  );

  assert.equal(merged.length, 1);
  assert.equal(merged[0].key, "gitlab-issue:gift-cache:android");
});

test("final action links collapse stable artifacts and legacy direct-field aliases by URL", () => {
  const href = "https://git.example/project/issues/1";
  const stableArtifact = {
    key: "gitlab-issue:gift-cache:android",
    label: "GitLab Issue",
    kind: "gitlab-issue",
    href,
  };
  const legacyDirectFieldAlias = {
    label: "GitLab Issue",
    href,
  };

  for (const links of [
    [stableArtifact, legacyDirectFieldAlias],
    [legacyDirectFieldAlias, stableArtifact],
  ]) {
    const selected = selectCurrentPrdWorkflowActionLinks(links, {
      stage: "implementation:gift-cache",
    });
    assert.equal(selected.length, 1);
    assert.equal(selected[0].key, stableArtifact.key);
    assert.equal(selected[0].href, href);
  }
});

test("final action link URL identity preserves functional query parameters", () => {
  const selected = selectCurrentPrdWorkflowActionLinks([
    {
      label: "Workspace file",
      href: "/api/workspace/file/raw?path=reports%2Fa.md",
    },
    {
      label: "Workspace file",
      href: "/api/workspace/file/raw?path=reports%2Fb.md",
    },
  ], {
    stage: "implementation:gift-cache",
  });

  assert.equal(selected.length, 2);
});

test("implementation action keeps MR and linked Code Review report artifacts", () => {
  const merged = mergePrdWorkflowActionLists(
    [{
      key: "gitlab-mr:gift-cache:implementation",
      label: "实现 MR",
      kind: "gitlab-mr",
      url: "https://git.example/project/merge_requests/948",
    }],
    [{
      key: "code-review:gift-cache:android",
      label: "Code Review 报告",
      kind: "code-review",
      url: "http://agentflow.example/r/CodeRv01",
      issueKey: "gift-cache",
      platform: "android",
      mrUrl: "https://git.example/project/merge_requests/948",
      mrIid: "948",
      commitSha: "abc123",
      stageKey: "implementation:gift-cache",
    }],
  );

  assert.equal(merged.length, 2);
  assert.deepEqual(
    merged.map((artifact) => artifact.label),
    ["实现 MR", "Code Review 报告"],
  );
  assert.equal(merged[1].stageKey, "implementation:gift-cache");
  assert.equal(merged[1].commitSha, "abc123");
});
