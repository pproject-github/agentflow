function text(value) {
  return String(value ?? "").trim();
}

function truthyFlag(value) {
  if (value === true) return true;
  return ["true", "yes", "done", "waived", "not_required"].includes(text(value).toLowerCase());
}

function falseFlag(value) {
  if (value === false) return true;
  return ["false", "no", "not_required", "waived"].includes(text(value).toLowerCase());
}

export function workflowIssueKey(issue, fallback = "") {
  return text(issue?.key || issue?.issueKey || issue?.issue_key || issue?.id || fallback);
}

export function workflowIssuePlatform(issue) {
  return text(issue?.platform || "all").toLowerCase() || "all";
}

export function workflowIssueIsLogicalParent(issue) {
  return workflowIssuePlatform(issue) === "all";
}

export function workflowIssueParentKey(issue, availableKeys = []) {
  const explicit = text(
    issue?.sourceIssue
    || issue?.source_issue
    || issue?.parentKey
    || issue?.parent_key
    || issue?.parentIssue
    || issue?.parent_issue
    || issue?.parent,
  );
  if (explicit) return explicit;

  const platform = workflowIssuePlatform(issue);
  const key = workflowIssueKey(issue);
  if (!key || !["android", "ios"].includes(platform)) return "";
  const suffix = `-${platform}`;
  if (!key.endsWith(suffix)) return "";
  const inferred = key.slice(0, -suffix.length);
  return new Set(availableKeys.map((value) => text(value))).has(inferred) ? inferred : "";
}

export function workflowIssueLinkKind(link) {
  const label = text(link?.label).toLowerCase();
  const href = text(link?.href || link?.url).toLowerCase();
  if (/\/merge_requests\/\d+/.test(href) || /\bmr\b|merge request|合并请求|实现 mr|修复 mr|提测 mr|集成 mr/i.test(label)) {
    return "mr";
  }
  if (/\/issues\/\d+/.test(href) || /gitlab issue/i.test(label)) return "issue";
  return "other";
}

export function sortWorkflowIssueLinks(links = []) {
  const rank = { issue: 0, mr: 1, other: 2 };
  return [...links].sort((left, right) => (
    rank[workflowIssueLinkKind(left)] - rank[workflowIssueLinkKind(right)]
  ));
}

function noMrReason(issue) {
  const reason = text(
    issue?.noMrReason
    || issue?.no_mr_reason
    || issue?.mrWaiverReason
    || issue?.mr_waiver_reason
    || issue?.implementationNotRequiredReason
    || issue?.implementation_not_required_reason,
  );
  if (/user confirmed self-test completion without implementation mr evidence/i.test(reason)) {
    return "自测确认，无需实现 MR";
  }
  return reason;
}

export function workflowIssueMrStatus(issue, links = []) {
  if (workflowIssueIsLogicalParent(issue)) {
    return {
      kind: "aggregate",
      label: "双端汇总",
      detail: "由 Android / iOS 端侧 Issue 承接",
    };
  }

  const kinds = links.map(workflowIssueLinkKind);
  if (kinds.includes("mr")) {
    return { kind: "linked", label: "MR 已关联", detail: "" };
  }

  const explicitMrRequired = issue?.mrRequired ?? issue?.mr_required ?? issue?.requiresMr ?? issue?.requires_mr;
  const implementationNotRequired = (
    truthyFlag(issue?.implementationNotRequired)
    || truthyFlag(issue?.implementation_not_required)
    || falseFlag(explicitMrRequired)
  );
  if (implementationNotRequired) {
    return {
      kind: "not-required",
      label: noMrReason(issue) || "无需实现 MR",
      detail: "",
    };
  }

  if (!kinds.includes("issue")) {
    return {
      kind: "missing-issue",
      label: "GitLab Issue 未绑定",
      detail: "端侧执行项应先创建或绑定 GitLab Issue",
    };
  }
  return {
    kind: "pending",
    label: "MR 尚未记录",
    detail: "",
  };
}

export function workflowIssueTreeCount(rows = []) {
  return rows.reduce((total, row) => (
    total + 1 + workflowIssueTreeCount(Array.isArray(row?.children) ? row.children : [])
  ), 0);
}
