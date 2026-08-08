/**
 * `workspace.layout.json` / `workspace.nodes.json` 的抽取。
 *
 * 划分原则：**代码里说得清的就不进 JSON**。
 *
 * - layout.json —— 画布状态：坐标、尺寸、引脚显隐与顺序。这些和流程语义无关，
 *   放代码里只会淹没结构。
 * - nodes.json —— 说不清的节点级数据：粘贴的图片（base64，语料里单张 70 KB）、
 *   机器管理的属性（marketplaceRef、model…）。
 *
 * 引脚显隐和顺序都只记**偏离定义表的部分**。字段缺失 = 继承定义表，不算漂移——
 * 这一条踩过坑：把「没写 showOnNode」当成 `false` 会凭空造出一堆假的覆盖记录。
 */
import { definitionOf } from "./defs.mjs";
import { NODE_META_KEYS, bodyMirrorSuppressed } from "./ir.mjs";

function canonicalSlotNames(defSlots, extras) {
  return [...defSlots.map((s) => s.name), ...extras.filter((x) => !defSlots.some((s) => s.name === x))];
}

/**
 * @param {object} designGraph 设计态图
 * @param {object} ir 同一张图的 IR（用来知道哪些是自定义槽）
 * @returns {{ layout: object, nodeMeta: object }}
 */
export function extractLayout(designGraph, ir) {
  const instances = designGraph?.instances && typeof designGraph.instances === "object"
    ? designGraph.instances
    : {};
  const ui = designGraph?.ui && typeof designGraph.ui === "object" ? designGraph.ui : {};

  const layout = { version: 1, nodes: {} };
  if (ui.viewport) layout.viewport = ui.viewport;
  // ui 下除了坐标/尺寸/视口之外的键原样透传——语料里出现过 ui.groups: []，
  // 用 Object.keys().length 判空会把它吃掉
  for (const [key, value] of Object.entries(ui)) {
    if (key === "nodePositions" || key === "nodeSizes" || key === "viewport") continue;
    layout[key] = value;
  }

  const nodeMeta = { version: 1, nodes: {} };

  // 按 id 排序而不是按插入顺序：instances 的键序会随一次往返而变（irToGraph 按 IR 顺序
  // 重建），不定序会让「没改任何东西的再保存」也产生 diff。
  for (const id of Object.keys(instances).sort()) {
    const instance = instances[id];
    const def = definitionOf(String(instance.definitionId || ""));
    const entry = {};

    const pos = ui.nodePositions?.[id];
    if (pos) {
      entry.x = pos.x;
      entry.y = pos.y;
    }
    const size = ui.nodeSizes?.[id];
    if (size) {
      entry.w = size.width;
      entry.h = size.height;
    }

    const pins = {};
    for (const [kind, slots, defSlots] of [
      ["in", instance.input || [], def.input],
      ["out", instance.output || [], def.output],
    ]) {
      const byName = new Map(defSlots.map((s) => [s.name, s]));
      for (const slot of slots) {
        const d = byName.get(slot.name);
        for (const key of ["showOnNode", "required"]) {
          if (!(key in slot)) continue;            // 缺失 = 继承定义表，不是覆盖
          const actual = Boolean(slot[key]);
          if (d ? actual !== Boolean(d[key]) : actual) {
            ((pins[kind] ||= {})[slot.name] ||= {})[key] = actual;
          }
        }
      }
    }
    if (Object.keys(pins).length) entry.pins = pins;

    const irNode = ir.nodes[id];
    for (const [kind, slots, extras] of [
      ["in", instance.input || [], irNode?.extraIn || []],
      ["out", instance.output || [], irNode?.extraOut || []],
    ]) {
      const actual = slots.map((s) => String(s.name || ""));
      const canonical = canonicalSlotNames(kind === "in" ? def.input : def.output, extras);
      if (JSON.stringify(actual) !== JSON.stringify(canonical)) (entry.pinOrder ||= {})[kind] = actual;
    }

    if (Object.keys(entry).length) layout.nodes[id] = entry;

    const meta = {};
    if (instance.images !== undefined && instance.images !== null) meta.images = instance.images;
    for (const key of NODE_META_KEYS) if (String(instance[key] || "").trim()) meta[key] = instance[key];
    if (instance.globalContext === true) meta.globalContext = true;
    if (bodyMirrorSuppressed(instance)) meta.bodyMirror = false;
    if (String(instance.role || "") && String(instance.role) !== "normal") meta.role = instance.role;
    if (Object.keys(meta).length) nodeMeta.nodes[id] = meta;
  }

  return { layout, nodeMeta };
}
