/**
 * 从某次 run 的 intermediate 读取各节点最新 result 状态，供 UI 从历史进入时还原画布角标。
 */
import fs from "fs";
import path from "path";
import { getRunDir } from "./paths.mjs";
import { formatDuration } from "./terminal.mjs";
import { loadAllExecIds, latestResultExecId, intermediateResultBasename } from "../pipeline/get-exec-id.mjs";

function parseResultStatus(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const m = raw.match(/^\s*status:\s*["']?(\w+)["']?/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** @param {string} filePath @returns {number | null} */
function parseElapsedMsLine(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const m = raw.match(/^\s*elapsedMs:\s*(\d+)/m);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} workspaceRoot
 * @param {string} flowName
 * @param {string} uuid
 * @returns {Record<string, { status: string, elapsed?: string }>}
 */
export function getRunNodeStatusesFromDisk(workspaceRoot, flowName, uuid) {
  const runDir = getRunDir(workspaceRoot, flowName, uuid);
  const flowJsonPath = path.join(runDir, "intermediate", "flow.json");
  if (!fs.existsSync(flowJsonPath)) return {};

  let flow;
  try {
    flow = JSON.parse(fs.readFileSync(flowJsonPath, "utf-8"));
  } catch {
    return {};
  }
  if (!flow || !flow.ok) return {};

  const order = Array.isArray(flow.order) ? flow.order : [];
  const nodeDefinitions = flow.nodeDefinitions && typeof flow.nodeDefinitions === "object" ? flow.nodeDefinitions : {};
  const execIdMap = loadAllExecIds(workspaceRoot, flowName, uuid, order);
  const intermediateDir = path.join(runDir, "intermediate");
  /** @type {Record<string, { status: string, elapsed?: string }>} */
  const out = {};

  for (const instanceId of order) {
    const defId = nodeDefinitions[instanceId] || "";
    const execId = execIdMap[instanceId] ?? 1;
    const latestE = latestResultExecId(execId);
    const resultPath = path.join(intermediateDir, instanceId, intermediateResultBasename(instanceId, latestE));
    let status = fs.existsSync(resultPath) ? parseResultStatus(resultPath) : null;
    if (!status && defId.startsWith("provide_")) status = "success";
    if (!status && defId === "control_start") status = "success";
    if (!status) continue;

    let uiStatus = status;
    const low = String(status).toLowerCase();
    if (low === "completed" || low === "done") uiStatus = "success";

    /** @type {{ status: string, elapsed?: string }} */
    const row = { status: uiStatus };
    if (uiStatus === "success" && fs.existsSync(resultPath)) {
      const ms = parseElapsedMsLine(resultPath);
      if (ms != null && ms > 0) {
        row.elapsed = formatDuration(ms);
      }
    }
    out[instanceId] = row;
  }

  return out;
}
