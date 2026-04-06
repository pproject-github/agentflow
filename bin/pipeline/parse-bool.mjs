#!/usr/bin/env node
/**
 * 布尔解析工具，供 control_if 等节点在 pre-process / post-process 中共用。
 * 用法（模块）：import { parseBool, getFirstBoolInputValue } from "./parse-bool.mjs";
 */

/**
 * 将字符串或值解析为布尔：true/1/yes/on 为 true，其余为 false。
 * @param {*} val
 * @returns {boolean}
 */
export function parseBool(val) {
  if (val == null || val === "") return false;
  const s = String(val).trim().toLowerCase();
  return ["true", "1", "yes", "on"].includes(s);
}

/**
 * 从 resolvedInputs 中取第一个 type 为 bool 的槽位值（名称不限）。
 * @param {Record<string, unknown>} resolvedInputs
 * @param {Record<string, string>|null} inputSlotTypes - inputSlotTypes[instanceId]
 * @returns {string|null} 槽位原始值（可能为路径或 "true"/"false" 等），无则 null
 */
export function getFirstBoolInputValue(resolvedInputs, inputSlotTypes) {
  if (!resolvedInputs || !inputSlotTypes) return null;
  for (const [slotName, type] of Object.entries(inputSlotTypes)) {
    if (String(type).toLowerCase() !== "bool") continue;
    const v = resolvedInputs[slotName];
    if (v == null) continue;
    return typeof v === "string" ? v : String(v);
  }
  return null;
}
