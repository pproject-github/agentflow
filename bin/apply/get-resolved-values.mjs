#!/usr/bin/env node
/**
 * 获取指定 instance 的 resolvedInputs、resolvedOutputs、systemPrompt，用于占位符替换。
 * systemPrompt 来自 instance 或 node 定义的 description，占位符 ${input.xxx}、${output.xxx}、${xxx} 会被替换。
 * 用法：node get-resolved-values.mjs <workspaceRoot> <flowName> <uuid> <instanceId>
 * 输出（stdout JSON）：{ "ok": true, "resolvedInputs": {...}, "resolvedOutputs": {...}, "systemPrompt": "..." }
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirnameResolved = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_BUILTIN_NODES_DIR = path.join(path.resolve(__dirnameResolved, "..", ".."), "builtin", "nodes");

import { loadFlowDefinition } from "./parse-flow.mjs";
import { loadAllExecIds, outputDirForNode } from "./get-exec-id.mjs";
import { computeResolvedInputsForInstance } from "./resolve-inputs.mjs";

function parseFrontmatter(raw) {
  const m = raw.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!m) return {};
  const lines = m[1].split("\n");
  const data = {};
  let section = null;
  let currentName = null;
  for (const line of lines) {
    if (/^\s*description:\s*(.*)$/.test(line)) {
      const v = line.replace(/^\s*description:\s*/, "").replace(/^["']|["']$/g, "").trim();
      data.description = v;
      continue;
    }
    if (/^\s*definitionId:\s*(.*)$/.test(line)) {
      const v = line.replace(/^\s*definitionId:\s*/, "").replace(/^["']|["']$/g, "").trim();
      data.definitionId = v;
      continue;
    }
  }
  return data;
}

function readNodeDescription(workspaceRoot, flowDir, definitionId) {
  const fileName = definitionId.endsWith(".md") ? definitionId : `${definitionId}.md`;
  const flowNodesPath = path.join(flowDir, "nodes", fileName);
  const projectNodesPath = path.join(workspaceRoot, ".cursor", "agentflow", "nodes", fileName);
  const packageNodesPath = path.join(PACKAGE_BUILTIN_NODES_DIR, fileName);
  for (const p of [flowNodesPath, projectNodesPath, packageNodesPath]) {
    try {
      const raw = fs.readFileSync(p, "utf-8");
      const m = raw.match(/^---\s*\n([\s\S]*?)\n---/);
      if (!m) continue;
      const descMatch = m[1].match(/^\s*description:\s*(.*)$/m);
      if (descMatch) {
        const v = descMatch[1].replace(/^["']|["']$/g, "").trim();
        if (v) return v;
      }
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
  const { instanceId } = opts;
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
        return getOutputPathForSlot(instanceId, opts.currentExecId, slot);
      }
      if (instanceId && slot in resolvedOutputs) {
        return getOutputPathForSlot(instanceId, 1, slot);
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
      v = getOutputPathForSlot(instanceId, opts.currentExecId ?? 1, slot);
    }
    return v;
  });
}

/**
 * 获取指定 instance 的 resolvedInputs、resolvedOutputs、systemPrompt。
 * @returns {{ ok: boolean, resolvedInputs?: object, resolvedOutputs?: object, systemPrompt?: string, error?: string }}
 */
export function getResolvedValues(workspaceRoot, flowName, uuid, instanceId) {
  const runDir = path.join(workspaceRoot, ".workspace", "agentflow", "runBuild", flowName, uuid);
  const flowJsonPath = path.join(runDir, "intermediate", "flow.json");

  if (!fs.existsSync(flowJsonPath)) {
    return { ok: false, error: `flow.json not found: ${flowJsonPath}. Run parse-flow.mjs first.` };
  }

  try {
    const flow = JSON.parse(fs.readFileSync(flowJsonPath, "utf-8"));
    if (!flow.ok) {
      return { ok: false, error: flow.error || "flow.json indicates error" };
    }

    let flowDir = path.join(workspaceRoot, ".cursor", "agentflow", "pipelines", flowName);
    if (flow.flowDir && typeof flow.flowDir === "string" && flow.flowDir.trim()) {
      flowDir = path.isAbsolute(flow.flowDir) ? flow.flowDir : path.join(workspaceRoot, flow.flowDir);
    }
    const instancePath = path.join(flowDir, "instance", `${instanceId}.md`);

    const raw = computeResolvedInputsForInstance(workspaceRoot, flowName, uuid, instanceId);
    if (!raw.ok) {
      return { ok: false, error: raw.error || "computeResolvedInputsForInstance failed" };
    }
    let resolvedInputs = raw.resolvedInputs || {};

    const runDirRel = path.join(".workspace", "agentflow", "runBuild", flowName, uuid);

    const order = flow.order || [];
    const execIds = loadAllExecIds(workspaceRoot, flowName, uuid, order);
    const currentExecId = execIds[instanceId] ?? 1;

    // 当前节点 output 路径从结构（outputSlotTypes / nodes）得到槽名，固定路径不含 _execId
    const resolvedOutputs = {};
    const outSlotNames = (flow.outputSlotTypes && flow.outputSlotTypes[instanceId])
      ? Object.keys(flow.outputSlotTypes[instanceId])
      : [];
    for (const slotName of outSlotNames) {
      resolvedOutputs[slotName] = getOutputPathForSlot(instanceId, currentExecId, slotName);
    }
    if (Object.keys(resolvedOutputs).length === 0 && order.includes(instanceId)) {
      const node = flow.nodes?.find((n) => n.id === instanceId);
      const outSlots = node?.output || flow.outputSlotTypes?.[instanceId];
      if (outSlots && typeof outSlots === "object") {
        for (const slotName of Object.keys(outSlots)) {
          resolvedOutputs[slotName] = getOutputPathForSlot(instanceId, currentExecId, slotName);
        }
      }
    }

    // 注入运行时常量，供 tool_nodejs 等节点在 instance body 中用 ${workspaceRoot} ${flowName} ${runDir} 引用
    resolvedInputs = {
      workspaceRoot: path.resolve(workspaceRoot),
      flowName,
      runDir: runDirRel,
      ...resolvedInputs,
    };

    // 对上游 output 路径：若文件已存在且该槽位类型不是「文件」，用文件内容替换路径（便于 cache 一致）。
    // 类型为「文件」的 input 槽：保留路径（文件名/引用），不替换为内容，供 prompt 中「引用文件」使用。
    const inputSlotTypes = (flow.inputSlotTypes && flow.inputSlotTypes[instanceId]) || {};
    for (const slotName of Object.keys(resolvedInputs)) {
      if (inputSlotTypes[slotName] === "文件") continue;
      const v = resolvedInputs[slotName];
      if (typeof v !== "string" || !v) continue;
      if (!v.startsWith("output/")) continue;
      const absPath = path.join(runDir, v);
      try {
        if (fs.existsSync(absPath)) {
          resolvedInputs[slotName] = fs.readFileSync(absPath, "utf-8").trim();
        }
      } catch (_) {}
    }

    let description = "";
    let definitionId = "";
    const flowNode = flow.nodes?.find((n) => n.id === instanceId);
    const nameForFile = flowNode?.definitionName ?? flowNode?.definitionId;
    const flowData = loadFlowDefinition(flowDir);
    if (flowData?.instances?.[instanceId] != null) {
      const inst = flowData.instances[instanceId];
      definitionId = (flowNode?.definitionId ?? inst.definitionId ?? "").trim();
      description = (inst.description || "").trim();
      if (!description && (nameForFile || inst.definitionId)) {
        description = readNodeDescription(workspaceRoot, flowDir, nameForFile || inst.definitionId);
      }
    } else {
      try {
        const instanceRaw = fs.readFileSync(instancePath, "utf-8");
        const data = parseFrontmatter(instanceRaw);
        definitionId = (flowNode?.definitionId ?? data.definitionId ?? "").trim();
        description = (data.description || "").trim();
        if (!description && (nameForFile || data.definitionId)) {
          description = readNodeDescription(workspaceRoot, flowDir, nameForFile || data.definitionId);
        }
      } catch (_) {}
    }

    const systemPrompt = resolvePlaceholdersInText(
      description,
      resolvedInputs,
      resolvedOutputs,
      { instanceId, currentExecId },
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
