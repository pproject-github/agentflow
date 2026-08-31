import crypto from "node:crypto";
import { RELEASE_WORKFLOW_CONFIG } from "../../shared/release-workflow-config.js";

function shellQuote(value) {
  return `'${String(value ?? "").replace(/'/g, `'"'"'`)}'`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

function normalizeCompositeStatus(status, aliases = {}) {
  const value = String(status || "").trim().toLowerCase();
  return String(aliases?.[value] || value);
}

export function confirmationFingerprint(action, context = {}, inputs = {}) {
  const payload = stableJson({
    actionId: action?.id || "",
    compositeId: action?.compositeId || (action?.kind === "composite" ? String(action?.id || "").replace(/^composite:/, "") : ""),
    actionSequence: Array.isArray(action?.actions) ? action.actions.map((item, index) => ({ stepId: item?.stepId || `step-${index + 1}`, id: item?.id || "", order: index })) : [],
    context,
    inputs,
  });
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

function wrapperScript(skillName, actionName, scriptPath, skillRoot) {
  const python = [
    "import json, os, subprocess",
    "input_values = json.loads(os.environ.get('AGENTFLOW_INPUTS_JSON', '{}'))",
    `skill = ${JSON.stringify(String(skillName || ""))}`,
    `action = ${JSON.stringify(String(actionName || ""))}`,
    `repository_root = ${JSON.stringify(String(skillRoot || ""))}`,
    `args = ['run', 'python', ${JSON.stringify(String(scriptPath || ""))}, '--action', action]`,
    "if skill == 'release-notification' and os.environ.get('AGENTFLOW_RELEASE_TEST_MODE') == '1':\n    input_values['message_style'] = 'debug'\n    if action == 'send-custom-notification': input_values['bot'] = 'debug'\n    else: input_values['target'] = 'debug'",
    "fingerprint = input_values.pop('__release_confirmation_fingerprint', '')",
    "if fingerprint: args.extend(['--confirmation-fingerprint', str(fingerprint)])",
    "if skill == 'release-google-play':\n    if 'config' in input_values: args.extend(['--config', str(input_values['config'])])\n    if 'package_name' in input_values: args.extend(['--package-name', str(input_values['package_name'])])\n    if action == 'submit-aab-internal-testing': args.append('--live')\nelse:\n    args.extend(sum(([\"--input\", f\"{key}={value}\"] for key, value in input_values.items()), []))",
    "raise SystemExit(subprocess.call(['uv', *args], cwd=repository_root or None))",
  ].join("\n");
  return [
    "uv run python -c",
    shellQuote(python),
  ].join(" ");
}

export function buildReleaseRunGraph(action, context = {}, inputs = {}) {
  if (!action?.id || !action?.source?.scriptPath) throw new Error("A discovered release action is required");
  const inputSlots = Object.entries(inputs && typeof inputs === "object" ? inputs : {})
    .filter(([name]) => String(name || "").trim())
    .map(([name, value]) => ({ type: "text", name: String(name), value: String(value ?? ""), showOnNode: false }));
  return {
    version: 1,
    meta: {
      releaseActionId: action.id,
      context: { ...context },
      inputs: { ...inputs },
    },
    instances: {
      release_action: {
        definitionId: "tool_nodejs",
        label: action.title || action.action || action.id,
        script: wrapperScript(action.skill, action.action, action.source.scriptPath, action.source.skillRoot),
        input: [{ type: "node", name: "prev", value: "" }, ...inputSlots],
        output: [{ type: "node", name: "next", value: "" }],
      },
    },
    edges: [],
    ui: { nodePositions: { release_action: { x: 120, y: 100 } } },
  };
}

// 用户需求点: 复合发版节点必须在 AgentFlow 中按配置顺序串行执行，每个内部 Action 保留等待、确认、重试和扇出元数据。
export function buildCompositeReleaseRunGraph(composite, atomicNodes = [], context = {}, inputs = {}) {
  if (!composite?.id || !Array.isArray(composite.actions) || composite.actions.length === 0) {
    throw new Error("A configured composite release workflow is required");
  }
  const compositeIdentity = String(composite.compositeId || composite.id || "").replace(/^composite:/, "");
  const atomicById = new Map((Array.isArray(atomicNodes) ? atomicNodes : []).filter((node) => node?.id).map((node) => [String(node.id), node]));
  const entries = composite.actions.map((entry, index) => {
    const id = String(entry?.id || entry?.actionId || "").trim();
    const atomic = atomicById.get(id) || (entry?.source?.scriptPath ? entry : null);
    if (!atomic?.source?.scriptPath) throw new Error(`Composite Action not available: ${id}`);
    return { ...entry, id, stepId: String(entry.stepId || `step-${index + 1}`), atomic, order: index };
  });
  const aliases = { ...(RELEASE_WORKFLOW_CONFIG.statusAliases || {}), ...(composite.statusAliases || {}) };
  const outputNamesByStep = new Map(entries.map((entry) => [entry.stepId, new Set(["result"])]));
  for (const entry of entries) {
    for (const mapping of Object.values(entry.inputs && typeof entry.inputs === "object" ? entry.inputs : {})) {
      if (!mapping || typeof mapping !== "object") continue;
      const fromStep = String(mapping.fromStep || "").trim();
      const output = String(mapping.output || "").trim();
      if (fromStep && outputNamesByStep.has(fromStep) && output) outputNamesByStep.get(fromStep).add(output);
    }
  }
  const instances = {};
  const positions = {};
  for (const entry of entries) {
    const nodeId = `composite_${entry.stepId}`;
    const mappedInputs = entry.inputs && typeof entry.inputs === "object" ? entry.inputs : {};
    const stepExecutionInputs = releaseExecutionInputs(entry.atomic, context, inputs);
    const inputNames = new Set([
      ...((Array.isArray(entry.atomic.inputSchema) ? entry.atomic.inputSchema : []).map((item) => String(item?.key || item?.name || "").trim()).filter(Boolean)),
      ...Object.keys(mappedInputs).map((name) => String(name || "").trim()).filter(Boolean),
      ...Object.keys(stepExecutionInputs).filter((name) => !String(name).startsWith("__")),
      ...(Object.prototype.hasOwnProperty.call(stepExecutionInputs, "__release_confirmation_fingerprint") ? ["__release_confirmation_fingerprint"] : []),
    ]);
    const input = [{ type: "node", name: "prev", value: "" }];
    for (const name of inputNames) {
      const mapping = mappedInputs[name];
      let value = "";
      if (mapping && typeof mapping === "object") {
        const contextKey = String(mapping.context || "").trim();
        if (contextKey) value = inputs?.[contextKey] ?? context?.[contextKey] ?? "";
      } else if (mapping != null) value = mapping;
      if (!value && Object.prototype.hasOwnProperty.call(stepExecutionInputs || {}, name)) value = stepExecutionInputs[name];
      input.push({ type: "text", name, value: String(value ?? ""), showOnNode: false });
    }
    const output = [{ type: "node", name: "next", value: "" }, ...[...outputNamesByStep.get(entry.stepId)].map((name) => ({ type: "text", name, value: "" }))];
    instances[nodeId] = {
      definitionId: "tool_nodejs",
      label: entry.atomic.title || entry.id,
      script: wrapperScript(entry.atomic.skill, entry.atomic.action, entry.atomic.source.scriptPath, entry.atomic.source.skillRoot),
      input,
      output,
      compositeStep: {
        compositeId: compositeIdentity,
        stepId: entry.stepId,
        actionId: entry.id,
        order: entry.order,
        continueOn: (entry.continueOn || []).map((status) => normalizeCompositeStatus(status, aliases)),
        waitFor: entry.waitFor ? { ...entry.waitFor, statuses: (entry.waitFor.statuses || []).map((status) => normalizeCompositeStatus(status, aliases)) } : null,
        forEach: entry.forEach ? { ...entry.forEach } : null,
        requiresConfirmation: entry.requiresConfirmation === true || entry.atomic.requiresConfirmation === true,
        inputMappings: { ...mappedInputs },
        statusAliases: { ...aliases },
      },
    };
    positions[nodeId] = { x: 120 + entry.order * 360, y: 100 };
  }
  const edges = [];
  const outputIndex = (nodeId, name) => (instances[nodeId].output || []).findIndex((slot) => String(slot?.name || "") === name);
  const inputIndex = (nodeId, name) => (instances[nodeId].input || []).findIndex((slot) => String(slot?.name || "") === name);
  for (let index = 1; index < entries.length; index += 1) {
    const previous = `composite_${entries[index - 1].stepId}`;
    const current = `composite_${entries[index].stepId}`;
    edges.push({ source: previous, sourceHandle: "output-0", target: current, targetHandle: "input-0" });
  }
  for (const entry of entries) {
    const targetId = `composite_${entry.stepId}`;
    for (const [name, mapping] of Object.entries(entry.inputs && typeof entry.inputs === "object" ? entry.inputs : {})) {
      if (!mapping || typeof mapping !== "object") continue;
      const fromStep = String(mapping.fromStep || "").trim();
      if (!fromStep) continue;
      const sourceId = `composite_${fromStep}`;
      if (!instances[sourceId]) throw new Error(`Composite input references unknown step: ${fromStep}`);
      const sourceOutput = String(mapping.output || "result").trim() || "result";
      const sourceSlotIndex = outputIndex(sourceId, sourceOutput);
      const targetSlotIndex = inputIndex(targetId, name);
      if (sourceSlotIndex < 0 || targetSlotIndex < 0) continue;
      edges.push({ source: sourceId, sourceHandle: `output-${sourceSlotIndex}`, target: targetId, targetHandle: `input-${targetSlotIndex}` });
    }
  }
  return {
    version: 1,
    meta: {
      releaseCompositeId: compositeIdentity,
      compositeId: compositeIdentity,
      compositeActionIds: entries.map((entry) => entry.id),
      context: { ...context },
      inputs: { ...inputs },
      statusAliases: { ...aliases },
    },
    instances,
    edges,
    ui: { nodePositions: positions },
  };
}

// 用户需求点: 页面初始化的业务线、平台和版本必须真正传入 release-skill，否则脚本会把一次有效执行误判为缺少上下文的预检。
export function releaseExecutionInputs(action, context = {}, inputs = {}) {
  const skill = String(action?.skill || "").trim().toLowerCase();
  const actionName = String(action?.action || "").trim().toLowerCase();
  const version = String(context?.version || "").trim();
  const majorVersion = version.split(".").slice(0, 2).join(".");
  const result = { ...(inputs && typeof inputs === "object" ? inputs : {}) };
  result.product = String(context?.businessLine || "likee").trim().toLowerCase() || "likee";
  result.platform = String(context?.platform || "android").trim().toLowerCase() || "android";
  if (["release-git", "release-approval", "release-gray-observe", "release-records", "release-channel-packages", "release-localization", "release-notification"].includes(skill)) {
    result.minor_version = version;
  }
  if (skill === "release-management" && ["append-release-batch", "register-release-branch", "update-active-release"].includes(actionName)) {
    result.major_version = majorVersion;
  }
  if (skill === "release-management" && actionName === "update-active-release") result.minor_version = version;
  if (skill === "release-metrics" && actionName === "query-version-metrics") result.app_version = version;
  return result;
}

// 用户需求点: release-skill 可能用零退出码返回 preflight_failed，AgentFlow 仍需把它展示为失败并保留重试入口。
export function releaseFailureFromResult(result) {
  const texts = (Array.isArray(result?.events) ? result.events : [])
    .filter((event) => event?.type === "script-finish")
    .map((event) => String(event?.stdout || ""))
    .filter(Boolean);
  const output = texts.join("\n");
  if (!/(?:^|\n)status:\s*(?:preflight_failed|failed|error)\b/m.test(output)) return "";
  const error = output.match(/(?:^|\n)error:\s*(.+?)(?:\n|$)/m);
  return error?.[1]?.trim() || "发版脚本预检失败";
}

// 用户需求点: 发版时间线要展示真实操作耗时，而不是接口返回瞬间写入的 0ms。
export function releaseTimingFromResult(result, fallbackStartedAt = Date.now()) {
  const events = Array.isArray(result?.events) ? result.events : [];
  const finish = [...events].reverse().find((event) => event?.type === "script-finish");
  const start = events.find((event) => event?.type === "script-start" || event?.type === "node-start");
  const durationMs = Number(finish?.durationMs);
  const startedAt = Number(start?.ts);
  const normalizedDuration = Number.isFinite(durationMs) ? Math.max(0, durationMs) : Math.max(0, Date.now() - (Number.isFinite(startedAt) ? startedAt : fallbackStartedAt));
  return {
    startedAt: Number.isFinite(startedAt) ? startedAt : Math.max(0, Date.now() - normalizedDuration),
    completedAt: Date.now(),
    durationMs: normalizedDuration,
  };
}

export async function previewReleaseAction(action, context = {}, inputs = {}, { executePreview, atomicNodes = [] } = {}) {
  if (!action?.id) throw new Error("A discovered release action is required");
  const fingerprint = confirmationFingerprint(action, context, inputs);
  const graph = action.kind === "composite"
    ? buildCompositeReleaseRunGraph(action, atomicNodes, context, inputs)
    : buildReleaseRunGraph(action, context, inputs);
  const preview = typeof executePreview === "function"
    ? await executePreview(graph)
    : { action: action.action, inputs: { ...inputs }, message: "等待执行预览" };
  return { preview, confirmationFingerprint: fingerprint, graph };
}

export async function runReleaseAction(action, context = {}, inputs = {}, options = {}) {
  if (!action?.id) throw new Error("A discovered release action is required");
  const expected = options.confirmationFingerprint;
  if (action.requiresConfirmation && expected !== confirmationFingerprint(action, context, inputs)) {
    const error = new Error("确认指纹已失效，请重新预览");
    error.code = "RELEASE_CONFIRMATION_MISMATCH";
    throw error;
  }
  if (typeof options.runGraph !== "function") {
    return { runId: `release-preview-${Date.now().toString(36)}`, status: "preview", output: null, logs: [] };
  }
  const graph = action.kind === "composite"
    ? buildCompositeReleaseRunGraph(action, options.atomicNodes || [], context, inputs)
    : buildReleaseRunGraph(action, context, inputs);
  return options.runGraph(graph, options);
}

export async function stopReleaseAction(runId, { stopRun } = {}) {
  if (!String(runId || "").trim()) throw new Error("runId is required");
  if (typeof stopRun === "function") return stopRun(runId);
  return { stopped: false, runId };
}
