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
  if (s.description != null) slot.description = String(s.description);
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
  control_cancelled: ["Cancelled", "Cancel Check"],
  control_cd_workspace: ["CD Workspace", "Load Workspace"],
  control_delay: ["Delay"],
  control_if: ["If Branch"],
  control_interval_loop: ["Interval Loop"],
  control_load_skills: ["Load Skills"],
  control_load_mcp: ["Load MCP"],
  workspace_scheduled_run: ["Scheduled Run"],
  workspace_run: ["Run"],
  control_user_workspace: ["User Workspace"],
  control_toBool: ["To Bool", "Code ToBool"],
  control_wait_until: ["Wait Until"],
  tool_git_checkout: ["Git Checkout"],
  tool_get_env: ["Get Env"],
  tool_load_key: ["Load Key"],
  tool_set_run_env: ["Set Run Env", "Set Env"],
  tool_display_share_link: ["Display Share Link", "Share Link"],
  tool_nodejs: ["Node.js Script"],
  tool_print: ["Print"],
  tool_save_key: ["Save Key"],
  tool_user_ask: ["UserAsk"],
  tool_user_check: ["User Confirm"],
  provide_file: ["File"],
  provide_password: ["Password"],
  provide_bool: ["Boolean"],
  provide_text: ["Text"],
  provide_str: ["Text"],
  display_markdown: ["Markdown Display"],
  display_react_app: ["React App"],
  display_mermaid: ["Mermaid Display"],
  display_ascii: ["ASCII Display"],
  display_chart: ["Chart Display"],
  display_table: ["Table Display"],
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
  control_load_mcp: new Set(["workspaceContext", "mcpContext", "loadedCount", "summary"]),
  agent_subAgent: new Set(["workspaceContext", "skillsContext", "mcpContext"]),
};

const CANVAS_HIDDEN_SLOT_NAMES = {
  control_cd_workspace: new Set(["mode", "label", "workspaceContext", "cwd", "previous"]),
  control_user_workspace: new Set(["cwd"]),
  display_markdown: new Set(["prev", "next"]),
  display_mermaid: new Set(["prev", "next"]),
  display_ascii: new Set(["prev", "next"]),
  display_html: new Set(["prev", "next"]),
  display_react_app: new Set(["prev", "next"]),
  display_image: new Set(["prev", "next"]),
  display_chart: new Set(["prev", "next"]),
  display_table: new Set(["prev", "next"]),
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

const CANVAS_VISIBLE_SLOT_NAMES = {
  agent_subAgent: new Set(["knowledgeContext", "skillsContext"]),
};

const DISPLAY_DEFINITION_IDS = new Set([
  "display_markdown",
  "display_mermaid",
  "display_ascii",
  "display_html",
  "display_react_app",
  "display_image",
  "display_chart",
  "display_table",
]);

function isDisplayPrimarySlot(definitionId, slot) {
  if (!DISPLAY_DEFINITION_IDS.has(String(definitionId || ""))) return false;
  const name = String(slot?.name || "");
  return name === "content" || name === "src";
}

function marketplaceRefForDefinition(def) {
  const id = String(def?.marketplaceDefinitionId || def?.id || "").trim();
  return id.startsWith("marketplace:") ? id : "";
}

function runtimeDefinitionIdForPalette(def, fallback) {
  const baseDefinitionId = String(def?.baseDefinitionId || "").trim();
  if (!baseDefinitionId) return fallback;
  return baseDefinitionId;
}

function shellQuoteArg(value) {
  const text = String(value ?? "");
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(text)) return text;
  return "'" + text.replace(/'/g, "'\\''") + "'";
}

function runtimeInterpreterForMarketplaceEntry(runtime, entry) {
  const language = String(runtime?.language || "").trim().toLowerCase();
  const entryLower = String(entry || "").trim().toLowerCase();
  if (language.includes("python") || entryLower.endsWith(".py")) return "python3";
  if (language.includes("shell") || language === "bash" || entryLower.endsWith(".sh") || entryLower.endsWith(".bash")) return "bash";
  return "node";
}

function marketplaceRuntimeArg(arg) {
  const text = String(arg ?? "").trim();
  if (!text) return "";
  if (text.includes("${")) return text;
  return shellQuoteArg(text);
}

function scriptFromMarketplaceRuntime(def) {
  if (String(def?.baseDefinitionId || "").trim() !== "tool_nodejs") return "";
  const runtime = def?.runtime && typeof def.runtime === "object" ? def.runtime : {};
  const entry = String(runtime.entry || "").trim().replace(/^\/+/, "");
  if (entry) {
    const packageDir = String(def?.packageDir || "").trim().replace(/\/+$/, "");
    const entryPath = packageDir ? `${packageDir}/${entry}` : `\${flowDir}/${entry}`;
    const args = Array.isArray(runtime.args) ? runtime.args.map(marketplaceRuntimeArg).filter(Boolean) : [];
    return [runtimeInterpreterForMarketplaceEntry(runtime, entry), shellQuoteArg(entryPath), ...args].join(" ");
  }
  return String(runtime.command || "").trim();
}

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
      ...(slot.description == null && def.description != null ? { description: String(def.description) } : {}),
      ...(wasLegacyAutoHidden ? { showOnNode: true } : {}),
      ...(!slot._showOnNodeExplicit && def.showOnNode != null ? { showOnNode: Boolean(def.showOnNode) } : {}),
      ...(!slot._showOnNodeExplicit && def.showOnNode == null ? { showOnNode: Boolean(slot.required) || String(slot.type || "").trim().toLowerCase() === "node" } : {}),
      ...(!slot._showOnNodeExplicit && isDisplayPrimarySlot(definitionId, slot) ? { showOnNode: true } : {}),
      ...(CANVAS_VISIBLE_SLOT_NAMES[definitionId]?.has(slot.name) ? { showOnNode: true } : {}),
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
        description: String(sl.description ?? ""),
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
  const inst = instances[n.id];
  const explicitMarketplaceRef = inst?.marketplaceRef || n.data?.marketplaceRef || "";
  // marketplace 节点用自身定义描述引脚，用 baseDefinitionId 选择运行时卡片。
  // 只按 runtime definitionId（例如 tool_nodejs）查 palette 会把自定义引脚按内置槽位
  // 的下标错误合并，最终把已经连接的第 2、3 个输入隐藏掉。
  const def = palette.find((p) => p.id === explicitMarketplaceRef)
    || palette.find((p) => p.id === definitionId);
  let inputs = [];
  let outputs = [];
  let label = n.data?.label ?? n.id;
  let instanceRole;
  let instanceModel;
  let instanceBody;
  let instanceImages;
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
    if (Array.isArray(inst.images)) instanceImages = inst.images;
    if (inst.script != null) instanceScript = String(inst.script);
  }
  const mergedRole = instanceRole ?? (typeof n.data?.role === "string" ? n.data.role : "普通");
  const mergedModel = instanceModel ?? n.data?.model ?? undefined;
  const defDescRaw = def?.description != null ? String(def.description).trim() : "";
  const mergedDescription = defDescRaw !== "" ? defDescRaw : undefined;
  const mergedBody = instanceBody ?? n.data?.body ?? "";
  const mergedImages = Array.isArray(instanceImages) ? instanceImages : Array.isArray(n.data?.images) ? n.data.images : [];
  const runtimeScript = scriptFromMarketplaceRuntime(def);
  const mergedScript =
    instanceScript !== undefined
      ? instanceScript
      : n.data?.script != null
        ? String(n.data.script)
        : runtimeScript;
  const nodeId = String(n.id);
  const pipelineNodeTranslations = pipelineTranslations?.[flowId]?.[nodeId];
  const translatedLabel = pipelineNodeTranslations?.label?.label;
  const translatedBody = pipelineNodeTranslations?.body;
  const translatedDescription = pipelineNodeTranslations?.description;
  if (!ioFromYamlInstance) {
    if (inputs.length === 0 && def?.inputs?.length) inputs = def.inputs.map((x) => ({ ...x }));
    if (outputs.length === 0 && def?.outputs?.length) outputs = def.outputs.map((x) => ({ ...x }));
  }
  const resolvedDefId = runtimeDefinitionIdForPalette(def, def?.id ?? definitionId);
  const marketplaceRef = explicitMarketplaceRef || marketplaceRefForDefinition(def);
  if (resolvedDefId === "agent_subAgent" && !outputs.some((slot) => slot?.name === "result")) {
    const resultSlot = def?.outputs?.find((slot) => slot?.name === "result");
    outputs = [...outputs, resultSlot ? { ...resultSlot } : { type: "text", name: "result", default: "" }];
  }
  if (resolvedDefId === "agent_subAgent" && !inputs.some((slot) => slot?.name === "knowledgeContext")) {
    const knowledgeSlot = def?.inputs?.find((slot) => slot?.name === "knowledgeContext");
    inputs = [...inputs, knowledgeSlot ? { ...knowledgeSlot } : { type: "text", name: "knowledgeContext", default: "", showOnNode: true }];
  }
  if (
    (resolvedDefId === "display_markdown" || resolvedDefId === "display_mermaid" || resolvedDefId === "display_ascii" || resolvedDefId === "display_chart" || resolvedDefId === "display_table") &&
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
  if (resolvedDefId.startsWith("provide_") && outputs[0] && String(outputs[0].default ?? outputs[0].value ?? "").trim() === "" && String(mergedBody).trim() !== "") {
    outputs = outputs.map((slot, index) => index === 0 ? { ...slot, default: mergedBody, value: mergedBody } : slot);
  }
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
      ...(marketplaceRef ? { marketplaceRef } : {}),
      ...(inst?.marketplacePackageId || n.data?.marketplacePackageId || def?.packageId
        ? { marketplacePackageId: inst?.marketplacePackageId || n.data?.marketplacePackageId || def?.packageId }
        : {}),
      ...(inst?.marketplaceVersion || n.data?.marketplaceVersion || def?.version
        ? { marketplaceVersion: inst?.marketplaceVersion || n.data?.marketplaceVersion || def?.version }
        : {}),
      schemaType: n.data?.schemaType ?? n.type ?? "agent",
      role: mergedRole,
      model: mergedModel,
      body: translatedBody || mergedBody,
      images: mergedImages,
      script: mergedScript,
      inputs,
      outputs,
      description: translatedDescription || mergedDescription,
      guide: def?.guide || n.data?.guide,
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

function connectionHandleIndex(handle, prefix) {
  const match = new RegExp(`^${prefix}-(\\d+)$`).exec(String(handle || ""));
  if (!match) return 0;
  const index = Number.parseInt(match[1], 10);
  return Number.isFinite(index) && index >= 0 ? index : 0;
}

function revealSlotOnNode(slots, index) {
  if (!Array.isArray(slots) || !slots[index]) return slots;
  if (slots[index].showOnNode === true) return slots;
  return slots.map((slot, i) => (i === index ? { ...slot, showOnNode: true } : slot));
}

export function revealConnectedSlots(nodes, connection) {
  const source = String(connection?.source || "");
  const target = String(connection?.target || "");
  if (!source || !target) return nodes;
  const sourceIndex = connectionHandleIndex(connection?.sourceHandle, "output");
  const targetIndex = connectionHandleIndex(connection?.targetHandle, "input");
  let changed = false;
  const next = (nodes || []).map((node) => {
    if (node.id === source) {
      const outputs = revealSlotOnNode(node.data?.outputs, sourceIndex);
      if (outputs !== node.data?.outputs) {
        changed = true;
        return { ...node, data: { ...node.data, outputs } };
      }
    }
    if (node.id === target) {
      const inputs = revealSlotOnNode(node.data?.inputs, targetIndex);
      if (inputs !== node.data?.inputs) {
        changed = true;
        return { ...node, data: { ...node.data, inputs } };
      }
    }
    return node;
  });
  return changed ? next : nodes;
}

export function revealConnectedSlotsForEdges(nodes, edges) {
  return (Array.isArray(edges) ? edges : []).reduce(
    (current, edge) => revealConnectedSlots(current, edge),
    Array.isArray(nodes) ? nodes : [],
  );
}
