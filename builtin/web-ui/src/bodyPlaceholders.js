/** 与 get-resolved-values 注入的 resolvedInputs 一致（含 flowDir：当前 flow.yaml 所在目录绝对路径） */
export const RUNTIME_PLACEHOLDER_KEYS = new Set(["workspaceRoot", "flowName", "runDir", "flowDir"]);

/** 补全菜单中运行时常量顺序（稳定展示） */
export const RUNTIME_PLACEHOLDER_KEYS_ORDER = ["workspaceRoot", "flowName", "runDir", "flowDir"];

/**
 * 光标处是否存在未闭合的 `${...}`（用于补全）。
 * @param {string} text
 * @param {number} cursor
 * @returns {{ atIndex: number, query: string } | null}
 */
export function parseOpenPlaceholderContext(text, cursor) {
  const before = text.slice(0, cursor);
  const openIdx = before.lastIndexOf("${");
  if (openIdx < 0) return null;
  const afterOpen = before.slice(openIdx + 2);
  if (afterOpen.includes("}")) return null;
  return { atIndex: openIdx, query: afterOpen };
}

/**
 * @param {string} text
 * @returns {Array<{ start: number, end: number, key: string }>}
 */
export function findClosedPlaceholderRanges(text) {
  const re = /\$\{([^}]*)\}/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    out.push({
      start: m.index,
      end: m.index + m[0].length,
      key: m[1],
    });
  }
  return out;
}

/**
 * @param {Array<{ name?: string } | undefined>} slots
 * @returns {Set<string>}
 */
function slotNamesToSet(slots) {
  const set = new Set();
  if (!Array.isArray(slots)) return set;
  for (const s of slots) {
    const n = s?.name != null ? String(s.name).trim() : "";
    if (n) set.add(n);
  }
  return set;
}

/**
 * @param {string} key
 * @param {{ inputNames: Set<string>, outputNames: Set<string> }} names
 * @returns {boolean}
 */
export function isValidPlaceholderKey(key, { inputNames, outputNames }) {
  const k = key.trim();
  if (!k) return false;
  if (k.startsWith("input.")) {
    const slot = k.slice(6).trim();
    return slot !== "" && inputNames.has(slot);
  }
  if (k.startsWith("output.")) {
    const slot = k.slice(7).trim();
    return slot !== "" && outputNames.has(slot);
  }
  if (RUNTIME_PLACEHOLDER_KEYS.has(k)) return true;
  if (inputNames.has(k) || outputNames.has(k)) return true;
  if (!k.includes(".")) {
    const md = `${k}.md`;
    if (inputNames.has(md) || outputNames.has(md)) return true;
  }
  return false;
}

/**
 * @param {{ inputs?: { name?: string }[], outputs?: { name?: string }[] }} slots
 */
export function namesFromSlots(slots) {
  return {
    inputNames: slotNamesToSet(slots?.inputs),
    outputNames: slotNamesToSet(slots?.outputs),
  };
}

/**
 * @param {string} body
 * @param {{ inputs?: { name?: string }[], outputs?: { name?: string }[] }} slots
 * @returns {Array<{ start: number, end: number, message: string }>}
 */
export function validateBodyPlaceholders(body, slots, i18n) {
  const names = namesFromSlots(slots);
  const ranges = findClosedPlaceholderRanges(body);
  const invalid = [];
  for (const r of ranges) {
    if (!isValidPlaceholderKey(r.key, names)) {
      const hint = r.key.trim() === "" ? i18n("flow:placeholder.empty") : r.key.trim();
      invalid.push({ start: r.start, end: r.end, message: i18n("flow:placeholder.invalidPlaceholder", { hint }) });
    }
  }
  return invalid;
}

/**
 * @typedef {{ kind: "plain" | "ph-valid" | "ph-invalid", text: string }} BodyHighlightSegment
 * @param {string} body
 * @param {{ inputs?: { name?: string }[], outputs?: { name?: string }[] }} slots
 * @returns {BodyHighlightSegment[]}
 */
export function getBodyHighlightSegments(body, slots) {
  const names = namesFromSlots(slots);
  const re = /\$\{([^}]*)\}/g;
  /** @type {BodyHighlightSegment[]} */
  const segments = [];
  let last = 0;
  let m;
  while ((m = re.exec(body)) !== null) {
    if (m.index > last) segments.push({ kind: "plain", text: body.slice(last, m.index) });
    const full = m[0];
    const ok = isValidPlaceholderKey(m[1], names);
    segments.push({ kind: ok ? "ph-valid" : "ph-invalid", text: full });
    last = m.index + full.length;
  }
  if (last < body.length) segments.push({ kind: "plain", text: body.slice(last) });
  return segments;
}

/**
 * @param {string} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * @param {BodyHighlightSegment[]} segments
 * @returns {string}
 */
export function segmentsToBackdropHtml(segments) {
  return segments
    .map((seg) => {
      const esc = escapeHtml(seg.text);
      if (seg.kind === "ph-invalid") return `<span class="af-body-ph-invalid">${esc}</span>`;
      if (seg.kind === "ph-valid") return `<span class="af-body-ph-valid">${esc}</span>`;
      return esc;
    })
    .join("");
}

/** @typedef {{ section: "input" | "output" | "runtime", insert: string, label: string, subtitle?: string }} PlaceholderMenuItem */

/**
 * @param {{ inputs?: { name?: string, type?: string }[], outputs?: { name?: string, type?: string }[] }} slots
 * @returns {PlaceholderMenuItem[]}
 */
export function buildPlaceholderMenuItems(slots, i18n) {
  /** @type {PlaceholderMenuItem[]} */
  const items = [];
  for (const s of slots?.inputs ?? []) {
    const n = s?.name != null ? String(s.name).trim() : "";
    if (!n) continue;
    const t = s?.type != null ? String(s.type) : "";
    items.push({
      section: "input",
      insert: `input.${n}`,
      label: n,
      subtitle: t ? i18n("flow:placeholder.inputSubtitle", { type: t }) : i18n("flow:placeholder.inputSubtitleNoType"),
    });
  }
  for (const s of slots?.outputs ?? []) {
    const n = s?.name != null ? String(s.name).trim() : "";
    if (!n) continue;
    const t = s?.type != null ? String(s.type) : "";
    items.push({
      section: "output",
      insert: `output.${n}`,
      label: n,
      subtitle: t ? i18n("flow:placeholder.outputSubtitle", { type: t }) : i18n("flow:placeholder.outputSubtitleNoType"),
    });
  }
  for (const k of RUNTIME_PLACEHOLDER_KEYS_ORDER) {
    if (RUNTIME_PLACEHOLDER_KEYS.has(k)) {
      items.push({ section: "runtime", insert: k, label: k, subtitle: i18n("flow:placeholder.runtimeConst") });
    }
  }
  return items;
}

/**
 * @param {PlaceholderMenuItem[]} items
 * @param {string} query
 * @returns {PlaceholderMenuItem[]}
 */
export function filterPlaceholderMenuItems(items, query) {
  const q = query.toLowerCase();
  if (!q) return items;
  return items.filter((it) => {
    const hay = [it.insert, it.label, it.subtitle ?? ""].map((x) => String(x).toLowerCase());
    return hay.some((h) => h.includes(q));
  });
}
