/** Shared stage-outcome helpers for release timeline/pending cards (and Inspector reuse). */

export function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

export function artifactHref(artifact) {
  const bag = asRecord(artifact);
  if (!bag) return "";
  for (const key of ["url", "href", "link", "web_url", "mrUrl", "mr_url"]) {
    const value = bag[key];
    if (typeof value === "string" && /^https?:\/\//i.test(value.trim())) return value.trim();
  }
  return "";
}

export function artifactLabel(artifact) {
  const bag = asRecord(artifact);
  if (!bag) return "产物";
  const typeLabels = {
    merge_request: "合并请求 (MR)",
    notification: "通知记录",
    file: "文件",
    package: "安装包",
    archive: "归档",
  };
  const typed = typeLabels[String(bag.type || bag.kind || "").trim()] || "";
  return String(bag.title || bag.label || bag.name || typed || bag.type || bag.kind || "产物").trim() || "产物";
}

export function inferArtifactsFromText(text, existing = []) {
  const artifacts = [...existing];
  const seen = new Set(artifacts.map((item) => artifactHref(item)).filter(Boolean));
  const source = String(text || "");
  for (const match of source.matchAll(/https?:\/\/[^\s)'"，。；]+/g)) {
    const href = match[0].replace(/[),.，。；]+$/g, "");
    if (!href || seen.has(href)) continue;
    seen.add(href);
    const isMr = /merge_requests?\//i.test(href);
    artifacts.push({ type: isMr ? "merge_request" : "link", url: href, title: isMr ? "合并请求 (MR)" : "相关链接" });
  }
  for (const match of source.matchAll(/\bMR\s*!(\d+)\b/gi)) {
    const iid = match[1];
    const already = artifacts.some((item) => String(artifactHref(item) || "").includes(`/merge_requests/${iid}`));
    if (already) continue;
    artifacts.push({ type: "merge_request", title: `合并请求 (MR !${iid})`, state: /merged/i.test(source) ? "merged" : undefined });
  }
  return artifacts;
}

/** Prefer output.summary → details.summary → message (hydrate fields already on item). */
export function resolveStageSummary(item) {
  const output = asRecord(item?.output);
  const details = asRecord(item?.details);
  for (const candidate of [output?.summary, details?.summary, item?.message]) {
    const text = String(candidate || "").trim();
    if (text) return text;
  }
  return "";
}

export function resolveStageArtifacts(item) {
  const output = asRecord(item?.output);
  const details = asRecord(item?.details);
  const listed = [];
  const seen = new Set();
  for (const artifact of [
    ...(Array.isArray(output?.artifacts) ? output.artifacts : []),
    ...(Array.isArray(details?.artifacts) ? details.artifacts : []),
  ]) {
    const href = artifactHref(artifact);
    const key = href || JSON.stringify(artifact);
    if (seen.has(key)) continue;
    seen.add(key);
    listed.push(artifact);
  }
  return inferArtifactsFromText(resolveStageSummary(item), listed);
}

export function resolveWaitingInfo(item) {
  if (String(item?.status || "").toLowerCase() !== "waiting") return null;
  const waiting = asRecord(item?.waiting)
    || asRecord(asRecord(item?.output)?.waiting)
    || asRecord(asRecord(item?.details)?.waiting);
  if (!waiting) return null;
  const reason = String(waiting.reason || "").trim();
  if (!reason) return null;
  const rawUrl = typeof waiting.operator_url === "string" ? waiting.operator_url.trim() : "";
  const operatorUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : "";
  return { reason, operatorUrl };
}

export function truncateSummary(text, max = 120) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}
