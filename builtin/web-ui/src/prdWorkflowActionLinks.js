function text(value) {
  return String(value || "").trim();
}

function sourceKind(value) {
  if (typeof value === "string") return text(value).toLowerCase();
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return text(value.kind || value.type || value.persistence || value.durability).toLowerCase();
}

function artifactKey(link) {
  return text(link?.key || link?.artifactKey || link?.artifact_key);
}

function reviewUrl(link) {
  return text(
    link?.canonicalUrl
    || link?.canonical_url
    || link?.reviewUrl
    || link?.review_url
    || link?.href
    || link?.url,
  );
}

function normalizedUrl(value) {
  const raw = text(value);
  if (!raw) return "";
  try {
    const url = new URL(raw, "http://agentflow.local");
    return `${url.origin}${url.pathname}`;
  } catch {
    return raw.split(/[?#]/)[0];
  }
}

export function canonicalPrdWorkflowStageKey(item = {}) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return "";
  const issue = text(item.issueKey || item.issue_key || item.issue);
  const action = text(item.action || item.actionId || item.action_id);
  const rawStage = text(item.stageKey || item.stage_key || item.stage || item.phase || item.code || action);
  const normalizedStage = rawStage.toLowerCase();
  const tokens = [rawStage, action, item.code, item.type]
    .map((value) => text(value).toLowerCase())
    .filter(Boolean);
  if (!issue) return rawStage || action;
  if (/^(?:issue-plan|issue-gitlab|implementation|bugfix|integration):/.test(normalizedStage)) return rawStage;
  if (tokens.some((value) => /^code-review(?::|$)/.test(value) || value === "code_review_completed")) {
    return `implementation:${issue}`;
  }
  if (tokens.some((value) => /plan_draft_local|submit-plan|plan-doc/.test(value) || ["plan_mr", "plan_approved", "issue-plan"].includes(value))) {
    return `issue-plan:${issue}`;
  }
  if (tokens.some((value) => /gitlab_issue_missing|ensure-gitlab-issue/.test(value) || value === "issue-gitlab")) {
    return `issue-gitlab:${issue}`;
  }
  if (tokens.some((value) => ["fix_mr", "bugfix"].includes(value))) return `bugfix:${issue}`;
  if (tokens.some((value) => ["integration_mr", "integrated", "integration"].includes(value))) return `integration:${issue}`;
  if (tokens.some((value) => [
    "implementation_mr",
    "implementation_done",
    "implementation_merged",
    "impl_mr",
    "impl_done",
    "impl_merged",
    "runtime_marker",
    "status",
    "implementation",
  ].includes(value))) {
    return `implementation:${issue}`;
  }
  return rawStage || action;
}

export function isPrdWorkflowGlobalEvent(item = {}) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return false;
  const type = text(item.type || item.kind).toLowerCase();
  if (type !== "workflow-report") return false;
  const hasAction = Boolean(
    text(item.action || item.actionId || item.action_id || item.actionModel?.key || item.action_model?.key),
  );
  const globalScope = text(item.artifactScope || item.artifact_scope || item.scope).toLowerCase() === "global";
  const aggregateByStage = item.aggregateByStage ?? item.aggregate_by_stage;
  return !hasAction && (globalScope || aggregateByStage === false);
}

export function isPrdWorkflowReviewLink(link) {
  const key = artifactKey(link);
  if (/^prd-review:/i.test(key)) return true;
  if (text(link?.reviewId || link?.review_id)) return true;
  if (/\/api\/prd-workflow\/review\//.test(reviewUrl(link))) return true;

  const href = text(link?.href || link?.url || link?.shortUrl || link?.short_url);
  const kind = text(link?.kind || link?.type).toLowerCase();
  const durability = text(link?.durability).toLowerCase();
  const source = sourceKind(link?.source) || sourceKind(link?.sourceArtifact || link?.source_artifact);
  const hasReviewMetadata = (
    kind === "review"
    || kind === "temporary-review"
    || durability === "temporary"
    || durability === "durable"
    || source === "local-draft"
    || source === "ai-doc"
  );
  return hasReviewMetadata && /\/r\/[A-Za-z0-9_-]{8,32}(?:[?#]|$)/.test(href);
}

function reviewRank(link) {
  const descriptor = [
    link?.label,
    link?.kind,
    link?.type,
    link?.durability,
    sourceKind(link?.source),
  ].map(text).join(" ");
  if (/方案文档/.test(descriptor)) return 50;
  if (/临时/.test(descriptor)) return 40;
  if (/Markdown Review/i.test(descriptor)) return 20;
  if (/预览|review/i.test(descriptor)) return 10;
  return 0;
}

function linkIdentity(link) {
  const key = artifactKey(link);
  if (key) return `key:${key}`;
  if (isPrdWorkflowReviewLink(link)) {
    const canonical = normalizedUrl(reviewUrl(link));
    if (canonical) return `review:${canonical}`;
  }
  return `link:${text(link?.label)}\n${normalizedUrl(link?.href || link?.url)}`;
}

function dedupeLinks(links) {
  const out = [];
  const seen = new Map();
  for (const link of links) {
    if (!link) continue;
    const key = linkIdentity(link);
    const index = seen.get(key);
    if (index == null) {
      seen.set(key, out.length);
      out.push(link);
      continue;
    }
    const existing = out[index];
    const preferredLabel = reviewRank(link) >= reviewRank(existing)
      ? text(link?.label) || text(existing?.label)
      : text(existing?.label) || text(link?.label);
    out[index] = {
      ...existing,
      ...link,
      ...(preferredLabel ? { label: preferredLabel } : {}),
    };
  }
  return out;
}

function isTemporaryReview(link) {
  const kind = text(link?.kind || link?.type).toLowerCase();
  const durability = text(link?.durability).toLowerCase();
  const persistence = text(link?.persistence).toLowerCase();
  const source = sourceKind(link?.source) || sourceKind(link?.sourceArtifact || link?.source_artifact);
  const descriptor = [
    link?.label,
    kind,
    durability,
    persistence,
    source,
  ].map(text).join(" ");
  return (
    kind === "temporary-review"
    || durability === "temporary"
    || source === "local-draft"
    || /临时\s*(markdown)?\s*(预览|review)|local[-_ ]?draft/i.test(descriptor)
  );
}

function isDurableReview(link) {
  if (!isPrdWorkflowReviewLink(link) || isTemporaryReview(link)) return false;
  const kind = text(link?.kind || link?.type).toLowerCase();
  const durability = text(link?.durability).toLowerCase();
  const persistence = text(link?.persistence).toLowerCase();
  const source = sourceKind(link?.source) || sourceKind(link?.sourceArtifact || link?.source_artifact);
  const descriptor = [link?.label, kind, durability, persistence, source].map(text).join(" ");
  return (
    kind === "review"
    || durability === "durable"
    || source === "ai-doc"
    || persistence === "ai-doc"
    || /方案文档预览|durable/i.test(descriptor)
  );
}

function isFormalPlanDocument(link) {
  if (isPrdWorkflowReviewLink(link)) return false;
  const kind = text(link?.kind || link?.type).toLowerCase();
  const persistence = text(link?.persistence).toLowerCase();
  const source = sourceKind(link?.source) || sourceKind(link?.sourceArtifact || link?.source_artifact);
  const descriptor = [link?.label, kind].map(text).join(" ");
  return (
    kind === "ai-doc"
    || persistence === "ai-doc"
    || source === "ai-doc"
    || /方案文档|技术方案/.test(descriptor)
  );
}

export function isPrdWorkflowPlanAction(item = {}) {
  const descriptor = [
    item.stage,
    item.stageKey,
    item.stage_key,
    item.action,
    item.id,
    item.title,
  ].map(text).join(" ");
  return (
    /(?:^|[:_-])issue[-_:]?plan(?:$|[:_-])|plan[-_:]?doc|submit[-_:]?plan/i.test(descriptor)
    || /方案(?:文档)?(?:已确认|预览)/.test(descriptor)
  );
}

/**
 * Plan review events are append-only audit history. Action cards should surface
 * the current document, not every historical preview URL accumulated by the
 * runtime event.
 */
export function selectCurrentPrdWorkflowActionLinks(links = [], item = {}) {
  const list = dedupeLinks(Array.isArray(links) ? links : []);
  if (!isPrdWorkflowPlanAction(item)) return list;

  const reviewLinks = list.filter(isPrdWorkflowReviewLink);
  if (reviewLinks.length === 0) return list;

  const durableReviews = reviewLinks.filter(isDurableReview);
  const hasFormalPlan = durableReviews.length > 0 || list.some(isFormalPlanDocument);
  const selectedReview = hasFormalPlan
    ? durableReviews.at(-1)
    : reviewLinks.filter(isTemporaryReview).at(-1);

  return list.filter((link) => !isPrdWorkflowReviewLink(link) || link === selectedReview);
}

/**
 * Merge snapshot/runtime lists by their logical artifact slot. A newer entry
 * with the same stable key replaces stale metadata instead of creating a
 * second chip. Keyless legacy entries retain value-based deduplication.
 */
export function mergePrdWorkflowActionLists(left, right) {
  const out = [];
  const indexByKey = new Map();
  const mergeKeys = (entry) => {
    if (typeof entry === "string") return [`value:${entry}`];
    if (!entry || typeof entry !== "object") return [];
    const keys = [];
    const stableKey = text(entry.key || entry.artifactKey || entry.artifact_key);
    if (stableKey) keys.push(`key:${stableKey}`);
    const canonical = normalizedUrl(
      entry.canonicalUrl
      || entry.canonical_url
      || entry.reviewUrl
      || entry.review_url
      || entry.href
      || entry.url,
    );
    if (canonical) keys.push(`url:${canonical}`);
    const path = text(entry.path);
    if (path) keys.push(`path:${path}`);
    if (!keys.length) keys.push(`value:${JSON.stringify(entry)}`);
    return keys;
  };
  const push = (entry) => {
    if (!entry) return;
    const keys = mergeKeys(entry);
    if (!keys.length) return;
    const index = keys.map((key) => indexByKey.get(key)).find((value) => value != null);
    if (index == null) {
      const nextIndex = out.length;
      out.push(entry);
      keys.forEach((key) => indexByKey.set(key, nextIndex));
      return;
    }
    out[index] = entry;
    mergeKeys(entry).forEach((key) => indexByKey.set(key, index));
  };
  (Array.isArray(left) ? left : []).forEach(push);
  (Array.isArray(right) ? right : []).forEach(push);
  return out;
}
