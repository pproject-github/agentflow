export function workspaceSubflowStartNodeId(subflowId) {
  return `subflow-start:${String(subflowId || "")}`;
}

export function workspaceSubflowReturnNodeId(subflowId) {
  return `subflow-return:${String(subflowId || "")}`;
}

function slotIndex(instance, direction, name) {
  const slots = Array.isArray(instance?.[direction]) ? instance[direction] : [];
  return slots.findIndex((slot) => String(slot?.name || "") === String(name || ""));
}

function slotNameFromHandle(instance, direction, handle) {
  const prefix = direction === "input" ? "input-" : "output-";
  const index = Number.parseInt(String(handle || "").replace(prefix, ""), 10);
  const slots = Array.isArray(instance?.[direction]) ? instance[direction] : [];
  return String(slots[Number.isFinite(index) ? index : 0]?.name || "");
}

function instanceLabel(instances, nodeId) {
  return String(instances?.[nodeId]?.label || nodeId || "Node");
}

function contractEntries(contract) {
  return Object.entries(contract || {}).map(([name, binding]) => ({
    name,
    type: String(binding?.type || "text"),
  }));
}

function outputBindingValue(instances, binding) {
  if (!binding?.nodeId || !binding?.slot) return undefined;
  const outputs = Array.isArray(instances?.[binding.nodeId]?.output) ? instances[binding.nodeId].output : [];
  const slot = outputs.find((item) => String(item?.name || "") === String(binding.slot));
  return slot?.value ?? slot?.default;
}

function jsonStatePreview(raw, sourceNodeId = "") {
  if (raw == null || raw === "") return null;
  try {
    const value = typeof raw === "string" ? JSON.parse(raw) : raw;
    if (!value || typeof value !== "object" || Array.isArray(value)) return { value, fields: [], sourceNodeId };
    return {
      value,
      sourceNodeId,
      fields: Object.entries(value).map(([name, fieldValue]) => ({
        name,
        type: Array.isArray(fieldValue) ? `array(${fieldValue.length})` : fieldValue === null ? "null" : typeof fieldValue,
        preview: typeof fieldValue === "object"
          ? JSON.stringify(fieldValue)
          : String(fieldValue),
      })),
    };
  } catch {
    return null;
  }
}

const WHILE_RUNTIME_CONTEXT_INPUTS = new Set(["iteration", "idempotencyKey"]);

/**
 * While supplies these values as execution context. They remain part of the
 * runtime/DSL contract, but are deliberately omitted from the product-facing
 * canvas so users only have to reason about business state.
 */
export function isRuntimeOnlyWhileInput(name) {
  return WHILE_RUNTIME_CONTEXT_INPUTS.has(String(name || ""));
}

/**
 * Build the UI-only mapping carried by a subflow call bus. These mappings explain
 * the call frame; they are not persisted graph edges and never affect execution.
 */
export function workspaceSubflowCallRelations(instances = {}, subflows = {}, edges = []) {
  const relations = [];
  const edgeList = Array.isArray(edges) ? edges : [];
  for (const [callerId, instance] of Object.entries(instances || {})) {
    const definitionId = String(instance?.definitionId || "");
    const descriptors = definitionId === "control_subflow_call"
      ? [{ kind: "call", role: "call", subflowId: String(instance?.subflowId || "") }]
      : definitionId === "control_while"
        ? [
            { kind: "while", role: "condition", subflowId: String(instance?.conditionSubflowId || "") },
            { kind: "while", role: "body", subflowId: String(instance?.bodySubflowId || "") },
          ]
        : [];
    for (const descriptor of descriptors) {
      const subflow = subflows?.[descriptor.subflowId];
      if (!descriptor.subflowId || !subflow) continue;
      const callerLabel = instanceLabel(instances, callerId);
      const subflowLabel = String(subflow?.label || descriptor.subflowId);
      const inputMappings = contractEntries(subflow.inputs)
        .filter(({ name }) => descriptor.kind !== "while" || !isRuntimeOnlyWhileInput(name))
        .map(({ name, type }) => {
          let from = `${callerLabel}.${name}`;
          let fromShort = descriptor.kind === "while" ? `While.${name}` : `Call.${name}`;
          let fromNodeId = callerId;
          if (descriptor.kind === "call") {
            const inputIndex = slotIndex(instance, "input", name);
            const incoming = inputIndex >= 0 ? edgeList.find((edge) => (
              String(edge?.target || "") === callerId && String(edge?.targetHandle || "") === `input-${inputIndex}`
            )) : null;
            if (incoming) {
              const sourceId = String(incoming.source || "");
              const sourceSlot = slotNameFromHandle(instances?.[sourceId], "output", incoming.sourceHandle) || "output";
              from = `${instanceLabel(instances, sourceId)}.${sourceSlot}`;
              fromShort = `${sourceId}.${sourceSlot}`;
              fromNodeId = sourceId;
            }
          }
          return {
            name,
            type,
            from,
            fromShort,
            to: `${subflowLabel}.${name}`,
            toShort: name,
            fromNodeId,
            toNodeId: workspaceSubflowStartNodeId(descriptor.subflowId),
          };
        });
      const outputMappings = contractEntries(subflow.outputs).map(({ name, type }) => ({
        name,
        type,
        from: `${subflowLabel}.${name}`,
        fromShort: name,
        to: `${callerLabel}.${name}`,
        toShort: descriptor.kind === "while" ? `While.${name}` : `Call.${name}`,
        fromNodeId: workspaceSubflowReturnNodeId(descriptor.subflowId),
        toNodeId: callerId,
      }));
      relations.push({
        id: descriptor.kind === "while"
          ? `while-subflow:${callerId}:${descriptor.role}:${descriptor.subflowId}`
          : `subflow-call:${callerId}:${descriptor.subflowId}`,
        kind: descriptor.kind,
        role: descriptor.role,
        callerId,
        callerLabel,
        subflowId: descriptor.subflowId,
        subflowLabel,
        inputMappings,
        outputMappings,
      });
    }
  }
  return relations;
}

function nodeSize(nodeId, sizes) {
  const size = sizes?.[nodeId] || {};
  return {
    width: Math.max(180, Number(size.width) || 320),
    height: Math.max(96, Number(size.height) || 96),
  };
}

function nodePosition(nodeId, positions) {
  const position = positions?.[nodeId] || {};
  return {
    x: Number(position.x) || 0,
    y: Number(position.y) || 0,
  };
}

function boundaryPosition(nodeId, positions, fallback) {
  const position = positions?.[nodeId];
  if (!position || !Number.isFinite(Number(position.x)) || !Number.isFinite(Number(position.y))) {
    return fallback;
  }
  return {
    x: Number(position.x),
    y: Number(position.y),
  };
}

function isInternalControlEdge(edge, memberSet, instances) {
  const source = String(edge?.source || "");
  const target = String(edge?.target || "");
  if (!memberSet.has(source) || !memberSet.has(target)) return false;
  const index = Number.parseInt(String(edge?.sourceHandle || "").replace("output-", ""), 10);
  const outputs = Array.isArray(instances?.[source]?.output) ? instances[source].output : [];
  return String(outputs[index]?.name || "") === "next";
}

function boundaryNode({ id, kind, subflowId, subflowLabel, subflowRole, label, position, width, height, contract, inputs, outputs, callRelations, fixedContract = false, statePreview = null }) {
  return {
    id,
    type: "flowNode",
    position,
    width,
    height,
    draggable: true,
    deletable: false,
    selectable: true,
    zIndex: 2,
    data: {
      isSubflowBoundary: true,
      boundaryKind: kind,
      subflowId,
      subflowLabel,
      subflowRole,
      label,
      title: label,
      contract,
      callRelations,
      fixedContract,
      statePreview,
      inputs,
      outputs,
      nodeSize: { width, height },
    },
  };
}

/**
 * Project the implicit call-frame entry/return into explanatory canvas nodes.
 * The returned nodes and edges are UI-only and must never be persisted to the DSL graph.
 */
export function buildWorkspaceSubflowProjection({
  instances = {},
  subflows = {},
  edges = [],
  positions = {},
  sizes = {},
  boundaryPositions = {},
} = {}) {
  const nodes = [];
  const virtualEdges = [];
  const groupMemberIds = {};
  const hiddenNodeIds = new Set();
  const hiddenInputHandles = new Set();
  const callRelations = workspaceSubflowCallRelations(instances, subflows, edges);

  for (const [subflowId, subflow] of Object.entries(subflows || {})) {
    const memberIds = (Array.isArray(subflow?.nodeIds) ? subflow.nodeIds : [])
      .map(String)
      .filter((nodeId) => instances?.[nodeId]);
    const memberSet = new Set(memberIds);
    const roots = (Array.isArray(subflow?.roots) ? subflow.roots : [])
      .map(String)
      .filter((nodeId) => memberSet.has(nodeId));
    if (!memberIds.length) continue;
    const referencedByWhile = callRelations.some((relation) => relation.subflowId === subflowId && relation.kind === "while");
    if (!roots.length && !referencedByWhile) continue;

    const inputContract = Object.entries(subflow?.inputs || {}).map(([name, binding]) => ({
      name,
      type: String(binding?.type || "text"),
      nodeId: String(binding?.nodeId || ""),
      slot: String(binding?.slot || ""),
    }));
    let outputContract = Object.entries(subflow?.outputs || {}).map(([name, binding]) => ({
      name,
      type: String(binding?.type || "text"),
      nodeId: String(binding?.nodeId || ""),
      slot: String(binding?.slot || ""),
    }));
    const subflowCallRelations = callRelations.filter((relation) => relation.subflowId === subflowId);
    const isWhileSubflow = subflowCallRelations.some((relation) => relation.kind === "while");
    const whileCallRelation = subflowCallRelations.find((relation) => relation.kind === "while");
    const subflowRole = whileCallRelation?.role || "call";
    if (isWhileSubflow) {
      const fixedOutputs = subflowRole === "condition"
        ? [{ name: "decision", type: "text", required: true }, { name: "summary", type: "text", required: false }]
        : [{ name: "state", type: "json", required: true }, { name: "summary", type: "text", required: false }];
      outputContract = fixedOutputs.map((fixed) => {
        const binding = outputContract.find((item) => item.name === fixed.name);
        return { ...fixed, ...(binding || {}) };
      });
    }
    const visibleInputContract = inputContract.filter((binding) => (
      !isWhileSubflow || !isRuntimeOnlyWhileInput(binding.name)
    ));
    const internalControlEdges = (Array.isArray(edges) ? edges : [])
      .filter((edge) => isInternalControlEdge(edge, memberSet, instances));
    const hasOutgoingControl = new Set(internalControlEdges.map((edge) => String(edge.source)));
    const executableMembers = memberIds.filter((nodeId) => (
      String(instances?.[nodeId]?.definitionId || "") !== "workspace_subflow_input"
    ));
    const leaves = executableMembers.filter((nodeId) => !hasOutgoingControl.has(nodeId));
    const returnSources = leaves.length
      ? leaves
      : Array.from(new Set(outputContract.map((binding) => binding.nodeId).filter((nodeId) => memberSet.has(nodeId))));

    const positionedMembers = memberIds.filter((nodeId) => positions?.[nodeId]);
    const layoutRoots = roots.length ? roots : positionedMembers;
    const rootPositions = layoutRoots.map((nodeId) => nodePosition(nodeId, positions));
    const startWidth = 340;
    const startInputCount = 1;
    const startOutputCount = 1 + visibleInputContract.length;
    const startHeight = Math.max(112, 72 + Math.max(startInputCount, startOutputCount) * 24);
    const rootCenterY = layoutRoots.length ? layoutRoots.reduce((sum, nodeId) => {
      const position = nodePosition(nodeId, positions);
      return sum + position.y + nodeSize(nodeId, sizes).height / 2;
    }, 0) / layoutRoots.length : 220;
    const derivedStartPosition = {
      x: rootPositions.length
        ? Math.round(Math.min(...rootPositions.map((position) => position.x)) - startWidth - 80)
        : 80,
      y: Math.round(rootCenterY - startHeight / 2),
    };
    const sourceIds = returnSources.length ? returnSources : layoutRoots;
    const returnWidth = 340;
    const returnInputCount = 1 + outputContract.length + (isWhileSubflow ? 0 : 1);
    const returnHeight = Math.max(112, 72 + returnInputCount * 24);
    const sourceCenterY = sourceIds.length ? sourceIds.reduce((sum, nodeId) => {
      const position = nodePosition(nodeId, positions);
      return sum + position.y + nodeSize(nodeId, sizes).height / 2;
    }, 0) / sourceIds.length : rootCenterY;
    const derivedReturnPosition = {
      x: sourceIds.length ? Math.round(Math.max(...sourceIds.map((nodeId) => {
        const position = nodePosition(nodeId, positions);
        return position.x + nodeSize(nodeId, sizes).width;
      })) + 110) : 820,
      y: Math.round(sourceCenterY - returnHeight / 2),
    };

    const startId = workspaceSubflowStartNodeId(subflowId);
    const returnId = workspaceSubflowReturnNodeId(subflowId);
    const startPosition = boundaryPosition(startId, boundaryPositions, derivedStartPosition);
    const returnPosition = boundaryPosition(returnId, boundaryPositions, derivedReturnPosition);
    nodes.push(boundaryNode({
      id: startId,
      kind: "start",
      subflowId,
      subflowLabel: String(subflow?.label || subflowId),
      subflowRole,
      label: "Subflow Start",
      position: startPosition,
      width: startWidth,
      height: startHeight,
      contract: visibleInputContract.map(({ name, type }) => ({ name, type })),
      inputs: [{ name: "calls", type: "node" }],
      outputs: [
        { name: "next", type: "node" },
        ...visibleInputContract.map(({ name, type }) => ({ name, type })),
      ],
      callRelations: subflowCallRelations,
    }));
    nodes.push(boundaryNode({
      id: returnId,
      kind: "return",
      subflowId,
      subflowLabel: String(subflow?.label || subflowId),
      subflowRole,
      label: "Subflow Return",
      position: returnPosition,
      width: returnWidth,
      height: returnHeight,
      contract: outputContract.map(({ name, type, required, nodeId }) => ({
        name,
        type,
        ...(required !== undefined ? { required } : {}),
        ...(isWhileSubflow ? { connected: Boolean(nodeId) } : {}),
      })),
      inputs: [
        { name: "prev", type: "node" },
        ...outputContract.map(({ name, type, required }) => ({
          name,
          type,
          ...(required !== undefined ? { required } : {}),
        })),
        ...(!isWhileSubflow ? [{ name: "add output", type: "any", addOutput: true }] : []),
      ],
      outputs: [],
      callRelations: subflowCallRelations,
      fixedContract: isWhileSubflow,
      statePreview: subflowRole === "body"
        ? jsonStatePreview(
            outputBindingValue(instances, subflow?.outputs?.state)
            ?? outputBindingValue(instances, { nodeId: whileCallRelation?.callerId, slot: "state" }),
            subflow?.outputs?.state?.nodeId || whileCallRelation?.callerId || "",
          )
        : null,
    }));
    groupMemberIds[subflowId] = [startId, returnId];

    const inputBindingByProviderSlot = new Map(inputContract.map((binding) => [
      `${binding.nodeId}\u0000${binding.slot}`,
      {
        ...binding,
        visibleContractIndex: visibleInputContract.findIndex((item) => item.name === binding.name),
      },
    ]));
    const inputProviderIds = new Set(inputContract
      .map((binding) => binding.nodeId)
      .filter((nodeId) => (
        memberSet.has(nodeId)
        && String(instances?.[nodeId]?.definitionId || "") === "workspace_subflow_input"
      )));
    for (const providerId of inputProviderIds) {
      const outgoing = (Array.isArray(edges) ? edges : []).filter((edge) => String(edge?.source || "") === providerId);
      const canProjectEveryEdge = outgoing.every((edge) => {
        if (!memberSet.has(String(edge?.target || ""))) return false;
        const outputIndex = Number.parseInt(String(edge?.sourceHandle || "").replace("output-", ""), 10);
        const slotName = String(instances?.[providerId]?.output?.[outputIndex]?.name || "");
        return inputBindingByProviderSlot.has(`${providerId}\u0000${slotName}`);
      });
      if (!canProjectEveryEdge) continue;
      hiddenNodeIds.add(providerId);
      outgoing.forEach((edge, edgeIndex) => {
        const outputIndex = Number.parseInt(String(edge?.sourceHandle || "").replace("output-", ""), 10);
        const slotName = String(instances?.[providerId]?.output?.[outputIndex]?.name || "");
        const binding = inputBindingByProviderSlot.get(`${providerId}\u0000${slotName}`);
        if (!binding) return;
        if (binding.visibleContractIndex < 0) {
          hiddenInputHandles.add(`${String(edge.target)}\u0000${String(edge.targetHandle || "")}`);
          return;
        }
        virtualEdges.push({
          id: `subflow-start-data:${subflowId}:${binding.name}:${edgeIndex}`,
          source: startId,
          target: String(edge.target),
          sourceHandle: `output-${binding.visibleContractIndex + 1}`,
          targetHandle: edge.targetHandle ?? undefined,
          data: { virtualSubflowBoundary: true, boundaryEdgeKind: "data" },
        });
      });
    }

    roots.forEach((rootId, index) => {
      const prevIndex = slotIndex(instances[rootId], "input", "prev");
      if (prevIndex < 0) return;
      virtualEdges.push({
        id: `subflow-start-edge:${subflowId}:${rootId}:${index}`,
        source: startId,
        target: rootId,
        sourceHandle: "output-0",
        targetHandle: `input-${prevIndex}`,
        data: { virtualSubflowBoundary: true, boundaryEdgeKind: "control" },
      });
    });

    sourceIds.forEach((sourceId, index) => {
      const nextIndex = slotIndex(instances[sourceId], "output", "next");
      if (nextIndex < 0) return;
      virtualEdges.push({
        id: `subflow-return-control:${subflowId}:${sourceId}:${index}`,
        source: sourceId,
        target: returnId,
        sourceHandle: `output-${nextIndex}`,
        targetHandle: "input-0",
        data: { virtualSubflowBoundary: true, boundaryEdgeKind: "control" },
      });
    });

    outputContract.forEach((binding, index) => {
      if (!memberSet.has(binding.nodeId)) return;
      const outputIndex = slotIndex(instances[binding.nodeId], "output", binding.slot);
      if (outputIndex < 0) return;
      virtualEdges.push({
        id: `subflow-return-data:${subflowId}:${binding.name}:${index}`,
        source: binding.nodeId,
        target: returnId,
        sourceHandle: `output-${outputIndex}`,
        targetHandle: `input-${index + 1}`,
        data: { virtualSubflowBoundary: true, boundaryEdgeKind: "data" },
      });
    });
  }

  return {
    nodes,
    edges: virtualEdges,
    groupMemberIds,
    hiddenNodeIds: Array.from(hiddenNodeIds),
    hiddenInputHandles: Array.from(hiddenInputHandles),
  };
}
