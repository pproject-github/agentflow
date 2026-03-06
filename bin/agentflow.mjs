#!/usr/bin/env node
/**
 * AgentFlow CLI: drive apply/replay from command line.
 * Commands: agentflow apply <FlowName> [uuid], agentflow replay [flowName] <uuid> <instanceId>
 * Cursor agent execution uses --print --output-format stream-json.
 */

import { spawn, spawnSync } from "child_process";
import { createRequire } from "module";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import chalk from "chalk";
import ora from "ora";
import { createMarkdownStreamer, render as renderMarkdown } from "markdansi";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const Table = require("cli-table3");

/** 节点执行区域分割线（开始/结束标识用） */
const NODE_SEP = "════════════════════════════════════════════════════════════════";

/** 读取 result 文件正文（frontmatter 之后的内容），用于 Print 节点输出到终端 */
function readResultBody(workspaceRoot, uuid, resultPathRel) {
  const resultPath = path.join(workspaceRoot, ".workspace", "agentflow", uuid, resultPathRel);
  if (!fs.existsSync(resultPath)) return "";
  const raw = fs.readFileSync(resultPath, "utf-8");
  const match = raw.match(/---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n([\s\S]*)$/);
  return match ? match[1].trim() : "";
}

/** 当前时间 hh:MM:ss（24 小时） */
function formatTimeHHMMSS() {
  const d = new Date();
  const h = String(d.getHours()).padStart(2, "0");
  const m = String(d.getMinutes()).padStart(2, "0");
  const s = String(d.getSeconds()).padStart(2, "0");
  return `${h}:${m}:${s}`;
}

/** 耗时展示：<1 分钟只展示秒，<1 小时展示分秒，>=1 小时展示时分秒 */
function formatDuration(ms) {
  if (ms < 0 || !Number.isFinite(ms)) return "0s";
  const sec = Math.floor(ms / 1000) % 60;
  const min = Math.floor(ms / 60000) % 60;
  const hour = Math.floor(ms / 3600000);
  if (hour > 0) return `${hour}h ${min}m ${sec}s`;
  if (min > 0) return `${min}m ${sec}s`;
  return `${sec}s`;
}

const SAVE_CURSOR = "\x1b[s";
const RESTORE_CURSOR = "\x1b[u";
/** 在终端右下角写入一行文字（需 TTY）。pos 为从右往左的字符数，默认 8（hh:MM:ss） */
function writeBottomRight(stream, text, pos = 8) {
  if (!stream.isTTY || stream.columns == null || stream.rows == null) return;
  const cols = stream.columns || 80;
  const rows = stream.rows || 24;
  const col = Math.max(1, cols - pos);
  stream.write(SAVE_CURSOR + `\x1b[${rows};${col}H` + text + RESTORE_CURSOR);
}

/** 并行时按节点着色的 palette，仅对行前缀上色 */
const PARALLEL_PREFIX_COLORS = [
  (s) => chalk.cyan(s),
  (s) => chalk.green(s),
  (s) => chalk.yellow(s),
  (s) => chalk.magenta(s),
  (s) => chalk.blue(s),
];

/** 对多行文本每行前加前缀后写入 stream；prefix 可为已着色字符串；contentColor(line) 可选，对每行正文上色（用于区分 Cursor AI 输出） */
function writeWithPrefix(stream, text, prefix, contentColor = null) {
  if (!text || !prefix) {
    if (text) stream.write(contentColor ? contentColor(text) : text);
    return;
  }
  const lines = text.split("\n");
  const out = lines.map((line) => prefix + (contentColor ? contentColor(line) : line)).join("\n");
  stream.write(out + (text.endsWith("\n") ? "" : "\n"));
}

/** 日志等级：debug 最低优先级（仅 --debug 时输出灰色），info / warn / error 依次升高 */
const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
let currentLogLevel = LOG_LEVELS.info;

const log = {
  debug: (msg) => {
    if (currentLogLevel <= LOG_LEVELS.debug) process.stderr.write(chalk.dim(msg) + "\n");
  },
  info: (msg) => {
    if (currentLogLevel <= LOG_LEVELS.info) process.stdout.write(msg + "\n");
  },
  warn: (msg) => {
    if (currentLogLevel <= LOG_LEVELS.warn) process.stderr.write(chalk.yellow(msg) + "\n");
  },
  error: (msg) => {
    if (currentLogLevel <= LOG_LEVELS.error) process.stderr.write(chalk.red(msg) + "\n");
  },
};

const SKILLS_APPLY = ".cursor/skills/agentflow-apply";
const RUN_DIR_REL = ".workspace/agentflow";

/** 从 run 的 memory.md 读取 runStartTime（本 run 首次开始执行的时间戳），无则返回 null。 */
function readRunStartTime(workspaceRoot, uuid) {
  const memoryPath = path.join(path.resolve(workspaceRoot), RUN_DIR_REL, uuid, "memory.md");
  if (!fs.existsSync(memoryPath)) return null;
  const content = fs.readFileSync(memoryPath, "utf-8");
  for (const line of (content || "").split(/\r?\n/)) {
    const idx = line.indexOf(": ");
    if (idx <= 0) continue;
    const k = line.slice(0, idx).trim();
    if (k !== "runStartTime") continue;
    const v = line.slice(idx + 2).trim();
    const n = parseInt(String(v), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  return null;
}

/** 确保本 run 有 runStartTime：已有则返回，无则在 memory 写入当前时间并返回（从 start 开始记录，继续跑会累加）。 */
function ensureRunStartTime(workspaceRoot, uuid) {
  const existing = readRunStartTime(workspaceRoot, uuid);
  if (existing != null) return existing;
  const runStartTime = Date.now();
  runNodeScript(workspaceRoot, "save-key.mjs", [workspaceRoot, uuid, "runStartTime", String(runStartTime)], { captureStdout: true });
  return runStartTime;
}
const MAX_LOOP_ROUNDS = 10000;

/** modelType（与 pre-process 一致）→ Cursor CLI --model。null 表示不传 --model（用 Cursor 默认）。Auto/自动 同义。可通过 env CURSOR_AGENT_MODEL_<modelType> 覆盖单项。 */
const MODEL_TYPE_TO_CURSOR_MODEL = {
  Auto: null,
  自动: null,
  规划: null,
  Code: null,
  前端: null,
};

/** 解析节点实际使用的 Cursor model 名称（与 runCursorAgentForNode 内逻辑一致），用于日志展示。 */
function getEffectiveModelName(modelOverride, modelType) {
  const modelRaw =
    modelOverride ??
    process.env.CURSOR_AGENT_MODEL ??
    (modelType != null && process.env["CURSOR_AGENT_MODEL_" + modelType]) ??
    (modelType != null && MODEL_TYPE_TO_CURSOR_MODEL[modelType]) ??
    null;
  if (modelRaw === false || modelRaw === "false" || modelRaw === "") return "Auto";
  return modelRaw || "Auto";
}

function getScriptPath(workspaceRoot, name) {
  return path.join(workspaceRoot, SKILLS_APPLY, name);
}

function runNodeScript(workspaceRoot, scriptName, args, options = {}) {
  const scriptPath = getScriptPath(workspaceRoot, scriptName);
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Script not found: ${scriptPath}. Run from workspace root that contains .cursor/skills/agentflow-apply.`);
  }
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: workspaceRoot,
    encoding: "utf-8",
    stdio: options.captureStdout ? ["inherit", "pipe", "inherit"] : ["inherit", "inherit", "inherit"],
    ...options,
  });
  return result;
}

function parseJsonStdout(result) {
  if (result.status !== 0) {
    const err = (result.stdout || "").trim() || result.stderr || "unknown";
    throw new Error(`Script failed: ${err}`);
  }
  const out = (result.stdout || "").trim();
  if (!out) throw new Error("Script produced no stdout");
  try {
    return JSON.parse(out);
  } catch (e) {
    throw new Error(`Invalid JSON from script: ${out.slice(0, 200)}`);
  }
}

function isValidUuid(value) {
  return typeof value === "string" && /^\d{14}$/.test(value);
}

/**
 * Run Cursor CLI with stream-json, forward events to stdout, return success/failure.
 * Prompt instructs the agent to act as node executor with promptPath, intermediatePath, resultPath.
 */
function runCursorAgentForNode(workspaceRoot, { promptPath, intermediatePath, resultPathRel, subagent }, options = {}) {
  const absPromptPath = path.resolve(workspaceRoot, promptPath);
  const absAgentPath = path.resolve(workspaceRoot, ".cursor", "agents", `${subagent}.md`);
  const absResultPath = path.join(intermediatePath, resultPathRel);
  const promptText = `请以 agent 模式执行。
- **agent 身份 prompt**：${absAgentPath}（请先阅读该文件以确定身份与规范）
- **读取执行 指令 prompt**：${absPromptPath}
- intermediatePath（run 目录）：${intermediatePath}
- 将结果写入 resultPath：${absResultPath}
请只完成该节点任务，不要修改 flow 或其它节点。`;

  const modelRaw =
    options.model ??
    process.env.CURSOR_AGENT_MODEL ??
    (options.modelType != null && process.env["CURSOR_AGENT_MODEL_" + options.modelType]) ??
    (options.modelType != null && MODEL_TYPE_TO_CURSOR_MODEL[options.modelType]) ??
    null;
  /** 避免把 false / "false" 传给 Cursor CLI（会报 Cannot use this model: false） */
  const model =
    modelRaw === false || modelRaw === "false" || modelRaw === "" ? "Auto" : (modelRaw || "Auto");

  const rawPrefix = options.outputPrefix != null ? `[${options.outputPrefix}] ` : "";
  const coloredPrefix = rawPrefix && options.prefixColor ? options.prefixColor(rawPrefix) : rawPrefix;
  /** Cursor AI 输出正文用灰色，与 CLI 自身打印区分 */
  const agentContentColor = options.contentColor ?? ((line) => chalk.gray(line));

  return new Promise((resolve, reject) => {
    const agentCmd = process.env.CURSOR_AGENT_CMD || "agent";
    const args = [
      "--print",
      "--output-format", "stream-json",
      "--trust",
      "--workspace", workspaceRoot,
    ];
    if (options.force) args.push("--force");
    args.push("--model", model);
    args.push(promptText);
    const child = spawn(agentCmd, args, {
      cwd: workspaceRoot,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let lastResult = null;
    let hadError = false;
    /** 限制 stderr 缓存大小，避免 Cursor 长时间输出导致内存无限增长（仅用于 exit 时错误信息）；有界即无泄漏 */
    const STDERR_CAP_BYTES = 1024 * 1024; // 1MB
    const stderrChunks = [];
    let stderrTotalBytes = 0;
    const stderrBuffer = options.stderrBuffer || null;
    let stderrLineBuffer = "";

    function writeStdout(text) {
      if (coloredPrefix) writeWithPrefix(process.stdout, text, coloredPrefix, agentContentColor);
      else if (text) process.stdout.write(agentContentColor(text));
    }

    function flushStderrLines() {
      if (!coloredPrefix) return;
      let idx;
      while ((idx = stderrLineBuffer.indexOf("\n")) !== -1) {
        const line = stderrLineBuffer.slice(0, idx + 1);
        stderrLineBuffer = stderrLineBuffer.slice(idx + 1);
        writeWithPrefix(process.stderr, line, coloredPrefix, agentContentColor);
      }
    }

    child.stderr.on("data", (chunk) => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, "utf-8");
      const len = buf.length;
      while (stderrChunks.length > 0 && stderrTotalBytes + len > STDERR_CAP_BYTES) {
        const drop = stderrChunks.shift();
        stderrTotalBytes -= Buffer.isBuffer(drop) ? drop.length : Buffer.byteLength(drop, "utf-8");
      }
      stderrChunks.push(buf);
      stderrTotalBytes += len;
      if (stderrBuffer) {
        stderrBuffer.push(chunk);
      } else if (coloredPrefix) {
        stderrLineBuffer += s;
        flushStderrLines();
      } else {
        process.stderr.write(chunk);
      }
    });

    const stdoutWidth = process.stdout.columns ?? 80;
    const mdStreamer = createMarkdownStreamer({
      render: (md) => renderMarkdown(md, { width: stdoutWidth }),
      spacing: "single",
    });

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      const lines = chunk.split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.type === "assistant" && event.message?.content) {
            const text = (event.message.content || [])
              .filter((c) => c.type === "text" && c.text)
              .map((c) => c.text)
              .join("");
            if (text) {
              const out = mdStreamer.push(text);
              if (out) writeStdout(out);
            }
          } else if (event.type === "tool_call") {
            const summary = event.subtype === "started" ? " [tool started]" : " [tool completed]";
            if (coloredPrefix) process.stdout.write(coloredPrefix + summary);
            else process.stdout.write(summary);
          } else if (event.type === "result") {
            lastResult = event;
            if (event.subtype === "success" && !event.is_error) {
              hadError = false;
            } else {
              hadError = true;
            }
          }
        } catch (_) {
          writeStdout(line + "\n");
        }
      }
    });

    child.on("error", (err) => {
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.removeAllListeners();
      reject(new Error(`Cursor CLI failed to start: ${err.message}. Ensure '${agentCmd}' is in PATH.`));
    });

    child.on("close", (code) => {
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();
      const tail = mdStreamer.finish();
      if (tail) writeStdout(tail);
      if (coloredPrefix && stderrLineBuffer) {
        writeWithPrefix(process.stderr, stderrLineBuffer.endsWith("\n") ? stderrLineBuffer : stderrLineBuffer + "\n", coloredPrefix);
      }
      if (code !== 0 && lastResult == null) {
        const stderr = Buffer.concat(stderrChunks).toString("utf-8");
        reject(new Error(`Cursor CLI exited ${code}. ${stderr || "No result event received."}`));
        return;
      }
      if (hadError || (lastResult && lastResult.is_error)) {
        reject(new Error(lastResult?.result || "Agent reported error."));
        return;
      }
      resolve();
    });
  });
}

/** 本地支持、不经过 Cursor CLI 的节点类型（与 pre-process-node.mjs 中 LOCAL_ONLY_DEFINITION_IDS 一致） */
const LOCAL_ONLY_DEFINITION_IDS = new Set([
  "control_if",
  "control_start",
  "control_end",
  "control_anyOne",
  "tool_print",
  "tool_user_check",
  "provide_str",
  "provide_file",
]);

/**
 * Execute one node: 按 definitionId / directCommand 决定是否走 Cursor CLI。
 * - LOCAL_ONLY_DEFINITION_IDS：预处理已写 result，直接跳过。
 * - directCommand：执行 pre-process 输出的 directCommand，不调 Cursor CLI。
 * - 其余节点：走 Cursor CLI（runCursorAgentForNode）。
 * options.model: optional Cursor CLI --model (overrides CURSOR_AGENT_MODEL).
 */
async function executeNode(workspaceRoot, flowName, uuid, instanceId, preOutput, options = {}) {
  const { definitionId, directCommand, promptPath, resultPath, subagent } = preOutput;
  const runDir = path.join(workspaceRoot, ".workspace", "agentflow", uuid);
  const intermediatePath = runDir;

  if (definitionId && LOCAL_ONLY_DEFINITION_IDS.has(definitionId)) {
    return;
  }
  if (directCommand) {
    const result = spawnSync(directCommand, [], { cwd: workspaceRoot, shell: true, stdio: "inherit" });
    if (result.status !== 0) throw new Error(`Direct command failed: ${directCommand}`);
    return;
  }

  await runCursorAgentForNode(
    workspaceRoot,
    { promptPath, intermediatePath, resultPathRel: resultPath, subagent },
    {
      model: options.model,
      modelType: preOutput.modelType,
      stderrBuffer: options.stderrBuffer,
      force: options.force,
      outputPrefix: options.outputPrefix,
      prefixColor: options.prefixColor,
    },
  );
}

function runPostProcess(workspaceRoot, flowName, uuid, instanceId, execId) {
  const result = runNodeScript(
    workspaceRoot,
    "post-process-node.mjs",
    [workspaceRoot, flowName, uuid, instanceId, String(execId)],
    { captureStdout: true },
  );
  parseJsonStdout(result);
}

/** 开始时：入口信息（仅流程名称与 uuid） */
function printEntryAndFlowFiles(workspaceRoot, flowName, uuid) {
  const entryTable = new Table({
    head: [chalk.cyan("项目"), chalk.cyan("值")],
    colWidths: [18, 24],
    style: { head: [], border: ["grey"] },
  });
  entryTable.push(
    ["流程名称", flowName],
    ["本次运行 uuid", uuid],
  );
  log.info("\n" + chalk.bold("入口信息"));
  log.info(entryTable.toString());
}

function styleStatus(s) {
  if (s === "success") return chalk.green("success");
  if (s === "pending") return chalk.yellow("pending");
  if (s === "running") return chalk.cyan("running");
  if (s === "condition_not_met") return chalk.dim("condition_not_met");
  return chalk.dim(s || "-");
}

/** 每轮：当前执行节点（仅当 readyNodes.length > 0）+ 全量节点状态。execIdMap 可选，来自 get-ready-nodes。 */
function printCurrentNodesAndStatus(readyNodes, instanceStatus, nodes, execIdMap = {}) {
  const idToLabel = new Map();
  const idToType = new Map();
  if (Array.isArray(nodes)) {
    for (const n of nodes) {
      idToLabel.set(n.id, n.label || n.id);
      idToType.set(n.id, n.type || "-");
    }
  }

  if (readyNodes.length > 0) {
    const runTable = new Table({
      head: [chalk.cyan("当前执行节点")],
      colWidths: [72],
      style: { head: [], border: ["grey"] },
    });
    for (const id of readyNodes) {
      const label = idToLabel.get(id);
      runTable.push([label != null ? `${id} ${chalk.dim("(" + label + ")")}` : id]);
    }
    log.info("\n" + chalk.bold("当前执行节点"));
    log.info(runTable.toString());
  }

  const order = Array.isArray(nodes) ? nodes.map((n) => n.id) : Object.keys(instanceStatus || {});
  if (order.length === 0) return;
  const statusTable = new Table({
    head: [chalk.cyan("标签"), chalk.cyan("类型"), chalk.cyan("状态"), chalk.cyan("execId")],
    colWidths: [20, 10, 16, 8],
    style: { head: [], border: ["grey"] },
  });
  for (const id of order) {
    const label = idToLabel.get(id) || id;
    const type = idToType.get(id) || "-";
    const status = (instanceStatus && instanceStatus[id]) || "-";
    const execId = execIdMap[id] != null ? String(execIdMap[id]) : "-";
    statusTable.push([label, type, styleStatus(status), execId]);
  }
  log.info(chalk.bold("节点状态"));
  log.info(statusTable.toString());
}

/** parallel 默认 false：多进程同时跑时 Cursor CLI 会写 ~/.cursor/cli-config.json，易产生 rename 竞态 (ENOENT)，故默认串行。 */
async function apply(workspaceRoot, flowName, uuidArg, dryRun, agentModel = null, force = true, parallel = false) {
  const ensureResult = runNodeScript(
    workspaceRoot,
    "ensure-run-dir.mjs",
    [workspaceRoot, uuidArg || "", flowName].filter(Boolean),
    { captureStdout: true },
  );
  const { uuid } = parseJsonStdout(ensureResult);

  const parseResult = runNodeScript(
    workspaceRoot,
    "parse-flow.mjs",
    [workspaceRoot, flowName, uuid],
    { captureStdout: true },
  );
  const parseOut = parseJsonStdout(parseResult);
  if (!parseOut.ok) throw new Error(parseOut.error || "parse-flow failed");

  printEntryAndFlowFiles(workspaceRoot, flowName, uuid);

  /** 总执行时间起点：从本 run 首次执行开始记录，继续跑时从 memory 读出，会累加 */
  let runStartTime = null;
  let round = 0;
  while (round < MAX_LOOP_ROUNDS) {
    round++;
    const readyResult = runNodeScript(
      workspaceRoot,
      "get-ready-nodes.mjs",
      [workspaceRoot, flowName, uuid],
      { captureStdout: true },
    );
    const { readyNodes = [], allDone, pendingNodes = [], instanceStatus = {}, execIdMap = {} } = parseJsonStdout(readyResult);

    printCurrentNodesAndStatus(readyNodes, instanceStatus, parseOut.nodes, execIdMap);

    if (readyNodes.length === 0) {
      if (allDone) {
        const totalElapsed = runStartTime != null ? formatDuration(Date.now() - runStartTime) : "-";
        log.info(`\nApply done. uuid=${uuid} runDir=${path.join(workspaceRoot, ".workspace", "agentflow", uuid)}  ${chalk.dim("总 " + totalElapsed)}`);
        return;
      }
      if (pendingNodes.length > 0) {
        const totalElapsed = runStartTime != null ? formatDuration(Date.now() - runStartTime) : "-";
        log.info(`\nPaused: uuid=${uuid} pendingNodes=${pendingNodes.join(", ")}  ${chalk.dim("总 " + totalElapsed)}`);
        const resumeExample =
          pendingNodes.length === 1
            ? `agentflow resume ${flowName} ${uuid} ${pendingNodes[0]}`
            : `agentflow resume ${flowName} ${uuid}`;
        log.info(chalk.bold.yellow("→ 继续执行请运行: ") + resumeExample);
        return;
      }
      const totalElapsed = runStartTime != null ? formatDuration(Date.now() - runStartTime) : "-";
      throw new Error("No ready nodes and not all done; flow may be stuck. 总 " + totalElapsed);
    }

    if (dryRun) {
      const totalElapsed = runStartTime != null ? formatDuration(Date.now() - runStartTime) : "-";
      log.info(`\n[--dry-run] Would execute nodes: ${readyNodes.join(", ")}. Omit --dry-run to run.  ${chalk.dim("总 " + totalElapsed)}`);
      return;
    }

    if (runStartTime === null) runStartTime = ensureRunStartTime(workspaceRoot, uuid);

    const idToLabel = new Map();
    if (Array.isArray(parseOut.nodes)) for (const n of parseOut.nodes) idToLabel.set(n.id, n.label || n.id);

    /** 预处理好所有 ready 节点，得到 preOutput 列表 */
    const preOutputs = [];
    for (const instanceId of readyNodes) {
      log.debug(`[agentflow] 进入节点 flowName=${flowName} uuid=${uuid} instanceId=${instanceId} round=${round}`);
      const preResult = runNodeScript(
        workspaceRoot,
        "pre-process-node.mjs",
        [workspaceRoot, flowName, uuid, instanceId],
        { captureStdout: true },
      );
      const preOutput = parseJsonStdout(preResult);
      preOutputs.push({ instanceId, label: idToLabel.get(instanceId) || instanceId, preOutput });
      log.debug(
        `[agentflow] 执行节点 instanceId=${instanceId} definitionId=${preOutput.definitionId ?? "-"} promptPath=${preOutput.promptPath} resultPath=${preOutput.resultPath} subagent=${preOutput.subagent} modelType=${preOutput.modelType ?? "-"} execId=${preOutput.execId} directCommand=${preOutput.directCommand ? "yes" : "-"}`,
      );
    }

    const runOne = async ({ instanceId, label, preOutput, outputPrefix, prefixColor }, isParallel) => {
      if (!isParallel) {
        const isLocalOnly = preOutput.definitionId && LOCAL_ONLY_DEFINITION_IDS.has(preOutput.definitionId);
        const modelLabel = isLocalOnly ? "(本地)" : getEffectiveModelName(agentModel, preOutput.modelType);
        process.stderr.write("\n" + NODE_SEP + "\n");
        process.stderr.write(chalk.bold.cyan("【开始】节点 ") + instanceId + chalk.dim(" (" + label + ")") + "  " + chalk.dim("model: ") + chalk.yellow(modelLabel) + "\n");
        log.info(chalk.dim("Prompt: ") + path.resolve(workspaceRoot, preOutput.promptPath));
        if (preOutput.definitionId === "tool_print" && preOutput.resultPath) {
          const body = readResultBody(workspaceRoot, uuid, preOutput.resultPath);
          if (body) {
            process.stderr.write("\n" + chalk.bold.yellow("【Print 输出】") + "\n");
            process.stderr.write(body + "\n");
            process.stderr.write(chalk.dim("────────────────────────────────────────") + "\n");
          }
        }
        process.stderr.write(NODE_SEP + "\n\n");
        const startTime = Date.now();
        const spinner = ora({
          text: `Running: ${instanceId} ${chalk.dim("(" + label + ")")}  ${chalk.dim(formatDuration(0) + " / " + formatDuration(Date.now() - runStartTime))}`,
          stream: process.stderr,
          discardStdin: false,
        }).start();
        const timeTick = setInterval(() => {
          spinner.text = `Running: ${instanceId} ${chalk.dim("(" + label + ")")}  ${chalk.dim(formatDuration(Date.now() - startTime) + " / " + formatDuration(Date.now() - runStartTime))}`;
        }, 1000);
        const stderrBuffer = [];
        let elapsedStr = "";
        try {
          await executeNode(workspaceRoot, flowName, uuid, instanceId, preOutput, {
            model: agentModel,
            stderrBuffer,
            force,
            outputPrefix: instanceId,
            prefixColor: (s) => chalk.cyan(s),
          });
          clearInterval(timeTick);
          elapsedStr = formatDuration(Date.now() - startTime);
          const totalStr = runStartTime != null ? formatDuration(Date.now() - runStartTime) : "-";
          spinner.succeed(chalk.green(`Done: ${instanceId}`) + chalk.dim(" (" + label + ")") + "  " + chalk.dim(elapsedStr) + "  " + chalk.dim("总 " + totalStr));
        } catch (err) {
          clearInterval(timeTick);
          elapsedStr = formatDuration(Date.now() - startTime);
          const totalStr = runStartTime != null ? formatDuration(Date.now() - runStartTime) : "-";
          spinner.fail(chalk.red(`Failed: ${instanceId}`) + chalk.dim(" (" + label + ")") + "  " + chalk.dim(elapsedStr) + "  " + chalk.dim("总 " + totalStr));
          if (stderrBuffer.length > 0) process.stderr.write(Buffer.concat(stderrBuffer));
          throw err;
        }
        if (stderrBuffer.length > 0) process.stderr.write(Buffer.concat(stderrBuffer));
        const totalStr = runStartTime != null ? formatDuration(Date.now() - runStartTime) : "-";
        process.stderr.write("\n" + NODE_SEP + "\n");
        process.stderr.write(chalk.bold.cyan("【结束】节点 ") + instanceId + chalk.dim(" (" + label + ")") + (elapsedStr ? "  " + chalk.dim(elapsedStr) : "") + "  " + chalk.dim("总 " + totalStr) + "\n");
        process.stderr.write(NODE_SEP + "\n");
      } else {
        await executeNode(workspaceRoot, flowName, uuid, instanceId, preOutput, {
          model: agentModel,
          stderrBuffer: [],
          force,
          outputPrefix,
          prefixColor,
        });
      }
      runPostProcess(workspaceRoot, flowName, uuid, instanceId, preOutput.execId);
      log.debug(`[agentflow] 退出节点 instanceId=${instanceId} execId=${preOutput.execId}`);
    };

    const useParallel = parallel && preOutputs.length > 1;
    if (useParallel) {
      preOutputs.forEach((item, i) => {
        item.outputPrefix = item.instanceId;
        item.prefixColor = PARALLEL_PREFIX_COLORS[i % PARALLEL_PREFIX_COLORS.length];
      });
      process.stderr.write("\n" + NODE_SEP + "\n");
      process.stderr.write(chalk.bold.cyan("【开始】并行执行 ") + preOutputs.length + " 个节点: " + preOutputs.map((p) => p.instanceId).join(", ") + "\n");
      for (const item of preOutputs) log.info(chalk.dim("Prompt: ") + path.resolve(workspaceRoot, item.preOutput.promptPath));
      process.stderr.write(NODE_SEP + "\n\n");
      log.info(chalk.cyan(`Running ${preOutputs.length} nodes in parallel: ${preOutputs.map((p) => p.instanceId).join(", ")}`));
      await Promise.all(preOutputs.map((item) => runOne(item, true)));
      const totalStrPar = runStartTime != null ? formatDuration(Date.now() - runStartTime) : "-";
      process.stderr.write("\n" + NODE_SEP + "\n");
      process.stderr.write(chalk.bold.cyan("【结束】并行节点全部完成") + "  " + chalk.dim("总 " + totalStrPar) + "\n");
      process.stderr.write(NODE_SEP + "\n");
    } else {
      for (const item of preOutputs) await runOne(item, false);
    }
  }
  const totalElapsed = runStartTime != null ? formatDuration(Date.now() - runStartTime) : "-";
  throw new Error(`Max rounds (${MAX_LOOP_ROUNDS}) reached. 总 ${totalElapsed}`);
}

/** 将 pending 节点标为 success 并继续 apply。resume <FlowName> <uuid> [instanceId] */
async function resume(workspaceRoot, flowName, uuid, instanceIdOptional, agentModel = null, force = true, parallel = false) {
  let nodesToResume = [];
  if (instanceIdOptional) {
    nodesToResume = [instanceIdOptional];
  } else {
    const readyResult = runNodeScript(
      workspaceRoot,
      "get-ready-nodes.mjs",
      [workspaceRoot, flowName, uuid],
      { captureStdout: true },
    );
    const { pendingNodes = [] } = parseJsonStdout(readyResult);
    nodesToResume = pendingNodes;
  }
  const payload = JSON.stringify({ status: "success", message: "用户确认继续" });
  for (const instanceId of nodesToResume) {
    const wr = runNodeScript(
      workspaceRoot,
      "write-result.mjs",
      [workspaceRoot, uuid, instanceId, "--json", payload],
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

async function replay(workspaceRoot, flowNameOrUuid, uuidOrInstanceId, instanceIdArg, agentModel = null, force = true) {
  let flowName, uuid, instanceId;
  const runDirByUuid = (u) => path.join(workspaceRoot, ".workspace", "agentflow", u);
  const flowJsonPath = (u) => path.join(runDirByUuid(u), "intermediate", "flow.json");

  if (instanceIdArg !== undefined) {
    flowName = flowNameOrUuid;
    uuid = uuidOrInstanceId;
    instanceId = instanceIdArg;
  } else {
    uuid = flowNameOrUuid;
    instanceId = uuidOrInstanceId;
    if (!fs.existsSync(flowJsonPath(uuid))) {
      throw new Error("flow.json not found. Run apply first or use: agentflow replay <flowName> <uuid> <instanceId>");
    }
    const flow = JSON.parse(fs.readFileSync(flowJsonPath(uuid), "utf-8"));
    flowName = flow.flowName || flow.name;
    if (!flowName) throw new Error("flow.json missing flowName. Use: agentflow replay <flowName> <uuid> <instanceId>");
  }

  log.debug(`[agentflow] 进入节点 flowName=${flowName} uuid=${uuid} instanceId=${instanceId}`);
  const preResult = runNodeScript(
    workspaceRoot,
    "pre-process-node.mjs",
    [workspaceRoot, flowName, uuid, instanceId],
    { captureStdout: true },
  );
  const preOutput = parseJsonStdout(preResult);
  log.debug(
    `[agentflow] 执行节点 instanceId=${instanceId} definitionId=${preOutput.definitionId ?? "-"} promptPath=${preOutput.promptPath} resultPath=${preOutput.resultPath} subagent=${preOutput.subagent} modelType=${preOutput.modelType ?? "-"} execId=${preOutput.execId} directCommand=${preOutput.directCommand ? "yes" : "-"}`,
  );
  const promptAbs = path.resolve(workspaceRoot, preOutput.promptPath);
  const isLocalOnlyReplay = preOutput.definitionId && LOCAL_ONLY_DEFINITION_IDS.has(preOutput.definitionId);
  const modelLabelReplay = isLocalOnlyReplay ? "(本地)" : getEffectiveModelName(agentModel, preOutput.modelType);
  process.stderr.write("\n" + NODE_SEP + "\n");
  process.stderr.write(chalk.bold.cyan("【开始】节点 ") + instanceId + "  " + chalk.dim("model: ") + chalk.yellow(modelLabelReplay) + "\n");
  log.info(chalk.dim("Prompt: ") + promptAbs);
  process.stderr.write(NODE_SEP + "\n\n");
  await executeNode(workspaceRoot, flowName, uuid, instanceId, preOutput, { model: agentModel, force });
  runPostProcess(workspaceRoot, flowName, uuid, instanceId, preOutput.execId);
  log.debug(`[agentflow] 退出节点 instanceId=${instanceId} execId=${preOutput.execId}`);
  process.stderr.write("\n" + NODE_SEP + "\n");
  process.stderr.write(chalk.bold.cyan("【结束】节点 ") + instanceId + "\n");
  process.stderr.write(NODE_SEP + "\n");
  log.info(`\nReplay done. ${instanceId} uuid=${uuid}`);
}

function printHelp() {
  log.info(`
AgentFlow CLI — drive apply/replay with Cursor CLI streaming.

Usage:
  agentflow apply <FlowName> [uuid]
  agentflow resume <FlowName> <uuid> [instanceId]  将 pending 节点标为已确认并继续 apply
  agentflow replay [flowName] <uuid> <instanceId>
  agentflow --help

Options:
  --workspace-root <path>  Workspace root (default: cwd)
  --dry-run                (apply only) Print ready nodes and exit without running Cursor agent
  --model <name>           Cursor CLI model (e.g. claude-sonnet). Overrides CURSOR_AGENT_MODEL. Run 'agent models' to list.
  --debug                  Show debug logs (gray, low priority)
  --force                  Pass --force to Cursor CLI (default: on). Use --no-force to disable.
  --parallel               Run same-round ready nodes in parallel (default: off; use to enable). Multiple Cursor CLI processes may race on ~/.cursor/cli-config.json.

Apply: builds run dir, parses flow, runs ready nodes in a loop.
Resume: marks pending node(s) as success (e.g. after UserCheck 确认), then continues apply.
Replay: runs a single node (pre-process → execute → post-process).

Requires: Node >=18, Cursor CLI ('agent') in PATH for node execution.
Scripts must exist under <workspace>/.cursor/skills/agentflow-apply/.
`);
}

async function main() {
  const argv = process.argv.slice(2);
  let workspaceRoot = process.cwd();
  const shift = () => argv.shift();
  while (argv[0] === "--workspace-root") {
    shift();
    workspaceRoot = path.resolve(shift() || "");
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    printHelp();
    process.exit(0);
  }
  const dryRun = argv.includes("--dry-run");
  if (dryRun) argv.splice(argv.indexOf("--dry-run"), 1);
  if (argv.includes("--debug")) {
    currentLogLevel = LOG_LEVELS.debug;
    argv.splice(argv.indexOf("--debug"), 1);
  }
  let force = true;
  if (argv.includes("--no-force")) {
    force = false;
    argv.splice(argv.indexOf("--no-force"), 1);
  }
  if (argv.includes("--force")) {
    force = true;
    argv.splice(argv.indexOf("--force"), 1);
  }
  if (argv.includes("--yolo")) {
    force = true;
    argv.splice(argv.indexOf("--yolo"), 1);
  }
  let parallel = false;
  if (argv.includes("--parallel")) {
    parallel = true;
    argv.splice(argv.indexOf("--parallel"), 1);
  }
  if (argv.includes("--no-parallel")) {
    parallel = false;
    argv.splice(argv.indexOf("--no-parallel"), 1);
  }
  const sub = shift();
  if (!sub) {
    printHelp();
    process.exit(1);
  }
  let agentModel = process.env.CURSOR_AGENT_MODEL || null;
  const modelIdx = argv.indexOf("--model");
  if (modelIdx >= 0 && argv[modelIdx + 1]) {
    agentModel = argv[modelIdx + 1];
    argv.splice(modelIdx, 2);
  }
  if (sub === "apply") {
    const flowName = shift();
    if (!flowName) throw new Error("Missing FlowName. Usage: agentflow apply <FlowName> [uuid]");
    const uuidArg = isValidUuid(argv[0]) ? shift() : undefined;
    await apply(workspaceRoot, flowName, uuidArg, dryRun, agentModel, force, parallel);
  } else if (sub === "resume") {
    const flowName = shift();
    const uuidArg = shift();
    if (!flowName || !uuidArg) throw new Error("Usage: agentflow resume <FlowName> <uuid> [instanceId]");
    const instanceIdOpt = argv.length > 0 && !argv[0].startsWith("--") ? shift() : undefined;
    await resume(workspaceRoot, flowName, uuidArg, instanceIdOpt, agentModel, force, parallel);
  } else if (sub === "replay") {
    const a = shift(), b = shift(), c = shift();
    if (!a || !b) throw new Error("Usage: agentflow replay <uuid> <instanceId> or agentflow replay <flowName> <uuid> <instanceId>");
    await replay(workspaceRoot, a, b, c, agentModel, force);
  } else {
    throw new Error("Unknown command: " + sub + ". Use apply, resume, or replay.");
  }
}

main().catch((err) => {
  log.error("Error: " + err.message);
  process.exit(1);
});
