/**
 * Portable node-package archives.
 *
 * On disk a node package is a directory. ZIP is only the transport form. The
 * archive always has `index.mjs` at its root and may contain relative scripts,
 * templates, and assets. We validate paths and size limits before either
 * packing or installing so an uploaded package cannot escape its destination.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { unzipSync, zipSync } from "fflate";
import yaml from "js-yaml";

import {
  NODE_PACKAGE_ENTRY,
  nodePackageExportsRun,
  readNodePackageManifest,
} from "./node-package-manifest.mjs";

export const NODE_PACKAGE_MAX_UNCOMPRESSED_BYTES = 8 * 1024 * 1024;
export const NODE_PACKAGE_MAX_FILE_ENTRIES = 500;
export const NODE_PACKAGE_MAX_ARCHIVE_BYTES = 10 * 1024 * 1024;
export const NODE_PACKAGE_METADATA_FILENAME = ".agentflow-package.json";

const FORBIDDEN_SEGMENTS = new Set([
  ".git",
  ".ssh",
  "__MACOSX",
  "node_modules",
]);
const FORBIDDEN_FILES = new Set([
  ".env",
  ".env.local",
  ".npmrc",
  ".DS_Store",
  NODE_PACKAGE_METADATA_FILENAME,
  "id_rsa",
  "id_ed25519",
]);

export function sanitizeNodePackageEntryPath(raw) {
  if (typeof raw !== "string") return null;
  // ZIP 规范只使用 `/`。不能把绝对路径或反斜杠悄悄“修正”为相对路径，否则两个不同的
  // archive entry 可能在安装时落到同一个文件，路径穿越也会从拒绝变成接受。
  const value = raw.replace(/^\uFEFF/, "");
  if (!value || value.includes("\0") || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) return null;
  const parts = value.split("/").filter(Boolean);
  if (!parts.length || parts.some((part) => part === "." || part === "..")) return null;
  if (parts.some((part) => FORBIDDEN_SEGMENTS.has(part))) return null;
  const base = parts.at(-1);
  if (FORBIDDEN_FILES.has(base) || /^\.env\./.test(base) || /\.(?:pem|key|p12|pfx)$/i.test(base)) return null;
  if (parts.some((part) => part.startsWith("._"))) return null;
  return parts.join("/");
}

function stableContentHash(files) {
  const hash = crypto.createHash("sha256");
  for (const [rel, content] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    hash.update(rel);
    hash.update("\0");
    hash.update(content);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function validateFilesMap(files, opts = {}) {
  if (!(files instanceof Map) || files.size === 0) {
    return { ok: false, error: "节点包内没有文件" };
  }
  if (files.size > NODE_PACKAGE_MAX_FILE_ENTRIES) {
    return { ok: false, error: `节点包文件数量超过限制（最多 ${NODE_PACKAGE_MAX_FILE_ENTRIES} 个）` };
  }
  let totalBytes = 0;
  for (const [rel, content] of files) {
    const safe = sanitizeNodePackageEntryPath(rel);
    if (!safe || safe !== rel) return { ok: false, error: `节点包包含非法或敏感路径：${rel}` };
    totalBytes += content.length;
    if (totalBytes > NODE_PACKAGE_MAX_UNCOMPRESSED_BYTES) {
      return { ok: false, error: "节点包解压后总大小超过限制（8MB）" };
    }
  }
  if (!files.has(NODE_PACKAGE_ENTRY) && !(opts.allowLegacyManifest && files.has("node.yaml"))) {
    return { ok: false, error: `节点包根目录缺少 ${NODE_PACKAGE_ENTRY}（旧包可使用 node.yaml）` };
  }
  return { ok: true, totalBytes };
}

function collectDirectoryFiles(packageDir) {
  const root = path.resolve(packageDir);
  const files = new Map();
  const walk = (dir) => {
    const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === NODE_PACKAGE_METADATA_FILENAME) continue;
      const abs = path.join(dir, entry.name);
      const stat = fs.lstatSync(abs);
      if (stat.isSymbolicLink()) throw new Error(`节点包不允许符号链接：${path.relative(root, abs)}`);
      const rel = path.relative(root, abs).replace(/\\/g, "/");
      const safe = sanitizeNodePackageEntryPath(rel);
      if (!safe || safe !== rel) throw new Error(`节点包包含非法或敏感路径：${rel}`);
      if (stat.isDirectory()) {
        walk(abs);
      } else if (stat.isFile()) {
        files.set(rel, fs.readFileSync(abs));
      }
    }
  };
  walk(root);
  return files;
}

function manifestFromTemporaryFiles(files, opts = {}) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-node-package-"));
  try {
    for (const [rel, content] of files) {
      const abs = path.join(tempRoot, ...rel.split("/"));
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content);
    }
    const manifest = readNodePackageManifest(tempRoot, (yamlPath) => {
      if (!opts.allowLegacyManifest || !fs.existsSync(yamlPath)) return null;
      const parsed = yaml.load(fs.readFileSync(yamlPath, "utf-8"));
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
    });
    if (!manifest) return { ok: false, error: `${NODE_PACKAGE_ENTRY} 缺少有效的 export default 声明，node.yaml 也无有效清单` };
    if (files.has(NODE_PACKAGE_ENTRY) && !nodePackageExportsRun(path.join(tempRoot, NODE_PACKAGE_ENTRY))) {
      return { ok: false, error: `${NODE_PACKAGE_ENTRY} 缺少 export function run` };
    }
    return { ok: true, manifest };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function inspectNodePackageDirectory(packageDir, opts = {}) {
  try {
    const root = path.resolve(packageDir);
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      return { ok: false, error: `节点包目录不存在：${root}` };
    }
    const files = collectDirectoryFiles(root);
    const checked = validateFilesMap(files, opts);
    if (!checked.ok) return checked;
    const parsed = manifestFromTemporaryFiles(files, opts);
    if (!parsed.ok) return parsed;
    return {
      ok: true,
      packageDir: root,
      manifest: parsed.manifest,
      files,
      fileList: [...files.keys()].sort(),
      fileCount: files.size,
      totalBytes: checked.totalBytes,
      contentSha256: stableContentHash(files),
    };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

export function createNodePackageArchive(packageDir) {
  const inspected = inspectNodePackageDirectory(packageDir);
  if (!inspected.ok) return inspected;
  const entries = Object.fromEntries([...inspected.files].map(([rel, content]) => [rel, new Uint8Array(content)]));
  const archive = Buffer.from(zipSync(entries, { level: 6 }));
  if (archive.length > NODE_PACKAGE_MAX_ARCHIVE_BYTES) {
    return { ok: false, error: "节点包 ZIP 超过限制（10MB）" };
  }
  return {
    ...inspected,
    archive,
    archiveSha256: crypto.createHash("sha256").update(archive).digest("hex"),
  };
}

function stripOptionalRoot(files) {
  const roots = new Set([...files.keys()].map((rel) => rel.split("/")[0]));
  if (roots.size !== 1 || files.has(NODE_PACKAGE_ENTRY)) return files;
  const [root] = [...roots];
  const prefix = `${root}/`;
  if (!files.has(`${prefix}${NODE_PACKAGE_ENTRY}`)) return files;
  return new Map([...files].map(([rel, content]) => [rel.slice(prefix.length), content]));
}

export function inspectNodePackageArchive(input) {
  try {
    const archive = Buffer.from(input || []);
    if (!archive.length) return { ok: false, error: "节点包 ZIP 为空" };
    if (archive.length > NODE_PACKAGE_MAX_ARCHIVE_BYTES) return { ok: false, error: "节点包 ZIP 超过限制（10MB）" };
    const raw = unzipSync(new Uint8Array(archive));
    let files = new Map();
    for (const [rawRel, value] of Object.entries(raw)) {
      if (rawRel.endsWith("/")) continue;
      const rel = sanitizeNodePackageEntryPath(rawRel);
      if (!rel) return { ok: false, error: `节点包包含非法或敏感路径：${rawRel}` };
      if (files.has(rel)) return { ok: false, error: `节点包包含重复路径：${rawRel}` };
      files.set(rel, Buffer.from(value));
    }
    files = stripOptionalRoot(files);
    const checked = validateFilesMap(files);
    if (!checked.ok) return checked;
    const parsed = manifestFromTemporaryFiles(files);
    if (!parsed.ok) return parsed;
    return {
      ok: true,
      manifest: parsed.manifest,
      files,
      fileList: [...files.keys()].sort(),
      fileCount: files.size,
      totalBytes: checked.totalBytes,
      contentSha256: stableContentHash(files),
      archiveSha256: crypto.createHash("sha256").update(archive).digest("hex"),
      archive,
    };
  } catch (error) {
    return { ok: false, error: `节点包 ZIP 解析失败：${error?.message || String(error)}` };
  }
}

export function writeNodePackageFiles(targetDir, files) {
  const target = path.resolve(targetDir);
  const checked = validateFilesMap(files);
  if (!checked.ok) return checked;
  fs.mkdirSync(target, { recursive: true });
  for (const [rel, content] of files) {
    const abs = path.resolve(target, ...rel.split("/"));
    if (abs !== target && !abs.startsWith(`${target}${path.sep}`)) {
      return { ok: false, error: `节点包路径越界：${rel}` };
    }
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return { ok: true, totalBytes: checked.totalBytes };
}
