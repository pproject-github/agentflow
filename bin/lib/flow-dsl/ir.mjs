/**
 * 设计态图 <-> 规范 IR。
 *
 * IR 是代码生成和解析的共同中间表示，两条方向都以它为准，因此往返能证明。它与
 * `workspace.graph.json` 的关键差别只有一处：
 *
 * **边按槽名记录，不按句柄下标。** 图里的边是 `output-1 -> input-2`，下标依赖实例
 * 自己的槽位数组顺序；而槽位顺序是实例级的（语料里 32 个实例的顺序偏离定义表），
 * 从代码反推不出来。改成 `源节点|源槽名|目标节点|目标槽名` 后，代码里写
 * `{ content: agent1.result }` 就能无歧义地还原成一条边；下标由 layout 里的
 * `pinOrder` 负责恢复。
 */
import {
  CTRL_SLOTS,
  STD_SLOTS,
  definitionOf,
  isControlSlot,
  isDisplayDefinition,
  isProvideDefinition,
} from "./defs.mjs";

/**
 * 正文默认镜像自「第一个有值的文本入参」的节点类型。
 *
 * 展示节点的 `body` 和内容引脚在 UI 里本来就是同一份东西，代码里写两遍纯属噪音，所以
 * 只写引脚、正文由 `irToGraph` 反推。**唯一的例外**——引脚有值但正文被清空了——反推会
 * 凭空造出正文，所以那种情况在 nodes.json 里显式记 `bodyMirror: false`。
 */
export function mirrorsBodyFromPin(definitionId) {
  return isDisplayDefinition(definitionId) || definitionId === "control_load_skills";
}

/** 这个实例是否属于上面说的例外：内容引脚有值，正文却是空的。 */
export function bodyMirrorSuppressed(instance) {
  if (!mirrorsBodyFromPin(String(instance?.definitionId || ""))) return false;
  if (String(instance?.body ?? "").trim()) return false;
  return (Array.isArray(instance?.input) ? instance.input : []).some(
    (s) => String(s?.type) === "text" && String(s?.value ?? "").trim(),
  );
}

/** 代码里不体现、由 nodes.json 承载的实例属性。 */
export const NODE_META_KEYS = [
  "model",
  "marketplaceRef",
  "marketplacePackageId",
  "marketplaceVersion",
  "sourceContextRunNodeId",
];

function handleIndex(handle) {
  const m = /-(\d+)$/.exec(String(handle || ""));
  return m ? Number(m[1]) : 0;
}

/**
 * 把设计态图转成 IR。
 *
 * 传进来的应当是 `splitWorkspaceGraph().design`——运行产出已经不在里面，所以这里
 * 不必再判断哪些值是跑出来的。
 */
export function graphToIr(graph) {
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  const slotAt = (id, kind, handle) => (instances[id]?.[kind] || [])[handleIndex(handle)];

  const edges = [];
  const wiredInputs = new Set();
  for (const edge of Array.isArray(graph?.edges) ? graph.edges : []) {
    if (!instances[edge?.source] || !instances[edge?.target]) continue;
    const from = slotAt(edge.source, "output", edge.sourceHandle);
    const to = slotAt(edge.target, "input", edge.targetHandle);
    if (!from || !to) continue;
    edges.push(`${edge.source}|${from.name}|${edge.target}|${to.name}`);
    if (!isControlSlot(to)) wiredInputs.add(`${edge.target}|${to.name}`);
  }

  const nodes = {};
  const slotOrder = {};
  for (const [id, instance] of Object.entries(instances)) {
    const definitionId = String(instance.definitionId || "");
    const def = definitionOf(definitionId);
    const defInputs = new Set(def.input.map((s) => s.name));
    const defOutputs = new Set(def.output.map((s) => s.name));

    const node = { definitionId, attrs: {} };
    if (String(instance.label || "").trim()) node.label = String(instance.label);
    if (String(instance.script || "").trim()) node.script = String(instance.script);
    for (const key of NODE_META_KEYS) {
      if (String(instance[key] || "").trim()) node.attrs[key] = String(instance[key]);
    }
    if (String(instance.role || "").trim() && String(instance.role) !== "normal") {
      node.attrs.role = String(instance.role);
    }
    if (instance.images !== undefined && instance.images !== null) node.attrs.images = instance.images;
    if (instance.globalContext === true) node.attrs.globalContext = true;

    node.inputs = {};
    node.inputTypes = {};
    node.outputs = {};
    node.extraIn = [];
    node.extraOut = [];

    for (const slot of instance.input || []) {
      const name = String(slot?.name || "");
      if (!name) continue;
      // 既不在定义表里、也不是标准槽的，是这个实例自己加的槽，代码里要显式声明
      if (!STD_SLOTS.has(name) && !defInputs.has(name) && String(slot.type) !== "node") {
        node.extraIn.push(name);
        // 自定义槽的类型在定义表里查不到，只能随槽本身走一趟 IR，否则往返一次
        // bool 槽就退化成 text，代码里的 `true` 变成 `"true"`
        if (slot.type && String(slot.type) !== "text") node.inputTypes[name] = String(slot.type);
      }
      if (isControlSlot(slot) || wiredInputs.has(`${id}|${name}`)) continue;
      const value = String(slot.value ?? slot.default ?? "");
      if (value.trim()) node.inputs[name] = value;
    }

    if (String(instance.body || "").trim()) {
      // 展示类节点的 body 常常只是「第一个有值的文本入参」的副本；这种镜像不进代码，
      // 由 irToGraph 用同一条规则反推，两边逻辑闭合。
      const firstText = (instance.input || []).find(
        (s) => String(s?.type) === "text" && String(s?.value ?? "").trim(),
      );
      const mirrored = mirrorsBodyFromPin(definitionId)
        && firstText
        && String(firstText.value) === String(instance.body);
      if (!mirrored) node.body = String(instance.body);
    }

    for (const slot of instance.output || []) {
      const name = String(slot?.name || "");
      if (!name) continue;
      if (!STD_SLOTS.has(name) && !defOutputs.has(name) && String(slot.type) !== "node") node.extraOut.push(name);
      // 设计态里只有 provide_* 的输出值是作者填的，其余都是运行产出（已被 Phase 0 剥离）
      if (!isProvideDefinition(definitionId) || isControlSlot(slot)) continue;
      const value = String(slot.value ?? slot.default ?? "");
      if (value.trim()) node.outputs[name] = value;
    }

    nodes[id] = node;
    slotOrder[id] = {
      in: (instance.input || []).map((s) => String(s?.name || "")),
      out: (instance.output || []).map((s) => String(s?.name || "")),
    };
  }

  return { nodes, edges: [...new Set(edges)].sort(), slotOrder };
}

/**
 * 自定义输入槽的类型推断：**跟着连它的那个上游输出槽走**。
 *
 * 代码里 `{ sample: count.sample }` 只说了「接哪」，没说这个槽是什么类型——而类型决定运行时
 * 怎么送值：`workspaceLinkedOutputShouldStayPath` 看的是**目标槽**的 type，`file` 才保留路径，
 * 否则把文件内容读出来内联。自定义槽以前一律建成 `text`，于是一个 `file` 输出接过去，脚本
 * 拿到的是整个文件的内容（还被 shell 引号包住）：
 *
 *     wc -l < '2026-08-10 row-1
 *     2026-08-10 row-2'          →  No such file or directory
 *
 * 唯一能救的是名字启发式（`xxxPath` / `xxxFile` 结尾），也就是说对不对全看作者怎么起名。
 * 改成随上游走之后，`{ sample: count.sample }` 直接就是 `file` 槽。
 *
 * 只有 `bool` 能被代码自己带回来（字面量 `true` 看得出类型）；其余偏离推断的类型由
 * `layout.json` 的 `pins.<kind>.<name>.type` 记一条——和 `pinOrder` 同一个套路，
 * 只记偏离，历史数据因此原样往返。
 *
 * @param {object} ir
 * @returns {(nodeId: string, slotName: string) => string}
 */
export function customInputTypeResolver(ir) {
  const wired = new Map();
  for (const key of ir?.edges || []) {
    const [source, fromSlot, target, toSlot] = String(key).split("|");
    if (target && toSlot && !wired.has(`${target}|${toSlot}`)) wired.set(`${target}|${toSlot}`, { source, fromSlot });
  }
  const outputTypeOf = (nodeId, slotName) => {
    const node = ir?.nodes?.[nodeId];
    if (!node) return "";
    const defSlots = node.packageDef ? node.packageDef.output : definitionOf(node.definitionId).output;
    return String((defSlots || []).find((s) => s?.name === slotName)?.type || "");
  };
  return (nodeId, slotName) => {
    const link = wired.get(`${nodeId}|${slotName}`);
    if (!link) return "text";
    // 上游是自定义输出槽（解构出来的）时查不到类型，那就还是 text
    return outputTypeOf(link.source, link.fromSlot) || "text";
  };
}

/**
 * IR + layout -> 设计态图。
 *
 * 槽位数组按「定义表顺序 + 代码里出现的自定义槽」重建；layout 里记了 `pinOrder`
 * 的实例用记录的顺序，因为那是偏离规范序的历史数据。边的句柄下标由重建后的顺序反查。
 */
export function irToGraph(ir, layout = { nodes: {} }, nodeMeta = { nodes: {} }) {
  const instances = {};
  const slotIndex = {};
  const inferInputType = customInputTypeResolver(ir);

  for (const [id, node] of Object.entries(ir.nodes)) {
    const def = definitionOf(node.definitionId);
    const layoutEntry = layout.nodes?.[id] || {};
    const meta = nodeMeta.nodes?.[id] || {};

    const buildSlots = (kind) => {
      // 代码节点包自带槽位表；基础类型只是运行方式，不决定这个节点有哪些引脚
      const pkgDef = node.packageDef;
      const defSlots = pkgDef
        ? (kind === "in" ? pkgDef.input : pkgDef.output)
        : (kind === "in" ? def.input : def.output);
      const extras = (kind === "in" ? node.extraIn : node.extraOut)
        .filter((name) => !defSlots.some((s) => s.name === name));
      const names = layoutEntry.pinOrder?.[kind] || [...defSlots.map((s) => s.name), ...extras];
      const byName = new Map(defSlots.map((s) => [s.name, s]));
      return names.map((name) => {
        const d = byName.get(name);
        const overrides = layoutEntry.pins?.[kind]?.[name] || {};
        // 自定义槽的类型：代码里带得回来的（bool 字面量）优先，其次 layout 记的偏离，
        // 最后随上游输出槽推断。输出槽没有上游可随，记了什么就是什么，没记就是 text。
        const custom = kind === "in"
          ? (node.inputTypes?.[name] || overrides.type || inferInputType(id, name))
          : overrides.type;
        const slot = {
          type: d ? d.type : (custom || (name === "prev" || name === "next" ? "node" : "text")),
          name,
          value: "",
        };
        if (d?.description) slot.description = d.description;
        if (d?.required) slot.required = true;
        if (d?.showOnNode) slot.showOnNode = true;
        for (const key of ["showOnNode", "required"]) {
          if (key in overrides) slot[key] = overrides[key];
        }
        return slot;
      });
    };

    const input = buildSlots("in");
    const output = buildSlots("out");
    slotIndex[id] = {
      in: new Map(input.map((s, i) => [s.name, i])),
      out: new Map(output.map((s, i) => [s.name, i])),
    };

    const instance = { definitionId: node.definitionId };
    if (node.label) instance.label = node.label;
    // `role: "normal"` 就是没写 role 的意思，别把默认值写回图里
    if (meta.role !== undefined) instance.role = meta.role;
    for (const key of NODE_META_KEYS) if (meta[key] !== undefined) instance[key] = meta[key];
    // 从 `import x from "./nodes/x"` 推出来的引用信息压过 nodes.json——代码里写的那个
    // import 才是作者的意思，nodes.json 只是上一次落盘的记录
    for (const key of NODE_META_KEYS) if (node.attrs?.[key] !== undefined) instance[key] = node.attrs[key];
    if (meta.images !== undefined) instance.images = meta.images;
    if (meta.globalContext === true) instance.globalContext = true;
    instance.input = input;
    instance.output = output;
    if (node.script) instance.script = node.script;

    for (const [name, value] of Object.entries(node.inputs || {})) {
      const i = slotIndex[id].in.get(name);
      if (i != null) input[i].value = value;
    }
    for (const [name, value] of Object.entries(node.outputs || {})) {
      const i = slotIndex[id].out.get(name);
      if (i != null) output[i].value = value;
    }

    if (node.body) instance.body = node.body;
    if (!instance.body && meta.bodyMirror !== false && mirrorsBodyFromPin(node.definitionId)) {
      // 与 graphToIr 的镜像判断成对：body 省略了就从第一个有值的文本入参反推。
      // 只补 body——同名输出槽的值属于运行态（在 workspace.state.json 里），这里凭空
      // 造一个会让设计态多出一份原图没有的产出。
      const primary = input.find((s) => s.type === "text" && String(s.value || "").trim());
      if (primary) instance.body = primary.value;
    }

    instances[id] = instance;
  }

  const edges = ir.edges.map((key) => {
    const [source, fromSlot, target, toSlot] = key.split("|");
    return {
      source,
      target,
      sourceHandle: `output-${slotIndex[source]?.out.get(fromSlot) ?? 0}`,
      targetHandle: `input-${slotIndex[target]?.in.get(toSlot) ?? 0}`,
    };
  });

  const ui = { nodePositions: {}, nodeSizes: {} };
  for (const [id, entry] of Object.entries(layout.nodes || {})) {
    if (entry.x !== undefined) ui.nodePositions[id] = { x: entry.x, y: entry.y };
    if (entry.w !== undefined) ui.nodeSizes[id] = { width: entry.w, height: entry.h };
  }
  for (const [key, value] of Object.entries(layout)) {
    if (!["version", "nodes", "viewport"].includes(key)) ui[key] = value;
  }
  if (layout.viewport) ui.viewport = layout.viewport;

  return { version: 1, instances, edges, ui };
}

export { CTRL_SLOTS, STD_SLOTS };
