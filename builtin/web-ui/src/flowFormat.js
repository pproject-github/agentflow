/**
 * 画布上的节点/实例互转，以及复制粘贴。
 *
 * 这个文件原本还有 flow.yaml 的读写（`deserializeFromFlowYaml` / `serializeToFlowYaml`），
 * 随 Start/End Pipeline 运行时一起退休后没人再调，但它长得和真正的加载入口一模一样：
 * 0.1.190 把边的身份换成槽位名时，改的就是这份死代码，活着的 `graphToFlow` 因此没人看，
 * 上线后整张图的连线全不见。留着一份没人跑的同形代码，就是留着一个让人改错地方的靶子。
 */

export const VALID_ROLES = ["requirement", "planning", "code", "test", "normal"];

const ROLE_ZH_TO_KEY = {
  普通: "normal",
  技术规划: "planning",
  代码执行: "code",
  测试回归: "test",
  需求拆解: "requirement",
};

/**
 * 将画布节点与已有 instances 合并，生成写回图的 instances（含节点上可编辑字段）。
 * @param {import('@xyflow/react').Node[]} nodes
 * @param {Record<string, any>} instancesMap
 * @returns {Record<string, any>}
 */
export function buildInstancesForYaml(nodes, instancesMap) {
  const toSlotValue = (s) => {
    const slot = {
      type: s?.type ?? "node",
      name: s?.name ?? "",
      value: s?.value ?? s?.default ?? "",
    };
    if (s?.required === true) slot.required = true;
    if (s?.description != null && String(s.description).trim()) slot.description = String(s.description);
    if (s?.showOnNode != null) slot.showOnNode = Boolean(s.showOnNode);
    return slot;
  };
  const instances = {};
  for (const n of nodes) {
    if (n?.data?.isWorkspaceGroup) continue;
    const base =
      instancesMap[n.id] && typeof instancesMap[n.id] === "object" ? { ...instancesMap[n.id] } : {};
    const defId = n.data?.definitionId || n.id;
    const dataInputs = n.data?.inputs ?? [];
    const dataOutputs = n.data?.outputs ?? [];
    const rawR = n.data?.role != null ? String(n.data.role).trim() : "";
    const rawBaseR = base.role != null ? String(base.role).trim() : "";
    const normalizedR = ROLE_ZH_TO_KEY[rawR] || rawR;
    const normalizedBaseR = ROLE_ZH_TO_KEY[rawBaseR] || rawBaseR;
    const role = VALID_ROLES.includes(normalizedR)
      ? normalizedR
      : VALID_ROLES.includes(normalizedBaseR)
        ? normalizedBaseR
        : "normal";

    // Prefer current canvas/node data so NodeProperties edits persist;
    // fall back to base instance only when node data is unavailable.
    const input = Array.isArray(dataInputs)
      ? dataInputs.map(toSlotValue)
      : Array.isArray(base.input)
        ? base.input.map((s) => toSlotValue(s))
        : [];
    const output = Array.isArray(dataOutputs)
      ? dataOutputs.map(toSlotValue)
      : Array.isArray(base.output)
        ? base.output.map((s) => toSlotValue(s))
        : [];

    const label =
      n.data?.label != null ? String(n.data.label) : base.label != null ? String(base.label) : n.id;

    const bodyFromData = n.data?.body;
    const body =
      bodyFromData != null ? String(bodyFromData) : base.body != null ? String(base.body) : "";

    let model =
      n.data?.model != null && String(n.data.model).trim() !== ""
        ? String(n.data.model).trim()
        : base.model != null && String(base.model).trim() !== ""
          ? String(base.model).trim()
          : undefined;
    if (model === "" || model === "default") model = undefined;

    /** @type {Record<string, unknown>} */
    const rec = {
      ...base,
      definitionId: defId,
      label,
      role,
      model,
      input,
      output,
    };

    const marketplaceRef = n.data?.marketplaceRef || base.marketplaceRef;
    if (marketplaceRef) rec.marketplaceRef = String(marketplaceRef);
    else delete rec.marketplaceRef;
    const marketplacePackageId = n.data?.marketplacePackageId || base.marketplacePackageId;
    if (marketplacePackageId) rec.marketplacePackageId = String(marketplacePackageId);
    else delete rec.marketplacePackageId;
    const marketplaceVersion = n.data?.marketplaceVersion || base.marketplaceVersion;
    if (marketplaceVersion) rec.marketplaceVersion = String(marketplaceVersion);
    else delete rec.marketplaceVersion;

    if (defId.startsWith("provide_") || body.trim() === "") {
      delete rec.body;
    } else {
      rec.body = body;
    }

    const images = Array.isArray(n.data?.images)
      ? n.data.images
      : Array.isArray(base.images)
        ? base.images
        : [];
    if (images.length > 0) {
      rec.images = images;
    } else {
      delete rec.images;
    }

    const scriptFromData = n.data?.script;
    const script =
      scriptFromData !== undefined && scriptFromData !== null
        ? String(scriptFromData)
        : base.script != null
          ? String(base.script)
          : "";
    if (script.trim() === "") {
      delete rec.script;
    } else {
      rec.script = script;
    }

    for (const key of ["scriptRef", "implementationRef", "implementationMode"]) {
      const fromData = n.data?.[key];
      const value =
        fromData !== undefined && fromData !== null
          ? String(fromData)
          : base[key] != null
            ? String(base[key])
            : "";
      if (value.trim() === "") delete rec[key];
      else rec[key] = value.trim();
    }

    delete rec.temperature;
    delete rec.maxTokens;
    delete rec.description;

    instances[n.id] = rec;
  }
  return instances;
}

function clonePlain(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function nextCopyId(baseId, usedIds) {
  const base = String(baseId || "node").replace(/_copy(?:_\d+)?$/i, "");
  let candidate = `${base}_copy`;
  let i = 2;
  while (usedIds.has(candidate)) {
    candidate = `${base}_copy_${i}`;
    i += 1;
  }
  usedIds.add(candidate);
  return candidate;
}

export function buildCanvasClipboard(nodes, edges, instancesMap) {
  const selectedNodes = (nodes || []).filter((node) => node?.selected);
  if (selectedNodes.length === 0) return null;
  const selectedIds = new Set(selectedNodes.map((node) => node.id));
  const selectedEdges = (edges || []).filter((edge) => selectedIds.has(edge.source) && selectedIds.has(edge.target));
  return {
    version: 1,
    nodes: selectedNodes.map((node) => clonePlain(node)),
    edges: selectedEdges.map((edge) => clonePlain(edge)),
    instances: buildInstancesForYaml(selectedNodes, instancesMap || {}),
  };
}

export function pasteCanvasClipboard(clipboard, nodes, edges, instancesMap, options = {}) {
  if (!clipboard || !Array.isArray(clipboard.nodes) || clipboard.nodes.length === 0) return null;
  const offset = options.offset || { x: 48, y: 48 };
  const usedIds = new Set((nodes || []).map((node) => node.id));
  const idMap = new Map();
  for (const node of clipboard.nodes) {
    idMap.set(node.id, nextCopyId(node.id, usedIds));
  }
  const nextNodes = clipboard.nodes.map((node) => {
    const id = idMap.get(node.id);
    return {
      ...clonePlain(node),
      id,
      selected: true,
      dragging: false,
      position: {
        x: Number(node.position?.x || 0) + offset.x,
        y: Number(node.position?.y || 0) + offset.y,
      },
    };
  });
  const nextEdges = (clipboard.edges || [])
    .filter((edge) => idMap.has(edge.source) && idMap.has(edge.target))
    .map((edge, index) => {
      const source = idMap.get(edge.source);
      const target = idMap.get(edge.target);
      return {
        ...clonePlain(edge),
        id: `e-${source}-${target}-${Date.now()}-${index}`,
        source,
        target,
        selected: false,
      };
    });
  const nextInstances = { ...(instancesMap || {}) };
  for (const [oldId, newId] of idMap.entries()) {
    const inst = clipboard.instances?.[oldId];
    if (inst) nextInstances[newId] = { ...clonePlain(inst), label: inst.label != null ? String(inst.label) : newId };
  }
  return {
    nodes: [...(nodes || []).map((node) => ({ ...node, selected: false })), ...nextNodes],
    edges: [...(edges || []).map((edge) => ({ ...edge, selected: false })), ...nextEdges],
    instances: nextInstances,
    pastedNodeIds: nextNodes.map((node) => node.id),
  };
}

/**
 * @param {import('@xyflow/react').Node[]} nodes
 * @param {import('@xyflow/react').Edge[]} edges
 * @param {Record<string, any>} instancesMap
 * @param {{ description?: string, viewport?: { x: number, y: number, zoom: number } | null }} [options]
 */
