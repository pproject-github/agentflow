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

/** 默认语言 */
export const DEFAULT_LANGUAGE = "zh";

/** 当前语言 */
let currentLang = DEFAULT_LANGUAGE;

/** 已加载的语言包缓存 */
const localeCache = new Map();

/**
 * 从环境变量解析语言
 * @returns {string}
 */
function detectLanguageFromEnv() {
  const envLang = process.env.LANG || process.env.LANGUAGE || "";
  // 处理形如 zh_CN.UTF-8 的格式
  const langCode = envLang.split(".")[0].split("_")[0].toLowerCase();
  return SUPPORTED_LANGUAGES.includes(langCode) ? langCode : DEFAULT_LANGUAGE;
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
