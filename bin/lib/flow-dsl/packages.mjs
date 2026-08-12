/**
 * 流程目录里的代码节点包（`<flowDir>/nodes/<name>/index.mjs`）。
 *
 * **lint 和存储层必须用同一份扫描。** 分成两份的后果实际发生过：lint 自己解析包、看到
 * 的是对的图，存储层不解析、把 `import x from "./nodes/x"` 读成一个槽位表为空的
 * `pkg:./nodes/x`，于是控制边落到第一个数据槽上、两条边撞同一个句柄。AI 照文档写完
 * lint 绿灯，画布上却是一张错图。
 *
 * 一个包在图里的形态与画布从面板拖出来的**完全一致**：`definitionId` 是基础类型
 * （`tool_nodejs` 等），包的身份放 `marketplaceRef`。代码里则渲染成 import + 调用，
 * 那只是同一件事的可读写法。
 */
import fs from "fs";
import path from "path";
import { parse as acornParse } from "acorn";

import { isNodePackageDir, readNodePackageManifest, slotMapToList } from "../node-package-manifest.mjs";
import { listMarketplaceNodes, parseMarketplaceDefinitionId } from "../marketplace.mjs";

/**
 * 从结构代码里提取远端节点依赖。import 本身就是依赖声明，不能再维护第二份 lock 清单。
 * 这里只看静态 ImportDeclaration，和 DSL 解析器的边界一致。
 *
 * @returns {{ dependencies: Array<{id:string,version:string,specifier:string,line:number}>, errors: string[] }}
 */
export function marketplaceDependenciesFromSource(source) {
  let ast;
  try {
    ast = acornParse(String(source || ""), {
      ecmaVersion: 2022,
      sourceType: "module",
      locations: true,
    });
  } catch (error) {
    return { dependencies: [], errors: [`workspace.flow.js 语法错误：${error?.message || String(error)}`] };
  }
  const bySpecifier = new Map();
  const errors = [];
  for (const statement of ast.body) {
    if (statement.type !== "ImportDeclaration") continue;
    const specifier = String(statement.source?.value || "").trim();
    if (!specifier.startsWith("marketplace:")) continue;
    const parsed = parseMarketplaceDefinitionId(specifier);
    const line = Number(statement.loc?.start?.line) || 0;
    if (!parsed?.id) {
      errors.push(`第 ${line} 行：无效的 marketplace 节点引用 ${JSON.stringify(specifier)}`);
      continue;
    }
    if (!parsed.version) {
      errors.push(`第 ${line} 行：${specifier} 没有固定版本；请使用 marketplace:<id>@<version>`);
      continue;
    }
    bySpecifier.set(specifier, { id: parsed.id, version: parsed.version, specifier, line });
  }
  return {
    dependencies: [...bySpecifier.values()].sort((a, b) => a.specifier.localeCompare(b.specifier)),
    errors,
  };
}

/**
 * 把流程目录里的相对节点包 import 改成可分发的固定版本 import。
 *
 * 只替换 ImportDeclaration 的字符串字面量，不碰用户文件，也不做正则替换；因此注释、
 * 普通字符串和动态 import 不会被误伤。调用方可以把返回的 source 作为一次性的发布产物。
 *
 * @param {string} source
 * @param {{bySpecifier?: Record<string, object>}} packages scanFlowLocalPackages 的结果
 * @returns {{source:string, dependencies:object[], rewritten:object[]}}
 */
export function rewriteFlowLocalPackageImports(source, packages) {
  const text = String(source || "");
  const ast = acornParse(text, {
    ecmaVersion: 2022,
    sourceType: "module",
    locations: true,
  });
  const replacements = [];
  const byRef = new Map();
  for (const statement of ast.body) {
    if (statement.type !== "ImportDeclaration") continue;
    const specifier = String(statement.source?.value || "");
    const record = packages?.bySpecifier?.[specifier];
    if (specifier.startsWith("./nodes/") && !record) {
      throw new Error(`第 ${Number(statement.loc?.start?.line) || 0} 行：节点包不存在或声明无效 ${specifier}`);
    }
    if (!record) continue;
    const marketplaceRef = String(record.marketplaceRef || "").trim();
    const parsed = parseMarketplaceDefinitionId(marketplaceRef);
    if (!parsed?.id || !parsed.version) {
      throw new Error(`${specifier} 没有可发布的固定版本 marketplaceRef`);
    }
    replacements.push({
      start: statement.source.start,
      end: statement.source.end,
      value: JSON.stringify(marketplaceRef),
      specifier,
      marketplaceRef,
      line: Number(statement.loc?.start?.line) || 0,
    });
    byRef.set(marketplaceRef, {
      id: parsed.id,
      version: parsed.version,
      specifier: marketplaceRef,
      line: Number(statement.loc?.start?.line) || 0,
      packageDir: record.packageDir || "",
    });
  }
  let portable = text;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    portable = `${portable.slice(0, replacement.start)}${replacement.value}${portable.slice(replacement.end)}`;
  }
  return {
    source: portable,
    dependencies: [...byRef.values()].sort((a, b) => a.specifier.localeCompare(b.specifier)),
    rewritten: replacements
      .sort((a, b) => a.start - b.start)
      .map(({ specifier, marketplaceRef, line }) => ({ specifier, marketplaceRef, line })),
  };
}

/** 包没写 baseDefinitionId 时按什么算——和 catalog 面板那边同一套回落。 */
function baseDefinitionIdOf(manifest) {
  return String(manifest.baseDefinitionId || manifest.runtime?.type || "tool_nodejs").trim();
}

/**
 * 扫 `<flowDir>/nodes/*`。
 *
 * @param {string} flowDir
 * @returns {{ bySpecifier: Record<string, object>, byRef: Record<string, object>, list: object[] }}
 */
export function scanFlowLocalPackages(flowDir) {
  const bySpecifier = {};
  const byRef = {};
  const list = [];
  const root = path.join(String(flowDir || ""), "nodes");
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { bySpecifier, byRef, list };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    if (!isNodePackageDir(dir)) continue;
    let manifest = null;
    try {
      // 只认 index.mjs 的静态声明；node.yaml 的老包由 marketplace 那条路负责
      manifest = readNodePackageManifest(dir, () => null);
    } catch {
      manifest = null;
    }
    if (!manifest?.id) continue;
    const record = {
      id: manifest.id,
      version: String(manifest.version || ""),
      dirName: entry.name,
      packageDir: dir,
      specifier: `./nodes/${entry.name}`,
      marketplaceRef: manifest.definitionId || `marketplace:${manifest.id}@${manifest.version}`,
      baseDefinitionId: baseDefinitionIdOf(manifest),
      input: manifest.input || slotMapToList({}, "input"),
      output: manifest.output || slotMapToList({}, "output"),
    };
    bySpecifier[record.specifier] = record;
    bySpecifier[`${record.specifier}/index.mjs`] = record;
    byRef[record.marketplaceRef] = record;
    list.push(record);
  }
  return { bySpecifier, byRef, list };
}

/**
 * Resolve both flow-local packages and packages installed in the workspace
 * marketplace. The latter use `marketplace:<id>@<version>` as their DSL import
 * specifier, so package identity is present in workspace.flow.js itself.
 */
export function scanAvailableNodePackages(flowDir, workspaceRoot = "") {
  const local = scanFlowLocalPackages(flowDir);
  if (!workspaceRoot) return local;
  const bySpecifier = {};
  const byRef = {};
  const list = [];
  for (const manifest of listMarketplaceNodes(workspaceRoot)) {
    const marketplaceRef = manifest.definitionId || `marketplace:${manifest.id}@${manifest.version}`;
    const record = {
      id: manifest.id,
      version: String(manifest.version || ""),
      dirName: manifest.id,
      specifier: marketplaceRef,
      marketplaceRef,
      baseDefinitionId: baseDefinitionIdOf(manifest),
      input: manifest.input || slotMapToList({}, "input"),
      output: manifest.output || slotMapToList({}, "output"),
      source: manifest.source || "marketplace",
    };
    bySpecifier[record.specifier] = record;
    byRef[record.marketplaceRef] = record;
    list.push(record);
  }
  // A flow-local package intentionally wins over an installed package with the
  // same id/version; runtime resolution follows the same order.
  Object.assign(bySpecifier, local.bySpecifier);
  Object.assign(byRef, local.byRef);
  const localRefs = new Set(local.list.map((item) => item.marketplaceRef));
  return {
    bySpecifier,
    byRef,
    list: [...list.filter((item) => !localRefs.has(item.marketplaceRef)), ...local.list],
  };
}

/** 给 `parseFlowSource` 用的 import 解析器。 */
export function packageResolverFor(packages) {
  return (specifier) => packages.bySpecifier[String(specifier || "")] || null;
}

/**
 * 给 `generateFlowSource` 用的 `opts.packages`：nodeId -> 包。
 * 本地包写相对 import，已安装包写 `marketplace:<id>@<version>` import。
 */
export function packageBindingsForGraph(graph, packages) {
  const out = {};
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  const used = new Set();
  for (const [nodeId, instance] of Object.entries(instances)) {
    const ref = String(instance?.marketplaceRef || "").trim();
    const record = ref ? packages.byRef[ref] : null;
    if (!record) continue;
    let binding = safeBindingName(record.dirName);
    while (used.has(binding)) binding = `${binding}_`;
    used.add(binding);
    out[nodeId] = { ...record, binding };
  }
  return out;
}

/** `count-lines` -> `countLines`；保证是合法且不与 API 命名空间撞车的标识符。 */
const RESERVED_BINDINGS = new Set([
  "agent", "control", "display", "file", "flow", "provide", "tool", "workspace",
]);

export function safeBindingName(dirName) {
  const camel = String(dirName || "node")
    .replace(/[^A-Za-z0-9]+(.)?/g, (_, ch) => (ch ? ch.toUpperCase() : ""))
    .replace(/^[^A-Za-z_$]+/, "");
  const base = camel || "node";
  return RESERVED_BINDINGS.has(base) ? `${base}Node` : base;
}
