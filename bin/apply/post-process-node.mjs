#!/usr/bin/env node
/**
 * 统一后处理入口：对每个已执行完的节点运行一次。
 * 1) 若存在本轮的 result 文件（AI/subagent 所写），先规范化 frontmatter 与正文后写回；
 * 2) 再根据 definitionId 分支：control_if 写 branch，control_if_true/false 写 condition_not_met，tool_user_check/waitForUser 写 pending 等；
 * 3) 若为 tool_print 则生成 optionalPromptPath 供主 agent 执行；
 * 4) 最后在 memory 中将该节点 execId +1。
 * 用法：node post-process-node.mjs <workspaceRoot> <flowName> <uuid> <instanceId> [execId]
 * 可选 execId：本轮执行的 execId（与 pre-process 输出一致），未传则从 memory 读取。**必须传入**才能正确命中本轮的 result 文件（否则第二轮起 user_check 等不生效）。
 * 输出（stdout JSON）：{ "ok": true } 或 { "ok": true, "optionalPromptPath": "..." }
 */

import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import { writeResult } from "./write-result.mjs";
import { loadExecId, intermediateResultBasename, intermediateDirForNode } from "./get-exec-id.mjs";
import { getResolvedValues } from "./get-resolved-values.mjs";
import { parseBool, getFirstBoolInputValue } from "./parse-bool.mjs";
import { logToRunTag } from "./run-log.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SAVE_KEY = path.join(__dirname, "save-key.mjs");
const EXEC_ID_KEY_PREFIX = "execId_";

/**
 * 将本 run 内指定节点「本轮已使用的 execId」写入 memory.md。
 * 语义：memory 存「上一轮已完成的 execId」，pre-process 用 execId = (memory || 0) + 1。
 * 环不做额外 execId 处理，每轮仍按普通节点一样由 post-process 写入当前 execId。
 * @param {string} workspaceRoot
 * @param {string} uuid
 * @param {string} instanceId
 * @param {number} [currentExecId] 本轮执行的 execId；未传则从 memory 读取后原样写回（兼容）
 * @returns {string} 写入后的 execId（字符串）
 */
export function incrementExecIdInMemory(workspaceRoot, flowName, uuid, instanceId, currentExecId) {
  const current = currentExecId ?? loadExecId(workspaceRoot, flowName, uuid, instanceId);
  const toSave = String(current);
  const save = spawnSync(
    process.execPath,
    [SAVE_KEY, path.resolve(workspaceRoot), flowName, uuid, EXEC_ID_KEY_PREFIX + instanceId, toSave],
    { cwd: path.resolve(workspaceRoot), encoding: "utf-8" },
  );
  if (save.status !== 0) {
    throw new Error(`save-key failed: ${save.stderr || save.stdout || "unknown"}`);
  }
  return toSave;
}

/** 从 result.md 中解析 frontmatter 与正文（简单正则，不依赖 YAML 库） */
function parseResultFrontmatter(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const raw = fs.readFileSync(filePath, "utf-8");
  const match = raw.match(/---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n([\s\S]*)$/);
  if (!match) return null;
  const [, fm, body] = match;
  const fields = {};
  for (const line of fm.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const key = line.slice(0, colon).trim();
    let val = line.slice(colon + 1).trim();
    if (val.startsWith('"') && val.endsWith('"'))
      val = val.slice(1, -1).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
    else if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
    fields[key] = val;
  }
  return { ...fields, _body: body };
}

/**
 * 若本轮的 result 文件存在，则按统一 frontmatter 格式写回（规范化 AI/subagent 写入的 result）。
 * 若 SubAgent 写成纯 Markdown 无 frontmatter，仍补写 status: success，避免 get-ready-nodes 读不到 status 导致该节点被重复执行。
 */
function applyExecutorResultNormalize(workspaceRoot, flowName, uuid, instanceId, execId) {
  const e = execId ?? loadExecId(workspaceRoot, flowName, uuid, instanceId);
  const runDir = path.join(workspaceRoot, ".workspace", "agentflow", "runBuild", flowName, uuid);
  const resultPath = path.join(runDir, intermediateDirForNode(instanceId), intermediateResultBasename(instanceId, e));
  if (!fs.existsSync(resultPath)) return;

  const parsed = parseResultFrontmatter(resultPath);
  let body;
  let status;
  let message;
  let finishedAt;
  let outputPath;
  let branch;

  if (parsed) {
    body = parsed._body ?? "";
    /** Agent 可能写 completed/done，统一迁移为 success，下游只认 success */
    status = (parsed.status === "completed" || parsed.status === "done" ? "success" : (parsed.status ?? "success"));
    message = parsed.message ?? "";
    finishedAt = parsed.finishedAt ?? new Date().toISOString();
    outputPath = parsed.outputPath;
    branch = parsed.branch;
  } else {
    const raw = fs.readFileSync(resultPath, "utf-8");
    body = raw.trim();
    status = "success";
    message = "已完成";
    finishedAt = new Date().toISOString();
    outputPath = undefined;
    branch = undefined;
  }

  writeResult(workspaceRoot, flowName, uuid, instanceId, {
    status,
    message,
    finishedAt,
    outputPath: outputPath || undefined,
    branch: branch || undefined,
  }, { body, execId: e });
}

/** 从 result.md 中解析 branch（与 get-ready-nodes 约定一致） */
function parseResultBranch(filePath) {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const m = raw.match(/^\s*branch:\s*["']?([^"'\s]+)["']?/m);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * 从 flow.json 读取 inputSlotTypes[instanceId]。
 * @returns {Record<string, string>|null}
 */
function readInputSlotTypes(workspaceRoot, flowName, uuid, instanceId) {
  const flowJsonPath = path.join(workspaceRoot, ".workspace", "agentflow", "runBuild", flowName, uuid, "intermediate", "flow.json");
  if (!fs.existsSync(flowJsonPath)) return null;
  try {
    const flow = JSON.parse(fs.readFileSync(flowJsonPath, "utf-8"));
    const inTypes = flow?.inputSlotTypes?.[instanceId];
    return inTypes && typeof inTypes === "object" ? inTypes : null;
  } catch {
    return null;
  }
}

/**
 * control_if 后处理：必须写入 branch。
 * 优先用 result 里已有的 branch；否则从 resolvedInputs 中第一个 type 为 bool 的槽位取值（名称不限）。
 * 值可能是：1) 路径（如 output/xxx/...），需读文件内容再解析；2) 已是布尔内容（如 "true"/"false"）。
 */
function applyControlIfLogic(workspaceRoot, flowName, uuid, instanceId, definitionId, execId) {
  if (definitionId !== "control_if") return;

  const runDir = path.join(workspaceRoot, ".workspace", "agentflow", "runBuild", flowName, uuid);
  const e = execId ?? loadExecId(workspaceRoot, flowName, uuid, instanceId);
  const resultPath = path.join(runDir, intermediateDirForNode(instanceId), intermediateResultBasename(instanceId, e));

  let branch = fs.existsSync(resultPath) ? parseResultBranch(resultPath) : null;
  if (!branch) {
    const data = getResolvedValues(workspaceRoot, flowName, uuid, instanceId);
    if (!data.ok || !data.resolvedInputs) return;
    const inputSlotTypes = readInputSlotTypes(workspaceRoot, flowName, uuid, instanceId);
    const rawVal = getFirstBoolInputValue(data.resolvedInputs, inputSlotTypes);
    if (rawVal == null) return;
    let boolValue;
    if (rawVal.startsWith("output/")) {
      const filePath = path.join(runDir, rawVal);
      if (!fs.existsSync(filePath)) return;
      boolValue = parseBool(fs.readFileSync(filePath, "utf-8").trim());
    } else {
      boolValue = parseBool(rawVal);
    }
    branch = boolValue ? "true" : "false";
  }

  writeResult(workspaceRoot, flowName, uuid, instanceId, {
    status: "success",
    message: `分支 ${branch}`,
    branch,
  }, { preserveBody: true, execId: e });
}

/**
 * 若为「待用户确认」节点：将 result 的 status 覆写为 pending，流程暂停，等用户再次 apply 时续跑。
 * 识别方式：instance frontmatter 中 waitForUser: true，或 definitionId === "tool_user_check"。
 */
function applyWaitForUserPending(workspaceRoot, flowName, uuid, instanceId, runDir, definitionId, execId) {
  const e = execId ?? loadExecId(workspaceRoot, flowName, uuid, instanceId);
  const resultPath = path.join(runDir, intermediateDirForNode(instanceId), intermediateResultBasename(instanceId, e));
  if (!fs.existsSync(resultPath)) return;

  let waitForUser = false;
  if (definitionId === "tool_user_check") {
    waitForUser = true;
  } else {
    const instancePath = path.join(
      workspaceRoot,
      ".cursor",
      "agentflow",
      "pipelines",
      flowName,
      "instance",
      `${instanceId}.md`,
    );
    if (fs.existsSync(instancePath)) {
      const raw = fs.readFileSync(instancePath, "utf-8");
      const match = raw.match(/\bwaitForUser:\s*(true|yes|1)\b/i);
      waitForUser = !!match;
    }
  }

  if (!waitForUser) return;

  writeResult(workspaceRoot, flowName, uuid, instanceId, {
    status: "pending",
    message: "等待用户确认",
  }, { preserveBody: true, execId: e });
}

/**
 * 若为 tool_print 节点，生成 prompt 文件并返回路径，供主 agent 执行（检查/修正 result 正文）。
 * 返回 { optionalPromptPath } 相对 workspaceRoot，或 null。
 */
function maybeEmitToolPrintPrompt(workspaceRoot, flowName, uuid, instanceId, runDir, definitionId, execId) {
  if (definitionId !== "tool_print") return null;

  const e = execId ?? loadExecId(workspaceRoot, flowName, uuid, instanceId);
  const resultPathRel = `${intermediateDirForNode(instanceId)}/${intermediateResultBasename(instanceId, e)}`;
  const promptContent = `请检查并必要时修正 result 文件：\`${resultPathRel}\`（相对 run 目录 \`.workspace/agentflow/runBuild/${flowName}/${uuid}/\`）。

该节点为 **tool_print**。约定：输出内容必须写在 result 文档的**正文部分**（frontmatter 下方），正文直接写节点输出，不要加「醒目提醒」「内容：」等包装。若当前正文缺失或不符合，请从 output 移入或根据节点意图补充正文。
`;

  const promptPath = path.join(runDir, intermediateDirForNode(instanceId), `${instanceId}_${e}.tool_print_prompt.md`);
  try {
    fs.mkdirSync(path.dirname(promptPath), { recursive: true });
    fs.writeFileSync(promptPath, promptContent, "utf-8");
  } catch (e) {
    return null;
  }

  const relativePath = path.relative(workspaceRoot, promptPath);
  return relativePath.replace(/\\/g, "/");
}

function main() {
  const args = process.argv.slice(2);
  if (args.length < 4) {
    console.error(
      JSON.stringify({
        ok: false,
        error:
          "Usage: node post-process-node.mjs <workspaceRoot> <flowName> <uuid> <instanceId>",
      }),
    );
    process.exit(1);
  }

  const [root, flowName, uuid, instanceId, execIdArg] = args;
  const workspaceRoot = path.resolve(root);
  const runDir = path.join(workspaceRoot, ".workspace", "agentflow", "runBuild", flowName, uuid);
  const execId = execIdArg != null && execIdArg !== ""
    ? (parseInt(String(execIdArg), 10) || undefined)
    : undefined;

  try {
    let definitionId = null;
    const flowJsonPath = path.join(runDir, "intermediate", "flow.json");
    if (fs.existsSync(flowJsonPath)) {
      try {
        const flow = JSON.parse(fs.readFileSync(flowJsonPath, "utf-8"));
        const node = flow?.nodes?.find((n) => n.id === instanceId);
        if (node?.definitionId) definitionId = node.definitionId;
      } catch (_) {}
    }
    if (definitionId == null) {
      const instancePath = path.join(
        workspaceRoot,
        ".cursor",
        "agentflow",
        "pipelines",
        flowName,
        "instance",
        `${instanceId}.md`,
      );
      if (fs.existsSync(instancePath)) {
        const instanceRaw = fs.readFileSync(instancePath, "utf-8");
        const defMatch = instanceRaw.match(/^\s*definitionId:\s*["']?([^"'\n]+)["']?/m);
        definitionId = defMatch ? defMatch[1].trim() : null;
      }
    }
    logToRunTag(workspaceRoot, flowName, uuid, "post-process", {
      event: "start",
      instanceId,
      definitionId,
      execId: execId ?? loadExecId(workspaceRoot, flowName, uuid, instanceId),
    });

    applyExecutorResultNormalize(workspaceRoot, flowName, uuid, instanceId, execId);
    logToRunTag(workspaceRoot, flowName, uuid, "post-process", { event: "result-normalized", instanceId });
    applyControlIfLogic(workspaceRoot, flowName, uuid, instanceId, definitionId, execId);
    applyWaitForUserPending(workspaceRoot, flowName, uuid, instanceId, runDir, definitionId, execId);

    const optionalPromptPath = maybeEmitToolPrintPrompt(
      workspaceRoot,
      flowName,
      uuid,
      instanceId,
      runDir,
      definitionId,
      execId,
    );
    const savedExecId = incrementExecIdInMemory(workspaceRoot, flowName, uuid, instanceId, execId);
    logToRunTag(workspaceRoot, flowName, uuid, "post-process", {
      event: "done",
      instanceId,
      execIdIncremented: savedExecId,
      hasOptionalPrompt: !!optionalPromptPath,
    });
    const output = { ok: true };
    if (optionalPromptPath) output.optionalPromptPath = optionalPromptPath;
    console.log(JSON.stringify(output));
  } catch (err) {
    console.error(JSON.stringify({ ok: false, error: err.message }));
    process.exit(1);
  }
}

const isMain =
  typeof process !== "undefined" &&
  process.argv[1] &&
  (process.argv[1].endsWith("post-process-node.mjs") || process.argv[1].endsWith("post-process-node.js"));
if (isMain) main();
