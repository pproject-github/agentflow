import crypto from "node:crypto";

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

export function confirmationFingerprint(action, context = {}, inputs = {}) {
  const payload = stableJson({ actionId: action?.id || "", context, inputs });
  return crypto.createHash("sha256").update(payload, "utf8").digest("hex");
}

function wrapperScript(actionName) {
  const python = [
    "import json, os, subprocess",
    "input_values = json.loads(os.environ.get('AGENTFLOW_INPUTS_JSON', '{}'))",
    `args = [os.environ['AGENTFLOW_SCRIPT_REF'], '--action', ${JSON.stringify(String(actionName || ""))}]`,
    "for key, value in input_values.items(): args.extend(['--input', f'{key}={value}'])",
    "raise SystemExit(subprocess.call(args))",
  ].join("; ");
  return [
    "uv run python -c",
    shellQuote(python),
  ].join(" ");
}

export function buildReleaseRunGraph(action, context = {}, inputs = {}) {
  if (!action?.id || !action?.source?.scriptPath) throw new Error("A discovered release action is required");
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
        scriptRef: action.source.scriptPath,
        script: wrapperScript(action.action),
        input: [{ type: "node", name: "prev", value: "" }],
        output: [{ type: "node", name: "next", value: "" }],
      },
    },
    edges: [],
    ui: { nodePositions: { release_action: { x: 120, y: 100 } } },
  };
}

export async function previewReleaseAction(action, context = {}, inputs = {}, { executePreview } = {}) {
  if (!action?.id) throw new Error("A discovered release action is required");
  const fingerprint = confirmationFingerprint(action, context, inputs);
  const preview = typeof executePreview === "function"
    ? await executePreview(buildReleaseRunGraph(action, context, inputs))
    : { action: action.action, inputs: { ...inputs }, message: "等待执行预览" };
  return { preview, confirmationFingerprint: fingerprint };
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
  return options.runGraph(buildReleaseRunGraph(action, context, inputs), options);
}

export async function stopReleaseAction(runId, { stopRun } = {}) {
  if (!String(runId || "").trim()) throw new Error("runId is required");
  if (typeof stopRun === "function") return stopRun(runId);
  return { stopped: false, runId };
}
