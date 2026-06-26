/**
 * 合并 palette（list-nodes）与 flow instances，供画布 Handle 与桌面一致
 */

function toIOSlot(s) {
  const type = s.type || "node";
  const hasShowOnNode = s.showOnNode != null;
  const slot = {
    type,
    name: s.name || "",
    default: s.value !== undefined && s.value !== null ? String(s.value) : s.default !== undefined ? String(s.default) : "",
  };
  if (s.required != null) slot.required = Boolean(s.required);
  slot.showOnNode = hasShowOnNode
    ? Boolean(s.showOnNode)
    : Boolean(slot.required) || String(type).trim().toLowerCase() === "node";
  slot._showOnNodeExplicit = hasShowOnNode;
  return slot;
}

const BUILTIN_DEFAULT_LABEL_ALIASES = {
  agent_subAgent: ["SubAgent"],
  control_start: ["Start"],
  control_end: ["End"],
  control_agent_toBool: ["Agent ToBool"],
  control_anyOne: ["Any One"],
  control_cancelled: ["Cancelled"],
  control_cd_workspace: ["CD Workspace"],
  control_deadline: ["Deadline"],
  control_delay: ["Delay"],
  control_if: ["If Branch"],
  control_interval_loop: ["Interval Loop"],
  control_load_skills: ["Load Skills"],
  control_user_workspace: ["User Workspace"],
  control_toBool: ["To Bool"],
  control_wait_until: ["Wait Until"],
  tool_git_checkout: ["Git Checkout"],
  tool_get_env: ["Get Env"],
  tool_load_key: ["Load Key"],
  tool_nodejs: ["Node.js Script"],
  tool_print: ["Print"],
  tool_save_key: ["Save Key"],
  tool_user_ask: ["UserAsk"],
  tool_user_check: ["User Confirm"],
  provide_file: ["File"],
  provide_bool: ["Boolean"],
  provide_text: ["Text"],
  provide_str: ["Text"],
  display_markdown: ["Markdown Display"],
  display_mermaid: ["Mermaid Display"],
  display_ascii: ["ASCII Display"],
};

function displayLabelForNode(definitionId, label, def) {
  const translated = String(def?.displayName || "").trim();
  const current = String(label || "").trim();
  if (!translated || !current || translated === current) return current;
  const aliases = BUILTIN_DEFAULT_LABEL_ALIASES[definitionId] || [];
  return aliases.includes(current) ? translated : current;
}

const LEGACY_AUTO_HIDDEN_SLOT_NAMES = {
  tool_git_checkout: new Set(["targetDir", "pullIfExists", "includeSubmodules", "workspaceContext", "commit", "changed"]),
  control_load_skills: new Set(["mergeMode", "workspaceContext", "skillsContext", "loadedCount", "summary"]),
  agent_subAgent: new Set(["workspaceContext", "skillsContext"]),
};

const CANVAS_HIDDEN_SLOT_NAMES = {
  control_cd_workspace: new Set(["mode", "label", "cwd", "previous"]),
  control_user_workspace: new Set(["cwd"]),
  tool_git_checkout: new Set([
    "branch",
    "targetDir",
    "pullIfExists",
    "includeSubmodules",
    "repoPath",
    "commit",
    "changed",
  ]),
  tool_gitlab_create_mr: new Set([
    "repoPath",
    "workspaceContext",
    "sourceBranch",
    "targetBranch",
    "title",
    "description",
    "draft",
    "labels",
    "push",
    "remote",
    "tokenEnv",
    "gitlabApiBase",
    "removeSourceBranch",
    "squash",
    "created",
    "mrIid",
    "projectId",
    "message",
  ]),
};

function mergeSlotDefinitionMeta(definitionId, slots, definitionSlots) {
  if (!Array.isArray(slots) || !Array.isArray(definitionSlots) || definitionSlots.length === 0) return slots;
  return slots.map((slot, index) => {
    const byIndex = definitionSlots[index];
    const byName = definitionSlots.find((candidate) => candidate?.name && candidate.name === slot.name);
    const def = byName || byIndex;
    if (!def) return slot;
    const wasLegacyAutoHidden =
      slot.showOnNode === false &&
      def.showOnNode == null &&
      LEGACY_AUTO_HIDDEN_SLOT_NAMES[definitionId]?.has(slot.name);
    return {
      ...slot,
      ...(slot.required == null && def.required != null ? { required: Boolean(def.required) } : {}),
      ...(wasLegacyAutoHidden ? { showOnNode: true } : {}),
      ...(!slot._showOnNodeExplicit && def.showOnNode != null ? { showOnNode: Boolean(def.showOnNode) } : {}),
      ...(!slot._showOnNodeExplicit && def.showOnNode == null ? { showOnNode: Boolean(slot.required) || String(slot.type || "").trim().toLowerCase() === "node" } : {}),
      ...(CANVAS_HIDDEN_SLOT_NAMES[definitionId]?.has(slot.name) ? { showOnNode: false } : {}),
    };
  });
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
      return {
        type: String(sl.type || "node"),
        name: String(sl.name ?? ""),
        default: String(sl.default ?? ""),
        required: Boolean(sl.required),
        showOnNode: sl.showOnNode != null
          ? sl.showOnNode !== false
          : Boolean(sl.required) || String(sl.type || "").trim().toLowerCase() === "node",
      };
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
  if (resolvedDefId === "agent_subAgent" && !outputs.some((slot) => slot?.name === "result")) {
    const resultSlot = def?.outputs?.find((slot) => slot?.name === "result");
    outputs = [...outputs, resultSlot ? { ...resultSlot } : { type: "text", name: "result", default: "" }];
  }
  if (
    (resolvedDefId === "display_markdown" || resolvedDefId === "display_mermaid" || resolvedDefId === "display_ascii") &&
    !outputs.some((slot) => slot?.name === "next")
  ) {
    const nextSlot = def?.outputs?.find((slot) => slot?.name === "next");
    outputs = [...outputs, nextSlot ? { ...nextSlot } : { type: "node", name: "next", default: "" }];
  }
  if (resolvedDefId === "workspace_run") {
    if (!inputs.some((slot) => slot?.name === "prev")) {
      const prevSlot = def?.inputs?.find((slot) => slot?.name === "prev");
      inputs = [prevSlot ? { ...prevSlot } : { type: "node", name: "prev", default: "" }, ...inputs];
    }
    if (!outputs.some((slot) => slot?.name === "next")) {
      const nextSlot = def?.outputs?.find((slot) => slot?.name === "next");
      outputs = [...outputs, nextSlot ? { ...nextSlot } : { type: "node", name: "next", default: "" }];
    }
  }
  inputs = mergeSlotDefinitionMeta(resolvedDefId, inputs, def?.inputs);
  outputs = mergeSlotDefinitionMeta(resolvedDefId, outputs, def?.outputs);
  const displayLabel = displayLabelForNode(resolvedDefId, translatedLabel || label, def);
  const showScriptField = resolvedDefId === "tool_nodejs" || String(mergedScript).trim() !== "";
  return {
    ...n,
    type: "flowNode",
    data: {
      ...n.data,
      label: translatedLabel || label,
      displayLabel,
      definitionDisplayName: def?.displayName,
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
      ...(showScriptField ? { script: mergedScript } : {}),
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
