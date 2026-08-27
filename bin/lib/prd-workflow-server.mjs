/**
 * PRD workflow 服务端子系统。
 *
 * 从 ui-server 原样搬出来的一整块：状态读写、快照物化、运行时事件、评审 HTML 渲染、
 * 看板与分享链接。和 Workspace 那套运行时零耦合——两边共用的只有 HTTP 路由和鉴权，
 * 所以挤在同一个两万行的文件里没有任何理由。
 *
 * 路由处理仍在 ui-server 的 startUiServer 里，这里只提供它调用的函数。
 */

import { parseBool } from "../pipeline/parse-bool.mjs";
import { readAuthUsers } from "./auth.mjs";
import { t } from "./i18n.mjs";
import { getAgentflowDataRoot, getAgentflowUserDataRoot, listAgentflowUserIds } from "./paths.mjs";
import { getPrdWorkflowCollaborationByShareToken, getPrdWorkflowCollaborationForUser, prdWorkflowCollaborationSummary } from "./prd-workflow-collaboration.mjs";
import { getTeamById } from "./teams.mjs";
import { legacyOverallToGlobalState, materializeWorkflowExtensions, materializeWorkflowGlobalState, materializeWorkflowProjections, mergeWorkflowArtifactLists, mergeWorkflowArtifacts, mergeWorkflowGlobalState, removeWorkflowGlobalStatePath, workflowRuntimeRevision, workflowSnapshotResourceVersions } from "./workflow-report.mjs";
import crypto from "crypto";
import fs from "fs";
import path from "path";

import { execFileBuffered } from "./exec-buffered.mjs";
import { htmlEscapeAttribute } from "./html-escape.mjs";
import { runtimeEnvForUser } from "./user-env.mjs";

function prdWorkflowReviewNormalizeText(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function workflowSafeRepoUrl(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    if (parsed.username || parsed.password) {
      parsed.username = "";
      parsed.password = "";
    }
    return parsed.toString();
  } catch {
    return raw;
  }
}

export function workflowKnowledgeSummary(entry = {}) {
  return {
    workspaceId: String(entry.id || "").trim(),
    label: String(entry.label || entry.id || "").trim(),
    kind: String(entry.kind || "local").trim(),
    type: String(entry.type || "code").trim(),
    repoUrl: workflowSafeRepoUrl(entry.repoUrl),
    branch: String(entry.branch || "").trim(),
  };
}

export function workflowConversationPath(workflowId = "", userId = "") {
  const safeWorkflowId = String(workflowId || "").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 100);
  const safeUserId = String(userId || "").replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 100);
  return path.join(getAgentflowDataRoot(), "workflow-conversations", safeWorkflowId, `${safeUserId}.json`);
}

function workflowSnapshotRepositoryRows(snapshot = {}) {
  const candidates = [
    snapshot?.repositories,
    snapshot?.repository,
    snapshot?.globalState?.repositories,
    snapshot?.globalState?.repository,
    snapshot?.global_state?.repositories,
    snapshot?.global_state?.repository,
    snapshot?.globalState?.codeContext?.repositories,
    snapshot?.globalState?.codeContext?.repository,
    snapshot?.globalState?.code_context?.repositories,
    snapshot?.globalState?.code_context?.repository,
    snapshot?.context?.repositories,
    snapshot?.sources?.repositories,
  ];
  return candidates.flatMap((value) => Array.isArray(value) ? value : value && typeof value === "object" ? [value] : []);
}

export function workflowRepositoryRef(snapshot = {}, workspace = {}) {
  const workspaceId = String(workspace.id || "").toLowerCase();
  const repoUrl = String(workspace.repoUrl || "").toLowerCase().replace(/\.git$/, "");
  const label = String(workspace.label || "").toLowerCase();
  const row = workflowSnapshotRepositoryRows(snapshot).find((entry) => {
    const values = [entry?.workspaceId, entry?.workspace_id, entry?.id, entry?.repoUrl, entry?.repo_url, entry?.url, entry?.name, entry?.label]
      .map((value) => String(value || "").toLowerCase().replace(/\.git$/, ""));
    return values.some((value) => value && (value === workspaceId || value === repoUrl || value === label));
  });
  return String(row?.commit || row?.sha || row?.revision || row?.ref || row?.branch || workspace.branch || "HEAD").trim() || "HEAD";
}

export function workflowAuthorityIdentity(value) {
  if (typeof value === "string" || typeof value === "number") return String(value || "").trim();
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  return String(value.username || value.userId || value.user_id || value.nick || value.name || "").trim();
}

export function workflowAuthorityIdentities(value) {
  const values = Array.isArray(value) ? value : value == null ? [] : [value];
  return [...new Set(values.flatMap((item) => {
    if (typeof item === "string") return item.split(/[;,，；]/).map((entry) => entry.trim()).filter(Boolean);
    const identity = workflowAuthorityIdentity(item);
    return identity ? [identity] : [];
  }))];
}

export function prdWorkflowCollaborationSummaryWithUsers(record, userId) {
  const summary = prdWorkflowCollaborationSummary(record, userId);
  if (!summary) return null;
  const users = readAuthUsers();
  return {
    ...summary,
    ownerUsername: String(users[summary.ownerId]?.username || summary.ownerId),
    members: (summary.members || []).map((member) => ({
      ...member,
      username: String(users[member.userId]?.username || member.userId),
    })),
  };
}

export function prdWorkflowShareLinkSummary(record, shareToken, publicBaseUrl, userId = "") {
  const token = String(shareToken || record?.shareToken || "").trim();
  if (!record || !token) return null;
  const query = new URLSearchParams({
    view: "workflow",
    tapdId: String(record.tapdId || ""),
    workflowShare: token,
  });
  const base = String(publicBaseUrl || "").replace(/\/+$/, "");
  const shortUrl = `${base}/w/${encodeURIComponent(token)}`;
  return {
    tapdId: String(record.tapdId || ""),
    url: `${base}/workspace?${query.toString()}`,
    shortUrl,
    active: true,
    readOnly: true,
    createdAt: record.shareCreatedAt || "",
    canManage: String(record.ownerId || "") === String(userId || "").trim().toLowerCase(),
  };
}

export function workflowProjectBindingRows(bindings = [], accessibleProjects = [], userCtx = {}) {
  return (Array.isArray(bindings) ? bindings : []).flatMap((binding) => {
    const workspaceId = String(binding?.workspaceId || "").trim();
    if (!workspaceId) return [];
    const project = accessibleProjects.find((flow) => String(flow?.collaboration?.id || "") === workspaceId);
    if (!project) return [];
    const role = String(project.collaboration?.role || "");
    return [{
      workspaceId,
      flowId: String(project.id || binding.flowId || ""),
      flowSource: String(project.source || binding.flowSource || "user"),
      archived: project.archived === true,
      label: String(project.id || binding.flowId || "Project"),
      description: String(project.description || ""),
      role: role || ((project.source || "user") === "user" ? "owner" : "editor"),
      canManage: role === "owner" || role === "editor" || (!role && (project.source || "user") === "user"),
      boundBy: String(binding.boundBy || ""),
      boundAt: String(binding.boundAt || ""),
    }];
  });
}

function prdWorkflowDashboardActions(snapshot = {}) {
  const rows = new Map();
  for (const field of ["actions", "workflowActions", "workflow_actions", "timeline", "history"]) {
    for (const item of Array.isArray(snapshot?.[field]) ? snapshot[field] : []) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const key = String(
        item.stageKey
        || item.stage_key
        || item.actionId
        || item.action_id
        || item.id
        || item.action
        || "",
      ).trim();
      if (!key) continue;
      rows.set(key, { ...(rows.get(key) || {}), ...item });
    }
  }
  return Array.from(rows.values());
}

function prdWorkflowDashboardTimestamp(item = {}) {
  for (const value of [
    item.updatedAt,
    item.updated_at,
    item.observedAt,
    item.observed_at,
    item.completedAt,
    item.completed_at,
    item.stageEnteredAt,
    item.stage_entered_at,
    item.actionAt,
    item.action_at,
    item.startedAt,
    item.started_at,
    item.reportedAt,
    item.reported_at,
    item.createdAt,
    item.created_at,
    item.at,
  ]) {
    const timestamp = Date.parse(String(value || ""));
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

export function prdWorkflowDashboardSummary(record, snapshot = {}, userCtx = {}, projectBindings = []) {
  const tapdId = String(record?.tapdId || snapshot?.tapdId || snapshot?.tapd_id || "").trim();
  const collaboration = prdWorkflowCollaborationSummaryWithUsers(record, userCtx?.userId) || {};
  const actions = prdWorkflowDashboardActions(snapshot);
  const doneStatuses = new Set(["done", "complete", "success", "completed", "passed", "observed"]);
  const completedActions = actions.filter((item) => (
    doneStatuses.has(String(item?.status || "").trim().toLowerCase())
  )).length;
  const latestAction = [...actions].sort((left, right) => (
    prdWorkflowDashboardTimestamp(right) - prdWorkflowDashboardTimestamp(left)
  ))[0] || null;
  const issues = Array.isArray(snapshot?.issues)
    ? snapshot.issues
    : Array.isArray(snapshot?.raw?.prd?.issues)
      ? snapshot.raw.prd.issues
      : [];
  const platforms = Array.from(new Set(issues
    .map((issue) => String(issue?.platform || "").trim().toLowerCase())
    .filter(Boolean)));
  const phase = String(snapshot?.phase || "").trim();
  const phaseKey = phase.toLowerCase();
  const state = /blocked|failed|error|conflict/.test(phaseKey)
    ? "blocked"
    : /done|completed|released|closed/.test(phaseKey) || (actions.length > 0 && completedActions === actions.length)
      ? "completed"
      : "active";
  const requirement = snapshot?.overall?.requirement && typeof snapshot.overall.requirement === "object"
    ? snapshot.overall.requirement
    : {};
  const title = String(
    snapshot?.globalState?.title
    || requirement.title
    || requirement.name
    || snapshot?.prd?.title
    || snapshot?.raw?.prd?.title
    || "",
  ).trim();
  const timeline = Array.isArray(snapshot?.projections?.timeline)
    ? snapshot.projections.timeline
        .filter((entry) => entry && typeof entry === "object" && !Array.isArray(entry))
        .map((entry) => ({
          key: String(entry.key || [entry.source, entry.kind, entry.id].filter(Boolean).join(":")),
          kind: String(entry.kind || ""),
          id: String(entry.id || ""),
          title: String(entry.title || entry.label || entry.id || ""),
          date: String(entry.date || ""),
          startDate: String(entry.startDate || entry.start_date || entry.start || ""),
          endDate: String(entry.endDate || entry.end_date || entry.end || entry.date || ""),
          source: String(entry.source || ""),
          dimensions: entry.dimensions && typeof entry.dimensions === "object" && !Array.isArray(entry.dimensions)
            ? entry.dimensions
            : {},
          order: Number.isFinite(Number(entry.order)) ? Number(entry.order) : 0,
        }))
        .filter((entry) => entry.kind && entry.id)
    : [];
  const updatedAtTimestamp = Math.max(
    prdWorkflowDashboardTimestamp(record),
    prdWorkflowDashboardTimestamp(snapshot),
    prdWorkflowDashboardTimestamp(latestAction || {}),
  );
  return {
    id: String(record?.id || ""),
    tapdId,
    title,
    phase,
    state,
    pointer: String(snapshot?.pointer || "").trim(),
    revision: String(snapshot?.revision || "").trim(),
    issueCount: issues.length,
    platforms,
    actionCount: actions.length,
    completedActionCount: completedActions,
    timeline,
    latestAction: latestAction
      ? {
          title: String(latestAction.title || latestAction.label || latestAction.action || latestAction.id || "").trim(),
          status: String(latestAction.status || "").trim(),
          at: prdWorkflowDashboardTimestamp(latestAction) ? new Date(prdWorkflowDashboardTimestamp(latestAction)).toISOString() : "",
        }
      : null,
    role: String(collaboration.role || ""),
    ownerId: String(collaboration.ownerId || ""),
    ownerUsername: String(collaboration.ownerUsername || collaboration.ownerId || ""),
    memberCount: Number(collaboration.memberCount || 0),
    accessSource: String(collaboration.accessSource || ""),
    teamId: String(collaboration.teamId || ""),
    teamName: String(getTeamById(collaboration.teamId)?.name || ""),
    shareActive: collaboration.shareActive === true,
    updatedAt: updatedAtTimestamp ? new Date(updatedAtTimestamp).toISOString() : String(record?.updatedAt || ""),
    projectBindings,
  };
}

function prdWorkflowDashboardTimelineDimensionValues(value) {
  return (Array.isArray(value) ? value : [value])
    .flatMap((item) => Array.isArray(item) ? item : [item])
    .map((item) => String(item ?? "").trim())
    .filter(Boolean);
}

function prdWorkflowDashboardTimelineIdentity(entry = {}) {
  const id = String(entry?.id || "").trim();
  const source = String(entry?.source || "").trim().toLowerCase();
  const kind = String(entry?.kind || "").trim().toLowerCase();
  const dimensions = entry?.dimensions && typeof entry.dimensions === "object" && !Array.isArray(entry.dimensions)
    ? entry.dimensions
    : {};
  const legacyPlatformIdentity = id.match(/^(android|ios|all)[:_-](.+)$/i);
  const declaredPlatforms = [
    ...prdWorkflowDashboardTimelineDimensionValues(dimensions.platform),
    ...prdWorkflowDashboardTimelineDimensionValues(dimensions.platforms),
  ].map((value) => value.toLowerCase());
  if (
    source === "prd-flow"
    && ["version", "iteration"].includes(kind)
    && legacyPlatformIdentity
    && declaredPlatforms.includes(legacyPlatformIdentity[1].toLowerCase())
  ) {
    return legacyPlatformIdentity[2].trim().toLowerCase();
  }
  return id.toLowerCase();
}

function prdWorkflowDashboardTimelineGroupKey(entry = {}) {
  const source = String(entry?.source || "").trim().toLowerCase();
  const kind = String(entry?.kind || "").trim().toLowerCase();
  const identity = prdWorkflowDashboardTimelineIdentity(entry);
  const dimensions = entry?.dimensions && typeof entry.dimensions === "object" && !Array.isArray(entry.dimensions)
    ? entry.dimensions
    : {};
  const nonPlatformDimensions = Object.entries(dimensions)
    .filter(([key]) => !["platform", "platforms", "client", "clients", "os"].includes(String(key).trim().toLowerCase()))
    .map(([key, value]) => [
      String(key).trim().toLowerCase(),
      prdWorkflowDashboardTimelineDimensionValues(value).map((item) => item.toLowerCase()).sort(),
    ])
    .sort(([left], [right]) => left.localeCompare(right));
  if (identity) return JSON.stringify([source, kind, identity, nonPlatformDimensions]);
  return String(entry?.key || [entry?.source, entry?.kind, entry?.id].filter(Boolean).join(":"));
}

function prdWorkflowDashboardMergeTimelineDimensions(current = {}, incoming = {}) {
  const out = {};
  for (const key of new Set([...Object.keys(current || {}), ...Object.keys(incoming || {})])) {
    const values = [
      ...prdWorkflowDashboardTimelineDimensionValues(current?.[key]),
      ...prdWorkflowDashboardTimelineDimensionValues(incoming?.[key]),
    ];
    const unique = Array.from(new Map(values.map((value) => [value.toLowerCase(), value])).values());
    if (unique.length === 1) out[key] = unique[0];
    else if (unique.length > 1) out[key] = unique;
  }
  return out;
}

export function prdWorkflowDashboardTimeline(workflows = []) {
  const buckets = new Map();
  const assignedWorkflowIds = new Set();
  const rows = [...(Array.isArray(workflows) ? workflows : [])].sort((left, right) => {
    const leftAt = Date.parse(String(left?.updatedAt || ""));
    const rightAt = Date.parse(String(right?.updatedAt || ""));
    if (Number.isFinite(leftAt) && Number.isFinite(rightAt)) return leftAt - rightAt;
    if (Number.isFinite(leftAt) !== Number.isFinite(rightAt)) return Number.isFinite(leftAt) ? 1 : -1;
    return String(left?.id || left?.tapdId || "").localeCompare(String(right?.id || right?.tapdId || ""));
  });
  for (const workflow of rows) {
    const workflowId = String(workflow?.id || workflow?.tapdId || "");
    const seen = new Set();
    for (const entry of Array.isArray(workflow?.timeline) ? workflow.timeline : []) {
      const memberKey = String(entry?.key || [entry?.source, entry?.kind, entry?.id].filter(Boolean).join(":"));
      const identity = prdWorkflowDashboardTimelineIdentity(entry);
      const rawId = String(entry?.id || "").trim();
      const projectionId = identity && identity !== rawId.toLowerCase() ? identity : rawId;
      const groupKey = prdWorkflowDashboardTimelineGroupKey(entry);
      if (!memberKey || !groupKey) continue;
      assignedWorkflowIds.add(workflowId);
      const current = buckets.get(groupKey) || {
        key: memberKey,
        kind: String(entry.kind || ""),
        id: identity || String(entry.id || ""),
        projectionId,
        title: String(entry.title || entry.id || ""),
        date: String(entry.date || ""),
        startDate: String(entry.startDate || ""),
        endDate: String(entry.endDate || entry.date || ""),
        source: String(entry.source || ""),
        dimensions: entry.dimensions && typeof entry.dimensions === "object" && !Array.isArray(entry.dimensions)
          ? entry.dimensions
          : {},
        order: Number.isFinite(Number(entry.order)) ? Number(entry.order) : 0,
        workflowCount: 0,
        completedCount: 0,
        blockedCount: 0,
        workflowIds: [],
        memberKeys: [],
      };
      current.kind = String(entry.kind || current.kind);
      current.projectionId = projectionId || current.projectionId;
      current.title = String(entry.title || current.title);
      current.date = String(entry.date || current.date);
      current.startDate = String(entry.startDate || current.startDate);
      current.endDate = String(entry.endDate || entry.date || current.endDate);
      current.source = String(entry.source || current.source);
      current.dimensions = prdWorkflowDashboardMergeTimelineDimensions(current.dimensions, entry.dimensions);
      current.order = Number.isFinite(Number(entry.order)) ? Number(entry.order) : current.order;
      if (!current.memberKeys.includes(memberKey)) current.memberKeys.push(memberKey);
      current.memberKeys.sort();
      current.key = current.memberKeys[0] || memberKey;
      if (!seen.has(groupKey)) {
        seen.add(groupKey);
        current.workflowCount += 1;
        if (workflow?.state === "completed") current.completedCount += 1;
        if (workflow?.state === "blocked") current.blockedCount += 1;
        if (!current.workflowIds.includes(workflowId)) current.workflowIds.push(workflowId);
      }
      buckets.set(groupKey, current);
    }
  }
  const timeline = Array.from(buckets.values()).sort((left, right) => {
    const leftAt = Date.parse(String(left.date || ""));
    const rightAt = Date.parse(String(right.date || ""));
    const leftValid = Number.isFinite(leftAt);
    const rightValid = Number.isFinite(rightAt);
    if (leftValid && rightValid && leftAt !== rightAt) return leftAt - rightAt;
    if (leftValid !== rightValid) return leftValid ? -1 : 1;
    if (left.order !== right.order) return left.order - right.order;
    return left.title.localeCompare(right.title, undefined, { numeric: true, sensitivity: "base" });
  });
  return {
    timeline,
    unassignedCount: rows.filter((workflow) => !assignedWorkflowIds.has(String(workflow?.id || workflow?.tapdId || ""))).length,
  };
}

function prdWorkflowTimelineTimestamp(value, endOfDay = false) {
  const text = String(value || "").trim();
  if (!text) return Number.NaN;
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) return Number.NaN;
  return endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? timestamp + (24 * 60 * 60 * 1000) - 1
    : timestamp;
}

export function prdWorkflowDefaultTimelineKey(timeline = [], now = Date.now()) {
  const rows = (Array.isArray(timeline) ? timeline : [])
    .map((entry) => ({
      entry,
      startAt: prdWorkflowTimelineTimestamp(entry?.startDate || entry?.start),
      endAt: prdWorkflowTimelineTimestamp(entry?.endDate || entry?.end || entry?.date, true),
    }))
    .filter(({ entry, endAt }) => String(entry?.key || "").trim() && Number.isFinite(endAt));
  const active = rows
    .filter(({ startAt, endAt }) => Number.isFinite(startAt) && startAt <= now && now <= endAt)
    .sort((left, right) => left.endAt - right.endAt);
  if (active.length > 0) return String(active[0].entry.key);
  const upcoming = rows
    .filter(({ endAt }) => endAt >= now)
    .sort((left, right) => left.endAt - right.endAt);
  if (upcoming.length > 0) return String(upcoming[0].entry.key);
  const latestPast = rows.sort((left, right) => right.endAt - left.endAt)[0];
  return latestPast ? String(latestPast.entry.key) : "all";
}

function prdWorkflowDashboardSearchValues(workflow = {}) {
  return [
    workflow.tapdId,
    workflow.title,
    workflow.pointer,
    workflow.phase,
    workflow.ownerUsername,
    workflow.latestAction?.title,
    ...(Array.isArray(workflow.timeline) ? workflow.timeline : []).flatMap((entry) => [
      entry?.title,
      entry?.kind,
      entry?.date,
      ...Object.values(entry?.dimensions || {}).flatMap((value) => Array.isArray(value) ? value : [value]),
    ]),
  ];
}

export function prdWorkflowDashboardPage(workflows = [], dashboardTimeline = {}, options = {}) {
  const allWorkflows = Array.isArray(workflows) ? workflows : [];
  const timeline = Array.isArray(dashboardTimeline?.timeline) ? dashboardTimeline.timeline : [];
  const unassignedCount = Number(dashboardTimeline?.unassignedCount || 0);
  const defaultTimelineKey = prdWorkflowDefaultTimelineKey(timeline, options.now);
  const requestedTimelineKey = String(options.timelineKey || "").trim();
  const matchedTimeline = timeline.find((entry) => (
    entry.key === requestedTimelineKey
    || (Array.isArray(entry.memberKeys) && entry.memberKeys.includes(requestedTimelineKey))
  ));
  const selectedTimelineKey = requestedTimelineKey === "all"
    ? "all"
    : requestedTimelineKey === "unassigned" && unassignedCount > 0
      ? "unassigned"
      : matchedTimeline?.key || defaultTimelineKey;
  const selectedTimeline = timeline.find((entry) => entry.key === selectedTimelineKey) || null;
  const selectedWorkflowIds = new Set(
    Array.isArray(selectedTimeline?.workflowIds)
      ? selectedTimeline.workflowIds.map((value) => String(value))
      : [],
  );
  const query = String(options.query || "").trim().toLowerCase();
  const scope = ["owned", "collaborating"].includes(options.scope) ? options.scope : "all";
  const state = ["active", "completed", "blocked"].includes(options.state) ? options.state : "all";
  const filtered = allWorkflows.filter((workflow) => {
    const workflowId = String(workflow?.id || workflow?.tapdId || "");
    if (selectedTimelineKey === "unassigned" && (workflow.timeline || []).length > 0) return false;
    if (selectedTimeline && !selectedWorkflowIds.has(workflowId)) return false;
    if (scope === "owned" && workflow.role !== "owner") return false;
    if (scope === "collaborating" && workflow.role === "owner") return false;
    if (state !== "all" && workflow.state !== state) return false;
    if (query && !prdWorkflowDashboardSearchValues(workflow).some(
      (value) => String(value || "").toLowerCase().includes(query),
    )) return false;
    return true;
  });
  const requestedPageSize = Number.parseInt(String(options.pageSize || "20"), 10);
  const pageSize = [20, 50, 100].includes(requestedPageSize) ? requestedPageSize : 20;
  const total = filtered.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const requestedPage = Number.parseInt(String(options.page || "1"), 10);
  const page = Math.min(totalPages, Math.max(1, Number.isFinite(requestedPage) ? requestedPage : 1));
  const start = (page - 1) * pageSize;
  return {
    workflows: filtered.slice(start, start + pageSize),
    availableCount: allWorkflows.length,
    selectedTimelineKey,
    defaultTimelineKey,
    pagination: {
      page,
      pageSize,
      total,
      totalPages,
      hasPrevious: page > 1,
      hasNext: page < totalPages,
    },
  };
}

export const prdWorkflowSubscribers = new Map();

export const prdWorkflowIdempotency = new Map();

export const prdWorkflowActionLocks = new Map();

const prdWorkflowWriteQueues = new Map();

export const PRD_WORKFLOW_IDEMPOTENCY_MAX = 1000;

const PRD_WORKFLOW_RUNTIME_EVENTS_MAX = 1000;

export async function prdWorkflowAcquireWriteLock(key) {
  const lockKey = String(key || "").trim();
  const previous = prdWorkflowWriteQueues.get(lockKey) || Promise.resolve();
  let releaseCurrent;
  const current = new Promise((resolve) => { releaseCurrent = resolve; });
  prdWorkflowWriteQueues.set(lockKey, current);
  await previous.catch(() => {});
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseCurrent();
    if (prdWorkflowWriteQueues.get(lockKey) === current) prdWorkflowWriteQueues.delete(lockKey);
  };
}

export function prdWorkflowKey(userCtx = {}, flowSource = "user", flowId = "", tapdId = "", shareToken = "") {
  const id = String(tapdId || "").trim();
  const collaboration = getPrdWorkflowCollaborationByShareToken(shareToken)
    || getPrdWorkflowCollaborationForUser(id, userCtx?.userId);
  const adminOwnerId = userCtx?.isAdmin === true ? String(userCtx?.adminOwnerId || "").trim() : "";
  const actorScope = `user:${String(collaboration?.stateOwnerId || collaboration?.ownerId || adminOwnerId || userCtx?.userId || "")}`;
  return [actorScope, id].join("\t");
}

export function prdWorkflowBroadcast(key, event = {}) {
  const set = prdWorkflowSubscribers.get(String(key || ""));
  if (!set || set.size === 0) return;
  const chunk = `data: ${JSON.stringify({ ...event, ts: Date.now() })}\n\n`;
  for (const clientRes of set) {
    try {
      clientRes.write(chunk);
    } catch (_) {}
  }
}

function prdWorkflowCollaborationState(userCtx = {}, flowSource = "user", flowId = "", tapdId = "") {
  const key = prdWorkflowKey(userCtx, flowSource, flowId, tapdId);
  const active = prdWorkflowActionLocks.get(key) || null;
  const subscribers = prdWorkflowSubscribers.get(key);
  const workflowCollaboration = getPrdWorkflowCollaborationForUser(tapdId, userCtx?.userId);
  return {
    subscribers: subscribers ? subscribers.size : 0,
    workflow: prdWorkflowCollaborationSummaryWithUsers(workflowCollaboration, userCtx?.userId),
    activeAction: active ? {
      action: String(active.action || ""),
      tapdId: String(active.tapdId || tapdId || ""),
      title: String(active.title || active.action || ""),
      stage: String(active.stage || ""),
      issueKey: String(active.issueKey || ""),
      startedAt: active.startedAt || 0,
      startedAtIso: active.startedAt ? new Date(active.startedAt).toISOString() : "",
      id: String(active.id || ""),
      userId: String(active.userId || userCtx?.userId || ""),
    } : null,
  };
}

function prdWorkflowCliCandidates(root, scopedRoot) {
  const fromEnv = String(process.env.PRD_FLOW_CLI || "").trim();
  return [
    fromEnv,
    scopedRoot ? path.join(scopedRoot, ".workspace", "prd-flow", "bin", "prd-flow") : "",
    root ? path.join(root, ".workspace", "prd-flow", "bin", "prd-flow") : "",
    scopedRoot ? path.join(scopedRoot, ".agents", "skills", "prd-flow", "bin", "prd-flow") : "",
    root ? path.join(root, ".agents", "skills", "prd-flow", "bin", "prd-flow") : "",
    "prd-flow",
  ].filter(Boolean);
}

function prdWorkflowResolveCli(root, scopedRoot) {
  const candidates = prdWorkflowCliCandidates(root, scopedRoot);
  for (const candidate of candidates) {
    if (candidate === "prd-flow") return { command: candidate, source: "PATH" };
    try {
      if (fs.existsSync(candidate)) return { command: candidate, source: candidate };
    } catch (_) {}
  }
  return { command: "prd-flow", source: "PATH" };
}

function prdWorkflowFallbackSnapshot(tapdId, phase, message, patch = {}) {
  const now = new Date().toISOString();
  return {
    tapdId: String(tapdId || ""),
    phase: String(phase || "unavailable"),
    pointer: String(message || "PRD workflow unavailable"),
    revision: "",
    nextAction: null,
    actions: [],
    milestones: [],
    issues: [],
    artifacts: [],
    optionalGaps: [{ severity: "warn", text: String(message || "PRD workflow unavailable") }],
    sources: { checkedAt: now },
    ...patch,
  };
}

function prdWorkflowStableValue(value) {
  if (Array.isArray(value)) return value.map((item) => prdWorkflowStableValue(item));
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if ([
        "checkedAt",
        "updatedAt",
        "createdAt",
        "clientReportedAt",
        "cacheUpdatedAt",
        "runtimeEventsUpdatedAt",
        "collaboration",
        "sources",
        "rawOutput",
      ].includes(key)) continue;
      out[key] = prdWorkflowStableValue(value[key]);
    }
    return out;
  }
  return value;
}

export function prdWorkflowRevisionHash(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(prdWorkflowStableValue(value)))
    .digest("hex")
    .slice(0, 24);
}

function prdWorkflowSnapshotRevision(snapshot = {}) {
  const explicit = String(snapshot?.revision || snapshot?.prd?.revision || snapshot?.next?.revision || "").trim();
  if (explicit) return explicit;
  return `snap:${prdWorkflowRevisionHash({
    tapdId: snapshot?.tapdId || snapshot?.tapd_id || snapshot?.prd?.tapd_id || "",
    phase: snapshot?.phase || snapshot?.workflow_stage || snapshot?.next?.code || "",
    pointer: snapshot?.pointer || snapshot?.current || snapshot?.status || snapshot?.next?.title || "",
    next: snapshot?.nextAction || snapshot?.next || null,
    actions: snapshot?.actions || snapshot?.workflowActions || snapshot?.workflow_actions || [],
    milestones: snapshot?.milestones || [],
    epics: snapshot?.epics || snapshot?.epicGroups || snapshot?.prd?.epics || [],
    issues: snapshot?.issues || snapshot?.issueGroups || snapshot?.prd?.issues || [],
    artifacts: snapshot?.artifacts || snapshot?.outputs || [],
    prd: snapshot?.prd || null,
  })}`;
}

export function prdWorkflowSafeStateId(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 128) || "unknown";
}

function prdWorkflowReviewIdFromRequest(tapdId, payload = {}, durability = "temporary") {
  if (durability === "temporary") {
    const idempotencyKey = String(payload.idempotencyKey || payload.idempotency_key || "").trim();
    if (!idempotencyKey) return `r-${crypto.randomBytes(5).toString("hex")}`;
    const source = String(payload.source || "agentflow-cli").trim().toLowerCase() || "agentflow-cli";
    const digest = crypto
      .createHash("sha256")
      .update(JSON.stringify({ tapdId: String(tapdId || ""), source, idempotencyKey }))
      .digest("hex")
      .slice(0, 12);
    return `r-${digest}`;
  }
  const requested = String(payload.reviewId || payload.review_id || "").trim();
  if (!requested) return `review_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
  const safeRequested = prdWorkflowSafeStateId(requested);
  if (safeRequested.length <= 48) return safeRequested;
  const stage = String(payload.stage || payload.stageKey || payload.stage_key || "review").trim();
  const action = String(payload.action || payload.actionId || payload.action_id || "").trim();
  const issueKey = String(payload.issueKey || payload.issue_key || payload.issue || "").trim();
  const stageHead = prdWorkflowSafeStateId(stage.split(":")[0] || stage || "review").slice(0, 20);
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify({ tapdId: String(tapdId || ""), requested, stage, action, issueKey }))
    .digest("hex")
    .slice(0, 10);
  return prdWorkflowSafeStateId(["review", tapdId, stageHead, digest].filter(Boolean).join("-")).slice(0, 64);
}

export function prdWorkflowReviewArtifactKey(tapdId, payload = {}) {
  const explicit = String(payload.artifactKey || payload.artifact_key || "").trim();
  if (explicit) return explicit.slice(0, 500);
  const issueKey = prdWorkflowSafeStateId(
    payload.issueKey || payload.issue_key || payload.issue || "global",
  ).toLowerCase();
  const platform = prdWorkflowSafeStateId(payload.platform || "all").toLowerCase();
  const stage = prdWorkflowSafeStateId(
    payload.stage
    || payload.stageKey
    || payload.stage_key
    || payload.action
    || payload.actionId
    || payload.action_id
    || "review",
  ).toLowerCase();
  return [
    "prd-review",
    prdWorkflowSafeStateId(tapdId).toLowerCase(),
    issueKey,
    platform,
    stage,
  ].join(":").slice(0, 500);
}

export function prdWorkflowStatePath(scopedRoot, tapdId) {
  const rootDir = scopedRoot || process.cwd();
  return path.join(rootDir, ".workspace", "prd-flow", "workflow-state", `${prdWorkflowSafeStateId(tapdId)}.json`);
}

export function prdWorkflowCachePath(scopedRoot, tapdId) {
  const rootDir = scopedRoot || process.cwd();
  return path.join(rootDir, ".workspace", "prd-flow", "workflow-state", `${prdWorkflowSafeStateId(tapdId)}.cache.json`);
}

export function prdWorkflowProjectPath(scopedRoot, tapdId) {
  const rootDir = scopedRoot || process.cwd();
  return path.join(rootDir, ".workspace", "prd-flow", "workflow-state", `${prdWorkflowSafeStateId(tapdId)}.project.json`);
}

export function prdWorkflowClientsPath(scopedRoot, tapdId) {
  const rootDir = scopedRoot || process.cwd();
  return path.join(rootDir, ".workspace", "prd-flow", "workflow-state", `${prdWorkflowSafeStateId(tapdId)}.clients.json`);
}

export function prdWorkflowEventsPath(scopedRoot, tapdId) {
  const rootDir = scopedRoot || process.cwd();
  return path.join(rootDir, ".workspace", "prd-flow", "workflow-state", `${prdWorkflowSafeStateId(tapdId)}.events.json`);
}

export function prdWorkflowEventsArchivePath(scopedRoot, tapdId) {
  const rootDir = scopedRoot || process.cwd();
  return path.join(rootDir, ".workspace", "prd-flow", "workflow-state", `${prdWorkflowSafeStateId(tapdId)}.events.archive.jsonl`);
}

export function prdWorkflowAuditPath(scopedRoot, tapdId) {
  const rootDir = scopedRoot || process.cwd();
  return path.join(rootDir, ".workspace", "prd-flow", "workflow-state", `${prdWorkflowSafeStateId(tapdId)}.audit.jsonl`);
}

function prdWorkflowReviewDir(scopedRoot, tapdId) {
  const rootDir = path.resolve(scopedRoot || process.cwd());
  return path.join(rootDir, ".workspace", "prd-flow", "reviews", prdWorkflowSafeStateId(tapdId));
}

function prdWorkflowReviewPaths(scopedRoot, tapdId, reviewId) {
  const dir = prdWorkflowReviewDir(scopedRoot, tapdId);
  const safeId = prdWorkflowSafeStateId(reviewId);
  return {
    dir,
    id: safeId,
    markdownPath: path.join(dir, `${safeId}.md`),
    metaPath: path.join(dir, `${safeId}.json`),
  };
}

function prdWorkflowReviewIndexPath(tapdId, reviewId) {
  return path.join(
    getAgentflowDataRoot(),
    "prd-workflow-review-index",
    prdWorkflowSafeStateId(tapdId),
    `${prdWorkflowSafeStateId(reviewId)}.json`,
  );
}

function prdWorkflowWriteReviewIndex(ownerId, tapdId, reviewId) {
  const indexPath = prdWorkflowReviewIndexPath(tapdId, reviewId);
  const tempPath = `${indexPath}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(tempPath, JSON.stringify({
    version: 1,
    tapdId: String(tapdId || ""),
    reviewId: prdWorkflowSafeStateId(reviewId),
    ownerId: String(ownerId || "").trim(),
    updatedAt: new Date().toISOString(),
  }, null, 2) + "\n", "utf-8");
  fs.renameSync(tempPath, indexPath);
}

function prdWorkflowReadReviewIndex(tapdId, reviewId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(prdWorkflowReviewIndexPath(tapdId, reviewId), "utf-8"));
    if (
      String(parsed?.tapdId || "") !== String(tapdId || "")
      || prdWorkflowSafeStateId(parsed?.reviewId) !== prdWorkflowSafeStateId(reviewId)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function prdWorkflowReviewFileExists(paths) {
  try {
    return fs.existsSync(paths.markdownPath) && fs.statSync(paths.markdownPath).isFile();
  } catch {
    return false;
  }
}

export function prdWorkflowResolveReviewPaths(scopedRoot, tapdId, reviewId) {
  const direct = prdWorkflowReviewPaths(scopedRoot, tapdId, reviewId);
  if (prdWorkflowReviewFileExists(direct)) return direct;

  const indexed = prdWorkflowReadReviewIndex(tapdId, reviewId);
  if (indexed) {
    const indexedPaths = prdWorkflowReviewPaths(
      getAgentflowUserDataRoot(indexed.ownerId || ""),
      tapdId,
      reviewId,
    );
    if (prdWorkflowReviewFileExists(indexedPaths)) return indexedPaths;
  }

  const candidateOwners = ["", ...listAgentflowUserIds()];
  for (const ownerId of candidateOwners) {
    const candidate = prdWorkflowReviewPaths(getAgentflowUserDataRoot(ownerId), tapdId, reviewId);
    if (!prdWorkflowReviewFileExists(candidate)) continue;
    try {
      prdWorkflowWriteReviewIndex(ownerId, tapdId, reviewId);
    } catch (_) {}
    return candidate;
  }
  return direct;
}

export function prdWorkflowMigrateLegacyState(legacyRoot, stateRoot, tapdId) {
  const sourceRoot = path.resolve(legacyRoot || "");
  const destinationRoot = path.resolve(stateRoot || "");
  if (!tapdId || sourceRoot === destinationRoot) return;
  const pairs = [
    [prdWorkflowStatePath(sourceRoot, tapdId), prdWorkflowStatePath(destinationRoot, tapdId)],
    [prdWorkflowCachePath(sourceRoot, tapdId), prdWorkflowCachePath(destinationRoot, tapdId)],
    [prdWorkflowProjectPath(sourceRoot, tapdId), prdWorkflowProjectPath(destinationRoot, tapdId)],
    [prdWorkflowClientsPath(sourceRoot, tapdId), prdWorkflowClientsPath(destinationRoot, tapdId)],
    [prdWorkflowEventsPath(sourceRoot, tapdId), prdWorkflowEventsPath(destinationRoot, tapdId)],
    [prdWorkflowAuditPath(sourceRoot, tapdId), prdWorkflowAuditPath(destinationRoot, tapdId)],
  ];
  for (const [source, destination] of pairs) {
    try {
      if (!fs.existsSync(source) || fs.existsSync(destination)) continue;
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    } catch (_) {}
  }
  try {
    const sourceReviews = prdWorkflowReviewDir(sourceRoot, tapdId);
    const destinationReviews = prdWorkflowReviewDir(destinationRoot, tapdId);
    if (fs.existsSync(sourceReviews) && !fs.existsSync(destinationReviews)) {
      fs.mkdirSync(path.dirname(destinationReviews), { recursive: true });
      fs.cpSync(sourceReviews, destinationReviews, { recursive: true, errorOnExist: false });
    }
  } catch (_) {}
}

function prdWorkflowReviewShortLinkDir(root) {
  return path.join(path.resolve(root || process.cwd()), ".workspace", "prd-flow", "review-short-links");
}

function prdWorkflowReviewShortLinkPath(root, shortCode) {
  return path.join(
    prdWorkflowReviewShortLinkDir(root),
    `${String(shortCode || "").trim()}.json`,
  );
}

export function prdWorkflowReadReviewShortLink(root, shortCode) {
  const code = String(shortCode || "").trim();
  if (!/^[A-Za-z0-9_-]{8,32}$/.test(code)) return null;
  try {
    const filePath = prdWorkflowReviewShortLinkPath(root, code);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
    const link = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const targetPath = String(link?.targetPath || "").trim();
    if (!targetPath.startsWith("/api/prd-workflow/review/") || /[\r\n]/.test(targetPath)) return null;
    return {
      ...link,
      shortCode: code,
      targetPath,
      filePath,
    };
  } catch {
    return null;
  }
}

export function prdWorkflowCreateReviewShortLink(root, reviewUrl, review = {}) {
  let parsed;
  try {
    parsed = new URL(String(reviewUrl || ""));
  } catch {
    return null;
  }
  const targetPath = `${parsed.pathname}${parsed.search}`;
  if (!targetPath.startsWith("/api/prd-workflow/review/")) return null;
  const digest = crypto.createHash("sha256").update(targetPath).digest("base64url");
  const dir = prdWorkflowReviewShortLinkDir(root);
  fs.mkdirSync(dir, { recursive: true });
  for (let length = 8; length <= 24; length += 2) {
    const shortCode = digest.slice(0, length);
    const existing = prdWorkflowReadReviewShortLink(root, shortCode);
    if (existing && existing.targetPath !== targetPath) continue;
    const link = {
      shortCode,
      targetPath,
      tapdId: String(review?.tapdId || ""),
      reviewId: String(review?.id || ""),
      durability: String(review?.durability || "temporary"),
      expiresAt: String(review?.expiresAt || ""),
      createdAt: String(review?.createdAt || new Date().toISOString()),
    };
    fs.writeFileSync(
      prdWorkflowReviewShortLinkPath(root, shortCode),
      JSON.stringify(link, null, 2) + "\n",
      "utf-8",
    );
    return {
      ...link,
      shortUrl: `${parsed.origin}/r/${shortCode}`,
    };
  }
  throw new Error("Unable to allocate a unique review short code");
}

function prdWorkflowPruneReviews(scopedRoot, tapdId, maxReviews = 200) {
  try {
    const dir = prdWorkflowReviewDir(scopedRoot, tapdId);
    if (!fs.existsSync(dir)) return;
    const now = Date.now();
    const entries = fs.readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const abs = path.join(dir, name);
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(abs).mtimeMs; } catch (_) {}
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(abs, "utf-8")); } catch (_) {}
        const expiresMs = Date.parse(meta?.expiresAt || "");
        return { name, abs, id: name.replace(/\.json$/i, ""), mtimeMs, expiresMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const entry of entries.filter((item) => Number.isFinite(item.expiresMs) && item.expiresMs < now)) {
      try { fs.unlinkSync(entry.abs); } catch (_) {}
      try { fs.unlinkSync(path.join(dir, `${entry.id}.md`)); } catch (_) {}
      try { fs.unlinkSync(prdWorkflowReviewIndexPath(tapdId, entry.id)); } catch (_) {}
    }
    for (const entry of entries.filter((item) => !(Number.isFinite(item.expiresMs) && item.expiresMs < now)).slice(maxReviews)) {
      try { fs.unlinkSync(entry.abs); } catch (_) {}
      try { fs.unlinkSync(path.join(dir, `${entry.id}.md`)); } catch (_) {}
      try { fs.unlinkSync(prdWorkflowReviewIndexPath(tapdId, entry.id)); } catch (_) {}
    }
  } catch (_) {}
}

function prdWorkflowReviewInlineMarkdown(text) {
  const codeSpans = [];
  let escaped = htmlEscapeAttribute(prdWorkflowReviewNormalizeText(text || "")).replace(/`([^`]+)`/g, (_m, code) => {
    const token = `@@CODE${codeSpans.length}@@`;
    codeSpans.push(`<code>${htmlEscapeAttribute(prdWorkflowReviewNormalizeText(code))}</code>`);
    return token;
  });
  escaped = escaped
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]+|file:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  codeSpans.forEach((html, index) => {
    escaped = escaped.replaceAll(`@@CODE${index}@@`, html);
  });
  return escaped;
}

function prdWorkflowReviewSplitFrontmatter(markdown) {
  const text = String(markdown || "");
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!match) return { frontmatter: "", body: text };
  return { frontmatter: match[1].trim(), body: text.slice(match[0].length) };
}

function prdWorkflowReviewStripLegacyMetadata(body) {
  const lines = String(body || "").replace(/\r\n/g, "\n").split("\n");
  const visible = [];
  let fenced = false;
  let hidden = false;
  for (const line of lines) {
    if (!hidden && /^\s*```/.test(line)) {
      fenced = !fenced;
      visible.push(line);
      continue;
    }
    if (!fenced && !hidden && /<!--\s*prd-flow-start\b/.test(line)) {
      hidden = !/prd-flow-end\s*-->/.test(line);
      continue;
    }
    if (hidden) {
      if (/prd-flow-end\s*-->/.test(line)) hidden = false;
      continue;
    }
    visible.push(line);
  }
  return visible.join("\n");
}

function prdWorkflowReviewRenderFrontmatter(frontmatter) {
  if (!String(frontmatter || "").trim()) return "";
  const rows = [];
  const lines = String(frontmatter || "").split(/\r?\n/);
  let current = null;
  const flush = () => {
    if (!current) return;
    let valueHtml = "";
    if (current.items.length) {
      valueHtml = `<ul class="frontmatter-list">${current.items.map((item) => `<li>${prdWorkflowReviewInlineMarkdown(item)}</li>`).join("")}</ul>`;
    } else {
      valueHtml = prdWorkflowReviewInlineMarkdown(current.value);
    }
    rows.push(`<tr><th>${htmlEscapeAttribute(current.key)}</th><td>${valueHtml}</td></tr>`);
    current = null;
  };
  for (const rawLine of lines) {
    const line = String(rawLine || "");
    const keyValue = line.match(/^([^:\s][^:]*):\s*(.*)$/);
    if (keyValue) {
      flush();
      const key = keyValue[1].trim();
      const value = keyValue[2].trim();
      const inlineList = value.match(/^\[(.*)\]$/);
      current = {
        key,
        value: inlineList ? "" : value,
        items: inlineList
          ? inlineList[1].split(",").map((item) => item.trim()).filter(Boolean)
          : [],
      };
      continue;
    }
    const listItem = line.match(/^\s*-\s+(.+)$/);
    if (listItem && current) {
      current.items.push(listItem[1].trim());
      continue;
    }
    if (line.trim()) {
      flush();
      rows.push(`<tr><td colspan="2">${prdWorkflowReviewInlineMarkdown(line.trim())}</td></tr>`);
    }
  }
  flush();
  return `<details class="frontmatter"><summary>文档元数据</summary><table><colgroup><col class="frontmatter-key-column"><col></colgroup>${rows}</table></details>`;
}

function prdWorkflowReviewRenderTable(lines) {
  const splitRow = (line) => String(line || "")
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
  const headers = splitRow(lines[0]);
  const body = lines.slice(2).map(splitRow);
  return [
    '<div class="table-wrap"><table>',
    `<thead><tr>${headers.map((cell) => `<th>${prdWorkflowReviewInlineMarkdown(cell)}</th>`).join("")}</tr></thead>`,
    `<tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${prdWorkflowReviewInlineMarkdown(cell)}</td>`).join("")}</tr>`).join("")}</tbody>`,
    "</table></div>",
  ].join("");
}

function prdWorkflowReviewDedentPlannedCode(lines) {
  const indents = lines
    .filter((line) => String(line || "").trim())
    .map((line) => String(line || "").match(/^\s*/)?.[0]?.length || 0);
  const indent = indents.length ? Math.min(...indents) : 0;
  return lines.map((line) => String(line || "").slice(indent));
}

const PRD_WORKFLOW_REVIEW_CODE_KEYWORDS = new Set([
  "abstract", "as", "async", "await", "break", "case", "catch", "class", "const",
  "continue", "default", "delete", "do", "else", "enum", "export", "extends",
  "final", "finally", "for", "from", "fun", "function", "goto", "if", "implements",
  "import", "in", "instanceof", "interface", "internal", "is", "native", "new",
  "object", "of", "open", "package", "private", "protected", "public", "return",
  "sealed", "static", "strictfp", "super", "switch", "synchronized", "throw",
  "throws", "transient", "try", "typeof", "val", "var", "void", "volatile",
  "when", "while", "with", "yield",
]);

const PRD_WORKFLOW_REVIEW_CODE_LITERALS = new Set([
  "false", "null", "this", "true", "undefined",
]);

const PRD_WORKFLOW_REVIEW_CODE_TYPES = new Set([
  "any", "boolean", "byte", "char", "double", "float", "int", "long", "never",
  "number", "short", "string", "unknown",
]);

function prdWorkflowReviewCodeLanguage(filePath) {
  const extension = String(filePath || "").trim().toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] || "";
  return {
    c: "c",
    cc: "cpp",
    cpp: "cpp",
    cs: "csharp",
    go: "go",
    java: "java",
    js: "javascript",
    json: "json",
    jsx: "jsx",
    kt: "kotlin",
    kts: "kotlin",
    m: "objective-c",
    mm: "objective-cpp",
    py: "python",
    rs: "rust",
    sh: "shell",
    swift: "swift",
    ts: "typescript",
    tsx: "tsx",
  }[extension] || "text";
}

function prdWorkflowReviewSyntaxToken(kind, value) {
  const escaped = htmlEscapeAttribute(prdWorkflowReviewNormalizeText(value));
  return kind ? `<span class="syntax-${kind}">${escaped}</span>` : escaped;
}

function prdWorkflowReviewHighlightCodeLine(line, language, state) {
  const source = prdWorkflowReviewNormalizeText(line);
  let html = "";
  let cursor = 0;
  const isIdentifierStart = (char) => /[A-Za-z_$]/.test(char || "");
  const isIdentifierPart = (char) => /[A-Za-z0-9_$]/.test(char || "");

  while (cursor < source.length) {
    if (state.blockComment) {
      const end = source.indexOf("*/", cursor);
      if (end < 0) {
        html += prdWorkflowReviewSyntaxToken("comment", source.slice(cursor));
        cursor = source.length;
        continue;
      }
      html += prdWorkflowReviewSyntaxToken("comment", source.slice(cursor, end + 2));
      state.blockComment = false;
      cursor = end + 2;
      continue;
    }

    if (source.startsWith("//", cursor) || (
      language === "shell"
      && source[cursor] === "#"
    )) {
      html += prdWorkflowReviewSyntaxToken("comment", source.slice(cursor));
      break;
    }

    if (source.startsWith("/*", cursor)) {
      const end = source.indexOf("*/", cursor + 2);
      if (end < 0) {
        html += prdWorkflowReviewSyntaxToken("comment", source.slice(cursor));
        state.blockComment = true;
        break;
      }
      html += prdWorkflowReviewSyntaxToken("comment", source.slice(cursor, end + 2));
      cursor = end + 2;
      continue;
    }

    const char = source[cursor];
    if (char === "\"" || char === "'" || char === "`") {
      let end = cursor + 1;
      while (end < source.length) {
        if (source[end] === "\\") {
          end += 2;
          continue;
        }
        if (source[end] === char) {
          end += 1;
          break;
        }
        end += 1;
      }
      html += prdWorkflowReviewSyntaxToken("string", source.slice(cursor, end));
      cursor = end;
      continue;
    }

    if (char === "@" && isIdentifierStart(source[cursor + 1])) {
      let end = cursor + 2;
      while (end < source.length && isIdentifierPart(source[end])) end += 1;
      html += prdWorkflowReviewSyntaxToken("annotation", source.slice(cursor, end));
      cursor = end;
      continue;
    }

    if (/[0-9]/.test(char)) {
      const number = source.slice(cursor).match(/^(?:0[xX][\dA-Fa-f_]+|0[bB][01_]+|\d[\d_]*(?:\.\d[\d_]*)?(?:[eE][+-]?\d+)?[fFdDlL]?)/)?.[0] || char;
      html += prdWorkflowReviewSyntaxToken("number", number);
      cursor += number.length;
      continue;
    }

    if (isIdentifierStart(char)) {
      let end = cursor + 1;
      while (end < source.length && isIdentifierPart(source[end])) end += 1;
      const word = source.slice(cursor, end);
      const next = source.slice(end).match(/^\s*(.)/)?.[1] || "";
      let kind = "";
      if (PRD_WORKFLOW_REVIEW_CODE_KEYWORDS.has(word)) kind = "keyword";
      else if (PRD_WORKFLOW_REVIEW_CODE_LITERALS.has(word)) kind = "literal";
      else if (/^[A-Z][A-Z0-9_]*$/.test(word)) kind = "constant";
      else if (PRD_WORKFLOW_REVIEW_CODE_TYPES.has(word) || /^[A-Z][A-Za-z0-9_$]*$/.test(word)) kind = "type";
      else if (next === "(") kind = "function";
      html += prdWorkflowReviewSyntaxToken(kind, word);
      cursor = end;
      continue;
    }

    const operator = source.slice(cursor).match(/^(?:>>>=|===|!==|>>>|<<=|>>=|->|=>|==|!=|<=|>=|&&|\|\||\+\+|--|\+=|-=|\*=|\/=|%=|::|<<|>>|\?\.|\?:)/)?.[0];
    if (operator) {
      html += prdWorkflowReviewSyntaxToken("operator", operator);
      cursor += operator.length;
      continue;
    }
    if (/[+\-*/%=&|!<>?:~^]/.test(char)) {
      html += prdWorkflowReviewSyntaxToken("operator", char);
      cursor += 1;
      continue;
    }
    if (/[()[\]{},.;]/.test(char)) {
      html += prdWorkflowReviewSyntaxToken("punctuation", char);
      cursor += 1;
      continue;
    }

    html += htmlEscapeAttribute(char);
    cursor += 1;
  }

  return html || " ";
}

function prdWorkflowReviewHighlightCodeLines(lines, filePath) {
  const language = prdWorkflowReviewCodeLanguage(filePath);
  const state = { blockComment: false };
  return {
    language,
    lines: lines.map((line) => prdWorkflowReviewHighlightCodeLine(line, language, state)),
  };
}

function prdWorkflowReviewRenderPlannedCode(filePath, codeLines, startLine = 0, endLine = 0) {
  const safePath = htmlEscapeAttribute(
    String(filePath || "").trim().replace(/^`|`$/g, ""),
  );
  const normalizedLines = prdWorkflowReviewDedentPlannedCode(codeLines);
  const highlighted = prdWorkflowReviewHighlightCodeLines(normalizedLines, filePath);
  const firstLine = Number.isFinite(Number(startLine)) && Number(startLine) > 0
    ? Number(startLine)
    : 0;
  const explicitEnd = Number.isFinite(Number(endLine)) && Number(endLine) >= firstLine
    ? Number(endLine)
    : 0;
  const lineLabel = firstLine
    ? `L${firstLine}${explicitEnd && explicitEnd !== firstLine ? `–L${explicitEnd}` : ""}`
    : "拟修改";
  const rows = highlighted.lines.map((line, index) => {
    const lineNumber = firstLine ? String(firstLine + index) : "·";
    return `<span class="planned-code__line"><span class="planned-code__number">${lineNumber}</span><span class="planned-code__text">${line}</span></span>`;
  }).join("");
  return `<section class="planned-code" data-file="${safePath}" data-language="${highlighted.language}">
  <div class="planned-code__header">
    <code class="planned-code__file">${safePath}</code>
    <span class="planned-code__anchor">${htmlEscapeAttribute(lineLabel)}</span>
    <span class="planned-code__badge">计划代码 · 未写入</span>
  </div>
  <pre class="planned-code__body"><code>${rows}</code></pre>
</section>`;
}

const PRD_WORKFLOW_VERIFICATION_FIELDS = {
  "Case ID": "caseId",
  "场景": "scenario",
  "数据准备": "setup",
  "执行步骤": "steps",
  "验证方式": "method",
  "证据定位": "evidenceLocator",
  "预期结果": "expectedResults",
};

const PRD_WORKFLOW_LEGACY_VERIFICATION_FIELDS = {
  "入口": "entry",
  "前置条件": "precondition",
  "观察": "observation",
  "通过标准": "passCriteria",
};

const PRD_WORKFLOW_ALL_VERIFICATION_FIELDS = {
  ...PRD_WORKFLOW_VERIFICATION_FIELDS,
  ...PRD_WORKFLOW_LEGACY_VERIFICATION_FIELDS,
};

function prdWorkflowReviewVerificationBoundary(line) {
  const trimmed = String(line || "").trim();
  return /^#verification\s*$/i.test(trimmed)
    || /^#change\s+(?:add|modify|remove|move)\s*$/i.test(trimmed)
    || /^#file\s+.+$/i.test(trimmed)
    || Boolean(prdWorkflowReviewActionLine(line));
}

function prdWorkflowReviewVerificationContent(lines = []) {
  const source = Array.isArray(lines) ? [...lines] : [];
  while (source.length && !String(source[0] || "").trim()) source.shift();
  while (source.length && !String(source[source.length - 1] || "").trim()) source.pop();
  if (source.length <= 1) return source;
  return [source[0], ...prdWorkflowReviewDedentPlannedCode(source.slice(1))];
}

function prdWorkflowReviewVerificationScalar(lines = []) {
  return prdWorkflowReviewVerificationContent(lines)
    .map((line) => String(line || "").trim())
    .filter(Boolean)
    .join(" ");
}

function prdWorkflowReviewVerificationList(lines = []) {
  const items = [];
  for (const line of prdWorkflowReviewVerificationContent(lines)) {
    const value = String(line || "");
    const item = value.match(/^\s*(?:[-*]|\d+[.)])\s+(?:\[(?: |x|X)\]\s+)?(.+)$/);
    if (item) {
      items.push(item[1].trim());
      continue;
    }
    const continuation = value.trim();
    if (!continuation) continue;
    if (items.length) items[items.length - 1] += ` ${continuation}`;
    else items.push(continuation);
  }
  return items;
}

function prdWorkflowReviewVerificationField(line, fieldIndent) {
  const field = String(line || "").match(
    /^(\s*)-\s*(Case ID|场景|数据准备|执行步骤|验证方式|证据定位|预期结果|入口|前置条件|观察|通过标准)\s*[:：]\s*(.*)$/i,
  );
  if (!field) return null;
  const indent = field[1].length;
  if (fieldIndent != null && indent !== fieldIndent) return null;
  const canonicalLabel = Object.keys(PRD_WORKFLOW_ALL_VERIFICATION_FIELDS)
    .find((label) => label.toLowerCase() === field[2].toLowerCase());
  if (!canonicalLabel) return null;
  return {
    indent,
    key: PRD_WORKFLOW_ALL_VERIFICATION_FIELDS[canonicalLabel],
    value: field[3],
  };
}

function prdWorkflowReviewParseVerificationBlock(lines, startIndex) {
  if (!/^\s*#verification\s*$/i.test(String(lines[startIndex] || ""))) return null;
  const fields = Object.fromEntries(
    Object.values(PRD_WORKFLOW_ALL_VERIFICATION_FIELDS).map((key) => [key, []]),
  );
  let activeField = "";
  let fieldIndent = null;
  let boundaryIndex = lines.length;
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const line = String(lines[i] || "");
    if (/^\s*#verificationend\s*$/i.test(line)) {
      return {
        verification: {
          type: "verification",
          caseId: prdWorkflowReviewVerificationScalar(fields.caseId),
          scenario: prdWorkflowReviewVerificationScalar(fields.scenario),
          setup: prdWorkflowReviewVerificationScalar(fields.setup),
          steps: prdWorkflowReviewVerificationList(fields.steps),
          method: prdWorkflowReviewVerificationScalar(fields.method),
          evidenceLocator: prdWorkflowReviewVerificationList(fields.evidenceLocator),
          expectedResults: prdWorkflowReviewVerificationList(fields.expectedResults),
          entry: prdWorkflowReviewVerificationContent(fields.entry),
          precondition: prdWorkflowReviewVerificationContent(fields.precondition),
          observation: prdWorkflowReviewVerificationContent(fields.observation),
          passCriteria: prdWorkflowReviewVerificationContent(fields.passCriteria),
        },
        complete: true,
        endIndex: i,
      };
    }
    if (prdWorkflowReviewVerificationBoundary(line)) {
      boundaryIndex = i;
      break;
    }
    const field = prdWorkflowReviewVerificationField(line, fieldIndent);
    if (field) {
      if (fieldIndent == null) fieldIndent = field.indent;
      activeField = field.key;
      if (field.value) fields[activeField].push(field.value);
      continue;
    }
    if (activeField) fields[activeField].push(line);
  }
  return {
    verification: null,
    complete: false,
    endIndex: boundaryIndex - 1,
    rawLines: lines.slice(startIndex + 1, boundaryIndex),
  };
}

function prdWorkflowReviewRenderLegacyVerificationBlock(verification) {
  const fields = [
    ["入口", verification.entry],
    ["前置条件", verification.precondition],
    ["观察", verification.observation],
    ["通过标准", verification.passCriteria],
  ];
  const rows = fields.map(([label, content]) => {
    const missing = !Array.isArray(content) || !content.some((line) => String(line || "").trim());
    const value = missing
      ? '<span class="verification-block__missing">未填写</span>'
      : prdWorkflowReviewMarkdownLinesToHtml(content);
    return `<div class="verification-block__field${missing ? " is-missing" : ""}">
  <dt>${htmlEscapeAttribute(label)}</dt>
  <dd>${value}</dd>
</div>`;
  }).join("");
  return `<section class="verification-block" data-solution-block="verification">
  <div class="verification-block__header">
    <span class="verification-block__badge">验证方案</span>
    <span>执行与通过标准</span>
  </div>
  <dl class="verification-block__fields">${rows}</dl>
</section>`;
}

function prdWorkflowReviewRenderVerificationCaseValue(value, kind = "scalar") {
  const values = Array.isArray(value) ? value.filter((item) => String(item || "").trim()) : [];
  if (kind === "scalar") {
    const text = String(value || "").trim();
    return text
      ? `<p>${prdWorkflowReviewInlineMarkdown(text)}</p>`
      : '<span class="verification-block__missing">未填写</span>';
  }
  if (!values.length) return '<span class="verification-block__missing">未填写</span>';
  const tag = kind === "steps" ? "ol" : "ul";
  return `<${tag} class="verification-block__list">${values
    .map((item) => `<li>${prdWorkflowReviewInlineMarkdown(item)}</li>`)
    .join("")}</${tag}>`;
}

function prdWorkflowReviewRenderVerificationCase(verification) {
  const caseId = String(verification.caseId || "").trim();
  const scenario = String(verification.scenario || "").trim();
  const fields = [
    ["数据准备", verification.setup, "scalar"],
    ["执行步骤", verification.steps, "steps"],
    ["验证方式", verification.method, "scalar"],
    ["证据定位", verification.evidenceLocator, "list"],
    ["预期结果", verification.expectedResults, "list"],
  ];
  const rows = fields.map(([label, value, kind]) => {
    const missing = kind === "scalar"
      ? !String(value || "").trim()
      : !Array.isArray(value) || !value.some((item) => String(item || "").trim());
    return `<div class="verification-block__field${missing ? " is-missing" : ""}">
  <dt>${htmlEscapeAttribute(label)}</dt>
  <dd>${prdWorkflowReviewRenderVerificationCaseValue(value, kind)}</dd>
</div>`;
  }).join("");
  return `<section class="verification-block verification-case" data-solution-block="verification">
  <div class="verification-block__header">
    <span class="verification-block__badge">验证用例</span>
    <div class="verification-block__title">
      ${caseId ? `<code>${htmlEscapeAttribute(caseId)}</code>` : '<span class="verification-block__missing">未填写 Case ID</span>'}
      <strong>${scenario ? prdWorkflowReviewInlineMarkdown(scenario) : "未命名场景"}</strong>
    </div>
  </div>
  <dl class="verification-block__fields">${rows}</dl>
</section>`;
}

function prdWorkflowReviewRenderVerificationBlock(verification) {
  const hasVerificationCase = [
    verification.caseId,
    verification.scenario,
    verification.setup,
    verification.method,
    ...(Array.isArray(verification.steps) ? verification.steps : []),
    ...(Array.isArray(verification.evidenceLocator) ? verification.evidenceLocator : []),
    ...(Array.isArray(verification.expectedResults) ? verification.expectedResults : []),
  ].some((value) => String(value || "").trim());
  return hasVerificationCase
    ? prdWorkflowReviewRenderVerificationCase(verification)
    : prdWorkflowReviewRenderLegacyVerificationBlock(verification);
}

function prdWorkflowReviewRenderIncompleteVerification(rawLines = []) {
  const body = prdWorkflowReviewMarkdownLinesToHtml(rawLines);
  return `<section class="verification-block is-incomplete" data-solution-block="verification">
  <div class="verification-block__header">
    <span class="verification-block__badge">验证方案</span>
    <strong>验证块格式不完整</strong>
  </div>
  ${body ? `<div class="verification-block__fallback">${body}</div>` : ""}
</section>`;
}

function prdWorkflowReviewParseChangeIntent(lines, startIndex) {
  const start = String(lines[startIndex] || "")
    .trim()
    .match(/^#change\s+(add|modify|remove|move)\s*$/i);
  if (!start) return null;
  const change = {
    operation: start[1].toLowerCase(),
    target: "",
    module: "",
    file: "",
    symbol: "",
    base: "",
    insertNear: "",
    destination: "",
    references: [],
    annotations: [],
    proposals: [],
  };
  for (let i = startIndex + 1; i < lines.length; i += 1) {
    const trimmed = String(lines[i] || "").trim();
    if (/^#changeend\s*$/i.test(trimmed)) {
      return { change, endIndex: i };
    }
    const simple = trimmed.match(
      /^#(target|module|file|symbol|base|insert-near|destination)\s+(.+?)\s*$/i,
    );
    if (simple) {
      const key = simple[1].toLowerCase();
      const value = simple[2].trim().replace(/^`|`$/g, "");
      if (key === "insert-near") change.insertNear = value;
      else change[key] = value;
      continue;
    }
    const reference = trimmed.match(
      /^#reference\s+line\s*(\d+)(?:\s*-\s*(\d+))?\s*$/i,
    );
    if (reference) {
      const body = [];
      let end = i + 1;
      while (end < lines.length && !/^#referenceend\s*$/i.test(String(lines[end] || "").trim())) {
        body.push(lines[end]);
        end += 1;
      }
      if (end >= lines.length) return null;
      change.references.push({
        startLine: Number(reference[1]),
        endLine: Number(reference[2] || reference[1]),
        lines: body,
      });
      i = end;
      continue;
    }
    const annotation = trimmed.match(
      /^#annotation\s+line\s*(\d+)(?:\s*-\s*(\d+))?\s+(problem|change|preserve)\s*$/i,
    );
    if (annotation) {
      const body = [];
      let end = i + 1;
      while (end < lines.length && !/^#annotationend\s*$/i.test(String(lines[end] || "").trim())) {
        body.push(lines[end]);
        end += 1;
      }
      if (end >= lines.length) return null;
      change.annotations.push({
        startLine: Number(annotation[1]),
        endLine: Number(annotation[2] || annotation[1]),
        type: annotation[3].toLowerCase(),
        lines: body,
      });
      i = end;
      continue;
    }
    const proposal = trimmed.match(/^#proposal\s+(natural|pseudocode|code)\s*$/i);
    if (proposal) {
      const body = [];
      let end = i + 1;
      while (end < lines.length && !/^#proposalend\s*$/i.test(String(lines[end] || "").trim())) {
        body.push(lines[end]);
        end += 1;
      }
      if (end >= lines.length) return null;
      change.proposals.push({
        type: proposal[1].toLowerCase(),
        lines: body,
      });
      i = end;
    }
  }
  return null;
}

function prdWorkflowReviewRenderChangeIntent(change) {
  const operationLabels = {
    add: "新增",
    modify: "修改",
    remove: "删除",
    move: "移动",
  };
  const targetLabels = {
    module: "模块",
    file: "文件",
    class: "类",
    function: "方法",
    code: "代码片段",
  };
  const proposalLabels = {
    natural: "自然语言方案",
    pseudocode: "方案伪代码",
    code: "拟议代码 · 未写入",
  };
  const annotationLabels = {
    problem: "当前问题",
    change: "计划修改",
    preserve: "保持不变",
  };
  const operation = operationLabels[change.operation] || "变更";
  const target = targetLabels[change.target] || "目标";
  const locator = change.module || change.file || "未定位";
  const safeLocator = htmlEscapeAttribute(locator);
  const safeSymbol = htmlEscapeAttribute(change.symbol || "");
  const safeBase = htmlEscapeAttribute(change.base || "");
  const safeInsertNear = htmlEscapeAttribute(change.insertNear || "");
  const safeDestination = htmlEscapeAttribute(change.destination || "");
  const meta = [
    safeBase ? `<span><strong>基于</strong> <code>${safeBase}</code></span>` : "",
    safeInsertNear ? `<span><strong>建议位置</strong> <code>${safeInsertNear}</code> 附近</span>` : "",
    safeDestination ? `<span><strong>移动到</strong> <code>${safeDestination}</code></span>` : "",
  ].filter(Boolean).join("");

  const references = Array.isArray(change.references)
    ? change.references
    : (change.reference ? [change.reference] : []);
  const annotations = Array.isArray(change.annotations) ? change.annotations : [];
  const sourceLanguage = prdWorkflowReviewCodeLanguage(change.file || change.module);
  const sourceLineLabel = (item) => `L${item.startLine}${
    item.endLine !== item.startLine
      ? `–L${item.endLine}`
      : ""
  }`;
  let referenceHtml = "";
  if (references.length) {
    const totalLines = references.reduce(
      (total, reference) => total + Math.max(0, reference.endLine - reference.startLine + 1),
      0,
    );
    const hunks = references.map((reference, referenceIndex) => {
      const normalized = prdWorkflowReviewDedentPlannedCode(reference.lines);
      const highlighted = prdWorkflowReviewHighlightCodeLines(normalized, change.file || change.module);
      const rows = highlighted.lines.map((line, index) => (
        `<span class="change-intent__source-line">`
        + `<span class="change-intent__source-number">${reference.startLine + index}</span>`
        + `<span class="change-intent__source-text">${line}</span>`
        + "</span>"
      )).join("");
      const annotationHtml = annotations
        .filter((annotation) => (
          reference.startLine <= annotation.startLine
          && annotation.endLine <= reference.endLine
        ))
        .map((annotation) => {
          const type = annotation.type || "change";
          const label = annotationLabels[type] || "Review 指引";
          const body = prdWorkflowReviewMarkdownLinesToHtml(
            prdWorkflowReviewDedentPlannedCode(annotation.lines),
          );
          return `<aside class="change-intent__annotation is-${htmlEscapeAttribute(type)}">
  <div class="change-intent__annotation-header">
    <span class="change-intent__annotation-title">Review 指引</span>
    <span class="change-intent__annotation-badge">${htmlEscapeAttribute(label)}</span>
    <span class="change-intent__annotation-anchor">${htmlEscapeAttribute(sourceLineLabel(annotation))}</span>
  </div>
  <div class="change-intent__annotation-body">${body}</div>
</aside>`;
        }).join("");
      return `<section class="change-intent__hunk">
  <div class="change-intent__hunk-header">
    <span>片段 ${referenceIndex + 1}</span>
    <span class="change-intent__line-anchor">${htmlEscapeAttribute(sourceLineLabel(reference))}</span>
  </div>
  <pre class="change-intent__source" data-language="${highlighted.language}"><code>${rows}</code></pre>
  ${annotationHtml}
</section>`;
    }).join("");
    referenceHtml = `<details class="change-intent__context" data-language="${sourceLanguage}" open>
  <summary>
    <span>当前上下文</span>
    <span class="change-intent__context-stats">${references.length} 个片段 · ${totalLines} 行</span>
  </summary>
  <div class="change-intent__hunks">${hunks}</div>
</details>`;
  }

  const proposalsHtml = change.proposals.map((proposal) => {
    const type = proposal.type;
    const label = proposalLabels[type] || "方案";
    const normalized = prdWorkflowReviewDedentPlannedCode(proposal.lines);
    let body = "";
    if (type === "natural") {
      body = `<div class="change-intent__natural">${prdWorkflowReviewMarkdownLinesToHtml(normalized)}</div>`;
    } else if (type === "code") {
      const highlighted = prdWorkflowReviewHighlightCodeLines(normalized, change.file || change.module);
      const rows = highlighted.lines.map((line) => (
        `<span class="change-intent__proposal-line is-code">`
        + '<span class="change-intent__proposal-mark">+</span>'
        + `<span class="change-intent__proposal-text">${line}</span>`
        + "</span>"
      )).join("");
      body = `<pre class="change-intent__proposal-body is-code" data-language="${highlighted.language}"><code>${rows}</code></pre>`;
    } else {
      const rows = normalized.map((line) => (
        `<span class="change-intent__proposal-line">`
        + `<span class="change-intent__proposal-text">${htmlEscapeAttribute(prdWorkflowReviewNormalizeText(line)) || " "}</span>`
        + "</span>"
      )).join("");
      body = `<pre class="change-intent__proposal-body"><code>${rows}</code></pre>`;
    }
    return `<section class="change-intent__proposal is-${htmlEscapeAttribute(type)}">
  <div class="change-intent__proposal-header">
    <span>准备怎么改</span>
    <span class="change-intent__proposal-badge">${htmlEscapeAttribute(label)}</span>
  </div>
  ${body}
</section>`;
  }).join("");

  return `<section class="change-intent is-${htmlEscapeAttribute(change.operation)}" data-operation="${htmlEscapeAttribute(change.operation)}" data-target="${htmlEscapeAttribute(change.target)}">
  <div class="change-intent__header">
    <span class="change-intent__operation">${htmlEscapeAttribute(`${operation}${target}`)}</span>
    <div class="change-intent__locator">
      <code>${safeLocator}</code>
      ${safeSymbol ? `<span aria-hidden="true">›</span><code>${safeSymbol}</code>` : ""}
    </div>
  </div>
  ${meta ? `<div class="change-intent__meta">${meta}</div>` : ""}
  ${referenceHtml}
  ${proposalsHtml}
</section>`;
}

function prdWorkflowReviewMarkdownLinesToHtml(lines) {
  const html = [];
  let paragraph = [];
  let list = null;
  let code = null;
  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${prdWorkflowReviewInlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list?.items?.length) return;
    const tag = list.ordered ? "ol" : "ul";
    const start = list.ordered && list.start !== 1 ? ` start="${list.start}"` : "";
    html.push(`<${tag}${start}>${list.items.map((item) => `<li>${item}</li>`).join("")}</${tag}>`);
    list = null;
  };
  const flushBlocks = () => {
    flushParagraph();
    flushList();
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    const fence = trimmed.match(/^```(\w+)?\s*$/);
    if (code) {
      if (fence) {
        html.push(`<pre><code>${htmlEscapeAttribute(prdWorkflowReviewNormalizeText(code.lines.join("\n")))}</code></pre>`);
        code = null;
      } else {
        code.lines.push(line);
      }
      continue;
    }
    if (fence) {
      flushBlocks();
      code = { lang: fence[1] || "", lines: [] };
      continue;
    }
    if (!trimmed) {
      flushBlocks();
      continue;
    }
    if (/^#verification\s*$/i.test(trimmed)) {
      const parsed = prdWorkflowReviewParseVerificationBlock(lines, i);
      if (parsed) {
        flushBlocks();
        html.push(parsed.complete
          ? prdWorkflowReviewRenderVerificationBlock(parsed.verification)
          : prdWorkflowReviewRenderIncompleteVerification(parsed.rawLines));
        i = parsed.endIndex;
        continue;
      }
    }
    if (/^#change\s+/i.test(trimmed)) {
      const parsed = prdWorkflowReviewParseChangeIntent(lines, i);
      if (parsed) {
        flushBlocks();
        html.push(prdWorkflowReviewRenderChangeIntent(parsed.change));
        i = parsed.endIndex;
        continue;
      }
    }
    const plannedFile = trimmed.match(/^#file\s+(.+?)\s*$/i);
    if (plannedFile) {
      let codeStart = i + 1;
      while (codeStart < lines.length && !String(lines[codeStart] || "").trim()) codeStart += 1;
      const codeDirective = String(lines[codeStart] || "")
        .trim()
        .match(/^#code(?:\s+line\s*(\d+)(?:\s*-\s*(\d+))?)?\s*$/i);
      if (codeDirective) {
        let codeEnd = codeStart + 1;
        const plannedLines = [];
        while (codeEnd < lines.length && !/^#codeend\s*$/i.test(String(lines[codeEnd] || "").trim())) {
          plannedLines.push(lines[codeEnd]);
          codeEnd += 1;
        }
        if (codeEnd < lines.length) {
          flushBlocks();
          html.push(prdWorkflowReviewRenderPlannedCode(
            plannedFile[1],
            plannedLines,
            Number(codeDirective[1] || 0),
            Number(codeDirective[2] || 0),
          ));
          i = codeEnd;
          continue;
        }
      }
    }
    if (/^\|.+\|\s*$/.test(trimmed) && i + 1 < lines.length && /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1].trim())) {
      flushBlocks();
      const tableLines = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && /^\|.+\|\s*$/.test(lines[i].trim())) {
        tableLines.push(lines[i]);
        i += 1;
      }
      i -= 1;
      html.push(prdWorkflowReviewRenderTable(tableLines));
      continue;
    }
    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushBlocks();
      const level = Math.min(6, heading[1].length);
      html.push(`<h${level}>${prdWorkflowReviewInlineMarkdown(heading[2].trim())}</h${level}>`);
      continue;
    }
    const quote = trimmed.match(/^>\s+(.+)$/);
    if (quote) {
      flushBlocks();
      html.push(`<blockquote>${prdWorkflowReviewInlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }
    const listItem = line.match(/^(\s*)([-*]|\d+[.)])\s+(?:\[( |x|X)\]\s+)?(.+)$/);
    if (listItem) {
      flushParagraph();
      const ordered = /^\d/.test(listItem[2]);
      if (list && list.ordered !== ordered) flushList();
      if (!list) {
        list = {
          ordered,
          start: ordered ? Number.parseInt(listItem[2], 10) || 1 : 1,
          indent: listItem[1].length,
          items: [],
        };
      }
      const checked = listItem[3]
        ? `<input type="checkbox" disabled${listItem[3].toLowerCase() === "x" ? " checked" : ""}> `
        : "";
      list.items.push(`${checked}${prdWorkflowReviewInlineMarkdown(listItem[4])}`);
      continue;
    }
    if (list?.items?.length && /^\s{2,}\S/.test(line)) {
      const lastIndex = list.items.length - 1;
      list.items[lastIndex] += ` ${prdWorkflowReviewInlineMarkdown(trimmed)}`;
      continue;
    }
    if (list) flushList();
    paragraph.push(trimmed);
  }
  if (code) html.push(`<pre><code>${htmlEscapeAttribute(prdWorkflowReviewNormalizeText(code.lines.join("\n")))}</code></pre>`);
  flushBlocks();
  return html.join("\n");
}

function prdWorkflowReviewActionLine(line) {
  const match = String(line || "").match(/^\s*[-*]\s+(?:\[( |x|X)\]\s+)?(A\d+|Action\s*\d+)(?=\s|[（(：:.-]|$)(.*)$/i);
  if (!match) return null;
  return {
    checked: match[1] ? match[1].toLowerCase() === "x" : null,
    label: match[2].replace(/\s+/g, " ").toUpperCase(),
    title: String(match[3] || "").replace(/^\s*[-:：]\s*/, "").trim(),
  };
}

function prdWorkflowReviewIsActionsHeading(line) {
  const heading = String(line || "").trim().match(/^(#{1,6})\s+(.+)$/);
  if (!heading) return null;
  const title = heading[2].replace(/[*_`]/g, "").trim();
  if (!/(?:\bTODO\s+Actions?\b|\bActions?\b|待办(?:事项|行动)?|行动项)/i.test(title)) return null;
  return { level: heading[1].length };
}

function prdWorkflowReviewRenderActionSection(lines, sectionIndex) {
  const actionStarts = [];
  lines.forEach((line, index) => {
    const action = prdWorkflowReviewActionLine(line);
    if (action) actionStarts.push({ index, action });
  });
  if (!actionStarts.length) return prdWorkflowReviewMarkdownLinesToHtml(lines);

  const ids = new Map();
  const actions = actionStarts.map(({ index, action }, actionIndex) => {
    const nextStart = actionStarts[actionIndex + 1]?.index ?? lines.length;
    let bodyStart = index + 1;
    const titleParts = [action.title].filter(Boolean);
    while (bodyStart < nextStart) {
      const continuation = String(lines[bodyStart] || "");
      if (!/^\s{2,}\S/.test(continuation) || /^\s*[-*]\s+/.test(continuation) || /^\s*```/.test(continuation)) break;
      titleParts.push(continuation.trim());
      bodyStart += 1;
    }
    const labelId = action.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || actionIndex + 1;
    const baseId = `action-${labelId}${sectionIndex ? `-${sectionIndex + 1}` : ""}`;
    const duplicate = ids.get(baseId) || 0;
    ids.set(baseId, duplicate + 1);
    return {
      ...action,
      id: duplicate ? `${baseId}-${sectionIndex + 1}-${duplicate + 1}` : baseId,
      title: titleParts.join(" ") || action.label,
      body: lines.slice(bodyStart, nextStart),
    };
  });

  const intro = prdWorkflowReviewMarkdownLinesToHtml(lines.slice(0, actionStarts[0].index));
  const navigation = actions.length > 1
    ? `<nav class="action-index" aria-label="Action 快速跳转"><span class="action-index__label">快速跳转</span>${actions.map((action) => `<a href="#${htmlEscapeAttribute(action.id)}">${htmlEscapeAttribute(action.label)}</a>`).join("")}</nav>`
    : "";
  const cards = actions.map((action) => {
    const status = action.checked === null
      ? ""
      : `<span class="action-card__status${action.checked ? " is-complete" : ""}">${action.checked ? "已完成" : "待完成"}</span>`;
    const body = prdWorkflowReviewMarkdownLinesToHtml(action.body);
    return `<section class="action-card${action.checked ? " is-complete" : ""}" id="${htmlEscapeAttribute(action.id)}">
  <div class="action-card__header">
    <span class="action-card__index">${htmlEscapeAttribute(action.label)}</span>
    <h3 class="action-card__title">${prdWorkflowReviewInlineMarkdown(action.title)}</h3>
    ${status}
  </div>
  <div class="action-card__body">${body}</div>
</section>`;
  }).join("\n");
  return [intro, navigation, cards].filter(Boolean).join("\n");
}

function prdWorkflowReviewBodyToHtml(body) {
  const lines = String(body || "").replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let cursor = 0;
  let sectionIndex = 0;
  while (cursor < lines.length) {
    const actionsHeading = prdWorkflowReviewIsActionsHeading(lines[cursor]);
    if (!actionsHeading) {
      const nextHeading = lines.findIndex((line, index) => index > cursor && prdWorkflowReviewIsActionsHeading(line));
      const end = nextHeading >= 0 ? nextHeading : lines.length;
      html.push(prdWorkflowReviewMarkdownLinesToHtml(lines.slice(cursor, end)));
      cursor = end;
      continue;
    }
    let end = cursor + 1;
    while (end < lines.length) {
      const heading = String(lines[end] || "").trim().match(/^(#{1,6})\s+/);
      if (heading && heading[1].length <= actionsHeading.level) break;
      end += 1;
    }
    html.push(prdWorkflowReviewMarkdownLinesToHtml([lines[cursor]]));
    html.push(prdWorkflowReviewRenderActionSection(lines.slice(cursor + 1, end), sectionIndex));
    sectionIndex += 1;
    cursor = end;
  }
  return html.filter(Boolean).join("\n");
}

export function prdWorkflowReviewMarkdownToHtml(markdown) {
  const { frontmatter, body } = prdWorkflowReviewSplitFrontmatter(markdown);
  return [
    prdWorkflowReviewRenderFrontmatter(frontmatter),
    prdWorkflowReviewBodyToHtml(prdWorkflowReviewStripLegacyMetadata(body)),
  ].filter(Boolean).join("\n");
}

function prdWorkflowReviewExtractPageTitle(markdown, fallbackTitle) {
  const { frontmatter, body } = prdWorkflowReviewSplitFrontmatter(markdown);
  const visibleBody = prdWorkflowReviewStripLegacyMetadata(body);
  const lines = String(visibleBody || "").replace(/\r\n/g, "\n").split("\n");
  const firstContentIndex = lines.findIndex((line) => String(line || "").trim());
  const heading = firstContentIndex >= 0
    ? String(lines[firstContentIndex] || "").trim().match(/^#\s+(.+)$/)
    : null;
  if (!heading) {
    return {
      markdown: [
        frontmatter ? `---\n${frontmatter}\n---` : "",
        visibleBody,
      ].filter(Boolean).join("\n\n"),
      title: String(fallbackTitle || "PRD Workflow Review"),
    };
  }

  lines.splice(firstContentIndex, 1);
  const markdownTitle = prdWorkflowReviewNormalizeText(heading[1])
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .trim();
  const bodyWithoutTitle = lines.join("\n").replace(/^\n+/, "");
  return {
    markdown: [
      frontmatter ? `---\n${frontmatter}\n---` : "",
      bodyWithoutTitle,
    ].filter(Boolean).join("\n\n"),
    title: markdownTitle || String(fallbackTitle || "PRD Workflow Review"),
  };
}

export function prdWorkflowReviewHtml(title, markdown, meta = {}) {
  const page = prdWorkflowReviewExtractPageTitle(markdown, title);
  const escapedTitle = htmlEscapeAttribute(page.title);
  const escapedMeta = htmlEscapeAttribute([
    meta.tapdId ? `TAPD ${meta.tapdId}` : "",
    meta.stage ? `stage ${meta.stage}` : "",
    meta.issueKey ? `issue ${meta.issueKey}` : "",
    meta.createdAt || "",
  ].filter(Boolean).join(" · "));
  const durability = String(meta.durability || "").trim().toLowerCase();
  const lifecycle = [
    durability === "temporary" ? "Temporary review link" : durability === "durable" ? "Durable preview" : "",
    meta.expiresAt ? `Expires ${meta.expiresAt}` : "",
    meta.persistence ? `persistence ${meta.persistence}` : "",
  ].filter(Boolean).join(" · ");
  const escapedLifecycle = htmlEscapeAttribute(lifecycle);
  const renderedMarkdown = prdWorkflowReviewMarkdownToHtml(page.markdown);
  const rawHref = htmlEscapeAttribute(meta.rawHref || "?raw=1");
  return `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapedTitle}</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --bg: #1a1b26;
      --panel: #1f2335;
      --panel-strong: #24283b;
      --panel-soft: #292e42;
      --border: #3b4261;
      --border-soft: #30364f;
      --text: #e5e7eb;
      --heading: #f4f4f5;
      --muted: #8b90a0;
      --body: #d4d4d8;
      --link: #7dcfff;
      --interactive: #7aa2f7;
      --purple: #bb9af7;
      --button: #24283b;
      --button-text: #cbd0da;
      --code-bg: #292e42;
      --code-inline: #7dcfff;
      --code-block: #16161e;
      --code-block-text: #e5e7eb;
      --planned-border: rgba(158,206,106,.42);
      --planned-header: rgba(158,206,106,.08);
      --planned-gutter: #565f89;
      --planned-line: rgba(158,206,106,.08);
      --change-border: rgba(122,162,247,.34);
      --change-header: rgba(122,162,247,.08);
      --change-context: #1b1e2b;
      --change-proposal: #202536;
      --change-code: rgba(158,206,106,.08);
      --change-add: #9ece6a;
      --change-modify: #7dcfff;
      --change-remove: #f7768e;
      --change-move: #bb9af7;
      --syntax-comment: #737aa2;
      --syntax-keyword: #bb9af7;
      --syntax-literal: #ff9e64;
      --syntax-type: #2ac3de;
      --syntax-function: #7aa2f7;
      --syntax-string: #9ece6a;
      --syntax-number: #ff9e64;
      --syntax-annotation: #e0af68;
      --syntax-constant: #ff9e64;
      --syntax-operator: #89ddff;
      --syntax-punctuation: #a9b1d6;
      --action-bg: #1f2335;
      --action-header: #24283b;
      --pending-bg: rgba(224,175,104,.10);
      --pending-border: rgba(224,175,104,.34);
      --pending-text: #e0af68;
      --complete-bg: rgba(158,206,106,.10);
      --complete-border: rgba(158,206,106,.34);
      --complete-text: #9ece6a;
      --shadow: rgba(9,10,15,.28);
      background: var(--bg);
    }
    :root[data-theme="light"] {
      color-scheme: light;
      --bg: #e1e2e7;
      --panel: #f3f3f5;
      --panel-strong: #e9e9ed;
      --panel-soft: #dcdfe7;
      --border: #c8cad4;
      --border-soft: #d5d7df;
      --text: #4c505e;
      --heading: #343b58;
      --muted: #7f849c;
      --body: #4c505e;
      --link: #007197;
      --interactive: #2e7de9;
      --purple: #7847bd;
      --button: #e7e8ed;
      --button-text: #4c505e;
      --code-bg: #dcdfe7;
      --code-inline: #007197;
      --code-block: #d5d8e1;
      --code-block-text: #343b58;
      --planned-border: rgba(88,117,57,.34);
      --planned-header: rgba(88,117,57,.08);
      --planned-gutter: #8990a7;
      --planned-line: rgba(88,117,57,.07);
      --change-border: rgba(46,125,233,.28);
      --change-header: rgba(46,125,233,.06);
      --change-context: #eceef3;
      --change-proposal: #e8eaf0;
      --change-code: rgba(88,117,57,.08);
      --change-add: #587539;
      --change-modify: #007197;
      --change-remove: #c64343;
      --change-move: #7847bd;
      --syntax-comment: #8990a7;
      --syntax-keyword: #7847bd;
      --syntax-literal: #965027;
      --syntax-type: #007197;
      --syntax-function: #2e7de9;
      --syntax-string: #587539;
      --syntax-number: #965027;
      --syntax-annotation: #9a5200;
      --syntax-constant: #965027;
      --syntax-operator: #007197;
      --syntax-punctuation: #565a6e;
      --action-bg: #f3f3f5;
      --action-header: #e9e9ed;
      --pending-bg: rgba(177,92,0,.08);
      --pending-border: rgba(177,92,0,.28);
      --pending-text: #9a5200;
      --complete-bg: rgba(88,117,57,.10);
      --complete-border: rgba(88,117,57,.28);
      --complete-text: #587539;
      --shadow: rgba(52,59,88,.10);
    }
    *, *::before, *::after { box-sizing: border-box; }
    html, body { overflow-x: hidden; }
    body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); }
    main { width: min(100%, 1180px); margin: 0 auto; padding: 40px 24px 72px; min-width: 0; }
    header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 22px; }
    h1 { margin: 0 0 10px; font-size: clamp(28px, 4vw, 44px); line-height: 1.12; letter-spacing: -.015em; }
    .meta { margin: 0; color: var(--muted); font-size: 14px; }
    .toolbar { flex: 0 0 auto; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 10px; }
    .raw, .theme-toggle { border: 1px solid var(--border); border-radius: 999px; color: var(--button-text); background: var(--button); padding: 9px 14px; text-decoration: none; font-size: 13px; font-weight: 800; line-height: 1.2; }
    .raw:hover, .theme-toggle:hover { border-color: var(--interactive); color: var(--link); }
    .theme-toggle { cursor: pointer; font-family: inherit; }
    .lifecycle { margin-top: 10px; display: inline-flex; max-width: 100%; border: 1px solid var(--border); border-radius: 999px; background: var(--button); color: var(--muted); padding: 6px 10px; font-size: 12px; font-weight: 800; line-height: 1.35; overflow-wrap: anywhere; }
    article { min-width: 0; border: 0; border-radius: 14px; background: var(--panel); box-shadow: 0 18px 50px var(--shadow); padding: clamp(20px, 4vw, 34px); }
    article > *:first-child { margin-top: 0; }
    article > *:last-child { margin-bottom: 0; }
    h2, h3, h4, h5, h6 { margin: 1.7em 0 .65em; line-height: 1.25; letter-spacing: 0; color: var(--heading); overflow-wrap: anywhere; }
    h2 { padding-bottom: .4rem; border-bottom: 1px solid var(--border-soft); font-size: 1.5rem; }
    h3 { font-size: 1.2rem; }
    p, li, td, th, blockquote { font-size: 15px; line-height: 1.75; overflow-wrap: anywhere; word-break: break-word; }
    p { margin: .75rem 0; color: var(--body); }
    ul, ol { margin: .75rem 0 1.1rem; padding-left: 1.55rem; }
    ol { padding-left: 1.8rem; }
    li { margin: .48rem 0; padding-left: .12rem; color: var(--body); }
    li::marker { color: var(--interactive); font-weight: 750; }
    li input { margin-right: .38rem; transform: translateY(1px); }
    code { display: inline; max-width: 100%; border: 1px solid var(--border-soft); border-radius: 4px; background: color-mix(in srgb, var(--interactive) 8%, transparent); color: var(--code-inline); padding: .06rem .24rem; font-family: "SFMono-Regular", Consolas, monospace; font-size: .9em; white-space: normal; overflow-wrap: anywhere; word-break: break-word; }
    pre { max-width: 100%; overflow: auto; border: 1px solid var(--border); border-radius: 10px; background: var(--code-block); padding: 16px; line-height: 1.65; }
    pre code { border: 0; background: transparent; color: var(--code-block-text); padding: 0; white-space: pre; overflow-wrap: normal; word-break: normal; }
    .planned-code { max-width: 100%; margin: 1rem 0 1.2rem; overflow: hidden; border: 1px solid var(--planned-border); border-radius: 10px; background: var(--code-block); }
    .planned-code__header { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; border-bottom: 1px solid var(--planned-border); background: var(--planned-header); padding: 10px 12px; }
    .planned-code__file { min-width: 0; border: 0; background: transparent; color: var(--link); padding: 0; font-weight: 800; }
    .planned-code__anchor, .planned-code__badge { border: 1px solid var(--border); border-radius: 999px; padding: 3px 8px; color: var(--muted); font: 800 11px/1.35 "SFMono-Regular", Consolas, monospace; }
    .planned-code__badge { margin-left: auto; border-color: var(--planned-border); color: var(--complete-text); }
    .planned-code__body { margin: 0; border: 0; border-radius: 0; padding: 10px 0; font: 500 13px/1.55 "SFMono-Regular", "JetBrains Mono", Consolas, monospace; }
    .planned-code__body code { display: block; font: inherit; }
    .planned-code__line { display: grid; grid-template-columns: 3.75rem minmax(max-content, 1fr); min-height: 1.55em; }
    .planned-code__line:hover { background: var(--planned-line); }
    .planned-code__number { border-right: 1px solid var(--border-soft); color: var(--planned-gutter); padding: 0 .8rem 0 .5rem; text-align: right; user-select: none; }
    .planned-code__text { padding: 0 1rem; white-space: pre; }
    .change-intent { max-width: 100%; margin: 1rem 0 1.2rem; overflow: hidden; border: 1px solid var(--change-border); border-radius: 12px; background: var(--panel-strong); }
    .change-intent__header { display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--change-border); background: var(--change-header); padding: 12px 14px; }
    .change-intent__operation { flex: 0 0 auto; border: 1px solid currentColor; border-radius: 999px; padding: 4px 9px; color: var(--change-modify); font-size: 12px; font-weight: 900; line-height: 1.3; }
    .change-intent.is-add .change-intent__operation { color: var(--change-add); }
    .change-intent.is-remove .change-intent__operation { color: var(--change-remove); }
    .change-intent.is-move .change-intent__operation { color: var(--change-move); }
    .change-intent__locator { min-width: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 6px; color: var(--muted); }
    .change-intent__locator code { border: 0; background: transparent; padding: 0; color: var(--link); font-weight: 800; }
    .change-intent__meta { display: flex; align-items: center; flex-wrap: wrap; gap: 8px 18px; border-bottom: 1px solid var(--border-soft); padding: 9px 14px; color: var(--muted); font-size: 12px; }
    .change-intent__meta span { min-width: 0; overflow-wrap: anywhere; }
    .change-intent__meta strong { color: var(--body); }
    .change-intent__meta code { border: 0; background: transparent; padding: 0; color: var(--muted); }
    .change-intent__context { border-bottom: 1px solid var(--border-soft); background: var(--change-context); }
    .change-intent__context summary { display: flex; align-items: center; justify-content: space-between; gap: 10px; cursor: pointer; padding: 10px 14px; color: var(--body); font-size: 13px; font-weight: 900; list-style-position: inside; }
    .change-intent__context-stats, .change-intent__line-anchor, .change-intent__proposal-badge, .change-intent__annotation-anchor { margin-left: auto; border: 1px solid var(--border); border-radius: 999px; padding: 3px 8px; color: var(--muted); font: 800 11px/1.35 "SFMono-Regular", Consolas, monospace; white-space: nowrap; }
    .change-intent__hunk + .change-intent__hunk { border-top: 8px solid var(--panel-strong); }
    .change-intent__hunk-header { display: flex; align-items: center; gap: 10px; border-top: 1px solid var(--border-soft); padding: 8px 14px; color: var(--muted); font-size: 12px; font-weight: 800; }
    .change-intent__source { margin: 0; border: 0; border-top: 1px solid var(--border-soft); border-radius: 0; padding: 10px 0; background: var(--code-block); font: 500 13px/1.55 "SFMono-Regular", "JetBrains Mono", Consolas, monospace; }
    .change-intent__source code, .change-intent__proposal-body code { display: block; font: inherit; }
    .change-intent__source-line { display: grid; grid-template-columns: 3.75rem minmax(max-content, 1fr); min-height: 1.55em; }
    .change-intent__source-line:hover { background: var(--planned-line); }
    .change-intent__source-number { border-right: 1px solid var(--border-soft); color: var(--planned-gutter); padding: 0 .8rem 0 .5rem; text-align: right; user-select: none; }
    .change-intent__source-text { padding: 0 1rem; white-space: pre; }
    .change-intent__annotation { border-top: 1px solid var(--border-soft); border-left: 3px solid var(--change-modify); background: var(--change-proposal); padding: 10px 14px 11px; }
    .change-intent__annotation.is-problem { border-left-color: var(--change-remove); }
    .change-intent__annotation.is-preserve { border-left-color: var(--change-add); }
    .change-intent__annotation-header { display: flex; align-items: center; flex-wrap: wrap; gap: 8px; color: var(--body); }
    .change-intent__annotation-title { font-size: 12px; font-weight: 900; }
    .change-intent__annotation-badge { border: 1px solid currentColor; border-radius: 999px; color: var(--change-modify); padding: 3px 8px; font-size: 11px; font-weight: 900; line-height: 1.3; }
    .change-intent__annotation.is-problem .change-intent__annotation-badge { color: var(--change-remove); }
    .change-intent__annotation.is-preserve .change-intent__annotation-badge { color: var(--change-add); }
    .change-intent__annotation-body { margin-top: 7px; }
    .change-intent__annotation-body > *:first-child { margin-top: 0; }
    .change-intent__annotation-body > *:last-child { margin-bottom: 0; }
    .change-intent__proposal { background: var(--change-proposal); }
    .change-intent__proposal + .change-intent__proposal { border-top: 1px solid var(--border-soft); }
    .change-intent__proposal-header { display: flex; align-items: center; gap: 10px; padding: 10px 14px; color: var(--heading); font-size: 13px; font-weight: 900; }
    .change-intent__proposal-badge { color: var(--change-modify); }
    .change-intent__proposal.is-code .change-intent__proposal-badge { border-color: var(--complete-border); color: var(--change-add); }
    .change-intent__natural { border-top: 1px solid var(--border-soft); padding: 11px 14px 13px; }
    .change-intent__natural > *:first-child { margin-top: 0; }
    .change-intent__natural > *:last-child { margin-bottom: 0; }
    .change-intent__proposal-body { margin: 0; border: 0; border-top: 1px solid var(--border-soft); border-radius: 0; padding: 11px 14px 13px; background: var(--code-block); font: 500 13px/1.55 "SFMono-Regular", "JetBrains Mono", Consolas, monospace; }
    .change-intent__proposal-line { display: block; min-height: 1.55em; }
    .change-intent__proposal-line.is-code { display: grid; grid-template-columns: 2rem minmax(max-content, 1fr); margin: 0 -14px; padding: 0 14px; background: var(--change-code); }
    .change-intent__proposal-mark { color: var(--change-add); font-weight: 900; text-align: center; user-select: none; }
    .change-intent__proposal-text { white-space: pre; }
    .verification-block { max-width: 100%; margin: 1rem 0 1.2rem; overflow: hidden; border: 1px solid var(--change-border); border-radius: 12px; background: var(--panel-strong); }
    .verification-block__header { display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--change-border); background: var(--change-header); padding: 11px 14px; color: var(--heading); font-size: 13px; font-weight: 900; }
    .verification-block__badge { flex: 0 0 auto; border: 1px solid currentColor; border-radius: 999px; color: var(--change-move); padding: 4px 9px; font-size: 12px; line-height: 1.3; }
    .verification-block__title { min-width: 0; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; }
    .verification-block__title code { color: var(--link); font-weight: 900; }
    .verification-block__title strong { min-width: 0; color: var(--heading); overflow-wrap: anywhere; }
    .verification-block__fields { margin: 0; }
    .verification-block__field { display: grid; grid-template-columns: minmax(7rem, 9rem) minmax(0, 1fr); border-top: 1px solid var(--border-soft); }
    .verification-block__field:first-child { border-top: 0; }
    .verification-block__field dt { background: var(--change-context); color: var(--body); padding: 11px 14px; font-size: 13px; font-weight: 900; }
    .verification-block__field dd { min-width: 0; margin: 0; padding: 10px 14px 12px; color: var(--body); }
    .verification-block__field dd > *:first-child { margin-top: 0; }
    .verification-block__field dd > *:last-child { margin-bottom: 0; }
    .verification-block__list { margin: 0; }
    .verification-block__field.is-missing { opacity: .72; }
    .verification-block__missing { color: var(--muted); font-size: 13px; font-style: italic; }
    .verification-block.is-incomplete { border-color: var(--pending-border); }
    .verification-block.is-incomplete .verification-block__header { border-bottom-color: var(--pending-border); background: var(--pending-bg); color: var(--pending-text); }
    .verification-block.is-incomplete .verification-block__badge { color: var(--pending-text); }
    .verification-block__fallback { padding: 10px 14px 12px; }
    .verification-block__fallback > *:first-child { margin-top: 0; }
    .verification-block__fallback > *:last-child { margin-bottom: 0; }
    .syntax-comment { color: var(--syntax-comment); font-style: italic; }
    .syntax-keyword { color: var(--syntax-keyword); font-weight: 700; }
    .syntax-literal { color: var(--syntax-literal); font-weight: 650; }
    .syntax-type { color: var(--syntax-type); }
    .syntax-function { color: var(--syntax-function); }
    .syntax-string { color: var(--syntax-string); }
    .syntax-number { color: var(--syntax-number); }
    .syntax-annotation { color: var(--syntax-annotation); }
    .syntax-constant { color: var(--syntax-constant); }
    .syntax-operator { color: var(--syntax-operator); }
    .syntax-punctuation { color: var(--syntax-punctuation); }
    blockquote { margin: 1rem 0; border-left: 3px solid var(--purple); background: var(--panel-soft); padding: .75rem 1rem; color: var(--body); }
    a { color: var(--link); text-decoration-thickness: .08em; text-underline-offset: .16em; overflow-wrap: anywhere; }
    .table-wrap { max-width: 100%; overflow-x: auto; margin: 1rem 0 1.25rem; border: 1px solid var(--border-soft); border-radius: 10px; background: var(--panel-strong); }
    table { width: 100%; max-width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { min-width: 0; border-bottom: 1px solid var(--border-soft); padding: .65rem .8rem; text-align: left; vertical-align: top; }
    th { background: var(--panel-soft); color: var(--heading); font-weight: 800; }
    tr:last-child td { border-bottom: 0; }
    .frontmatter { margin: 0 0 1.35rem; border: 1px solid var(--border-soft); border-radius: 10px; background: var(--panel-strong); padding: .75rem .9rem; }
    .frontmatter summary { cursor: pointer; color: var(--body); font-weight: 800; }
    .frontmatter table { min-width: 0; margin-top: .7rem; }
    .frontmatter-key-column { width: clamp(10rem, 22%, 16rem); }
    .frontmatter th { background: var(--panel-soft); color: var(--body); }
    .frontmatter-list { margin: 0; padding-left: 1.1rem; }
    .action-index { position: sticky; top: 10px; z-index: 4; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 1rem 0 1.25rem; border: 1px solid var(--border); border-radius: 12px; background: var(--panel-strong); box-shadow: 0 8px 22px var(--shadow); padding: 10px 12px; }
    .action-index__label { margin-right: 2px; color: var(--muted); font-size: 12px; font-weight: 800; }
    .action-index a { min-width: 38px; border: 1px solid color-mix(in srgb, var(--interactive) 38%, var(--border)); border-radius: 999px; background: color-mix(in srgb, var(--interactive) 10%, var(--button)); color: var(--interactive); padding: 5px 10px; text-align: center; text-decoration: none; font-size: 12px; font-weight: 900; }
    .action-index a:hover { border-color: var(--link); background: color-mix(in srgb, var(--interactive) 18%, var(--button)); color: var(--link); }
    .action-card { scroll-margin-top: 78px; margin: 0 0 20px; overflow: hidden; border: 1px solid var(--border); border-radius: 12px; background: var(--action-bg); box-shadow: 0 8px 24px var(--shadow); }
    .action-card:target { border-color: var(--interactive); box-shadow: 0 0 0 2px color-mix(in srgb, var(--interactive) 18%, transparent), 0 8px 24px var(--shadow); }
    .action-card__header { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; gap: 12px; border-bottom: 1px solid var(--border-soft); background: var(--action-header); padding: 16px 18px; }
    .action-card__index { display: inline-grid; place-items: center; min-width: 42px; min-height: 30px; border: 1px solid color-mix(in srgb, var(--interactive) 34%, var(--border)); border-radius: 8px; background: color-mix(in srgb, var(--interactive) 10%, var(--panel-soft)); color: var(--interactive); font: 900 13px/1 "SFMono-Regular", Consolas, monospace; }
    .action-card__title { margin: 3px 0 0; font-size: 16px; line-height: 1.55; letter-spacing: 0; color: var(--heading); }
    .action-card__status { margin-top: 2px; border: 1px solid var(--pending-border); border-radius: 999px; background: var(--pending-bg); color: var(--pending-text); padding: 5px 9px; font-size: 11px; font-weight: 900; white-space: nowrap; }
    .action-card__status.is-complete { border-color: var(--complete-border); background: var(--complete-bg); color: var(--complete-text); }
    .action-card__body { padding: 15px 20px 20px; }
    .action-card__body > *:first-child { margin-top: 0; }
    .action-card__body > *:last-child { margin-bottom: 0; }
    .action-card__body > ul { margin: 0 0 1rem; padding-left: 1.3rem; }
    .action-card__body > ul > li { margin: .55rem 0; padding-left: .15rem; }
    .action-card__body pre { margin: .9rem 0 1.1rem; }
    @media (max-width: 720px) {
      main { padding: 28px 14px 48px; }
      .change-intent__header { align-items: flex-start; flex-direction: column; }
      .change-intent__locator { width: 100%; }
      .verification-block__field { grid-template-columns: 1fr; }
      .verification-block__field dt { border-bottom: 1px solid var(--border-soft); padding-bottom: 8px; }
      .change-intent__source-line, .planned-code__line { grid-template-columns: 3.25rem minmax(max-content, 1fr); }
      header { display: block; }
      .toolbar { justify-content: flex-start; margin-top: 14px; }
      article { padding: 18px; }
      th, td { padding: .58rem .65rem; }
      .action-index { top: 6px; }
      .action-card__header { grid-template-columns: auto minmax(0, 1fr); padding: 14px; }
      .action-card__status { grid-column: 2; justify-self: start; }
      .action-card__body { padding: 14px 16px 18px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>${escapedTitle}</h1>
        ${escapedMeta ? `<p class="meta">${escapedMeta}</p>` : ""}
        ${escapedLifecycle ? `<p class="lifecycle">${escapedLifecycle}</p>` : ""}
      </div>
      <div class="toolbar">
        <button class="theme-toggle" type="button" data-theme-toggle>明亮模式</button>
        <a class="raw" href="${rawHref}">Raw Markdown</a>
      </div>
    </header>
    <article>${renderedMarkdown}</article>
  </main>
  <script>
    (() => {
      const key = "prd-workflow-review-theme";
      const root = document.documentElement;
      const button = document.querySelector("[data-theme-toggle]");
      const apply = (theme) => {
        root.dataset.theme = theme;
        if (button) button.textContent = theme === "light" ? "暗黑模式" : "明亮模式";
        try { window.localStorage.setItem(key, theme); } catch (_) {}
      };
      let saved = "dark";
      try { saved = window.localStorage.getItem(key) || "dark"; } catch (_) {}
      apply(saved === "light" ? "light" : "dark");
      if (button) button.addEventListener("click", () => apply(root.dataset.theme === "light" ? "dark" : "light"));
    })();
  </script>
</body>
</html>`;
}

export function prdWorkflowCreateReview(scopedRoot, tapdId, payload = {}, urlBase = "", ownerId = "") {
  const content = String(payload.markdown || payload.content || payload.rawOutput || "");
  if (!content.trim()) throw new Error("Missing review markdown");
  if (Buffer.byteLength(content, "utf-8") > 500000) {
    const error = new Error("Review markdown exceeds 500000 bytes");
    error.status = 413;
    throw error;
  }
  const title = String(payload.title || payload.label || "PRD Workflow Review").trim().slice(0, 160) || "PRD Workflow Review";
  const durability = String(payload.durability || (payload.durable === true || payload.permanent === true ? "durable" : "temporary")).trim().toLowerCase() || "temporary";
  if (!["temporary", "durable"].includes(durability)) {
    const error = new Error("durability must be temporary or durable");
    error.status = 400;
    throw error;
  }
  const reviewId = prdWorkflowReviewIdFromRequest(tapdId, payload, durability);
  const paths = prdWorkflowReviewPaths(scopedRoot, tapdId, reviewId);
  const ttlDaysRaw = Number(payload.ttlDays || payload.ttl_days || (durability === "temporary" ? 7 : 0));
  const ttlDays = Number.isFinite(ttlDaysRaw) && ttlDaysRaw > 0 ? ttlDaysRaw : 0;
  const createdAt = new Date();
  const explicitExpiresAt = String(payload.expiresAt || payload.expires_at || "").trim();
  const expiresAt = durability === "temporary"
    ? (explicitExpiresAt || new Date(createdAt.getTime() + ttlDays * 86400000).toISOString())
    : "";
  const meta = {
    id: paths.id,
    tapdId: String(tapdId || ""),
    title,
    stage: String(payload.stage || payload.stageKey || payload.stage_key || "").trim(),
    action: String(payload.action || payload.actionId || payload.action_id || "").trim(),
    issueKey: String(payload.issueKey || payload.issue_key || payload.issue || "").trim(),
    durability,
    persistence: "runtime",
    source: payload.source && typeof payload.source === "object" && !Array.isArray(payload.source)
      ? payload.source
      : {
          kind: durability === "durable" ? "ai-doc" : "local-draft",
          durability,
        },
    ttlDays,
    expiresAt,
    createdAt: createdAt.toISOString(),
  };
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.markdownPath, content.trimEnd() + "\n", "utf-8");
  fs.writeFileSync(paths.metaPath, JSON.stringify(meta, null, 2) + "\n", "utf-8");
  prdWorkflowWriteReviewIndex(ownerId, tapdId, paths.id);
  prdWorkflowPruneReviews(scopedRoot, tapdId);
  prdWorkflowAppendAudit(scopedRoot, tapdId, {
    type: "review-created",
    reviewId: paths.id,
    title,
    stage: meta.stage,
    action: meta.action,
    issueKey: meta.issueKey,
    durability,
    persistence: "runtime",
    sourceKind: String(meta.source?.kind || ""),
    expiresAt,
    contentBytes: Buffer.byteLength(content, "utf-8"),
  });
  const url = `${String(urlBase || "").replace(/\/+$/, "")}/api/prd-workflow/review/${encodeURIComponent(prdWorkflowSafeStateId(tapdId))}/${encodeURIComponent(paths.id)}`;
  return { ...meta, url, markdownPath: paths.markdownPath };
}

function prdWorkflowReadCachedSnapshotFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

export function prdWorkflowReadCachedSnapshot(scopedRoot, tapdId) {
  const cache = prdWorkflowReadCachedSnapshotFile(prdWorkflowCachePath(scopedRoot, tapdId));
  if (cache) return { ...cache, cacheKind: "projection-cache" };
  const legacy = prdWorkflowReadCachedSnapshotFile(prdWorkflowStatePath(scopedRoot, tapdId));
  return legacy ? { ...legacy, cacheKind: "legacy-projection-cache" } : null;
}

function prdWorkflowReadCachedSnapshotWithFallback(root, scopedRoot, tapdId) {
  const scoped = prdWorkflowReadCachedSnapshot(scopedRoot, tapdId);
  if (scoped) return { ...scoped, cacheScope: "scoped", cacheRoot: scopedRoot };
  if (root && path.resolve(root) !== path.resolve(scopedRoot || root)) {
    const global = prdWorkflowReadCachedSnapshot(root, tapdId);
    if (global) return { ...global, cacheScope: "global", cacheRoot: root };
  }
  return null;
}

function prdWorkflowReadJsonFile(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : fallback;
  } catch {
    return fallback;
  }
}

function prdWorkflowWriteJsonFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, filePath);
  return data;
}

export function prdWorkflowAppendAudit(scopedRoot, tapdId, event = {}) {
  try {
    const p = prdWorkflowAuditPath(scopedRoot, tapdId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const entry = {
      at: new Date().toISOString(),
      tapdId: String(tapdId || ""),
      ...event,
    };
    fs.appendFileSync(p, JSON.stringify(entry) + "\n", "utf-8");
  } catch (_) {}
}

function prdWorkflowReadAuditEntries(scopedRoot, tapdId, limit = 500) {
  try {
    const p = prdWorkflowAuditPath(scopedRoot, tapdId);
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, "utf-8")
      .split(/\r?\n/)
      .filter(Boolean)
      .slice(-Math.max(1, Number(limit) || 500))
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function prdWorkflowReadRecentActionAudit(scopedRoot, tapdId, limit = 24) {
  return prdWorkflowReadAuditEntries(scopedRoot, tapdId, 500)
    .filter((item) => item?.type === "snapshot-action-change")
    .slice(-Math.max(1, Number(limit) || 24));
}

function prdWorkflowFirstPointerObservation(scopedRoot, tapdId, snapshot = {}) {
  const phase = String(snapshot?.phase || "").trim();
  const pointer = String(snapshot?.pointer || "").trim();
  if (!phase && !pointer) return "";
  let earliest = "";
  for (const entry of prdWorkflowReadAuditEntries(scopedRoot, tapdId, 5000)) {
    if (entry?.type !== "client-observation-stored") continue;
    if (phase && String(entry.phase || "").trim() !== phase) continue;
    if (pointer && String(entry.pointer || "").trim() !== pointer) continue;
    const candidate = String(entry.observedAt || entry.reportedAt || entry.at || "").trim();
    const candidateTime = Date.parse(candidate);
    if (!Number.isFinite(candidateTime)) continue;
    if (!earliest || candidateTime < Date.parse(earliest)) earliest = candidate;
  }
  return earliest;
}

export function prdWorkflowReadProjectState(scopedRoot, tapdId) {
  return prdWorkflowReadJsonFile(prdWorkflowProjectPath(scopedRoot, tapdId), {
    version: 1,
    tapdId: String(tapdId || ""),
    updatedAt: "",
    snapshot: null,
    conflicts: [],
  });
}

export function prdWorkflowReadProjectStateWithFallback(root, scopedRoot, tapdId) {
  const scoped = prdWorkflowReadProjectState(scopedRoot, tapdId);
  if (scoped?.snapshot) return { ...scoped, cacheScope: "scoped", cacheRoot: scopedRoot };
  if (root && path.resolve(root) !== path.resolve(scopedRoot || root)) {
    const global = prdWorkflowReadProjectState(root, tapdId);
    if (global?.snapshot) return { ...global, cacheScope: "global", cacheRoot: root };
  }
  return scoped?.snapshot ? scoped : null;
}

export function prdWorkflowWriteProjectState(scopedRoot, tapdId, snapshot, patch = {}) {
  const prev = prdWorkflowReadProjectState(scopedRoot, tapdId);
  return prdWorkflowWriteJsonFile(prdWorkflowProjectPath(scopedRoot, tapdId), {
    version: 1,
    tapdId: String(tapdId || ""),
    updatedAt: new Date().toISOString(),
    snapshot,
    conflicts: Array.isArray(patch.conflicts) ? patch.conflicts : Array.isArray(prev.conflicts) ? prev.conflicts : [],
    sources: patch.sources && typeof patch.sources === "object" ? patch.sources : prev.sources || {},
  });
}

export function prdWorkflowReadClientState(scopedRoot, tapdId) {
  const data = prdWorkflowReadJsonFile(prdWorkflowClientsPath(scopedRoot, tapdId), null);
  if (!data) return { version: 1, tapdId: String(tapdId || ""), updatedAt: "", clients: {} };
  const clients = data.clients && typeof data.clients === "object" && !Array.isArray(data.clients)
    ? data.clients
    : {};
  return { ...data, clients };
}

function prdWorkflowReadClientStateWithFallback(root, scopedRoot, tapdId) {
  const merged = { version: 1, tapdId: String(tapdId || ""), updatedAt: "", clients: {} };
  const add = (state, cacheScope) => {
    if (!state?.clients) return;
    if (state.updatedAt && (!merged.updatedAt || Date.parse(state.updatedAt) > Date.parse(merged.updatedAt))) {
      merged.updatedAt = state.updatedAt;
    }
    for (const [clientId, item] of Object.entries(state.clients)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const prev = merged.clients[clientId];
      const itemTime = Date.parse(item.reportedAt || item.observedAt || "");
      const prevTime = Date.parse(prev?.reportedAt || prev?.observedAt || "");
      if (!prev || !Number.isFinite(prevTime) || (Number.isFinite(itemTime) && itemTime >= prevTime)) {
        merged.clients[clientId] = { ...item, cacheScope };
      }
    }
  };
  if (root && path.resolve(root) !== path.resolve(scopedRoot || root)) {
    add(prdWorkflowReadClientState(root, tapdId), "global");
  }
  add(prdWorkflowReadClientState(scopedRoot, tapdId), "scoped");
  return merged;
}

export function prdWorkflowWriteClientObservation(scopedRoot, tapdId, meta, snapshot) {
  const state = prdWorkflowReadClientState(scopedRoot, tapdId);
  const reportSource = String(meta.reportSource || meta.source || "legacy").trim().toLowerCase() || "legacy";
  const clientId = prdWorkflowSafeStateId(`${reportSource}:${meta.clientId || "anonymous"}`);
  const nextClients = {
    ...state.clients,
    [clientId]: {
      clientId: String(meta.clientId || clientId),
      source: reportSource,
      userId: String(meta.userId || ""),
      observedAt: String(meta.observedAt || ""),
      reportedAt: String(meta.reportedAt || new Date().toISOString()),
      revision: String(snapshot?.revision || ""),
      phase: String(snapshot?.phase || ""),
      pointer: String(snapshot?.pointer || ""),
      nextAction: snapshot?.nextAction || null,
      issues: Array.isArray(snapshot?.issues) ? snapshot.issues : [],
      artifacts: Array.isArray(snapshot?.artifacts) ? snapshot.artifacts : [],
      snapshot,
    },
  };
  return prdWorkflowWriteJsonFile(prdWorkflowClientsPath(scopedRoot, tapdId), {
    version: 1,
    tapdId: String(tapdId || ""),
    updatedAt: new Date().toISOString(),
    clients: nextClients,
  });
}

const PRD_WORKFLOW_SNAPSHOT_ACTION_ARRAY_KEYS = [
  "actions",
  "workflowActions",
  "workflow_actions",
  "timeline",
  "history",
];

function prdWorkflowSnapshotActionKey(action = {}) {
  const stageKey = String(
    action.stageKey ||
    action.stage_key ||
    action.stage ||
    action.actionId ||
    action.action_id ||
    action.action ||
    action.id ||
    "",
  ).trim();
  const issueKey = String(action.issueKey || action.issue_key || action.issue || "").trim();
  const platform = String(action.platform || "").trim().toLowerCase();
  return [stageKey, issueKey, platform].filter(Boolean).join("|");
}

function prdWorkflowSnapshotActionTime(action = {}) {
  return String(
    action.stageEnteredAt ||
    action.stage_entered_at ||
    action.time ||
    action.at ||
    action.observedAt ||
    action.observed_at ||
    action.startedAt ||
    action.started_at ||
    action.completedAt ||
    action.completed_at ||
    action.updatedAt ||
    action.updated_at ||
    action.createdAt ||
    action.created_at ||
    "",
  ).trim();
}

function prdWorkflowSnapshotSourceActionTime(action = {}) {
  return String(
    action.time ||
    action.at ||
    action.observedAt ||
    action.observed_at ||
    action.startedAt ||
    action.started_at ||
    action.completedAt ||
    action.completed_at ||
    action.updatedAt ||
    action.updated_at ||
    action.createdAt ||
    action.created_at ||
    "",
  ).trim();
}

function prdWorkflowSnapshotActionMap(snapshot = {}) {
  const out = new Map();
  for (const key of PRD_WORKFLOW_SNAPSHOT_ACTION_ARRAY_KEYS) {
    const rows = Array.isArray(snapshot?.[key]) ? snapshot[key] : [];
    for (const action of rows) {
      if (!action || typeof action !== "object" || Array.isArray(action)) continue;
      const actionKey = prdWorkflowSnapshotActionKey(action);
      if (actionKey && !out.has(actionKey)) out.set(actionKey, action);
    }
  }
  return out;
}

export function prdWorkflowSnapshotActionChanges(previousSnapshot = {}, nextSnapshot = {}) {
  const previous = prdWorkflowSnapshotActionMap(previousSnapshot);
  const next = prdWorkflowSnapshotActionMap(nextSnapshot);
  const changes = [];
  const compact = (kind, action, previousAction = null) => ({
    kind,
    stageKey: String(action?.stageKey || action?.stage_key || action?.stage || action?.id || "").trim(),
    issueKey: String(action?.issueKey || action?.issue_key || action?.issue || "").trim(),
    platform: String(action?.platform || "").trim(),
    title: String(action?.title || action?.label || action?.name || "").trim(),
    status: String(action?.status || "").trim(),
    previousStatus: String(previousAction?.status || "").trim(),
    actionAt: prdWorkflowSnapshotActionTime(action),
    previousActionAt: prdWorkflowSnapshotActionTime(previousAction || {}),
    sourceActionAt: prdWorkflowSnapshotSourceActionTime(action),
    previousSourceActionAt: prdWorkflowSnapshotSourceActionTime(previousAction || {}),
  });
  for (const [key, action] of next) {
    const previousAction = previous.get(key);
    if (!previousAction) {
      changes.push(compact("added", action));
      continue;
    }
    const statusChanged = String(previousAction.status || "") !== String(action.status || "");
    const timeChanged =
      prdWorkflowSnapshotActionTime(previousAction) !== prdWorkflowSnapshotActionTime(action) ||
      prdWorkflowSnapshotSourceActionTime(previousAction) !== prdWorkflowSnapshotSourceActionTime(action);
    const titleChanged = String(previousAction.title || previousAction.label || "") !== String(action.title || action.label || "");
    if (statusChanged || timeChanged || titleChanged) {
      changes.push(compact(
        statusChanged ? "status-changed" : timeChanged ? "time-changed" : "title-changed",
        action,
        previousAction,
      ));
    }
  }
  for (const [key, action] of previous) {
    if (!next.has(key)) changes.push(compact("removed", action, action));
  }
  return changes.slice(0, 80);
}

export function prdWorkflowStampCurrentActionEntryTimes(scopedRoot, tapdId, snapshot = {}, clientState = {}, meta = {}) {
  const existingTimes = new Map();
  for (const client of Object.values(clientState?.clients || {})) {
    const observedAt = String(client?.observedAt || client?.reportedAt || "").trim();
    for (const [key, action] of prdWorkflowSnapshotActionMap(client?.snapshot || {})) {
      if (String(action?.status || "").trim().toLowerCase() !== "current") continue;
      const value = String(action.stageEnteredAt || action.stage_entered_at || observedAt).trim();
      if (!value || !Number.isFinite(Date.parse(value))) continue;
      const previous = existingTimes.get(key);
      if (!previous || Date.parse(value) < Date.parse(previous)) existingTimes.set(key, value);
    }
  }
  const auditedAt = prdWorkflowFirstPointerObservation(scopedRoot, tapdId, snapshot);
  const observedAt = String(meta.observedAt || meta.reportedAt || new Date().toISOString()).trim();
  const stamp = (action) => {
    if (!action || typeof action !== "object" || Array.isArray(action)) return action;
    if (String(action.status || "").trim().toLowerCase() !== "current") return action;
    const actionKey = prdWorkflowSnapshotActionKey(action);
    const candidates = [
      String(action.stageEnteredAt || action.stage_entered_at || "").trim(),
      existingTimes.get(actionKey) || "",
      auditedAt,
      observedAt,
    ].filter((value) => Number.isFinite(Date.parse(value)));
    const stageEnteredAt = candidates.sort((left, right) => Date.parse(left) - Date.parse(right))[0] || observedAt;
    return {
      ...action,
      stageEnteredAt,
    };
  };
  const next = { ...snapshot };
  for (const key of PRD_WORKFLOW_SNAPSHOT_ACTION_ARRAY_KEYS) {
    if (Array.isArray(snapshot?.[key])) next[key] = snapshot[key].map(stamp);
  }
  return next;
}

const PRD_WORKFLOW_PROJECTION_SOURCE_KEYS = new Set([
  "projectionMode",
  "projectCacheScope",
  "legacyCacheScope",
  "clientsUpdatedAt",
  "runtimeEventsUpdatedAt",
]);

function prdWorkflowStoredObservationSources(...sourcesList) {
  const out = {};
  for (const sources of sourcesList) {
    if (!sources || typeof sources !== "object" || Array.isArray(sources)) continue;
    for (const [key, value] of Object.entries(sources)) {
      if (PRD_WORKFLOW_PROJECTION_SOURCE_KEYS.has(key)) continue;
      out[key] = value;
    }
  }
  return out;
}

export function prdWorkflowStoredObservationSnapshot(snapshot, sourcePatch = {}) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return snapshot;
  const clean = { ...snapshot };
  delete clean.events;
  delete clean.runtimeEvents;
  delete clean.runtime_events;
  delete clean.collaboration;
  delete clean.clientObservations;
  delete clean.clients;
  delete clean.snapshotAudit;
  clean.sources = prdWorkflowStoredObservationSources(snapshot.sources, sourcePatch);
  return clean;
}

export function prdWorkflowProjectFactSource(payload = {}, rawSnapshot = {}) {
  const sources = rawSnapshot?.sources && typeof rawSnapshot.sources === "object" && !Array.isArray(rawSnapshot.sources)
    ? rawSnapshot.sources
    : {};
  const truth = String(payload.truth || rawSnapshot.truth || sources.truth || "").trim().toLowerCase();
  if (!["durable_fact", "project_fact"].includes(truth)) return null;
  return {
    truth,
    authority: String(payload.authority || rawSnapshot.authority || sources.authority || "ai-doc").trim() || "ai-doc",
    persistence: String(payload.persistence || rawSnapshot.persistence || sources.persistence || "ai-doc").trim() || "ai-doc",
  };
}

export function prdWorkflowSnapshotMetaFromReport(payload = {}, rawSnapshot = {}, req = null, userCtx = {}) {
  const sources = rawSnapshot.sources && typeof rawSnapshot.sources === "object" && !Array.isArray(rawSnapshot.sources)
    ? rawSnapshot.sources
    : {};
  const headerClientId = req?.headers?.["x-agentflow-client-id"];
  const headerObservedAt = req?.headers?.["x-agentflow-observed-at"];
  const reportedAt = new Date().toISOString();
  return {
    reportedAt,
    observedAt: String(payload.observedAt || payload.observed_at || rawSnapshot.observedAt || rawSnapshot.observed_at || sources.observedAt || sources.checkedAt || headerObservedAt || reportedAt),
    clientId: String(payload.clientId || payload.client_id || sources.clientId || headerClientId || userCtx?.userId || "anonymous").slice(0, 160),
    reportSource: String(payload.reportSource || payload.report_source || payload.source || "legacy").trim().toLowerCase().slice(0, 120) || "legacy",
    userId: String(userCtx?.userId || payload.userId || payload.user_id || "").slice(0, 160),
    baseRevision: String(payload.baseRevision || payload.base_revision || payload.expectedRevision || payload.expected_revision || rawSnapshot.baseRevision || sources.baseRevision || "").trim(),
    scope: String(payload.scope || rawSnapshot.scope || rawSnapshot.next?.scope || sources.scope || "client").trim().toLowerCase() || "client",
    platform: String(payload.platform || rawSnapshot.platform || rawSnapshot.next?.platform || sources.platform || "").trim(),
    issueKey: String(payload.issueKey || payload.issue_key || rawSnapshot.issueKey || rawSnapshot.issue_key || rawSnapshot.next?.issue || rawSnapshot.next?.issueKey || "").trim(),
    stageKey: String(payload.stageKey || payload.stage_key || rawSnapshot.stageKey || rawSnapshot.stage_key || rawSnapshot.next?.code || "").trim(),
    force: payload.force === true || payload.force === "1",
  };
}

export function prdWorkflowStoreClientObservation({
  scopedRoot,
  tapdId,
  rawState,
  payload = {},
  req = null,
  userCtx = {},
  flowSource = "user",
  flowId = "",
}) {
  const normalizedSnapshot = {
    ...prdWorkflowSnapshotFromParsed(scopedRoot, tapdId, rawState, userCtx, { flowSource, flowId }),
    clientReportedAt: new Date().toISOString(),
    sources: {
      ...(rawState.sources && typeof rawState.sources === "object" ? rawState.sources : {}),
      executionMode: "workflow-report",
    },
  };
  const reportMeta = prdWorkflowSnapshotMetaFromReport(payload, rawState, req, userCtx);
  const reportSource = {
    ...(normalizedSnapshot.sources && typeof normalizedSnapshot.sources === "object" ? normalizedSnapshot.sources : {}),
    executionMode: "workflow-report",
    truth: "observation",
    authority: "client",
    persistence: "runtime",
    clientId: reportMeta.clientId,
    clientUserId: reportMeta.userId,
    clientReportedAt: reportMeta.reportedAt,
    clientObservedAt: reportMeta.observedAt,
    baseRevision: reportMeta.baseRevision,
    scope: reportMeta.scope,
    platform: reportMeta.platform,
    issueKey: reportMeta.issueKey,
    stageKey: reportMeta.stageKey,
  };
  const existingClientState = prdWorkflowReadClientState(scopedRoot, tapdId);
  const existingClientId = prdWorkflowSafeStateId(`${reportMeta.reportSource || "legacy"}:${reportMeta.clientId || "anonymous"}`);
  const previousClientSnapshot = existingClientState.clients?.[existingClientId]?.snapshot || null;
  const stampedSnapshot = prdWorkflowStampCurrentActionEntryTimes(
    scopedRoot,
    tapdId,
    normalizedSnapshot,
    existingClientState,
    reportMeta,
  );
  const storedObservationSnapshot = prdWorkflowStoredObservationSnapshot(stampedSnapshot, reportSource);
  const actionChanges = prdWorkflowSnapshotActionChanges(previousClientSnapshot || {}, storedObservationSnapshot);
  prdWorkflowWriteClientObservation(scopedRoot, tapdId, reportMeta, storedObservationSnapshot);
  prdWorkflowAppendAudit(scopedRoot, tapdId, {
    type: "workflow-report-observation-stored",
    flowSource,
    flowId,
    clientId: reportMeta.clientId,
    userId: reportMeta.userId,
    observedAt: reportMeta.observedAt,
    reportedAt: reportMeta.reportedAt,
    phase: String(storedObservationSnapshot?.phase || ""),
    pointer: String(storedObservationSnapshot?.pointer || ""),
    revision: String(storedObservationSnapshot?.revision || ""),
    actionCount: prdWorkflowSnapshotActionCount(storedObservationSnapshot),
    truth: "observation",
    authority: "client",
    persistence: "runtime",
    note: "producer observation accepted through the canonical Workflow Report endpoint",
  });
  for (const change of actionChanges) {
    prdWorkflowAppendAudit(scopedRoot, tapdId, {
      type: "snapshot-action-change",
      source: "workflow-report",
      clientId: reportMeta.clientId,
      userId: reportMeta.userId,
      observedAt: reportMeta.observedAt,
      reportedAt: reportMeta.reportedAt,
      revision: String(storedObservationSnapshot.revision || ""),
      previousRevision: String(previousClientSnapshot?.revision || ""),
      pointer: String(storedObservationSnapshot.pointer || ""),
      previousPointer: String(previousClientSnapshot?.pointer || ""),
      ...change,
    });
  }
  return { reportMeta, storedObservationSnapshot, previousClientSnapshot };
}

export function prdWorkflowSnapshotReportConflict(existingRecord, incomingSnapshot, meta) {
  if (!existingRecord?.snapshot || meta.force) return null;
  const current = existingRecord.snapshot;
  const currentRevision = String(current.revision || "").trim();
  const incomingRevision = String(incomingSnapshot?.revision || "").trim();
  if (meta.baseRevision && currentRevision && meta.baseRevision !== currentRevision) {
    return {
      reason: "base-revision-mismatch",
      message: `snapshot base revision ${meta.baseRevision} is stale; current revision is ${currentRevision}`,
      expectedRevision: meta.baseRevision,
      currentRevision,
      incomingRevision,
    };
  }
  const incomingObservedAt = Date.parse(meta.observedAt || "");
  const currentObservedAt = Date.parse(
    current?.sources?.clientObservedAt ||
    current?.sources?.clientReportedAt ||
    existingRecord.updatedAt ||
    "",
  );
  if (
    Number.isFinite(incomingObservedAt) &&
    Number.isFinite(currentObservedAt) &&
    incomingObservedAt + 1000 < currentObservedAt &&
    incomingRevision !== currentRevision
  ) {
    return {
      reason: "older-observation",
      message: "snapshot was observed before the current cached workflow state",
      currentRevision,
      incomingRevision,
      currentObservedAt: new Date(currentObservedAt).toISOString(),
      incomingObservedAt: new Date(incomingObservedAt).toISOString(),
    };
  }
  return null;
}

function prdWorkflowClientObservationRows(root, scopedRoot, tapdId) {
  const state = prdWorkflowReadClientStateWithFallback(root, scopedRoot, tapdId);
  return Object.values(state.clients || {})
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .sort((a, b) => Date.parse(b.reportedAt || b.observedAt || "") - Date.parse(a.reportedAt || a.observedAt || ""));
}

export function prdWorkflowLatestClientSnapshot(root, scopedRoot, tapdId) {
  const latest = prdWorkflowClientObservationRows(root, scopedRoot, tapdId)[0];
  return latest?.snapshot && typeof latest.snapshot === "object" && !Array.isArray(latest.snapshot)
    ? latest.snapshot
    : null;
}

function prdWorkflowMergedClientIssues(clientRows = []) {
  const out = [];
  const seen = new Map();
  for (const client of clientRows) {
    const issues = Array.isArray(client.snapshot?.issues) ? client.snapshot.issues : Array.isArray(client.issues) ? client.issues : [];
    for (const issue of issues) {
      if (!issue || typeof issue !== "object" || Array.isArray(issue)) continue;
      const key = String(issue.key || issue.issueKey || issue.issue_key || issue.id || issue.title || "").trim();
      const platform = String(issue.platform || "").trim();
      const mergeKey = [key || "issue", platform || "all"].join("|");
      const prevIndex = seen.get(mergeKey);
      const next = {
        ...issue,
        key: key || issue.key,
        platform: platform || issue.platform,
        observedBy: client.clientId || "",
        observedAt: client.observedAt || client.reportedAt || "",
      };
      if (prevIndex != null) out[prevIndex] = { ...out[prevIndex], ...next };
      else {
        seen.set(mergeKey, out.length);
        out.push(next);
      }
    }
  }
  return out;
}

function prdWorkflowArrayCount(value) {
  return Array.isArray(value) ? value.length : 0;
}

export function prdWorkflowSnapshotActionCount(snapshot = {}) {
  return prdWorkflowArrayCount(snapshot?.actions) +
    prdWorkflowArrayCount(snapshot?.workflowActions) +
    prdWorkflowArrayCount(snapshot?.workflow_actions) +
    prdWorkflowArrayCount(snapshot?.timeline) +
    prdWorkflowArrayCount(snapshot?.history);
}

export function prdWorkflowMaterializeSnapshot(root, scopedRoot, tapdId, userCtx = {}, opts = {}) {
  const flowSource = String(opts.flowSource || "user").trim() || "user";
  const flowId = String(opts.flowId || "").trim();
  const project = prdWorkflowReadProjectStateWithFallback(root, scopedRoot, tapdId);
  const legacy = prdWorkflowReadCachedSnapshotWithFallback(root, scopedRoot, tapdId);
  const latestClient = prdWorkflowLatestClientSnapshot(root, scopedRoot, tapdId);
  const baseSource = project?.snapshot ? "project" : latestClient ? "client-observations" : legacy?.snapshot ? "legacy-cache" : "empty";
  const base = (
    project?.snapshot ||
    latestClient ||
    legacy?.snapshot ||
    prdWorkflowFallbackSnapshot(tapdId, "client_snapshot_required", "等待客户端 prd-flow skill 上报 Workflow snapshot", {
      optionalGaps: [{
        severity: "warn",
        text: "Workflow 服务端不会执行客户端 workspace 里的 prd-flow。请在客户端运行 prd-flow current <tapd_id>，并用 AGENTFLOW_BASE_URL + AGENTFLOW_TOKEN 上报到 /api/prd-workflow/snapshot。",
      }],
      sources: { executionMode: "client-report" },
    })
  );
  const clientObservations = prdWorkflowClientObservationRows(root, scopedRoot, tapdId).map((item) => ({
    clientId: item.clientId,
    source: item.source || "legacy",
    userId: item.userId || "",
    phase: item.phase || "",
    pointer: item.pointer || "",
    revision: item.revision || "",
    observedAt: item.observedAt || "",
    reportedAt: item.reportedAt || "",
    nextAction: item.nextAction || null,
    cacheScope: item.cacheScope || "",
  }));
  const clientRows = prdWorkflowClientObservationRows(root, scopedRoot, tapdId);
  const clientIssues = prdWorkflowMergedClientIssues(clientRows);
  const runtimeState = prdWorkflowReadRuntimeEvents(scopedRoot, tapdId);
  const projectionAudit = [
    {
      step: "select-base",
      source: baseSource,
      reason: project?.snapshot
        ? "project materialized snapshot is available"
        : latestClient
          ? "no project snapshot; latest client current observation is used as display base"
          : legacy?.snapshot
            ? "no project/client snapshot; legacy projection cache is used"
            : "no stored workflow projection exists",
      projectSnapshot: Boolean(project?.snapshot),
      latestClientSnapshot: Boolean(latestClient),
      legacySnapshot: Boolean(legacy?.snapshot),
      clientObservationCount: clientRows.length,
      runtimeEventCount: runtimeState.events.length,
      baseActionCount: prdWorkflowSnapshotActionCount(base),
      latestClientRevision: String(latestClient?.revision || ""),
      projectRevision: String(project?.snapshot?.revision || ""),
    },
    {
      step: "merge-client-issues",
      source: "clients",
      applied: !project?.snapshot && clientIssues.length > 0,
      issueCount: clientIssues.length,
      reason: project?.snapshot
        ? "project snapshot owns issue projection"
        : clientIssues.length
          ? "merged issue views from client observations"
          : "no client issue projection available",
    },
    {
      step: "merge-runtime-events",
      source: "runtime-events",
      eventCount: runtimeState.events.length,
      reason: "runtime events are merged after base selection and must not replace durable facts",
    },
  ];
  const materialized = prdWorkflowMergeRuntimeEvents(scopedRoot, tapdId, {
    ...base,
    issues: project?.snapshot ? base.issues : clientIssues.length ? clientIssues : base.issues,
    issueGroups: project?.snapshot ? base.issueGroups : clientIssues.length ? clientIssues : base.issueGroups,
    collaboration: prdWorkflowCollaborationState(userCtx, flowSource, flowId, tapdId),
    clientObservations,
    clients: clientObservations,
    sources: {
      ...(base.sources && typeof base.sources === "object" ? base.sources : {}),
      projectionMode: project?.snapshot ? "project" : latestClient ? "client-observations" : legacy?.snapshot ? "legacy-cache" : "empty",
      projectCacheScope: project?.cacheScope || "",
      legacyCacheScope: legacy?.cacheScope || "",
      clientsUpdatedAt: prdWorkflowReadClientStateWithFallback(root, scopedRoot, tapdId).updatedAt || "",
      checkedAt: new Date().toISOString(),
    },
    projectionAudit,
  });
  materialized.projectionAudit = [
    ...projectionAudit,
    {
      step: "result",
      source: "materialized",
      phase: String(materialized.phase || ""),
      pointer: String(materialized.pointer || ""),
      actionCount: prdWorkflowSnapshotActionCount(materialized) + prdWorkflowArrayCount(materialized.runtimeEvents) + prdWorkflowArrayCount(materialized.runtime_events),
      revision: String(materialized.revision || ""),
    },
  ];
  materialized.snapshotAudit = prdWorkflowReadRecentActionAudit(scopedRoot, tapdId);
  prdWorkflowAppendAudit(scopedRoot, tapdId, {
    type: "projection-materialized",
    flowSource,
    flowId,
    baseSource,
    projectSnapshot: Boolean(project?.snapshot),
    latestClientSnapshot: Boolean(latestClient),
    legacySnapshot: Boolean(legacy?.snapshot),
    clientObservationCount: clientRows.length,
    runtimeEventCount: runtimeState.events.length,
    baseActionCount: prdWorkflowSnapshotActionCount(base),
    resultActionCount: prdWorkflowSnapshotActionCount(materialized) + prdWorkflowArrayCount(materialized.runtimeEvents) + prdWorkflowArrayCount(materialized.runtime_events),
    revision: String(materialized.revision || ""),
  });
  if (!project?.snapshot && latestClient) {
    materialized.optionalGaps = [
      ...(Array.isArray(materialized.optionalGaps) ? materialized.optionalGaps : []),
      { severity: "info", text: "当前展示来自最新客户端观察；尚未形成独立 project materialized view。" },
    ];
  }
  return materialized;
}

function prdWorkflowNormalizeStoredRuntimeEvent(tapdId, event = {}) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const out = { ...event };
  const type = String(out.type || out.kind || "").trim();
  const source = String(out.source || "").trim();
  const idem = String(out.idempotencyKey || out.idempotency_key || "").trim();
  const status = String(out.status || "").trim().toLowerCase();
  const isSnapshotObservation =
    idem.startsWith("snapshot-action:") ||
    (!out.truth && source === "prd-flow-client" && type === "workflow-action");
  if (isSnapshotObservation) {
    out.truth = out.truth || "observation";
    out.persistence = out.persistence || "runtime";
    out.authority = out.authority || "client";
    if (["done", "success", "completed", "passed"].includes(status)) out.status = "observed";
  } else {
    out.truth = out.truth || (type === "review-link" ? "runtime_event" : "runtime_event");
    out.persistence = out.persistence || "runtime";
    out.authority = out.authority || source || "agentflow";
  }
  if (type === "review-link") {
    const durability = String(out.durability || "").trim().toLowerCase();
    const sourceArtifact = out.sourceArtifact && typeof out.sourceArtifact === "object" && !Array.isArray(out.sourceArtifact)
      ? out.sourceArtifact
      : {
          kind: durability === "durable" ? "ai-doc" : "local-draft",
          durability: durability || "temporary",
        };
    out.truth = out.truth || "runtime_event";
    out.persistence = "runtime";
    out.sourceArtifact = sourceArtifact;
    const normalizeReviewRef = (item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const kind = String(item.kind || "").trim();
      const hasReviewUrl = /\/api\/prd-workflow\/review\//.test(String(item.url || item.href || ""));
      if (!kind && !hasReviewUrl) return item;
      const originalKey = String(item.key || item.artifactKey || item.artifact_key || "").trim();
      const logicalKey = /^prd-review:/i.test(originalKey)
        ? originalKey.replace(/:(?:temporary|durable)$/i, "")
        : originalKey && !/^(?:temporary-)?review:https?:/i.test(originalKey)
          ? originalKey
          : prdWorkflowReviewArtifactKey(tapdId, out);
      return {
        ...item,
        key: logicalKey,
        persistence: item.persistence || "runtime",
        source: item.source && typeof item.source === "object" && !Array.isArray(item.source) ? item.source : sourceArtifact,
      };
    };
    if (Array.isArray(out.artifacts)) out.artifacts = out.artifacts.map(normalizeReviewRef);
    if (Array.isArray(out.links)) out.links = out.links.map(normalizeReviewRef);
    const reviewArtifactKey = String(
      out.artifacts?.[0]?.key
      || out.links?.[0]?.key
      || "",
    ).trim();
    out.aggregateByStage = false;
    if (reviewArtifactKey) out.id = `review-link:${reviewArtifactKey}`;
  }
  const canonicalStage = prdWorkflowRuntimeEventCanonicalStage(out);
  const canonicalAction = prdWorkflowRuntimeEventCanonicalAction(canonicalStage);
  const rawStage = String(out.stageKey || out.stage_key || out.stage || "").trim();
  if (canonicalStage) {
    if (rawStage && rawStage !== canonicalStage) out.sourceStage = out.sourceStage || rawStage;
    out.stage = canonicalStage;
    out.stageKey = canonicalStage;
  }
  if (canonicalAction && (type === "workflow-marker" || String(out.action || "") === "mark")) {
    out.action = canonicalAction;
    out.actionId = canonicalAction;
  }
  if (type === "workflow-report" && !out.action && (
    String(out.artifactScope || out.artifact_scope || out.scope || "").toLowerCase() === "global"
    || out.aggregateByStage === false
    || out.aggregate_by_stage === false
  )) {
    out.auxiliary = true;
  }
  out.artifacts = prdWorkflowRuntimeOwnedArtifacts(out.artifacts, canonicalStage);
  out.links = prdWorkflowRuntimeOwnedArtifacts(out.links, canonicalStage);
  out.tapdId = String(out.tapdId || out.tapd_id || tapdId || "");
  const canonicalId = prdWorkflowRuntimeEventId(out);
  if (out.id && out.id !== canonicalId) out.sourceEventId = out.sourceEventId || out.id;
  out.id = canonicalId;
  return out;
}

function prdWorkflowReadRuntimeEvents(scopedRoot, tapdId) {
  try {
    const p = prdWorkflowEventsPath(scopedRoot, tapdId);
    const archivePath = prdWorkflowEventsArchivePath(scopedRoot, tapdId);
    const data = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, "utf-8")) : {};
    const archivedEvents = fs.existsSync(archivePath)
      ? fs.readFileSync(archivePath, "utf-8").split("\n").filter(Boolean).flatMap((line) => {
          try { return [JSON.parse(line)]; } catch { return []; }
        })
      : [];
    const normalizedEvents = [...archivedEvents, ...(Array.isArray(data?.events) ? data.events : [])]
      .map((item) => prdWorkflowNormalizeStoredRuntimeEvent(data?.tapdId || tapdId, item))
      .filter((item) => item && typeof item === "object");
    const eventsByKey = new Map();
    for (const event of normalizedEvents) {
      const key = `${prdWorkflowRuntimeEventProducer(event)}:${prdWorkflowRuntimeEventOperation(event)}:${String(event.id || "")}`;
      eventsByKey.set(key, event);
    }
    const events = [...eventsByKey.values()];
    return {
      version: 1,
      tapdId: String(data?.tapdId || tapdId || ""),
      updatedAt: data?.updatedAt || "",
      events,
    };
  } catch {
    return { version: 1, tapdId: String(tapdId || ""), events: [] };
  }
}

function prdWorkflowWriteRuntimeEvents(scopedRoot, tapdId, events) {
  const p = prdWorkflowEventsPath(scopedRoot, tapdId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const allEvents = Array.isArray(events) ? events : [];
  const overflow = allEvents.slice(0, Math.max(0, allEvents.length - PRD_WORKFLOW_RUNTIME_EVENTS_MAX));
  const archivePath = prdWorkflowEventsArchivePath(scopedRoot, tapdId);
  const archiveTmp = `${archivePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(archiveTmp, overflow.length ? `${overflow.map((event) => JSON.stringify(event)).join("\n")}\n` : "", "utf-8");
  fs.renameSync(archiveTmp, archivePath);
  const data = {
    version: 1,
    tapdId: String(tapdId || ""),
    updatedAt: new Date().toISOString(),
    events: allEvents.slice(-PRD_WORKFLOW_RUNTIME_EVENTS_MAX),
  };
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, p);
  return data;
}

function prdWorkflowRuntimeEventStatus(type, status) {
  const s = String(status || "").trim().toLowerCase();
  if (s) return s;
  const t = String(type || "").trim().toLowerCase();
  if (t.includes("done") || t.includes("success") || t.includes("completed")) return "done";
  if (t.includes("error") || t.includes("failed") || t.includes("conflict")) return "error";
  if (t.includes("start") || t.includes("running")) return "running";
  return "pending";
}

export function prdWorkflowRuntimeEventCanonicalStage(event = {}) {
  const issue = String(event.issueKey || event.issue_key || event.issue || "").trim();
  const action = String(event.action || event.actionId || event.action_id || "").trim();
  const rawStage = String(event.stageKey || event.stage_key || event.stage || event.phase || event.code || action || "").trim();
  const normalizedStage = rawStage.toLowerCase();
  const tokens = [rawStage, action, event.code, event.type]
    .map((value) => String(value || "").trim().toLowerCase())
    .filter(Boolean);
  if (issue) {
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
  }
  return rawStage || action;
}

function prdWorkflowRuntimeEventCanonicalAction(stage = "") {
  const prefix = String(stage || "").trim().split(":", 1)[0];
  return ["issue-plan", "issue-gitlab", "implementation", "bugfix", "integration"].includes(prefix)
    ? prefix
    : "";
}

function prdWorkflowRuntimeEventProducer(event = {}) {
  return String(event.source || event.producer || "agentflow")
    .trim()
    .toLowerCase()
    .slice(0, 120) || "agentflow";
}

function prdWorkflowRuntimeEventOperation(event = {}) {
  return String(event.operation || (event.type === "review-link" ? "artifact.publish" : "report"))
    .trim()
    .toLowerCase() || "report";
}

function prdWorkflowRuntimeOwnedArtifacts(values, stage = "") {
  if (!Array.isArray(values)) return values;
  const ownsOnlyChangedArtifact = /^(?:issue-plan|implementation|bugfix|integration):/.test(String(stage || ""));
  if (!ownsOnlyChangedArtifact) return values;
  return values.filter((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return true;
    const kind = String(item.kind || item.type || "").trim().toLowerCase();
    const key = String(item.key || item.artifactKey || item.artifact_key || "").trim().toLowerCase();
    return !(
      ["gitlab-epic", "gitlab-issue"].includes(kind)
      || /^(?:gitlab-epic|gitlab-issue):/.test(key)
    );
  });
}

function prdWorkflowRuntimeEventId(event = {}) {
  const stage = prdWorkflowRuntimeEventCanonicalStage(event);
  const action = String(event.action || event.actionId || event.action_id || "").trim();
  const scope = String(event.scope || "").trim();
  const platform = String(event.platform || "").trim();
  const aggregateByStage = event.aggregateByStage !== false && event.aggregate_by_stage !== false;
  const operation = prdWorkflowRuntimeEventOperation(event);
  const stableActionKey = String(event?.actionModel?.key || "").trim();
  if (stableActionKey && aggregateByStage && String(event?.type || "") === "workflow-report") {
    return `stage_${prdWorkflowSafeStateId([prdWorkflowRuntimeEventProducer(event), operation, stableActionKey].join(":"))}`;
  }
  if ((stage || action) && aggregateByStage) {
    const issue = String(event.issueKey || event.issue_key || event.issue || "").trim();
    const key = [prdWorkflowRuntimeEventProducer(event), operation, scope, issue, platform, stage || action].filter(Boolean).join(":");
    return `stage_${prdWorkflowSafeStateId(key)}`;
  }
  const existing = String(event.id || event.eventId || event.event_id || "").trim();
  if (existing) return existing.slice(0, 160);
  if (stage || action) {
    const issue = String(event.issueKey || event.issue_key || event.issue || "").trim();
    const key = [prdWorkflowRuntimeEventProducer(event), operation, scope, issue, platform, stage || action].filter(Boolean).join(":");
    return `stage_${prdWorkflowSafeStateId(key)}`;
  }
  return `evt_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

export function prdWorkflowCompactRuntimeValue(value, maxChars = 24000) {
  if (value == null) return value;
  try {
    const text = JSON.stringify(value);
    if (!text || text.length <= maxChars) return value;
    return { truncated: true, preview: text.slice(0, maxChars) };
  } catch {
    const text = String(value || "");
    return text.length <= maxChars ? text : { truncated: true, preview: text.slice(0, maxChars) };
  }
}

function prdWorkflowNormalizeRuntimeEvent(tapdId, event = {}) {
  const now = new Date().toISOString();
  const type = String(event.type || event.kind || "workflow-event").trim().slice(0, 120);
  const rawAction = String(event.action || event.actionId || event.action_id || "").trim().slice(0, 160);
  const rawStage = String(event.stageKey || event.stage_key || event.stage || event.phase || rawAction || "").trim().slice(0, 160);
  const stage = prdWorkflowRuntimeEventCanonicalStage(event).slice(0, 160);
  const canonicalAction = prdWorkflowRuntimeEventCanonicalAction(stage);
  const action = canonicalAction && (type === "workflow-marker" || rawAction === "mark")
    ? canonicalAction
    : rawAction;
  const scope = String(event.scope || "").trim().slice(0, 80);
  const platform = String(event.platform || "").trim().slice(0, 80);
  const status = prdWorkflowRuntimeEventStatus(type, event.status);
  const source = String(event.source || "agentflow").trim().slice(0, 80) || "agentflow";
  const truth = String(
    event.truth ||
    event.stateTruth ||
    event.state_truth ||
    (type === "review-link" ? "runtime_event" : source === "prd-flow-client" && type === "workflow-action" ? "observation" : "runtime_event"),
  ).trim();
  const persistence = String(event.persistence || event.storage || "runtime").trim();
  const authority = String(event.authority || (truth === "observation" ? "client" : source)).trim();
  const entry = {
    ...event,
    id: prdWorkflowRuntimeEventId(event),
    source,
    runtime: event.runtime !== false,
    type,
    tapdId: String(event.tapdId || event.tapd_id || tapdId || ""),
    status,
    truth,
    persistence,
    authority,
    updatedAt: now,
  };
  if (rawStage && rawStage !== stage) entry.sourceStage = rawStage;
  const sourceEventId = String(event.id || event.eventId || event.event_id || "").trim();
  if (sourceEventId && sourceEventId !== entry.id) entry.sourceEventId = sourceEventId.slice(0, 160);
  if (action) {
    entry.action = action;
    entry.actionId = String(event.actionId || event.action_id || action);
  }
  if (stage) {
    entry.stage = stage;
    entry.stageKey = stage;
  }
  const attachProducer = (values) => (Array.isArray(values) ? values.map((item) => (
    item && typeof item === "object" && !Array.isArray(item)
      ? { ...item, producer: String(item.producer || source).trim().toLowerCase() || source }
      : item
  )) : values);
  entry.artifacts = attachProducer(prdWorkflowRuntimeOwnedArtifacts(entry.artifacts, stage));
  entry.links = attachProducer(prdWorkflowRuntimeOwnedArtifacts(entry.links, stage));
  if (scope) entry.scope = scope;
  if (platform) entry.platform = platform;
  if (!entry.createdAt) entry.createdAt = event.startedAt || now;
  if (!entry.title && (stage || action)) entry.title = stage || action;
  if (!entry.detail && event.message) entry.detail = String(event.message || "").slice(0, 4000);
  if (entry.rawOutput) entry.rawOutput = String(entry.rawOutput).slice(0, 12000);
  if (entry.error) entry.error = String(entry.error).slice(0, 4000);
  if (entry.output != null) entry.output = prdWorkflowCompactRuntimeValue(entry.output);
  if (entry.result != null) entry.result = prdWorkflowCompactRuntimeValue(entry.result);
  const history = Array.isArray(event.idempotencyHistory) ? event.idempotencyHistory : [];
  const idem = String(event.idempotencyKey || "").trim();
  if (idem && !history.includes(idem)) entry.idempotencyHistory = [...history, idem].slice(-50);
  return entry;
}

function prdWorkflowMergeRuntimeEventArrays(left, right) {
  const out = [];
  const seen = new Map();
  const aliasesFor = (value) => {
    if (typeof value === "string") return [`value:${value}`];
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const aliases = [];
    const explicitKey = String(value.key || value.artifactKey || value.artifact_key || "").trim();
    if (explicitKey) aliases.push(`key:${explicitKey}`);
    const rawUrl = String(
      value.canonicalUrl
      || value.canonical_url
      || value.href
      || value.url
      || "",
    ).trim();
    if (rawUrl) {
      try {
        const parsed = new URL(rawUrl, "http://agentflow.local");
        aliases.push(`url:${parsed.origin}${parsed.pathname.replace(/\/+$/, "") || "/"}`);
      } catch {
        aliases.push(`url:${rawUrl.split(/[?#]/)[0].replace(/\/+$/, "")}`);
      }
    }
    const itemPath = String(value.path || "").trim();
    if (itemPath) aliases.push(`path:${itemPath}`);
    if (!aliases.length) {
      try {
        aliases.push(`value:${JSON.stringify(value)}`);
      } catch {
        aliases.push(`value:${String(value)}`);
      }
    }
    return aliases;
  };
  for (const value of [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])]) {
    if (value == null) continue;
    const aliases = aliasesFor(value);
    const index = aliases.map((alias) => seen.get(alias)).find((candidate) => candidate != null);
    if (index == null) {
      const nextIndex = out.length;
      out.push(value);
      aliases.forEach((alias) => seen.set(alias, nextIndex));
      continue;
    }
    out[index] = value;
    aliasesFor(value).forEach((alias) => seen.set(alias, index));
  }
  return out;
}

function prdWorkflowRuntimeEventArtifactSignature(event = {}) {
  const explicit = String(event.artifactHash || event.artifact_hash || event.hash || "").trim();
  if (explicit) return explicit;
  const parts = [
    event.artifact,
    event.artifactUrl || event.artifact_url,
    event.url,
    event.reviewUrl || event.review_url,
    event.planDoc || event.plan_doc,
  ].map((value) => String(value || "").trim()).filter(Boolean);
  if (parts.length) return parts.join("|");
  const artifacts = Array.isArray(event.artifacts) ? event.artifacts : [];
  const urls = artifacts
    .map((item) => String(item?.url || item?.href || item?.path || item?.label || "").trim())
    .filter(Boolean);
  return urls.length ? urls.join("|") : "";
}

function prdWorkflowRuntimeEventShouldConflictOnArtifact(event = {}) {
  if (event.conflictOnArtifact === true || event.conflict_on_artifact === true) return true;
  if (event.conflictOnArtifact === false || event.conflict_on_artifact === false) return false;
  if (String(event.type || "") === "review-link") return false;
  if ((Array.isArray(event.artifacts) ? event.artifacts : []).some((item) => String(item?.kind || "") === "temporary-review")) return false;
  const stage = String(event.stage || event.stageKey || event.stage_key || event.action || "").toLowerCase();
  return /submit-plan|project-plan|tech-design|plan/.test(stage);
}

export function prdWorkflowAppendRuntimeEvent(scopedRoot, tapdId, event = {}) {
  try {
    const current = prdWorkflowReadRuntimeEvents(scopedRoot, tapdId);
    const entry = prdWorkflowNormalizeRuntimeEvent(tapdId, event);
    const entryIdem = String(entry.idempotencyKey || "").trim();
    const entryProducer = prdWorkflowRuntimeEventProducer(entry);
    const entryOperation = prdWorkflowRuntimeEventOperation(entry);
    const entryDedupeKey = prdWorkflowRuntimeEventDedupeKey(entry);
    const index = current.events.findIndex((item) => {
      if (prdWorkflowRuntimeEventProducer(item) !== entryProducer) return false;
      if (String(item?.id || "") === entry.id) return true;
      if (prdWorkflowRuntimeEventOperation(item) !== entryOperation) return false;
      if (prdWorkflowRuntimeEventDedupeKey(item) === entryDedupeKey) return true;
      if (!entryIdem) return false;
      if (String(item?.idempotencyKey || "").trim() === entryIdem) return true;
      return Array.isArray(item?.idempotencyHistory) && item.idempotencyHistory.includes(entryIdem);
    });
    const updatedExisting = index >= 0;
    let artifactConflict = false;
    const events = [...current.events];
    if (index >= 0) {
      const previousImplementationMetadata =
        events[index]?.implementationMetadata || events[index]?.implementation_metadata;
      const incomingImplementationMetadata =
        entry?.implementationMetadata || entry?.implementation_metadata;
      const mergedImplementationMetadata =
        incomingImplementationMetadata && typeof incomingImplementationMetadata === "object" && !Array.isArray(incomingImplementationMetadata)
          ? prdWorkflowOverallMerge(
              previousImplementationMetadata && typeof previousImplementationMetadata === "object" && !Array.isArray(previousImplementationMetadata)
                ? previousImplementationMetadata
                : {},
              incomingImplementationMetadata,
            )
          : previousImplementationMetadata;
      const previousGlobalStatePatch =
        events[index]?.globalStatePatch || events[index]?.global_state_patch;
      const incomingGlobalStatePatch =
        entry?.globalStatePatch || entry?.global_state_patch;
      const mergedGlobalStatePatch =
        incomingGlobalStatePatch && typeof incomingGlobalStatePatch === "object" && !Array.isArray(incomingGlobalStatePatch)
          ? mergeWorkflowGlobalState(
              previousGlobalStatePatch && typeof previousGlobalStatePatch === "object" && !Array.isArray(previousGlobalStatePatch)
                ? previousGlobalStatePatch
                : {},
              incomingGlobalStatePatch,
            )
          : previousGlobalStatePatch;
      const incomingPatchPaths = Array.isArray(entry?.globalStateOwnerPaths) ? entry.globalStateOwnerPaths : [];
      const previousRemovePaths = Array.isArray(events[index]?.globalStateRemove || events[index]?.global_state_remove)
        ? (events[index].globalStateRemove || events[index].global_state_remove)
        : [];
      const incomingRemovePaths = Array.isArray(entry?.globalStateRemove || entry?.global_state_remove)
        ? (entry.globalStateRemove || entry.global_state_remove)
        : [];
      const overlapsPath = (left, right) => left === right || left.startsWith(`${right}.`) || right.startsWith(`${left}.`);
      const mergedGlobalStateRemove = [...new Set([
        ...previousRemovePaths.filter((removedPath) => !incomingPatchPaths.some((patchPath) => overlapsPath(String(removedPath), String(patchPath)))),
        ...incomingRemovePaths,
      ])];
      let normalizedGlobalStatePatch = mergedGlobalStatePatch;
      for (const removedPath of incomingRemovePaths) {
        normalizedGlobalStatePatch = removeWorkflowGlobalStatePath(normalizedGlobalStatePatch, removedPath);
      }
      const prevArtifact = prdWorkflowRuntimeEventArtifactSignature(events[index]);
      const nextArtifact = prdWorkflowRuntimeEventArtifactSignature(entry);
      artifactConflict = Boolean(prevArtifact && nextArtifact && prevArtifact !== nextArtifact &&
        prdWorkflowRuntimeEventShouldConflictOnArtifact(events[index]) &&
        prdWorkflowRuntimeEventShouldConflictOnArtifact(entry));
      const idempotencyHistory = [...new Set([
        ...(Array.isArray(events[index].idempotencyHistory) ? events[index].idempotencyHistory : []),
        ...(events[index].idempotencyKey ? [events[index].idempotencyKey] : []),
        ...(Array.isArray(entry.idempotencyHistory) ? entry.idempotencyHistory : []),
        ...(entry.idempotencyKey ? [entry.idempotencyKey] : []),
      ])].slice(-50);
      const allIdempotencyFingerprints = {
        ...(events[index].idempotencyFingerprints || {}),
        ...(events[index].idempotencyKey && events[index].idempotencyFingerprint
          ? { [events[index].idempotencyKey]: events[index].idempotencyFingerprint }
          : {}),
        ...(entry.idempotencyFingerprints || {}),
        ...(entry.idempotencyKey && entry.idempotencyFingerprint
          ? { [entry.idempotencyKey]: entry.idempotencyFingerprint }
          : {}),
      };
      events[index] = {
        ...events[index],
        ...entry,
        links: prdWorkflowMergeRuntimeEventArrays(events[index].links, entry.links),
        artifacts: mergeWorkflowArtifactLists(events[index].artifacts, entry.artifacts, entry.artifactScope || "action"),
        outputs: prdWorkflowMergeRuntimeEventArrays(events[index].outputs, entry.outputs),
        results: prdWorkflowMergeRuntimeEventArrays(events[index].results, entry.results),
        actionModel: mergeWorkflowGlobalState(events[index].actionModel, entry.actionModel),
        globalStateRemove: mergedGlobalStateRemove,
        extensionsPatch: entry.extensionsPatch
          ? mergeWorkflowGlobalState(events[index].extensionsPatch, entry.extensionsPatch)
          : events[index].extensionsPatch,
        globalStateOwnerPaths: prdWorkflowMergeRuntimeEventArrays(
          events[index].globalStateOwnerPaths,
          entry.globalStateOwnerPaths,
        ),
        createdAt: events[index].createdAt || entry.createdAt,
        startedAt: events[index].startedAt || entry.startedAt,
        idempotencyHistory,
        idempotencyFingerprints: Object.fromEntries(
          idempotencyHistory
            .filter((key) => allIdempotencyFingerprints[key])
            .map((key) => [key, allIdempotencyFingerprints[key]]),
        ),
      };
      if (mergedImplementationMetadata && typeof mergedImplementationMetadata === "object" && !Array.isArray(mergedImplementationMetadata)) {
        events[index].implementationMetadata = mergedImplementationMetadata;
      }
      if (normalizedGlobalStatePatch && typeof normalizedGlobalStatePatch === "object" && !Array.isArray(normalizedGlobalStatePatch)) {
        events[index].globalStatePatch = normalizedGlobalStatePatch;
      }
      if (artifactConflict) {
        events[index] = {
          ...events[index],
          type: "same-platform-stage-conflict",
          status: "conflict",
          conflict: {
            type: "same-platform-stage-conflict",
            previousArtifact: prevArtifact,
            incomingArtifact: nextArtifact,
            message: "同一 issue/platform/stage 上报了不同产物，需要本地 agent 拉取后 review。",
          },
        };
      }
    } else {
      events.push(entry);
    }
    prdWorkflowWriteRuntimeEvents(scopedRoot, tapdId, events);
    prdWorkflowAppendAudit(scopedRoot, tapdId, {
      type: "runtime-event-stored",
      eventId: entry.id,
      eventType: entry.type,
      source: entry.source,
      scope: entry.scope || "",
      issueKey: entry.issueKey || entry.issue_key || entry.issue || "",
      platform: entry.platform || "",
      stage: entry.stage || entry.stageKey || entry.stage_key || "",
      action: entry.action || entry.actionId || entry.action_id || "",
      status: entry.status || "",
      truth: entry.truth || "",
      authority: entry.authority || "",
      persistence: entry.persistence || "",
      idempotencyKey: entry.idempotencyKey || "",
      updatedExisting,
      artifactConflict,
      eventCount: events.length,
      note: "runtime event stored as append-only workflow event; projection may merge it into the visible timeline",
    });
    return entry;
  } catch {
    return null;
  }
}

export function prdWorkflowFindIdempotencyEvent(scopedRoot, tapdId, idempotencyKey, source = "", completedOnly = true, operation = "") {
  const key = String(idempotencyKey || "").trim();
  if (!key) return null;
  const producer = String(source || "").trim().toLowerCase();
  const operationKey = String(operation || "").trim().toLowerCase();
  const events = prdWorkflowReadRuntimeEvents(scopedRoot, tapdId).events;
  return [...events].reverse().find((event) => (
    (!producer || prdWorkflowRuntimeEventProducer(event) === producer) &&
    (!operationKey || String(event?.operation || (event?.type === "review-link" ? "artifact.publish" : "report")).toLowerCase() === operationKey) &&
    (String(event?.idempotencyKey || "") === key || (Array.isArray(event?.idempotencyHistory) && event.idempotencyHistory.includes(key))) &&
    (!completedOnly || ["done", "success", "completed"].includes(String(event?.status || "").toLowerCase()))
  )) || null;
}

export function prdWorkflowFindCompletedIdempotencyEvent(scopedRoot, tapdId, idempotencyKey, source = "") {
  return prdWorkflowFindIdempotencyEvent(scopedRoot, tapdId, idempotencyKey, source, false, "report");
}

export function prdWorkflowIdempotencyFingerprint(event = {}, idempotencyKey = "") {
  const key = String(idempotencyKey || "").trim();
  return String(
    event?.idempotencyFingerprints?.[key]
    || (String(event?.idempotencyKey || "").trim() === key ? event?.idempotencyFingerprint : "")
    || "",
  );
}

export function prdWorkflowResourceVersionConflicts(expectedVersions = {}, currentVersions = {}) {
  const conflicts = [];
  for (const [resourceKey, expectedVersion] of Object.entries(expectedVersions || {})) {
    const currentVersion = String(currentVersions?.[resourceKey] || "absent");
    const expected = String(expectedVersion || "absent");
    if (expected === currentVersion) continue;
    conflicts.push({ resourceKey, expectedVersion: expected, currentVersion });
  }
  return conflicts;
}

function prdWorkflowGlobalPathOwners(snapshot = {}) {
  const owners = new Map();
  for (const event of Array.isArray(snapshot.runtimeEvents) ? snapshot.runtimeEvents : []) {
    const source = prdWorkflowRuntimeEventProducer(event);
    for (const path of Array.isArray(event?.globalStateOwnerPaths) ? event.globalStateOwnerPaths : []) {
      const normalized = String(path || "").trim();
      if (normalized) owners.set(normalized, source);
    }
  }
  return owners;
}

export function prdWorkflowGlobalOwnershipConflicts(report, currentSnapshot = {}) {
  const source = prdWorkflowRuntimeEventProducer(report?.event || {});
  const owners = prdWorkflowGlobalPathOwners(currentSnapshot);
  const conflicts = [];
  for (const path of Array.isArray(report?.event?.globalStateOwnerPaths) ? report.event.globalStateOwnerPaths : []) {
    const normalizedPath = String(path || "");
    const match = [...owners.entries()].find(([ownedPath, owner]) => (
      owner !== source && (
        ownedPath === normalizedPath ||
        ownedPath.startsWith(`${normalizedPath}.`) ||
        normalizedPath.startsWith(`${ownedPath}.`)
      )
    ));
    if (match) conflicts.push({ path: normalizedPath, owner: match[1], source });
  }
  return conflicts;
}

export function prdWorkflowMergeProducerTimeline(report, currentSnapshot = {}) {
  if (!report?.projections || !Array.isArray(report.projections.timeline)) return report;
  const source = prdWorkflowRuntimeEventProducer(report.event);
  const current = Array.isArray(currentSnapshot?.projections?.timeline) ? currentSnapshot.projections.timeline : [];
  const incoming = report.projections.timeline;
  const foreignCurrent = current.filter((item) => prdWorkflowRuntimeEventProducer(item) !== source);
  const ownIncoming = incoming.filter((item) => prdWorkflowRuntimeEventProducer(item) === source);
  const foreignIncoming = incoming.filter((item) => prdWorkflowRuntimeEventProducer(item) !== source);
  const foreignByKey = new Map(foreignCurrent.map((item) => [String(item?.key || `${item?.source}:${item?.kind}:${item?.id}`), item]));
  for (const item of foreignIncoming) {
    const key = String(item?.key || `${item?.source}:${item?.kind}:${item?.id}`);
    const existing = foreignByKey.get(key);
    const existingVersion = existing
      ? Object.values(workflowSnapshotResourceVersions({ projections: { timeline: [existing] } }))[0]
      : "";
    const incomingVersion = Object.values(workflowSnapshotResourceVersions({ projections: { timeline: [item] } }))[0] || "";
    if (!existing || existingVersion !== incomingVersion) {
      return { error: `projections.timeline may not modify entries owned by source ${item?.source || "unknown"}` };
    }
  }
  const timeline = [...foreignCurrent, ...ownIncoming];
  return {
    ...report,
    projections: { ...report.projections, timeline },
    event: { ...report.event, projections: { ...report.event.projections, timeline } },
  };
}

export function prdWorkflowAdminVersionRepairOperation(value = "", userCtx = {}) {
  const operation = String(value || "").trim().toLowerCase();
  if (!operation) return { requested: false };
  if (operation !== "repair-version-membership") {
    return { requested: true, status: 400, error: `Unsupported admin Workflow operation: ${operation}` };
  }
  if (userCtx.isAdmin !== true) {
    return { requested: true, status: 403, error: "Admin permission required" };
  }
  return { requested: true, operation };
}

export function prdWorkflowAdminVersionRepairIntent(payload = {}, report = {}, userCtx = {}) {
  const intent = prdWorkflowAdminVersionRepairOperation(
    payload.adminOperation || payload.admin_operation || payload.administrativeOperation || payload.administrative_operation || "",
    userCtx,
  );
  if (!intent.requested || intent.error) return intent;
  const forbiddenKeys = ["action", "artifacts", "observation", "globalState", "global_state", "extensions", "extension"]
    .filter((key) => Object.prototype.hasOwnProperty.call(payload, key));
  if (forbiddenKeys.length) {
    return {
      requested: true,
      status: 400,
      error: `Admin version repair may only update projections.timeline; remove: ${forbiddenKeys.join(", ")}`,
    };
  }
  const projections = payload.projections;
  if (!projections || typeof projections !== "object" || Array.isArray(projections) || !Array.isArray(projections.timeline)) {
    return { requested: true, status: 400, error: "Admin version repair requires projections.timeline" };
  }
  const extraProjectionKeys = Object.keys(projections).filter((key) => key !== "timeline");
  if (extraProjectionKeys.length) {
    return { requested: true, status: 400, error: "Admin version repair may only update projections.timeline" };
  }
  const nonVersionEntry = report?.projections?.timeline?.find((item) => String(item?.kind || "").trim().toLowerCase() !== "version");
  if (nonVersionEntry) {
    return { requested: true, status: 400, error: "Admin version repair only accepts timeline entries with kind=version" };
  }
  if (!report.idempotencyKey) {
    return { requested: true, status: 400, error: "Admin version repair requires idempotencyKey" };
  }
  if (!report.expectedRevision) {
    return { requested: true, status: 400, error: "Admin version repair requires expectedRevision" };
  }
  const rawReason = String(payload.adminReason || payload.admin_reason || "");
  if (rawReason.length > 500) {
    return { requested: true, status: 400, error: "Admin version repair reason exceeds 500 characters" };
  }
  if (/[\0\r\n]/.test(rawReason)) {
    return { requested: true, status: 400, error: "Admin version repair reason contains control characters" };
  }
  return { ...intent, reason: rawReason.trim() };
}

export function prdWorkflowMergeAdminVersionTimeline(report, currentSnapshot = {}, adminIntent = {}) {
  const source = prdWorkflowRuntimeEventProducer(report?.event || {});
  const current = Array.isArray(currentSnapshot?.projections?.timeline) ? currentSnapshot.projections.timeline : [];
  const incoming = Array.isArray(report?.projections?.timeline) ? report.projections.timeline : [];
  const retained = current.filter((item) => (
    prdWorkflowRuntimeEventProducer(item) !== source
    || String(item?.kind || "").trim().toLowerCase() !== "version"
  ));
  const timeline = [...retained, ...incoming];
  const administrativeRepair = {
    kind: "version-attribution",
    operation: "repair-version-membership",
    ...(adminIntent.reason ? { reason: adminIntent.reason } : {}),
  };
  return {
    ...report,
    projections: { ...report.projections, timeline },
    event: {
      ...report.event,
      projections: { ...report.event.projections, timeline },
      administrativeRepair,
      administrative_repair: administrativeRepair,
    },
  };
}

function prdWorkflowRuntimeEventDedupeKey(event = {}, index = 0) {
  const producer = prdWorkflowRuntimeEventProducer(event);
  const operation = prdWorkflowRuntimeEventOperation(event);
  const stage = prdWorkflowRuntimeEventCanonicalStage(event);
  const aggregateByStage = event.aggregateByStage !== false && event.aggregate_by_stage !== false;
  const stableActionKey = String(event?.actionModel?.key || "").trim();
  if (stableActionKey && aggregateByStage && String(event?.type || "") === "workflow-report") {
    return `producer:${producer}:operation:${operation}:action:${stableActionKey}`;
  }
  if (stage) {
    const issue = event?.issueKey || event?.issue_key || event?.issue;
    const platform = event?.platform;
    if (aggregateByStage || issue || platform) {
      return ["producer", producer, "operation", operation, "stage", event?.scope, issue, platform, stage]
        .map((value) => String(value || "").trim())
        .join(":");
    }
  }
  const id = String(event?.id || event?.eventId || event?.event_id || "").trim();
  if (id) return `producer:${producer}:operation:${operation}:id:${id}`;
  if (stage) {
    return ["producer", producer, "operation", operation, "stage", event?.scope, event?.issueKey || event?.issue_key || event?.issue, event?.platform, stage]
      .map((value) => String(value || "").trim())
      .join(":");
  }
  return `producer:${producer}:operation:${operation}:idx:${index}`;
}

function prdWorkflowMergeRuntimeEventList(snapshotEvents = [], runtimeEvents = []) {
  const out = [];
  const seen = new Map();
  for (const event of [...(Array.isArray(snapshotEvents) ? snapshotEvents : []), ...(Array.isArray(runtimeEvents) ? runtimeEvents : [])]) {
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const key = prdWorkflowRuntimeEventDedupeKey(event, out.length);
    const index = seen.get(key);
    if (index == null) {
      seen.set(key, out.length);
      out.push(event);
    } else {
      out[index] = {
        ...out[index],
        ...event,
        links: prdWorkflowMergeRuntimeEventArrays(out[index].links, event.links),
        artifacts: mergeWorkflowArtifactLists(out[index].artifacts, event.artifacts, event.artifactScope || "action"),
        outputs: prdWorkflowMergeRuntimeEventArrays(out[index].outputs, event.outputs),
        results: prdWorkflowMergeRuntimeEventArrays(out[index].results, event.results),
      };
    }
  }
  return out;
}

function prdWorkflowOverallPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function prdWorkflowOverallMerge(base, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return base;
  const out = { ...prdWorkflowOverallPlainObject(base) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) {
      delete out[key];
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = prdWorkflowOverallMerge(out[key], value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function prdWorkflowOverallDeletePath(value, rawPath) {
  const pathParts = String(rawPath || "").split(".").map((part) => part.trim()).filter(Boolean);
  if (!pathParts.length) return value;
  const root = prdWorkflowOverallPlainObject(value);
  let cursor = root;
  for (const part of pathParts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== "object" || Array.isArray(cursor[part])) return root;
    cursor = cursor[part];
  }
  delete cursor[pathParts[pathParts.length - 1]];
  return root;
}

function prdWorkflowOverallValueKey(value) {
  if (typeof value === "string") return value.trim().toLowerCase();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function prdWorkflowOverallUnique(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    if (value == null || value === "") continue;
    const key = prdWorkflowOverallValueKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function prdWorkflowOverallFilterValues(filters, key) {
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) return [];
  const aliases = {
    countries: ["countries", "country", "countryFilters", "country_filters"],
    users: ["users", "user", "uids", "uid", "userFilters", "user_filters"],
    versions: ["versions", "version", "versionFilters", "version_filters"],
  };
  for (const alias of aliases[key] || [key]) {
    const value = filters[alias];
    if (Array.isArray(value)) return value;
    if (value != null && value !== "") return [value];
  }
  return [];
}

function prdWorkflowFinalizeOverall(tapdId, value) {
  const overall = prdWorkflowOverallPlainObject(value);
  const requirement = {
    ...prdWorkflowOverallPlainObject(overall.requirement),
    tapdId: String(overall?.requirement?.tapdId || overall?.requirement?.tapd_id || tapdId || ""),
  };
  const platforms = {};
  for (const [rawPlatform, rawValue] of Object.entries(prdWorkflowOverallPlainObject(overall.platforms))) {
    const platform = String(rawPlatform || "").trim().toLowerCase();
    if (!platform) continue;
    const platformValue = prdWorkflowOverallPlainObject(rawValue);
    const issues = prdWorkflowOverallPlainObject(platformValue.issues);
    const implementations = Object.values(issues)
      .map((issue) => prdWorkflowOverallPlainObject(issue).implementation)
      .filter((item) => item && typeof item === "object" && !Array.isArray(item));
    const filters = implementations.map((item) => prdWorkflowOverallPlainObject(item.filters));
    platforms[platform] = {
      ...platformValue,
      tags: prdWorkflowOverallUnique([
        ...(Array.isArray(platformValue.tags) ? platformValue.tags : []),
        ...implementations.flatMap((item) => Array.isArray(item.tags) ? item.tags : []),
      ]),
      experiments: prdWorkflowOverallUnique([
        ...(Array.isArray(platformValue.experiments) ? platformValue.experiments : []),
        ...implementations.flatMap((item) => Array.isArray(item.experiments) ? item.experiments : []),
      ]),
      settings: prdWorkflowOverallUnique([
        ...(Array.isArray(platformValue.settings) ? platformValue.settings : []),
        ...implementations.flatMap((item) => Array.isArray(item.settings) ? item.settings : []),
      ]),
      filters: {
        ...prdWorkflowOverallPlainObject(platformValue.filters),
        countries: prdWorkflowOverallUnique([
          ...prdWorkflowOverallFilterValues(platformValue.filters, "countries"),
          ...filters.flatMap((item) => prdWorkflowOverallFilterValues(item, "countries")),
        ]),
        users: prdWorkflowOverallUnique([
          ...prdWorkflowOverallFilterValues(platformValue.filters, "users"),
          ...filters.flatMap((item) => prdWorkflowOverallFilterValues(item, "users")),
        ]),
        versions: prdWorkflowOverallUnique([
          ...prdWorkflowOverallFilterValues(platformValue.filters, "versions"),
          ...filters.flatMap((item) => prdWorkflowOverallFilterValues(item, "versions")),
        ]),
      },
      rules: prdWorkflowOverallUnique([
        ...(Array.isArray(platformValue.rules) ? platformValue.rules : []),
        ...implementations.flatMap((item) => Array.isArray(item.rules) ? item.rules : []),
      ]),
      issues,
    };
  }
  return {
    ...overall,
    requirement,
    platforms,
  };
}

function prdWorkflowOverallFromEvents(tapdId, snapshot = {}, runtimeEvents = []) {
  const rawOverall =
    snapshot?.overall ||
    snapshot?.prdOverall ||
    snapshot?.prd_overall ||
    snapshot?.raw?.overall ||
    snapshot?.raw?.prdOverall ||
    snapshot?.raw?.prd_overall ||
    snapshot?.raw?.prd?.overall ||
    {};
  let overall = prdWorkflowOverallMerge({}, rawOverall);
  const events = [...(Array.isArray(runtimeEvents) ? runtimeEvents : [])].sort((left, right) => {
    const leftAt = Date.parse(left?.updatedAt || left?.completedAt || left?.createdAt || left?.observedAt || "");
    const rightAt = Date.parse(right?.updatedAt || right?.completedAt || right?.createdAt || right?.observedAt || "");
    if (!Number.isFinite(leftAt) && !Number.isFinite(rightAt)) return 0;
    if (!Number.isFinite(leftAt)) return -1;
    if (!Number.isFinite(rightAt)) return 1;
    return leftAt - rightAt;
  });
  for (const event of events) {
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const patch = event.overallPatch || event.overall_patch;
    if (patch && typeof patch === "object" && !Array.isArray(patch)) {
      overall = prdWorkflowOverallMerge(overall, patch);
    }
    const platform = String(event.platform || "").trim().toLowerCase();
    const issueKey = String(event.issueKey || event.issue_key || event.issue || "").trim();
    const actor = prdWorkflowOverallPlainObject(event.actor);
    if ((event.overallOwnerFromActor === true || event.overall_owner_from_actor === true) && platform && (actor.userId || actor.username)) {
      overall = prdWorkflowOverallMerge(overall, {
        platforms: {
          [platform]: {
            owner: {
              userId: String(actor.userId || ""),
              username: String(actor.username || actor.userId || ""),
              source: "latest-confirmed-plan",
              planVersion: event.planVersion || event.plan_version || "",
              updatedAt: event.updatedAt || event.completedAt || "",
            },
          },
        },
      });
    }
    const implementation = event.implementationMetadata || event.implementation_metadata;
    if (platform && issueKey && implementation && typeof implementation === "object" && !Array.isArray(implementation)) {
      overall = prdWorkflowOverallMerge(overall, {
        platforms: {
          [platform]: {
            issues: {
              [issueKey]: {
                title: String(event.issueTitle || event.issue_title || event.title || ""),
                implementation,
                mr: String(event?.changes?.impl_mr || event?.implMr || event?.impl_mr || ""),
                updatedAt: event.updatedAt || event.completedAt || "",
              },
            },
          },
        },
      });
    }
    const removePaths = event.overallRemove || event.overall_remove;
    for (const removePath of Array.isArray(removePaths) ? removePaths : []) {
      overall = prdWorkflowOverallDeletePath(overall, removePath);
    }
  }
  return prdWorkflowFinalizeOverall(tapdId, overall);
}

function prdWorkflowEventUpdatesOverall(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  return Boolean(
    event.overallPatch ||
    event.overall_patch ||
    event.overallOwnerFromActor === true ||
    event.overall_owner_from_actor === true ||
    event.implementationMetadata ||
    event.implementation_metadata ||
    (Array.isArray(event.overallRemove) && event.overallRemove.length) ||
    (Array.isArray(event.overall_remove) && event.overall_remove.length)
  );
}

function prdWorkflowGlobalStateFromEvents(tapdId, snapshot = {}, runtimeEvents = []) {
  let legacyOverall = prdWorkflowOverallFromEvents(tapdId, snapshot, []);
  let state = materializeWorkflowGlobalState(tapdId, snapshot, [], legacyOverall);
  const events = [...(Array.isArray(runtimeEvents) ? runtimeEvents : [])].sort((left, right) => {
    const leftAt = Date.parse(left?.updatedAt || left?.occurredAt || left?.completedAt || left?.createdAt || left?.observedAt || "");
    const rightAt = Date.parse(right?.updatedAt || right?.occurredAt || right?.completedAt || right?.createdAt || right?.observedAt || "");
    if (!Number.isFinite(leftAt) && !Number.isFinite(rightAt)) return 0;
    if (!Number.isFinite(leftAt)) return -1;
    if (!Number.isFinite(rightAt)) return 1;
    return leftAt - rightAt;
  });
  for (const event of events) {
    if (prdWorkflowEventUpdatesOverall(event)) {
      legacyOverall = prdWorkflowOverallFromEvents(tapdId, { overall: legacyOverall }, [event]);
      state = mergeWorkflowGlobalState(state, legacyOverallToGlobalState(tapdId, legacyOverall));
    }
    state = materializeWorkflowGlobalState(tapdId, { globalState: state }, [event], {});
  }
  return state;
}

function prdWorkflowChecklistActionKey(action = {}) {
  return String(
    action?.actionModel?.key ||
    action?.key ||
    action?.actionKey ||
    action?.action_key ||
    action?.action ||
    action?.actionId ||
    action?.action_id ||
    action?.stageKey ||
    action?.stage_key ||
    "",
  ).trim();
}

export function prdWorkflowChecklistResourceKey(producer, actionKey, itemKey) {
  return `checklist:${String(producer || "").trim().toLowerCase()}:${String(actionKey || "").trim()}:${String(itemKey || "").trim()}`;
}

function prdWorkflowChecklistStateEntries(runtimeEvents = []) {
  const states = new Map();
  for (const event of Array.isArray(runtimeEvents) ? runtimeEvents : []) {
    const state = event?.checklistState || event?.checklist_state;
    if (!state || typeof state !== "object" || Array.isArray(state)) continue;
    const producer = String(state.producer || state.source || "").trim().toLowerCase();
    const actionKey = String(state.actionKey || state.action_key || "").trim();
    const itemKey = String(state.itemKey || state.item_key || "").trim();
    if (!producer || !actionKey || !itemKey) continue;
    const resourceKey = prdWorkflowChecklistResourceKey(producer, actionKey, itemKey);
    const version = workflowSnapshotResourceVersions({ runtimeEvents: [event] })[resourceKey] || "absent";
    states.set(resourceKey, { ...state, producer, actionKey, itemKey, resourceKey, version });
  }
  return states;
}

function prdWorkflowMaterializeChecklists(snapshot = {}, runtimeEvents = []) {
  const actionSources = new Map();
  for (const event of Array.isArray(runtimeEvents) ? runtimeEvents : []) {
    const actionKey = prdWorkflowChecklistActionKey(event);
    const producer = String(event?.source || event?.producer || "").trim().toLowerCase();
    if (!actionKey || !producer || (!event?.checklist && !event?.actionModel?.checklist)) continue;
    const existing = actionSources.get(actionKey);
    actionSources.set(actionKey, existing && existing !== producer ? "" : producer);
  }
  const stateEntries = prdWorkflowChecklistStateEntries(runtimeEvents);
  const terminalStatuses = new Set(["passed", "skipped"]);
  const decorate = (action) => {
    if (!action || typeof action !== "object" || Array.isArray(action)) return action;
    const definition = action.checklist || action.actionModel?.checklist;
    if (!definition || typeof definition !== "object" || Array.isArray(definition)) return action;
    const actionKey = prdWorkflowChecklistActionKey(action);
    const producer = String(
      definition.source || action.source || action.producer || action.actionModel?.source || actionSources.get(actionKey) || "",
    ).trim().toLowerCase();
    const items = (Array.isArray(definition.items) ? definition.items : []).map((item) => {
      const itemKey = String(item?.key || item?.id || "").trim();
      const resourceKey = producer && actionKey && itemKey
        ? prdWorkflowChecklistResourceKey(producer, actionKey, itemKey)
        : "";
      const stored = resourceKey ? stateEntries.get(resourceKey) : null;
      const state = stored || {
        producer,
        actionKey,
        itemKey,
        status: "pending",
        note: "",
        evidence: [],
        resourceKey,
        version: "absent",
      };
      return { ...item, state };
    });
    const required = items.filter((item) => item.required !== false);
    const completed = items.filter((item) => terminalStatuses.has(String(item?.state?.status || "pending"))).length;
    const requiredCompleted = required.filter((item) => terminalStatuses.has(String(item?.state?.status || "pending"))).length;
    const completionPolicy = String(definition.completionPolicy || definition.completion_policy || "all_required").trim().toLowerCase();
    const completionCandidates = required.length ? required : items;
    const ready = completionPolicy === "manual"
      ? false
      : completionPolicy === "any_required"
        ? completionCandidates.some((item) => terminalStatuses.has(String(item?.state?.status || "pending")))
        : completionCandidates.length > 0 && completionCandidates.every((item) => terminalStatuses.has(String(item?.state?.status || "pending")));
    const checklist = {
      ...definition,
      source: producer,
      items,
      progress: {
        total: items.length,
        completed,
        required: required.length,
        requiredCompleted,
        percent: items.length ? Math.round((completed / items.length) * 100) : 0,
        ready,
      },
    };
    return {
      ...action,
      checklist,
      ...(action.actionModel && typeof action.actionModel === "object" && !Array.isArray(action.actionModel)
        ? { actionModel: { ...action.actionModel, checklist } }
        : {}),
    };
  };
  const out = { ...snapshot };
  for (const key of ["actions", "workflowActions", "workflow_actions", "timeline", "history", "events", "runtimeEvents", "runtime_events"]) {
    if (Array.isArray(snapshot?.[key])) out[key] = snapshot[key].map(decorate);
  }
  out.checklistStates = [...stateEntries.values()];
  return out;
}

export function prdWorkflowFindChecklistAction(snapshot = {}, producer = "", actionKey = "") {
  const wantedProducer = String(producer || "").trim().toLowerCase();
  const wantedActionKey = String(actionKey || "").trim();
  const matches = [];
  for (const key of ["actions", "workflowActions", "workflow_actions", "timeline", "history", "events", "runtimeEvents", "runtime_events"]) {
    for (const action of Array.isArray(snapshot?.[key]) ? snapshot[key] : []) {
      if (!action || typeof action !== "object" || Array.isArray(action)) continue;
      const checklist = action.checklist || action.actionModel?.checklist;
      if (!checklist || typeof checklist !== "object" || Array.isArray(checklist)) continue;
      const resolvedActionKey = prdWorkflowChecklistActionKey(action);
      const resolvedProducer = String(checklist.source || action.source || action.producer || "").trim().toLowerCase();
      if (resolvedActionKey !== wantedActionKey) continue;
      if (wantedProducer && resolvedProducer !== wantedProducer) continue;
      matches.push({ ...action, checklist, source: resolvedProducer || wantedProducer });
    }
  }
  return matches.at(-1) || null;
}

export function prdWorkflowMergeRuntimeEvents(scopedRoot, tapdId, snapshot) {
  const runtime = prdWorkflowReadRuntimeEvents(scopedRoot, tapdId);
  const runtimeEvents = runtime.events;
  const events = prdWorkflowMergeRuntimeEventList(snapshot?.events, runtimeEvents);
  const overall = prdWorkflowOverallFromEvents(tapdId, snapshot, runtimeEvents);
  const globalState = prdWorkflowGlobalStateFromEvents(tapdId, snapshot, runtimeEvents);
  const artifacts = mergeWorkflowArtifacts(snapshot?.artifacts, runtimeEvents);
  const projections = materializeWorkflowProjections(snapshot, runtimeEvents);
  const extensions = materializeWorkflowExtensions(snapshot, runtimeEvents);
  const prdFlowExtension = extensions["prd-flow"] && typeof extensions["prd-flow"] === "object"
    ? extensions["prd-flow"]
    : {};
  const prdFlowExtensionView = {};
  for (const key of ["issues", "issueGroups", "issue_groups", "epics", "epicGroups", "epic_groups", "aiDocs", "ai_docs"]) {
    if (Object.prototype.hasOwnProperty.call(prdFlowExtension, key)) prdFlowExtensionView[key] = prdFlowExtension[key];
  }
  let materialized = {
    ...snapshot,
    ...prdFlowExtensionView,
    workflow: globalState.workflow,
    overall,
    globalState,
    artifacts,
    projections,
    extensions,
    runtimeRevision: workflowRuntimeRevision(globalState, artifacts, runtimeEvents, projections, extensions),
    runtimeEvents,
    events,
    sources: {
      ...(snapshot?.sources && typeof snapshot.sources === "object" ? snapshot.sources : {}),
      runtimeEventsUpdatedAt: runtime.updatedAt || "",
    },
  };
  materialized = prdWorkflowMaterializeChecklists(materialized, runtimeEvents);
  materialized.resourceVersions = workflowSnapshotResourceVersions(materialized);
  return materialized;
}

export function prdWorkflowMockSnapshot(scopedRoot, tapdId = "mock-prd") {
  const id = String(tapdId || "mock-prd");
  const now = new Date().toISOString();
  return prdWorkflowMergeRuntimeEvents(scopedRoot, id, {
    tapdId: id,
    phase: "implementing",
    pointer: "实现中：Tunnel ConfigV3 支持",
    revision: "mock:tapd-ai-doc-gitlab-runtime",
    actions: [
      {
        id: "stage_tech_design",
        stage: "tech_design",
        action: "submit-tech-design",
        title: "确认技术方案",
        detail: "tech_design.md 与 TAPD baseline 已归档",
        status: "done",
        updatedAt: now,
        artifacts: [{ label: "技术方案", url: "https://example.com/ai-doc/stories/mock/tech_design.md" }],
      },
      {
        id: "stage_plan_android",
        stage: "submit-plan",
        action: "submit-plan",
        issueKey: "tunnel-config-v3",
        title: "提交 Android 实施计划",
        detail: "计划已确认，GitLab Issue 已绑定",
        status: "done",
        updatedAt: now,
        artifacts: [{ label: "Android Plan", url: "https://example.com/ai-doc/stories/mock/android-plan.md" }],
      },
      {
        id: "stage_implementation_tunnel-config-v3",
        stage: "implementation",
        action: "mark",
        issueKey: "tunnel-config-v3",
        title: "实现 Tunnel ConfigV3",
        detail: "Android MR 已创建，iOS 待处理",
        status: "current",
        updatedAt: now,
        dryRunSupported: true,
      },
    ],
    nextAction: {
      action: "mark",
      actionId: "mark-impl-mr",
      stage: "implementation",
      issueKey: "tunnel-config-v3",
      title: "记录实现 MR",
      detail: "验证 GitLab Issue/MR 关联后写入 Workflow runtime",
      dryRunSupported: true,
    },
    epics: [
      {
        key: "network-governance",
        title: "网络治理",
        issues: [
          {
            key: "tunnel-config-v3",
            title: "Tunnel ConfigV3 URI 云控支持",
            platform: "all",
            status: "implementing",
            issueUrl: "https://example.com/gitlab/issues/101",
            planDocUrl: "https://example.com/ai-doc/stories/mock/android-plan.md",
            mrs: [
              { label: "Android MR", platform: "android", url: "https://example.com/gitlab/mr/1", status: "opened" },
              { label: "iOS MR", platform: "ios", url: "https://example.com/gitlab/mr/2", status: "todo" },
            ],
          },
          {
            key: "self-test-package",
            parentKey: "tunnel-config-v3",
            title: "自测包与验证记录",
            platform: "all",
            status: "pending",
            links: [{ label: "临时 review", url: "https://example.com/review/mock" }],
          },
        ],
      },
    ],
    issues: [
      {
        key: "tunnel-config-v3",
        epicKey: "network-governance",
        title: "Tunnel ConfigV3 URI 云控支持",
        platform: "all",
        status: "implementing",
      },
    ],
    artifacts: [
      { label: "TAPD 需求", kind: "tapd", url: "https://example.com/tapd/mock" },
      { label: "技术方案", kind: "ai-doc", url: "https://example.com/ai-doc/stories/mock/tech_design.md" },
    ],
    optionalGaps: [{ severity: "info", text: "Mock snapshot: 用于验证 Workflow 阶段、Epic/Issue 层级和 MR 归类。" }],
    sources: { checkedAt: now, mock: true },
  });
}

function prdWorkflowWriteCachedSnapshot(scopedRoot, tapdId, snapshot) {
  try {
    const p = prdWorkflowCachePath(scopedRoot, tapdId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const data = {
      version: 1,
      tapdId: String(tapdId || ""),
      updatedAt: new Date().toISOString(),
      snapshot,
      sources: {
        truth: "projection",
        authority: "agentflow-runtime",
        persistence: "cache",
      },
    };
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
    fs.renameSync(tmp, p);
    return data;
  } catch {
    return null;
  }
}

function prdWorkflowFallbackWithCache(scopedRoot, tapdId, fallback, userCtx = {}, flowSource = "user", flowId = "") {
  const cached = prdWorkflowReadCachedSnapshot(scopedRoot, tapdId);
  const snapshot = cached?.snapshot && typeof cached.snapshot === "object" && !Array.isArray(cached.snapshot)
    ? cached.snapshot
    : null;
  if (!snapshot) {
    return {
      ...fallback,
      collaboration: prdWorkflowCollaborationState(userCtx, flowSource, flowId, tapdId),
    };
  }
  const optionalGaps = [
    ...(Array.isArray(fallback?.optionalGaps) ? fallback.optionalGaps : []),
    ...(Array.isArray(snapshot.optionalGaps) ? snapshot.optionalGaps : []),
  ];
  return prdWorkflowMergeRuntimeEvents(scopedRoot, tapdId, {
    ...snapshot,
    stale: true,
    runtimeStatus: fallback?.phase || "unavailable",
    runtimeMessage: fallback?.pointer || fallback?.error || "",
    optionalGaps,
    collaboration: prdWorkflowCollaborationState(userCtx, flowSource, flowId, tapdId),
    sources: {
      ...(snapshot.sources && typeof snapshot.sources === "object" ? snapshot.sources : {}),
      cacheUpdatedAt: cached.updatedAt || "",
      checkedAt: new Date().toISOString(),
    },
  });
}

export function prdWorkflowWithAgentflowTokenDiagnostic(snapshot, sessionToken = "") {
  const current = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? snapshot : {};
  const tokenPresent = Boolean(String(sessionToken || "").trim());
  const optionalGaps = Array.isArray(current.optionalGaps) ? [...current.optionalGaps] : [];
  const hasTokenHint = optionalGaps.some((gap) => /AgentFlow runtime token|AGENTFLOW_BASE_URL|AGENTFLOW_TOKEN|session token/i.test(String(gap?.text || gap || "")));
  if (!hasTokenHint) {
    optionalGaps.push({
      severity: "info",
      text: tokenPresent
        ? "当前浏览器会话已有 AgentFlow token。客户端 prd-flow skill/CLI 同步 Workflow 时还需要 AGENTFLOW_BASE_URL，并使用 AGENTFLOW_TOKEN 或 PRD_FLOW_RUNTIME_EVENT_TOKEN 上报 snapshot/event；不要把 token 写入 ai-doc 或 prd-flow config。"
        : "当前请求没有 AgentFlow session token。客户端 prd-flow skill/CLI 要同步 Workflow 时，需要在客户端 .env 配置 AGENTFLOW_BASE_URL 和 AGENTFLOW_TOKEN，或配置 PRD_FLOW_RUNTIME_BASE_URL 和 PRD_FLOW_RUNTIME_EVENT_TOKEN。",
    });
  }
  return {
    ...current,
    optionalGaps,
    sources: {
      ...(current.sources && typeof current.sources === "object" ? current.sources : {}),
      agentflowRuntimeToken: tokenPresent ? "session" : "not-required-for-local-ui",
    },
  };
}

export function prdWorkflowAllowServerExec() {
  return parseBool(process.env.AGENTFLOW_PRD_WORKFLOW_SERVER_EXEC, false);
}

export function prdWorkflowParseJson(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {}
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1));
    } catch (_) {}
  }
  return null;
}

function prdWorkflowFirstArray(...values) {
  const value = values.find((item) => Array.isArray(item));
  return value ? [...value] : [];
}

function prdWorkflowSplitCommand(command) {
  const text = String(command || "").trim();
  if (!text || /[\0\r\n]/.test(text) || text.length > 4000) return [];
  const tokens = [];
  let current = "";
  let quote = "";
  let escaping = false;
  for (const ch of text) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = "";
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (escaping) current += "\\";
  if (quote) return [];
  if (current) tokens.push(current);
  return tokens.filter(Boolean);
}

export function prdWorkflowCommandArgs(command) {
  const tokens = prdWorkflowSplitCommand(command);
  if (!tokens.length) return [];
  const first = tokens[0] || "";
  const start = path.basename(first) === "prd-flow" ? 1 : 0;
  const args = tokens.slice(start);
  const action = String(args[0] || "");
  if (!action || action.startsWith("-") || /[\/\\]/.test(action)) return [];
  return args;
}

export function prdWorkflowCommandTapdId(args = []) {
  for (const arg of args.slice(1)) {
    const value = String(arg || "").trim();
    if (!value || value.startsWith("-")) continue;
    return value;
  }
  return "";
}

function prdWorkflowNormalizeNextAction(parsed = {}, fallbackTapdId = "") {
  const raw = parsed.nextAction || parsed.next_action || parsed.currentAction || parsed.current_action || parsed.next || null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const command = String(raw.command || raw.nextCommand || raw.next_command || "").trim();
  const args = prdWorkflowCommandArgs(command);
  const action = String(raw.action || raw.actionId || raw.action_id || args[0] || raw.code || raw.id || "").trim();
  const issue = raw.issue && typeof raw.issue === "object" && !Array.isArray(raw.issue)
    ? String(raw.issue.key || raw.issue.id || raw.issue.title || "").trim()
    : String(raw.issue || raw.issueKey || raw.issue_key || "").trim();
  const title = String(raw.title || raw.label || raw.name || raw.code || action || "下一步").trim();
  return {
    ...raw,
    id: String(raw.id || raw.code || action || "next"),
    action,
    actionId: String(raw.actionId || raw.action_id || action),
    command,
    label: String(raw.label || title),
    title,
    detail: String(raw.detail || raw.description || raw.user_hint || raw.userHint || ""),
    issueKey: issue,
    tapdId: String(raw.tapdId || raw.tapd_id || prdWorkflowCommandTapdId(args) || fallbackTapdId || ""),
    dryRunSupported: raw.dryRunSupported !== false && raw.dry_run_supported !== false,
    dryRunMode: command ? "preview" : raw.dryRunMode || raw.dry_run_mode || "",
  };
}

export async function runPrdWorkflowCommand(root, scopedRoot, args = [], userCtx = {}, options = {}) {
  const cli = prdWorkflowResolveCli(root, scopedRoot);
  const cwd = scopedRoot || root || process.cwd();
  const env = runtimeEnvForUser(userCtx, {
    PRD_FLOW_WORKSPACE: path.join(cwd, ".workspace", "prd-flow"),
    ...(options.env && typeof options.env === "object" && !Array.isArray(options.env) ? options.env : {}),
  });
  const result = await execFileBuffered(cli.command, args, {
    cwd,
    env,
    timeout: Number(options.timeout || 120000),
    maxBuffer: Number(options.maxBuffer || 4 * 1024 * 1024),
  });
  return { ...result, cli };
}

export function prdWorkflowSnapshotFromParsed(scopedRoot, tapdId, parsed = {}, userCtx = {}, opts = {}) {
  const id = String(tapdId || parsed?.tapdId || parsed?.tapd_id || parsed?.prd?.tapd_id || parsed?.prd?.tapdId || "").trim();
  const flowSource = String(opts.flowSource || "user").trim() || "user";
  const flowId = String(opts.flowId || "").trim();
  const nextAction = prdWorkflowNormalizeNextAction(parsed, id);
  const prd = parsed.prd && typeof parsed.prd === "object" && !Array.isArray(parsed.prd) ? parsed.prd : {};
  const actions = prdWorkflowFirstArray(parsed.actions, parsed.workflowActions, parsed.workflow_actions);
  const epics = prdWorkflowFirstArray(parsed.epics, parsed.epicGroups, parsed.epic_groups, prd.epics, prd.epicGroups, prd.epic_groups);
  const issues = prdWorkflowFirstArray(parsed.issues, parsed.issueGroups, parsed.issue_groups, prd.issues, prd.issueGroups, prd.issue_groups);
  const optionalGaps = prdWorkflowFirstArray(parsed.optionalGaps, parsed.optional_gaps);
  if (!actions.length && !nextAction) {
    optionalGaps.push({ severity: "warn", text: "prd-flow current --json 未返回 actions/nextAction，Workflow 时间线只能显示 runtime 或空状态。" });
  }
  if (!epics.length && !issues.length) {
    optionalGaps.push({ severity: "info", text: "prd-flow current --json 未返回 epics/issues，Issue 整合区暂为空。" });
  }
  const snapshot = {
    tapdId: String(parsed.tapdId || parsed.tapd_id || prd.tapd_id || prd.tapdId || id),
    phase: String(parsed.phase || parsed.workflow_stage || nextAction?.id || parsed.next?.code || "unknown"),
    pointer: String(parsed.pointer || parsed.current || parsed.status || nextAction?.title || ""),
    revision: String(parsed.revision || prd.revision || parsed.next?.revision || ""),
    nextAction,
    actions,
    workflowActions: actions,
    timeline: prdWorkflowFirstArray(parsed.timeline),
    events: prdWorkflowFirstArray(parsed.events),
    history: prdWorkflowFirstArray(parsed.history),
    milestones: prdWorkflowFirstArray(parsed.milestones),
    epics,
    epicGroups: epics,
    issues,
    issueGroups: issues,
    artifacts: prdWorkflowFirstArray(parsed.artifacts, parsed.outputs),
    dependencies: prdWorkflowFirstArray(parsed.dependencies),
    optionalGaps,
    sources: parsed.sources && typeof parsed.sources === "object" ? parsed.sources : {},
    overall: prdWorkflowOverallFromEvents(id, {
      overall: parsed.overall || parsed.prdOverall || parsed.prd_overall || prd.overall || {},
    }, []),
    raw: parsed,
    collaboration: prdWorkflowCollaborationState(userCtx, flowSource, flowId, id),
  };
  snapshot.revision = prdWorkflowSnapshotRevision(snapshot);
  return snapshot;
}

export async function prdWorkflowSnapshot(root, scopedRoot, tapdId, userCtx = {}, opts = {}) {
  const id = String(tapdId || "").trim();
  const flowSource = String(opts.flowSource || "user").trim() || "user";
  const flowId = String(opts.flowId || "").trim();
  if (!id) {
    return {
      ...prdWorkflowFallbackSnapshot("", "unselected", "输入 TAPD ID 后读取 Workflow 状态"),
      collaboration: prdWorkflowCollaborationState(userCtx, flowSource, flowId, ""),
    };
  }
  if (!prdWorkflowAllowServerExec()) {
    return prdWorkflowMaterializeSnapshot(root, scopedRoot, id, userCtx, { flowSource, flowId });
  }
  try {
    const result = await runPrdWorkflowCommand(root, scopedRoot, ["current", id, "--json"], userCtx, { timeout: 120000 });
    const parsed = prdWorkflowParseJson(result.stdout);
    if (!parsed) {
      return prdWorkflowFallbackWithCache(scopedRoot, id, prdWorkflowFallbackSnapshot(id, "json_unsupported", "prd-flow current --json 暂不可用或未返回 JSON", {
        rawOutput: String(result.stdout || result.stderr || "").slice(0, 8000),
        cli: result.cli,
      }), userCtx, flowSource, flowId);
    }
    const snapshot = {
      ...prdWorkflowSnapshotFromParsed(scopedRoot, id, parsed, userCtx, opts),
      cli: result.cli,
    };
    const mergedSnapshot = prdWorkflowMergeRuntimeEvents(scopedRoot, id, snapshot);
    prdWorkflowWriteCachedSnapshot(scopedRoot, id, mergedSnapshot);
    return mergedSnapshot;
  } catch (e) {
    const code = e?.code || "";
    const stdout = String(e?.stdout || "");
    const stderr = String(e?.stderr || "");
    const missing = code === "ENOENT";
    return prdWorkflowFallbackWithCache(scopedRoot, id, prdWorkflowFallbackSnapshot(
      id,
      missing ? "unavailable" : "command_failed",
      missing ? "未找到 prd-flow CLI，请先在 workspace 配置 .workspace/prd-flow/bin/prd-flow 或设置 PRD_FLOW_CLI" : `prd-flow current --json 执行失败：${String(e?.message || e)}`,
      {
        rawOutput: `${stdout}${stdout && stderr ? "\n" : ""}${stderr}`.slice(0, 8000),
        error: String(e?.message || e),
      },
    ), userCtx, flowSource, flowId);
  }
}

function prdWorkflowActionText(payload = {}, normalized = {}) {
  return [
    normalized?.action,
    payload.action,
    payload.actionId,
    payload.action_id,
    payload.command,
    payload.marker,
    payload.flag,
    payload.stage,
    payload.stageKey,
    payload.stage_key,
    payload.title,
    payload.label,
  ].map((value) => String(value || "").trim()).filter(Boolean).join(" ");
}

function prdWorkflowFirstString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

export function prdWorkflowMarkerEventSpec(payload = {}, normalized = {}) {
  const text = prdWorkflowActionText(payload, normalized).toLowerCase().replace(/[_\s]+/g, "-");
  const explicitRuntimeOnly = payload.runtimeOnly === true || payload.runtime_only === true ||
    payload.markerOnly === true || payload.marker_only === true;
  const specs = [
    { re: /(^|-)mark-impl-mr($|-)|(^|-)record-impl-mr($|-)|--impl-mr\b/, stage: "implementation", title: "记录实现 MR", kind: "impl-mr" },
    { re: /(^|-)mark-fix-mr($|-)|(^|-)record-fix-mr($|-)|--fix-mr\b/, stage: "bugfix", title: "记录修复 MR", kind: "fix-mr" },
    { re: /(^|-)mark-impl-done($|-)|--impl-done\b/, stage: "implementation", title: "实现完成标记", kind: "impl-done" },
    { re: /(^|-)mark-impl-merged($|-)|--impl-merged\b/, stage: "implementation", title: "实现 MR 合并标记", kind: "impl-merged" },
    { re: /(^|-)mark-integration-mr($|-)|(^|-)record-integration-mr($|-)|--integration-mr\b/, stage: "submit-test", title: "记录集成 MR", kind: "integration-mr" },
    { re: /(^|-)mark-integrated($|-)|--integrated\b/, stage: "submit-test", title: "集成完成标记", kind: "integrated" },
    { re: /(^|-)retry-jenkins($|-)|(^|-)retry-jenkins-build($|-)|(^|-)record-jenkins($|-)/, stage: "self-test", title: "Jenkins 构建记录", kind: "jenkins" },
    { re: /(^|-)record-test-mr($|-)|(^|-)test-mr($|-)/, stage: "submit-test", title: "记录提测 MR", kind: "test-mr" },
  ];
  let matched = specs.find((spec) => spec.re.test(text));
  if (!matched && explicitRuntimeOnly) {
    matched = {
      stage: prdWorkflowFirstString(payload.stageKey, payload.stage_key, payload.stage, normalized.action, payload.action, "workflow"),
      title: prdWorkflowFirstString(payload.title, payload.label, normalized.action, payload.action, "Workflow runtime action"),
      kind: "runtime",
    };
  }
  if (!matched) return null;
  const issueKey = prdWorkflowFirstString(payload.issueKey, payload.issue_key, payload.issue);
  const url = prdWorkflowFirstString(payload.url, payload.href, payload.mr, payload.mrUrl, payload.mr_url, payload.mergeRequestUrl, payload.merge_request_url);
  const links = Array.isArray(payload.links) ? payload.links : [];
  const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
  const title = prdWorkflowFirstString(payload.title, payload.label, matched.title);
  const stage = prdWorkflowFirstString(payload.stageKey, payload.stage_key, payload.stage, matched.stage);
  const linkArtifacts = url ? [{ kind: matched.kind, label: title, url }] : [];
  return {
    runtimeOnly: true,
    kind: matched.kind,
    stage,
    title,
    issueKey,
    detail: prdWorkflowFirstString(payload.detail, payload.description, payload.summary, url ? "记录外部系统事实，不写 ai-doc marker" : "记录运行态事实，不写 ai-doc marker"),
    links,
    artifacts: [...artifacts, ...linkArtifacts],
  };
}
