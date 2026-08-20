import fs from "fs";
import path from "path";

import { MARKETPLACE_PACKAGES_DIR } from "./paths.mjs";

const USAGE_DIRNAME = "usage";
const FLOW_ORIGIN_FILENAME = ".agentflow-marketplace-origin.json";

function usageRoot(workspaceRoot) {
  return path.join(path.resolve(workspaceRoot), path.dirname(MARKETPLACE_PACKAGES_DIR), USAGE_DIRNAME);
}

function dayKey(timeMs) {
  const date = new Date(Number(timeMs) || Date.now());
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

function safeText(value, max = 240) {
  return String(value || "").trim().slice(0, max);
}

export function normalizeMarketplaceVisibility(value, fallback = "public") {
  const normalized = safeText(value, 20).toLowerCase();
  if (normalized === "private") return "private";
  if (normalized === "public") return "public";
  return fallback === "private" ? "private" : "public";
}

export function marketplaceResourceKey(kind, id, version) {
  return `${safeText(kind, 32)}:${safeText(id)}@${safeText(version, 80)}`;
}

export function appendMarketplaceUsageEvent(workspaceRoot, event = {}) {
  try {
    const kind = safeText(event.kind, 32);
    const id = safeText(event.id);
    const version = safeText(event.version, 80);
    const action = safeText(event.action, 32);
    const actorUserId = safeText(event.actorUserId || event.userId, 160);
    const at = Number(event.at || Date.now());
    const eventId = safeText(
      event.eventId || `${action}:${kind}:${id}@${version}:${actorUserId}:${at}`,
      500,
    );
    if (!kind || !id || !version || !["install", "use"].includes(action) || !eventId) return false;
    const record = {
      version: 1,
      eventId,
      kind,
      id,
      resourceVersion: version,
      action,
      actorUserId,
      runId: safeText(event.runId, 240),
      at: Number.isFinite(at) && at > 0 ? at : Date.now(),
    };
    const filePath = path.join(usageRoot(workspaceRoot), `${dayKey(record.at)}.jsonl`);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf-8");
    return true;
  } catch {
    // Marketplace telemetry must never break publishing, installing, or running.
    return false;
  }
}

function readUsageEvents(workspaceRoot) {
  const dir = usageRoot(workspaceRoot);
  if (!fs.existsSync(dir)) return [];
  const events = [];
  try {
    const files = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name))
      .map((entry) => path.join(dir, entry.name))
      .sort();
    for (const filePath of files) {
      for (const line of fs.readFileSync(filePath, "utf-8").split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) events.push(parsed);
        } catch {
          // Ignore individual malformed telemetry records.
        }
      }
    }
  } catch {
    return [];
  }
  return events;
}

export function marketplaceUsageStats(workspaceRoot) {
  const byResource = new Map();
  const seenEvents = new Set();
  for (const event of readUsageEvents(workspaceRoot)) {
    const eventId = safeText(event.eventId, 500);
    if (!eventId || seenEvents.has(eventId)) continue;
    seenEvents.add(eventId);
    const key = marketplaceResourceKey(event.kind, event.id, event.resourceVersion);
    if (!byResource.has(key)) {
      byResource.set(key, {
        useCount: 0,
        installCount: 0,
        uniqueUserCount: 0,
        lastUsedAt: "",
        _users: new Set(),
        _actors: new Map(),
      });
    }
    const stats = byResource.get(key);
    const actorUserId = safeText(event.actorUserId, 160);
    if (actorUserId) stats._users.add(actorUserId);
    if (actorUserId && !stats._actors.has(actorUserId)) stats._actors.set(actorUserId, { useCount: 0, installCount: 0 });
    if (event.action === "use") {
      stats.useCount += 1;
      if (actorUserId) stats._actors.get(actorUserId).useCount += 1;
      const atIso = new Date(Number(event.at) || 0).toISOString();
      if (!stats.lastUsedAt || atIso > stats.lastUsedAt) stats.lastUsedAt = atIso;
    } else if (event.action === "install") {
      stats.installCount += 1;
      if (actorUserId) stats._actors.get(actorUserId).installCount += 1;
    }
  }
  for (const stats of byResource.values()) {
    stats.uniqueUserCount = stats._users.size;
  }
  return byResource;
}

export function marketplaceStatsFor(statsByResource, kind, id, version, ownerUserId = "") {
  const stats = statsByResource.get(marketplaceResourceKey(kind, id, version));
  if (!stats) return {
    useCount: 0,
    installCount: 0,
    uniqueUserCount: 0,
    lastUsedAt: "",
  };
  const owner = safeText(ownerUserId, 160);
  const ownerStats = owner ? stats._actors.get(owner) : null;
  return {
    useCount: Math.max(0, stats.useCount - Number(ownerStats?.useCount || 0)),
    installCount: Math.max(0, stats.installCount - Number(ownerStats?.installCount || 0)),
    uniqueUserCount: Math.max(0, stats.uniqueUserCount - (owner && stats._users.has(owner) ? 1 : 0)),
    lastUsedAt: stats.lastUsedAt,
  };
}

export function marketplaceFlowOriginPath(flowDir) {
  return path.join(path.resolve(flowDir), FLOW_ORIGIN_FILENAME);
}

export function writeMarketplaceFlowOrigin(flowDir, origin = {}) {
  const kind = safeText(origin.kind, 32) === "project-flow" ? "project-flow" : "flow";
  const value = {
    kind,
    id: safeText(origin.id),
    version: safeText(origin.version, 80),
    installedAt: safeText(origin.installedAt || new Date().toISOString(), 80),
  };
  if (!value.id || !value.version) throw new Error("Invalid marketplace flow origin");
  fs.writeFileSync(marketplaceFlowOriginPath(flowDir), `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  return value;
}

export function readMarketplaceFlowOrigin(flowDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(marketplaceFlowOriginPath(flowDir), "utf-8"));
    if (!["flow", "project-flow"].includes(parsed?.kind) || !parsed.id || !parsed.version) return null;
    return { kind: parsed.kind, id: String(parsed.id), version: String(parsed.version) };
  } catch {
    return null;
  }
}

function parseMarketplaceNodeRef(instance = {}) {
  const ref = safeText(instance.marketplaceRef || instance.definitionId, 500);
  if (!ref.startsWith("marketplace:")) return null;
  const spec = ref.slice("marketplace:".length);
  const at = spec.lastIndexOf("@");
  if (at <= 0 || at === spec.length - 1) return null;
  return { kind: "node", id: spec.slice(0, at), version: spec.slice(at + 1) };
}

export function marketplaceResourcesForRun(flowDir, graph, executedNodeIds = []) {
  const resources = new Map();
  const flowOrigin = readMarketplaceFlowOrigin(flowDir);
  if (flowOrigin) resources.set(marketplaceResourceKey(flowOrigin.kind, flowOrigin.id, flowOrigin.version), flowOrigin);
  const ids = Array.isArray(executedNodeIds) && executedNodeIds.length
    ? executedNodeIds.map((id) => String(id))
    : Object.keys(graph?.instances || {});
  for (const nodeId of ids) {
    const ref = parseMarketplaceNodeRef(graph?.instances?.[nodeId]);
    if (ref) resources.set(marketplaceResourceKey(ref.kind, ref.id, ref.version), ref);
  }
  return [...resources.values()];
}

export function recordMarketplaceRunUsage(workspaceRoot, resources = [], run = {}) {
  if (String(run.status || "") !== "success") return;
  if (!String(workspaceRoot || "").trim() || !Array.isArray(resources) || resources.length === 0) return;
  const runId = safeText(run.runId, 240);
  const actorUserId = safeText(run.userId || run.actorUserId, 160);
  if (!runId) return;
  for (const resource of resources) {
    appendMarketplaceUsageEvent(workspaceRoot, {
      ...resource,
      action: "use",
      actorUserId,
      runId,
      at: run.endedAt || Date.now(),
      eventId: `use:${resource.kind}:${resource.id}@${resource.version}:${runId}`,
    });
  }
}
