function text(value) {
  return String(value || "").trim();
}

function lower(value) {
  return text(value).toLowerCase();
}

function sourceKind(value) {
  if (typeof value === "string") return lower(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return lower(value.kind || value.type || value.persistence || value.durability);
}

function normalizedHref(value, origin = "http://localhost") {
  const href = text(value);
  if (!href) return "";
  try {
    const url = new URL(href, origin);
    return `${url.origin}${url.pathname}`;
  } catch {
    return href.split(/[?#]/)[0];
  }
}

export function isConfirmedAiDocCandidate(candidate = {}) {
  const href = text(candidate.href || candidate.url);
  if (!href) return false;
  const kind = lower(candidate.kind || candidate.type);
  const durability = lower(candidate.durability);
  const persistence = lower(candidate.persistence);
  const truth = lower(candidate.truth || candidate.stateTruth || candidate.state_truth);
  const authority = lower(candidate.authority);
  const source = sourceKind(candidate.source) ||
    sourceKind(candidate.sourceArtifact || candidate.source_artifact);
  const artifactLabel = [
    candidate.label,
    kind,
  ].map(text).join(" ");
  const descriptor = [
    candidate.label,
    candidate.title,
    kind,
    persistence,
    authority,
    source,
    href,
  ].map(text).join(" ");

  if (
    durability === "temporary" ||
    (persistence === "runtime" && source && source !== "ai-doc") ||
    source === "local-draft" ||
    kind === "temporary-review" ||
    /临时\s*(markdown)?\s*(预览|review)|local[-_ ]?draft/i.test(descriptor)
  ) {
    return false;
  }

  const externalArtifact =
    /gitlab[-_ ]?(issue|epic|mr)|merge[-_ ]?request|jenkins|tapd|实现\s*mr|修复\s*mr|提测\s*mr|集成\s*mr|安装包|二维码/i.test(artifactLabel);
  if (externalArtifact) return false;
  const internalSupportArtifact =
    /tapd[-_ ]?(baseline|snapshot)|baseline[-_ ]?snapshot|tapd_snapshot|snapshot_v\d+\.md/i.test(`${artifactLabel} ${href}`);
  if (internalSupportArtifact) return false;

  const documentArtifact =
    /ai[-_ ]?doc|方案文档|技术方案|设计文档|代码审查|code[-_ ]?review|文档预览|markdown[-_ ]?review/i.test(artifactLabel);
  const persistedByAiDoc =
    kind === "ai-doc" ||
    source === "ai-doc" ||
    authority === "ai-doc" ||
    (persistence === "ai-doc" && documentArtifact);
  const durableConfirmedFact =
    truth === "durable_fact" ||
    truth === "project_fact" ||
    candidate.confirmed === true;
  const durable = durability === "durable" || persistedByAiDoc || durableConfirmedFact;
  return persistedByAiDoc && durable;
}

function documentFamily(candidate = {}) {
  const descriptor = [
    candidate.label,
    candidate.kind,
    candidate.title,
    candidate.documentType,
  ].map(text).join(" ");
  if (/技术方案|tech(?:nical)?[-_ ]?design/i.test(descriptor)) return "tech-design";
  if (/方案文档|方案已确认|plan(?:[-_ ]?doc)?/i.test(descriptor)) return "plan";
  if (/代码审查|code[-_ ]?review/i.test(descriptor)) return "code-review";
  if (/设计文档|design[-_ ]?doc/i.test(descriptor)) return "design";
  return "document";
}

export function aiDocArticleTitle(candidate = {}, {
  issueTitle = "",
  requirementTitle = "",
} = {}) {
  const explicitTitle = text(
    candidate.articleTitle ||
    candidate.article_title ||
    candidate.documentTitle ||
    candidate.document_title ||
    candidate.docTitle ||
    candidate.doc_title,
  );
  if (explicitTitle) return explicitTitle;
  if (text(issueTitle)) return text(issueTitle);
  if (documentFamily(candidate) === "tech-design" && text(requirementTitle)) {
    return text(requirementTitle);
  }
  return text(candidate.title || candidate.label);
}

export function confirmedAiDocIdentity(candidate = {}, origin = "http://localhost") {
  const issueKey = text(candidate.issueKey || candidate.issue_key || candidate.issue);
  const family = documentFamily(candidate);
  if (issueKey) return `issue:${issueKey}:${family}`;
  if (family === "tech-design") return "requirement:tech-design";
  const documentPath = text(candidate.documentPath || candidate.document_path || candidate.path);
  if (documentPath) return `path:${documentPath.replace(/\\/g, "/").replace(/\/+/g, "/")}`;
  return `url:${normalizedHref(candidate.href || candidate.url, origin)}`;
}

function candidateRank(candidate = {}) {
  const href = text(candidate.href || candidate.url);
  const kind = lower(candidate.kind || candidate.type);
  const source = sourceKind(candidate.source) ||
    sourceKind(candidate.sourceArtifact || candidate.source_artifact);
  const label = text(candidate.label);
  let rank = 0;
  if (candidate.confirmed === true) rank += 100;
  if (source === "ai-doc") rank += 80;
  if (kind === "ai-doc") rank += 70;
  if (/^https?:\/\//i.test(href)) rank += 30;
  if (/\/api\/prd-workflow\/review\//.test(href)) rank += 20;
  if (!/预览|review/i.test(label)) rank += 10;
  return rank;
}

function titleRank(value) {
  const title = text(value);
  if (!title) return 0;
  const normalized = title.replace(/^Issue\s*\d+\s*/i, "").trim();
  if (/^(方案文档预览|方案文档|技术方案|设计文档|代码审查|Markdown Review|文档预览)$/i.test(normalized)) {
    return 10;
  }
  return 100 + Math.min(title.length, 100);
}

export function dedupeConfirmedAiDocs(candidates = [], origin = "http://localhost") {
  const seen = new Map();
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!isConfirmedAiDocCandidate(candidate)) continue;
    const key = confirmedAiDocIdentity(candidate, origin);
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, candidate);
      continue;
    }
    const preferred = candidateRank(candidate) > candidateRank(existing) ? candidate : existing;
    const alternate = preferred === candidate ? existing : candidate;
    seen.set(key, {
      ...alternate,
      ...preferred,
      title: titleRank(existing.title) >= titleRank(candidate.title)
        ? existing.title
        : candidate.title,
      issueKey: existing.issueKey || candidate.issueKey,
      platform: existing.platform || candidate.platform,
    });
  }
  return Array.from(seen.values());
}
