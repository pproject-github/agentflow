#!/usr/bin/env node
/**
 * 向 run 目录下的 logs/log.txt 追加日志（单文件、追加模式），便于定位 get-ready-nodes、cache、result 等问题。
 * 用法（模块）：import { logToRunTag } from "./run-log.mjs";
 *   logToRunTag(workspaceRoot, flowName, uuid, tag, message)
 * 日志写入：.workspace/agentflow/runBuild/<flowName>/<uuid>/logs/log.txt，每行 [ISO8601] [tag] message
 */

import fs from "fs";
import path from "path";

const RUN_BASE_REL = ".workspace/agentflow/runBuild";
const LOG_FILE = "logs/log.txt";

/**
 * 向 run 目录下的 logs/log.txt 追加一行日志（单文件、追加模式）。
 * @param {string} workspaceRoot - 工作区根目录
 * @param {string} flowName - 流程名
 * @param {string} uuid - 本次 run 的 uuid
 * @param {string} tag - 来源标识：get-ready-nodes | check-cache | pre-process | post-process | result
 * @param {string|object} message - 文本或对象（对象会 JSON.stringify）
 */
export function logToRunTag(workspaceRoot, flowName, uuid, tag, message) {
  if (!workspaceRoot || !flowName || !uuid) return;
  const text = typeof message === "string" ? message : JSON.stringify(message);
  try {
    const runDir = path.join(path.resolve(workspaceRoot), RUN_BASE_REL, flowName, uuid);
    const logPath = path.join(runDir, LOG_FILE);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const line = `[${new Date().toISOString()}] [${tag}] ${text}\n`;
    fs.appendFileSync(logPath, line, "utf-8");
  } catch (_) {}
}
