let nextCursorApiKeyCursor = 0;
const cursorApiKeyBlockedUntil = new Map();

export function parseCursorApiKeyPool(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => {
          if (typeof item === "string") return item.trim();
          if (item && typeof item === "object") return String(item.key || "").trim();
          return "";
        })
        .filter(Boolean);
    }
  } catch {
    // Legacy comma-separated format.
  }
  return raw.split(",").map((key) => key.trim()).filter(Boolean);
}

export function createCursorApiKeyAttempts(env = {}) {
  const keys = parseCursorApiKeyPool(env.CURSOR_API_KEYS);
  if (keys.length === 0) return [undefined];

  const now = Date.now();
  const candidates = keys
    .map((key, index) => ({ key, index, total: keys.length }))
    .filter((selection) => (cursorApiKeyBlockedUntil.get(selection.index) || 0) <= now);
  const effective = candidates.length > 0 ? candidates : keys.map((key, index) => ({ key, index, total: keys.length }));
  const start = nextCursorApiKeyCursor % effective.length;
  nextCursorApiKeyCursor += 1;
  return [...effective.slice(start), ...effective.slice(0, start)];
}

export function cursorApiKeyEnv(selection) {
  return selection && selection.key ? { CURSOR_API_KEY: selection.key } : {};
}

export function markCursorApiKeyQuotaBlocked(selection, cooldownMinutes = 30) {
  if (!selection || !Number.isFinite(selection.index)) return;
  const minutes = Math.max(1, Number(cooldownMinutes) || 30);
  cursorApiKeyBlockedUntil.set(selection.index, Date.now() + minutes * 60 * 1000);
}

export function cursorApiKeyLabel(selection) {
  if (!selection) return "default";
  return `${selection.index + 1}/${selection.total}`;
}

export function isCursorQuotaError(error = "") {
  const text = String(error || "");
  if (!text) return false;
  return [
    /\b429\b/i,
    /rate[_\s-]*limit/i,
    /too many requests/i,
    /quota/i,
    /usage\s+limit/i,
    /limit\s+(?:exceeded|reached)/i,
    /exceeded\s+(?:your\s+)?limit/i,
    /resource[_\s-]*exhausted/i,
    /ActionRequiredError/i,
  ].some((pattern) => pattern.test(text));
}

export function cursorApiKeyCooldownMinutes(env = {}) {
  return Math.max(1, Number(env.AGENTFLOW_CURSOR_API_KEY_COOLDOWN_MINUTES || env.CURSOR_API_KEY_COOLDOWN_MINUTES || 30) || 30);
}
