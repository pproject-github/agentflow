import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getAgentflowDataRoot } from "./paths.mjs";
import { getTeamForUser } from "./teams.mjs";

const REGISTRY_VERSION = 1;

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

function publicWorkflow(record, userId = "") {
  if (!record) return null;
  const actorId = normalizeUserId(userId);
  const members = record.members && typeof record.members === "object" ? record.members : {};
  const access = prdWorkflowCollaborationAccess(record, actorId);
  return {
    id: record.id,
    tapdId: record.tapdId,
    ownerId: record.ownerId,
    role: access.role,
    accessSource: access.source,
    teamId: String(record.teamId || getTeamForUser(record.ownerId)?.id || ""),
    memberCount: Object.keys(members).length,
    members: Object.entries(members).map(([id, role]) => ({ userId: id, role })),
    shareActive: Boolean(record.shareToken),
    shareCreatedAt: record.shareCreatedAt || "",
    createdAt: record.createdAt || "",
    updatedAt: record.updatedAt || "",
  };
}

export function prdWorkflowCollaborationAccess(record, userId) {
  if (!record) return { allowed: true, role: "" };
  const actorId = normalizeUserId(userId);
  const directRole = actorId === record.ownerId ? "owner" : String(record.members?.[actorId] || "");
  const actorTeam = getTeamForUser(actorId);
  const recordTeamId = String(record.teamId || getTeamForUser(record.ownerId)?.id || "");
  const teamRole = actorTeam?.status === "active" && actorTeam.id === recordTeamId ? "viewer" : "";
  const role = directRole || teamRole;
  return {
    allowed: role === "owner" || role === "editor" || role === "viewer",
    writable: role === "owner" || role === "editor",
    role,
    source: directRole ? "member" : teamRole ? "team" : "",
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
      record?.ownerId === actorId || Boolean(record?.members?.[actorId])
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
    teamId: String(getTeamForUser(ownerId)?.id || ""),
    members: { [ownerId]: "owner" },
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
  role = "editor",
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
  const conflicting = Object.values(registry.workflows).find((item) => (
    item?.id !== record.id
    && item?.tapdId === record.tapdId
    && prdWorkflowCollaborationAccess(item, targetId).allowed
  ));
  if (conflicting) {
    return { error: "该用户已经加入同一 TAPD ID 的另一个 Workflow 分享", status: 409 };
  }
  record.members = record.members && typeof record.members === "object" ? record.members : {};
  record.members[targetId] = role === "viewer" ? "viewer" : "editor";
  record.updatedAt = new Date().toISOString();
  writeRegistry(registry);
  return { workflow: publicWorkflow(record, actorId), memberUserId: targetId };
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
  return {
    workflow: publicWorkflow(record, actorId),
    removedUserId: targetId,
    left: targetId === actorId,
  };
}
