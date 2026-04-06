#!/usr/bin/env node
/**
 * 按 flow 结构 + 中间文件为单个 instance 计算 resolvedInputs（不注入常量；上游 output 路径已带对应 input handler 的 execId）。
 * 供 get-resolved-values 等用时现算，不依赖 flow.json 中的 resolvedInputs。
 * 约定：上游节点的 output 槽路径使用该前驱的 latestResultExecId，即 output/<predId>/node_<predId>_<execId>_<slot>.md。
 * 用法（模块）：import { computeResolvedInputsForInstance } from "./resolve-inputs.mjs";
 * @returns {{ ok: true, resolvedInputs: object }} 或 {{ ok: false, error: string }}
 */

import fs from "fs";
import path from "path";

import { getRunDir, PIPELINES_DIR } from "../lib/paths.mjs";
import { getFlowDir } from "../lib/workspace.mjs";
import {
  loadAllExecIds,
  latestResultExecId,
  intermediateResultBasename,
  outputDirForNode,
  outputNodeBasename,
} from "./get-exec-id.mjs";
import {
  loadFlowDefinition,
  parseResultOutputPath,
  instanceEntryToSlots,
  parseInstanceSlots,
  readInstanceContent,
  extractPlaceholders,
} from "./parse-flow.mjs";

/**
 * 为指定 instanceId 计算 resolvedInputs（与 parse-flow resolvePlaceholders 单实例逻辑一致）。
 */
export function computeResolvedInputsForInstance(workspaceRoot, flowName, uuid, instanceId) {
  const root = path.resolve(workspaceRoot);
  const runDir = getRunDir(workspaceRoot, flowName, uuid);
  const flowJsonPath = path.join(runDir, "intermediate", "flow.json");
  const intermediateDir = path.join(runDir, "intermediate");

  if (!fs.existsSync(flowJsonPath)) {
    return { ok: false, error: `flow.json not found: ${flowJsonPath}. Run parse-flow.mjs first.` };
  }

  let flow;
  try {
    flow = JSON.parse(fs.readFileSync(flowJsonPath, "utf-8"));
  } catch (e) {
    return { ok: false, error: e.message || "Invalid flow.json" };
  }
  if (!flow.ok) {
    return { ok: false, error: flow.error || "flow.json indicates error" };
  }

  let flowDir = getFlowDir(root, flowName) || path.join(root, PIPELINES_DIR, flowName);
  if (flow.flowDir && typeof flow.flowDir === "string" && flow.flowDir.trim()) {
    flowDir = path.isAbsolute(flow.flowDir) ? flow.flowDir : path.join(root, flow.flowDir);
  }
  const instanceDir = path.join(flowDir, "instance");

  const order = flow.order || [];
  const edges = flow.edges || [];
  if (!order.length) {
    return { ok: false, error: "flow.json missing order" };
  }

  if (!order.includes(instanceId)) {
    return { ok: false, error: `instanceId ${instanceId} not in flow order` };
  }

  const flowData = loadFlowDefinition(flowDir);
  const instances = flowData?.instances && typeof flowData.instances === "object" ? flowData.instances : {};
  const useYaml = Object.keys(instances).length > 0;

  let execIds = {};
  if (fs.existsSync(intermediateDir)) {
    try {
      execIds = loadAllExecIds(workspaceRoot, flowName, uuid, order);
    } catch (_) {}
  }

  /** 入边：target -> [{ source, sourceHandle, targetHandle }] */
  const predecessors = new Map();
  for (const e of edges) {
    if (!e.target) continue;
    if (!predecessors.has(e.target)) predecessors.set(e.target, []);
    predecessors.get(e.target).push({
      source: e.source,
      sourceHandle: e.sourceHandle || "output-0",
      targetHandle: e.targetHandle,
    });
  }

  const getSlotsFor = (id) => {
    if (useYaml && instances[id]) return instanceEntryToSlots(instances[id]);
    const instPath = path.join(instanceDir, `${id}.md`);
    return fs.existsSync(instPath) ? parseInstanceSlots(instPath) : instanceEntryToSlots(null);
  };

  const getContentFor = (id) => {
    if (useYaml && instances[id] && instances[id].body != null) return String(instances[id].body || "").trim();
    return readInstanceContent(path.join(instanceDir, `${id}.md`));
  };

  const getNodeOutput = (id, sourceHandle) => {
    const slots = getSlotsFor(id);
    const outValues = Object.values(slots.output || {});
    if (sourceHandle && /^output-(\d+)$/.test(sourceHandle)) {
      const idx = parseInt(sourceHandle.replace("output-", ""), 10);
      if (idx >= 0 && idx < outValues.length) return outValues[idx] ?? null;
    }
    return outValues[0] ?? null;
  };

  const getNodeOutputFromResult = (id) => {
    const latestE = latestResultExecId(execIds[id] ?? 1);
    if (!latestE) return null;
    const resultPath = path.join(intermediateDir, id, intermediateResultBasename(id, latestE));
    return parseResultOutputPath(resultPath);
  };

  const resolvedInputs = {};
  const slots = getSlotsFor(instanceId);
  const { inputs: inputRefs } = extractPlaceholders(getContentFor(instanceId));
  const preds = predecessors.get(instanceId) || [];
  const inputSlotNames = Object.keys(slots.input || {});

  for (let i = 0; i < inputSlotNames.length; i++) {
    const slotName = inputSlotNames[i];
    const targetHandle = `input-${i}`;
    const pred = preds.find((p) => p.targetHandle === targetHandle);
    if (!pred) continue;

    const fromResult = getNodeOutputFromResult(pred.source);
    const fromInstance = getNodeOutput(pred.source, pred.sourceHandle);
    let value = fromResult ?? fromInstance;

    if (pred.sourceHandle && /^output-(\d+)$/.test(pred.sourceHandle)) {
      const sourceSlots = getSlotsFor(pred.source);
      const outSlotNames = Object.keys(sourceSlots.output || {});
      if (outSlotNames.length > 0) {
        const idx = parseInt(pred.sourceHandle.replace("output-", ""), 10);
        if (idx >= 0 && idx < outSlotNames.length) {
          const predExecId = latestResultExecId(execIds[pred.source] ?? 1);
          const slotPath = `${outputDirForNode(pred.source)}/${outputNodeBasename(pred.source, predExecId, outSlotNames[idx])}`;
          if (!value || value === "" || outSlotNames.length > 1) {
            value = slotPath;
          }
        }
      }
    }

    if (value != null) {
      const slotType = (slots.inputTypes && slots.inputTypes[slotName]) || null;
      if (slotType === "节点") {
        value = pred.source;
      }
      resolvedInputs[slotName] = value;
    }
  }

  for (const slotName of inputSlotNames) {
    if (resolvedInputs[slotName] != null) continue;
    const defaultVal = slots.input && slots.input[slotName];
    if (defaultVal !== undefined && defaultVal !== "") {
      resolvedInputs[slotName] = defaultVal;
    }
  }

  if (inputRefs.length > 0 && preds.length > 0 && !Object.keys(resolvedInputs).length) {
    const pred = preds[0];
    const fromResult = getNodeOutputFromResult(pred.source);
    const fromInstance = getNodeOutput(pred.source, pred.sourceHandle);
    let v = fromResult ?? fromInstance;
    if (v != null) {
      const firstSlotName = inputSlotNames[0];
      const firstType = (slots.inputTypes && slots.inputTypes[firstSlotName]) || null;
      if (firstType === "节点") v = pred.source;
      return { ok: true, resolvedInputs: { _: v } };
    }
  }

  return { ok: true, resolvedInputs };
}
