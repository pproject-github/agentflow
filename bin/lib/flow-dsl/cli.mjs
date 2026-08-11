/**
 * `agentflow flow dsl <export|import|lint>` 的实现。
 *
 * export / import 是互逆的，用同一套 IR，所以往返可证；lint 只读，不改任何文件。
 */
import fs from "fs";
import os from "os";
import path from "path";

import { WORKSPACE_STATE_FILENAME, mergeWorkspaceState } from "../workspace-state.mjs";
import {
  FLOW_LAYOUT_FILENAME,
  FLOW_NODES_FILENAME,
  FLOW_SOURCE_FILENAME,
  flowFilesToGraph,
  graphToFlowFiles,
} from "./index.mjs";
import { legacyYamlToDesignGraph } from "./legacy-yaml.mjs";
import { lintFlowDir } from "./lint.mjs";
import { readWorkspaceGraphFiles, writeWorkspaceGraphFiles } from "../workspace-flow-store.mjs";

const GRAPH_FILENAME = "workspace.graph.json";
const LEGACY_YAML_FILENAME = "flow.yaml";

function readJson(file, fallback) {
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

function writeFileEnsuringDir(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, "utf-8");
}

/** 读一个流程目录里的完整图（设计态 + 运行态）。 */
function readFullGraph(flowDir) {
  const graphPath = path.join(flowDir, GRAPH_FILENAME);
  if (!fs.existsSync(graphPath)) throw new Error(`找不到 ${graphPath}`);
  const design = JSON.parse(fs.readFileSync(graphPath, "utf-8"));
  return mergeWorkspaceState(design, readJson(path.join(flowDir, WORKSPACE_STATE_FILENAME), null));
}

/**
 * workspace.graph.json -> workspace.flow.js + layout/nodes + 外置长文本。
 * @returns {{ outDir: string, written: string[] }}
 */
export function exportFlowDsl(flowDir, outDir) {
  const graph = readFullGraph(flowDir);
  const out = graphToFlowFiles(graph);
  const target = path.resolve(outDir || flowDir);
  fs.mkdirSync(target, { recursive: true });

  const written = [];
  const put = (rel, text) => {
    writeFileEnsuringDir(path.join(target, rel), text);
    written.push(rel);
  };

  put(FLOW_SOURCE_FILENAME, out.source);
  put(FLOW_LAYOUT_FILENAME, `${JSON.stringify(out.layout, null, 2)}\n`);
  if (Object.keys(out.nodeMeta.nodes).length) {
    put(FLOW_NODES_FILENAME, `${JSON.stringify(out.nodeMeta, null, 2)}\n`);
  }
  for (const file of out.files) put(file.path, file.text);

  return { outDir: target, written };
}

/**
 * workspace.flow.js + layout/nodes -> workspace.graph.json（设计态）。
 * 运行态原样保留在 workspace.state.json 里，不受导入影响。
 */
export function importFlowDsl(srcDir, outFlowDir) {
  const dir = path.resolve(srcDir);
  const sourcePath = path.join(dir, FLOW_SOURCE_FILENAME);
  if (!fs.existsSync(sourcePath)) throw new Error(`找不到 ${sourcePath}`);

  const lint = lintFlowDir(dir);
  if (lint.errors.length) {
    throw new Error(`lint 未通过，拒绝导入：\n  ${lint.errors.join("\n  ")}`);
  }

  // file() 引用的外置文本：把目录下所有非结构文件都喂进去，解析时按引用取用
  const files = {};
  const collect = (rel) => {
    const abs = path.join(dir, rel);
    if (!fs.existsSync(abs)) return;
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      if (entry.isDirectory()) continue;
      files[`${rel}/${entry.name}`] = fs.readFileSync(path.join(abs, entry.name), "utf-8");
    }
  };
  for (const sub of ["prompts", "docs", "scripts"]) collect(sub);

  const design = flowFilesToGraph({
    source: fs.readFileSync(sourcePath, "utf-8"),
    layout: readJson(path.join(dir, FLOW_LAYOUT_FILENAME), { nodes: {} }),
    nodeMeta: readJson(path.join(dir, FLOW_NODES_FILENAME), { nodes: {} }),
    files,
  });

  const target = path.resolve(outFlowDir || dir);
  fs.mkdirSync(target, { recursive: true });
  writeFileEnsuringDir(path.join(target, GRAPH_FILENAME), `${JSON.stringify(design, null, 2)}\n`);
  return {
    graphPath: path.join(target, GRAPH_FILENAME),
    nodeCount: Object.keys(design.instances).length,
    edgeCount: design.edges.length,
    warnings: lint.warnings,
  };
}

/** 没有节点丢失时的空损耗清单，让返回值形状始终一致。 */
const NO_LOSS = { remapped: [], dropped: [], droppedEdges: [], warnings: [] };

/**
 * 把一个流程目录就地迁移成代码形态。两个来源：
 *
 * - `workspace.graph.json` —— 同一套词汇表，纯换存储格式，无损
 * - `flow.yaml` —— 老执行栈的词汇表，要换词，**可能有损**
 *
 * 都走 Web UI 保存时的同一条路径（`writeWorkspaceDesign`），因此同样带往返比对闸门：
 * 生成的代码解析不回原图就不迁移，原文件原样留着。
 *
 * yaml 那条路默认**拒绝有损迁移**：只要有节点或边接不过去就停下来把清单报出去，磁盘不动。
 * `allowLoss` 才落盘。理由和存储层那条闸门一样——宁可不迁移，也不能悄悄弄丢。
 *
 * yaml 原文不删。迁移完 `workspace.flow.js` 成为权威（读图先看它），`flow.yaml` 退到
 * 一边当原始材料，出了问题还能对着看。
 *
 * @param {string} flowDir
 * @param {{ force?: boolean }} [opts]
 * @returns {{ flowDir: string, format: "dsl"|"json"|"yaml"|"empty", migrated: boolean,
 *   degradedReason: string|null, externals: string[], source?: "graph.json"|"flow.yaml",
 *   remapped: Array, dropped: Array, droppedEdges: Array, warnings: string[] }}
 */
export function migrateFlowDirToDsl(flowDir, opts = {}) {
  const dir = path.resolve(flowDir);
  const current = readWorkspaceGraphFiles(dir);
  if (current.format === "dsl") {
    return { flowDir: dir, format: "dsl", migrated: false, degradedReason: null, externals: [], ...NO_LOSS };
  }
  if (current.format === "empty") return migrateLegacyYamlDir(dir, opts);

  // 走完整图这条路：历史 graph.json 里运行产出还是内联的，得先拆出去，否则那些每跑一次
  // 就变一次的值会被当成设计态参与往返比对
  const result = writeWorkspaceGraphFiles(dir, current.graph);
  return {
    flowDir: dir,
    format: result.format,
    migrated: result.format === "dsl",
    degradedReason: result.degradedReason,
    externals: result.externals,
    source: "graph.json",
    ...NO_LOSS,
  };
}

/** `flow.yaml` -> 代码。没有 yaml 就是真的没图。 */
function migrateLegacyYamlDir(dir, { force = false } = {}) {
  const yamlPath = path.join(dir, LEGACY_YAML_FILENAME);
  if (!fs.existsSync(yamlPath)) {
    return { flowDir: dir, format: "empty", migrated: false, degradedReason: null, externals: [], ...NO_LOSS };
  }
  const converted = legacyYamlToDesignGraph(fs.readFileSync(yamlPath, "utf-8"));
  const loss = {
    remapped: converted.remapped,
    dropped: converted.dropped,
    droppedEdges: converted.droppedEdges,
    warnings: converted.warnings,
  };
  // `control_end` 和指向它的边标了 benign——丢了等于没丢，不该拦住迁移。
  const lossy = [...converted.dropped, ...converted.droppedEdges].some((x) => !x.benign);
  if (lossy && !force) {
    return {
      flowDir: dir,
      format: "yaml",
      migrated: false,
      degradedReason: "有节点或边接不过去（--allow-loss 忽略并继续）",
      externals: [],
      source: "flow.yaml",
      ...loss,
    };
  }
  const result = writeWorkspaceGraphFiles(dir, converted.graph);
  return {
    flowDir: dir,
    format: result.format,
    migrated: result.format === "dsl",
    // 从 yaml 出发时，退回 JSON 也是**成功**：`workspace.graph.json` 读得出、画得出、
    // 跑得动，而 yaml 三样都不行。够不着代码形态只是差最后一步，不是这次迁移失败。
    leftYaml: true,
    degradedReason: result.degradedReason,
    externals: result.externals,
    source: "flow.yaml",
    ...loss,
  };
}

/**
 * 校验一个流程目录里的 Workspace 图，不管它是代码形态还是历史 JSON。
 *
 * 历史 JSON 的做法是先在临时目录里渲染成代码再 lint——校验的正是它迁移之后会变成的
 * 样子，比「这份 JSON 能不能 parse」有用得多：引脚名、未知节点类型、环、fan-in 这些
 * 问题在两种形态下都一样存在，只有代码形态能查出来。
 *
 * @returns {{ format: "dsl"|"json"|"empty", errors: string[], warnings: string[] }}
 */
export function lintWorkspaceFlowDir(flowDir) {
  const dir = path.resolve(flowDir);
  if (fs.existsSync(path.join(dir, FLOW_SOURCE_FILENAME))) {
    return { format: "dsl", ...lintFlowDir(dir) };
  }

  const current = readWorkspaceGraphFiles(dir);
  if (current.format === "empty") {
    return { format: "empty", errors: [], warnings: ["这个流程还没有 Workspace 图"] };
  }

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-lint-"));
  try {
    const out = graphToFlowFiles(current.graph);
    writeFileEnsuringDir(path.join(staging, FLOW_SOURCE_FILENAME), out.source);
    writeFileEnsuringDir(path.join(staging, FLOW_LAYOUT_FILENAME), `${JSON.stringify(out.layout, null, 2)}\n`);
    writeFileEnsuringDir(path.join(staging, FLOW_NODES_FILENAME), `${JSON.stringify(out.nodeMeta, null, 2)}\n`);
    for (const file of out.files) writeFileEnsuringDir(path.join(staging, file.path), file.text);
    // 代码节点包在原目录里，不复制过去的话每个 import 都会报「节点包不存在」
    const localNodes = path.join(dir, "nodes");
    if (fs.existsSync(localNodes)) fs.cpSync(localNodes, path.join(staging, "nodes"), { recursive: true });
    return { format: "json", ...lintFlowDir(staging) };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

export { lintFlowDir };
