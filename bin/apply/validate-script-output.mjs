#!/usr/bin/env node
/**
 * 校验 tool_nodejs 脚本 stdout 约定格式，并可选提取 payload。
 * 约定：单行 JSON { "err_code": number, "message": { "result": "..." } }；err_code 0=节点成功、1=节点失败，无 message.next。
 *
 * 用法：
 *   node validate-script-output.mjs              # 从 stdin 读取
 *   node validate-script-output.mjs <file>      # 从文件读取
 *   node validate-script-output.mjs --slots result  # 校验 message 必须包含指定槽（默认 result）
 *
 * 输出（stdout JSON）：{ "ok": boolean, "errors": string[], "payload": { "err_code", "message" } | null }
 * 退出码：0 校验通过，1 校验失败
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

/**
 * 从文本中提取第一个完整 JSON 对象并解析。
 * 支持：单行 JSON、多行（pretty-print）JSON、stdout 前有日志的情况。
 * 按括号深度提取到匹配的 }，避免被字符串内的 } 干扰。
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
 * 校验并解析脚本 stdout。
 * @param {string} stdoutText - 脚本 stdout 内容
 * @param {{ requireSlots?: string[] }} options - requireSlots 默认 ["result"]
 * @returns {{ ok: boolean, errors: string[], payload: { err_code: number, message: object } | null }}
 */
export function validateAndParse(stdoutText, options = {}) {
  const requireSlots = options.requireSlots ?? ["result"];
  const errors = [];

  const payload = parsePayload(stdoutText);
  if (!payload) {
    errors.push("stdout 须包含一行合法 JSON（以 { 开头）");
    return { ok: false, errors, payload: null };
  }

  if (typeof payload.err_code !== "number") {
    errors.push("缺少或类型错误：err_code 须为数字");
  }

  if (!payload.message || typeof payload.message !== "object" || Array.isArray(payload.message)) {
    errors.push("缺少或类型错误：message 须为对象");
  } else {
    for (const slot of requireSlots) {
      if (!(slot in payload.message)) {
        errors.push(`message 缺少槽位：${slot}`);
      }
    }
  }

  const ok = errors.length === 0;
  return { ok, errors, payload: ok ? payload : null };
}

function main() {
  const args = process.argv.slice(2);
  let requireSlots = ["result"];
  const slotIdx = args.indexOf("--slots");
  if (slotIdx >= 0 && args[slotIdx + 1]) {
    requireSlots = args[slotIdx + 1].split(",").map((s) => s.trim()).filter(Boolean);
    args.splice(slotIdx, 2);
  }

  let input = "";
  if (args.length > 0 && !args[0].startsWith("--")) {
    try {
      input = fs.readFileSync(args[0], "utf-8");
    } catch (e) {
      const result = { ok: false, errors: [e.message], payload: null };
      console.log(JSON.stringify(result));
      process.exit(1);
    }
  } else {
    input = fs.readFileSync(0, "utf-8");
  }

  const { ok, errors, payload } = validateAndParse(input, { requireSlots });
  console.log(JSON.stringify({ ok, errors, payload }));
  process.exit(ok ? 0 : 1);
}

const _url = fileURLToPath(import.meta.url);
const _dir = path.dirname(_url);
const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(_dir, "validate-script-output.mjs");
if (isMain) main();
