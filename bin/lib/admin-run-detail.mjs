import fs from "fs";
import path from "path";

import { listAllRunDirs } from "./workspace.mjs";
import {
  listWorkspaceRunLogs,
  readWorkspaceRunLogEvents,
} from "./workspace-run-logs.mjs";

const MAX_LOG_BYTES = 512 * 1024;
const MAX_EVENTS = 2_000;
const MAX_EVENT_TEXT_CHARS = 20_000;
const SECRET_KEY_RE = /(token|password|passwd|secret|webhook|authorization|api[_-]?key|access[_-]?key)/i;
const SECRET_TEXT_PATTERNS = [
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 ***"],
  [/((?:token|password|passwd|secret|authorization|api[_-]?key|access[_-]?key)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,;]+)/gi, "$1***"],
  [/(["'](?:token|password|passwd|secret|authorization|api[_-]?key|access[_-]?key)["']\s*:\s*)("[^"]*"|'[^']*')/gi, "$1\"***\""],
];

function truncateText(value, max = MAX_EVENT_TEXT_CHARS) {
  const text = String(value ?? "");
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... [truncated ${text.length - max} chars]`;
}

export function redactAdminRunText(value) {
  let text = truncateText(value);
  for (const [pattern, replacement] of SECRET_TEXT_PATTERNS) {
    text = text.replace(pattern, replacement);
  }
  return text;
}

function sanitizeValue(value, depth = 0) {
  if (depth > 8) return "[MaxDepth]";
  if (typeof value === "string") return redactAdminRunText(value);
  if (value == null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.slice(0, 200).map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === "object") {
    const out = {};
    for (const [key, raw] of Object.entries(value).slice(0, 200)) {
      if (key === "graph") out[key] = "[omitted]";
      else out[key] = SECRET_KEY_RE.test(key) ? "***" : sanitizeValue(raw, depth + 1);
    }
    return out;
  }
  return redactAdminRunText(value);
}

function safeJson(value) {
  try {
    return truncateText(JSON.stringify(sanitizeValue(value)));
  } catch {
    return redactAdminRunText(value);
  }
}

function numberTime(value, fallback = 0) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : fallback;
}

function structuredText(value) {
  if (!value || typeof value !== "object") return "";
  const direct = value.text ?? value.line ?? value.error ?? value.message ?? value.delta ?? value.thinking;
  if (typeof direct === "string" || typeof direct === "number") return redactAdminRunText(direct);
  if (typeof value.content === "string") return redactAdminRunText(value.content);
  if (Array.isArray(value.content)) {
    const texts = value.content
      .map((block) => block?.thinking ?? block?.text ?? block?.content ?? "")
      .filter((text) => typeof text === "string" && text.trim());
    if (texts.length > 0) return redactAdminRunText(texts.join("\n"));
  }
  return "";
}

function eventKind(value, tag = "") {
  const candidates = [
    tag,
    value?.kind,
    value?.type,
    value?.subtype,
    value?.event,
    value?.item?.type,
  ].map((item) => String(item || "").toLowerCase());
  if (candidates.some((item) => item.includes("thinking") || item.includes("reasoning"))) return "thinking";
  if (candidates.some((item) => item.includes("tool"))) return "tool";
  if (candidates.some((item) => item.includes("error") || item.includes("fail"))) return "error";
  if (candidates.some((item) => item.includes("result") || item.includes("assistant"))) return "result";
  return "process";
}

function normalizeEvent(value, index = 0, raw = "") {
  const event = value && typeof value === "object" ? sanitizeValue(value) : {};
  const type = String(event.type || event.event || event.kind || "event");
  const kind = eventKind(event);
  const nodeId = String(event.nodeId || event.runNodeId || event.instanceId || "");
  const text = structuredText(event) || safeJson(event);
  return {
    id: `${numberTime(event.ts || event.at, index)}-${index}`,
    ts: numberTime(event.ts || event.at, 0),
    type,
    kind,
    nodeId,
    text,
    raw: redactAdminRunText(raw || safeJson(event)),
  };
}

function parsePipelineLine(line, index) {
  const match = String(line || "").match(/^\[([^\]]+)\]\s+\[([^\]]+)\]\s+([\s\S]*)$/);
  if (!match) {
    return {
      id: `0-${index}`,
      ts: 0,
      type: "log",
      kind: eventKind({}, "log"),
      nodeId: "",
      text: redactAdminRunText(line),
      raw: redactAdminRunText(line),
    };
  }
  const [, timestamp, tag, body] = match;
  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = null;
  }
  const sanitized = parsed && typeof parsed === "object" ? sanitizeValue(parsed) : null;
  const type = String(sanitized?.event || sanitized?.type || sanitized?.kind || tag || "log");
  const kind = eventKind(sanitized || {}, tag);
  const nodeId = String(sanitized?.nodeId || sanitized?.runNodeId || sanitized?.instanceId || "");
  const text = structuredText(sanitized) || redactAdminRunText(body);
  return {
    id: `${numberTime(timestamp, index)}-${index}`,
    ts: numberTime(timestamp, 0),
    type,
    kind,
    nodeId,
    text,
    raw: redactAdminRunText(line),
  };
}

function compactThinkingEvents(events) {
  const out = [];
  for (const event of events) {
    const previous = out[out.length - 1];
    if (
      event.kind === "thinking" &&
      previous?.kind === "thinking" &&
      previous.nodeId === event.nodeId &&
      previous.type === event.type
    ) {
      previous.text = truncateText(`${previous.text}${event.text}`);
      continue;
    }
    out.push({ ...event });
  }
  return out;
}

export function parseAdminPipelineRunLog(text) {
  const lines = String(text || "").split(/\r?\n/).filter((line) => line.trim());
  const sliced = lines.slice(-MAX_EVENTS);
  return {
    events: compactThinkingEvents(sliced.map((line, index) => parsePipelineLine(line, index))),
    rawLines: sliced.map((line) => redactAdminRunText(line)),
    truncated: lines.length > sliced.length,
  };
}

function readLogTail(filePath) {
  if (!fs.existsSync(filePath)) return { text: "", bytes: 0, truncated: false };
  const stat = fs.statSync(filePath);
  const bytes = stat.size;
  const start = Math.max(0, bytes - MAX_LOG_BYTES);
  const fd = fs.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(bytes - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString("utf-8");
    if (start > 0) {
      const newline = text.indexOf("\n");
      if (newline >= 0) text = text.slice(newline + 1);
    }
    return { text, bytes, truncated: start > 0 };
  } finally {
    fs.closeSync(fd);
  }
}

function sourceMatches(flowSource, source) {
  if (flowSource === "user") return source === "user" || source === "legacyUserRoot";
  if (flowSource === "workspace") return source === "workspace" || source === "legacyWorkspaceRoot";
  return true;
}

function findPipelineRun(workspaceRoot, input) {
  return listAllRunDirs(workspaceRoot, {
    userId: input.userId,
    includeWorkspaceRuns: true,
    includeLegacyUserRuns: true,
  }).find((entry) => (
    entry.flowName === input.flowId &&
    entry.uuid === input.runId &&
    sourceMatches(input.flowSource, entry.source)
  )) || null;
}

function workspaceRunDetail(input) {
  const run = listWorkspaceRunLogs({
    userId: input.userId,
    flowId: input.flowId,
    flowSource: input.flowSource,
    limit: 200,
  }).find((item) => String(item.runId || "") === input.runId);
  if (!run) return null;
  const allEvents = readWorkspaceRunLogEvents(input.runId);
  const rawEvents = allEvents.slice(-MAX_EVENTS);
  const events = compactThinkingEvents(rawEvents.map((event, index) => normalizeEvent(event, index)));
  return {
    run: { ...sanitizeValue(run), runType: "workspace" },
    events,
    rawLines: rawEvents.map((event) => safeJson(event)),
    truncated: allEvents.length > rawEvents.length,
  };
}

function pipelineRunDetail(workspaceRoot, input) {
  const entry = findPipelineRun(workspaceRoot, input);
  if (!entry) return null;
  const log = readLogTail(path.join(entry.runDir, "logs", "log.txt"));
  const parsed = parseAdminPipelineRunLog(log.text);
  return {
    run: {
      userId: input.userId,
      flowId: input.flowId,
      flowSource: input.flowSource,
      runId: input.runId,
      runType: "pipeline",
    },
    events: parsed.events,
    rawLines: parsed.rawLines,
    bytes: log.bytes,
    truncated: log.truncated || parsed.truncated,
  };
}

export function readAdminRunDetail(workspaceRoot, input = {}) {
  const normalized = {
    runType: String(input.runType || "pipeline").trim().toLowerCase(),
    userId: String(input.userId || "").trim(),
    flowId: String(input.flowId || "").trim(),
    flowSource: String(input.flowSource || "user").trim().toLowerCase(),
    runId: String(input.runId || "").trim(),
  };
  if (!normalized.userId || !normalized.flowId || !normalized.runId) return null;
  if (normalized.runType === "workspace") return workspaceRunDetail(normalized);
  return pipelineRunDetail(workspaceRoot, normalized);
}
