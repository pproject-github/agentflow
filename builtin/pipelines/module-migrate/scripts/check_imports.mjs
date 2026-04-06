#!/usr/bin/env node
/**
 * 轻量级 import 预检查（不跑 Gradle）；主模块引用输出（需改为 API 调用的位置）。
 * 供 AgentFlow tool_nodejs 或 CLI 调用；stdout 单行 JSON：{ "err_code": 0|1, "message": { "result": "..." } }。
 *
 * 用法:
 *   # 主模块引用输出（迁移后需改 API 的 import/引用位置）
 *   node check_imports.mjs --after-list <path> [--before-list <path>] [--root /path/to/repo]
 *
 *   # 原有：按模块或文件列表检查 import 是否存在
 *   node check_imports.mjs --module modules/multiline [--root /path/to/repo]
 *   node check_imports.mjs --files - [--root /path/to/repo]   # 从 stdin 读文件路径，每行一个
 *
 * 主模块引用模式依赖 tree-sitter、tree-sitter-kotlin、tree-sitter-java（scripts 目录 npm install）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PIPELINE_DIR = path.resolve(__dirname, "..");
// scripts -> module-migrate -> pipelines -> AgentFlow 包根（传入 --root 可指向业务仓库）
const REPO_ROOT_DEFAULT = path.resolve(PIPELINE_DIR, "..", "..", "..");

const PRIVACY_GLOBS = [
  "**/sg/bigo/live/accountAuth/**",
  "**/sg/bigo/live/login/**",
  "**/sg/bigo/like/socialib/LoginManager.kt",
  "**/sg/bigo/like/mengma/TokenProperty.kt",
  "**/jsMethod/extend/JSMethodGetToken.java",
  "**/jsMethod/extend/JSMethodRefreshToken.java",
  "**/jsMethod/extend/JSMethodSSOAuthSuccess.kt",
  "**/sg/bigo/live/pay/**",
  "**/sg/bigo/live/profit/**",
  "**/googlebilling/**",
  "**/huawei/*Pay*.java",
  "**/huawei/*Pay*.kt",
  "**/samsung/*Pay*.kt",
  "**/xiaomi/*Billing*.kt",
  "**/rustore/*Billing*.kt",
  "**/jsMethod/biz/like/JSMethodHalfScreenRecharge.kt",
  "**/jsMethod/biz/like/JSMethodGoAlterPayEntry.kt",
  "**/jsMethod/biz/like/JSMethodOnlyAlterPayEntry.kt",
  "**/jsMethod/biz/like/JSMethodWalletEntryConfig.kt",
  "**/jsMethod/biz/other/JSMethodGotoPay.java",
  "**/jsMethod/biz/like/JSMethodGetSecurityCode.kt",
];

const IN_REPO_PREFIXES = ["sg.bigo.", "com.yy.iheima.", "com.yy."];

function pathMatchesGlobs(relPath, globs) {
  const normalized = relPath.replace(/\\/g, "/");
  for (const g of globs) {
    const re = globToRegExp(g);
    if (re.test(normalized)) return true;
  }
  return false;
}

function globToRegExp(glob) {
  const s = glob.replace(/\\/g, "/");
  let re = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "*") {
      if (s[i + 1] === "*" && (s[i + 2] === "/" || s[i + 2] === undefined)) {
        re += ".*";
        i += 1;
        if (s[i + 1] === "/") i += 1;
      } else {
        re += "[^/]*";
      }
    } else if (/[.+^${}()|[\]\\]/.test(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp("^" + re + "$");
}

function sourceDirs(root) {
  const dirs = [];
  const candidates = [
    path.join(root, "bigovlog"),
    path.join(root, "iHeima"),
    path.join(root, "modules"),
    path.join(root, "effectone-api"),
    path.join(root, "effectone_impl"),
  ];
  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;
    if (path.basename(candidate) === "modules") {
      try {
        const subs = fs.readdirSync(candidate, { withFileTypes: true });
        for (const d of subs) {
          if (!d.isDirectory()) continue;
          for (const sub of ["src/main/java", "src/main/kotlin"]) {
            const p = path.join(candidate, d.name, sub);
            if (fs.existsSync(p)) dirs.push(p);
          }
        }
      } catch (_) {}
    } else {
      for (const sub of ["src/main/java", "src/main/kotlin"]) {
        const p = path.join(candidate, sub);
        if (fs.existsSync(p)) dirs.push(p);
      }
    }
  }
  return dirs;
}

function buildClassIndex(root) {
  const index = Object.create(null);
  const dirs = sourceDirs(root);
  const exts = [".kt", ".java"];
  for (const src of dirs) {
    try {
      for (const ext of exts) {
        const files = walkRel(src, ext);
        for (const { rel, full } of files) {
          const rootRel = path.relative(root, full).replace(/\\/g, "/");
          if (pathMatchesGlobs(rootRel, PRIVACY_GLOBS)) continue;
          const qual = rel.replace(/\.(kt|java)$/, "").replace(/\//g, ".");
          index[qual] = rootRel;
        }
      }
    } catch (_) {}
  }
  return index;
}

function walkRel(dir, ext, base = dir, acc = []) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(base, full).replace(/\\/g, "/");
    if (e.isDirectory()) {
      walkRel(full, ext, base, acc);
    } else if (e.name.endsWith(ext)) {
      acc.push({ rel, full });
    }
  }
  return acc;
}

const IMPORT_RE = /^\s*import\s+(?:static\s+)?([\w.]+)(?:\s+as\s+\w+)?\s*(?:$|\/\/)/;

function extractImports(filePath, root) {
  let text;
  try {
    text = fs.readFileSync(filePath, "utf-8");
  } catch {
    return [];
  }
  const lines = text.split(/\r?\n/);
  const imports = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].trim().match(IMPORT_RE);
    if (m) imports.push({ imp: m[1], line: i + 1 });
  }
  return imports;
}

function isInRepoImport(imp) {
  const pkg = imp.endsWith(".*") ? imp.slice(0, -2) : imp.includes(".") ? imp.replace(/\.[^.]*$/, "") : imp;
  return IN_REPO_PREFIXES.some((prefix) => pkg.startsWith(prefix));
}

function checkFilesExist(root, files, classIndex) {
  const missing = [];
  for (const f of files) {
    if (!fs.existsSync(f) || !fs.statSync(f).isFile()) continue;
    const imports = extractImports(f, root);
    for (const { imp, line } of imports) {
      if (!isInRepoImport(imp)) continue;
      if (imp.endsWith(".*")) {
        const pkg = imp.slice(0, -2);
        const has = Object.keys(classIndex).some((k) => k === pkg || k.startsWith(pkg + "."));
        if (!has) missing.push({ imp, file: path.relative(root, f).replace(/\\/g, "/"), line, reason: "no_class_in_package" });
      } else {
        if (classIndex[imp]) continue;
        const outer = imp.replace(/\.[^.]*$/, "");
        if (classIndex[outer]) continue;
        missing.push({ imp, file: path.relative(root, f).replace(/\\/g, "/"), line, reason: "class_not_found" });
      }
    }
  }
  return missing;
}

function collectKtJavaUnder(root, modulePath) {
  const base = path.join(root, modulePath);
  if (!fs.existsSync(base)) return [];
  const out = [];
  const subdirs = ["src/main/java", "src/main/kotlin", "src/debug/java", "src/release/java"];
  for (const sub of subdirs) {
    const dPath = path.join(base, sub);
    if (!fs.existsSync(dPath)) continue;
    for (const ext of [".kt", ".java"]) {
      const files = walkRel(dPath, ext, root);
      for (const { rel } of files) {
        if (pathMatchesGlobs(rel, PRIVACY_GLOBS)) continue;
        out.push(path.join(root, rel));
      }
    }
  }
  return out;
}

function parseArgs() {
  const args = process.argv.slice(2);
  let modulePath = null;
  let filesFromStdin = false;
  let root = REPO_ROOT_DEFAULT;
  let beforeListPath = null;
  let afterListPath = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--module" && args[i + 1]) {
      modulePath = args[++i];
    } else if (args[i] === "--files" && args[i + 1] === "-") {
      filesFromStdin = true;
      i++;
    } else if (args[i] === "--root" && args[i + 1]) {
      root = path.resolve(args[++i]);
    } else if (args[i] === "--before-list" && args[i + 1]) {
      beforeListPath = args[++i];
    } else if (args[i] === "--after-list" && args[i + 1]) {
      afterListPath = args[++i];
    }
  }
  return { modulePath, filesFromStdin, root, beforeListPath, afterListPath };
}

/** 从列表文件读取路径，每行一个，相对 path 则基于 root 解析为绝对路径。 */
function readListFile(listPath, root) {
  const resolved = path.isAbsolute(listPath) ? listPath : path.join(root, listPath);
  let content;
  try {
    content = fs.readFileSync(resolved, "utf-8");
  } catch (e) {
    return { ok: false, error: e.message, paths: [] };
  }
  const paths = content
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((p) => (path.isAbsolute(p) ? p : path.join(root, p)));
  return { ok: true, paths };
}

/** 动态加载 Tree-sitter 与 Kotlin/Java 语法（从脚本所在目录 node_modules）；失败返回 null。 */
function loadTreeSitterSync() {
  const require = createRequire(import.meta.url);
  try {
    const Parser = require("tree-sitter");
    const Kotlin = require("tree-sitter-kotlin");
    const Java = require("tree-sitter-java");
    const parser = new Parser();
    return { Parser, Kotlin, Java, parser };
  } catch (_) {
    return null;
  }
}

function nodeText(node, src) {
  return src.slice(node.startIndex, node.endIndex);
}

/** 从 Kotlin AST 取 package 名（不含 keyword）。 */
function getPackageFromKotlin(rootNode, src) {
  for (let i = 0; i < rootNode.childCount; i++) {
    const c = rootNode.child(i);
    if (c.type === "package_header") {
      const raw = nodeText(c, src);
      const m = raw.match(/package\s+(.+?)(?:\s*$|\s*[;\n])/s);
      if (m) return m[1].replace(/\s+/g, "").trim();
    }
  }
  return "";
}

/** 从 Java AST 取 package 名。 */
function getPackageFromJava(rootNode, src) {
  for (let i = 0; i < rootNode.childCount; i++) {
    const c = rootNode.child(i);
    if (c.type === "package_declaration") {
      const raw = nodeText(c, src);
      const m = raw.match(/package\s+(.+?)\s*;/s);
      if (m) return m[1].replace(/\s+/g, "").trim();
    }
  }
  return "";
}

/** 递归找 simple_identifier 或 type_identifier 的文本（首个）。 */
function firstIdentifierText(node, src) {
  if (!node) return "";
  if (node.type === "simple_identifier" || node.type === "identifier" || node.type === "type_identifier") return nodeText(node, src).trim();
  for (let i = 0; i < node.namedChildCount; i++) {
    const t = firstIdentifierText(node.namedChild(i), src);
    if (t) return t;
  }
  return "";
}

/** Kotlin：顶层 class/object/interface 名。 */
function getTopLevelDeclNamesFromKotlin(rootNode, src) {
  const names = [];
  function walk(n) {
    if (!n) return;
    const type = n.type;
    if (type === "class_declaration" || type === "object_declaration" || type === "interface_declaration") {
      const name = n.namedChild(0) ? nodeText(n.namedChild(0), src).trim() : "";
      if (name) names.push(name);
      return;
    }
    for (let i = 0; i < n.childCount; i++) walk(n.child(i));
  }
  walk(rootNode);
  return names;
}

/** Java：顶层 class/interface 名。 */
function getTopLevelDeclNamesFromJava(rootNode, src) {
  const names = [];
  for (let i = 0; i < rootNode.childCount; i++) {
    const c = rootNode.child(i);
    if (c.type === "class_declaration" || c.type === "interface_declaration") {
      const nameNode = c.childForFieldName("name");
      if (nameNode) names.push(nodeText(nameNode, src).trim());
    }
  }
  return names;
}

/** 从迁移后文件列表解析出已迁移 FQCN 集合与包集合（用于 wildcard import）。 */
function extractFqcnsFromAfterList(root, afterPaths, ts) {
  const movedFqcns = new Set();
  const movedPackages = new Set();
  const parser = ts.parser;

  for (const filePath of afterPaths) {
    if (!/\.(kt|java)$/i.test(filePath) || !fs.existsSync(filePath)) continue;
    const rootRel = path.relative(root, filePath).replace(/\\/g, "/");
    if (pathMatchesGlobs(rootRel, PRIVACY_GLOBS)) continue;

    let src;
    try {
      src = fs.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }

    const ext = path.extname(filePath).toLowerCase();
    if (ext === ".kt") {
      parser.setLanguage(ts.Kotlin);
      const tree = parser.parse(src);
      const rootNode = tree.rootNode;
      const pkg = getPackageFromKotlin(rootNode, src);
      if (pkg) movedPackages.add(pkg);
      const names = getTopLevelDeclNamesFromKotlin(rootNode, src);
      for (const name of names) movedFqcns.add(pkg ? `${pkg}.${name}` : name);
    } else {
      parser.setLanguage(ts.Java);
      const tree = parser.parse(src);
      const rootNode = tree.rootNode;
      const pkg = getPackageFromJava(rootNode, src);
      if (pkg) movedPackages.add(pkg);
      const names = getTopLevelDeclNamesFromJava(rootNode, src);
      for (const name of names) movedFqcns.add(pkg ? `${pkg}.${name}` : name);
    }
  }

  return { movedFqcns, movedPackages };
}

/** 无 Tree-sitter 时从文件路径推导 FQCN（java/kotlin 目录下的包路径 + 文件名）。 */
function extractFqcnsFromPathsFallback(root, afterPaths) {
  const movedFqcns = new Set();
  const movedPackages = new Set();
  const javaKotlin = /[/\\]src[/\\](?:main|debug|release)[/\\](?:java|kotlin)[/\\]/i;
  for (const filePath of afterPaths) {
    const rootRel = path.relative(root, filePath).replace(/\\/g, "/");
    const match = rootRel.match(javaKotlin);
    if (!match) continue;
    const after = rootRel.indexOf(match[0]) + match[0].length;
    const rest = rootRel.slice(after).replace(/\.(kt|java)$/i, "").replace(/\//g, ".");
    if (rest) {
      movedFqcns.add(rest);
      const pkg = rest.replace(/\.[^.]+$/, "");
      if (pkg !== rest) movedPackages.add(pkg);
    }
  }
  return { movedFqcns, movedPackages };
}

/** 仅主模块（iHeima）的源码目录。 */
function mainModuleSourceDirs(root) {
  const iHeima = path.join(root, "iHeima");
  if (!fs.existsSync(iHeima)) return [];
  const dirs = [];
  for (const sub of ["src/main/java", "src/main/kotlin", "src/debug/java", "src/release/java"]) {
    const p = path.join(iHeima, sub);
    if (fs.existsSync(p)) dirs.push(p);
  }
  return dirs;
}

/** 收集主模块内所有 .kt/.java 文件路径。 */
function collectMainModuleFiles(root) {
  const dirs = mainModuleSourceDirs(root);
  const out = [];
  for (const d of dirs) {
    for (const ext of [".kt", ".java"]) {
      for (const { full } of walkRel(d, ext)) {
        const rootRel = path.relative(root, full).replace(/\\/g, "/");
        if (pathMatchesGlobs(rootRel, PRIVACY_GLOBS)) continue;
        out.push(full);
      }
    }
  }
  return out;
}

/** 从 Kotlin/Java AST 中收集 import 的 FQCN 或包（wildcard），带行号列号。 */
function collectImportsFromAst(rootNode, src, ext) {
  const imports = [];
  function walk(n) {
    if (!n) return;
    if (n.type === "import_list") {
      for (let i = 0; i < n.childCount; i++) walk(n.child(i));
      return;
    }
    if (n.type === "import_header") {
      const full = nodeText(n, src).replace(/\s+/g, " ").trim();
      const m = full.match(/import\s+(?:static\s+)?([\w.]+)(?:\s+as\s+\w+)?/);
      if (m) {
        const line = n.startPosition.row + 1;
        const column = n.startPosition.column + 1;
        imports.push({ fqcnOrPkg: m[1], isWildcard: m[1].endsWith(".*"), line, column });
      }
      return;
    }
    if (ext === ".java" && n.type === "import_declaration") {
      const full = nodeText(n, src).replace(/\s+/g, " ").trim();
      const m = full.match(/import\s+(?:static\s+)?([\w.]+)\s*;/);
      if (m) {
        const line = n.startPosition.row + 1;
        const column = n.startPosition.column + 1;
        imports.push({ fqcnOrPkg: m[1], isWildcard: m[1].endsWith(".*"), line, column });
      }
      return;
    }
    for (let i = 0; i < n.childCount; i++) walk(n.child(i));
  }
  walk(rootNode);
  return imports;
}

/** 单文件中找出命中 movedFqcns/movedPackages 的 import 与引用位置。 */
function findImportsAndRefsInFile(filePath, root, movedFqcns, movedPackages, ts) {
  const refs = [];
  const rootRel = path.relative(root, filePath).replace(/\\/g, "/");
  let src;
  try {
    src = fs.readFileSync(filePath, "utf-8");
  } catch {
    return refs;
  }

  const ext = path.extname(filePath).toLowerCase();
  const parser = ts.parser;

  if (ext === ".kt") {
    parser.setLanguage(ts.Kotlin);
  } else {
    parser.setLanguage(ts.Java);
  }
  const tree = parser.parse(src);
  const rootNode = tree.rootNode;

  const imports = collectImportsFromAst(rootNode, src, ext);
  for (const { fqcnOrPkg, isWildcard, line, column } of imports) {
    let hit = false;
    if (isWildcard) {
      const pkg = fqcnOrPkg.slice(0, -2);
      if (movedPackages.has(pkg)) hit = true;
      if (movedFqcns.has(pkg)) hit = true;
      for (const f of movedFqcns) {
        if (f === pkg || f.startsWith(pkg + ".")) {
          hit = true;
          break;
        }
      }
    } else {
      if (movedFqcns.has(fqcnOrPkg)) hit = true;
      if (movedPackages.has(fqcnOrPkg)) hit = true;
    }
    if (hit) refs.push({ file: rootRel, line, column, type: "import", fqcn: fqcnOrPkg });
  }

  const lines = src.split(/\r?\n/);
  const importMap = new Map();
  for (const { fqcnOrPkg, isWildcard } of imports) {
    if (isWildcard) continue;
    const short = fqcnOrPkg.replace(/^.*\./, "");
    importMap.set(short, fqcnOrPkg);
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const [short, fqcn] of importMap) {
      if (!movedFqcns.has(fqcn)) continue;
      const re = new RegExp("\\b" + short.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b");
      if (re.test(line)) {
        refs.push({
          file: rootRel,
          line: i + 1,
          column: 1,
          type: "reference",
          fqcn,
          snippet: line.trim().slice(0, 80),
        });
        break;
      }
    }
  }

  return refs;
}

/** 无 Tree-sitter 时仅用正则收集 import 行中命中 moved 的。 */
function findImportsAndRefsInFileFallback(filePath, root, movedFqcns, movedPackages) {
  const refs = [];
  const rootRel = path.relative(root, filePath).replace(/\\/g, "/");
  let src;
  try {
    src = fs.readFileSync(filePath, "utf-8");
  } catch {
    return refs;
  }
  const importList = extractImports(filePath, root);
  for (const { imp, line } of importList) {
    let hit = false;
    if (imp.endsWith(".*")) {
      const pkg = imp.slice(0, -2);
      if (movedPackages.has(pkg)) hit = true;
      for (const f of movedFqcns) {
        if (f === pkg || f.startsWith(pkg + ".")) {
          hit = true;
          break;
        }
      }
    } else {
      if (movedFqcns.has(imp) || movedPackages.has(imp)) hit = true;
    }
    if (hit) refs.push({ file: rootRel, line, column: 1, type: "import", fqcn: imp });
  }
  return refs;
}

function findMainModuleRefs(root, movedFqcns, movedPackages, ts) {
  const mainFiles = collectMainModuleFiles(root);
  const allRefs = [];
  const useFallback = !ts;
  for (const filePath of mainFiles) {
    const refs = useFallback
      ? findImportsAndRefsInFileFallback(filePath, root, movedFqcns, movedPackages)
      : findImportsAndRefsInFile(filePath, root, movedFqcns, movedPackages, ts);
    allRefs.push(...refs);
  }
  return allRefs;
}

function formatMainRefsResult(refs, usedTreeSitter) {
  if (refs.length === 0) {
    return "主模块中未发现对已迁移类的 import 或引用，无需改为 API。" + (usedTreeSitter ? "" : "\n（未使用 Tree-sitter，仅检查 import。）");
  }
  const header = "| 文件 | 行 | 类型 | FQCN/内容 |";
  const sep = "| --- | --- | --- | --- |";
  const rows = refs.map((r) => `| ${r.file} | ${r.line} | ${r.type} | ${(r.fqcn || r.snippet || "").replace(/\|/g, "\\|")} |`);
  const note = usedTreeSitter ? "" : "\n\n（未使用 Tree-sitter，仅 import；安装 tree-sitter、tree-sitter-kotlin、tree-sitter-java 可得到引用位置。）";
  return "主模块中需改为 API 调用的代码地址：\n\n" + [header, sep, ...rows].join("\n") + note;
}

function readStdinLines() {
  return new Promise((resolve, reject) => {
    const chunks = [];
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => chunks.push(c));
    process.stdin.on("end", () => {
      const line = Buffer.concat(chunks).toString("utf8");
      resolve(line.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    });
    process.stdin.on("error", reject);
  });
}

function outputResult(errCode, resultText) {
  const out = JSON.stringify({ err_code: errCode, message: { result: resultText } });
  if (process.stdout.write(out + "\n") === false) {
    process.stdout.once("drain", () => process.exit(errCode));
  } else {
    process.exit(errCode);
  }
}

async function main() {
  const { modulePath, filesFromStdin, root, beforeListPath, afterListPath } = parseArgs();

  if (afterListPath) {
    const afterRes = readListFile(afterListPath, root);
    if (!afterRes.ok) {
      outputResult(1, "error: 无法读取迁移后列表 " + afterListPath + ": " + afterRes.error);
      return;
    }
    const afterPaths = afterRes.paths.filter((p) => /\.(kt|java)$/i.test(p));
    if (afterPaths.length === 0) {
      outputResult(0, "主模块中未发现对已迁移类的 import 或引用，无需改为 API。（迁移后列表无 .kt/.java 文件）");
      return;
    }

    let ts = loadTreeSitterSync();
    let movedFqcns, movedPackages;
    if (ts) {
      try {
        const out = extractFqcnsFromAfterList(root, afterPaths, ts);
        movedFqcns = out.movedFqcns;
        movedPackages = out.movedPackages;
      } catch (_) {
        const out = extractFqcnsFromPathsFallback(root, afterPaths);
        movedFqcns = out.movedFqcns;
        movedPackages = out.movedPackages;
        ts = null;
      }
    } else {
      const out = extractFqcnsFromPathsFallback(root, afterPaths);
      movedFqcns = out.movedFqcns;
      movedPackages = out.movedPackages;
    }
    if (movedFqcns.size === 0 && movedPackages.size === 0) {
      outputResult(0, "主模块中未发现对已迁移类的 import 或引用，无需改为 API。（未能从迁移后文件解析出类/包）");
      return;
    }

    let refs;
    try {
      refs = findMainModuleRefs(root, movedFqcns, movedPackages, ts);
    } catch (_) {
      refs = findMainModuleRefs(root, movedFqcns, movedPackages, null);
      ts = null;
    }
    const result = formatMainRefsResult(refs, !!ts);
    // 仅脚本自身失败返回 1；检查完成（无论是否发现需改引用）均返回 0，下游根据 result 报告内容分支
    outputResult(0, result);
    return;
  }

  if (!modulePath && !filesFromStdin) {
    outputResult(1, "error: 请指定 --after-list <path>（主模块引用）或 --module <path> / --files -（import 检查）");
    return;
  }
  if (modulePath && filesFromStdin) {
    outputResult(1, "error: 只能指定 --module 或 --files 其一");
    return;
  }

  let files = [];
  if (filesFromStdin) {
    const lines = await readStdinLines();
    files = lines.map((p) => (path.isAbsolute(p) ? p : path.join(root, p)));
  } else {
    files = collectKtJavaUnder(root, modulePath);
  }

  files = files.filter((f) => /\.(kt|java)$/i.test(f));
  if (files.length === 0) {
    outputResult(0, "ok: no .kt/.java files to check.");
    return;
  }

  const classIndex = buildClassIndex(root);
  const missing = checkFilesExist(root, files, classIndex);

  if (missing.length === 0) {
    outputResult(0, "ok: all checked imports exist in repo.");
    return;
  }

  const lines = missing.map((m) => `  ${m.file}:${m.line}  ${m.imp}  [${m.reason}]`);
  const result = "potential broken imports (run compile to confirm):\n" + lines.join("\n");
  outputResult(1, result);
}

main().catch((err) => {
  outputResult(1, "error: " + (err && err.message ? err.message : String(err)));
});
