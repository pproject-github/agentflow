function isObjectLike(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

function stableStringify(value) {
  if (value == null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const obj = /** @type {Record<string, unknown>} */ (value);
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

function nodeSignature(node) {
  return stableStringify({
    id: node.id,
    type: node.type,
    position: node.position,
    data: node.data,
    parentId: node.parentId,
    extent: node.extent,
    sourcePosition: node.sourcePosition,
    targetPosition: node.targetPosition,
    hidden: node.hidden,
  });
}

export function buildStableEdgeKey(edge) {
  const sh = edge.sourceHandle ?? "";
  const th = edge.targetHandle ?? "";
  return `${edge.source}|${sh}|${edge.target}|${th}`;
}

function edgeSignature(edge) {
  return stableStringify({
    source: edge.source,
    target: edge.target,
    sourceHandle: edge.sourceHandle ?? null,
    targetHandle: edge.targetHandle ?? null,
    type: edge.type,
    label: edge.label,
    data: edge.data,
    markerStart: edge.markerStart,
    markerEnd: edge.markerEnd,
    animated: edge.animated,
    hidden: edge.hidden,
    style: edge.style,
  });
}

function withSelected(next, prev) {
  if (!isObjectLike(prev) || !("selected" in prev)) return next;
  if (prev.selected === next.selected) return next;
  return { ...next, selected: Boolean(prev.selected) };
}

function indexEdgesByStableKey(edges, throwOnDuplicate = false) {
  const map = new Map();
  for (const edge of edges) {
    const key = buildStableEdgeKey(edge);
    if (throwOnDuplicate && map.has(key)) {
      throw new Error(`存在重复连线键: ${key}`);
    }
    map.set(key, edge);
  }
  return map;
}

/**
 * 以节点 id 与稳定连线键为基准，复用未变化对象引用。
 * @param {import("@xyflow/react").Node[]} prevNodes
 * @param {import("@xyflow/react").Edge[]} prevEdges
 * @param {import("@xyflow/react").Node[]} nextNodes
 * @param {import("@xyflow/react").Edge[]} nextEdges
 */
export function reconcileFlowGraph(prevNodes, prevEdges, nextNodes, nextEdges) {
  const prevNodeById = new Map(prevNodes.map((node) => [node.id, node]));
  const nextNodeIds = new Set(nextNodes.map((node) => node.id));
  const reusedNodeIds = new Set();
  const addedNodeIds = [];
  const updatedNodeIds = [];
  const mergedNodes = nextNodes.map((nextNode) => {
    const prevNode = prevNodeById.get(nextNode.id);
    if (!prevNode) {
      addedNodeIds.push(nextNode.id);
      return nextNode;
    }
    if (nodeSignature(prevNode) === nodeSignature(nextNode)) {
      reusedNodeIds.add(nextNode.id);
      return prevNode;
    }
    updatedNodeIds.push(nextNode.id);
    return withSelected(nextNode, prevNode);
  });

  const prevEdgeByKey = indexEdgesByStableKey(prevEdges);
  const nextEdgeByKey = indexEdgesByStableKey(nextEdges, true);
  const reusedEdgeKeys = new Set();
  const addedEdgeKeys = [];
  const updatedEdgeKeys = [];
  const mergedEdges = nextEdges.map((nextEdge) => {
    const key = buildStableEdgeKey(nextEdge);
    const prevEdge = prevEdgeByKey.get(key);
    if (!prevEdge) {
      addedEdgeKeys.push(key);
      return nextEdge;
    }
    if (edgeSignature(prevEdge) === edgeSignature(nextEdge)) {
      reusedEdgeKeys.add(key);
      return prevEdge;
    }
    updatedEdgeKeys.push(key);
    return withSelected(nextEdge, prevEdge);
  });

  const removedNodeIds = prevNodes.filter((node) => !nextNodeIds.has(node.id)).map((node) => node.id);
  const removedEdgeKeys = prevEdges
    .map((edge) => buildStableEdgeKey(edge))
    .filter((key) => !nextEdgeByKey.has(key));

  return {
    nodes: mergedNodes,
    edges: mergedEdges,
    changes: {
      addedNodeIds,
      updatedNodeIds,
      removedNodeIds,
      addedEdgeKeys,
      updatedEdgeKeys,
      removedEdgeKeys,
    },
    stats: {
      nodeAdded: addedNodeIds.length,
      nodeRemoved: removedNodeIds.length,
      nodeReused: reusedNodeIds.size,
      edgeAdded: addedEdgeKeys.length,
      edgeRemoved: removedEdgeKeys.length,
      edgeReused: reusedEdgeKeys.size,
      nextEdgeCount: nextEdgeByKey.size,
    },
  };
}
