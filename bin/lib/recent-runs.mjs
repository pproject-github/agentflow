/**
 * 扫描 runBuild 目录，供 UI 展示「最近运行」。
 */
import fs from "fs";
import path from "path";
import { listAllRunDirs } from "./workspace.mjs";
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

/** 读取 result.md 里的 finishedAt（ISO 字符串），返回 ms 时间戳或 null */
function parseResultFinishedAtFromFile(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const m = raw.match(/^\s*finishedAt:\s*["']?([^"'\n]+?)["']?\s*$/m);
    if (!m) return null;
    const t = Date.parse(m[1]);
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

/** 扫 run 目录所有 result.md，返回最大的 finishedAt。回退到 runDir mtime */
function computeEndedAt(runDir) {
  const interRoot = path.join(runDir, "intermediate");
  let maxAt = 0;
  if (fs.existsSync(interRoot) && fs.statSync(interRoot).isDirectory()) {
    try {
      const dirs = fs.readdirSync(interRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
      for (const d of dirs) {
        const rp = path.join(interRoot, d.name, `${d.name}.result.md`);
        if (!fs.existsSync(rp)) continue;
        const t = parseResultFinishedAtFromFile(rp);
        if (t != null && t > maxAt) maxAt = t;
      }
    } catch {
      /* ignore */
    }
  }
  if (maxAt > 0) return maxAt;
  try {
    return fs.statSync(runDir).mtimeMs;
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

/** listAllRunDirs 的 source 映射到 UI 里的 flowSource 字段 */
function mapFlowSource(src) {
  if (src === "user") return "user";
  if (src === "workspace") return "workspace";
  // legacy 位置仍归到它物理所在的 scope
  if (src === "legacyWorkspaceRoot") return "workspace";
  if (src === "legacyUserRoot") return "user";
  return "workspace";
}

/**
 * @param {string} workspaceRoot
 * @returns {Array<{ flowId: string, flowSource: 'workspace'|'user', runId: string, at: number, durationMs: number, endedAt: number|null, status: 'success'|'failed'|'running'|'stopped'|'interrupted'|'unknown' }>}
 */
export function listRecentRunsFromDisk(workspaceRoot) {
  const out = [];
  for (const { flowName, uuid, runDir, source } of listAllRunDirs(workspaceRoot)) {
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
    const endedAt = status === "running" ? null : computeEndedAt(runDir);
    out.push({ flowId: flowName, flowSource: mapFlowSource(source), runId: uuid, at, durationMs, endedAt, status });
  }

  out.sort((a, b) => b.at - a.at);
  return out;
}
