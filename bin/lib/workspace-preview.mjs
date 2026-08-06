import fs from "fs";
import path from "path";
import crypto from "crypto";
import { getUserPipelinesRoot } from "./paths.mjs";

export const WORKSPACE_PREVIEW_METADATA_FILENAME = ".agentflow-workspace-preview.json";
export const DEFAULT_WORKSPACE_PREVIEW_TTL_MS = 2 * 60 * 60 * 1000;
export const MAX_WORKSPACE_PREVIEW_TTL_MS = 24 * 60 * 60 * 1000;

function safePreviewId(value = "") {
  const raw = String(value || "").trim();
  return /^preview_[a-z0-9_-]{8,100}$/i.test(raw) ? raw : "";
}

export function workspacePreviewMetadataPath(flowDir) {
  return path.join(flowDir, WORKSPACE_PREVIEW_METADATA_FILENAME);
}

export function readWorkspacePreviewMetadata(flowDir) {
  try {
    const filePath = workspacePreviewMetadataPath(flowDir);
    if (!fs.existsSync(filePath)) return null;
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const flowId = safePreviewId(value.flowId);
    const ownerId = String(value.ownerId || "").trim();
    const expiresAt = String(value.expiresAt || "").trim();
    if (!flowId || !ownerId || !Number.isFinite(Date.parse(expiresAt))) return null;
    return { ...value, flowId, ownerId, expiresAt };
  } catch {
    return null;
  }
}

export function isWorkspacePreviewDir(flowDir) {
  return Boolean(readWorkspacePreviewMetadata(flowDir));
}

export function workspacePreviewFlowDir(flowId, userId = "") {
  const safeId = safePreviewId(flowId);
  if (!safeId) return "";
  return path.join(getUserPipelinesRoot(userId), safeId);
}

export function createWorkspacePreviewId() {
  return `preview_${crypto.randomBytes(10).toString("hex")}`;
}

export function normalizeWorkspacePreviewTtlMs(value) {
  const requested = Number(value);
  if (!Number.isFinite(requested) || requested <= 0) return DEFAULT_WORKSPACE_PREVIEW_TTL_MS;
  return Math.min(MAX_WORKSPACE_PREVIEW_TTL_MS, Math.max(60_000, Math.round(requested)));
}

export function writeWorkspacePreviewMetadata(flowDir, metadata) {
  const filePath = workspacePreviewMetadataPath(flowDir);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

export function listExpiredWorkspacePreviews(userPipelinesRoot, now = Date.now()) {
  if (!fs.existsSync(userPipelinesRoot)) return [];
  const expired = [];
  for (const entry of fs.readdirSync(userPipelinesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const flowDir = path.join(userPipelinesRoot, entry.name);
    const metadata = readWorkspacePreviewMetadata(flowDir);
    if (!metadata) continue;
    if (Date.parse(metadata.expiresAt) <= now) expired.push({ flowDir, metadata });
  }
  return expired;
}

