import fs from "fs";
import path from "path";

import { readAuthUsers } from "./auth.mjs";
import { reassignWorkspaceCollaborationOwner } from "./workspace-collaboration.mjs";
import { readWorkspaceDraftMetadata, writeWorkspaceDraftMetadata } from "./workspace-draft.mjs";
import { reassignWorkspaceScheduleOwner } from "./workspace-server.mjs";
import {
  ARCHIVED_PIPELINES_DIR_NAME,
  getAgentflowDataRoot,
  getUserPipelinesRoot,
  isFlowDir,
  sanitizeAgentflowUserId,
} from "./paths.mjs";

function projectRoot(userId, archived = false) {
  const root = getUserPipelinesRoot(userId);
  return archived ? path.join(root, ARCHIVED_PIPELINES_DIR_NAME) : root;
}

function projectDirectory(userId, flowId, archived = false) {
  const safeUserId = sanitizeAgentflowUserId(userId);
  const id = String(flowId || "").trim();
  if (!safeUserId || !id || id !== path.basename(id) || id === "." || id === "..") return "";
  const root = path.resolve(projectRoot(safeUserId, archived));
  const candidate = path.resolve(root, id);
  return candidate.startsWith(`${root}${path.sep}`) ? candidate : "";
}

function projectSummary(userId, flowId, archived = false) {
  const dir = projectDirectory(userId, flowId, archived);
  if (!dir || !fs.existsSync(dir) || !isFlowDir(dir)) return null;
  let updatedAt = "";
  try { updatedAt = fs.statSync(dir).mtime.toISOString(); } catch { /* ignore */ }
  return { userId, flowId, archived: archived === true, updatedAt };
}

export function listAdminOwnedProjects() {
  const users = readAuthUsers();
  const projects = [];
  for (const userId of Object.keys(users)) {
    for (const archived of [false, true]) {
      const root = projectRoot(userId, archived);
      let entries = [];
      try {
        entries = fs.readdirSync(root, { withFileTypes: true });
      } catch {
        entries = [];
      }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const summary = projectSummary(userId, entry.name, archived);
        if (summary) projects.push(summary);
      }
    }
  }
  return projects.sort((left, right) => (
    left.userId.localeCompare(right.userId)
    || Number(left.archived) - Number(right.archived)
    || left.flowId.localeCompare(right.flowId)
  ));
}

export function listUserOwnedProjects(userId) {
  const normalizedUserId = sanitizeAgentflowUserId(userId);
  if (!normalizedUserId) return [];
  return listAdminOwnedProjects().filter((project) => project.userId === normalizedUserId);
}

function appendTransferAudit(record) {
  const filePath = path.join(getAgentflowDataRoot(), "admin", "project-owner-transfers.jsonl");
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, "utf8");
}

export function reassignAdminProjectOwner({ actorUserId, sourceUserId, targetUserId, flowId, archived = false, dryRun = false, transferKind = "admin" } = {}) {
  const sourceId = sanitizeAgentflowUserId(sourceUserId);
  const targetId = sanitizeAgentflowUserId(targetUserId);
  const projectId = String(flowId || "").trim();
  if (!sourceId || !targetId || !projectId) return { ok: false, status: 400, error: "缺少有效的原用户、目标用户或 Project" };
  if (sourceId === targetId) return { ok: false, status: 400, error: "原用户和目标用户不能相同" };
  const users = readAuthUsers();
  const sourceUser = users[sourceId];
  const targetUser = users[targetId];
  if (!sourceUser) return { ok: false, status: 404, error: "原用户不存在" };
  if (!targetUser) return { ok: false, status: 404, error: "目标用户不存在" };
  if (targetUser.isAdmin || String(targetUser.authProvider || "") !== "cas") {
    return { ok: false, status: 400, error: "目标用户必须是已登录过 AgentFlow 的 CAS 用户" };
  }
  const sourceDir = projectDirectory(sourceId, projectId, archived);
  const targetDir = projectDirectory(targetId, projectId, archived);
  if (!sourceDir || !targetDir || !fs.existsSync(sourceDir) || !isFlowDir(sourceDir)) {
    return { ok: false, status: 404, error: "原 Project 不存在" };
  }
  if (fs.lstatSync(sourceDir).isSymbolicLink()) return { ok: false, status: 400, error: "不支持迁移符号链接 Project" };
  if (fs.existsSync(targetDir)) return { ok: false, status: 409, error: "目标用户已有同名 Project，请先处理名称冲突" };
  const scheduleCheck = reassignWorkspaceScheduleOwner({
    sourceUserId: sourceId,
    targetUserId: targetId,
    targetUsername: targetUser.username || targetId,
    flowId: projectId,
    flowSource: "user",
    dryRun: true,
  });
  if (scheduleCheck.conflict) return { ok: false, status: 409, error: scheduleCheck.error };
  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      project: { userId: targetId, flowId: projectId, archived: archived === true },
      sourceUserId: sourceId,
      targetUserId: targetId,
    };
  }

  fs.mkdirSync(path.dirname(targetDir), { recursive: true });
  fs.renameSync(sourceDir, targetDir);
  const draft = readWorkspaceDraftMetadata(targetDir);
  if (draft) writeWorkspaceDraftMetadata(targetDir, { ...draft, ownerId: targetId, updatedAt: new Date().toISOString() });
  const collaboration = reassignWorkspaceCollaborationOwner({
    sourceUserId: sourceId,
    targetUserId: targetId,
    flowId: projectId,
    flowSource: "user",
    archived,
  });
  const schedules = archived ? { changed: 0 } : reassignWorkspaceScheduleOwner({
    sourceUserId: sourceId,
    targetUserId: targetId,
    targetUsername: targetUser.username || targetId,
    flowId: projectId,
    flowSource: "user",
  });
  const transferredAt = new Date().toISOString();
  appendTransferAudit({
    action: "project_owner_reassigned",
    actorUserId: String(actorUserId || ""),
    sourceUserId: sourceId,
    targetUserId: targetId,
    flowId: projectId,
    archived: archived === true,
    collaborationChanged: collaboration.changed === true,
    schedulesChanged: Number(schedules.changed || 0),
    transferKind: String(transferKind || "admin"),
    transferredAt,
  });
  return {
    ok: true,
    project: { userId: targetId, flowId: projectId, archived: archived === true, updatedAt: transferredAt },
    sourceUserId: sourceId,
    targetUserId: targetId,
    collaborationChanged: collaboration.changed === true,
    schedulesChanged: Number(schedules.changed || 0),
  };
}

export function reassignAllUserProjects({ actorUserId, sourceUserId, targetUserId, transferKind = "self_service_legacy_link" } = {}) {
  const sourceId = sanitizeAgentflowUserId(sourceUserId);
  const targetId = sanitizeAgentflowUserId(targetUserId);
  if (!sourceId || !targetId || sourceId === targetId) {
    return { ok: false, status: 400, error: "旧账号与 CAS 用户无效" };
  }
  const projects = listUserOwnedProjects(sourceId);
  for (const project of projects) {
    const checked = reassignAdminProjectOwner({
      actorUserId,
      sourceUserId: sourceId,
      targetUserId: targetId,
      flowId: project.flowId,
      archived: project.archived,
      dryRun: true,
      transferKind,
    });
    if (!checked.ok) {
      return { ...checked, error: `${project.flowId}：${checked.error || "迁移预检失败"}`, project };
    }
  }
  const transferred = [];
  for (const project of projects) {
    const result = reassignAdminProjectOwner({
      actorUserId,
      sourceUserId: sourceId,
      targetUserId: targetId,
      flowId: project.flowId,
      archived: project.archived,
      transferKind,
    });
    if (!result.ok) {
      return {
        ...result,
        status: 500,
        error: `${project.flowId}：${result.error || "迁移失败"}`,
        partial: transferred,
      };
    }
    transferred.push(result.project);
  }
  return { ok: true, sourceUserId: sourceId, targetUserId: targetId, projects: transferred, transferredProjects: transferred.length };
}
