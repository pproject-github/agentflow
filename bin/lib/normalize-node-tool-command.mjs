/**
 * 规范化 tool_nodejs 的 script 命令行，修复误写 `node "${workspaceRoot}/..."` 等导致的错误路径。
 * 供 node-execute（内联执行）与 run-tool-nodejs（子进程）共用。
 */

/**
 * 合并 bash 风格「'片段'/后续路径」拼接，得到真实文件系统路径。
 * 同时处理中间嵌入的 `/'T'/` 形态（脚本模板里对变量加单引号，
 * 但这些单引号对 spawn/非 shell 调用是字面量，需剥掉）。
 */
export function normalizeConcatenatedSingleQuotedPath(s) {
  let out = String(s).trim();
  for (let n = 0; n < 64; n++) {
    // 开头：'x'/y 或 'x'.y → xy
    let next = out.replace(/^'([^']*)'(\/|\.)/, "$1$2");
    // 中间：/'x'/ 或 /'x'. → /x/ 或 /x.  （保留前后分隔符，避免误吃尾随空格后的独立 '…' 参数）
    next = next.replace(/(\/)'([^'\s]*)'(\/|\.)/g, "$1$2$3");
    if (next === out) break;
    out = next;
  }
  return out;
}

/**
 * 去掉首段外层双引号（含 `node "'/a'/.b" --flags`：首段结束后还有参数）。
 */
export function stripOuterDoubleQuotes(rest) {
  const t = rest.trim();
  if (!t.startsWith('"')) return t;
  for (let i = 1; i < t.length; i++) {
    if (t[i] === '"' && (i + 1 >= t.length || /\s/.test(t[i + 1]))) {
      return (t.slice(1, i) + t.slice(i + 1)).trim();
    }
  }
  if (t.endsWith('"')) return t.slice(1, -1).trim();
  return t.slice(1).trim();
}

/**
 * 极简 shell 式分词：未加引号片段、单引号块、双引号块。
 */
export function parseShellLikeArgs(input) {
  const args = [];
  const str = String(input);
  let i = 0;
  const len = str.length;
  while (i < len) {
    while (i < len && /\s/.test(str[i])) i++;
    if (i >= len) break;
    let arg = "";
    if (str[i] === "'") {
      i++;
      while (i < len && str[i] !== "'") arg += str[i++];
      if (str[i] === "'") i++;
    } else if (str[i] === '"') {
      i++;
      while (i < len && str[i] !== '"') {
        if (str[i] === "\\" && i + 1 < len) arg += str[++i];
        else arg += str[i];
        i++;
      }
      if (str[i] === '"') i++;
    } else {
      while (i < len && !/\s/.test(str[i])) arg += str[i++];
    }
    args.push(arg);
  }
  return args;
}

/**
 * @param {string} resolvedScript - 如 node "'/root'/.workspace/.../x.mjs" 或 node "${workspaceRoot}/..." 解析后的错误形态
 * @returns {string}
 */
export function normalizeNodeToolCommandLine(resolvedScript) {
  const t = String(resolvedScript).trim();
  const m = t.match(/^node\s+/i);
  if (!m) return resolvedScript;
  let rest = t.slice(m[0].length).trim();
  rest = stripOuterDoubleQuotes(rest);
  rest = normalizeConcatenatedSingleQuotedPath(rest);
  return `node ${rest}`;
}

/**
 * @returns {{ argv: string[], commandLine: string }}
 */
export function nodeToolCommandToArgv(commandLine) {
  const normalized = normalizeNodeToolCommandLine(commandLine);
  const nodeLead = normalized.match(/^node\s+/i);
  if (!nodeLead) {
    return { argv: [], commandLine: normalized };
  }
  const rest = normalized.slice(nodeLead[0].length).trim();
  const argv = parseShellLikeArgs(rest);
  return { argv, commandLine: normalized };
}
