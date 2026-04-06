/**
 * 与 bin/lib/flow-import.mjs 中 suggestFlowIdFromZip 逻辑一致，用于前端预填流水线 ID。
 */
import { unzipSync } from "fflate";

const IMPORT_MAX_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;
const IMPORT_MAX_FILE_ENTRIES = 500;

/** @param {string} rel */
function sanitizeRelativeEntryPath(rel) {
  if (rel == null || typeof rel !== "string") return null;
  let s = rel.replace(/\\/g, "/").replace(/^\uFEFF/, "");
  while (s.startsWith("/")) s = s.slice(1);
  if (!s || s.includes("\0")) return null;
  if (/^[a-zA-Z]:/.test(s)) return null;
  const parts = s.split("/").filter((p) => p.length > 0);
  for (const p of parts) {
    if (p === "." || p === "..") return null;
  }
  return parts.join("/");
}

/** @param {string} norm */
function shouldIgnoreZipPath(norm) {
  if (!norm) return true;
  const parts = norm.split("/");
  return parts.some((seg) => seg === "__MACOSX" || seg.startsWith("._"));
}

/** @param {string} normPath */
function flowYamlParentDir(normPath) {
  const lower = normPath.toLowerCase();
  if (lower === "flow.yaml" || lower === "flow.yml") return "";
  const suf = "/flow.yaml";
  const sufYml = "/flow.yml";
  let parent = null;
  if (lower.endsWith(suf)) parent = normPath.slice(0, -suf.length);
  else if (lower.endsWith(sufYml)) parent = normPath.slice(0, -sufYml.length);
  else return null;
  if (parent.includes("/")) return null;
  return parent;
}

const PIPELINE_ID_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/**
 * @param {File} file
 * @returns {Promise<string | null>}
 */
export async function peekSuggestedFlowIdFromZipFile(file) {
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    const unzipped = unzipSync(buf);
    /** @type {Map<string, number>} */
    const raw = new Map();
    let total = 0;
    let count = 0;

    for (const [rawKey, u8b] of Object.entries(unzipped)) {
      if (rawKey.endsWith("/")) continue;
      const norm = sanitizeRelativeEntryPath(rawKey);
      if (!norm || shouldIgnoreZipPath(norm)) continue;
      const size = u8b?.length ?? 0;
      total += size;
      if (total > IMPORT_MAX_UNCOMPRESSED_BYTES) return null;
      count += 1;
      if (count > IMPORT_MAX_FILE_ENTRIES) return null;
      raw.set(norm, size);
    }

    if (raw.size === 0) return null;

    /** @type {Set<string>} */
    const parents = new Set();
    for (const k of raw.keys()) {
      const p = flowYamlParentDir(k);
      if (p !== null) parents.add(p);
    }

    if (parents.size !== 1) return null;

    const [prefix] = [...parents];
    if (prefix === "") return null;

    for (const k of raw.keys()) {
      const need = k === prefix || k.startsWith(`${prefix}/`);
      if (!need) return null;
    }

    return PIPELINE_ID_RE.test(prefix) ? prefix : null;
  } catch {
    return null;
  }
}
