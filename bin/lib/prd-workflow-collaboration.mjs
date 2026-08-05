import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getAgentflowDataRoot } from "./paths.mjs";
import { getTeamForUser } from "./teams.mjs";

const REGISTRY_VERSION = 3;

function registryPath() {
  return path.join(getAgentflowDataRoot(), "collaboration", "prd-workflows.json");
}

function readRegistry() {
  try {
    const filePath = registryPath();
    if (!fs.existsSync(filePath)) return { version: REGISTRY_VERSION, workflows: {} };
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return {
      version: REGISTRY_VERSION,
      workflows: parsed?.workflows && typeof parsed.workflows === "object" && !Array.isArray(parsed.workflows)
        ? parsed.workflows
        : {},
    };
  } catch {
    return { version: REGISTRY_VERSION, workflows: {} };
  }
}

function writeRegistry(registry) {
  const filePath = registryPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify({
    version: REGISTRY_VERSION,
    workflows: registry?.workflows || {},
  }, null, 2) + "\n", "utf-8");
  fs.renameSync(tempPath, filePath);
}

function normalizeUserId(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeTapdId(value) {
  return String(value || "").trim();
}

function normalizeShareToken(value) {
  return String(value || "").trim();
}

function normalizeMemberRole(value) {
  const role = String(value || "").trim().toLowerCase();
  if (role === "reporter" || role === "editor") return "reporter";
  if (role === "viewer") return "viewer";
  return "";
}

function normalizedMemberMap(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .map(([userId, role]) => [normalizeUserId(userId), normalizeMemberRole(role)])
    .filter(([userId, role]) => userId && role));
}

function normalizeKnowledgeBindings(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
    const workspaceId = String(entry.workspaceId || entry.id || "").trim();
    if (!workspaceId || seen.has(workspaceId)) return [];
    seen.add(workspaceId);
    return [{
      workspaceId,
      label: String(entry.label || workspaceId).trim() || workspaceId,
      kind: String(entry.kind || "git").trim().toLowerCase(),
      type: String(entry.type || "knowledge").trim().toLowerCase(),
      branch: String(entry.branch || "").trim(),
      boundBy: normalizeUserId(entry.boundBy),
      boundAt: String(entry.boundAt || "").trim(),
    }];
  });
}

function collaborationMembers(record) {
  const ownerId = normalizeUserId(record?.ownerId);
  const explicit = normalizedMemberMap(record?.members);
  const derived = normalizedMemberMap(record?.derivedMembers);
  const rows = new Map();
  if (ownerId) rows.set(ownerId, {
    userId: ownerId,
    role: "owner",
    source: String(record?.ownerSource || "legacy"),
  });
  for (const [userId, role] of Object.entries(derived)) {
    if (userId === ownerId) continue;
    rows.set(userId, { userId, role: role === "reporter" ? "reporter" : "viewer", source: "tapd" });
  }
  for (const [userId, role] of Object.entries(explicit)) {
    if (userId === ownerId) continue;
    rows.set(userId, { userId, role, source: "explicit" });
  }
  return [...rows.values()];
}

function publicWorkflow(record, userId = "") {
  if (!record) return null;
  const actorId = normalizeUserId(userId);
  const members = collaborationMembers(record);
  const access = prdWorkflowCollaborationAccess(record, actorId);
  return {
    id: record.id,
    tapdId: record.tapdId,
    ownerId: record.ownerId,
    role: access.role,
    accessSource: access.source,
    teamId: String(record.teamId || getTeamForUser(record.ownerId)?.id || ""),
    ownerSource: String(record.ownerSource || "legacy"),
    memberCount: members.length,
    members,
    authority: record.authority && typeof record.authority === "object" ? {
      type: String(record.authority.type || ""),
      observedAt: String(record.authority.observedAt || ""),
      revision: String(record.authority.revision || ""),
      unresolvedParticipants: Array.isArray(record.authority.unresolvedParticipants)
        ? record.authority.unresolvedParticipants.map((value) => String(value || "")).filter(Boolean)
        : [],
    } : null,
    knowledgeBindings: normalizeKnowledgeBindings(record.knowledgeBindings),
    shareActive: Boolean(record.shareToken),
    shareCreatedAt: record.shareCreatedAt || "",
    createdAt: record.createdAt || "",
    updatedAt: record.updatedAt || "",
  };
}

export function prdWorkflowCollaborationAccess(record, userId) {
  if (!record) return { allowed: true, role: "" };
  const actorId = normalizeUserId(userId);
  const explicitRole = normalizeMemberRole(record.members?.[actorId]);
  const derivedRole = normalizeMemberRole(record.derivedMembers?.[actorId]);
  const directRole = actorId === record.ownerId ? "owner" : (explicitRole || derivedRole);
  const actorTeam = getTeamForUser(actorId);
  const recordTeamId = String(record.teamId || getTeamForUser(record.ownerId)?.id || "");
  const teamRole = actorTeam?.status === "active" && actorTeam.id === recordTeamId ? "viewer" : "";
  const role = directRole || teamRole;
  return {
    allowed: role === "owner" || role === "reporter" || role === "viewer",
    writable: role === "owner" || role === "reporter",
    role,
    source: actorId === record.ownerId
      ? String(record.ownerSource || "legacy")
      : explicitRole
      ? "explicit"
      : derivedRole
      ? "tapd"
      : teamRole
      ? "team"
      : "",
    teamId: teamRole ? recordTeamId : "",
  };
}

export function getPrdWorkflowCollaborationById(workflowId) {
  return readRegistry().workflows[String(workflowId || "").trim()] || null;
}

export function getPrdWorkflowCollaborationByTapdId(tapdId) {
  const normalizedTapdId = normalizeTapdId(tapdId);
  if (!normalizedTapdId) return null;
  return Object.values(readRegistry().workflows)
    .filter((record) => record?.tapdId === normalizedTapdId)
    .sort((left, right) => String(right?.updatedAt || "").localeCompare(String(left?.updatedAt || "")))[0] || null;
}

export function getPrdWorkflowCollaborationByShareToken(shareToken) {
  const token = normalizeShareToken(shareToken);
  if (!token) return null;
  const incoming = Buffer.from(token);
  return Object.values(readRegistry().workflows).find((record) => {
    if (!record?.shareToken) return false;
    const stored = Buffer.from(String(record.shareToken));
    return stored.length === incoming.length && crypto.timingSafeEqual(stored, incoming);
  }) || null;
}

export function getPrdWorkflowCollaborationForUser(tapdId, userId) {
  const normalizedTapdId = normalizeTapdId(tapdId);
  const actorId = normalizeUserId(userId);
  if (!normalizedTapdId || !actorId) return null;
  const records = Object.values(readRegistry().workflows)
    .filter((record) => (
      record?.tapdId === normalizedTapdId
      && prdWorkflowCollaborationAccess(record, actorId).allowed
    ))
    .sort((left, right) => String(right?.updatedAt || "").localeCompare(String(left?.updatedAt || "")));
  return records.find((record) => record.ownerId === actorId) || records[0] || null;
}

export function listPrdWorkflowCollaborationsForUser(userId) {
  const actorId = normalizeUserId(userId);
  if (!actorId) return [];
  return Object.values(readRegistry().workflows)
    .filter((record) => (
      record?.ownerId === actorId
      || Boolean(normalizeMemberRole(record?.members?.[actorId]))
      || Boolean(normalizeMemberRole(record?.derivedMembers?.[actorId]))
    ))
    .sort((left, right) => String(right?.updatedAt || "").localeCompare(String(left?.updatedAt || "")));
}

export function listPrdWorkflowCollaborationsForTeam(teamId) {
  const id = String(teamId || "").trim();
  if (!id) return [];
  return Object.values(readRegistry().workflows)
    .filter((record) => String(record?.teamId || getTeamForUser(record?.ownerId)?.id || "") === id)
    .sort((left, right) => String(right?.updatedAt || "").localeCompare(String(left?.updatedAt || "")));
}

export function ensurePrdWorkflowCollaboration({ tapdId, userId }) {
  const ownerId = normalizeUserId(userId);
  const normalizedTapdId = normalizeTapdId(tapdId);
  if (!ownerId) return { error: "Authentication required", status: 401 };
  if (!normalizedTapdId) return { error: "Missing tapdId", status: 400 };
  const registry = readRegistry();
  let record = Object.values(registry.workflows).find((item) => item?.tapdId === normalizedTapdId) || null;
  if (record) {
    const access = prdWorkflowCollaborationAccess(record, ownerId);
    if (!access.allowed) return { error: "Workflow already belongs to another owner", status: 403 };
    return { record, workflow: publicWorkflow(record, ownerId), created: false };
  }
  const now = new Date().toISOString();
  const workflowId = `prd_${crypto.randomBytes(12).toString("hex")}`;
  record = {
    id: workflowId,
    tapdId: normalizedTapdId,
    ownerId,
    ownerSource: "legacy",
    stateOwnerId: ownerId,
    teamId: String(getTeamForUser(ownerId)?.id || ""),
    members: {},
    derivedMembers: {},
    createdAt: now,
    updatedAt: now,
  };
  registry.workflows[workflowId] = record;
  writeRegistry(registry);
  return { record, workflow: publicWorkflow(record, ownerId), created: true };
}

export function prdWorkflowCollaborationSummary(record, userId) {
  return publicWorkflow(record, userId);
}

export function setPrdWorkflowKnowledgeBindings({ tapdId, userId, bindings = [] }) {
  const record = getPrdWorkflowCollaborationForUser(tapdId, userId);
  if (!record) return { error: "PRD Workflow collaboration not found", status: 404 };
  const actorId = normalizeUserId(userId);
  if (prdWorkflowCollaborationAccess(record, actorId).role !== "owner") {
    return { error: "Only the Workflow owner can manage knowledge bindings", status: 403 };
  }
  const registry = readRegistry();
  const stored = registry.workflows[record.id];
  if (!stored) return { error: "PRD Workflow collaboration not found", status: 404 };
  const now = new Date().toISOString();
  stored.knowledgeBindings = normalizeKnowledgeBindings(bindings).map((binding) => ({
    ...binding,
    boundBy: actorId,
    boundAt: binding.boundAt || now,
  }));
  stored.updatedAt = now;
  writeRegistry(registry);
  return {
    record: stored,
    workflow: publicWorkflow(stored, actorId),
    knowledgeBindings: normalizeKnowledgeBindings(stored.knowledgeBindings),
  };
}

export function ensurePrdWorkflowShareLink({ tapdId, userId }) {
  const ensured = ensurePrdWorkflowCollaboration({ tapdId, userId });
  if (ensured.error) return ensured;
  const actorId = normalizeUserId(userId);
  if (prdWorkflowCollaborationAccess(ensured.record, actorId).role !== "owner") {
    return { error: "Only the Workflow owner can create a share link", status: 403 };
  }
  if (ensured.record.shareToken) {
    return {
      record: ensured.record,
      workflow: publicWorkflow(ensured.record, actorId),
      shareToken: ensured.record.shareToken,
      created: false,
    };
  }
  const registry = readRegistry();
  const record = registry.workflows[ensured.record.id];
  if (!record) return { error: "PRD Workflow collaboration not found", status: 404 };
  const now = new Date().toISOString();
  record.shareToken = crypto.randomBytes(24).toString("base64url");
  record.shareCreatedAt = now;
  record.updatedAt = now;
  writeRegistry(registry);
  return {
    record,
    workflow: publicWorkflow(record, actorId),
    shareToken: record.shareToken,
    created: true,
  };
}

export function revokePrdWorkflowShareLink({ tapdId, userId }) {
  const record = getPrdWorkflowCollaborationForUser(tapdId, userId);
  if (!record) return { error: "PRD Workflow collaboration not found", status: 404 };
  const actorId = normalizeUserId(userId);
  if (prdWorkflowCollaborationAccess(record, actorId).role !== "owner") {
    return { error: "Only the Workflow owner can revoke a share link", status: 403 };
  }
  const registry = readRegistry();
  const stored = registry.workflows[record.id];
  if (!stored) return { error: "PRD Workflow collaboration not found", status: 404 };
  const revoked = Boolean(stored.shareToken);
  delete stored.shareToken;
  delete stored.shareCreatedAt;
  stored.updatedAt = new Date().toISOString();
  writeRegistry(registry);
  return {
    workflow: publicWorkflow(stored, actorId),
    revoked,
  };
}

export function addPrdWorkflowCollaborationMember({
  workflowId,
  userId,
  memberUserId,
  role = "reporter",
}) {
  const registry = readRegistry();
  const record = registry.workflows[String(workflowId || "").trim()];
  if (!record) return { error: "PRD Workflow collaboration not found", status: 404 };
  const actorId = normalizeUserId(userId);
  const targetId = normalizeUserId(memberUserId);
  if (prdWorkflowCollaborationAccess(record, actorId).role !== "owner") {
    return { error: "Only the Workflow owner can add members", status: 403 };
  }
  if (!targetId) return { error: "Missing member user", status: 400 };
  if (targetId === record.ownerId) {
    return { workflow: publicWorkflow(record, actorId), unchanged: true };
  }
  const normalizedRole = normalizeMemberRole(role);
  if (!normalizedRole) {
    return { error: "Workflow member role must be reporter or viewer", status: 400 };
  }
  const conflicting = Object.values(registry.workflows).find((item) => (
    item?.id !== record.id
    && item?.tapdId === record.tapdId
    && prdWorkflowCollaborationAccess(item, targetId).allowed
  ));
  if (conflicting) {
    return { error: "该用户已经加入同一 TAPD ID 的另一个 Workflow 分享", status: 409 };
  }
  record.members = record.members && typeof record.members === "object" ? record.members : {};
  record.members[targetId] = normalizedRole;
  record.updatedAt = new Date().toISOString();
  writeRegistry(registry);
  return { workflow: publicWorkflow(record, actorId), memberUserId: targetId };
}

export function syncPrdWorkflowAuthority({
  tapdId,
  userId,
  isAdmin = false,
  authority = "tapd",
  ownerUserId,
  ownerIdentity = "",
  participantUserIds = [],
  participantIdentities = [],
  unresolvedParticipants = [],
  observedAt = "",
  revision = "",
}) {
  const actorId = normalizeUserId(userId);
  const normalizedTapdId = normalizeTapdId(tapdId);
  const normalizedOwnerId = normalizeUserId(ownerUserId);
  const authorityType = String(authority || "tapd").trim().toLowerCase();
  if (!actorId) return { error: "Authentication required", status: 401 };
  if (!normalizedTapdId) return { error: "Missing tapdId", status: 400 };
  if (authorityType !== "tapd") return { error: `Unsupported Workflow authority: ${authorityType}`, status: 400 };
  if (!normalizedOwnerId) return { error: "TAPD owner must be a registered AgentFlow user", status: 422 };
  const normalizedObservedAt = String(observedAt || "").trim();
  if (normalizedObservedAt && !Number.isFinite(Date.parse(normalizedObservedAt))) {
    return { error: "observedAt must be an ISO-compatible date", status: 400 };
  }

  const registry = readRegistry();
  let record = Object.values(registry.workflows).find((item) => item?.tapdId === normalizedTapdId) || null;
  const previousOwnerId = normalizeUserId(record?.ownerId);
  if (!record && actorId !== normalizedOwnerId && isAdmin !== true) {
    return { error: "Only the TAPD owner can initialize Workflow permissions", status: 403 };
  }
  if (record && actorId !== previousOwnerId && isAdmin !== true) {
    return { error: "Only the current Workflow owner or an administrator can synchronize TAPD permissions", status: 403 };
  }
  const storedObservedAt = String(record?.authority?.observedAt || "").trim();
  if (storedObservedAt && normalizedObservedAt && Date.parse(normalizedObservedAt) < Date.parse(storedObservedAt)) {
    return { error: "TAPD permission snapshot is older than the stored snapshot", status: 409 };
  }

  const now = new Date().toISOString();
  if (!record) {
    const workflowId = `prd_${crypto.randomBytes(12).toString("hex")}`;
    record = {
      id: workflowId,
      tapdId: normalizedTapdId,
      stateOwnerId: normalizedOwnerId,
      members: {},
      createdAt: now,
    };
    registry.workflows[workflowId] = record;
  }
  const participants = [...new Set(participantUserIds.map(normalizeUserId).filter(Boolean))]
    .filter((id) => id !== normalizedOwnerId);
  record.ownerId = normalizedOwnerId;
  record.stateOwnerId = normalizeUserId(record.stateOwnerId || previousOwnerId || normalizedOwnerId);
  record.ownerSource = "tapd";
  record.teamId = String(getTeamForUser(normalizedOwnerId)?.id || "");
  record.members = normalizedMemberMap(record.members);
  delete record.members[normalizedOwnerId];
  record.derivedMembers = Object.fromEntries(participants.map((id) => [id, "viewer"]));
  record.authority = {
    type: "tapd",
    ownerIdentity: String(ownerIdentity || "").trim(),
    participantIdentities: [...new Set(participantIdentities.map((value) => String(value || "").trim()).filter(Boolean))],
    unresolvedParticipants: [...new Set(unresolvedParticipants.map((value) => String(value || "").trim()).filter(Boolean))],
    observedAt: normalizedObservedAt || now,
    revision: String(revision || "").trim(),
  };
  record.updatedAt = now;
  writeRegistry(registry);
  return {
    record,
    workflow: publicWorkflow(record, actorId),
    created: !previousOwnerId,
    ownerChanged: Boolean(previousOwnerId && previousOwnerId !== normalizedOwnerId),
    previousOwnerId,
  };
}

export function removePrdWorkflowCollaborationMember({
  workflowId,
  userId,
  memberUserId,
}) {
  const registry = readRegistry();
  const record = registry.workflows[String(workflowId || "").trim()];
  if (!record) return { error: "PRD Workflow collaboration not found", status: 404 };
  const actorId = normalizeUserId(userId);
  const targetId = normalizeUserId(memberUserId || actorId);
  const access = prdWorkflowCollaborationAccess(record, actorId);
  if (!access.allowed) return { error: "PRD Workflow collaboration permission denied", status: 403 };
  if (targetId === record.ownerId) return { error: "Workflow owner cannot leave", status: 400 };
  if (access.role !== "owner" && targetId !== actorId) {
    return { error: "Only the Workflow owner can remove another member", status: 403 };
  }
  if (!record.members?.[targetId]) {
    return { workflow: publicWorkflow(record, actorId), unchanged: true };
  }
  delete record.members[targetId];
  record.updatedAt = new Date().toISOString();
  writeRegistry(registry);
  const selfRemoved = targetId === actorId;
  const stillAllowed = prdWorkflowCollaborationAccess(record, actorId).allowed;
  return {
    workflow: publicWorkflow(record, actorId),
    removedUserId: targetId,
    left: selfRemoved && !stillAllowed,
  };
}
