/**
 * `agentflow flow dsl <export|import|lint>` 的实现。
 *
 * export / import 是互逆的，用同一套 IR，所以往返可证；lint 只读，不改任何文件。
 */
import fs from "fs";
import path from "path";

import { WORKSPACE_STATE_FILENAME, mergeWorkspaceState } from "../workspace-state.mjs";
import {
  FLOW_LAYOUT_FILENAME,
  FLOW_NODES_FILENAME,
  FLOW_SOURCE_FILENAME,
  flowFilesToGraph,
  graphToFlowFiles,
} from "./index.mjs";
import { lintFlowDir } from "./lint.mjs";
import { readWorkspaceGraphFiles, writeWorkspaceGraphFiles } from "../workspace-flow-store.mjs";

const GRAPH_FILENAME = "workspace.graph.json";

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

/**
 * 把一个流程目录就地迁移成代码形态：`workspace.graph.json` -> `workspace.flow.js` + 伴生文件。
 *
 * 走的是 Web UI 保存时的同一条路径（`writeWorkspaceDesign`），因此同样带往返比对闸门：
 * 生成的代码解析不回原图就不迁移，原文件原样留着。
 *
 * @returns {{ flowDir: string, format: "dsl"|"json", migrated: boolean, degradedReason: string|null, externals: string[] }}
 */
export function migrateFlowDirToDsl(flowDir) {
  const dir = path.resolve(flowDir);
  const current = readWorkspaceGraphFiles(dir);
  if (current.format === "empty") {
    return { flowDir: dir, format: "empty", migrated: false, degradedReason: null, externals: [] };
  }
  if (current.format === "dsl") {
    return { flowDir: dir, format: "dsl", migrated: false, degradedReason: null, externals: [] };
  }
  // 走完整图这条路：历史 graph.json 里运行产出还是内联的，得先拆出去，否则那些每跑一次
  // 就变一次的值会被当成设计态参与往返比对
  const result = writeWorkspaceGraphFiles(dir, current.graph);
  return {
    flowDir: dir,
    format: result.format,
    migrated: result.format === "dsl",
    degradedReason: result.degradedReason,
    externals: result.externals,
  };
}

export { lintFlowDir };
