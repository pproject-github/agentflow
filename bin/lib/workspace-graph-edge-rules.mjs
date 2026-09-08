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

/**
 * 这次保存是不是「节点全在、连线全没」。
 *
 * 0.1.190 的教训：画布加载时把边的句柄换算漏了一处，React Flow 匹配不到任何 handle，
 * 整张图的边被丢掉。画布手里从此是一张没有边的图，用户随后**任何一次保存**都把这个
 * 状态写回磁盘——一个渲染 bug 就这样变成了不可恢复的数据删除，3 个线上流程的连线没了，
 * 服务端没有任何快照能恢复。
 *
 * 所以存图这一步要能分辨「用户删了线」和「线在别处丢了」。两者的形态不一样：
 * 人删线是一条一条来的，每次保存少一两条；渲染失败是**一次全没**，而节点一个不少。
 * 只拦后者——判据窄，但那正是会造成不可逆损失的那一种。
 *
 * 故意清空全部连线的人还有路可走：先删掉任意一个节点，或者分两次删。宁可让这种
 * 罕见操作多一步，也不能让一次静默保存抹掉别人的图。
 *
 * @param {object} storedGraph 磁盘上当前那张图
 * @param {object} nextGraph 这次要存的图
 * @returns {{removedEdges: number, keptNodes: number}|null} 命中时返回细节，否则 null
 */
export function edgeWipeWithoutNodeDeletion(storedGraph, nextGraph) {
  const storedInstances = storedGraph?.instances && typeof storedGraph.instances === "object" ? storedGraph.instances : {};
  const nextInstances = nextGraph?.instances && typeof nextGraph.instances === "object" ? nextGraph.instances : {};
  const storedEdges = Array.isArray(storedGraph?.edges) ? storedGraph.edges : [];
  const nextEdges = Array.isArray(nextGraph?.edges) ? nextGraph.edges : [];

  // 一条边都没有过的图，谈不上被抹掉；只有一条时也可能就是人手删的
  if (storedEdges.length < 2 || nextEdges.length > 0) return null;
  const storedIds = Object.keys(storedInstances);
  if (!storedIds.length) return null;
  // 删过节点就不是这个形态——删节点连带删线是正常编辑
  if (storedIds.some((id) => !Object.prototype.hasOwnProperty.call(nextInstances, id))) return null;

  return { removedEdges: storedEdges.length, keptNodes: storedIds.length };
}
