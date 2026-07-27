import crypto from "node:crypto";

const MISSING = Symbol("missing");

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clone(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonicalize(value[key])]),
  );
}

function equal(left, right) {
  if (left === MISSING || right === MISSING) return left === right;
  return JSON.stringify(canonicalize(left)) === JSON.stringify(canonicalize(right));
}

function normalizedGraph(graph) {
  const source = isPlainObject(graph) ? graph : {};
  return {
    version: Number(source.version) || 1,
    instances: isPlainObject(source.instances) ? clone(source.instances) : {},
    edges: Array.isArray(source.edges) ? clone(source.edges) : [],
    ui: isPlainObject(source.ui) ? clone(source.ui) : { nodePositions: {} },
  };
}

function isProvideInstance(instance) {
  return String(instance?.definitionId || "").startsWith("provide_");
}

function designInstance(instance) {
  if (!isPlainObject(instance)) return instance;
  const next = clone(instance);
  delete next.displayReloadKey;
  if (!isProvideInstance(next) && Array.isArray(next.output)) {
    next.output = next.output.map((slot) => {
      if (!isPlainObject(slot)) return slot;
      const clean = { ...slot };
      delete clean.value;
      delete clean.default;
      return clean;
    });
  }
  return next;
}

export function workspaceDesignGraph(graph) {
  const next = normalizedGraph(graph);
  next.instances = Object.fromEntries(
    Object.entries(next.instances).map(([id, instance]) => [id, designInstance(instance)]),
  );
  delete next.ui.viewport;
  return next;
}

export function workspaceDesignRevision(graph) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(canonicalize(workspaceDesignGraph(graph))))
    .digest("hex")
    .slice(0, 24);
}

export function workspaceRuntimeRevision(graph) {
  return crypto.createHash("sha256")
    .update(JSON.stringify(canonicalize(normalizedGraph(graph))))
    .digest("hex")
    .slice(0, 24);
}

function edgeKey(edge) {
  return [
    edge?.source || "",
    edge?.target || "",
    edge?.sourceHandle || "",
    edge?.targetHandle || "",
  ].map((part) => encodeURIComponent(String(part))).join("|");
}

function edgesToMap(edges) {
  const result = {};
  for (const edge of Array.isArray(edges) ? edges : []) {
    result[edgeKey(edge)] = edge;
  }
  return result;
}

function graphToMergeShape(graph) {
  const next = normalizedGraph(graph);
  delete next.ui.viewport;
  return {
    ...next,
    edges: edgesToMap(next.edges),
  };
}

function mergeShapeToGraph(shape) {
  const graph = normalizedGraph({
    ...shape,
    edges: Object.keys(shape?.edges || {})
      .sort()
      .map((key) => shape.edges[key]),
  });
  delete graph.ui.viewport;
  return graph;
}

function pathLabel(path) {
  if (!path.length) return "$";
  return path.reduce((label, part) => (
    typeof part === "number"
      ? `${label}[${part}]`
      : `${label}.${String(part).replaceAll(".", "\\.")}`
  ), "$");
}

function isRuntimePath(path, graphs) {
  if (path[0] === "ui" && path[1] === "viewport") return true;
  if (path[0] !== "instances" || path.length < 3) return false;
  if (path[2] === "displayReloadKey") return true;
  if (path[2] !== "output" || !Number.isInteger(path[3])) return false;
  if (path[4] !== "value" && path[4] !== "default") return false;
  const nodeId = path[1];
  const instance = graphs.incoming?.instances?.[nodeId]
    || graphs.current?.instances?.[nodeId]
    || graphs.base?.instances?.[nodeId];
  return !isProvideInstance(instance);
}

function mergeValue(base, current, incoming, path, context) {
  if (equal(incoming, base)) return current;
  if (equal(current, base)) return incoming;
  if (equal(incoming, current)) return current;

  if (isPlainObject(base) && isPlainObject(current) && isPlainObject(incoming)) {
    const merged = {};
    const keys = new Set([...Object.keys(base), ...Object.keys(current), ...Object.keys(incoming)]);
    for (const key of keys) {
      const value = mergeValue(
        Object.prototype.hasOwnProperty.call(base, key) ? base[key] : MISSING,
        Object.prototype.hasOwnProperty.call(current, key) ? current[key] : MISSING,
        Object.prototype.hasOwnProperty.call(incoming, key) ? incoming[key] : MISSING,
        [...path, key],
        context,
      );
      if (value !== MISSING) merged[key] = value;
    }
    return merged;
  }

  if (
    Array.isArray(base)
    && Array.isArray(current)
    && Array.isArray(incoming)
    && base.length === current.length
    && base.length === incoming.length
  ) {
    return base.map((value, index) => mergeValue(
      value,
      current[index],
      incoming[index],
      [...path, index],
      context,
    ));
  }

  if (isRuntimePath(path, context.graphs)) {
    return incoming;
  }

  context.conflicts.push({
    path: pathLabel(path),
    pathParts: [...path],
    hasBase: base !== MISSING,
    hasCurrent: current !== MISSING,
    hasIncoming: incoming !== MISSING,
    base: base === MISSING ? undefined : clone(base),
    current: current === MISSING ? undefined : clone(current),
    incoming: incoming === MISSING ? undefined : clone(incoming),
  });
  return current;
}

export function mergeWorkspaceGraphs({ baseGraph, currentGraph, incomingGraph }) {
  const base = graphToMergeShape(baseGraph);
  const current = graphToMergeShape(currentGraph);
  const incoming = graphToMergeShape(incomingGraph);
  const context = {
    conflicts: [],
    graphs: { base, current, incoming },
  };
  const merged = mergeValue(base, current, incoming, [], context);
  return {
    graph: mergeShapeToGraph(merged),
    conflicts: context.conflicts,
  };
}
