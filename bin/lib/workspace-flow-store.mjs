/**
 * Workspace 图的磁盘表示。
 *
 * 设计态的**权威格式是代码**：
 *
 * ```
 * workspace.flow.js       图结构——节点、连线、作者写的内容（受限 ESM，静态解析）
 * workspace.layout.json   画布状态——坐标、尺寸、引脚显隐与顺序
 * workspace.nodes.json    代码里说不清的——粘贴的图片、model、marketplaceRef、外置文件清单
 * prompts/ docs/ scripts/ 超过 3 KB 的长文本
 * workspace.state.json    运行态——由 workspace-state.mjs 负责，这里不碰
 * ```
 *
 * `workspace.graph.json` 降级为**只读的历史格式**：没有 `workspace.flow.js` 时按它读，
 * 下一次写入自动迁移成代码。迁移不是无条件的——`writeWorkspaceDesign` 会先把生成的代码
 * 解析回来跟原图逐字段比对，比不上就**退回写 JSON**。宁可不迁移，也不能因为 DSL 表达不了
 * 某个字段就把它悄悄弄丢。
 */
import fs from "fs";
import path from "path";

import {
  FLOW_LAYOUT_FILENAME,
  FLOW_NODES_FILENAME,
  FLOW_SOURCE_FILENAME,
  flowFilesToGraph,
  graphToFlowFiles,
} from "./flow-dsl/index.mjs";
import { definitionOf } from "./flow-dsl/defs.mjs";
import { NODE_META_KEYS } from "./flow-dsl/ir.mjs";
import {
  WORKSPACE_STATE_FILENAME,
  isEmptyWorkspaceState,
  mergeWorkspaceState,
  splitWorkspaceGraph,
} from "./workspace-state.mjs";

export const WORKSPACE_GRAPH_FILENAME = "workspace.graph.json";
export { FLOW_SOURCE_FILENAME, FLOW_LAYOUT_FILENAME, FLOW_NODES_FILENAME };

/** 外置长文本只会落在这几个目录里；清理陈旧文件时不越界。 */
export const EXTERNAL_DIRS = ["prompts", "docs", "scripts"];

/**
 * 流程目录里由运行产生、不属于流程本身的文件（相对路径 glob）。
 *
 * 分享 / 发布一张流程图时必须排掉：这些文件每跑一次就变一次，而且装的是上一次运行的
 * 真实产出——业务数据、接口返回、agent 写的正文。把它们打进 Hub 包等于顺手把内网内容
 * 发出去。判断只看路径，不看内容，所以调用方不需要读文件。
 */
export const RUNTIME_ARTIFACT_GLOBS = [
  WORKSPACE_STATE_FILENAME,
  "nodes/*/history.md",
];

/** 相对路径是不是运行产物。`glob` 里只支持单层 `*`，够用且不会误伤。 */
export function isRuntimeArtifactPath(relPath) {
  const rel = String(relPath || "").replace(/\\/g, "/").replace(/^\.\//, "");
  return RUNTIME_ARTIFACT_GLOBS.some((glob) => {
    const pattern = new RegExp(`^${glob.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")}$`);
    return pattern.test(rel);
  });
}

/** 三个结构文件——文件浏览器里当作机器产物处理。 */
export const WORKSPACE_DESIGN_FILENAMES = [
  FLOW_SOURCE_FILENAME,
  FLOW_LAYOUT_FILENAME,
  FLOW_NODES_FILENAME,
  WORKSPACE_GRAPH_FILENAME,
];

/** `workspace.flow.js` 解析失败。必须炸到调用方——静默当空图会在下一次保存时清空整张流程。 */
export class WorkspaceFlowParseError extends Error {
  constructor(message, filePath) {
    super(message);
    this.name = "WorkspaceFlowParseError";
    this.filePath = filePath;
  }
}

function readJsonFile(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  try {
    const raw = fs.readFileSync(file, "utf-8");
    if (!raw.trim()) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeTextAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, text, "utf-8");
  fs.renameSync(tmp, file);
}

function readTextOrNull(file) {
  try {
    return fs.readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

export function emptyDesignGraph() {
  return { version: 1, instances: {}, edges: [], ui: { nodePositions: {} } };
}

function normalizeDesignShape(raw) {
  const graph = raw && typeof raw === "object" ? raw : {};
  return {
    version: Number(graph.version) || 1,
    instances:
      graph.instances && typeof graph.instances === "object" && !Array.isArray(graph.instances)
        ? graph.instances
        : {},
    edges: Array.isArray(graph.edges) ? graph.edges : [],
    ui: graph.ui && typeof graph.ui === "object" ? graph.ui : { nodePositions: {} },
  };
}

/** `file("prompts/x.md")` 引用的外置文本：把三个目录下的文件都读进来，解析时按引用取用。 */
function collectExternalFiles(dir) {
  const files = {};
  for (const sub of EXTERNAL_DIRS) {
    const abs = path.join(dir, sub);
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const text = readTextOrNull(path.join(abs, entry.name));
      if (text !== null) files[`${sub}/${entry.name}`] = text;
    }
  }
  return files;
}

// ── 往返比对 ────────────────────────────────────────────────────────────────
// 逐字段规范化后深比。规范化只抹平「表示差异」（键顺序、`undefined` / `null` / `""`
// 三种缺省写法、role: normal 等价于没写），不抹平任何有意义的内容——否则这道闸门就白设了。

const asText = (value) => (value === undefined || value === null ? "" : String(value));

/**
 * 槽的 showOnNode / required 缺省时继承定义表——`hydrateWorkspaceSlotMetaFromDefinitions`
 * 在图进入运行时前就会把它们补齐，所以「没写」和「写了定义表里的那个值」是同一件事。
 * 比对时先解析到同一基准，否则老 UI 存的、缺这两个键的图会被判成往返失败。
 */
function resolveSlotMeta(slot, defSlot, key) {
  if (slot && key in slot) return slot[key] === true;
  return defSlot ? defSlot[key] === true : false;
}

function normalizeSlot(slot, defSlot) {
  const s = slot && typeof slot === "object" ? slot : {};
  return {
    name: asText(s.name),
    type: asText(s.type),
    value: asText(s.value ?? s.default ?? ""),
    description: asText(s.description),
    showOnNode: resolveSlotMeta(s, defSlot, "showOnNode"),
    required: resolveSlotMeta(s, defSlot, "required"),
  };
}

function normalizeInstance(instance) {
  const inst = instance && typeof instance === "object" ? instance : {};
  const def = definitionOf(asText(inst.definitionId));
  const defSlot = (kind, name) => def[kind].find((s) => s.name === name) || null;
  const out = {
    definitionId: asText(inst.definitionId),
    label: asText(inst.label),
    role: asText(inst.role) === "normal" ? "" : asText(inst.role),
    body: asText(inst.body),
    script: asText(inst.script),
    scriptRef: asText(inst.scriptRef),
    globalContext: inst.globalContext === true,
    images: inst.images === undefined || inst.images === null ? null : inst.images,
    input: (Array.isArray(inst.input) ? inst.input : []).map((s) => normalizeSlot(s, defSlot("input", asText(s?.name)))),
    output: (Array.isArray(inst.output) ? inst.output : []).map((s) => normalizeSlot(s, defSlot("output", asText(s?.name)))),
  };
  for (const key of NODE_META_KEYS) out[key] = asText(inst[key]);
  return out;
}

function normalizeUi(ui) {
  const src = ui && typeof ui === "object" ? ui : {};
  const out = {};
  for (const key of Object.keys(src).sort()) {
    const value = src[key];
    if (value === undefined || value === null) continue;
    if ((key === "nodePositions" || key === "nodeSizes") && !Object.keys(value).length) continue;
    out[key] = value;
  }
  return out;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** 设计态图的规范化指纹。两张图指纹相同 = 语义上是同一张图。 */
export function designFingerprint(graph) {
  const design = normalizeDesignShape(graph);
  const instances = {};
  for (const id of Object.keys(design.instances).sort()) {
    instances[id] = normalizeInstance(design.instances[id]);
  }
  const edges = design.edges
    .filter((e) => e && design.instances[e.source] && design.instances[e.target])
    .map((e) => `${e.source}|${asText(e.sourceHandle)}|${e.target}|${asText(e.targetHandle)}`)
    .sort();
  return stableStringify({ instances, edges: [...new Set(edges)], ui: normalizeUi(design.ui) });
}

// ── 读 ──────────────────────────────────────────────────────────────────────

/**
 * 读一个流程目录的设计态图。
 *
 * @param {string} flowDir
 * @returns {{ format: "dsl"|"json"|"empty", path: string, graph: object, source: string|null }}
 * @throws {WorkspaceFlowParseError} `workspace.flow.js` 存在但解析不出图
 */
export function readWorkspaceDesign(flowDir) {
  const dir = path.resolve(flowDir);
  const sourcePath = path.join(dir, FLOW_SOURCE_FILENAME);
  const source = readTextOrNull(sourcePath);
  if (source !== null && source.trim()) {
    let graph;
    try {
      graph = flowFilesToGraph({
        source,
        layout: readJsonFile(path.join(dir, FLOW_LAYOUT_FILENAME), { nodes: {} }),
        nodeMeta: readJsonFile(path.join(dir, FLOW_NODES_FILENAME), { nodes: {} }),
        files: collectExternalFiles(dir),
      });
    } catch (e) {
      throw new WorkspaceFlowParseError(
        `${FLOW_SOURCE_FILENAME} 解析失败：${(e && e.message) || String(e)}`,
        sourcePath,
      );
    }
    return { format: "dsl", path: sourcePath, graph: normalizeDesignShape(graph), source };
  }

  const graphPath = path.join(dir, WORKSPACE_GRAPH_FILENAME);
  const rawJson = readTextOrNull(graphPath);
  if (rawJson !== null && rawJson.trim()) {
    return { format: "json", path: graphPath, graph: normalizeDesignShape(JSON.parse(rawJson)), source: null };
  }

  return { format: "empty", path: sourcePath, graph: emptyDesignGraph(), source: null };
}

// ── 写 ──────────────────────────────────────────────────────────────────────

function resolveInsideDir(dir, rel) {
  const abs = path.resolve(dir, rel);
  const prefix = dir.endsWith(path.sep) ? dir : dir + path.sep;
  return abs.startsWith(prefix) ? abs : null;
}

/**
 * 删掉上一次生成、这一次不再需要的外置文本（body 缩短到阈值以下、节点被删）。
 *
 * 清单来自 `workspace.nodes.json` 的 `externals`，只删「我们自己写过的」——不靠文件名
 * 猜测，免得误删 `scripts/` 下作者手写的脚本。清单本身可能被人改过，逐条做目录归属检查。
 */
function pruneStaleExternals(dir, previous, keep) {
  if (!Array.isArray(previous)) return [];
  const removed = [];
  for (const rel of previous) {
    if (typeof rel !== "string" || keep.has(rel)) continue;
    if (!EXTERNAL_DIRS.includes(rel.split("/")[0])) continue;
    const abs = resolveInsideDir(dir, rel);
    if (!abs || !fs.existsSync(abs)) continue;
    try {
      fs.rmSync(abs, { force: true });
      removed.push(rel);
    } catch {
      /* 删不掉就留着，是垃圾文件，不是错误 */
    }
  }
  return removed;
}

/**
 * 写设计态图。
 *
 * 顺序是有讲究的：**先落外置文本，再落 `workspace.flow.js`**。反过来的话，中途失败会留下
 * 一个引用着不存在文件的流程文件，下次读直接炸；现在这个顺序最坏也只是多几个没人引用的文件。
 *
 * 返回的 `design` 是**落盘之后再读回来的那张图**，不是传进来的那张。代码化会做规范化
 * （槽位补齐、`role: normal` 省掉、槽序归位），调用方拿它去算 revision 才和下一次 GET
 * 对得上——不然客户端存完手里就攥着一个磁盘上根本不存在的版本号。
 *
 * @param {string} flowDir
 * @param {object} designGraph 设计态图（运行态请先用 splitWorkspaceGraph 摘掉）
 * @returns {{ format: "dsl"|"json", changed: boolean, degradedReason: string|null, externals: string[], design: object }}
 */
export function writeWorkspaceDesign(flowDir, designGraph) {
  const dir = path.resolve(flowDir);
  fs.mkdirSync(dir, { recursive: true });
  const design = normalizeDesignShape(designGraph);

  const sourcePath = path.join(dir, FLOW_SOURCE_FILENAME);
  const layoutPath = path.join(dir, FLOW_LAYOUT_FILENAME);
  const nodesPath = path.join(dir, FLOW_NODES_FILENAME);
  const graphPath = path.join(dir, WORKSPACE_GRAPH_FILENAME);

  let generated = null;
  let persisted = null;
  let degradedReason = null;
  try {
    generated = graphToFlowFiles(design);
  } catch (e) {
    degradedReason = `代码生成失败：${(e && e.message) || String(e)}`;
  }

  if (generated) {
    // 生成的代码必须能原样解析回同一张图，否则这次不迁移
    try {
      persisted = flowFilesToGraph({
        source: generated.source,
        layout: generated.layout,
        nodeMeta: generated.nodeMeta,
        files: Object.fromEntries(generated.files.map((f) => [f.path, f.text])),
      });
      if (designFingerprint(persisted) !== designFingerprint(design)) {
        degradedReason = "生成的代码解析回来与原图不一致";
      }
    } catch (e) {
      degradedReason = `生成的代码解析不回来：${(e && e.message) || String(e)}`;
    }
  }

  if (degradedReason) {
    // 退回历史格式。此时绝不能留下 workspace.flow.js——它的优先级更高，留着就等于让残缺的
    // 那张图接管。
    for (const file of [sourcePath, layoutPath, nodesPath]) fs.rmSync(file, { force: true });
    writeTextAtomic(graphPath, `${JSON.stringify(design, null, 2)}\n`);
    return { format: "json", changed: true, degradedReason, externals: [], design };
  }

  const externals = generated.files.map((f) => f.path).sort();
  const nodeMeta = { ...generated.nodeMeta };
  if (externals.length) nodeMeta.externals = externals;
  const layoutText = `${JSON.stringify(generated.layout, null, 2)}\n`;
  const nodesText = `${JSON.stringify(nodeMeta, null, 2)}\n`;
  const wantNodesFile = Object.keys(generated.nodeMeta.nodes || {}).length > 0 || externals.length > 0;

  const unchanged =
    readTextOrNull(sourcePath) === generated.source
    && readTextOrNull(layoutPath) === layoutText
    && readTextOrNull(nodesPath) === (wantNodesFile ? nodesText : null)
    && !fs.existsSync(graphPath)
    && generated.files.every((f) => readTextOrNull(path.join(dir, f.path)) === f.text);
  if (unchanged) return { format: "dsl", changed: false, degradedReason: null, externals, design: persisted };

  const previousExternals = readJsonFile(nodesPath, {}).externals;

  for (const file of generated.files) {
    const abs = resolveInsideDir(dir, file.path);
    if (!abs) continue;
    if (readTextOrNull(abs) !== file.text) writeTextAtomic(abs, file.text);
  }
  writeTextAtomic(sourcePath, generated.source);
  writeTextAtomic(layoutPath, layoutText);
  if (wantNodesFile) writeTextAtomic(nodesPath, nodesText);
  else fs.rmSync(nodesPath, { force: true });

  pruneStaleExternals(dir, previousExternals, new Set(externals));
  // 迁移完成：历史格式退场。往返已经逐字段比对过，这里删的是一份可以再生成的副本。
  fs.rmSync(graphPath, { force: true });

  return { format: "dsl", changed: true, degradedReason: null, externals, design: persisted };
}

// ── 完整图（设计态 + 运行态）────────────────────────────────────────────────

/** 运行态损坏不该让整张图打不开——产出重跑就有，设计态才是不可再生的。 */
function readWorkspaceStateFile(dir) {
  const parsed = readJsonFile(path.join(dir, WORKSPACE_STATE_FILENAME), null);
  return parsed && !Array.isArray(parsed) ? parsed : null;
}

/** 读回合并了运行态的完整图。 */
export function readWorkspaceGraphFiles(flowDir) {
  const dir = path.resolve(flowDir);
  const design = readWorkspaceDesign(dir);
  if (design.format === "empty") return { ...design, graph: emptyDesignGraph() };
  return { ...design, graph: mergeWorkspaceState(design.graph, readWorkspaceStateFile(dir)) };
}

/**
 * 写一张完整图：运行态进 `workspace.state.json`，设计态进代码。
 *
 * 先落运行态再落设计态——中途失败时设计态仍是上一版，不会出现「新设计 + 空运行态」
 * 这种展示节点内容凭空消失的组合。
 */
export function writeWorkspaceGraphFiles(flowDir, graph) {
  const dir = path.resolve(flowDir);
  fs.mkdirSync(dir, { recursive: true });
  const statePath = path.join(dir, WORKSPACE_STATE_FILENAME);
  const { design, state } = splitWorkspaceGraph(graph);
  if (isEmptyWorkspaceState(state)) fs.rmSync(statePath, { force: true });
  else writeTextAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`);
  const result = writeWorkspaceDesign(dir, design);
  // `graph` 是落盘之后读回来会拿到的那张完整图。调用方用它算 revision，客户端手里的
  // 版本号才和磁盘一致。
  return { ...result, graph: mergeWorkspaceState(result.design, state) };
}
