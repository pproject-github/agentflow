/**
 * Composer 执行器：以给定 prompt 拉起一次 CLI agent（Cursor / OpenCode / Claude Code / Codex），
 * 并按用户私有 MCP 配置临时物化 .cursor/mcp.json 或 codex 覆盖参数。
 *
 * Workspace 的节点执行、生成、node-chat、实现优化都走这里。
 */
import fs from "fs";
import os from "os";
import path from "path";
import { getAgentflowDataRoot, getAgentflowUserDataRoot, sanitizeAgentflowUserId } from "./paths.mjs";
import { readMergedEnvObject } from "./user-env.mjs";
import { resolveCliAndModel } from "./model-config.mjs";
import { runCodexAgentWithPrompt, runClaudeCodeAgentWithPrompt, runCursorAgentWithPrompt, runOpenCodeAgentWithPrompt } from "./agent-runners.mjs";

const MAX_PROMPT_CHARS = 500_000;

function readJsonObject(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function readUserMcpPrivateEnvObject(userId) {
  const safe = sanitizeAgentflowUserId(userId);
  const data = readJsonObject(path.join(getAgentflowUserDataRoot(safe), "mcp-private.json"));
  const servers = data?.servers && typeof data.servers === "object" && !Array.isArray(data.servers) ? data.servers : {};
  const env = {};
  for (const server of Object.values(servers)) {
    const serverEnv = server?.env && typeof server.env === "object" && !Array.isArray(server.env) ? server.env : {};
    for (const [key, value] of Object.entries(serverEnv)) {
      const envKey = String(key || "").trim();
      if (envKey) env[envKey] = String(value ?? "");
    }
  }
  return env;
}

function readUserMcpPrivateServers(userId) {
  const safe = sanitizeAgentflowUserId(userId);
  if (!safe) return {};
  const data = readJsonObject(path.join(getAgentflowUserDataRoot(safe), "mcp-private.json"));
  return data?.servers && typeof data.servers === "object" && !Array.isArray(data.servers) ? data.servers : {};
}

function pruneCursorMcpPrivateEnvPlaceholders() {
  const filePath = path.join(os.homedir(), ".cursor", "mcp.json");
  const config = readJsonObject(filePath);
  const servers = config?.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)
    ? config.mcpServers
    : null;
  if (!servers) return;
  let changed = false;
  const nextServers = {};
  for (const [name, raw] of Object.entries(servers)) {
    const server = raw && typeof raw === "object" && !Array.isArray(raw) ? { ...raw } : raw;
    const privateEnvKeys = Array.isArray(server?.__agentflowPrivateKeys?.env)
      ? server.__agentflowPrivateKeys.env.map((key) => String(key || "").trim()).filter(Boolean)
      : [];
    if (!privateEnvKeys.length || !server?.env || typeof server.env !== "object" || Array.isArray(server.env)) {
      nextServers[name] = server;
      continue;
    }
    const nextEnv = { ...server.env };
    for (const key of privateEnvKeys) {
      if (Object.prototype.hasOwnProperty.call(nextEnv, key) && String(nextEnv[key] ?? "") === "") {
        delete nextEnv[key];
        changed = true;
      }
    }
    nextServers[name] = { ...server, env: nextEnv };
    if (Object.keys(nextEnv).length === 0) delete nextServers[name].env;
  }
  if (!changed) return;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ ...config, mcpServers: nextServers }, null, 2) + "\n", "utf-8");
}

function cursorMcpServersFromFile(filePath) {
  const config = readJsonObject(filePath);
  return config?.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)
    ? config.mcpServers
    : {};
}

function materializeWorkspaceCursorMcpPrivateConfig(workspaceRoot, userId) {
  const safe = sanitizeAgentflowUserId(userId);
  if (!safe) return () => {};
  const privateServers = readUserMcpPrivateServers(safe);
  if (!Object.keys(privateServers).length) return () => {};

  const workspace = path.resolve(workspaceRoot || process.cwd());
  const filePath = path.join(workspace, ".cursor", "mcp.json");
  const globalFilePath = path.join(os.homedir(), ".cursor", "mcp.json");
  const existed = fs.existsSync(filePath);
  const original = existed ? fs.readFileSync(filePath, "utf-8") : "";
  const config = readJsonObject(filePath);
  const localServers = cursorMcpServersFromFile(filePath);
  const globalServers = cursorMcpServersFromFile(globalFilePath);
  const nextServers = { ...localServers };
  let changed = false;

  for (const [name, privateServer] of Object.entries(privateServers)) {
    const current = nextServers[name] || globalServers[name];
    if (!current || typeof current !== "object" || Array.isArray(current)) continue;
    const privateEnv = privateServer?.env && typeof privateServer.env === "object" && !Array.isArray(privateServer.env) ? privateServer.env : {};
    const privateHeaders = privateServer?.headers && typeof privateServer.headers === "object" && !Array.isArray(privateServer.headers) ? privateServer.headers : {};
    if (!Object.keys(privateEnv).length && !Object.keys(privateHeaders).length) continue;

    const next = { ...current };
    if (Object.keys(privateEnv).length) {
      const currentEnv = current.env && typeof current.env === "object" && !Array.isArray(current.env) ? current.env : {};
      next.env = { ...currentEnv, ...privateEnv };
      changed = true;
    }
    if (Object.keys(privateHeaders).length) {
      const currentHeaders = current.headers && typeof current.headers === "object" && !Array.isArray(current.headers) ? current.headers : {};
      next.headers = { ...currentHeaders, ...privateHeaders };
      changed = true;
    }
    nextServers[name] = next;
  }

  if (!changed) return () => {};
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ ...config, mcpServers: nextServers }, null, 2) + "\n", "utf-8");

  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    try {
      if (existed) fs.writeFileSync(filePath, original, "utf-8");
      else if (fs.existsSync(filePath)) fs.rmSync(filePath, { force: true });
    } catch {
      // Best-effort restore; do not fail an already-running agent on cleanup.
    }
  };
}

function tomlString(value) {
  return JSON.stringify(String(value ?? ""));
}

function tomlArray(values) {
  return `[${(Array.isArray(values) ? values : []).map((value) => tomlString(value)).join(", ")}]`;
}

function tomlInlineTable(obj) {
  const entries = Object.entries(obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {})
    .filter(([key]) => String(key || "").trim())
    .map(([key, value]) => `${tomlString(String(key).trim())} = ${tomlString(value)}`);
  return `{ ${entries.join(", ")} }`;
}

function codexMcpName(name, used) {
  const base = String(name || "mcp")
    .trim()
    .replace(/[^A-Za-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "") || "mcp";
  let out = base;
  let i = 2;
  while (used.has(out)) out = `${base}_${i++}`;
  used.add(out);
  return out;
}

function bearerFromHeaders(headers) {
  const obj = headers && typeof headers === "object" && !Array.isArray(headers) ? headers : {};
  for (const [key, value] of Object.entries(obj)) {
    if (String(key).toLowerCase() !== "authorization") continue;
    const match = String(value ?? "").match(/^Bearer\s+(.+)$/i);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function mergedCursorMcpServersForCodex(workspaceRoot, userId) {
  const safe = sanitizeAgentflowUserId(userId);
  const workspace = path.resolve(workspaceRoot || process.cwd());
  const localServers = cursorMcpServersFromFile(path.join(workspace, ".cursor", "mcp.json"));
  const globalServers = cursorMcpServersFromFile(path.join(os.homedir(), ".cursor", "mcp.json"));
  const privateServers = safe ? readUserMcpPrivateServers(safe) : {};
  const merged = { ...globalServers, ...localServers };

  for (const [name, privateServer] of Object.entries(privateServers)) {
    const current = merged[name];
    if (!current || typeof current !== "object" || Array.isArray(current)) continue;
    const privateEnv = privateServer?.env && typeof privateServer.env === "object" && !Array.isArray(privateServer.env) ? privateServer.env : {};
    const privateHeaders = privateServer?.headers && typeof privateServer.headers === "object" && !Array.isArray(privateServer.headers) ? privateServer.headers : {};
    const currentEnv = current.env && typeof current.env === "object" && !Array.isArray(current.env) ? current.env : {};
    const currentHeaders = current.headers && typeof current.headers === "object" && !Array.isArray(current.headers) ? current.headers : {};
    merged[name] = {
      ...current,
      ...(Object.keys(privateEnv).length ? { env: { ...currentEnv, ...privateEnv } } : {}),
      ...(Object.keys(privateHeaders).length ? { headers: { ...currentHeaders, ...privateHeaders } } : {}),
    };
  }

  return merged;
}

function codexMcpOverridesFromCursorConfig(workspaceRoot, userId) {
  const safe = sanitizeAgentflowUserId(userId);
  const privateServers = safe ? readUserMcpPrivateServers(safe) : {};
  const servers = mergedCursorMcpServersForCodex(workspaceRoot, userId);
  const used = new Set();
  const codexConfigArgs = [];
  const env = {};

  for (const [rawName, rawServer] of Object.entries(servers)) {
    if (!rawServer || typeof rawServer !== "object" || Array.isArray(rawServer)) continue;
    if (rawServer.disabled === true) continue;
    const name = codexMcpName(rawName, used);
    const prefix = `mcp_servers.${name}`;
    const envObj = rawServer.env && typeof rawServer.env === "object" && !Array.isArray(rawServer.env) ? rawServer.env : {};
    const headers = rawServer.headers && typeof rawServer.headers === "object" && !Array.isArray(rawServer.headers) ? rawServer.headers : {};
    const privateServer = privateServers[rawName];
    const privateEnv = privateServer?.env && typeof privateServer.env === "object" && !Array.isArray(privateServer.env) ? privateServer.env : {};
    const url = String(rawServer.url || "").trim();
    const command = String(rawServer.command || "").trim();

    if (url) {
      codexConfigArgs.push(`${prefix}.url=${tomlString(url)}`);
      if (rawServer.bearer_token_env_var && String(rawServer.bearer_token_env_var).trim()) {
        codexConfigArgs.push(`${prefix}.bearer_token_env_var=${tomlString(rawServer.bearer_token_env_var)}`);
      }
      if (rawServer.oauth_client_id && String(rawServer.oauth_client_id).trim()) {
        codexConfigArgs.push(`${prefix}.oauth_client_id=${tomlString(rawServer.oauth_client_id)}`);
      }
      if (rawServer.oauth_resource && String(rawServer.oauth_resource).trim()) {
        codexConfigArgs.push(`${prefix}.oauth_resource=${tomlString(rawServer.oauth_resource)}`);
      }
      const bearer = bearerFromHeaders(headers);
      if (bearer) {
        const envKey = `AGENTFLOW_CODEX_MCP_${name.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_BEARER`;
        env[envKey] = bearer;
        codexConfigArgs.push(`${prefix}.bearer_token_env_var=${tomlString(envKey)}`);
      }
      continue;
    }

    if (!command) continue;
    codexConfigArgs.push(`${prefix}.command=${tomlString(command)}`);
    if (Array.isArray(rawServer.args) && rawServer.args.length) {
      codexConfigArgs.push(`${prefix}.args=${tomlArray(rawServer.args)}`);
    }
    if (rawServer.cwd && String(rawServer.cwd).trim()) {
      codexConfigArgs.push(`${prefix}.cwd=${tomlString(rawServer.cwd)}`);
    }
    const publicEnvForConfig = {};
    for (const [key, value] of Object.entries(envObj)) {
      const envKey = String(key || "").trim();
      if (!envKey) continue;
      if (Object.prototype.hasOwnProperty.call(privateEnv, envKey)) {
        env[envKey] = String(privateEnv[envKey] ?? "");
      } else {
        publicEnvForConfig[envKey] = value;
      }
    }
    if (Object.keys(publicEnvForConfig).length) {
      codexConfigArgs.push(`${prefix}.env=${tomlInlineTable(publicEnvForConfig)}`);
    }
  }

  return { codexConfigArgs, env };
}

function agentflowUserEnv(userId) {
  const safe = sanitizeAgentflowUserId(userId);
  pruneCursorMcpPrivateEnvPlaceholders();
  return { ...readMergedEnvObject(safe), ...(safe ? readUserMcpPrivateEnvObject(safe) : {}), AGENTFLOW_USER_ID: safe };
}

function runCodexAgentWithPrivateMcp(cliWorkspace, prompt, options, userId) {
  const { codexConfigArgs, env } = codexMcpOverridesFromCursorConfig(cliWorkspace, userId);
  return runCodexAgentWithPrompt(cliWorkspace, prompt, {
    ...options,
    codexConfigArgs: [...(Array.isArray(options?.codexConfigArgs) ? options.codexConfigArgs : []), ...codexConfigArgs],
    env: { ...(options?.env || {}), ...env },
  });
}

function runCursorAgentWithPrivateMcp(cliWorkspace, prompt, options, userId) {
  const restore = materializeWorkspaceCursorMcpPrivateConfig(cliWorkspace, userId);
  let handle;
  try {
    handle = runCursorAgentWithPrompt(cliWorkspace, prompt, options);
  } catch (e) {
    restore();
    throw e;
  }

  let restored = false;
  const safeRestore = () => {
    if (restored) return;
    restored = true;
    restore();
  };
  if (handle?.child?.once) {
    handle.child.once("exit", safeRestore);
    handle.child.once("error", safeRestore);
  }
  const finished = Promise.resolve(handle.finished).finally(safeRestore);
  return { ...handle, finished };
}

// ─── script 内容注入辅助 ─────────────────────────────────────────────────

/**
 * 旧版单步执行：将整个 prompt 一次性发给 Cursor / OpenCode。
 * @param {object} opts
 * @param {string} opts.uiWorkspaceRoot
 * @param {string} [opts.cliWorkspace]
 * @param {string} opts.prompt
 * @param {string} [opts.modelKey]
 * @param {Record<string, string>} [opts.extraEnv]
 * @param {boolean} [opts.force]
 * @param {(ev: object) => void} [opts.onStreamEvent]
 * @param {(subtype: string, toolName: string) => void} [opts.onToolCall]
 * @returns {{ child: import('child_process').ChildProcess, finished: Promise<void> }}
 */
export function startComposerAgent(opts) {
  const uiRoot = opts.uiWorkspaceRoot && String(opts.uiWorkspaceRoot).trim();
  if (!uiRoot) throw new Error("Missing uiWorkspaceRoot");

  const prompt = opts.prompt != null ? String(opts.prompt) : "";
  if (!prompt.trim()) throw new Error("Empty prompt");
  if (prompt.length > MAX_PROMPT_CHARS) throw new Error(`Prompt exceeds ${MAX_PROMPT_CHARS} characters`);

  const cliWs = opts.cliWorkspace ? String(opts.cliWorkspace) : getAgentflowDataRoot();
  const modelKey = opts.modelKey != null ? String(opts.modelKey).trim() : "";
  const { cli, model } = resolveCliAndModel(uiRoot, modelKey || null, null);
  const extraEnv = opts.extraEnv && typeof opts.extraEnv === "object" && !Array.isArray(opts.extraEnv) ? opts.extraEnv : {};
  const env = { ...agentflowUserEnv(opts.agentflowUserId), ...extraEnv };

  const common = {
    onStreamEvent: opts.onStreamEvent,
    onToolCall: opts.onToolCall,
    onChild: opts.onChild,
    detached: Boolean(opts.detached),
    force: Boolean(opts.force),
    env,
    addDirs: Array.isArray(opts.writableDirs)
      ? opts.writableDirs.map((dir) => String(dir || "").trim()).filter(Boolean)
      : [],
  };

  if (cli === "opencode") {
    return runOpenCodeAgentWithPrompt(cliWs, prompt, {
      ...common,
      model: model || undefined,
    });
  }

  if (cli === "codex") {
    return runCodexAgentWithPrivateMcp(cliWs, prompt, {
      ...common,
      model: model || undefined,
    }, opts.agentflowUserId);
  }

  if (cli === "claude-code") {
    return runClaudeCodeAgentWithPrompt(cliWs, prompt, {
      ...common,
      model: model || undefined,
    });
  }

  return runCursorAgentWithPrivateMcp(cliWs, prompt, {
    ...common,
    model: model || undefined,
  }, opts.agentflowUserId);
}
