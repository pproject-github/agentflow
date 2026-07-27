import assert from "node:assert/strict";
import test from "node:test";

import {
  sortWorkflowIssueLinks,
  workflowIssueIsLogicalParent,
  workflowIssueMrStatus,
  workflowIssueParentKey,
  workflowIssueTreeCount,
} from "../builtin/web-ui/src/prdWorkflowIssuePresentation.js";

test("treats platform all as a logical parent and nests legacy platform children", () => {
  const parent = { key: "remote-config-control", platform: "all" };
  const child = { key: "remote-config-control-android", platform: "android" };
  assert.equal(workflowIssueIsLogicalParent(parent), true);
  assert.equal(
    workflowIssueParentKey(child, [parent.key, child.key]),
    parent.key,
  );
  assert.equal(workflowIssueMrStatus(parent, []).kind, "aggregate");
});

test("prefers explicit source_issue when relating a platform execution item", () => {
  assert.equal(
    workflowIssueParentKey({
      key: "android-execution",
      platform: "android",
      source_issue: "shared-product-rule",
    }, []),
    "shared-product-rule",
  );
});

test("shows a structured reason when implementation MR is not required", () => {
  assert.deepEqual(
    workflowIssueMrStatus({
      platform: "android",
      implementation_not_required: true,
      implementation_not_required_reason: "User confirmed self-test completion without implementation MR evidence.",
    }, [{ label: "GitLab Issue", href: "https://git.example/p/-/issues/12" }]),
    {
      kind: "not-required",
      label: "自测确认，无需实现 MR",
      detail: "",
    },
  );
});

test("distinguishes missing GitLab Issue, pending MR, and linked MR", () => {
  const gitlabIssue = { label: "GitLab Issue", href: "https://git.example/p/-/issues/12" };
  const mergeRequest = { label: "实现 MR", href: "https://git.example/p/-/merge_requests/34" };
  assert.equal(workflowIssueMrStatus({ platform: "android" }, []).kind, "missing-issue");
  assert.equal(workflowIssueMrStatus({ platform: "android" }, [gitlabIssue]).kind, "pending");
  assert.equal(workflowIssueMrStatus({ platform: "android" }, [gitlabIssue, mergeRequest]).kind, "linked");
  assert.deepEqual(sortWorkflowIssueLinks([mergeRequest, gitlabIssue]), [gitlabIssue, mergeRequest]);
});

test("counts parent and nested execution issues", () => {
  assert.equal(workflowIssueTreeCount([
    { children: [{ children: [] }, { children: [] }] },
    { children: [] },
  ]), 4);
});
