import fs from "fs";
import path from "path";
import { RUN_LOG_REL } from "./paths.mjs";
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
