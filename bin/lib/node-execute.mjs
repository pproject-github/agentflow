import { spawnSync } from "child_process";
import fs from "fs";
import path from "path";
import { backupResolvedOutputsIfExist } from "../pipeline/backup-resolved-output.mjs";
import { outputNodeBasename, outputDirForNode } from "../pipeline/get-exec-id.mjs";
import { writeResult } from "../pipeline/write-result.mjs";
import { runCursorAgentForNode, runCursorAgentWithPrompt, runOpenCodeAgentForNode, runOpenCodeAgentWithPrompt } from "./agent-runners.mjs";
import { runApiAgentForNode } from "./api-runner.mjs";
import { log } from "./log.mjs";
import { LOCAL_ONLY_DEFINITION_IDS, LOCAL_ONLY_TERMINAL_SUCCESS_IDS } from "./paths.mjs";
import { resolveCliAndModel } from "./model-config.mjs";
import { parseJsonStdout, runNodeScript } from "./pipeline-scripts.mjs";
import { emitEvent } from "./run-events.mjs";
import { getRunDir } from "./workspace.mjs";
import { nodeToolCommandToArgv } from "./normalize-node-tool-command.mjs";

const TOOL_NODEJS_MAX_RETRIES = 3;
const TOOL_NODEJS_RETRY_DELAY_MS = 1000;
const AI_HEAL_ENABLED = !(
  process.env.AGENTFLOW_TOOL_NODEJS_AI_HEAL === "0" ||
  process.env.AGENTFLOW_TOOL_NODEJS_AI_HEAL === "false"
);

// ─── AI 自愈：失败后调用 Cursor/OpenCode CLI 修复脚本再重试 ──────────────────

function extractScriptPath(resolvedScript) {
  const { argv } = nodeToolCommandToArgv(resolvedScript);
  if (argv.length === 0) return null;
  const candidate = argv[0];
  if (!candidate) return null;
  const abs = path.isAbsolute(candidate) ? candidate : path.resolve(candidate);
  return fs.existsSync(abs) ? abs : null;
}

function buildHealPrompt(scriptPath, command, errorInfo, scriptContent) {
  const stderrSlice = (errorInfo.stderr || "").trim().slice(0, 4000) || "(无)";
  const stdoutSlice = (errorInfo.stdout || "").trim().slice(0, 2000) || "(无)";
  return [
    "你是脚本调试助手。以下 Node.js 脚本执行失败，请直接修复脚本文件中的错误。",
    "",
    `## 脚本路径\n${scriptPath}`,
    `## 执行命令\n${command}`,
    `## 退出码\n${errorInfo.exitCode}`,
    `## 标准错误 (stderr)\n${stderrSlice}`,
    `## 标准输出 (stdout)\n${stdoutSlice}`,
    "## 当前脚本内容",
    "```javascript",
    scriptContent.slice(0, 30000),
    "```",
    "",
    "## 修复要求",
    `1. 直接编辑脚本文件 \`${scriptPath}\` 修复错误`,
    "2. 保持脚本的输入输出格式不变（stdout 须输出 JSON `{\"err_code\":0,\"message\":{\"result\":\"...\"}}` 或纯文本）",
    "3. 只修复导致失败的问题，不做无关改动",
    "4. 不要创建新文件、不要修改其他文件",
  ].join("\n");
}

/**
 * 调用 Cursor/OpenCode CLI 让 AI 分析 stderr 并修复脚本文件，然后由调用方重新执行。
 * @returns {Promise<boolean>} 是否成功完成修复（AI 调用无报错即视为成功，实际修复效果由重试验证）
 */
async function healToolNodejsWithAI(workspaceRoot, flowName, uuid, instanceId, resolvedScript, errorInfo, cli, model) {
  const scriptPath = extractScriptPath(resolvedScript);
  if (!scriptPath) {
    log.warn(`[tool_nodejs AI 自愈] 无法从命令提取脚本路径，跳过: ${resolvedScript.slice(0, 120)}`);
    return false;
  }

  let scriptContent;
  try {
    scriptContent = fs.readFileSync(scriptPath, "utf-8");
  } catch {
    log.warn(`[tool_nodejs AI 自愈] 无法读取脚本文件，跳过: ${scriptPath}`);
    return false;
  }

  const prompt = buildHealPrompt(scriptPath, resolvedScript, errorInfo, scriptContent);
  const healCli = cli === "opencode" ? "opencode" : "cursor";

  log.info(`[tool_nodejs AI 自愈] ${instanceId} 调用 ${healCli}${model ? ` (${model})` : ""} 修复 ${path.basename(scriptPath)}`);
  emitEvent(workspaceRoot, flowName, uuid, {
    event: "tool-nodejs-ai-heal-start",
    instanceId,
    scriptPath,
    cli: healCli,
    model: model ?? null,
  });

  try {
    if (healCli === "opencode") {
      const { finished } = runOpenCodeAgentWithPrompt(workspaceRoot, prompt, { model: model || undefined, force: true });
      await finished;
    } else {
      const { finished } = runCursorAgentWithPrompt(workspaceRoot, prompt, { model: model || undefined });
      await finished;
    }
    log.info(`[tool_nodejs AI 自愈] ${instanceId} AI 修复完成，即将重试脚本`);
    emitEvent(workspaceRoot, flowName, uuid, {
      event: "tool-nodejs-ai-heal-done",
      instanceId,
      scriptPath,
    });
    return true;
  } catch (healErr) {
    log.warn(`[tool_nodejs AI 自愈] ${instanceId} AI 修复失败: ${healErr.message?.slice(0, 200) || healErr}`);
    emitEvent(workspaceRoot, flowName, uuid, {
      event: "tool-nodejs-ai-heal-failed",
      instanceId,
      scriptPath,
      error: healErr.message?.slice(0, 300) || String(healErr),
    });
    return false;
  }
}

// ─── 内联执行 + 重试 ────────────────────────────────────────────────────────

/**
 * tool_nodejs + script 内联执行：直接跑脚本、写 result，无中间进程。
 * 失败时可通过 AI（Cursor/OpenCode CLI）自动分析 stderr 修复脚本再重试，
 * 最多重试 TOOL_NODEJS_MAX_RETRIES 次。
 * 设置 AGENTFLOW_TOOL_NODEJS_AI_HEAL=0 可关闭 AI 自愈回退为简单重试。
 *
 * 协议：exit code 0=success 非0=failed；stdout → result 槽位。
 * 若 stdout 为 JSON {err_code, message:{result}} 则 err_code 覆盖 exit code（向后兼容）。
 */
async function executeToolNodejsInline(workspaceRoot, flowName, uuid, instanceId, resolvedScript, execId, healOptions) {
  let lastError;
  for (let attempt = 1; attempt <= TOOL_NODEJS_MAX_RETRIES + 1; attempt++) {
    try {
      executeToolNodejsOnce(workspaceRoot, flowName, uuid, instanceId, resolvedScript, execId);
      return;
    } catch (err) {
      lastError = err;
      if (attempt <= TOOL_NODEJS_MAX_RETRIES) {
        const tag = `[tool_nodejs 自愈] ${instanceId} 第 ${attempt}/${TOOL_NODEJS_MAX_RETRIES} 次重试`;
        log.warn(`${tag}：${err.message?.slice(0, 200) || err}`);
        emitEvent(workspaceRoot, flowName, uuid, {
          event: "tool-nodejs-retry",
          instanceId,
          attempt,
          maxRetries: TOOL_NODEJS_MAX_RETRIES,
          error: err.message?.slice(0, 300) || String(err),
        });

        if (AI_HEAL_ENABLED && healOptions) {
          const errorInfo = {
            stdout: err.scriptStdout || "",
            stderr: err.scriptStderr || "",
            exitCode: err.scriptExitCode ?? 1,
          };
          await healToolNodejsWithAI(
            workspaceRoot, flowName, uuid, instanceId, resolvedScript,
            errorInfo, healOptions.cli, healOptions.model,
          );
        }

        if (TOOL_NODEJS_RETRY_DELAY_MS > 0) {
          spawnSync("sleep", [String(TOOL_NODEJS_RETRY_DELAY_MS / 1000)], { stdio: "ignore" });
        }
      }
    }
  }
  throw lastError;
}

function executeToolNodejsOnce(workspaceRoot, flowName, uuid, instanceId, resolvedScript, execId) {
  const runDir = getRunDir(workspaceRoot, flowName, uuid);
  const outputDir = path.join(runDir, outputDirForNode(instanceId));

  const { argv, commandLine: normalized } = nodeToolCommandToArgv(resolvedScript);
  let child;
  if (/^node\s/i.test(String(normalized).trim()) && argv.length >= 1) {
    child = spawnSync(process.execPath, argv, {
      cwd: workspaceRoot,
      shell: false,
      stdio: ["inherit", "pipe", "pipe"],
    });
  } else {
    child = spawnSync(normalized, [], {
      cwd: workspaceRoot,
      shell: true,
      stdio: ["inherit", "pipe", "pipe"],
    });
  }

  const stdout = child.stdout?.toString("utf-8") ?? "";
  const stderr = child.stderr?.toString("utf-8") ?? "";
  const exitCode = child.status ?? 1;

  let success = exitCode === 0;
  let resultText = stdout.trim();

  const jsonMatch = stdout.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      if (typeof parsed.err_code === "number" && parsed.message && typeof parsed.message === "object") {
        success = parsed.err_code === 0;
        resultText = parsed.message.result != null ? String(parsed.message.result) : "";
      }
    } catch (_) {}
  }

  fs.mkdirSync(outputDir, { recursive: true });
  backupResolvedOutputsIfExist(runDir, instanceId, execId, ["result", "stderr"]);
  if (resultText) {
    fs.writeFileSync(path.join(outputDir, outputNodeBasename(instanceId, execId, "result")), resultText, "utf-8");
  }
  if (stderr) {
    try { fs.writeFileSync(path.join(outputDir, outputNodeBasename(instanceId, execId, "stderr")), stderr, "utf-8"); } catch (_) {}
  }

  writeResult(workspaceRoot, flowName, uuid, instanceId, {
    status: success ? "success" : "failed",
    message: success
      ? "执行完成"
      : `脚本退出码 ${exitCode}` + (stderr.trim() ? `：${stderr.trim().slice(0, 200)}` : ""),
  }, { preserveBody: true, execId });

  if (!success) {
    const hint = stderr.trim() ? ` ${stderr.trim().slice(0, 280)}` : "";
    const err = new Error(`Script failed (exit ${exitCode}): ${String(normalized).slice(0, 120)}${hint}`);
    err.scriptStdout = stdout;
    err.scriptStderr = stderr;
    err.scriptExitCode = exitCode;
    throw err;
  }
}

/**
 * Execute one node: 按 definitionId / resolvedScript / directCommand 决定执行方式。
 */
export async function executeNode(workspaceRoot, flowName, uuid, instanceId, preOutput, options = {}) {
  const { definitionId, directCommand, resolvedScript, promptPath, nodeContext, taskBody, resultPath, subagent } = preOutput;
  const runDir = getRunDir(workspaceRoot, flowName, uuid);
  const intermediatePath = runDir;

  if (definitionId && LOCAL_ONLY_DEFINITION_IDS.has(definitionId)) {
    return;
  }

  if (resolvedScript) {
    const execId = preOutput.execId ?? 1;
    let healOptions = null;
    if (AI_HEAL_ENABLED) {
      const { cli, model } = resolveCliAndModel(workspaceRoot, preOutput.model ?? null, options.model ?? null);
      healOptions = { cli: cli === "api" ? "cursor" : cli, model };
    }
    emitEvent(workspaceRoot, flowName, uuid, {
      event: "direct-command-start",
      instanceId,
      directCommand: resolvedScript,
    });
    try {
      await executeToolNodejsInline(workspaceRoot, flowName, uuid, instanceId, resolvedScript, execId, healOptions);
      emitEvent(workspaceRoot, flowName, uuid, {
        event: "direct-command-done",
        instanceId,
        directCommand: resolvedScript,
      });
    } catch (err) {
      emitEvent(workspaceRoot, flowName, uuid, {
        event: "direct-command-failed",
        instanceId,
        directCommand: resolvedScript,
        error: err.message,
      });
      throw err;
    }
    return;
  }

  if (directCommand) {
    emitEvent(workspaceRoot, flowName, uuid, {
      event: "direct-command-start",
      instanceId,
      directCommand,
    });
    try {
      const result = spawnSync(directCommand, [], { cwd: workspaceRoot, shell: true, stdio: "inherit" });
      if (result.status !== 0) {
        emitEvent(workspaceRoot, flowName, uuid, {
          event: "direct-command-failed",
          instanceId,
          directCommand,
          exitCode: result.status,
        });
        throw new Error(`Direct command failed: ${directCommand}`);
      }
      emitEvent(workspaceRoot, flowName, uuid, {
        event: "direct-command-done",
        instanceId,
        directCommand,
      });
    } catch (err) {
      if (err.message && !err.message.includes("Direct command failed")) {
        emitEvent(workspaceRoot, flowName, uuid, {
          event: "direct-command-failed",
          instanceId,
          directCommand,
          error: err.message,
        });
      }
      throw err;
    }
    return;
  }

  const { cli, model } = resolveCliAndModel(workspaceRoot, preOutput.model ?? null, options.model ?? null);

  const execId = preOutput.execId ?? 1;
  const flowJsonPath = path.join(runDir, "intermediate", "flow.json");
  let outSlotNames = [];
  if (fs.existsSync(flowJsonPath)) {
    try {
      const flow = JSON.parse(fs.readFileSync(flowJsonPath, "utf-8"));
      if (flow.ok && flow.outputSlotTypes && flow.outputSlotTypes[instanceId]) {
        outSlotNames = Object.keys(flow.outputSlotTypes[instanceId]);
      }
      if (outSlotNames.length === 0 && flow.order && flow.order.includes(instanceId)) {
        const node = flow.nodes?.find((n) => n.id === instanceId);
        const outSlots = node?.output || flow.outputSlotTypes?.[instanceId];
        if (outSlots && typeof outSlots === "object") outSlotNames = Object.keys(outSlots);
      }
    } catch (_) {}
  }
  backupResolvedOutputsIfExist(runDir, instanceId, execId, outSlotNames);

  emitEvent(workspaceRoot, flowName, uuid, {
    event: "agent-invoke-start",
    instanceId,
    subagent: subagent ?? null,
    promptPath: promptPath ?? null,
    resultPathRel: resultPath ?? null,
    modelCli: cli,
    model: model ?? null,
  });
  try {
    if (cli === "api") {
      await runApiAgentForNode(
        workspaceRoot,
        { promptPath, nodeContext: nodeContext ?? "", taskBody: taskBody ?? "", subagent, instanceId },
        {
          model,
          onToolCall: options.onToolCall,
          flowName,
          uuid,
        },
      );
    } else if (cli === "opencode") {
      await runOpenCodeAgentForNode(
        workspaceRoot,
        { promptPath, nodeContext: nodeContext ?? "", taskBody: taskBody ?? "", intermediatePath, resultPathRel: resultPath, subagent, instanceId },
        {
          model,
          stderrBuffer: options.stderrBuffer,
          force: options.force,
          outputPrefix: options.outputPrefix,
          prefixColor: options.prefixColor,
          onToolCall: options.onToolCall,
          flowName,
          uuid,
        },
      );
    } else {
      await runCursorAgentForNode(
        workspaceRoot,
        { promptPath, nodeContext: nodeContext ?? "", taskBody: taskBody ?? "", intermediatePath, resultPathRel: resultPath, subagent, instanceId },
        {
          model,
          stderrBuffer: options.stderrBuffer,
          force: options.force,
          outputPrefix: options.outputPrefix,
          prefixColor: options.prefixColor,
          onToolCall: options.onToolCall,
          flowName,
          uuid,
        },
      );
    }
    emitEvent(workspaceRoot, flowName, uuid, {
      event: "agent-invoke-done",
      instanceId,
      subagent: subagent ?? null,
      modelCli: cli,
      model: model ?? null,
    });
  } catch (err) {
    const payload = {
      event: "agent-invoke-failed",
      instanceId,
      subagent: subagent ?? null,
      modelCli: cli,
      model: model ?? null,
      error: err && err.message ? String(err.message) : String(err),
    };
    if (err && err.cursorStderrTail) payload.cursorStderrTail = err.cursorStderrTail;
    emitEvent(workspaceRoot, flowName, uuid, payload);
    throw err;
  }
}

/**
 * @param {number | undefined} [opts.elapsedMs] 本节点执行耗时（毫秒），写入 result.elapsedMs 供 UI 展示
 */
export function runPostProcess(workspaceRoot, flowName, uuid, instanceId, execId, opts = {}) {
  const args = [workspaceRoot, flowName, uuid, instanceId, String(execId)];
  const { elapsedMs } = opts;
  if (elapsedMs != null && Number.isFinite(elapsedMs) && elapsedMs >= 0) {
    args.push(String(Math.round(elapsedMs)));
  }
  const result = runNodeScript(workspaceRoot, "post-process-node.mjs", args, {
    captureStdout: true,
  });
  parseJsonStdout(result);
}

export function ensureLocalNodeTerminalSuccess(workspaceRoot, flowName, uuid, instanceId, preOutput) {
  if (!preOutput.definitionId || !LOCAL_ONLY_TERMINAL_SUCCESS_IDS.has(preOutput.definitionId)) return;
  const payload = {
    status: "success",
    message: "已通过",
    execId: preOutput.execId ?? 1,
  };
  const result = runNodeScript(
    workspaceRoot,
    "write-result.mjs",
    [workspaceRoot, flowName, uuid, instanceId, "--json", JSON.stringify(payload)],
    { captureStdout: true },
  );
  if (result.status !== 0) {
    log.warn(`[agentflow] ensureLocalNodeTerminalSuccess write-result failed for ${instanceId}: ${result.stdout || result.stderr || result.status}`);
  }
}
