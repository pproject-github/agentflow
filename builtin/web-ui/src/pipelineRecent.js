const STORAGE_KEY = "agentflow.pipelineRecent";
const MAX_OPEN_ENTRIES = 50;
const MERGE_LIMIT = 15;

function safeParse(json) {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * @returns {Array<{ flowId: string, flowSource: string, kind: 'opened', at: number }>}
 */
export function loadOpenedEntries() {
  if (typeof localStorage === "undefined") return [];
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return [];
  return safeParse(raw).filter(
    (e) =>
      e &&
      typeof e.flowId === "string" &&
      (e.flowSource === "user" || e.flowSource === "builtin" || e.flowSource === "workspace") &&
      e.kind === "opened" &&
      typeof e.at === "number",
  );
}

/**
 * @param {string} flowId
 * @param {'user'|'builtin'|'workspace'} flowSource
 */
export function recordPipelineOpened(flowId, flowSource) {
  if (typeof localStorage === "undefined") return;
  const at = Date.now();
  const prev = loadOpenedEntries();
  const next = [{ flowId, flowSource, kind: "opened", at }, ...prev.filter((e) => !(e.flowId === flowId && e.flowSource === flowSource))];
  const trimmed = next.slice(0, MAX_OPEN_ENTRIES);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
  } catch {
    /* quota */
  }
}

/**
 * @param {Array<{ id: string, source: string }>} flowsFromApi
 * @param {string} flowId
 * @returns {'user'|'builtin'|'workspace'}
 */
export function resolveFlowSource(flowsFromApi, flowId) {
  const matches = flowsFromApi.filter((f) => f.id === flowId);
  if (matches.length === 0) return "user";
  if (matches.some((f) => (f.source ?? "user") === "user")) return "user";
  if (matches.some((f) => f.source === "workspace")) return "workspace";
  if (matches.some((f) => f.source === "builtin")) return "builtin";
  return matches[0].source ?? "user";
}

/**
 * @param {number} atMs
 * @returns {string}
 */
export function formatRelativeTimeZh(atMs) {
  const now = Date.now();
  const diff = Math.max(0, now - atMs);
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return "刚刚";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = new Date(atMs);
  const today = new Date();
  const yday = new Date(today);
  yday.setDate(yday.getDate() - 1);
  if (d.toDateString() === yday.toDateString()) return "昨天";
  const days = Math.floor(h / 24);
  if (days < 7) return `${days} 天前`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * @param {number} ms
 * @returns {string}
 */
export function formatDurationMsZh(ms) {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return "--";
  if (ms < 1000) return `${Math.max(1, Math.round(ms))} 毫秒`;
  const s = ms / 1000;
  return `${s >= 10 ? Math.round(s) : s.toFixed(1)} 秒`;
}

/**
 * @param {Array<{ flowId: string, at: number }>} runs
 * @param {Array<{ flowId: string, flowSource: string, kind: 'opened', at: number }>} opens
 * @param {Array<{ id: string, source: string }>} flows
 */
export function mergeRecentActivity(runs, opens, flows) {
  /** @type {Array<{ flowId: string, flowSource: string, kind: 'executed'|'opened', at: number }>} */
  const items = [];
  for (const r of runs) {
    if (!r || typeof r.flowId !== "string" || typeof r.at !== "number") continue;
    items.push({
      flowId: r.flowId,
      flowSource: resolveFlowSource(flows, r.flowId),
      kind: "executed",
      at: r.at,
    });
  }
  for (const o of opens) {
    items.push({
      flowId: o.flowId,
      flowSource: o.flowSource,
      kind: "opened",
      at: o.at,
    });
  }
  items.sort((a, b) => b.at - a.at);
  return items.slice(0, MERGE_LIMIT);
}
