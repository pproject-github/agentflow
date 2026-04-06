import fs from "fs";
import path from "path";
import chalk from "chalk";
import ora from "ora";
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
export async function apply(workspaceRoot, flowName, uuidArg, dryRun, agentModel = null, force = true, parallel = false) {
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

  const parseResult = runNodeScript(workspaceRoot, "parse-flow.mjs", [workspaceRoot, flowName, uuid, flowDir], {
    captureStdout: true,
  });
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
  await apply(workspaceRoot, flowName, uuid, false, agentModel, force, parallel);
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
