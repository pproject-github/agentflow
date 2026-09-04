import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { getAgentflowDataRoot } from "./paths.mjs";

const SECRET_KEY_RE = /(token|password|passwd|secret|webhook|authorization|api[_-]?key|access[_-]?key|cookie)/i;
const MAX_DEPTH = 8;
const MAX_KEYS = 500;
const MAX_ARRAY = 500;
const MAX_TEXT = 20_000;
const MAX_HISTORY = 1000;

function safeSegment(value, fallback = "run") {
  return String(value || fallback).trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 160) || fallback;
}

function rootDir() {
  const override = String(process.env.AGENTFLOW_RUN_STATE_ROOT || "").trim();
  return path.resolve(override || path.join(getAgentflowDataRoot(), "workspace-run-logs"));
}

function statePath(runId) {
  const explicit = String(process.env.AGENTFLOW_RUN_STATE_FILE || "").trim();
  if (explicit) return path.resolve(explicit);
  return path.join(rootDir(), "state", `${safeSegment(runId)}.json`);
}

function stateEventsPath(runId) {
  const explicit = String(process.env.AGENTFLOW_RUN_STATE_EVENTS_FILE || "").trim();
  if (explicit) return path.resolve(explicit);
  return path.join(rootDir(), "state-events", `${safeSegment(runId)}.jsonl`);
}

function stateCheckpointsPath(runId) {
  return path.join(rootDir(), "checkpoints", `${safeSegment(runId)}.jsonl`);
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function redact(value, depth = 0) {
  if (depth > MAX_DEPTH) return "[MaxDepth]";
  if (typeof value === "string") return value.length > MAX_TEXT ? `${value.slice(0, MAX_TEXT)}\n... [truncated]` : value;
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, MAX_ARRAY).map((item) => redact(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, raw] of Object.entries(value).slice(0, MAX_KEYS)) out[key] = SECRET_KEY_RE.test(key) ? "***" : redact(raw, depth + 1);
    return out;
  }
  return String(value);
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  fs.renameSync(temp, file);
}

function readJson(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const value = JSON.parse(fs.readFileSync(file, "utf-8"));
    return value && typeof value === "object" ? value : fallback;
  } catch {
    return fallback;
  }
}

function readEvents(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf-8").split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean).slice(-1000);
  } catch { return []; }
}

function appendEvent(runId, event) {
  const file = stateEventsPath(runId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(redact(event))}\n`, "utf-8");
}

function normalizeSchema(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  const initial = schema.initial && typeof schema.initial === "object" && !Array.isArray(schema.initial) ? redact(schema.initial) : {};
  const reducers = {};
  if (schema.reducers && typeof schema.reducers === "object" && !Array.isArray(schema.reducers)) {
    for (const [key, value] of Object.entries(schema.reducers)) {
      const reducer = String(value || "merge").trim().toLowerCase();
      if (["replace", "merge", "append"].includes(reducer)) reducers[key] = reducer;
    }
  }
  return { version: Number(schema.version) || 1, initial, reducers };
}

function normalize(runId, value = {}, revision = 0, updatedAt = 0, schema = null) {
  return {
    version: 1,
    runId: String(runId || ""),
    revision: Number(revision) || 0,
    updatedAt: Number(updatedAt) || 0,
    schema: normalizeSchema(schema),
    state: redact(value && typeof value === "object" && !Array.isArray(value) ? value : {}),
  };
}

export function workspaceRunStatePath(runId) { return statePath(runId); }
export function workspaceRunStateEventsPath(runId) { return stateEventsPath(runId); }
export function workspaceRunStateCheckpointsPath(runId) { return stateCheckpointsPath(runId); }

export function createWorkspaceRunState(runId, initialState = {}, meta = {}) {
  const id = String(runId || "").trim();
  if (!id) return null;
  const existing = readJson(statePath(id), null);
  if (existing?.runId === id && existing.state && typeof existing.state === "object") return existing;
  const now = Date.now();
  const schema = normalizeSchema(meta.schema);
  const seed = Object.keys(initialState || {}).length ? initialState : (schema?.initial || {});
  const record = normalize(id, seed, 0, now, schema);
  writeAtomic(statePath(id), record);
  appendEvent(id, { type: "run-state-created", runId: id, revision: 0, nodeId: meta.nodeId || "", operation: "create", ts: now, changedKeys: Object.keys(record.state) });
  return record;
}

export function readWorkspaceRunState(runId) {
  const id = String(runId || "").trim();
  if (!id) return null;
  const record = readJson(statePath(id), null);
  if (!record) return null;
  return { ...record, state: redact(record.state || {}) };
}

function pathParts(key) {
  if (Array.isArray(key)) return key.map((part) => String(part)).filter(Boolean);
  return String(key || "").split(".").map((part) => part.trim()).filter(Boolean);
}

function mergePatch(target, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return clone(patch);
  const out = target && typeof target === "object" && !Array.isArray(target) ? clone(target) : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === "object" && !Array.isArray(value) && out[key] && typeof out[key] === "object" && !Array.isArray(out[key])) out[key] = mergePatch(out[key], value);
    else out[key] = clone(value);
  }
  return out;
}

function changedKeys(before, after) {
  const keys = new Set([...Object.keys(before || {}), ...Object.keys(after || {})]);
  return Array.from(keys).filter((key) => JSON.stringify(before?.[key]) !== JSON.stringify(after?.[key]));
}

function update(runId, nextState, meta = {}) {
  const id = String(runId || "").trim();
  if (!id) return null;
  const previous = readWorkspaceRunState(id) || createWorkspaceRunState(id, {});
  const schema = previous?.schema || normalizeSchema(meta.schema);
  const safe = redact(nextState && typeof nextState === "object" && !Array.isArray(nextState) ? nextState : {});
  const revision = Number(previous?.revision || 0) + 1;
  const now = Date.now();
  const record = normalize(id, safe, revision, now, schema);
  writeAtomic(statePath(id), record);
  appendEvent(id, {
    type: "run-state-updated", runId: id, revision, nodeId: String(meta.nodeId || ""),
    operation: String(meta.operation || "patch"), changedKeys: changedKeys(previous?.state || {}, safe), ts: now,
  });
  return record;
}

export function patchWorkspaceRunState(runId, patch = {}, meta = {}) {
  const current = readWorkspaceRunState(runId) || createWorkspaceRunState(runId, {});
  if (meta.expectedRevision != null && Number(meta.expectedRevision) !== Number(current?.revision || 0)) {
    const error = new Error(`Run State revision conflict: expected ${meta.expectedRevision}, current ${current?.revision || 0}`);
    error.code = "RUN_STATE_REVISION_CONFLICT";
    error.currentRevision = Number(current?.revision || 0);
    throw error;
  }
  const reducers = current?.schema?.reducers || {};
  const next = mergePatch(current?.state || {}, patch);
  for (const [key, reducer] of Object.entries(reducers)) {
    if (!Object.prototype.hasOwnProperty.call(patch || {}, key)) continue;
    if (reducer === "replace") next[key] = clone(patch[key]);
    if (reducer === "append") {
      const prior = Array.isArray(current?.state?.[key]) ? current.state[key] : [];
      const incoming = Array.isArray(patch[key]) ? patch[key] : [patch[key]];
      next[key] = [...prior, ...clone(incoming)];
    }
  }
  return update(runId, next, { ...meta, operation: "patch" });
}

export function replaceWorkspaceRunState(runId, nextState = {}, meta = {}) {
  const current = readWorkspaceRunState(runId) || createWorkspaceRunState(runId, {});
  if (meta.expectedRevision != null && Number(meta.expectedRevision) !== Number(current?.revision || 0)) {
    const error = new Error(`Run State revision conflict: expected ${meta.expectedRevision}, current ${current?.revision || 0}`);
    error.code = "RUN_STATE_REVISION_CONFLICT";
    error.currentRevision = Number(current?.revision || 0);
    throw error;
  }
  return update(runId, nextState, { ...meta, operation: "replace" });
}

export function appendWorkspaceRunState(runId, key, value, meta = {}) {
  const current = readWorkspaceRunState(runId) || createWorkspaceRunState(runId, {});
  if (meta.expectedRevision != null && Number(meta.expectedRevision) !== Number(current?.revision || 0)) {
    const error = new Error(`Run State revision conflict: expected ${meta.expectedRevision}, current ${current?.revision || 0}`);
    error.code = "RUN_STATE_REVISION_CONFLICT";
    error.currentRevision = Number(current?.revision || 0);
    throw error;
  }
  const parts = pathParts(key);
  if (!parts.length) throw new Error("runState.append requires a non-empty path");
  const next = clone(current?.state || {});
  let cursor = next;
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== "object" || Array.isArray(cursor[part])) cursor[part] = {};
    cursor = cursor[part];
  }
  const leaf = parts[parts.length - 1];
  if (!Array.isArray(cursor[leaf])) cursor[leaf] = [];
  cursor[leaf].push(clone(value));
  return update(runId, next, { ...meta, operation: "append" });
}

export function getWorkspaceRunStateValue(runId, key = "") {
  const current = readWorkspaceRunState(runId);
  if (!current) return undefined;
  const parts = pathParts(key);
  let value = current.state;
  for (const part of parts) {
    if (value == null) return undefined;
    value = value[part];
  }
  return redact(value);
}

export function readWorkspaceRunStateEvents(runId) { return readEvents(stateEventsPath(runId)); }

export function appendWorkspaceRunStateCheckpoint(runId, checkpoint = {}) {
  const current = readWorkspaceRunState(runId);
  if (!current) return null;
  const history = readEvents(stateCheckpointsPath(runId));
  const previous = history.length ? history[history.length - 1] : null;
  const checkpointId = String(checkpoint.checkpointId || `ckpt_${crypto.randomBytes(10).toString("hex")}`);
  const record = redact({
    version: 2,
    recordType: "checkpoint",
    checkpointId,
    runId: String(runId),
    parentCheckpointId: String(checkpoint.parentCheckpointId || previous?.checkpointId || ""),
    revision: current.revision,
    ts: Date.now(),
    nodeId: String(checkpoint.nodeId || ""),
    status: String(checkpoint.status || "running"),
    graphRevision: String(checkpoint.graphRevision || ""),
    cursor: checkpoint.cursor && typeof checkpoint.cursor === "object" && !Array.isArray(checkpoint.cursor)
      ? checkpoint.cursor
      : {},
    state: current.state,
    ...checkpoint,
  });
  const file = stateCheckpointsPath(runId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${JSON.stringify(record)}\n`, "utf-8");
  return record;
}

export function readWorkspaceRunStateHistory(runId) { return readEvents(stateCheckpointsPath(runId)).slice(-MAX_HISTORY); }

export function readWorkspaceRunStateCheckpoint(runId, checkpointId) {
  const wanted = String(checkpointId || "").trim();
  if (!wanted) return null;
  return readWorkspaceRunStateHistory(runId).find((item) => String(item?.checkpointId || "") === wanted) || null;
}
