/**
 * Workspace 图的设计态 / 运行态分离。
 *
 * `workspace.graph.json` 原本一个文件装三样东西：图结构、运行产出、画布布局。真实语料
 * 里运行产出占 33.6%（21 个流程 1.38 MB 中的 465 KB），每跑一次就变一次——既污染 diff，
 * 也让 AI 生成的图和跑过的图无法比对。
 *
 * 这里把运行态抽到 `workspace.state.json`：
 *
 * ```
 * workspace.graph.json   设计态：节点、连线、位置、作者写的内容
 * workspace.state.json   运行态：输出槽产出、展示节点的运行内容、视口
 * ```
 *
 * **这是纯存储层的改动。** `readWorkspaceGraph` 合并两个文件后返回的图与拆分前逐字节
 * 相同，上层（含 designRevision 的计算）看不到任何区别。
 *
 * 哪些算运行态，与 `workspace-graph-merge.mjs` 的 `isRuntimePath` 保持同一套判断：
 *
 * - 非 provide 节点的 `output[*].value` / `.default`——provide 节点的输出值是用户填的
 * - `displayReloadKey`
 * - `ui.viewport`
 * - **有内容入边**的展示节点的 `body`
 *
 * 最后一条是唯一需要看图结构才能判断的：展示节点没有内容入边时，`body` 是作者手写的
 * 文档（语料里有 29 个这样的节点、64 KB），当成运行态外移就等于删掉它们。判断规则与
 * ui-server 运行循环里的 `workspaceContentInputEdge` 完全一致。
 */

export const WORKSPACE_STATE_FILENAME = "workspace.state.json";

const STATE_VERSION = 1;

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isProvideDefinition(definitionId) {
  return String(definitionId || "").startsWith("provide_");
}

function isDisplayDefinition(definitionId) {
  return String(definitionId || "").startsWith("display_");
}

/**
 * 语义入槽——连到这些槽上的边不代表「内容由上游驱动」。
 * 与 ui-server 的 `isWorkspaceSemanticInputSlot` 逐字一致；改一处必须改两处。
 */
function isSemanticInputSlot(slot) {
  const name = String(slot?.name || "");
  const type = String(slot?.type || "");
  return type === "node"
    || name === "prev" || name === "next"
    || name === "skillsContext" || name === "mcpContext"
    || name === "knowledgeContext" || name === "workspaceContext" || name === "gitContext";
}

function handleIndex(handle, prefix) {
  const match = String(handle || "").match(new RegExp(`^${prefix}-(\\d+)$`));
  return match ? Number(match[1]) : 0;
}

/**
 * 展示节点是否由上游内容驱动。复刻 ui-server 的 `workspaceContentInputEdge`：
 * 收集入边，去掉指向语义槽的，剩下任意一条就说明 body 是运行产出。
 *
 * 不能简单地按 `targetHandle !== "input-0"` 近似——语料里有 32 个实例的槽位顺序不规范，
 * input-0 未必是 prev；语义槽也可能出现在更靠后的位置。
 */
function displayNodeIdsDrivenByEdges(graph) {
  const out = new Set();
  const instances = isPlainObject(graph?.instances) ? graph.instances : {};
  for (const edge of Array.isArray(graph?.edges) ? graph.edges : []) {
    const targetId = String(edge?.target || "");
    const target = instances[targetId];
    if (!targetId || !isDisplayDefinition(target?.definitionId)) continue;
    const input = Array.isArray(target?.input) ? target.input : [];
    if (isSemanticInputSlot(input[handleIndex(edge?.targetHandle, "input")] || null)) continue;
    out.add(targetId);
  }
  return out;
}

/** 输出槽名在实例内唯一时才按名字外移；重名就整个实例放弃外移，宁可留在设计里也不丢值。 */
function outputSlotNamesAreUnique(instance) {
  const names = (Array.isArray(instance?.output) ? instance.output : []).map((s) => String(s?.name ?? ""));
  return new Set(names).size === names.length;
}

/**
 * 把一张完整的图拆成设计态和运行态。
 * @param {object} graph
 * @returns {{ design: object, state: object }}
 */
export function splitWorkspaceGraph(graph) {
  const source = isPlainObject(graph) ? graph : {};
  const instances = isPlainObject(source.instances) ? source.instances : {};
  const displayDriven = displayNodeIdsDrivenByEdges(source);

  const outputs = {};
  const displayBodies = {};
  const displayReloadKeys = {};
  const designInstances = {};

  for (const [nodeId, raw] of Object.entries(instances)) {
    if (!isPlainObject(raw)) {
      designInstances[nodeId] = raw;
      continue;
    }
    const instance = { ...raw };

    if (instance.displayReloadKey !== undefined) {
      displayReloadKeys[nodeId] = instance.displayReloadKey;
      delete instance.displayReloadKey;
    }

    if (isDisplayDefinition(instance.definitionId) && displayDriven.has(nodeId) && instance.body !== undefined) {
      displayBodies[nodeId] = instance.body;
      delete instance.body;
    }

    if (!isProvideDefinition(instance.definitionId)
      && Array.isArray(instance.output)
      && outputSlotNamesAreUnique(instance)) {
      const slotState = {};
      instance.output = instance.output.map((slot) => {
        if (!isPlainObject(slot)) return slot;
        const name = String(slot.name ?? "");
        const entry = {};
        if (slot.value !== undefined) entry.value = slot.value;
        if (slot.default !== undefined) entry.default = slot.default;
        if (!Object.keys(entry).length) return slot;
        slotState[name] = entry;
        const clean = { ...slot };
        delete clean.value;
        delete clean.default;
        return clean;
      });
      if (Object.keys(slotState).length) outputs[nodeId] = slotState;
    }

    designInstances[nodeId] = instance;
  }

  const design = { ...source, instances: designInstances };
  if (isPlainObject(source.ui)) {
    const ui = { ...source.ui };
    delete ui.viewport;
    design.ui = ui;
  }

  const state = { version: STATE_VERSION };
  if (Object.keys(outputs).length) state.outputs = outputs;
  if (Object.keys(displayBodies).length) state.displayBodies = displayBodies;
  if (Object.keys(displayReloadKeys).length) state.displayReloadKeys = displayReloadKeys;
  if (isPlainObject(source.ui) && source.ui.viewport !== undefined) state.viewport = source.ui.viewport;

  return { design, state };
}

/**
 * 把运行态合回设计态。`state` 为空时原样返回设计态，因此对尚未拆分的旧图是恒等操作。
 * @param {object} design
 * @param {object|null} state
 * @returns {object}
 */
export function mergeWorkspaceState(design, state) {
  const base = isPlainObject(design) ? design : {};
  if (!isPlainObject(state)) return base;

  const outputs = isPlainObject(state.outputs) ? state.outputs : {};
  const displayBodies = isPlainObject(state.displayBodies) ? state.displayBodies : {};
  const displayReloadKeys = isPlainObject(state.displayReloadKeys) ? state.displayReloadKeys : {};
  const instances = isPlainObject(base.instances) ? base.instances : {};

  const merged = {};
  for (const [nodeId, raw] of Object.entries(instances)) {
    if (!isPlainObject(raw)) {
      merged[nodeId] = raw;
      continue;
    }
    const instance = { ...raw };

    if (Object.prototype.hasOwnProperty.call(displayBodies, nodeId)) {
      instance.body = displayBodies[nodeId];
    }
    if (Object.prototype.hasOwnProperty.call(displayReloadKeys, nodeId)) {
      instance.displayReloadKey = displayReloadKeys[nodeId];
    }

    const slotState = outputs[nodeId];
    if (isPlainObject(slotState) && Array.isArray(instance.output)) {
      instance.output = instance.output.map((slot) => {
        if (!isPlainObject(slot)) return slot;
        const entry = slotState[String(slot.name ?? "")];
        if (!isPlainObject(entry)) return slot;
        const next = { ...slot };
        if (entry.value !== undefined) next.value = entry.value;
        if (entry.default !== undefined) next.default = entry.default;
        return next;
      });
    }

    merged[nodeId] = instance;
  }

  const out = { ...base, instances: merged };
  if (state.viewport !== undefined) {
    out.ui = { ...(isPlainObject(base.ui) ? base.ui : {}), viewport: state.viewport };
  }
  return out;
}

/** 运行态里没有任何内容时为 true——此时不必落盘 state 文件。 */
export function isEmptyWorkspaceState(state) {
  if (!isPlainObject(state)) return true;
  return !state.outputs && !state.displayBodies && !state.displayReloadKeys && state.viewport === undefined;
}
