/**
 * Composer AI 对话日志记录模块。
 * 
 * 将 UI 上 AI 对话生成 flow 的过程持久化到磁盘，便于调试。
 * 
 * 日志位置：<workspaceRoot>/.workspace/agentflow/composer-logs/<YYYY-MM>/<YYYY-MM-DD_HHMMSS_<short-uuid>.log>
 * 格式：[ISO8601] [tag] JSON event or message
 */

import fs from "fs";
import path from "path";

const COMPOSER_LOGS_DIR = "composer-logs";

function getComposerLogsRoot(workspaceRoot) {
  const root = workspaceRoot && String(workspaceRoot).trim() !== ""
    ? path.resolve(String(workspaceRoot))
    : process.cwd();
  return path.join(root, ".workspace/agentflow", COMPOSER_LOGS_DIR);
}

function generateShortUuid() {
  return Math.random().toString(36).slice(2, 8);
}

function formatTimestampForFilename() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  const dd = String(now.getDate()).padStart(2, "0");
  const hh = String(now.getHours()).padStart(2, "0");
  const min = String(now.getMinutes()).padStart(2, "0");
  const ss = String(now.getSeconds()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}_${hh}${min}${ss}`;
}

function getMonthDir() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, "0");
  return `${yyyy}-${mm}`;
}

/**
 * 创建新的 Composer 对话日志会话。
 * @param {string} workspaceRoot 工作区根目录
 * @returns {{ sessionId: string, logPath: string, monthDir: string }}
 */
export function createComposerSession(workspaceRoot) {
  const logsRoot = getComposerLogsRoot(workspaceRoot);
  const monthDir = getMonthDir();
  const monthPath = path.join(logsRoot, monthDir);
  
  fs.mkdirSync(monthPath, { recursive: true });
  
  const ts = formatTimestampForFilename();
  const shortUuid = generateShortUuid();
  const sessionId = `${ts}_${shortUuid}`;
  const logPath = path.join(monthPath, `${sessionId}.log`);
  
  return { sessionId, logPath, monthDir };
}

/**
 * 向 Composer 日志文件追加一行事件。
 * @param {string} logPath 日志文件绝对路径
 * @param {string} tag 事件标签：composer-start | classify | plan | step-start | step-progress | step-done | validation | phase-plan | phase-complete | phase-auto-continue | natural | error | composer-done
 * @param {object|string} payload 事件内容（对象会 JSON.stringify）
 */
export function logComposerEvent(logPath, tag, payload) {
  if (!logPath) return;
  try {
    const ts = new Date().toISOString();
    const text = typeof payload === "string" ? payload : JSON.stringify(payload);
    const line = `[${ts}] [${tag}] ${text}\n`;
    fs.appendFileSync(logPath, line, "utf-8");
  } catch (e) {
    process.stderr.write(`[composer-log] 写入失败: ${e.message}\n`);
  }
}

/**
 * 截断文本以便日志记录（避免日志文件过大）。
 * @param {string} text 原始文本
 * @param {number} maxLen 最大长度（默认 2000）
 * @returns {string}
 */
export function truncateForLog(text, maxLen = 2000) {
  if (!text || typeof text !== "string") return "";
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + "…(截断)";
}

/**
 * 获取 Composer 日志目录路径（供外部查询）。
 * @param {string} workspaceRoot 工作区根目录
 * @returns {string}
 */
export function getComposerLogsDir(workspaceRoot) {
  return getComposerLogsRoot(workspaceRoot);
}

/**
 * 列出最近的 Composer 日志会话。
 * @param {string} workspaceRoot 工作区根目录
 * @param {number} limit 最大数量（默认 20）
 * @returns {Array<{ sessionId: string, logPath: string, monthDir: string, size: number, mtime: Date }>}
 */
export function listRecentComposerSessions(workspaceRoot, limit = 20) {
  const logsRoot = getComposerLogsRoot(workspaceRoot);
  if (!fs.existsSync(logsRoot)) return [];
  
  const sessions = [];
  const monthDirs = fs.readdirSync(logsRoot).filter((d) => /^\d{4}-\d{2}$/.test(d));
  
  for (const monthDir of monthDirs) {
    const monthPath = path.join(logsRoot, monthDir);
    if (!fs.statSync(monthPath).isDirectory()) continue;
    
    const files = fs.readdirSync(monthPath).filter((f) => f.endsWith(".log"));
    for (const file of files) {
      const logPath = path.join(monthPath, file);
      const stat = fs.statSync(logPath);
      sessions.push({
        sessionId: file.replace(".log", ""),
        logPath,
        monthDir,
        size: stat.size,
        mtime: stat.mtime,
      });
    }
  }
  
  sessions.sort((a, b) => b.mtime - a.mtime);
  return sessions.slice(0, limit);
}

/**
 * 解析日志文件为事件数组。每行格式：[ISO8601] [tag] {json} 或 string。
 * 多行字段（含换行的 prompt/response）通过 JSON 序列化保留为 \n，所以每行始终是单条事件。
 * @param {string} logPath
 * @returns {Array<{ ts: string, tag: string, payload: any }>}
 */
export function parseComposerLogFile(logPath) {
  if (!logPath || !fs.existsSync(logPath)) return [];
  const raw = fs.readFileSync(logPath, "utf-8");
  const events = [];
  const lines = raw.split("\n");
  for (const line of lines) {
    if (!line) continue;
    const m = line.match(/^\[([^\]]+)\]\s+\[([^\]]+)\]\s+(.*)$/);
    if (!m) continue;
    const ts = m[1];
    const tag = m[2];
    const rest = m[3];
    let payload;
    try {
      payload = JSON.parse(rest);
    } catch {
      payload = rest;
    }
    events.push({ ts, tag, payload });
  }
  return events;
}

/**
 * 从日志文件首行尝试提取 composer-start 中的元数据（flowId, model, prompt 等）。
 * @param {string} logPath
 * @returns {{ flowId: string|null, flowSource: string|null, model: string|null, prompt: string|null, sessionId: string|null }}
 */
export function readComposerSessionMeta(logPath) {
  const empty = { flowId: null, flowSource: null, model: null, prompt: null, sessionId: null };
  try {
    if (!fs.existsSync(logPath)) return empty;
    const raw = fs.readFileSync(logPath, "utf-8");
    const lines = raw.split("\n");
    for (const line of lines) {
      const m = line.match(/^\[([^\]]+)\]\s+\[composer-start\]\s+(.*)$/);
      if (m) {
        try {
          const obj = JSON.parse(m[2]);
          return {
            flowId: obj.flowId || null,
            flowSource: obj.flowSource || null,
            model: obj.model || null,
            prompt: obj.prompt || null,
            sessionId: obj.sessionId || null,
          };
        } catch {
          return empty;
        }
      }
    }
  } catch { /* ignore */ }
  return empty;
}