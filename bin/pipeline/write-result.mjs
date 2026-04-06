#!/usr/bin/env node
/**
 * 统一写入/更新 intermediate/<instanceId>.result.md，保证 frontmatter 格式一致。
 * 供前处理（写入 running）、执行后规范化、后处理（覆写 status/branch 等）共同使用。
 *
 * 用法（CLI）：
 *   node write-result.mjs <workspaceRoot> <flowName> <uuid> <instanceId> --json '<JSON>'
 * JSON 字段：status（必）, message（必）, finishedAt?, outputPath?, branch?, elapsedMs?, body?（cacheMd5/cacheInputInfo 仅存 .cache.json，不写入 result）
 * 若传入 body 则使用；否则若文件已存在且未传 body，则保留原正文（preserveBody）。
 *
 * 用法（模块）：
 *   import { writeResult } from "./write-result.mjs";
 *   writeResult(workspaceRoot, flowName, uuid, instanceId, fields, options?)
 * fields: { status, message, finishedAt?, outputPath?, branch?, cacheNotMetReason?, elapsedMs? }
 * options: { preserveBody?: boolean, body?: string, execId?: number }
 */

import fs from "fs";
import path from "path";

import { backupIntermediateFileIfExists } from "./backup-intermediate-file.mjs";
import { getRunDir } from "../lib/paths.mjs";
import { loadExecId } from "./get-exec-id.mjs";
import { intermediateResultBasename, intermediateDirForNode } from "./get-exec-id.mjs";
import { logToRunTag } from "./run-log.mjs";

/**
 * 转义 YAML frontmatter 中的字符串值（可含冒号、换行时用双引号并转义）
 */
function escapeYamlValue(val) {
  if (val == null) return '""';
  const s = String(val);
  if (/[\n"\\:]/.test(s)) {
    return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
  }
  return '"' + s + '"';
}

/**
 * 从已有 result 文件中截取正文（frontmatter 之后的部分）
 */
function getExistingBody(resultPath) {
  if (!fs.existsSync(resultPath)) return "";
  const raw = fs.readFileSync(resultPath, "utf-8");
  const match = raw.match(/---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n([\s\S]*)$/);
  return match ? match[1] : "";
}

/**
 * 从现有 result frontmatter 中读取 execId。
 * @param {string} resultPath
 * @returns {number | null}
 */
function getExistingExecId(resultPath) {
  if (!fs.existsSync(resultPath)) return null;
  const raw = fs.readFileSync(resultPath, "utf-8");
  const fm = raw.match(/---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return null;
  const m = fm[1].match(/(?:^|\n)\s*execId:\s*"?(\d+)"?\s*(?:\n|$)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

/**
 * 统一写入 result 文件。
 * cacheMd5/cacheInputInfo 仅保存在 <instanceId>.cache.json，不写入 result。
 * @param {string} workspaceRoot - 工作区根目录
 * @param {string} flowName - 流程名
 * @param {string} uuid - 本次 run 的 uuid
 * @param {string} instanceId - 节点 instance id
 * @param {{ status: string, message: string, finishedAt?: string, outputPath?: string, branch?: string, cacheNotMetReason?: string, elapsedMs?: number }} fields - 必填 status、message；可选其余（elapsedMs 为节点执行耗时毫秒，供 UI 展示）
 * @param {{ preserveBody?: boolean, body?: string, execId?: number }} [options] - preserveBody：保留已有正文；body：指定正文内容；execId：本轮 execId，缺省则从 memory 读取
 */
export function writeResult(workspaceRoot, flowName, uuid, instanceId, fields, options = {}) {
  const runDir = getRunDir(workspaceRoot, flowName, uuid);
  const execId = options.execId ?? loadExecId(workspaceRoot, flowName, uuid, instanceId);
  const resultBasename = intermediateResultBasename(instanceId, execId);
  const resultPath = path.join(runDir, intermediateDirForNode(instanceId), resultBasename);

  /** 调度只认 success；Agent 可能传 completed/done，在此统一写成 success */
  let status = fields.status ?? "success";
  if (typeof status === "string" && (status.toLowerCase() === "completed" || status.toLowerCase() === "done")) {
    status = "success";
  }
  const message = fields.message ?? "";
  const finishedAt = fields.finishedAt ?? new Date().toISOString();
  const outputPath = fields.outputPath;
  const branch = fields.branch;
  const cacheNotMetReason = fields.cacheNotMetReason;
  const elapsedMs =
    fields.elapsedMs != null && Number.isFinite(fields.elapsedMs) && fields.elapsedMs >= 0 ? Math.round(fields.elapsedMs) : undefined;

  const existingExecId = getExistingExecId(resultPath);
  let body = options.body;
  if (body === undefined && options.preserveBody !== false) {
    body = getExistingBody(resultPath);
  }
  if (body === undefined) body = "";
  if (fs.existsSync(resultPath) && existingExecId !== execId) {
    backupIntermediateFileIfExists(resultPath, execId);
  }

  const lines = [
    "---",
    `status: ${escapeYamlValue(status)}`,
    `execId: ${escapeYamlValue(execId)}`,
  ];
  if (branch !== undefined && branch !== null) {
    lines.push(`branch: ${escapeYamlValue(branch)}`);
  }
  lines.push(
    `message: ${escapeYamlValue(message)}`,
    `finishedAt: ${escapeYamlValue(finishedAt)}`
  );
  if (outputPath !== undefined && outputPath !== null && outputPath !== "") {
    lines.push(`outputPath: ${escapeYamlValue(outputPath)}`);
  }
  if (cacheNotMetReason !== undefined && cacheNotMetReason !== null && cacheNotMetReason !== "") {
    lines.push(`cacheNotMetReason: ${escapeYamlValue(cacheNotMetReason)}`);
  }
  if (elapsedMs !== undefined) {
    lines.push(`elapsedMs: ${elapsedMs}`);
  }
  lines.push("---");
  const content = lines.join("\n") + "\n" + (body ? "\n" + body : "");

  fs.mkdirSync(path.dirname(resultPath), { recursive: true });
  fs.writeFileSync(resultPath, content, "utf-8");
  logToRunTag(workspaceRoot, flowName, uuid, "result", {
    instanceId,
    status,
    message: message || undefined,
    branch: branch ?? undefined,
    cacheNotMetReason: cacheNotMetReason ?? undefined,
    resultPathRel: path.relative(runDir, resultPath),
  });
}

function main() {
  const args = process.argv.slice(2);
  const jsonIdx = args.indexOf("--json");
  if (args.length < 5 || jsonIdx === -1 || !args[jsonIdx + 1]) {
    console.error(
      JSON.stringify({
        ok: false,
        error:
          "Usage: node write-result.mjs <workspaceRoot> <flowName> <uuid> <instanceId> --json '<JSON>'",
      })
    );
    process.exit(1);
  }

  const [root, flowName, uuid, instanceId] = args.slice(0, jsonIdx);
  const jsonStr = args[jsonIdx + 1];
  const workspaceRoot = path.resolve(root);

  let payload;
  try {
    payload = JSON.parse(jsonStr);
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: "Invalid JSON: " + e.message }));
    process.exit(1);
  }

  if (!payload.status || !payload.message) {
    console.error(
      JSON.stringify({ ok: false, error: "JSON must include status and message" })
    );
    process.exit(1);
  }

  const fields = {
    status: payload.status,
    message: payload.message,
    finishedAt: payload.finishedAt,
    outputPath: payload.outputPath,
    branch: payload.branch,
    cacheNotMetReason: payload.cacheNotMetReason,
    elapsedMs: payload.elapsedMs,
  };
  const options = {};
  if (payload.body !== undefined) options.body = payload.body;
  else options.preserveBody = true;
  if (payload.execId !== undefined) options.execId = Number(payload.execId) || 1;

  try {
    writeResult(workspaceRoot, flowName, uuid, instanceId, fields, options);
    console.log(JSON.stringify({ ok: true }));
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  }
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("write-result.mjs") || process.argv[1].endsWith("write-result.js"));
if (isMain) {
  main();
}
