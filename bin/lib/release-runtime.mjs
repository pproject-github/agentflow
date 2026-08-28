import fs from "node:fs";
import path from "node:path";
import yaml from "js-yaml";

const DEFAULT_BUSINESS_LINES = ["likee", "bigolive", "hello"];
const DEFAULT_BATCHES = ["initial", "supplemental"];

function normalizeList(value, fallback = []) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  if (value == null || value === "") return [...fallback];
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function titleFromAction(actionName) {
  return String(actionName || "")
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function categoryForSkill(skillName) {
  if (/setup|management|git/i.test(skillName)) return "发版准备";
  if (/metric|gray/i.test(skillName)) return "指标检查";
  if (/approval|records|channel|release-notes|google-play/i.test(skillName)) return "版本发布";
  if (/notification/i.test(skillName)) return "协作通知";
  if (/localization/i.test(skillName)) return "多语言";
  return "发版阶段";
}

function readFrontmatter(filePath) {
  const content = fs.readFileSync(filePath, "utf8");
  const match = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const parsed = yaml.load(match[1]);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function actionDefinition({ skillRoot, skillPath, skillName, skillMeta, action }) {
  const actionName = String(action?.name || "").trim();
  const skillDir = path.dirname(skillPath);
  const scriptCandidates = [
    path.join(skillDir, "scripts", "run.py"),
    path.join(skillDir, "scripts", `${skillName.replace(/^release-/, "")}.py`),
  ];
  const scriptPath = scriptCandidates.find((candidate) => fs.existsSync(candidate)) || scriptCandidates[0];
  const releaseContext = action?.release_context && typeof action.release_context === "object" ? action.release_context : {};
  const inputs = normalizeList(action?.inputs).map((key) => ({
    key,
    label: key.replace(/[_-]+/g, " "),
    type: "text",
    required: false,
  }));
  return {
    id: `${skillName}:${actionName}`,
    title: titleFromAction(actionName),
    description: String(skillMeta.description || "").trim(),
    skill: skillName,
    action: actionName,
    category: categoryForSkill(skillName),
    businessLines: [...DEFAULT_BUSINESS_LINES],
    platforms: normalizeList(action?.platforms, ["ios", "android"]).map((item) => item.toLowerCase()),
    allowedBatches: normalizeList(releaseContext.allowed_batches, DEFAULT_BATCHES),
    requiresConfirmation: action?.requires_confirmation === true,
    acceptsCurrentRelease: skillMeta.accepts_current_release !== false,
    inputSchema: inputs,
    nextNodeIds: [],
    runnable: fs.existsSync(scriptPath),
    error: fs.existsSync(scriptPath) ? "" : `缺少执行脚本：${path.relative(skillRoot, scriptPath)}`,
    source: {
      skillRoot,
      skillPath,
      scriptPath,
    },
  };
}

export function releaseActionId(skillName, actionName) {
  return `${String(skillName || "").trim()}:${String(actionName || "").trim()}`;
}

export function readReleaseAction(skillRoot, skillName, actionName) {
  const skillPath = path.join(path.resolve(skillRoot), String(skillName || "").trim(), "SKILL.md");
  if (!fs.existsSync(skillPath)) throw new Error(`Release Skill not found: ${skillName}`);
  const meta = readFrontmatter(skillPath);
  const action = normalizeList(meta.actions).find((item) => String(item || "") === String(actionName || ""));
  if (!action) {
    const actions = Array.isArray(meta.actions) ? meta.actions : [];
    const match = actions.find((item) => item && String(item.name || "") === String(actionName || ""));
    if (!match) throw new Error(`Release Action not found: ${skillName}:${actionName}`);
    return actionDefinition({ skillRoot: path.resolve(skillRoot), skillPath, skillName, skillMeta: meta, action: match });
  }
  return actionDefinition({ skillRoot: path.resolve(skillRoot), skillPath, skillName, skillMeta: meta, action });
}

export async function discoverReleaseActions({ roots = [], businessLine = "likee", platform = "android", batch = "initial" } = {}) {
  const line = String(businessLine || "likee").trim().toLowerCase();
  const targetPlatform = String(platform || "android").trim().toLowerCase();
  const targetBatch = String(batch || "initial").trim().toLowerCase();
  const nodes = [];
  for (const configuredRoot of roots) {
    const skillRoot = path.resolve(String(configuredRoot || ""));
    if (!fs.existsSync(skillRoot)) continue;
    let skillDirs = [];
    try {
      skillDirs = fs.readdirSync(skillRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      continue;
    }
    for (const entry of skillDirs) {
      const skillName = entry.name;
      const skillPath = path.join(skillRoot, skillName, "SKILL.md");
      if (!fs.existsSync(skillPath)) continue;
      let meta;
      try { meta = readFrontmatter(skillPath); } catch { continue; }
      const actions = Array.isArray(meta.actions) ? meta.actions : [];
      for (const action of actions) {
        if (!action || typeof action !== "object" || !String(action.name || "").trim()) continue;
        const node = actionDefinition({ skillRoot, skillPath, skillName, skillMeta: meta, action });
        if (!node.businessLines.includes(line) || !node.platforms.includes(targetPlatform) || !node.allowedBatches.includes(targetBatch)) continue;
        nodes.push(node);
      }
    }
  }
  const unique = new Map();
  for (const node of nodes) if (!unique.has(node.id)) unique.set(node.id, node);
  return Array.from(unique.values()).sort((a, b) => a.id.localeCompare(b.id));
}
