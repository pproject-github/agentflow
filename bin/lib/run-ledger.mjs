import fs from "fs";
import path from "path";
import crypto from "crypto";

import { getAgentflowDataRoot } from "./paths.mjs";

function localDayKey(timeMs) {
  const d = new Date(Number(timeMs) || Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function safeSegment(value, fallback = "run") {
  return String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || fallback;
}

export function runLedgerId(prefix = "run") {
  return `${safeSegment(prefix, "run")}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

export function runLedgerDir() {
  return path.join(getAgentflowDataRoot(), "admin", "run-ledger");
}

export function runLedgerPath(timeMs = Date.now()) {
  return path.join(runLedgerDir(), `${localDayKey(timeMs)}.jsonl`);
}

export function appendRunLedgerEvent(event = {}) {
  try {
    const item = {
      version: 1,
      type: String(event.type || ""),
      kind: String(event.kind || ""),
      runId: String(event.runId || runLedgerId()),
      userId: String(event.userId || ""),
      username: String(event.username || event.userId || ""),
      flowId: String(event.flowId || ""),
      flowSource: String(event.flowSource || "user"),
      runNodeId: String(event.runNodeId || ""),
      at: Number(event.at || event.startedAt || Date.now()),
      endedAt: event.endedAt == null ? null : Number(event.endedAt),
      durationMs: Math.max(0, Number(event.durationMs || 0)),
      status: event.status ? String(event.status || "") : "",
    };
    if (!item.type || !item.kind || !item.runId || !item.flowId) return;
    const filePath = runLedgerPath(item.at);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(item) + "\n", "utf-8");
  } catch {
    // Usage telemetry must never affect the run itself.
  }
}

function readJsonlObjects(filePath) {
  if (!fs.existsSync(filePath)) return [];
  try {
    const out = [];
    const lines = fs.readFileSync(filePath, "utf-8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) out.push(parsed);
      } catch {
        /* ignore malformed line */
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function readRunLedgerEvents(options = {}) {
  const dir = runLedgerDir();
  if (!fs.existsSync(dir)) return [];
  try {
    const sinceMs = Number(options?.sinceMs || 0);
    const sinceKey = Number.isFinite(sinceMs) && sinceMs > 0 ? localDayKey(sinceMs) : "";
    const files = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(entry.name))
      .filter((entry) => !sinceKey || entry.name.slice(0, 10) >= sinceKey)
      .map((entry) => path.join(dir, entry.name))
      .sort();
    return files.flatMap((filePath) => readJsonlObjects(filePath));
  } catch {
    return [];
  }
}
