/**
 * 与 bin/pipeline/validate-flow.mjs 中 checkFlowCore 的槽位-edge 检查保持一致（input/output 无连线警告）。
 * 仅含可运行于浏览器的纯逻辑，修改时请同步更新 validate-flow.mjs。
 */

/**
 * @param {import('@xyflow/react').Node} n
 * @returns {{ inputNames: string[], outputNames: string[] }}
 */
export function getSlotsFromNodeData(n) {
  const result = { inputNames: [], outputNames: [] };
  const inp = Array.isArray(n.data?.inputs) ? n.data.inputs : [];
  const out = Array.isArray(n.data?.outputs) ? n.data.outputs : [];
  for (let i = 0; i < inp.length; i++) {
    const slot = inp[i];
    const name = (slot && slot.name != null ? String(slot.name).trim() : "") || `input-${i}`;
    result.inputNames.push(name);
  }
  for (let i = 0; i < out.length; i++) {
    const slot = out[i];
    const name = (slot && slot.name != null ? String(slot.name).trim() : "") || `output-${i}`;
    result.outputNames.push(name);
  }
  return result;
}

/**
 * @typedef {{ nodeId: string, suffix: string, key: string }} SlotEdgeWarningItem
 */

/**
 * @param {import('@xyflow/react').Node[]} nodes
 * @param {import('@xyflow/react').Edge[]} edges
 * @returns {SlotEdgeWarningItem[]}
 */
export function computeSlotEdgeWarnings(nodes, edges, t) {
  const nodeIds = new Set(nodes.map((n) => n.id));
  /** @type {Record<string, { inputNames: string[], outputNames: string[] }>} */
  const nodeIdToSlots = {};
  for (const n of nodes) {
    nodeIdToSlots[n.id] = getSlotsFromNodeData(n);
  }

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

  /** @type {SlotEdgeWarningItem[]} */
  const warnings = [];
  for (const n of nodes) {
    const defId = n.data?.definitionId != null ? String(n.data.definitionId) : "";
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
          warnings.push({
            nodeId: n.id,
            suffix: t("flow:validation.inputSlotNoEdge", { slotName, handle: h }),
            key: `${n.id}-${h}-in`,
          });
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
          warnings.push({
            nodeId: n.id,
            suffix: t("flow:validation.outputSlotNoEdge", { slotName, handle: h }),
            key: `${n.id}-${h}-out`,
          });
        }
      }
    }
  }

  return warnings;
}
