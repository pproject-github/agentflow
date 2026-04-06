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
} from "./paths.mjs";

export { getRunDir } from "./paths.mjs";

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
function getRunBuildRoots(workspaceRoot) {
  const roots = [getWorkspaceRunBuildRoot(workspaceRoot), getLegacyUserRunBuildRoot()];
  const out = [];
  const seen = new Set();
  for (const dir of roots) {
    const resolved = path.resolve(dir);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

/** 列出所有存在 logs/log.txt 的 run，供 extract-thinking -list 使用。 */
export function listRunsWithLogs(workspaceRoot) {
  const list = [];
  const seenRuns = new Set();
  for (const runBuildDir of getRunBuildRoots(workspaceRoot)) {
    if (!fs.existsSync(runBuildDir) || !fs.statSync(runBuildDir).isDirectory()) continue;
    const flowNames = fs.readdirSync(runBuildDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    for (const flowName of flowNames) {
      const flowDir = path.join(runBuildDir, flowName);
      let uuids;
      try {
        uuids = fs.readdirSync(flowDir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch (_) {
        continue;
      }
      for (const uuid of uuids) {
        const runKey = `${flowName}\t${uuid}`;
        if (seenRuns.has(runKey)) continue;
        const logPath = path.join(flowDir, uuid, "logs", "log.txt");
        if (fs.existsSync(logPath)) {
          let size = 0;
          let lines = 0;
          try {
            const stat = fs.statSync(logPath);
            size = stat.size;
            const c = fs.readFileSync(logPath, "utf8");
            lines = c.split(/\r?\n/).length;
          } catch (_) {}
          list.push({ flowName, uuid, logPath, size, lines });
          seenRuns.add(runKey);
        }
      }
    }
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
  const userFlowDir = path.join(getUserPipelinesRoot(), flowName);
  if (fs.existsSync(userFlowDir) && fs.existsSync(path.join(userFlowDir, "flow.yaml"))) return userFlowDir;
  const wsFlowDir = path.join(root, PIPELINES_DIR, flowName);
  if (fs.existsSync(wsFlowDir) && fs.existsSync(path.join(wsFlowDir, "flow.yaml"))) return wsFlowDir;
  const legacyFlowDir = path.join(root, LEGACY_PIPELINES_DIR, flowName);
  if (fs.existsSync(legacyFlowDir) && fs.existsSync(path.join(legacyFlowDir, "flow.yaml"))) return legacyFlowDir;
  const builtinFlowDir = path.join(PACKAGE_BUILTIN_PIPELINES_DIR, flowName);
  if (fs.existsSync(builtinFlowDir) && fs.existsSync(path.join(builtinFlowDir, "flow.yaml"))) return builtinFlowDir;
  return null;
}

/** 两参 replay 时根据 uuid 查找 run 目录，返回 flowName 或 null。 */
export function findFlowNameByUuid(workspaceRoot, uuid) {
  for (const runBuildDir of getRunBuildRoots(workspaceRoot)) {
    if (!fs.existsSync(runBuildDir) || !fs.statSync(runBuildDir).isDirectory()) continue;
    const flowNames = fs.readdirSync(runBuildDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
    for (const fn of flowNames) {
      const flowJsonPath = path.join(runBuildDir, fn, uuid, "intermediate", "flow.json");
      if (fs.existsSync(flowJsonPath)) return fn;
    }
  }
  return null;
}
