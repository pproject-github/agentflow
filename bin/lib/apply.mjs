import fs from "fs";
import path from "path";
import chalk from "chalk";
import ora from "ora";
import readline from "readline";
import { spawn, spawnSync } from "child_process";
import { executeNode, ensureLocalNodeTerminalSuccess, runPostProcess } from "./node-execute.mjs";
import { log } from "./log.mjs";
import { resolveCliAndModel } from "./model-config.mjs";
import { t } from "./i18n.mjs";
import {
  LOCAL_ONLY_DEFINITION_IDS,
  MAX_LOOP_ROUNDS,
  NODE_SEP,
  LEGACY_PIPELINES_DIR,
  PIPELINES_DIR,
  USER_AGENTFLOW_PIPELINES_LABEL,
} from "./paths.mjs";
import { parseJsonStdout, runNodeScript } from "./pipeline-scripts.mjs";
import { appendRunLogLine, emitEvent, ensureRunStartTime, readTotalExecutedMs, saveTotalExecutedMs } from "./run-events.mjs";
import { formatDuration } from "./terminal.mjs";
import { printEntryAndFlowFiles, printNodeStatusTable, runValidateFlowAndExitIfInvalid } from "./ui-print.mjs";
import { clearApplyActiveLock, writeApplyActiveLock } from "./run-apply-active-lock.mjs";
import { ensureReference, findFlowNameByUuid, getFlowDir, getRunDir } from "./workspace.mjs";

const PARALLEL_PREFIX_COLORS = [
  (s) => chalk.cyan(s),
  (s) => chalk.green(s),
  (s) => chalk.yellow(s),
  (s) => chalk.magenta(s),
  (s) => chalk.blue(s),
];

/** parallel 默认 false */
export async function apply(workspaceRoot, flowName, uuidArg, dryRun, agentModel = null, force = true, parallel = false, cliInputs = {}) {
  ensureReference(workspaceRoot);
  const flowDir = getFlowDir(workspaceRoot, flowName);
  if (!flowDir) {
    throw new Error(
      `Flow not found: ${flowName} (no flow.yaml under ${USER_AGENTFLOW_PIPELINES_LABEL}/${flowName}, ${PIPELINES_DIR}/${flowName}, ${LEGACY_PIPELINES_DIR}/${flowName}, or builtin)`,
    );
  }
  runValidateFlowAndExitIfInvalid(workspaceRoot, flowName, flowDir);
  const ensureArgs = [workspaceRoot, uuidArg ?? "", flowName];
  const ensureResult = runNodeScript(workspaceRoot, "ensure-run-dir.mjs", ensureArgs, { captureStdout: true });
  const { uuid } = parseJsonStdout(ensureResult);

  const parseArgs = [workspaceRoot, flowName, uuid, flowDir];
  if (Object.keys(cliInputs).length > 0) {
    parseArgs.push("--cli-inputs", JSON.stringify(cliInputs));
  }
  const parseResult = runNodeScript(workspaceRoot, "parse-flow.mjs", parseArgs, { captureStdout: true });
  const parseOut = parseJsonStdout(parseResult);
  if (!parseOut.ok) throw new Error(parseOut.error || "parse-flow failed");

  printEntryAndFlowFiles(workspaceRoot, flowName, uuid);
  emitEvent(workspaceRoot, flowName, uuid, {
    event: "apply-start",
    flowName,
    uuid,
    runDir: getRunDir(workspaceRoot, flowName, uuid),
    dryRun: Boolean(dryRun),
    parallel: Boolean(parallel),
  });
  writeApplyActiveLock(workspaceRoot, flowName, uuid);

  try {
  let runStartTime = null;
  let totalExecutedMs = 0;
  let round = 0;
  while (round < MAX_LOOP_ROUNDS) {
    round++;
    const readyResult = runNodeScript(workspaceRoot, "get-ready-nodes.mjs", [workspaceRoot, flowName, uuid], {
      captureStdout: true,
    });
    const { readyNodes = [], allDone, pendingNodes = [], instanceStatus = {}, execIdMap = {} } = parseJsonStdout(readyResult);

    if (round === 1) printNodeStatusTable(instanceStatus, parseOut.nodes, execIdMap);

    if (readyNodes.length === 0) {
      if (allDone) {
        saveTotalExecutedMs(workspaceRoot, flowName, uuid, totalExecutedMs);
        const totalElapsed = formatDuration(totalExecutedMs);
        emitEvent(workspaceRoot, flowName, uuid, {
          event: "apply-done",
          flowName,
          uuid,
          runDir: getRunDir(workspaceRoot, flowName, uuid),
          totalElapsed,
        });
        log.info(`\n${t("apply.done")}. uuid=${uuid} runDir=${getRunDir(workspaceRoot, flowName, uuid)}  ${chalk.dim(t("common.total") + " " + totalElapsed)}`);
        return;
      }
      if (pendingNodes.length > 0) {
        saveTotalExecutedMs(workspaceRoot, flowName, uuid, totalExecutedMs);
        const totalElapsed = formatDuration(totalExecutedMs);
        const resumeExample =
          pendingNodes.length === 1
            ? `agentflow resume ${flowName} ${uuid} ${pendingNodes[0]}`
            : `agentflow resume ${flowName} ${uuid}`;
        emitEvent(workspaceRoot, flowName, uuid, {
          event: "apply-paused",
          flowName,
          uuid,
          pendingNodes,
          totalElapsed,
          resumeExample,
        });
        log.info(`\n${t("apply.paused")}: uuid=${uuid} pendingNodes=${pendingNodes.join(", ")}  ${chalk.dim(t("common.total") + " " + totalElapsed)}`);

        let userConfirmed = false;
        for (const pendId of pendingNodes) {
          const pendNode = parseOut.nodes?.find((n) => n.id === pendId);
          if (pendNode?.definitionId === "tool_user_check") {
            const pendExecId = execIdMap[pendId] ?? 1;
            const contentPath = path.join(getRunDir(workspaceRoot, flowName, uuid), `output/${pendId}/node_${pendId}_content.md`);
            if (fs.existsSync(contentPath)) {
              const checkContent = fs.readFileSync(contentPath, "utf-8");
              
              // CLI 交互式确认
              if (!process.stdin.isTTY) {
                log.info(chalk.bold.cyan(`\n━━━ 用户确认内容 (${pendId}) ━━━`));
                const contentLines = checkContent.split("\n").slice(0, 50);
                for (const line of contentLines) {
                  process.stderr.write("  " + line + "\n");
                }
                process.stderr.write(chalk.bold.cyan("━━━━━━━━━━━━━━━━━━━━━━━━━\n"));
                log.info(chalk.bold.yellow("→ " + t("flow.resume_hint") + " ") + resumeExample);
                return;
              }

              // 显示内容和交互菜单
              console.log("");
              console.log(chalk.bold.cyan(`╔════════════════════════════════════════════════════════════╗`));
              console.log(chalk.bold.cyan(`║  用户确认节点: ${pendId}`) + " ".repeat(40 - pendId.length) + "║");
              console.log(chalk.bold.cyan(`╠════════════════════════════════════════════════════════════╣`));
              console.log(chalk.bold.cyan(`║  文件路径: ${chalk.dim(contentPath)}`));
              console.log(chalk.bold.cyan(`╚════════════════════════════════════════════════════════════╝`));
              console.log("");

              // 显示内容预览
              const contentLines = checkContent.split("\n");
              const previewLines = contentLines.slice(0, 30);
              console.log(chalk.dim("─".repeat(60)));
              for (const line of previewLines) {
                console.log("  " + line);
              }
              if (contentLines.length > 30) {
                console.log(chalk.dim(`  ... (${contentLines.length - 30} 行已截断)`));
              }
              console.log(chalk.dim("─".repeat(60)));
              console.log("");

              // 交互菜单
              const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
              
              while (true) {
                console.log(chalk.bold("操作选项:"));
                console.log("  " + chalk.green("c") + " - 确认并继续");
                console.log("  " + chalk.blue("e") + " - 编辑内容（使用外部编辑器）");
                console.log("  " + chalk.magenta("a") + " - AI 修改（输入指令）");
                console.log("  " + chalk.yellow("v") + " - 查看完整内容");
                console.log("  " + chalk.red("q") + " - 取消并退出");
                console.log("");

                const answer = await new Promise((resolve) => {
                  rl.question(chalk.bold("请选择操作 [c/e/a/v/q]: "), resolve);
                });

                if (answer.trim().toLowerCase() === "c" || answer.trim() === "") {
                  // 确认继续
                  log.info(chalk.dim("用户确认，继续执行..."));
                  const resultPayload = { status: "success", message: "用户确认通过", execId: pendExecId };
                  runNodeScript(workspaceRoot, "write-result.mjs", [workspaceRoot, flowName, uuid, pendId, "--json", JSON.stringify(resultPayload)], { captureStdout: true });
                  userConfirmed = true;
                  rl.close();
                  break;
                } else if (answer.trim().toLowerCase() === "e") {
                  // 使用外部编辑器
                  const editor = process.env.EDITOR || process.env.VISUAL || "vim";
                  console.log(chalk.dim(`正在打开编辑器: ${editor} ${contentPath}`));
                  rl.pause();
                  const { status } = spawnSync(editor, [contentPath], { stdio: "inherit" });
                  rl.resume();
                  if (status === 0) {
                    console.log(chalk.green("编辑完成，内容已保存"));
                    // 重新读取内容
                    const editedContent = fs.readFileSync(contentPath, "utf-8");
                    console.log(chalk.dim("─".repeat(60)));
                    const newLines = editedContent.split("\n").slice(0, 10);
                    for (const line of newLines) {
                      console.log("  " + line);
                    }
                    console.log(chalk.dim("─".repeat(60)));
                  } else {
                    console.log(chalk.yellow("编辑器退出异常"));
                  }
                } else if (answer.trim().toLowerCase() === "a") {
                  // AI 修改
                  const aiPrompt = await new Promise((resolve) => {
                    rl.question(chalk.magenta("输入 AI 修改指令: "), resolve);
                  });
                  if (aiPrompt.trim()) {
                    console.log(chalk.dim("AI 正在修改..."));
                    const currentContent = fs.readFileSync(contentPath, "utf-8");
                    
                    // 调用 OpenCode
                    const opencodeCmd = process.env.OPENCODE_CMD || "opencode";
                    const tmpPromptFile = path.join(getRunDir(workspaceRoot, flowName, uuid), `intermediate/${pendId}_ai_prompt.txt`);
                    const fullPrompt = `请根据以下指令修改内容。直接输出修改后的完整内容，不要解释。

原始内容：
---
${currentContent}
---

修改指令：${aiPrompt}

请直接输出修改后的完整内容（保持原有格式）：`;
                    
                    fs.mkdirSync(path.dirname(tmpPromptFile), { recursive: true });
                    fs.writeFileSync(tmpPromptFile, fullPrompt, "utf-8");
                    
                    const result = spawnSync(opencodeCmd, ["--prompt-file", tmpPromptFile, "--print"], {
                      cwd: workspaceRoot,
                      env: { ...process.env, OPENCODE_NON_INTERACTIVE: "1" },
                      stdio: ["ignore", "pipe", "pipe"],
                    });
                    
                    try { fs.unlinkSync(tmpPromptFile); } catch (_) {}
                    
                    if (result.status === 0 && result.stdout) {
                      const editedContent = result.stdout.toString().trim();
                      fs.writeFileSync(contentPath, editedContent, "utf-8");
                      console.log(chalk.green("AI 修改完成"));
                      console.log(chalk.dim("─".repeat(60)));
                      const newLines = editedContent.split("\n").slice(0, 10);
                      for (const line of newLines) {
                        console.log("  " + line);
                      }
                      console.log(chalk.dim("─".repeat(60)));
                    } else {
                      console.log(chalk.red("AI 修改失败: " + (result.stderr?.toString() || "未知错误")));
                    }
                  }
                } else if (answer.trim().toLowerCase() === "v") {
                  // 查看完整内容
                  console.log("");
                  console.log(chalk.dim("─".repeat(60)));
                  const fullContent = fs.readFileSync(contentPath, "utf-8");
                  for (const line of fullContent.split("\n")) {
                    console.log("  " + line);
                  }
                  console.log(chalk.dim("─".repeat(60)));
                  console.log("");
                } else if (answer.trim().toLowerCase() === "q") {
                  rl.close();
                  log.info(chalk.yellow("用户取消，流程暂停。") + chalk.dim(` 恢复命令: ${resumeExample}`));
                  return;
                }
              }
            }
          }
        }

        if (userConfirmed) {
          // 用户确认后继续循环
          continue;
        }

        log.info(chalk.bold.yellow("→ " + t("flow.resume_hint") + " ") + resumeExample);
        return;
      }
      const endNodeIds = Array.isArray(parseOut.nodes)
        ? parseOut.nodes.filter((n) => n.definitionId === "control_end").map((n) => n.id)
        : [];
      const endReached = endNodeIds.some((id) => instanceStatus[id] === "success");
      if (endReached) {
        saveTotalExecutedMs(workspaceRoot, flowName, uuid, totalExecutedMs);
        const totalElapsed = formatDuration(totalExecutedMs);
        emitEvent(workspaceRoot, flowName, uuid, {
          event: "apply-done",
          flowName,
          uuid,
          runDir: getRunDir(workspaceRoot, flowName, uuid),
          totalElapsed,
        });
        log.info(`\n${t("apply.done")}. uuid=${uuid} runDir=${getRunDir(workspaceRoot, flowName, uuid)}  ${chalk.dim(t("common.total") + " " + totalElapsed)}`);
        return;
      }
      const totalElapsed = formatDuration(totalExecutedMs);
      const stuckErr = new Error(t("flow.stuck_error") + " " + t("common.total") + " " + totalElapsed);
      stuckErr.flowName = flowName;
      stuckErr.uuid = uuid;
      throw stuckErr;
    }

    if (dryRun) {
      const totalElapsed = formatDuration(totalExecutedMs);
      log.info(`\n${t("flow.dry_run_nodes", { nodes: readyNodes.join(", ") })}  ${chalk.dim(t("common.total") + " " + totalElapsed)}`);
      return;
    }

    if (runStartTime === null) {
      runStartTime = ensureRunStartTime(workspaceRoot, flowName, uuid);
      totalExecutedMs = readTotalExecutedMs(workspaceRoot, flowName, uuid);
    }

    const idToLabel = new Map();
    if (Array.isArray(parseOut.nodes)) for (const n of parseOut.nodes) idToLabel.set(n.id, n.label || n.id);

    const preOutputs = [];
    for (const instanceId of readyNodes) {
      log.debug(`[agentflow] 进入节点 flowName=${flowName} uuid=${uuid} instanceId=${instanceId} round=${round}`);
      const preResult = runNodeScript(workspaceRoot, "pre-process-node.mjs", [workspaceRoot, flowName, uuid, instanceId], {
        captureStdout: true,
      });
      const preOutput = parseJsonStdout(preResult);
      preOutputs.push({ instanceId, label: idToLabel.get(instanceId) || instanceId, preOutput });
      log.debug(
        `[agentflow] 执行节点 instanceId=${instanceId} definitionId=${preOutput.definitionId ?? "-"} promptPath=${preOutput.promptPath} resultPath=${preOutput.resultPath} subagent=${preOutput.subagent} role=${preOutput.role ?? "-"} model=${preOutput.model ?? "-"} execId=${preOutput.execId} directCommand=${preOutput.directCommand ? "yes" : "-"}`,
      );
    }

    const runOne = async ({ instanceId, label, preOutput, outputPrefix, prefixColor }, isParallel) => {
      let elapsedMsForPost = undefined;
      if (!isParallel) {
        const isLocalOnly = preOutput.definitionId && LOCAL_ONLY_DEFINITION_IDS.has(preOutput.definitionId);
        const { label: resolvedLabel } = resolveCliAndModel(workspaceRoot, preOutput.model ?? null, agentModel ?? null);
        const modelLabel = isLocalOnly ? `(${t("common.local")})` : resolvedLabel;
        const promptAbs = path.resolve(workspaceRoot, preOutput.promptPath);
        const cliResolved = resolveCliAndModel(workspaceRoot, preOutput.model ?? null, agentModel ?? null);
        emitEvent(workspaceRoot, flowName, uuid, {
          event: "node-start",
          instanceId,
          label,
          definitionId: preOutput.definitionId ?? null,
          modelCli: isLocalOnly ? null : cliResolved.cli,
          model: modelLabel,
          execId: preOutput.execId ?? null,
          promptPathRel: preOutput.promptPath ?? null,
          promptPathAbs: promptAbs,
          resultPathRel: preOutput.resultPath ?? null,
          subagent: preOutput.subagent ?? null,
          directCommand: preOutput.directCommand ? String(preOutput.directCommand) : null,
        });
        appendRunLogLine(workspaceRoot, flowName, uuid, "cli-raw", `${t("node.start")} ${instanceId} (${label}) model: ${modelLabel}`);
        appendRunLogLine(workspaceRoot, flowName, uuid, "cli-raw", `Prompt: ${promptAbs}`);
        process.stderr.write("\n" + NODE_SEP + "\n");
        process.stderr.write(
          chalk.bold.cyan(t("node.start") + " ") + instanceId + chalk.dim(" (" + label + ")") + "  " + chalk.dim(t("node.model_label") + ": ") + chalk.yellow(modelLabel) + "\n",
        );
        log.info(chalk.dim("Prompt: ") + promptAbs);
        process.stderr.write(NODE_SEP + "\n\n");
        const startTime = Date.now();
        const getTotalStr = () => formatDuration(totalExecutedMs + (Date.now() - startTime));
        const initialRunningText = `Running: ${instanceId} (${label})  ${formatDuration(0) + " / " + getTotalStr()}`;
        appendRunLogLine(workspaceRoot, flowName, uuid, "cli-raw", initialRunningText);
        const spinner = ora({
          text: `Running: ${instanceId} ${chalk.dim("(" + label + ")")}  ${chalk.dim(formatDuration(0) + " / " + getTotalStr())}`,
          stream: process.stderr,
          discardStdin: false,
        }).start();
        let lastToolCallText = "";
        const updateSpinnerText = () => {
          const duration = formatDuration(Date.now() - startTime) + " / " + getTotalStr();
          spinner.text =
            `Running: ${instanceId} ${chalk.dim("(" + label + ")")}  ${chalk.dim(duration)}` +
            (lastToolCallText ? "  " + chalk.dim("| " + lastToolCallText) : "");
        };
        const timeTick = setInterval(updateSpinnerText, 1000);
        const stderrBuffer = [];
        let elapsedStr = "";
        try {
          await executeNode(workspaceRoot, flowName, uuid, instanceId, preOutput, {
            model: agentModel,
            stderrBuffer,
            force,
            outputPrefix: instanceId,
            prefixColor: (s) => chalk.cyan(s),
            onToolCall(subtype, toolName) {
              lastToolCallText = subtype === "thinking" ? "thinking" : `${toolName} ${subtype}`;
              updateSpinnerText();
            },
          });
          clearInterval(timeTick);
          const nodeMs = Date.now() - startTime;
          elapsedMsForPost = nodeMs;
          totalExecutedMs += nodeMs;
          elapsedStr = formatDuration(nodeMs);
          const totalStr = formatDuration(totalExecutedMs);
          spinner.succeed(
            chalk.green(`${t("node.done_label")}: ${instanceId}`) + chalk.dim(" (" + label + ")") + "  " + chalk.dim(elapsedStr) + "  " + chalk.dim(t("common.total") + " " + totalStr),
          );
          emitEvent(workspaceRoot, flowName, uuid, {
            event: "node-done",
            instanceId,
            label,
            elapsed: elapsedStr,
            total: totalStr,
          });
        } catch (err) {
          clearInterval(timeTick);
          const nodeMs = Date.now() - startTime;
          totalExecutedMs += nodeMs;
          elapsedStr = formatDuration(nodeMs);
          const totalStr = formatDuration(totalExecutedMs);
          spinner.fail(
            chalk.red(`${t("node.failed_label")}: ${instanceId}`) + chalk.dim(" (" + label + ")") + "  " + chalk.dim(elapsedStr) + "  " + chalk.dim(t("common.total") + " " + totalStr),
          );
          emitEvent(workspaceRoot, flowName, uuid, {
            event: "node-failed",
            instanceId,
            label,
            elapsed: elapsedStr,
            total: totalStr,
            error: err && err.message ? String(err.message) : String(err),
          });
          if (stderrBuffer.length > 0) process.stderr.write(Buffer.concat(stderrBuffer));
          err.flowName = flowName;
          err.uuid = uuid;
          throw err;
        }
        if (stderrBuffer.length > 0) process.stderr.write(Buffer.concat(stderrBuffer));
        process.stderr.write("\n" + NODE_SEP + "\n");
        process.stderr.write(
          chalk.bold.cyan(t("node.end") + " ") +
            instanceId +
            chalk.dim(" (" + label + ")") +
            (elapsedStr ? "  " + chalk.dim(elapsedStr) : "") +
            "  " +
            chalk.dim(t("common.total") + " " + formatDuration(totalExecutedMs)) +
            "\n",
        );
        process.stderr.write(NODE_SEP + "\n");
      } else {
        const startTime = Date.now();
        await executeNode(workspaceRoot, flowName, uuid, instanceId, preOutput, {
          model: agentModel,
          stderrBuffer: [],
          force,
          outputPrefix,
          prefixColor,
        });
        elapsedMsForPost = Date.now() - startTime;
      }
      runPostProcess(workspaceRoot, flowName, uuid, instanceId, preOutput.execId, { elapsedMs: elapsedMsForPost });
      ensureLocalNodeTerminalSuccess(workspaceRoot, flowName, uuid, instanceId, preOutput);

      // user_check 节点：在主流程中发送事件，因为 post-process 的 emitEvent 被子进程捕获
      if (preOutput.definitionId === "tool_user_check") {
        const runDir = getRunDir(workspaceRoot, flowName, uuid);
        const execId = preOutput.execId ?? 1;
        const outputPath = path.join(runDir, `output/${instanceId}/node_${instanceId}_content.md`);

        // 获取 resolvedInputs
        const resolvedResult = runNodeScript(workspaceRoot, "get-resolved-values.mjs", [workspaceRoot, flowName, uuid, instanceId], { captureStdout: true });
        const resolvedData = parseJsonStdout(resolvedResult);

        // 读取 content 输入槽位的内容
        let content = "";
        let contentInputPath = null;
        if (resolvedData.ok && resolvedData.resolvedInputs?.content) {
          contentInputPath = resolvedData.resolvedInputs.content;
          if (contentInputPath && fs.existsSync(contentInputPath)) {
            try {
              content = fs.readFileSync(contentInputPath, "utf-8");
            } catch (_) {}
          }
        }

        // 确保 output 文件存在
        try {
          fs.mkdirSync(path.dirname(outputPath), { recursive: true });
          fs.writeFileSync(outputPath, content, "utf-8");
        } catch (_) {}

        emitEvent(workspaceRoot, flowName, uuid, {
          type: "user-check-content",
          event: "user-check-content",
          instanceId,
          execId,
          inputPath: contentInputPath,
          outputPath: `output/${instanceId}/node_${instanceId}_content.md`,
          content,
        });
      }

      // tool_print 节点：CLI 框框展示 + 发送事件供 Web UI 显示
      if (preOutput.definitionId === "tool_print") {
        const runDir = getRunDir(workspaceRoot, flowName, uuid);
        const execId = preOutput.execId ?? 1;
        const resultPath = path.join(runDir, `intermediate/${instanceId}/${instanceId}.result.md`);

        if (fs.existsSync(resultPath)) {
          const raw = fs.readFileSync(resultPath, "utf-8");
          const bodyMatch = raw.match(/---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n([\s\S]*)$/);
          const content = bodyMatch ? bodyMatch[1].trim() : raw.trim();

          if (content) {
            // CLI 框框样式展示（参考 user_check）
            console.log("");
            console.log(chalk.bold.cyan(`╔════════════════════════════════════════════════════════════╗`));
            const titleLine = `║  Print 输出: ${instanceId}`;
            const padding = 58 - titleLine.length;
            console.log(chalk.bold.cyan(titleLine + " ".repeat(Math.max(0, padding)) + "║"));
            console.log(chalk.bold.cyan(`╚════════════════════════════════════════════════════════════╝`));
            console.log("");

            const contentLines = content.split("\n");
            const previewLines = contentLines.slice(0, 30);
            console.log(chalk.dim("─".repeat(60)));
            for (const line of previewLines) {
              console.log("  " + line);
            }
            if (contentLines.length > 30) {
              console.log(chalk.dim(`  ... (${contentLines.length - 30} 行已截断)`));
            }
            console.log(chalk.dim("─".repeat(60)));
            console.log("");

            // 发送事件供 Web UI 显示右下角通知卡片
            emitEvent(workspaceRoot, flowName, uuid, {
              type: "tool-print-content",
              event: "tool-print-content",
              instanceId,
              execId,
              content,
            });
          }
        }
      }

      log.debug(`[agentflow] 退出节点 instanceId=${instanceId} execId=${preOutput.execId}`);
    };

    const useParallel = parallel && preOutputs.length > 1;
    if (useParallel) {
      preOutputs.forEach((item, i) => {
        item.outputPrefix = item.instanceId;
        item.prefixColor = PARALLEL_PREFIX_COLORS[i % PARALLEL_PREFIX_COLORS.length];
      });
      emitEvent(workspaceRoot, flowName, uuid, {
        event: "parallel-start",
        size: preOutputs.length,
        nodes: preOutputs.map((p) => ({
          instanceId: p.instanceId,
          label: p.label,
          definitionId: p.preOutput?.definitionId ?? null,
          promptPathRel: p.preOutput?.promptPath ?? null,
        })),
      });
      appendRunLogLine(
        workspaceRoot,
        flowName,
        uuid,
        "cli-raw",
        `${t("node.start_parallel")} ${preOutputs.length} 个节点: ${preOutputs.map((p) => p.instanceId).join(", ")}`,
      );
      preOutputs.forEach((item) => {
        const abs = path.resolve(workspaceRoot, item.preOutput.promptPath);
        appendRunLogLine(workspaceRoot, flowName, uuid, "cli-raw", `Prompt: ${abs}`);
      });
      appendRunLogLine(
        workspaceRoot,
        flowName,
        uuid,
        "cli-raw",
        `Running ${preOutputs.length} nodes in parallel: ${preOutputs.map((p) => p.instanceId).join(", ")}`,
      );
      process.stderr.write("\n" + NODE_SEP + "\n");
      process.stderr.write(chalk.bold.cyan(t("node.start_parallel") + " ") + preOutputs.length + " 个节点: " + preOutputs.map((p) => p.instanceId).join(", ") + "\n");
      for (const item of preOutputs) log.info(chalk.dim("Prompt: ") + path.resolve(workspaceRoot, item.preOutput.promptPath));
      process.stderr.write(NODE_SEP + "\n\n");
      log.info(chalk.cyan(`Running ${preOutputs.length} nodes in parallel: ${preOutputs.map((p) => p.instanceId).join(", ")}`));
      const parallelBatchStart = Date.now();
      await Promise.all(preOutputs.map((item) => runOne(item, true)));
      totalExecutedMs += Date.now() - parallelBatchStart;
      const totalStrPar = formatDuration(totalExecutedMs);
      process.stderr.write("\n" + NODE_SEP + "\n");
      process.stderr.write(chalk.bold.cyan(t("node.end_parallel") + "  ") + chalk.dim(t("common.total") + " " + totalStrPar) + "\n");
      process.stderr.write(NODE_SEP + "\n");
      emitEvent(workspaceRoot, flowName, uuid, {
        event: "parallel-done",
        size: preOutputs.length,
        total: totalStrPar,
      });
    } else {
      for (const item of preOutputs) await runOne(item, false);
    }
  }
  const totalElapsed = formatDuration(totalExecutedMs);
  const maxErr = new Error(`Max rounds (${MAX_LOOP_ROUNDS}) reached. ${t("common.total")} ${totalElapsed}`);
  maxErr.flowName = flowName;
  maxErr.uuid = uuid;
  throw maxErr;
  } finally {
    clearApplyActiveLock(workspaceRoot, flowName, uuid);
  }
}

export async function resume(workspaceRoot, flowName, uuid, instanceIdOptional, agentModel = null, force = true, parallel = false) {
  let nodesToResume = [];
  if (instanceIdOptional) {
    nodesToResume = [instanceIdOptional];
  } else {
    const readyResult = runNodeScript(workspaceRoot, "get-ready-nodes.mjs", [workspaceRoot, flowName, uuid], { captureStdout: true });
    const { pendingNodes = [], instanceStatus = {} } = parseJsonStdout(readyResult);
    const failedNodes = Object.keys(instanceStatus).filter((id) => instanceStatus[id] === "failed");
    nodesToResume = [...new Set([...pendingNodes, ...failedNodes])];
  }
  const payload = JSON.stringify({ status: "success", message: t("apply.user_confirmed") });
  for (const instanceId of nodesToResume) {
    const wr = runNodeScript(
      workspaceRoot,
      "write-result.mjs",
      [workspaceRoot, flowName, uuid, instanceId, "--json", payload],
      { captureStdout: true },
    );
    if (wr.status !== 0) {
      const err = (wr.stdout || "").trim() || wr.stderr || "write-result failed";
      throw new Error(`resume: write result for ${instanceId} failed: ${err}`);
    }
    log.info(chalk.dim(`Resumed node: ${instanceId}`));
  }
  await apply(workspaceRoot, flowName, uuid, false, agentModel, force, parallel, {});
}

export async function replay(workspaceRoot, flowNameOrUuid, uuidOrInstanceId, instanceIdArg, agentModel = null, force = true) {
  let flowName, uuid, instanceId;
  const flowJsonPathFor = (f, u) => path.join(getRunDir(workspaceRoot, f, u), "intermediate", "flow.json");

  if (instanceIdArg !== undefined) {
    flowName = flowNameOrUuid;
    uuid = uuidOrInstanceId;
    instanceId = instanceIdArg;
  } else {
    uuid = flowNameOrUuid;
    instanceId = uuidOrInstanceId;
    flowName = findFlowNameByUuid(workspaceRoot, uuid);
    if (!flowName) {
      throw new Error("No run found for uuid " + uuid + ". Run apply first or use: agentflow replay <flowName> <uuid> <instanceId>");
    }
    const flowJsonPath = flowJsonPathFor(flowName, uuid);
    if (!fs.existsSync(flowJsonPath)) {
      throw new Error("flow.json not found. Run apply first or use: agentflow replay <flowName> <uuid> <instanceId>");
    }
    const flow = JSON.parse(fs.readFileSync(flowJsonPath, "utf-8"));
    if (!flow.flowName && !flow.name) {
      throw new Error("flow.json missing flowName. Use: agentflow replay <flowName> <uuid> <instanceId>");
    }
  }

  log.debug(`[agentflow] 进入节点 flowName=${flowName} uuid=${uuid} instanceId=${instanceId}`);
  const preResult = runNodeScript(workspaceRoot, "pre-process-node.mjs", [workspaceRoot, flowName, uuid, instanceId], { captureStdout: true });
  const preOutput = parseJsonStdout(preResult);
  log.debug(
    `[agentflow] 执行节点 instanceId=${instanceId} definitionId=${preOutput.definitionId ?? "-"} promptPath=${preOutput.promptPath} resultPath=${preOutput.resultPath} subagent=${preOutput.subagent} modelType=${preOutput.modelType ?? "-"} execId=${preOutput.execId} directCommand=${preOutput.directCommand ? "yes" : "-"}`,
  );
  const promptAbs = path.resolve(workspaceRoot, preOutput.promptPath);
  const isLocalOnlyReplay = preOutput.definitionId && LOCAL_ONLY_DEFINITION_IDS.has(preOutput.definitionId);
  const { label: modelLabelReplay } = resolveCliAndModel(workspaceRoot, preOutput.model ?? null, agentModel ?? null);
  const modelLabelDisplay = isLocalOnlyReplay ? `(${t("common.local")})` : modelLabelReplay;
  emitEvent(workspaceRoot, flowName, uuid, {
    event: "replay-start",
    flowName,
    uuid,
    instanceId,
    definitionId: preOutput.definitionId ?? null,
    model: modelLabelDisplay,
    execId: preOutput.execId ?? null,
    promptPathRel: preOutput.promptPath ?? null,
    promptPathAbs: promptAbs,
    resultPathRel: preOutput.resultPath ?? null,
  });
  appendRunLogLine(workspaceRoot, flowName, uuid, "cli-raw", `${t("node.start")} replay 节点 ${instanceId} model: ${modelLabelDisplay}`);
  appendRunLogLine(workspaceRoot, flowName, uuid, "cli-raw", `Prompt: ${promptAbs}`);
  process.stderr.write("\n" + NODE_SEP + "\n");
  process.stderr.write(chalk.bold.cyan(t("node.start") + " ") + instanceId + "  " + chalk.dim(t("node.model_label") + ": ") + chalk.yellow(modelLabelDisplay) + "\n");
  log.info(chalk.dim("Prompt: ") + promptAbs);
  process.stderr.write(NODE_SEP + "\n\n");
  const replayStart = Date.now();
  await executeNode(workspaceRoot, flowName, uuid, instanceId, preOutput, { model: agentModel, force });
  runPostProcess(workspaceRoot, flowName, uuid, instanceId, preOutput.execId, { elapsedMs: Date.now() - replayStart });
  ensureLocalNodeTerminalSuccess(workspaceRoot, flowName, uuid, instanceId, preOutput);
  log.debug(`[agentflow] 退出节点 instanceId=${instanceId} execId=${preOutput.execId}`);
  process.stderr.write("\n" + NODE_SEP + "\n");
  process.stderr.write(chalk.bold.cyan(t("node.end") + " ") + instanceId + "\n");
  process.stderr.write(NODE_SEP + "\n");
  emitEvent(workspaceRoot, flowName, uuid, {
    event: "replay-done",
    flowName,
    uuid,
    instanceId,
  });
  log.info(`\nReplay done. ${instanceId} uuid=${uuid}`);
}
