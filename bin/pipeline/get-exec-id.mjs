#!/usr/bin/env node
/**
 * 从 run 目录 memory 读取各节点的 execId（供其它逻辑使用）。result/中间文件使用固定文件名，不再带 _execId。
 * 用法（CLI）：node get-exec-id.mjs <workspaceRoot> <uuid> [instanceId]
 *   - 仅 instanceId：输出该节点 execId（默认 1）
 *   - 无 instanceId：需从 flow.json 读 order，输出 JSON { "execIds": { "<id>": number } }
 * 用法（模块）：
 *   loadExecId(workspaceRoot, flowName, uuid, instanceId) -> number
 *   loadAllExecIds(workspaceRoot, flowName, uuid, order) -> { instanceId: number }
 *   latestResultExecId(execId) -> number
 *   intermediateResultBasename(instanceId, execId?) -> "<instanceId>.result.md"（固定，execId 忽略）
 *   intermediatePromptBasename(instanceId, execId?) -> "<instanceId>.prompt.md"（固定）
 *   intermediateCacheBasename(instanceId, execId?) -> "<instanceId>.cache.json"（固定）
 *   outputNodeBasename(instanceId, execId?, slot) -> "node_<instanceId>_<slot>.md"（固定，无 execId）
 *   intermediateDirForNode(instanceId) -> "intermediate/<instanceId>"（相对 run 目录）
 *   outputDirForNode(instanceId) -> "output/<instanceId>"
 */

import fs from "fs";
import path from "path";

import { getRunDir } from "../lib/paths.mjs";

const MEMORY_FILENAME = "memory.md";
const EXEC_ID_KEY_PREFIX = "execId_";

function parseMemory(content) {
  const map = new Map();
  for (const line of (content || "").split(/\r?\n/)) {
    const idx = line.indexOf(": ");
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim();
    const v = line.slice(idx + 2).trim();
    if (k) map.set(k, v);
  }
  return map;
}

/**
 * 从 memory 读取单个节点的 execId，默认 1。
 */
export function loadExecId(workspaceRoot, flowName, uuid, instanceId) {
  const runDir = getRunDir(workspaceRoot, flowName, uuid);
  const memoryPath = path.join(runDir, MEMORY_FILENAME);
  if (!fs.existsSync(memoryPath)) return 1;
  const map = parseMemory(fs.readFileSync(memoryPath, "utf-8"));
  const v = map.get(EXEC_ID_KEY_PREFIX + instanceId);
  if (v === undefined || v === "") return 1;
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/**
 * 从 memory 读取所有 order 中节点的 execId。
 */
export function loadAllExecIds(workspaceRoot, flowName, uuid, order) {
  const runDir = getRunDir(workspaceRoot, flowName, uuid);
  const memoryPath = path.join(runDir, MEMORY_FILENAME);
  const map = fs.existsSync(memoryPath)
    ? parseMemory(fs.readFileSync(memoryPath, "utf-8"))
    : new Map();
  const out = {};
  for (const instanceId of order) {
    const v = map.get(EXEC_ID_KEY_PREFIX + instanceId);
    const n = v !== undefined && v !== "" ? parseInt(String(v), 10) : 1;
    out[instanceId] = Number.isFinite(n) && n >= 1 ? n : 1;
  }
  return out;
}

/**
 * 用于读取「当前最新」result 文件对应的 execId。
 * 约定：memory 存的是「上一轮已完成的 execId」，节点以 execId E 执行时写入 <id>_E.result.md。
 * 故最新 result 即为 _<memory 中的 execId>.result.md，直接返回该值；缺省或非法时为 1。
 */
export function latestResultExecId(execId) {
  const e = execId != null ? Number(execId) : 1;
  return Number.isFinite(e) && e >= 1 ? e : 1;
}

/** 固定文件名，不含 _execId，第二参数保留兼容调用方但不参与结果 */
export function intermediateResultBasename(instanceId, execId) {
  return `${instanceId}.result.md`;
}

/** 固定文件名，不含 _execId */
export function intermediatePromptBasename(instanceId, execId) {
  return `${instanceId}.prompt.md`;
}

/** 固定文件名，不含 _execId */
export function intermediateCacheBasename(instanceId, execId) {
  return `${instanceId}.cache.json`;
}

/** 固定文件名：node_<instanceId>_<base>.md，不含 execId */
export function outputNodeBasename(instanceId, execId, slot) {
  const base = (slot || "result").replace(/\.(md|txt|json|html?)$/i, "") || "result";
  return `node_${instanceId}_${base}.md`;
}

/** 节点在 intermediate 下的一级目录（相对 run 目录），flow.json 仍在 intermediate/ 根下 */
export function intermediateDirForNode(instanceId) {
  return `intermediate/${instanceId}`;
}

/** 节点在 output 下的一级目录（相对 run 目录） */
export function outputDirForNode(instanceId) {
  return `output/${instanceId}`;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.error("Usage: node get-exec-id.mjs <workspaceRoot> <flowName> <uuid> [instanceId]");
    process.exit(1);
  }
  const [root, flowName, uuid, instanceId] = args;
  const workspaceRoot = path.resolve(root);

  if (instanceId) {
    const execId = loadExecId(workspaceRoot, flowName, uuid, instanceId);
    console.log(JSON.stringify({ execId }));
    return;
  }

  const flowJsonPath = path.join(getRunDir(workspaceRoot, flowName, uuid), "intermediate", "flow.json");
  if (!fs.existsSync(flowJsonPath)) {
    console.log(JSON.stringify({ execIds: {} }));
    return;
  }
  let order = [];
  try {
    const flow = JSON.parse(fs.readFileSync(flowJsonPath, "utf-8"));
    if (flow.ok && Array.isArray(flow.order)) order = flow.order;
  } catch (_) {}
  const execIds = loadAllExecIds(workspaceRoot, flowName, uuid, order);
  console.log(JSON.stringify({ execIds }));
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("get-exec-id.mjs") || process.argv[1].endsWith("get-exec-id.js"));
if (isMain) main();
