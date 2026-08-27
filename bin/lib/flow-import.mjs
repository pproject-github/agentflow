/**
 * 从上传的流程文件或 zip 解压结果导入流水线目录（user / workspace）。
 *
 * 「包的根在哪」这件事以前只认 `flow.yaml`——代码化的流程目录里没有它，于是从平台发布通道
 * 传上来只会得到「压缩包内未找到 flow.yaml」。判据改成和磁盘上完全一致的那一套
 * （`FLOW_MARKER_FILENAMES`：`workspace.flow.js` / `workspace.graph.json` / `flow.yaml`），
 * 两种格式都收。
 */
import fs from "fs";
import path from "path";
import yaml from "js-yaml";
import { unzipSync } from "fflate";
import { flowFilesToGraph } from "./flow-dsl/index.mjs";
import { marketplaceDependenciesFromSource } from "./flow-dsl/packages.mjs";
import { resolveFlowDirForWrite, validateUserPipelineId } from "./flow-write.mjs";
import { normalizeFlowYamlText } from "./flow-normalize.mjs";
import { FLOW_MARKER_FILENAMES } from "./paths.mjs";

/** `flow.yml` 是 `flow.yaml` 的历史别名，落盘时统一改名。 */
const YAML_ALIAS = "flow.yml";
const MARKERS = new Set([...FLOW_MARKER_FILENAMES, YAML_ALIAS].map((n) => n.toLowerCase()));

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

/**
 * 这个文件是不是流程目录的标记文件；是的话返回它所在的目录（根目录为 `""`）。
 *
 * 只认根目录或一层子目录——再深的层级不是「单个流程的包」。
 *
 * @returns {string | null} 不是标记文件时返回 null
 */
function flowMarkerParentDir(normPath) {
  const lower = normPath.toLowerCase();
  if (MARKERS.has(lower)) return "";
  const slash = lower.lastIndexOf("/");
  if (slash < 0 || !MARKERS.has(lower.slice(slash + 1))) return null;
  const parent = normPath.slice(0, slash);
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
 * 单文件上传（不是 zip）时，判断这一份是什么、能不能收。
 *
 * 代码化的流程只上传 `workspace.flow.js` 时，布局和节点元数据都缺席——那不影响读图，
 * 缺省会被补齐。但源码必须**当场解析得过**：写进去一个解析不出图的文件，用户下次打开画布
 * 才发现，而那时已经离现场很远。
 *
 * @param {string} content
 * @param {string} filename 上传时的文件名，用来决定按哪种格式解析
 * @param {{ resolvePackage?: Function }} [opts]
 * @returns {{ ok: true, entryName: string } | { ok: false, error: string }}
 */
export function validateImportedFlowSource(content, filename = "", opts = {}) {
  const name = String(filename || "").toLowerCase();
  if (!name.endsWith(".js") && !name.endsWith(".mjs")) {
    const checked = validateImportedFlowYaml(content);
    return checked.ok ? { ok: true, entryName: "flow.yaml" } : checked;
  }
  if (Buffer.byteLength(String(content || ""), "utf8") > IMPORT_MAX_UNCOMPRESSED_BYTES) {
    return { ok: false, error: "workspace.flow.js 过大" };
  }
  const dependencies = marketplaceDependenciesFromSource(content);
  if (dependencies.errors.length) {
    return { ok: false, error: dependencies.errors.join("；") };
  }
  if (typeof opts.resolvePackage === "function") {
    const missing = dependencies.dependencies.filter((dependency) => !opts.resolvePackage(dependency.specifier));
    if (missing.length) {
      return {
        ok: false,
        error: `服务端缺少节点包：${missing.map((dependency) => dependency.specifier).join(", ")}；请先上传这些精确版本`,
      };
    }
  }
  try {
    flowFilesToGraph({
      source: String(content || ""),
      layout: {},
      nodeMeta: {},
      files: {},
      resolvePackage: opts.resolvePackage,
    });
    return { ok: true, entryName: "workspace.flow.js" };
  } catch (e) {
    return { ok: false, error: `workspace.flow.js 解析失败：${(e && e.message) || e}` };
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
    const p = flowMarkerParentDir(k);
    if (p !== null) parents.add(p);
  }

  if (parents.size === 0) {
    return { ok: false, error: `压缩包内未找到流程文件（需要 ${FLOW_MARKER_FILENAMES.join(" / ")} 之一）` };
  }
  if (parents.size > 1) {
    return { ok: false, error: "压缩包内存在多个 pipeline，请分别打包" };
  }

  const [prefix] = [...parents];

  for (const k of raw.keys()) {
    const need = prefix === "" ? true : k === prefix || k.startsWith(`${prefix}/`);
    if (!need) {
      return {
        ok: false,
        error: "ZIP 目录结构无效：存在不属于该流水线目录的文件（请使用单文件夹，或把流程文件放在根目录）",
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
    (k) => k.toLowerCase() === "flow.yaml" || k.toLowerCase() === YAML_ALIAS,
  );
  if (yamlKeys.length > 1) {
    return { ok: false, error: "流水线目录内不能同时存在多个 flow.yaml / flow.yml" };
  }
  const yamlKey = yamlKeys[0];
  if (yamlKey && yamlKey !== "flow.yaml") {
    const body = out.get(yamlKey);
    out.delete(yamlKey);
    out.set("flow.yaml", body);
  }

  // 归一化会剥掉外层目录，标记文件可能因此换了位置——重新确认一次
  if (![...out.keys()].some((k) => MARKERS.has(k.toLowerCase()))) {
    return { ok: false, error: `归一化后缺少流程文件（需要 ${FLOW_MARKER_FILENAMES.join(" / ")} 之一）` };
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
      const p = flowMarkerParentDir(k);
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
export function writePipelineTree(workspaceRoot, flowId, flowSource, filesRelative, opts = {}) {
  const { flowDir, error } = resolveFlowDirForWrite(workspaceRoot, flowId, flowSource, opts);
  if (error) return { success: false, error };
  if (fs.existsSync(flowDir)) {
    return { success: false, error: "目标目录已存在" };
  }

  // 有 yaml 就照旧校验并规范化；代码化的包没有 yaml，认标记文件即可
  const yamlBuf = filesRelative.get("flow.yaml");
  let normalizedYaml = "";
  if (yamlBuf) {
    const text = yamlBuf.toString("utf8");
    const v = validateImportedFlowYaml(text);
    if (!v.ok) return { success: false, error: v.error };
    normalizedYaml = normalizeFlowYamlText(text).text;
  } else if (![...filesRelative.keys()].some((k) => MARKERS.has(k.toLowerCase()))) {
    return { success: false, error: `缺少流程文件（需要 ${FLOW_MARKER_FILENAMES.join(" / ")} 之一）` };
  }

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
      const payload = safe === "flow.yaml" && normalizedYaml ? Buffer.from(normalizedYaml, "utf8") : buf;
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
