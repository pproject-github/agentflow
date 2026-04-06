#!/usr/bin/env node
/**
 * 根据 prompt 内容 + resolvedInputs 计算缓存键 MD5 与 cacheInputInfo，供前处理与 check-cache 共用。
 * 用法（模块）：import { computeCacheMd5 } from "./compute-cache-md5.mjs";
 * 返回 { cacheMd5, cacheInputInfo, payload } 或 { ok: false, error }。payload 为计算 MD5 的完整字符串，供 pre/now 落盘排查。
 *
 * 当前 .cache.json 文件结构（写入路径：intermediate/<instanceId>/<instanceId>.cache.json）：
 * - cacheMd5: string   — 对 payload 的 MD5 十六进制串
 * - cacheInputInfo: string — JSON 字符串，解析后为 { instanceId, definitionId, inputPaths }
 *   - inputPaths: Array<{ slot: string, execId: number, value: string }>，即 forCache 各 key 及参与 MD5 的值
 * - execId: number      — 本轮写入时的 execId
 * - inputHandlerExecIds?: Record<前驱节点 id, number> — 各前驱在本轮计算时用的 execId（可选）
 * - payload?: string   — 用于算 MD5 的完整字符串：prompt 全文 + "\\n" + forCache 规范化串（可选，便于排查）
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";

import { getRunDir, PIPELINES_DIR } from "../lib/paths.mjs";
import { getFlowDir } from "../lib/workspace.mjs";

import { buildNodePrompt } from "./build-node-prompt.mjs";
import { getResolvedValues } from "./get-resolved-values.mjs";
import { loadAllExecIds, latestResultExecId, intermediatePromptBasename, intermediateCacheBasename } from "./get-exec-id.mjs";
import { loadFlowDefinition, instanceEntryToSlots, parseInstanceSlots } from "./parse-flow.mjs";

/** 从 intermediate/<instanceId>/<instanceId>_<execId>.cache.json 读取 cacheMd5，无则返回 "" */
function readUpstreamCacheMd5(intermediateDir, instanceId, execId) {
  const basename = intermediateCacheBasename(instanceId, execId);
  const p = path.join(intermediateDir, instanceId, basename);
  if (!fs.existsSync(p)) return "";
  try {
    const o = JSON.parse(fs.readFileSync(p, "utf-8"));
    return o.cacheMd5 != null ? String(o.cacheMd5) : "";
  } catch {
    return "";
  }
}

/**
 * 计算节点的 cacheMd5 与 cacheInputInfo。
 * payload 不含 execId，使相同输入得到稳定 cache 键，避免缓存持续失效。
 * 约定：payload = prompt 内容 + "\n" + 规范化的 forCache（仅 resolvedInputs、upstreamMd5）。
 * @returns {{ ok: true, cacheMd5: string, cacheInputInfo: string, payload: string }} 或 {{ ok: false, error: string }}
 */
export function computeCacheMd5(workspaceRoot, flowName, uuid, instanceId, execId = 1) {
  const runDir = getRunDir(workspaceRoot, flowName, uuid);
  const intermediateDir = path.join(runDir, "intermediate");
  const build = buildNodePrompt(workspaceRoot, flowName, uuid, instanceId, execId);
  if (!build.ok) {
    return { ok: false, error: build.error || "buildNodePrompt failed" };
  }
  const promptBasename = intermediatePromptBasename(instanceId, execId);
  const promptPath = path.join(intermediateDir, instanceId, promptBasename);
  if (!fs.existsSync(promptPath)) {
    return { ok: false, error: "Prompt file not found" };
  }
  const promptContent = fs.readFileSync(promptPath, "utf-8");

  /** 所有写 .cache.json 的节点（含 control_if、control_anyOne、tool_load_key、tool_save_key、tool_get_env、普通节点）均由此处统一解析输入；
   * 输入来自 getResolvedValues → computeResolvedInputsForInstance，按 flow.edges 的 targetHandle 与 instance 的 input 槽位一一对应赋值，无按 definitionId 的特殊分支。
   * 只要 flow 中该节点的 edge 与 instance 定义正确，各 input 槽会正确赋值。 */
  const data = getResolvedValues(workspaceRoot, flowName, uuid, instanceId);
  if (!data.ok) {
    return { ok: false, error: data.error || "getResolvedValues failed" };
  }
  const resolvedInputs = data.resolvedInputs || {};

  /** 上游 edge 对应 node 的 cacheMd5 与各 input handler 的 execId：从 flow.json 取 predecessors，再读各前驱的 .cache.json */
  let upstreamMd5 = "";
  /** 各 input handler（前驱节点）在本次计算时使用的 execId，用于落盘与参与 cache 计算 */
  let inputHandlerExecIds = {};
  const flowJsonPath = path.join(intermediateDir, "flow.json");
  if (fs.existsSync(flowJsonPath)) {
    try {
      const flow = JSON.parse(fs.readFileSync(flowJsonPath, "utf-8"));
      if (flow.ok) {
        let preds = flow.predecessors && flow.predecessors[instanceId];
        if (!preds && Array.isArray(flow.edges)) {
          preds = [];
          const seen = new Set();
          for (const e of flow.edges) {
            if (e.target !== instanceId || !e.source) continue;
            if (!seen.has(e.source)) {
              seen.add(e.source);
              preds.push(e.source);
            }
          }
        }
        if (Array.isArray(preds) && preds.length > 0) {
          const order = flow.order || [];
          const execIds = loadAllExecIds(workspaceRoot, flowName, uuid, order);
          const sorted = [...new Set(preds)].sort();
          upstreamMd5 = sorted
            .map((predId) => {
              const predExecId = latestResultExecId(execIds[predId] ?? 1);
              inputHandlerExecIds[predId] = predExecId;
              return `${predId}:${readUpstreamCacheMd5(intermediateDir, predId, 1)}`;
            })
            .join("\n");
        }
      }
    } catch (_) {}
  }

  /** forCache 仅含 resolvedInputs 与 upstreamMd5，不包含 execId，保证 payload 稳定 */
  const forCache = {
    ...resolvedInputs,
    upstreamMd5,
  };
  const keys = Object.keys(forCache).sort();
  const parts = keys.map((k) => `${k}:${String(forCache[k] ?? "")}`);
  const canonicalInputString = parts.join("\n");

  const payload = promptContent + "\n" + canonicalInputString;
  const cacheMd5 = crypto.createHash("md5").update(payload, "utf8").digest("hex");

  let definitionId = "";
  let flow = null;
  if (fs.existsSync(flowJsonPath)) {
    try {
      flow = JSON.parse(fs.readFileSync(flowJsonPath, "utf-8"));
      if (flow.ok && flow.nodes) {
        const node = flow.nodes.find((n) => n.id === instanceId);
        definitionId = node?.definitionId ?? "";
      }
    } catch (_) {}
  }

  /** 每个 slot 对应的 input handler 的 execId（该槽由哪次执行的 handler 提供）；非 handler 槽用 0，本节点 execId 槽用当前 execId */
  const slotToHandlerExecId = {};
  if (flow?.ok && flow.edges && (inputHandlerExecIds && Object.keys(inputHandlerExecIds).length > 0)) {
    const predsWithHandle = (flow.edges || [])
      .filter((e) => e.target === instanceId && e.source)
      .map((e) => ({ source: e.source, targetHandle: e.targetHandle || "input-0" }));
    let flowDir = getFlowDir(workspaceRoot, flowName) || path.join(path.resolve(workspaceRoot), PIPELINES_DIR, flowName);
    if (flow?.flowDir && typeof flow.flowDir === "string" && flow.flowDir.trim()) {
      flowDir = path.isAbsolute(flow.flowDir) ? flow.flowDir : path.join(workspaceRoot, flow.flowDir);
    }
    const flowData = loadFlowDefinition(flowDir);
    const instanceDir = path.join(flowDir, "instance");
    const getSlotsFor = (id) => {
      if (flowData?.instances?.[id]) return instanceEntryToSlots(flowData.instances[id]);
      try {
        return parseInstanceSlots(path.join(instanceDir, `${id}.md`));
      } catch {
        return { input: {}, output: {}, inputTypes: {}, outputTypes: {} };
      }
    };
    const inputSlotNames = Object.keys(getSlotsFor(instanceId).input || {});
    for (let i = 0; i < inputSlotNames.length; i++) {
      const slotName = inputSlotNames[i];
      const targetHandle = `input-${i}`;
      const pred = predsWithHandle.find((p) => p.targetHandle === targetHandle);
      if (pred && inputHandlerExecIds[pred.source] != null) {
        slotToHandlerExecId[slotName] = inputHandlerExecIds[pred.source];
      }
    }
  }
  const currentExecId = execId ?? 1;
  const inputPaths = keys.map((k) => ({
    slot: k,
    execId: slotToHandlerExecId[k] ?? (k === "execId" ? currentExecId : 0),
    value: forCache[k],
  }));
  const cacheInputInfo = JSON.stringify({ instanceId, definitionId, inputPaths });

  return {
    ok: true,
    cacheMd5,
    cacheInputInfo,
    payload,
    execId: execId ?? 1,
    inputHandlerExecIds,
  };
}
