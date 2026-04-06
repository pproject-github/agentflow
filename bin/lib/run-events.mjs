import fs from "fs";
import path from "path";
import { machineReadable } from "./log.mjs";
import { RUN_LOG_REL } from "./paths.mjs";
import { runNodeScript } from "./pipeline-scripts.mjs";
import { getRunDir } from "./workspace.mjs";

/**
 * 将 CLI 侧的关键信息也落盘到 run 目录的 logs/log.txt。
 */
export function appendRunLogLine(workspaceRoot, flowName, uuid, tag, message) {
  if (!workspaceRoot || !flowName || !uuid) return;
  try {
    const runDir = getRunDir(workspaceRoot, flowName, uuid);
    const logPath = path.join(runDir, RUN_LOG_REL);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const text = typeof message === "string" ? message : JSON.stringify(message);
    const line = `[${new Date().toISOString()}] [${tag}] ${text}\n`;
    fs.appendFileSync(logPath, line, "utf-8");
  } catch (_) {}
}

/** 发送 CLI 事件：写 run log，且 machineReadable 时向 stdout 输出一行 JSON */
export function emitEvent(workspaceRoot, flowName, uuid, payload) {
  appendRunLogLine(workspaceRoot, flowName, uuid, "cli", payload);
  if (machineReadable && workspaceRoot && flowName && uuid) {
    const line = JSON.stringify({ ...payload, ts: new Date().toISOString() }) + "\n";
    /* 同步写入，减少 pipe 缓冲导致 UI 长时间收不到首行 */
    try {
      fs.writeSync(1, Buffer.from(line, "utf8"));
    } catch {
      process.stdout.write(line);
    }
  }
}

/** 从 run 的 memory.md 读取 runStartTime */
export function readRunStartTime(workspaceRoot, flowName, uuid) {
  const memoryPath = path.join(getRunDir(workspaceRoot, flowName, uuid), "memory.md");
  if (!fs.existsSync(memoryPath)) return null;
  const content = fs.readFileSync(memoryPath, "utf-8");
  for (const line of (content || "").split(/\r?\n/)) {
    const idx = line.indexOf(": ");
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim();
    if (k !== "runStartTime") continue;
    const v = line.slice(idx + 2).trim();
    const n = parseInt(String(v), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

/** 从 run 的 memory.md 读取 totalExecutedMs */
export function readTotalExecutedMs(workspaceRoot, flowName, uuid) {
  const memoryPath = path.join(getRunDir(workspaceRoot, flowName, uuid), "memory.md");
  if (!fs.existsSync(memoryPath)) return 0;
  const content = fs.readFileSync(memoryPath, "utf-8");
  for (const line of (content || "").split(/\r?\n/)) {
    const idx = line.indexOf(": ");
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim();
    if (k !== "totalExecutedMs") continue;
    const v = line.slice(idx + 2).trim();
    const n = parseInt(String(v), 10);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }
  return 0;
}

export function saveTotalExecutedMs(workspaceRoot, flowName, uuid, totalExecutedMs) {
  runNodeScript(workspaceRoot, "save-key.mjs", [workspaceRoot, flowName, uuid, "totalExecutedMs", String(totalExecutedMs)], {
    captureStdout: true,
  });
}

export function ensureRunStartTime(workspaceRoot, flowName, uuid) {
  const existing = readRunStartTime(workspaceRoot, flowName, uuid);
  if (existing != null) return existing;
  const runStartTime = Date.now();
  runNodeScript(workspaceRoot, "save-key.mjs", [workspaceRoot, flowName, uuid, "runStartTime", String(runStartTime)], {
    captureStdout: true,
  });
  return runStartTime;
}
