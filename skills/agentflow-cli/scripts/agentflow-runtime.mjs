import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PACKAGE_NAME = "@fieldwangai/agentflow";
const RUNTIME_ENTRY = path.join("bin", "lib", "skill-runtime.mjs");
const BUNDLED_RUNTIME_ENTRY = path.join("bin", "lib", "skill-runtime.mjs");
let explicitRoot = "";
let resolvedRoot = "";
let runtimePromise = null;

function packageLooksUsable(root) {
  if (!root) return false;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
    const supportedManifest = manifest?.name === PACKAGE_NAME || manifest?.agentflowSkillRuntime === 1;
    const entry = manifest?.agentflowSkillRuntime === 1 ? BUNDLED_RUNTIME_ENTRY : RUNTIME_ENTRY;
    return supportedManifest && fs.statSync(path.join(root, entry)).isFile();
  } catch {
    return false;
  }
}

function ancestors(start) {
  const out = [];
  let current = path.resolve(start);
  while (true) {
    out.push(current);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return out;
}

function rootsNear(start) {
  const out = [];
  for (const ancestor of ancestors(start)) {
    out.push(ancestor, path.join(ancestor, "node_modules", "@fieldwangai", "agentflow"));
  }
  return out;
}

function executableCandidates() {
  const names = process.platform === "win32" ? ["agentflow.cmd", "agentflow.exe", "agentflow"] : ["agentflow"];
  const dirs = String(process.env.PATH || "").split(path.delimiter).filter(Boolean);
  return dirs.flatMap((dir) => names.map((name) => path.join(dir, name)));
}

function rootsFromExecutable(candidate) {
  try {
    if (!fs.statSync(candidate).isFile() && !fs.lstatSync(candidate).isSymbolicLink()) return [];
    const real = fs.realpathSync(candidate);
    return rootsNear(path.dirname(real));
  } catch {
    return [];
  }
}

export function configureAgentFlowRuntime(options = {}) {
  const requested = String(options.packageRoot || "").trim();
  if (!requested || requested === explicitRoot) return;
  explicitRoot = path.resolve(requested);
  resolvedRoot = "";
  runtimePromise = null;
}

export function resolveAgentFlowPackageRoot() {
  if (resolvedRoot) return resolvedRoot;
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const bundledRoot = path.resolve(scriptDir, "..", "runtime");
  const candidates = [
    explicitRoot,
    String(process.env.AGENTFLOW_PACKAGE_ROOT || "").trim(),
    bundledRoot,
    ...rootsNear(process.cwd()),
    ...rootsNear(scriptDir),
    ...executableCandidates().flatMap(rootsFromExecutable),
  ].filter(Boolean);
  const seen = new Set();
  for (const candidate of candidates) {
    const root = path.resolve(candidate);
    if (seen.has(root)) continue;
    seen.add(root);
    if (packageLooksUsable(root)) {
      resolvedRoot = root;
      return root;
    }
  }
  throw new Error(
    "Cannot locate the AgentFlow Skill runtime. Reinstall/update agentflow-cli from SkillHub, "
    + "or set AGENTFLOW_PACKAGE_ROOT/--agentflow-package-root for an explicit development override.",
  );
}

export function loadAgentFlowRuntime() {
  if (!runtimePromise) {
    const root = resolveAgentFlowPackageRoot();
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf-8"));
    const entry = path.join(root, manifest?.agentflowSkillRuntime === 1 ? BUNDLED_RUNTIME_ENTRY : RUNTIME_ENTRY);
    runtimePromise = import(pathToFileURL(entry).href);
  }
  return runtimePromise;
}
