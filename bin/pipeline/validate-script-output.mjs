#!/usr/bin/env node
/**
 * 解析 tool_nodejs 脚本 stdout 为结构化 payload。
 *
 * 两种模式：
 * 1. JSON 模式：stdout 含 { "err_code": number, "message": { "result": "..." } }
 *    → 直接使用，err_code 可覆盖 exit code 语义（向后兼容）。
 * 2. 纯文本模式：stdout 不含合法 JSON
 *    → 自动包装为 { err_code: -1, message: { result: <stdout> }, _synthetic: true }
 *    → 调用方应以进程 exit code 决定成败。
 *
 * 用法：
 *   node validate-script-output.mjs              # 从 stdin 读取
 *   node validate-script-output.mjs <file>       # 从文件读取
 *
 * 输出（stdout JSON）：{ "ok": boolean, "errors": string[], "payload": object | null }
 * 退出码：0 解析成功，1 失败
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * 从文本中提取第一个完整 JSON 对象并解析。
 * 支持：单行 JSON、多行（pretty-print）JSON、stdout 前有日志的情况。
 */
function parsePayload(text) {
  if (!text || typeof text !== "string") return null;
  const raw = text.trimStart().replace(/^\uFEFF/, "");
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;
  for (let i = start; i < raw.length; i++) {
    const c = raw[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (inString) {
      if (c === "\\") escape = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      continue;
    }
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  const slice = end > 0 ? raw.slice(start, end) : raw.slice(start).split("\n")[0];
  try {
    return JSON.parse(slice);
  } catch {
    return null;
  }
}

/**
 * 解析脚本 stdout 为结构化 payload。
 *
 * @param {string} stdoutText
 * @returns {{ ok: boolean, errors: string[], payload: { err_code: number, message: object, _synthetic?: boolean } | null }}
 *   - JSON 模式：payload 含脚本输出的 err_code + message
 *   - 纯文本模式：payload._synthetic = true，err_code = -1（由调用方按 exit code 判断）
 *   - stdout 为空：ok = false
 */
export function validateAndParse(stdoutText) {
  const errors = [];
  const jsonPayload = parsePayload(stdoutText);

  if (jsonPayload) {
    if (typeof jsonPayload.err_code !== "number") {
      errors.push("JSON 缺少 err_code（数字）");
    }
    if (!jsonPayload.message || typeof jsonPayload.message !== "object" || Array.isArray(jsonPayload.message)) {
      errors.push("JSON 缺少 message（对象）");
    }
    if (errors.length > 0) {
      return { ok: false, errors, payload: null };
    }
    return { ok: true, errors: [], payload: jsonPayload };
  }

  if (stdoutText && stdoutText.trim()) {
    return {
      ok: true,
      errors: [],
      payload: { err_code: -1, message: { result: stdoutText.trim() }, _synthetic: true },
    };
  }

  errors.push("stdout 为空");
  return { ok: false, errors, payload: null };
}

function main() {
  const args = process.argv.slice(2);

  let input = "";
  if (args.length > 0 && !args[0].startsWith("--")) {
    try {
      input = fs.readFileSync(args[0], "utf-8");
    } catch (e) {
      console.log(JSON.stringify({ ok: false, errors: [e.message], payload: null }));
      process.exit(1);
    }
  } else {
    input = fs.readFileSync(0, "utf-8");
  }

  const { ok, errors, payload } = validateAndParse(input);
  console.log(JSON.stringify({ ok, errors, payload }));
  process.exit(ok ? 0 : 1);
}

const _url = fileURLToPath(import.meta.url);
const _dir = path.dirname(_url);
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(_dir, "validate-script-output.mjs");
if (isMain) main();
