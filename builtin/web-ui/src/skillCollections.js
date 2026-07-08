export function normalizeSkillCollections(value) {
  const collections = Array.isArray(value?.collections) ? value.collections : [];
  return collections
    .filter((item) => item && typeof item === "object")
    .map((item) => ({
      id: String(item.id || item.name || "").trim(),
      name: String(item.name || item.id || "").trim(),
      skillKeys: Array.from(new Set((Array.isArray(item.skillKeys) ? item.skillKeys : []).map((key) => String(key || "").trim()).filter(Boolean))),
      builtin: Boolean(item.builtin),
      createdAt: Number.isFinite(item.createdAt) ? Number(item.createdAt) : Date.now(),
      updatedAt: Number.isFinite(item.updatedAt) ? Number(item.updatedAt) : Date.now(),
    }))
    .filter((item) => item.id && item.name);
}

export function skillCollectionConfig(collections) {
  return { version: 1, collections: normalizeSkillCollections({ collections }) };
}

function skillNameFromKey(key) {
  const value = String(key || "").trim();
  const idx = value.indexOf(":");
  return idx >= 0 ? value.slice(idx + 1).trim() : value;
}

function skillKeyResolver(skills) {
  const byKey = new Map();
  const byName = new Map();
  for (const skill of Array.isArray(skills) ? skills : []) {
    if (skill?.key) byKey.set(skill.key, skill.key);
    if (skill?.name && skill?.key && !byName.has(skill.name)) byName.set(skill.name, skill.key);
  }
  return (key) => {
    const raw = String(key || "").trim();
    if (!raw) return "";
    return byKey.get(raw) || byName.get(skillNameFromKey(raw)) || "";
  };
}

export function collectionSkillKeys(collection, skills) {
  const resolveSkillKey = skillKeyResolver(skills);
  return Array.from(new Set((Array.isArray(collection?.skillKeys) ? collection.skillKeys : [])
    .map((key) => resolveSkillKey(key))
    .filter(Boolean)));
}

export function addSkillKeys(selected, keys) {
  const out = new Set(Array.isArray(selected) ? selected : []);
  for (const key of Array.isArray(keys) ? keys : []) {
    if (key) out.add(key);
  }
  return Array.from(out);
}

export function removeSkillKeys(selected, keys) {
  const remove = new Set(Array.isArray(keys) ? keys : []);
  return (Array.isArray(selected) ? selected : []).filter((key) => !remove.has(key));
}

export function collectionSelectionState(collection, selectedSet, skills) {
  const keys = collectionSkillKeys(collection, skills);
  if (keys.length === 0) return "empty";
  const count = keys.filter((key) => selectedSet.has(key)).length;
  if (count === 0) return "none";
  if (count === keys.length) return "all";
  return "partial";
}

export function defaultSkillKeysForView(view, skills, collections) {
  const id = String(view || "").trim().toLowerCase();
  const collection = normalizeSkillCollections({ collections }).find((item) => item.id === id || item.name.toLowerCase() === id);
  return collectionSkillKeys(collection, skills);
}

export function readStoredOrDefaultSkillKeys(storageKey, view, skills, collections) {
  const availableKeys = (Array.isArray(skills) ? skills : []).map((skill) => skill.key).filter(Boolean);
  const normalizedView = String(view || "").trim().toLowerCase();
  const normalizedCollections = normalizeSkillCollections({ collections });
  const defaultKeys = defaultSkillKeysForView(view, skills, collections);
  const fallback = defaultKeys.length > 0 ? defaultKeys : availableKeys;
  if (!storageKey) return fallback;
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw !== null) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const resolveSkillKey = skillKeyResolver(skills);
        const stored = Array.from(new Set(parsed.map(resolveSkillKey).filter(Boolean)));
        if (availableKeys.length > 0 && stored.length === availableKeys.length) return fallback;
        const storedSet = new Set(stored);
        const defaultSet = new Set(defaultKeys);
        const hasAllDefault = defaultKeys.length > 0 && defaultKeys.every((key) => storedSet.has(key));
        const otherBuiltInSelected = normalizedCollections.some((collection) => {
          if (!collection.builtin) return false;
          if (collection.id === normalizedView || collection.name.toLowerCase() === normalizedView) return false;
          const keys = collectionSkillKeys(collection, skills);
          return keys.length > 0 && keys.every((key) => storedSet.has(key));
        });
        if (defaultKeys.length > 0 && otherBuiltInSelected && !hasAllDefault) return fallback;
        return stored;
      }
    }
  } catch {
    /* ignore invalid storage */
  }
  return fallback;
}
