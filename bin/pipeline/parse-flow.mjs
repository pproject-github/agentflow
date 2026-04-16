#!/usr/bin/env node
/**
 * 解析 flow.yaml：从 instances + edges（顶层）构建有向图并输出拓扑序，带环检测。
 * 用法：node parse-flow.mjs <flowYamlPath>
 * 或：  node parse-flow.mjs <workspaceRoot> <flowName> [uuid] [flowDir]
 * 当参数个数 ≥4 且第 4 个参数存在时，用 args[3] 作为 flowDir；否则按 getFlowDir（user → .workspace → .cursor 旧路径 → builtin）解析。
 * 输出：order、nodes（含 role、model）、edges、hasCycle；若传 uuid 则含 instanceStatus 并写入 intermediate/flow.json（不写 resolvedInputs/resolvedOutputs，由 get-resolved-values 用时现算）；若传 flowName 则 stdout 含 outputSlotTypes、inputSlotTypes，可选含 resolvedInputs、resolvedOutputs。
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";

import { getRunDir, LEGACY_NODES_DIR, PIPELINES_DIR, PROJECT_NODES_DIR } from "../lib/paths.mjs";
import { getFlowDir } from "../lib/workspace.mjs";
import { loadAllExecIds, latestResultExecId, intermediateResultBasename, intermediateDirForNode, outputDirForNode } from "./get-exec-id.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_BUILTIN_NODES_DIR = path.join(path.resolve(__dirname, "..", ".."), "builtin", "nodes");
import { logToRunTag } from "./run-log.mjs";

const FLOW_YAML_FILENAME = "flow.yaml";

/** 从流程目录读取 flow.yaml，返回 { instances, edges, ui }；兼容旧版 flow.edges */
function loadFlowDefinition(flowDir) {
  const filePath = path.join(flowDir, FLOW_YAML_FILENAME);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = yaml.load(raw);
    if (!data || typeof data !== "object") return null;
    const edges = Array.isArray(data.edges)
      ? data.edges
      : Array.isArray(data.flow?.edges)
        ? data.flow.edges
        : [];
    return {
      instances: data.instances && typeof data.instances === "object" ? data.instances : {},
      edges,
      ui: data.ui && typeof data.ui === "object" ? data.ui : {},
    };
  } catch {
    return null;
  }
}

/** 由 definitionId 前缀推导 type */
function definitionIdToType(definitionId) {
  const id = (definitionId || "").toLowerCase();
  if (id.startsWith("control_")) return "control";
  if (id.startsWith("agent_")) return "agent";
  if (id.startsWith("provide_")) return "provide";
  if (id.startsWith("tool_")) return "agent";
  return "agent";
}

/**
 * 按定义名查找节点类文件，读 frontmatter 中的 definitionId；若无则返回 definitionName。
 * 查找顺序：flowDir/nodes、.workspace/agentflow/nodes、旧 .cursor/agentflow/nodes、包内 builtin/nodes。
 * @param {string} flowDir - 流程目录 pipelines/<flowName>
 * @param {string} definitionName - 实例中引用的定义名（如 user_confirm_scope）
 * @returns {{ definitionId: string, definitionName: string }}
 */
function resolveDefinitionIdFromNodeClass(flowDir, definitionName) {
  const workspaceRoot = path.resolve(flowDir, "..", "..", "..", "..");
  const fileName = definitionName.endsWith(".md") ? definitionName : `${definitionName}.md`;
  const flowNodesPath = path.join(flowDir, "nodes", fileName);
  const projectNodesNew = path.join(workspaceRoot, PROJECT_NODES_DIR, fileName);
  const projectNodesLegacy = path.join(workspaceRoot, LEGACY_NODES_DIR, fileName);
  const packageNodesPath = path.join(PACKAGE_BUILTIN_NODES_DIR, fileName);
  for (const filePath of [flowNodesPath, projectNodesNew, projectNodesLegacy, packageNodesPath]) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const m = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
      if (!m) continue;
      const fmMatch = m[1].match(/^\s*definitionId:\s*["']?([^"'\n]+)["']?/m);
      const inner = fmMatch ? fmMatch[1].trim() : "";
      const definitionId = inner || definitionName;
      return { definitionId, definitionName };
    } catch (_) {}
  }
  return { definitionId: definitionName, definitionName };
}

/** 从 loadFlowDefinition 结果得到 nodes 和 edges（与 readFlowMd 输出形状一致） */
function readFlowFromYaml(flowDir) {
  const def = loadFlowDefinition(flowDir);
  if (!def) return { nodes: [], edges: [] };
  const instances = def.instances;
  const edgesRaw = Array.isArray(def.edges) ? def.edges : [];
  const nodeIds = new Set(Object.keys(instances));
  for (const e of edgesRaw) {
    if (e?.source) nodeIds.add(e.source);
    if (e?.target) nodeIds.add(e.target);
  }
  const nodes = Array.from(nodeIds).map((id) => {
    const inst = instances[id] || {};
    const definitionName = inst.definitionId ?? id;
    const { definitionId } = resolveDefinitionIdFromNodeClass(flowDir, definitionName);
    const type = definitionIdToType(definitionId);
    const label = inst.label != null ? String(inst.label) : id;
    const role =
      inst.role != null && String(inst.role).trim()
        ? String(inst.role).trim()
        : "普通";
    const model =
      inst.model != null && String(inst.model).trim()
        ? String(inst.model).trim()
        : null;
    return { id, type, label, definitionId, role, model, definitionName };
  });
  const edges = edgesRaw
    .filter((e) => e?.source && e?.target)
    .map((e) => ({
      source: String(e.source),
      target: String(e.target),
      sourceHandle: e.sourceHandle ?? null,
      targetHandle: e.targetHandle ?? null,
    }));
  return { nodes, edges };
}

function readFlowMd(filePath) {
  const raw = fs.readFileSync(filePath, "utf-8");
  const nodes = [];
  const edges = [];
  let inNodes = false;
  let inEdges = false;
  const lines = raw.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "nodes:") {
      inNodes = true;
      inEdges = false;
      continue;
    }
    if (trimmed === "edges:") {
      inEdges = true;
      inNodes = false;
      continue;
    }
    if (inNodes && /^\s*-\s+id:\s*(.+)$/.test(line)) {
      const id = line.replace(/^\s*-\s+id:\s*/, "").trim().replace(/^["']|["']$/g, "");
      nodes.push({ id });
      continue;
    }
    if (inNodes && nodes.length && /^\s{2,}(type|label|definitionId|role|model):\s*(.+)$/.test(line)) {
      const m = line.match(/^\s{2,}(type|label|definitionId|role|model):\s*(.+)$/);
      if (m) {
        const key = m[1];
        const val = m[2].trim().replace(/^["']|["']$/g, "");
        nodes[nodes.length - 1][key] = val;
      }
      continue;
    }
    if (inEdges && /^\s*-\s+source:\s*(.+)$/.test(line)) {
      const source = line.replace(/^\s*-\s+source:\s*/, "").trim().replace(/^["']|["']$/g, "");
      edges.push({ source, target: null, sourceHandle: null, targetHandle: null });
      continue;
    }
    if (inEdges && edges.length && /^\s+target:\s*(.+)$/.test(line)) {
      const target = line.replace(/^\s+target:\s*/, "").trim().replace(/^["']|["']$/g, "");
      edges[edges.length - 1].target = target;
      continue;
    }
    if (inEdges && edges.length && /^\s+sourceHandle:\s*(.+)$/.test(line)) {
      const v = line.replace(/^\s+sourceHandle:\s*/, "").trim().replace(/^["']|["']$/g, "");
      edges[edges.length - 1].sourceHandle = v === "null" ? null : v;
      continue;
    }
    if (inEdges && edges.length && /^\s+targetHandle:\s*(.+)$/.test(line)) {
      const v = line.replace(/^\s+targetHandle:\s*/, "").trim().replace(/^["']|["']$/g, "");
      edges[edges.length - 1].targetHandle = v === "null" ? null : v;
      continue;
    }
    if (trimmed === "" && (inNodes || inEdges)) {
      inNodes = false;
      inEdges = false;
    }
  }
  return { nodes, edges };
}

function topoSort(nodes, edges) {
  const idToIndex = new Map(nodes.map((n, i) => [n.id, i]));
  const n = nodes.length;
  const outEdges = Array.from({ length: n }, () => []);
  const inDeg = new Array(n).fill(0);
  for (const e of edges) {
    const u = idToIndex.get(e.source);
    const v = idToIndex.get(e.target);
    if (u == null || v == null) continue;
    outEdges[u].push(v);
    inDeg[v]++;
  }
  const queue = [];
  for (let i = 0; i < n; i++) if (inDeg[i] === 0) queue.push(i);
  const order = [];
  let visited = 0;
  while (queue.length) {
    const u = queue.shift();
    order.push(nodes[u].id);
    visited++;
    for (const v of outEdges[u]) {
      inDeg[v]--;
      if (inDeg[v] === 0) queue.push(v);
    }
  }
  const hasCycle = visited !== n;
  return { order, hasCycle };
}

/**
 * 找出所有参与至少一个环的节点（Tarjan SCC：大小 > 1 的强连通分量中的节点并集）。
 * 返回 Set<nodeId>。
 */
function findCycleNodes(nodes, edges) {
  const idToIndex = new Map(nodes.map((n, i) => [n.id, i]));
  const n = nodes.length;
  const outEdges = Array.from({ length: n }, () => []);
  for (const e of edges) {
    const u = idToIndex.get(e.source);
    const v = idToIndex.get(e.target);
    if (u == null || v == null) continue;
    outEdges[u].push(v);
  }

  let index = 0;
  const stack = [];
  const dfn = new Array(n).fill(-1);
  const low = new Array(n).fill(-1);
  const onStack = new Array(n).fill(false);
  const cycleNodeIds = new Set();

  function strongConnect(u) {
    dfn[u] = low[u] = index++;
    stack.push(u);
    onStack[u] = true;
    for (const v of outEdges[u]) {
      if (dfn[v] === -1) {
        strongConnect(v);
        low[u] = Math.min(low[u], low[v]);
      } else if (onStack[v]) {
        low[u] = Math.min(low[u], dfn[v]);
      }
    }
    if (dfn[u] === low[u]) {
      const scc = [];
      let w;
      do {
        w = stack.pop();
        onStack[w] = false;
        scc.push(w);
      } while (w !== u);
      if (scc.length > 1) {
        for (const i of scc) cycleNodeIds.add(nodes[i].id);
      }
    }
  }

  for (let i = 0; i < n; i++) {
    if (dfn[i] === -1) strongConnect(i);
  }
  return cycleNodeIds;
}

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

/** 从文件中提取 ${input}、${output}、${input.xxx}、${output.xxx} 占位符 */
function extractPlaceholders(text) {
  if (!text || typeof text !== "string") return { inputs: [], outputs: [] };
  const inputs = [];
  const outputs = [];
  const inputRe = /\$\{input(?:\.(\w+))?\}/g;
  const outputRe = /\$\{output(?:\.(\w+))?\}/g;
  let m;
  while ((m = inputRe.exec(text)) !== null) {
    inputs.push(m[1] || null);
  }
  while ((m = outputRe.exec(text)) !== null) {
    outputs.push(m[1] || null);
  }
  return { inputs: [...new Set(inputs)], outputs: [...new Set(outputs)] };
}

/** 解析 instance 的 frontmatter，提取 input/output 槽位的 name、value 与 type */
function parseInstanceSlots(filePath) {
  const result = { input: {}, output: {}, inputTypes: {}, outputTypes: {} };
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
    if (!fmMatch) return result;
    const fm = fmMatch[1];
    let section = null;
    let currentName = null;
    let currentType = null;
    const lines = fm.split(/\n/);
    for (const line of lines) {
      if (/^\s*input:\s*$/.test(line)) {
        section = "input";
        currentName = null;
        currentType = null;
        continue;
      }
      if (/^\s*output:\s*$/.test(line)) {
        section = "output";
        currentName = null;
        currentType = null;
        continue;
      }
      const typeMatch = line.match(/^\s*-\s+type:\s*["']?([^"'\n]*)["']?/);
      if (typeMatch) {
        currentType = typeMatch[1].trim() || null;
        currentName = null;
        continue;
      }
      const typeMatch2 = line.match(/^\s+type:\s*["']?([^"'\n]*)["']?/);
      if (typeMatch2 && section) {
        currentType = typeMatch2[1].trim() || null;
        continue;
      }
      const nameMatch = line.match(/^\s+name:\s*["']?([^"'\n]*)["']?/);
      if (nameMatch) {
        currentName = nameMatch[1].trim() || "";
        continue;
      }
      const valueMatch = line.match(/^\s+(?:value|default):\s*(.*)$/);
      if (valueMatch && section) {
        const v = valueMatch[1].replace(/^["']|["']$/g, "").trim();
        const key = currentName != null ? currentName : "_";
        result[section][key] = v;
        if (currentType && section === "output") result.outputTypes[key] = currentType;
        if (currentType && section === "input") result.inputTypes[key] = currentType;
        currentName = null;
        currentType = null;
      }
    }
  } catch (_) {}
  return result;
}

/** 读取 instance 文件内容（用于提取占位符） */
function readInstanceContent(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const m = raw.match(/^---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)$/);
    return m ? m[1] : raw;
  } catch {
    return "";
  }
}

/** 从 result.md 解析 outputPath（上游节点执行后的实际输出路径） */
function parseResultOutputPath(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const m = raw.match(/^\s*outputPath:\s*["']?([^"'\s]+)["']?/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** 按约定生成输出槽的静态路径：output/<instanceId>/node_<instanceId>_<slotBase>.md */
function getOutputPathForSlot(instanceId, slotName) {
  const base = slotName.replace(/\.(md|txt|json|html?)$/i, "") || slotName;
  return `${outputDirForNode(instanceId)}/node_${instanceId}_${base}.md`;
}

/** 从 flow.yaml 的 instance 条目得到 slots 形状（与 parseInstanceSlots 一致） */
function instanceEntryToSlots(inst) {
  const result = { input: {}, output: {}, inputTypes: {}, outputTypes: {} };
  if (!inst || typeof inst !== "object") return result;
  const toMap = (arr, typesTarget) => {
    const map = {};
    if (!Array.isArray(arr)) return map;
    arr.forEach((item, i) => {
      const name = item?.name != null ? String(item.name) : (i === 0 ? "_" : "");
      const key = name || `_${i}`;
      map[key] = item?.value != null ? String(item.value) : "";
      if (item?.type && typesTarget) typesTarget[key] = item.type;
    });
    return map;
  };
  result.input = toMap(inst.input, result.inputTypes);
  result.output = toMap(inst.output, result.outputTypes);
  return result;
}

/** 解析 ${input}/${output} 占位符的实际值；需 workspaceRoot、flowName，可选 uuid；flowData 为 loadFlowDefinition 结果，有则从 instances 读。可选 flowDirIn：传入时作为流程目录（支持用户数据目录下 flow）。 */
function resolvePlaceholders(workspaceRoot, flowName, order, edges, uuid, flowData, flowDirIn) {
  const flowDir =
    flowDirIn != null && flowDirIn !== ""
      ? path.resolve(flowDirIn)
      : getFlowDir(workspaceRoot, flowName) || path.join(workspaceRoot, PIPELINES_DIR, flowName);
  const instanceDir = path.join(flowDir, "instance");
  const instances = flowData?.instances && typeof flowData.instances === "object" ? flowData.instances : {};
  const useYaml = Object.keys(instances).length > 0;
  const intermediateDir = uuid && flowName ? path.join(getRunDir(workspaceRoot, flowName, uuid), "intermediate") : null;
  let execIds = {};
  if (uuid && flowName && intermediateDir && fs.existsSync(intermediateDir)) {
    try {
      execIds = loadAllExecIds(workspaceRoot, flowName, uuid, order);
    } catch (_) {}
  }

  const predecessors = new Map();
  for (const e of edges) {
    if (!e.target) continue;
    if (!predecessors.has(e.target)) predecessors.set(e.target, []);
    predecessors.get(e.target).push({ source: e.source, sourceHandle: e.sourceHandle, targetHandle: e.targetHandle });
  }

  const resolvedInputs = {};
  const resolvedOutputs = {};
  const outputSlotTypes = {};
  const inputSlotTypes = {};

  const getSlotsFor = (instanceId) => {
    if (useYaml && instances[instanceId]) return instanceEntryToSlots(instances[instanceId]);
    const instPath = path.join(instanceDir, `${instanceId}.md`);
    return fs.existsSync(instPath) ? parseInstanceSlots(instPath) : instanceEntryToSlots(null);
  };

  const getContentFor = (instanceId) => {
    if (useYaml && instances[instanceId] && instances[instanceId].body != null) return String(instances[instanceId].body || "").trim();
    return readInstanceContent(path.join(instanceDir, `${instanceId}.md`));
  };

  /** 通过 sourceHandle (output-0, output-1...) 获取上游节点对应 output 槽位的值 */
  const getNodeOutput = (instanceId, sourceHandle) => {
    const slots = getSlotsFor(instanceId);
    const out = slots.output;
    const outValues = Object.values(out);
    if (sourceHandle && /^output-(\d+)$/.test(sourceHandle)) {
      const idx = parseInt(sourceHandle.replace("output-", ""), 10);
      if (idx >= 0 && idx < outValues.length) return outValues[idx] ?? null;
    }
    return outValues[0] ?? null;
  };

  const getNodeOutputFromResult = (instanceId) => {
    if (!intermediateDir) return null;
    const latestE = latestResultExecId(execIds[instanceId] ?? 1);
    if (!latestE) return null;
    const resultPath = path.join(intermediateDir, instanceId, intermediateResultBasename(instanceId, latestE));
    return parseResultOutputPath(resultPath);
  };

  for (const instanceId of order) {
    const content = getContentFor(instanceId);
    const slots = getSlotsFor(instanceId);
    resolvedOutputs[instanceId] = { ...slots.output };
    if (slots.outputTypes && Object.keys(slots.outputTypes).length > 0) {
      outputSlotTypes[instanceId] = slots.outputTypes;
    }
    if (slots.inputTypes && Object.keys(slots.inputTypes).length > 0) {
      inputSlotTypes[instanceId] = slots.inputTypes;
    }
    const { inputs: inputRefs } = extractPlaceholders(content);

    const preds = predecessors.get(instanceId) || [];
    const inputSlotNames = Object.keys(slots.input);

    for (let i = 0; i < inputSlotNames.length; i++) {
      const slotName = inputSlotNames[i];
      const targetHandle = `input-${i}`;
      const pred = preds.find((p) => p.targetHandle === targetHandle);
      if (!pred) continue;

      const fromResult = getNodeOutputFromResult(pred.source);
      const fromInstance = getNodeOutput(pred.source, pred.sourceHandle);
      let value = fromResult ?? fromInstance;
      // 按上游 output 槽名生成路径：上游多槽时 result 只记一个 path，若直接用 fromResult 会令所有边得到同一路径，导致 pre/now 不一致；故有 sourceHandle 时优先用槽名约定路径
      if (pred.sourceHandle && /^output-(\d+)$/.test(pred.sourceHandle)) {
        const sourceSlots = getSlotsFor(pred.source);
        if (Object.keys(sourceSlots.output).length > 0) {
          const outSlotNames = Object.keys(sourceSlots.output);
          const idx = parseInt(pred.sourceHandle.replace("output-", ""), 10);
          if (idx >= 0 && idx < outSlotNames.length) {
            const slotPath = getOutputPathForSlot(pred.source, outSlotNames[idx]);
            // 无 result 或 result 未提供路径时用约定路径；有 result 且上游多槽时仍用约定路径，避免多边共用一个 outputPath
            if (!value || value === "" || outSlotNames.length > 1) {
              value = slotPath;
            }
          }
        }
      }
      if (value != null) {
        // 类型为「节点」的 input 槽：填上游节点 id，不填文件路径，避免多 output 槽解析歧义与 cache 漂移
        const slotType = slots.inputTypes && slots.inputTypes[slotName];
        if (slotType === "节点" || slotType === "node") {
          value = pred.source;
        }
        if (!resolvedInputs[instanceId]) resolvedInputs[instanceId] = {};
        resolvedInputs[instanceId][slotName] = value;
      }
    }
    // 无入边的 input 槽位使用 instance 中该槽的 value 作为默认值（如 tool_save_key 的 key）
    if (!resolvedInputs[instanceId]) resolvedInputs[instanceId] = {};
    for (const slotName of inputSlotNames) {
      if (resolvedInputs[instanceId][slotName] != null) continue;
      const defaultVal = slots.input[slotName];
      if (defaultVal !== undefined && defaultVal !== "") {
        resolvedInputs[instanceId][slotName] = defaultVal;
      }
    }

    if (inputRefs.length > 0 && preds.length > 0 && !Object.keys(resolvedInputs[instanceId]).length) {
      const pred = preds[0];
      const fromResult = getNodeOutputFromResult(pred.source);
      const fromInstance = getNodeOutput(pred.source, pred.sourceHandle);
      let v = fromResult ?? fromInstance;
      if (v != null) {
        // 占位符 _ 若对应节点类型，用上游节点 id
        const firstSlotName = inputSlotNames[0];
        const firstType = slots.inputTypes && slots.inputTypes[firstSlotName];
        if (firstType === "节点" || firstType === "node") v = pred.source;
        resolvedInputs[instanceId] = { _: v };
      }
    }
  }
  return { resolvedInputs, resolvedOutputs, outputSlotTypes, inputSlotTypes };
}

function applyCliInputs(order, edges, instances, cliInputs, resolvedInputs) {
  if (!instances || typeof instances !== "object") return;
  for (const instanceId of order) {
    const inst = instances[instanceId];
    if (!inst?.input) continue;
    const inputSlots = inst.input;
    for (let i = 0; i < inputSlots.length; i++) {
      const slotName = inputSlots[i]?.name;
      if (!slotName || !cliInputs[slotName]) continue;
      const edge = edges.find(e => e.target === instanceId && e.targetHandle === `input-${i}`);
      if (!edge?.source) continue;
      const sourceInst = instances[edge.source];
      if (sourceInst?.definitionId?.startsWith("provide_")) {
        const cliVal = cliInputs[slotName];
        const value = cliVal.type === "file" ? cliVal.path : cliVal.value;
        if (!resolvedInputs[instanceId]) resolvedInputs[instanceId] = {};
        resolvedInputs[instanceId][slotName] = value;
      }
    }
  }
}

/** 读取 uuid 对应 run 目录下 intermediate/ 中各 instance 的状态（按 _execId 最新一轮 result 读） */
function readInstanceStatus(workspaceRoot, flowName, uuid, order) {
  const intermediateDir = path.join(getRunDir(workspaceRoot, flowName, uuid), "intermediate");
  const instanceStatus = {};
  try {
    if (!fs.existsSync(intermediateDir)) return instanceStatus;
    const execIds = loadAllExecIds(workspaceRoot, flowName, uuid, order);
    for (const instanceId of order) {
      const latestE = latestResultExecId(execIds[instanceId] ?? 1);
      if (!latestE) continue;
      const resultPath = path.join(intermediateDir, instanceId, intermediateResultBasename(instanceId, latestE));
      const status = parseResultStatus(resultPath);
      if (status) instanceStatus[instanceId] = status;
    }
  } catch (_) {}
  return instanceStatus;
}

function main() {
  const args = process.argv.slice(2);
  let flowDir;
  let workspaceRoot = null;
  let uuid = null;
  let cliInputs = {};
  const cliInputsIdx = args.indexOf("--cli-inputs");
  if (cliInputsIdx >= 0 && args[cliInputsIdx + 1]) {
    try {
      cliInputs = JSON.parse(args[cliInputsIdx + 1]);
      args.splice(cliInputsIdx, 2);
    } catch (_) {}
  }
  if (args.length === 1) {
    const p = path.resolve(args[0]);
    flowDir = path.dirname(p);
    if (!p.endsWith(FLOW_YAML_FILENAME)) {
      console.error(JSON.stringify({ ok: false, error: `Path must be to ${FLOW_YAML_FILENAME}` }));
      process.exit(1);
    }
  } else if (args.length >= 2) {
    const [root, name] = args;
    workspaceRoot = path.resolve(root);
    if (args.length >= 4 && args[3]) {
      flowDir = path.resolve(args[3]);
    } else {
      flowDir = getFlowDir(workspaceRoot, name) || path.join(workspaceRoot, PIPELINES_DIR, name);
    }
    if (args.length >= 3) uuid = args[2];
  } else {
    console.error(JSON.stringify({ ok: false, error: "Usage: node parse-flow.mjs <flowYamlPath> | node parse-flow.mjs <workspaceRoot> <flowName> [uuid] [flowDir] [--cli-inputs <json>]" }));
    process.exit(1);
  }
  const flowData = loadFlowDefinition(flowDir);
  if (!flowData) {
    console.error(JSON.stringify({ ok: false, error: `File not found or invalid: ${path.join(flowDir, FLOW_YAML_FILENAME)}` }));
    process.exit(1);
  }
  try {
    const { nodes, edges } = readFlowFromYaml(flowDir);
    const { order: topoOrder, hasCycle } = topoSort(nodes, edges);
    const order = hasCycle ? nodes.map((n) => n.id) : topoOrder;
    const cycleNodes = hasCycle ? Array.from(findCycleNodes(nodes, edges)) : [];

    const predecessors = {};
    for (const e of edges) {
      if (!e.target) continue;
      if (!predecessors[e.target]) predecessors[e.target] = [];
      predecessors[e.target].push(e.source);
    }

    const nodeDefinitions = {};
    for (const n of nodes) {
      if (n.definitionId) nodeDefinitions[n.id] = n.definitionId;
    }
    const out = { ok: true, order, nodes, edges, predecessors, nodeDefinitions, hasCycle, cycleNodes };
    const flowNameArg = args.length >= 2 ? args[1] : null;
    if (uuid && workspaceRoot && flowNameArg) {
      out.instanceStatus = readInstanceStatus(workspaceRoot, flowNameArg, uuid, order);
    }
    if (workspaceRoot && args.length >= 2) {
      const flowName = args[1];
      out.flowName = flowName;
      const { resolvedInputs, resolvedOutputs, outputSlotTypes, inputSlotTypes } = resolvePlaceholders(workspaceRoot, flowName, order, edges, uuid || null, flowData, flowDir);
      if (Object.keys(cliInputs).length > 0) {
        applyCliInputs(order, edges, flowData.instances, cliInputs, resolvedInputs);
      }
      out.resolvedInputs = resolvedInputs;
      out.resolvedOutputs = resolvedOutputs;
      out.outputSlotTypes = outputSlotTypes;
      out.inputSlotTypes = inputSlotTypes;
      out.cliInputsApplied = Object.keys(cliInputs).length > 0 ? cliInputs : null;
    }
    // 传入 uuid 时自动写入 intermediate/flow.json（仅结构 + slotTypes，不含 resolvedInputs/resolvedOutputs）
    if (uuid && workspaceRoot && flowNameArg) {
      const intermediateDir = path.join(getRunDir(workspaceRoot, flowNameArg, uuid), "intermediate");
      fs.mkdirSync(intermediateDir, { recursive: true });
      const flowJsonPath = path.join(intermediateDir, "flow.json");
      const starts = order.filter((id) => nodeDefinitions[id] === "control_start");
      let pendingInstances = starts;
      let preserved = false;
      if (fs.existsSync(flowJsonPath)) {
        try {
          const old = JSON.parse(fs.readFileSync(flowJsonPath, "utf-8"));
          if (Array.isArray(old.pendingInstances) && old.pendingInstances.length > 0) {
            pendingInstances = old.pendingInstances;
            preserved = true;
          }
        } catch (_) {}
      }
      out.pendingInstances = pendingInstances;
      out.flowDir = path.resolve(flowDir);
      logToRunTag(workspaceRoot, flowNameArg, uuid, "parse-flow", {
        event: "pendingInstances",
        pendingInstances,
        preserved,
      });
      const { resolvedInputs: _ri, resolvedOutputs: _ro, ...flowForFile } = out;
      fs.writeFileSync(flowJsonPath, JSON.stringify(flowForFile), "utf-8");
    }
    console.log(JSON.stringify(out));
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  }
}

/** 供其他脚本使用：从流程目录读取 flow.yaml；resolve-inputs 等需用到的 helpers */
export {
  loadFlowDefinition,
  readFlowFromYaml,
  parseResultOutputPath,
  getOutputPathForSlot,
  instanceEntryToSlots,
  parseInstanceSlots,
  readInstanceContent,
  extractPlaceholders,
  applyCliInputs,
};

const isMain = typeof process !== "undefined" && process.argv[1] && process.argv[1].endsWith("parse-flow.mjs");
if (isMain) main();
