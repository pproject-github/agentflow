import crypto from "crypto";
import fs from "fs";
import path from "path";

import { collectPipelineNamesFromDir, listFlowsJson, readPipelineListDescription } from "./catalog-flows.mjs";
import { listMarketplaceNodes } from "./marketplace.mjs";
import { marketplaceStatsFor, marketplaceUsageStats, normalizeMarketplaceVisibility, readMarketplaceFlowOrigin } from "./marketplace-usage.mjs";
import {
  getAgentflowDataRoot,
  getUserPipelinesRoot,
  listAgentflowUserIds,
} from "./paths.mjs";
import { getWorkspaceCollaborationByFlow } from "./workspace-collaboration.mjs";
import { onRepositoryRunFinished } from "./repository-index-events.mjs";
import { workspaceDesignRevision } from "./workspace-graph-merge.mjs";
import {
  readWorkspaceGraph,
  readWorkspaceReleaseStatus,
  readWorkspaceRunUsageRecords,
  readWorkspaceStableRelease,
  workspaceRunPlan,
} from "./workspace-server.mjs";

const REPOSITORY_INDEX_VERSION = 3;
const REPOSITORY_INDEX_FILENAME = "repository-index.json";
const REPOSITORY_INDEX_MAX_AGE_MS = 5 * 60 * 1000;
const memoryIndexes = new Map();
const pendingRebuilds = new Set();
const pendingWrites = new Map();

function indexKey(workspaceRoot) {
  return path.resolve(workspaceRoot);
}

export function repositoryIndexPath(workspaceRoot) {
  const root = indexKey(workspaceRoot);
  const rootKey = crypto.createHash("sha256").update(root).digest("hex").slice(0, 20);
  return path.join(getAgentflowDataRoot(), "admin", "repository-index", `${rootKey}-${REPOSITORY_INDEX_FILENAME}`);
}

export function projectFlowRepositoryId(ownerUserId, flowSource, flowId) {
  return `project-flow:${String(ownerUserId || "").trim()}:${String(flowSource || "user").trim()}:${String(flowId || "").trim()}`;
}

const PROJECT_FLOW_MARKETPLACE_FILENAME = path.join(".workspace", "agentflow", "marketplace.json");

export function projectFlowMarketplaceMetadataPath(flowRoot) {
  return path.join(path.resolve(flowRoot), PROJECT_FLOW_MARKETPLACE_FILENAME);
}

export function readProjectFlowMarketplaceMetadata(flowRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(projectFlowMarketplaceMetadataPath(flowRoot), "utf-8"));
    return {
      visibility: String(parsed?.visibility || "").trim() === "private" ? "private" : "public",
      updatedAt: String(parsed?.updatedAt || "").trim(),
    };
  } catch {
    return { visibility: "public", updatedAt: "" };
  }
}

export function writeProjectFlowMarketplaceMetadata(flowRoot, visibility) {
  const filePath = projectFlowMarketplaceMetadataPath(flowRoot);
  const value = {
    version: 1,
    visibility: String(visibility || "").trim() === "private" ? "private" : "public",
    updatedAt: new Date().toISOString(),
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  fs.renameSync(tempPath, filePath);
  return value;
}

function projectFlowUpdatedAt(flowRoot, metadata = {}) {
  if (metadata.updatedAt) return metadata.updatedAt;
  try {
    return fs.statSync(path.resolve(flowRoot)).mtime.toISOString();
  } catch {
    return "";
  }
}

function validIsoFromMs(value) {
  const time = Number(value || 0);
  if (!Number.isFinite(time) || time <= 0) return "";
  try {
    return new Date(time).toISOString();
  } catch {
    return "";
  }
}

function runUsageKey(ownerId, flowSource, flowId, runNodeId = "") {
  return [ownerId, flowSource || "user", flowId, runNodeId].map((item) => String(item || "").trim()).join("\u0000");
}

function aggregateSuccessfulRuns() {
  const aggregate = new Map();
  for (const run of readWorkspaceRunUsageRecords()) {
    if (run?.status !== "success") continue;
    const flowSource = String(run.flowSource || "user");
    const ownerId = flowSource === "user" ? String(run.userId || "") : "";
    const key = runUsageKey(ownerId, flowSource, run.flowId, run.runNodeId || "");
    const current = aggregate.get(key) || { count: 0, lastUsedAt: "" };
    current.count += 1;
    const at = validIsoFromMs(run.endedAt || run.at);
    if (at && (!current.lastUsedAt || at > current.lastUsedAt)) current.lastUsedAt = at;
    aggregate.set(key, current);
  }
  return aggregate;
}

export function runnableProjectFlowEntries(graph, scopedRoot = "", options = {}) {
  const includeGraph = options.includeGraph === true;
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  const entries = Object.entries(instances).filter(([, instance]) => (
    instance?.definitionId === "workspace_run"
    || instance?.definitionId === "workspace_scheduled_run"
  ));
  return entries.flatMap(([entryId, entry]) => {
    let plan;
    try {
      plan = workspaceRunPlan(graph, entryId, scopedRoot, { ignoreCache: true });
    } catch {
      return [];
    }
    const executedNodeIds = Array.from(new Set((plan.order || []).map((id) => String(id || "").trim()).filter(Boolean)));
    if (executedNodeIds.length === 0) return [];
    const includedNodeIds = new Set([entryId, ...executedNodeIds]);
    const base = {
      entryId,
      entry,
      runMode: entry.definitionId === "workspace_scheduled_run" ? "scheduled" : "manual",
      nodeCount: includedNodeIds.size,
      edgeCount: (Array.isArray(graph?.edges) ? graph.edges : []).filter((edge) => (
        includedNodeIds.has(String(edge?.source || ""))
        && includedNodeIds.has(String(edge?.target || ""))
      )).length,
    };
    if (!includeGraph) return [base];
    const positions = graph?.ui?.nodePositions && typeof graph.ui.nodePositions === "object"
      ? Object.fromEntries(Object.entries(graph.ui.nodePositions).filter(([id]) => includedNodeIds.has(id)))
      : {};
    const sizes = graph?.ui?.nodeSizes && typeof graph.ui.nodeSizes === "object"
      ? Object.fromEntries(Object.entries(graph.ui.nodeSizes).filter(([id]) => includedNodeIds.has(id)))
      : {};
    return [{
      ...base,
      graph: {
        ...graph,
        instances: Object.fromEntries(Object.entries(instances).filter(([id]) => includedNodeIds.has(id))),
        edges: (Array.isArray(graph?.edges) ? graph.edges : []).filter((edge) => (
          includedNodeIds.has(String(edge?.source || ""))
          && includedNodeIds.has(String(edge?.target || ""))
        )),
        ui: { ...(graph?.ui || {}), nodePositions: positions, nodeSizes: sizes },
      },
    }];
  });
}

function scanProjectFlows(workspaceRoot, usageStats) {
  const directRuns = aggregateSuccessfulRuns();
  const resources = [];
  const appendFlow = (ownerId, flow, flowSource = "user", workspaceId = "") => {
    if (!ownerId || flow.archived || !flow.path) return;
    let draftGraph;
    let releaseStatus;
    try {
      draftGraph = readWorkspaceGraph(flow.path, workspaceRoot).graph;
      releaseStatus = readWorkspaceReleaseStatus(flow.path, workspaceRoot, draftGraph);
    } catch {
      return;
    }
    const runnableEntries = (releaseStatus.entries || []).map((entryStatus) => {
      const stable = readWorkspaceStableRelease(flow.path, workspaceRoot, entryStatus.entryNodeId);
      const graph = stable?.graph || draftGraph;
      const runnable = runnableProjectFlowEntries(graph, stable?.root || flow.path)
        .find((item) => item.entryId === entryStatus.entryNodeId);
      return runnable ? { runnable, entryStatus, stable, graph } : null;
    }).filter(Boolean);
    if (runnableEntries.length === 0) return;
    const metadata = readProjectFlowMarketplaceMetadata(flow.path);
    for (const resolved of runnableEntries) {
      const { runnable, entryStatus, stable, graph } = resolved;
      const baseId = projectFlowRepositoryId(ownerId, flowSource, flow.id);
      const id = runnableEntries.length === 1 ? baseId : `${baseId}:${runnable.entryId}`;
      const version = stable?.release?.id || `current-${String(entryStatus.draftRevision || workspaceDesignRevision(graph)).slice(0, 12)}`;
      const releaseState = stable?.release?.id ? "stable" : "draft";
      const hasUnpublishedChanges = Boolean(entryStatus.hasDraftChanges);
      const rawEntryLabel = String(runnable.entry?.label || "").trim();
      const genericLabel = ["", "Run", "Scheduled Run", "运行", "定时运行"].includes(rawEntryLabel);
      const exactOwner = flowSource === "user" ? ownerId : "";
      const exactRuns = directRuns.get(runUsageKey(exactOwner, flowSource, flow.id, runnable.entryId));
      const unscopedRuns = runnableEntries.length === 1
        ? directRuns.get(runUsageKey(exactOwner, flowSource, flow.id, ""))
        : null;
      const telemetry = marketplaceStatsFor(usageStats, "project-flow", id, version);
      const directCount = Number(exactRuns?.count || 0) + Number(unscopedRuns?.count || 0);
      const directLastUsedAt = [exactRuns?.lastUsedAt, unscopedRuns?.lastUsedAt].filter(Boolean).sort().at(-1) || "";
      resources.push({
        resourceType: "flow",
        projectFlow: true,
        id,
        definitionId: `${flow.id}/${runnable.entryId}`,
        displayName: runnableEntries.length === 1 ? flow.id : `${flow.id} · ${genericLabel ? runnable.entryId : rawEntryLabel}`,
        description: flow.description || "",
        version,
        versionLabel: stable?.release?.id ? `Stable ${stable.release.id}` : "当前版本",
        releaseState,
        stableReleaseId: stable?.release?.id || "",
        hasUnpublishedChanges,
        runMode: runnable.runMode,
        runModeLabel: runnable.runMode === "scheduled" ? "定时运行" : "手动运行",
        ownerUserId: ownerId,
        liveOwnerUserId: ownerId,
        liveFlowId: flow.id,
        liveFlowSource: flowSource,
        liveWorkspaceId: workspaceId,
        liveEntryId: runnable.entryId,
        installFlowId: runnableEntries.length === 1 ? flow.id : `${flow.id}-${runnable.entryId}`,
        visibility: metadata.visibility,
        nodeCount: runnable.nodeCount,
        edgeCount: runnable.edgeCount,
        updatedAt: projectFlowUpdatedAt(flow.path, metadata),
        ...telemetry,
        useCount: telemetry.useCount + directCount,
        lastUsedAt: [telemetry.lastUsedAt, directLastUsedAt].filter(Boolean).sort().at(-1) || "",
        flowRoot: flow.path,
      });
    }
  };

  for (const ownerUserId of listAgentflowUserIds()) {
    const ownerId = String(ownerUserId || "").trim();
    const pipelinesRoot = getUserPipelinesRoot(ownerId);
    for (const flowId of collectPipelineNamesFromDir(pipelinesRoot)) {
      const flowRoot = path.join(pipelinesRoot, flowId);
      const description = readPipelineListDescription(flowRoot);
      appendFlow(ownerId, { id: flowId, path: flowRoot, ...(description ? { description } : {}) }, "user");
    }
  }
  for (const flow of listFlowsJson(workspaceRoot, { userId: "", includeWorkspaceFlows: true })) {
    if ((flow.source || "") !== "workspace" || flow.archived || !flow.path) continue;
    const collaboration = getWorkspaceCollaborationByFlow(flow.id, false);
    const ownerId = String(collaboration?.ownerId || "").trim();
    if (ownerId) appendFlow(ownerId, flow, "workspace", collaboration.id);
  }
  return resources;
}

function scanNodes(workspaceRoot, usageStats) {
  return listMarketplaceNodes(workspaceRoot, null, { userId: "", isAdmin: true, marketplaceScope: "all" }).map((node) => ({
    id: node.id,
    version: node.version,
    definitionId: node.definitionId,
    baseDefinitionId: node.baseDefinitionId,
    displayName: node.displayName,
    description: node.description,
    inputs: node.input,
    outputs: node.output,
    ui: node.ui,
    packagedFiles: Array.isArray(node.packagedFiles) ? node.packagedFiles : [],
    fileList: Array.isArray(node.fileList) ? node.fileList : [],
    fileCount: Number(node.fileCount) || 0,
    totalBytes: Number(node.totalBytes) || 0,
    contentSha256: String(node.contentSha256 || ""),
    archiveSha256: String(node.archiveSha256 || ""),
    installedFrom: String(node.installedFrom || ""),
    installedAt: String(node.installedAt || ""),
    ownerUserId: node.ownerUserId || node.createdBy || "",
    createdBy: node.createdBy || node.ownerUserId || "",
    visibility: normalizeMarketplaceVisibility(node.visibility),
    packageDir: node.packageDir,
    source: node.source || "marketplace",
    resourceType: "node",
    installed: true,
    ...marketplaceStatsFor(usageStats, "node", node.id, node.version, node.ownerUserId || node.createdBy || ""),
  }));
}

function scanFlowInstallations() {
  const installations = {};
  for (const rawUserId of listAgentflowUserIds()) {
    const userId = String(rawUserId || "").trim();
    if (!userId) continue;
    const pipelinesRoot = getUserPipelinesRoot(userId);
    const entries = [];
    for (const flowId of collectPipelineNamesFromDir(pipelinesRoot)) {
      const origin = readMarketplaceFlowOrigin(path.join(pipelinesRoot, flowId));
      if (!origin) continue;
      entries.push({ key: `${origin.id}@${origin.version}`, flowId });
    }
    if (entries.length > 0) installations[userId] = entries;
  }
  return installations;
}

function writeIndex(workspaceRoot, index) {
  const filePath = repositoryIndexPath(workspaceRoot);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(index)}\n`, "utf-8");
  fs.renameSync(tempPath, filePath);
}

function scheduleIndexWrite(workspaceRoot) {
  const root = indexKey(workspaceRoot);
  if (pendingWrites.has(root)) return;
  const timer = setTimeout(() => {
    pendingWrites.delete(root);
    const index = memoryIndexes.get(root);
    if (!index) return;
    try { writeIndex(root, index); } catch {}
  }, 250);
  timer.unref?.();
  pendingWrites.set(root, timer);
}

function readIndex(workspaceRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(repositoryIndexPath(workspaceRoot), "utf-8"));
    if (
      parsed?.version !== REPOSITORY_INDEX_VERSION
      || parsed.workspaceRoot !== indexKey(workspaceRoot)
      || !Array.isArray(parsed.flows)
      || !Array.isArray(parsed.nodes)
    ) return null;
    if (!parsed.installations || typeof parsed.installations !== "object" || Array.isArray(parsed.installations)) parsed.installations = {};
    return parsed;
  } catch {
    return null;
  }
}

export function rebuildRepositoryIndex(workspaceRoot) {
  const root = indexKey(workspaceRoot);
  const usageStats = marketplaceUsageStats(root);
  const index = {
    version: REPOSITORY_INDEX_VERSION,
    workspaceRoot: root,
    generatedAt: new Date().toISOString(),
    flows: scanProjectFlows(root, usageStats),
    nodes: scanNodes(root, usageStats),
    installations: scanFlowInstallations(),
  };
  memoryIndexes.set(root, index);
  writeIndex(root, index);
  return index;
}

function scheduleRebuild(workspaceRoot) {
  const root = indexKey(workspaceRoot);
  if (pendingRebuilds.has(root)) return;
  pendingRebuilds.add(root);
  setImmediate(() => {
    try {
      rebuildRepositoryIndex(root);
    } catch {
      // The last valid index remains available; the next request retries reconciliation.
    } finally {
      pendingRebuilds.delete(root);
    }
  });
}

export function getRepositoryIndex(workspaceRoot, options = {}) {
  const root = indexKey(workspaceRoot);
  if (options.force === true) return rebuildRepositoryIndex(root);
  let index = memoryIndexes.get(root);
  if (!index) {
    index = readIndex(root);
    if (index) memoryIndexes.set(root, index);
  }
  if (!index) return rebuildRepositoryIndex(root);
  const generatedAt = Date.parse(index.generatedAt || "");
  if (!Number.isFinite(generatedAt) || Date.now() - generatedAt > REPOSITORY_INDEX_MAX_AGE_MS) scheduleRebuild(root);
  return index;
}

export function markRepositoryIndexDirty(workspaceRoot) {
  scheduleRebuild(workspaceRoot);
}

export function updateIndexedProjectFlowVisibility(workspaceRoot, id, visibility, updatedAt = "") {
  const root = indexKey(workspaceRoot);
  const index = getRepositoryIndex(root);
  let changed = false;
  const flows = index.flows.map((flow) => {
    if (flow.id !== id) return flow;
    changed = true;
    return { ...flow, visibility: visibility === "private" ? "private" : "public", updatedAt: updatedAt || flow.updatedAt };
  });
  if (!changed) return false;
  const next = { ...index, generatedAt: new Date().toISOString(), flows };
  memoryIndexes.set(root, next);
  writeIndex(root, next);
  return true;
}

export function updateIndexedNodeVisibility(workspaceRoot, id, version, visibility) {
  const root = indexKey(workspaceRoot);
  const index = getRepositoryIndex(root);
  let changed = false;
  const nodes = index.nodes.map((node) => {
    if (node.id !== id || node.version !== version) return node;
    changed = true;
    return { ...node, visibility: visibility === "private" ? "private" : "public" };
  });
  if (!changed) return false;
  const next = { ...index, generatedAt: new Date().toISOString(), nodes };
  memoryIndexes.set(root, next);
  writeIndex(root, next);
  return true;
}

export function recordIndexedProjectFlowUse(workspaceRoot, run = {}) {
  const root = indexKey(workspaceRoot);
  let index = memoryIndexes.get(root);
  if (!index) {
    index = readIndex(root);
    if (index) memoryIndexes.set(root, index);
  }
  if (!index) return false;
  const flowId = String(run.flowId || "").trim();
  const flowSource = String(run.flowSource || "user").trim() || "user";
  const runNodeId = String(run.runNodeId || "").trim();
  const userId = String(run.userId || "").trim();
  const candidates = flowId ? index.flows.filter((flow) => (
    flow.liveFlowId === flowId
    && flow.liveFlowSource === flowSource
    && (flowSource !== "user" || flow.ownerUserId === userId)
  )) : [];
  const matchingIds = new Set(
    candidates
      .filter((flow) => !runNodeId || flow.liveEntryId === runNodeId || candidates.length === 1)
      .map((flow) => flow.id),
  );
  for (const resource of Array.isArray(run.marketplaceResources) ? run.marketplaceResources : []) {
    if (resource?.kind !== "project-flow") continue;
    const resourceId = String(resource.id || "");
    const resourceVersion = String(resource.version || "");
    for (const flow of index.flows) {
      if (flow.id === resourceId && flow.version === resourceVersion) matchingIds.add(flow.id);
    }
  }
  const usedNodes = new Set((Array.isArray(run.marketplaceResources) ? run.marketplaceResources : [])
    .filter((resource) => resource?.kind === "node")
    .map((resource) => `${String(resource.id || "")}@${String(resource.version || "")}`));
  if (matchingIds.size === 0 && usedNodes.size === 0) return false;
  const at = validIsoFromMs(run.endedAt || run.at || Date.now()) || new Date().toISOString();
  const flows = index.flows.map((flow) => matchingIds.has(flow.id) ? {
    ...flow,
    useCount: Number(flow.useCount || 0) + 1,
    lastUsedAt: !flow.lastUsedAt || at > flow.lastUsedAt ? at : flow.lastUsedAt,
  } : flow);
  const nodes = index.nodes.map((node) => usedNodes.has(`${node.id}@${node.version}`) ? {
    ...node,
    useCount: Number(node.useCount || 0) + 1,
    lastUsedAt: !node.lastUsedAt || at > node.lastUsedAt ? at : node.lastUsedAt,
  } : node);
  const next = { ...index, flows, nodes };
  memoryIndexes.set(root, next);
  scheduleIndexWrite(root);
  return true;
}

onRepositoryRunFinished((workspaceRoot, run, status) => {
  if (status === "success") recordIndexedProjectFlowUse(workspaceRoot, run);
});

function canAccessResource(item, userCtx = {}, scope = "all") {
  const userId = String(userCtx.userId || "").trim();
  const owned = String(item.ownerUserId || "").trim() === userId;
  if (scope === "owned" && !owned && userCtx.isAdmin !== true) return false;
  if (scope !== "owned" && item.visibility === "private" && !owned && userCtx.isAdmin !== true) return false;
  return true;
}

export function listIndexedProjectFlows(workspaceRoot, userCtx = {}, scope = "all") {
  return getRepositoryIndex(workspaceRoot).flows
    .filter((item) => canAccessResource(item, userCtx, scope))
    .map((item) => ({ ...item, _flowRoot: item.flowRoot }));
}

export function listIndexedNodes(workspaceRoot, userCtx = {}, scope = "all") {
  return getRepositoryIndex(workspaceRoot).nodes
    .filter((item) => canAccessResource(item, userCtx, scope));
}

export function indexedMarketplaceFlowCopies(workspaceRoot, userId) {
  const entries = getRepositoryIndex(workspaceRoot).installations?.[String(userId || "").trim()] || [];
  const copies = new Map();
  for (const entry of entries) {
    const flowIds = copies.get(entry.key) || [];
    flowIds.push(entry.flowId);
    copies.set(entry.key, flowIds);
  }
  return copies;
}

export function indexedProjectFlowPreview(workspaceRoot, indexedFlow) {
  if (!indexedFlow?.flowRoot) return null;
  let stable;
  let graph;
  try {
    stable = readWorkspaceStableRelease(indexedFlow.flowRoot, workspaceRoot, indexedFlow.liveEntryId);
    graph = stable?.graph || readWorkspaceGraph(indexedFlow.flowRoot, workspaceRoot).graph;
  } catch {
    return null;
  }
  const version = stable?.release?.id || `current-${workspaceDesignRevision(graph).slice(0, 12)}`;
  if (version !== indexedFlow.version) return { stale: true, version };
  const runnable = runnableProjectFlowEntries(graph, indexedFlow.flowRoot, { includeGraph: true })
    .find((item) => item.entryId === indexedFlow.liveEntryId);
  if (!runnable) return null;
  return { graph: runnable.graph, version };
}

export function clearRepositoryIndexMemoryForTest(workspaceRoot = "") {
  if (workspaceRoot) {
    const root = indexKey(workspaceRoot);
    memoryIndexes.delete(root);
    const timer = pendingWrites.get(root);
    if (timer) clearTimeout(timer);
    pendingWrites.delete(root);
  } else {
    memoryIndexes.clear();
    for (const timer of pendingWrites.values()) clearTimeout(timer);
    pendingWrites.clear();
  }
}
