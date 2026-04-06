/**
 * Composer 脚本操作层：直接用 Node.js 修改 flow.yaml，无需 AI。
 * 适用于确定性操作（改 label、body、role、value、连线、位置等）。
 */
import fs from "fs";
import yaml from "js-yaml";

// ─── YAML 读写 ─────────────────────────────────────────────────────────────

function readFlowYaml(flowYamlAbs) {
  const raw = fs.readFileSync(flowYamlAbs, "utf-8");
  const doc = yaml.load(raw);
  if (!doc || typeof doc !== "object") throw new Error("flow.yaml 解析失败或为空");
  return { doc, raw };
}

function writeFlowYaml(flowYamlAbs, doc) {
  const out = yaml.dump(doc, {
    lineWidth: -1,
    noRefs: true,
    quotingType: "'",
    forceQuotes: false,
    sortKeys: false,
  });
  fs.writeFileSync(flowYamlAbs, out, "utf-8");
}

function ensureInstances(doc) {
  if (!doc.instances || typeof doc.instances !== "object") {
    doc.instances = {};
  }
  return doc.instances;
}

function ensureEdges(doc) {
  if (!Array.isArray(doc.edges)) doc.edges = [];
  return doc.edges;
}

function ensureUi(doc) {
  if (!doc.ui || typeof doc.ui !== "object") doc.ui = {};
  if (!doc.ui.nodePositions || typeof doc.ui.nodePositions !== "object") doc.ui.nodePositions = {};
  return doc.ui;
}

// ─── 操作实现 ──────────────────────────────────────────────────────────────

function opEditLabel(doc, params) {
  const inst = ensureInstances(doc);
  const { instanceId, value } = params;
  if (!inst[instanceId]) throw new Error(`实例 ${instanceId} 不存在`);
  inst[instanceId].label = value;
  return `节点 ${instanceId} 的 label 已改为「${value}」`;
}

function opEditBody(doc, params) {
  const inst = ensureInstances(doc);
  const { instanceId, value } = params;
  if (!inst[instanceId]) throw new Error(`实例 ${instanceId} 不存在`);
  inst[instanceId].body = value;
  return `节点 ${instanceId} 的 body 已更新`;
}

function opEditScript(doc, params) {
  const inst = ensureInstances(doc);
  const { instanceId, value } = params;
  if (!inst[instanceId]) throw new Error(`实例 ${instanceId} 不存在`);
  if (inst[instanceId].definitionId !== "tool_nodejs") {
    throw new Error(`节点 ${instanceId} 的 definitionId 不是 tool_nodejs，不能设置 script 字段`);
  }
  inst[instanceId].script = value;
  return `节点 ${instanceId} 的 script 已更新`;
}

function opEditRole(doc, params) {
  const inst = ensureInstances(doc);
  const { instanceId, value } = params;
  if (!inst[instanceId]) throw new Error(`实例 ${instanceId} 不存在`);
  inst[instanceId].role = value;
  return `节点 ${instanceId} 的 role 已改为「${value}」`;
}

function opEditModel(doc, params) {
  const inst = ensureInstances(doc);
  const { instanceId, value } = params;
  if (!inst[instanceId]) throw new Error(`实例 ${instanceId} 不存在`);
  inst[instanceId].model = value;
  return `节点 ${instanceId} 的 model 已改为「${value}」`;
}

function opEditInputValue(doc, params) {
  const inst = ensureInstances(doc);
  const { instanceId, inputName, value } = params;
  if (!inst[instanceId]) throw new Error(`实例 ${instanceId} 不存在`);
  const inputs = inst[instanceId].input;
  if (!Array.isArray(inputs)) throw new Error(`实例 ${instanceId} 没有 input 数组`);
  const slot = inputs.find((s) => s.name === inputName);
  if (!slot) throw new Error(`实例 ${instanceId} 没有名为 ${inputName} 的输入`);
  slot.value = value;
  return `节点 ${instanceId} 输入 ${inputName} 的 value 已更新`;
}

function opEditOutputValue(doc, params) {
  const inst = ensureInstances(doc);
  const { instanceId, outputName, value } = params;
  if (!inst[instanceId]) throw new Error(`实例 ${instanceId} 不存在`);
  const outputs = inst[instanceId].output;
  if (!Array.isArray(outputs)) throw new Error(`实例 ${instanceId} 没有 output 数组`);
  const slot = outputs.find((s) => s.name === outputName);
  if (!slot) throw new Error(`实例 ${instanceId} 没有名为 ${outputName} 的输出`);
  slot.value = value;
  return `节点 ${instanceId} 输出 ${outputName} 的 value 已更新`;
}

function opAddEdge(doc, params) {
  const edges = ensureEdges(doc);
  const { source, target, sourceHandle, targetHandle } = params;
  if (!source || !target) throw new Error("连线需要 source 和 target");
  const exists = edges.some(
    (e) =>
      e.source === source &&
      e.target === target &&
      (!sourceHandle || e.sourceHandle === sourceHandle) &&
      (!targetHandle || e.targetHandle === targetHandle),
  );
  if (exists) return `边 ${source} → ${target} 已存在，跳过`;
  const edge = { source, target };
  if (sourceHandle) edge.sourceHandle = sourceHandle;
  if (targetHandle) edge.targetHandle = targetHandle;
  edges.push(edge);
  return `已添加边 ${source} → ${target}`;
}

function opRemoveEdge(doc, params) {
  const edges = ensureEdges(doc);
  const { source, target, sourceHandle, targetHandle } = params;
  const before = edges.length;
  const filtered = edges.filter((e) => {
    if (source && e.source !== source) return true;
    if (target && e.target !== target) return true;
    if (sourceHandle && e.sourceHandle !== sourceHandle) return true;
    if (targetHandle && e.targetHandle !== targetHandle) return true;
    return false;
  });
  doc.edges = filtered;
  const removed = before - filtered.length;
  return removed > 0 ? `已删除 ${removed} 条边` : "未找到匹配的边";
}

function opUpdatePosition(doc, params) {
  const ui = ensureUi(doc);
  const { instanceId, x, y } = params;
  if (!ui.nodePositions[instanceId]) ui.nodePositions[instanceId] = {};
  if (x != null) ui.nodePositions[instanceId].x = Number(x);
  if (y != null) ui.nodePositions[instanceId].y = Number(y);
  return `节点 ${instanceId} 位置已更新为 (${x}, ${y})`;
}

const OP_HANDLERS = {
  "edit-label": opEditLabel,
  "edit-body": opEditBody,
  "edit-script": opEditScript,
  "edit-role": opEditRole,
  "edit-model": opEditModel,
  "edit-input-value": opEditInputValue,
  "edit-output-value": opEditOutputValue,
  "add-edge": opAddEdge,
  "remove-edge": opRemoveEdge,
  "update-position": opUpdatePosition,
};

// ─── 公开接口 ──────────────────────────────────────────────────────────────

/**
 * 执行一个 script 类型步骤。
 * @param {string} flowYamlAbs flow.yaml 绝对路径
 * @param {{ op: string, params: object }} step
 * @returns {{ success: boolean, message: string }}
 */
export function executeScriptOp(flowYamlAbs, step) {
  const handler = OP_HANDLERS[step.op];
  if (!handler) {
    return { success: false, message: `未知操作: ${step.op}` };
  }
  try {
    const { doc } = readFlowYaml(flowYamlAbs);
    const message = handler(doc, step.params || {});
    writeFlowYaml(flowYamlAbs, doc);
    return { success: true, message };
  } catch (e) {
    return { success: false, message: e.message || String(e) };
  }
}

/**
 * 批量执行多个 script 操作（共享一次 YAML 读写）。
 * @param {string} flowYamlAbs
 * @param {Array<{ op: string, params: object }>} steps
 * @returns {Array<{ success: boolean, message: string }>}
 */
export function executeScriptOpsBatch(flowYamlAbs, steps) {
  const { doc } = readFlowYaml(flowYamlAbs);
  const results = [];
  for (const step of steps) {
    const handler = OP_HANDLERS[step.op];
    if (!handler) {
      results.push({ success: false, message: `未知操作: ${step.op}` });
      continue;
    }
    try {
      const message = handler(doc, step.params || {});
      results.push({ success: true, message });
    } catch (e) {
      results.push({ success: false, message: e.message || String(e) });
    }
  }
  writeFlowYaml(flowYamlAbs, doc);
  return results;
}

/**
 * 检查一个操作名称是否属于已支持的 script 操作。
 */
export function isSupportedScriptOp(op) {
  return op in OP_HANDLERS;
}

/**
 * 返回所有支持的 script 操作名称列表。
 */
export function listScriptOps() {
  return Object.keys(OP_HANDLERS);
}
