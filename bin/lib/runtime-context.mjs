import path from "path";
import { getFlowDir } from "./workspace.mjs";
import { PACKAGE_ROOT, PIPELINES_DIR } from "./paths.mjs";
import { listSkills, listSkillsFromSources, workspaceSkillSources } from "./skill-registry.mjs";

function parseJsonObject(raw) {
  if (raw == null) return null;
  if (typeof raw === "object" && !Array.isArray(raw)) return raw;
  const text = String(raw || "").trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function getPipelineFlowDir(workspaceRoot, flowName, flowJson = null) {
  if (flowJson?.flowDir && typeof flowJson.flowDir === "string" && flowJson.flowDir.trim()) {
    return path.isAbsolute(flowJson.flowDir) ? path.resolve(flowJson.flowDir) : path.resolve(workspaceRoot, flowJson.flowDir);
  }
  return getFlowDir(workspaceRoot, flowName) || path.join(path.resolve(workspaceRoot), PIPELINES_DIR, flowName);
}

export function buildDefaultWorkspaceContext(workspaceRoot, flowName, flowJson = null) {
  const pipelineWorkspace = path.resolve(workspaceRoot);
  const flowDir = getPipelineFlowDir(workspaceRoot, flowName, flowJson);
  return {
    version: 1,
    label: "pipeline",
    cwd: pipelineWorkspace,
    workspaceRoot: pipelineWorkspace,
    pipelineWorkspace,
    flowDir,
    previous: null,
  };
}

export function normalizeWorkspaceContext(raw, workspaceRoot, flowName, flowJson = null) {
  const base = buildDefaultWorkspaceContext(workspaceRoot, flowName, flowJson);
  const parsed = parseJsonObject(raw);
  if (!parsed) return base;
  const cwdRaw = parsed.cwd || parsed.workspaceRoot || parsed.path || "";
  const cwd = cwdRaw ? path.resolve(String(cwdRaw)) : base.cwd;
  return {
    ...base,
    ...parsed,
    version: 1,
    cwd,
    workspaceRoot: cwd,
    pipelineWorkspace: path.resolve(parsed.pipelineWorkspace || base.pipelineWorkspace),
    flowDir: path.resolve(parsed.flowDir || base.flowDir),
    previous: parsed.previous && typeof parsed.previous === "object" ? parsed.previous : null,
  };
}

export function normalizeSkillsContext(raw) {
  const parsed = parseJsonObject(raw);
  if (!parsed) return null;
  return {
    version: 1,
    ...parsed,
    skills: Array.isArray(parsed.skills) ? parsed.skills : [],
    skillKeys: Array.isArray(parsed.skillKeys) ? parsed.skillKeys : [],
    sources: Array.isArray(parsed.sources) ? parsed.sources : [],
    warnings: Array.isArray(parsed.warnings) ? parsed.warnings : [],
  };
}

export function expandRuntimePlaceholders(text, workspaceContext, extra = {}) {
  if (text == null) return "";
  const raw = String(text).trim();
  if (!raw) return "";
  const values = {
    workspaceRoot: workspaceContext.workspaceRoot || workspaceContext.cwd || "",
    cwd: workspaceContext.cwd || workspaceContext.workspaceRoot || "",
    pipelineWorkspace: workspaceContext.pipelineWorkspace || "",
    flowDir: workspaceContext.flowDir || "",
    ...extra,
  };
  return raw.replace(/\$\{([^}]+)\}/g, (_, key) => {
    const k = String(key || "").trim();
    return values[k] != null ? String(values[k]) : "";
  });
}

export function resolveWorkspaceTarget(rawTarget, workspaceContext, extra = {}) {
  const expanded = expandRuntimePlaceholders(rawTarget, workspaceContext, extra).trim();
  if (!expanded || expanded === "pipeline" || expanded === "pipeline-workspace") {
    return workspaceContext.pipelineWorkspace;
  }
  if (expanded === "current" || expanded === ".") return workspaceContext.cwd;
  if (expanded === "flowDir") return workspaceContext.flowDir;
  return path.isAbsolute(expanded) ? path.resolve(expanded) : path.resolve(workspaceContext.cwd, expanded);
}

export function scanSkillsFromPaths(paths, opts = {}) {
  const sources = (paths || []).map((entry, index) => ({
    source: entry.source || `runtime-${index}`,
    sourceLabel: entry.sourceLabel || entry.label || entry.dir,
    dir: path.resolve(entry.dir),
    installedBy: entry.installedBy || "runtime",
  }));
  return listSkillsFromSources(sources, { ...opts, warnMissing: true });
}

export function parseSkillKeyList(raw) {
  if (Array.isArray(raw)) return raw.map((x) => String(x || "").trim()).filter(Boolean);
  return String(raw || "")
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function skillBodyFromRegistryItem(skill) {
  return {
    name: skill.name,
    key: skill.key,
    description: skill.description,
    source: skill.source,
    sourceLabel: skill.sourceLabel,
    path: skill.path,
    body: skill.body,
  };
}

export function buildSkillsContextFromRegistry({ workspaceContext, skillKeys = [], mergeMode = "replace" }) {
  const wc = workspaceContext;
  const wanted = parseSkillKeyList(skillKeys);
  const registryWorkspaceRoot = wc.pipelineWorkspace || wc.workspaceRoot || wc.cwd || process.cwd();
  const registry = listSkills(PACKAGE_ROOT, registryWorkspaceRoot);
  const skillBodies = [];
  const warnings = [];
  const seenKeys = new Set();

  for (const raw of wanted) {
    const key = String(raw || "").trim();
    if (!key) continue;
    const match = registry.find((skill) => skill.key === key || skill.name === key || skill.id === key);
    if (!match) {
      warnings.push(`skill not found: ${key}`);
      continue;
    }
    const dedupeKey = match.key || match.path || match.name;
    if (seenKeys.has(dedupeKey)) continue;
    seenKeys.add(dedupeKey);
    skillBodies.push(skillBodyFromRegistryItem(match));
  }

  return {
    version: 1,
    workspaceRoot: wc.workspaceRoot,
    cwd: wc.cwd,
    pipelineWorkspace: wc.pipelineWorkspace,
    flowDir: wc.flowDir,
    source: "public-registry",
    mergeMode,
    requestedSkillKeys: wanted,
    skills: skillBodies.map(({ body, ...meta }) => meta),
    skillKeys: skillBodies.map((s) => s.key),
    sources: [...new Set(skillBodies.map((s) => s.sourceLabel || s.source || "").filter(Boolean))],
    loadedCount: skillBodies.length,
    warnings,
    skillBodies,
  };
}

export function buildSkillsContext({ workspaceContext, source = "current-workspace", paths = [], include = [], exclude = [], mergeMode = "replace" }) {
  const wc = workspaceContext;
  const sourcePaths = [];
  const addWorkspace = (root, label) => {
    sourcePaths.push(...workspaceSkillSources(root, label, label));
  };
  if (source === "pipeline-workspace") {
    addWorkspace(wc.pipelineWorkspace, "pipeline");
  } else if (source === "explicit-paths") {
    for (const p of paths) {
      const resolved = path.isAbsolute(p) ? path.resolve(p) : path.resolve(wc.cwd, p);
      sourcePaths.push({ dir: resolved, label: "explicit" });
    }
  } else if (source === "all") {
    addWorkspace(wc.cwd, "current");
    if (path.resolve(wc.cwd) !== path.resolve(wc.pipelineWorkspace)) addWorkspace(wc.pipelineWorkspace, "pipeline");
  } else {
    addWorkspace(wc.cwd, "current");
  }
  const scanned = scanSkillsFromPaths(sourcePaths, { include, exclude });
  return {
    version: 1,
    workspaceRoot: wc.workspaceRoot,
    cwd: wc.cwd,
    source,
    mergeMode,
    skills: scanned.skills.map(({ body, ...meta }) => meta),
    skillKeys: scanned.skills.map((s) => s.key),
    sources: sourcePaths.map((p) => p.dir),
    loadedCount: scanned.skills.length,
    warnings: scanned.warnings,
    skillBodies: scanned.skills.map((s) => ({
      name: s.name,
      key: s.key,
      description: s.description,
      sourceLabel: s.sourceLabel,
      path: s.path,
      body: s.body,
    })),
  };
}

export function renderSkillsContextForPrompt(skillsContext) {
  const ctx = normalizeSkillsContext(skillsContext);
  if (!ctx || !Array.isArray(ctx.skillBodies) || ctx.skillBodies.length === 0) return "";
  const blocks = ctx.skillBodies.slice(0, 20).map((skill) => {
    const body = String(skill.body || "").trim();
    return [
      `### ${skill.name}`,
      skill.description ? `说明：${skill.description}` : "",
      `来源：${skill.path || skill.sourceLabel || ""}`,
      "",
      body.slice(0, 16000),
    ].filter(Boolean).join("\n");
  });
  return ["## 已加载 Skills", "", ...blocks].join("\n\n");
}
