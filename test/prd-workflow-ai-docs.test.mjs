import test from "node:test";
import assert from "node:assert/strict";

import {
  aiDocArticleTitle,
  confirmedAiDocIdentity,
  dedupeConfirmedAiDocs,
  isConfirmedAiDocCandidate,
} from "../builtin/web-ui/src/prdWorkflowAiDocs.js";

test("AI Docs only keeps confirmed, persisted ai-doc artifacts", () => {
  assert.equal(isConfirmedAiDocCandidate({
    label: "临时 Markdown 预览",
    href: "http://127.0.0.1:8875/api/prd-workflow/review/1015046/temp",
    kind: "temporary-review",
    durability: "temporary",
    persistence: "runtime",
    source: { kind: "local-draft" },
  }), false);

  assert.equal(isConfirmedAiDocCandidate({
    label: "方案文档预览",
    href: "http://127.0.0.1:8875/api/prd-workflow/review/1015046/durable",
    kind: "review",
    durability: "durable",
    source: { kind: "ai-doc", path: "issues/issue-3/plan.md" },
  }), true);
});

test("external artifacts do not inherit AI Docs membership from their action", () => {
  assert.equal(isConfirmedAiDocCandidate({
    label: "GitLab Issue",
    href: "https://git.example.test/group/project/-/issues/42",
    kind: "gitlab-issue",
    durability: "durable",
    persistence: "ai-doc",
    truth: "durable_fact",
  }), false);

  assert.equal(isConfirmedAiDocCandidate({
    label: "实现 MR",
    href: "https://git.example.test/group/project/-/merge_requests/7",
    kind: "gitlab-mr",
    durability: "durable",
    persistence: "ai-doc",
    truth: "durable_fact",
  }), false);
});

test("internal TAPD baseline snapshots are not user-facing AI Docs articles", () => {
  assert.equal(isConfirmedAiDocCandidate({
    label: "TAPD baseline snapshot",
    href: "file://stories/1015046/tapd_snapshot_v1.md",
    kind: "ai-doc",
    durability: "durable",
    persistence: "ai-doc",
  }), false);
});

test("AI Docs titles prefer article metadata and domain titles over action labels", () => {
  assert.equal(aiDocArticleTitle({
    label: "方案文档预览",
    title: "Issue4 方案已确认",
  }, {
    issueTitle: "Android 双端灰度配置与验收闭环",
  }), "Android 双端灰度配置与验收闭环");

  assert.equal(aiDocArticleTitle({
    label: "技术方案",
    title: "技术方案已确认",
  }, {
    requirementTitle: "双端 Remote Config 接入",
  }), "双端 Remote Config 接入");

  assert.equal(aiDocArticleTitle({
    label: "技术方案",
    documentTitle: "Remote Config 双端技术方案",
  }, {
    requirementTitle: "双端 Remote Config 接入",
  }), "Remote Config 双端技术方案");
});

test("confirmed technical-design file and preview share one document identity", () => {
  assert.equal(
    confirmedAiDocIdentity({
      label: "技术方案",
      documentPath: "stories/1015046/tech_design.md",
    }),
    confirmedAiDocIdentity({
      label: "需求技术方案预览",
      href: "http://127.0.0.1/review/tech-design",
    }),
  );
});

test("AI Docs deduplicates file and preview links by issue document identity", () => {
  const entries = dedupeConfirmedAiDocs([
    {
      label: "方案文档",
      href: "file://issues/issue-3/plan.md",
      kind: "ai-doc",
      durability: "durable",
      issueKey: "firebase-init-analytics-preservation-android",
      platform: "Android",
      title: "Issue3 · Android 双端保持 Firebase 初始化",
      documentPath: "issues/issue-3/plan.md",
    },
    {
      label: "临时 Markdown 预览",
      href: "http://127.0.0.1:8875/api/prd-workflow/review/1015046/temp",
      kind: "temporary-review",
      durability: "temporary",
      persistence: "runtime",
      source: { kind: "local-draft", path: "issues/issue-3/plan.md" },
      issueKey: "firebase-init-analytics-preservation-android",
      title: "Issue3 · Android 双端保持 Firebase 初始化",
    },
    {
      label: "方案文档预览",
      href: "http://127.0.0.1:8875/api/prd-workflow/review/1015046/durable",
      kind: "review",
      durability: "durable",
      source: { kind: "ai-doc", path: "issues/issue-3/plan.md" },
      issueKey: "firebase-init-analytics-preservation-android",
      platform: "Android",
      title: "Issue3 · Android 双端保持 Firebase 初始化",
    },
    {
      label: "方案文档预览",
      href: "http://127.0.0.1:8875/api/prd-workflow/review/1015046/durable?refresh=1",
      kind: "review",
      durability: "durable",
      source: { kind: "ai-doc", path: "issues/issue-3/plan.md" },
      issueKey: "firebase-init-analytics-preservation-android",
      platform: "Android",
      title: "方案文档预览",
    },
  ], "http://127.0.0.1:8875");

  assert.equal(entries.length, 1);
  assert.equal(entries[0].href, "http://127.0.0.1:8875/api/prd-workflow/review/1015046/durable");
  assert.equal(entries[0].title, "Issue3 · Android 双端保持 Firebase 初始化");
});

test("different issue documents remain separate", () => {
  const base = {
    label: "方案文档",
    kind: "ai-doc",
    durability: "durable",
  };
  const entries = dedupeConfirmedAiDocs([
    { ...base, href: "file://issue-1/plan.md", issueKey: "issue-1" },
    { ...base, href: "file://issue-2/plan.md", issueKey: "issue-2" },
  ]);

  assert.equal(entries.length, 2);
  assert.notEqual(
    confirmedAiDocIdentity(entries[0]),
    confirmedAiDocIdentity(entries[1]),
  );
});
