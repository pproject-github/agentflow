import crypto from "crypto";
import fs from "fs";
import path from "path";

import { getUserPipelinesRoot } from "./paths.mjs";

export const WORKSPACE_DRAFT_METADATA_FILENAME = ".agentflow-workspace-draft.json";
export const DEFAULT_WORKSPACE_DRAFT_TTL_MS = 2 * 60 * 60 * 1000;
export const MAX_WORKSPACE_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

export function safeWorkspaceDraftId(value = "") {
  const raw = String(value || "").trim();
  return /^draft_[a-z0-9_-]{8,100}$/i.test(raw) ? raw : "";
}

export function createWorkspaceDraftId() {
  return `draft_${crypto.randomBytes(10).toString("hex")}`;
}

export function workspaceDraftFlowDir(draftId, userId = "") {
  const safeId = safeWorkspaceDraftId(draftId);
  if (!safeId) return "";
  return path.join(getUserPipelinesRoot(userId), safeId);
}

export function workspaceDraftMetadataPath(flowDir) {
  return path.join(flowDir, WORKSPACE_DRAFT_METADATA_FILENAME);
}

export function readWorkspaceDraftMetadata(flowDir) {
  try {
    const filePath = workspaceDraftMetadataPath(flowDir);
    if (!fs.existsSync(filePath)) return null;
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const flowId = safeWorkspaceDraftId(value.flowId);
    const ownerId = String(value.ownerId || "").trim();
    const expiresAt = String(value.expiresAt || "").trim();
    if (!flowId || !ownerId || !Number.isFinite(Date.parse(expiresAt))) return null;
    return { ...value, flowId, ownerId, expiresAt };
  } catch {
    return null;
  }
}

export function isWorkspaceDraftDir(flowDir) {
  return Boolean(readWorkspaceDraftMetadata(flowDir));
}

export function normalizeWorkspaceDraftTtlMs(value) {
  const requested = Number(value);
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_WORKSPACE_DRAFT_TTL_MS;
  return Math.min(MAX_WORKSPACE_DRAFT_TTL_MS, Math.max(60_000, Math.round(requested)));
}

export function writeWorkspaceDraftMetadata(flowDir, metadata) {
  const filePath = workspaceDraftMetadataPath(flowDir);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

export function listExpiredWorkspaceDrafts(userPipelinesRoot, now = Date.now()) {
  if (!fs.existsSync(userPipelinesRoot)) return [];
  const expired = [];
  for (const entry of fs.readdirSync(userPipelinesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const flowDir = path.join(userPipelinesRoot, entry.name);
    const metadata = readWorkspaceDraftMetadata(flowDir);
    if (!metadata) continue;
    if (Date.parse(metadata.expiresAt) <= now) expired.push({ flowDir, metadata });
  }
  return expired;
}
