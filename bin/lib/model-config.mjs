import fs from "fs";
import path from "path";

import { LEGACY_MODEL_CONFIG_REL, MODEL_CONFIG_REL } from "./paths.mjs";

const modelConfigCache = new Map();

/** UI 格式为「模型 ID - 描述」，传参只用前面的模型 ID。若为 "auto" 则规范为 Cursor 可识别的 "Auto"。 */
export function normalizeCursorModelForCli(value) {
  if (value == null || value === false || value === "") return "Auto";
  let s = String(value).trim();
  if (!s) return "Auto";
  const dashIdx = s.indexOf(" - ");
  if (dashIdx >= 0) s = s.slice(0, dashIdx).trim();
  if (!s) return "Auto";
  if (/^auto$/i.test(s)) return "Auto";
  return s;
}

export function loadModelConfig(workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  if (modelConfigCache.has(root)) return modelConfigCache.get(root);
  const primaryPath = path.join(root, MODEL_CONFIG_REL);
  const legacyPath = path.join(root, LEGACY_MODEL_CONFIG_REL);
  const configPath = fs.existsSync(primaryPath) ? primaryPath : legacyPath;
  let config = { models: {} };
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.models && typeof parsed.models === "object") {
        config = { models: parsed.models };
      }
    }
  } catch (_) {
    // ignore parse errors
  }
  modelConfigCache.set(root, config);
  return config;
}

export function resolveCliAndModel(workspaceRoot, nodeModel, agentModelOverride) {
  if (agentModelOverride && String(agentModelOverride).trim()) {
    const raw = String(agentModelOverride).trim();
    if (raw.startsWith("api:")) {
      return { cli: "api", model: raw, label: raw };
    }
    const model = normalizeCursorModelForCli(raw);
    return { cli: "cursor", model, label: `cursor: ${model}` };
  }

  const key = nodeModel && String(nodeModel).trim() ? String(nodeModel).trim() : "";
  if (key) {
    const { models } = loadModelConfig(workspaceRoot);
    const cfg = models[key];
    if (cfg && typeof cfg === "object" && cfg.cli && cfg.model) {
      const cli = cfg.cli === "opencode" ? "opencode" : cfg.cli === "api" ? "api" : "cursor";
      const model = String(cfg.model).trim();
      return { cli, model, label: `${cli}: ${model}` };
    }
  }

  if (key && key.startsWith("api:")) {
    return { cli: "api", model: key, label: key };
  }

  if (key && key.startsWith("opencode:")) {
    const model = key.slice("opencode:".length) || "";
    return {
      cli: "opencode",
      model: model || null,
      label: model ? `opencode: ${model}` : "opencode (default)",
    };
  }

  const envModel = process.env.CURSOR_AGENT_MODEL && String(process.env.CURSOR_AGENT_MODEL).trim();
  if (envModel && envModel.startsWith("api:")) {
    return { cli: "api", model: envModel, label: envModel };
  }
  const model = normalizeCursorModelForCli(key || envModel || "Auto");
  return {
    cli: "cursor",
    model,
    label: model === "Auto" ? "cursor: Auto" : `cursor: ${model}`,
  };
}
