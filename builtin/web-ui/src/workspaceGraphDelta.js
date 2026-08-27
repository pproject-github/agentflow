function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

export function workspaceValueEqual(left, right) {
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function graphInstances(graph) {
  return isObject(graph?.instances) ? graph.instances : {};
}

function graphUi(graph) {
  return isObject(graph?.ui) ? graph.ui : {};
}

function objectWithoutKeys(value, knownKeys) {
  if (!isObject(value)) return {};
  const known = new Set(knownKeys);
  return Object.fromEntries(
    Object.entries(value).filter(([key]) => !known.has(key)),
  );
}

function hasSafeGraphShape(baseGraph, nextGraph) {
  if (!isObject(baseGraph) || !isObject(nextGraph)) return false;
  if (!isObject(baseGraph.instances) || !isObject(nextGraph.instances)) return false;
  if (!Array.isArray(baseGraph.edges) || !Array.isArray(nextGraph.edges)) return false;
  if (!isObject(baseGraph.ui) || !isObject(nextGraph.ui)) return false;
  if (Number(baseGraph.version || 1) !== Number(nextGraph.version || 1)) return false;
  const unknownTopLevelBase = objectWithoutKeys(baseGraph, ["version", "instances", "edges", "ui"]);
  const unknownTopLevelNext = objectWithoutKeys(nextGraph, ["version", "instances", "edges", "ui"]);
  if (!workspaceValueEqual(unknownTopLevelBase, unknownTopLevelNext)) return false;
  const knownUiKeys = ["nodePositions", "nodeSizes", "groups", "displayPage", "viewport", "subflowBoundaryPositions"];
  return workspaceValueEqual(
    objectWithoutKeys(baseGraph.ui, knownUiKeys),
    objectWithoutKeys(nextGraph.ui, knownUiKeys),
  );
}

function graphGroupsById(graph) {
  const groups = Array.isArray(graphUi(graph).groups) ? graphUi(graph).groups : [];
  return new Map(
    groups
      .filter((group) => group?.id)
      .map((group) => [String(group.id), group]),
  );
}

function graphNodeIds(graph) {
  const ids = new Set(Object.keys(graphInstances(graph)));
  for (const edge of Array.isArray(graph?.edges) ? graph.edges : []) {
    if (edge?.source) ids.add(String(edge.source));
    if (edge?.target) ids.add(String(edge.target));
  }
  for (const id of graphGroupsById(graph).keys()) ids.add(id);
  for (const id of Object.keys(isObject(graphUi(graph).subflowBoundaryPositions)
    ? graphUi(graph).subflowBoundaryPositions
    : {})) ids.add(id);
  return ids;
}

function graphNodeRecord(graph, id) {
  const instances = graphInstances(graph);
  const ui = graphUi(graph);
  const groups = graphGroupsById(graph);
  return {
    instance: Object.prototype.hasOwnProperty.call(instances, id) ? instances[id] : null,
    position: isObject(ui.nodePositions) && Object.prototype.hasOwnProperty.call(ui.nodePositions, id)
      ? ui.nodePositions[id]
      : null,
    size: isObject(ui.nodeSizes) && Object.prototype.hasOwnProperty.call(ui.nodeSizes, id)
      ? ui.nodeSizes[id]
      : null,
    boundaryPosition: isObject(ui.subflowBoundaryPositions) && Object.prototype.hasOwnProperty.call(ui.subflowBoundaryPositions, id)
      ? ui.subflowBoundaryPositions[id]
      : null,
    group: groups.get(id) || null,
  };
}

function normalizedEdges(graph) {
  return (Array.isArray(graph?.edges) ? graph.edges : [])
    .map((edge) => ({ ...edge }))
    .sort((left, right) => {
      const leftKey = [
        left.source,
        left.target,
        left.sourceHandle,
        left.targetHandle,
        left.id,
      ].map((value) => String(value ?? "")).join("\u0000");
      const rightKey = [
        right.source,
        right.target,
        right.sourceHandle,
        right.targetHandle,
        right.id,
      ].map((value) => String(value ?? "")).join("\u0000");
      return leftKey.localeCompare(rightKey);
    });
}

export function diffWorkspaceGraphsForUi(baseGraph, nextGraph) {
  if (!hasSafeGraphShape(baseGraph, nextGraph)) {
    return {
      safe: false,
      changedNodeIds: [],
      nodesChanged: true,
      edgesChanged: true,
      displayPageChanged: true,
    };
  }
  const ids = new Set([...graphNodeIds(baseGraph), ...graphNodeIds(nextGraph)]);
  const changedNodeIds = Array.from(ids).filter(
    (id) => !workspaceValueEqual(graphNodeRecord(baseGraph, id), graphNodeRecord(nextGraph, id)),
  );
  return {
    safe: true,
    changedNodeIds,
    nodesChanged: changedNodeIds.length > 0,
    edgesChanged: !workspaceValueEqual(normalizedEdges(baseGraph), normalizedEdges(nextGraph)),
    displayPageChanged: !workspaceValueEqual(
      graphUi(baseGraph).displayPage || null,
      graphUi(nextGraph).displayPage || null,
    ),
  };
}

export function reconcileWorkspaceNodes(currentNodes, nextNodes, changedNodeIds) {
  const currentById = new Map((Array.isArray(currentNodes) ? currentNodes : []).map((node) => [node.id, node]));
  const changed = new Set(Array.isArray(changedNodeIds) ? changedNodeIds : []);
  return (Array.isArray(nextNodes) ? nextNodes : []).map((nextNode) => {
    const current = currentById.get(nextNode.id);
    if (current && !changed.has(nextNode.id)) return current;
    if (!current) return nextNode;
    return {
      ...nextNode,
      selected: current.selected === true,
    };
  });
}

function flowEdgeKey(edge) {
  return [
    edge?.source,
    edge?.target,
    edge?.sourceHandle,
    edge?.targetHandle,
  ].map((value) => String(value ?? "")).join("\u0000");
}

function edgeWithoutSelection(edge) {
  if (!edge || typeof edge !== "object") return edge;
  const next = { ...edge };
  delete next.selected;
  return next;
}

export function reconcileWorkspaceEdges(currentEdges, nextEdges) {
  const currentByKey = new Map(
    (Array.isArray(currentEdges) ? currentEdges : []).map((edge) => [flowEdgeKey(edge), edge]),
  );
  return (Array.isArray(nextEdges) ? nextEdges : []).map((nextEdge) => {
    const current = currentByKey.get(flowEdgeKey(nextEdge));
    if (!current) return nextEdge;
    if (workspaceValueEqual(edgeWithoutSelection(current), edgeWithoutSelection(nextEdge))) return current;
    return {
      ...nextEdge,
      selected: current.selected === true,
    };
  });
}

export function reconcileWorkspaceInstances(currentInstances, nextInstances, changedNodeIds) {
  const current = isObject(currentInstances) ? currentInstances : {};
  const next = isObject(nextInstances) ? nextInstances : {};
  const changed = new Set(Array.isArray(changedNodeIds) ? changedNodeIds : []);
  return Object.fromEntries(
    Object.entries(next).map(([id, instance]) => [
      id,
      !changed.has(id) && Object.prototype.hasOwnProperty.call(current, id)
        ? current[id]
        : instance,
    ]),
  );
}
