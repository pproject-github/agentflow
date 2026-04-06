/**
 * Composer Skill Router：基于用户输入意图动态加载 SKILL.md 和 reference 文档。
 *
 * 意图分类：
 *   add-instances  — 新增节点/实例
 *   edit-fields    — 改已有节点内容
 *   optimize-flow  — 优化/重构整体流程
 *   optimize-nodes — 优化特定节点 prompt / body
 *   create-flow    — 从零创建新流程
 *
 * 每种意图映射到需要注入的 skills 和 reference 文档。
 */
import fs from "fs";
import path from "path";

// ─── 意图模式定义 ─────────────────────────────────────────────────────────

const INTENT_PATTERNS = [
  {
    id: "create-flow",
    patterns: [
      /(?:新建|创建|新增|生成|搭建|设计).*(?:流程|流水线|pipeline|flow|agentflow)/i,
      /(?:从零|从头|从无到有).*(?:搭|建|写|做)/i,
      /create\s+(?:a\s+)?(?:new\s+)?(?:flow|pipeline)/i,
    ],
  },
  {
    id: "add-instances",
    patterns: [
      /(?:新增|添加|加入|插入|增加|加个|加一个|补充|补一个).*(?:节点|实例|node|instance|步骤|环节)/i,
      /(?:加|添|增|补).*(?:分支|条件|判断|循环|环|if|toBool|anyOne)/i,
      /add\s+(?:a\s+)?(?:new\s+)?(?:node|instance|step)/i,
    ],
  },
  {
    id: "edit-fields",
    patterns: [
      /(?:改|修改|更新|调整|编辑|更换|换成|设为|设置|改为|替换|重写).*(?:节点|label|body|role|标签|名称|角色|内容|描述|文案|prompt|提示词|输入|输出|value|值)/i,
      /(?:节点|label|body|role|标签|角色|内容|文案|prompt|提示词).*(?:改|修改|更新|调整|编辑|换|设|替换|重写)/i,
      /edit\s+(?:node|label|body|role|content)/i,
      /(?:把|将).{0,30}(?:改成|换成|设为|更新为|修改为|替换为)/i,
    ],
  },
  {
    id: "optimize-nodes",
    patterns: [
      /(?:优化|改善|提升|改进|完善|精炼|润色|增强).*(?:节点|node|body|prompt|提示词|描述|文案|内容)/i,
      /(?:节点|node|body|prompt|提示词).*(?:优化|改善|提升|改进|完善|精炼|润色|增强)/i,
      /(?:让|使).{0,20}(?:节点|node|prompt|body).{0,20}(?:更好|更准|更清晰|更高效)/i,
      /optimize\s+(?:node|prompt|body)/i,
    ],
  },
  {
    id: "optimize-flow",
    patterns: [
      /(?:优化|改善|提升|改进|完善|重构|重新设计|简化|精简).*(?:流程|流水线|pipeline|flow|拓扑|结构|架构|整体)/i,
      /(?:流程|流水线|pipeline|flow|拓扑|结构|架构|整体).*(?:优化|改善|提升|改进|完善|重构|重新设计|简化|精简)/i,
      /(?:重新|重).*(?:规划|设计|组织|编排).*(?:流程|节点|步骤)/i,
      /optimize\s+(?:flow|pipeline|topology)/i,
      /refactor/i,
    ],
  },
];

// 意图 → 需要加载的 skills 和 references
const INTENT_RESOURCES = {
  "create-flow": {
    skills: ["agentflow-flow-add-instances"],
    references: ["flow-control-capabilities.md", "flow-layout.md"],
  },
  "add-instances": {
    skills: ["agentflow-flow-add-instances"],
    references: ["flow-control-capabilities.md", "flow-layout.md"],
  },
  "edit-fields": {
    skills: ["agentflow-flow-edit-node-fields"],
    references: ["flow-prompt-handler-check.md"],
  },
  "optimize-nodes": {
    skills: ["agentflow-flow-edit-node-fields", "agentflow-flow-add-instances"],
    references: ["flow-prompt-handler-check.md", "flow-control-capabilities.md"],
  },
  "optimize-flow": {
    skills: ["agentflow-flow-add-instances", "agentflow-flow-edit-node-fields"],
    references: ["flow-control-capabilities.md", "flow-layout.md", "flow-prompt-handler-check.md"],
  },
};

// ─── 文件缓存 ─────────────────────────────────────────────────────────────

const _fileCache = new Map();
const CACHE_TTL_MS = 60_000;

function readFileCached(absPath) {
  const now = Date.now();
  const cached = _fileCache.get(absPath);
  if (cached && now - cached.ts < CACHE_TTL_MS) return cached.content;
  try {
    const content = fs.readFileSync(absPath, "utf-8");
    _fileCache.set(absPath, { content, ts: now });
    return content;
  } catch {
    return null;
  }
}

// ─── 意图检测 ─────────────────────────────────────────────────────────────

/**
 * 分析用户输入，返回匹配的意图 ID 列表（按优先级排序，去重）。
 * 可能返回多个意图（如"优化节点并新增一个分支"同时匹配 optimize-nodes 和 add-instances）。
 * @param {string} userPrompt
 * @returns {string[]}
 */
export function detectIntents(userPrompt) {
  if (!userPrompt || typeof userPrompt !== "string") return [];
  const text = userPrompt.trim();
  if (!text) return [];

  const matched = [];
  for (const { id, patterns } of INTENT_PATTERNS) {
    for (const re of patterns) {
      if (re.test(text)) {
        matched.push(id);
        break;
      }
    }
  }
  return [...new Set(matched)];
}

// ─── 加载 skill 和 reference 内容 ─────────────────────────────────────────

/**
 * 根据意图列表加载对应的 SKILL.md 和 reference 文档内容。
 *
 * @param {string[]} intents - detectIntents 返回的意图 ID 列表
 * @param {string} packageRoot - AgentFlow 包根目录
 * @returns {{ skills: Array<{id: string, content: string}>, references: Array<{name: string, content: string}>, skillsHint: string, hasContext: boolean }}
 */
export function loadResourcesForIntents(intents, packageRoot) {
  if (!intents || intents.length === 0) {
    return { skills: [], references: [], skillsHint: "", hasContext: false };
  }

  const skillIds = new Set();
  const refNames = new Set();

  for (const intent of intents) {
    const res = INTENT_RESOURCES[intent];
    if (!res) continue;
    for (const s of res.skills) skillIds.add(s);
    for (const r of res.references) refNames.add(r);
  }

  const skills = [];
  for (const id of skillIds) {
    const absPath = path.join(packageRoot, "skills", id, "SKILL.md");
    const content = readFileCached(absPath);
    if (content) {
      const body = stripFrontmatter(content);
      skills.push({ id, content: body });
    }
  }

  const references = [];
  for (const name of refNames) {
    const absPath = path.join(packageRoot, "reference", name);
    const content = readFileCached(absPath);
    if (content) {
      references.push({ name, content });
    }
  }

  const skillsHint = buildSkillsHint(intents, skills, references);

  return {
    skills,
    references,
    skillsHint,
    hasContext: skills.length > 0 || references.length > 0,
  };
}

// ─── 构建注入到 prompt 的文本块 ───────────────────────────────────────────

/**
 * 为单步 prompt 构建完整的 skill + reference 注入块。
 * @param {Array<{id: string, content: string}>} skills
 * @param {Array<{name: string, content: string}>} references
 * @returns {string}
 */
export function buildSkillInjectionBlock(skills, references) {
  const parts = [];

  if (skills.length > 0) {
    parts.push("### 相关编辑技能（请严格遵循）");
    parts.push("");
    for (const s of skills) {
      parts.push(`<skill name="${s.id}">`);
      parts.push(s.content.trim());
      parts.push("</skill>");
      parts.push("");
    }
  }

  if (references.length > 0) {
    parts.push("### 参考文档");
    parts.push("");
    for (const r of references) {
      parts.push(`<reference name="${r.name}">`);
      parts.push(r.content.trim());
      parts.push("</reference>");
      parts.push("");
    }
  }

  return parts.join("\n");
}

/**
 * 为多步模式的 flowContext.skillsHint 构建精简版。
 */
function buildSkillsHint(intents, skills, references) {
  const lines = [];

  if (intents.includes("add-instances") || intents.includes("create-flow")) {
    lines.push("- 新增实例与边：遵循 skill `skills/agentflow-flow-add-instances/SKILL.md`（内容已注入上下文）");
  }
  if (intents.includes("edit-fields") || intents.includes("optimize-nodes")) {
    lines.push("- 仅改已有实例文案/占位等：遵循 `skills/agentflow-flow-edit-node-fields/SKILL.md`（内容已注入上下文）");
  }
  if (intents.includes("optimize-flow")) {
    lines.push("- 流程结构优化：参考 `reference/flow-control-capabilities.md` 和 `reference/flow-layout.md`（内容已注入上下文）");
  }

  lines.push(
    "- **节点类型选择（必须遵守）**：能用 tool 节点确定性执行的，不要用 agent_subAgent。" +
    "打印文本/执行已知脚本/文件操作 → tool_nodejs + script 字段（exit code 决定成败，stdout 直接作为 result）；" +
    "醒目输出 → tool_print；仅当需要 AI 推理时才用 agent_subAgent。"
  );
  lines.push(
    "- **tool_nodejs 必须写 script 字段**：script 是实际执行的命令代码，body 仅为文档注释（有 script 时不执行）。" +
    "禁止 tool_nodejs 只有 body 没有 script（body 中的自然语言不会被执行）。" +
    "如果无法写出完整可执行的 script，必须改用 agent_subAgent。"
  );

  return lines.join("\n");
}

// ─── 辅助 ─────────────────────────────────────────────────────────────────

function stripFrontmatter(content) {
  const match = content.match(/^---\n[\s\S]*?\n---\n?/);
  return match ? content.slice(match[0].length) : content;
}

/**
 * 为规划器提供精简的 skill 上下文摘要（不含完整文档内容，仅规则要点）。
 * @param {string[]} intents
 * @returns {string}
 */
export function buildPlannerSkillContext(intents) {
  if (!intents || intents.length === 0) return "";

  const parts = ["## 编辑技能约束（规划时须遵守）"];

  if (intents.includes("add-instances") || intents.includes("create-flow")) {
    parts.push(
      "- 新增节点：须从 builtin/pipelines/new/flow.yaml 拷贝同类 definitionId 的实例模板；" +
      "不要自造 input/output 顺序和 name；每个新 instanceId 须在 ui.nodePositions 写入坐标（默认画布中心附近 x:400 y:220）；" +
      "默认不连线，仅当用户明确要求时才在 edges 中增加边。"
    );
    parts.push(
      "- 节点类型选择：能确定性执行的用 tool_nodejs + script，不要用 agent_subAgent；" +
      "醒目输出用 tool_print；仅需 AI 推理时才用 agent_subAgent。"
    );
    parts.push(
      "- tool_nodejs 的 script 与 body 区分：script 是实际执行的命令（必填），body 仅为文档注释（有 script 时不执行）；" +
      "禁止 tool_nodejs 只写 body 不写 script（自然语言不会被执行）；如果无法写出完整可执行的 script，必须改用 agent_subAgent。"
    );
    parts.push("- 每个节点单一职责，不要把多个操作塞进同一个 body。");
  }

  if (intents.includes("edit-fields") || intents.includes("optimize-nodes")) {
    parts.push(
      "- 修改已有节点：可改白名单字段（label、body、role、script、input[].value、output[].value）；" +
      "禁改 definitionId、instanceId 键名、input/output 数组结构与顺序、edges。"
    );
    parts.push(
      "- **tool_nodejs 的 script 必须写**：`definitionId: tool_nodejs` 的节点核心是 `script`（实际执行的 shell/node 命令），" +
      "`body` 有 script 时不执行。优化 tool_nodejs 节点时务必检查并完善 `script` 字段，禁止只在 `body` 里写自然语言描述。" +
      "如果无法写出可执行 script，应建议改用 `agent_subAgent`。"
    );
  }

  if (intents.includes("optimize-flow")) {
    parts.push(
      "- 流程优化可能涉及：调整拓扑（改边）、增删节点、改 body 内容、调整布局坐标。" +
      "如果需要多种操作，拆成多个步骤（先改内容再连线，先加节点再连线）。"
    );
  }

  return parts.join("\n");
}
