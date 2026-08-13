import {
  isRuntimeOnlyWhileInput,
  workspaceSubflowReturnNodeId,
  workspaceSubflowStartNodeId,
} from "./workspaceSubflowProjection.js";

function slotIndex(instance, direction, name) {
  const slots = Array.isArray(instance?.[direction]) ? instance[direction] : [];
  return slots.findIndex((slot) => String(slot?.name || "") === String(name || ""));
}

function handleIndex(handle, prefix) {
  const index = Number.parseInt(String(handle || "").replace(prefix, ""), 10);
  return Number.isFinite(index) ? index : -1;
}

function uniqueId(base, used) {
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${base}_${index}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

function inputProxy(id, subflowId, name, type) {
  return {
    definitionId: "workspace_subflow_input",
    label: name,
    subflowId,
    subflowInputName: name,
    subflowInputType: type,
    input: [],
    output: [{ type, name: "value", value: "" }],
  };
}

export function createWhileSubflowScaffold({ whileId, instance, instances = {}, subflows = {} }) {
  const id = String(whileId || "").trim();
  if (!id) return null;
  const used = new Set([...Object.keys(instances), ...Object.keys(subflows)]);
  const conditionId = uniqueId(`${id}Condition`, used);
  const bodyId = uniqueId(`${id}Body`, used);
  const conditionStateId = uniqueId(`${id}_condition_state`, used);
  const conditionIterationId = uniqueId(`${id}_condition_iteration`, used);
  const bodyStateId = uniqueId(`${id}_body_state`, used);
  const bodyIterationId = uniqueId(`${id}_body_iteration`, used);
  const bodyIdempotencyKeyId = uniqueId(`${id}_body_idempotency_key`, used);
  const createdInstances = {
    [conditionStateId]: inputProxy(conditionStateId, conditionId, "state", "json"),
    [conditionIterationId]: inputProxy(conditionIterationId, conditionId, "iteration", "text"),
    [bodyStateId]: inputProxy(bodyStateId, bodyId, "state", "json"),
    [bodyIterationId]: inputProxy(bodyIterationId, bodyId, "iteration", "text"),
    [bodyIdempotencyKeyId]: inputProxy(bodyIdempotencyKeyId, bodyId, "idempotencyKey", "text"),
  };
  return {
    instance: {
      ...(instance || {}),
      conditionSubflowId: conditionId,
      bodySubflowId: bodyId,
    },
    instances: createdInstances,
    subflows: {
      [conditionId]: {
        id: conditionId,
        label: "判断是否继续",
        inputs: {
          state: { nodeId: conditionStateId, slot: "value", type: "json" },
          iteration: { nodeId: conditionIterationId, slot: "value", type: "text" },
        },
        outputs: {},
        roots: [],
        nodeIds: [conditionStateId, conditionIterationId],
      },
      [bodyId]: {
        id: bodyId,
        label: "执行一轮",
        inputs: {
          state: { nodeId: bodyStateId, slot: "value", type: "json" },
          iteration: { nodeId: bodyIterationId, slot: "value", type: "text" },
          idempotencyKey: { nodeId: bodyIdempotencyKeyId, slot: "value", type: "text" },
        },
        outputs: {},
        roots: [],
        nodeIds: [bodyStateId, bodyIterationId, bodyIdempotencyKeyId],
      },
    },
  };
}

export function addNodeToSubflow(subflows = {}, subflowId, nodeId) {
  const id = String(subflowId || "");
  const subflow = subflows?.[id];
  if (!subflow || !nodeId) return subflows;
  return {
    ...subflows,
    [id]: {
      ...subflow,
      nodeIds: Array.from(new Set([...(subflow.nodeIds || []), String(nodeId)])),
    },
  };
}

export function renameSubflowOutput(subflows = {}, subflowId, oldName, newName) {
  const id = String(subflowId || "");
  const from = String(oldName || "").trim();
  const to = String(newName || "").trim();
  const subflow = subflows?.[id];
  if (!subflow || !from || !subflow.outputs?.[from]) return { subflows, error: "输出变量不存在" };
  if (!to) return { subflows, error: "输出变量名不能为空" };
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(to)) {
    return { subflows, error: "输出变量名只能使用字母、数字、_ 或 $，且不能以数字开头" };
  }
  if (to !== from && subflow.outputs?.[to]) return { subflows, error: `输出变量 ${to} 已存在` };
  if (to === from) return { subflows };
  const outputs = Object.fromEntries(Object.entries(subflow.outputs || {}).map(([name, binding]) => (
    name === from ? [to, binding] : [name, binding]
  )));
  return {
    subflows: { ...subflows, [id]: { ...subflow, outputs } },
  };
}

export function removeSubflowOutput(subflows = {}, subflowId, name) {
  const id = String(subflowId || "");
  const outputName = String(name || "").trim();
  const subflow = subflows?.[id];
  if (!subflow || !outputName || !subflow.outputs?.[outputName]) return { subflows, error: "输出变量不存在" };
  return {
    subflows: {
      ...subflows,
      [id]: {
        ...subflow,
        outputs: Object.fromEntries(Object.entries(subflow.outputs || {}).filter(([key]) => key !== outputName)),
      },
    },
  };
}

export function reconcileSubflowCallOutputs(graph, subflowId, renameMap = {}) {
  const id = String(subflowId || "");
  const subflow = graph?.subflows?.[id];
  if (!graph || !subflow) return graph;
  const next = typeof structuredClone === "function" ? structuredClone(graph) : JSON.parse(JSON.stringify(graph));
  const callers = new Set();
  for (const [nodeId, instance] of Object.entries(next.instances || {})) {
    if (String(instance?.definitionId || "") !== "control_subflow_call" || String(instance?.subflowId || "") !== id) continue;
    callers.add(String(nodeId));
    const oldOutputs = Array.isArray(instance.output) ? instance.output : [];
    const controlOutputs = oldOutputs.filter((slot) => String(slot?.type || "") === "node");
    if (!controlOutputs.length) controlOutputs.push({ name: "next", type: "node", value: "" });
    const oldByName = new Map(oldOutputs.map((slot) => [String(slot?.name || ""), slot]));
    const dataOutputs = Object.entries(subflow.outputs || {}).map(([name, binding]) => {
      const previousName = Object.entries(renameMap || {}).find(([, renamed]) => String(renamed) === name)?.[0] || name;
      const previous = oldByName.get(previousName) || oldByName.get(name) || {};
      return {
        ...previous,
        name,
        type: String(binding?.type || previous?.type || "text"),
        value: previous?.value ?? previous?.default ?? "",
      };
    });
    instance.output = [...controlOutputs, ...dataOutputs];

    next.edges = (next.edges || []).flatMap((edge) => {
      if (String(edge?.source || "") !== String(nodeId)) return [edge];
      const oldIndex = handleIndex(edge.sourceHandle, "output-");
      const oldSlot = oldOutputs[oldIndex];
      if (!oldSlot) return [];
      const renamed = renameMap?.[String(oldSlot.name || "")] || String(oldSlot.name || "");
      const newIndex = instance.output.findIndex((slot) => String(slot?.name || "") === renamed);
      return newIndex < 0 ? [] : [{ ...edge, sourceHandle: `output-${newIndex}` }];
    });
  }
  return callers.size ? next : graph;
}

export function whileSubflowContract(role, subflow = {}) {
  const condition = role === "condition";
  const inputNames = condition ? ["state"] : ["state"];
  const outputSpecs = condition
    ? [{ name: "decision", type: "text", required: true }, { name: "summary", type: "text", required: false }]
    : [{ name: "state", type: "json", required: true }, { name: "summary", type: "text", required: false }];
  const inputs = inputNames.map((name) => ({
    name,
    type: String(subflow?.inputs?.[name]?.type || "json"),
    required: true,
  }));
  const outputs = outputSpecs.map((spec) => ({
    ...spec,
    connected: Boolean(subflow?.outputs?.[spec.name]?.nodeId),
  }));
  return { inputs, outputs };
}

export function applySubflowBoundaryConnection({ graph, params, sourceNode, targetNode, activeSubflowId = "" }) {
  if (!graph || !params) return { handled: false, graph };
  const sourceBoundary = sourceNode?.data?.isSubflowBoundary ? sourceNode.data : null;
  const targetBoundary = targetNode?.data?.isSubflowBoundary ? targetNode.data : null;
  if (!sourceBoundary && !targetBoundary) return { handled: false, graph };
  const subflowId = String(sourceBoundary?.subflowId || targetBoundary?.subflowId || activeSubflowId || "");
  const subflow = graph?.subflows?.[subflowId];
  if (!subflow) return { handled: true, error: "子流程不存在", graph };
  const memberSet = new Set((subflow.nodeIds || []).map(String));
  const next = typeof structuredClone === "function" ? structuredClone(graph) : JSON.parse(JSON.stringify(graph));
  const nextSubflow = next.subflows[subflowId];

  if (sourceBoundary?.boundaryKind === "start" && !targetBoundary) {
    if (!memberSet.has(String(params.target || ""))) return { handled: true, error: "只能连接当前子流程中的节点", graph };
    const outputIndex = handleIndex(params.sourceHandle, "output-");
    if (outputIndex === 0) {
      const prevIndex = slotIndex(next.instances?.[params.target], "input", "prev");
      if (prevIndex < 0 || String(params.targetHandle || "") !== `input-${prevIndex}`) {
        return { handled: true, error: "START.next 只能连接节点的 prev", graph };
      }
      nextSubflow.roots = Array.from(new Set([...(nextSubflow.roots || []), String(params.target)]));
      return { handled: true, graph: next };
    }
    const visibleInputs = Object.entries(nextSubflow.inputs || {})
      .filter(([name]) => !isRuntimeOnlyWhileInput(name));
    const [name, binding] = visibleInputs[outputIndex - 1] || [];
    if (!name || !binding?.nodeId) return { handled: true, error: "未知的 START 输入端口", graph };
    const targetIndex = handleIndex(params.targetHandle, "input-");
    const targetSlot = next.instances?.[params.target]?.input?.[targetIndex];
    if (!targetSlot || String(targetSlot.type || "") !== String(binding.type || "text")) {
      return { handled: true, error: `类型不兼容：${binding.type || "text"}`, graph };
    }
    next.edges = (next.edges || []).filter((edge) => !(
      String(edge.target) === String(params.target) && String(edge.targetHandle || "") === String(params.targetHandle || "")
    ));
    next.edges.push({
      source: String(binding.nodeId),
      target: String(params.target),
      sourceHandle: "output-0",
      targetHandle: String(params.targetHandle),
    });
    return { handled: true, graph: next };
  }

  if (targetBoundary?.boundaryKind === "return" && !sourceBoundary) {
    if (!memberSet.has(String(params.source || ""))) return { handled: true, error: "只能从当前子流程中的节点返回", graph };
    const inputIndex = handleIndex(params.targetHandle, "input-");
    if (inputIndex === 0) {
      const nextIndex = slotIndex(next.instances?.[params.source], "output", "next");
      if (nextIndex < 0 || String(params.sourceHandle || "") !== `output-${nextIndex}`) {
        return { handled: true, error: "RETURN.prev 只能接节点的 next", graph };
      }
      const hasInternalSuccessor = (next.edges || []).some((edge) => (
        String(edge?.source || "") === String(params.source || "")
        && String(edge?.sourceHandle || "") === `output-${nextIndex}`
        && memberSet.has(String(edge?.target || ""))
      ));
      if (hasInternalSuccessor) {
        return { handled: true, error: "RETURN.prev 只能从子流程的末端节点连入", graph };
      }
      return { handled: true, graph: next };
    }
    const role = String(targetBoundary.subflowRole || "call");
    const contract = role === "condition"
      ? [{ name: "decision", type: "text" }, { name: "summary", type: "text" }]
      : role === "body"
        ? [{ name: "state", type: "json" }, { name: "summary", type: "text" }]
        : (targetBoundary.contract || []);
    if (role === "call" && inputIndex === contract.length + 1) {
      const sourceIndex = handleIndex(params.sourceHandle, "output-");
      const sourceSlot = next.instances?.[params.source]?.output?.[sourceIndex];
      if (!sourceSlot || String(sourceSlot.type || "") === "node") {
        return { handled: true, error: "请把数据输出连到 ADD OUTPUT", graph };
      }
      const usedNames = new Set(Object.keys(nextSubflow.outputs || {}));
      const base = String(sourceSlot.name || "output").replace(/[^A-Za-z0-9_$]/g, "_") || "output";
      const safeBase = /^[A-Za-z_$]/.test(base) ? base : `output_${base}`;
      const name = uniqueId(safeBase, usedNames);
      nextSubflow.outputs = {
        ...(nextSubflow.outputs || {}),
        [name]: {
          nodeId: String(params.source),
          slot: String(sourceSlot.name || ""),
          type: String(sourceSlot.type || "text"),
        },
      };
      return { handled: true, graph: reconcileSubflowCallOutputs(next, subflowId), addedOutputName: name };
    }
    const output = contract[inputIndex - 1];
    const sourceIndex = handleIndex(params.sourceHandle, "output-");
    const sourceSlot = next.instances?.[params.source]?.output?.[sourceIndex];
    if (!output || !sourceSlot || String(sourceSlot.type || "") !== String(output.type || "text")) {
      return { handled: true, error: `返回值类型不兼容：需要 ${output?.type || "unknown"}`, graph };
    }
    nextSubflow.outputs = {
      ...(nextSubflow.outputs || {}),
      [output.name]: {
        nodeId: String(params.source),
        slot: String(sourceSlot.name || ""),
        type: String(output.type || "text"),
      },
    };
    return { handled: true, graph: next };
  }

  return { handled: true, error: "子流程边界只支持 START → 节点，或节点 → RETURN", graph };
}

export function activeSubflowCanvas({ nodes = [], edges = [], subflow = null, subflowId = "" }) {
  if (!subflow || !subflowId) return { nodes, edges };
  const ids = new Set([
    ...(subflow.nodeIds || []).map(String),
    workspaceSubflowStartNodeId(subflowId),
    workspaceSubflowReturnNodeId(subflowId),
  ]);
  const visibleNodes = nodes.filter((node) => ids.has(String(node.id)) && !node?.data?.isSubflowInputProxy);
  const visibleIds = new Set(visibleNodes.map((node) => String(node.id)));
  return {
    nodes: visibleNodes,
    edges: edges.filter((edge) => visibleIds.has(String(edge.source)) && visibleIds.has(String(edge.target))),
  };
}

/**
 * Keep implementation details of every subflow out of the parent graph view.
 * The graph state remains complete; this only controls what React Flow renders.
 */
export function parentWorkspaceCanvas({ nodes = [], edges = [], subflows = {} }) {
  const memberIds = new Set(Object.values(subflows || {}).flatMap((subflow) => (
    Array.isArray(subflow?.nodeIds) ? subflow.nodeIds.map(String) : []
  )));
  const visibleNodes = nodes.filter((node) => (
    !memberIds.has(String(node?.id || ""))
    && !node?.data?.isSubflowBoundary
    && !node?.data?.isSubflowGroup
  ));
  const visibleIds = new Set(visibleNodes.map((node) => String(node.id)));
  return {
    nodes: visibleNodes,
    edges: edges.filter((edge) => (
      visibleIds.has(String(edge?.source || ""))
      && visibleIds.has(String(edge?.target || ""))
      && !edge?.data?.virtualSubflowBoundary
      && !edge?.data?.virtualSubflowCall
    )),
  };
}
