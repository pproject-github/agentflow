import test from "node:test";
import assert from "node:assert/strict";

import {
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
