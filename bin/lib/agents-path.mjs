import fs from "fs";
import path from "path";
import { PACKAGE_AGENTS_DIR, getUserAgentsDirAbs } from "./paths.mjs";

/** 解析 agent 身份 prompt 路径：优先使用包内 agents/<subagent>.md，否则工作区 */
export function getAgentPath(workspaceRoot, subagent) {
  const packagePath = path.join(PACKAGE_AGENTS_DIR, `${subagent}.md`);
  if (fs.existsSync(packagePath)) return path.resolve(packagePath);
  return path.join(getUserAgentsDirAbs(), `${subagent}.md`);
}

/**
 * 读取 agent 文件内容并替换路径占位符为真实路径。
 * 返回替换后的整段文本；若文件不存在则返回空字符串。
 */
export function loadAgentPromptWithReplacements(workspaceRoot, subagent, replacements) {
  const agentPath = getAgentPath(workspaceRoot, subagent);
  if (!fs.existsSync(agentPath)) return "";
  let content = fs.readFileSync(agentPath, "utf8");
  for (const [key, value] of Object.entries(replacements)) {
    if (value != null && typeof value === "string") {
      const placeholder = "${" + key + "}";
      content = content.split(placeholder).join(value);
    }
  }
  return content;
}

/** 去掉 Markdown 顶部的 YAML frontmatter（--- ... ---），返回正文 */
export function stripYamlFrontmatter(content) {
  if (!content || typeof content !== "string") return "";
  const first = content.indexOf("---");
  if (first !== 0) return content.trim();
  const afterFirst = content.indexOf("---", 3);
  if (afterFirst === -1) return content.trim();
  return content.slice(afterFirst + 3).trim();
}

/** 从 agent .md 文件读取 frontmatter 的 name、description（简易解析） */
export function readAgentFrontmatter(filePath) {
  if (!fs.existsSync(filePath)) return { name: null, description: null };
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    const start = raw.indexOf("---");
    if (start === -1) return { name: null, description: null };
    const afterFirst = raw.indexOf("---", start + 3);
    if (afterFirst === -1) return { name: null, description: null };
    const block = raw.slice(start + 3, afterFirst).trim();
    let name = null;
    let description = null;
    for (const line of block.split("\n")) {
      const m = line.match(/^\s*name:\s*(.+)$/);
      if (m) name = m[1].trim().replace(/^["']|["']$/g, "");
      const d = line.match(/^\s*description:\s*(.+)$/);
      if (d) description = d[1].trim().replace(/^["']|["']$/g, "");
    }
    return { name, description };
  } catch (_) {
    return { name: null, description: null };
  }
}
