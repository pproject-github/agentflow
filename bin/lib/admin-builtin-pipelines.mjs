import fs from "fs";
import path from "path";
import {
  getAgentflowDataRoot,
  getUserPipelinesRoot,
  isFlowDir,
} from "./paths.mjs";

const CONFIG_FILENAME = "admin-builtin-pipelines.json";

function configPath() {
  return path.join(getAgentflowDataRoot(), "admin", CONFIG_FILENAME);
}

function normalizeConfig(raw) {
  const hiddenBuiltins = Array.isArray(raw?.hiddenBuiltins)
    ? raw.hiddenBuiltins.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  const promoted = Array.isArray(raw?.promoted)
    ? raw.promoted.map((item) => ({
      id: String(item?.id || item?.flowId || "").trim(),
      ownerUserId: String(item?.ownerUserId || "").trim(),
      source: "user",
      createdAt: String(item?.createdAt || ""),
      createdBy: String(item?.createdBy || ""),
    })).filter((item) => item.id && item.ownerUserId)
    : [];
  return {
    hiddenBuiltins: Array.from(new Set(hiddenBuiltins)),
    promoted: promoted.filter((item, index, list) => (
      list.findIndex((other) => other.id === item.id) === index
    )),
  };
}

export function readAdminBuiltinPipelineConfig() {
  try {
    const p = configPath();
    if (!fs.existsSync(p)) return normalizeConfig({});
    return normalizeConfig(JSON.parse(fs.readFileSync(p, "utf-8")));
  } catch {
    return normalizeConfig({});
  }
}

export function writeAdminBuiltinPipelineConfig(config) {
  const next = normalizeConfig(config);
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(next, null, 2) + "\n", "utf-8");
  return next;
}

export function resolveAdminBuiltinPipelineDir(flowId) {
  const id = String(flowId || "").trim();
  if (!id) return "";
  const config = readAdminBuiltinPipelineConfig();
  const entry = config.promoted.find((item) => item.id === id);
  if (!entry) return "";
  const dir = path.join(getUserPipelinesRoot(entry.ownerUserId), entry.id);
  return isFlowDir(dir) ? dir : "";
}

export function updateAdminBuiltinPipelineConfig(action, payload = {}, actor = {}) {
  const config = readAdminBuiltinPipelineConfig();
  const flowId = String(payload.flowId || "").trim();
  if (!flowId) return { ok: false, error: "Missing flowId" };
  if (action === "promote") {
    const ownerUserId = String(payload.ownerUserId || actor.userId || "").trim();
    if (!ownerUserId) return { ok: false, error: "Missing ownerUserId" };
    const dir = path.join(getUserPipelinesRoot(ownerUserId), flowId);
    if (!isFlowDir(dir)) return { ok: false, error: "Pipeline not found" };
    const promoted = config.promoted.filter((item) => item.id !== flowId);
    promoted.unshift({
      id: flowId,
      ownerUserId,
      source: "user",
      createdAt: new Date().toISOString(),
      createdBy: String(actor.userId || ""),
    });
    return { ok: true, config: writeAdminBuiltinPipelineConfig({ ...config, promoted }) };
  }
  if (action === "unpromote") {
    return {
      ok: true,
      config: writeAdminBuiltinPipelineConfig({
        ...config,
        promoted: config.promoted.filter((item) => item.id !== flowId),
      }),
    };
  }
  if (action === "hide-builtin") {
    return {
      ok: true,
      config: writeAdminBuiltinPipelineConfig({
        ...config,
        hiddenBuiltins: Array.from(new Set([...config.hiddenBuiltins, flowId])),
      }),
    };
  }
  if (action === "show-builtin") {
    return {
      ok: true,
      config: writeAdminBuiltinPipelineConfig({
        ...config,
        hiddenBuiltins: config.hiddenBuiltins.filter((id) => id !== flowId),
      }),
    };
  }
  return { ok: false, error: "Invalid action" };
}
