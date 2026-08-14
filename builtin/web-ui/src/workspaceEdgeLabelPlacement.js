const DEFAULT_LABEL_WIDTH = 176;
const DEFAULT_LABEL_HEIGHT = 30;
const DEFAULT_NODE_PADDING = 12;

function cubicPoint(curve, t) {
  const inverse = 1 - t;
  const inverseSquared = inverse * inverse;
  const tSquared = t * t;
  return {
    x: (inverseSquared * inverse * curve.x0)
      + (3 * inverseSquared * t * curve.x1)
      + (3 * inverse * tSquared * curve.x2)
      + (tSquared * t * curve.x3),
    y: (inverseSquared * inverse * curve.y0)
      + (3 * inverseSquared * t * curve.y1)
      + (3 * inverse * tSquared * curve.y2)
      + (tSquared * t * curve.y3),
  };
}

function cubicTangent(curve, t) {
  const inverse = 1 - t;
  return {
    x: (3 * inverse * inverse * (curve.x1 - curve.x0))
      + (6 * inverse * t * (curve.x2 - curve.x1))
      + (3 * t * t * (curve.x3 - curve.x2)),
    y: (3 * inverse * inverse * (curve.y1 - curve.y0))
      + (6 * inverse * t * (curve.y2 - curve.y1))
      + (3 * t * t * (curve.y3 - curve.y2)),
  };
}

function parseBezierPath(path) {
  const numbers = String(path || "").match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi)?.map(Number) || [];
  if (numbers.length < 8 || numbers.slice(0, 8).some((value) => !Number.isFinite(value))) return null;
  const [x0, y0, x1, y1, x2, y2, x3, y3] = numbers;
  return { x0, y0, x1, y1, x2, y2, x3, y3 };
}

function overlapArea(a, b) {
  const width = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const height = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  return width * height;
}

function candidateRect(point, width, height) {
  return {
    x: point.x - width / 2,
    y: point.y - height / 2,
    width,
    height,
  };
}

/**
 * Keep virtual relation badges close to their Bézier edge without covering node cards.
 * All coordinates are React Flow canvas coordinates, so the result remains stable at
 * every zoom level.
 */
export function placeWorkspaceRelationLabel({
  edgePath,
  fallbackX,
  fallbackY,
  nodeRects = [],
  labelWidth = DEFAULT_LABEL_WIDTH,
  labelHeight = DEFAULT_LABEL_HEIGHT,
  nodePadding = DEFAULT_NODE_PADDING,
} = {}) {
  const fallback = {
    x: Number(fallbackX) || 0,
    y: Number(fallbackY) || 0,
  };
  const curve = parseBezierPath(edgePath);
  if (!curve) return fallback;

  const obstacles = (Array.isArray(nodeRects) ? nodeRects : [])
    .map((rect) => ({
      x: Number(rect?.x) - nodePadding,
      y: Number(rect?.y) - nodePadding,
      width: Math.max(0, Number(rect?.width) || 0) + nodePadding * 2,
      height: Math.max(0, Number(rect?.height) || 0) + nodePadding * 2,
    }))
    .filter((rect) => Number.isFinite(rect.x) && Number.isFinite(rect.y) && rect.width > 0 && rect.height > 0);
  if (!obstacles.length) return fallback;

  const samples = [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8, 0.12, 0.88];
  const normalOffsets = [0, 36, -36, 64, -64, 96, -96, 132, -132, 180, -180, 240, -240];
  let best = null;

  for (const t of samples) {
    const point = cubicPoint(curve, t);
    const tangent = cubicTangent(curve, t);
    const tangentLength = Math.hypot(tangent.x, tangent.y) || 1;
    const normal = { x: -tangent.y / tangentLength, y: tangent.x / tangentLength };
    for (const offset of normalOffsets) {
      const candidate = {
        x: point.x + normal.x * offset,
        y: point.y + normal.y * offset,
      };
      const rect = candidateRect(candidate, labelWidth, labelHeight);
      const overlap = obstacles.reduce((total, obstacle) => total + overlapArea(rect, obstacle), 0);
      const score = (overlap * 1000) + (Math.abs(t - 0.5) * 80) + Math.abs(offset);
      if (!best || score < best.score) best = { ...candidate, score, overlap };
    }
  }

  return best ? { x: best.x, y: best.y } : fallback;
}
