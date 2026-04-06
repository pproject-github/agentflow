#!/usr/bin/env node
/**
 * 执行占位符替换，组装最终 prompt 并写入 intermediate 文件。
 * 用法：node build-node-prompt.mjs <workspaceRoot> <flowName> <uuid> <instanceId>
 * 输出（stdout JSON）：{ "ok": true, "promptPath": ".workspace/agentflow/runBuild/<flowName>/<uuid>/intermediate/<instanceId>.prompt.md" }
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { getRunDir, PIPELINES_DIR } from "../lib/paths.mjs";
import { getFlowDir } from "../lib/workspace.mjs";
import { backupIntermediateFileIfExists } from "./backup-intermediate-file.mjs";
import { loadFlowDefinition } from "./parse-flow.mjs";
import { getResolvedValues, getOutputPathForSlot } from "./get-resolved-values.mjs";
import { loadExecId } from "./get-exec-id.mjs";
import { intermediatePromptBasename, intermediateDirForNode } from "./get-exec-id.mjs";

function shellQuote(s) {
  if (s == null) return "''";
  return "'" + String(s).replace(/'/g, "'\\''") + "'";
}

function resolvePlaceholder(k, resolvedInputs, resolvedOutputs, opts) {
  const { instanceId, currentExecId, runDir } = opts;
  const execId = currentExecId ?? 1;
  const toAbs = (rel) => (runDir && rel ? path.join(runDir, rel) : rel);
  if (k.startsWith("input.")) {
    const slot = k.slice(6);
    return resolvedInputs[slot] ?? resolvedInputs._ ?? "";
  }
  if (k.startsWith("output.")) {
    const slot = k.slice(7);
    const v = resolvedOutputs[slot] ?? resolvedOutputs._ ?? "";
    if (v) return v;
    if (instanceId && slot in resolvedOutputs) {
      return toAbs(getOutputPathForSlot(instanceId, execId, slot));
    }
    return "";
  }
  let v = resolvedInputs[k] ?? resolvedOutputs[k] ?? "";
  if (!v && !k.includes(".")) {
    v = resolvedInputs[k + ".md"] ?? resolvedOutputs[k + ".md"] ?? "";
  }
  if (!v && instanceId && (k in resolvedOutputs || (k + ".md") in resolvedOutputs)) {
    const slot = k in resolvedOutputs ? k : k + ".md";
    v = toAbs(getOutputPathForSlot(instanceId, execId, slot));
  }
  return v;
}

function resolvePlaceholdersInText(
  text,
  resolvedInputs,
  resolvedOutputs,
  opts = {},
) {
  if (!text || typeof text !== "string") return "";
  return text.replace(/\$\{([^}]+)\}/g, (_, key) => {
    return resolvePlaceholder(key.trim(), resolvedInputs, resolvedOutputs, opts);
  });
}

/**
 * 解析 script 字段中的 ${} 占位符，每个替换值用 shell 单引号包裹，避免路径含空格/特殊字符时被 shell 误拆分。
 */
function resolveScriptCommand(
  text,
  resolvedInputs,
  resolvedOutputs,
  opts = {},
) {
  if (!text || typeof text !== "string") return "";
  return text.replace(/\$\{([^}]+)\}/g, (_, key) => {
    return shellQuote(resolvePlaceholder(key.trim(), resolvedInputs, resolvedOutputs, opts));
  });
}

/**
 * 执行占位符替换，组装 prompt 并写入 intermediate 文件（文件名带 _execId）。
 * @param {number} [execId] - 本轮 execId，缺省则从 memory 读取
 * @returns {{ ok: boolean, promptPath?: string, nodeContext?: string, taskBody?: string, error?: string }}
 */
export function buildNodePrompt(workspaceRoot, flowName, uuid, instanceId, execId) {
  const runDir = getRunDir(workspaceRoot, flowName, uuid);
  const flowJsonPath = path.join(runDir, "intermediate", "flow.json");
  let flowDir = getFlowDir(workspaceRoot, flowName) || path.join(workspaceRoot, PIPELINES_DIR, flowName);
  if (fs.existsSync(flowJsonPath)) {
    try {
      const flow = JSON.parse(fs.readFileSync(flowJsonPath, "utf-8"));
      if (flow?.flowDir && typeof flow.flowDir === "string" && flow.flowDir.trim()) {
        flowDir = path.isAbsolute(flow.flowDir) ? flow.flowDir : path.join(workspaceRoot, flow.flowDir);
      }
    } catch (_) {}
  }
  const nodeIntermediateDir = path.join(runDir, intermediateDirForNode(instanceId));
  const e = execId ?? loadExecId(workspaceRoot, flowName, uuid, instanceId);
  const promptBasename = intermediatePromptBasename(instanceId, e);
  const promptPath = path.join(nodeIntermediateDir, promptBasename);

  const data = getResolvedValues(workspaceRoot, flowName, uuid, instanceId);
  if (!data.ok) {
    return { ok: false, error: data.error || "get-resolved-values failed" };
  }

  const flowData = loadFlowDefinition(flowDir);
  const inst = flowData?.instances?.[instanceId];
  const instanceBody =
    inst?.body != null
      ? String(inst.body || "").trim()
      : "";
  const instanceScript =
    inst?.script != null
      ? String(inst.script || "").trim()
      : "";

  const { resolvedInputs = {}, resolvedOutputs = {}, systemPrompt = "" } = data;
  const resolveOpts = { instanceId, currentExecId: e, runDir };
  const taskBody = resolvePlaceholdersInText(
    instanceBody,
    resolvedInputs,
    resolvedOutputs,
    resolveOpts,
  );

  const resolvedScript = instanceScript
    ? resolveScriptCommand(instanceScript, resolvedInputs, resolvedOutputs, resolveOpts)
    : "";

  const content = `## 节点上下文

${systemPrompt || "(无)"}

## 执行任务

${taskBody || "(无)"}
`;

  try {
    fs.mkdirSync(nodeIntermediateDir, { recursive: true });
    backupIntermediateFileIfExists(promptPath, e);
    fs.writeFileSync(promptPath, content, "utf-8");
  } catch (e) {
    return { ok: false, error: e.message || "Failed to write prompt file" };
  }

  const relativePath = path.relative(workspaceRoot, promptPath);
  return {
    ok: true,
    promptPath: relativePath.replace(/\\/g, "/"),
    nodeContext: systemPrompt || "",
    taskBody: taskBody || "",
    script: resolvedScript || "",
  };
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 4) {
    console.error(
      JSON.stringify({
        ok: false,
        error: "Usage: node build-node-prompt.mjs <workspaceRoot> <flowName> <uuid> <instanceId>",
      }),
    );
    process.exit(1);
  }

  const [root, flowName, uuid, instanceId] = args;
  const workspaceRoot = path.resolve(root);
  const result = buildNodePrompt(workspaceRoot, flowName, uuid, instanceId, undefined);
  console.log(JSON.stringify(result));
  if (!result.ok) process.exit(1);
}

const isMain = process.argv[1] && path.resolve(fileURLToPath(import.meta.url)) === path.resolve(process.argv[1]);
if (isMain) main();
