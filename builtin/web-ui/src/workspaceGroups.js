const DEFAULT_NODE_WIDTH = 320;
const DEFAULT_NODE_HEIGHT = 96;

function isWorkspaceGroup(node) {
  return Boolean(node?.data?.isWorkspaceGroup);
}

function displayFallbackSize(definitionId) {
  const id = String(definitionId || "");
  if (id === "display_html" || id === "display_react_app") return { width: 720, height: 520 };
  if (id === "display_table" || id === "display_chart") return { width: 640, height: 380 };
  if (id === "display_image") return { width: 520, height: 360 };
  if (id.startsWith("display_")) return { width: 520, height: 320 };
  return { width: DEFAULT_NODE_WIDTH, height: DEFAULT_NODE_HEIGHT };
}

function positiveSize(raw) {
  const width = Number(raw?.width);
  const height = Number(raw?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return { width, height };
}

function workspaceMemberSize(node) {
  return positiveSize({ width: node?.width, height: node?.height })
    || positiveSize(node?.measured)
    || positiveSize(node?.data?.displaySize)
    || positiveSize(node?.data?.nodeSize)
    || displayFallbackSize(node?.data?.definitionId);
}

/**
 * A member may grow after its content has rendered. Keep a manually enlarged
 * group, but never allow its border to cut through one of its members.
 */
export function expandWorkspaceGroupsToMembers(nodes, {
  padding = 52,
  minWidth = 240,
  minHeight = 160,
} = {}) {
  const list = Array.isArray(nodes) ? nodes : [];
  const byId = new Map(list.map((node) => [String(node?.id || ""), node]));
  let changed = false;
  const next = list.map((group) => {
    if (!isWorkspaceGroup(group)) return group;
    const members = Array.from(new Set(Array.isArray(group.data?.nodeIds) ? group.data.nodeIds : []))
      .map((id) => byId.get(String(id || "")))
      .filter((node) => node && !isWorkspaceGroup(node));
    if (members.length === 0) return group;

    const memberBounds = members.reduce((bounds, node) => {
      const x = Number(node.position?.x) || 0;
      const y = Number(node.position?.y) || 0;
      const size = workspaceMemberSize(node);
      return {
        minX: Math.min(bounds.minX, x),
        minY: Math.min(bounds.minY, y),
        maxX: Math.max(bounds.maxX, x + size.width),
        maxY: Math.max(bounds.maxY, y + size.height),
      };
    }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });

    const currentX = Number(group.position?.x) || 0;
    const currentY = Number(group.position?.y) || 0;
    const currentSize = positiveSize({ width: group.width, height: group.height })
      || positiveSize(group.data?.nodeSize)
      || positiveSize(group.measured)
      || { width: minWidth, height: minHeight };
    const x = Math.min(currentX, memberBounds.minX - padding);
    const y = Math.min(currentY, memberBounds.minY - padding);
    const right = Math.max(currentX + currentSize.width, memberBounds.maxX + padding);
    const bottom = Math.max(currentY + currentSize.height, memberBounds.maxY + padding);
    const size = {
      width: Math.max(minWidth, Math.round(right - x)),
      height: Math.max(minHeight, Math.round(bottom - y)),
    };
    const roundedX = Math.round(x);
    const roundedY = Math.round(y);
    if (
      roundedX === currentX
      && roundedY === currentY
      && size.width === Math.round(currentSize.width)
      && size.height === Math.round(currentSize.height)
    ) return group;
    changed = true;
    return {
      ...group,
      position: { x: roundedX, y: roundedY },
      width: size.width,
      height: size.height,
      data: {
        ...group.data,
        nodeSize: size,
      },
    };
  });
  return changed ? next : list;
}
