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

import { isNodePackageDir, readNodePackageManifest, slotMapToList } from "../node-package-manifest.mjs";

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

/** 给 `parseFlowSource` 用的 import 解析器。 */
export function packageResolverFor(packages) {
  return (specifier) => packages.bySpecifier[String(specifier || "")] || null;
}

/**
 * 给 `generateFlowSource` 用的 `opts.packages`：nodeId -> 包。
 * 只有解析得到**流程本地**包的实例才走 import 形式；已发布到 marketplace 的包没有本地
 * 路径可 import，继续按基础类型渲染，引用信息留在 nodes.json 里。
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
