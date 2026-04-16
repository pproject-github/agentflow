#!/usr/bin/env node
/**
 * 根据 flow.json 和最新 intermediate/*.result.md 计算当前可执行的节点。
 * 入口处先执行 cache 校验（集成 check-cache 逻辑），再计算就绪节点，保证每次取就绪列表前缓存已更新。
 * 用法：node get-ready-nodes.mjs <workspaceRoot> <flowName> <uuid>
 * 输出（stdout JSON）：{ "readyNodes": [...], "instanceStatus": {...}, "allDone": true|false, "pendingNodes": [...] }
 * pendingNodes：status 为 pending 的节点 id 列表，供主流程区分「暂停」与「卡住」。
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { spawnSync } from "child_process";

import { getRunDir } from "../lib/paths.mjs";
import { loadAllExecIds, latestResultExecId, intermediateResultBasename } from "./get-exec-id.mjs";
import { logToRunTag } from "./run-log.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 从 result.md 中解析 status（匹配 YAML frontmatter 中的 status: xxx） */
function parseResultStatus(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const m = raw.match(/^\s*status:\s*["']?(\w+)["']?/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** 从 result.md 中解析 branch（control_if 用）。值为节点类型的 output 槽位名（如 next1、next2）或布尔 "true"/"false"。 */
function parseResultBranch(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const m = raw.match(/^\s*branch:\s*["']?([^"'\s]+)["']?/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** control_if：将 branch 值（槽位名 next1/next2 或 true/false）映射为出边 sourceHandle（output-0 / output-1） */
function controlIfBranchToSourceHandle(branch) {
  if (!branch) return null;
  const b = String(branch).toLowerCase();
  if (b === "next1" || b === "true") return "output-0";
  if (b === "next2" || b === "false") return "output-1";
  return null;
}

/** tool_user_ask：将 branch 值映射为出边 sourceHandle。
 * branch 可为：槽位名（如 "option_1"）、纯数字字符串（"1"）或 "output-1" 形式。
 * 槽位名映射依赖 instance 的 output 顺序（与 outputSlotTypes 的 key 顺序一致）。 */
function userAskBranchToSourceHandle(branch, outputSlotTypesForNode) {
  if (!branch) return null;
  const s = String(branch).trim();
  if (/^output-\d+$/.test(s)) return s;
  if (/^\d+$/.test(s)) return `output-${parseInt(s, 10)}`;
  if (outputSlotTypesForNode && typeof outputSlotTypesForNode === "object") {
    const names = Object.keys(outputSlotTypesForNode);
    const idx = names.indexOf(s);
    if (idx >= 0) return `output-${idx}`;
  }
  // 兜底：option_N 形式
  const m = s.match(/^option_(\d+)$/i);
  if (m) return `output-${parseInt(m[1], 10)}`;
  return null;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.error(
      JSON.stringify({
        ok: false,
        error: "Usage: node get-ready-nodes.mjs <workspaceRoot> <flowName> <uuid>",
      }),
    );
    process.exit(1);
  }

  const [root, flowName, uuid] = args;
  const workspaceRoot = path.resolve(root);

  /** 先执行 cache 校验，再计算就绪节点，避免主流程漏调 check-cache */
  const checkCachePath = path.join(__dirname, "check-cache.mjs");
  const cacheResult = spawnSync(
    process.execPath,
    [checkCachePath, workspaceRoot, flowName, uuid],
    { encoding: "utf-8", stdio: ["inherit", "pipe", "inherit"] },
  );
  if (cacheResult.status !== 0) {
    console.error(cacheResult.stdout || "check-cache failed");
    process.exit(cacheResult.status ?? 1);
  }
  logToRunTag(workspaceRoot, flowName, uuid, "get-ready-nodes", { event: "check-cache-done", status: cacheResult.status });

  const runDir = getRunDir(workspaceRoot, flowName, uuid);
  const flowJsonPath = path.join(runDir, "intermediate", "flow.json");
  const intermediateDir = path.join(runDir, "intermediate");

  if (!fs.existsSync(flowJsonPath)) {
    console.error(
      JSON.stringify({
        ok: false,
        error: `flow.json not found: ${flowJsonPath}. Run parse-flow.mjs first.`,
      }),
    );
    process.exit(1);
  }

  let flow;
  try {
    flow = JSON.parse(fs.readFileSync(flowJsonPath, "utf-8"));
    if (!flow.ok) {
      console.error(JSON.stringify({ ok: false, error: flow.error || "flow.json indicates error" }));
      process.exit(1);
    }
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  }

  try {
    const {
      order,
      edges = [],
      predecessors: rawPredecessors,
      nodeDefinitions = {},
      outputSlotTypes = {},
      inputSlotTypes = {},
    } = flow;
    const execIdMap = loadAllExecIds(workspaceRoot, flowName, uuid, order);
    if (!order || !Array.isArray(order)) {
      console.error(JSON.stringify({ ok: false, error: "flow.json missing order" }));
      process.exit(1);
    }

    /** 若 flow.json 无 predecessors，从 edges 构建 */
    let predecessors = rawPredecessors;
    if (!predecessors || typeof predecessors !== "object") {
      predecessors = {};
      for (const e of edges) {
        if (!e.target) continue;
        if (!predecessors[e.target]) predecessors[e.target] = [];
        predecessors[e.target].push(e.source);
      }
    }

    /** 判断边是否为「节点」边：两端槽位类型均为「节点」；图由 edge 搭建，后继只看节点边，前驱用全部边。 */
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
      return (outType === "节点" || outType === "node") && (inType === "节点" || inType === "node");
    };

    /** 后继：仅「节点」边（执行顺序由节点边决定）；用于从 control_start 的可达集与 execId 同步 */
    const successors = {};
    for (const e of edges) {
      if (!e.source || e.target == null) continue;
      if (!isNodeEdge(e)) continue;
      if (!successors[e.source]) successors[e.source] = [];
      successors[e.source].push(e.target);
    }

    const starts = order.filter((id) => nodeDefinitions[id] === "control_start");
    /** 游标：当前执行前沿；缺省为 starts，并写回 flow.json */
    const hadPendingFromFile = Array.isArray(flow.pendingInstances) && flow.pendingInstances.length > 0;
    let pendingInstances = hadPendingFromFile ? flow.pendingInstances : starts;
    if (!hadPendingFromFile) {
      flow.pendingInstances = pendingInstances;
      fs.writeFileSync(flowJsonPath, JSON.stringify(flow), "utf-8");
    }
    logToRunTag(workspaceRoot, flowName, uuid, "get-ready-nodes", {
      event: "pendingInstances-init",
      pendingInstances,
      usedStarts: !hadPendingFromFile,
    });

    const reachableFromStart = new Set();
    const queue = [...starts];
    while (queue.length) {
      const id = queue.shift();
      if (reachableFromStart.has(id)) continue;
      reachableFromStart.add(id);
      for (const next of successors[id] || []) {
        if (!reachableFromStart.has(next)) queue.push(next);
      }
    }

    /** 参与集：从 start 可达的节点 + 这些节点的所有前驱（递归）。下游依赖的节点（如 loadFlowKey）即使无入边也会被纳入，从而可被就绪判定。 */
    const needToRun = new Set(reachableFromStart);
    let changed = true;
    while (changed) {
      changed = false;
      for (const id of needToRun) {
        for (const p of predecessors[id] || []) {
          if (!needToRun.has(p)) {
            needToRun.add(p);
            changed = true;
          }
        }
      }
    }

    /** 刷新 instanceStatus：仅对参与集 needToRun 读 result，后续只用这些节点的 status */
    const instanceStatus = {};
    for (const instanceId of needToRun) {
      const execId = execIdMap[instanceId] ?? 1;
      const latestE = latestResultExecId(execId);
      const resultPath = latestE
        ? path.join(intermediateDir, instanceId, intermediateResultBasename(instanceId, latestE))
        : null;
      let status = resultPath && fs.existsSync(resultPath) ? parseResultStatus(resultPath) : null;
      if (!status && (nodeDefinitions[instanceId] || "").startsWith("provide_")) {
        status = "success";
      }
      /* control_start 在流程开头即执行且由 CLI 写 result，无 result 时也视为 success 避免角标缺失；control_end 只有流程真正跑完才会执行并写 result，不能无 result 就标 success */
      if (!status && nodeDefinitions[instanceId] === "control_start") {
        status = "success";
      }
      if (status) instanceStatus[instanceId] = status;
    }
    logToRunTag(workspaceRoot, flowName, uuid, "get-ready-nodes", {
      event: "instanceStatus",
      instanceStatus,
      order,
    });

    /** 入边：target -> [{ source, sourceHandle }, ...]，用于 control_if 分支判断 */
    const inEdgesByTarget = {};
    for (const e of edges) {
      if (!e.target) continue;
      if (!inEdgesByTarget[e.target]) inEdgesByTarget[e.target] = [];
      inEdgesByTarget[e.target].push({ source: e.source, sourceHandle: e.sourceHandle || "output-0" });
    }

    /** 更新 pendingInstances：result 为 success 的从游标移除，并沿节点边向后移动（control_if 只加 branch 匹配的那条后继） */
    const nextPending = new Set(pendingInstances);
    for (const id of pendingInstances) {
      if (instanceStatus[id] !== "success") continue;
      nextPending.delete(id);
      if (nodeDefinitions[id] === "control_if" || nodeDefinitions[id] === "tool_user_ask") {
        const predLatestE = latestResultExecId(execIdMap[id] ?? 1);
        const resultPath = predLatestE
          ? path.join(intermediateDir, id, intermediateResultBasename(id, predLatestE))
          : null;
        const branch = resultPath && fs.existsSync(resultPath) ? parseResultBranch(resultPath) : null;
        const expectedHandle = nodeDefinitions[id] === "control_if"
          ? controlIfBranchToSourceHandle(branch)
          : userAskBranchToSourceHandle(branch, outputSlotTypes[id]);
        /** 同一 branch 可连多条节点边（如 true 同时到 save_key 与 anyOne），须全部加入游标，不可只用 find 取第一条 */
        const outEdges = edges.filter(
          (e) => e.source === id && isNodeEdge(e) && (e.sourceHandle || "output-0") === expectedHandle,
        );
        for (const outEdge of outEdges) {
          if (outEdge.target != null) nextPending.add(outEdge.target);
        }
      } else {
        for (const next of successors[id] || []) nextPending.add(next);
      }
    }
    const movedSuccess = pendingInstances.filter((id) => instanceStatus[id] === "success");
    const added = [...nextPending].filter((n) => !pendingInstances.includes(n));
    pendingInstances = Array.from(nextPending);
    const pendingSet = new Set(pendingInstances);
    logToRunTag(workspaceRoot, flowName, uuid, "get-ready-nodes", {
      event: "pendingInstances-update",
      pendingInstances,
      movedSuccess,
      added,
    });

    /** 候选集：从 pendingInstances 沿 successors 能到达的所有节点（闭包）；再扩展为包含「阻塞当前 pending 的」前驱（沿 predecessors 反向闭包），
     * 以便将可运行但未在 frontier 的前驱加入 readyNodes，避免 readyNodes 为空导致卡住（如 LoadFile 的前驱未在 pending 时）。 */
    const candidateSet = new Set();
    let candQueue = [...pendingInstances];
    while (candQueue.length) {
      const id = candQueue.shift();
      if (candidateSet.has(id)) continue;
      candidateSet.add(id);
      for (const next of successors[id] || []) {
        if (!candidateSet.has(next)) candQueue.push(next);
      }
    }
    candQueue = [...candidateSet];
    while (candQueue.length) {
      const id = candQueue.shift();
      for (const p of predecessors[id] || []) {
        if (candidateSet.has(p)) continue;
        candidateSet.add(p);
        candQueue.push(p);
      }
    }
    logToRunTag(workspaceRoot, flowName, uuid, "get-ready-nodes", {
      event: "candidateSet",
      size: candidateSet.size,
      candidateSet: [...candidateSet],
    });

    /** 判断 predecessor P 对 target N 是否算「就绪」：普通节点看 status；control_if / tool_user_ask 看 branch 与出边 sourceHandle */
    const isPredecessorReadyFor = (predSource, predDefId, targetId) => {
      if (instanceStatus[predSource] !== "success") return false;
      if (predDefId !== "control_if" && predDefId !== "tool_user_ask") return true;
      const inEdges = inEdgesByTarget[targetId] || [];
      const edge = inEdges.find((ie) => ie.source === predSource);
      if (!edge) return true;
      const predLatestE = latestResultExecId(execIdMap[predSource] ?? 1);
      const resultPath = predLatestE
        ? path.join(intermediateDir, predSource, intermediateResultBasename(predSource, predLatestE))
        : null;
      const branch = resultPath && fs.existsSync(resultPath) ? parseResultBranch(resultPath) : null;
      const expectedHandle = predDefId === "control_if"
        ? controlIfBranchToSourceHandle(branch)
        : userAskBranchToSourceHandle(branch, outputSlotTypes[predSource]);
      return expectedHandle != null && (edge.sourceHandle || "output-0") === expectedHandle;
    };

    const terminalStatuses = ["success", "failed", "condition_not_met", "pending"];
    const isRunnable = (nodeId) => {
      const preds = predecessors[nodeId] || [];
      if (preds.length === 0) return true;
      const defId = nodeDefinitions[nodeId];
      return defId === "control_anyOne"
        ? preds.some((p) => isPredecessorReadyFor(p, nodeDefinitions[p], nodeId))
        : preds.every((p) => isPredecessorReadyFor(p, nodeDefinitions[p], nodeId));
    };

    /** 将「阻塞当前 pending 的可运行前驱」加入 pendingInstances（并 pendingSet），写回 flow.json，使本轮回或下一轮能将其加入 readyNodes。 */
    const blockingRunnablePreds = [];
    for (const p of candidateSet) {
      if (pendingSet.has(p)) continue;
      if (terminalStatuses.includes(instanceStatus[p])) continue;
      if (!needToRun.has(p)) continue;
      if (!isRunnable(p)) continue;
      const blocksSomePending = [...pendingSet].some((n) => (predecessors[n] || []).includes(p));
      if (!blocksSomePending) continue;
      blockingRunnablePreds.push(p);
    }
    if (blockingRunnablePreds.length > 0) {
      for (const p of blockingRunnablePreds) {
        pendingInstances.push(p);
        pendingSet.add(p);
      }
      logToRunTag(workspaceRoot, flowName, uuid, "get-ready-nodes", {
        event: "pendingInstances-supplement",
        added: blockingRunnablePreds,
      });
    }

    /** 计算 readyNodes：仅考虑参与集 needToRun 内的节点；且必须在 pendingInstances 中（游标前沿）；predecessor 满足条件且自身未达终态。
     * 遍历范围限定为从 pendingInstances 沿边向后的候选集 candidateSet，不再全图遍历。
     * control_anyOne：至少有一个前驱 P 满足「P 已 success 且（若 P 为 control_if）P→N 的边与 P 的 branch 一致」。
     * control_if 仅解锁与 branch 匹配的那条出边所连的后继。pending 视为终态。
     * cache_not_met 由 check-cache.mjs 写入（prompt/input 变更导致缓存失效），非终态，节点可重新进入待执行。 */
    const readyNodes = [];
    for (const instanceId of candidateSet) {
      if (!pendingSet.has(instanceId)) continue;
      if (!needToRun.has(instanceId)) continue;
      const preds = predecessors[instanceId] || [];
      const definitionId = nodeDefinitions[instanceId];
      const allPredsReady =
        definitionId === "control_anyOne"
          ? preds.some((p) => isPredecessorReadyFor(p, nodeDefinitions[p], instanceId))
          : preds.every((p) => isPredecessorReadyFor(p, nodeDefinitions[p], instanceId));
      if (!allPredsReady) continue;
      /** 规则 1：仅 start 在无前驱时视为就绪；其他无前驱节点不在此轮加入 */
      if (preds.length === 0 && definitionId !== "control_start") continue;
      const isTerminal = terminalStatuses.includes(instanceStatus[instanceId]);
      if (!isTerminal) readyNodes.push(instanceId);
    }

    /** 规则 2：按需解析依赖——当 N 仅因前驱 P 未就绪而阻塞时，将可运行的 P 加入 readyNodes；P 须在 pendingSet 内（阻塞前驱已通过 supplement 加入 pendingInstances）。 */
    const addedSet = new Set(readyNodes);
    for (const instanceId of candidateSet) {
      if (!needToRun.has(instanceId)) continue;
      if (terminalStatuses.includes(instanceStatus[instanceId])) continue;
      if (addedSet.has(instanceId)) continue;
      const preds = predecessors[instanceId] || [];
      const missingPreds = preds.filter((p) => !instanceStatus[p]);
      if (missingPreds.length === 0) continue;
      for (const p of missingPreds) {
        if (!pendingSet.has(p)) continue;
        const otherPreds = preds.filter((x) => x !== p);
        const allOthersReady = otherPreds.every((op) =>
          isPredecessorReadyFor(op, nodeDefinitions[op], instanceId),
        );
        if (!allOthersReady) continue;
        if (terminalStatuses.includes(instanceStatus[p]) || addedSet.has(p)) continue;
        if (!isRunnable(p)) continue;
        addedSet.add(p);
        readyNodes.push(p);
      }
    }

    /** allDone：参与集内节点均为终态，或被阻塞（某 predecessor 为 condition_not_met 故永不会执行）；不在参与集内的节点视为已完成 */
    const isNodeDone = (id) => {
      if (!needToRun.has(id)) return true;
      if (terminalStatuses.includes(instanceStatus[id])) return true;
      const preds = predecessors[id] || [];
      const blocked = preds.some((p) => instanceStatus[p] === "condition_not_met");
      return blocked;
    };
    let allDone = needToRun.size === 0 ? false : [...needToRun].every(isNodeDone);

    /** pendingNodes：在参与集内且 status 为 pending 的节点（待用户确认），用于主流程判断「暂停」而非「卡住」 */
    const pendingNodes = [...needToRun].filter((id) => instanceStatus[id] === "pending");

    flow.pendingInstances = pendingInstances;
    fs.writeFileSync(flowJsonPath, JSON.stringify(flow), "utf-8");

    logToRunTag(workspaceRoot, flowName, uuid, "get-ready-nodes", {
      event: "ready",
      readyNodes,
      allDone,
      pendingNodes,
      pendingInstances,
      instanceStatus,
    });
    console.log(JSON.stringify({ ok: true, readyNodes, instanceStatus, allDone, pendingNodes }));
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  }
}

main();
