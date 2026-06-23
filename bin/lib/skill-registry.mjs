import fs from "fs";
import os from "os";
import path from "path";
import yaml from "js-yaml";

const fileCache = new Map();
const CACHE_TTL_MS = 60_000;

function readFileCached(absPath) {
  const now = Date.now();
  const cached = fileCache.get(absPath);
  if (cached && now - cached.ts < CACHE_TTL_MS) return cached.content;
  try {
    const content = fs.readFileSync(absPath, "utf-8");
    fileCache.set(absPath, { content, ts: now });
    return content;
  } catch {
    return null;
  }
}

export function stripSkillFrontmatter(content) {
  const raw = String(content || "");
  const match = raw.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/);
  return match ? raw.slice(match[0].length).trim() : raw.trim();
}

function parseSkillFrontmatter(content) {
  const match = String(content || "").match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  try {
    return yaml.load(match[1]) || {};
  } catch {
    return {};
  }
}

export function parseSkillFile(absPath, source = {}) {
  const content = readFileCached(absPath);
  if (!content) return null;
  const meta = parseSkillFrontmatter(content);
  const name = String(meta.name || path.basename(path.dirname(absPath))).trim();
  if (!name) return null;
  const body = stripSkillFrontmatter(content);
  const sourceId = String(source.source || source.id || "unknown").trim() || "unknown";
  const sourceLabel = String(source.sourceLabel || source.label || sourceId).trim() || sourceId;
  return {
    key: `${sourceId}:${name}`,
    id: name,
    name,
    description: String(meta.description || "").trim(),
    source: sourceId,
    sourceLabel,
    path: absPath,
    body,
    content,
    installedBy: source.installedBy || "",
  };
}

export function listSkillFiles(dir) {
  try {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(dir, entry.name, "SKILL.md"))
      .filter((skillPath) => fs.existsSync(skillPath));
  } catch {
    return [];
  }
}

export function workspaceSkillSources(root, prefix, labelPrefix) {
  if (!root) return [];
  const abs = path.resolve(root);
  return [
    { source: `${prefix}-agents`, sourceLabel: `${labelPrefix}/.agents`, dir: path.join(abs, ".agents", "skills"), installedBy: "filesystem" },
    { source: `${prefix}-cursor`, sourceLabel: `${labelPrefix}/.cursor`, dir: path.join(abs, ".cursor", "skills"), installedBy: "filesystem" },
    { source: `${prefix}-codex`, sourceLabel: `${labelPrefix}/.codex`, dir: path.join(abs, ".codex", "skills"), installedBy: "filesystem" },
  ];
}

export function defaultSkillSources(packageRoot, workspaceRoot) {
  const sources = [
    {
      source: "builtin",
      sourceLabel: "AgentFlow",
      dir: path.join(path.resolve(packageRoot), "skills"),
      installedBy: "agentflow",
    },
  ];
  if (workspaceRoot) sources.push(...workspaceSkillSources(workspaceRoot, "workspace", "工作区"));
  const home = os.homedir();
  sources.push(
    { source: "global-agents", sourceLabel: "全局 .agents", dir: path.join(home, ".agents", "skills"), installedBy: "global" },
    { source: "global-cursor", sourceLabel: "全局 .cursor", dir: path.join(home, ".cursor", "skills"), installedBy: "global" },
    { source: "global-codex", sourceLabel: "全局 .codex", dir: path.join(home, ".codex", "skills"), installedBy: "skillhub" },
  );
  return sources;
}

export function listSkillsFromSources(sources, opts = {}) {
  const include = new Set((opts.include || []).map((x) => String(x).trim()).filter(Boolean));
  const exclude = new Set((opts.exclude || []).map((x) => String(x).trim()).filter(Boolean));
  const skills = [];
  const warnings = [];
  const seenKeys = new Set();
  const seenPaths = new Set();
  for (const source of sources || []) {
    const dir = path.resolve(source.dir || "");
    if (!fs.existsSync(dir)) {
      if (opts.warnMissing) warnings.push(`skills path not found: ${dir}`);
      continue;
    }
    for (const skillPath of listSkillFiles(dir)) {
      const skill = parseSkillFile(skillPath, source);
      if (!skill) continue;
      if (include.size > 0 && !include.has(skill.name) && !include.has(skill.key)) continue;
      if (exclude.has(skill.name) || exclude.has(skill.key)) continue;
      if (seenPaths.has(skill.path)) continue;
      if (seenKeys.has(skill.key)) continue;
      seenPaths.add(skill.path);
      seenKeys.add(skill.key);
      skills.push(skill);
    }
  }
  skills.sort((a, b) => {
    const bySource = a.sourceLabel.localeCompare(b.sourceLabel);
    if (bySource !== 0) return bySource;
    return a.name.localeCompare(b.name);
  });
  return { skills, warnings };
}

export function listSkills(packageRoot, workspaceRoot, opts = {}) {
  return listSkillsFromSources(defaultSkillSources(packageRoot, workspaceRoot), opts).skills;
}

export function readSkillDetail(packageRoot, workspaceRoot, keyOrName) {
  const wanted = String(keyOrName || "").trim();
  if (!wanted) return null;
  const item = listSkills(packageRoot, workspaceRoot).find((skill) => skill.key === wanted || skill.name === wanted);
  if (!item) return null;
  return item;
}
