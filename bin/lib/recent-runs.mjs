/**
 * 扫描 runBuild 目录，供 UI 展示「最近运行」。
 */
import fs from "fs";
import path from "path";
import { getLegacyUserRunBuildRoot, getWorkspaceRunBuildRoot } from "./paths.mjs";
import { isApplyProcessAlive } from "./run-apply-active-lock.mjs";

/** Web UI 调用 /api/flow/run/stop 时写入，用于与「未跑完但未标记」区分 */
export const RUN_INTERRUPTED_FILENAME = "run-interrupted.json";

/** @param {string} filePath */
function parseResultStatusFromFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const m = raw.match(/^\s*status:\s*["']?(\w+)["']?/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * 根据 intermediate 下各节点 result 与 control_end 推断单次运行状态。
 * @returns {'success'|'failed'|'running'|'stopped'|'interrupted'|'unknown'}
 */
function inferRunStatusFromRunDir(runDir) {
  const interruptedPath = path.join(runDir, RUN_INTERRUPTED_FILENAME);
  if (fs.existsSync(interruptedPath)) return "stopped";

  const interRoot = path.join(runDir, "intermediate");
  if (!fs.existsSync(interRoot) || !fs.statSync(interRoot).isDirectory()) return "unknown";

  let anyFailed = false;
  let anyResult = false;
  try {
    const dirs = fs.readdirSync(interRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
    for (const d of dirs) {
      const instanceId = d.name;
      const rp = path.join(interRoot, instanceId, `${instanceId}.result.md`);
      if (!fs.existsSync(rp)) continue;
      anyResult = true;
      const st = parseResultStatusFromFile(rp);
      if (st === "failed") anyFailed = true;
    }
  } catch {
    return "unknown";
  }

  if (anyFailed) return "failed";

  const flowJsonPath = path.join(interRoot, "flow.json");
  let endId = null;
  if (fs.existsSync(flowJsonPath)) {
    try {
      const flow = JSON.parse(fs.readFileSync(flowJsonPath, "utf-8"));
      const nd = flow.nodeDefinitions || {};
      for (const [iid, def] of Object.entries(nd)) {
        if (def === "control_end") {
          endId = iid;
          break;
        }
      }
    } catch {
      /* ignore */
    }
  }

  if (endId) {
    const endPath = path.join(interRoot, endId, `${endId}.result.md`);
    const endSt = parseResultStatusFromFile(endPath);
    if (endSt === "success") return "success";
  }

  if (anyResult || fs.existsSync(flowJsonPath)) {
    if (isApplyProcessAlive(runDir)) return "running";
    return "interrupted";
  }
  return "unknown";
}

function readKeyFromMemory(runDir, key) {
  const memoryPath = path.join(runDir, "memory.md");
  if (!fs.existsSync(memoryPath)) return null;
  try {
    const content = fs.readFileSync(memoryPath, "utf-8");
    for (const line of (content || "").split(/\r?\n/)) {
      const idx = line.indexOf(": ");
      if (idx <= 0) continue;
      const k = line.slice(0, idx).trim();
      if (k !== key) continue;
      const v = line.slice(idx + 2).trim();
      const n = parseInt(String(v), 10);
      return Number.isFinite(n) && n >= 0 ? n : null;
    }
  } catch {
    return null;
  }
  return null;
}

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

/**
 * @param {string} workspaceRoot
 * @returns {Array<{ flowId: string, runId: string, at: number, durationMs: number, status: 'success'|'failed'|'running'|'stopped'|'interrupted'|'unknown' }>}
 */
export function listRecentRunsFromDisk(workspaceRoot) {
  const out = [];
  const seenRuns = new Set();
  for (const runBuildDir of getRunBuildRoots(workspaceRoot)) {
    if (!fs.existsSync(runBuildDir) || !fs.statSync(runBuildDir).isDirectory()) continue;
    const flowNames = fs.readdirSync(runBuildDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);

    for (const flowId of flowNames) {
      const flowDir = path.join(runBuildDir, flowId);
      let uuids;
      try {
        uuids = fs.readdirSync(flowDir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch {
        continue;
      }
      for (const uuid of uuids) {
        const runKey = `${flowId}\t${uuid}`;
        if (seenRuns.has(runKey)) continue;
        const runDir = path.join(flowDir, uuid);
        let at = readKeyFromMemory(runDir, "runStartTime");
        if (at == null) {
          try {
            at = fs.statSync(runDir).mtimeMs;
          } catch {
            continue;
          }
        }
        const durationMs = readKeyFromMemory(runDir, "totalExecutedMs") ?? 0;
        const status = inferRunStatusFromRunDir(runDir);
        out.push({ flowId, runId: uuid, at, durationMs, status });
        seenRuns.add(runKey);
      }
    }
  }

  out.sort((a, b) => b.at - a.at);
  return out;
}
