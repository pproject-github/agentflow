/** 按类型返回连接点颜色（与桌面 AgentFlow 一致） */
export function getHandleColor(type) {
  switch (normalizeSlotType(type)) {
    case "text":
      return "#2196f3";
    case "file":
      return "#4caf50";
    case "node":
      return "#ff9800";
    case "bool":
      return "#9c27b0";
    default:
      return "#9e9e9e";
  }
}

export function normalizeSlotType(type) {
  const raw = String(type ?? "").trim().toLowerCase();
  if (raw === "文本" || raw === "str" || raw === "string") return "text";
  if (raw === "文件" || raw === "path") return "file";
  if (raw === "节点" || raw === "flow" || raw === "control") return "node";
  if (raw === "boolean" || raw === "布尔") return "bool";
  return raw || "node";
}

export function areSlotTypesCompatible(sourceType, targetType) {
  const src = normalizeSlotType(sourceType);
  const tgt = normalizeSlotType(targetType);
  if (!src || !tgt) return false;
  if (src === "any" || tgt === "any") return true;
  return src === tgt;
}

const SEMANTIC_TEXT_SLOT_NAMES = new Set(["workspaceContext", "skillsContext", "mcpContext"]);

export function getSlotSemanticKey(slot) {
  const type = normalizeSlotType(slot?.type);
  const name = String(slot?.name || slot?.id || "").trim();
  if (type === "text" && SEMANTIC_TEXT_SLOT_NAMES.has(name)) return `${type}+${name}`;
  return type;
}

export function getSlotConnectionLabel(slot) {
  return getSlotSemanticKey(slot);
}

export function areSlotsCompatible(sourceSlot, targetSlot) {
  if (!sourceSlot || !targetSlot) return false;
  if (!areSlotTypesCompatible(sourceSlot.type, targetSlot.type)) return false;
  const srcKey = getSlotSemanticKey(sourceSlot);
  const tgtKey = getSlotSemanticKey(targetSlot);
  const srcSemantic = srcKey.includes("+");
  const tgtSemantic = tgtKey.includes("+");
  if (srcSemantic || tgtSemantic) return srcKey === tgtKey;
  return true;
}

export function slotIndexFromHandle(handleId, prefix) {
  const m = new RegExp(`^${prefix}-(\\d+)$`).exec(String(handleId || ""));
  if (!m) return -1;
  const idx = Number.parseInt(m[1], 10);
  return Number.isFinite(idx) ? idx : -1;
}

export function getNodeSlotByHandle(node, handleId, handleType) {
  const side = handleType === "source" ? "outputs" : "inputs";
  const prefix = handleType === "source" ? "output" : "input";
  const idx = slotIndexFromHandle(handleId, prefix);
  if (idx < 0) return null;
  const slots = Array.isArray(node?.data?.[side]) ? node.data[side] : [];
  return slots[idx] || null;
}
