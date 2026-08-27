/**
 * Workspace graph 的确定性自动排版。
 *
 * 这是 CLI 和 Web UI 共用的纯函数：不读文件、不依赖 Node API，也不修改传入对象。
 * DSL 只描述流程语义，坐标由这里生成，避免模型手写一堆既脆弱又难维护的数字。
 */

const HORIZONTAL_GAP = 160;
const VERTICAL_GAP = 72;
const ORIGIN_X = 120;
const MAIN_Y = 360;
const COLLISION_MARGIN = 28;

function finite(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function nodeSize(graph, id) {
  const saved = graph?.ui?.nodeSizes?.[id];
  if (saved && Number.isFinite(saved.width) && Number.isFinite(saved.height)) {
    return { width: Math.max(80, saved.width), height: Math.max(60, saved.height) };
  }
  const definitionId = String(graph?.instances?.[id]?.definitionId || "");
  if (definitionId === "workspace_run" || definitionId === "workspace_scheduled_run") {
    return { width: 256, height: 156 };
  }
  if (definitionId.startsWith("provide_")) return { width: 220, height: 110 };
  if (definitionId.startsWith("display_")) return { width: 496, height: 160 };
  return { width: 260, height: 150 };
}

function handleIndex(handle) {
  const matched = /-(\d+)$/.exec(String(handle || ""));
  return matched ? Number(matched[1]) : 0;
}

function edgeIsControl(graph, edge) {
  const source = graph?.instances?.[edge.source];
  const target = graph?.instances?.[edge.target];
  const output = Array.isArray(source?.output) ? source.output[handleIndex(edge.sourceHandle)] : null;
  const input = Array.isArray(target?.input) ? target.input[handleIndex(edge.targetHandle)] : null;
  return output?.type === "node" || input?.type === "node";
}

function orderedNodeIds(graph) {
  const ids = [];
  const seen = new Set();
  const add = (value) => {
    const id = String(value || "");
    if (!id || seen.has(id)) return;
    seen.add(id);
    ids.push(id);
  };
  for (const id of Object.keys(graph?.instances || {})) add(id);
  for (const edge of graph?.edges || []) {
    add(edge?.source);
    add(edge?.target);
  }
  return ids;
}

/** 所有语义边参与分层；同一对节点的控制线和数据线只计一次。 */
function graphLayers(graph, ids, order) {
  const known = new Set(ids);
  const outgoing = new Map(ids.map((id) => [id, new Set()]));
  const indegree = new Map(ids.map((id) => [id, 0]));
  for (const edge of graph?.edges || []) {
    const source = String(edge?.source || "");
    const target = String(edge?.target || "");
    if (!known.has(source) || !known.has(target) || source === target || outgoing.get(source).has(target)) continue;
    outgoing.get(source).add(target);
    indegree.set(target, indegree.get(target) + 1);
  }

  const byOrder = (a, b) => order.get(a) - order.get(b);
  const queue = ids.filter((id) => indegree.get(id) === 0).sort(byOrder);
  const depth = new Map(ids.map((id) => [id, 0]));
  const visited = new Set();
  while (queue.length) {
    const id = queue.shift();
    visited.add(id);
    for (const next of [...outgoing.get(id)].sort(byOrder)) {
      depth.set(next, Math.max(depth.get(next), depth.get(id) + 1));
      indegree.set(next, indegree.get(next) - 1);
      if (indegree.get(next) === 0) {
        queue.push(next);
        queue.sort(byOrder);
      }
    }
  }

  // lint 会拒绝环；这里仍要保证坏图能打开。环里的节点依声明顺序放到后续列。
  let cycleDepth = Math.max(0, ...depth.values());
  for (const id of ids) {
    if (visited.has(id)) continue;
    cycleDepth += 1;
    depth.set(id, cycleDepth);
  }
  return depth;
}

function stackAt(ids, startY, graph, positions) {
  let y = startY;
  for (const id of ids) {
    positions[id] = { ...positions[id], y };
    y += nodeSize(graph, id).height + VERTICAL_GAP;
  }
  return y;
}

function desiredPositions(graph) {
  const ids = orderedNodeIds(graph);
  const order = new Map(ids.map((id, index) => [id, index]));
  const depth = graphLayers(graph, ids, order);
  const controlIds = new Set();
  for (const edge of graph?.edges || []) {
    if (!edgeIsControl(graph, edge)) continue;
    controlIds.add(String(edge.source));
    controlIds.add(String(edge.target));
  }
  for (const id of ids) {
    const definitionId = String(graph?.instances?.[id]?.definitionId || "");
    if (definitionId === "workspace_run" || definitionId === "workspace_scheduled_run") controlIds.add(id);
  }

  const columns = new Map();
  for (const id of ids) {
    const d = depth.get(id) || 0;
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d).push(id);
  }
  const depths = [...columns.keys()].sort((a, b) => a - b);
  const positions = {};
  let baseY = MAIN_Y;
  for (const column of columns.values()) {
    const main = column.filter((id) => controlIds.has(id));
    const above = column.filter((id) => !controlIds.has(id)
      && !String(graph?.instances?.[id]?.definitionId || "").startsWith("display_"));
    const aboveHeight = above.reduce((sum, id) => sum + nodeSize(graph, id).height, 0)
      + Math.max(0, above.length - 1) * VERTICAL_GAP;
    if (main.length) baseY = Math.max(baseY, aboveHeight + VERTICAL_GAP + 80);
    else {
      const totalHeight = column.reduce((sum, id) => sum + nodeSize(graph, id).height, 0)
        + Math.max(0, column.length - 1) * VERTICAL_GAP;
      baseY = Math.max(baseY, totalHeight / 2 + 80);
    }
  }
  let x = ORIGIN_X;
  for (const d of depths) {
    const column = columns.get(d).sort((a, b) => order.get(a) - order.get(b));
    const main = column.filter((id) => controlIds.has(id));
    const above = column.filter((id) => !controlIds.has(id)
      && !String(graph?.instances?.[id]?.definitionId || "").startsWith("display_"));
    const below = column.filter((id) => !controlIds.has(id) && !above.includes(id));
    for (const id of column) positions[id] = { x, y: baseY };

    if (main.length) {
      const mainStart = baseY;
      const mainEnd = stackAt(main, mainStart, graph, positions);

      const aboveHeight = above.reduce((sum, id) => sum + nodeSize(graph, id).height, 0)
        + Math.max(0, above.length - 1) * VERTICAL_GAP;
      stackAt(above, mainStart - VERTICAL_GAP - aboveHeight, graph, positions);
      stackAt(below, mainEnd, graph, positions);
    } else {
      const all = [...above, ...below];
      const height = all.reduce((sum, id) => sum + nodeSize(graph, id).height, 0)
        + Math.max(0, all.length - 1) * VERTICAL_GAP;
      stackAt(all, baseY - height / 2, graph, positions);
    }

    const width = Math.max(...column.map((id) => nodeSize(graph, id).width), 0);
    x += width + HORIZONTAL_GAP;
  }
  return positions;
}

function validPosition(value) {
  return value && Number.isFinite(value.x) && Number.isFinite(value.y);
}

function overlaps(a, b) {
  return a.x < b.x + b.width + COLLISION_MARGIN
    && a.x + a.width + COLLISION_MARGIN > b.x
    && a.y < b.y + b.height + COLLISION_MARGIN
    && a.y + a.height + COLLISION_MARGIN > b.y;
}

/**
 * 返回完整 nodePositions。默认保留人工拖过的坐标，只给新节点补位置；`preserveExisting:false`
 * 则整图重排。已有坐标可能不在实例表里，原样保留，避免意外破坏 UI 扩展数据。
 */
export function layoutWorkspaceNodePositions(graph, { preserveExisting = true } = {}) {
  const desired = desiredPositions(graph || {});
  const existing = graph?.ui?.nodePositions && typeof graph.ui.nodePositions === "object"
    ? graph.ui.nodePositions
    : {};
  const result = preserveExisting ? { ...existing } : {};
  const occupied = [];

  if (preserveExisting) {
    for (const [id, position] of Object.entries(existing)) {
      if (!validPosition(position)) continue;
      const size = nodeSize(graph, id);
      occupied.push({ id, x: position.x, y: position.y, ...size });
    }
  }

  for (const id of orderedNodeIds(graph || {})) {
    if (preserveExisting && validPosition(existing[id])) continue;
    const size = nodeSize(graph, id);
    const position = { x: finite(desired[id]?.x, ORIGIN_X), y: finite(desired[id]?.y, MAIN_Y) };
    let candidate = { id, ...position, ...size };
    while (occupied.some((other) => overlaps(candidate, other))) {
      position.y += size.height + VERTICAL_GAP;
      candidate = { id, ...position, ...size };
    }
    result[id] = position;
    occupied.push(candidate);
  }
  return result;
}

export function applyWorkspaceAutoLayout(graph, options = {}) {
  const source = graph && typeof graph === "object" ? graph : {};
  const ui = source.ui && typeof source.ui === "object" ? source.ui : {};
  return {
    ...source,
    ui: {
      ...ui,
      nodePositions: layoutWorkspaceNodePositions(source, options),
    },
  };
}
