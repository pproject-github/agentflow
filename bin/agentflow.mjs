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

const updateNotifier = require("update-notifier").default;
const pkg = require(path.join(__dirname, "..", "package.json"));
updateNotifier({ pkg }).notify();

/** 当 stderr 非 TTY（如被 desktop 管道捕获）时禁用 chalk，避免日志里出现 [90m 等 ANSI 转义码 */
if (process.stderr && !process.stderr.isTTY) {
  chalk.level = 0;
}

/** 节点执行区域分割线（开始/结束标识用） */
const NODE_SEP = "════════════════════════════════════════════════════════════════";

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

/** --machine-readable 时向 stdout 输出 JSON 行事件（apply-start/node-start/node-done/node-failed/apply-done/apply-paused），供 UI 解析并展示正在执行的节点 */
let machineReadable = false;

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

/** agentflow 包根目录（CLI 所在包的 node_modules 用于解析脚本依赖，如 js-yaml） */
const PACKAGE_ROOT = path.resolve(__dirname, "..");
/** 包内 agents 目录（执行器身份 prompt），优先使用，缺失时回退到工作区 .cursor/agents */
const PACKAGE_AGENTS_DIR = path.join(PACKAGE_ROOT, "agents");
/** apply 子命令所用脚本目录（随包发布，不再从工作区 .cursor/skills/agentflow-apply 加载） */
const APPLY_SCRIPTS_DIR = path.join(__dirname, "apply");
/** apply -ai 允许调用的单步脚本名（不含 .mjs），供外部多轮控制 */
const APPLY_AI_STEPS = [
  "ensure-run-dir",
  "parse-flow",
  "get-ready-nodes",
  "pre-process-node",
  "post-process-node",
  "write-result",
  "run-tool-nodejs",
  "check-flow",
  "collect-nodes",
  "gc",
];
const RUN_BUILD_REL = ".workspace/agentflow/runBuild";
const PIPELINES_DIR = ".cursor/agentflow/pipelines";
const PIPELINES_DIR_WORKSPACE = ".workspace/agentflow/pipelines";
const REFERENCE_DIR_REL = ".workspace/agentflow/reference";
const RUN_LOG_REL = "logs/log.txt";

/** 包内 reference 目录（npm 安装后与 bin 同包），运行时若工作区缺少则复制到 .workspace/agentflow/reference */
const PACKAGE_REFERENCE_DIR = path.join(PACKAGE_ROOT, "reference");
/** 包内内置节点与流水线（脱离 ai-ability .cursor/agentflow 时使用） */
const PACKAGE_BUILTIN_NODES_DIR = path.join(PACKAGE_ROOT, "builtin", "nodes");
const PACKAGE_BUILTIN_PIPELINES_DIR = path.join(PACKAGE_ROOT, "builtin", "pipelines");

/**
 * 确保工作区 .workspace/agentflow/reference 存在且含包内 reference 文件（全局安装或未跑 postinstall 时补齐）。
 */
function ensureReference(workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  const destDir = path.join(root, REFERENCE_DIR_REL);
  if (!fs.existsSync(PACKAGE_REFERENCE_DIR) || !fs.statSync(PACKAGE_REFERENCE_DIR).isDirectory()) return;
  try {
    fs.mkdirSync(destDir, { recursive: true });
    const names = fs.readdirSync(PACKAGE_REFERENCE_DIR);
    for (const name of names) {
      const srcFile = path.join(PACKAGE_REFERENCE_DIR, name);
      if (fs.statSync(srcFile).isFile()) {
        const destFile = path.join(destDir, name);
        if (!fs.existsSync(destFile)) fs.copyFileSync(srcFile, destFile);
      }
    }
  } catch (_) {}
}

function getRunDir(workspaceRoot, flowName, uuid) {
  return path.join(path.resolve(workspaceRoot), RUN_BUILD_REL, flowName, uuid);
}

/** 解析 flow 目录：优先 .workspace → .cursor/agentflow/pipelines → 包内 builtin/pipelines；不存在则返回 null。 */
function getFlowDir(workspaceRoot, flowName) {
  const root = path.resolve(workspaceRoot);
  const workspaceFlowDir = path.join(root, PIPELINES_DIR_WORKSPACE, flowName);
  if (fs.existsSync(workspaceFlowDir) && fs.existsSync(path.join(workspaceFlowDir, "flow.yaml"))) return workspaceFlowDir;
  const cursorFlowDir = path.join(root, PIPELINES_DIR, flowName);
  if (fs.existsSync(cursorFlowDir) && fs.existsSync(path.join(cursorFlowDir, "flow.yaml"))) return cursorFlowDir;
  const builtinFlowDir = path.join(PACKAGE_BUILTIN_PIPELINES_DIR, flowName);
  if (fs.existsSync(builtinFlowDir) && fs.existsSync(path.join(builtinFlowDir, "flow.yaml"))) return builtinFlowDir;
  return null;
}

/** 解析 agent 身份 prompt 路径：优先使用包内 agents/<subagent>.md，否则工作区 .cursor/agents/<subagent>.md */
function getAgentPath(workspaceRoot, subagent) {
  const packagePath = path.join(PACKAGE_AGENTS_DIR, `${subagent}.md`);
  if (fs.existsSync(packagePath)) return path.resolve(packagePath);
  return path.resolve(workspaceRoot, ".cursor", "agents", `${subagent}.md`);
}

/**
 * 读取 agent 文件内容并替换路径占位符为真实路径（方案 A：注入 prompt 用）。
 * replacements 形如 { workspaceRoot, promptPath, resultPath, intermediatePath, outputDir }，均为绝对路径字符串。
 * 返回替换后的整段文本；若文件不存在则返回空字符串。
 */
function loadAgentPromptWithReplacements(workspaceRoot, subagent, replacements) {
  const agentPath = getAgentPath(workspaceRoot, subagent);
  if (!fs.existsSync(agentPath)) return "";
  let content = fs.readFileSync(agentPath, "utf8");
  for (const [key, value] of Object.entries(replacements)) {
    if (value != null && typeof value === "string") {
      const placeholder = "${" + key + "}";
      content = content.split(placeholder).join(value);
    }
  }
  return content;
}

/**
 * 将 CLI 侧的关键信息也落盘到 run 目录的 logs/log.txt（与 run-log.mjs 同文件），便于事后回溯。
 * 写入失败不影响 CLI 主流程。
 */
function appendRunLogLine(workspaceRoot, flowName, uuid, tag, message) {
  if (!workspaceRoot || !flowName || !uuid) return;
  try {
    const runDir = getRunDir(workspaceRoot, flowName, uuid);
    const logPath = path.join(runDir, RUN_LOG_REL);
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    const text = typeof message === "string" ? message : JSON.stringify(message);
    const line = `[${new Date().toISOString()}] [${tag}] ${text}\n`;
    fs.appendFileSync(logPath, line, "utf-8");
  } catch (_) {}
}

/** 发送 CLI 事件：写 run log，且 machineReadable 时向 stdout 输出一行 JSON（含 ts），供 UI 展示当前节点等。 */
function emitEvent(workspaceRoot, flowName, uuid, payload) {
  appendRunLogLine(workspaceRoot, flowName, uuid, "cli", payload);
  if (machineReadable && workspaceRoot && flowName && uuid) {
    process.stdout.write(JSON.stringify({ ...payload, ts: new Date().toISOString() }) + "\n");
  }
}

/** 两参 replay 时根据 uuid 查找 run 目录（扫描 runBuild/<flowName>/<uuid>），返回 flowName 或 null。 */
function findFlowNameByUuid(workspaceRoot, uuid) {
  const runBuildDir = path.join(path.resolve(workspaceRoot), RUN_BUILD_REL);
  if (!fs.existsSync(runBuildDir) || !fs.statSync(runBuildDir).isDirectory()) return null;
  const flowNames = fs.readdirSync(runBuildDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  for (const fn of flowNames) {
    const flowJsonPath = path.join(runBuildDir, fn, uuid, "intermediate", "flow.json");
    if (fs.existsSync(flowJsonPath)) return fn;
  }
  return null;
}

/** 从 run 的 memory.md 读取 runStartTime（本 run 首次开始执行的时间戳），无则返回 null。 */
function readRunStartTime(workspaceRoot, flowName, uuid) {
  const memoryPath = path.join(getRunDir(workspaceRoot, flowName, uuid), "memory.md");
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
function ensureRunStartTime(workspaceRoot, flowName, uuid) {
  const existing = readRunStartTime(workspaceRoot, flowName, uuid);
  if (existing != null) return existing;
  const runStartTime = Date.now();
  runNodeScript(workspaceRoot, "save-key.mjs", [workspaceRoot, flowName, uuid, "runStartTime", String(runStartTime)], { captureStdout: true });
  return runStartTime;
}
const MAX_LOOP_ROUNDS = 10000;

/**
 * 解析节点实际使用的 CLI 与模型：
 * - agentModelOverride（CLI --model 或 CURSOR_AGENT_MODEL）存在时：始终使用 Cursor CLI。
 * - 否则优先从工作区 .cursor/agentflow/models.json 中按 key 查找 { cli, model }。
 * - 若配置缺失则根据约定回退：以 "opencode:" 前缀或显式 cli 指定 opencode，其余默认 cursor。
 */
const MODEL_CONFIG_REL = path.join(".cursor", "agentflow", "models.json");
const modelConfigCache = new Map(); // workspaceRoot -> { models: Record<string,{cli,model}> }

/** UI 格式为「模型 ID - 描述」，传参只用前面的模型 ID。若为 "auto" 则规范为 Cursor 可识别的 "Auto"。 */
function normalizeCursorModelForCli(value) {
  if (value == null || value === false || value === "") return "Auto";
  let s = String(value).trim();
  if (!s) return "Auto";
  const dashIdx = s.indexOf(" - ");
  if (dashIdx >= 0) s = s.slice(0, dashIdx).trim();
  if (!s) return "Auto";
  if (/^auto$/i.test(s)) return "Auto";
  return s;
}

function loadModelConfig(workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  if (modelConfigCache.has(root)) return modelConfigCache.get(root);
  const configPath = path.join(root, MODEL_CONFIG_REL);
  let config = { models: {} };
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, "utf-8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && parsed.models && typeof parsed.models === "object") {
        config = { models: parsed.models };
      }
    }
  } catch (_) {
    // ignore parse errors, fall back to empty config
  }
  modelConfigCache.set(root, config);
  return config;
}

function resolveCliAndModel(workspaceRoot, nodeModel, agentModelOverride) {
  // CLI --model / CURSOR_AGENT_MODEL 始终表示「Cursor CLI + 覆盖模型」
  if (agentModelOverride && String(agentModelOverride).trim()) {
    const model = normalizeCursorModelForCli(agentModelOverride);
    return {
      cli: "cursor",
      model,
      label: `cursor: ${model}`,
    };
  }

  const key = nodeModel && String(nodeModel).trim() ? String(nodeModel).trim() : "";
  if (key) {
    const { models } = loadModelConfig(workspaceRoot);
    const cfg = models[key];
    if (cfg && typeof cfg === "object" && cfg.cli && cfg.model) {
      const cli = cfg.cli === "opencode" ? "opencode" : "cursor";
      const model = String(cfg.model).trim();
      return { cli, model, label: `${cli}: ${model}` };
    }
  }

  // 无配置时的约定：以 "opencode:" 前缀表示 OpenCode，其余默认 Cursor。
  if (key && key.startsWith("opencode:")) {
    const model = key.slice("opencode:".length) || "";
    return {
      cli: "opencode",
      model: model || null,
      label: model ? `opencode: ${model}` : "opencode (default)",
    };
  }

  // 默认 Cursor：若未指定节点级 model，则用 CURSOR_AGENT_MODEL / Auto。将 UI 可能写入的 "auto - Auto (current)" 规范为 "Auto"。
  const envModel = process.env.CURSOR_AGENT_MODEL && String(process.env.CURSOR_AGENT_MODEL).trim();
  const model = normalizeCursorModelForCli(key || envModel || "Auto");
  return {
    cli: "cursor",
    model,
    label: model === "Auto" ? "cursor: Auto" : `cursor: ${model}`,
  };
}

/** 脚本路径：从 agentflow 包内 bin/apply 目录加载（不兼容：不再从工作区 .cursor/skills/agentflow-apply 加载） */
function getScriptPath(workspaceRoot, name) {
  return path.join(APPLY_SCRIPTS_DIR, name);
}

function runNodeScript(workspaceRoot, scriptName, args, options = {}) {
  const scriptPath = getScriptPath(workspaceRoot, scriptName);
  if (!fs.existsSync(scriptPath)) {
    throw new Error(`Script not found: ${scriptPath}. Reinstall the agentflow package.`);
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
 * Agent 身份文件先按路径变量替换后写入「该节点 intermediate」目录（即 prompt 所在目录）下的 agent-<subagent>.md，传参为「Agent角色定义: 该替换后文件路径」及本任务路径信息。
 */
function runCursorAgentForNode(workspaceRoot, { promptPath, intermediatePath, resultPathRel, subagent }, options = {}) {
  const absPromptPath = path.resolve(workspaceRoot, promptPath);
  const absResultPath = path.join(path.resolve(workspaceRoot, intermediatePath), resultPathRel);
  const absIntermediatePath = path.resolve(workspaceRoot, intermediatePath);
  const nodeIntermediateDir = path.dirname(absPromptPath);
  const outputDir = path.join(absIntermediatePath, "output");
  const absWorkspaceRoot = path.resolve(workspaceRoot);
  const replacements = {
    workspaceRoot: absWorkspaceRoot,
    promptPath: absPromptPath,
    resultPath: absResultPath,
    intermediatePath: absIntermediatePath,
    outputDir,
  };
  const agentContent = loadAgentPromptWithReplacements(workspaceRoot, subagent, replacements);
  let agentPathForPrompt = getAgentPath(workspaceRoot, subagent);
  if (agentContent) {
    const resolvedAgentPath = path.join(nodeIntermediateDir, `agent-${subagent}.md`);
    fs.mkdirSync(nodeIntermediateDir, { recursive: true });
    fs.writeFileSync(resolvedAgentPath, agentContent, "utf8");
    agentPathForPrompt = resolvedAgentPath;
  }
  const promptText = `Agent角色定义: ${agentPathForPrompt}

请先阅读该文件以确定身份与规范，再按以下路径执行：
- 读取指令 prompt：${absPromptPath}
- workspaceRoot（write-result 第一参数）：${absWorkspaceRoot}
- resultPath：${absResultPath}
- outputDir：${outputDir}
请只完成该节点任务，不要修改 flow 或其它节点。`;

  const modelRaw =
    options.model ??
    process.env.CURSOR_AGENT_MODEL ??
    null;
  /** 避免把 false / "false" 传给 Cursor CLI；将 "auto - Auto (current)" 等规范为 "Auto" */
  const model = normalizeCursorModelForCli(modelRaw);
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
    if (options.flowName && options.uuid) {
      const argvLog = args.slice(0, -1).concat([`(prompt ${args[args.length - 1].length} chars)`]);
      appendRunLogLine(workspaceRoot, options.flowName, options.uuid, "cli-raw", `Cursor CLI 完整参数: ${agentCmd} ${JSON.stringify(argvLog)}`);
      appendRunLogLine(workspaceRoot, options.flowName, options.uuid, "cli-raw", `Cursor CLI prompt 前 800 字:\n${promptText.slice(0, 800)}${promptText.length > 800 ? "..." : ""}`);
    }
    /** 使用 inherit 让 Cursor 的 stderr 直接打到终端，便于在 exit 1 无 result 时看到真实报错（否则子进程无 TTY 时 Cursor 可能不往 pipe 写 stderr） */
    const useStderrInherit = process.env.AGENTFLOW_CURSOR_STDERR_INHERIT === "1" || process.env.AGENTFLOW_CURSOR_STDERR_INHERIT === "true";
    const child = spawn(agentCmd, args, {
      cwd: workspaceRoot,
      stdio: ["ignore", "pipe", useStderrInherit ? "inherit" : "pipe"],
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
    const flowName = options.flowName ?? null;
    const uuid = options.uuid ?? null;

    /** machineReadable 时 Cursor 输出写 stderr，保证 stdout 仅用于 JSON 事件行 */
    const outStream = machineReadable ? process.stderr : process.stdout;
    function writeStdout(text) {
      if (coloredPrefix) writeWithPrefix(outStream, text, coloredPrefix, agentContentColor);
      else if (text) outStream.write(agentContentColor(text));
      if (text && flowName && uuid) appendRunLogLine(workspaceRoot, flowName, uuid, "cursor-stdout", text);
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

    if (!useStderrInherit) {
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
        if (flowName && uuid) appendRunLogLine(workspaceRoot, flowName, uuid, "cursor-stderr", s);
      });
    }

    const stdoutWidth = process.stdout.columns ?? 80;
    const mdStreamer = createMarkdownStreamer({
      render: (md) => renderMarkdown(md, { width: stdoutWidth }),
      spacing: "single",
    });

    /** 超过此长度的未解析行只输出摘要，避免整段 JSON 刷屏与写入 run log。需看完整 JSON 时可设 AGENTFLOW_DEBUG_STDOUT=1 */
    const STDOUT_RAW_CAP = 200;
    const debugStdout = process.env.AGENTFLOW_DEBUG_STDOUT === "1" || process.env.AGENTFLOW_DEBUG_STDOUT === "true";

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      const lines = chunk.split("\n").filter(Boolean);
      for (const line of lines) {
        if (flowName && uuid) appendRunLogLine(workspaceRoot, flowName, uuid, "cursor-stdout-raw", line);
        try {
          const event = JSON.parse(line);
          if (event.type === "assistant" && event.message?.content) {
            let text = (event.message.content || [])
              .filter((c) => c.type === "text" && c.text)
              .map((c) => c.text)
              .join("");
            if (text) {
              text = text.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
              const out = mdStreamer.push(text);
              if (out) writeStdout(out);
            }
          } else if (event.type === "tool_call") {
            const toolName = event.tool_call && typeof event.tool_call === "object"
              ? Object.keys(event.tool_call)[0] ?? "?"
              : "?";
            const subtype = event.subtype ?? "";
            if (options.onToolCall) options.onToolCall(subtype, toolName);
          } else if (event.type === "thinking") {
            if (options.onToolCall) options.onToolCall("thinking", "");
          } else if (event.type === "result") {
            lastResult = event;
            if (event.subtype === "success" && !event.is_error) {
              hadError = false;
            } else {
              hadError = true;
            }
          } else {
            writeStdout(`[cursor-stdout] event: ${event.type ?? "unknown"}\n`);
          }
        } catch (_) {
          let out;
          if (line.includes('"type":"tool_call"') || line.includes('"type": "tool_call"')) {
            let subtype = "?";
            try {
              const event = JSON.parse(line);
              if (event && event.type === "tool_call") subtype = event.subtype ?? "?";
            } catch (_) {
              // 大 payload（如 grep 整段结果）会导致 JSON.parse 失败，用正则从行首提取 subtype，避免解析整行
              const m = line.match(/"subtype"\s*:\s*"([^"]+)"/);
              if (m) subtype = m[1];
            }
            out = `[cursor] tool_call ${subtype}\n`;
          } else if (debugStdout || line.length <= STDOUT_RAW_CAP) {
            out = line + "\n";
          } else if (lastResult == null) {
            out = `[cursor-stdout] (非 JSON，可能为 Cursor 报错) ${line.slice(0, 500)}${line.length > 500 ? "..." : ""}\n`;
          } else {
            out = `[cursor-stdout] (解析失败或未处理的一行, ${line.length} 字符)\n`;
          }
          writeStdout(out);
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
      if (!useStderrInherit) child.stderr.removeAllListeners();
      child.removeAllListeners();
      const tail = mdStreamer.finish();
      if (tail) writeStdout(tail);
      if (coloredPrefix && stderrLineBuffer) {
        writeWithPrefix(process.stderr, stderrLineBuffer.endsWith("\n") ? stderrLineBuffer : stderrLineBuffer + "\n", coloredPrefix);
      }
      if (code !== 0 && lastResult == null) {
        const stderr = Buffer.concat(stderrChunks).toString("utf-8");
        const stderrTail = stderr ? stderr.trim().slice(-1200) : "";
        const logHint = flowName && uuid
          ? ` 检查 run 目录 logs/log.txt 查看完整 Cursor stderr；常见原因：未登录 Cursor、模型不可用、网络/权限。若无报错内容，可设置 AGENTFLOW_CURSOR_STDERR_INHERIT=1 后重跑，使 Cursor 的 stderr 直接输出到终端。`
          : "";
        const err = new Error(
          `Cursor CLI exited ${code}. ${stderrTail || "No result event received."}${logHint}`,
        );
        err.cursorStderrTail = stderrTail;
        reject(err);
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

/**
 * Run OpenCode CLI in non-interactive mode for a node.
 * 与 Cursor 一致：agent 身份先替换到「该节点 intermediate」目录（prompt 所在目录）/agent-<subagent>.md，再传该路径及本任务路径。
 */
function runOpenCodeAgentForNode(workspaceRoot, { promptPath, intermediatePath, resultPathRel, subagent }, options = {}) {
  const absPromptPath = path.resolve(workspaceRoot, promptPath);
  const absResultPath = path.join(path.resolve(workspaceRoot, intermediatePath), resultPathRel);
  const absIntermediatePath = path.resolve(workspaceRoot, intermediatePath);
  const nodeIntermediateDir = path.dirname(absPromptPath);
  const outputDir = path.join(absIntermediatePath, "output");
  const absWorkspaceRoot = path.resolve(workspaceRoot);
  const replacements = {
    workspaceRoot: absWorkspaceRoot,
    promptPath: absPromptPath,
    resultPath: absResultPath,
    intermediatePath: absIntermediatePath,
    outputDir,
  };
  const agentContent = loadAgentPromptWithReplacements(workspaceRoot, subagent, replacements);
  let agentPathForPrompt = getAgentPath(workspaceRoot, subagent);
  if (agentContent) {
    const resolvedAgentPath = path.join(nodeIntermediateDir, `agent-${subagent}.md`);
    fs.mkdirSync(nodeIntermediateDir, { recursive: true });
    fs.writeFileSync(resolvedAgentPath, agentContent, "utf8");
    agentPathForPrompt = resolvedAgentPath;
  }
  const promptText = `Agent角色定义: ${agentPathForPrompt}

请先阅读该文件以确定身份与规范，再按以下路径执行：
- 读取指令 prompt：${absPromptPath}
- workspaceRoot（write-result 第一参数）：${absWorkspaceRoot}
- resultPath：${absResultPath}
- outputDir：${outputDir}
请只完成该节点任务，不要修改 flow 或其它节点。`;

  const model = options.model && String(options.model).trim();
  const rawPrefix = options.outputPrefix != null ? `[${options.outputPrefix}] ` : "";
  const coloredPrefix = rawPrefix && options.prefixColor ? options.prefixColor(rawPrefix) : rawPrefix;
  const agentContentColor = options.contentColor ?? ((line) => chalk.gray(line));

  return new Promise((resolve, reject) => {
    const opencodeCmd = process.env.OPENCODE_CMD || "opencode";
    const args = ["run"];
    if (model) {
      args.push("--model", model);
    }
    args.push("--dir", workspaceRoot);
    // 使用 "--" 结束选项解析，避免 prompt 以 "---"（frontmatter）开头时被误解析为选项导致打印 help 并 exit 1
    args.push("--", promptText);
    const spawnOpts = {
      cwd: workspaceRoot,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    };
    // 与 Cursor 的 --trust/--force 对应：非交互下 external_directory 默认 ask 会 auto-reject，需显式 allow
    // 使用 OPENCODE_CONFIG_CONTENT（优先级高于 opencode.json）确保权限生效
    if (options.force) {
      spawnOpts.env = {
        ...process.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          permission: { external_directory: "allow" },
        }),
      };
    }
    const child = spawn(opencodeCmd, args, spawnOpts);
    const flowName = options.flowName ?? null;
    const uuid = options.uuid ?? null;

    function writeStdout(text) {
      if (!text) return;
      if (coloredPrefix) writeWithPrefix(process.stdout, text, coloredPrefix, agentContentColor);
      else process.stdout.write(agentContentColor(text));
      if (text && flowName && uuid) appendRunLogLine(workspaceRoot, flowName, uuid, "opencode-stdout", text);
    }

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      writeStdout(chunk);
    });

    child.stderr.on("data", (chunk) => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      if (flowName && uuid) appendRunLogLine(workspaceRoot, flowName, uuid, "opencode-stderr", s);
      if (coloredPrefix) {
        writeWithPrefix(process.stderr, s, coloredPrefix, agentContentColor);
      } else {
        process.stderr.write(chunk);
      }
    });

    child.on("error", (err) => {
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.removeAllListeners();
      reject(new Error(`OpenCode CLI failed to start: ${err.message}. Ensure '${opencodeCmd}' is in PATH.`));
    });

    child.on("close", (code) => {
      child.stdout.removeAllListeners();
      child.stderr.removeAllListeners();
      child.removeAllListeners();
      if (code !== 0) {
        reject(new Error(`OpenCode CLI exited ${code}.`));
        return;
      }
      resolve();
    });
  });
}

/**
 * 仅 pre+post、不执行任何命令的节点类型；CLI 的「跳过 agent」规则仅由此处维护，pre-process 只提供 definitionId 与可选的 directCommand。
 * - 留在 LOCAL_ONLY（执行阶段跳过，仅 pre + post）：control_start、control_end、control_if、tool_print、tool_user_check、provide_str、provide_file。
 * - 需执行一条确定命令的节点（control_anyOne、tool_load_key、tool_save_key）由 pre 输出 directCommand，CLI 执行该命令并跳过 agent，不列入本集合。
 */
const LOCAL_ONLY_DEFINITION_IDS = new Set([
  "control_if",
  "control_start",
  "control_end",
  "tool_print",
  "tool_user_check",
  "provide_str",
  "provide_file",
]);

/**
 * 仅 pre+post 且由 CLI 负责写终态的节点：post 后由 CLI 调用 write-result 写入 success，避免 get-ready-nodes 因非终态而循环。
 * 不含 control_if（pre 已写 success）、tool_user_check（post 已写 pending）。
 */
const LOCAL_ONLY_TERMINAL_SUCCESS_IDS = new Set([
  "control_start",
  "control_end",
  "tool_print",
  "provide_str",
  "provide_file",
]);

/**
 * Execute one node: 按 definitionId / directCommand 决定是否走 Cursor CLI。
 * 顺序：1) definitionId ∈ LOCAL_ONLY_DEFINITION_IDS → 直接 return（仅 pre+post）；2) preOutput.directCommand 存在 → 执行该命令并 return；3) 否则 → runCursorAgentForNode。
 * options.model: optional Cursor CLI --model (overrides CURSOR_AGENT_MODEL).
 */
async function executeNode(workspaceRoot, flowName, uuid, instanceId, preOutput, options = {}) {
  const { definitionId, directCommand, promptPath, resultPath, subagent } = preOutput;
  const runDir = getRunDir(workspaceRoot, flowName, uuid);
  const intermediatePath = runDir;

  if (definitionId && LOCAL_ONLY_DEFINITION_IDS.has(definitionId)) {
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

  const { cli, model, label: modelLabelResolved } = resolveCliAndModel(
    workspaceRoot,
    preOutput.model ?? null,
    options.model ?? null,
  );

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
    if (cli === "opencode") {
      await runOpenCodeAgentForNode(
        workspaceRoot,
        { promptPath, intermediatePath, resultPathRel: resultPath, subagent },
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
        { promptPath, intermediatePath, resultPathRel: resultPath, subagent },
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

function runPostProcess(workspaceRoot, flowName, uuid, instanceId, execId) {
  const result = runNodeScript(
    workspaceRoot,
    "post-process-node.mjs",
    [workspaceRoot, flowName, uuid, instanceId, String(execId)],
    { captureStdout: true },
  );
  parseJsonStdout(result);
}

/**
 * CLI 侧：对「仅 pre+post、需由 CLI 写终态」的节点，在 post 后写入 result.status = success，避免 get-ready-nodes 循环。
 */
function ensureLocalNodeTerminalSuccess(workspaceRoot, flowName, uuid, instanceId, preOutput) {
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

/** 仅打印全量节点状态表（应用进入时展示一次用）。输出到 stderr。 */
function printNodeStatusTable(instanceStatus, nodes, execIdMap = {}) {
  const idToLabel = new Map();
  const idToType = new Map();
  if (Array.isArray(nodes)) {
    for (const n of nodes) {
      idToLabel.set(n.id, n.label || n.id);
      idToType.set(n.id, n.type || "-");
    }
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
  process.stderr.write("\n" + chalk.bold("节点状态") + "\n");
  process.stderr.write(statusTable.toString() + "\n");
}

/** parallel 默认 false：多进程同时跑时 Cursor CLI 会写 ~/.cursor/cli-config.json，易产生 rename 竞态 (ENOENT)，故默认串行。 */
async function apply(workspaceRoot, flowName, uuidArg, dryRun, agentModel = null, force = true, parallel = false) {
  ensureReference(workspaceRoot);
  const flowDir = getFlowDir(workspaceRoot, flowName);
  if (!flowDir) {
    throw new Error(
      `Flow not found: ${flowName} (no flow.yaml under ${PIPELINES_DIR_WORKSPACE}/${flowName} or ${PIPELINES_DIR}/${flowName})`,
    );
  }
  const ensureArgs = [workspaceRoot, uuidArg || "", flowName].filter(Boolean);
  ensureArgs.push(flowDir);
  const ensureResult = runNodeScript(
    workspaceRoot,
    "ensure-run-dir.mjs",
    ensureArgs,
    { captureStdout: true },
  );
  const { uuid } = parseJsonStdout(ensureResult);

  const parseResult = runNodeScript(
    workspaceRoot,
    "parse-flow.mjs",
    [workspaceRoot, flowName, uuid, flowDir],
    { captureStdout: true },
  );
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

    /** 节点状态仅在进入时（第一轮）展示一次 */
    if (round === 1) printNodeStatusTable(instanceStatus, parseOut.nodes, execIdMap);

    if (readyNodes.length === 0) {
      if (allDone) {
        const totalElapsed = runStartTime != null ? formatDuration(Date.now() - runStartTime) : "-";
        emitEvent(workspaceRoot, flowName, uuid, {
          event: "apply-done",
          flowName,
          uuid,
          runDir: getRunDir(workspaceRoot, flowName, uuid),
          totalElapsed,
        });
        log.info(`\nApply done. uuid=${uuid} runDir=${getRunDir(workspaceRoot, flowName, uuid)}  ${chalk.dim("总 " + totalElapsed)}`);
        return;
      }
      if (pendingNodes.length > 0) {
        const totalElapsed = runStartTime != null ? formatDuration(Date.now() - runStartTime) : "-";
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
        log.info(`\nPaused: uuid=${uuid} pendingNodes=${pendingNodes.join(", ")}  ${chalk.dim("总 " + totalElapsed)}`);
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

    if (runStartTime === null) runStartTime = ensureRunStartTime(workspaceRoot, flowName, uuid);

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
        `[agentflow] 执行节点 instanceId=${instanceId} definitionId=${preOutput.definitionId ?? "-"} promptPath=${preOutput.promptPath} resultPath=${preOutput.resultPath} subagent=${preOutput.subagent} role=${preOutput.role ?? "-"} model=${preOutput.model ?? "-"} execId=${preOutput.execId} directCommand=${preOutput.directCommand ? "yes" : "-"}`,
      );
    }

    const runOne = async ({ instanceId, label, preOutput, outputPrefix, prefixColor }, isParallel) => {
      if (!isParallel) {
        const isLocalOnly = preOutput.definitionId && LOCAL_ONLY_DEFINITION_IDS.has(preOutput.definitionId);
        const { label: resolvedLabel } = resolveCliAndModel(
          workspaceRoot,
          preOutput.model ?? null,
          agentModel ?? null,
        );
        const modelLabel = isLocalOnly ? "(本地)" : resolvedLabel;
        const promptAbs = path.resolve(workspaceRoot, preOutput.promptPath);
        // CLI 侧「开始」信息同时写入终端与 run 日志
        emitEvent(workspaceRoot, flowName, uuid, {
          event: "node-start",
          instanceId,
          label,
          definitionId: preOutput.definitionId ?? null,
          modelCli: isLocalOnly ? null : resolveCliAndModel(workspaceRoot, preOutput.model ?? null, agentModel ?? null).cli,
          model: modelLabel,
          execId: preOutput.execId ?? null,
          promptPathRel: preOutput.promptPath ?? null,
          promptPathAbs: promptAbs,
          resultPathRel: preOutput.resultPath ?? null,
          subagent: preOutput.subagent ?? null,
          directCommand: preOutput.directCommand ? String(preOutput.directCommand) : null,
        });
        appendRunLogLine(workspaceRoot, flowName, uuid, "cli-raw", `【开始】节点 ${instanceId} (${label}) model: ${modelLabel}`);
        appendRunLogLine(workspaceRoot, flowName, uuid, "cli-raw", `Prompt: ${promptAbs}`);
        process.stderr.write("\n" + NODE_SEP + "\n");
        process.stderr.write(chalk.bold.cyan("【开始】节点 ") + instanceId + chalk.dim(" (" + label + ")") + "  " + chalk.dim("model: ") + chalk.yellow(modelLabel) + "\n");
        log.info(chalk.dim("Prompt: ") + promptAbs);
        process.stderr.write(NODE_SEP + "\n\n");
        const startTime = Date.now();
        const initialRunningText = `Running: ${instanceId} (${label})  ${formatDuration(0) + " / " + formatDuration(Date.now() - runStartTime)}`;
        appendRunLogLine(workspaceRoot, flowName, uuid, "cli-raw", initialRunningText);
        const spinner = ora({
          text: `Running: ${instanceId} ${chalk.dim("(" + label + ")")}  ${chalk.dim(formatDuration(0) + " / " + formatDuration(Date.now() - runStartTime))}`,
          stream: process.stderr,
          discardStdin: false,
        }).start();
        let lastToolCallText = "";
        const updateSpinnerText = () => {
          const duration = formatDuration(Date.now() - startTime) + " / " + formatDuration(Date.now() - runStartTime);
          spinner.text = `Running: ${instanceId} ${chalk.dim("(" + label + ")")}  ${chalk.dim(duration)}${lastToolCallText ? "  " + chalk.dim("| " + lastToolCallText) : ""}`;
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
          elapsedStr = formatDuration(Date.now() - startTime);
          const totalStr = runStartTime != null ? formatDuration(Date.now() - runStartTime) : "-";
          spinner.succeed(chalk.green(`Done: ${instanceId}`) + chalk.dim(" (" + label + ")") + "  " + chalk.dim(elapsedStr) + "  " + chalk.dim("总 " + totalStr));
          emitEvent(workspaceRoot, flowName, uuid, {
            event: "node-done",
            instanceId,
            label,
            elapsed: elapsedStr,
            total: totalStr,
          });
        } catch (err) {
          clearInterval(timeTick);
          elapsedStr = formatDuration(Date.now() - startTime);
          const totalStr = runStartTime != null ? formatDuration(Date.now() - runStartTime) : "-";
          spinner.fail(chalk.red(`Failed: ${instanceId}`) + chalk.dim(" (" + label + ")") + "  " + chalk.dim(elapsedStr) + "  " + chalk.dim("总 " + totalStr));
          emitEvent(workspaceRoot, flowName, uuid, {
            event: "node-failed",
            instanceId,
            label,
            elapsed: elapsedStr,
            total: totalStr,
            error: err && err.message ? String(err.message) : String(err),
          });
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
        `【开始】并行执行 ${preOutputs.length} 个节点: ${preOutputs.map((p) => p.instanceId).join(", ")}`,
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
      process.stderr.write(chalk.bold.cyan("【开始】并行执行 ") + preOutputs.length + " 个节点: " + preOutputs.map((p) => p.instanceId).join(", ") + "\n");
      for (const item of preOutputs) log.info(chalk.dim("Prompt: ") + path.resolve(workspaceRoot, item.preOutput.promptPath));
      process.stderr.write(NODE_SEP + "\n\n");
      log.info(chalk.cyan(`Running ${preOutputs.length} nodes in parallel: ${preOutputs.map((p) => p.instanceId).join(", ")}`));
      await Promise.all(preOutputs.map((item) => runOne(item, true)));
      const totalStrPar = runStartTime != null ? formatDuration(Date.now() - runStartTime) : "-";
      process.stderr.write("\n" + NODE_SEP + "\n");
      process.stderr.write(chalk.bold.cyan("【结束】并行节点全部完成") + "  " + chalk.dim("总 " + totalStrPar) + "\n");
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

async function replay(workspaceRoot, flowNameOrUuid, uuidOrInstanceId, instanceIdArg, agentModel = null, force = true) {
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
  emitEvent(workspaceRoot, flowName, uuid, {
    event: "replay-start",
    flowName,
    uuid,
    instanceId,
    definitionId: preOutput.definitionId ?? null,
    model: modelLabelReplay,
    execId: preOutput.execId ?? null,
    promptPathRel: preOutput.promptPath ?? null,
    promptPathAbs: promptAbs,
    resultPathRel: preOutput.resultPath ?? null,
  });
  appendRunLogLine(
    workspaceRoot,
    flowName,
    uuid,
    "cli-raw",
    `【开始】replay 节点 ${instanceId} model: ${modelLabelReplay}`,
  );
  appendRunLogLine(workspaceRoot, flowName, uuid, "cli-raw", `Prompt: ${promptAbs}`);
  process.stderr.write("\n" + NODE_SEP + "\n");
  process.stderr.write(chalk.bold.cyan("【开始】节点 ") + instanceId + "  " + chalk.dim("model: ") + chalk.yellow(modelLabelReplay) + "\n");
  log.info(chalk.dim("Prompt: ") + promptAbs);
  process.stderr.write(NODE_SEP + "\n\n");
  await executeNode(workspaceRoot, flowName, uuid, instanceId, preOutput, { model: agentModel, force });
  runPostProcess(workspaceRoot, flowName, uuid, instanceId, preOutput.execId);
  ensureLocalNodeTerminalSuccess(workspaceRoot, flowName, uuid, instanceId, preOutput);
  log.debug(`[agentflow] 退出节点 instanceId=${instanceId} execId=${preOutput.execId}`);
  process.stderr.write("\n" + NODE_SEP + "\n");
  process.stderr.write(chalk.bold.cyan("【结束】节点 ") + instanceId + "\n");
  process.stderr.write(NODE_SEP + "\n");
  emitEvent(workspaceRoot, flowName, uuid, {
    event: "replay-done",
    flowName,
    uuid,
    instanceId,
  });
  log.info(`\nReplay done. ${instanceId} uuid=${uuid}`);
}

/** 从指定目录收集含 flow.yaml 的子目录名。 */
function collectPipelineNamesFromDir(dirPath) {
  if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) return [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .filter((e) => fs.existsSync(path.join(dirPath, e.name, "flow.yaml")))
    .map((e) => e.name);
}

/** 列出所有 pipeline（包内 builtin + .workspace + .cursor/agentflow/pipelines，合并去重），带来源列。 */
function listPipelines(workspaceRoot) {
  const rows = listFlowsJson(workspaceRoot);
  if (rows.length === 0) {
    log.info(
      "No pipelines found (no subdirs with flow.yaml under builtin, " +
        PIPELINES_DIR +
        " or " +
        PIPELINES_DIR_WORKSPACE +
        ").",
    );
    return;
  }
  const table = new Table({
    head: [chalk.cyan("Pipeline"), chalk.cyan("来源"), chalk.cyan("Apply 示例")],
    colWidths: [24, 10, 48],
    style: { head: [], border: ["grey"] },
  });
  for (const row of rows) {
    const sourceLabel = row.source === "builtin" ? "builtin" : "user";
    table.push([row.id, sourceLabel, `agentflow apply ${row.id}`]);
  }
  log.info("\n" + chalk.bold("Pipelines"));
  log.info(table.toString());
}

/** 解析 .md 节点文件的 frontmatter：返回 { input, output, displayName, description }，槽位为 { type, name, default? }[] */
function parseNodeFrontmatter(raw) {
  const m = raw.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
  const data = { input: [], output: [], displayName: undefined, description: undefined };
  if (!m) return data;
  const fm = m[1];
  const slotRe = /^\s*-\s+type:\s*["']?([^"'\n]*)["']?(?:\s*\n\s+name:\s*["']?([^"'\n]*)["']?)?(?:\s*\n\s+(?:default|value):\s*(.*))?/gm;
  const inputBlock = fm.match(/(?:^|\n)\s*input:\s*\n([\s\S]*?)(?=\n\s*[a-zA-Z_][a-zA-Z0-9_]*\s*:|---|$)/m);
  const outputBlock = fm.match(/(?:^|\n)\s*output:\s*\n([\s\S]*?)(?=\n\s*[a-zA-Z_][a-zA-Z0-9_]*\s*:|---|$)/m);
  const normalizeSlots = (block) => {
    if (!block) return [];
    return block[1]
      .split(/\n/)
      .filter((line) => /^\s*-\s+type:/.test(line))
      .map((line) => {
        const typeM = line.match(/type:\s*["']?([^"'\n]*)["']?/);
        const nameM = line.match(/name:\s*["']?([^"'\n]*)["']?/);
        const defaultM = line.match(/(?:default|value):\s*(.*)$/);
        return {
          type: typeM ? typeM[1].trim() : "文本",
          name: nameM ? nameM[1].trim() : undefined,
          default: defaultM ? defaultM[1].trim().replace(/^["']|["']$/g, "") : undefined,
        };
      });
  };
  data.input = normalizeSlots(inputBlock);
  data.output = normalizeSlots(outputBlock);
  const descM = fm.match(/\bdescription:\s*["']?([^"'\n#][^\n]*)["']?/);
  const displayM = fm.match(/\bdisplayName:\s*["']?([^"'\n#][^\n]*)["']?/);
  if (descM) data.description = descM[1].trim().replace(/^["']|["']$/g, "");
  if (displayM) data.displayName = displayM[1].trim().replace(/^["']|["']$/g, "");
  return data;
}

function listFlowsJson(workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  const out = [];
  const fromBuiltin = collectPipelineNamesFromDir(PACKAGE_BUILTIN_PIPELINES_DIR);
  for (const name of fromBuiltin) {
    out.push({ id: name, path: path.join(PACKAGE_BUILTIN_PIPELINES_DIR, name), source: "builtin" });
  }
  const fromWorkspace = collectPipelineNamesFromDir(path.join(root, PIPELINES_DIR_WORKSPACE));
  for (const name of fromWorkspace) {
    out.push({ id: name, path: path.join(root, PIPELINES_DIR_WORKSPACE, name), source: "user" });
  }
  const fromCursor = collectPipelineNamesFromDir(path.join(root, PIPELINES_DIR));
  for (const name of fromCursor) {
    if (!out.some((f) => f.id === name && f.source === "user")) {
      out.push({ id: name, path: path.join(root, PIPELINES_DIR, name), source: "user" });
    }
  }
  out.sort((a, b) => (a.source !== b.source ? (a.source === "builtin" ? -1 : 1) : a.id.localeCompare(b.id)));
  return out;
}

function listNodesJson(workspaceRoot, flowId, flowSource) {
  const root = path.resolve(workspaceRoot);
  const byId = new Map();
  const addFromDir = (dir, source, flowIdOpt) => {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return;
    const files = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile() && e.name.endsWith(".md"));
    for (const e of files) {
      const id = e.name.replace(/\.mdx?$/i, "").replace(/\.markdown$/i, "");
      let type = "agent";
      if (/^control/i.test(id)) type = "control";
      else if (/^provide/i.test(id)) type = "provide";
      else if (/^tool/i.test(id)) type = "agent";
      try {
        const raw = fs.readFileSync(path.join(dir, e.name), "utf-8");
        const data = parseNodeFrontmatter(raw);
        const strippedId =
          id.replace(/^agent_?/i, "").replace(/^control_?/i, "").replace(/^provide_?/i, "").replace(/^tool_?/i, "") || id;
        const label = data.displayName ?? strippedId;
        byId.set(id, {
          id,
          type,
          label,
          displayName: data.displayName,
          description: data.description,
          inputs: data.input,
          outputs: data.output,
          source: flowIdOpt ? "flow" : "project",
          flowId: flowIdOpt,
        });
      } catch (_) {}
    }
  };
  addFromDir(PACKAGE_BUILTIN_NODES_DIR, "project");
  addFromDir(path.join(root, ".cursor", "agentflow", "nodes"), "project");
  if (flowId && flowSource) {
    const flowDir =
      flowSource === "builtin"
        ? path.join(PACKAGE_BUILTIN_PIPELINES_DIR, flowId)
        : path.join(root, flowSource === "user" ? PIPELINES_DIR_WORKSPACE : PIPELINES_DIR, flowId);
    addFromDir(path.join(flowDir, "nodes"), "flow", flowId);
  }
  return Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id));
}

function readFlowJson(workspaceRoot, flowId, flowSource) {
  const root = path.resolve(workspaceRoot);
  let flowDir;
  if (flowSource === "builtin") {
    flowDir = path.join(PACKAGE_BUILTIN_PIPELINES_DIR, flowId);
  } else {
    flowDir = path.join(root, PIPELINES_DIR_WORKSPACE, flowId);
    if (!fs.existsSync(path.join(flowDir, "flow.yaml"))) {
      flowDir = path.join(root, PIPELINES_DIR, flowId);
    }
  }
  const yamlPath = path.join(flowDir, "flow.yaml");
  if (!fs.existsSync(yamlPath)) {
    return { error: "Flow not found: " + flowId };
  }
  try {
    const flowYaml = fs.readFileSync(yamlPath, "utf-8");
    return { flowYaml };
  } catch (e) {
    return { error: (e && e.message) || String(e) };
  }
}

function readNodeJson(workspaceRoot, nodeId, flowId, flowSource) {
  const root = path.resolve(workspaceRoot);
  const fileName = nodeId.endsWith(".md") ? nodeId : `${nodeId}.md`;
  const pathsToTry = [];
  if (flowId && flowSource) {
    const flowDir =
      flowSource === "builtin"
        ? path.join(PACKAGE_BUILTIN_PIPELINES_DIR, flowId)
        : path.join(root, flowSource === "user" ? PIPELINES_DIR_WORKSPACE : PIPELINES_DIR, flowId);
    pathsToTry.push(path.join(flowDir, "nodes", fileName));
  }
  pathsToTry.push(path.join(root, ".cursor", "agentflow", "nodes", fileName));
  pathsToTry.push(path.join(PACKAGE_BUILTIN_NODES_DIR, fileName));
  for (const filePath of pathsToTry) {
    if (!fs.existsSync(filePath)) continue;
    try {
      const raw = fs.readFileSync(filePath, "utf-8");
      const data = parseNodeFrontmatter(raw);
      const content = raw.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, "").trim();
      let type = "agent";
      if (/^control/i.test(nodeId)) type = "control";
      else if (/^provide/i.test(nodeId)) type = "provide";
      else if (/^tool/i.test(nodeId)) type = "agent";
      const strippedId =
        nodeId.replace(/\.md$/, "").replace(/^agent_?/i, "").replace(/^control_?/i, "").replace(/^provide_?/i, "").replace(/^tool_?/i, "") || nodeId;
      const label = data.displayName ?? strippedId;
      return {
        type,
        label,
        displayName: data.displayName,
        inputs: data.input,
        outputs: data.output,
        executionLogic: content || undefined,
        description: data.description,
      };
    } catch (_) {}
  }
  return { error: "Node not found: " + nodeId };
}

function copyBuiltinJson(workspaceRoot, flowId, targetFlowId) {
  const root = path.resolve(workspaceRoot);
  const destId = (targetFlowId && targetFlowId.trim()) || flowId;
  const srcDir = path.join(PACKAGE_BUILTIN_PIPELINES_DIR, flowId);
  const destDir = path.join(root, PIPELINES_DIR_WORKSPACE, destId);
  if (!fs.existsSync(srcDir) || !fs.existsSync(path.join(srcDir, "flow.yaml"))) {
    return { success: false, error: "内置流程不存在" };
  }
  const existing = collectPipelineNamesFromDir(path.join(root, PIPELINES_DIR_WORKSPACE));
  if (existing.includes(destId)) {
    return { success: false, error: "该名称已存在，请换一个" };
  }
  try {
    fs.mkdirSync(path.dirname(destDir), { recursive: true });
    fs.cpSync(srcDir, destDir, { recursive: true });
    return { success: true };
  } catch (e) {
    return { success: false, error: (e && e.message) || String(e) };
  }
}

function printHelp() {
  log.info(`
AgentFlow CLI — drive apply/replay with Cursor or OpenCode CLI streaming.

Usage:
  agentflow list                              列出所有 pipeline
  agentflow apply <FlowName> [uuid]            或 agentflow apply <uuid>（由 uuid 反查 pipeline）
  agentflow resume <FlowName> <uuid> [instanceId]  将 pending 节点标为已确认并继续 apply
  agentflow replay [flowName] <uuid> <instanceId>
  agentflow run-status <flowName> <uuid>  输出该次运行的节点状态 JSON（供 UI 展示 success/pending 等角标）
  agentflow --help

Options:
  --workspace-root <path>  Workspace root (default: cwd)
  --dry-run                (apply only) Print ready nodes and exit without running Cursor agent
  --model <name>           Cursor CLI model (e.g. claude-sonnet). Overrides CURSOR_AGENT_MODEL. Run 'agent models' to list.
  --debug                  Show debug logs (gray, low priority)
  --force                  Pass --force/--trust to Cursor; set OPENCODE_PERMISSION to allow external_directory for OpenCode (default: on). Use --no-force to disable.
  --parallel               Run same-round ready nodes in parallel (default: off; use to enable). Multiple Cursor CLI processes may race on ~/.cursor/cli-config.json.
  --machine-readable       Emit one JSON event per line to stdout (apply-start/node-start/node-done/node-failed/apply-done/apply-paused). For UI run button: parse stdout to show current node; Cursor agent output goes to stderr.

Apply: builds run dir, parses flow, runs ready nodes in a loop.
  With -ai / --ai: run a single step for external (AI) multi-round control:
    agentflow apply -ai ensure-run-dir <workspaceRoot> [uuid] <flowName>
    agentflow apply -ai parse-flow <workspaceRoot> <flowName> <uuid> [flowDir]
    agentflow apply -ai get-ready-nodes <workspaceRoot> <flowName> <uuid>
    agentflow apply -ai pre-process-node <workspaceRoot> <flowName> <uuid> <instanceId>
    agentflow apply -ai post-process-node <workspaceRoot> <flowName> <uuid> <instanceId> [execId]
    agentflow apply -ai write-result <workspaceRoot> <flowName> <uuid> <instanceId> --json '<JSON>'
    agentflow apply -ai run-tool-nodejs <workspaceRoot> <flowName> <uuid> <instanceId> [execId] -- <scriptCmd> [args...]
    agentflow apply -ai check-flow <workspaceRoot> <flowName> [flowDir]
    agentflow apply -ai collect-nodes <workspaceRoot> <flowName> [runDir]
    agentflow apply -ai gc <workspaceRoot> [--list] [--dry-run] [--delete] [--keep N] [--older-than N]
Resume: marks pending node(s) as success (e.g. after UserCheck 确认), then continues apply.
Replay: runs a single node (pre-process → execute → post-process).

Requires: Node >=18, Cursor CLI ('agent') in PATH for node execution.
Apply/replay scripts are bundled in the agentflow package (bin/apply/).
`);
}

async function main() {
  const argv = process.argv.slice(2);
  let workspaceRoot = process.cwd();
  const shift = () => argv.shift();
  // 支持 --workspace-root 在任意位置（桌面端传 list-flows --json --workspace-root <path>）
  const wrIdx = argv.indexOf("--workspace-root");
  if (wrIdx >= 0 && argv[wrIdx + 1]) {
    workspaceRoot = path.resolve(argv[wrIdx + 1]);
    argv.splice(wrIdx, 2);
  }
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
  if (argv.includes("--machine-readable")) {
    machineReadable = true;
    argv.splice(argv.indexOf("--machine-readable"), 1);
  }
  const jsonMode = argv.includes("--json");
  if (jsonMode) argv.splice(argv.indexOf("--json"), 1);
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
  if (sub === "list-flows" && jsonMode) {
    const list = listFlowsJson(workspaceRoot);
    process.stdout.write(JSON.stringify(list) + "\n");
    process.exit(0);
  }
  if (sub === "list-nodes" && jsonMode) {
    let flowId, flowSource;
    const flowIdIdx = argv.indexOf("--flow-id");
    if (flowIdIdx >= 0 && argv[flowIdIdx + 1]) {
      flowId = argv[flowIdIdx + 1];
      argv.splice(flowIdIdx, 2);
    }
    const flowSourceIdx = argv.indexOf("--flow-source");
    if (flowSourceIdx >= 0 && argv[flowSourceIdx + 1]) {
      flowSource = argv[flowSourceIdx + 1];
      argv.splice(flowSourceIdx, 2);
    }
    const list = listNodesJson(workspaceRoot, flowId, flowSource);
    process.stdout.write(JSON.stringify(list) + "\n");
    process.exit(0);
  }
  if (sub === "read-flow" && jsonMode) {
    let flowSource = "user";
    const flowSourceIdx = argv.indexOf("--flow-source");
    if (flowSourceIdx >= 0 && argv[flowSourceIdx + 1]) {
      flowSource = argv[flowSourceIdx + 1];
      argv.splice(flowSourceIdx, 2);
    }
    const flowId = argv.find((a) => !a.startsWith("--"));
    if (!flowId) {
      process.stdout.write(JSON.stringify({ error: "Missing flowId" }) + "\n");
      process.exit(1);
    }
    const result = readFlowJson(workspaceRoot, flowId, flowSource);
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(result.error ? 1 : 0);
  }
  if (sub === "read-node" && jsonMode) {
    let flowId, flowSource;
    const flowIdIdx = argv.indexOf("--flow-id");
    if (flowIdIdx >= 0 && argv[flowIdIdx + 1]) {
      flowId = argv[flowIdIdx + 1];
      argv.splice(flowIdIdx, 2);
    }
    const flowSourceIdx = argv.indexOf("--flow-source");
    if (flowSourceIdx >= 0 && argv[flowSourceIdx + 1]) {
      flowSource = argv[flowSourceIdx + 1];
      argv.splice(flowSourceIdx, 2);
    }
    const nodeId = argv.find((a) => !a.startsWith("--"));
    if (!nodeId) {
      process.stdout.write(JSON.stringify({ error: "Missing nodeId" }) + "\n");
      process.exit(1);
    }
    const result = readNodeJson(workspaceRoot, nodeId, flowId, flowSource);
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(result.error ? 1 : 0);
  }
  if (sub === "copy-builtin" && jsonMode) {
    const flowId = shift();
    let targetFlowId;
    const targetIdx = argv.indexOf("--target");
    if (targetIdx >= 0 && argv[targetIdx + 1]) targetFlowId = argv[targetIdx + 1];
    if (!flowId) {
      process.stdout.write(JSON.stringify({ success: false, error: "Missing flowId" }) + "\n");
      process.exit(1);
    }
    const result = copyBuiltinJson(workspaceRoot, flowId, targetFlowId);
    process.stdout.write(JSON.stringify(result) + "\n");
    process.exit(result.success ? 0 : 1);
  }
  if (sub === "list") {
    listPipelines(workspaceRoot);
  } else if (sub === "apply") {
    const aiMode = argv[0] === "-ai" || argv[0] === "--ai";
    if (aiMode) {
      argv.shift(); // -ai / --ai
      const step = argv.shift();
      if (!step || !APPLY_AI_STEPS.includes(step)) {
        throw new Error(
          "Missing or invalid step. Usage: agentflow apply -ai <step> <args...>. Steps: " + APPLY_AI_STEPS.join(", "),
        );
      }
      if (argv.length === 0) {
        throw new Error("Missing args for step " + step + ". Example: agentflow apply -ai ensure-run-dir <workspaceRoot> [uuid] <flowName>");
      }
      const stepWorkspaceRoot = path.resolve(argv[0]);
      ensureReference(stepWorkspaceRoot);
      const scriptName = step + ".mjs";
      const result = runNodeScript(stepWorkspaceRoot, scriptName, argv, { captureStdout: false });
      process.exit(result.status ?? 0);
    }
    const first = shift();
    if (!first) throw new Error("Missing FlowName or uuid. Usage: agentflow apply <FlowName> [uuid] | agentflow apply <uuid>");
    let flowName, uuidArg;
    if (isValidUuid(first)) {
      flowName = findFlowNameByUuid(workspaceRoot, first);
      if (!flowName) throw new Error("No run found for uuid " + first + ". Run apply with FlowName first (e.g. agentflow apply <FlowName>).");
      uuidArg = first;
    } else {
      flowName = first;
      uuidArg = isValidUuid(argv[0]) ? shift() : undefined;
    }
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
  } else if (sub === "run-status") {
    const flowName = shift();
    const uuidArg = shift();
    if (!flowName || !uuidArg) throw new Error("Usage: agentflow run-status <flowName> <uuid>");
    const result = runNodeScript(workspaceRoot, "get-ready-nodes.mjs", [workspaceRoot, flowName, uuidArg], { captureStdout: true });
    if (result.stdout) process.stdout.write(result.stdout);
    process.exit(result.status === 0 ? 0 : 1);
  } else if (sub === "list-flows" || sub === "list-nodes" || sub === "read-flow" || sub === "read-node" || sub === "copy-builtin") {
    throw new Error("Use --json with " + sub + ". Example: agentflow list-flows --json --workspace-root <path>");
  } else {
    throw new Error("Unknown command: " + sub + ". Use list, list-flows --json, list-nodes --json, read-flow --json, read-node --json, copy-builtin --json, apply, resume, replay, or run-status.");
  }
}

main().catch((err) => {
  log.error("Error: " + err.message);
  process.exit(1);
});
