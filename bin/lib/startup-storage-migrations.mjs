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
import {
  ARCHIVED_PIPELINES_DIR_NAME,
  LEGACY_PIPELINES_DIR,
  PIPELINES_DIR,
  getAgentflowDataRoot,
  isFlowDir,
} from "./paths.mjs";

export const STORAGE_SCHEMA_VERSION = 1;
export const WORKSPACE_FLOW_DSL_MIGRATION_ID = "workspace-flow-dsl-v1";

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
      },
    };
    writeJsonAtomic(statePath, nextState);
    return {
      schemaVersion: nextState.schemaVersion,
      migrationId: WORKSPACE_FLOW_DSL_MIGRATION_ID,
      statePath,
      attempted,
      skipped,
    };
  } finally {
    releaseLock();
  }
}
