/**
 * 服务端启动前的数据迁移。
 *
 * 迁移直接在物理存储上执行，不经过用户 Token：服务端已经知道 AGENTFLOW_HOME、全部用户
 * pipelines 和当前 workspaceRoot。这里只自动做无损转换；需要 `--allow-loss` 的老 YAML
 * 永远留给人工决定。
 */
import fs from "fs";
import path from "path";

import { migrateFlowDirToDsl } from "./flow-dsl/cli.mjs";
import { readWorkspaceDesign } from "./workspace-flow-store.mjs";
import {
  ARCHIVED_PIPELINES_DIR_NAME,
  LEGACY_PIPELINES_DIR,
  PIPELINES_DIR,
  getAgentflowDataRoot,
  isFlowDir,
} from "./paths.mjs";

export const STORAGE_SCHEMA_VERSION = 1;
export const WORKSPACE_FLOW_DSL_MIGRATION_ID = "workspace-flow-dsl-v1";
export const WORKSPACE_SCHEDULE_OWNER_MIGRATION_ID = "workspace-schedule-owner-v1";

const STATE_FILENAME = "storage-migrations.json";
const LOCK_FILENAME = "storage-migrations.lock";
const GRAPH_FILENAME = "workspace.graph.json";

function readState(filePath) {
  if (!fs.existsSync(filePath)) return { schemaVersion: 0, migrations: {} };
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Invalid storage migration state: ${filePath}`);
  }
  return {
    ...parsed,
    schemaVersion: Number(parsed.schemaVersion || 0),
    migrations: parsed.migrations && typeof parsed.migrations === "object" && !Array.isArray(parsed.migrations)
      ? parsed.migrations
      : {},
  };
}

function writeJsonAtomic(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
  fs.renameSync(tempPath, filePath);
}

function acquireLock(lockPath) {
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  let fd;
  try {
    fd = fs.openSync(lockPath, "wx");
    fs.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`, "utf-8");
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`Storage migration is already running: ${lockPath}`);
    }
    throw error;
  }
  return () => {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.rmSync(lockPath, { force: true }); } catch { /* a stale lock is safer than deleting another path */ }
  };
}

function listFlowDirs(pipelinesRoot, scope) {
  const root = path.resolve(pipelinesRoot);
  if (!fs.existsSync(root)) return [];
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Cannot list pipeline root ${root}: ${error?.message || String(error)}`);
  }
  const flows = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ARCHIVED_PIPELINES_DIR_NAME) continue;
    const flowDir = path.join(root, entry.name);
    if (isFlowDir(flowDir)) flows.push({ flowId: entry.name, flowDir, archived: false, scope });
  }
  const archivedRoot = path.join(root, ARCHIVED_PIPELINES_DIR_NAME);
  if (fs.existsSync(archivedRoot)) {
    for (const entry of fs.readdirSync(archivedRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const flowDir = path.join(archivedRoot, entry.name);
      if (isFlowDir(flowDir)) flows.push({ flowId: entry.name, flowDir, archived: true, scope });
    }
  }
  return flows;
}

function dataPipelineRoots(dataRoot) {
  const roots = [{ path: path.join(dataRoot, "pipelines"), scope: "user:legacy" }];
  const usersRoot = path.join(dataRoot, "users");
  if (!fs.existsSync(usersRoot)) return roots;
  for (const entry of fs.readdirSync(usersRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    roots.push({ path: path.join(usersRoot, entry.name, "pipelines"), scope: `user:${entry.name}` });
  }
  return roots;
}

function workspacePipelineRoots(workspaceRoot) {
  return [
    { path: path.join(workspaceRoot, PIPELINES_DIR), scope: "workspace" },
    { path: path.join(workspaceRoot, LEGACY_PIPELINES_DIR), scope: "workspace:legacy" },
  ];
}

function uniqueFlows(roots) {
  const seen = new Set();
  const flows = [];
  for (const root of roots) {
    for (const flow of listFlowDirs(root.path, root.scope)) {
      let key = path.resolve(flow.flowDir);
      try { key = fs.realpathSync(flow.flowDir); } catch { /* keep resolved path */ }
      if (seen.has(key)) continue;
      seen.add(key);
      flows.push(flow);
    }
  }
  return flows.sort((a, b) => a.flowDir.localeCompare(b.flowDir));
}

function backupLegacyGraph(flowDir) {
  const graphPath = path.join(flowDir, GRAPH_FILENAME);
  if (!fs.existsSync(graphPath)) return "";
  const backupPath = path.join(
    flowDir,
    ".agentflow-migrations",
    WORKSPACE_FLOW_DSL_MIGRATION_ID,
    GRAPH_FILENAME,
  );
  if (!fs.existsSync(backupPath)) {
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(graphPath, backupPath, fs.constants.COPYFILE_EXCL);
  }
  return backupPath;
}

function migrateFlows(flows, { marketplaceRoot = "" } = {}) {
  const rows = [];
  for (const flow of flows) {
    try {
      const backup = backupLegacyGraph(flow.flowDir);
      const result = migrateFlowDirToDsl(flow.flowDir, { marketplaceRoot });
      const lost = [...(result.dropped || []), ...(result.droppedEdges || [])]
        .filter((item) => !item?.benign)
        .map((item) => item.id || `${item.source}->${item.target}`);
      rows.push({
        flowId: flow.flowId,
        scope: flow.scope,
        archived: flow.archived,
        flowDir: flow.flowDir,
        source: result.source || result.format,
        result: result.format === "yaml" ? "needs-decision"
          : result.migrated ? "migrated-dsl"
          : result.leftYaml ? "migrated-json"
          : result.format === "dsl" ? "already-current"
          : result.format === "json" ? "degraded-json"
          : "empty",
        ...(backup ? { backup } : {}),
        ...(result.degradedReason ? { degradedReason: result.degradedReason } : {}),
        ...(lost.length ? { lost } : {}),
        ...(result.warnings?.length ? { warnings: result.warnings } : {}),
      });
    } catch (error) {
      rows.push({
        flowId: flow.flowId,
        scope: flow.scope,
        archived: flow.archived,
        flowDir: flow.flowDir,
        result: "failed",
        error: error?.message || String(error),
      });
    }
  }
  return rows;
}

function summarizeRows(rows) {
  const count = (result) => rows.filter((row) => row.result === result).length;
  return {
    total: rows.length,
    migrated: count("migrated-dsl") + count("migrated-json"),
    alreadyCurrent: count("already-current"),
    degraded: count("degraded-json") + count("migrated-json"),
    needsDecision: rows.filter((row) => row.result === "needs-decision")
      .map((row) => `${row.flowId} [${row.scope}${row.archived ? ":archived" : ""}]`),
    failed: rows.filter((row) => row.result === "failed")
      .map((row) => `${row.flowId} [${row.scope}${row.archived ? ":archived" : ""}]: ${row.error}`),
  };
}

function readJsonObjectFile(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/** 这个用户的这份流程里，`scheduleNodeId` 确实是一个 workspace_scheduled_run 节点吗 */
function flowDeclaresScheduleNode(flowDir, scheduleNodeId) {
  if (!scheduleNodeId || !fs.existsSync(flowDir) || !isFlowDir(flowDir)) return false;
  try {
    const { graph } = readWorkspaceDesign(flowDir);
    return String(graph?.instances?.[scheduleNodeId]?.definitionId || "") === "workspace_scheduled_run";
  } catch {
    return false;
  }
}

function userFlowDir(dataRoot, userId, flowId, archived) {
  const root = path.join(dataRoot, "users", String(userId || ""), "pipelines");
  return archived === true ? path.join(root, ARCHIVED_PIPELINES_DIR_NAME, flowId) : path.join(root, flowId);
}

/**
 * 修定时登记里判错的归属。
 *
 * 历史上归属只按 flowId 找协作登记，两个人各有一份同名个人流程时会判成对方：登记、
 * 调度身份、运行记录一起改姓，事后从记录里看不出真正的作者。这里按**目录**认回来——
 * 哪个用户的 pipelines 里确实有这份流程、且图里确实有这个定时节点，就是谁的。
 * 认不回来的（流程已删、多个用户都对得上）一律不动，只记进结果里。
 */
export function repairWorkspaceScheduleOwners(dataRoot, { dryRun = false } = {}) {
  const schedulesPath = path.join(dataRoot, "workspace-schedules.json");
  const registry = readJsonObjectFile(schedulesPath, null);
  const schedules = registry?.schedules && typeof registry.schedules === "object" ? registry.schedules : null;
  if (!schedules) return { total: 0, repaired: [], dropped: [], unresolved: [], skipped: true };

  const authUsers = readJsonObjectFile(path.join(dataRoot, "auth", "users.json"), {});
  const collaborations = Object.values(
    readJsonObjectFile(path.join(dataRoot, "collaboration", "workspaces.json"), {})?.workspaces || {},
  ).filter(Boolean);
  const userIds = (() => {
    const usersRoot = path.join(dataRoot, "users");
    try {
      return fs.readdirSync(usersRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  })();

  const next = {};
  const repaired = [];
  const dropped = [];
  const unresolved = [];
  for (const [key, entry] of Object.entries(schedules)) {
    const flowId = String(entry?.flowId || "");
    const flowSource = String(entry?.flowSource || "user");
    const scheduleNodeId = String(entry?.scheduleNodeId || key.split(":").pop() || "");
    const currentUserId = String(entry?.userId || "");
    const archived = entry?.archived === true;
    let ownerUserId = "";
    if (flowSource === "workspace") {
      // 共享作用域全局唯一：协作登记里的 owner 就是答案。
      ownerUserId = String(collaborations.find((record) => (
        String(record?.flowId || "") === flowId
        && record?.archived === archived
        && String(record?.projectSource || record?.flowSource || "workspace") === "workspace"
      ))?.ownerId || "");
    } else {
      const candidates = userIds.filter((userId) => (
        flowDeclaresScheduleNode(userFlowDir(dataRoot, userId, flowId, archived), scheduleNodeId)
      ));
      if (candidates.length === 1) ownerUserId = candidates[0];
      else if (candidates.includes(currentUserId)) ownerUserId = currentUserId;
    }
    if (!ownerUserId || ownerUserId === currentUserId) {
      if (!ownerUserId) unresolved.push({ key, flowId, flowSource, userId: currentUserId });
      next[key] = entry;
      continue;
    }
    const nextKey = [ownerUserId, flowSource, flowId, scheduleNodeId].join(":");
    if (schedules[nextKey]) {
      // 正主自己那条已经在了：判错主留下的是重复登记，同一个定时会被触发两次。
      dropped.push({ key, flowId, flowSource, userId: currentUserId, keptKey: nextKey });
      continue;
    }
    next[nextKey] = {
      ...entry,
      key: nextKey,
      userId: ownerUserId,
      username: String(authUsers?.[ownerUserId]?.username || ownerUserId),
    };
    repaired.push({ key, nextKey, flowId, flowSource, from: currentUserId, to: ownerUserId });
  }

  let backup = "";
  if ((repaired.length > 0 || dropped.length > 0) && !dryRun) {
    // 认错的判断只能靠磁盘上的图，万一认反了要有原件可回滚。带时间戳，不覆盖上一次。
    backup = path.join(
      dataRoot,
      "admin",
      "backups",
      `workspace-schedules.${WORKSPACE_SCHEDULE_OWNER_MIGRATION_ID}.${Date.now()}.json`,
    );
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.copyFileSync(schedulesPath, backup);
    writeJsonAtomic(schedulesPath, {
      version: 1,
      updatedAt: new Date().toISOString(),
      schedules: next,
    });
  }
  return { total: Object.keys(schedules).length, repaired, dropped, unresolved, skipped: false, ...(backup ? { backup } : {}) };
}

/**
 * 根据独立的存储结构版本执行一次启动迁移。重复启动幂等；同一个 dataRoot 下换了新的
 * workspaceRoot 时，只补迁这个新 Workspace，不会重扫已经完成的目标。
 */
export function runStartupStorageMigrations({
  workspaceRoot,
  dataRoot = getAgentflowDataRoot(),
  force = false,
} = {}) {
  const resolvedDataRoot = path.resolve(dataRoot);
  const resolvedWorkspaceRoot = path.resolve(workspaceRoot || process.cwd());
  const adminRoot = path.join(resolvedDataRoot, "admin");
  const statePath = path.join(adminRoot, STATE_FILENAME);
  const lockPath = path.join(adminRoot, LOCK_FILENAME);
  const releaseLock = acquireLock(lockPath);
  try {
    const state = readState(statePath);
    const migration = state.migrations[WORKSPACE_FLOW_DSL_MIGRATION_ID] || { targets: {} };
    const migrationVersion = Number(migration.version || 0);
    const targets = migration.targets && typeof migration.targets === "object" ? migration.targets : {};
    const definitions = [
      {
        key: `data:${resolvedDataRoot}`,
        kind: "data",
        root: resolvedDataRoot,
        pipelineRoots: dataPipelineRoots(resolvedDataRoot),
      },
      {
        key: `workspace:${resolvedWorkspaceRoot}`,
        kind: "workspace",
        root: resolvedWorkspaceRoot,
        pipelineRoots: workspacePipelineRoots(resolvedWorkspaceRoot),
      },
    ];
    const attempted = [];
    const skipped = [];
    for (const target of definitions) {
      if (!force && migrationVersion >= STORAGE_SCHEMA_VERSION && targets[target.key]?.completed === true) {
        skipped.push(target.key);
        continue;
      }
      const rows = migrateFlows(uniqueFlows(target.pipelineRoots), { marketplaceRoot: resolvedWorkspaceRoot });
      const summary = summarizeRows(rows);
      const record = {
        kind: target.kind,
        root: target.root,
        attemptedAt: new Date().toISOString(),
        completed: summary.failed.length === 0,
        summary,
        rows,
      };
      if (record.completed) record.completedAt = record.attemptedAt;
      targets[target.key] = record;
      attempted.push(record);
    }
    // 定时归属的修复跟着流程迁移一起跑：都要在 scheduler 起来之前落定，
    // 否则第一次轮询就会用判错的身份去跑别人的流程。
    const scheduleOwnerState = state.migrations[WORKSPACE_SCHEDULE_OWNER_MIGRATION_ID] || {};
    const scheduleOwnerDone = !force
      && Number(scheduleOwnerState.version || 0) >= STORAGE_SCHEMA_VERSION
      && scheduleOwnerState.completed === true;
    const scheduleOwners = scheduleOwnerDone
      ? { ...scheduleOwnerState, rerun: false }
      : {
        version: STORAGE_SCHEMA_VERSION,
        completed: true,
        attemptedAt: new Date().toISOString(),
        rerun: true,
        ...repairWorkspaceScheduleOwners(resolvedDataRoot),
      };
    const nextState = {
      ...state,
      schemaVersion: Math.max(Number(state.schemaVersion || 0), STORAGE_SCHEMA_VERSION),
      updatedAt: new Date().toISOString(),
      migrations: {
        ...state.migrations,
        [WORKSPACE_FLOW_DSL_MIGRATION_ID]: {
          version: STORAGE_SCHEMA_VERSION,
          targets,
        },
        [WORKSPACE_SCHEDULE_OWNER_MIGRATION_ID]: scheduleOwners,
      },
    };
    writeJsonAtomic(statePath, nextState);
    return {
      schemaVersion: nextState.schemaVersion,
      migrationId: WORKSPACE_FLOW_DSL_MIGRATION_ID,
      statePath,
      attempted,
      skipped,
      scheduleOwners,
    };
  } finally {
    releaseLock();
  }
}
