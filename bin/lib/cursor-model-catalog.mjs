import { spawn } from "node:child_process";

const MODEL_CATALOG_TIMEOUT_MS = 15_000;
const MODEL_CATALOG_CACHE_MS = 15 * 60 * 1000;
const MAX_CATALOG_OUTPUT_LENGTH = 64 * 1024;
const ANSI_ESCAPE_PATTERN = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;

const modelCatalogCache = new Map();

export async function discoverCursorModels({
  keyId,
  cwd,
  env,
  command = "agent",
  forceRefresh = false,
} = {}) {
  const now = Date.now();
  const cacheKey = String(keyId || "default");
  const cached = modelCatalogCache.get(cacheKey);
  if (!forceRefresh && cached && cached.expiresAt > now) {
    return buildCatalogResult(cached.models);
  }

  const commandResult = await runModelsCommand({ cwd, env, command });
  if (!commandResult.success) return { models: [], error: commandResult.error };

  const models = parseCursorModelsOutput(commandResult.output);
  if (models.length === 0) {
    return { models: [], error: "Cursor CLI did not return any available models." };
  }
  modelCatalogCache.set(cacheKey, {
    expiresAt: now + MODEL_CATALOG_CACHE_MS,
    models,
  });
  return buildCatalogResult(models);
}

export function parseCursorModelsOutput(output = "") {
  const lines = stripAnsi(String(output || ""))
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const models = [];
  let insideModelList = false;
  for (const line of lines) {
    if (/^available models$/i.test(line)) {
      insideModelList = true;
      continue;
    }
    if (/^tip:/i.test(line)) break;
    if (!insideModelList || /^no models available/i.test(line)) continue;

    const flagsMatch = line.match(/\s+\(((?:current|default)(?:,\s*(?:current|default))*)\)$/i);
    const flags = flagsMatch?.[1]?.toLowerCase() || "";
    const value = flagsMatch ? line.slice(0, flagsMatch.index).trim() : line;
    const separatorIndex = value.indexOf(" - ");
    const id = (separatorIndex >= 0 ? value.slice(0, separatorIndex) : value).trim();
    const displayName = (separatorIndex >= 0 ? value.slice(separatorIndex + 3) : id).trim();
    if (!id || (separatorIndex < 0 && /\s/.test(id))) continue;
    models.push({
      id,
      displayName: displayName || id,
      isDefault: flags.split(/,\s*/).includes("default"),
      isCurrent: flags.split(/,\s*/).includes("current"),
    });
  }
  return dedupeModels(models);
}

export function selectComposerFallbackModel(models = []) {
  return models.find((model) => [model?.id, model?.displayName].some((value) =>
    /(^|[^a-z0-9])composer(?=$|[^a-z0-9])/i.test(String(value || ""))
  ));
}

export function clearCursorModelCatalogCache() {
  modelCatalogCache.clear();
}

function buildCatalogResult(models) {
  const fallback = selectComposerFallbackModel(models);
  return {
    models,
    ...(fallback ? {
      fallbackModel: {
        id: fallback.id,
        displayName: formatComposerModelName(fallback),
        discoveredAt: new Date().toISOString(),
      },
    } : {}),
  };
}

function runModelsCommand({ cwd, env, command }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const child = spawn(command || "agent", ["models"], {
      cwd,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutId);
      resolve(result);
    };
    const timeoutId = setTimeout(() => {
      child.kill("SIGTERM");
      finish({ success: false, error: "Cursor CLI model discovery timed out." });
    }, MODEL_CATALOG_TIMEOUT_MS);
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < MAX_CATALOG_OUTPUT_LENGTH) stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < MAX_CATALOG_OUTPUT_LENGTH) stderr += chunk.toString();
    });
    child.on("error", (error) => finish({ success: false, error: error.message }));
    child.on("exit", (code) => {
      if (code === 0) {
        finish({ success: true, output: stdout.slice(0, MAX_CATALOG_OUTPUT_LENGTH) });
        return;
      }
      finish({
        success: false,
        error: stripAnsi(stderr || stdout || `Cursor CLI models exited with code ${code}`).trim().slice(0, 1000),
      });
    });
  });
}

function stripAnsi(value) {
  return String(value || "").replace(ANSI_ESCAPE_PATTERN, "");
}

function formatComposerModelName(model) {
  if (/(^|[^a-z0-9])composer(?=$|[^a-z0-9])/i.test(model.displayName)) return model.displayName;
  if (model.displayName && model.displayName !== model.id) return `${model.id} · ${model.displayName}`;
  return model.id;
}

function dedupeModels(models) {
  const seen = new Set();
  return models.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}
