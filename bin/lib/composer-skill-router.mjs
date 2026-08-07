/**
 * Composer Skill Router：按用户在 Workspace Composer 中显式勾选的 skill key
 * 加载 SKILL.md 及其引用的 reference 文档，并渲染成可注入 prompt 的文本块。
 *
 * 旧的「按 prompt 猜意图自动注入」随 Start/End Pipeline Composer 一并下线。
 */
import path from "path";
import {
  listSkills as registryListSkills,
  listUniqueSkills as registryListUniqueSkills,
  readSkillDetail as registryReadSkillDetail,
} from "./skill-registry.mjs";

export function listComposerSkills(packageRoot, workspaceRoot) {
  return registryListUniqueSkills(packageRoot, workspaceRoot).map(({ body, content, ...skill }) => skill);
}

export function readComposerSkillDetail(packageRoot, workspaceRoot, keyOrName) {
  return registryReadSkillDetail(packageRoot, workspaceRoot, keyOrName);
}

function skillNameFromKey(keyOrName) {
  const value = String(keyOrName || "").trim();
  if (!value) return "";
  const idx = value.indexOf(":");
  return idx >= 0 ? value.slice(idx + 1).trim() : value;
}

export function loadResourcesForSkillKeys(skillKeys, packageRoot, workspaceRoot) {
  if (!Array.isArray(skillKeys) || skillKeys.length === 0) {
    return { skills: [], references: [], skillsHint: "", hasContext: false };
  }
  const wanted = new Set(skillKeys.map((x) => String(x || "").trim()).filter(Boolean));
  if (wanted.size === 0) return { skills: [], references: [], skillsHint: "", hasContext: false };
  const wantedNames = new Set(Array.from(wanted).map(skillNameFromKey).filter(Boolean));

  const exactByKey = new Map(registryListSkills(packageRoot, workspaceRoot).map((item) => [item.key, item]));
  const candidateItems = [];
  const seenKeys = new Set();
  for (const item of registryListUniqueSkills(packageRoot, workspaceRoot)) {
    if (!wanted.has(item.key) && !wanted.has(item.name) && !wantedNames.has(item.name)) continue;
    candidateItems.push(item);
    seenKeys.add(item.key);
  }
  for (const key of wanted) {
    const exact = exactByKey.get(key);
    if (exact && !seenKeys.has(exact.key)) {
      candidateItems.push(exact);
      seenKeys.add(exact.key);
    }
  }

  const skills = [];
  for (const item of candidateItems) {
    skills.push({
      id: item.name,
      content: item.body,
      absPath: item.path,
      source: item.source,
      sourceLabel: item.sourceLabel,
    });
  }

  return {
    skills,
    references: [],
    skillsHint: buildSelectedSkillsHint(skills),
    hasContext: skills.length > 0,
  };
}

// ─── 构建注入到 prompt 的文本块 ───────────────────────────────────────────

// 已知 reference / skill 的一行摘要（compact 模式注入）
const RESOURCE_SUMMARIES = {
  "agentflow-flow-add-instances": "新增 instance 与边的规则、handle 速查、布局原则、节点类型选择",
  "agentflow-flow-edit-node-fields": "编辑已有 instance 字段白名单、tool_nodejs script 规则",
  "flow-control-capabilities.md": "控制节点语义、handle 索引、循环模式（check→fix→re-check）",
  "flow-layout.md": "ui.nodePositions 布局原则（主链 x+=280、分支 y±200）",
  "flow-prompt-handler-check.md": "USER_PROMPT 中读写描述与节点 input/output edge 一致性",
};

/**
 * Compact 注入：仅给绝对路径 + 一行摘要，agent 按需 Read。
 * 比 buildSkillInjectionBlock 省 ~20-30KB/step。
 * @param {Array<{id: string, content: string, absPath: string}>} skills
 * @param {Array<{name: string, content: string, absPath: string}>} references
 * @returns {string}
 */
export function buildSkillCompactInjectionBlock(skills, references) {
  const parts = [];
  if (skills.length === 0 && references.length === 0) return "";

  parts.push("### 编辑技能与参考文档（按需 Read 绝对路径）");
  parts.push("");
  for (const s of skills) {
    const summary = RESOURCE_SUMMARIES[s.id] || "";
    parts.push(`- **skill** \`${s.id}\` — ${summary}`);
    parts.push(`  路径：${s.absPath}`);
  }
  for (const r of references) {
    const summary = RESOURCE_SUMMARIES[r.name] || "";
    parts.push(`- **reference** \`${r.name}\` — ${summary}`);
    parts.push(`  路径：${r.absPath}`);
  }
  parts.push("");
  parts.push("**默认不需要 Read** — 节点 schema 表与阶段规则已覆盖 90% 场景。仅当遇到上述摘要明确涉及的特殊情况时再 Read 对应文件。");
  return parts.join("\n");
}

function buildSelectedSkillsHint(skills) {
  if (!Array.isArray(skills) || skills.length === 0) return "";
  const lines = ["## 用户选择的 skills"];
  for (const s of skills) {
    lines.push(`- 使用 skill \`${s.id}\`：${s.absPath}`);
  }
  lines.push("如任务与所选 skill 匹配，请先读取对应 SKILL.md 并遵循其说明；如果只是问答，按问题直接回答。");
  return lines.join("\n");
}

// ─── 辅助 ─────────────────────────────────────────────────────────────────

