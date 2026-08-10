import crypto from "node:crypto";

import { splitWorkspaceGraph, workspaceRuntimeSurface } from "./workspace-state.mjs";

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

/**
 * 设计态视图 = 存储层拆出来的设计态，一个字不多一个字不少。
 *
 * 以前这里自己写了一遍「什么算运行态」，只覆盖 output 值和 displayReloadKey，漏掉了
 * 接了入边的 input 值和展示节点正文。后果是跑一次流程 designRevision 就变，协作者手里
 * 的基线全部作废——明明没人改过图。判断规则见 `workspace-state.mjs`。
 */
export function workspaceDesignGraph(graph) {
  const next = normalizedGraph(splitWorkspaceGraph(normalizedGraph(graph)).design);
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

/**
 * 这个位置上的值是不是运行产出。是的话冲突不算冲突，直接取 incoming——重跑一次就有的
 * 东西，没必要拦住用户让他手动选。
 *
 * 判断口径与 `workspaceRuntimeSurface` 完全一致；先在 incoming / current / base 里找到
 * 第一个有这个节点的图，按那张图的槽位数组解析下标，避免三张图槽序不同时张冠李戴。
 */
function isRuntimePath(path, sides) {
  if (path[0] === "ui" && path[1] === "viewport") return true;
  if (path[0] !== "instances" || path.length < 3) return false;

  const nodeId = path[1];
  const side = sides.find((s) => s.graph.instances?.[nodeId]);
  if (!side) return false;

  if (path[2] === "displayReloadKey" || path[2] === "runFingerprint") return true;
  if (path[2] === "body") return side.runtime.displayBodies.has(nodeId);

  if (path[2] !== "input" && path[2] !== "output") return false;
  if (!Number.isInteger(path[3])) return false;
  if (path[4] !== "value" && path[4] !== "default") return false;

  if (path[2] === "output") return !side.runtime.isProvide(nodeId);
  const slots = side.graph.instances[nodeId]?.input;
  const slotName = String((Array.isArray(slots) ? slots : [])[path[3]]?.name ?? "");
  return Boolean(slotName) && Boolean(side.runtime.inputs.get(nodeId)?.has(slotName));
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

  if (isRuntimePath(path, context.sides)) {
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
    // 运行态判断要看边，而合并形态里 edges 已经变成 map 了，所以按原图先算好。
    // 顺序即优先级：incoming 最先，和「哪张图有这个节点」的查找顺序一致。
    sides: [
      { graph: incoming, runtime: workspaceRuntimeSurface(incomingGraph) },
      { graph: current, runtime: workspaceRuntimeSurface(currentGraph) },
      { graph: base, runtime: workspaceRuntimeSurface(baseGraph) },
    ],
  };
  const merged = mergeValue(base, current, incoming, [], context);
  return {
    graph: mergeShapeToGraph(merged),
    conflicts: context.conflicts,
  };
}
