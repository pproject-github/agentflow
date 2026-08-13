import {
  areSlotTypesCompatible,
  getSlotTypeColor,
  normalizeSlotType,
  slotTypeCompatibility,
} from "../../../shared/slot-types.js";

export { areSlotTypesCompatible, normalizeSlotType, slotTypeCompatibility };

/** 按类型返回连接点颜色（与桌面 AgentFlow 一致） */
export function getHandleColor(type) {
  return getSlotTypeColor(type);
}

const SEMANTIC_TEXT_SLOT_NAMES = new Set(["knowledgeContext", "workspaceContext", "skillsContext", "mcpContext"]);

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
