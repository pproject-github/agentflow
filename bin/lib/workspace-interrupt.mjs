import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { getAgentflowDataRoot } from "./paths.mjs";

const MAX_PAYLOAD_BYTES = 1024 * 1024;

function safeSegment(value, fallback = "run") {
  return String(value || fallback).trim().replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 160) || fallback;
}

function rootDir() {
  return path.join(getAgentflowDataRoot(), "workspace-interrupts");
}

export function listWorkspaceInterrupts() {
  try {
    if (!fs.existsSync(rootDir())) return [];
    return fs.readdirSync(rootDir()).filter((name) => name.endsWith(".json")).map((name) => read(path.join(rootDir(), name))).filter(Boolean).map(clone);
  } catch {
    return [];
  }
}

const OPEN_INTERRUPT_STATUSES = ["waiting", "resuming"];

/**
 * 按 token 找中断记录，**不过滤状态**。审核页要靠它把「从来没建过」和
 * 「已经处理过」分开——两者以前都只会渲染同一句「链接已失效或已处理」。
 * 同一个 token 若命中多条（流程把 resumeToken 写死时会这样），优先返回仍
 * 然打开的那条，其次返回最近更新的一条。
 * @param {string} token
 * @returns {object|null}
 */
export function findWorkspaceInterruptRecordByToken(token) {
  const wanted = String(token || "").trim();
  if (!wanted) return null;
  const matches = listWorkspaceInterrupts().filter((item) => String(item.resumeToken || "") === wanted);
  if (!matches.length) return null;
  const open = matches.filter((item) => OPEN_INTERRUPT_STATUSES.includes(String(item.status || "")));
  const pool = open.length ? open : matches;
  return pool.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")))[0];
}

export function isOpenWorkspaceInterrupt(record) {
  return OPEN_INTERRUPT_STATUSES.includes(String(record?.status || ""));
}

export function findWorkspaceInterruptByToken(token) {
  const record = findWorkspaceInterruptRecordByToken(token);
  return record && isOpenWorkspaceInterrupt(record) ? record : null;
}

function interruptPath(runId) {
  return path.join(rootDir(), `${safeSegment(runId)}.json`);
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function assertPayloadSize(value) {
  const bytes = Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
  if (bytes > MAX_PAYLOAD_BYTES) throw new Error(`Workspace interrupt payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
}

function validateResume(value, schema = {}) {
  if (!schema || typeof schema !== "object") return;
  const type = String(schema.type || "").toLowerCase();
  if (type === "object" && (!value || typeof value !== "object" || Array.isArray(value))) {
    throw new Error("Workspace interrupt resume must be an object");
  }
  for (const key of Array.isArray(schema.required) ? schema.required : []) {
    if (!Object.prototype.hasOwnProperty.call(value || {}, String(key))) {
      throw new Error(`Workspace interrupt resume is missing required field: ${String(key)}`);
    }
  }
}

function writeAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(5).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tmp, file);
}

function read(file) {
  try {
    if (!fs.existsSync(file)) return null;
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function workspaceInterruptPath(runId) {
  return interruptPath(runId);
}

export function readWorkspaceInterrupt(runId) {
  const value = read(interruptPath(runId));
  return value ? clone(value) : null;
}

export function createWorkspaceInterrupt(runId, record = {}) {
  const id = String(runId || "").trim();
  if (!id) throw new Error("Workspace interrupt requires runId");
  const existing = readWorkspaceInterrupt(id);
  if (existing?.status === "waiting") {
    const error = new Error("Workspace run already has a pending interrupt");
    error.code = "INTERRUPT_ALREADY_WAITING";
    error.interruptId = existing.interruptId || "";
    throw error;
  }
  const payload = {
    version: 1,
    interruptId: String(record.interruptId || `int_${crypto.randomBytes(10).toString("hex")}`),
    runId: id,
    flowId: String(record.flowId || ""),
    flowSource: String(record.flowSource || "user"),
    userId: String(record.userId || ""),
    requestedBy: String(record.requestedBy || record.userId || ""),
    approvers: Array.isArray(record.approvers)
      ? [...new Set(record.approvers.map((item) => String(item || "").trim()).filter(Boolean))]
      : [],
    approvalMode: "any",
    approvalStatus: "pending",
    reviewer: "",
    reviewComment: "",
    nodeId: String(record.nodeId || ""),
    kind: String(record.kind || "user_input"),
    reason: String(record.reason || ""),
    value: clone(record.value ?? null),
    resumeToken: String(record.resumeToken || ""),
    resumeSchema: clone(record.resumeSchema || { type: "object" }),
    cursor: clone(record.cursor || {}),
    status: "waiting",
    createdAt: record.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  assertPayloadSize(payload);
  writeAtomic(interruptPath(id), payload);
  return clone(payload);
}

export function resolveWorkspaceInterrupt(runId, interruptId, resume, meta = {}) {
  const id = String(runId || "").trim();
  const expected = String(interruptId || "").trim();
  const current = readWorkspaceInterrupt(id);
  if (!current) {
    const error = new Error("Workspace interrupt is not waiting");
    error.code = "INTERRUPT_NOT_WAITING";
    throw error;
  }
  if (current.status !== "waiting") {
    const error = new Error("Workspace interrupt has already been resumed");
    error.code = "INTERRUPT_ALREADY_RESUMED";
    error.interruptId = current.interruptId || "";
    throw error;
  }
  if (expected && expected !== String(current.interruptId || "")) {
    const error = new Error("Workspace interrupt id does not match");
    error.code = "INTERRUPT_ID_MISMATCH";
    throw error;
  }
  if (meta.expectedRunStateRevision != null && Number(meta.expectedRunStateRevision) !== Number(current.cursor?.runStateRevision || 0)) {
    const error = new Error(`Workspace interrupt revision conflict: expected ${meta.expectedRunStateRevision}, current ${current.cursor?.runStateRevision || 0}`);
    error.code = "INTERRUPT_REVISION_CONFLICT";
    error.currentRevision = Number(current.cursor?.runStateRevision || 0);
    throw error;
  }
  assertPayloadSize(resume);
  validateResume(resume, current.resumeSchema);
  const decision = resume && typeof resume === "object" && !Array.isArray(resume)
    ? String(resume.decision || resume.status || "").toLowerCase()
    : "";
  const approved = resume && typeof resume === "object" && !Array.isArray(resume)
    ? !(resume.approved === false || ["reject", "rejected", "deny", "denied", "refuse", "refused"].includes(decision))
    : true;
  const next = {
    ...current,
    status: "resuming",
    resume: clone(resume ?? null),
    resolvedBy: String(meta.resolvedBy || ""),
    reviewer: String(meta.resolvedBy || ""),
    reviewComment: String(resume?.comment || ""),
    approvalStatus: approved ? "approved" : "rejected",
    resolvedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    idempotencyKey: String(meta.idempotencyKey || ""),
  };
  writeAtomic(interruptPath(id), next);
  return clone(next);
}

export function consumeWorkspaceInterrupt(runId, interruptId) {
  const current = readWorkspaceInterrupt(runId);
  if (!current) return null;
  if (interruptId && String(current.interruptId || "") !== String(interruptId)) return null;
  if (current.status !== "resuming") return null;
  const next = { ...current, status: "resolved", consumedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  writeAtomic(interruptPath(runId), next);
  return clone(next);
}

export function requeueWorkspaceInterrupt(runId, interruptId, meta = {}) {
  const current = readWorkspaceInterrupt(runId);
  if (!current) return null;
  if (interruptId && String(current.interruptId || "") !== String(interruptId)) return null;
  if (current.status !== "resuming") return clone(current);
  const next = {
    ...current,
    status: "waiting",
    resume: null,
    resolvedBy: "",
    resolvedAt: "",
    updatedAt: new Date().toISOString(),
    retryReason: String(meta.reason || ""),
  };
  writeAtomic(interruptPath(runId), next);
  return clone(next);
}

export function clearWorkspaceInterrupt(runId) {
  try { fs.rmSync(interruptPath(runId), { force: true }); } catch {}
}
