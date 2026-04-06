/**
 * Composer 模型路由器：基于 model-lists.json 按任务复杂度分配合适的模型。
 *
 * 模型分三个档次：
 * - fast    — 简单/一般任务（改文案、添加节点、日常编辑）
 * - balanced — 中等任务（多步推理、较复杂设计）
 * - capable  — 复杂任务（流程重构、深度分析）
 *
 * 路由策略：simple → fast，medium → fast，complex → capable
 * "auto" 条目不参与自动路由（auto 本身就是让 Cursor 自己选，不是明确的模型选择）。
 */
import fs from "fs";
import { getModelListsAbs } from "./paths.mjs";
import { loadModelConfig, normalizeCursorModelForCli } from "./model-config.mjs";

// ─── 模型分类规则 ──────────────────────────────────────────────────────────

const FAST_PATTERNS = [
  /\bflash\b/i,
  /\bmini\b/i,
  /\bhaiku\b/i,
  /\blite\b/i,
  /\binstant\b/i,
  /\bfast\b/i,
  /\b4o-mini\b/i,
  /\bgpt-4\.1-mini\b/i,
  /\bgpt-4\.1-nano\b/i,
  /\bclaude-3\.5-haiku\b/i,
  /\bgemini.*flash\b/i,
  /\bdeepseek-v3\b/i,
];

const CAPABLE_PATTERNS = [
  /\bopus\b/i,
  /\bo1\b/i,
  /\bo3\b/i,
  /\bo4-mini\b/i,
  /\bsonnet.*think/i,
  /\bthinking\b/i,
  /\bmax\b/i,
  /\bcodex\b/i,
  /\bgpt-5/i,
  /\bclaude-4/i,
  /\bdeepseek-r1\b/i,
  /\bgemini.*pro.*think/i,
];

function classifyModel(modelId) {
  const s = String(modelId || "");
  for (const re of FAST_PATTERNS) {
    if (re.test(s)) return "fast";
  }
  for (const re of CAPABLE_PATTERNS) {
    if (re.test(s)) return "capable";
  }
  return "balanced";
}

// ─── 读取可用模型列表 ──────────────────────────────────────────────────────

function loadModelLists() {
  try {
    const p = getModelListsAbs();
    if (!fs.existsSync(p)) return { cursor: [], opencode: [] };
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    return {
      cursor: Array.isArray(data.cursor) ? data.cursor.map(String) : [],
      opencode: Array.isArray(data.opencode) ? data.opencode.map(String) : [],
    };
  } catch {
    return { cursor: [], opencode: [] };
  }
}

function isAutoEntry(entry) {
  const id = String(entry || "").split(" - ")[0].trim().toLowerCase();
  return id === "auto" || id === "";
}

function buildModelTiers(modelList) {
  const tiers = { fast: [], balanced: [], capable: [] };
  for (const m of modelList) {
    if (isAutoEntry(m)) continue;
    const tier = classifyModel(m);
    tiers[tier].push(m);
  }
  return tiers;
}

// ─── 公开接口 ──────────────────────────────────────────────────────────────

/**
 * 根据任务复杂度从可用模型列表中选择合适的模型。
 *
 * @param {"simple" | "medium" | "complex"} complexity
 * @param {object} [opts]
 * @param {string} [opts.userPreferredModel] 用户在 Composer 下拉选择的模型（优先级最高）
 * @param {string} [opts.workspaceRoot] 工作区根目录（加载 models.json）
 * @returns {{ model: string | null, tier: string, source: string }}
 */
export function routeModel(complexity, opts = {}) {
  if (opts.userPreferredModel && String(opts.userPreferredModel).trim()) {
    const m = String(opts.userPreferredModel).trim();
    return { model: m, tier: classifyModel(m), source: "user-selected" };
  }

  const lists = loadModelLists();
  const allModels = [...lists.cursor];
  if (allModels.length === 0) {
    return { model: null, tier: complexity === "complex" ? "capable" : complexity === "simple" ? "fast" : "balanced", source: "no-models-available" };
  }

  const tiers = buildModelTiers(allModels);

  // simple 和 medium 都优先用 fast 模型，complex 才升级到 capable
  const tierMap = {
    simple: "fast",
    medium: "fast",
    complex: "capable",
  };
  const targetTier = tierMap[complexity] || "fast";

  if (tiers[targetTier].length > 0) {
    return { model: tiers[targetTier][0], tier: targetTier, source: "auto-routed" };
  }

  // fallback 链：capable → balanced → fast → any
  if (targetTier === "capable") {
    if (tiers.balanced.length > 0) return { model: tiers.balanced[0], tier: "balanced", source: "auto-routed-fallback" };
    if (tiers.fast.length > 0) return { model: tiers.fast[0], tier: "fast", source: "auto-routed-fallback" };
  }
  if (targetTier === "fast") {
    if (tiers.balanced.length > 0) return { model: tiers.balanced[0], tier: "balanced", source: "auto-routed-fallback" };
    if (tiers.capable.length > 0) return { model: tiers.capable[0], tier: "capable", source: "auto-routed-fallback" };
  }

  const firstReal = allModels.find((m) => !isAutoEntry(m));
  if (firstReal) return { model: firstReal, tier: classifyModel(firstReal), source: "auto-routed-fallback" };
  return { model: allModels[0], tier: classifyModel(allModels[0]), source: "auto-routed-fallback" };
}

/**
 * 返回模型列表的分层信息（供 UI 或调试用）。
 */
export function getModelTierInfo() {
  const lists = loadModelLists();
  const cursorTiers = buildModelTiers(lists.cursor);
  const opencodeTiers = buildModelTiers(lists.opencode);
  return {
    cursor: cursorTiers,
    opencode: opencodeTiers,
    totalCursor: lists.cursor.length,
    totalOpencode: lists.opencode.length,
  };
}

/**
 * 对单个模型 ID 进行分类。
 */
export { classifyModel };
