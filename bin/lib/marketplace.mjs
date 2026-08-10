import fs from "fs";
import path from "path";
import yaml from "js-yaml";

import {
  ARCHIVED_PIPELINES_DIR_NAME,
  LEGACY_PIPELINES_DIR,
  MARKETPLACE_PACKAGES_DIR,
  PIPELINES_DIR,
  getUserPipelinesRoot,
  isFlowDir,
} from "./paths.mjs";
import { NODE_PACKAGE_ENTRY, isNodePackageDir, readNodePackageManifest } from "./node-package-manifest.mjs";

const NODE_MANIFEST = "node.yaml";
const COLLECTION_MANIFEST = "collection.yaml";
const FLOW_SNIPPET_MANIFEST = "flow-snippet.yaml";
const LOCK_FILENAME = "agentflow.lock.json";

function workspacePackageRoot(workspaceRoot) {
  return path.join(path.resolve(workspaceRoot), MARKETPLACE_PACKAGES_DIR);
}

export function workspaceMarketplaceRoot(workspaceRoot) {
  return workspacePackageRoot(workspaceRoot);
}

export function parseMarketplaceDefinitionId(definitionId) {
  const raw = String(definitionId || "").trim();
  if (!raw.startsWith("marketplace:")) return null;
  const spec = raw.slice("marketplace:".length).trim();
  if (!spec) return null;
  const at = spec.lastIndexOf("@");
  if (at > 0) {
    return { id: spec.slice(0, at), version: spec.slice(at + 1) || null };
  }
  return { id: spec, version: null };
}

export function isMarketplaceDefinitionId(definitionId) {
  return Boolean(parseMarketplaceDefinitionId(definitionId));
}

function readYamlObject(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = yaml.load(fs.readFileSync(filePath, "utf-8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function readJsonObject(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function normalizeSlotList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((slot) => {
    if (!slot || typeof slot !== "object") return { type: "text", name: "", default: "", showOnNode: false };
    const type = slot.type != null ? String(slot.type).trim() : "text";
    const name = slot.name != null ? String(slot.name).trim() : "";
    const def = slot.default !== undefined ? slot.default : slot.value;
    const normalized = {
      type,
      name,
      default: def == null ? "" : String(def),
    };
    if (slot.required != null) normalized.required = Boolean(slot.required);
    if (slot.description != null) normalized.description = String(slot.description);
    normalized.showOnNode = slot.showOnNode != null
      ? Boolean(slot.showOnNode)
      : Boolean(normalized.required) || type.toLowerCase() === "node";
    return normalized;
  });
}

/**
 * 读取节点包清单：`index.mjs` 的静态声明优先，回退 `node.yaml`。
 * 声明写得不合法时不静默吞掉——按目录名报错，否则节点会莫名从面板消失。
 */
function readNodeManifestRaw(dir) {
  try {
    return readNodePackageManifest(dir, readYamlObject);
  } catch (e) {
    console.warn(`[agentflow] 节点包 ${path.basename(dir)} 清单无效：${(e && e.message) || e}`);
    return null;
  }
}

function normalizeManifest(raw, packageDir, source = "workspace") {
  if (!raw || typeof raw !== "object") return null;
  const id = raw.id != null ? String(raw.id).trim() : path.basename(packageDir);
  const version = raw.version != null ? String(raw.version).trim() : "";
  if (!id || !version) return null;
  const runtime = raw.runtime && typeof raw.runtime === "object" ? raw.runtime : {};
  const baseDefinitionId =
    raw.baseDefinitionId != null && String(raw.baseDefinitionId).trim() !== ""
      ? String(raw.baseDefinitionId).trim()
      : raw.sourceDefinitionId != null && String(raw.sourceDefinitionId).trim() !== ""
        ? String(raw.sourceDefinitionId).trim()
        : runtime.type != null && String(runtime.type).trim() !== ""
          ? String(runtime.type).trim()
          : "";
  return {
    ...raw,
    id,
    version,
    packageDir,
    definitionId: `marketplace:${id}@${version}`,
    baseDefinitionId,
    displayName: raw.displayName != null ? String(raw.displayName) : raw.name != null ? String(raw.name) : id,
    description: raw.description != null ? String(raw.description) : "",
    input: normalizeSlotList(raw.input || raw.inputs),
    output: normalizeSlotList(raw.output || raw.outputs),
    runtime,
    source,
  };
}

function manifestOwnerUserId(manifest) {
  return String(manifest?.ownerUserId || manifest?.createdBy || "").trim();
}

function isAdminRequest(opts = {}) {
  return Boolean(opts?.isAdmin);
}

function shouldFilterMarketplaceOwner(opts = {}) {
  return opts?.marketplaceScope === "owned";
}

function canAccessMarketplaceOwner(ownerUserId, opts = {}) {
  if (!shouldFilterMarketplaceOwner(opts)) return true;
  const requestedUserId = String(opts.userId || "").trim();
  if (!requestedUserId) return true;
  if (isAdminRequest(opts)) return true;
  return Boolean(ownerUserId) && ownerUserId === requestedUserId;
}

function canManageMarketplaceOwner(ownerUserId, opts = {}) {
  const requestedUserId = String(opts.userId || "").trim();
  if (!requestedUserId) return false;
  if (isAdminRequest(opts)) return true;
  return Boolean(ownerUserId) && ownerUserId === requestedUserId;
}

function canAccessMarketplaceNode(manifest, opts = {}) {
  if ((manifest?.source || "marketplace") !== "marketplace") return true;
  return canAccessMarketplaceOwner(manifestOwnerUserId(manifest), opts);
}

function sortVersionsDesc(versions) {
  return [...versions].sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: "base" }));
}

function listVersionDirs(baseDir) {
  if (!fs.existsSync(baseDir)) return [];
  return fs.readdirSync(baseDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter(Boolean);
}

function isSafePathSegment(value) {
  const text = String(value || "").trim();
  return Boolean(text) && !text.includes("\0") && !path.isAbsolute(text) && !text.split(/[\\/]+/).includes("..");
}

function resolveWorkspaceNodePackageDir(workspaceRoot, id, version) {
  if (!isSafePathSegment(id) || !isSafePathSegment(version)) return null;
  const base = path.resolve(workspacePackageRoot(workspaceRoot), "nodes");
  const target = path.resolve(base, id, version);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

function resolveWorkspaceFlowSnippetPackageDir(workspaceRoot, id, version) {
  if (!isSafePathSegment(id) || !isSafePathSegment(version)) return null;
  const base = path.resolve(workspacePackageRoot(workspaceRoot), "flow-snippets");
  const target = path.resolve(base, id, version);
  if (target !== base && !target.startsWith(base + path.sep)) return null;
  return target;
}

function collectFlowDirs(rootDir, source, archived = false) {
  const out = [];
  if (!fs.existsSync(rootDir)) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(rootDir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === ARCHIVED_PIPELINES_DIR_NAME) continue;
    const dir = path.join(rootDir, entry.name);
    if (!isFlowDir(dir)) continue;
    out.push({ flowId: entry.name, flowSource: source, archived, flowDir: dir });
  }
  return out;
}

function listWritableFlowDirs(workspaceRoot, opts = {}) {
  const root = path.resolve(workspaceRoot);
  const userRoot = getUserPipelinesRoot(opts.userId);
  const wsRoot = path.join(root, PIPELINES_DIR);
  const legacyRoot = path.join(root, LEGACY_PIPELINES_DIR);
  return [
    ...collectFlowDirs(userRoot, "user", false),
    ...collectFlowDirs(path.join(userRoot, ARCHIVED_PIPELINES_DIR_NAME), "user", true),
    ...collectFlowDirs(wsRoot, "workspace", false),
    ...collectFlowDirs(path.join(wsRoot, ARCHIVED_PIPELINES_DIR_NAME), "workspace", true),
    ...collectFlowDirs(legacyRoot, "workspace", false),
    ...collectFlowDirs(path.join(legacyRoot, ARCHIVED_PIPELINES_DIR_NAME), "workspace", true),
  ];
}

function depMatchesNode(dep, id, version) {
  if (typeof dep === "string") {
    const parsed = parseMarketplaceDefinitionId(dep.startsWith("marketplace:") ? dep : `marketplace:${dep}`);
    return Boolean(parsed && parsed.id === id && (!parsed.version || parsed.version === version));
  }
  if (!dep || typeof dep !== "object") return false;
  return dep.id === id && (dep.version == null || String(dep.version) === version);
}

function instanceMatchesNode(inst, id, version) {
  const parsed =
    parseMarketplaceDefinitionId(inst?.definitionId) ||
    parseMarketplaceDefinitionId(inst?.marketplaceRef);
  if (parsed) return Boolean(parsed.id === id && (!parsed.version || parsed.version === version));
  return inst?.marketplacePackageId === id && (inst?.marketplaceVersion == null || String(inst.marketplaceVersion) === version);
}

export function listMarketplaceNodeUsages(workspaceRoot, id, version, opts = {}) {
  const usages = [];
  if (!id || !version) return usages;
  for (const flow of listWritableFlowDirs(workspaceRoot, opts)) {
    const flowYamlPath = path.join(flow.flowDir, "flow.yaml");
    const data = readYamlObject(flowYamlPath);
    if (!data) continue;
    const hits = [];
    const deps = data.dependencies && typeof data.dependencies === "object" ? data.dependencies : {};
    const nodeDeps = Array.isArray(deps.nodes) ? deps.nodes : [];
    for (const dep of nodeDeps) {
      if (depMatchesNode(dep, id, version)) {
        hits.push({ instanceId: "dependencies.nodes", label: "dependency" });
      }
    }
    const instances = data.instances && typeof data.instances === "object" ? data.instances : {};
    for (const [instanceId, inst] of Object.entries(instances)) {
      if (instanceMatchesNode(inst, id, version)) {
        hits.push({ instanceId, label: inst?.label || instanceId });
      }
    }
    if (hits.length > 0) {
      usages.push({
        flowId: flow.flowId,
        flowSource: flow.flowSource,
        archived: flow.archived,
        instances: hits,
      });
    }
  }
  return usages;
}

function findNodePackageDir(workspaceRoot, id, version) {
  const root = workspacePackageRoot(workspaceRoot);
  const nodeBase = path.join(root, "nodes", id);
  if (version) {
    const direct = path.join(nodeBase, version);
    if (isNodePackageDir(direct)) return direct;
  } else {
    for (const v of sortVersionsDesc(listVersionDirs(nodeBase))) {
      const direct = path.join(nodeBase, v);
      if (isNodePackageDir(direct)) return direct;
    }
  }
  return null;
}

function iterCollectionNodeDirs(workspaceRoot, collectionDeps = []) {
  const root = workspacePackageRoot(workspaceRoot);
  const out = [];
  const deps = Array.isArray(collectionDeps) ? collectionDeps : [];
  for (const dep of deps) {
    const collectionId = typeof dep === "string" ? dep : dep && dep.id;
    const collectionVersion = typeof dep === "object" && dep ? dep.version : null;
    if (!collectionId) continue;
    const collectionBase = path.join(root, "collections", String(collectionId));
    const versions = collectionVersion ? [String(collectionVersion)] : sortVersionsDesc(listVersionDirs(collectionBase));
    for (const version of versions) {
      const nodesRoot = path.join(collectionBase, version, "nodes");
      if (!fs.existsSync(nodesRoot)) continue;
      for (const entry of fs.readdirSync(nodesRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const direct = path.join(nodesRoot, entry.name);
        if (isNodePackageDir(direct)) {
          out.push(direct);
          continue;
        }
        for (const nodeVersion of sortVersionsDesc(listVersionDirs(direct))) {
          const versioned = path.join(direct, nodeVersion);
          if (isNodePackageDir(versioned)) out.push(versioned);
        }
      }
    }
  }
  return out;
}

function dependencyVersion(flowData, id) {
  const deps = flowData && typeof flowData === "object" ? flowData.dependencies : null;
  const nodeDeps = deps && Array.isArray(deps.nodes) ? deps.nodes : [];
  for (const dep of nodeDeps) {
    if (typeof dep === "string") {
      const parsed = parseMarketplaceDefinitionId(dep.startsWith("marketplace:") ? dep : `marketplace:${dep}`);
      if (parsed && parsed.id === id) return parsed.version;
    } else if (dep && typeof dep === "object" && dep.id === id) {
      return dep.version != null ? String(dep.version) : null;
    }
  }
  return null;
}

function lockVersion(flowDir, id) {
  const lock = readJsonObject(path.join(flowDir, LOCK_FILENAME));
  const entry = lock && lock.nodes && lock.nodes[id];
  if (typeof entry === "string") return entry;
  if (entry && typeof entry === "object" && entry.version) return String(entry.version);
  return null;
}

function collectionDeps(flowData) {
  const deps = flowData && typeof flowData === "object" ? flowData.dependencies : null;
  return deps && Array.isArray(deps.collections) ? deps.collections : [];
}

/**
 * flow 自带的代码节点包：`<flowDir>/nodes/<dirName>/`，不带版本子目录。
 *
 * 这类包跟着 flow 走——AI 生成流程时可以顺手把节点实现写在流程目录里，不必先发布到
 * marketplace。id 以包声明为准（目录名只是回退），所以目录名和 id 可以不一致。
 */
function findFlowLocalNodePackageDir(flowDir, id, requestedVersion) {
  const nodesRoot = flowDir ? path.join(path.resolve(flowDir), "nodes") : "";
  if (!nodesRoot || !fs.existsSync(nodesRoot) || !fs.statSync(nodesRoot).isDirectory()) return null;
  for (const entry of fs.readdirSync(nodesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(nodesRoot, entry.name);
    if (!isNodePackageDir(dir)) continue;
    const manifest = normalizeManifest(readNodeManifestRaw(dir), dir, "flow");
    if (!manifest || manifest.id !== id) continue;
    if (requestedVersion && manifest.version !== requestedVersion) continue;
    return dir;
  }
  return null;
}

/**
 * 列出一个 `nodes/` 目录下的所有代码节点包（子目录形式，不带版本层）。
 * 供节点目录把 flow 自带的节点一起摆进面板。
 */
export function listNodePackagesInDir(nodesRoot) {
  const out = [];
  const root = String(nodesRoot || "");
  if (!root || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) return out;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    if (!isNodePackageDir(dir)) continue;
    const manifest = normalizeManifest(readNodeManifestRaw(dir), dir, "flow");
    if (manifest) out.push(manifest);
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

export function resolveMarketplaceNodePackage(workspaceRoot, flowDir, definitionId, flowData = null, opts = {}) {
  const parsed = parseMarketplaceDefinitionId(definitionId);
  if (!parsed) return null;
  const id = parsed.id;
  const requestedVersion = parsed.version || dependencyVersion(flowData, id) || lockVersion(flowDir, id);
  // flow 自带的包优先：流程目录里的实现就是这个流程要用的那份，不该被同名的已发布包顶掉
  let packageDir = findFlowLocalNodePackageDir(flowDir, id, requestedVersion);
  let packageSource = packageDir ? "flow" : "marketplace";
  if (!packageDir) packageDir = findNodePackageDir(workspaceRoot, id, requestedVersion);

  if (!packageDir) {
    for (const dir of iterCollectionNodeDirs(workspaceRoot, collectionDeps(flowData))) {
      const manifest = normalizeManifest(readNodeManifestRaw(dir), dir, "collection");
      if (!manifest || manifest.id !== id) continue;
      if (requestedVersion && manifest.version !== requestedVersion) continue;
      packageDir = dir;
      packageSource = "collection";
      break;
    }
  }

  if (!packageDir) return null;
  const manifest = normalizeManifest(readNodeManifestRaw(packageDir), packageDir, packageSource);
  if (!manifest) return null;
  if (!canAccessMarketplaceNode(manifest, opts)) return null;
  return {
    ...manifest,
    requestedDefinitionId: definitionId,
    resolvedDefinitionId: `marketplace:${manifest.id}@${manifest.version}`,
  };
}

export function listMarketplaceNodes(workspaceRoot, flowData = null, opts = {}) {
  const root = workspacePackageRoot(workspaceRoot);
  const out = [];
  const seen = new Set();
  const addManifest = (dir, source = "marketplace") => {
    const manifest = normalizeManifest(readNodeManifestRaw(dir), dir, source);
    if (!manifest) return;
    if (!canAccessMarketplaceNode(manifest, opts)) return;
    const key = `${manifest.id}@${manifest.version}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(manifest);
  };

  const nodesRoot = path.join(root, "nodes");
  if (fs.existsSync(nodesRoot)) {
    for (const nodeEntry of fs.readdirSync(nodesRoot, { withFileTypes: true })) {
      if (!nodeEntry.isDirectory()) continue;
      const nodeBase = path.join(nodesRoot, nodeEntry.name);
      for (const version of listVersionDirs(nodeBase)) {
        addManifest(path.join(nodeBase, version), "marketplace");
      }
    }
  }

  for (const dir of iterCollectionNodeDirs(workspaceRoot, collectionDeps(flowData))) {
    addManifest(dir, "collection");
  }
  return out.sort((a, b) => a.id.localeCompare(b.id) || a.version.localeCompare(b.version));
}

export function listMarketplacePackages(workspaceRoot, opts = {}) {
  const root = workspacePackageRoot(workspaceRoot);
  const nodes = listMarketplaceNodes(workspaceRoot, null, opts).map((n) => ({
    id: n.id,
    version: n.version,
    definitionId: n.definitionId,
    baseDefinitionId: n.baseDefinitionId,
    displayName: n.displayName,
    description: n.description,
    inputs: n.input,
    outputs: n.output,
    packagedFiles: Array.isArray(n.packagedFiles) ? n.packagedFiles : [],
    packageDir: n.packageDir,
    usage: listMarketplaceNodeUsages(workspaceRoot, n.id, n.version, opts),
  }));
  const collections = [];
  const collectionsRoot = path.join(root, "collections");
  if (fs.existsSync(collectionsRoot)) {
    for (const entry of fs.readdirSync(collectionsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const base = path.join(collectionsRoot, entry.name);
      for (const version of listVersionDirs(base)) {
        const dir = path.join(base, version);
        const manifest = readYamlObject(path.join(dir, COLLECTION_MANIFEST)) || {};
        collections.push({
          id: manifest.id || entry.name,
          version: manifest.version || version,
          displayName: manifest.displayName || manifest.name || entry.name,
          description: manifest.description || "",
          packageDir: dir,
        });
      }
    }
  }
  return { nodes, collections };
}

export function listMarketplaceFlowSnippets(workspaceRoot, opts = {}) {
  const root = workspacePackageRoot(workspaceRoot);
  const snippetsRoot = path.join(root, "flow-snippets");
  const snippets = [];
  const requestedUserId = String(opts.userId || "").trim();
  if (!fs.existsSync(snippetsRoot)) return { snippets };
  for (const entry of fs.readdirSync(snippetsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const base = path.join(snippetsRoot, entry.name);
    for (const version of listVersionDirs(base)) {
      const dir = path.join(base, version);
      const manifest = readYamlObject(path.join(dir, FLOW_SNIPPET_MANIFEST));
      if (!manifest) continue;
      const snippet = manifest.snippet && typeof manifest.snippet === "object" ? manifest.snippet : {};
      const ownerUserId = String(manifest.ownerUserId || manifest.createdBy || "").trim();
      if (requestedUserId && !canAccessMarketplaceOwner(ownerUserId, opts)) continue;
      snippets.push({
        id: manifest.id || entry.name,
        version: manifest.version || version,
        displayName: manifest.displayName || manifest.name || entry.name,
        description: manifest.description || "",
        tags: Array.isArray(manifest.tags) ? manifest.tags.map((x) => String(x)) : [],
        nodeCount: Number(manifest.nodeCount) || Object.keys(snippet.instances || {}).length || 0,
        edgeCount: Number(manifest.edgeCount) || (Array.isArray(snippet.edges) ? snippet.edges.length : 0),
        createdAt: manifest.createdAt || "",
        updatedAt: manifest.updatedAt || "",
        ownerUserId,
        packageDir: dir,
        snippet,
      });
    }
  }
  snippets.sort((a, b) => {
    const byTime = String(b.updatedAt || b.createdAt || "").localeCompare(String(a.updatedAt || a.createdAt || ""));
    return byTime || a.id.localeCompare(b.id) || a.version.localeCompare(b.version);
  });
  return { snippets };
}

export function deleteMarketplaceNodePackage(workspaceRoot, id, version, opts = {}) {
  const packageDir = resolveWorkspaceNodePackageDir(workspaceRoot, id, version);
  if (!packageDir) return { ok: false, error: "Invalid marketplace node id or version" };
  const manifestPath = path.join(packageDir, NODE_MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, error: `Marketplace node package not found: ${id}@${version}` };
  }
  const manifest = normalizeManifest(readYamlObject(manifestPath), packageDir, "marketplace");
  if (!manifest || !canManageMarketplaceOwner(manifestOwnerUserId(manifest), opts)) {
    return { ok: false, error: "Marketplace node permission denied" };
  }
  const usage = listMarketplaceNodeUsages(workspaceRoot, id, version, opts);
  if (usage.length > 0) {
    return { ok: false, error: "Marketplace node is still used by flows", usage };
  }
  fs.rmSync(packageDir, { recursive: true, force: true });
  const versionRoot = path.dirname(packageDir);
  try {
    if (fs.existsSync(versionRoot) && fs.readdirSync(versionRoot).length === 0) {
      fs.rmdirSync(versionRoot);
    }
  } catch {
    /* keep non-empty or unreadable parent */
  }
  return { ok: true, id, version, packageDir };
}

export function deleteMarketplaceFlowSnippetPackage(workspaceRoot, id, version, opts = {}) {
  const packageDir = resolveWorkspaceFlowSnippetPackageDir(workspaceRoot, id, version);
  if (!packageDir) return { ok: false, error: "Invalid flow snippet id or version" };
  const manifestPath = path.join(packageDir, FLOW_SNIPPET_MANIFEST);
  if (!fs.existsSync(manifestPath)) {
    return { ok: false, error: `Flow snippet package not found: ${id}@${version}` };
  }
  const manifest = readYamlObject(manifestPath) || {};
  const ownerUserId = String(manifest.ownerUserId || manifest.createdBy || "").trim();
  if (!canManageMarketplaceOwner(ownerUserId, opts)) {
    return { ok: false, error: "Flow snippet permission denied" };
  }
  fs.rmSync(packageDir, { recursive: true, force: true });
  const versionRoot = path.dirname(packageDir);
  try {
    if (fs.existsSync(versionRoot) && fs.readdirSync(versionRoot).length === 0) {
      fs.rmdirSync(versionRoot);
    }
  } catch {
    /* keep non-empty or unreadable parent */
  }
  return { ok: true, id, version, packageDir };
}

export function writeFlowMarketplaceLock(workspaceRoot, flowDir, flowData, opts = {}) {
  if (!flowData || !flowData.instances || typeof flowData.instances !== "object") return null;
  const nodes = {};
  for (const inst of Object.values(flowData.instances)) {
    const defId = inst && (inst.marketplaceRef || inst.definitionId);
    const resolved = resolveMarketplaceNodePackage(workspaceRoot, flowDir, defId, flowData, opts);
    if (!resolved) continue;
    nodes[resolved.id] = {
      version: resolved.version,
      resolved: path.relative(flowDir, resolved.packageDir).replace(/\\/g, "/"),
      definitionId: resolved.resolvedDefinitionId,
    };
  }
  const lockPath = path.join(flowDir, LOCK_FILENAME);
  if (Object.keys(nodes).length === 0) return null;
  const lock = readJsonObject(lockPath) || {};
  const next = {
    ...lock,
    version: 1,
    updatedAt: new Date().toISOString(),
    nodes: { ...(lock.nodes && typeof lock.nodes === "object" ? lock.nodes : {}), ...nodes },
  };
  fs.writeFileSync(lockPath, JSON.stringify(next, null, 2) + "\n", "utf-8");
  return next;
}

export function publishNodePackage(workspaceRoot, sourceDir) {
  const src = path.resolve(sourceDir);
  // 走和读取同一条路径：`index.mjs` 的静态声明优先，回落 `node.yaml`。只认后者的话，
  // 一个目录扫描、面板、运行时都跑得通的 index.mjs 包偏偏发布不出去。
  const manifest = normalizeManifest(readNodeManifestRaw(src), src);
  if (!manifest) {
    return { ok: false, error: `Invalid node package manifest: ${src} 里既没有可解析的 ${NODE_PACKAGE_ENTRY}，也没有 ${NODE_MANIFEST}` };
  }
  const dest = path.join(workspacePackageRoot(workspaceRoot), "nodes", manifest.id, manifest.version);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.cpSync(src, dest, { recursive: true });
  return { ok: true, id: manifest.id, version: manifest.version, packageDir: dest, definitionId: manifest.definitionId };
}

function safePackageId(raw) {
  return String(raw || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeVersion(raw) {
  const text = String(raw || "").trim();
  return /^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9_.-]+)?$/.test(text) ? text : "1.0.0";
}

function tokenizeShellLike(command) {
  const tokens = [];
  let cur = "";
  let quote = "";
  let escaped = false;
  for (const ch of String(command || "")) {
    if (escaped) {
      cur += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\" && quote !== "'") {
      cur += ch;
      escaped = true;
      continue;
    }
    if ((ch === "'" || ch === '"') && !quote) {
      quote = ch;
      cur += ch;
      continue;
    }
    if (quote && ch === quote) {
      quote = "";
      cur += ch;
      continue;
    }
    if (!quote && /\s/.test(ch)) {
      if (cur) {
        tokens.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) tokens.push(cur);
  return tokens;
}

function stripShellQuotes(text) {
  const s = String(text || "");
  if (s.length >= 2 && ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"')))) {
    return s.slice(1, -1);
  }
  return s;
}

function replaceKnownPathVars(text, vars) {
  let out = String(text || "");
  for (const [key, value] of Object.entries(vars || {})) {
    if (!value) continue;
    out = out.replaceAll(`\${${key}}`, String(value));
  }
  return out;
}

function isInsideDir(filePath, dir) {
  if (!filePath || !dir) return false;
  const file = path.resolve(filePath);
  const base = path.resolve(dir);
  const baseWithSep = base.endsWith(path.sep) ? base : base + path.sep;
  return file === base || file.startsWith(baseWithSep);
}

function uniqueRelativeScriptPath(destDir, baseName) {
  const safeBase = path.basename(baseName || "script.mjs").replace(/[^a-zA-Z0-9_.-]+/g, "-") || "script.mjs";
  let rel = path.join("scripts", safeBase).replace(/\\/g, "/");
  let i = 2;
  while (fs.existsSync(path.join(destDir, rel))) {
    const ext = path.extname(safeBase);
    const stem = ext ? safeBase.slice(0, -ext.length) : safeBase;
    rel = path.join("scripts", `${stem}-${i}${ext}`).replace(/\\/g, "/");
    i += 1;
  }
  return rel;
}

function scriptLanguageFor(interpreter, scriptPath) {
  const cmd = path.basename(stripShellQuotes(interpreter || "")).toLowerCase();
  const ext = path.extname(stripShellQuotes(scriptPath || "")).toLowerCase();
  if (cmd.startsWith("node") || [".mjs", ".cjs", ".js"].includes(ext)) return "nodejs";
  if (cmd.startsWith("python") || ext === ".py") return "python";
  if (cmd === "bash" || cmd === "sh" || ext === ".sh") return "bash";
  return cmd || "script";
}

function interpreterForLanguage(language) {
  if (language === "nodejs") return "node";
  if (language === "python") return "python3";
  if (language === "bash") return "bash";
  return "";
}

function createScriptPackagePlan(command, opts = {}) {
  const tokens = tokenizeShellLike(command);
  if (tokens.length < 2) return null;
  const interpreter = stripShellQuotes(tokens[0]);
  const scriptToken = tokens[1];
  const scriptRaw = stripShellQuotes(scriptToken);
  if (!/\.(mjs|cjs|js|py|sh)$/i.test(scriptRaw)) return null;

  const vars = {
    flowDir: opts.flowDir || "",
    workspaceRoot: opts.workspaceRoot || "",
  };
  const resolvedScript = path.resolve(replaceKnownPathVars(scriptRaw, vars));
  if (!fs.existsSync(resolvedScript) || !fs.statSync(resolvedScript).isFile()) return null;
  if (
    (opts.flowDir && isInsideDir(resolvedScript, opts.flowDir)) ||
    (opts.workspaceRoot && isInsideDir(resolvedScript, opts.workspaceRoot))
  ) {
    return {
      sourcePath: resolvedScript,
      sourceToken: scriptToken,
      language: scriptLanguageFor(interpreter, scriptRaw),
      args: tokens.slice(2),
    };
  }
  return null;
}

function buildPackagedRuntimeFromScript(command, destDir, opts = {}) {
  const plan = createScriptPackagePlan(command, opts);
  if (!plan) return null;
  const entry = uniqueRelativeScriptPath(destDir, path.basename(plan.sourcePath));
  const entryAbs = path.join(destDir, entry);
  fs.mkdirSync(path.dirname(entryAbs), { recursive: true });
  fs.copyFileSync(plan.sourcePath, entryAbs);
  return {
    runtime: {
      type: "tool_nodejs",
      language: plan.language,
      entry,
      args: plan.args,
    },
    packagedFiles: [{ from: plan.sourcePath, to: entry }],
  };
}

function safePackageRefPath(raw) {
  const text = String(raw || "").trim().replace(/^["']|["']$/g, "").replace(/\\/g, "/");
  if (!text || path.isAbsolute(text) || text.includes("\n") || text.includes("\r")) return "";
  const normalized = path.posix.normalize(text).replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) return "";
  return normalized;
}

function packageNodeReferenceFiles(destDir, opts = {}) {
  const flowDir = opts.flowDir ? path.resolve(opts.flowDir) : "";
  const packagedFiles = [];
  const result = {};
  const copyRef = (rawRef, targetRel, key) => {
    const clean = safePackageRefPath(rawRef);
    if (!clean || !flowDir) return "";
    const source = path.resolve(flowDir, ...clean.split("/"));
    if (!isInsideDir(source, flowDir) || !fs.existsSync(source) || !fs.statSync(source).isFile()) return "";
    const rel = targetRel.replace(/\\/g, "/");
    const abs = path.join(destDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.copyFileSync(source, abs);
    packagedFiles.push({ from: source, to: rel, role: key });
    result[key] = rel;
    return rel;
  };
  const scriptRef = copyRef(opts.scriptRef, `scripts/${path.basename(safePackageRefPath(opts.scriptRef) || "script.mjs")}`, "scriptRef");
  const implementationRef = copyRef(opts.implementationRef, "implementation.md", "implementationRef");
  let scriptRuntime = null;
  if (scriptRef) {
    const abs = path.join(destDir, scriptRef);
    scriptRuntime = {
      type: "tool_nodejs",
      language: scriptLanguageFor("", scriptRef),
      entry: scriptRef,
      args: [],
    };
    if (!fs.existsSync(abs)) scriptRuntime = null;
  }
  return { ...result, packagedFiles, scriptRuntime };
}

export function publishNodeFromInstance(workspaceRoot, payload = {}, options = {}) {
  const label = String(payload.label || payload.instanceId || "node").trim();
  const id = safePackageId(payload.id || payload.packageId || label);
  const version = normalizeVersion(payload.version || "1.0.0");
  const sourceDefinitionId = String(payload.definitionId || "").trim();
  if (!id) return { ok: false, error: "Invalid package id" };
  const ownerUserId = String(options.userId || "").trim();
  if (!ownerUserId) return { ok: false, error: "Authentication required" };

  const inputs = normalizeSlotList(payload.inputs || payload.input).map((slot) => ({
    type: slot.type,
    name: slot.name,
    default: slot.default,
    ...(slot.required != null ? { required: Boolean(slot.required) } : {}),
    ...(slot.showOnNode != null ? { showOnNode: Boolean(slot.showOnNode) } : {}),
  }));
  const outputs = normalizeSlotList(payload.outputs || payload.output).map((slot) => ({
    type: slot.type,
    name: slot.name,
    default: slot.default,
    ...(slot.required != null ? { required: Boolean(slot.required) } : {}),
    ...(slot.showOnNode != null ? { showOnNode: Boolean(slot.showOnNode) } : {}),
  }));
  const script = String(payload.script || "").trim();
  const scriptRef = String(payload.scriptRef || "").trim();
  const implementationRef = String(payload.implementationRef || "").trim();
  const implementationMode = String(payload.implementationMode || "").trim();
  const body = String(payload.body || "").trim();
  const description = String(payload.description || body || `Published from node ${label}`).trim();
  const dest = path.join(workspacePackageRoot(workspaceRoot), "nodes", id, version);
  const existingManifest = readYamlObject(path.join(dest, NODE_MANIFEST));
  if (existingManifest) {
    const existingOwner = manifestOwnerUserId(existingManifest);
    if (!canManageMarketplaceOwner(existingOwner, options)) return { ok: false, error: "Marketplace node permission denied" };
  }
  const now = new Date().toISOString();
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const packagedRefs = packageNodeReferenceFiles(dest, {
    flowDir: options.flowDir || payload.flowDir,
    scriptRef,
    implementationRef,
  });
  const packagedScript = script
    ? buildPackagedRuntimeFromScript(script, dest, {
        flowDir: options.flowDir || payload.flowDir,
        workspaceRoot,
      })
    : null;
  const runtime = packagedScript?.runtime || packagedRefs.scriptRuntime || (
    script
      ? {
          type: "tool_nodejs",
          language: "nodejs",
          command: script,
        }
      : {
          type: sourceDefinitionId || "agent_subAgent",
        }
  );
  const manifest = {
    id,
    version,
    name: label,
    description,
    baseDefinitionId: sourceDefinitionId || runtime.type || "agent_subAgent",
    runtime,
    inputs,
    outputs,
    ownerUserId,
    createdBy: ownerUserId,
    createdAt: existingManifest?.createdAt || now,
    updatedAt: now,
  };
  if (packagedRefs.implementationRef) manifest.implementationRef = packagedRefs.implementationRef;
  if (implementationMode) manifest.implementationMode = implementationMode;
  const packagedFiles = [...(packagedScript?.packagedFiles || []), ...(packagedRefs.packagedFiles || [])];
  if (packagedFiles.length) manifest.packagedFiles = packagedFiles;
  fs.writeFileSync(path.join(dest, NODE_MANIFEST), yaml.dump(manifest, { lineWidth: -1 }), "utf-8");
  fs.writeFileSync(
    path.join(dest, "README.md"),
    `# ${label}\n\n${description || "Published from AgentFlow node properties."}\n`,
    "utf-8",
  );
  if (body) fs.writeFileSync(path.join(dest, "prompt.md"), body + "\n", "utf-8");
  return {
    ok: true,
    id,
    version,
    packageDir: dest,
    definitionId: `marketplace:${id}@${version}`,
    baseDefinitionId: manifest.baseDefinitionId,
    marketplaceDefinitionId: `marketplace:${id}@${version}`,
    packagedFiles,
  };
}

export function publishFlowSnippet(workspaceRoot, payload = {}, opts = {}) {
  const label = String(payload.displayName || payload.name || payload.id || "flow snippet").trim();
  const id = safePackageId(payload.id || payload.packageId || label);
  const version = normalizeVersion(payload.version || "1.0.0");
  if (!id) return { ok: false, error: "Invalid snippet id" };
  const ownerUserId = String(opts.userId || "").trim();
  if (!ownerUserId) return { ok: false, error: "Authentication required" };

  const rawSnippet = payload.snippet && typeof payload.snippet === "object" ? payload.snippet : {};
  const instances = rawSnippet.instances && typeof rawSnippet.instances === "object" ? rawSnippet.instances : {};
  const edges = Array.isArray(rawSnippet.edges) ? rawSnippet.edges : [];
  const ui = rawSnippet.ui && typeof rawSnippet.ui === "object" ? rawSnippet.ui : {};
  const nodeCount = Object.keys(instances).length;
  if (nodeCount < 2) return { ok: false, error: "A flow snippet needs at least two nodes" };

  const now = new Date().toISOString();
  const dest = resolveWorkspaceFlowSnippetPackageDir(workspaceRoot, id, version);
  if (!dest) return { ok: false, error: "Invalid snippet id or version" };
  const existingManifest = readYamlObject(path.join(dest, FLOW_SNIPPET_MANIFEST));
  if (existingManifest) {
    const existingOwner = String(existingManifest.ownerUserId || existingManifest.createdBy || "").trim();
    if (!canManageMarketplaceOwner(existingOwner, opts)) return { ok: false, error: "Flow snippet permission denied" };
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  const manifest = {
    id,
    version,
    name: label,
    displayName: label,
    description: String(payload.description || "").trim(),
    tags: Array.isArray(payload.tags) ? payload.tags.map((x) => String(x).trim()).filter(Boolean) : [],
    ownerUserId,
    createdBy: ownerUserId,
    nodeCount,
    edgeCount: edges.length,
    createdAt: now,
    updatedAt: now,
    snippet: {
      instances,
      edges: edges.map((edge) => ({
        source: String(edge.source || ""),
        target: String(edge.target || ""),
        sourceHandle: edge.sourceHandle ?? null,
        targetHandle: edge.targetHandle ?? null,
      })).filter((edge) => edge.source && edge.target),
      ui,
    },
  };
  fs.writeFileSync(path.join(dest, FLOW_SNIPPET_MANIFEST), yaml.dump(manifest, { lineWidth: -1 }), "utf-8");
  fs.writeFileSync(
    path.join(dest, "README.md"),
    `# ${label}\n\n${manifest.description || "Published from an AgentFlow canvas selection."}\n`,
    "utf-8",
  );
  return { ok: true, id, version, packageDir: dest, snippet: manifest.snippet };
}

export function installFlowDependency(workspaceRoot, flowDir, spec, opts = {}) {
  const parsed = parseMarketplaceDefinitionId(spec.startsWith("marketplace:") ? spec : `marketplace:${spec}`);
  if (!parsed) return { ok: false, error: `Invalid marketplace node spec: ${spec}` };
  const resolved = resolveMarketplaceNodePackage(workspaceRoot, flowDir, `marketplace:${parsed.id}${parsed.version ? `@${parsed.version}` : ""}`, { dependencies: {} }, opts);
  if (!resolved) return { ok: false, error: `Marketplace node not found: ${spec}` };

  const flowYamlPath = path.join(flowDir, "flow.yaml");
  const data = readYamlObject(flowYamlPath);
  if (!data) return { ok: false, error: `Invalid flow.yaml: ${flowYamlPath}` };
  const deps = data.dependencies && typeof data.dependencies === "object" ? data.dependencies : {};
  const nodes = Array.isArray(deps.nodes) ? deps.nodes : [];
  const exists = nodes.some((item) => (typeof item === "string" ? item === resolved.id : item && item.id === resolved.id));
  if (!exists) nodes.push({ id: resolved.id, version: resolved.version });
  data.dependencies = { ...deps, nodes };
  fs.writeFileSync(flowYamlPath, yaml.dump(data, { lineWidth: -1 }), "utf-8");
  writeFlowMarketplaceLock(workspaceRoot, flowDir, data, opts);
  return { ok: true, id: resolved.id, version: resolved.version, definitionId: `marketplace:${resolved.id}@${resolved.version}` };
}
