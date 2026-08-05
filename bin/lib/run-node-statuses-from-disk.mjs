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

function readJenkinsState(runDir, instanceId) {
  const statePath = path.join(runDir, "state", `${instanceId}.jenkins.json`);
  if (!fs.existsSync(statePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function jenkinsUiStatus(executionStatus, state) {
  if (!state) return executionStatus;
  if (executionStatus === "pending" || state.phase === "queued" || state.phase === "running" || state.phase === "triggering") {
    return "waiting";
  }
  if (executionStatus === "success" && state.phase === "complete") {
    return String(state.status || "").toUpperCase() === "SUCCESS" ? "success" : "outcome_failed";
  }
  return executionStatus;
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
 * @returns {Record<string, { status: string, elapsed?: string, executionStatus?: string, phase?: string, jenkinsStatus?: string, message?: string, buildNumber?: string, url?: string, qrUrl?: string, startedAt?: string, wakeAt?: string }>}
 */
export function getRunNodeStatusesFromDisk(workspaceRoot, flowName, uuid, opts = {}) {
  const runDir = getRunDir(workspaceRoot, flowName, uuid, opts);
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
  const execIdMap = loadAllExecIds(workspaceRoot, flowName, uuid, order, opts);
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

    const jenkinsState = defId === "tool_jenkins_build" ? readJenkinsState(runDir, instanceId) : null;
    if (jenkinsState) uiStatus = jenkinsUiStatus(uiStatus, jenkinsState);

    /** @type {{ status: string, elapsed?: string, executionStatus?: string, phase?: string, jenkinsStatus?: string, message?: string, buildNumber?: string, url?: string, qrUrl?: string, startedAt?: string, wakeAt?: string }} */
    const row = { status: uiStatus };
    if (jenkinsState) {
      row.executionStatus = status;
      row.phase = String(jenkinsState.phase || "");
      row.jenkinsStatus = String(jenkinsState.status || "");
      row.message = String(jenkinsState.message || "");
      row.buildNumber = String(jenkinsState.buildNumber || "");
      row.url = String(jenkinsState.url || jenkinsState.buildUrl || "");
      row.qrUrl = String(jenkinsState.qrUrl || "");
      row.startedAt = String(jenkinsState.startedAt || "");
      row.wakeAt = String(jenkinsState.wakeAt || "");
      const started = Date.parse(jenkinsState.startedAt || "");
      const ended = Date.parse(jenkinsState.completedAt || "");
      if (Number.isFinite(started) && Number.isFinite(ended) && ended >= started) row.elapsed = formatDuration(ended - started);
    } else if (uiStatus === "success" && fs.existsSync(resultPath)) {
      const ms = parseElapsedMsLine(resultPath);
      if (ms != null && ms > 0) {
        row.elapsed = formatDuration(ms);
      }
    }
    out[instanceId] = row;
  }

  return out;
}
