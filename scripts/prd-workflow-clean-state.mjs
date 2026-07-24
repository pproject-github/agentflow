#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const root = process.argv[2] ? path.resolve(process.argv[2]) : process.cwd();
const stateDir = path.join(root, ".workspace", "prd-flow", "workflow-state");
const projectionSourceKeys = new Set([
  "projectionMode",
  "projectCacheScope",
  "legacyCacheScope",
  "clientsUpdatedAt",
  "runtimeEventsUpdatedAt",
]);

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
}

function writeJsonIfChanged(filePath, before, after) {
  const beforeText = JSON.stringify(before, null, 2) + "\n";
  const afterText = JSON.stringify(after, null, 2) + "\n";
  if (beforeText === afterText) return false;
  fs.writeFileSync(filePath, afterText, "utf-8");
  return true;
}

function cleanSources(sources) {
  if (!sources || typeof sources !== "object" || Array.isArray(sources)) return sources;
  const out = { ...sources };
  for (const key of projectionSourceKeys) delete out[key];
  return out;
}

function cleanStoredSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return snapshot;
  const out = { ...snapshot };
  delete out.events;
  delete out.runtimeEvents;
  delete out.runtime_events;
  delete out.collaboration;
  delete out.clientObservations;
  delete out.clients;
  out.sources = cleanSources(out.sources);
  return out;
}

function isLegacyCacheFile(name) {
  return (
    name.endsWith(".json") &&
    !name.endsWith(".cache.json") &&
    !name.endsWith(".clients.json") &&
    !name.endsWith(".events.json") &&
    !name.endsWith(".project.json")
  );
}

const summary = {
  stateDir,
  clientsCleaned: 0,
  projectsCleaned: 0,
  cachesWritten: 0,
  legacyCacheFilesKept: 0,
};

if (!fs.existsSync(stateDir)) {
  console.log(JSON.stringify({ ...summary, skipped: "state dir missing" }, null, 2));
  process.exit(0);
}

for (const name of fs.readdirSync(stateDir)) {
  const filePath = path.join(stateDir, name);
  if (!fs.statSync(filePath).isFile()) continue;
  const data = readJson(filePath);
  if (!data || typeof data !== "object" || Array.isArray(data)) continue;

  if (name.endsWith(".clients.json")) {
    const next = { ...data, clients: { ...(data.clients || {}) } };
    for (const [clientId, record] of Object.entries(next.clients)) {
      if (!record || typeof record !== "object" || Array.isArray(record)) continue;
      next.clients[clientId] = {
        ...record,
        snapshot: cleanStoredSnapshot(record.snapshot),
      };
    }
    if (writeJsonIfChanged(filePath, data, next)) summary.clientsCleaned += 1;
    continue;
  }

  if (name.endsWith(".project.json")) {
    const next = { ...data, snapshot: cleanStoredSnapshot(data.snapshot) };
    if (writeJsonIfChanged(filePath, data, next)) summary.projectsCleaned += 1;
    continue;
  }

  if (isLegacyCacheFile(name) && data.snapshot) {
    const tapdId = name.slice(0, -".json".length);
    const cachePath = path.join(stateDir, `${tapdId}.cache.json`);
    const cacheData = {
      version: 1,
      tapdId: String(data.tapdId || tapdId),
      updatedAt: data.updatedAt || new Date().toISOString(),
      snapshot: data.snapshot,
      sources: {
        truth: "projection",
        authority: "agentflow-runtime",
        persistence: "cache",
        migratedFrom: name,
      },
    };
    const existing = readJson(cachePath);
    if (!existing) {
      fs.writeFileSync(cachePath, JSON.stringify(cacheData, null, 2) + "\n", "utf-8");
      summary.cachesWritten += 1;
    } else if (writeJsonIfChanged(cachePath, existing, cacheData)) {
      summary.cachesWritten += 1;
    }
    summary.legacyCacheFilesKept += 1;
  }
}

console.log(JSON.stringify(summary, null, 2));
