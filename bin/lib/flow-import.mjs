/**
 * 从 flow.yaml 文本或 zip 解压结果导入流水线目录（user / workspace）。
 */
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { unzipSync } from "fflate";
import { resolveFlowDirForWrite, validateUserPipelineId } from "./flow-write.mjs";
import { normalizeFlowYamlText } from "./flow-normalize.mjs";

export const IMPORT_MAX_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;
export const IMPORT_MAX_FILE_ENTRIES = 500;

/**
 * @param {string} rel
 * @returns {string | null} 规范化后的 posix 相对路径，非法则 null
 */
export function sanitizeRelativeEntryPath(rel) {
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

function shouldIgnoreZipPath(norm) {
  if (!norm) return true;
  const parts = norm.split("/");
  return parts.some((seg) => seg === "__MACOSX" || seg.startsWith("._"));
}

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

/**
 * @param {unknown} data
 * @returns {boolean}
 */
function isValidFlowRootShape(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) return false;
  const o = /** @type {Record<string, unknown>} */ (data);
  if (o.instances != null && typeof o.instances !== "object") return false;
  if (Array.isArray(o.instances)) return false;
  const edges = o.edges;
  const flowEdges = o.flow && typeof o.flow === "object" ? /** @type {any} */ (o.flow).edges : undefined;
  if (edges != null && !Array.isArray(edges)) return false;
  if (flowEdges != null && !Array.isArray(flowEdges)) return false;
  return true;
}

/**
 * @param {string} content
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
export function validateImportedFlowYaml(content) {
  if (content == null || typeof content !== "string") {
    return { ok: false, error: "flow.yaml 内容无效" };
  }
  if (Buffer.byteLength(content, "utf8") > IMPORT_MAX_UNCOMPRESSED_BYTES) {
    return { ok: false, error: "flow.yaml 过大" };
  }
  try {
    const data = yaml.load(content);
    if (!isValidFlowRootShape(data)) {
      return { ok: false, error: "flow.yaml 根结构无效（需含 instances 对象与 edges 数组等）" };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: (e && e.message) || "YAML 解析失败" };
  }
}

/**
 * @param {Record<string, Uint8Array>} unzipped
 * @returns {{ ok: true, files: Map<string, Buffer> } | { ok: false, error: string }}
 */
export function normalizeZipToPipelineFiles(unzipped) {
  /** @type {Map<string, Buffer>} */
  const raw = new Map();
  let total = 0;
  let count = 0;

  for (const [rawKey, u8] of Object.entries(unzipped)) {
    if (rawKey.endsWith("/")) continue;
    const norm = sanitizeRelativeEntryPath(rawKey);
    if (!norm || shouldIgnoreZipPath(norm)) continue;
    const size = u8?.length ?? 0;
    total += size;
    if (total > IMPORT_MAX_UNCOMPRESSED_BYTES) {
      return { ok: false, error: "解压后总大小超过限制（8MB）" };
    }
    count += 1;
    if (count > IMPORT_MAX_FILE_ENTRIES) {
      return { ok: false, error: "压缩包内文件数量过多（最多 500 个）" };
    }
    raw.set(norm, Buffer.from(u8));
  }

  if (raw.size === 0) {
    return { ok: false, error: "压缩包内没有可导入的文件" };
  }

  /** @type {Set<string>} */
  const parents = new Set();
  for (const k of raw.keys()) {
    const p = flowYamlParentDir(k);
    if (p !== null) parents.add(p);
  }

  if (parents.size === 0) {
    return { ok: false, error: "压缩包内未找到 flow.yaml" };
  }
  if (parents.size > 1) {
    return { ok: false, error: "压缩包内存在多个 pipeline（多个 flow.yaml），请分别打包" };
  }

  const [prefix] = [...parents];

  for (const k of raw.keys()) {
    const need = prefix === "" ? true : k === prefix || k.startsWith(`${prefix}/`);
    if (!need) {
      return {
        ok: false,
        error: "ZIP 目录结构无效：存在不属于该流水线目录的文件（请使用单文件夹或根目录 flow.yaml）",
      };
    }
  }

  /** @type {Map<string, Buffer>} */
  const out = new Map();
  const strip = prefix === "" ? "" : `${prefix}/`;
  for (const [k, buf] of raw) {
    const inner = strip ? (k.startsWith(strip) ? k.slice(strip.length) : k) : k;
    if (!inner || inner.endsWith("/")) continue;
    const safe = sanitizeRelativeEntryPath(inner);
    if (!safe) {
      return { ok: false, error: `非法路径: ${inner}` };
    }
    out.set(safe, buf);
  }

  const yamlKeys = [...out.keys()].filter(
    (k) => k.toLowerCase() === "flow.yaml" || k.toLowerCase() === "flow.yml",
  );
  if (yamlKeys.length === 0) {
    return { ok: false, error: "归一化后缺少 flow.yaml" };
  }
  if (yamlKeys.length > 1) {
    return { ok: false, error: "流水线目录内不能同时存在多个 flow.yaml / flow.yml" };
  }

  const yamlKey = yamlKeys[0];
  if (yamlKey !== "flow.yaml") {
    const body = out.get(yamlKey);
    out.delete(yamlKey);
    out.set("flow.yaml", body);
  }

  return { ok: true, files: out };
}

/**
 * @param {Map<string, Buffer>} out
 */
/**
 * 仅从 zip 推断建议的流水线 ID（单文件夹布局时取文件夹名）；不写入磁盘。
 * @param {Buffer} zipBuffer
 * @returns {{ ok: true, suggestedFlowId: string | null } | { ok: false, error: string }}
 */
export function suggestFlowIdFromZip(zipBuffer) {
  try {
    const u8 = zipBuffer instanceof Uint8Array ? zipBuffer : new Uint8Array(zipBuffer);
    const unzipped = unzipSync(u8);
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
      if (total > IMPORT_MAX_UNCOMPRESSED_BYTES) {
        return { ok: false, error: "解压后总大小超过限制（8MB）" };
      }
      count += 1;
      if (count > IMPORT_MAX_FILE_ENTRIES) {
        return { ok: false, error: "压缩包内文件数量过多（最多 500 个）" };
      }
      raw.set(norm, size);
    }

    if (raw.size === 0) {
      return { ok: false, error: "压缩包内没有可导入的文件" };
    }

    /** @type {Set<string>} */
    const parents = new Set();
    for (const k of raw.keys()) {
      const p = flowYamlParentDir(k);
      if (p !== null) parents.add(p);
    }

    if (parents.size !== 1) {
      return { ok: true, suggestedFlowId: null };
    }

    const [prefix] = [...parents];
    if (prefix === "") {
      return { ok: true, suggestedFlowId: null };
    }

    for (const k of raw.keys()) {
      const need = k === prefix || k.startsWith(`${prefix}/`);
      if (!need) {
        return { ok: true, suggestedFlowId: null };
      }
    }

    const idCheck = validateUserPipelineId(prefix);
    if (!idCheck.ok) return { ok: true, suggestedFlowId: null };
    return { ok: true, suggestedFlowId: idCheck.flowId };
  } catch (e) {
    return { ok: false, error: (e && e.message) || "ZIP 解析失败" };
  }
}

/**
 * @param {Buffer} zipBuffer
 * @returns {{ ok: true, files: Map<string, Buffer> } | { ok: false, error: string }}
 */
export function unzipAndNormalizePipelineZip(zipBuffer) {
  try {
    const u8 = zipBuffer instanceof Uint8Array ? zipBuffer : new Uint8Array(zipBuffer);
    const unzipped = unzipSync(u8);
    return normalizeZipToPipelineFiles(unzipped);
  } catch (e) {
    return { ok: false, error: (e && e.message) || "ZIP 解压失败" };
  }
}

/**
 * @param {string} workspaceRoot
 * @param {string} flowId
 * @param {"user" | "workspace"} flowSource
 * @param {Map<string, Buffer>} filesRelative 相对流水线根，须含 flow.yaml
 * @returns {{ success: true } | { success: false, error: string }}
 */
export function writePipelineTree(workspaceRoot, flowId, flowSource, filesRelative) {
  const { flowDir, error } = resolveFlowDirForWrite(workspaceRoot, flowId, flowSource);
  if (error) return { success: false, error };
  if (fs.existsSync(flowDir)) {
    return { success: false, error: "目标目录已存在" };
  }

  const yamlBuf = filesRelative.get("flow.yaml");
  if (!yamlBuf) return { success: false, error: "缺少 flow.yaml" };
  const text = yamlBuf.toString("utf8");
  const v = validateImportedFlowYaml(text);
  if (!v.ok) return { success: false, error: v.error };
  const normalizedYaml = normalizeFlowYamlText(text).text;

  try {
    fs.mkdirSync(flowDir, { recursive: true });
    for (const [rel, buf] of filesRelative) {
      const safe = sanitizeRelativeEntryPath(rel);
      if (!safe) return { success: false, error: `非法路径: ${rel}` };
      const abs = path.resolve(path.join(flowDir, ...safe.split("/")));
      const base = path.resolve(flowDir);
      const baseWithSep = base.endsWith(path.sep) ? base : base + path.sep;
      if (abs !== base && !abs.startsWith(baseWithSep)) {
        return { success: false, error: "路径越界" };
      }
      const parent = path.dirname(abs);
      fs.mkdirSync(parent, { recursive: true });
      const payload = safe === "flow.yaml" ? Buffer.from(normalizedYaml, "utf8") : buf;
      fs.writeFileSync(abs, payload);
    }
    return { success: true };
  } catch (e) {
    try {
      fs.rmSync(flowDir, { recursive: true, force: true });
    } catch (_) {
      /* ignore */
    }
    return { success: false, error: (e && e.message) || String(e) };
  }
}
