/**
 * 获取工作区目录树结构，用于 UI 工作区面板展开显示
 */
import fs from "fs";
import path from "path";
import {
  PIPELINES_DIR,
  LEGACY_PIPELINES_DIR,
  ARCHIVED_PIPELINES_DIR_NAME,
  getWorkspaceRunBuildRoot,
  getLegacyUserRunBuildRoot,
  getUserPipelinesRoot,
  PACKAGE_BUILTIN_PIPELINES_DIR,
} from "./paths.mjs";

/**
 * 获取目录下的子目录列表
 * @param {string} dir
 * @returns {Array<{name: string, path: string}>}
 */
function getSubdirectories(dir) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return [];
  }
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => ({ name: e.name, path: path.join(dir, e.name) }));
  } catch {
    return [];
  }
}

/**
 * 获取工作区树形结构
 * @param {string} workspaceRoot
 * @returns {{
 *   pipelines: Array<{id: string, source: 'workspace', archived?: boolean}>,
 *   runs: Array<{flowId: string, runs: Array<{runId: string, at: number}>}>
 * }}
 */
export function getWorkspaceTree(workspaceRoot) {
  const root = path.resolve(workspaceRoot);

  // 1. 获取 pipelines 列表
  const pipelines = [];
  const seenPipelineIds = new Set();

  // 主路径: .workspace/agentflow/pipelines
  const wsPipelinesDir = path.join(root, PIPELINES_DIR);
  const wsPipelines = getSubdirectories(wsPipelinesDir).filter(
    (d) => d.name !== ARCHIVED_PIPELINES_DIR_NAME
  );
  for (const p of wsPipelines) {
    if (!seenPipelineIds.has(p.name)) {
      seenPipelineIds.add(p.name);
      pipelines.push({ id: p.name, source: "workspace" });
    }
  }

  // 归档路径: .workspace/agentflow/pipelines/_archived
  const wsArchivedDir = path.join(wsPipelinesDir, ARCHIVED_PIPELINES_DIR_NAME);
  const wsArchived = getSubdirectories(wsArchivedDir);
  for (const p of wsArchived) {
    if (!seenPipelineIds.has(p.name)) {
      seenPipelineIds.add(p.name);
      pipelines.push({ id: p.name, source: "workspace", archived: true });
    }
  }

  // 旧版路径: .cursor/agentflow/pipelines (兼容读取)
  const legacyPipelinesDir = path.join(root, LEGACY_PIPELINES_DIR);
  const legacyPipelines = getSubdirectories(legacyPipelinesDir).filter(
    (d) => d.name !== ARCHIVED_PIPELINES_DIR_NAME
  );
  for (const p of legacyPipelines) {
    if (!seenPipelineIds.has(p.name)) {
      seenPipelineIds.add(p.name);
      pipelines.push({ id: p.name, source: "workspace" });
    }
  }

  // 旧版归档路径
  const legacyArchivedDir = path.join(legacyPipelinesDir, ARCHIVED_PIPELINES_DIR_NAME);
  const legacyArchived = getSubdirectories(legacyArchivedDir);
  for (const p of legacyArchived) {
    if (!seenPipelineIds.has(p.name)) {
      seenPipelineIds.add(p.name);
      pipelines.push({ id: p.name, source: "workspace", archived: true });
    }
  }

  // 2. 获取 runs 列表 (按 flowId 分组)
  const runsMap = new Map();
  const seenRuns = new Set();

  const runBuildRoots = [
    getWorkspaceRunBuildRoot(root),
    getLegacyUserRunBuildRoot(),
  ];
  const seenRoots = new Set();

  for (const runBuildDir of runBuildRoots) {
    const resolved = path.resolve(runBuildDir);
    if (seenRoots.has(resolved)) continue;
    seenRoots.add(resolved);

    const flowDirs = getSubdirectories(runBuildDir);
    for (const flowDir of flowDirs) {
      const flowId = flowDir.name;
      const runUuids = getSubdirectories(flowDir.path);

      for (const runDir of runUuids) {
        const runKey = `${flowId}\t${runDir.name}`;
        if (seenRuns.has(runKey)) continue;
        seenRuns.add(runKey);

        // 获取运行时间
        let at = 0;
        try {
          const memoryPath = path.join(runDir.path, "memory.md");
          if (fs.existsSync(memoryPath)) {
            const content = fs.readFileSync(memoryPath, "utf-8");
            for (const line of content.split(/\r?\n/)) {
              const idx = line.indexOf(": ");
              if (idx > 0 && line.slice(0, idx).trim() === "runStartTime") {
                const v = line.slice(idx + 2).trim();
                const n = parseInt(v, 10);
                if (Number.isFinite(n) && n >= 0) {
                  at = n;
                  break;
                }
              }
            }
          }
          if (at === 0) {
            at = fs.statSync(runDir.path).mtimeMs;
          }
        } catch {
          try {
            at = fs.statSync(runDir.path).mtimeMs;
          } catch {
            at = 0;
          }
        }

        if (!runsMap.has(flowId)) {
          runsMap.set(flowId, []);
        }
        runsMap.get(flowId).push({ runId: runDir.name, at });
      }
    }
  }

  // 转换 runsMap 为数组，并排序
  const runs = [];
  for (const [flowId, flowRuns] of runsMap) {
    flowRuns.sort((a, b) => b.at - a.at); // 最新的在前
    runs.push({ flowId, runs: flowRuns.slice(0, 10) }); // 每个 flow 最多显示 10 个
  }
  runs.sort((a, b) => {
    const aLatest = a.runs[0]?.at || 0;
    const bLatest = b.runs[0]?.at || 0;
    return bLatest - aLatest; // 按最新运行时间排序
  });

  return { pipelines, runs };
}

const FILE_ICON_MAP = {
  ".yaml": "description",
  ".yml": "description",
  ".mjs": "code",
  ".js": "code",
  ".ts": "code",
  ".json": "data_object",
  ".md": "article",
  ".txt": "note",
};

function getFileIcon(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  return FILE_ICON_MAP[ext] || "draft";
}

function getDirectoryIcon(dirName) {
  if (dirName === "scripts") return "terminal";
  if (dirName === "nodes") return "hub";
  return "folder";
}

function readFileSize(filePath) {
  try {
    const stats = fs.statSync(filePath);
    return stats.size;
  } catch {
    return 0;
  }
}

function readFilesRecursive(dir, baseDir, maxDepth = 2, currentDepth = 0) {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    return [];
  }
  if (currentDepth >= maxDepth) {
    return [];
  }
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const entryPath = path.join(dir, entry.name);
      const relativePath = path.relative(baseDir, entryPath);
      if (entry.isDirectory()) {
        const children = readFilesRecursive(entryPath, baseDir, maxDepth, currentDepth + 1);
        result.push({
          name: entry.name,
          type: "directory",
          icon: getDirectoryIcon(entry.name),
          path: relativePath,
          children,
        });
      } else if (entry.isFile()) {
        result.push({
          name: entry.name,
          type: "file",
          icon: getFileIcon(entry.name),
          path: relativePath,
          size: readFileSize(entryPath),
        });
      }
    }
    result.sort((a, b) => {
      if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
      if (a.name === "flow.yaml") return -1;
      if (b.name === "flow.yaml") return 1;
      if (a.name === "scripts") return -1;
      if (b.name === "scripts") return 1;
      return a.name.localeCompare(b.name);
    });
    return result;
  } catch {
    return [];
  }
}

export function getPipelineFiles(workspaceRoot, flowId, flowSource, archived = false) {
  const root = path.resolve(workspaceRoot);
  let pipelineDir = null;

  if (archived) {
    if (flowSource === "user") {
      pipelineDir = path.join(getUserPipelinesRoot(), ARCHIVED_PIPELINES_DIR_NAME, flowId);
    } else if (flowSource === "workspace") {
      pipelineDir = path.join(root, PIPELINES_DIR, ARCHIVED_PIPELINES_DIR_NAME, flowId);
      if (!fs.existsSync(pipelineDir)) {
        const alt = path.join(root, LEGACY_PIPELINES_DIR, ARCHIVED_PIPELINES_DIR_NAME, flowId);
        if (fs.existsSync(alt)) pipelineDir = alt;
      }
    }
  } else {
    if (flowSource === "builtin") {
      pipelineDir = path.join(PACKAGE_BUILTIN_PIPELINES_DIR, flowId);
    } else if (flowSource === "user") {
      pipelineDir = path.join(getUserPipelinesRoot(), flowId);
      if (!fs.existsSync(pipelineDir)) {
        const alt = path.join(root, PIPELINES_DIR, flowId);
        if (fs.existsSync(alt)) pipelineDir = alt;
      }
      if (!fs.existsSync(pipelineDir)) {
        const altLeg = path.join(root, LEGACY_PIPELINES_DIR, flowId);
        if (fs.existsSync(altLeg)) pipelineDir = altLeg;
      }
    } else if (flowSource === "workspace") {
      pipelineDir = path.join(root, PIPELINES_DIR, flowId);
      if (!fs.existsSync(pipelineDir)) {
        const altLeg = path.join(root, LEGACY_PIPELINES_DIR, flowId);
        if (fs.existsSync(altLeg)) pipelineDir = altLeg;
      }
    }
  }

  if (!pipelineDir || !fs.existsSync(pipelineDir) || !fs.statSync(pipelineDir).isDirectory()) {
    return { files: [], error: "Pipeline directory not found" };
  }

  const files = readFilesRecursive(pipelineDir, pipelineDir, 2, 0);
  return { files, path: pipelineDir };
}
