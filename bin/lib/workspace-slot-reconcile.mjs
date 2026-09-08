/**
 * 槽位表归节点定义所有。
 *
 * 图里存的槽位表只是**上一次落盘时定义表长什么样**的快照。定义改了，快照不会跟着改：
 * 线上因此出现过 4 个 agent 节点连 `prev` 都没有（那版定义还没这个槽），控制边无处可接；
 * 还有一批节点带着早就改过的旧说明文字，往返比对判成「解析回来与原图不一致」，
 * 整个流程退回写 `workspace.graph.json`。
 *
 * 所以读图和落盘前都按定义对账一遍：**定义槽的存在、类型、说明、必填由定义说了算**，
 * 图只保留自己那份数据——槽位的值、画布上显不显示、以及定义里没有的自定义槽。
 *
 * 顺序也归定义：定义槽按定义序在前，自定义槽按实例里的先后在后。这一步必须在
 * 「边已经按槽位名记录」之后做（见 shared/slot-handles.js）——否则重排槽位就是重接线。
 */
import { definitionOf } from "./flow-dsl/defs.mjs";

/** 槽位表由实例自己定义、定义表管不着的节点类型。 */
const INSTANCE_OWNED_SLOTS = new Set(["control_subflow_call", "workspace_subflow_input"]);

const asText = (v) => (v === undefined || v === null ? "" : String(v));

function definitionSlots(instance, resolvePackage) {
  const definitionId = asText(instance?.definitionId);
  if (!definitionId || INSTANCE_OWNED_SLOTS.has(definitionId)) return null;
  // 代码节点包自带槽位表；`tool_nodejs` 只是它的运行方式，不决定它有哪些引脚
  const ref = asText(instance?.marketplaceRef).trim();
  if (ref && typeof resolvePackage === "function") {
    const pkg = resolvePackage(ref);
    if (pkg && (Array.isArray(pkg.input) || Array.isArray(pkg.output))) {
      return { input: pkg.input || [], output: pkg.output || [] };
    }
    // 包没装上时槽位表读不到。这一刻按「定义里没有这些槽」对账会把整张表当自定义槽
    // 留着——那正是我们要的：宁可不动，也不能凭一张空表把引脚删光。
    return null;
  }
  const def = definitionOf(definitionId);
  if (!def.input.length && !def.output.length) return null;
  return { input: def.input, output: def.output };
}

function reconcileSlotList(instanceSlots, defSlots) {
  const own = Array.isArray(instanceSlots) ? instanceSlots : [];
  const byName = new Map();
  for (const slot of own) {
    const name = asText(slot?.name);
    if (name && !byName.has(name)) byName.set(name, slot);
  }

  const out = [];
  const taken = new Set();
  for (const d of defSlots) {
    const name = asText(d?.name);
    if (!name || taken.has(name)) continue;
    taken.add(name);
    const mine = byName.get(name);
    const slot = { type: asText(d.type), name, value: asText(mine?.value ?? mine?.default ?? "") };
    // 定义写了什么就照抄什么，包括 `showOnNode: false`——只抄真值会让这张表和
    // `hydrateWorkspaceSlotMetaFromDefinitions` 补出来的那张差一个键，revision 跟着对不上，
    // 客户端存完拿到的版本号在磁盘上根本不存在，下一步发布直接 409。
    for (const key of ["description", "required", "showOnNode"]) {
      if (d[key] != null) slot[key] = d[key];
    }
    // 显不显示在卡片上是这个实例的画布选择，不是定义的事
    if (mine && "showOnNode" in mine) slot.showOnNode = mine.showOnNode === true;
    out.push(slot);
  }
  // 定义里没有的槽是作者自己加的，原样保留，排在定义槽之后
  for (const slot of own) {
    const name = asText(slot?.name);
    if (!name || taken.has(name)) continue;
    taken.add(name);
    out.push(slot);
  }
  return out;
}

/**
 * 按定义对账一个实例的槽位表。定义表读不到时原样返回。
 *
 * @param {object} instance
 * @param {(ref: string) => ({input?: Array, output?: Array}|null)} [resolvePackage]
 * @returns {object} 对账后的实例（内容没变时返回原对象）
 */
export function reconcileInstanceSlots(instance, resolvePackage) {
  const defs = definitionSlots(instance, resolvePackage);
  if (!defs) return instance;
  const input = reconcileSlotList(instance?.input, defs.input);
  const output = reconcileSlotList(instance?.output, defs.output);
  return { ...instance, input, output };
}

/**
 * 按定义对账整张图的槽位表。
 *
 * @param {object} graph 设计态图
 * @param {{ resolvePackage?: Function }} [opts]
 * @returns {object} 对账后的图（没有实例时返回原图）
 */
export function reconcileGraphSlots(graph, opts = {}) {
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : null;
  if (!instances) return graph;
  const next = {};
  for (const [id, instance] of Object.entries(instances)) {
    next[id] = reconcileInstanceSlots(instance, opts.resolvePackage);
  }
  return { ...graph, instances: next };
}
