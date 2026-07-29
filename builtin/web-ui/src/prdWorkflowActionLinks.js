function text(value) {
  return String(value || "").trim();
}

function sourceKind(value) {
  if (typeof value === "string") return text(value).toLowerCase();
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return text(value.kind || value.type || value.persistence || value.durability).toLowerCase();
}

function isReviewLink(link) {
  return /\/api\/prd-workflow\/review\//.test(text(link?.href || link?.url));
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
  if (!isReviewLink(link) || isTemporaryReview(link)) return false;
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
  if (isReviewLink(link)) return false;
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
  const list = Array.isArray(links) ? links : [];
  if (!isPrdWorkflowPlanAction(item)) return list;

  const reviewLinks = list.filter(isReviewLink);
  if (reviewLinks.length === 0) return list;

  const durableReviews = reviewLinks.filter(isDurableReview);
  const hasFormalPlan = durableReviews.length > 0 || list.some(isFormalPlanDocument);
  const selectedReview = hasFormalPlan
    ? durableReviews.at(-1)
    : reviewLinks.filter(isTemporaryReview).at(-1);

  return list.filter((link) => !isReviewLink(link) || link === selectedReview);
}
