import { createHash } from "node:crypto";

let nextCursorApiKeyCursor = 0;
const cursorApiKeyStates = new Map();

export function parseCursorApiKeyRecords(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return [];
  const normalizeRecord = (item, index) => {
    if (typeof item === "string") {
      const key = item.trim();
      return key ? { id: legacyKeyId(key), name: `Key ${index + 1}`, key } : null;
    }
    if (!item || typeof item !== "object") return null;
    const key = String(item.key || "").trim();
    if (!key) return null;
    return {
      id: String(item.id || "").trim() || legacyKeyId(key),
      name: String(item.name || "").trim() || `Key ${index + 1}`,
      key,
      createdAt: String(item.createdAt || "").trim(),
    };
  };
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.map(normalizeRecord).filter(Boolean);
  } catch {
    // Legacy comma-separated format.
  }
  return raw.split(",").map(normalizeRecord).filter(Boolean);
}

export function parseCursorApiKeyPool(value = "") {
  return parseCursorApiKeyRecords(value).map((record) => record.key);
}

export function createCursorApiKeyAttempts(env = {}, now = Date.now()) {
  const records = parseCursorApiKeyRecords(env.CURSOR_API_KEYS);
  if (records.length === 0) return [undefined];

  const selections = records.map((record, index) => ({
    ...record,
    index,
    total: records.length,
    modelSelection: getCursorApiKeyModelSelection(record.id, now),
  }));
  const candidates = selections.filter((selection) => Boolean(selection.modelSelection));
  // Preserve the old pool's last-resort behavior if every key is cooling down.
  // Normal operation always uses candidates and therefore respects lane cooldowns.
  const effective = candidates.length > 0
    ? candidates
    : selections.map((selection) => ({
        ...selection,
        modelSelection: { lane: "auto", modelId: "auto", modelName: "Auto" },
      }));
  const start = nextCursorApiKeyCursor % effective.length;
  nextCursorApiKeyCursor += 1;
  return [...effective.slice(start), ...effective.slice(0, start)];
}

export function getCursorApiKeyModelSelection(keyOrSelection, now = Date.now()) {
  const keyId = selectionId(keyOrSelection);
  const keyState = cursorApiKeyStates.get(keyId);
  const autoBlocked = (keyState?.auto?.blockedUntil || 0) > now;
  if (!autoBlocked) return { lane: "auto", modelId: "auto", modelName: "Auto" };

  if (keyState?.auto?.errorCategory !== "explicit_limit" || keyState.auto.fallbackEligible !== true) {
    return undefined;
  }
  const fallbackModel = keyState.fallbackModel;
  if (!fallbackModel || (keyState.fallback?.blockedUntil || 0) > now) return undefined;
  return {
    lane: "fallback",
    modelId: fallbackModel.id,
    modelName: fallbackModel.displayName,
  };
}

export function recordCursorApiKeyFallbackModel(keyOrSelection, model) {
  if (!model?.id) return;
  const keyId = selectionId(keyOrSelection);
  const keyState = cursorApiKeyStates.get(keyId) || {};
  keyState.fallbackModel = { ...model };
  cursorApiKeyStates.set(keyId, keyState);
}

export function markCursorApiKeyLaneBlocked(
  keyOrSelection,
  lane,
  cooldownMinutes = 30,
  errorText = "",
  now = Date.now(),
  evidence = {},
) {
  const keyId = selectionId(keyOrSelection);
  if (!keyId || !["auto", "fallback"].includes(lane)) return 0;
  const minutes = Math.max(1, Number(cooldownMinutes) || 30);
  const keyState = cursorApiKeyStates.get(keyId) || {};
  const currentLane = keyState[lane] || {};
  const blockedUntil = Math.max(currentLane.blockedUntil || 0, now + minutes * 60 * 1000);
  const errorCategory = classifyCursorApiKeyLimitError(errorText);
  const fallbackModel = keyState.fallbackModel;
  const lastFailure = {
    triggeredAt: new Date(now).toISOString(),
    ...(errorCategory ? { errorCategory } : {}),
    errorPreview: sanitizeErrorPreview(errorText),
    lane,
    modelId: String(evidence?.modelId || (lane === "auto" ? "auto" : fallbackModel?.id || "fallback")),
    modelName: String(evidence?.modelName || (lane === "auto" ? "Auto" : fallbackModel?.displayName || "降级模型")),
  };
  keyState[lane] = {
    ...currentLane,
    blockedUntil,
    ...(errorCategory ? { errorCategory } : {}),
    ...(lane === "auto" ? { fallbackEligible: isCursorAutoFallbackEligible(errorText) } : {}),
    lastFailure,
  };
  keyState.lastFailure = lastFailure;
  cursorApiKeyStates.set(keyId, keyState);
  return blockedUntil;
}

export function clearCursorApiKeyLaneCooldown(keyOrSelection, lane) {
  const keyState = cursorApiKeyStates.get(selectionId(keyOrSelection));
  if (!keyState?.[lane]) return false;
  keyState[lane].blockedUntil = 0;
  delete keyState[lane].errorCategory;
  delete keyState[lane].fallbackEligible;
  return true;
}

export function clearCursorApiKeyCooldown(keyOrSelection) {
  const keyState = cursorApiKeyStates.get(selectionId(keyOrSelection));
  if (!keyState) return false;
  let changed = false;
  for (const lane of ["auto", "fallback"]) {
    if (!keyState[lane] || (keyState[lane].blockedUntil || 0) <= 0) continue;
    keyState[lane].blockedUntil = 0;
    delete keyState[lane].errorCategory;
    delete keyState[lane].fallbackEligible;
    changed = true;
  }
  return changed;
}

export function recordCursorApiKeyUsage(keyOrSelection, selection = {}, now = Date.now()) {
  const keyId = selectionId(keyOrSelection);
  if (!keyId || keyId === "default") return;
  const keyState = cursorApiKeyStates.get(keyId) || {};
  keyState.lastUsedAt = new Date(now).toISOString();
  keyState.lastSelection = {
    lane: selection?.lane === "fallback" ? "fallback" : "auto",
    modelId: String(selection?.modelId || "auto"),
    modelName: String(selection?.modelName || "Auto"),
  };
  cursorApiKeyStates.set(keyId, keyState);
}

export function getCursorApiKeyPoolStatuses(records = [], now = Date.now()) {
  return (Array.isArray(records) ? records : []).map((record) => {
    const id = selectionId(record);
    const keyState = cursorApiKeyStates.get(id);
    const selection = getCursorApiKeyModelSelection(id, now);
    const laneCooldowns = buildLaneCooldowns(keyState, now);
    const common = {
      id,
      ...(keyState?.lastUsedAt ? { lastUsedAt: keyState.lastUsedAt } : {}),
      ...(keyState?.fallbackModel ? { fallbackModel: keyState.fallbackModel } : {}),
      laneCooldowns,
      ...(keyState?.lastFailure ? { lastFailure: keyState.lastFailure } : {}),
    };
    if (selection) {
      return {
        ...common,
        status: "available",
        activeLane: selection.lane,
        activeModelId: selection.modelId,
        activeModelName: selection.modelName,
        degraded: selection.lane === "fallback",
      };
    }
    const activeCooldowns = laneCooldowns.filter((item) => item.remainingSeconds > 0);
    const earliest = activeCooldowns.reduce(
      (result, item) => !result || item.remainingSeconds < result.remainingSeconds ? item : result,
      undefined,
    );
    const autoState = keyState?.auto;
    return {
      ...common,
      status: "cooling_down",
      ...(autoState?.errorCategory ? { errorCategory: autoState.errorCategory } : {}),
      blockedUntil: earliest?.blockedUntil || new Date(Math.max(now, autoState?.blockedUntil || now)).toISOString(),
      remainingSeconds: earliest?.remainingSeconds || Math.max(0, Math.ceil(((autoState?.blockedUntil || now) - now) / 1000)),
    };
  });
}

export function cursorApiKeyEnv(selection) {
  return selection?.key ? { CURSOR_API_KEY: selection.key } : {};
}

export function markCursorApiKeyQuotaBlocked(selection, cooldownMinutes = 30, errorText = "") {
  return markCursorApiKeyLaneBlocked(selection, "auto", cooldownMinutes, errorText);
}

export function cursorApiKeyLabel(selection) {
  if (!selection) return "default";
  return selection.name ? `${selection.index + 1}/${selection.total} (${selection.name})` : `${selection.index + 1}/${selection.total}`;
}

export function isCursorAutoFallbackEligible(error = "") {
  const text = String(error || "");
  return [/\bout\s+of\s+usage\b/i, /\busage\s+limit\b/i].some((pattern) => pattern.test(text));
}

export function classifyCursorApiKeyLimitError(error = "") {
  const text = String(error || "");
  if (!text) return undefined;
  const isExplicitLimit = [
    /\b429\b/i,
    /rate[_\s-]*limit/i,
    /too many requests/i,
    /quota/i,
    /usage\s+limit/i,
    /out\s+of\s+usage/i,
    /limit\s+(?:exceeded|reached)/i,
    /exceeded\s+(?:your\s+)?limit/i,
    /insufficient[_\s-]*quota/i,
    /credit[s]?\s+(?:exhausted|limit)/i,
    /request\s+limit/i,
  ].some((pattern) => pattern.test(text));
  if (isExplicitLimit) return "explicit_limit";
  if (/resource[_\s-]*exhausted/i.test(text)) return "resource_exhausted";
  return undefined;
}

export function isCursorQuotaError(error = "") {
  return classifyCursorApiKeyLimitError(error) !== undefined;
}

export function cursorApiKeyCooldownMinutes(env = {}, errorText = "") {
  if (classifyCursorApiKeyLimitError(errorText) === "resource_exhausted") {
    return Math.max(1, Number(env.AGENTFLOW_CURSOR_API_KEY_RESOURCE_EXHAUSTED_COOLDOWN_MINUTES || 3) || 3);
  }
  return Math.max(1, Number(env.AGENTFLOW_CURSOR_API_KEY_COOLDOWN_MINUTES || env.CURSOR_API_KEY_COOLDOWN_MINUTES || 30) || 30);
}

export function resetCursorApiKeyPoolForTests() {
  nextCursorApiKeyCursor = 0;
  cursorApiKeyStates.clear();
}

function selectionId(keyOrSelection) {
  if (typeof keyOrSelection === "string") return keyOrSelection;
  if (keyOrSelection?.id) return String(keyOrSelection.id);
  if (keyOrSelection?.key) return legacyKeyId(String(keyOrSelection.key));
  return "default";
}

function legacyKeyId(key) {
  return `legacy_${createHash("sha256").update(String(key || "")).digest("hex").slice(0, 16)}`;
}

function buildLaneCooldowns(keyState, now) {
  if (!keyState) return [];
  const lanes = [];
  for (const lane of ["auto", "fallback"]) {
    const laneState = keyState[lane];
    if (!laneState || (laneState.blockedUntil || 0) <= now) continue;
    const fallbackModel = keyState.fallbackModel;
    lanes.push({
      lane,
      modelId: lane === "auto" ? "auto" : fallbackModel?.id || "fallback",
      modelName: lane === "auto" ? "Auto" : fallbackModel?.displayName || "降级模型",
      ...(laneState.errorCategory ? { errorCategory: laneState.errorCategory } : {}),
      blockedUntil: new Date(laneState.blockedUntil).toISOString(),
      remainingSeconds: Math.ceil((laneState.blockedUntil - now) / 1000),
    });
  }
  return lanes;
}

function sanitizeErrorPreview(errorText) {
  return String(errorText || "").replace(/(?:sk|key)[-_][A-Za-z0-9_-]{8,}/gi, "[redacted]").trim().slice(0, 500);
}
