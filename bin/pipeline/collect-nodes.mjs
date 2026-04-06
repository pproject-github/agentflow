#!/usr/bin/env node
/**
 * 收集所有节点（内置 + 当前流水线）的元数据，按 tool_nodejs 约定向 stdout 输出一行 JSON。
 * 用法：agentflow apply -ai collect-nodes <workspaceRoot> <flowName> [runDir]
 * 输出（仅 stdout 一行）：{ "err_code": 0, "message": { "result": "<节点元数据 markdown>" } }；err_code 0=成功 1=失败，无 next。
 * 不写任何文件，由 agentflow apply -ai run-tool-nodejs 根据 message 写入 output。
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import yaml from "js-yaml";

import { LEGACY_NODES_DIR, PIPELINES_DIR, PROJECT_NODES_DIR } from "../lib/paths.mjs";
import { getFlowDir } from "../lib/workspace.mjs";

const __dirnameCollect = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_BUILTIN_NODES_DIR = path.join(path.resolve(__dirnameCollect, "..", ".."), "builtin", "nodes");

function extractFrontmatter(raw) {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---/);
  return m ? m[1] : "";
}

function parseDescription(fm) {
  const match = fm.match(/\bdescription:\s*["']?([^"'\n#][^\n]*)["']?/);
  return match ? match[1].trim().replace(/^["']|["']$/g, "") : "";
}

function parseDisplayName(fm) {
  const match = fm.match(/\bdisplayName:\s*["']?([^"'\n#][^\n]*)["']?/);
  return match ? match[1].trim().replace(/^["']|["']$/g, "") : "";
}

/** 解析 frontmatter 中的 input/output 数组，返回 [{ type, name, defaultOrValue }, ...] */
function parseSlots(fm, key) {
  const slots = [];
  const re = new RegExp(`\\b${key}:\\s*\\n([\\s\\S]*?)(?=\\n[a-zA-Z_][a-zA-Z0-9_]*\\s*:|---|$)`, "m");
  const blockMatch = fm.match(re);
  if (!blockMatch) return slots;
  const block = blockMatch[1];
  let current = {};
  for (const line of block.split("\n")) {
    const typeMatch = line.match(/^\s*-\s+type:\s*["']?([^"'\n]*)["']?/);
    if (typeMatch) {
      if (current.type) slots.push({ ...current });
      current = { type: typeMatch[1].trim() };
      continue;
    }
    const nameMatch = line.match(/^\s+name:\s*["']?([^"'\n]*)["']?/);
    if (nameMatch) {
      current.name = nameMatch[1].trim();
      continue;
    }
    const defaultMatch = line.match(/^\s+(?:default|value):\s*(.*)$/);
    if (defaultMatch) {
      current.defaultOrValue = defaultMatch[1].trim().replace(/^["']|["']$/g, "");
      slots.push({ ...current });
      current = {};
    }
  }
  if (current.type) slots.push({ ...current });
  return slots;
}

function readNodeMeta(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, "utf-8");
    const fm = extractFrontmatter(raw);
    return {
      description: parseDescription(fm),
      displayName: parseDisplayName(fm),
      input: parseSlots(fm, "input"),
      output: parseSlots(fm, "output"),
    };
  } catch {
    return null;
  }
}

/** 从 flow.yaml 的 instances 得到节点列表，每项 { id, label, definitionId, input, output }，input/output 为 [{ type, name, defaultOrValue }] */
function loadFlowYamlNodes(flowDir) {
  const flowPath = path.join(flowDir, "flow.yaml");
  if (!fs.existsSync(flowPath)) return [];
  try {
    const raw = fs.readFileSync(flowPath, "utf-8");
    const data = yaml.load(raw);
    const instances = data?.instances && typeof data.instances === "object" ? data.instances : {};
    return Object.entries(instances).map(([id, inst]) => {
      const inp = Array.isArray(inst.input) ? inst.input : [];
      const out = Array.isArray(inst.output) ? inst.output : [];
      const input = inp.map((s) => ({
        type: (s && s.type != null) ? String(s.type).trim() : "",
        name: (s && s.name != null) ? String(s.name).trim() : "",
        defaultOrValue: (s && (s.value != null || s.default != null)) ? String(s.value ?? s.default ?? "").trim() : "",
      }));
      const output = out.map((s) => ({
        type: (s && s.type != null) ? String(s.type).trim() : "",
        name: (s && s.name != null) ? String(s.name).trim() : "",
        defaultOrValue: (s && (s.value != null || s.default != null)) ? String(s.value ?? s.default ?? "").trim() : "",
      }));
      return {
        id,
        label: (inst.label != null) ? String(inst.label) : id,
        definitionId: (inst.definitionId != null) ? String(inst.definitionId) : id,
        input,
        output,
      };
    });
  } catch (_) {
    return [];
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    const payload = { err_code: 1, message: { result: "Usage: agentflow apply -ai collect-nodes <workspaceRoot> <flowName> [runDir]" } };
    console.log(JSON.stringify(payload));
    process.exit(1);
  }

  const [workspaceRoot, flowName] = args.map((p) => path.resolve(p));
  const nodesDirLegacy = path.join(workspaceRoot, LEGACY_NODES_DIR);
  const nodesDirNew = path.join(workspaceRoot, PROJECT_NODES_DIR);
  const flowDir = getFlowDir(workspaceRoot, flowName) || path.join(workspaceRoot, PIPELINES_DIR, flowName);

  const out = [];

  // 1. 内置节点：包内 builtin/nodes + 项目 .workspace/agentflow/nodes（覆盖旧 .cursor/...），包内同 id 优先
  out.push("# 节点元数据（内置 + 当前流水线）\n");
  out.push("## 1. 内置节点元数据\n\n");
  const builtinFiles = new Map();
  if (fs.existsSync(PACKAGE_BUILTIN_NODES_DIR)) {
    for (const file of fs.readdirSync(PACKAGE_BUILTIN_NODES_DIR).filter((f) => f.endsWith(".md")).sort()) {
      builtinFiles.set(file.replace(/\.md$/, ""), path.join(PACKAGE_BUILTIN_NODES_DIR, file));
    }
  }
  const projectById = new Map();
  const mergeProjectDir = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".md")).sort()) {
      projectById.set(file.replace(/\.md$/, ""), path.join(dir, file));
    }
  };
  mergeProjectDir(nodesDirLegacy);
  mergeProjectDir(nodesDirNew);
  for (const [id, fp] of projectById) {
    if (!builtinFiles.has(id)) builtinFiles.set(id, fp);
  }
  for (const [definitionId, filePath] of builtinFiles) {
    const meta = readNodeMeta(filePath);
    if (!meta) continue;
    out.push(`### ${definitionId}\n`);
    out.push(`- **displayName**: ${meta.displayName || definitionId}\n`);
    out.push(`- **description**: ${meta.description || ""}\n`);
    out.push(`- **input** (handle: input-0, input-1, …):\n`);
    if (meta.input.length) meta.input.forEach((s, i) => out.push(`  - \`${s.name || "?"}\` (${s.type || "?"}) → input-${i}\n`));
    else out.push("  - 无\n");
    out.push(`- **output** (handle: output-0, output-1, …):\n`);
    if (meta.output.length) meta.output.forEach((s, i) => out.push(`  - \`${s.name || "?"}\` (${s.type || "?"}) → output-${i}\n`));
    else out.push("  - 无\n");
    out.push("\n");
  }
  if (builtinFiles.size === 0) out.push("（无内置节点目录）\n");

  // 2. 当前流水线节点（来自 flow.yaml instances）
  out.push("## 2. 当前流水线节点元数据\n\n");
  const flowNodes = loadFlowYamlNodes(flowDir);
  for (const node of flowNodes) {
    const { id, label, definitionId, input: nodeInput, output: nodeOutput } = node;
    let input = nodeInput || [];
    let output = nodeOutput || [];
    if (input.length === 0 && output.length === 0) {
      const tryPaths = [
        path.join(flowDir, "nodes", `${definitionId}.md`),
        path.join(nodesDirNew, `${definitionId}.md`),
        path.join(nodesDirLegacy, `${definitionId}.md`),
        path.join(PACKAGE_BUILTIN_NODES_DIR, `${definitionId}.md`),
      ];
      let meta = null;
      for (const defPath of tryPaths) {
        meta = readNodeMeta(defPath);
        if (meta) break;
      }
      if (meta) {
        input = meta.input;
        output = meta.output;
      }
    }
    out.push(`### ${id}\n`);
    out.push(`- **label**: ${label || id}\n`);
    out.push(`- **definitionId**: ${definitionId || ""}\n`);
    out.push(`- **input** (handle):\n`);
    if (input.length) input.forEach((s, i) => out.push(`  - \`${s.name || "?"}\` (${s.type || "?"}) → input-${i}\n`));
    else out.push("  - 无\n");
    out.push(`- **output** (handle):\n`);
    if (output.length) output.forEach((s, i) => out.push(`  - \`${s.name || "?"}\` (${s.type || "?"}) → output-${i}\n`));
    else out.push("  - 无\n");
    out.push("\n");
  }

  const content = out.join("");
  const payload = {
    err_code: 0,
    message: { result: content },
  };
  console.log(JSON.stringify(payload));
}

main();
