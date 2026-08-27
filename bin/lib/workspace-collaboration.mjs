import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getAgentflowDataRoot } from "./paths.mjs";
import { getTeamForUser } from "./teams.mjs";

const REGISTRY_VERSION = 1;
const DEFAULT_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function collaborationRoot() {
  return path.join(getAgentflowDataRoot(), "collaboration");
}

function registryPath() {
  return path.join(collaborationRoot(), "workspaces.json");
}

function readRegistry() {
  try {
    const filePath = registryPath();
    if (!fs.existsSync(filePath)) return { version: REGISTRY_VERSION, workspaces: {} };
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return {
      version: REGISTRY_VERSION,
      workspaces: parsed?.workspaces && typeof parsed.workspaces === "object" && !Array.isArray(parsed.workspaces)
        ? parsed.workspaces
        : {},
    };
  } catch {
    return { version: REGISTRY_VERSION, workspaces: {} };
  }
}

function writeRegistry(registry) {
  const filePath = registryPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({
    version: REGISTRY_VERSION,
    workspaces: registry?.workspaces || {},
  }, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, filePath);
}

function normalizeUserId(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeFlowId(value) {
  return String(value || "").trim();
}

function flowKey(flowId, archived = false, flowSource = "workspace", ownerId = "") {
  return [
    "project",
    normalizeUserId(ownerId),
    String(flowSource || "workspace"),
    archived ? "archived" : "active",
    normalizeFlowId(flowId),
  ].join(":");
}

function tokenHash(token) {
  return crypto.createHash("sha256").update(String(token || "")).digest("hex");
}

function publicWorkspace(record, userId = "") {
  if (!record) return null;
  const actorId = normalizeUserId(userId);
  const members = record.members && typeof record.members === "object" ? record.members : {};
  const access = workspaceCollaborationAccess(record, actorId);
  return {
    id: record.id,
    flowId: record.flowId,
    flowSource: record.projectSource || record.flowSource || "workspace",
    archived: record.archived === true,
    ownerId: record.ownerId,
    role: access.role,
    accessSource: access.source,
    teamId: access.teamId,
    memberCount: Object.keys(members).length,
    members: Object.entries(members).map(([id, role]) => ({ userId: id, role })),
    teamShares: Object.entries(record.teamShares || {}).map(([teamId, role]) => ({ teamId, role })),
    createdAt: record.createdAt || "",
    updatedAt: record.updatedAt || "",
  };
}

export function getWorkspaceCollaborationByFlow(flowId, archived = false) {
  return Object.values(readRegistry().workspaces)
    .find((record) => (
      record
      && record.flowId === normalizeFlowId(flowId)
      && record.archived === (archived === true)
      && (record.projectSource || record.flowSource || "workspace") === "workspace"
    )) || null;
}

export function getWorkspaceCollaborationById(workspaceId) {
  return readRegistry().workspaces[String(workspaceId || "").trim()] || null;
}

export function workspaceCollaborationAccess(record, userId) {
  if (!record) return { allowed: true, role: "" };
  const id = normalizeUserId(userId);
  const directRole = id === record.ownerId ? "owner" : String(record.members?.[id] || "");
  const team = getTeamForUser(id);
  const teamRole = team ? String(record.teamShares?.[team.id] || "") : "";
  const role = directRole === "owner" || directRole === "editor" || teamRole === "editor"
    ? directRole === "owner" ? "owner" : "editor"
    : directRole === "viewer" || teamRole === "viewer" ? "viewer" : "";
  return {
    allowed: role === "owner" || role === "editor" || role === "viewer",
    writable: role === "owner" || role === "editor",
    runnable: role === "owner" || role === "editor",
    role,
    source: directRole ? "member" : teamRole ? "team" : "",
    teamId: teamRole ? team?.id || "" : "",
  };
}

export function ensureWorkspaceCollaboration({ flowId, flowSource = "workspace", archived = false, userId }) {
  const id = normalizeUserId(userId);
  const normalizedFlowId = normalizeFlowId(flowId);
  if (!id) return { error: "Authentication required", status: 401 };
  if (!normalizedFlowId) return { error: "Missing flowId", status: 400 };
  const registry = readRegistry();
  const normalizedSource = flowSource === "user" ? "user" : "workspace";
  const key = flowKey(normalizedFlowId, archived, normalizedSource, id);
  let record = Object.values(registry.workspaces).find((item) => item?.flowKey === key) || null;
  if (!record && normalizedSource === "workspace") {
    record = Object.values(registry.workspaces).find((item) => (
      item?.flowId === normalizedFlowId
      && item?.archived === (archived === true)
      && (item?.projectSource || item?.flowSource || "workspace") === "workspace"
    )) || null;
  }
  if (record) {
    const access = workspaceCollaborationAccess(record, id);
    if (!access.allowed) return { error: "Workspace collaboration permission denied", status: 403 };
    return { record, workspace: publicWorkspace(record, id), created: false };
  }
  const now = new Date().toISOString();
  const workspaceId = `ws_${crypto.randomBytes(12).toString("hex")}`;
  record = {
    id: workspaceId,
    flowKey: key,
    flowId: normalizedFlowId,
    flowSource: normalizedSource,
    projectSource: normalizedSource,
    archived: archived === true,
    ownerId: id,
    members: { [id]: "owner" },
    invites: {},
    createdAt: now,
    updatedAt: now,
  };
  registry.workspaces[workspaceId] = record;
  writeRegistry(registry);
  return { record, workspace: publicWorkspace(record, id), created: true };
}

export function createWorkspaceCollaborationInvite({
  workspaceId,
  userId,
  role = "editor",
  expiresInMs = DEFAULT_INVITE_TTL_MS,
}) {
  const registry = readRegistry();
  const record = registry.workspaces[String(workspaceId || "").trim()];
  if (!record) return { error: "Workspace collaboration not found", status: 404 };
  const actorId = normalizeUserId(userId);
  const access = workspaceCollaborationAccess(record, actorId);
  if (access.role !== "owner") return { error: "Only the workspace owner can create invitations", status: 403 };
  const normalizedRole = role === "viewer" ? "viewer" : "editor";
  const token = crypto.randomBytes(24).toString("base64url");
  const now = Date.now();
  const hash = tokenHash(token);
  record.invites = record.invites && typeof record.invites === "object" ? record.invites : {};
  record.invites[hash] = {
    role: normalizedRole,
    createdBy: actorId,
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + Math.max(60_000, Number(expiresInMs) || DEFAULT_INVITE_TTL_MS)).toISOString(),
  };
  record.updatedAt = new Date(now).toISOString();
  writeRegistry(registry);
  return {
    token,
    expiresAt: record.invites[hash].expiresAt,
    workspace: publicWorkspace(record, actorId),
  };
}

export function acceptWorkspaceCollaborationInvite({ token, userId }) {
  const id = normalizeUserId(userId);
  if (!id) return { error: "Authentication required", status: 401 };
  const hash = tokenHash(token);
  const registry = readRegistry();
  const record = Object.values(registry.workspaces)
    .find((item) => item?.invites && item.invites[hash]) || null;
  if (!record) return { error: "Workspace invitation not found", status: 404 };
  const invite = record.invites[hash];
  if (Date.parse(invite.expiresAt || "") <= Date.now()) {
    delete record.invites[hash];
    record.updatedAt = new Date().toISOString();
    writeRegistry(registry);
    return { error: "Workspace invitation has expired", status: 410 };
  }
  record.members = record.members && typeof record.members === "object" ? record.members : {};
  if (id !== record.ownerId) record.members[id] = invite.role === "viewer" ? "viewer" : "editor";
  record.updatedAt = new Date().toISOString();
  writeRegistry(registry);
  return { workspace: publicWorkspace(record, id) };
}

export function workspaceCollaborationSummary(record, userId) {
  return publicWorkspace(record, userId);
}

export function getWorkspaceCollaborationForProject({
  workspaceId,
  flowId,
  flowSource = "user",
  archived = false,
  ownerId = "",
}) {
  if (workspaceId) return getWorkspaceCollaborationById(workspaceId);
  const normalizedOwner = normalizeUserId(ownerId);
  return Object.values(readRegistry().workspaces).find((record) => (
    record
    && record.flowId === normalizeFlowId(flowId)
    && record.archived === (archived === true)
    && (record.projectSource || record.flowSource || "workspace") === flowSource
    && (!normalizedOwner || record.ownerId === normalizedOwner)
  )) || null;
}

export function listWorkspaceCollaborationsForUser(userId) {
  const actorId = normalizeUserId(userId);
  return Object.values(readRegistry().workspaces).filter((record) => (
    workspaceCollaborationAccess(record, actorId).allowed
  ));
}

export function addWorkspaceCollaborationMember({
  workspaceId,
  userId,
  memberUserId,
  role = "editor",
}) {
  const registry = readRegistry();
  const record = registry.workspaces[String(workspaceId || "").trim()];
  if (!record) return { error: "Workspace collaboration not found", status: 404 };
  const actorId = normalizeUserId(userId);
  const targetId = normalizeUserId(memberUserId);
  if (workspaceCollaborationAccess(record, actorId).role !== "owner") {
    return { error: "Only the workspace owner can add members", status: 403 };
  }
  if (!targetId) return { error: "Missing member user", status: 400 };
  if (targetId === record.ownerId) {
    return { workspace: publicWorkspace(record, actorId), unchanged: true };
  }
  record.members = record.members && typeof record.members === "object" ? record.members : {};
  record.members[targetId] = role === "viewer" ? "viewer" : "editor";
  record.updatedAt = new Date().toISOString();
  writeRegistry(registry);
  return { workspace: publicWorkspace(record, actorId), memberUserId: targetId };
}

export function setWorkspaceCollaborationTeamShare({
  workspaceId,
  userId,
  teamId,
  role = "viewer",
}) {
  const registry = readRegistry();
  const record = registry.workspaces[String(workspaceId || "").trim()];
  if (!record) return { error: "Workspace collaboration not found", status: 404 };
  const actorId = normalizeUserId(userId);
  const targetTeamId = String(teamId || "").trim();
  if (workspaceCollaborationAccess(record, actorId).role !== "owner") {
    return { error: "Only the workspace owner can share with a team", status: 403 };
  }
  if (!targetTeamId) return { error: "Missing teamId", status: 400 };
  record.teamShares = record.teamShares && typeof record.teamShares === "object" ? record.teamShares : {};
  record.teamShares[targetTeamId] = role === "editor" ? "editor" : "viewer";
  record.updatedAt = new Date().toISOString();
  writeRegistry(registry);
  return { workspace: publicWorkspace(record, actorId), teamId: targetTeamId };
}

export function removeWorkspaceCollaborationTeamShare({ workspaceId, userId, teamId }) {
  const registry = readRegistry();
  const record = registry.workspaces[String(workspaceId || "").trim()];
  if (!record) return { error: "Workspace collaboration not found", status: 404 };
  const actorId = normalizeUserId(userId);
  const targetTeamId = String(teamId || "").trim();
  if (workspaceCollaborationAccess(record, actorId).role !== "owner") {
    return { error: "Only the workspace owner can revoke a team share", status: 403 };
  }
  const removed = Boolean(record.teamShares?.[targetTeamId]);
  if (removed) delete record.teamShares[targetTeamId];
  record.updatedAt = new Date().toISOString();
  writeRegistry(registry);
  return { workspace: publicWorkspace(record, actorId), teamId: targetTeamId, removed };
}

export function removeWorkspaceCollaborationMember({
  workspaceId,
  userId,
  memberUserId,
}) {
  const registry = readRegistry();
  const record = registry.workspaces[String(workspaceId || "").trim()];
  if (!record) return { error: "Workspace collaboration not found", status: 404 };
  const actorId = normalizeUserId(userId);
  const targetId = normalizeUserId(memberUserId || actorId);
  const actorAccess = workspaceCollaborationAccess(record, actorId);
  if (!actorAccess.allowed) return { error: "Workspace collaboration permission denied", status: 403 };
  if (targetId === record.ownerId) {
    return { error: "Workspace owner cannot leave; delete or move the source project instead", status: 400 };
  }
  if (actorAccess.role !== "owner" && targetId !== actorId) {
    return { error: "Only the workspace owner can remove another member", status: 403 };
  }
  if (!record.members?.[targetId]) {
    return { workspace: publicWorkspace(record, actorId), unchanged: true };
  }
  delete record.members[targetId];
  record.updatedAt = new Date().toISOString();
  writeRegistry(registry);
  return {
    workspace: publicWorkspace(record, actorId),
    removedUserId: targetId,
    left: targetId === actorId,
  };
}

export function updateWorkspaceCollaborationFlow({
  previousFlowId,
  previousArchived = false,
  flowSource = "workspace",
  ownerId = "",
  flowId,
  archived = false,
}) {
  const registry = readRegistry();
  const record = Object.values(registry.workspaces).find((item) => (
    item?.flowId === normalizeFlowId(previousFlowId)
    && item?.archived === (previousArchived === true)
    && (item?.projectSource || item?.flowSource || "workspace") === flowSource
    && (!ownerId || item?.ownerId === normalizeUserId(ownerId))
  )) || null;
  if (!record) return null;
  record.flowId = normalizeFlowId(flowId);
  record.archived = archived === true;
  record.flowKey = flowKey(
    record.flowId,
    record.archived,
    record.projectSource || record.flowSource || "workspace",
    record.ownerId,
  );
  record.updatedAt = new Date().toISOString();
  writeRegistry(registry);
  return record;
}

export function reassignWorkspaceCollaborationOwner({
  sourceUserId,
  targetUserId,
  flowId,
  flowSource = "user",
  archived = false,
}) {
  const sourceId = normalizeUserId(sourceUserId);
  const targetId = normalizeUserId(targetUserId);
  const normalizedFlowId = normalizeFlowId(flowId);
  if (!sourceId || !targetId || !normalizedFlowId || sourceId === targetId) return { changed: false };
  const registry = readRegistry();
  const record = Object.values(registry.workspaces).find((item) => (
    item?.ownerId === sourceId
    && item?.flowId === normalizedFlowId
    && item?.archived === (archived === true)
    && (item?.projectSource || item?.flowSource || "workspace") === flowSource
  )) || null;
  if (!record) return { changed: false };
  record.members = record.members && typeof record.members === "object" ? record.members : {};
  delete record.members[targetId];
  record.members[targetId] = "owner";
  if (sourceId !== targetId) record.members[sourceId] = "editor";
  record.ownerId = targetId;
  record.flowKey = flowKey(normalizedFlowId, archived, flowSource, targetId);
  record.updatedAt = new Date().toISOString();
  writeRegistry(registry);
  return { changed: true, workspaceId: record.id, record };
}

export function deleteWorkspaceCollaborationForFlow(flowId, archived = false) {
  const registry = readRegistry();
  const key = flowKey(flowId, archived);
  const entry = Object.entries(registry.workspaces).find(([, item]) => item?.flowKey === key);
  if (!entry) return false;
  delete registry.workspaces[entry[0]];
  writeRegistry(registry);
  return true;
}

export function deleteWorkspaceCollaborationById(workspaceId) {
  const registry = readRegistry();
  const id = String(workspaceId || "").trim();
  if (!id || !registry.workspaces[id]) return false;
  delete registry.workspaces[id];
  writeRegistry(registry);
  return true;
}
