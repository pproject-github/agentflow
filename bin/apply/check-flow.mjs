#!/usr/bin/env node
/**
 * 检查 flow.yaml 定义：校验 instances、edges、槽位、control_start/control_end、环与 control_anyOne 等。
 * 用法：agentflow apply -ai check-flow <workspaceRoot> <flowName> [flowDir]
 * 或：agentflow apply -ai check-flow <flowYamlPath>（单参时为 flow 目录或 flow.yaml 路径）
 * 当传 3 个参数时，flowDir 为含 flow.yaml 的目录（相对 workspaceRoot 或绝对路径）；不传时先查 .workspace/agentflow/pipelines/<flowName>，再查 .cursor/agentflow/pipelines/<flowName>。
 * 输出（适配 agentflow apply -ai run-tool-nodejs）：stdout 单行 JSON { "err_code": number, "message": { "result": "<全文>" } }；err_code 恒为 0。
 */

import fs from "fs";
import path from "path";
import yaml from "js-yaml";

/** 由 definitionId 推导 type（与 parse-flow 一致） */
function definitionIdToType(definitionId) {
  const id = (definitionId || "").toLowerCase();
  if (id.startsWith("control_")) return "control";
  if (id.startsWith("agent_")) return "agent";
  if (id.startsWith("provide_")) return "provide";
  if (id.startsWith("tool_")) return "agent";
  return "agent";
}

/** 从 flow.yaml 的 instance 条目的 input/output 数组解析槽位名与类型 */
function getSlotsFromInstance(inst) {
  const result = { inputNames: [], outputNames: [], inputTypes: [], outputTypes: [] };
  if (!inst || typeof inst !== "object") return result;
  const inp = Array.isArray(inst.input) ? inst.input : [];
  const out = Array.isArray(inst.output) ? inst.output : [];
  for (const slot of inp) {
    const name = slot && (slot.name != null) ? String(slot.name).trim() : "";
    const type = slot && (slot.type != null) ? String(slot.type).trim() : "";
    if (name) {
      result.inputNames.push(name);
      result.inputTypes.push(type);
    }
  }
  for (const slot of out) {
    const name = slot && (slot.name != null) ? String(slot.name).trim() : "";
    const type = slot && (slot.type != null) ? String(slot.type).trim() : "";
    if (name) {
      result.outputNames.push(name);
      result.outputTypes.push(type);
    }
  }
  return result;
}

/**
 * 从流程目录读取 flow.yaml，返回 { nodes, edges, instances }；不存在或解析失败返回 null。
 */
function loadFlowYaml(flowDir) {
  const filePath = path.join(flowDir, "flow.yaml");
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = yaml.load(raw);
    if (!data || typeof data !== "object") return null;
    const instances = data.instances && typeof data.instances === "object" ? data.instances : {};
    const edgesRaw = Array.isArray(data.edges) ? data.edges : [];
    const nodeIds = new Set(Object.keys(instances));
    for (const e of edgesRaw) {
      if (e?.source) nodeIds.add(e.source);
      if (e?.target) nodeIds.add(e.target);
    }
    const nodes = Array.from(nodeIds).map((id) => {
      const inst = instances[id] || {};
      const definitionId = inst.definitionId != null ? String(inst.definitionId) : id;
      return {
        id,
        type: definitionIdToType(definitionId),
        label: inst.label != null ? String(inst.label) : id,
        definitionId,
        modelType: inst.modelType != null ? String(inst.modelType) : "Auto",
      };
    });
    const edges = edgesRaw
      .filter((e) => e?.source && e?.target)
      .map((e) => ({
        source: String(e.source),
        target: String(e.target),
        sourceHandle: e.sourceHandle ?? null,
        targetHandle: e.targetHandle ?? null,
      }));
    return { nodes, edges, instances };
  } catch {
    return null;
  }
}

/**
 * 从 frontmatter 字符串中解析 description 字段（支持 "、'、无引号），返回 trim 后的字符串，无则返回 ""。
 */
function parseDescriptionFromFm(fm) {
  if (!fm || typeof fm !== "string") return "";
  const match = fm.match(/\bdescription:\s*["']?([^"'\n#][^\n]*)["']?/);
  return match ? match[1].trim().replace(/^["']|["']$/g, "") : "";
}

/**
 * 读取文件 frontmatter 并返回 description。
 */
function getDescriptionFromFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return "";
    const raw = fs.readFileSync(filePath, "utf-8");
    const fmMatch = raw.match(/^---\s*\n([\s\S]*?)\n---/);
    return fmMatch ? parseDescriptionFromFm(fmMatch[1]) : "";
  } catch {
    return "";
  }
}

/**
 * 从正文中提取所有 ${...} 占位符，返回占位符内容列表（如 ["prev", "input.github", "output.next"]）。
 */
function extractPlaceholders(body) {
  const list = [];
  const re = /\$\{([^}]*)\}/g;
  let match;
  while ((match = re.exec(body)) !== null) {
    const inner = match[1].trim();
    if (inner) list.push(inner);
  }
  return list;
}

/** 转义字符串中的正则特殊字符，用于构造 RegExp。 */
function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 检查正文中槽位名是否被反引号或引号包裹（而非 ${}），若有则加入 warnings。
 */
function warnSlotNameNotWrappedInDollarBraces(body, inputNames, outputNames, warnings) {
  const allSlotNames = [...new Set([...inputNames, ...outputNames])];
  if (allSlotNames.length === 0) return;
  const bodyWithoutDollarBraces = body.replace(/\$\{[^}]*\}/g, "\x00\x00");
  for (const name of allSlotNames) {
    const escaped = escapeRegex(name);
    if (new RegExp(`\`${escaped}\``).test(bodyWithoutDollarBraces)) {
      warnings.push(`槽位名 "${name}" 被反引号包裹，应使用 \${${name}} 或 \${input.${name}}/\${output.${name}} 引用`);
    }
    if (new RegExp(`"${escaped}"`).test(bodyWithoutDollarBraces)) {
      warnings.push(`槽位名 "${name}" 被双引号包裹，应使用 \${${name}} 或 \${input.${name}}/\${output.${name}} 引用`);
    }
    if (new RegExp(`'${escaped}'`).test(bodyWithoutDollarBraces)) {
      warnings.push(`槽位名 "${name}" 被单引号包裹，应使用 \${${name}} 或 \${input.${name}}/\${output.${name}} 引用`);
    }
  }
}

/**
 * 校验正文中对 input/output 槽位的引用：必须为 ${name}、${input.name} 或 ${output.name}。
 * 返回 { errors: string[], warnings: string[] }，errors 带前缀 "[节点Id] 文件路径: "。
 */
function validatePlaceholdersInBody(nodeId, filePath, body, inputNames, outputNames) {
  const errors = [];
  const warnings = [];
  const inputSet = new Set(inputNames);
  const outputSet = new Set(outputNames);
  const placeholders = extractPlaceholders(body);

  for (const ph of placeholders) {
    if (ph.startsWith("input.")) {
      const name = ph.slice(6).trim();
      if (!name) {
        errors.push(`占位符 \${${ph}} 格式错误，应为 \${input.槽位名}`);
        continue;
      }
      if (!inputSet.has(name)) {
        if (outputSet.has(name)) {
          errors.push(`占位符 \${${ph}}：槽位 "${name}" 为 output，应使用 \${output.${name}} 或 \${${name}}`);
        } else {
          errors.push(`占位符 \${${ph}}：未定义的 input 槽位 "${name}"，应在 frontmatter 的 input 中声明`);
        }
      }
      continue;
    }
    if (ph.startsWith("output.")) {
      const name = ph.slice(7).trim();
      if (!name) {
        errors.push(`占位符 \${${ph}} 格式错误，应为 \${output.槽位名}`);
        continue;
      }
      if (!outputSet.has(name)) {
        if (inputSet.has(name)) {
          errors.push(`占位符 \${${ph}}：槽位 "${name}" 为 input，应使用 \${input.${name}} 或 \${${name}}`);
        } else {
          errors.push(`占位符 \${${ph}}：未定义的 output 槽位 "${name}"，应在 frontmatter 的 output 中声明`);
        }
      }
      continue;
    }
    // ${name} 形式：name 必须是 input 或 output 槽位名
    if (inputSet.has(ph) || outputSet.has(ph)) continue;
    // 非槽位名（如 USER_PROMPT）不报错，可选 warning
    if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(ph)) {
      warnings.push(`占位符 \${${ph}} 含非常规标识符，请确认是否为槽位引用`);
    }
  }

  // 若槽位名被 ` 或 " 或 ' 包裹而非 ${}，给出 warning
  warnSlotNameNotWrappedInDollarBraces(body, inputNames, outputNames, warnings);

  const prefix = `[${nodeId}] ${filePath}: `;
  return {
    errors: errors.map((e) => prefix + e),
    warnings: warnings.map((w) => prefix + w),
  };
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
 * 内部校验核心：接收 nodes、edges、flowDir、nodeIdToSlots 以及从 instances 取 description/body 的 getter（仅 flow.yaml）。
 */
function checkFlowCore(nodes, edges, flowDir, nodeIdToSlots, getInstanceDescription, getNodeBody) {
  const errors = [];
  const warnings = [];
  const fixesApplied = [];
  const nodeIds = new Set(nodes.map((n) => n.id));
  const nodesDir = path.join(flowDir, "..", "nodes");
  const builtInNodesDir = path.join(flowDir, "..", "..", "nodes");

  // 必须包含 control_start 与 control_end 各一
  const definitionIds = nodes.map((n) => n.definitionId).filter(Boolean);
  const hasStart = definitionIds.some((d) => d === "control_start");
  const hasEnd = definitionIds.some((d) => d === "control_end");
  if (!hasStart) errors.push("流程必须包含一个 definitionId 为 control_start 的节点");
  if (!hasEnd) errors.push("流程必须包含一个 definitionId 为 control_end 的节点");

  // 仅对内置节点做 description 一致性检查
  for (const n of nodes) {
    const defId = n.definitionId || "";
    if (!defId) continue;
    const builtInPath = path.join(builtInNodesDir, `${defId}.md`);
    if (!fs.existsSync(builtInPath)) continue;
    const descInstance = (getInstanceDescription(n) || "").trim();
    const descBuiltIn = getDescriptionFromFile(builtInPath);
    if (descBuiltIn === "") continue;
    if (descInstance !== descBuiltIn) {
      errors.push(
        `节点 "${n.id}"（instance）的 description 与内置节点 "${defId}" 的 description 不一致，应保持一致。当前 instance: "${descInstance || "(空)"}"，内置: "${descBuiltIn}"`
      );
    }
  }

  // 校验 edges：source、target 必须存在；sourceHandle/targetHandle 与槽位一致
  const edgesToFix = [];
  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (!e.source) errors.push(`edge ${i + 1}: 缺少 source`);
    else if (!nodeIds.has(e.source)) errors.push(`edge ${i + 1}: source "${e.source}" 不在 nodes 中`);
    if (!e.target) errors.push(`edge ${i + 1}: 缺少 target`);
    else if (!nodeIds.has(e.target)) errors.push(`edge ${i + 1}: target "${e.target}" 不在 nodes 中`);
    if (!e.sourceHandle && e.source) {
      warnings.push(`edge ${i + 1} (${e.source} -> ${e.target}): 缺少 sourceHandle，建议补全为 output-0`);
      edgesToFix.push({ i, field: "sourceHandle", value: "output-0" });
    }
    if (!e.targetHandle && e.target) {
      warnings.push(`edge ${i + 1} (${e.source} -> ${e.target}): 缺少 targetHandle，建议补全为 input-0`);
      edgesToFix.push({ i, field: "targetHandle", value: "input-0" });
    }

    // sourceHandle 必须在源节点的 output 槽位范围内
    if (e.source && nodeIds.has(e.source)) {
      const outSlots = nodeIdToSlots[e.source]?.outputNames ?? [];
      const maxOut = outSlots.length - 1;
      if (e.sourceHandle) {
        const outMatch = e.sourceHandle.match(/^output-(\d+)$/);
        if (!outMatch) {
          errors.push(`edge ${i + 1} (${e.source} -> ${e.target}): sourceHandle 应为 output-N 格式，当前为 "${e.sourceHandle}"`);
        } else {
          const idx = parseInt(outMatch[1], 10);
          if (idx < 0 || idx > maxOut) {
            const slotList = maxOut >= 0 ? outSlots.join(", ") : "（无 output 槽位）";
            const range = maxOut < 0 ? "（无有效 output 槽位）" : maxOut === 0 ? "output-0" : `output-0 ~ output-${maxOut}`;
            errors.push(
              `edge ${i + 1} (${e.source} -> ${e.target}): sourceHandle "${e.sourceHandle}" 超出源节点 output 槽位 [${slotList}]，有效范围: ${range}`
            );
          }
        }
      }
    }

    // targetHandle 必须在目标节点的 input 槽位范围内
    if (e.target && nodeIds.has(e.target)) {
      const inSlots = nodeIdToSlots[e.target]?.inputNames ?? [];
      const maxIn = inSlots.length - 1;
      if (e.targetHandle) {
        const inMatch = e.targetHandle.match(/^input-(\d+)$/);
        if (!inMatch) {
          errors.push(`edge ${i + 1} (${e.source} -> ${e.target}): targetHandle 应为 input-N 格式，当前为 "${e.targetHandle}"`);
        } else {
          const idx = parseInt(inMatch[1], 10);
          if (idx < 0 || idx > maxIn) {
            const slotList = maxIn >= 0 ? inSlots.join(", ") : "（无 input 槽位）";
            const range = maxIn < 0 ? "（无有效 input 槽位）" : maxIn === 0 ? "input-0" : `input-0 ~ input-${maxIn}`;
            errors.push(
              `edge ${i + 1} (${e.source} -> ${e.target}): targetHandle "${e.targetHandle}" 超出目标节点 input 槽位 [${slotList}]，有效范围: ${range}`
            );
          }
        }
      }
    }

    // 边两端槽位类型必须一致（节点↔节点、文本↔文本、文件↔文件）
    if (e.source && e.target && nodeIds.has(e.source) && nodeIds.has(e.target) && e.sourceHandle && e.targetHandle) {
      const outMatch = e.sourceHandle.match(/^output-(\d+)$/);
      const inMatch = e.targetHandle.match(/^input-(\d+)$/);
      if (outMatch && inMatch) {
        const outIdx = parseInt(outMatch[1], 10);
        const inIdx = parseInt(inMatch[1], 10);
        const srcSlots = nodeIdToSlots[e.source];
        const tgtSlots = nodeIdToSlots[e.target];
        const srcType = (srcSlots?.outputTypes?.[outIdx] ?? "").trim();
        const tgtType = (tgtSlots?.inputTypes?.[inIdx] ?? "").trim();
        if (srcType && tgtType && srcType !== tgtType) {
          const srcName = srcSlots?.outputNames?.[outIdx] ?? e.sourceHandle;
          const tgtName = tgtSlots?.inputNames?.[inIdx] ?? e.targetHandle;
          errors.push(
            `edge ${i + 1} (${e.source} -> ${e.target}): 槽位类型不一致，源 ${e.sourceHandle}（${srcName}）为「${srcType}」，目标 ${e.targetHandle}（${tgtName}）为「${tgtType}」，应同为 节点/文本/文件 之一`
          );
        }
      }
    }
  }

  // 若有 input 或 output 槽位，应有对应 edge 连接，否则 warning
  const incomingByNode = new Map(); // nodeId -> Set<targetHandle>
  const outgoingByNode = new Map(); // nodeId -> Set<sourceHandle>
  for (const e of edges) {
    if (e.target && nodeIds.has(e.target)) {
      if (!incomingByNode.has(e.target)) incomingByNode.set(e.target, new Set());
      if (e.targetHandle) incomingByNode.get(e.target).add(e.targetHandle);
    }
    if (e.source && nodeIds.has(e.source)) {
      if (!outgoingByNode.has(e.source)) outgoingByNode.set(e.source, new Set());
      if (e.sourceHandle) outgoingByNode.get(e.source).add(e.sourceHandle);
    }
  }
  for (const n of nodes) {
    const defId = n.definitionId || "";
    const slots = nodeIdToSlots[n.id] || { inputNames: [], outputNames: [] };
    const inCount = slots.inputNames.length;
    const outCount = slots.outputNames.length;
    // input 槽位：应有至少一条 edge 的 target 为该节点且 targetHandle 对应该槽位
    const skipInputCheck = defId === "control_start" || defId.startsWith("provide_");
    if (!skipInputCheck && inCount > 0) {
      for (let i = 0; i < inCount; i++) {
        const h = `input-${i}`;
        const hasIn = incomingByNode.get(n.id)?.has(h);
        if (!hasIn) {
          const slotName = slots.inputNames[i] || h;
          warnings.push(`节点 "${n.id}" 的 input 槽位 "${slotName}"（${h}）无对应 edge 连接`);
        }
      }
    }
    // output 槽位：应有至少一条 edge 的 source 为该节点且 sourceHandle 对应该槽位
    const skipOutputCheck = defId === "control_end";
    if (!skipOutputCheck && outCount > 0) {
      for (let i = 0; i < outCount; i++) {
        const h = `output-${i}`;
        const hasOut = outgoingByNode.get(n.id)?.has(h);
        if (!hasOut) {
          const slotName = slots.outputNames[i] || h;
          warnings.push(`节点 "${n.id}" 的 output 槽位 "${slotName}"（${h}）无对应 edge 连接`);
        }
      }
    }
  }

  // 节点正文中 input/output 槽位引用必须为 ${name}、${input.name}、${output.name}
  for (const n of nodes) {
    const slots = nodeIdToSlots[n.id] || { inputNames: [], outputNames: [] };
    const body = (getNodeBody(n) || "").trim();
    if (!body) continue;
    const fileLabel = `flow.yaml (${n.id})`;
    const { errors: placeErrors, warnings: placeWarnings } = validatePlaceholdersInBody(
      n.id,
      fileLabel,
      body,
      slots.inputNames,
      slots.outputNames
    );
    errors.push(...placeErrors);
    warnings.push(...placeWarnings);
  }

  // 拓扑序与环检测（支持环：有环时 order 为部分拓扑序，不报错）
  const { order, hasCycle } = topoSort(nodes, edges);
  const cycleNodes = hasCycle ? nodes.filter((n) => !order.includes(n.id)).map((n) => n.id) : [];

  // 节点可达性：仅沿「节点」类型边从 start 到 end 的链路；仅文件/文本边连接视为不可达
  const startNodes = nodes.filter((n) => n.definitionId === "control_start").map((n) => n.id);
  const endNodes = nodes.filter((n) => n.definitionId === "control_end").map((n) => n.id);
  const nodeOnlyEdges = [];
  for (const e of edges) {
    if (!e.source || !e.target || !nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
    const outMatch = e.sourceHandle?.match(/^output-(\d+)$/);
    const inMatch = e.targetHandle?.match(/^input-(\d+)$/);
    if (!outMatch || !inMatch) continue;
    const outIdx = parseInt(outMatch[1], 10);
    const inIdx = parseInt(inMatch[1], 10);
    const srcType = (nodeIdToSlots[e.source]?.outputTypes?.[outIdx] ?? "").trim();
    const tgtType = (nodeIdToSlots[e.target]?.inputTypes?.[inIdx] ?? "").trim();
    if (srcType === "节点" && tgtType === "节点") {
      nodeOnlyEdges.push({ source: e.source, target: e.target });
    }
  }
  const nodeReachable = new Set();
  const queue = [...startNodes];
  for (const id of startNodes) nodeReachable.add(id);
  while (queue.length) {
    const cur = queue.shift();
    for (const e of nodeOnlyEdges) {
      if (e.source !== cur || nodeReachable.has(e.target)) continue;
      nodeReachable.add(e.target);
      queue.push(e.target);
    }
  }
  if (endNodes.length > 0 && !endNodes.some((id) => nodeReachable.has(id))) {
    errors.push(
      "从 control_start 到 control_end 无纯「节点」边构成的路径（仅存在文件/文本边），图不可达。请为 start→end 中间节点补充节点类型（节点→节点）的 edge。"
    );
  }
  for (const n of nodes) {
    const defId = n.definitionId || "";
    if (defId === "control_start" || defId === "control_end" || defId.startsWith("provide_")) continue;
    if (!nodeReachable.has(n.id)) {
      warnings.push(
        `节点 "${n.id}"（${n.label || n.id}）无节点边可达：仅通过文件/文本边连接，缺少从 start 到该节点的节点链路，执行顺序无法保证`
      );
    }
  }

  // 有环时：环的入口节点（从环外进入环内的合并点）必须是 control_anyOne
  if (hasCycle && cycleNodes.length > 0) {
    const cycleSet = new Set(cycleNodes);
    const idToNode = new Map(nodes.map((n) => [n.id, n]));
    for (const nodeId of cycleNodes) {
      const incomingFromOutside = edges.filter((e) => e.target === nodeId && !cycleSet.has(e.source));
      if (incomingFromOutside.length > 0) {
        const node = idToNode.get(nodeId);
        const defId = node?.definitionId || "";
        if (defId !== "control_anyOne") {
          errors.push(
            `拓扑存在环时，环的入口节点必须是 control_anyOne。节点 "${nodeId}"（definitionId: ${defId}）有来自环外的入边，应改为 control_anyOne 节点。`
          );
        }
      }
    }
  }

  const unreachableNodeIds = nodes
    .filter(
      (n) =>
        n.definitionId &&
        n.definitionId !== "control_start" &&
        n.definitionId !== "control_end" &&
        !n.definitionId.startsWith("provide_") &&
        !nodeReachable.has(n.id)
    )
    .map((n) => n.id);

  const report = {
    nodesCount: nodes.length,
    edgesCount: edges.length,
    order,
    hasCycle,
    cycleNodes,
    hasStart,
    hasEnd,
    nodeReachable: nodeReachable.size,
    unreachableNodeIds,
  };

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    fixesApplied,
    report,
    nodes,
    edges,
    edgesToFix,
  };
}

function checkFlowFromYaml(flowDir) {
  const loaded = loadFlowYaml(flowDir);
  if (!loaded) {
    return { ok: false, errors: [`未找到 flow.yaml：${path.join(flowDir, "flow.yaml")}`], warnings: [], fixesApplied: [] };
  }
  const { nodes, edges, instances } = loaded;
  if (nodes.length === 0) {
    return { ok: false, errors: ["flow.yaml 必须包含 instances 且至少一个节点"], warnings: [], fixesApplied: [] };
  }
  const nodeIdToSlots = {};
  for (const n of nodes) {
    nodeIdToSlots[n.id] = getSlotsFromInstance(instances[n.id]);
  }
  const getInstanceDescription = (n) => (instances[n.id] && instances[n.id].description != null ? String(instances[n.id].description) : "");
  const getNodeBody = (n) => (instances[n.id] && instances[n.id].body != null ? String(instances[n.id].body) : "");
  return checkFlowCore(nodes, edges, flowDir, nodeIdToSlots, getInstanceDescription, getNodeBody);
}

function main() {
  const args = process.argv.slice(2);
  const rest = args.filter((a) => a !== "--fix");

  let flowDir;
  if (rest.length === 1) {
    const arg = rest[0];
    const p = path.resolve(arg);
    const hasFlowYaml = (dir) => fs.existsSync(path.join(dir, "flow.yaml"));
    if (path.basename(p) === "flow.yaml") {
      flowDir = path.dirname(p);
    } else if (hasFlowYaml(p)) {
      flowDir = p;
    } else {
      // 单参且路径下无 flow.yaml 时，视为 flowName，解析到 .cursor/agentflow/pipelines/<name>
      const cwd = process.cwd();
      const pipelinesDir = path.join(cwd, ".cursor", "agentflow", "pipelines", arg);
      if (hasFlowYaml(pipelinesDir)) {
        flowDir = pipelinesDir;
      } else {
        flowDir = p;
      }
    }
  } else if (rest.length >= 2) {
    const root = path.resolve(rest[0]);
    const name = rest[1];
    if (rest.length >= 3) {
      flowDir = path.resolve(root, rest[2]);
    } else {
      const hasFlowYaml = (dir) => fs.existsSync(path.join(dir, "flow.yaml"));
      const workspaceFlowDir = path.join(root, ".workspace", "agentflow", "pipelines", name);
      const cursorFlowDir = path.join(root, ".cursor", "agentflow", "pipelines", name);
      if (hasFlowYaml(workspaceFlowDir)) {
        flowDir = workspaceFlowDir;
      } else if (hasFlowYaml(cursorFlowDir)) {
        flowDir = cursorFlowDir;
      } else {
        flowDir = cursorFlowDir;
      }
    }
  } else {
    console.error(JSON.stringify({ ok: false, error: "Usage: agentflow apply -ai check-flow <workspaceRoot> <flowName> [flowDir] | agentflow apply -ai check-flow <flowYamlPath>" }));
    process.exit(1);
  }

  const result = checkFlowFromYaml(flowDir);
  if (result.fixesApplied === undefined) result.fixesApplied = [];
  delete result.edgesToFix;

  // 适配 agentflow apply -ai run-tool-nodejs：脚本执行成功则 err_code 恒为 0（有无 error/warning 不影响）；process.exit 仍按 result.ok 供 CLI 使用
  const resultPayload = {
    err_code: 0,
    message: { result: JSON.stringify(result, null, 2) },
  };
  console.log(JSON.stringify(resultPayload));
  process.exit(result.ok ? 0 : 1);
}

main();
