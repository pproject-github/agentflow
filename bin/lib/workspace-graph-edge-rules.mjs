/**
 * 连线的三条硬规则，在**存图**这一步执行。
 *
 * 画布上早就有 `isValidConnection` 拦着（`nodeSchema.js`），但服务端没有——
 * 程序化写入口（CLI skill、Composer、agent 生成的图）绕过画布直接提交，非法边就这么
 * 进了库。线上真出现过：一条 `provide_str.value` 落到了某个节点的 `prev` 控制槽上，
 * 和真正的控制边撞在一起；运行时只认第一条入边，那个值从此再没传进去过，图看着还是连着的。
 *
 * 规则本身和 `flow dsl lint` 是同一套，只是那边跑在 IR 上、这边跑在设计态图上。
 */
import { slotTypeCompatibility } from "../../shared/slot-types.js";
import { slotNameFromHandle } from "../../shared/slot-handles.js";

const slotOf = (instance, kind, handle) => {
  const list = Array.isArray(instance?.[kind]) ? instance[kind] : [];
  const name = slotNameFromHandle(handle, list);
  return name ? list.find((slot) => String(slot?.name || "") === name) || null : null;
};

/**
 * 找出一张图里所有违规的边。
 *
 * @param {object} graph 设计态图（槽位表应当已按定义对账过）
 * @returns {Array<{key: string, kind: string, message: string}>}
 */
export function workspaceGraphEdgeViolations(graph) {
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const out = [];
  const seen = new Map();
  for (const edge of edges) {
    const from = String(edge?.source ?? "");
    const to = String(edge?.target ?? "");
    const source = instances[from];
    const target = instances[to];
    // 两端节点都不在了的边是垃圾，不是违规——落盘时自会被丢掉，这里不拦
    if (!source || !target) continue;

    const fromSlot = slotOf(source, "output", edge?.sourceHandle);
    const toSlot = slotOf(target, "input", edge?.targetHandle);
    if (!fromSlot) {
      out.push({ key: `${from}|${edge?.sourceHandle}|${to}|${edge?.targetHandle}|missing-source`,
        kind: "slot_missing", message: `${from} 上没有 ${edge?.sourceHandle} 这个输出槽` });
      continue;
    }
    if (!toSlot) {
      out.push({ key: `${from}|${edge?.sourceHandle}|${to}|${edge?.targetHandle}|missing-target`,
        kind: "slot_missing", message: `${to} 上没有 ${edge?.targetHandle} 这个输入槽` });
      continue;
    }

    const key = `${from}|${fromSlot.name}|${to}|${toSlot.name}`;
    // 一个输入槽只能有一条入边。运行时只用第一条，后面的静默忽略——图看着是连的，值没到。
    const inputKey = `${to}|${toSlot.name}`;
    if (seen.has(inputKey)) {
      out.push({ key: `${key}|fan-in`, kind: "fan_in",
        message: `${to}.${toSlot.name} 同时被 ${seen.get(inputKey)} 和 ${from} 连入；一个输入槽只能有一条入边` });
    } else {
      seen.set(inputKey, from);
    }

    const compatibility = slotTypeCompatibility(fromSlot.type, toSlot.type);
    if (!compatibility.compatible) {
      out.push({ key: `${key}|type`, kind: "type_mismatch",
        message: `${from}.${fromSlot.name}(${compatibility.source}) -> ${to}.${toSlot.name}(${compatibility.target})：类型不兼容` });
    }
  }
  return out;
}

/**
 * 这次保存**新引入**了哪些违规。
 *
 * 只拦新增的，不拦存量：图里已经有一条坏边的话，一刀切会让作者连改都改不动——
 * 存不进去就没法修。存量由迁移和人工修复处理，闸门只负责不让新的进来。
 *
 * @param {object} storedGraph 磁盘上当前那张图
 * @param {object} nextGraph 这次要存的图
 * @returns {Array<{key: string, kind: string, message: string}>}
 */
export function introducedWorkspaceGraphEdgeViolations(storedGraph, nextGraph) {
  const existing = new Set(workspaceGraphEdgeViolations(storedGraph).map((v) => v.key));
  return workspaceGraphEdgeViolations(nextGraph).filter((v) => !existing.has(v.key));
}
