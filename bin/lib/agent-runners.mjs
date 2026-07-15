import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import chalk from "chalk";
import { createMarkdownStreamer, render as renderMarkdown } from "markdansi";
import { getAgentPath, loadAgentPromptWithReplacements, stripYamlFrontmatter } from "./agents-path.mjs";
import { machineReadable } from "./log.mjs";
import { normalizeCursorModelForCli } from "./model-config.mjs";
import { appendRunLogLine } from "./run-events.mjs";
import { writeWithPrefix } from "./terminal.mjs";
import { t } from "./i18n.mjs";
import { readMergedEnvObject } from "./user-env.mjs";
import { outputNodeBasename } from "../pipeline/get-exec-id.mjs";

function shouldPassCursorModelArg(model) {
  const text = String(model || "").trim();
  return text !== "" && !/^auto$/i.test(text);
}

function childEnv(options = {}, extra = {}) {
  const optEnv = options && options.env && typeof options.env === "object" ? options.env : {};
  const userId = optEnv.AGENTFLOW_USER_ID || process.env.AGENTFLOW_USER_ID || "";
  return { ...process.env, ...readMergedEnvObject(userId), ...optEnv, ...extra };
}

function writeAgentTextArtifacts(absResultPath, absRunDir, instanceId, text) {
  const body = String(text ?? "").trim();
  if (!body) return;
  fs.mkdirSync(path.dirname(absResultPath), { recursive: true });
  fs.writeFileSync(absResultPath, body + "\n", "utf-8");
  if (!instanceId) return;
  const slotPath = path.join(absRunDir, "output", instanceId, outputNodeBasename(instanceId, 1, "result"));
  fs.mkdirSync(path.dirname(slotPath), { recursive: true });
  fs.writeFileSync(slotPath, body + "\n", "utf-8");
}

function envFlag(name, defaultValue = false) {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultValue;
  return raw !== "0" && raw !== "false";
}

function cleanModel(value, fallbackEnvName = "") {
  const raw = value ?? (fallbackEnvName ? process.env[fallbackEnvName] : null) ?? "";
  const text = String(raw).trim();
  if (!text) return "";
  const dashIdx = text.indexOf(" - ");
  return dashIdx >= 0 ? text.slice(0, dashIdx).trim() : text;
}

function hasGitMetadataAncestor(startDir) {
  let cur = path.resolve(startDir || ".");
  while (true) {
    if (fs.existsSync(path.join(cur, ".git"))) return true;
    const parent = path.dirname(cur);
    if (parent === cur) return false;
    cur = parent;
  }
}

function shouldSkipCodexGitCheck(workspace) {
  const raw = process.env.AGENTFLOW_CODEX_SKIP_GIT_CHECK;
  if (raw === "1" || raw === "true") return true;
  if (raw === "0" || raw === "false") return false;
  return !hasGitMetadataAncestor(workspace);
}

function buildCodexExecArgs({ workspace, addDirs = [], model, outputLastMessagePath, promptText, configArgs = [] }) {
  const args = [];
  for (const cfg of Array.isArray(configArgs) ? configArgs : []) {
    const value = String(cfg || "").trim();
    if (value) args.push("-c", value);
  }
  const approval = String(process.env.AGENTFLOW_CODEX_APPROVAL || "never").trim();
  if (approval) args.push("--ask-for-approval", approval);
  args.push("exec", "--json", "--color", "never", "--cd", workspace, "--output-last-message", outputLastMessagePath);
  if (envFlag("AGENTFLOW_CODEX_IGNORE_USER_CONFIG", true)) args.push("--ignore-user-config");
  for (const dir of addDirs) {
    const abs = path.resolve(dir);
    if (abs && abs !== workspace) args.push("--add-dir", abs);
  }
  if (envFlag("AGENTFLOW_CODEX_DANGER", false)) {
    args.push("--dangerously-bypass-approvals-and-sandbox");
  } else {
    args.push("--sandbox", String(process.env.AGENTFLOW_CODEX_SANDBOX || "workspace-write").trim() || "workspace-write");
  }
  if (shouldSkipCodexGitCheck(workspace)) args.push("--skip-git-repo-check");
  if (envFlag("AGENTFLOW_CODEX_EPHEMERAL", false)) args.push("--ephemeral");
  if (model) args.push("--model", model);
  args.push(promptText);
  return args;
}

function extractCodexText(event) {
  if (!event || typeof event !== "object") return "";
  const candidates = [
    event.delta,
    event.text,
    event.message,
    event.content,
    event.output_text,
    event.final_message,
    event.item?.text,
    event.item?.message,
    event.item?.content,
    event.msg?.content,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return normalizeStreamTextChunk(c);
    if (Array.isArray(c)) {
      const parts = c
        .map((part) => {
          if (typeof part === "string") return part;
          if (part && typeof part === "object") return part.text || part.content || part.output_text || "";
          return "";
        })
        .filter(Boolean);
      if (parts.length) return normalizeStreamTextChunk(parts.join(""));
    }
  }
  return "";
}

function extractCodexToolName(event) {
  if (!event || typeof event !== "object") return "";
  const names = [event.name, event.tool_name, event.toolName, event.call?.name, event.item?.name, event.command?.name];
  for (const name of names) {
    if (typeof name === "string" && name.trim()) return name.trim();
  }
  return "";
}

function codexEventKind(event) {
  const base = String(event?.type || event?.event || event?.kind || "unknown");
  const itemType = typeof event?.item?.type === "string" && event.item.type.trim() ? event.item.type.trim() : "";
  return itemType ? `${base}:${itemType}` : base;
}

function codexEventBaseKind(event) {
  return String(event?.type || event?.event || event?.kind || "unknown");
}

function codexItemType(event) {
  return typeof event?.item?.type === "string" ? event.item.type.trim().toLowerCase() : "";
}

function codexCommandText(event) {
  const item = event?.item;
  const candidates = [item?.command, item?.cmd, event?.command, event?.cmd];
  for (const c of candidates) {
    if (typeof c === "string" && c.trim()) return c.trim();
  }
  if (item?.command && typeof item.command === "object") {
    const name = item.command.name || item.command.command || "";
    const args = Array.isArray(item.command.args) ? item.command.args.join(" ") : "";
    const text = `${name} ${args}`.trim();
    if (text) return text;
  }
  return "";
}

function isNonFatalCodexErrorMessage(message) {
  const lower = String(message || "").toLowerCase();
  return lower.includes("reconnecting") || lower.includes("retrying") || lower.includes("timed out waiting for") || lower.includes("transport channel closed");
}

function handleCodexEvent(event, { emitNatural, emitStatus, onToolCall }) {
  const kind = codexEventKind(event);
  const baseKind = codexEventBaseKind(event);
  const lower = kind.toLowerCase();
  const baseLower = baseKind.toLowerCase();
  const itemType = codexItemType(event);
  const text = extractCodexText(event);

  if (itemType === "agent_message") {
    if (text) emitNatural("assistant", text);
    return { handled: true, hadError: false };
  }
  if (itemType.includes("reason") || itemType.includes("thinking")) {
    if (text) emitNatural("thinking", text);
    if (onToolCall) onToolCall("thinking", "");
    return { handled: true, hadError: false };
  }
  if (itemType === "command_execution" || itemType.includes("tool_call") || itemType.includes("tool")) {
    const command = codexCommandText(event);
    const status = String(event?.item?.status || event?.status || baseKind || "").toLowerCase();
    const exitCode = event?.item?.exit_code ?? event?.exit_code;
    const name = command || extractCodexToolName(event) || itemType || kind;
    if (onToolCall) onToolCall(itemType || kind, name);
    if (baseLower.includes("started") || status === "in_progress") {
      emitStatus(`Codex command started: ${truncateComposerLine(name)}`);
    } else if (baseLower.includes("completed") || status === "completed" || status === "failed") {
      const suffix = exitCode == null ? "" : ` exit ${exitCode}`;
      emitStatus(`Codex command ${status === "failed" || exitCode ? "finished" : "completed"}:${suffix} ${truncateComposerLine(name)}`);
    } else {
      emitStatus(`Codex ${truncateComposerLine(name)}`);
    }
    return { handled: true, hadError: false };
  }

  if (text && (lower.includes("message") || lower.includes("response") || lower.includes("delta") || lower === "assistant")) {
    emitNatural("assistant", text);
    return { handled: true, hadError: false };
  }
  if (text && lower.includes("reason")) {
    emitNatural("thinking", text);
    if (onToolCall) onToolCall("thinking", "");
    return { handled: true, hadError: false };
  }
  if (lower.includes("tool") || lower.includes("exec") || lower.includes("command")) {
    const toolName = extractCodexToolName(event) || kind;
    if (onToolCall) onToolCall(kind, toolName);
    emitStatus(`Codex ${toolName}`);
    return { handled: true, hadError: false };
  }
  if (lower.includes("error") || event?.is_error) {
    const msg = text || event?.message || event?.error || kind;
    emitStatus(truncateComposerLine(String(msg)));
    return { handled: true, hadError: !isNonFatalCodexErrorMessage(msg) };
  }
  if (baseLower === "thread.started" || baseLower === "turn.started" || baseLower === "turn.completed") {
    return { handled: true, hadError: false };
  }
  return { handled: false, hadError: false };
}

function codexFailureMessage(code, stderrTail, { flowName = "", uuid = "" } = {}) {
  const tail = String(stderrTail || "").trim();
  const lower = tail.toLowerCase();
  const hints = [];
  if (lower.includes("login") || lower.includes("auth") || lower.includes("authentication") || lower.includes("not logged")) {
    hints.push("Codex 可能未登录，请先执行 `codex login`。");
  }
  if (lower.includes("model") && (lower.includes("not found") || lower.includes("unknown") || lower.includes("invalid"))) {
    hints.push("Codex 模型可能不可用，请检查 `codex:<model>` 或刷新模型列表。");
  }
  if (lower.includes("mcp") || lower.includes("config") || lower.includes("invalid transport")) {
    hints.push("Codex MCP/配置加载失败，请检查 MCP 名称、URL、command/env 配置。");
  }
  if (lower.includes("network") || lower.includes("timeout") || lower.includes("connection")) {
    hints.push("Codex 网络连接失败，请检查代理或网络环境。");
  }
  if (flowName && uuid) {
    hints.push("完整 stderr 可在 run 日志中查看；需要直接透传 stderr 可设置 `AGENTFLOW_CODEX_STDERR_INHERIT=1` 后重跑。");
  }
  const suffix = hints.length ? ` ${hints.join(" ")}` : "";
  return `Codex CLI exited ${code}. ${tail || "No result event received."}${suffix}`;
}

/**
 * Run Cursor CLI with stream-json, forward events to stdout, return success/failure.
 */
export function runCursorAgentForNode(
  workspaceRoot,
  { promptPath, nodeContext, taskBody, intermediatePath, resultPathRel, subagent, instanceId },
  options = {},
) {
  const absPromptPath = path.resolve(workspaceRoot, promptPath);
  const absRunDir = path.resolve(workspaceRoot, intermediatePath);
  const absResultPath = path.join(absRunDir, resultPathRel);
  const nodeIntermediateDir = path.dirname(absPromptPath);
  const outputDir = instanceId ? path.join(absRunDir, "output", instanceId) : path.join(absRunDir, "output");
  if (instanceId) fs.mkdirSync(outputDir, { recursive: true });
  const absWorkspaceRoot = path.resolve(workspaceRoot);
  const execWorkspaceRoot = path.resolve(options.execWorkspaceRoot || workspaceRoot);
  const replacements = {
    workspaceRoot: execWorkspaceRoot,
    executionWorkspaceRoot: execWorkspaceRoot,
    pipelineWorkspace: absWorkspaceRoot,
    promptPath: absPromptPath,
    nodeContext: nodeContext ?? "",
    taskBody: taskBody ?? "",
    resultPath: absResultPath,
    intermediatePath: path.join(absRunDir, "intermediate"),
    outputDir,
    flowName: options.flowName ?? "",
    uuid: options.uuid ?? "",
    instanceId: instanceId ?? "",
  };
  const agentContent = loadAgentPromptWithReplacements(workspaceRoot, subagent, replacements);
  let agentPathForPrompt = getAgentPath(workspaceRoot, subagent);
  if (agentContent) {
    const resolvedAgentPath = path.join(nodeIntermediateDir, `agent-${subagent}.md`);
    fs.mkdirSync(nodeIntermediateDir, { recursive: true });
    fs.writeFileSync(resolvedAgentPath, agentContent, "utf8");
    agentPathForPrompt = resolvedAgentPath;
  }
  const rawAgentContent =
    agentContent != null
      ? agentContent
      : fs.existsSync(agentPathForPrompt)
        ? fs.readFileSync(agentPathForPrompt, "utf8")
        : "";
  const promptText = stripYamlFrontmatter(rawAgentContent);

  const modelRaw = options.model ?? process.env.CURSOR_AGENT_MODEL ?? null;
  const model = normalizeCursorModelForCli(modelRaw);
  const rawPrefix = options.outputPrefix != null ? `[${options.outputPrefix}] ` : "";
  const coloredPrefix = rawPrefix && options.prefixColor ? options.prefixColor(rawPrefix) : rawPrefix;
  const agentContentColor = options.contentColor ?? ((line) => chalk.gray(line));

  return new Promise((resolve, reject) => {
    const agentCmd = process.env.CURSOR_AGENT_CMD || "agent";
    const args = ["--print", "--output-format", "stream-json", "--trust", "--workspace", execWorkspaceRoot];
    const approveMcps = process.env.AGENTFLOW_CURSOR_APPROVE_MCPS !== "0" && process.env.AGENTFLOW_CURSOR_APPROVE_MCPS !== "false";
    if (approveMcps) args.push("--approve-mcps");
    if (options.force) args.push("--force");
    if (shouldPassCursorModelArg(model)) args.push("--model", model);
    args.push(promptText);
    if (options.flowName && options.uuid) {
      const argvLog = args.slice(0, -1).concat([`(prompt ${args[args.length - 1].length} chars)`]);
      appendRunLogLine(workspaceRoot, options.flowName, options.uuid, "cli-raw", `Cursor CLI 完整参数: ${agentCmd} ${JSON.stringify(argvLog)}`);
      appendRunLogLine(
        workspaceRoot,
        options.flowName,
        options.uuid,
        "cli-raw",
        `Cursor CLI prompt 前 800 字:\n${promptText.slice(0, 800)}${promptText.length > 800 ? "..." : ""}`,
      );
      appendRunLogLine(workspaceRoot, options.flowName, options.uuid, "cli-raw", `Cursor CLI prompt 完整:\n${promptText}`);
    }
    const useStderrInherit = process.env.AGENTFLOW_CURSOR_STDERR_INHERIT === "1" || process.env.AGENTFLOW_CURSOR_STDERR_INHERIT === "true";
    const child = spawn(agentCmd, args, {
      cwd: execWorkspaceRoot,
      stdio: ["ignore", "pipe", useStderrInherit ? "inherit" : "pipe"],
      shell: false,
      env: childEnv(options),
    });

    let lastResult = null;
    let hadError = false;
    const assistantTextChunks = [];
    const STDERR_CAP_BYTES = 1024 * 1024;
    const stderrChunks = [];
    let stderrTotalBytes = 0;
    const stderrBuffer = options.stderrBuffer || null;
    let stderrLineBuffer = "";
    const flowName = options.flowName ?? null;
    const uuid = options.uuid ?? null;

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

    const STDOUT_RAW_CAP = 200;
    const debugStdout = process.env.AGENTFLOW_DEBUG_STDOUT === "1" || process.env.AGENTFLOW_DEBUG_STDOUT === "true";

    function isLikelyBase64(s) {
      if (!s || typeof s !== "string") return false;
      const t = s.trim();
      if (t.startsWith("data:image/") && t.includes(";base64,")) return true;
      if (t.length < 80) return false;
      return /^[A-Za-z0-9+/]+=*$/.test(t);
    }

    child.stdout.setEncoding("utf-8");
    let stdoutLineBuffer = "";
    child.stdout.on("data", (chunk) => {
      stdoutLineBuffer += chunk;
      const idx = stdoutLineBuffer.lastIndexOf("\n");
      const complete = idx >= 0 ? stdoutLineBuffer.slice(0, idx) : "";
      if (idx >= 0) stdoutLineBuffer = stdoutLineBuffer.slice(idx + 1);
      const lines = complete.split("\n").filter(Boolean);
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
              assistantTextChunks.push(text);
              const out = mdStreamer.push(text);
              if (out) writeStdout(out);
            }
          } else if (event.type === "tool_call") {
            const toolName =
              event.tool_call && typeof event.tool_call === "object" ? Object.keys(event.tool_call)[0] ?? "?" : "?";
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
              const ev = JSON.parse(line);
              if (ev && ev.type === "tool_call") subtype = ev.subtype ?? "?";
            } catch {
              const m = line.match(/"subtype"\s*:\s*"([^"]+)"/);
              if (m) subtype = m[1];
            }
            out = `[cursor] tool_call ${subtype}\n`;
          } else if (isLikelyBase64(line)) {
            out = `[cursor-stdout] (base64 图片/数据, ${line.length} 字符)\n`;
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
      if (stdoutLineBuffer.trim() && flowName && uuid) {
        appendRunLogLine(workspaceRoot, flowName, uuid, "cursor-stdout-raw", stdoutLineBuffer.trim());
      }
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
        const autoOnly =
          /named models unavailable/i.test(stderrTail) ||
          (/free plans?/i.test(stderrTail) && /only use auto/i.test(stderrTail)) ||
          /only use auto/i.test(stderrTail);
        if (autoOnly && model !== "Auto" && !options._agentflowAutoRetry) {
          writeStdout(t("runner.cursor_account_limit") + "\n");
          runCursorAgentForNode(
            workspaceRoot,
            { promptPath, nodeContext, taskBody, intermediatePath, resultPathRel, subagent, instanceId },
            { ...options, model: "Auto", _agentflowAutoRetry: true },
          ).then(resolve).catch(reject);
          return;
        }
        const logHint =
          flowName && uuid
            ? ` 检查 run 目录 logs/log.txt 查看完整 Cursor stderr；常见原因：未登录 Cursor、模型不可用、网络/权限。若无报错内容，可设置 AGENTFLOW_CURSOR_STDERR_INHERIT=1 后重跑，使 Cursor 的 stderr 直接输出到终端。`
            : "";
        const err = new Error(`Cursor CLI exited ${code}. ${stderrTail || "No result event received."}${logHint}`);
        err.cursorStderrTail = stderrTail;
        reject(err);
        return;
      }
      if (hadError || (lastResult && lastResult.is_error)) {
        reject(new Error(lastResult?.result || "Agent reported error."));
        return;
      }
      writeAgentTextArtifacts(absResultPath, absRunDir, instanceId, assistantTextChunks.join("") || lastResult?.result || "");
      resolve();
    });
  });
}

/**
 * Run OpenCode CLI in non-interactive mode for a node.
 */
export function runOpenCodeAgentForNode(
  workspaceRoot,
  { promptPath, nodeContext, taskBody, intermediatePath, resultPathRel, subagent, instanceId },
  options = {},
) {
  const absPromptPath = path.resolve(workspaceRoot, promptPath);
  const absRunDir = path.resolve(workspaceRoot, intermediatePath);
  const absResultPath = path.join(absRunDir, resultPathRel);
  const nodeIntermediateDir = path.dirname(absPromptPath);
  const outputDir = instanceId ? path.join(absRunDir, "output", instanceId) : path.join(absRunDir, "output");
  if (instanceId) fs.mkdirSync(outputDir, { recursive: true });
  const absWorkspaceRoot = path.resolve(workspaceRoot);
  const execWorkspaceRoot = path.resolve(options.execWorkspaceRoot || workspaceRoot);
  const replacements = {
    workspaceRoot: execWorkspaceRoot,
    executionWorkspaceRoot: execWorkspaceRoot,
    pipelineWorkspace: absWorkspaceRoot,
    promptPath: absPromptPath,
    nodeContext: nodeContext ?? "",
    taskBody: taskBody ?? "",
    resultPath: absResultPath,
    intermediatePath: path.join(absRunDir, "intermediate"),
    outputDir,
    flowName: options.flowName ?? "",
    uuid: options.uuid ?? "",
    instanceId: instanceId ?? "",
  };
  const agentContent = loadAgentPromptWithReplacements(workspaceRoot, subagent, replacements);
  let agentPathForPrompt = getAgentPath(workspaceRoot, subagent);
  if (agentContent) {
    const resolvedAgentPath = path.join(nodeIntermediateDir, `agent-${subagent}.md`);
    fs.mkdirSync(nodeIntermediateDir, { recursive: true });
    fs.writeFileSync(resolvedAgentPath, agentContent, "utf8");
    agentPathForPrompt = resolvedAgentPath;
  }
  const rawAgentContent =
    agentContent != null
      ? agentContent
      : fs.existsSync(agentPathForPrompt)
        ? fs.readFileSync(agentPathForPrompt, "utf8")
        : "";
  const promptText = stripYamlFrontmatter(rawAgentContent);

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
    args.push("--dir", execWorkspaceRoot);
    args.push("--", promptText);
    const spawnOpts = {
      cwd: execWorkspaceRoot,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
      env: childEnv(options),
    };
    if (options.force) {
      spawnOpts.env = {
        ...spawnOpts.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify({
          permission: { external_directory: "allow" },
        }),
      };
    }
    const child = spawn(opencodeCmd, args, spawnOpts);
    const flowName = options.flowName ?? null;
    const uuid = options.uuid ?? null;

    let stdoutLogBuf = "";
    let stderrLogBuf = "";
    let stdoutCaptured = "";

    function drainLogBuf(buf, tag) {
      let idx;
      while ((idx = buf.indexOf("\n")) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        const line = stripAnsi(raw).trimEnd();
        if (line.trim() && flowName && uuid) {
          appendRunLogLine(workspaceRoot, flowName, uuid, tag, line);
        }
      }
      return buf;
    }

    function flushLogBuf(buf, tag) {
      if (!buf) return;
      const line = stripAnsi(buf).trimEnd();
      if (line.trim() && flowName && uuid) {
        appendRunLogLine(workspaceRoot, flowName, uuid, tag, line);
      }
    }

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      if (coloredPrefix) writeWithPrefix(process.stdout, chunk, coloredPrefix, agentContentColor);
      else process.stdout.write(agentContentColor(chunk));
      const normalizedChunk = String(chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      stdoutCaptured += normalizedChunk;
      stdoutLogBuf += normalizedChunk;
      stdoutLogBuf = drainLogBuf(stdoutLogBuf, "opencode-stdout");
    });

    child.stderr.on("data", (chunk) => {
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
      if (coloredPrefix) {
        writeWithPrefix(process.stderr, s, coloredPrefix, agentContentColor);
      } else {
        process.stderr.write(chunk);
      }
      stderrLogBuf += s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
      stderrLogBuf = drainLogBuf(stderrLogBuf, "opencode-stderr");
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
      flushLogBuf(stdoutLogBuf, "opencode-stdout");
      flushLogBuf(stderrLogBuf, "opencode-stderr");
      if (code !== 0) {
        reject(new Error(`OpenCode CLI exited ${code}.`));
        return;
      }
      writeAgentTextArtifacts(absResultPath, absRunDir, instanceId, stripAnsi(stdoutCaptured));
      resolve();
    });
  });
}

/**
 * Run Claude Code CLI (`claude`) in non-interactive stream-json mode for a node.
 * NDJSON event schema: system(init) / assistant(message.content[]) / user(tool_result) / result.
 * Thinking and text both live as content blocks inside assistant events (not as top-level events).
 */
export function runClaudeCodeAgentForNode(
  workspaceRoot,
  { promptPath, nodeContext, taskBody, intermediatePath, resultPathRel, subagent, instanceId },
  options = {},
) {
  const absPromptPath = path.resolve(workspaceRoot, promptPath);
  const absRunDir = path.resolve(workspaceRoot, intermediatePath);
  const absResultPath = path.join(absRunDir, resultPathRel);
  const nodeIntermediateDir = path.dirname(absPromptPath);
  const outputDir = instanceId ? path.join(absRunDir, "output", instanceId) : path.join(absRunDir, "output");
  if (instanceId) fs.mkdirSync(outputDir, { recursive: true });
  const absWorkspaceRoot = path.resolve(workspaceRoot);
  const execWorkspaceRoot = path.resolve(options.execWorkspaceRoot || workspaceRoot);
  const replacements = {
    workspaceRoot: execWorkspaceRoot,
    executionWorkspaceRoot: execWorkspaceRoot,
    pipelineWorkspace: absWorkspaceRoot,
    promptPath: absPromptPath,
    nodeContext: nodeContext ?? "",
    taskBody: taskBody ?? "",
    resultPath: absResultPath,
    intermediatePath: path.join(absRunDir, "intermediate"),
    outputDir,
    flowName: options.flowName ?? "",
    uuid: options.uuid ?? "",
    instanceId: instanceId ?? "",
  };
  const agentContent = loadAgentPromptWithReplacements(workspaceRoot, subagent, replacements);
  let agentPathForPrompt = getAgentPath(workspaceRoot, subagent);
  if (agentContent) {
    const resolvedAgentPath = path.join(nodeIntermediateDir, `agent-${subagent}.md`);
    fs.mkdirSync(nodeIntermediateDir, { recursive: true });
    fs.writeFileSync(resolvedAgentPath, agentContent, "utf8");
    agentPathForPrompt = resolvedAgentPath;
  }
  const rawAgentContent =
    agentContent != null
      ? agentContent
      : fs.existsSync(agentPathForPrompt)
        ? fs.readFileSync(agentPathForPrompt, "utf8")
        : "";
  const promptText = stripYamlFrontmatter(rawAgentContent);

  const model = options.model && String(options.model).trim();
  const rawPrefix = options.outputPrefix != null ? `[${options.outputPrefix}] ` : "";
  const coloredPrefix = rawPrefix && options.prefixColor ? options.prefixColor(rawPrefix) : rawPrefix;
  const agentContentColor = options.contentColor ?? ((line) => chalk.gray(line));

  return new Promise((resolve, reject) => {
    const claudeCmd = process.env.CLAUDE_CODE_CMD || "claude";
    const bypassPermissions =
      process.env.AGENTFLOW_CLAUDE_CODE_BYPASS_PERMISSIONS !== "0" &&
      process.env.AGENTFLOW_CLAUDE_CODE_BYPASS_PERMISSIONS !== "false";
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--add-dir", execWorkspaceRoot, "--add-dir", absWorkspaceRoot];
    if (bypassPermissions) args.push("--dangerously-skip-permissions");
    if (model) args.push("--model", model);
    args.push(promptText);
    if (options.flowName && options.uuid) {
      const argvLog = args.slice(0, -1).concat([`(prompt ${args[args.length - 1].length} chars)`]);
      appendRunLogLine(
        workspaceRoot,
        options.flowName,
        options.uuid,
        "cli-raw",
        `Claude Code CLI 完整参数: ${claudeCmd} ${JSON.stringify(argvLog)}`,
      );
      appendRunLogLine(
        workspaceRoot,
        options.flowName,
        options.uuid,
        "cli-raw",
        `Claude Code CLI prompt 前 800 字:\n${promptText.slice(0, 800)}${promptText.length > 800 ? "..." : ""}`,
      );
      appendRunLogLine(workspaceRoot, options.flowName, options.uuid, "cli-raw", `Claude Code CLI prompt 完整:\n${promptText}`);
    }
    const useStderrInherit =
      process.env.AGENTFLOW_CLAUDE_CODE_STDERR_INHERIT === "1" ||
      process.env.AGENTFLOW_CLAUDE_CODE_STDERR_INHERIT === "true";
    const child = spawn(claudeCmd, args, {
      cwd: execWorkspaceRoot,
      stdio: ["ignore", "pipe", useStderrInherit ? "inherit" : "pipe"],
      shell: false,
      env: childEnv(options),
    });

    let lastResult = null;
    let hadError = false;
    let sessionId = null;
    const assistantTextChunks = [];
    const STDERR_CAP_BYTES = 1024 * 1024;
    const stderrChunks = [];
    let stderrTotalBytes = 0;
    const stderrBuffer = options.stderrBuffer || null;
    let stderrLineBuffer = "";
    const flowName = options.flowName ?? null;
    const uuid = options.uuid ?? null;

    const outStream = machineReadable ? process.stderr : process.stdout;
    function writeStdout(text) {
      if (coloredPrefix) writeWithPrefix(outStream, text, coloredPrefix, agentContentColor);
      else if (text) outStream.write(agentContentColor(text));
      if (text && flowName && uuid) appendRunLogLine(workspaceRoot, flowName, uuid, "claude-code-stdout", text);
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
        if (flowName && uuid) appendRunLogLine(workspaceRoot, flowName, uuid, "claude-code-stderr", s);
      });
    }

    const stdoutWidth = process.stdout.columns ?? 80;
    const mdStreamer = createMarkdownStreamer({
      render: (md) => renderMarkdown(md, { width: stdoutWidth }),
      spacing: "single",
    });

    child.stdout.setEncoding("utf-8");
    let stdoutLineBuffer = "";
    child.stdout.on("data", (chunk) => {
      stdoutLineBuffer += chunk;
      const idx = stdoutLineBuffer.lastIndexOf("\n");
      const complete = idx >= 0 ? stdoutLineBuffer.slice(0, idx) : "";
      if (idx >= 0) stdoutLineBuffer = stdoutLineBuffer.slice(idx + 1);
      const lines = complete.split("\n").filter(Boolean);
      for (const line of lines) {
        if (flowName && uuid) appendRunLogLine(workspaceRoot, flowName, uuid, "claude-code-stdout-raw", line);
        try {
          const event = JSON.parse(line);
          if (event && typeof event === "object" && event.session_id && !sessionId) {
            sessionId = event.session_id;
          }
          if (event.type === "system") {
            // init 等元事件，仅记录
          } else if (event.type === "assistant" && event.message && Array.isArray(event.message.content)) {
            for (const block of event.message.content) {
              if (!block || typeof block !== "object") continue;
              if (block.type === "text" && block.text) {
                const text = normalizeStreamTextChunk(block.text);
                assistantTextChunks.push(text);
                const out = mdStreamer.push(text);
                if (out) writeStdout(out);
              } else if (block.type === "thinking") {
                if (options.onToolCall) options.onToolCall("thinking", "");
              } else if (block.type === "tool_use") {
                const toolName = block.name || "?";
                if (options.onToolCall) options.onToolCall("tool_use", toolName);
                writeStdout(`[claude-code] tool ${toolName}\n`);
              }
            }
          } else if (event.type === "user" && event.message && Array.isArray(event.message.content)) {
            // tool_result 回传；不向用户 stdout 渲染，只记录
          } else if (event.type === "result") {
            lastResult = event;
            const isSuccess = event.subtype === "success" && !event.is_error;
            hadError = !isSuccess;
          } else {
            writeStdout(`[claude-code-stdout] event: ${event.type ?? "unknown"}\n`);
          }
        } catch (_) {
          writeStdout(`[claude-code-stdout] (非 JSON) ${line.slice(0, 500)}${line.length > 500 ? "..." : ""}\n`);
        }
      }
    });

    child.on("error", (err) => {
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.removeAllListeners();
      reject(
        new Error(
          `Claude Code CLI failed to start: ${err.message}. Install via 'npm i -g @anthropic-ai/claude-code' and run 'claude /login', or set CLAUDE_CODE_CMD.`,
        ),
      );
    });

    child.on("close", (code) => {
      if (stdoutLineBuffer.trim() && flowName && uuid) {
        appendRunLogLine(workspaceRoot, flowName, uuid, "claude-code-stdout-raw", stdoutLineBuffer.trim());
      }
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
        const logHint =
          flowName && uuid
            ? ` 检查 run 目录 logs/log.txt 查看完整 Claude Code stderr；常见原因：未登录 claude /login、模型不可用、网络/权限。若无报错内容，可设置 AGENTFLOW_CLAUDE_CODE_STDERR_INHERIT=1 后重跑。`
            : "";
        const err = new Error(`Claude Code CLI exited ${code}. ${stderrTail || "No result event received."}${logHint}`);
        err.claudeCodeStderrTail = stderrTail;
        reject(err);
        return;
      }
      if (hadError || (lastResult && lastResult.is_error)) {
        const msg =
          (lastResult && typeof lastResult.result === "string" && lastResult.result) ||
          (lastResult && lastResult.subtype) ||
          "Agent reported error.";
        reject(new Error(String(msg)));
        return;
      }
      writeAgentTextArtifacts(absResultPath, absRunDir, instanceId, assistantTextChunks.join("") || lastResult?.result || "");
      resolve();
    });
  });
}

/**
 * Run Codex CLI (`codex exec`) in non-interactive JSONL mode for a node.
 */
export function runCodexAgentForNode(
  workspaceRoot,
  { promptPath, nodeContext, taskBody, intermediatePath, resultPathRel, subagent, instanceId },
  options = {},
) {
  const absPromptPath = path.resolve(workspaceRoot, promptPath);
  const absRunDir = path.resolve(workspaceRoot, intermediatePath);
  const absResultPath = path.join(absRunDir, resultPathRel);
  const nodeIntermediateDir = path.dirname(absPromptPath);
  const outputDir = instanceId ? path.join(absRunDir, "output", instanceId) : path.join(absRunDir, "output");
  if (instanceId) fs.mkdirSync(outputDir, { recursive: true });
  const absWorkspaceRoot = path.resolve(workspaceRoot);
  const execWorkspaceRoot = path.resolve(options.execWorkspaceRoot || workspaceRoot);
  const replacements = {
    workspaceRoot: execWorkspaceRoot,
    executionWorkspaceRoot: execWorkspaceRoot,
    pipelineWorkspace: absWorkspaceRoot,
    promptPath: absPromptPath,
    nodeContext: nodeContext ?? "",
    taskBody: taskBody ?? "",
    resultPath: absResultPath,
    intermediatePath: path.join(absRunDir, "intermediate"),
    outputDir,
    flowName: options.flowName ?? "",
    uuid: options.uuid ?? "",
    instanceId: instanceId ?? "",
  };
  const agentContent = loadAgentPromptWithReplacements(workspaceRoot, subagent, replacements);
  let agentPathForPrompt = getAgentPath(workspaceRoot, subagent);
  if (agentContent) {
    const resolvedAgentPath = path.join(nodeIntermediateDir, `agent-${subagent}.md`);
    fs.mkdirSync(nodeIntermediateDir, { recursive: true });
    fs.writeFileSync(resolvedAgentPath, agentContent, "utf8");
    agentPathForPrompt = resolvedAgentPath;
  }
  const rawAgentContent =
    agentContent != null
      ? agentContent
      : fs.existsSync(agentPathForPrompt)
        ? fs.readFileSync(agentPathForPrompt, "utf8")
        : "";
  const promptText = stripYamlFrontmatter(rawAgentContent);

  const model = cleanModel(options.model, "CODEX_MODEL");
  const rawPrefix = options.outputPrefix != null ? `[${options.outputPrefix}] ` : "";
  const coloredPrefix = rawPrefix && options.prefixColor ? options.prefixColor(rawPrefix) : rawPrefix;
  const agentContentColor = options.contentColor ?? ((line) => chalk.gray(line));

  return new Promise((resolve, reject) => {
    const codexCmd = process.env.CODEX_CMD || "codex";
    fs.mkdirSync(nodeIntermediateDir, { recursive: true });
    const outputLastMessagePath = path.join(nodeIntermediateDir, "codex-last-message.txt");
    const args = buildCodexExecArgs({
      workspace: execWorkspaceRoot,
      addDirs: [absWorkspaceRoot],
      model,
      outputLastMessagePath,
      promptText,
      configArgs: options.codexConfigArgs,
    });
    if (options.flowName && options.uuid) {
      const argvLog = args.slice(0, -1).concat([`(prompt ${args[args.length - 1].length} chars)`]);
      appendRunLogLine(
        workspaceRoot,
        options.flowName,
        options.uuid,
        "cli-raw",
        `Codex CLI 完整参数: ${codexCmd} ${JSON.stringify(argvLog)}`,
      );
      appendRunLogLine(
        workspaceRoot,
        options.flowName,
        options.uuid,
        "cli-raw",
        `Codex CLI prompt 前 800 字:\n${promptText.slice(0, 800)}${promptText.length > 800 ? "..." : ""}`,
      );
      appendRunLogLine(workspaceRoot, options.flowName, options.uuid, "cli-raw", `Codex CLI prompt 完整:\n${promptText}`);
    }

    const useStderrInherit =
      process.env.AGENTFLOW_CODEX_STDERR_INHERIT === "1" ||
      process.env.AGENTFLOW_CODEX_STDERR_INHERIT === "true";
    const child = spawn(codexCmd, args, {
      cwd: execWorkspaceRoot,
      stdio: ["ignore", "pipe", useStderrInherit ? "inherit" : "pipe"],
      shell: false,
      env: childEnv(options),
    });

    let hadError = false;
    const assistantTextChunks = [];
    const STDERR_CAP_BYTES = 1024 * 1024;
    const stderrChunks = [];
    let stderrTotalBytes = 0;
    const stderrBuffer = options.stderrBuffer || null;
    let stderrLineBuffer = "";
    const flowName = options.flowName ?? null;
    const uuid = options.uuid ?? null;

    const outStream = machineReadable ? process.stderr : process.stdout;
    function writeStdout(text) {
      if (coloredPrefix) writeWithPrefix(outStream, text, coloredPrefix, agentContentColor);
      else if (text) outStream.write(agentContentColor(text));
      if (text && flowName && uuid) appendRunLogLine(workspaceRoot, flowName, uuid, "codex-stdout", text);
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
        if (flowName && uuid) appendRunLogLine(workspaceRoot, flowName, uuid, "codex-stderr", s);
      });
    }

    const stdoutWidth = process.stdout.columns ?? 80;
    const mdStreamer = createMarkdownStreamer({
      render: (md) => renderMarkdown(md, { width: stdoutWidth }),
      spacing: "single",
    });

    function emitNatural(_kind, text) {
      assistantTextChunks.push(text);
      const out = mdStreamer.push(text);
      if (out) writeStdout(out);
    }

    function emitStatus(line) {
      if (line) writeStdout(`[codex] ${line}\n`);
    }

    child.stdout.setEncoding("utf-8");
    let stdoutLineBuffer = "";
    child.stdout.on("data", (chunk) => {
      stdoutLineBuffer += chunk;
      const idx = stdoutLineBuffer.lastIndexOf("\n");
      const complete = idx >= 0 ? stdoutLineBuffer.slice(0, idx) : "";
      if (idx >= 0) stdoutLineBuffer = stdoutLineBuffer.slice(idx + 1);
      const lines = complete.split("\n").filter(Boolean);
      for (const line of lines) {
        if (flowName && uuid) appendRunLogLine(workspaceRoot, flowName, uuid, "codex-stdout-raw", line);
        try {
          const event = JSON.parse(line);
          const result = handleCodexEvent(event, { emitNatural, emitStatus, onToolCall: options.onToolCall });
          if (result.hadError) hadError = true;
          if (!result.handled) writeStdout(`[codex-stdout] event: ${codexEventKind(event)}\n`);
        } catch (_) {
          writeStdout(`[codex-stdout] (非 JSON) ${line.slice(0, 500)}${line.length > 500 ? "..." : ""}\n`);
        }
      }
    });

    child.on("error", (err) => {
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.removeAllListeners();
      reject(new Error(`Codex CLI failed to start: ${err.message}. Ensure '${codexCmd}' is in PATH and run 'codex login'.`));
    });

    child.on("close", (code) => {
      if (stdoutLineBuffer.trim() && flowName && uuid) {
        appendRunLogLine(workspaceRoot, flowName, uuid, "codex-stdout-raw", stdoutLineBuffer.trim());
      }
      child.stdout.removeAllListeners();
      if (!useStderrInherit) child.stderr.removeAllListeners();
      child.removeAllListeners();
      const tail = mdStreamer.finish();
      if (tail) writeStdout(tail);
      if (coloredPrefix && stderrLineBuffer) {
        writeWithPrefix(process.stderr, stderrLineBuffer.endsWith("\n") ? stderrLineBuffer : stderrLineBuffer + "\n", coloredPrefix);
      }
      const finalMessage = fs.existsSync(outputLastMessagePath)
        ? fs.readFileSync(outputLastMessagePath, "utf-8").trim()
        : assistantTextChunks.join("").trim();
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf-8");
        const stderrTail = stderr ? stderr.trim().slice(-1200) : "";
        const err = new Error(codexFailureMessage(code, stderrTail, { flowName, uuid }));
        err.codexStderrTail = stderrTail;
        reject(err);
        return;
      }
      if (hadError) {
        reject(new Error(finalMessage || "Codex reported error."));
        return;
      }
      writeAgentTextArtifacts(absResultPath, absRunDir, instanceId, finalMessage || assistantTextChunks.join(""));
      resolve();
    });
  });
}

const COMPOSER_STATUS_MAX = 200;

/**
 * 去除 ANSI escape（颜色/光标控制 / OSC / 私有序列）。OpenCode `run` 模式 stdout 走 TUI 渲染，
 * 含大量 \x1b[...m / \x1b]...BEL 类序列。Cursor/OpenCode 的 stderr 也常带这些。
 */
const ANSI_ESCAPE_RE = /[\u001B\u009B][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[a-zA-Z\d]*)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PRZcf-ntqry=><~]))/g;

function stripAnsi(s) {
  return String(s || "").replace(ANSI_ESCAPE_RE, "");
}

function truncateComposerLine(s) {
  const t = stripAnsi(s).replace(/\s+/g, " ").trim();
  if (t.length <= COMPOSER_STATUS_MAX) return t;
  return t.slice(0, COMPOSER_STATUS_MAX - 1) + "…";
}

const RAW_TRACE_MAX_CHARS = 4096;

function rawTraceText(value) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > RAW_TRACE_MAX_CHARS ? text.slice(0, RAW_TRACE_MAX_CHARS) + "\n...[truncated]" : text;
}

function normalizeStreamTextChunk(t) {
  if (!t || typeof t !== "string") return "";
  return t.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}

/** Cursor stream-json：从 message.content 等提取可展示正文（不含 JSON 包装） */
function extractCursorStreamNlText(event) {
  if (!event || typeof event !== "object") return "";
  const content = event.message?.content;
  if (Array.isArray(content)) {
    const parts = content
      .filter((c) => c && (c.type === "text" || c.type === "thinking") && c.text)
      .map((c) => c.text);
    if (parts.length) return normalizeStreamTextChunk(parts.join(""));
  }
  if (typeof event.text === "string" && event.text.trim()) return normalizeStreamTextChunk(event.text);
  if (typeof event.thinking === "string" && event.thinking.trim()) return normalizeStreamTextChunk(event.thinking);
  if (typeof event.delta === "string" && event.delta.trim()) return normalizeStreamTextChunk(event.delta);
  return "";
}

/** result 事件中仅推送可读字符串，跳过 JSON 形态 */
function extractCursorResultNl(event) {
  if (!event || typeof event !== "object") return "";
  const r = event.result;
  if (typeof r !== "string" || !r.trim()) return "";
  const t = r.trim();
  if ((t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"))) {
    try {
      JSON.parse(t);
      return "";
    } catch {
      return normalizeStreamTextChunk(r);
    }
  }
  return normalizeStreamTextChunk(r);
}

function tryEmitOpenCodeLineAsNatural(line, emit) {
  const raw = String(line || "");
  // OpenCode run 模式输出 TUI 渲染（CR 覆盖 + ANSI 颜色），先清掉再判断
  const cleaned = stripAnsi(raw).replace(/\r/g, "").trim();
  if (!cleaned) return;
  try {
    const ev = JSON.parse(cleaned);
    if (ev && typeof ev === "object") {
      const ty = ev.type;
      if (ty === "thinking" || ty === "assistant") {
        const text = extractCursorStreamNlText(ev);
        if (text) emit({ type: "natural", kind: ty === "thinking" ? "thinking" : "assistant", text });
        return;
      }
      if (ty === "result") {
        const text = extractCursorResultNl(ev);
        if (text) emit({ type: "natural", kind: "result", text });
        return;
      }
    }
  } catch {
    /* 非 JSON，按正文行处理 */
  }
  if (cleaned.startsWith("{") || cleaned.startsWith("[")) return;
  emit({ type: "natural", kind: "assistant", text: cleaned });
}

/**
 * Cursor CLI：纯文本 prompt，供 Composer / UI 流式使用；不写 process stdout/stderr。
 * @returns {{ child: import('child_process').ChildProcess, finished: Promise<void> }}
 */
export function runCursorAgentWithPrompt(cliWorkspace, promptText, options = {}) {
  const onStreamEvent = typeof options.onStreamEvent === "function" ? options.onStreamEvent : null;
  const ws = path.resolve(cliWorkspace);
  const model = normalizeCursorModelForCli(options.model ?? process.env.CURSOR_AGENT_MODEL ?? null);
  const agentCmd = process.env.CURSOR_AGENT_CMD || "agent";
  // Web UI Composer 需要能无交互执行本机 curl 等命令来刷新画布。
  const args = ["--print", "--output-format", "stream-json", "--trust", "--sandbox", "disabled", "--workspace", ws];
  const approveMcps = process.env.AGENTFLOW_CURSOR_APPROVE_MCPS !== "0" && process.env.AGENTFLOW_CURSOR_APPROVE_MCPS !== "false";
  if (approveMcps) args.push("--approve-mcps");
  args.push("--force");
  if (shouldPassCursorModelArg(model)) args.push("--model", model);
  args.push(promptText);

  const useStderrInherit = process.env.AGENTFLOW_CURSOR_STDERR_INHERIT === "1" || process.env.AGENTFLOW_CURSOR_STDERR_INHERIT === "true";
  const child = spawn(agentCmd, args, {
    cwd: ws,
    stdio: ["ignore", "pipe", useStderrInherit ? "inherit" : "pipe"],
    shell: false,
    env: childEnv(options),
  });

  let lastResult = null;
  let hadError = false;
  const STDERR_CAP_BYTES = 1024 * 1024;
  const stderrChunks = [];
  let stderrTotalBytes = 0;
  let stderrComposerBuffer = "";

  const emit = (payload) => {
    try {
      onStreamEvent?.(payload);
    } catch (_) {}
  };

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
      stderrComposerBuffer += s;
      let idx;
      while ((idx = stderrComposerBuffer.indexOf("\n")) !== -1) {
        const line = stderrComposerBuffer.slice(0, idx);
        stderrComposerBuffer = stderrComposerBuffer.slice(idx + 1);
        if (line.trim()) {
          emit({ type: "status", line: `[stderr] ${truncateComposerLine(line)}` });
        }
      }
    });
  }

  const stdoutWidth = 80;
  const mdStreamer = createMarkdownStreamer({
    render: (md) => renderMarkdown(md, { width: stdoutWidth }),
    spacing: "single",
  });

  const STDOUT_RAW_CAP = 200;
  const debugStdout = process.env.AGENTFLOW_DEBUG_STDOUT === "1" || process.env.AGENTFLOW_DEBUG_STDOUT === "true";

  function isLikelyBase64(s) {
    if (!s || typeof s !== "string") return false;
    const t = s.trim();
    if (t.startsWith("data:image/") && t.includes(";base64,")) return true;
    if (t.length < 80) return false;
    return /^[A-Za-z0-9+/]+=*$/.test(t);
  }

  child.stdout.setEncoding("utf-8");
  let stdoutLineBuffer = "";
  child.stdout.on("data", (chunk) => {
    stdoutLineBuffer += chunk;
    const idx = stdoutLineBuffer.lastIndexOf("\n");
    const complete = idx >= 0 ? stdoutLineBuffer.slice(0, idx) : "";
    if (idx >= 0) stdoutLineBuffer = stdoutLineBuffer.slice(idx + 1);
    const lines = complete.split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        emit({ type: "raw", source: "cursor", stream: "stdout", eventType: event?.type || "unknown", text: rawTraceText(event) });
        if (event.type === "assistant" && event.message?.content) {
          const text = extractCursorStreamNlText(event);
          if (text) {
            emit({ type: "natural", kind: "assistant", text });
            mdStreamer.push(text);
            emit({ type: "status", line: t("runner.generating_reply") });
          }
        } else if (event.type === "tool_call") {
          const toolName =
            event.tool_call && typeof event.tool_call === "object" ? Object.keys(event.tool_call)[0] ?? "?" : "?";
          const subtype = event.subtype ?? "";
          const statusLine = `工具 ${toolName}${subtype ? ` (${subtype})` : ""}`;
          emit({ type: "status", line: statusLine });
          if (options.onToolCall) options.onToolCall(subtype, toolName);
        } else if (event.type === "thinking") {
          const thinkText = extractCursorStreamNlText(event);
          if (thinkText) emit({ type: "natural", kind: "thinking", text: thinkText });
          emit({ type: "status", line: t("runner.thinking") });
          if (options.onToolCall) options.onToolCall("thinking", "");
        } else if (event.type === "result") {
          lastResult = event;
          const resultNl = extractCursorResultNl(event);
          if (resultNl) emit({ type: "natural", kind: "result", text: resultNl });
          if (event.subtype === "success" && !event.is_error) {
            hadError = false;
            emit({ type: "status", line: t("runner.completed") });
          } else {
            hadError = true;
            const errNl = extractCursorResultNl(event);
            if (errNl) emit({ type: "natural", kind: "error", text: errNl });
            emit({
              type: "status",
              line: truncateComposerLine(String(event.result || t("runner.execution_failed"))),
            });
          }
        } else {
          emit({ type: "status", line: `${t("runner.event_label")}: ${event.type ?? "unknown"}` });
        }
      } catch (_) {
        emit({ type: "raw", source: "cursor", stream: "stdout", eventType: "line", text: rawTraceText(line) });
        if (line.includes('"type":"tool_call"') || line.includes('"type": "tool_call"')) {
          let subtype = "?";
          try {
            const ev = JSON.parse(line);
            if (ev && ev.type === "tool_call") subtype = ev.subtype ?? "?";
          } catch {
            const m = line.match(/"subtype"\s*:\s*"([^"]+)"/);
            if (m) subtype = m[1];
          }
          emit({ type: "status", line: t("runner.tool_call", { subtype }) });
        } else if (isLikelyBase64(line)) {
          emit({ type: "status", line: t("runner.base64_data", { len: line.length }) });
        } else if (debugStdout || line.length <= STDOUT_RAW_CAP) {
          emit({ type: "status", line: truncateComposerLine(line) });
        } else if (lastResult == null) {
          emit({
            type: "status",
            line: truncateComposerLine(t("runner.non_json_line", { preview: line.slice(0, 500) + (line.length > 500 ? "..." : "") })),
          });
        } else {
          emit({ type: "status", line: t("runner.unparsed_line", { len: line.length }) });
        }
      }
    }
  });

  const finished = new Promise((resolve, reject) => {
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
      mdStreamer.finish();
      if (!useStderrInherit && stderrComposerBuffer.trim()) {
        const rest = stderrComposerBuffer.trim();
        emit({ type: "status", line: `[stderr] ${truncateComposerLine(rest)}` });
      }
      if (code !== 0 && lastResult == null) {
        const stderr = Buffer.concat(stderrChunks).toString("utf-8");
        const stderrTail = stderr ? stderr.trim().slice(-1200) : "";
        const err = new Error(`Cursor CLI exited ${code}. ${stderrTail || "No result event received."}`);
        err.cursorStderrTail = stderrTail;
        emit({ type: "status", line: truncateComposerLine(err.message) });
        reject(err);
        return;
      }
      if (hadError || (lastResult && lastResult.is_error)) {
        const msg = lastResult?.result || "Agent reported error.";
        emit({ type: "status", line: truncateComposerLine(msg) });
        reject(new Error(msg));
        return;
      }
      resolve();
    });
  });

  return { child, finished };
}

/**
 * OpenCode CLI：纯文本 prompt，供 Composer / UI；不写 process stdout/stderr。
 * @returns {{ child: import('child_process').ChildProcess, finished: Promise<void> }}
 */
export function runOpenCodeAgentWithPrompt(cliWorkspace, promptText, options = {}) {
  const onStreamEvent = typeof options.onStreamEvent === "function" ? options.onStreamEvent : null;
  const ws = path.resolve(cliWorkspace);
  const model = options.model && String(options.model).trim();
  const opencodeCmd = process.env.OPENCODE_CMD || "opencode";
  const args = ["run"];
  if (model) args.push("--model", model);
  args.push("--dir", ws);
  args.push("--", promptText);

  const spawnOpts = {
    cwd: ws,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    env: childEnv(options),
  };
  if (options.force) {
    spawnOpts.env = {
      ...spawnOpts.env,
      OPENCODE_CONFIG_CONTENT: JSON.stringify({
        permission: { external_directory: "allow" },
      }),
    };
  }

  const child = spawn(opencodeCmd, args, spawnOpts);

  const emit = (payload) => {
    try {
      onStreamEvent?.(payload);
    } catch (_) {}
  };

  let outBuf = "";
  let errBuf = "";

  child.stdout.setEncoding("utf-8");
  child.stdout.on("data", (chunk) => {
    const s = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    outBuf += s;
    let idx;
    while ((idx = outBuf.indexOf("\n")) !== -1) {
      const line = outBuf.slice(0, idx);
      outBuf = outBuf.slice(idx + 1);
      if (line) {
        emit({ type: "raw", source: "opencode", stream: "stdout", eventType: "line", text: rawTraceText(line) });
        tryEmitOpenCodeLineAsNatural(line, emit);
        emit({ type: "status", line: `[stdout] ${truncateComposerLine(line)}` });
      }
    }
  });

  child.stderr.setEncoding("utf-8");
  child.stderr.on("data", (chunk) => {
    const s = typeof chunk === "string" ? chunk : chunk.toString("utf-8");
    errBuf += s;
    let idx;
    while ((idx = errBuf.indexOf("\n")) !== -1) {
      const line = errBuf.slice(0, idx);
      errBuf = errBuf.slice(idx + 1);
      if (line) {
        emit({ type: "raw", source: "opencode", stream: "stderr", eventType: "line", text: rawTraceText(line) });
        tryEmitOpenCodeLineAsNatural(line, emit);
        emit({ type: "status", line: `[stderr] ${truncateComposerLine(line)}` });
      }
    }
  });

  const finished = new Promise((resolve, reject) => {
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
      if (outBuf.trim()) {
        emit({ type: "raw", source: "opencode", stream: "stdout", eventType: "tail", text: rawTraceText(outBuf.trim()) });
        tryEmitOpenCodeLineAsNatural(outBuf.trim(), emit);
        emit({ type: "status", line: truncateComposerLine(outBuf.trim()) });
      }
      if (errBuf.trim()) {
        emit({ type: "raw", source: "opencode", stream: "stderr", eventType: "tail", text: rawTraceText(errBuf.trim()) });
        tryEmitOpenCodeLineAsNatural(errBuf.trim(), emit);
        emit({ type: "status", line: `[opencode_stderr] ${truncateComposerLine(errBuf.trim())}` });
      }
      if (code !== 0) {
        emit({ type: "status", line: t("runner.opencode_exit_code", { code }) });
        reject(new Error(`OpenCode CLI exited ${code}.`));
        return;
      }
      emit({ type: "status", line: t("runner.done") });
      resolve();
    });
  });

  return { child, finished };
}

/**
 * Claude Code CLI：纯文本 prompt，供 Composer / UI 流式使用；不写 process stdout/stderr。
 * @returns {{ child: import('child_process').ChildProcess, finished: Promise<void> }}
 */
export function runClaudeCodeAgentWithPrompt(cliWorkspace, promptText, options = {}) {
  const onStreamEvent = typeof options.onStreamEvent === "function" ? options.onStreamEvent : null;
  const ws = path.resolve(cliWorkspace);
  const model = options.model && String(options.model).trim();
  const claudeCmd = process.env.CLAUDE_CODE_CMD || "claude";
  const bypassPermissions =
    process.env.AGENTFLOW_CLAUDE_CODE_BYPASS_PERMISSIONS !== "0" &&
    process.env.AGENTFLOW_CLAUDE_CODE_BYPASS_PERMISSIONS !== "false";
  const args = ["-p", "--output-format", "stream-json", "--verbose", "--add-dir", ws];
  if (bypassPermissions) args.push("--dangerously-skip-permissions");
  if (model) args.push("--model", model);
  args.push(promptText);

  const useStderrInherit =
    process.env.AGENTFLOW_CLAUDE_CODE_STDERR_INHERIT === "1" ||
    process.env.AGENTFLOW_CLAUDE_CODE_STDERR_INHERIT === "true";
  const child = spawn(claudeCmd, args, {
    cwd: ws,
    stdio: ["ignore", "pipe", useStderrInherit ? "inherit" : "pipe"],
    shell: false,
    env: childEnv(options),
  });

  let lastResult = null;
  let hadError = false;
  const STDERR_CAP_BYTES = 1024 * 1024;
  const stderrChunks = [];
  let stderrTotalBytes = 0;
  let stderrComposerBuffer = "";

  const emit = (payload) => {
    try {
      onStreamEvent?.(payload);
    } catch (_) {}
  };

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
      stderrComposerBuffer += s;
      let idx;
      while ((idx = stderrComposerBuffer.indexOf("\n")) !== -1) {
        const line = stderrComposerBuffer.slice(0, idx);
        stderrComposerBuffer = stderrComposerBuffer.slice(idx + 1);
        if (line.trim()) {
          emit({ type: "status", line: `[stderr] ${truncateComposerLine(line)}` });
        }
      }
    });
  }

  const stdoutWidth = 80;
  const mdStreamer = createMarkdownStreamer({
    render: (md) => renderMarkdown(md, { width: stdoutWidth }),
    spacing: "single",
  });

  child.stdout.setEncoding("utf-8");
  let stdoutLineBuffer = "";
  child.stdout.on("data", (chunk) => {
    stdoutLineBuffer += chunk;
    const idx = stdoutLineBuffer.lastIndexOf("\n");
    const complete = idx >= 0 ? stdoutLineBuffer.slice(0, idx) : "";
    if (idx >= 0) stdoutLineBuffer = stdoutLineBuffer.slice(idx + 1);
    const lines = complete.split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        emit({ type: "raw", source: "claude-code", stream: "stdout", eventType: event?.type || "unknown", text: rawTraceText(event) });
        if (event.type === "assistant" && event.message && Array.isArray(event.message.content)) {
          for (const block of event.message.content) {
            if (!block || typeof block !== "object") continue;
            if (block.type === "text" && block.text) {
              const text = normalizeStreamTextChunk(block.text);
              emit({ type: "natural", kind: "assistant", text });
              mdStreamer.push(text);
              emit({ type: "status", line: t("runner.generating_reply") });
            } else if (block.type === "thinking" && block.thinking) {
              const text = normalizeStreamTextChunk(block.thinking);
              emit({ type: "natural", kind: "thinking", text });
              emit({ type: "status", line: t("runner.thinking") });
              if (options.onToolCall) options.onToolCall("thinking", "");
            } else if (block.type === "tool_use") {
              const toolName = block.name || "?";
              emit({ type: "status", line: `工具 ${toolName}` });
              if (options.onToolCall) options.onToolCall("tool_use", toolName);
            }
          }
        } else if (event.type === "result") {
          lastResult = event;
          const isSuccess = event.subtype === "success" && !event.is_error;
          if (isSuccess) {
            hadError = false;
            if (typeof event.result === "string" && event.result.trim()) {
              emit({ type: "natural", kind: "result", text: normalizeStreamTextChunk(event.result) });
            }
            emit({ type: "status", line: t("runner.completed") });
          } else {
            hadError = true;
            const errText =
              (typeof event.result === "string" && event.result) ||
              event.subtype ||
              t("runner.execution_failed");
            emit({ type: "natural", kind: "error", text: String(errText) });
            emit({ type: "status", line: truncateComposerLine(String(errText)) });
          }
        } else if (event.type === "system") {
          // init 元事件
        } else if (event.type === "user") {
          // tool_result 回传
        } else {
          emit({ type: "status", line: `${t("runner.event_label")}: ${event.type ?? "unknown"}` });
        }
      } catch (_) {
        emit({ type: "raw", source: "claude-code", stream: "stdout", eventType: "line", text: rawTraceText(line) });
        emit({ type: "status", line: truncateComposerLine(line) });
      }
    }
  });

  const finished = new Promise((resolve, reject) => {
    child.on("error", (err) => {
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.removeAllListeners();
      reject(
        new Error(
          `Claude Code CLI failed to start: ${err.message}. Install via 'npm i -g @anthropic-ai/claude-code' and run 'claude /login', or set CLAUDE_CODE_CMD.`,
        ),
      );
    });

    child.on("close", (code) => {
      child.stdout.removeAllListeners();
      if (!useStderrInherit) child.stderr.removeAllListeners();
      child.removeAllListeners();
      mdStreamer.finish();
      if (!useStderrInherit && stderrComposerBuffer.trim()) {
        const rest = stderrComposerBuffer.trim();
        emit({ type: "status", line: `[stderr] ${truncateComposerLine(rest)}` });
      }
      if (code !== 0 && lastResult == null) {
        const stderr = Buffer.concat(stderrChunks).toString("utf-8");
        const stderrTail = stderr ? stderr.trim().slice(-1200) : "";
        const err = new Error(`Claude Code CLI exited ${code}. ${stderrTail || "No result event received."}`);
        err.claudeCodeStderrTail = stderrTail;
        emit({ type: "status", line: truncateComposerLine(err.message) });
        reject(err);
        return;
      }
      if (hadError || (lastResult && lastResult.is_error)) {
        const msg =
          (lastResult && typeof lastResult.result === "string" && lastResult.result) ||
          (lastResult && lastResult.subtype) ||
          "Agent reported error.";
        emit({ type: "status", line: truncateComposerLine(String(msg)) });
        reject(new Error(String(msg)));
        return;
      }
      resolve();
    });
  });

  return { child, finished };
}

/**
 * Codex CLI：纯文本 prompt，供 Composer / UI 流式使用；不写 process stdout/stderr。
 * @returns {{ child: import('child_process').ChildProcess, finished: Promise<void> }}
 */
export function runCodexAgentWithPrompt(cliWorkspace, promptText, options = {}) {
  const onStreamEvent = typeof options.onStreamEvent === "function" ? options.onStreamEvent : null;
  const ws = path.resolve(cliWorkspace);
  const model = cleanModel(options.model, "CODEX_MODEL");
  const codexCmd = process.env.CODEX_CMD || "codex";
  const tmpDir = path.join(ws, ".workspace", "agentflow", "tmp");
  fs.mkdirSync(tmpDir, { recursive: true });
  const outputLastMessagePath = path.join(tmpDir, `codex-last-message-${process.pid}-${Date.now()}.txt`);
  const args = buildCodexExecArgs({
    workspace: ws,
    model,
    outputLastMessagePath,
    promptText,
    configArgs: options.codexConfigArgs,
  });

  const useStderrInherit =
    process.env.AGENTFLOW_CODEX_STDERR_INHERIT === "1" ||
    process.env.AGENTFLOW_CODEX_STDERR_INHERIT === "true";
  const child = spawn(codexCmd, args, {
    cwd: ws,
    stdio: ["ignore", "pipe", useStderrInherit ? "inherit" : "pipe"],
    shell: false,
    env: childEnv(options),
  });

  let hadError = false;
  let emittedNatural = false;
  const STDERR_CAP_BYTES = 1024 * 1024;
  const stderrChunks = [];
  let stderrTotalBytes = 0;
  let stderrComposerBuffer = "";

  const emit = (payload) => {
    try {
      onStreamEvent?.(payload);
    } catch (_) {}
  };

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
      stderrComposerBuffer += s;
      let idx;
      while ((idx = stderrComposerBuffer.indexOf("\n")) !== -1) {
        const line = stderrComposerBuffer.slice(0, idx);
        stderrComposerBuffer = stderrComposerBuffer.slice(idx + 1);
        if (line.trim()) {
          emit({ type: "raw", source: "codex", stream: "stderr", eventType: "line", text: rawTraceText(line) });
          emit({ type: "status", line: `[stderr] ${truncateComposerLine(line)}` });
        }
      }
    });
  }

  const stdoutWidth = 80;
  const mdStreamer = createMarkdownStreamer({
    render: (md) => renderMarkdown(md, { width: stdoutWidth }),
    spacing: "single",
  });

  function emitNatural(kind, text) {
    emittedNatural = true;
    emit({ type: "natural", kind, text });
    mdStreamer.push(text);
    emit({ type: "status", line: kind === "thinking" ? t("runner.thinking") : t("runner.generating_reply") });
  }

  function emitStatus(line) {
    if (line) emit({ type: "status", line: truncateComposerLine(line) });
  }

  child.stdout.setEncoding("utf-8");
  let stdoutLineBuffer = "";
  child.stdout.on("data", (chunk) => {
    stdoutLineBuffer += chunk;
    const idx = stdoutLineBuffer.lastIndexOf("\n");
    const complete = idx >= 0 ? stdoutLineBuffer.slice(0, idx) : "";
    if (idx >= 0) stdoutLineBuffer = stdoutLineBuffer.slice(idx + 1);
    const lines = complete.split("\n").filter(Boolean);
    for (const line of lines) {
      try {
        const event = JSON.parse(line);
        emit({ type: "raw", source: "codex", stream: "stdout", eventType: codexEventKind(event), text: rawTraceText(event) });
        const result = handleCodexEvent(event, { emitNatural, emitStatus, onToolCall: options.onToolCall });
        if (result.hadError) hadError = true;
        if (!result.handled) emit({ type: "status", line: `${t("runner.event_label")}: ${codexEventKind(event)}` });
      } catch (_) {
        emit({ type: "raw", source: "codex", stream: "stdout", eventType: "line", text: rawTraceText(line) });
        emit({ type: "status", line: truncateComposerLine(line) });
      }
    }
  });

  const finished = new Promise((resolve, reject) => {
    child.on("error", (err) => {
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      child.removeAllListeners();
      reject(new Error(`Codex CLI failed to start: ${err.message}. Ensure '${codexCmd}' is in PATH and run 'codex login'.`));
    });

    child.on("close", (code) => {
      if (stdoutLineBuffer.trim()) {
        emit({ type: "raw", source: "codex", stream: "stdout", eventType: "tail", text: rawTraceText(stdoutLineBuffer.trim()) });
      }
      child.stdout.removeAllListeners();
      if (!useStderrInherit) child.stderr.removeAllListeners();
      child.removeAllListeners();
      mdStreamer.finish();
      if (!useStderrInherit && stderrComposerBuffer.trim()) {
        const rest = stderrComposerBuffer.trim();
        emit({ type: "raw", source: "codex", stream: "stderr", eventType: "tail", text: rawTraceText(rest) });
        emit({ type: "status", line: `[stderr] ${truncateComposerLine(rest)}` });
      }
      const finalMessage = fs.existsSync(outputLastMessagePath) ? fs.readFileSync(outputLastMessagePath, "utf-8").trim() : "";
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf-8");
        const stderrTail = stderr ? stderr.trim().slice(-1200) : "";
        const err = new Error(codexFailureMessage(code, stderrTail));
        err.codexStderrTail = stderrTail;
        emit({ type: "status", line: truncateComposerLine(err.message) });
        reject(err);
        return;
      }
      if (hadError) {
        const msg = finalMessage || "Codex reported error.";
        emit({ type: "status", line: truncateComposerLine(msg) });
        reject(new Error(msg));
        return;
      }
      if (finalMessage && !emittedNatural) {
        emit({ type: "natural", kind: "result", text: finalMessage });
      }
      emit({ type: "status", line: t("runner.completed") });
      try {
        if (fs.existsSync(outputLastMessagePath)) fs.unlinkSync(outputLastMessagePath);
      } catch (_) {}
      resolve();
    });
  });

  return { child, finished };
}
