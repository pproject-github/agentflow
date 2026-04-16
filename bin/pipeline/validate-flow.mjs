#!/usr/bin/env node
/**
 * 统一流程校验：合并 check-flow 与 validate-for-ui 逻辑（最大集）。
 * 用法：agentflow apply -ai validate-flow <workspaceRoot> <flowName> <flowDir> [uuid]
 * 或由 agentflow validate <FlowName> [uuid] 调用；传 uuid 时写入 runDir/intermediate/validation.json。
 * 输出：stdout 单行 JSON { ok, errors, warnings, validation: { edgeTypeMismatch, nodeRoleMissing, nodeModelMissing }, report? }
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";

import { getModelListsAbs, getRunDir, getUserAgentsJsonAbs, getUserPipelinesRoot } from "../lib/paths.mjs";
import { getFlowDir } from "../lib/workspace.mjs";

/** 槽位合法 type 集合（英文为 builtin/nodes 标准；中文为遗留兼容，新写代码统一英文） */
const VALID_SLOT_TYPES = new Set(["node", "text", "file", "bool", "节点", "文本", "文件", "布尔"]);
const CANONICAL_SLOT_TYPES = "node|text|file|bool";

/** 与前端 flowFormat.VALID_ROLES + 内置 id 一致 */
const VALID_ROLE_KEYS = ["requirement", "planning", "code", "test", "normal"];
const ROLE_ZH_TO_KEY = {
  需求拆解: "requirement",
  技术规划: "planning",
  代码执行: "code",
  测试回归: "test",
  普通: "normal",
};
const VALID_ROLES = new Set([
  ...VALID_ROLE_KEYS,
  ...Object.keys(ROLE_ZH_TO_KEY),
  "前端/UI",
  "agentflow-node-executor-requirement",
  "agentflow-node-executor-planning",
  "agentflow-node-executor-code",
  "agentflow-node-executor-test",
  "agentflow-node-executor",
  "agentflow-node-executor-ui",
]);

/** 由 definitionId 推导 type（与 parse-flow 一致） */
function definitionIdToType(definitionId) {
  const id = (definitionId || "").toLowerCase();
  if (id.startsWith("control_")) return "control";
  if (id.startsWith("agent_")) return "agent";
  if (id.startsWith("provide_")) return "provide";
  if (id.startsWith("tool_")) return "agent";
  return "agent";
}

function getSlotsFromInstance(inst) {
  const result = { inputNames: [], outputNames: [], inputTypes: [], outputTypes: [] };
  if (!inst || typeof inst !== "object") return result;
  const inp = Array.isArray(inst.input) ? inst.input : [];
  const out = Array.isArray(inst.output) ? inst.output : [];
  for (let i = 0; i < inp.length; i++) {
    const slot = inp[i];
    const name = (slot && slot.name != null ? String(slot.name).trim() : "") || `input-${i}`;
    const type = slot && (slot.type != null) ? String(slot.type).trim() : "";
    result.inputNames.push(name);
    result.inputTypes.push(type);
  }
  for (let i = 0; i < out.length; i++) {
    const slot = out[i];
    const name = (slot && slot.name != null ? String(slot.name).trim() : "") || `output-${i}`;
    const type = slot && (slot.type != null) ? String(slot.type).trim() : "";
    result.outputNames.push(name);
    result.outputTypes.push(type);
  }
  return result;
}

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

function loadModelLists(_workspaceRoot) {
  const p = getModelListsAbs();
  if (!fs.existsSync(p)) return { cursor: [], opencode: [] };
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    return {
      cursor: Array.isArray(data.cursor) ? data.cursor : [],
      opencode: Array.isArray(data.opencode) ? data.opencode : [],
    };
  } catch {
    return { cursor: [], opencode: [] };
  }
}

function loadCustomRoleIds(_workspaceRoot) {
  const agentsPath = getUserAgentsJsonAbs();
  if (!fs.existsSync(agentsPath)) return new Set();
  try {
    const data = JSON.parse(fs.readFileSync(agentsPath, "utf-8"));
    const list = Array.isArray(data) ? data : (data.agents || []);
    return new Set(list.filter((a) => a && typeof a.id === "string" && a.id.trim()).map((a) => a.id.trim()));
  } catch {
    return new Set();
  }
}

function toEdgeId(e) {
  return `${e.source}__${e.sourceHandle || "output-0"}__${e.target}__${e.targetHandle || "input-0"}`;
}

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

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
    if (inputSet.has(ph) || outputSet.has(ph)) continue;
    if (!/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(ph)) {
      warnings.push(`占位符 \${${ph}} 含非常规标识符，请确认是否为槽位引用`);
    }
  }
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
 * 结构校验核心（不含边类型一致，边类型由下方 computeValidation 统一产出）。
 */
function checkFlowCore(nodes, edges, flowDir, nodeIdToSlots, getNodeBody, instances = null) {
  const errors = [];
  const warnings = [];
  const nodeIds = new Set(nodes.map((n) => n.id));

  /* 提醒：input/output 槽位未填写 name 时建议补全，便于引用 */
  if (instances && typeof instances === "object") {
    for (const n of nodes) {
      const inst = instances[n.id];
      if (!inst) continue;
      const inp = Array.isArray(inst.input) ? inst.input : [];
      const out = Array.isArray(inst.output) ? inst.output : [];
      inp.forEach((slot, i) => {
        const name = slot && slot.name != null ? String(slot.name).trim() : "";
        if (!name) warnings.push(`节点 "${n.id}" 的 input 第 ${i + 1} 项未填写 name，建议补全（如 value）以便 \${name} 引用`);
      });
      out.forEach((slot, i) => {
        const name = slot && slot.name != null ? String(slot.name).trim() : "";
        if (!name) warnings.push(`节点 "${n.id}" 的 output 第 ${i + 1} 项未填写 name，建议补全（如 value）以便 \${name} 引用`);
      });
    }
  }

  const definitionIds = nodes.map((n) => n.definitionId).filter(Boolean);
  const hasStart = definitionIds.some((d) => d === "control_start");
  const hasEnd = definitionIds.some((d) => d === "control_end");
  if (!hasStart) errors.push("流程必须包含一个 definitionId 为 control_start 的节点");
  if (!hasEnd) errors.push("流程必须包含一个 definitionId 为 control_end 的节点");

  for (let i = 0; i < edges.length; i++) {
    const e = edges[i];
    if (!e.source) errors.push(`edge ${i + 1}: 缺少 source`);
    else if (!nodeIds.has(e.source)) errors.push(`edge ${i + 1}: source "${e.source}" 不在 nodes 中`);
    if (!e.target) errors.push(`edge ${i + 1}: 缺少 target`);
    else if (!nodeIds.has(e.target)) errors.push(`edge ${i + 1}: target "${e.target}" 不在 nodes 中`);
    if (!e.sourceHandle && e.source) {
      warnings.push(`edge ${i + 1} (${e.source} -> ${e.target}): 缺少 sourceHandle，建议补全为 output-0`);
    }
    if (!e.targetHandle && e.target) {
      warnings.push(`edge ${i + 1} (${e.source} -> ${e.target}): 缺少 targetHandle，建议补全为 input-0`);
    }

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
    // 边类型一致检查（同 type 才能连）
    if (
      e.source && e.target &&
      nodeIds.has(e.source) && nodeIds.has(e.target) &&
      e.sourceHandle && e.targetHandle
    ) {
      const outMatch = e.sourceHandle.match(/^output-(\d+)$/);
      const inMatch = e.targetHandle.match(/^input-(\d+)$/);
      if (outMatch && inMatch) {
        const outIdx = parseInt(outMatch[1], 10);
        const inIdx = parseInt(inMatch[1], 10);
        const srcSlots = nodeIdToSlots[e.source];
        const tgtSlots = nodeIdToSlots[e.target];
        const srcType = (srcSlots?.outputTypes?.[outIdx] ?? "").trim();
        const tgtType = (tgtSlots?.inputTypes?.[inIdx] ?? "").trim();
        // 中文别名归一化（兼容旧画布）
        const norm = (t) => {
          if (t === "节点") return "node";
          if (t === "文本") return "text";
          if (t === "文件") return "file";
          if (t === "布尔") return "bool";
          return t;
        };
        const sNorm = norm(srcType);
        const tNorm = norm(tgtType);
        if (sNorm && tNorm && sNorm !== tNorm) {
          const srcSlotName = srcSlots?.outputNames?.[outIdx] ?? `output-${outIdx}`;
          const tgtSlotName = tgtSlots?.inputNames?.[inIdx] ?? `input-${inIdx}`;
          errors.push(
            `edge ${i + 1}: 边类型不匹配 — ${e.source}.${srcSlotName}:${sNorm} → ${e.target}.${tgtSlotName}:${tNorm}（不允许跨类型连线，type 必须一致）`
          );
        }
      }
    }
  }

  /* 槽位与 edge 对应：Web UI 同步逻辑见 builtin/web-ui/src/flowSlotEdgeWarnings.js（computeSlotEdgeWarnings） */
  const incomingByNode = new Map();
  const outgoingByNode = new Map();
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

  if (instances && typeof instances === "object") {
    for (const n of nodes) {
      const inst = instances[n.id];
      if (!inst) continue;
      const defId = inst.definitionId || n.definitionId || "";

      // tool_nodejs 必须有 script
      if (defId === "tool_nodejs") {
        const script = inst.script != null ? String(inst.script).trim() : "";
        const body = inst.body != null ? String(inst.body).trim() : "";
        if (!script && body) {
          errors.push(
            `节点 "${n.id}"（tool_nodejs）缺少 script 字段：body 中的自然语言不会被执行，必须添加可执行的 script，或改用 agent_subAgent`
          );
        } else if (!script && !body) {
          errors.push(
            `节点 "${n.id}"（tool_nodejs）既无 script 也无 body，节点无法执行，必须添加 script 字段`
          );
        }
      }

      // provide_str / provide_file output 类型校验
      const normType = (t) => {
        if (t === "节点") return "node";
        if (t === "文本") return "text";
        if (t === "文件") return "file";
        if (t === "布尔") return "bool";
        return (t || "").trim();
      };
      if (defId === "provide_str") {
        const out = Array.isArray(inst.output) ? inst.output : [];
        if (out.length !== 1) {
          errors.push(`节点 "${n.id}"（provide_str）output 必须仅有 1 个槽位（value:text），当前 ${out.length} 个`);
        } else {
          const t0 = normType(out[0] && out[0].type);
          if (t0 !== "text") {
            errors.push(`节点 "${n.id}"（provide_str）output[0].type 必须为 \`text\`，当前为 \`${t0 || "(空)"}\``);
          }
        }
      }
      if (defId === "provide_file") {
        const out = Array.isArray(inst.output) ? inst.output : [];
        if (out.length !== 1) {
          errors.push(`节点 "${n.id}"（provide_file）output 必须仅有 1 个槽位（value:file），当前 ${out.length} 个`);
        } else {
          const t0 = normType(out[0] && out[0].type);
          if (t0 !== "file") {
            errors.push(`节点 "${n.id}"（provide_file）output[0].type 必须为 \`file\`，当前为 \`${t0 || "(空)"}\``);
          }
        }
      }
    }
  }

  const { order, hasCycle } = topoSort(nodes, edges);
  const cycleNodes = hasCycle ? nodes.filter((n) => !order.includes(n.id)).map((n) => n.id) : [];

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
    if ((srcType === "node" || srcType === "节点") && (tgtType === "node" || tgtType === "节点")) {
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
  const nodeReachableOptional = (defId) =>
    defId === "control_start" || defId === "control_end" || defId.startsWith("provide_") || defId === "tool_load_key" || defId === "tool_save_key" || defId === "tool_get_env";
  for (const n of nodes) {
    const defId = n.definitionId || "";
    if (nodeReachableOptional(defId)) continue;
    if (!nodeReachable.has(n.id)) {
      warnings.push(
        `节点 "${n.id}"（${n.label || n.id}）无节点边可达：仅通过文件/文本边连接，缺少从 start 到该节点的节点链路，执行顺序无法保证`
      );
    }
  }

  if (hasCycle && cycleNodes.length > 0) {
    const cycleSet = new Set(cycleNodes);
    const idToNode = new Map(nodes.map((n) => [n.id, n]));
    for (const nodeId of cycleNodes) {
      // 仅看「节点→节点」边：上游是 provide_file 等时不算环外入边，避免误判
      const incomingFromOutside = nodeOnlyEdges.filter((e) => e.target === nodeId && !cycleSet.has(e.source));
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
        !nodeReachableOptional(n.definitionId) &&
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

  return { errors, warnings, report };
}

/**
 * 产出 edgeTypeMismatch、nodeRoleMissing、nodeModelMissing（供前端标红），并返回对应 errors 文案。
 */
function computeValidation(loaded, workspaceRoot) {
  const { nodes, edges, instances } = loaded;
  const edgeTypeMismatch = [];
  const nodeRoleMissing = [];
  const nodeModelMissing = [];
  const validationErrors = [];

  const nodeIds = new Set(nodes.map((n) => n.id));
  const nodeIdToSlots = {};
  for (const n of nodes) {
    nodeIdToSlots[n.id] = getSlotsFromInstance(instances[n.id]);
  }

  for (const e of edges) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
    const sh = e.sourceHandle ?? "output-0";
    const th = e.targetHandle ?? "input-0";
    const outMatch = sh.match(/^output-(\d+)$/);
    const inMatch = th.match(/^input-(\d+)$/);
    if (!outMatch || !inMatch) continue;
    const outIdx = parseInt(outMatch[1], 10);
    const inIdx = parseInt(inMatch[1], 10);
    const srcSlots = nodeIdToSlots[e.source];
    const tgtSlots = nodeIdToSlots[e.target];
    const srcType = (srcSlots?.outputTypes?.[outIdx] ?? "").trim();
    const tgtType = (tgtSlots?.inputTypes?.[inIdx] ?? "").trim();
    if (srcType && tgtType && srcType !== tgtType) {
      const edgeId = toEdgeId({ ...e, sourceHandle: sh, targetHandle: th });
      edgeTypeMismatch.push(edgeId);
      validationErrors.push(`边类型不一致: ${e.source} ${sh} -> ${e.target} ${th}`);
    }
  }

  // 槽位 type 白名单：拒绝 "string"/"str"/"文字" 等非法值，避免下游 type 比较静默失配
  for (const n of nodes) {
    const slots = nodeIdToSlots[n.id];
    if (!slots) continue;
    const checkSlot = (kind, idx, type) => {
      const t = (type || "").trim();
      if (t === "" || VALID_SLOT_TYPES.has(t)) return;
      validationErrors.push(
        `节点 "${n.id}" ${kind}-${idx} 的 type "${t}" 非法（合法值：${CANONICAL_SLOT_TYPES}）`
      );
    };
    (slots.outputTypes || []).forEach((t, i) => checkSlot("output", i, t));
    (slots.inputTypes || []).forEach((t, i) => checkSlot("input", i, t));
  }

  // provide_* 仅作数据源，不得连入控制链（node→node 边）
  for (const e of edges) {
    if (!nodeIds.has(e.source) || !nodeIds.has(e.target)) continue;
    const sh = e.sourceHandle ?? "output-0";
    const th = e.targetHandle ?? "input-0";
    const outIdx = parseInt((sh.match(/^output-(\d+)$/) || [])[1] ?? "-1", 10);
    const inIdx = parseInt((th.match(/^input-(\d+)$/) || [])[1] ?? "-1", 10);
    if (outIdx < 0 || inIdx < 0) continue;
    const srcDef = (instances[e.source]?.definitionId || "").trim();
    const tgtDef = (instances[e.target]?.definitionId || "").trim();
    const srcType = (nodeIdToSlots[e.source]?.outputTypes?.[outIdx] ?? "").trim();
    const tgtType = (nodeIdToSlots[e.target]?.inputTypes?.[inIdx] ?? "").trim();
    const isNodeEdge = (srcType === "node" || srcType === "节点") && (tgtType === "node" || tgtType === "节点");
    if (!isNodeEdge) continue;
    if (srcDef.startsWith("provide_") || tgtDef.startsWith("provide_")) {
      validationErrors.push(
        `provide_* 节点不得出现在控制链上（node→node 边）：${e.source} ${sh} -> ${e.target} ${th}；provide 仅作数据源，请改连下游 text/file 数据槽`
      );
    }
  }

  const validRoles = new Set(VALID_ROLES);
  if (workspaceRoot) {
    for (const id of loadCustomRoleIds(workspaceRoot)) validRoles.add(id);
  }
  for (const n of nodes) {
    const role = (instances[n.id] && instances[n.id].role != null) ? String(instances[n.id].role).trim() : "";
    if (role && !validRoles.has(role)) {
      nodeRoleMissing.push(n.id);
      validationErrors.push(`节点角色未配置或不在允许列表: ${n.id}`);
    }
  }

  const root = workspaceRoot ? path.resolve(workspaceRoot) : path.dirname(loaded._flowDir || ".");
  const { cursor: cursorList, opencode: opencodeList } = loadModelLists(root);
  const opencodeSet = new Set((opencodeList || []).map((s) => String(s).trim()));
  const cursorSet = new Set(
    (cursorList || []).map((s) => {
      const t = String(s).trim();
      const first = t.split(/\s+-/)[0].trim();
      return first || t;
    })
  );
  for (const n of nodes) {
    const model = (instances[n.id] && instances[n.id].model != null) ? String(instances[n.id].model).trim() : "";
    if (!model) continue;
    let valid = false;
    if (model.startsWith("opencode:")) {
      valid = opencodeSet.has(model.slice(9).trim());
    } else {
      const cursorId = model.startsWith("cursor:") ? model.slice(7).trim() : model;
      valid = cursorSet.has(cursorId) || (cursorList || []).some((c) => String(c).trim() === model || String(c).trim().startsWith(cursorId + " "));
    }
    if (!valid) {
      nodeModelMissing.push(n.id);
      validationErrors.push(`节点模型未配置或不在模型列表: ${n.id}`);
    }
  }

  return {
    validation: { edgeTypeMismatch, nodeRoleMissing, nodeModelMissing },
    validationErrors,
  };
}

export function runValidateFlow(flowDir, workspaceRoot) {
  const loaded = loadFlowYaml(flowDir);
  if (!loaded) {
    return {
      ok: false,
      errors: [`未找到 flow.yaml：${path.join(flowDir, "flow.yaml")}`],
      warnings: [],
      validation: { edgeTypeMismatch: [], nodeRoleMissing: [], nodeModelMissing: [] },
      report: null,
    };
  }
  const { nodes, edges, instances } = loaded;
  if (nodes.length === 0) {
    return {
      ok: false,
      errors: ["flow.yaml 必须包含 instances 且至少一个节点"],
      warnings: [],
      validation: { edgeTypeMismatch: [], nodeRoleMissing: [], nodeModelMissing: [] },
      report: null,
    };
  }

  const nodeIdToSlots = {};
  for (const n of nodes) {
    nodeIdToSlots[n.id] = getSlotsFromInstance(instances[n.id]);
  }
  const getNodeBody = (n) => (instances[n.id] && instances[n.id].body != null ? String(instances[n.id].body) : "");

  const { errors: structureErrors, warnings, report } = checkFlowCore(nodes, edges, flowDir, nodeIdToSlots, getNodeBody, instances);

  loaded._flowDir = flowDir;
  const { validation, validationErrors } = computeValidation(loaded, workspaceRoot);

  const errors = [...structureErrors, ...validationErrors];
  const ok = errors.length === 0;

  return {
    ok,
    errors,
    warnings,
    validation,
    report,
  };
}

function resolveFlowDir(workspaceRoot, flowName, flowDirArg) {
  if (flowDirArg != null && flowDirArg !== "") {
    const p = path.resolve(flowDirArg);
    if (fs.existsSync(path.join(p, "flow.yaml"))) return p;
  }
  const found = getFlowDir(workspaceRoot, flowName);
  if (found) return found;
  return path.join(getUserPipelinesRoot(), flowName);
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.length < 2) {
    console.error(JSON.stringify({ ok: false, error: "Usage: validate-flow.mjs <workspaceRoot> <flowName> [flowDir] [uuid]" }));
    process.exit(1);
  }
  const workspaceRoot = path.resolve(argv[0]);
  const flowName = argv[1];
  let flowDirArg = argv[2];
  let uuid = null;
  if (argv.length >= 4 && /^\d{14}$/.test(String(argv[3]).trim())) {
    uuid = String(argv[3]).trim();
  } else if (argv.length === 3 && /^\d{14}$/.test(String(argv[2]).trim())) {
    uuid = String(argv[2]).trim();
    flowDirArg = null;
  }
  const flowDir = resolveFlowDir(workspaceRoot, flowName, flowDirArg);

  if (!fs.existsSync(path.join(flowDir, "flow.yaml"))) {
    console.error(JSON.stringify({ ok: false, error: "flow.yaml not found in " + flowDir }));
    process.exit(1);
  }

  const result = runValidateFlow(flowDir, workspaceRoot);

  if (uuid && flowName) {
    const runDir = getRunDir(workspaceRoot, flowName, uuid);
    const intermediateDir = path.join(runDir, "intermediate");
    try {
      fs.mkdirSync(intermediateDir, { recursive: true });
      fs.writeFileSync(path.join(intermediateDir, "validation.json"), JSON.stringify(result, null, 2), "utf-8");
    } catch (err) {
      console.error(JSON.stringify({ ok: false, error: err.message }));
      process.exit(1);
    }
  }

  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}

const isValidateFlowCli =
  process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isValidateFlowCli) {
  main();
}
