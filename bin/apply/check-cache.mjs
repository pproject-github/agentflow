#!/usr/bin/env node
/**
 * get-ready-nodes 前执行：对 status 为 success 且存在 .cache.json 的节点重算 MD5，
 * 若与 .cache.json 中记录不一致则将该节点 result 改为 cache_not_met，使其重新进入待执行。
 * result/cache 使用固定路径（不含 _execId）。
 * 用法：node check-cache.mjs <workspaceRoot> <flowName> <uuid>
 * 输出（stdout JSON）：{ "ok": true }；失败时 { "ok": false, "error": "..." }
 */

import fs from "fs";
import path from "path";

import { computeCacheMd5 } from "./compute-cache-md5.mjs";
import { writeResult } from "./write-result.mjs";
import { intermediateResultBasename, intermediateCacheBasename } from "./get-exec-id.mjs";
import { logToRunTag } from "./run-log.mjs";

const RUN_BASE_REL = ".workspace/agentflow/runBuild";

function parseResultStatus(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const m = raw.match(/^\s*status:\s*["']?(\w+)["']?/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

const PRE_CACHE_JSON = ".pre.cache.json";
const NOW_CACHE_JSON = ".now.cache.json";

/** 从 intermediate/<instanceId>/<instanceId>.cache.json 读取 cacheMd5（固定路径） */
function readCacheFromSidecar(intermediateDir, instanceId) {
  const basename = intermediateCacheBasename(instanceId, 1);
  const p = path.join(intermediateDir, instanceId, basename);
  if (!fs.existsSync(p)) return { cacheMd5: null };
  try {
    const raw = fs.readFileSync(p, "utf-8");
    const o = JSON.parse(raw);
    return { cacheMd5: o.cacheMd5 ?? null };
  } catch {
    return { cacheMd5: null };
  }
}

/** 将当时的 .cache.json 存为 .pre.cache.json，当前重算结果存为 .now.cache.json，便于排查 */
function savePreAndNowCache(intermediateDir, instanceId, current) {
  const nodeDir = path.join(intermediateDir, instanceId);
  const prePath = path.join(nodeDir, intermediateCacheBasename(instanceId, 1));
  const preSavePath = path.join(nodeDir, `${instanceId}${PRE_CACHE_JSON}`);
  const nowSavePath = path.join(nodeDir, `${instanceId}${NOW_CACHE_JSON}`);
  if (fs.existsSync(prePath)) {
    try {
      fs.copyFileSync(prePath, preSavePath);
    } catch (_) {}
  }
  try {
    const nowObj = { cacheMd5: current.cacheMd5, cacheInputInfo: current.cacheInputInfo ?? "" };
    if (current.payload !== undefined) nowObj.payload = current.payload;
    if (current.execId !== undefined) nowObj.execId = current.execId;
    if (current.inputHandlerExecIds != null && Object.keys(current.inputHandlerExecIds).length > 0) {
      nowObj.inputHandlerExecIds = current.inputHandlerExecIds;
    }
    fs.writeFileSync(nowSavePath, JSON.stringify(nowObj, null, 2), "utf-8");
  } catch (_) {}
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.error(
      JSON.stringify({
        ok: false,
        error: "Usage: node check-cache.mjs <workspaceRoot> <flowName> <uuid>",
      })
    );
    process.exit(1);
  }

  const [root, flowName, uuid] = args;
  const workspaceRoot = path.resolve(root);
  const runDir = path.join(workspaceRoot, RUN_BASE_REL, flowName, uuid);
  const flowJsonPath = path.join(runDir, "intermediate", "flow.json");

  if (!fs.existsSync(flowJsonPath)) {
    console.log(JSON.stringify({ ok: true }));
    return;
  }

  let flow;
  try {
    flow = JSON.parse(fs.readFileSync(flowJsonPath, "utf-8"));
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  }
  if (!flow.ok || !Array.isArray(flow.order)) {
    console.log(JSON.stringify({ ok: true }));
    return;
  }

  const order = flow.order;
  const edges = flow.edges || [];
  const nodeDefinitions = flow.nodeDefinitions || {};
  const outputSlotTypes = flow.outputSlotTypes || {};
  const inputSlotTypes = flow.inputSlotTypes || {};
  const intermediateDir = path.join(runDir, "intermediate");

  /** 仅对 pendingInstances 及其向后边能到达的节点做缓存校验，与 get-ready-nodes 候选集一致 */
  const isNodeEdge = (e) => {
    const outTypes = outputSlotTypes[e.source];
    const inTypes = inputSlotTypes[e.target];
    if (!outTypes || !inTypes) return false;
    const outNames = Object.keys(outTypes);
    const inNames = Object.keys(inTypes);
    const oidx = parseInt(String(e.sourceHandle || "output-0").replace("output-", ""), 10) || 0;
    const iidx = parseInt(String(e.targetHandle || "input-0").replace("input-", ""), 10) || 0;
    const outType = outNames[oidx] != null ? outTypes[outNames[oidx]] : null;
    const inType = inNames[iidx] != null ? inTypes[inNames[iidx]] : null;
    return outType === "节点" && inType === "节点";
  };
  const successors = {};
  for (const e of edges) {
    if (!e.source || e.target == null) continue;
    if (!isNodeEdge(e)) continue;
    if (!successors[e.source]) successors[e.source] = [];
    successors[e.source].push(e.target);
  }
  const starts = order.filter((id) => nodeDefinitions[id] === "control_start");
  const pendingInstances = Array.isArray(flow.pendingInstances) ? flow.pendingInstances : starts;
  const candidateSet = new Set();
  const candQueue = [...pendingInstances];
  while (candQueue.length) {
    const id = candQueue.shift();
    if (candidateSet.has(id)) continue;
    candidateSet.add(id);
    for (const next of successors[id] || []) {
      if (!candidateSet.has(next)) candQueue.push(next);
    }
  }

  logToRunTag(workspaceRoot, flowName, uuid, "check-cache", {
    event: "start",
    candidateSet: [...candidateSet],
  });

  for (const instanceId of candidateSet) {
    const resultBasename = intermediateResultBasename(instanceId, 1);
    const resultPath = path.join(intermediateDir, instanceId, resultBasename);
    if (!fs.existsSync(resultPath)) continue;

    const status = parseResultStatus(resultPath);
    const { cacheMd5: storedMd5 } = readCacheFromSidecar(intermediateDir, instanceId);
    if (status !== "success" || !storedMd5) continue;

    const current = computeCacheMd5(workspaceRoot, flowName, uuid, instanceId, 1);
    if (!current.ok) continue;

    if (current.cacheMd5 !== storedMd5) {
      savePreAndNowCache(intermediateDir, instanceId, current);
      const reason = `storedMd5=${storedMd5} currentMd5=${current.cacheMd5}`;
      logToRunTag(workspaceRoot, flowName, uuid, "check-cache", {
        event: "cache_not_met",
        instanceId,
        storedMd5,
        currentMd5: current.cacheMd5,
        reason,
      });
      try {
        writeResult(workspaceRoot, flowName, uuid, instanceId, {
          status: "cache_not_met",
          message: "缓存失效（prompt/input 已变更）",
          cacheNotMetReason: reason,
        }, { preserveBody: true });
      } catch (err) {
        console.error(JSON.stringify({ ok: false, error: err.message }));
        process.exit(1);
      }
    }
  }

  logToRunTag(workspaceRoot, flowName, uuid, "check-cache", { event: "done" });
  console.log(JSON.stringify({ ok: true }));
}

main();
