/**
 * AgentFlow CLI i18n 模块
 * 支持通过 LANG 环境变量或 --lang 参数切换语言
 */

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** 支持的语言列表 */
export const SUPPORTED_LANGUAGES = ["en", "zh"];

/**
 * 检测系统语言
 * - 优先使用 LANG/LANGUAGE 环境变量
 * - macOS/Linux: process.env.LANG (如 zh_CN.UTF-8)
 * - Windows: process.env.LANGUAGE 或 LC_ALL
 * @returns {string}
 */
function detectSystemLanguage() {
  const envLang = process.env.LANG || process.env.LANGUAGE || process.env.LC_ALL || "";
  // 处理形如 zh_CN.UTF-8、en_US.UTF-8 的格式
  const langCode = envLang.split(".")[0].split("_")[0].toLowerCase();
  // 默认使用英文，仅在检测到中文时使用中文
  if (langCode === "zh") return "zh";
  if (SUPPORTED_LANGUAGES.includes(langCode)) return langCode;
  return "en";
}

/** 默认语言（跟随系统） */
export const DEFAULT_LANGUAGE = detectSystemLanguage();

/** 当前语言 */
let currentLang = DEFAULT_LANGUAGE;

/** 已加载的语言包缓存 */
const localeCache = new Map();

/**
 * 从环境变量解析语言（兼容旧 API）
 * @returns {string}
 */
function detectLanguageFromEnv() {
  return detectSystemLanguage();
}

/**
 * 初始化 i18n
 * @param {string} [lang] - 指定语言，如不提供则使用环境变量检测
 */
export function initI18n(lang) {
  currentLang = lang || detectLanguageFromEnv();
  if (!SUPPORTED_LANGUAGES.includes(currentLang)) {
    currentLang = DEFAULT_LANGUAGE;
  }
  // 清空缓存以重新加载
  localeCache.clear();
}

/**
 * 设置当前语言
 * @param {string} lang
 */
export function setLanguage(lang) {
  if (SUPPORTED_LANGUAGES.includes(lang)) {
    currentLang = lang;
    localeCache.clear();
  }
}

/**
 * 获取当前语言
 * @returns {string}
 */
export function getLanguage() {
  return currentLang;
}

/**
 * 加载语言包
 * @param {string} lang
 * @returns {object}
 */
function loadLocale(lang) {
  if (localeCache.has(lang)) {
    return localeCache.get(lang);
  }

  try {
    const filePath = path.join(__dirname, "locales", `${lang}.json`);
    const content = readFileSync(filePath, "utf-8");
    const locale = JSON.parse(content);
    localeCache.set(lang, locale);
    return locale;
  } catch (err) {
    // 如果加载失败，返回空对象（会使用回退逻辑）
    return {};
  }
}

/**
 * 获取翻译文本
 * @param {string} key - 键名，支持嵌套如 "flow.not_found"
 * @param {object} [vars] - 插值变量
 * @returns {string}
 */
export function t(key, vars = {}) {
  const locale = loadLocale(currentLang);
  const fallbackLocale = loadLocale(DEFAULT_LANGUAGE);

  // 解析嵌套键
  const keys = key.split(".");
  let value = locale;
  let fallbackValue = fallbackLocale;

  for (const k of keys) {
    value = value?.[k];
    fallbackValue = fallbackValue?.[k];
  }

  // 如果没有找到翻译，使用回退语言或键名
  let text = value || fallbackValue || key;

  // 处理插值 {{varName}}
  if (vars && typeof text === "string") {
    text = text.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
      return vars[varName] !== undefined ? String(vars[varName]) : match;
    });
  }

  return text;
}

/**
 * 批量翻译多个键
 * @param {string[]} keys
 * @returns {object}
 */
export function tBatch(keys) {
  const result = {};
  for (const key of keys) {
    result[key] = t(key);
  }
  return result;
}

// 初始化（使用环境变量检测）
initI18n();

/** 中文 type 到英文 key 的映射 */
export const TYPE_ZH_TO_KEY = {
  节点: "node",
  文本: "text",
  文件: "file",
  bool: "bool",
  布尔: "bool",
};

/** 英文 key 到中文 type 的映射 */
export const TYPE_KEY_TO_ZH = {
  node: "节点",
  text: "文本",
  file: "文件",
  bool: "布尔",
};

/** 中文 role 到英文 key 的映射 */
export const ROLE_ZH_TO_KEY = {
  普通: "normal",
  技术规划: "planning",
  代码执行: "code",
  测试回归: "test",
  需求拆解: "requirement",
};

/** 英文 key 到中文 role 的映射 */
export const ROLE_KEY_TO_ZH = {
  normal: "普通",
  planning: "技术规划",
  code: "代码执行",
  test: "测试回归",
  requirement: "需求拆解",
};

/**
 * 翻译类型名称（支持中英文互转）
 * @param {string} typeOrKey - 中文类型名或英文 key
 * @returns {string} 当前语言对应的类型名
 */
export function translateType(typeOrKey) {
  const key = TYPE_ZH_TO_KEY[typeOrKey] || typeOrKey;
  return t(`type.${key}`);
}

/**
 * 翻译角色名称（支持中英文互转）
 * @param {string} roleOrKey - 中文角色名或英文 key
 * @returns {string} 当前语言对应的角色名
 */
export function translateRole(roleOrKey) {
  const key = ROLE_ZH_TO_KEY[roleOrKey] || roleOrKey;
  return t(`role.${key}`);
}

/**
 * 获取类型的英文 key（用于内部存储）
 * @param {string} typeOrKey - 中文类型名或英文 key
 * @returns {string} 英文 key
 */
export function normalizeTypeToKey(typeOrKey) {
  return TYPE_ZH_TO_KEY[typeOrKey] || typeOrKey;
}

/**
 * 获取角色的英文 key（用于内部存储）
 * @param {string} roleOrKey - 中文角色名或英文 key
 * @returns {string} 英文 key
 */
export function normalizeRoleToKey(roleOrKey) {
  return ROLE_ZH_TO_KEY[roleOrKey] || roleOrKey;
}

/**
 * 翻译节点定义字段
 * @param {string} definitionId - 节点定义 ID
 * @param {"displayName" | "description"} field - 字段名
 * @returns {string}
 */
export function translateNodeDef(definitionId, field) {
  return t(`nodeDef.${definitionId}.${field}`);
}
