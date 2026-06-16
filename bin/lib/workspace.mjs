import fs from "fs";
import path from "path";
import {
  LEGACY_PIPELINES_DIR,
  PACKAGE_BUILTIN_PIPELINES_DIR,
  PACKAGE_REFERENCE_DIR,
  PIPELINES_DIR,
  getLegacyUserRunBuildRoot,
  getReferenceRootAbs,
  getWorkspaceRunBuildRoot,
  getUserPipelinesRoot,
  ARCHIVED_PIPELINES_DIR_NAME,
} from "./paths.mjs";

export { getRunDir } from "./paths.mjs";

/**
 * 枚举所有 run 目录（新 per-flow 位置 + 旧 runBuild root 位置）。
 * 返回扁平列表：{ flowName, uuid, runDir, source }，source ∈ { user, workspace, legacyWorkspaceRoot, legacyUserRoot }
 * - user: ~/agentflow/pipelines/<name>/runBuild/<uuid>
 * - workspace: <ws>/.workspace/agentflow/pipelines/<name>/runBuild/<uuid>
 * - legacyWorkspaceRoot: <ws>/.workspace/agentflow/runBuild/<name>/<uuid>
 * - legacyUserRoot: ~/agentflow/runBuild/<name>/<uuid>
 * 后两者仅作为向下兼容读取；新写入只走 user/workspace。
 */
export function listAllRunDirs(workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  const out = [];
  const seen = new Set();
  const add = (flowName, uuid, runDir, source) => {
    const key = `${flowName}\t${uuid}`;
    if (seen.has(key)) return;
    if (!fs.existsSync(runDir)) return;
    seen.add(key);
    out.push({ flowName, uuid, runDir, source });
  };

  const scanPipelinesDir = (pipelinesDir, source) => {
    if (!fs.existsSync(pipelinesDir)) return;
    let entries;
    try {
      entries = fs.readdirSync(pipelinesDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === ARCHIVED_PIPELINES_DIR_NAME) continue;
      const runBuildDir = path.join(pipelinesDir, e.name, "runBuild");
      if (!fs.existsSync(runBuildDir)) continue;
      let uuids;
      try {
        uuids = fs.readdirSync(runBuildDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const u of uuids) {
        if (!u.isDirectory()) continue;
        add(e.name, u.name, path.join(runBuildDir, u.name), source);
      }
    }
  };

  // 新位置（优先）
  scanPipelinesDir(getUserPipelinesRoot(), "user");
  scanPipelinesDir(path.join(root, PIPELINES_DIR), "workspace");

  // 旧位置（兼容读）
  const scanLegacyRoot = (runBuildDir, source) => {
    if (!fs.existsSync(runBuildDir)) return;
    let flowEntries;
    try {
      flowEntries = fs.readdirSync(runBuildDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const fe of flowEntries) {
      if (!fe.isDirectory()) continue;
      const flowRunDir = path.join(runBuildDir, fe.name);
      let uuids;
      try {
        uuids = fs.readdirSync(flowRunDir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const u of uuids) {
        if (!u.isDirectory()) continue;
        add(fe.name, u.name, path.join(flowRunDir, u.name), source);
      }
    }
  };
  scanLegacyRoot(getWorkspaceRunBuildRoot(root), "legacyWorkspaceRoot");
  scanLegacyRoot(getLegacyUserRunBuildRoot(), "legacyUserRoot");

  return out;
}

/**
 * 确保用户数据目录下 reference 存在且含包内 reference 文件。
 */
export function ensureReference(_workspaceRoot) {
  const destDir = getReferenceRootAbs();
  if (!fs.existsSync(PACKAGE_REFERENCE_DIR) || !fs.statSync(PACKAGE_REFERENCE_DIR).isDirectory()) return;
  try {
    fs.mkdirSync(destDir, { recursive: true });
    const names = fs.readdirSync(PACKAGE_REFERENCE_DIR);
    for (const name of names) {
      const srcFile = path.join(PACKAGE_REFERENCE_DIR, name);
      if (fs.statSync(srcFile).isFile()) {
        const destFile = path.join(destDir, name);
        if (!fs.existsSync(destFile)) fs.copyFileSync(srcFile, destFile);
      }
    }
  } catch (_) {}
}

/** 列出所有存在 logs/log.txt 的 run，供 extract-thinking -list 使用。 */
export function listRunsWithLogs(workspaceRoot) {
  const list = [];
  for (const { flowName, uuid, runDir } of listAllRunDirs(workspaceRoot)) {
    const logPath = path.join(runDir, "logs", "log.txt");
    if (!fs.existsSync(logPath)) continue;
    let size = 0;
    let lines = 0;
    try {
      const stat = fs.statSync(logPath);
      size = stat.size;
      const c = fs.readFileSync(logPath, "utf8");
      lines = c.split(/\r?\n/).length;
    } catch (_) {}
    list.push({ flowName, uuid, logPath, size, lines });
  }
  list.sort((a, b) => {
    const fc = a.flowName.localeCompare(b.flowName);
    if (fc !== 0) return fc;
    return a.uuid.localeCompare(b.uuid);
  });
  return list;
}

/** 解析 flow 目录：~/agentflow/pipelines → .workspace/agentflow/pipelines → .cursor/agentflow/pipelines（旧）→ builtin/pipelines */
export function getFlowDir(workspaceRoot, flowName) {
  const root = path.resolve(workspaceRoot);
  const hasFlow = (dir) => fs.existsSync(dir) && fs.existsSync(path.join(dir, "flow.yaml"));

  // user pipelines
  const userRoot = getUserPipelinesRoot();
  const userFlowDir = path.join(userRoot, flowName);
  if (hasFlow(userFlowDir)) return userFlowDir;
  // user archived
  const userArchivedDir = path.join(userRoot, ARCHIVED_PIPELINES_DIR_NAME, flowName);
  if (hasFlow(userArchivedDir)) return userArchivedDir;

  // workspace pipelines
  const wsFlowDir = path.join(root, PIPELINES_DIR, flowName);
  if (hasFlow(wsFlowDir)) return wsFlowDir;
  // workspace archived
  const wsArchivedDir = path.join(root, PIPELINES_DIR, ARCHIVED_PIPELINES_DIR_NAME, flowName);
  if (hasFlow(wsArchivedDir)) return wsArchivedDir;

  // legacy
  const legacyFlowDir = path.join(root, LEGACY_PIPELINES_DIR, flowName);
  if (hasFlow(legacyFlowDir)) return legacyFlowDir;

  // builtin
  const builtinFlowDir = path.join(PACKAGE_BUILTIN_PIPELINES_DIR, flowName);
  if (hasFlow(builtinFlowDir)) return builtinFlowDir;

  return null;
}

/** 两参 replay 时根据 uuid 查找 run 目录，返回 flowName 或 null。 */
export function findFlowNameByUuid(workspaceRoot, uuid) {
  for (const entry of listAllRunDirs(workspaceRoot)) {
    if (entry.uuid !== uuid) continue;
    const flowJsonPath = path.join(entry.runDir, "intermediate", "flow.json");
    if (fs.existsSync(flowJsonPath)) return entry.flowName;
  }
  return null;
}
