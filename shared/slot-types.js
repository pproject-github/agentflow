const SLOT_TYPE_ALIASES = new Map([
  ["文本", "text"],
  ["str", "text"],
  ["string", "text"],
  ["文件", "file"],
  ["path", "file"],
  ["节点", "node"],
  ["flow", "node"],
  ["control", "node"],
  ["boolean", "bool"],
  ["布尔", "bool"],
  ["object", "json"],
]);

/**
 * Lossless assignments that do not need an adapter node.
 * JSON can always be serialized as text; text cannot safely become JSON
 * without parsing and validation, so the reverse direction is deliberately
 * absent.
 */
const LOSSLESS_ASSIGNMENTS = new Set([
  "json>text",
]);

export const SLOT_TYPE_COLORS = Object.freeze({
  text: "#2196f3",
  file: "#4caf50",
  node: "#ff9800",
  bool: "#9c27b0",
  json: "#00bcd4",
  image: "#ec407a",
  any: "#9e9e9e",
});

export function normalizeSlotType(type) {
  const raw = String(type ?? "").trim().toLowerCase();
  return SLOT_TYPE_ALIASES.get(raw) || raw || "node";
}

export function slotTypeCompatibility(sourceType, targetType) {
  const source = normalizeSlotType(sourceType);
  const target = normalizeSlotType(targetType);
  if (!source || !target) return { compatible: false, kind: "incompatible", source, target };
  if (source === "any" || target === "any") return { compatible: true, kind: "any", source, target };
  if (source === target) return { compatible: true, kind: "exact", source, target };
  if (LOSSLESS_ASSIGNMENTS.has(`${source}>${target}`)) {
    return { compatible: true, kind: "lossless", source, target };
  }
  return { compatible: false, kind: "incompatible", source, target };
}

export function areSlotTypesCompatible(sourceType, targetType) {
  return slotTypeCompatibility(sourceType, targetType).compatible;
}

export function getSlotTypeColor(type) {
  return SLOT_TYPE_COLORS[normalizeSlotType(type)] || "#9e9e9e";
}
