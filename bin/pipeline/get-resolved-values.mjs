#!/usr/bin/env node
/**
 * 获取指定 instance 的 resolvedInputs、resolvedOutputs、systemPrompt，用于占位符替换。
 * systemPrompt 来自 instance 或 node 定义的 description，占位符 ${input.xxx}、${output.xxx}、${xxx} 会被替换。
 * 用法：node get-resolved-values.mjs <workspaceRoot> <flowName> <uuid> <instanceId>
 * 输出（stdout JSON）：{ "ok": true, "resolvedInputs": {...}, "resolvedOutputs": {...}, "systemPrompt": "..." }
 */

import fs from "fs";
import path from "path";

import { getRunDir, LEGACY_NODES_DIR, PIPELINES_DIR, PROJECT_NODES_DIR } from "../lib/paths.mjs";
import { getFlowDir } from "../lib/workspace.mjs";
import { fileURLToPath } from "url";

const __dirnameResolved = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_BUILTIN_NODES_DIR = path.join(path.resolve(__dirnameResolved, "..", ".."), "builtin", "nodes");

import { loadFlowDefinition } from "./parse-flow.mjs";
import { loadAllExecIds, outputDirForNode } from "./get-exec-id.mjs";
import { computeResolvedInputsForInstance } from "./resolve-inputs.mjs";

/** 仅多行标记（无实际内容）时视为空，应回退到节点定义的 description */
function isEmptyDescription(v) {
  if (!v || typeof v !== "string") return true;
  const t = v.trim();
  return t === "|" || t === ">" || /^[|>]\s*$/.test(t);
}

/** 解析 frontmatter（如 instance .md），支持 description 多行（| / >）。当前仅 flow.yaml instances 生效，此函数保留供复用。 */
function parseFrontmatter(raw) {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return {};
  const fm = m[1];
  const data = {};
  const lines = fm.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*definitionId:\s*(.*)$/.test(line)) {
      const v = line.replace(/^\s*definitionId:\s*/, "").replace(/^["']|["']$/g, "").trim();
      data.definitionId = v;
      continue;
    }
    const descMatch = line.match(/^\s*description:\s*(.+)$/);
    if (descMatch) {
      const rest = descMatch[1].replace(/^["']|["']$/g, "").trim();
      if (rest === "|" || rest === ">" || /^[|>]\s*$/.test(rest)) {
        const keyIndent = line.search(/\S/);
        const contentLines = [];
        for (let j = i + 1; j < lines.length; j++) {
          const contentLine = lines[j];
          if (contentLine.trim() === "") {
            contentLines.push("");
            continue;
          }
          const lineIndent = contentLine.search(/\S/);
          if (lineIndent <= keyIndent) break;
          contentLines.push(lineIndent >= 0 ? contentLine.slice(lineIndent) : contentLine);
        }
        data.description = contentLines.join("\n").trim();
      } else if (rest) {
        data.description = rest;
      }
      continue;
    }
  }
  return data;
}

/**
 * 从 frontmatter 文本中解析 description 字段，支持单行与 YAML 多行（| 或 >）。
 * @param {string} frontmatter - --- 与 --- 之间的内容（不含首尾 ---）
 * @returns {string}
 */
function extractDescriptionFromFrontmatter(frontmatter) {
  const lines = frontmatter.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const singleLineMatch = line.match(/^\s*description:\s*(.+)$/);
    if (singleLineMatch) {
      const rest = singleLineMatch[1].replace(/^["']|["']$/g, "").trim();
      // 多行标记：仅 "|" 或 ">" 或带空格的 "| " / "> "
      if (rest === "|" || rest === ">" || /^[|>]\s*$/.test(rest)) {
        const keyIndent = line.search(/\S/);
        const contentLines = [];
        for (let j = i + 1; j < lines.length; j++) {
          const contentLine = lines[j];
          if (contentLine.trim() === "") {
            contentLines.push("");
            continue;
          }
          const lineIndent = contentLine.search(/\S/);
          if (lineIndent <= keyIndent && contentLine.trim() !== "") break;
          contentLines.push(lineIndent >= 0 ? contentLine.slice(lineIndent) : contentLine);
        }
        return contentLines.join("\n").trim();
      }
      if (rest) return rest;
    }
  }
  return "";
}

function readNodeDescription(workspaceRoot, flowDir, definitionId) {
  const fileName = definitionId.endsWith(".md") ? definitionId : `${definitionId}.md`;
  const flowNodesPath = path.join(flowDir, "nodes", fileName);
  const projectNodesNew = path.join(workspaceRoot, PROJECT_NODES_DIR, fileName);
  const projectNodesLegacy = path.join(workspaceRoot, LEGACY_NODES_DIR, fileName);
  const packageNodesPath = path.join(PACKAGE_BUILTIN_NODES_DIR, fileName);
  for (const p of [flowNodesPath, projectNodesNew, projectNodesLegacy, packageNodesPath]) {
    try {
      const raw = fs.readFileSync(p, "utf-8");
      const m = raw.match(/^---\s*\n([\s\S]*?)\n---/);
      if (!m) continue;
      const v = extractDescriptionFromFrontmatter(m[1]);
      if (v) return v;
    } catch (_) {}
  }
  return "";
}

/**
 * 输出槽 slot 名对应的目标输出路径（run 目录内相对路径），固定文件名不含 _execId。
 * 约定：output/<instanceId>/node_<instanceId>_<base>.<ext>
 */
export function getOutputPathForSlot(instanceId, execId, slotName) {
  const base = slotName.replace(/\.(md|txt|json|html?)$/i, "") || slotName;
  const ext = (slotName.match(/\.(md|txt|json|html?)$/i) || ["", "md"])[1];
  return `${outputDirForNode(instanceId)}/node_${instanceId}_${base}.${ext}`;
}

function resolvePlaceholdersInText(
  text,
  resolvedInputs,
  resolvedOutputs,
  opts = {},
) {
  if (!text || typeof text !== "string") return "";
  const { instanceId, runDir } = opts;
  const toAbs = (rel) => (runDir && rel ? path.join(runDir, rel) : rel);
  return text.replace(/\$\{([^}]+)\}/g, (_, key) => {
    const k = key.trim();
    if (k.startsWith("input.")) {
      const slot = k.slice(6);
      return resolvedInputs[slot] ?? resolvedInputs._ ?? "";
    }
    if (k.startsWith("output.")) {
      const slot = k.slice(7);
      const v = resolvedOutputs[slot] ?? resolvedOutputs._ ?? "";
      if (v) return v;
      if (instanceId && slot in resolvedOutputs && opts.currentExecId != null) {
        return toAbs(getOutputPathForSlot(instanceId, opts.currentExecId, slot));
      }
      if (instanceId && slot in resolvedOutputs) {
        return toAbs(getOutputPathForSlot(instanceId, 1, slot));
      }
      return "";
    }
    let v = resolvedInputs[k] ?? resolvedOutputs[k] ?? "";
    // 兼容槽位名带 .md 等后缀：如模板写 ${message}，resolved 里可能是 message.md
    if (!v && !k.includes(".")) {
      v = resolvedInputs[k + ".md"] ?? resolvedOutputs[k + ".md"] ?? "";
    }
    if (!v && instanceId && (k in resolvedOutputs || (k + ".md") in resolvedOutputs)) {
      const slot = k in resolvedOutputs ? k : k + ".md";
      v = toAbs(getOutputPathForSlot(instanceId, opts.currentExecId ?? 1, slot));
    }
    return v;
  });
}

/**
 * 获取指定 instance 的 resolvedInputs、resolvedOutputs、systemPrompt。
 * @returns {{ ok: boolean, resolvedInputs?: object, resolvedOutputs?: object, systemPrompt?: string, error?: string }}
 */
export function getResolvedValues(workspaceRoot, flowName, uuid, instanceId) {
  const runDir = getRunDir(workspaceRoot, flowName, uuid);
  const flowJsonPath = path.join(runDir, "intermediate", "flow.json");

  if (!fs.existsSync(flowJsonPath)) {
    return { ok: false, error: `flow.json not found: ${flowJsonPath}. Run parse-flow.mjs first.` };
  }

  try {
    const flow = JSON.parse(fs.readFileSync(flowJsonPath, "utf-8"));
    if (!flow.ok) {
      return { ok: false, error: flow.error || "flow.json indicates error" };
    }

    let flowDir = getFlowDir(workspaceRoot, flowName) || path.join(workspaceRoot, PIPELINES_DIR, flowName);
    if (flow.flowDir && typeof flow.flowDir === "string" && flow.flowDir.trim()) {
      flowDir = path.isAbsolute(flow.flowDir) ? flow.flowDir : path.join(workspaceRoot, flow.flowDir);
    }
    const raw = computeResolvedInputsForInstance(workspaceRoot, flowName, uuid, instanceId);
    if (!raw.ok) {
      return { ok: false, error: raw.error || "computeResolvedInputsForInstance failed" };
    }
    let resolvedInputs = raw.resolvedInputs || {};

    const runDirRel = path.join(".workspace", "agentflow", "runBuild", flowName, uuid);

    const order = flow.order || [];
    const execIds = loadAllExecIds(workspaceRoot, flowName, uuid, order);
    const currentExecId = execIds[instanceId] ?? 1;

    // 当前节点 output 路径从结构（outputSlotTypes / nodes）得到槽名，固定路径不含 _execId；拼入 prompt 时使用绝对路径
    const resolvedOutputs = {};
    const outSlotNames = (flow.outputSlotTypes && flow.outputSlotTypes[instanceId])
      ? Object.keys(flow.outputSlotTypes[instanceId])
      : [];
    for (const slotName of outSlotNames) {
      const rel = getOutputPathForSlot(instanceId, currentExecId, slotName);
      resolvedOutputs[slotName] = path.join(runDir, rel);
    }
    if (Object.keys(resolvedOutputs).length === 0 && order.includes(instanceId)) {
      const node = flow.nodes?.find((n) => n.id === instanceId);
      const outSlots = node?.output || flow.outputSlotTypes?.[instanceId];
      if (outSlots && typeof outSlots === "object") {
        for (const slotName of Object.keys(outSlots)) {
          const rel = getOutputPathForSlot(instanceId, currentExecId, slotName);
          resolvedOutputs[slotName] = path.join(runDir, rel);
        }
      }
    }

    // 注入运行时常量，供 tool_nodejs 等节点在 instance body / script 中用 ${workspaceRoot} ${flowName} ${runDir} ${flowDir} 引用
    // 运行时常量放在后面，确保不会被 input 槽位的空值覆盖
    const runtimeConstants = {
      workspaceRoot: path.resolve(workspaceRoot),
      flowName,
      runDir: runDirRel,
      flowDir: path.resolve(flowDir),
    };
    for (const [key, value] of Object.entries(runtimeConstants)) {
      // 仅在 input 槽位的值为空或占位符时才使用运行时常量
      const existing = resolvedInputs[key];
      if (!existing || existing === "${" + key + "}" || existing.trim() === "") {
        resolvedInputs[key] = value;
      }
    }

    // 对上游 output 路径：若文件已存在且该槽位类型不是「文件」，用文件内容替换路径（便于 cache 一致）。
    // 类型为「文件」的 input 槽：保留路径（文件名/引用），不替换为内容，供 prompt 中「引用文件」使用。
    const inputSlotTypes = (flow.inputSlotTypes && flow.inputSlotTypes[instanceId]) || {};
    for (const slotName of Object.keys(resolvedInputs)) {
      if (inputSlotTypes[slotName] === "文件" || inputSlotTypes[slotName] === "file") continue;
      const v = resolvedInputs[slotName];
      if (typeof v !== "string" || !v) continue;
      if (!v.startsWith("output/")) continue;
      const absPath = path.join(runDir, v);
      try {
        if (fs.existsSync(absPath)) {
          resolvedInputs[slotName] = fs.readFileSync(absPath, "utf-8").trim();
        } else {
          // 备份机制（backupResolvedOutputsIfExist）会将 foo.md 重命名为 foo_N.md，
          // 循环节点第二轮起原始文件不存在时，回退查找最新的 _N 备份文件。
          const dir = path.dirname(absPath);
          const ext = path.extname(absPath);
          const base = path.basename(absPath, ext);
          if (fs.existsSync(dir)) {
            const candidates = fs.readdirSync(dir).filter(f =>
              f.startsWith(base + "_") && f.endsWith(ext) &&
              /^\d+$/.test(f.slice(base.length + 1, -ext.length))
            );
            if (candidates.length > 0) {
              candidates.sort((a, b) => {
                const na = parseInt(a.slice(base.length + 1, -ext.length), 10);
                const nb = parseInt(b.slice(base.length + 1, -ext.length), 10);
                return nb - na;
              });
              resolvedInputs[slotName] = fs.readFileSync(path.join(dir, candidates[0]), "utf-8").trim();
            }
          }
        }
      } catch (_) {}
    }

    // 拼入 prompt 的 resolveInput/output 统一使用绝对路径，避免相对路径歧义
    for (const slotName of Object.keys(resolvedInputs)) {
      const v = resolvedInputs[slotName];
      if (typeof v === "string" && v && (v.startsWith("output/") || v.startsWith("intermediate/"))) {
        resolvedInputs[slotName] = path.join(runDir, v);
      }
    }

    let description = "";
    let definitionId = "";
    const flowNode = flow.nodes?.find((n) => n.id === instanceId);
    const nameForFile = flowNode?.definitionName ?? flowNode?.definitionId;
    const flowData = loadFlowDefinition(flowDir);
    if (flowData?.instances?.[instanceId] != null) {
      const inst = flowData.instances[instanceId];
      definitionId = (flowNode?.definitionId ?? inst.definitionId ?? "").trim();
      if (nameForFile || inst.definitionId) {
        description = readNodeDescription(workspaceRoot, flowDir, nameForFile || inst.definitionId);
      }
    } else {
      definitionId = (flowNode?.definitionId ?? flowNode?.definitionName ?? "").trim();
      if (nameForFile || definitionId) {
        description = readNodeDescription(workspaceRoot, flowDir, nameForFile || definitionId);
      }
    }

    const systemPrompt = resolvePlaceholdersInText(
      description,
      resolvedInputs,
      resolvedOutputs,
      { instanceId, currentExecId, runDir },
    );

    return { ok: true, resolvedInputs, resolvedOutputs, systemPrompt };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 4) {
    console.error(
      JSON.stringify({
        ok: false,
        error: "Usage: node get-resolved-values.mjs <workspaceRoot> <flowName> <uuid> <instanceId>",
      }),
    );
    process.exit(1);
  }

  const [root, flowName, uuid, instanceId] = args;
  const workspaceRoot = path.resolve(root);
  const result = getResolvedValues(workspaceRoot, flowName, uuid, instanceId);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exit(1);
}

const isMain = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMain) main();
