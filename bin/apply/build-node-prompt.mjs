#!/usr/bin/env node
/**
 * 执行占位符替换，组装 AgentFlowSystem + AgentSubAgent 格式，写入 intermediate 文件。
 * 用法：node build-node-prompt.mjs <workspaceRoot> <flowName> <uuid> <instanceId>
 * 输出（stdout JSON）：{ "ok": true, "promptPath": ".workspace/agentflow/runBuild/<flowName>/<uuid>/intermediate/<instanceId>.prompt.md" }
 * 生成文件格式：
 *   AgentFlowSystem:
 *   <systemPrompt>;
 *
 *   AgentSubAgent:
 *   <instance body with placeholders replaced>;
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { loadFlowDefinition } from "./parse-flow.mjs";
import { getResolvedValues, getOutputPathForSlot } from "./get-resolved-values.mjs";
import { loadExecId } from "./get-exec-id.mjs";
import { intermediatePromptBasename, intermediateDirForNode } from "./get-exec-id.mjs";

function resolvePlaceholdersInText(
  text,
  resolvedInputs,
  resolvedOutputs,
  opts = {},
) {
  if (!text || typeof text !== "string") return "";
  const { instanceId, currentExecId } = opts;
  const execId = currentExecId ?? 1;
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
      if (instanceId && slot in resolvedOutputs) {
        return getOutputPathForSlot(instanceId, execId, slot);
      }
      return "";
    }
    let v = resolvedInputs[k] ?? resolvedOutputs[k] ?? "";
    if (!v && !k.includes(".")) {
      v = resolvedInputs[k + ".md"] ?? resolvedOutputs[k + ".md"] ?? "";
    }
    if (!v && instanceId && (k in resolvedOutputs || (k + ".md") in resolvedOutputs)) {
      const slot = k in resolvedOutputs ? k : k + ".md";
      v = getOutputPathForSlot(instanceId, execId, slot);
    }
    return v;
  });
}

function readInstanceBody(instancePath) {
  try {
    const raw = fs.readFileSync(instancePath, "utf-8");
    const m = raw.match(/^---\s*\n[\s\S]*?\n---\s*\n([\s\S]*)$/);
    return m ? m[1].trim() : raw.trim();
  } catch {
    return "";
  }
}

/**
 * 执行占位符替换，组装 prompt 并写入 intermediate 文件（文件名带 _execId）。
 * @param {number} [execId] - 本轮 execId，缺省则从 memory 读取
 * @returns {{ ok: boolean, promptPath?: string, optionalPromptPath?: string, error?: string }}
 */
export function buildNodePrompt(workspaceRoot, flowName, uuid, instanceId, execId) {
  const runDir = path.join(workspaceRoot, ".workspace", "agentflow", "runBuild", flowName, uuid);
  const flowJsonPath = path.join(runDir, "intermediate", "flow.json");
  let flowDir = path.join(workspaceRoot, ".cursor", "agentflow", "pipelines", flowName);
  if (fs.existsSync(flowJsonPath)) {
    try {
      const flow = JSON.parse(fs.readFileSync(flowJsonPath, "utf-8"));
      if (flow?.flowDir && typeof flow.flowDir === "string" && flow.flowDir.trim()) {
        flowDir = path.isAbsolute(flow.flowDir) ? flow.flowDir : path.join(workspaceRoot, flow.flowDir);
      }
    } catch (_) {}
  }
  const instancePath = path.join(flowDir, "instance", `${instanceId}.md`);
  const nodeIntermediateDir = path.join(runDir, intermediateDirForNode(instanceId));
  const e = execId ?? loadExecId(workspaceRoot, flowName, uuid, instanceId);
  const promptBasename = intermediatePromptBasename(instanceId, e);
  const promptPath = path.join(nodeIntermediateDir, promptBasename);

  const data = getResolvedValues(workspaceRoot, flowName, uuid, instanceId);
  if (!data.ok) {
    return { ok: false, error: data.error || "get-resolved-values failed" };
  }

  const flowData = loadFlowDefinition(flowDir);
  const instanceBody =
    flowData?.instances?.[instanceId]?.body != null
      ? String(flowData.instances[instanceId].body || "").trim()
      : readInstanceBody(instancePath);

  const { resolvedInputs = {}, resolvedOutputs = {}, systemPrompt = "" } = data;
  const agentSubAgent = resolvePlaceholdersInText(
    instanceBody,
    resolvedInputs,
    resolvedOutputs,
    { instanceId, currentExecId: e },
  );

  const content = `AgentFlowSystem:
${systemPrompt || "(无)"};

AgentSubAgent:
${agentSubAgent || "(无)"};
`;

  try {
    fs.mkdirSync(nodeIntermediateDir, { recursive: true });
    fs.writeFileSync(promptPath, content, "utf-8");
  } catch (e) {
    return { ok: false, error: e.message || "Failed to write prompt file" };
  }

  const relativePath = path.relative(workspaceRoot, promptPath);
  return { ok: true, promptPath: relativePath.replace(/\\/g, "/") };
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
