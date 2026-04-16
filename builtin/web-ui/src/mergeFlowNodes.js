/**
 * 合并 palette（list-nodes）与 flow instances，供画布 Handle 与桌面一致
 */

function toIOSlot(s) {
  return {
    type: s.type || "node",
    name: s.name || "",
    default: s.value !== undefined && s.value !== null ? String(s.value) : s.default !== undefined ? String(s.default) : "",
  };
}

/**
 * 节点属性面板草稿：与画布 data.inputs / data.outputs 字段一致（type、name、default）。
 * @param {import('@xyflow/react').Node | null | undefined} node
 * @returns {{ inputs: { type: string, name: string, default: string }[], outputs: { type: string, name: string, default: string }[] }}
 */
export function cloneNodeIoDraftSlots(node) {
  const ins = Array.isArray(node?.data?.inputs) ? node.data.inputs : [];
  const outs = Array.isArray(node?.data?.outputs) ? node.data.outputs : [];
  const norm = (arr) =>
    arr.map((s) => {
      const sl = toIOSlot(s);
      return { type: String(sl.type || "node"), name: String(sl.name ?? ""), default: String(sl.default ?? "") };
    });
  return { inputs: norm(ins), outputs: norm(outs) };
}

/**
 * @param {import('@xyflow/react').Node} n
 * @param {Record<string, any>} instances
 * @param {Array<{ id: string, inputs?: any[], outputs?: any[] }>} palette
 * @param {Record<string, Record<string, { label?: string, body?: string, description?: string }>>} [pipelineTranslations]
 * @param {string} [flowId]
 */
export function mergeNodeWithPalette(n, instances, palette, pipelineTranslations, flowId) {
  const definitionId = n.data?.definitionId || String(n.id).replace(/-\d+$/, "");
  const def = palette.find((p) => p.id === definitionId);
  const inst = instances[n.id];
  let inputs = [];
  let outputs = [];
  let label = n.data?.label ?? n.id;
  let instanceRole;
  let instanceModel;
  let instanceBody;
  /** @type {string | undefined} */
  let instanceScript;
  /** flow.yaml 里已有该 instance 时，引脚以 YAML 为准（含空数组），不回填 palette，避免「YAML 无槽位仍显示定义引脚」 */
  const ioFromYamlInstance = Boolean(inst);
  if (inst) {
    if (Array.isArray(inst.input)) inputs = inst.input.map(toIOSlot);
    if (Array.isArray(inst.output)) outputs = inst.output.map(toIOSlot);
    if (inst.label) label = String(inst.label);
    if (inst.role && typeof inst.role === "string") instanceRole = inst.role;
    if (inst.model != null) instanceModel = String(inst.model).trim();
    if (inst.body != null) instanceBody = String(inst.body);
    if (inst.script != null) instanceScript = String(inst.script);
  }
  const mergedRole = instanceRole ?? (typeof n.data?.role === "string" ? n.data.role : "普通");
  const mergedModel = instanceModel ?? n.data?.model ?? undefined;
  const defDescRaw = def?.description != null ? String(def.description).trim() : "";
  const mergedDescription = defDescRaw !== "" ? defDescRaw : undefined;
  const mergedBody = instanceBody ?? n.data?.body ?? "";
  const mergedScript =
    instanceScript !== undefined
      ? instanceScript
      : n.data?.script != null
        ? String(n.data.script)
        : "";
  const nodeId = String(n.id);
  const pipelineNodeTranslations = pipelineTranslations?.[flowId]?.[nodeId];
  const translatedLabel = pipelineNodeTranslations?.label?.label;
  const translatedBody = pipelineNodeTranslations?.body;
  const translatedDescription = pipelineNodeTranslations?.description;
  if (!ioFromYamlInstance) {
    if (inputs.length === 0 && def?.inputs?.length) inputs = def.inputs.map((x) => ({ ...x }));
    if (outputs.length === 0 && def?.outputs?.length) outputs = def.outputs.map((x) => ({ ...x }));
  }
  const resolvedDefId = def?.id ?? definitionId;
  const showScriptField = resolvedDefId === "tool_nodejs" || String(mergedScript).trim() !== "";
return {
    ...n,
    type: "flowNode",
    data: {
      ...n.data,
      label: translatedLabel || label,
      definitionId: resolvedDefId,
      schemaType: n.data?.schemaType ?? n.type ?? "agent",
      role: mergedRole,
      model: mergedModel,
      body: translatedBody || mergedBody,
      script: mergedScript,
      inputs,
      outputs,
      description: translatedDescription || mergedDescription,
      originalLabel: label,
      originalBody: mergedBody,
      body: mergedBody,
      ...(showScriptField ? { script: mergedScript } : {}),
      inputs,
      outputs,
    },
  };
}

/**
 * @param {import('@xyflow/react').Edge[]} edges
 * @param {import('@xyflow/react').Node[]} nodesWithSchema
 */
export function filterValidEdges(edges, nodesWithSchema) {
  const nodeById = new Map(nodesWithSchema.map((nd) => [nd.id, nd]));
  return edges.filter((e) => {
    const src = nodeById.get(e.source);
    const tgt = nodeById.get(e.target);
    const srcOutputs = src?.data?.outputs?.length ?? 0;
    const tgtInputs = tgt?.data?.inputs?.length ?? 0;
    const srcHandleIdx = e.sourceHandle ? parseInt(String(e.sourceHandle).replace("output-", ""), 10) : 0;
    const tgtHandleIdx = e.targetHandle ? parseInt(String(e.targetHandle).replace("input-", ""), 10) : 0;
    return (
      src &&
      tgt &&
      srcHandleIdx >= 0 &&
      srcHandleIdx < srcOutputs &&
      tgtHandleIdx >= 0 &&
      tgtHandleIdx < tgtInputs
    );
  });
}
