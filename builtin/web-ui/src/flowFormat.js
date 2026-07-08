/**
 * 与 AI_Workspace agentflow/flowFormat.ts 对齐：统一 flow.yaml（instances / edges / ui）
 */
import { MarkerType } from "@xyflow/react";
import yaml from "js-yaml";

export const VALID_ROLES = ["requirement", "planning", "code", "test", "normal"];

const ROLE_ZH_TO_KEY = {
  普通: "normal",
  技术规划: "planning",
  代码执行: "code",
  测试回归: "test",
  需求拆解: "requirement",
};

const TYPE_ZH_TO_KEY = {
  节点: "node",
  文本: "text",
  文件: "file",
  bool: "bool",
  布尔: "bool",
};

const VALID_NODE_TYPES = ["agent", "control", "provide", "condition", "jump", "condition_jump", "start", "end"];

function normalizeNodeType(t) {
  return VALID_NODE_TYPES.includes(t) ? t : "agent";
}

function definitionIdToType(definitionId) {
  const id = (definitionId || "").toLowerCase();
  if (id.startsWith("control_")) return "control";
  if (id.startsWith("agent_")) return "agent";
  if (id.startsWith("provide_")) return "provide";
  if (id.startsWith("tool_")) return "agent";
  return "agent";
}

/**
 * @param {string} flowYamlContent
 * @returns {{ nodes: import('@xyflow/react').Node[], edges: import('@xyflow/react').Edge[], instances: Record<string, any>, description?: string, viewport?: { x: number, y: number, zoom: number } } | { error: string }}
 */
export function deserializeFromFlowYaml(flowYamlContent) {
  if (!flowYamlContent?.trim()) {
    return { nodes: [], edges: [], instances: {} };
  }
  try {
    const raw = yaml.load(flowYamlContent);
    if (!raw || typeof raw !== "object") {
      return { error: "flow.yaml 格式无效：根内容不是对象" };
    }
    const data = raw;
    const instances = data.instances && typeof data.instances === "object" ? data.instances : {};
    const edgesRaw = Array.isArray(data.edges)
      ? data.edges
      : Array.isArray(data.flow?.edges)
        ? data.flow.edges
        : [];
    const ui = data.ui && typeof data.ui === "object" ? data.ui : {};
    const nodePositions = ui.nodePositions && typeof ui.nodePositions === "object" ? ui.nodePositions : {};
    const nodeSizes = ui.nodeSizes && typeof ui.nodeSizes === "object" ? ui.nodeSizes : {};
    const rawViewport = ui.viewport && typeof ui.viewport === "object" ? ui.viewport : null;
    const viewport =
      rawViewport &&
      Number.isFinite(Number(rawViewport.x)) &&
      Number.isFinite(Number(rawViewport.y)) &&
      Number.isFinite(Number(rawViewport.zoom))
        ? {
            x: Number(rawViewport.x),
            y: Number(rawViewport.y),
            zoom: Math.min(Math.max(Number(rawViewport.zoom), 0.1), 4),
          }
        : undefined;
    const description =
      typeof ui.description === "string" && ui.description.trim() ? ui.description.trim() : undefined;

    const nodeIds = new Set(Object.keys(instances));
    for (const e of edgesRaw) {
      if (e?.source) nodeIds.add(String(e.source));
      if (e?.target) nodeIds.add(String(e.target));
    }

    const nodes = Array.from(nodeIds).map((id) => {
      const inst = instances[id];
      const position =
        nodePositions[id] && typeof nodePositions[id].x === "number" && typeof nodePositions[id].y === "number"
          ? { x: nodePositions[id].x, y: nodePositions[id].y }
          : { x: 0, y: 0 };
      const size =
        nodeSizes[id] && typeof nodeSizes[id].width === "number" && typeof nodeSizes[id].height === "number"
          ? { width: nodeSizes[id].width, height: nodeSizes[id].height }
          : null;
      const definitionId = inst?.definitionId ?? id;
      const type = definitionIdToType(definitionId);
      const label = inst?.label != null ? String(inst.label) : id;
      const rawRole = inst?.role != null ? String(inst.role).trim() : "";
      const normalizedRole = ROLE_ZH_TO_KEY[rawRole] || rawRole;
      const role = VALID_ROLES.includes(normalizedRole) ? normalizedRole : "normal";
      const model = inst?.model != null ? String(inst.model).trim() : undefined;
      const body = inst?.body != null ? String(inst.body) : "";
      const script = inst?.script != null ? String(inst.script) : "";
      const scriptRef = inst?.scriptRef != null ? String(inst.scriptRef) : "";
      const implementationRef = inst?.implementationRef != null ? String(inst.implementationRef) : "";
      const implementationMode = inst?.implementationMode != null ? String(inst.implementationMode) : "";
      const images = Array.isArray(inst?.images) ? inst.images : [];
      return {
        id,
        type: normalizeNodeType(type),
        position,
        ...(size ? { width: size.width, height: size.height } : {}),
        data: {
          label,
          definitionId,
          schemaType: type,
          role,
          model: model || undefined,
          body,
          images,
          ...(size ? { displaySize: size } : {}),
          ...(script.trim() !== "" ? { script } : {}),
          ...(scriptRef.trim() !== "" ? { scriptRef } : {}),
          ...(implementationRef.trim() !== "" ? { implementationRef } : {}),
          ...(implementationMode.trim() !== "" ? { implementationMode } : {}),
        },
      };
    });

    const edges = edgesRaw
      .filter((e) => e?.source && e?.target)
      .map((e, i) => ({
        id: `e-${e.source}-${e.target}-${i}`,
        source: String(e.source),
        target: String(e.target),
        sourceHandle: e.sourceHandle ?? undefined,
        targetHandle: e.targetHandle ?? undefined,
        markerEnd: { type: MarkerType.ArrowClosed },
      }));

    return { nodes, edges, instances, description, ...(viewport ? { viewport } : {}) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    let hint = "";
    // 最常见根因：script / body / value 字段裸写含 `:` 或引号的命令字符串，YAML 把 `: ` 当成新 mapping
    if (/bad indentation of a mapping entry|expected.*scalar|mapping values are not allowed/i.test(message)) {
      const lineMatch = message.match(/\((\d+):/);
      const lineHint = lineMatch ? `第 ${lineMatch[1]} 行附近` : "";
      hint =
        `\n\n💡 提示：通常由 ${lineHint}的 \`script\` / \`body\` / \`value\` 字段裸写命令字符串引起。` +
        `\nYAML 中含 \`: \`、\`"\`、\`'\` 等特殊字符的多行字符串必须使用 \`|\` 块标量。` +
        `\n\n✅ 正确写法：` +
        `\n\`\`\`yaml` +
        `\nscript: |` +
        `\n  node -e "console.log('TODO: scripts/x.mjs')"` +
        `\n\`\`\`` +
        `\n❌ 错误写法（当前文件）：` +
        `\n\`\`\`yaml` +
        `\nscript: node -e "console.log('TODO: scripts/x.mjs')"` +
        `\n\`\`\``;
    }
    return { error: `flow.yaml 解析失败：${message}${hint}` };
  }
}

/**
 * 将画布节点与已有 instances 合并，生成写入 flow.yaml 的 instances（含节点上可编辑字段）。
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
export function serializeToFlowYaml(nodes, edges, instancesMap, options) {
  const instances = buildInstancesForYaml(nodes, instancesMap);
  const flowEdges = edges.map((e) => ({
    source: e.source,
    target: e.target,
    sourceHandle: e.sourceHandle ?? null,
    targetHandle: e.targetHandle ?? null,
  }));
  const nodePositions = {};
  const nodeSizes = {};
  for (const n of nodes) {
    const p = n.position ?? { x: 0, y: 0 };
    nodePositions[n.id] = { x: p.x, y: p.y };
    const width = Number(n.data?.displaySize?.width || n.width || 0);
    const height = Number(n.data?.displaySize?.height || n.height || 0);
    if (width > 0 && height > 0) {
      nodeSizes[n.id] = { width: Math.round(width), height: Math.round(height) };
    }
  }
  const ui = { nodePositions };
  if (Object.keys(nodeSizes).length > 0) ui.nodeSizes = nodeSizes;
  if (
    options?.viewport &&
    Number.isFinite(Number(options.viewport.x)) &&
    Number.isFinite(Number(options.viewport.y)) &&
    Number.isFinite(Number(options.viewport.zoom))
  ) {
    ui.viewport = {
      x: Number(options.viewport.x),
      y: Number(options.viewport.y),
      zoom: Math.min(Math.max(Number(options.viewport.zoom), 0.1), 4),
    };
  }
  if (options?.description != null && String(options.description).trim() !== "") {
    ui.description = String(options.description).trim();
  }
  const unified = { instances, edges: flowEdges, ui };
  return yaml.dump(unified, { lineWidth: -1 });
}
