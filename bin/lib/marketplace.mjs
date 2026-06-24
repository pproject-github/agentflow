import fs from "fs";
import path from "path";
import yaml from "js-yaml";

import {
  ARCHIVED_PIPELINES_DIR_NAME,
  LEGACY_PIPELINES_DIR,
  MARKETPLACE_PACKAGES_DIR,
  PIPELINES_DIR,
  getUserPipelinesRoot,
} from "./paths.mjs";

const NODE_MANIFEST = "node.yaml";
const COLLECTION_MANIFEST = "collection.yaml";
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
    if (!slot || typeof slot !== "object") return { type: "text", name: "", default: "" };
    const type = slot.type != null ? String(slot.type).trim() : "text";
    const name = slot.name != null ? String(slot.name).trim() : "";
    const def = slot.default !== undefined ? slot.default : slot.value;
    return {
      type,
      name,
      default: def == null ? "" : String(def),
    };
  });
}

function normalizeManifest(raw, packageDir, source = "workspace") {
  if (!raw || typeof raw !== "object") return null;
  const id = raw.id != null ? String(raw.id).trim() : path.basename(packageDir);
  const version = raw.version != null ? String(raw.version).trim() : "";
  if (!id || !version) return null;
  const runtime = raw.runtime && typeof raw.runtime === "object" ? raw.runtime : {};
  return {
    ...raw,
    id,
    version,
    packageDir,
    definitionId: `marketplace:${id}@${version}`,
    displayName: raw.displayName != null ? String(raw.displayName) : raw.name != null ? String(raw.name) : id,
    description: raw.description != null ? String(raw.description) : "",
    input: normalizeSlotList(raw.input || raw.inputs),
    output: normalizeSlotList(raw.output || raw.outputs),
    runtime,
    source,
  };
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
    if (!fs.existsSync(path.join(dir, "flow.yaml"))) continue;
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
  const parsed = parseMarketplaceDefinitionId(inst?.definitionId);
  return Boolean(parsed && parsed.id === id && (!parsed.version || parsed.version === version));
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
    if (fs.existsSync(path.join(direct, NODE_MANIFEST))) return direct;
  } else {
    for (const v of sortVersionsDesc(listVersionDirs(nodeBase))) {
      const direct = path.join(nodeBase, v);
      if (fs.existsSync(path.join(direct, NODE_MANIFEST))) return direct;
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
        if (fs.existsSync(path.join(direct, NODE_MANIFEST))) {
          out.push(direct);
          continue;
        }
        for (const nodeVersion of sortVersionsDesc(listVersionDirs(direct))) {
          const versioned = path.join(direct, nodeVersion);
          if (fs.existsSync(path.join(versioned, NODE_MANIFEST))) out.push(versioned);
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

export function resolveMarketplaceNodePackage(workspaceRoot, flowDir, definitionId, flowData = null) {
  const parsed = parseMarketplaceDefinitionId(definitionId);
  if (!parsed) return null;
  const id = parsed.id;
  const requestedVersion = parsed.version || dependencyVersion(flowData, id) || lockVersion(flowDir, id);
  let packageDir = findNodePackageDir(workspaceRoot, id, requestedVersion);

  if (!packageDir) {
    for (const dir of iterCollectionNodeDirs(workspaceRoot, collectionDeps(flowData))) {
      const raw = readYamlObject(path.join(dir, NODE_MANIFEST));
      const manifest = normalizeManifest(raw, dir, "collection");
      if (!manifest || manifest.id !== id) continue;
      if (requestedVersion && manifest.version !== requestedVersion) continue;
      packageDir = dir;
      break;
    }
  }

  if (!packageDir) return null;
  const manifest = normalizeManifest(readYamlObject(path.join(packageDir, NODE_MANIFEST)), packageDir);
  if (!manifest) return null;
  return {
    ...manifest,
    requestedDefinitionId: definitionId,
    resolvedDefinitionId: `marketplace:${manifest.id}@${manifest.version}`,
  };
}

export function listMarketplaceNodes(workspaceRoot, flowData = null) {
  const root = workspacePackageRoot(workspaceRoot);
  const out = [];
  const seen = new Set();
  const addManifest = (dir, source = "marketplace") => {
    const manifest = normalizeManifest(readYamlObject(path.join(dir, NODE_MANIFEST)), dir, source);
    if (!manifest) return;
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
  const nodes = listMarketplaceNodes(workspaceRoot).map((n) => ({
    id: n.id,
    version: n.version,
    definitionId: n.definitionId,
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

export function deleteMarketplaceNodePackage(workspaceRoot, id, version, opts = {}) {
  const packageDir = resolveWorkspaceNodePackageDir(workspaceRoot, id, version);
  if (!packageDir) return { ok: false, error: "Invalid marketplace node id or version" };
  if (!fs.existsSync(path.join(packageDir, NODE_MANIFEST))) {
    return { ok: false, error: `Marketplace node package not found: ${id}@${version}` };
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

export function writeFlowMarketplaceLock(workspaceRoot, flowDir, flowData) {
  if (!flowData || !flowData.instances || typeof flowData.instances !== "object") return null;
  const nodes = {};
  for (const inst of Object.values(flowData.instances)) {
    const defId = inst && inst.definitionId;
    const resolved = resolveMarketplaceNodePackage(workspaceRoot, flowDir, defId, flowData);
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
  const manifestPath = path.join(src, NODE_MANIFEST);
  const manifest = normalizeManifest(readYamlObject(manifestPath), src);
  if (!manifest) return { ok: false, error: `Invalid node package manifest: ${manifestPath}` };
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

export function publishNodeFromInstance(workspaceRoot, payload = {}, options = {}) {
  const label = String(payload.label || payload.instanceId || "node").trim();
  const id = safePackageId(payload.id || payload.packageId || label);
  const version = normalizeVersion(payload.version || "1.0.0");
  if (!id) return { ok: false, error: "Invalid package id" };

  const inputs = normalizeSlotList(payload.inputs || payload.input).map((slot) => ({
    type: slot.type,
    name: slot.name,
    default: slot.default,
  }));
  const outputs = normalizeSlotList(payload.outputs || payload.output).map((slot) => ({
    type: slot.type,
    name: slot.name,
    default: slot.default,
  }));
  const script = String(payload.script || "").trim();
  const body = String(payload.body || "").trim();
  const description = String(payload.description || body || `Published from node ${label}`).trim();
  const dest = path.join(workspacePackageRoot(workspaceRoot), "nodes", id, version);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  const packagedScript = script
    ? buildPackagedRuntimeFromScript(script, dest, {
        flowDir: options.flowDir || payload.flowDir,
        workspaceRoot,
      })
    : null;
  const runtime = packagedScript?.runtime || (
    script
      ? {
          type: "tool_nodejs",
          language: "nodejs",
          command: script,
        }
      : {
          type: "agent_subAgent",
        }
  );
  const manifest = {
    id,
    version,
    name: label,
    description,
    runtime,
    inputs,
    outputs,
  };
  if (packagedScript?.packagedFiles?.length) manifest.packagedFiles = packagedScript.packagedFiles;
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
    packagedFiles: packagedScript?.packagedFiles || [],
  };
}

export function installFlowDependency(workspaceRoot, flowDir, spec) {
  const parsed = parseMarketplaceDefinitionId(spec.startsWith("marketplace:") ? spec : `marketplace:${spec}`);
  if (!parsed) return { ok: false, error: `Invalid marketplace node spec: ${spec}` };
  const resolved = resolveMarketplaceNodePackage(workspaceRoot, flowDir, `marketplace:${parsed.id}${parsed.version ? `@${parsed.version}` : ""}`, { dependencies: {} });
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
  writeFlowMarketplaceLock(workspaceRoot, flowDir, data);
  return { ok: true, id: resolved.id, version: resolved.version, definitionId: `marketplace:${resolved.id}@${resolved.version}` };
}
