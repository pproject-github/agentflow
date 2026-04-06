/**
 * 直调 AI API 运行器，绕过 Cursor/OpenCode CLI 冷启动开销。
 *
 * 支持的模型格式（在 flow.yaml 或模型配置中指定）：
 *   api:openai/<model>        — OpenAI 或兼容端点（Together/Groq/DeepSeek/Azure 等）
 *   api:anthropic/<model>     — Anthropic Claude
 *
 * 相关环境变量：
 *   OPENAI_API_KEY            — OpenAI 或兼容端点的 API key
 *   OPENAI_BASE_URL           — 兼容端点基础 URL（默认 https://api.openai.com/v1）
 *   ANTHROPIC_API_KEY         — Anthropic API key
 *   AGENTFLOW_API_MAX_ROUNDS  — 工具调用最大轮数（默认 30）
 *   AGENTFLOW_API_MAX_TOKENS  — 单次响应最大 token 数（默认 8192）
 */

import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

import { loadAgentPromptWithReplacements, stripYamlFrontmatter } from "./agents-path.mjs";
import { appendRunLogLine } from "./run-events.mjs";

const DEFAULT_OPENAI_BASE = "https://api.openai.com/v1";
const MAX_TOOL_ROUNDS = parseInt(process.env.AGENTFLOW_API_MAX_ROUNDS ?? "30", 10) || 30;
const MAX_TOKENS = parseInt(process.env.AGENTFLOW_API_MAX_TOKENS ?? "8192", 10) || 8192;

// ─── 工具定义 ────────────────────────────────────────────────────────────────

const TOOL_DEFS = [
  {
    name: "read_file",
    description: "Read the contents of a file. Returns the file content as text.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (absolute, or relative to workspace root)" },
      },
      required: ["path"],
    },
  },
  {
    name: "write_file",
    description: "Write content to a file, creating parent directories as needed. Overwrites existing content.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path (absolute, or relative to workspace root)" },
        content: { type: "string", description: "Full content to write" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "run_command",
    description: "Run a shell command in the workspace root directory. Returns stdout, stderr and exit code.",
    parameters: {
      type: "object",
      properties: {
        command: { type: "string", description: "Shell command to execute" },
        timeout_ms: { type: "number", description: "Timeout in milliseconds (default: 30000)" },
      },
      required: ["command"],
    },
  },
  {
    name: "list_dir",
    description: "List files and subdirectories at a path.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Directory path (absolute, or relative to workspace root)" },
      },
      required: ["path"],
    },
  },
];

/** OpenAI format: tools array */
function openAiTools() {
  return TOOL_DEFS.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

/** Anthropic format: tools array */
function anthropicTools() {
  return TOOL_DEFS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.parameters,
  }));
}

// ─── 工具执行 ────────────────────────────────────────────────────────────────

function toAbs(workspaceRoot, p) {
  return path.isAbsolute(p) ? p : path.resolve(workspaceRoot, p);
}

function executeTool(workspaceRoot, toolName, input) {
  try {
    switch (toolName) {
      case "read_file": {
        const abs = toAbs(workspaceRoot, input.path);
        if (!fs.existsSync(abs)) return { error: `File not found: ${input.path}` };
        const content = fs.readFileSync(abs, "utf-8");
        return { content };
      }

      case "write_file": {
        const abs = toAbs(workspaceRoot, input.path);
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, input.content, "utf-8");
        return { ok: true, bytes_written: Buffer.byteLength(input.content, "utf-8") };
      }

      case "run_command": {
        const timeoutMs = typeof input.timeout_ms === "number" ? input.timeout_ms : 30000;
        const r = spawnSync(input.command, [], {
          cwd: workspaceRoot,
          shell: true,
          encoding: "utf-8",
          timeout: timeoutMs,
        });
        return {
          exit_code: r.status ?? -1,
          stdout: (r.stdout ?? "").slice(0, 20000),
          stderr: (r.stderr ?? "").slice(0, 5000),
          timed_out: r.signal === "SIGTERM",
        };
      }

      case "list_dir": {
        const abs = toAbs(workspaceRoot, input.path);
        if (!fs.existsSync(abs)) return { error: `Path not found: ${input.path}` };
        const entries = fs.readdirSync(abs, { withFileTypes: true });
        return {
          items: entries.map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" })),
        };
      }

      default:
        return { error: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    return { error: err.message };
  }
}

// ─── API 调用封装 ─────────────────────────────────────────────────────────────

async function fetchOpenAi(apiKey, baseUrl, model, messages) {
  const url = `${baseUrl.replace(/\/$/, "")}/chat/completions`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages,
      tools: openAiTools(),
      tool_choice: "auto",
      max_tokens: MAX_TOKENS,
    }),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`OpenAI API ${resp.status}: ${txt.slice(0, 600)}`);
  }
  return resp.json();
}

async function fetchAnthropic(apiKey, model, messages, systemPrompt) {
  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      system: systemPrompt,
      messages,
      tools: anthropicTools(),
      max_tokens: MAX_TOKENS,
    }),
  });
  if (!resp.ok) {
    const txt = await resp.text().catch(() => "");
    throw new Error(`Anthropic API ${resp.status}: ${txt.slice(0, 600)}`);
  }
  return resp.json();
}

// ─── 工具调用循环 ─────────────────────────────────────────────────────────────

async function runOpenAiLoop(apiKey, baseUrl, model, systemPrompt, userContent, workspaceRoot, log, options) {
  const messages = [
    ...(systemPrompt ? [{ role: "system", content: systemPrompt }] : []),
    { role: "user", content: userContent },
  ];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    log(`[api/openai] round ${round + 1}`);
    const resp = await fetchOpenAi(apiKey, baseUrl, model, messages);
    const choice = resp.choices?.[0];
    if (!choice) throw new Error("OpenAI: no choices in response");

    const msg = choice.message;
    messages.push(msg);

    // 向外广播助手文本（用于 spinner 显示）
    if (options.onToolCall) {
      const txt = typeof msg.content === "string" ? msg.content : "";
      if (txt.trim()) options.onToolCall("assistant", txt.slice(0, 200));
    }

    if (choice.finish_reason === "stop" || choice.finish_reason === "end_turn" || !msg.tool_calls?.length) {
      log(`[api/openai] finished (${choice.finish_reason ?? "no-tool-calls"})`);
      break;
    }

    const toolResults = [];
    for (const tc of msg.tool_calls) {
      const toolName = tc.function.name;
      let toolInput = {};
      try { toolInput = JSON.parse(tc.function.arguments); } catch (_) { /**/ }

      log(`[api/openai] tool: ${toolName} ${JSON.stringify(toolInput).slice(0, 120)}`);
      if (options.onToolCall) options.onToolCall("tool_call", toolName);

      const result = executeTool(workspaceRoot, toolName, toolInput);
      log(`[api/openai] tool result: ${JSON.stringify(result).slice(0, 200)}`);

      toolResults.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
    }
    messages.push(...toolResults);
  }
}

async function runAnthropicLoop(apiKey, model, systemPrompt, userContent, workspaceRoot, log, options) {
  const messages = [{ role: "user", content: userContent }];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    log(`[api/anthropic] round ${round + 1}`);
    const resp = await fetchAnthropic(apiKey, model, messages, systemPrompt);

    // 助手消息
    messages.push({ role: "assistant", content: resp.content });

    if (options.onToolCall) {
      const textBlock = resp.content?.find((b) => b.type === "text");
      if (textBlock?.text) options.onToolCall("assistant", textBlock.text.slice(0, 200));
    }

    if (resp.stop_reason === "end_turn" || resp.stop_reason === "stop_sequence") {
      log(`[api/anthropic] finished (${resp.stop_reason})`);
      break;
    }

    const toolUses = (resp.content ?? []).filter((b) => b.type === "tool_use");
    if (!toolUses.length) {
      log("[api/anthropic] finished (no tool_use blocks)");
      break;
    }

    const toolResults = [];
    for (const tb of toolUses) {
      log(`[api/anthropic] tool: ${tb.name} ${JSON.stringify(tb.input).slice(0, 120)}`);
      if (options.onToolCall) options.onToolCall("tool_call", tb.name);

      const result = executeTool(workspaceRoot, tb.name, tb.input ?? {});
      log(`[api/anthropic] tool result: ${JSON.stringify(result).slice(0, 200)}`);

      toolResults.push({ type: "tool_result", tool_use_id: tb.id, content: JSON.stringify(result) });
    }
    messages.push({ role: "user", content: toolResults });
  }
}

// ─── 公共解析函数 ─────────────────────────────────────────────────────────────

/**
 * 从模型字符串中解析 provider 和 model。
 * 例：
 *   "api:openai/gpt-4o"          → { provider: "openai", model: "gpt-4o" }
 *   "api:anthropic/claude-opus-4-5" → { provider: "anthropic", model: "claude-opus-4-5" }
 *   "api:gpt-4o"                 → { provider: "openai", model: "gpt-4o" }  (默认 openai)
 */
export function parseApiModel(str) {
  const s = String(str ?? "").replace(/^api:/, "");
  const slash = s.indexOf("/");
  if (slash < 0) return { provider: "openai", model: s };
  const provider = s.slice(0, slash).toLowerCase();
  const model = s.slice(slash + 1);
  return { provider, model };
}

// ─── 主入口 ───────────────────────────────────────────────────────────────────

/**
 * 直调 AI API 执行节点，绕过 Cursor/OpenCode CLI。
 *
 * @param {string} workspaceRoot
 * @param {{ promptPath: string, nodeContext?: string, taskBody?: string, subagent?: string, instanceId?: string }} nodeInfo
 * @param {object} options
 *   model      — "api:openai/gpt-4o" | "api:anthropic/claude-opus-4-5" 等
 *   flowName   — 用于日志
 *   uuid       — 用于日志
 *   onToolCall — (subtype: string, name: string) => void  供 spinner 展示
 */
export async function runApiAgentForNode(workspaceRoot, { promptPath, nodeContext, taskBody, subagent, instanceId }, options = {}) {
  const absRoot = path.resolve(workspaceRoot);
  const flowName = options.flowName ?? null;
  const uuid = options.uuid ?? null;

  const log = (msg) => {
    if (flowName && uuid) appendRunLogLine(absRoot, flowName, uuid, "api-runner", msg);
  };

  // ── 解析 provider / model ──────────────────────────────────────────────────
  const modelRaw = String(options.model ?? "api:openai/gpt-4o");
  const { provider, model } = parseApiModel(modelRaw);
  log(`start provider=${provider} model=${model} instanceId=${instanceId ?? "-"}`);

  // ── 读取 Agent 角色提示，注入 nodeContext/taskBody ────────────────────────
  const replacements = {
    workspaceRoot: absRoot,
    nodeContext: nodeContext ?? "",
    taskBody: taskBody ?? "",
    flowName: flowName ?? "",
    uuid: uuid ?? "",
    instanceId: instanceId ?? "",
  };
  const agentRaw = loadAgentPromptWithReplacements(workspaceRoot, subagent ?? "agentflow-node-executor", replacements);
  const renderedBody = stripYamlFrontmatter(agentRaw);

  // ── system/user 拆分：## 节点上下文 之前为角色指令，之后为任务内容 ─────────
  const splitMarker = "## 节点上下文";
  const splitIdx = renderedBody.indexOf(splitMarker);
  const systemPrompt = splitIdx > 0 ? renderedBody.slice(0, splitIdx).trim() : renderedBody;
  const userContent = `## 节点上下文\n\n${nodeContext ?? ""}\n\n## 执行任务\n\n${taskBody ?? ""}`;

  // ── 确认 API Key ───────────────────────────────────────────────────────────
  if (provider === "anthropic") {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("[api-runner] ANTHROPIC_API_KEY is required for api:anthropic/* models");
    await runAnthropicLoop(key, model, systemPrompt, userContent, absRoot, log, options);
  } else {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("[api-runner] OPENAI_API_KEY is required for api:openai/* models");
    const baseUrl = (process.env.OPENAI_BASE_URL ?? DEFAULT_OPENAI_BASE).trim();
    await runOpenAiLoop(key, baseUrl, model, systemPrompt, userContent, absRoot, log, options);
  }

  log(`done instanceId=${instanceId ?? "-"}`);
}
