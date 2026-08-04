import crypto from "crypto";
import fs from "fs";
import path from "path";
import { getAgentflowDataRoot } from "./paths.mjs";

const REGISTRY_VERSION = 1;

function registryPath() {
  return path.join(getAgentflowDataRoot(), "organization", "teams.json");
}

function normalizeUserId(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeTeamId(value) {
  return String(value || "").trim();
}

function normalizeMembers(value) {
  const members = Array.isArray(value) ? value : [];
  return Array.from(new Set(members.map(normalizeUserId).filter(Boolean)));
}

function readRegistry() {
  try {
    const filePath = registryPath();
    if (!fs.existsSync(filePath)) return { version: REGISTRY_VERSION, teams: {} };
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return {
      version: REGISTRY_VERSION,
      teams: parsed?.teams && typeof parsed.teams === "object" && !Array.isArray(parsed.teams)
        ? parsed.teams
        : {},
    };
  } catch {
    return { version: REGISTRY_VERSION, teams: {} };
  }
}

function writeRegistry(registry) {
  const filePath = registryPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify({
    version: REGISTRY_VERSION,
    teams: registry?.teams || {},
  }, null, 2) + "\n", "utf-8");
  fs.renameSync(tempPath, filePath);
}

function publicTeam(record) {
  if (!record) return null;
  const members = normalizeMembers(record.members);
  return {
    id: String(record.id || ""),
    name: String(record.name || ""),
    description: String(record.description || ""),
    status: record.status === "inactive" ? "inactive" : "active",
    members,
    memberCount: members.length,
    createdAt: String(record.createdAt || ""),
    updatedAt: String(record.updatedAt || ""),
  };
}

export function listTeams({ includeInactive = true } = {}) {
  return Object.values(readRegistry().teams)
    .map(publicTeam)
    .filter((team) => includeInactive || team.status === "active")
    .sort((left, right) => left.name.localeCompare(right.name));
}

export function getTeamById(teamId) {
  return publicTeam(readRegistry().teams[normalizeTeamId(teamId)] || null);
}

export function getTeamForUser(userId, { includeInactive = false } = {}) {
  const id = normalizeUserId(userId);
  if (!id) return null;
  return listTeams({ includeInactive }).find((team) => team.members.includes(id)) || null;
}

export function createTeam({ name, description = "" } = {}) {
  const normalizedName = String(name || "").trim();
  if (!normalizedName) return { error: "团队名称不能为空", status: 400 };
  const registry = readRegistry();
  const duplicate = Object.values(registry.teams).some((team) => (
    String(team?.name || "").trim().toLowerCase() === normalizedName.toLowerCase()
  ));
  if (duplicate) return { error: "已存在同名团队", status: 409 };
  const now = new Date().toISOString();
  const id = `team_${crypto.randomBytes(10).toString("hex")}`;
  const record = {
    id,
    name: normalizedName,
    description: String(description || "").trim(),
    status: "active",
    members: [],
    createdAt: now,
    updatedAt: now,
  };
  registry.teams[id] = record;
  writeRegistry(registry);
  return { team: publicTeam(record), created: true };
}

export function updateTeam(teamId, patch = {}) {
  const id = normalizeTeamId(teamId);
  const registry = readRegistry();
  const record = registry.teams[id];
  if (!record) return { error: "团队不存在", status: 404 };
  if (Object.prototype.hasOwnProperty.call(patch, "name")) {
    const name = String(patch.name || "").trim();
    if (!name) return { error: "团队名称不能为空", status: 400 };
    const duplicate = Object.values(registry.teams).some((team) => (
      team?.id !== id && String(team?.name || "").trim().toLowerCase() === name.toLowerCase()
    ));
    if (duplicate) return { error: "已存在同名团队", status: 409 };
    record.name = name;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "description")) {
    record.description = String(patch.description || "").trim();
  }
  if (Object.prototype.hasOwnProperty.call(patch, "status")) {
    record.status = patch.status === "inactive" ? "inactive" : "active";
  }
  record.updatedAt = new Date().toISOString();
  writeRegistry(registry);
  return { team: publicTeam(record) };
}

export function setTeamMembers(teamId, members = []) {
  const id = normalizeTeamId(teamId);
  const registry = readRegistry();
  const record = registry.teams[id];
  if (!record) return { error: "团队不存在", status: 404 };
  const normalized = normalizeMembers(members);
  for (const team of Object.values(registry.teams)) {
    if (!team || team.id === id) continue;
    team.members = normalizeMembers(team.members).filter((memberId) => !normalized.includes(memberId));
  }
  record.members = normalized;
  record.updatedAt = new Date().toISOString();
  writeRegistry(registry);
  return { team: publicTeam(record) };
}

export function deleteTeam(teamId) {
  const id = normalizeTeamId(teamId);
  const registry = readRegistry();
  const record = registry.teams[id];
  if (!record) return { error: "团队不存在", status: 404 };
  if (normalizeMembers(record.members).length > 0) {
    return { error: "请先移出团队中的全部成员", status: 409 };
  }
  delete registry.teams[id];
  writeRegistry(registry);
  return { deleted: true, teamId: id };
}
