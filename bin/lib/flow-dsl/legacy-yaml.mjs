/**
 * `flow.yaml` -> Workspace 设计态图。**只给迁移用**，读图那条路不走这里。
 *
 * Start/End Pipeline 退休之后 `flow.yaml` 变成了一块墓碑：目录哨兵认它，所以流程还挂在
 * 列表里；`readWorkspaceGraphFiles` 不认它，所以画布上是空图、跑不了、也编辑不了。里面
 * 却存着作者真写过的东西——body、prompt、script。没有这条路的话，摘掉哨兵等于让这些内容
 * 从「坏的但看得见」变成「坏的且找不到」。
 *
 * 两种格式的**结构完全相同**（`instances` / `edges` / `ui`，`output-N` 索引式 handle），
 * 差的是节点词汇表：yaml 用的一批节点在 Workspace 运行时里 `runtime: none`。所以这里做的
 * 不是解析，是**改词**——外加一份诚实的损耗清单。
 *
 * 迁移不追求无损。追求的是：丢了什么，当场说清楚。
 */
import yaml from "js-yaml";

import { DEFINITIONS, definitionOf } from "./defs.mjs";
import { normalizeFlowYamlText } from "../flow-normalize.mjs";

/**
 * 换词表：`runtime: none` 的节点里，有对等物的那些。
 *
 * 换的是 `definitionId`，边按**槽位名**重接——不是按索引。索引会错：`tool_print` 的
 * `next` 在 0 号位，`display_markdown` 的 `next` 在 1 号位（0 号位是 `content` 输出）。
 * 照索引搬会把控制边接到内容槽上，图还是连通的，跑起来才发现错。
 */
export const LEGACY_NODE_REMAP = {
  // 老流程的入口 = Workspace 的运行节点。`next` 对 `next`。
  control_start: "workspace_run",
  // Workspace 没有「终点」这个概念，运行到没有后继就结束了。
  control_end: null,
  // 唯一的展示节点 -> Workspace 的展示节点。
  tool_print: "display_markdown",
  // 同名同形（prev/value -> next/prediction），但换过去之后语义靠 agent 兜，
  // 而 `parse-bool.mjs` 只认 true/1/yes/on。所以要单独提醒。
  control_toBool: "control_agent_toBool",
};

/** 换过去之后语义会松掉的，迁移时单独提醒一句。 */
const REMAP_CAVEATS = {
  control_toBool: "判定从确定性解析变成 agent 判定；prediction 只认 true/1/yes/on，模型答「是」会被当成 false",
};

/**
 * 换词之后新节点装不下的实例字段。留着的话往返比对过不去，整张图会退回 JSON——
 * 那等于因为一句文档说明放弃整次迁移。所以在这儿丢掉，并把原文报出去。
 */
const REMAP_DROPPED_FIELDS = {
  // 运行节点生成的是 `flow("标签", ...)`，没有正文位置（只有排程流程用 body 存排程 JSON）
  workspace_run: ["body"],
  // 换成 agent 节点之后 `script` 不再执行——判定改由模型给出，脚本留着只会误导
  control_agent_toBool: ["script"],
};

/** `output-3` -> 3；不是这个形状就返回 -1。 */
function handleIndex(handle) {
  const m = /^(?:input|output)-(\d+)$/.exec(String(handle || ""));
  return m ? Number(m[1]) : -1;
}

/** 实例自己声明的槽位数组；缺了就退回定义里的。 */
function slotsOf(instance, definitionId, kind) {
  const own = Array.isArray(instance?.[kind]) ? instance[kind] : null;
  if (own && own.length) return own;
  return definitionOf(definitionId)[kind] || [];
}

const isNodeSlot = (slot) => String(slot?.type || "") === "node";

/**
 * 把老实例的槽位搬到新定义的槽位表上：先对名字，对不上的按位置兜底。
 *
 * 位置兜底不是图省事——老流程会改槽位名。LikeeProduce 的 `tool_print` 输入槽叫 `summary`
 * 类型是 `file`，而展示节点的运行时按**名字**取内容（`workspaceWriteDisplayContent` 找
 * `content`，或者退而求其次找第一个 `text`）。只按名字对，这条边接不上；照搬旧名字，接上
 * 了运行时也读不到。所以要真的改名，并且把改名报出去。
 *
 * 兜底只在「都是控制槽」或「都不是控制槽」之间发生，不会把一条控制边挪到内容槽上。
 * 名字对上的先占位，占过的不参与兜底——否则 `tool_print` 的 `next` 会被 `content` 抢走。
 *
 * @returns {{ slots: object[], renames: Map<string, string> }} renames: 老槽位名 -> 新槽位名
 */
function rebuildSlots(oldSlots, newDefSlots) {
  const claimed = new Set();
  const picked = new Array(newDefSlots.length).fill(null);
  const renames = new Map();

  newDefSlots.forEach((def, i) => {
    const idx = oldSlots.findIndex((s, j) => !claimed.has(j) && String(s?.name || "") === String(def.name || ""));
    if (idx < 0) return;
    claimed.add(idx);
    picked[i] = oldSlots[idx];
  });
  newDefSlots.forEach((def, i) => {
    if (picked[i] || claimed.has(i)) return;
    const old = oldSlots[i];
    if (!old || isNodeSlot(old) !== isNodeSlot(def)) return;
    claimed.add(i);
    picked[i] = old;
    renames.set(String(old.name || ""), String(def.name || ""));
  });

  const slots = newDefSlots.map((def, i) => {
    const old = picked[i];
    // 类型跟新定义走。老槽位上的 `file` 在新节点上没有意义——运行时按新定义的类型读。
    const slot = { type: def.type, name: def.name, value: old?.value ?? def.value ?? "" };
    for (const key of ["required", "showOnNode", "description"]) {
      if (def[key] !== undefined) slot[key] = def[key];
    }
    return slot;
  });
  return { slots, renames };
}

/**
 * 把一份 `flow.yaml` 转成 Workspace 设计态图。
 *
 * @param {string} yamlText
 * @returns {{
 *   graph: object,
 *   remapped: Array<{ id: string, from: string, to: string, caveat?: string }>,
 *   dropped: Array<{ id: string, definitionId: string, reason: string }>,
 *   droppedEdges: Array<{ source: string, target: string, reason: string }>,
 *   warnings: string[],
 * }}
 */
export function legacyYamlToDesignGraph(yamlText) {
  const parsed = yaml.load(normalizeFlowYamlText(String(yamlText ?? "")).text);
  if (!parsed || typeof parsed !== "object") throw new Error("flow.yaml 解析不出对象");
  const srcInstances = parsed.instances && typeof parsed.instances === "object" ? parsed.instances : {};
  const srcEdges = Array.isArray(parsed.edges) ? parsed.edges : [];

  const remapped = [];
  const dropped = [];
  const droppedEdges = [];
  const warnings = [];

  /** id -> { input, output, renameIn, renameOut }，用来重接边。 */
  const kept = new Map();
  /** 丢了不算数的节点；指向它们的边跟着一起不算数。 */
  const benignDrops = new Set();
  const instances = {};

  for (const [id, raw] of Object.entries(srcInstances)) {
    const instance = raw && typeof raw === "object" ? raw : {};
    const from = String(instance.definitionId || "");
    const oldIn = slotsOf(instance, from, "input");
    const oldOut = slotsOf(instance, from, "output");

    const hasRemap = Object.prototype.hasOwnProperty.call(LEGACY_NODE_REMAP, from);
    const to = hasRemap ? LEGACY_NODE_REMAP[from] : from;

    // `control_end` 是唯一一个「丢了等于没丢」的：Workspace 里跑到没有后继就结束，
    // 终点节点本来就没有对应物需要表达。所以标 benign——报出来，但不算有损。
    if (hasRemap && to === null) {
      dropped.push({
        id,
        definitionId: from,
        benign: true,
        reason: "Workspace 没有终点节点，跑到没有后继就结束",
      });
      benignDrops.add(id);
      continue;
    }
    if (!hasRemap && definitionOf(from).runtime === "none") {
      dropped.push({
        id,
        definitionId: from,
        benign: false,
        reason: DEFINITIONS[from]
          ? "这个节点类型在 Workspace 运行时里没有实现，也没有对等物"
          : "未知节点类型",
      });
      continue;
    }

    if (to !== from) {
      const def = definitionOf(to);
      const rebuiltIn = rebuildSlots(oldIn, def.input || []);
      const rebuiltOut = rebuildSlots(oldOut, def.output || []);
      const next = { ...instance, definitionId: to, input: rebuiltIn.slots, output: rebuiltOut.slots };
      instances[id] = next;
      kept.set(id, {
        input: next.input,
        output: next.output,
        renameIn: rebuiltIn.renames,
        renameOut: rebuiltOut.renames,
      });
      const entry = { id, from, to };
      const droppedFields = [];
      for (const field of REMAP_DROPPED_FIELDS[to] || []) {
        const text = String(next[field] ?? "").trim();
        if (!text) continue;
        delete next[field];
        droppedFields.push({ field, text });
      }
      if (droppedFields.length) entry.droppedFields = droppedFields;
      const renames = [...rebuiltIn.renames, ...rebuiltOut.renames].map(([a, b]) => `${a} -> ${b}`);
      if (renames.length) entry.renamedSlots = renames;
      if (REMAP_CAVEATS[from]) entry.caveat = REMAP_CAVEATS[from];
      remapped.push(entry);
    } else {
      // 原样保留：`tool_nodejs` 这类带动态槽位的节点，实例上的槽位表就是权威，
      // 拿定义去覆盖会把作者加的输入抹掉。
      const next = { ...instance, input: [...oldIn], output: [...oldOut] };
      instances[id] = next;
      kept.set(id, { input: next.input, output: next.output, renameIn: new Map(), renameOut: new Map() });
    }
  }

  // ── 重接边：索引 -> 老槽位名 -> 新索引 ─────────────────────────────────────
  const edges = [];
  const takenTargets = new Set();
  for (const edge of srcEdges) {
    const source = String(edge?.source || "");
    const target = String(edge?.target || "");
    const from = kept.get(source);
    const to = kept.get(target);
    if (!from || !to) {
      const missing = !from ? source : target;
      droppedEdges.push({ source, target, benign: benignDrops.has(missing), reason: `${missing} 已丢弃` });
      continue;
    }
    const srcSlots = slotsOf(srcInstances[source], srcInstances[source]?.definitionId, "output");
    const tgtSlots = slotsOf(srcInstances[target], srcInstances[target]?.definitionId, "input");
    const srcName = srcSlots[handleIndex(edge.sourceHandle)]?.name;
    const tgtName = tgtSlots[handleIndex(edge.targetHandle)]?.name;
    // 换词时改过名的槽位，按新名字找
    const srcFinal = from.renameOut.get(String(srcName)) ?? srcName;
    const tgtFinal = to.renameIn.get(String(tgtName)) ?? tgtName;
    const srcIdx = from.output.findIndex((s) => s.name === srcFinal);
    const tgtIdx = to.input.findIndex((s) => s.name === tgtFinal);
    if (srcIdx < 0 || tgtIdx < 0) {
      droppedEdges.push({
        source,
        target,
        benign: false,
        reason: `新节点上找不到槽位 ${srcIdx < 0 ? `${source}.${srcFinal ?? edge.sourceHandle}` : `${target}.${tgtFinal ?? edge.targetHandle}`}`,
      });
      continue;
    }
    // Workspace 禁止 fan-in：同一个输入槽只能有一条入边。老图里靠 control_anyOne
    // 汇合的分支，删掉汇合点之后会撞在同一个槽上。
    const key = `${target} input-${tgtIdx}`;
    if (takenTargets.has(key)) {
      droppedEdges.push({ source, target, benign: false, reason: `${target}.${tgtFinal} 已经有入边了，Workspace 不允许 fan-in` });
      continue;
    }
    takenTargets.add(key);
    edges.push({ source, target, sourceHandle: `output-${srcIdx}`, targetHandle: `input-${tgtIdx}` });
  }

  // ── ui ────────────────────────────────────────────────────────────────────
  const srcUi = parsed.ui && typeof parsed.ui === "object" ? parsed.ui : {};
  const nodePositions = {};
  for (const [id, pos] of Object.entries(srcUi.nodePositions || {})) {
    if (kept.has(id)) nodePositions[id] = pos;
  }
  const ui = { nodePositions, nodeSizes: {} };
  if (typeof srcUi.description === "string" && srcUi.description.trim()) ui.description = srcUi.description;

  if (!Object.keys(instances).length) warnings.push("迁移之后一个节点都不剩");
  else if (![...kept.keys()].some((id) => instances[id].definitionId === "workspace_run")) {
    warnings.push("图里没有运行节点（老流程缺 control_start）；补一个 workspace_run 才能跑");
  }

  return { graph: { version: 1, instances, edges, ui }, remapped, dropped, droppedEdges, warnings };
}
