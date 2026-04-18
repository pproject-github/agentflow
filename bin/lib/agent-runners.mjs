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
  const replacements = {
    workspaceRoot: absWorkspaceRoot,
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
    const args = ["--print", "--output-format", "stream-json", "--trust", "--workspace", workspaceRoot];
    const approveMcps = process.env.AGENTFLOW_CURSOR_APPROVE_MCPS !== "0" && process.env.AGENTFLOW_CURSOR_APPROVE_MCPS !== "false";
    if (approveMcps) args.push("--approve-mcps");
    if (options.force) args.push("--force");
    args.push("--model", model);
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
      cwd: workspaceRoot,
      stdio: ["ignore", "pipe", useStderrInherit ? "inherit" : "pipe"],
      shell: false,
    });

    let lastResult = null;
    let hadError = false;
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
  const replacements = {
    workspaceRoot: absWorkspaceRoot,
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
    args.push("--dir", workspaceRoot);
    args.push("--", promptText);
    const spawnOpts = {
      cwd: workspaceRoot,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    };
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

    let stdoutLogBuf = "";
    let stderrLogBuf = "";

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
      stdoutLogBuf += String(chunk).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
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
  const replacements = {
    workspaceRoot: absWorkspaceRoot,
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
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--add-dir", workspaceRoot];
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
      cwd: workspaceRoot,
      stdio: ["ignore", "pipe", useStderrInherit ? "inherit" : "pipe"],
      shell: false,
    });

    let lastResult = null;
    let hadError = false;
    let sessionId = null;
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
  args.push("--model", model);
  args.push(promptText);

  const useStderrInherit = process.env.AGENTFLOW_CURSOR_STDERR_INHERIT === "1" || process.env.AGENTFLOW_CURSOR_STDERR_INHERIT === "true";
  const child = spawn(agentCmd, args, {
    cwd: ws,
    stdio: ["ignore", "pipe", useStderrInherit ? "inherit" : "pipe"],
    shell: false,
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
  };
  if (options.force) {
    spawnOpts.env = {
      ...process.env,
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
        tryEmitOpenCodeLineAsNatural(outBuf.trim(), emit);
        emit({ type: "status", line: truncateComposerLine(outBuf.trim()) });
      }
      if (errBuf.trim()) {
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
