import fs from "fs";
import path from "path";

import { getAgentflowDataRoot } from "./paths.mjs";
import { runLedgerId } from "./run-ledger.mjs";

const MAX_EVENT_TEXT_CHARS = 20_000;
const MAX_INDEX_RECORDS = 10_000;
const SECRET_KEY_RE = /(token|password|passwd|secret|webhook|authorization|api[_-]?key|access[_-]?key)/i;
const SECRET_TEXT_PATTERNS = [
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 ***"],
  [/((?:token|password|passwd|secret|authorization|api[_-]?key|access[_-]?key)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1***"],
  [/(["'](?:token|password|passwd|secret|authorization|api[_-]?key|access[_-]?key)["']\s*:\s*)("[^"]*"|'[^']*')/gi, "$1\"***\""],
];

function safeSegment(value, fallback = "run") {
  return String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 160) || fallback;
}

function logRoot() {
  return path.join(getAgentflowDataRoot(), "workspace-run-logs");
}

function indexPath() {
  return path.join(logRoot(), "index.jsonl");
}

function eventPath(runId) {
  return path.join(logRoot(), "events", `${safeSegment(runId)}.jsonl`);
}

function truncateText(value) {
  const text = String(value ?? "");
  if (text.length <= MAX_EVENT_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_EVENT_TEXT_CHARS)}\n... [truncated ${text.length - MAX_EVENT_TEXT_CHARS} chars]`;
}

function redactText(value) {
  let text = truncateText(value);
  for (const [pattern, replacement] of SECRET_TEXT_PATTERNS) text = text.replace(pattern, replacement);
  return text;
}

function redact(value, depth = 0) {
  if (depth > 8) return "[MaxDepth]";
  if (typeof value === "string") return redactText(value);
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => redact(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, raw] of Object.entries(value).slice(0, 200)) {
      if (key === "graph") {
        out[key] = "[omitted]";
      } else {
        out[key] = SECRET_KEY_RE.test(key) ? "***" : redact(raw, depth + 1);
      }
    }
    return out;
  }
  return String(value);
}

function appendJsonl(filePath, item) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(item) + "\n", "utf-8");
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    return fs.readFileSync(filePath, "utf-8")
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => {
        try {
          const parsed = JSON.parse(line);
          return parsed && typeof parsed === "object" ? parsed : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function indexRecord(meta = {}, patch = {}) {
  const now = Date.now();
  return {
    version: 1,
    recordType: "summary",
    runId: String(meta.runId || patch.runId || runLedgerId("workspace")),
    userId: String(meta.userId || ""),
    username: String(meta.username || meta.userId || ""),
    flowId: String(meta.flowId || ""),
    flowSource: String(meta.flowSource || "user"),
    scheduleNodeId: String(meta.scheduleNodeId || ""),
    runNodeId: String(meta.runNodeId || ""),
    releaseId: String(meta.releaseId || ""),
    designRevision: String(meta.designRevision || ""),
    scheduled: meta.scheduled === true,
    trigger: String(meta.trigger || (meta.scheduled === true ? "scheduled" : "manual")),
    label: String(meta.label || ""),
    startedAt: Number(meta.startedAt || now),
    endedAt: meta.endedAt == null ? null : Number(meta.endedAt),
    durationMs: Math.max(0, Number(meta.durationMs || 0)),
    status: String(meta.status || "running"),
    error: String(meta.error || ""),
    updatedAt: Number(meta.updatedAt || now),
    ...patch,
  };
}

export function createWorkspaceRunLogSession(meta = {}) {
  const startedAt = Number(meta.startedAt || Date.now());
  const runId = String(meta.runId || runLedgerId("workspace"));
  const item = indexRecord({ ...meta, runId, startedAt, status: "running", updatedAt: startedAt });
  appendJsonl(indexPath(), item);
  appendWorkspaceRunLogEvent(runId, { type: "run-start", ...item, ts: startedAt });
  return { ...item, eventPath: eventPath(runId) };
}

export function appendWorkspaceRunLogEvent(runId, event = {}) {
  const id = String(runId || "");
  if (!id) return;
  const now = Date.now();
  const item = {
    version: 1,
    runId: id,
    ts: Number(event.ts || event.at || now),
    type: String(event.type || "event"),
    ...redact(event),
  };
  appendJsonl(eventPath(id), item);
}

export function finishWorkspaceRunLogSession(runId, status, patch = {}) {
  const id = String(runId || "");
  if (!id) return null;
  const endedAt = Number(patch.endedAt || Date.now());
  const summaries = readWorkspaceRunLogIndex().filter((item) => item.runId === id);
  const started = summaries[0] || {};
  const item = indexRecord(started, {
    ...patch,
    runId: id,
    endedAt,
    durationMs: Math.max(0, Number(patch.durationMs || (endedAt - Number(started.startedAt || endedAt)))),
    status: String(status || patch.status || "finished"),
    error: String(patch.error || ""),
    updatedAt: endedAt,
  });
  appendJsonl(indexPath(), item);
  appendWorkspaceRunLogEvent(id, { type: "run-finish", status: item.status, error: item.error, ts: endedAt, durationMs: item.durationMs });
  return item;
}

export function readWorkspaceRunLogIndex() {
  const rows = readJsonl(indexPath());
  return rows.slice(-MAX_INDEX_RECORDS);
}

export function listWorkspaceRunLogs(filter = {}) {
  const byRun = new Map();
  for (const row of readWorkspaceRunLogIndex()) {
    if (!row || !row.runId) continue;
    const prev = byRun.get(row.runId) || {};
    byRun.set(row.runId, { ...prev, ...row });
  }
  let rows = Array.from(byRun.values());
  const userId = String(filter.userId || "");
  const flowId = String(filter.flowId || "");
  const flowSource = String(filter.flowSource || "");
  const scheduleNodeId = String(filter.scheduleNodeId || "");
  const runNodeId = String(filter.runNodeId || "");
  const scheduled = filter.scheduled;
  if (userId) rows = rows.filter((row) => String(row.userId || "") === userId);
  if (flowId) rows = rows.filter((row) => String(row.flowId || "") === flowId);
  if (flowSource) rows = rows.filter((row) => String(row.flowSource || "user") === flowSource);
  if (scheduleNodeId) rows = rows.filter((row) => String(row.scheduleNodeId || "") === scheduleNodeId);
  if (runNodeId) rows = rows.filter((row) => String(row.runNodeId || "") === runNodeId);
  if (scheduled === true || scheduled === false) rows = rows.filter((row) => row.scheduled === scheduled);
  rows.sort((a, b) => Number(b.startedAt || b.updatedAt || 0) - Number(a.startedAt || a.updatedAt || 0));
  const limit = Math.max(1, Math.min(200, Number(filter.limit || 50)));
  return rows.slice(0, limit);
}

export function readWorkspaceRunLogEvents(runId) {
  return readJsonl(eventPath(runId));
}
