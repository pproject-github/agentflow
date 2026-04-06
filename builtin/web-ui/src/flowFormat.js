/**
 * 与 AI_Workspace agentflow/flowFormat.ts 对齐：统一 flow.yaml（instances / edges / ui）
 */
import { MarkerType } from "@xyflow/react";
import yaml from "js-yaml";

export const VALID_ROLES = ["需求拆解", "技术规划", "代码执行", "测试回归", "普通"];

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
 * @returns {{ nodes: import('@xyflow/react').Node[], edges: import('@xyflow/react').Edge[], instances: Record<string, any>, description?: string } | { error: string }}
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
      const definitionId = inst?.definitionId ?? id;
      const type = definitionIdToType(definitionId);
      const label = inst?.label != null ? String(inst.label) : id;
      const rawRole = inst?.role != null ? String(inst.role).trim() : "";
      const role = VALID_ROLES.includes(rawRole) ? rawRole : "普通";
      const model = inst?.model != null ? String(inst.model).trim() : undefined;
      const body = inst?.body != null ? String(inst.body) : "";
      const script = inst?.script != null ? String(inst.script) : "";
      return {
        id,
        type: normalizeNodeType(type),
        position,
        data: {
          label,
          definitionId,
          schemaType: type,
          role,
          model: model || undefined,
          body,
          ...(script.trim() !== "" ? { script } : {}),
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

    return { nodes, edges, instances, description };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: `flow.yaml 解析失败：${message}` };
  }
}

/**
 * 将画布节点与已有 instances 合并，生成写入 flow.yaml 的 instances（含节点上可编辑字段）。
 * @param {import('@xyflow/react').Node[]} nodes
 * @param {Record<string, any>} instancesMap
 * @returns {Record<string, any>}
 */
export function buildInstancesForYaml(nodes, instancesMap) {
  const toSlotValue = (s) => ({
    type: s?.type ?? "节点",
    name: s?.name ?? "",
    value: s?.value ?? s?.default ?? "",
  });
  const instances = {};
  for (const n of nodes) {
    const base =
      instancesMap[n.id] && typeof instancesMap[n.id] === "object" ? { ...instancesMap[n.id] } : {};
    const defId = n.data?.definitionId || n.id;
    const dataInputs = n.data?.inputs ?? [];
    const dataOutputs = n.data?.outputs ?? [];
    const rawR = n.data?.role != null ? String(n.data.role).trim() : "";
    const rawBaseR = base.role != null ? String(base.role).trim() : "";
    const role = VALID_ROLES.includes(rawR) ? rawR : VALID_ROLES.includes(rawBaseR) ? rawBaseR : "普通";

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

    if (body.trim() === "") {
      delete rec.body;
    } else {
      rec.body = body;
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

    delete rec.temperature;
    delete rec.maxTokens;
    delete rec.description;

    instances[n.id] = rec;
  }
  return instances;
}

/**
 * @param {import('@xyflow/react').Node[]} nodes
 * @param {import('@xyflow/react').Edge[]} edges
 * @param {Record<string, any>} instancesMap
 * @param {{ description?: string }} [options]
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
  for (const n of nodes) {
    const p = n.position ?? { x: 0, y: 0 };
    nodePositions[n.id] = { x: p.x, y: p.y };
  }
  const ui = { nodePositions };
  if (options?.description != null && String(options.description).trim() !== "") {
    ui.description = String(options.description).trim();
  }
  const unified = { instances, edges: flowEdges, ui };
  return yaml.dump(unified, { lineWidth: -1 });
}
