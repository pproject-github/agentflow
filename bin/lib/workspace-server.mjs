/**
 * Workspace 服务端子系统。
 *
 * 从 ui-server 原样搬出来：运行计划、节点执行、输入解析与输出信封、协作广播、调度、
 * display 分享。这一块和 PRD workflow 零耦合，闭包算下来对 ui-server 其余部分的依赖
 * 也是 0——共用的只有 HTTP 路由和鉴权。
 *
 * 路由处理仍在 ui-server 的 startUiServer 里，这里只提供它调用的函数。
 */

import { parseBool } from "../pipeline/parse-bool.mjs";
import { readAuthUsers } from "./auth.mjs";
import { listFlowsJson, listNodesJson } from "./catalog-flows.mjs";
import { startComposerAgent } from "./composer-agent.mjs";
import { loadResourcesForSkillKeys } from "./composer-skill-router.mjs";
import {
  MAX_CONTROL_WHILE_STEP_STDERR_BYTES,
  MAX_CONTROL_WHILE_STEP_STDOUT_BYTES,
  controlWhileCheckpointFingerprint,
  controlWhileIdempotencyKey,
  normalizeControlWhileConfig,
  normalizeControlWhileInitialState,
  parseControlWhileStepResult,
  resolveControlWhileCheckpoint,
  runControlWhile,
  serializeControlWhileState,
} from "./control-while.mjs";
import { graphToFlowFiles } from "./flow-dsl/index.mjs";
import { buildGitContext, inferGitRepoRootFromWorktree, loadGitWorktree, normalizeGitContext, runGit, sanitizeWorktreeName, unloadGitWorktree } from "./git-worktree.mjs";
import { createGitLabMergeRequest } from "./gitlab-mr.mjs";
import { json } from "./http-util.mjs";
import { t } from "./i18n.mjs";
import { advanceJenkinsBuild, createJenkinsHttpInvoker, jenkinsBuildStatePath, normalizeJenkinsBuildConfig, readJenkinsBuildState, writeJenkinsBuildState } from "./jenkins.mjs";
import { log } from "./log.mjs";
import { resolveMarketplaceNodePackage } from "./marketplace.mjs";
import { marketplaceResourcesForRun, recordMarketplaceRunUsage } from "./marketplace-usage.mjs";
import { PACKAGE_ROOT, getAgentflowDataRoot, getAgentflowUserDataRoot, listAgentflowUserIds } from "./paths.mjs";
import { emitRepositoryRunFinished } from "./repository-index-events.mjs";
import { appendRunLedgerEvent, readRunLedgerEvents, runLedgerId } from "./run-ledger.mjs";
import { computeNextRunAt } from "./schedule-config.mjs";
import { listTeams } from "./teams.mjs";
import { readMergedEnvObject, runtimeEnvForUser } from "./user-env.mjs";
import { sendWecomAppMarkdown, sendWecomGroupMarkdown } from "./wecom.mjs";
import { getWorkspaceCollaborationByFlow, getWorkspaceCollaborationForProject, listWorkspaceCollaborationsForUser, workspaceCollaborationAccess, workspaceCollaborationSummary } from "./workspace-collaboration.mjs";
import { FLOW_SOURCE_FILENAME, WORKSPACE_GRAPH_FILENAME, WorkspaceFlowParseError, readWorkspaceGraphFiles, readWorkspaceRunFingerprints, writeWorkspaceGraphFiles } from "./workspace-flow-store.mjs";
import { workspaceDesignRevision } from "./workspace-graph-merge.mjs";
import { createWorkspaceRunController, terminateWorkspaceChild } from "./workspace-run-controller.mjs";
import { appendWorkspaceRunLogEvent, createWorkspaceRunLogSession, finishWorkspaceRunLogSession } from "./workspace-run-logs.mjs";
import { mergeWorkspaceState, splitWorkspaceGraph } from "./workspace-state.mjs";
import { isWorkspaceDraftDir } from "./workspace-draft.mjs";
import { getPipelineFiles } from "./workspace-tree.mjs";
import { spawn } from "child_process";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";


export function cursorMcpConfigPath() {
  return path.join(os.homedir(), ".cursor", "mcp.json");
}

export function readCursorMcpConfig() {
  const p = cursorMcpConfigPath();
  try {
    if (!fs.existsSync(p)) return { mcpServers: {} };
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : { mcpServers: {} };
  } catch {
    return { mcpServers: {} };
  }
}

export function userMcpPrivatePath(userCtx = {}) {
  return path.join(getAgentflowUserDataRoot(userCtx.userId), "mcp-private.json");
}

export function readUserMcpPrivate(userCtx = {}) {
  const p = userMcpPrivatePath(userCtx);
  try {
    if (!fs.existsSync(p)) return { version: 1, servers: {} };
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    const servers = data?.servers && typeof data.servers === "object" && !Array.isArray(data.servers) ? data.servers : {};
    return { version: 1, servers };
  } catch {
    return { version: 1, servers: {} };
  }
}

function privateKeyMetadataFromConfig(configValue = {}) {
  const meta = configValue?.__agentflowPrivateKeys;
  const env = Array.isArray(meta?.env) ? meta.env.map((key) => String(key || "").trim()).filter(Boolean) : [];
  const headers = Array.isArray(meta?.headers) ? meta.headers.map((key) => String(key || "").trim()).filter(Boolean) : [];
  return { env: Array.from(new Set(env)), headers: Array.from(new Set(headers)) };
}

function withPrivatePlaceholders(obj, keys) {
  const out = { ...(obj && typeof obj === "object" && !Array.isArray(obj) ? obj : {}) };
  for (const key of keys) {
    if (key && !Object.prototype.hasOwnProperty.call(out, key)) out[key] = "";
  }
  return out;
}

export function normalizeMcpServerConfig(value) {
  const raw = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const next = {};
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  const command = typeof raw.command === "string" ? raw.command.trim() : "";
  const description = typeof raw.description === "string" ? raw.description.trim() : "";
  if (url) next.url = url;
  if (command) next.command = command;
  if (Array.isArray(raw.args)) next.args = raw.args.map((x) => String(x)).filter((x) => x.length > 0);
  if (raw.env && typeof raw.env === "object" && !Array.isArray(raw.env)) {
    const env = {};
    for (const [k, v] of Object.entries(raw.env)) {
      const key = String(k || "").trim();
      if (key) env[key] = String(v ?? "");
    }
    if (Object.keys(env).length) next.env = env;
  }
  if (raw.headers && typeof raw.headers === "object" && !Array.isArray(raw.headers)) {
    const headers = {};
    for (const [k, v] of Object.entries(raw.headers)) {
      const key = String(k || "").trim();
      if (key) headers[key] = String(v ?? "");
    }
    if (Object.keys(headers).length) next.headers = headers;
  }
  if (description) next.description = description;
  for (const [k, v] of Object.entries(raw)) {
    if (["url", "command", "args", "env", "headers", "description"].includes(k)) continue;
    next[k] = v;
  }
  return next;
}

function mcpHeadersInfo(headers = {}) {
  const entries = Object.entries(headers && typeof headers === "object" && !Array.isArray(headers) ? headers : {})
    .filter(([key]) => String(key || "").trim());
  const unsupported = [];
  let bearer = false;
  for (const [key, value] of entries) {
    const name = String(key || "").trim();
    if (name.toLowerCase() !== "authorization") {
      unsupported.push(name);
      continue;
    }
    if (/^Bearer\s+.+/i.test(String(value ?? "").trim())) bearer = true;
    else unsupported.push(name);
  }
  return { count: entries.length, bearer, unsupported };
}

function codexMcpCompatibility(server) {
  const raw = server?.raw && typeof server.raw === "object" && !Array.isArray(server.raw) ? server.raw : {};
  const reasons = [];
  const supported = [];
  const unsupported = [];
  const type = raw.url || server?.url ? "url" : raw.command || server?.command ? "command" : "";
  if (raw.disabled === true) {
    return {
      status: "unsupported",
      label: "Codex disabled",
      reasons: ["该 MCP 已 disabled，Codex 不会启用。"],
      supported,
      unsupported: ["disabled"],
    };
  }
  if (!type) {
    return {
      status: "unsupported",
      label: "Codex unsupported",
      reasons: ["缺少 url 或 command。"],
      supported,
      unsupported: ["transport"],
    };
  }

  if (type === "command") {
    supported.push("command", "args");
    const envKeys = Object.keys(raw.env && typeof raw.env === "object" && !Array.isArray(raw.env) ? raw.env : {});
    if (envKeys.length) supported.push("env");
    if (raw.cwd) supported.push("cwd");
    const headers = raw.headers && typeof raw.headers === "object" && !Array.isArray(raw.headers) ? raw.headers : {};
    if (Object.keys(headers).length) {
      unsupported.push("headers");
      reasons.push("Codex stdio MCP 不支持 headers。");
    }
  }

  if (type === "url") {
    supported.push("url");
    const headers = mcpHeadersInfo(raw.headers);
    if (headers.bearer) supported.push("Authorization Bearer");
    if (headers.unsupported.length) {
      unsupported.push(...headers.unsupported.map((name) => `header:${name}`));
      reasons.push(`Codex URL MCP 仅能等价支持 Authorization: Bearer；不支持自定义 header：${headers.unsupported.join(", ")}。`);
    }
    const envKeys = Object.keys(raw.env && typeof raw.env === "object" && !Array.isArray(raw.env) ? raw.env : {});
    if (envKeys.length) {
      unsupported.push("env");
      reasons.push("Codex URL MCP 不支持 env；如需鉴权请使用 Authorization: Bearer 或 bearer_token_env_var。");
    }
    if (raw.bearer_token_env_var) supported.push("bearer_token_env_var");
    if (raw.oauth_client_id) supported.push("oauth_client_id");
    if (raw.oauth_resource) supported.push("oauth_resource");
  }

  const known = new Set([
    "url",
    "command",
    "args",
    "env",
    "headers",
    "description",
    "cwd",
    "disabled",
    "bearer_token_env_var",
    "oauth_client_id",
    "oauth_resource",
    "__agentflowPrivateKeys",
  ]);
  const unknownKeys = Object.keys(raw).filter((key) => !known.has(key));
  if (unknownKeys.length) {
    unsupported.push(...unknownKeys.map((key) => `field:${key}`));
    reasons.push(`存在 Codex 未确认支持的额外字段：${unknownKeys.join(", ")}。`);
  }

  const status = unsupported.length ? "partial" : "ok";
  return {
    status,
    label: status === "ok" ? "Codex OK" : "Codex partial",
    reasons,
    supported,
    unsupported,
  };
}

function cursorMcpCompatibility(server) {
  if (server?.raw?.disabled === true) {
    return { status: "unsupported", label: "Cursor disabled", reasons: ["该 MCP 已 disabled。"] };
  }
  return { status: "ok", label: "Cursor OK", reasons: [] };
}

function withMcpBackendCompatibility(server) {
  return {
    ...server,
    backends: {
      cursor: cursorMcpCompatibility(server),
      codex: codexMcpCompatibility(server),
    },
  };
}

export function readCursorMcpServers(userCtx = {}) {
  const config = readCursorMcpConfig();
  const privateConfig = readUserMcpPrivate(userCtx);
  const rawServers = config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)
    ? config.mcpServers
    : {};
  const servers = Object.entries(rawServers).map(([name, value]) => {
    const publicValue = normalizeMcpServerConfig(value);
    const privateValue = privateConfig.servers?.[name] && typeof privateConfig.servers[name] === "object" ? privateConfig.servers[name] : {};
    const privateEnv = privateValue.env && typeof privateValue.env === "object" && !Array.isArray(privateValue.env) ? privateValue.env : {};
    const privateHeaders = privateValue.headers && typeof privateValue.headers === "object" && !Array.isArray(privateValue.headers) ? privateValue.headers : {};
    const privateMeta = privateKeyMetadataFromConfig(publicValue);
    const privateEnvKeys = Array.from(new Set([...privateMeta.env, ...Object.keys(privateEnv)]));
    const privateHeaderKeys = Array.from(new Set([...privateMeta.headers, ...Object.keys(privateHeaders)]));
    const configValue = {
      ...publicValue,
      env: { ...withPrivatePlaceholders(publicValue.env || {}, privateEnvKeys), ...privateEnv },
      headers: { ...withPrivatePlaceholders(publicValue.headers || {}, privateHeaderKeys), ...privateHeaders },
    };
    return {
      name,
      type: configValue.url ? "url" : "command",
      url: typeof configValue.url === "string" ? configValue.url : "",
      command: typeof configValue.command === "string" ? configValue.command : "",
      args: Array.isArray(configValue.args) ? configValue.args : [],
      env: configValue.env && typeof configValue.env === "object" ? configValue.env : {},
      headers: configValue.headers && typeof configValue.headers === "object" ? configValue.headers : {},
      description: typeof configValue.description === "string" ? configValue.description : "",
      raw: configValue,
      privateEnvKeys,
      privateHeaderKeys,
    };
  }).map(withMcpBackendCompatibility).sort((a, b) => a.name.localeCompare(b.name));
  return { path: cursorMcpConfigPath(), servers };
}

function compactErrorMessage(error) {
  const text = String(error?.message || error || "").trim();
  return text.length > 260 ? `${text.slice(0, 257)}...` : text;
}

function parseMcpSsePayload(text) {
  const events = [];
  let data = [];
  for (const rawLine of String(text || "").split(/\r?\n/g)) {
    const line = rawLine.trimEnd();
    if (!line) {
      if (data.length) {
        const joined = data.join("\n").trim();
        if (joined) events.push(joined);
        data = [];
      }
      continue;
    }
    if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length) events.push(data.join("\n").trim());
  for (const event of events) {
    try {
      const parsed = JSON.parse(event);
      if (parsed && typeof parsed === "object") return parsed;
    } catch {}
  }
  return null;
}

async function mcpHttpRequest(url, headers, body, sessionId = "") {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Accept": "application/json, text/event-stream",
        "Content-Type": "application/json",
        ...(headers || {}),
        ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${text.slice(0, 180)}`);
    const contentType = String(response.headers.get("content-type") || "").toLowerCase();
    const parsed = contentType.includes("text/event-stream") ? parseMcpSsePayload(text) : JSON.parse(text || "{}");
    return { message: parsed, sessionId: response.headers.get("mcp-session-id") || sessionId };
  } finally {
    clearTimeout(timer);
  }
}

async function checkMcpHttpServer(server) {
  const url = String(server?.raw?.url || server?.url || "").trim();
  if (!url) throw new Error("Missing MCP URL");
  const headers = server?.raw?.headers && typeof server.raw.headers === "object" ? server.raw.headers : {};
  const init = await mcpHttpRequest(url, headers, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "agentflow", version: "0.1.0" },
    },
  });
  if (init.message?.error) throw new Error(init.message.error.message || "MCP initialize failed");
  await mcpHttpRequest(url, headers, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  }, init.sessionId).catch(() => null);
  const tools = await mcpHttpRequest(url, headers, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  }, init.sessionId);
  if (tools.message?.error) throw new Error(tools.message.error.message || "MCP tools/list failed");
  return Array.isArray(tools.message?.result?.tools) ? tools.message.result.tools : [];
}

async function checkMcpStdioServer(server) {
  const command = String(server?.raw?.command || server?.command || "").trim();
  if (!command) throw new Error("Missing MCP command");
  const args = Array.isArray(server?.raw?.args) ? server.raw.args.map(String) : [];
  const env = server?.raw?.env && typeof server.raw.env === "object" ? server.raw.env : {};
  const child = spawn(command, args, {
    cwd: os.homedir(),
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let buffer = "";
  let stderr = "";
  let processError = null;
  const pending = new Map();
  let nextId = 1;
  const cleanup = () => {
    for (const [, request] of pending) clearTimeout(request.timer);
    pending.clear();
    if (!child.killed) child.kill("SIGTERM");
  };
  const rejectPending = (error) => {
    for (const [, request] of pending) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };
  child.on("error", (error) => {
    processError = error;
    rejectPending(error);
  });
  child.stdin.on("error", (error) => {
    processError = error;
    rejectPending(error);
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk || "");
    if (stderr.length > 2000) stderr = stderr.slice(-2000);
  });
  child.stdout.on("data", (chunk) => {
    buffer += String(chunk || "");
    const lines = buffer.split(/\r?\n/g);
    buffer = lines.pop() || "";
    for (const line of lines) {
      const text = line.trim();
      if (!text) continue;
      let message = null;
      try {
        message = JSON.parse(text);
      } catch {
        continue;
      }
      const request = pending.get(message.id);
      if (request) {
        pending.delete(message.id);
        clearTimeout(request.timer);
        request.resolve(message);
      }
    }
  });
  const send = (method, params = {}, timeoutMs = 8000) => new Promise((resolve, reject) => {
    if (processError) {
      reject(processError);
      return;
    }
    const id = nextId++;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method} timed out${stderr.trim() ? `: ${stderr.trim().slice(-220)}` : ""}`));
    }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n", (error) => {
      if (!error) return;
      pending.delete(id);
      clearTimeout(timer);
      reject(error);
    });
  });
  const notify = (method, params = {}) => {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  };
  try {
    const init = await send("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "agentflow", version: "0.1.0" },
    });
    if (init?.error) throw new Error(init.error.message || "MCP initialize failed");
    notify("notifications/initialized", {});
    const tools = await send("tools/list", {}, 8000);
    if (tools?.error) throw new Error(tools.error.message || "MCP tools/list failed");
    return Array.isArray(tools?.result?.tools) ? tools.result.tools : [];
  } finally {
    cleanup();
  }
}

async function checkMcpServer(server) {
  const startedAt = Date.now();
  try {
    const tools = server?.type === "url" || server?.raw?.url
      ? await checkMcpHttpServer(server)
      : await checkMcpStdioServer(server);
    return {
      name: server.name,
      ok: true,
      status: "enabled",
      toolCount: tools.length,
      tools: tools.map((tool) => ({
        name: String(tool?.name || ""),
        description: String(tool?.description || ""),
      })).filter((tool) => tool.name),
      checkedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    return {
      name: server?.name || "",
      ok: false,
      status: "error",
      error: compactErrorMessage(error),
      toolCount: 0,
      tools: [],
      checkedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt,
    };
  }
}

export async function checkCursorMcpServers(name = "", userCtx = {}) {
  const { servers } = readCursorMcpServers(userCtx);
  const targetName = String(name || "").trim();
  const targets = targetName ? servers.filter((server) => server.name === targetName) : servers;
  if (targetName && targets.length === 0) throw new Error("MCP server not found");
  const results = [];
  for (const server of targets) {
    results.push(await checkMcpServer(server));
  }
  return { results };
}

export function parseJsonText(text, fallback = null) {
  const s = String(text || "").trim();
  if (!s) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    const match = s.match(/(\{[\s\S]*\}|\[[\s\S]*\])\s*$/);
    if (!match) return fallback;
    try { return JSON.parse(match[1]); } catch { return fallback; }
  }
}

const WORKSPACE_FILE_SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "runBuild",
  ".next",
  ".nuxt",
  ".turbo",
  "dist",
  "build",
  "coverage",
]);

// workspace.flow.js 故意不在这里——它就是画布本身，用户应该能在文件树里看到并直接改。
// 藏起来的都是机器管理的伴生文件：坐标、图片 base64、运行产出、历史 JSON。
const WORKSPACE_FILE_SKIP_FILES = new Set([
  "flow.yaml",
  "workspace.graph.json",
  "workspace.layout.json",
  "workspace.nodes.json",
  "workspace.state.json",
]);

const WORKSPACE_TEXT_EXTS = new Set([
  ".md",
  ".markdown",
  ".txt",
  ".json",
  ".yaml",
  ".yml",
  ".js",
  ".jsx",
  ".ts",
  ".tsx",
  ".css",
  ".html",
  ".mjs",
  ".cjs",
]);

const WORKSPACE_IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);

export function resolveWorkspaceFilePath(workspaceRoot, relPath) {
  const root = path.resolve(workspaceRoot);
  const rel = String(relPath || "").replace(/^[/\\]+/, "");
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error("Path traversal not allowed");
  }
  return { root, rel: path.relative(root, abs).replace(/\\/g, "/"), abs };
}

function workspaceFileIcon(fileName, isDir = false) {
  if (isDir) return "folder";
  const ext = path.extname(fileName).toLowerCase();
  if (ext === ".md" || ext === ".markdown") return "article";
  if ([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"].includes(ext)) return "code";
  if ([".yaml", ".yml", ".json"].includes(ext)) return "data_object";
  if (ext === ".css") return "palette";
  if (ext === ".html") return "web";
  if (WORKSPACE_IMAGE_EXTS.has(ext)) return "image";
  return "draft";
}

export function workspaceDownloadContentDisposition(relPath) {
  const fallbackName = path.basename(String(relPath || "download")) || "download";
  const quotedName = fallbackName.replace(/[\r\n"\\]/g, "_");
  return `attachment; filename="${quotedName}"; filename*=UTF-8''${encodeURIComponent(fallbackName)}`;
}

const WORKSPACE_FILE_SKIP_REL_PREFIXES = [
  ".workspace/agentflow/worktrees",
  ".workspace/agentflow/git-repos",
  ".workspace/agentflow/runBuild",
  ".workspace/agentflow/composer-logs",
];

function workspacePathInside(parent, candidate) {
  const base = path.resolve(parent);
  const target = path.resolve(candidate);
  return target === base || target.startsWith(base + path.sep);
}

function shouldSkipWorkspaceFileRelPath(relPath) {
  const normalized = String(relPath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  return WORKSPACE_FILE_SKIP_REL_PREFIXES.some((prefix) => (
    normalized === prefix || normalized.startsWith(`${prefix}/`)
  ));
}

const WORKSPACE_FILES_MAX_ITEMS = 500;

function readWorkspaceFilesRecursive(dir, root, depth = 0, maxDepth = 3, budget = { count: 0 }) {
  if (depth > maxDepth) return [];
  if (depth > 0 && budget.count > WORKSPACE_FILES_MAX_ITEMS) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  entries.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const out = [];
  for (const entry of entries) {
    if (depth > 0 && budget.count > WORKSPACE_FILES_MAX_ITEMS) break;
    if (entry.name.startsWith(".") && entry.name !== ".agents" && entry.name !== ".codex") continue;
    const abs = path.join(dir, entry.name);
    const rel = path.relative(root, abs).replace(/\\/g, "/");
    if (shouldSkipWorkspaceFileRelPath(rel)) continue;
    if (entry.isDirectory()) {
      if (WORKSPACE_FILE_SKIP_DIRS.has(entry.name)) continue;
      out.push({
        type: "directory",
        name: entry.name,
        path: rel,
        icon: workspaceFileIcon(entry.name, true),
        children: budget.count > WORKSPACE_FILES_MAX_ITEMS
          ? []
          : readWorkspaceFilesRecursive(abs, root, depth + 1, maxDepth, budget),
      });
      budget.count++;
    } else if (entry.isFile()) {
      if (WORKSPACE_FILE_SKIP_FILES.has(entry.name)) continue;
      let size = 0;
      try { size = fs.statSync(abs).size; } catch {}
      budget.count++;
      out.push({ type: "file", name: entry.name, path: rel, icon: workspaceFileIcon(entry.name), size });
    }
  }
  return out;
}

export function readWorkspaceFiles(workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  return { root, files: readWorkspaceFilesRecursive(root, root) };
}

/**
 * 当前承载设计态的文件。正常是 `workspace.flow.js`；只有在往返比对没过、退回历史格式时
 * 才是 `workspace.graph.json`。API 把它回给前端，用来告诉用户「改的是哪个文件」。
 */
export function workspaceDesignPath(workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  const legacy = path.join(root, WORKSPACE_GRAPH_FILENAME);
  if (!fs.existsSync(path.join(root, FLOW_SOURCE_FILENAME)) && fs.existsSync(legacy)) return legacy;
  return path.join(root, FLOW_SOURCE_FILENAME);
}

/**
 * 设计态写 workspace.flow.js（+ layout / nodes / 外置长文本），运行态写 workspace.state.json。
 *
 * 落成代码还是历史 JSON 由存储层决定——它会把生成的代码解析回来跟原图逐字段比对，
 * 比不上就退回写 workspace.graph.json。这里只负责把降级喊出来。
 */
export function writeWorkspaceGraph(workspaceRoot, graph, marketplaceRoot = "") {
  const result = writeWorkspaceGraphFiles(workspaceRoot, graph, { marketplaceRoot });
  if (result.degradedReason) {
    log.warn(`Workspace 图无法表示成代码，已退回 ${WORKSPACE_GRAPH_FILENAME}：${result.degradedReason}`);
  }
  return result;
}

/**
 * 读回合并后的完整图。
 *
 * 设计态优先读 `workspace.flow.js`；没有就回落到历史的 `workspace.graph.json`，下一次
 * 写入自动迁移成代码。没有 `workspace.state.json` 时合并是恒等操作，所以两种历史形态
 * 都不需要迁移步骤。
 *
 * `workspace.flow.js` 解析失败会抛 `WorkspaceFlowParseError`——**不能**降级成空图：
 * 那会让下一次保存把整张流程清空。
 */
export function readWorkspaceGraph(workspaceRoot, marketplaceRoot = "") {
  const { path: designPath, graph } = readWorkspaceGraphFiles(workspaceRoot, { marketplaceRoot });
  return { path: designPath, graph };
}

const WORKSPACE_RELEASES_REL = path.join(".workspace", "agentflow", "releases");
const WORKSPACE_RELEASE_REGISTRY = "registry.json";
const WORKSPACE_RELEASE_MANIFEST = "release.json";
const WORKSPACE_RELEASE_SKIP_ROOTS = new Set([
  ".git",
  "node_modules",
  "outputs",
  "runBuild",
  "workspace.state.json",
]);

function workspaceReleasesRoot(workspaceRoot) {
  return path.join(path.resolve(workspaceRoot), WORKSPACE_RELEASES_REL);
}

function workspaceReleaseRegistryPath(workspaceRoot) {
  return path.join(workspaceReleasesRoot(workspaceRoot), WORKSPACE_RELEASE_REGISTRY);
}

function normalizeWorkspaceReleaseRegistry(value = {}) {
  const releases = Array.isArray(value?.releases)
    ? value.releases
      .filter((release) => release && /^v[1-9][0-9]*$/.test(String(release.id || "")))
      .map((release) => ({
        id: String(release.id),
        number: Math.max(1, Number(release.number || String(release.id).slice(1)) || 1),
        designRevision: String(release.designRevision || ""),
        createdAt: String(release.createdAt || ""),
        createdBy: String(release.createdBy || ""),
        notes: String(release.notes || ""),
        baseReleaseId: String(release.baseReleaseId || ""),
      }))
      .sort((a, b) => b.number - a.number)
    : [];
  const stableReleaseId = releases.some((release) => release.id === value?.stableReleaseId)
    ? String(value.stableReleaseId)
    : "";
  return {
    version: 1,
    stableReleaseId,
    nextNumber: Math.max(
      Number(value?.nextNumber || 1) || 1,
      releases.reduce((max, release) => Math.max(max, release.number + 1), 1),
    ),
    releases,
    updatedAt: String(value?.updatedAt || ""),
  };
}

function readWorkspaceReleaseRegistry(workspaceRoot) {
  const filePath = workspaceReleaseRegistryPath(workspaceRoot);
  try {
    if (!fs.existsSync(filePath)) return normalizeWorkspaceReleaseRegistry();
    return normalizeWorkspaceReleaseRegistry(JSON.parse(fs.readFileSync(filePath, "utf-8")));
  } catch {
    return normalizeWorkspaceReleaseRegistry();
  }
}

function writeWorkspaceReleaseRegistry(workspaceRoot, registry) {
  const releasesRoot = workspaceReleasesRoot(workspaceRoot);
  fs.mkdirSync(releasesRoot, { recursive: true });
  const filePath = workspaceReleaseRegistryPath(workspaceRoot);
  const tempPath = path.join(releasesRoot, `.registry-${crypto.randomUUID()}.tmp`);
  const normalized = normalizeWorkspaceReleaseRegistry({
    ...registry,
    updatedAt: new Date().toISOString(),
  });
  fs.writeFileSync(tempPath, `${JSON.stringify(normalized, null, 2)}\n`, "utf-8");
  fs.renameSync(tempPath, filePath);
  return normalized;
}

function workspaceReleaseSnapshotRoot(workspaceRoot, releaseId) {
  const id = String(releaseId || "").trim();
  if (!/^v[1-9][0-9]*$/.test(id)) return "";
  return path.join(workspaceReleasesRoot(workspaceRoot), id, "snapshot");
}

function workspaceReleaseRuntimeStatePath(workspaceRoot, releaseId) {
  const id = String(releaseId || "").trim();
  if (!/^v[1-9][0-9]*$/.test(id)) return "";
  return path.join(workspaceReleasesRoot(workspaceRoot), id, "runtime", "workspace.state.json");
}

function readWorkspaceReleaseRuntimeState(workspaceRoot, releaseId) {
  const filePath = workspaceReleaseRuntimeStatePath(workspaceRoot, releaseId);
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeWorkspaceReleaseRuntimeState(workspaceRoot, releaseId, graph) {
  const filePath = workspaceReleaseRuntimeStatePath(workspaceRoot, releaseId);
  if (!filePath) return;
  const { state } = splitWorkspaceGraph(graph || {});
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(state || { version: 1 }, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

function workspaceCopyReleaseSnapshot(sourceRoot, targetRoot, relative = "") {
  const source = relative ? path.join(sourceRoot, relative) : sourceRoot;
  const entries = fs.readdirSync(source, { withFileTypes: true });
  fs.mkdirSync(relative ? path.join(targetRoot, relative) : targetRoot, { recursive: true });
  for (const entry of entries) {
    const nextRelative = relative ? path.join(relative, entry.name) : entry.name;
    const normalized = nextRelative.replace(/\\/g, "/");
    if (!relative && WORKSPACE_RELEASE_SKIP_ROOTS.has(entry.name)) continue;
    if (normalized === ".workspace/agentflow" || normalized.startsWith(".workspace/agentflow/")) continue;
    const sourcePath = path.join(sourceRoot, nextRelative);
    const targetPath = path.join(targetRoot, nextRelative);
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      workspaceCopyReleaseSnapshot(sourceRoot, targetRoot, nextRelative);
    } else if (entry.isFile()) {
      fs.mkdirSync(path.dirname(targetPath), { recursive: true });
      try {
        fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_FICLONE);
      } catch {
        fs.copyFileSync(sourcePath, targetPath);
      }
    }
  }
}

function workspaceReleaseSummary(workspaceRoot, marketplaceRoot = "", graph = null) {
  const registry = readWorkspaceReleaseRegistry(workspaceRoot);
  const currentGraph = graph || readWorkspaceGraph(workspaceRoot, marketplaceRoot).graph;
  const draftRevision = workspaceDesignRevision(currentGraph);
  const stable = registry.releases.find((release) => release.id === registry.stableReleaseId) || null;
  return {
    enabled: Boolean(stable),
    stableReleaseId: stable?.id || "",
    stableRevision: stable?.designRevision || "",
    draftRevision,
    hasDraftChanges: Boolean(stable && stable.designRevision !== draftRevision),
    releases: registry.releases,
  };
}

export function readWorkspaceReleaseStatus(workspaceRoot, marketplaceRoot = "", graph = null) {
  return workspaceReleaseSummary(workspaceRoot, marketplaceRoot, graph);
}

export function readWorkspaceStableRelease(workspaceRoot, marketplaceRoot = "") {
  const registry = readWorkspaceReleaseRegistry(workspaceRoot);
  const release = registry.releases.find((item) => item.id === registry.stableReleaseId) || null;
  if (!release) return null;
  const root = workspaceReleaseSnapshotRoot(workspaceRoot, release.id);
  if (!root || !fs.existsSync(root)) return null;
  const designGraph = readWorkspaceGraph(root, marketplaceRoot).graph;
  const graph = mergeWorkspaceState(
    designGraph,
    readWorkspaceReleaseRuntimeState(workspaceRoot, release.id),
  );
  return { release, root, graph };
}

export function publishWorkspaceRelease(workspaceRoot, marketplaceRoot = "", options = {}) {
  const graph = readWorkspaceGraph(workspaceRoot, marketplaceRoot).graph;
  const designRevision = workspaceDesignRevision(graph);
  const expectedRevision = String(options.expectedRevision || "").trim();
  if (expectedRevision && expectedRevision !== designRevision) {
    return {
      error: "Workspace 已更新，请保存并刷新后再发布",
      conflict: "revision-mismatch",
      expectedRevision,
      currentRevision: designRevision,
    };
  }
  const registry = readWorkspaceReleaseRegistry(workspaceRoot);
  const number = registry.nextNumber;
  const releaseId = `v${number}`;
  const releasesRoot = workspaceReleasesRoot(workspaceRoot);
  const releaseRoot = path.join(releasesRoot, releaseId);
  const snapshotRoot = path.join(releaseRoot, "snapshot");
  const tempRoot = path.join(releasesRoot, `.publish-${releaseId}-${crypto.randomUUID()}`);
  const tempSnapshotRoot = path.join(tempRoot, "snapshot");
  const now = new Date().toISOString();
  const release = {
    id: releaseId,
    number,
    designRevision,
    createdAt: now,
    createdBy: String(options.createdBy || ""),
    notes: String(options.notes || "").trim().slice(0, 2000),
    baseReleaseId: registry.stableReleaseId || "",
  };
  let releaseInstalled = false;
  let registryCommitted = false;
  fs.mkdirSync(releasesRoot, { recursive: true });
  try {
    workspaceCopyReleaseSnapshot(path.resolve(workspaceRoot), tempSnapshotRoot);
    const { design } = splitWorkspaceGraph(graph);
    writeWorkspaceGraph(tempSnapshotRoot, design, marketplaceRoot);
    fs.writeFileSync(path.join(tempRoot, WORKSPACE_RELEASE_MANIFEST), `${JSON.stringify(release, null, 2)}\n`, "utf-8");
    if (fs.existsSync(releaseRoot)) throw new Error(`Release already exists: ${releaseId}`);
    fs.renameSync(tempRoot, releaseRoot);
    releaseInstalled = true;
    const nextRegistry = writeWorkspaceReleaseRegistry(workspaceRoot, {
      ...registry,
      stableReleaseId: releaseId,
      nextNumber: number + 1,
      releases: [release, ...registry.releases],
    });
    registryCommitted = true;
    return {
      ok: true,
      release,
      status: workspaceReleaseSummary(workspaceRoot, marketplaceRoot, graph),
      registry: nextRegistry,
      snapshotRoot,
    };
  } catch (error) {
    try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
    if (releaseInstalled && !registryCommitted) {
      try { fs.rmSync(releaseRoot, { recursive: true, force: true }); } catch {}
    }
    throw error;
  }
}

export function rollbackWorkspaceRelease(workspaceRoot, releaseId, marketplaceRoot = "") {
  const registry = readWorkspaceReleaseRegistry(workspaceRoot);
  const release = registry.releases.find((item) => item.id === String(releaseId || "").trim()) || null;
  const snapshotRoot = release ? workspaceReleaseSnapshotRoot(workspaceRoot, release.id) : "";
  if (!release || !snapshotRoot || !fs.existsSync(snapshotRoot)) {
    return { error: "Release not found" };
  }
  writeWorkspaceReleaseRegistry(workspaceRoot, { ...registry, stableReleaseId: release.id });
  return {
    ok: true,
    release,
    status: workspaceReleaseSummary(workspaceRoot, marketplaceRoot),
  };
}

const DISPLAY_SHARE_FILENAME = "display-shares.json";

const DISPLAY_SHARE_ALLOWED_EXPIRY_DAYS = new Set([1, 7, 30, 90, 365]);

export const USER_WORKSPACES_FILENAME = "workspaces.json";

export function workspacesPath() {
  return path.join(getAgentflowDataRoot(), USER_WORKSPACES_FILENAME);
}

function defaultWorkspaceGitPath(id) {
  return path.join(getAgentflowDataRoot(), "workspaces", "repos", id);
}

function legacyDefaultWorkspaceGitPath(userCtx = {}, id = "") {
  return path.join(getAgentflowUserDataRoot(userCtx.userId || ""), "workspaces", "repos", id);
}

function isLegacyDefaultWorkspaceGitPath(rawPath = "", id = "", userCtx = {}) {
  const raw = String(rawPath || "").trim();
  if (!raw || !id) return false;
  try {
    return path.resolve(raw.replace(/^~(?=$|\/|\\)/, os.homedir())) === path.resolve(legacyDefaultWorkspaceGitPath(userCtx, id));
  } catch {
    return false;
  }
}

function workspaceRepoNameFromUrl(repoUrl = "") {
  const raw = String(repoUrl || "").trim();
  if (!raw) return "";
  let pathname = raw;
  try {
    pathname = new URL(raw).pathname;
  } catch {
    pathname = raw.split("?")[0].split("#")[0];
  }
  const name = pathname.replace(/\/+$/, "").split("/").filter(Boolean).pop() || "";
  return name
    .replace(/\.git$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export function normalizeWorkspaceEntry(entry = {}, index = 0, userCtx = {}) {
  const label = String(entry?.label || entry?.name || "").trim();
  const kindRaw = String(entry?.kind || entry?.source || "").trim().toLowerCase();
  const repoUrl = String(entry?.repoUrl || entry?.gitUrl || entry?.url || "").trim();
  const kind = kindRaw === "git" || repoUrl ? "git" : "local";
  const branch = String(entry?.branch || "master").trim() || "master";
  const mountPathRaw = String(entry?.mountPath || "").trim();
  const rawPath = String(entry?.path || entry?.cwd || "").trim();
  if (!rawPath && kind !== "git") return null;
  const idRaw = String(entry?.id || label || mountPathRaw || repoUrl || rawPath || `workspace_${index + 1}`).trim().toLowerCase();
  const id = idRaw.replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64) || `workspace_${index + 1}`;
  const suggestedMountPath = kind === "git" ? workspaceRepoNameFromUrl(repoUrl) : "";
  const mountPath = (mountPathRaw || suggestedMountPath || id).replace(/^\/+/, "").replace(/\.\.(\/|\\|$)/g, "").trim() || id;
  const defaultGitPath = defaultWorkspaceGitPath(id);
  const explicitPath = kind === "git" && isLegacyDefaultWorkspaceGitPath(rawPath, id, userCtx) ? "" : rawPath;
  const absPath = path.resolve((explicitPath || defaultGitPath).replace(/^~(?=$|\/|\\)/, os.homedir()));
  const exists = fs.existsSync(absPath) && fs.statSync(absPath).isDirectory();
  return {
    id,
    label: label || path.basename(absPath) || id,
    kind,
    path: absPath,
    repoUrl,
    branch,
    mountPath,
    credentialRef: String(entry?.credentialRef || "").trim(),
    type: String(entry?.type || (kind === "git" ? "code" : "local")).trim() || (kind === "git" ? "code" : "local"),
    description: String(entry?.description || "").trim(),
    visibility: String(entry?.visibility || "personal").trim() || "personal",
    enabled: entry?.enabled !== false,
    exists,
  };
}

export function readWorkspacesFromPath(p, userCtx = {}) {
  if (!fs.existsSync(p)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    const list = Array.isArray(data?.workspaces) ? data.workspaces : Array.isArray(data) ? data : [];
    return list.map((entry, index) => normalizeWorkspaceEntry(entry, index, userCtx)).filter(Boolean);
  } catch {
    return [];
  }
}

function legacyUserWorkspacesPath(userCtx = {}) {
  return path.join(getAgentflowUserDataRoot(userCtx.userId || ""), USER_WORKSPACES_FILENAME);
}

function readLegacyAdminWorkspaces(userCtx = {}) {
  const users = readAuthUsers();
  const candidates = [];
  for (const [userId, user] of Object.entries(users || {})) {
    if (user?.isAdmin) candidates.push(String(userId || ""));
  }
  if (userCtx?.isAdmin && userCtx.userId) candidates.unshift(String(userCtx.userId));
  const seenPaths = new Set();
  const seenEntries = new Set();
  const out = [];
  for (const userId of candidates) {
    const p = legacyUserWorkspacesPath({ userId });
    const resolved = path.resolve(p);
    if (seenPaths.has(resolved) || resolved === path.resolve(workspacesPath())) continue;
    seenPaths.add(resolved);
    for (const entry of readWorkspacesFromPath(p, { userId })) {
      const key = entry.id || entry.path || entry.repoUrl;
      if (seenEntries.has(key)) continue;
      seenEntries.add(key);
      out.push(entry);
    }
  }
  return out;
}

/** The same authenticated Workspace catalog used by GET /api/workspaces. */
export function readUserWorkspaces(userCtx = {}) {
  const globalPath = workspacesPath();
  const globalWorkspaces = fs.existsSync(globalPath) ? readWorkspacesFromPath(globalPath, userCtx) : [];
  const adminLegacy = readLegacyAdminWorkspaces(userCtx);
  if (globalWorkspaces.length || adminLegacy.length) {
    const seen = new Set();
    const out = [];
    for (const entry of [...globalWorkspaces, ...adminLegacy]) {
      const key = entry.id || entry.path || entry.repoUrl;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(entry);
    }
    return out;
  }
  return readWorkspacesFromPath(legacyUserWorkspacesPath(userCtx), userCtx);
}

export function listConfiguredWorkspaces(root, scopedRoot, userCtx = {}) {
  const currentRoot = path.resolve(scopedRoot || root);
  const homeRoot = path.resolve(os.homedir());
  const builtins = [
    { id: "current", label: "当前流程工作区", kind: "local", path: currentRoot, builtin: true, exists: fs.existsSync(currentRoot) && fs.statSync(currentRoot).isDirectory(), type: "flow", enabled: true },
    { id: "home", label: "用户 Home", kind: "local", path: homeRoot, builtin: true, exists: fs.existsSync(homeRoot) && fs.statSync(homeRoot).isDirectory(), type: "local", enabled: true },
  ];
  const custom = readUserWorkspaces(userCtx).filter((entry) => entry.enabled !== false).map((entry) => ({ ...entry, builtin: false }));
  const seen = new Set();
  return [...builtins, ...custom].filter((entry) => {
    const key = path.resolve(entry.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function workspaceRepoUrlWithCredential(repoUrl = "", credential = "") {
  const token = String(credential || "").trim();
  if (!token) return String(repoUrl || "").trim();
  try {
    const u = new URL(String(repoUrl || "").trim());
    if (!/^https?:$/.test(u.protocol)) return String(repoUrl || "").trim();
    if (!u.username) u.username = "oauth2";
    u.password = token;
    return u.toString();
  } catch {
    return String(repoUrl || "").trim();
  }
}

function displaySharesPath() {
  return path.join(getAgentflowDataRoot(), DISPLAY_SHARE_FILENAME);
}

export function readDisplayShares() {
  const file = displaySharesPath();
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, "utf-8");
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

export function writeDisplayShares(shares) {
  const file = displaySharesPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(shares && typeof shares === "object" ? shares : {}, null, 2) + "\n", "utf-8");
}

const RUN_LEDGER_STALE_MS = 6 * 60 * 60 * 1000;

export function runStatusBucket(status) {
  const s = String(status || "unknown");
  if (s === "success" || s === "failed" || s === "running" || s === "stopped" || s === "interrupted") return s;
  return "unknown";
}

export function appendWorkspaceRunStarted(record) {
  appendRunLedgerEvent({
    ...record,
    type: "run_started",
    kind: "workspace",
    at: Number(record.startedAt || record.at || Date.now()),
  });
}

export function appendWorkspaceRunFinished(record, status) {
  appendRunLedgerEvent({
    ...record,
    type: "run_finished",
    kind: "workspace",
    at: Number(record.startedAt || record.at || Date.now()),
    endedAt: Number(record.endedAt || Date.now()),
    durationMs: Math.max(0, Number(record.durationMs || (Number(record.endedAt || Date.now()) - Number(record.startedAt || record.at || Date.now())))),
    status,
  });
  recordMarketplaceRunUsage(record.workspaceRoot || record.root || "", record.marketplaceResources || [], {
    ...record,
    status,
  });
  emitRepositoryRunFinished(record.workspaceRoot || record.root || "", record, status);
}

function normalizeWorkspaceUsageRecord(parsed, source = "workspace-run") {
  const userId = String(parsed?.userId || "").trim();
  const flowId = String(parsed?.flowId || "").trim();
  const at = Number(parsed?.at || parsed?.startedAt || 0);
  if (!userId || !flowId || !Number.isFinite(at) || at <= 0) return null;
  return {
    userId,
    username: String(parsed?.username || userId),
    flowId,
    flowSource: String(parsed?.flowSource || "user"),
    runNodeId: String(parsed?.runNodeId || ""),
    runId: String(parsed?.runId || ""),
    at,
    endedAt: parsed?.endedAt == null ? null : Number(parsed.endedAt),
    durationMs: Math.max(0, Number(parsed?.durationMs || 0)),
    status: runStatusBucket(parsed?.status),
    source,
  };
}

function readLegacyWorkspaceRunUsageRecords() {
  const filePath = path.join(getAgentflowDataRoot(), "admin", "workspace-run-usage.jsonl");
  if (!fs.existsSync(filePath)) return [];
  let items = [];
  try {
    items = fs.readFileSync(filePath, "utf-8")
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    items = [];
  }
  return items
    .map((item) => normalizeWorkspaceUsageRecord(item, "workspace-run-legacy"))
    .filter(Boolean);
}

function readWorkspaceRunLedgerRecords(options = {}) {
  const byRunId = new Map();
  for (const event of readRunLedgerEvents(options)) {
    if (String(event?.kind || "") !== "workspace") continue;
    const runId = String(event?.runId || "").trim();
    if (!runId) continue;
    const existing = byRunId.get(runId) || {};
    if (event.type === "run_started") {
      byRunId.set(runId, {
        ...existing,
        ...event,
        runId,
        at: Number(event.at || existing.at || Date.now()),
        status: existing.status || "running",
      });
    } else if (event.type === "run_finished") {
      byRunId.set(runId, {
        ...existing,
        ...event,
        runId,
        at: Number(existing.at || event.at || Date.now()),
        endedAt: event.endedAt == null ? null : Number(event.endedAt),
        durationMs: Math.max(0, Number(event.durationMs || 0)),
        status: runStatusBucket(event.status),
      });
    }
  }
  const now = Date.now();
  return Array.from(byRunId.values())
    .map((item) => {
      const at = Number(item?.at || 0);
      const status = runStatusBucket(item?.status);
      if (status === "running" && at > 0 && now - at > RUN_LEDGER_STALE_MS) {
        return {
          ...item,
          endedAt: Number(item?.endedAt || at + RUN_LEDGER_STALE_MS),
          durationMs: Math.max(0, Number(item?.durationMs || Math.min(now - at, RUN_LEDGER_STALE_MS))),
          status: "interrupted",
        };
      }
      return item;
    })
    .map((item) => normalizeWorkspaceUsageRecord(item, "workspace-run-ledger"))
    .filter(Boolean);
}

export function readWorkspaceRunUsageRecords(options = {}) {
  const sinceMs = Number(options?.sinceMs || 0);
  return [
    ...readLegacyWorkspaceRunUsageRecords(),
    ...readWorkspaceRunLedgerRecords(options),
  ].filter((run) => !Number.isFinite(sinceMs) || sinceMs <= 0 || Number(run?.at || 0) >= sinceMs);
}

export function activeWorkspaceRunUsageRecords() {
  const out = [];
  for (const entry of activeWorkspaceRuns.values()) {
    const userId = String(entry?.userId || "").trim();
    const flowId = String(entry?.flowId || "").trim();
    const at = Number(entry?.startedAt || 0);
    if (!userId || !flowId || !Number.isFinite(at) || at <= 0) continue;
    out.push({
      userId,
      username: String(entry?.username || userId),
      flowId,
      flowSource: String(entry?.flowSource || "user"),
      runId: String(entry?.runId || ""),
      at,
      endedAt: null,
      durationMs: Math.max(0, Date.now() - at),
      status: "running",
      source: "workspace-run-active",
    });
  }
  return out;
}

function createDisplayShareId() {
  return crypto.randomBytes(12).toString("base64url");
}

export function normalizeDisplayShareExpiry(input = {}, now = new Date()) {
  const mode = String(input?.expiresMode || input?.expiryMode || "").trim().toLowerCase();
  const rawDays = Number(input?.expiresInDays ?? input?.expiryDays ?? input?.ttlDays);
  if (
    mode === "permanent" ||
    mode === "forever" ||
    input?.permanent === true ||
    input?.expiresAt === null ||
    String(input?.expiresAt || "").trim().toLowerCase() === "permanent"
  ) {
    return { expiresAt: "", expiresMode: "permanent", expiresInDays: null };
  }
  let days = Number.isFinite(rawDays) ? Math.round(rawDays) : 30;
  if (!DISPLAY_SHARE_ALLOWED_EXPIRY_DAYS.has(days)) days = 30;
  const time = now instanceof Date ? now.getTime() : Date.now();
  return {
    expiresAt: new Date(time + days * 24 * 60 * 60 * 1000).toISOString(),
    expiresMode: "days",
    expiresInDays: days,
  };
}

export function normalizeDisplayShareNodeIds(ids, graph) {
  const out = [];
  const seen = new Set();
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  for (const rawId of Array.isArray(ids) ? ids : []) {
    const id = String(rawId || "").trim();
    if (!id || seen.has(id)) continue;
    const instance = instances[id];
    if (!workspaceDisplayKindFromInstance(instance)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

export function workspaceDisplayContentFromInstance(instance, kind = "") {
  const slots = [...(Array.isArray(instance?.input) ? instance.input : []), ...(Array.isArray(instance?.output) ? instance.output : [])];
  const primaryName = kind === "image" ? "src" : "content";
  const slotText = (slot) => workspaceSlotValue(slot);
  const hasSlotText = (slot) => slotText(slot).trim();
  const contentSlot =
    slots.find((slot) => String(slot?.name || "") === primaryName && hasSlotText(slot)) ||
    slots.find((slot) => String(slot?.name || "") === "result" && hasSlotText(slot)) ||
    slots.find((slot) => String(slot?.name || "") === "filePath" && hasSlotText(slot)) ||
    slots.find((slot) => String(slot?.type || "") === "text" && hasSlotText(slot));
  const slotContent = contentSlot ? slotText(contentSlot) : "";
  return String(isWorkspaceOneClickTaskDefinitionId(instance?.definitionId) ? slotContent : (instance?.body || slotContent));
}

function normalizeDisplayShareLayout(layout, fallback = "canvas") {
  const text = String(layout || "").trim();
  return ["canvas", "gallery", "slides", "document", "single"].includes(text) ? text : fallback;
}

export function createDisplayShareRecord({ userId, flowId, flowSource, archived, title, layout, nodeIds, expiresMode, expiresInDays, permanent, expiresAt, visibility = "public" }) {
  const shares = readDisplayShares();
  let id = createDisplayShareId();
  while (shares[id]) id = createDisplayShareId();
  const nowDate = new Date();
  const now = nowDate.toISOString();
  const expiry = normalizeDisplayShareExpiry({ expiresMode, expiresInDays, permanent, expiresAt }, nowDate);
  const share = {
    id,
    userId: String(userId || ""),
    flowId: String(flowId || ""),
    flowSource: String(flowSource || "user"),
    archived: archived === true,
    title: String(title || "").trim() || "AgentFlow Display",
    layout: normalizeDisplayShareLayout(layout, "canvas"),
    nodeIds: Array.isArray(nodeIds) ? nodeIds : [],
    visibility: String(visibility || "").trim().toLowerCase() === "private" ? "private" : "public",
    createdAt: now,
    updatedAt: now,
    expiresAt: expiry.expiresAt,
    expiresMode: expiry.expiresMode,
    expiresInDays: expiry.expiresInDays,
  };
  shares[id] = share;
  writeDisplayShares(shares);
  return share;
}

function parseDisplayShareNodeIdInput(value) {
  return String(value || "")
    .split(/[\s,，]+/g)
    .map((id) => id.trim())
    .filter(Boolean);
}

function inferUpstreamDisplayNodeIds(graph, nodeId) {
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const ids = [];
  const seen = new Set();
  for (const edge of edges) {
    if (String(edge?.target || "") !== String(nodeId || "")) continue;
    const sourceId = String(edge?.source || "").trim();
    if (!sourceId || seen.has(sourceId)) continue;
    if (!workspaceDisplayKind(instances[sourceId]?.definitionId)) continue;
    seen.add(sourceId);
    ids.push(sourceId);
  }
  return ids;
}

export function displayShareOutputUrl(shareId, baseUrl = "") {
  const pathPart = `/display/${encodeURIComponent(String(shareId || ""))}`;
  const base = String(baseUrl || "").trim();
  if (!base) return pathPart;
  try {
    return new URL(pathPart, base.endsWith("/") ? base : `${base}/`).href;
  } catch {
    return pathPart;
  }
}

function normalizeRunEnvKey(key) {
  const text = String(key || "").trim();
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(text) ? text : "";
}

function parseRunEnvAssignments(raw = "") {
  const text = String(raw || "").trim();
  if (!text) return {};
  if (text.startsWith("{")) {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Run Env JSON must be an object");
    const out = {};
    for (const [key, value] of Object.entries(parsed)) {
      const normalizedKey = normalizeRunEnvKey(key);
      if (!normalizedKey) throw new Error(`Invalid env key: ${key}`);
      out[normalizedKey] = String(value ?? "");
    }
    return out;
  }
  const out = {};
  for (const line of text.split(/\r?\n/g)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const normalized = trimmed.replace(/^export\s+/i, "");
    const eq = normalized.indexOf("=");
    if (eq <= 0) throw new Error(`Invalid env assignment: ${trimmed}`);
    const key = normalizeRunEnvKey(normalized.slice(0, eq));
    if (!key) throw new Error(`Invalid env key: ${normalized.slice(0, eq).trim()}`);
    out[key] = normalized.slice(eq + 1);
  }
  return out;
}

function normalizeWorkspaceGraphPayload(payload) {
  const graph = payload?.graph && typeof payload.graph === "object" ? payload.graph : payload;
  return {
    version: 1,
    instances: graph?.instances && typeof graph.instances === "object" && !Array.isArray(graph.instances) ? graph.instances : {},
    edges: Array.isArray(graph?.edges) ? graph.edges : [],
    ui: graph?.ui && typeof graph.ui === "object" ? graph.ui : { nodePositions: {} },
    subflows: graph?.subflows && typeof graph.subflows === "object" && !Array.isArray(graph.subflows) ? graph.subflows : {},
    updatedAt: new Date().toISOString(),
  };
}

export function workspaceRunTouchedNodeIds(result) {
  const ids = new Set();
  // A deferred run has only executed the prefix ending at the waiting node. Merging the
  // complete plan here would overwrite unrelated edits made while Jenkins is running.
  if (!result?.deferred && !(Array.isArray(result?.pauseNodeIds) && result.pauseNodeIds.length)) {
    for (const id of Array.isArray(result?.order) ? result.order : []) {
      const text = String(id || "").trim();
      if (text) ids.add(text);
    }
  }
  for (const event of Array.isArray(result?.events) ? result.events : []) {
    const nodeId = String(event?.nodeId || "").trim();
    if (nodeId) ids.add(nodeId);
    for (const displayId of Array.isArray(event?.displayNodeIds) ? event.displayNodeIds : []) {
      const text = String(displayId || "").trim();
      if (text) ids.add(text);
    }
  }
  return ids;
}

export function mergeWorkspaceRunGraph(currentGraph, runGraph, touchedIds) {
  const current = normalizeWorkspaceGraphPayload(currentGraph || {});
  const run = normalizeWorkspaceGraphPayload(runGraph || {});
  const ids = touchedIds instanceof Set ? touchedIds : new Set(touchedIds || []);
  const instances = { ...(current.instances || {}) };
  for (const id of ids) {
    if (run.instances && Object.prototype.hasOwnProperty.call(run.instances, id)) {
      instances[id] = run.instances[id];
    }
  }
  return {
    ...current,
    version: 1,
    instances,
    edges: Array.isArray(current.edges) ? current.edges : [],
    ui: current.ui && typeof current.ui === "object" ? current.ui : { nodePositions: {} },
    updatedAt: new Date().toISOString(),
  };
}

function mergeWorkspaceRunState(currentGraph, runGraph, touchedIds) {
  const currentSplit = splitWorkspaceGraph(currentGraph || {});
  const runSplit = splitWorkspaceGraph(runGraph || {});
  const ids = touchedIds instanceof Set ? touchedIds : new Set(touchedIds || []);
  const state = JSON.parse(JSON.stringify(currentSplit.state || { version: 1 }));
  for (const key of ["inputs", "outputs", "displayBodies", "displayReloadKeys", "fingerprints"]) {
    const currentBucket = state[key] && typeof state[key] === "object" ? state[key] : {};
    const runBucket = runSplit.state?.[key] && typeof runSplit.state[key] === "object" ? runSplit.state[key] : {};
    for (const nodeId of ids) {
      if (Object.prototype.hasOwnProperty.call(runBucket, nodeId)) currentBucket[nodeId] = runBucket[nodeId];
      else delete currentBucket[nodeId];
    }
    if (Object.keys(currentBucket).length) state[key] = currentBucket;
    else delete state[key];
  }
  return mergeWorkspaceState(currentSplit.design, state);
}

export function mergeWorkspacePersistentNodeRefs(incomingGraph, currentGraph) {
  const incoming = normalizeWorkspaceGraphPayload(incomingGraph || {});
  const current = normalizeWorkspaceGraphPayload(currentGraph || {});
  const instances = { ...(incoming.instances || {}) };
  for (const [id, currentInstance] of Object.entries(current.instances || {})) {
    const nextInstance = instances[id];
    if (!nextInstance || typeof nextInstance !== "object") continue;
    for (const key of ["scriptRef", "implementationRef", "implementationMode"]) {
      const currentValue = currentInstance?.[key];
      const nextValue = nextInstance?.[key];
      if (currentValue != null && String(currentValue).trim() && (nextValue == null || !String(nextValue).trim())) {
        nextInstance[key] = currentValue;
      }
    }
  }
  return { ...incoming, instances };
}

function hydrateWorkspaceNodeRefsFromFiles(scopedRoot, graph) {
  const next = normalizeWorkspaceGraphPayload(graph || {});
  const instances = { ...(next.instances || {}) };
  let changed = false;
  for (const [nodeId, instance] of Object.entries(instances)) {
    if (!instance || typeof instance !== "object") continue;
    const defId = String(instance.definitionId || "");
    if (defId === "workspace_run" || defId === "workspace_scheduled_run") continue;
    if (!String(instance.implementationRef || "").trim()) {
      const implementationRef = workspaceDefaultImplementationRef(nodeId);
      const abs = workspaceResolveFlowFile(scopedRoot, implementationRef, "implementationRef");
      if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
        instances[nodeId] = { ...instance, implementationRef };
        changed = true;
      }
    }
  }
  return changed ? { ...next, instances } : next;
}

function workspaceMergeSlotsWithDefinitionMeta(slots, definitionSlots) {
  const current = Array.isArray(slots) ? slots : [];
  const defs = Array.isArray(definitionSlots) ? definitionSlots : [];
  const byName = new Map(defs.map((slot) => [String(slot?.name || ""), slot]));
  return current.map((slot, index) => {
    const def = byName.get(String(slot?.name || "")) || defs[index] || null;
    if (!def) return slot;
    const next = { ...slot };
    for (const key of ["type", "name", "description", "required", "showOnNode"]) {
      if (next[key] == null || String(next[key]).trim?.() === "") {
        if (def[key] != null) next[key] = def[key];
      }
    }
    return next;
  });
}

function hydrateWorkspaceSlotMetaFromDefinitions(workspaceRoot, scoped = {}, graph = {}, userCtx = {}) {
  const next = normalizeWorkspaceGraphPayload(graph || {});
  let definitions = [];
  try {
    definitions = listNodesJson(workspaceRoot, scoped.flowId || "", scoped.flowSource || "user", {
      archived: scoped.archived === true,
      userId: userCtx?.userId || "",
    }).nodes || [];
  } catch {
    definitions = [];
  }
  if (!definitions.length) return next;
  const defById = new Map(definitions.map((def) => [String(def?.id || ""), def]));
  const instances = { ...(next.instances || {}) };
  let changed = false;
  for (const [nodeId, instance] of Object.entries(instances)) {
    if (!instance || typeof instance !== "object") continue;
    const def = defById.get(String(instance.definitionId || ""));
    if (!def) continue;
    const input = workspaceMergeSlotsWithDefinitionMeta(instance.input, def.inputs);
    const output = workspaceMergeSlotsWithDefinitionMeta(instance.output, def.outputs);
    if (JSON.stringify(input) !== JSON.stringify(instance.input || []) || JSON.stringify(output) !== JSON.stringify(instance.output || [])) {
      instances[nodeId] = { ...instance, input, output };
      changed = true;
    }
  }
  return changed ? { ...next, instances } : next;
}

function workspaceRuntimeInterpreterForMarketplaceEntry(runtime, entry) {
  const language = String(runtime?.language || "").trim().toLowerCase();
  const entryLower = String(entry || "").trim().toLowerCase();
  if (language.includes("python") || entryLower.endsWith(".py")) return "python3";
  if (language.includes("shell") || language === "bash" || entryLower.endsWith(".sh") || entryLower.endsWith(".bash")) return "bash";
  return "node";
}

function workspaceRuntimeArgForMarketplace(arg) {
  const text = String(arg ?? "").trim();
  if (!text) return "";
  if (text.includes("${")) return text;
  return workspaceShellQuote(text);
}

const NODE_PACKAGE_BOOTSTRAP = path.join(path.dirname(fileURLToPath(import.meta.url)), "node-package-bootstrap.mjs");

function workspaceMarketplaceRuntimeCommand(resolved) {
  const runtime = resolved?.runtime && typeof resolved.runtime === "object" ? resolved.runtime : {};
  const entry = String(runtime.entry || "").trim().replace(/^\/+/, "");
  if (entry && resolved?.packageDir) {
    const entryAbs = path.resolve(resolved.packageDir, ...entry.split(/[\\/]+/).filter(Boolean));
    const packageRoot = path.resolve(resolved.packageDir);
    const packageRootWithSep = packageRoot.endsWith(path.sep) ? packageRoot : `${packageRoot}${path.sep}`;
    if (entryAbs === packageRoot || !entryAbs.startsWith(packageRootWithSep)) return "";
    const args = Array.isArray(runtime.args) ? runtime.args.map(workspaceRuntimeArgForMarketplace).filter(Boolean) : [];
    // mode: module 的包，入口是「声明 + export run」的模块而不是脚本，直接跑只会定义完就退出；
    // 交给 bootstrap 把 env 契约翻译成 run(inputs, outputs, dirs) 的调用。
    if (String(runtime.mode || "").trim().toLowerCase() === "module") {
      return ["node", workspaceShellQuote(NODE_PACKAGE_BOOTSTRAP), workspaceShellQuote(entryAbs), ...args].join(" ");
    }
    return [workspaceRuntimeInterpreterForMarketplaceEntry(runtime, entry), workspaceShellQuote(entryAbs), ...args].join(" ");
  }
  return String(runtime.command || "").trim();
}

function hydrateWorkspaceMarketplaceToolNodejsRuntime(workspaceRoot, scoped = {}, graph = {}, userCtx = {}) {
  const next = normalizeWorkspaceGraphPayload(graph || {});
  const instances = { ...(next.instances || {}) };
  let changed = false;
  for (const [nodeId, instance] of Object.entries(instances)) {
    if (!instance || typeof instance !== "object") continue;
    const marketplaceDefId = String(instance.marketplaceRef || instance.definitionId || "").trim();
    if (!marketplaceDefId.startsWith("marketplace:")) continue;
    let resolved = null;
    try {
      resolved = resolveMarketplaceNodePackage(
        workspaceRoot,
        scoped.root || scoped.scopedRoot || workspaceRoot,
        marketplaceDefId,
        next,
        { userId: userCtx?.userId || "" },
      );
    } catch {
      resolved = null;
    }
    if (!resolved || String(resolved.baseDefinitionId || "").trim() !== "tool_nodejs") continue;
    const script = String(instance.script || "").trim();
    const scriptRef = String(instance.scriptRef || "").trim();
    const runtimeScript = script || scriptRef ? "" : workspaceMarketplaceRuntimeCommand(resolved);
    instances[nodeId] = {
      ...instance,
      definitionId: "tool_nodejs",
      marketplaceRef: resolved.resolvedDefinitionId || marketplaceDefId,
      marketplacePackageId: resolved.id,
      marketplaceVersion: resolved.version,
      ...(runtimeScript ? { script: runtimeScript } : {}),
    };
    changed = true;
  }
  return changed ? { ...next, instances } : next;
}

export function hydrateWorkspaceGraphForRuntime(workspaceRoot, scoped = {}, graph = {}, userCtx = {}) {
  const flowDir = scoped.root || scoped.scopedRoot || workspaceRoot;
  const withRefs = hydrateWorkspaceNodeRefsFromFiles(flowDir, graph);
  const withMarketplaceRuntime = hydrateWorkspaceMarketplaceToolNodejsRuntime(workspaceRoot, scoped, withRefs, userCtx);
  const hydrated = hydrateWorkspaceSlotMetaFromDefinitions(workspaceRoot, scoped, withMarketplaceRuntime, userCtx);
  return hydrateWorkspaceRunFingerprints(flowDir, hydrated);
}

/**
 * 用磁盘上记录的指纹覆盖图里的 `runFingerprint`。
 *
 * 计划和运行两条路都经过 hydrate，所以这里是唯一的收口。覆盖而不是补齐：客户端提交的那份
 * 一律不作数，磁盘上没有记录的节点就把字段抹掉——「没跑过」比「跑过但指纹存疑」更安全，
 * 判定会落到重跑那边。
 */
function hydrateWorkspaceRunFingerprints(flowDir, graph) {
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : null;
  if (!instances) return graph;
  let recorded = {};
  try {
    recorded = readWorkspaceRunFingerprints(flowDir);
  } catch {
    return graph;
  }
  const next = {};
  for (const [nodeId, instance] of Object.entries(instances)) {
    if (!instance || typeof instance !== "object") {
      next[nodeId] = instance;
      continue;
    }
    const fp = recorded[nodeId];
    if (fp) next[nodeId] = { ...instance, runFingerprint: fp };
    else if (instance.runFingerprint !== undefined) {
      const copy = { ...instance };
      delete copy.runFingerprint;
      next[nodeId] = copy;
    } else next[nodeId] = instance;
  }
  return { ...graph, instances: next };
}

export function adminWorkspaceOwnerSummary(ownerId = "") {
  const id = String(ownerId || "").trim();
  if (!id) return null;
  const users = readAuthUsers();
  const knownUserIds = new Set([
    ...Object.keys(users || {}),
    ...listAgentflowUserIds(),
  ].map((value) => String(value || "").trim()).filter(Boolean));
  if (!knownUserIds.has(id)) return null;
  return {
    userId: id,
    username: String(users?.[id]?.username || id),
  };
}

export function workspaceScopedUserContext(scoped = {}, userCtx = {}) {
  if (!scoped.adminReadonly || !scoped.ownerUserId) return userCtx;
  return {
    ...userCtx,
    userId: scoped.ownerUserId,
    adminOwnerId: "",
  };
}

export function resolveWorkspaceScopeRoot(workspaceRoot, params = {}, opts = {}) {
  const flowId = params.flowId != null ? String(params.flowId).trim() : "";
  if (!flowId) return { root: path.resolve(workspaceRoot), flowId: "", flowSource: "", archived: false };
  const flowSource = params.flowSource != null && String(params.flowSource).trim()
    ? String(params.flowSource).trim()
    : "user";
  const archived = params.archived === true || params.archived === "1" || params.flowArchived === true;
  if (!isValidFlowSourceRead(flowSource)) {
    return { root: "", error: "Invalid flowSource" };
  }
  const adminOwnerId = String(params.adminOwnerId || opts.adminOwnerId || "").trim();
  if (adminOwnerId) {
    if (opts.isAdmin !== true) {
      return { root: "", error: "Admin permission required", status: 403 };
    }
    if (!["user", "workspace"].includes(flowSource)) {
      return { root: "", error: "Admin read-only review only supports user or shared Workspaces", status: 400 };
    }
    const collaboration = flowSource === "workspace"
      ? getWorkspaceCollaborationByFlow(flowId, archived)
      : null;
    const owner = adminWorkspaceOwnerSummary(collaboration?.ownerId || adminOwnerId);
    if (!owner) {
      return { root: "", error: "Workspace owner not found", status: 404 };
    }
    let targetPath = "";
    let physicalFlowSource = flowSource;
    if (flowSource === "user") {
      const targetFlow = listFlowsJson(workspaceRoot, { userId: owner.userId })
        .find((flow) => (
          flow.id === flowId
          && (flow.source || "user") === "user"
          && Boolean(flow.archived) === archived
        ));
      targetPath = targetFlow?.path || "";
    } else {
      physicalFlowSource = collaboration?.projectSource || collaboration?.flowSource || "workspace";
      const result = getPipelineFiles(workspaceRoot, flowId, physicalFlowSource, archived, {
        ...opts,
        userId: owner.userId,
      });
      targetPath = result?.path || "";
    }
    if (!targetPath) {
      return { root: "", error: "Pipeline workspace not found", status: 404 };
    }
    return {
      root: path.resolve(targetPath),
      flowId,
      flowSource: physicalFlowSource,
      requestedFlowSource: flowSource,
      workspaceId: collaboration?.id || "",
      archived,
      collaboration,
      collaborationAccess: {
        allowed: true,
        writable: false,
        runnable: false,
        role: "admin-viewer",
      },
      adminReadonly: true,
      ownerUserId: owner.userId,
      ownerUsername: owner.username,
    };
  }
  const workspaceId = String(params.workspaceId || "").trim();
  let collaboration = getWorkspaceCollaborationForProject({
    workspaceId,
    flowId,
    flowSource,
    archived,
    ownerId: workspaceId ? "" : opts.userId,
  });
  if (!collaboration && !workspaceId) {
    collaboration = listWorkspaceCollaborationsForUser(opts.userId).find((record) => (
      record.flowId === flowId
      && record.archived === archived
      && (record.projectSource || record.flowSource || "workspace") === flowSource
    )) || null;
  }
  if (!collaboration && flowSource === "workspace") {
    collaboration = getWorkspaceCollaborationByFlow(flowId, archived);
  }
  if (collaboration) {
    const access = workspaceCollaborationAccess(collaboration, opts.userId);
    if (!access.allowed) {
      return { root: "", error: "Workspace collaboration permission denied", status: 403 };
    }
  }
  const physicalFlowSource = collaboration?.projectSource || collaboration?.flowSource || flowSource;
  const physicalOpts = collaboration && physicalFlowSource === "user"
    ? { ...opts, userId: collaboration.ownerId }
    : opts;
  const result = getPipelineFiles(workspaceRoot, flowId, physicalFlowSource, archived, physicalOpts);
  if (result.error || !result.path) {
    return { root: "", error: result.error || "Pipeline workspace not found" };
  }
  return {
    root: path.resolve(result.path),
    flowId,
    flowSource: physicalFlowSource,
    requestedFlowSource: flowSource,
    workspaceId: collaboration?.id || workspaceId,
    archived,
    draft: isWorkspaceDraftDir(result.path),
    collaboration,
    collaborationAccess: workspaceCollaborationAccess(collaboration, opts.userId),
  };
}

export function workspaceFlowCollaborationGuard(flowId, flowSource, archived, userCtx = {}, capability = "read") {
  if (flowSource !== "workspace") return null;
  const collaboration = getWorkspaceCollaborationByFlow(flowId, archived === true);
  if (!collaboration) return null;
  const access = workspaceCollaborationAccess(collaboration, userCtx.userId);
  if (!access.allowed) return { error: "Workspace collaboration permission denied", status: 403 };
  if (capability === "write" && !access.writable) {
    return { error: "Workspace collaboration edit permission denied", status: 403 };
  }
  if (capability === "run" && !access.runnable) {
    return { error: "Workspace collaboration run permission denied", status: 403 };
  }
  if (capability === "owner" && access.role !== "owner") {
    return { error: "Only the workspace owner can manage this workflow", status: 403 };
  }
  return null;
}

export function workspaceCollaborationSummaryWithUsers(record, userId) {
  const summary = workspaceCollaborationSummary(record, userId);
  if (!summary) return null;
  const users = readAuthUsers();
  const teams = new Map(listTeams().map((team) => [team.id, team]));
  return {
    ...summary,
    ownerUsername: String(users[summary.ownerId]?.username || summary.ownerId),
    members: (summary.members || []).map((member) => ({
      ...member,
      username: String(users[member.userId]?.username || member.userId),
    })),
    teamShares: (summary.teamShares || []).map((share) => ({
      ...share,
      teamName: String(teams.get(share.teamId)?.name || share.teamId),
    })),
  };
}

function workspaceConversationsPath(scopedRoot) {
  return path.join(path.resolve(scopedRoot), ".workspace", "agentflow", "conversations.json");
}

function workspaceConversationText(value, max = 4000) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max)}\n...[truncated ${text.length - max} chars]` : text;
}

function normalizeWorkspaceConversationMessage(message = {}) {
  const text = workspaceConversationText(message?.text, 4000);
  if (!text) return null;
  const role = String(message?.role || "assistant").trim() === "user" ? "user" : "assistant";
  const kind = String(message?.kind || "").trim();
  return {
    role,
    ...(kind ? { kind } : {}),
    text,
    ...(message?.error ? { error: true } : {}),
    at: Number.isFinite(Number(message?.at)) ? Number(message.at) : Date.now(),
  };
}

function normalizeWorkspaceConversationMessages(messages, limit = 80) {
  return (Array.isArray(messages) ? messages : [])
    .map(normalizeWorkspaceConversationMessage)
    .filter(Boolean)
    .slice(-limit);
}

function normalizeWorkspaceNodeChatSessions(nodeChats = {}) {
  const source = nodeChats && typeof nodeChats === "object" && !Array.isArray(nodeChats) ? nodeChats : {};
  const entries = Object.entries(source).slice(-80);
  const next = {};
  for (const [nodeId, session] of entries) {
    if (!session || typeof session !== "object" || Array.isArray(session)) continue;
    const id = String(nodeId || "").trim();
    if (!id) continue;
    const messages = normalizeWorkspaceConversationMessages(session.messages, 40);
    const draft = workspaceConversationText(session.draft || "", 2000);
    if (!messages.length && !draft) continue;
    next[id] = {
      sessionId: String(session.sessionId || `nodechat_${id}`).trim(),
      messages,
      ...(draft ? { draft } : {}),
      candidateContent: "",
      running: false,
      error: "",
    };
  }
  return next;
}

function normalizeWorkspaceComposerRunSessions(sessions = []) {
  return (Array.isArray(sessions) ? sessions : [])
    .map((session) => {
      if (!session || typeof session !== "object" || Array.isArray(session)) return null;
      const id = String(session.id || "").trim();
      if (!id) return null;
      const messages = normalizeWorkspaceConversationMessages(session.messages, 80);
      if (!messages.length) return null;
      const status = String(session.status || "done").trim();
      return {
        id,
        label: workspaceConversationText(session.label || id, 120),
        status: status === "failed" ? "failed" : "done",
        messages,
      };
    })
    .filter(Boolean)
    .slice(-20);
}

function normalizeWorkspaceConversations(raw = {}) {
  const data = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const composer = data.composer && typeof data.composer === "object" && !Array.isArray(data.composer) ? data.composer : {};
  const activeSessionId = String(composer.activeSessionId || "workspace").trim() || "workspace";
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    composer: {
      activeSessionId,
      messages: normalizeWorkspaceConversationMessages(composer.messages, 100),
      runSessions: normalizeWorkspaceComposerRunSessions(composer.runSessions),
    },
    nodeChats: normalizeWorkspaceNodeChatSessions(data.nodeChats),
  };
}

export function readWorkspaceConversations(scopedRoot) {
  const filePath = workspaceConversationsPath(scopedRoot);
  if (!fs.existsSync(filePath)) return normalizeWorkspaceConversations({});
  try {
    return normalizeWorkspaceConversations(JSON.parse(fs.readFileSync(filePath, "utf-8")));
  } catch {
    return normalizeWorkspaceConversations({});
  }
}

export function writeWorkspaceConversations(scopedRoot, raw) {
  const filePath = workspaceConversationsPath(scopedRoot);
  const conversations = normalizeWorkspaceConversations(raw);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(conversations, null, 2) + "\n", "utf-8");
  return conversations;
}

export function workspaceSearchGuardrailsBlock() {
  return [
    "## 检索约束",
    "",
    "默认不要读取、搜索或 Glob 历史运行产物；除非用户明确要求分析历史 run/log，否则必须排除：",
    "- `**/runBuild/**`",
    "- `**/logs/**`",
    "- `.workspace/agentflow/**/runBuild/**`",
    "- `~/agentflow/runBuild/**`",
    "- `node_modules/**`、`dist/**` 等依赖或构建产物",
    "",
    "使用 grep/rg/find/Glob 等工具时，应把上述路径作为 exclude/glob ignore；不要从历史 runBuild/logs 中推断业务事实、指标资产或 skill 文档。",
  ].join("\n");
}

/** 把当前图渲染成 `workspace.flow.js` 的样子，连同它引用的外置长文本清单。 */
export function workspaceGraphAsSource(graph) {
  try {
    const { design } = splitWorkspaceGraph(graph);
    const out = graphToFlowFiles(design);
    const externals = out.files.length
      ? `\n\n引用到的外置长文本（内容在这些文件里，需要时自己读）：\n${out.files.map((f) => `- ${f.path}`).join("\n")}`
      : "";
    return `\n## 当前 workspace 图（${FLOW_SOURCE_FILENAME}）\n\n\`\`\`js\n${out.source}\`\`\`${externals}`;
  } catch {
    return `\n## 当前 workspace graph\n\n${JSON.stringify(graph, null, 2)}`;
  }
}

function workspaceSlotValue(slot) {
  if (!slot || typeof slot !== "object") return "";
  for (const key of ["value", "default"]) {
    if (slot[key] != null && String(slot[key]).trim()) return String(slot[key]);
  }
  return "";
}

function workspaceSlotByName(instance, name) {
  const slots = [...(Array.isArray(instance?.input) ? instance.input : []), ...(Array.isArray(instance?.output) ? instance.output : [])];
  return slots.find((slot) => String(slot?.name || "") === String(name || "")) || null;
}

function workspaceSetOutputSlot(instance, name, value) {
  const text = String(value ?? "");
  return {
    ...(instance || {}),
    output: (Array.isArray(instance?.output) ? instance.output : []).map((slot) => (
      String(slot?.name || "") === String(name || "") ? { ...slot, default: text, value: text } : slot
    )),
  };
}

function workspaceSourceSlotForEdge(graph, edge) {
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  const source = instances[String(edge?.source || "")];
  const output = Array.isArray(source?.output) ? source.output : [];
  return output[workspaceHandleIndex(edge?.sourceHandle, "output")] || null;
}

function isWorkspaceSemanticOutputSlot(slot) {
  const name = String(slot?.name || "");
  const type = String(slot?.type || "");
  return type === "node" || name === "prev" || name === "next";
}

function workspaceLinkedOutputShouldStayPath(slot) {
  const rawName = String(slot?.name || "").trim();
  const name = rawName.toLowerCase();
  const type = String(slot?.type || "").trim().toLowerCase();
  if (["file", "image", "audio", "video", "binary", "directory", "dir"].includes(type)) return true;
  if (["file", "filepath", "file_path", "path", "url", "uri", "ref"].includes(name)) return true;
  return /(?:^|[_-])(file|path|url|uri|ref)$/i.test(rawName) || /(?:File|Path|Url|URL|Uri|URI|Ref)$/.test(rawName);
}

/**
 * 节点的主输出槽名——承载「结果正文」的那个槽。
 *
 * 判据是「第一个非控制输出槽」。**不能用 `index === 0`**：规范槽序是
 * `[next, result]`，下标 0 是控制槽 `next`，于是自定义名字的输出槽（比如代码节点声明的
 * `total`）在每一处都判不中——写文件那边把它当 result 写，回填槽那边又不认它是 result，
 * 值就卡在中间谁也拿不到。名字叫 result / content 的槽历史上靠特判蒙对了，所以这个 bug
 * 一直只在自定义输出名上发作。
 *
 * @returns {string} 槽名；没有非控制输出槽时返回 ""
 */
function workspacePrimaryOutputSlotName(instance) {
  for (const slot of Array.isArray(instance?.output) ? instance.output : []) {
    const name = String(slot?.name || "").trim();
    if (!name || isWorkspaceSemanticOutputSlot(slot)) continue;
    return name;
  }
  return "";
}

/** 这个输出槽是不是主输出槽。`slots` 传所在实例的完整 output 数组。 */
function workspaceIsPrimaryOutputSlot(slot, slots) {
  const name = String(slot?.name || "").trim();
  if (!name) return false;
  if (name === "result" || name === "content") return true;
  return name === workspacePrimaryOutputSlotName({ output: slots });
}

function workspaceResolveLinkedOutputForTarget(value, targetSlot, scopedRoot = "") {
  const text = String(value ?? "");
  if (!text.trim() || workspaceLinkedOutputShouldStayPath(targetSlot)) return text;
  const outputRel = workspaceSafeNodeOutputRelPath(text);
  if (!outputRel || !String(scopedRoot || "").trim()) return text;
  try {
    const abs = workspaceResolveFlowFile(scopedRoot, outputRel, "linked output");
    const content = workspaceReadTextFileIfExists(abs, 120000);
    return content || text;
  } catch {
    return text;
  }
}

function workspaceOutputSlotValueForEdge(graph, outputs, edge, scopedRoot = "") {
  const sourceId = String(edge?.source || "");
  const slot = workspaceSourceSlotForEdge(graph, edge);
  if (isWorkspaceSemanticOutputSlot(slot)) return "";
  const targetSlot = workspaceTargetSlotForEdge(graph, edge);
  const resolveValue = (value) => workspaceResolveLinkedOutputForTarget(value, targetSlot, scopedRoot);
  const out = outputs.get(sourceId);
  const sourceIndex = workspaceHandleIndex(edge?.sourceHandle, "output");
  const isPrimaryOutput = !slot
    || workspaceIsPrimaryOutputSlot(slot, graph?.instances?.[sourceId]?.output);
  if (isPrimaryOutput && out != null && String(out).trim()) return resolveValue(out);
  if (slot && String(slot?.type || "") !== "node") {
    const value = workspaceSlotValue(slot);
    if (value.trim()) return resolveValue(value);
  }
  if (out != null && String(out).trim()) return resolveValue(out);
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  return resolveValue(workspaceInstanceText(instances[sourceId]));
}

function workspaceParseJsonObjectFromText(text) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const candidates = [raw];
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.unshift(fenced[1].trim());
  const first = raw.indexOf("{");
  const last = raw.lastIndexOf("}");
  if (first >= 0 && last > first) candidates.unshift(raw.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      /* try next */
    }
  }
  return null;
}

function workspaceStringifyOutputValue(value) {
  if (value == null) return "";
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function workspaceUnescapeLooseJsonString(value) {
  return String(value ?? "")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, "\\")
    .trim();
}

function workspaceFindMatchingDelimiter(text, openIndex, openChar = "{", closeChar = "}") {
  const raw = String(text || "");
  if (raw[openIndex] !== openChar) return -1;
  let depth = 0;
  let quote = "";
  let escaped = false;
  for (let i = openIndex; i < raw.length; i += 1) {
    const ch = raw[i];
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        quote = "";
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === openChar) depth += 1;
    if (ch === closeChar) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function workspaceParseLooseJsonValue(text, startIndex, limitIndex = String(text || "").length) {
  const raw = String(text || "");
  let i = startIndex;
  while (i < limitIndex && /\s/.test(raw[i])) i += 1;
  if (i >= limitIndex) return { value: "", end: i };
  const ch = raw[i];
  if (ch === "{" || ch === "[") {
    const close = workspaceFindMatchingDelimiter(raw, i, ch, ch === "{" ? "}" : "]");
    const end = close >= 0 ? close + 1 : limitIndex;
    const slice = raw.slice(i, end).trim();
    try {
      return { value: workspaceStringifyOutputValue(JSON.parse(slice)), end };
    } catch {
      return { value: slice, end };
    }
  }
  if (ch === '"' || ch === "'") {
    const quote = ch;
    let escaped = false;
    let end = i + 1;
    for (; end < limitIndex; end += 1) {
      const c = raw[end];
      if (escaped) {
        escaped = false;
      } else if (c === "\\") {
        escaped = true;
      } else if (c === quote) {
        break;
      }
    }
    const body = raw.slice(i + 1, end < limitIndex ? end : limitIndex);
    return { value: workspaceUnescapeLooseJsonString(body), end: Math.min(end + 1, limitIndex) };
  }
  let end = i;
  while (end < limitIndex && raw[end] !== "," && raw[end] !== "\n" && raw[end] !== "\r" && raw[end] !== "}") end += 1;
  const slice = raw.slice(i, end).trim().replace(/^["'`]|["'`]$/g, "");
  return { value: workspaceUnescapeLooseJsonString(slice), end };
}

function workspaceExtractLooseOutParams(raw) {
  const text = String(raw || "");
  const out = {};
  const startMatch = /["']outParams["']\s*:\s*\{/i.exec(text);
  if (!startMatch) return out;
  const openIndex = text.indexOf("{", startMatch.index);
  const closeIndex = workspaceFindMatchingDelimiter(text, openIndex);
  const endLimit = closeIndex >= 0 ? closeIndex : text.length;
  const block = text.slice(openIndex, closeIndex >= 0 ? closeIndex + 1 : text.length);
  try {
    const parsed = JSON.parse(block);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        const name = String(key || "").trim();
        if (name) out[name] = workspaceStringifyOutputValue(value);
      }
      return out;
    }
  } catch {
    /* fall through to loose top-level scanning */
  }
  let i = openIndex + 1;
  while (i < endLimit) {
    while (i < endLimit && /[\s,]/.test(text[i])) i += 1;
    if (i >= endLimit) break;
    let key = "";
    if (text[i] === '"' || text[i] === "'") {
      const quote = text[i];
      const keyStart = i + 1;
      i = keyStart;
      while (i < endLimit && text[i] !== quote) i += 1;
      key = text.slice(keyStart, i).trim();
      i += 1;
    } else {
      const keyStart = i;
      while (i < endLimit && /[A-Za-z0-9_-]/.test(text[i])) i += 1;
      key = text.slice(keyStart, i).trim();
    }
    while (i < endLimit && /\s/.test(text[i])) i += 1;
    if (text[i] !== ":") {
      i += 1;
      continue;
    }
    i += 1;
    const parsedValue = workspaceParseLooseJsonValue(text, i, endLimit);
    if (key) out[key] = String(parsedValue.value ?? "").trim();
    i = parsedValue.end;
  }
  return out;
}

function workspaceExtractLooseResult(raw) {
  const text = String(raw || "").trim();
  const resultMatch = /["']result["']\s*:\s*(["'])/i.exec(text);
  if (!resultMatch) return "";
  const quote = resultMatch[1];
  const start = resultMatch.index + resultMatch[0].length;
  const outParamsMatch = /,\s*["']outParams["']\s*:/i.exec(text.slice(start));
  if (outParamsMatch) {
    const end = start + outParamsMatch.index;
    let value = text.slice(start, end).trim();
    if (value.endsWith(quote)) value = value.slice(0, -1);
    return workspaceUnescapeLooseJsonString(value);
  }
  const end = text.lastIndexOf(quote);
  if (end > start) return workspaceUnescapeLooseJsonString(text.slice(start, end));
  return "";
}

function workspaceNormalizeAgentflowEnvelopeBody(body) {
  let text = String(body || "").replace(/\r\n/g, "\n").trim();
  if (!text.includes("\n")) {
    text = text
      .replace(/\s+(resultFile|result|outParams|outParams\.[A-Za-z_][A-Za-z0-9_-]*)\s*:/g, "\n$1:")
      .replace(/(^|\n)outParams:\s+([A-Za-z_][A-Za-z0-9_-]*\s*:)/g, "$1outParams:\n  $2");
  }
  return text;
}

function workspaceExtractAgentflowEnvelope(raw) {
  const text = String(raw || "");
  const match = text.match(/---agentflow\b([\s\S]*?)---end/i);
  if (!match) return null;
  const envelope = workspaceNormalizeAgentflowEnvelopeBody(match[1] || "");
  const outside = `${text.slice(0, match.index || 0)}\n${text.slice((match.index || 0) + match[0].length)}`.trim();
  const lines = envelope.split("\n");
  const outParams = {};
  let result = "";
  let resultFile = "";

  const lineIndent = (line) => {
    const m = String(line || "").match(/^(\s*)/);
    return m ? m[1].length : 0;
  };
  const cleanScalar = (value) => String(value || "").trim().replace(/^["']|["']$/g, "");
  const collectBlock = (startIndex, baseIndent) => {
    const collected = [];
    let i = startIndex;
    for (; i < lines.length; i += 1) {
      const line = lines[i] || "";
      if (line.trim() && lineIndent(line) <= baseIndent) break;
      collected.push(line.slice(Math.min(line.length, baseIndent + 2)));
    }
    return { value: collected.join("\n").replace(/\s+$/g, ""), nextIndex: i };
  };
  const parseValue = (rawValue, currentIndex, baseIndent) => {
    const value = String(rawValue || "").trim();
    if (value === "|" || value === ">") return collectBlock(currentIndex + 1, baseIndent);
    return { value: cleanScalar(value), nextIndex: currentIndex + 1 };
  };

  for (let i = 0; i < lines.length;) {
    const line = lines[i] || "";
    if (!line.trim() || /^\s*#/.test(line)) {
      i += 1;
      continue;
    }
    const top = line.match(/^([A-Za-z_][A-Za-z0-9_.-]*)\s*:\s*(.*)$/);
    if (!top) {
      i += 1;
      continue;
    }
    const key = top[1];
    const rawValue = top[2] || "";
    if (key === "outParams") {
      i += 1;
      while (i < lines.length) {
        const childLine = lines[i] || "";
        if (!childLine.trim()) {
          i += 1;
          continue;
        }
        if (lineIndent(childLine) === 0) break;
        const child = childLine.match(/^\s+([A-Za-z_][A-Za-z0-9_.-]*)\s*:\s*(.*)$/);
        if (!child) {
          i += 1;
          continue;
        }
        const childKey = child[1];
        const parsed = parseValue(child[2] || "", i, lineIndent(childLine));
        if (childKey) outParams[childKey] = String(parsed.value || "").trim();
        i = parsed.nextIndex;
      }
      continue;
    }
    const parsed = parseValue(rawValue, i, 0);
    if (key === "result") result = String(parsed.value || "");
    else if (key === "resultFile") resultFile = String(parsed.value || "").trim();
    else if (key.startsWith("outParams.")) outParams[key.slice("outParams.".length)] = String(parsed.value || "").trim();
    else if (key) outParams[key] = String(parsed.value || "").trim();
    i = parsed.nextIndex;
  }
  return {
    result: resultFile || result || outside,
    resultFile,
    outParams,
    structured: true,
    parsed: { result, resultFile, outParams },
  };
}

function workspaceCanonicalAgentOutput(content) {
  const raw = String(content || "").trim();
  const match = raw.match(/---agentflow\b[\s\S]*?---end/i);
  if (match?.[0]) return match[0].trim();
  return raw;
}

export function workspaceStructuredAgentOutput(content) {
  const raw = workspaceCanonicalAgentOutput(content);
  const agentflowEnvelope = workspaceExtractAgentflowEnvelope(raw);
  if (agentflowEnvelope) return agentflowEnvelope;
  const parsed = workspaceParseJsonObjectFromText(raw);
  if (!parsed) {
    const looseResult = workspaceExtractLooseResult(raw);
    const looseOutParams = workspaceExtractLooseOutParams(raw);
    if (looseResult || Object.keys(looseOutParams).length) {
      return {
        result: looseResult || raw,
        outParams: looseOutParams,
        structured: true,
        parsed: null,
      };
    }
    return { result: raw, outParams: {}, structured: false, parsed: null };
  }
  const hasEnvelope = Object.prototype.hasOwnProperty.call(parsed, "result") ||
    Object.prototype.hasOwnProperty.call(parsed, "resultFile") ||
    Object.prototype.hasOwnProperty.call(parsed, "outParams");
  if (!hasEnvelope) return { result: raw, outParams: {}, structured: false, parsed };
  const outParamsRaw = parsed.outParams && typeof parsed.outParams === "object" && !Array.isArray(parsed.outParams)
    ? parsed.outParams
    : {};
  const outParams = {};
  for (const [key, value] of Object.entries(outParamsRaw)) {
    const name = String(key || "").trim();
    if (name) outParams[name] = workspaceStringifyOutputValue(value);
  }
  const resultFile = workspaceStringifyOutputValue(parsed.resultFile ?? "").trim();
  return {
    result: resultFile || workspaceStringifyOutputValue(parsed.result ?? ""),
    resultFile,
    outParams,
    structured: true,
    parsed,
  };
}

function workspaceExtractNamedOutputValue(content, slotName) {
  const name = String(slotName || "").trim();
  if (!name) return "";
  const structured = workspaceStructuredAgentOutput(content);
  if (Object.prototype.hasOwnProperty.call(structured.outParams, name)) {
    return String(structured.outParams[name] ?? "");
  }
  const fileName = `${name}File`;
  if (Object.prototype.hasOwnProperty.call(structured.outParams, fileName)) {
    return String(structured.outParams[fileName] ?? "");
  }
  const parsed = structured.parsed || workspaceParseJsonObjectFromText(content);
  if (parsed && Object.prototype.hasOwnProperty.call(parsed, name)) {
    const value = parsed[name];
    return workspaceStringifyOutputValue(value);
  }
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const looseOutParams = workspaceExtractLooseOutParams(content);
  if (Object.prototype.hasOwnProperty.call(looseOutParams, name)) {
    return String(looseOutParams[name] ?? "").trim();
  }
  const patterns = [
    new RegExp(`["']?${escaped}["']?\\s*:\\s*["']?([^"',}\\n\\r]+)`, "i"),
    new RegExp(`(?:\\$\\{${escaped}\\}|\\$${escaped})\\s*[=:：]\\s*([^\\n\\r]+)`, "i"),
    new RegExp(`(?:^|[\\n\\r])\\s*${escaped}\\s*[=:：]\\s*([^\\n\\r]+)`, "i"),
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(String(content || ""));
    if (!match?.[1]) continue;
    return match[1].replace(/^["'`]|["'`]$/g, "").trim();
  }
  return "";
}

function workspaceApplyAgentOutputSlots(instance, content) {
  const structured = content && typeof content === "object" && !Array.isArray(content)
    ? content
    : workspaceStructuredAgentOutput(content);
  const text = String(structured.result || "").trim();
  let changed = false;
  const next = {
    ...(instance || {}),
    output: (Array.isArray(instance?.output) ? instance.output : []).map((slot, index) => {
      const name = String(slot?.name || "").trim();
      const type = String(slot?.type || "");
      if (type === "node" || name === "next" || !name) return slot;
      let value = "";
      // 信封里点名给了值就用点名的——比「你是主输出槽」更具体
      if (Object.prototype.hasOwnProperty.call(structured.outParams, name)) {
        value = structured.outParams[name];
      } else if (Object.prototype.hasOwnProperty.call(structured.outParams, `${name}File`)) {
        value = structured.outParams[`${name}File`];
      } else if (workspaceIsPrimaryOutputSlot(slot, instance?.output)) {
        value = text;
      } else {
        value = workspaceExtractNamedOutputValue(text, name);
      }
      if (!value) return slot;
      changed = true;
      return { ...slot, default: value, value };
    }),
  };
  return { instance: changed ? next : instance, changed };
}

function workspaceResolvePath(baseCwd, raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  return path.isAbsolute(text) ? path.resolve(text) : path.resolve(baseCwd, text);
}

function workspaceShellQuote(value) {
  return "'" + String(value ?? "").replace(/'/g, "'\\''") + "'";
}

function workspaceSafeFlowRelPath(raw, fieldName = "path") {
  const text = String(raw || "").trim().replace(/^["']|["']$/g, "");
  if (!text) return "";
  if (text.length > 260) throw new Error(`${fieldName} is too long`);
  if (/[\r\n<>]/.test(text)) throw new Error(`${fieldName} contains invalid characters`);
  if (/^(?:https?:|data:|blob:|file:|javascript:|mailto:|tel:)/i.test(text)) {
    throw new Error(`${fieldName} must be a relative file path`);
  }
  if (path.isAbsolute(text)) throw new Error(`${fieldName} must be relative`);
  const normalized = path.posix.normalize(text.replace(/\\/g, "/")).replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`${fieldName} escapes workspace root`);
  }
  return normalized;
}

function workspaceResolveFlowFile(scopedRoot, relPath, fieldName = "path") {
  const clean = workspaceSafeFlowRelPath(relPath, fieldName);
  if (!clean) return "";
  const root = path.resolve(scopedRoot);
  const abs = path.resolve(root, ...clean.split("/"));
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (abs !== root && !abs.startsWith(rootWithSep)) {
    throw new Error(`${fieldName} escapes workspace root`);
  }
  return abs;
}

function workspaceReadTextFileIfExists(absPath, maxChars = 60000) {
  const file = String(absPath || "").trim();
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) return "";
  const raw = fs.readFileSync(file, "utf-8");
  return raw.length > maxChars ? `${raw.slice(0, maxChars)}\n...[truncated ${raw.length - maxChars} chars]` : raw;
}

function workspaceSanitizeRepoDirName(repoUrl) {
  const raw = String(repoUrl || "").trim().replace(/\.git$/i, "");
  const last = raw.split(/[/:]/).filter(Boolean).pop() || "repo";
  return last.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "repo";
}

function workspaceBoolSlot(instance, name, defaultValue = false) {
  const value = workspaceSlotValue(workspaceSlotByName(instance, name));
  if (!value.trim()) return Boolean(defaultValue);
  return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
}

function workspaceInstanceText(instance) {
  const body = String(instance?.body || "").trim();
  if (body) return body;
  const slots = [...(Array.isArray(instance?.input) ? instance.input : []), ...(Array.isArray(instance?.output) ? instance.output : [])];
  const textSlot = slots.find((slot) => String(slot?.type || "") === "text" && workspaceSlotValue(slot).trim());
  return textSlot ? workspaceSlotValue(textSlot) : "";
}

function workspaceDisplayKind(definitionId) {
  const id = String(definitionId || "");
  if (id === "display_markdown") return "markdown";
  if (id === "display_code") return "code";
  if (id === "display_mermaid") return "mermaid";
  if (id === "display_ascii") return "ascii";
  if (id === "display_html") return "html";
  if (id === "display_react_app") return "react";
  if (id === "display_image") return "image";
  if (id === "display_chart") return "chart";
  if (id === "display_table") return "table";
  return "";
}

export function workspaceDisplayKindFromInstance(instance) {
  const direct = workspaceDisplayKind(instance?.definitionId);
  if (direct) return direct;
  if (!isWorkspaceOneClickTaskDefinitionId(instance?.definitionId)) return "";
  if (!workspaceDisplayContentFromInstance(instance, workspaceContextRunDisplayKind(instance)).trim()) return "";
  return workspaceContextRunDisplayKind(instance);
}

export function workspaceDisplayTextFilePath(value, kind = "") {
  const text = String(value || "").trim();
  if (!text || text.length > 260) return "";
  if (/[\r\n<>]/.test(text)) return "";
  if (/^(?:https?:|data:|blob:|file:|javascript:|mailto:|tel:)/i.test(text)) return "";
  const clean = text.replace(/^\/+/, "");
  if (clean.includes("..") || clean.startsWith(".")) return "";
  const ext = clean.split("?")[0].split("#")[0].toLowerCase().split(".").pop() || "";
  const allowedByKind = {
    html: new Set(["html", "htm"]),
    react: new Set(["json", "jsx", "tsx", "js", "txt"]),
    markdown: new Set(["md", "markdown", "txt"]),
    code: new Set(["txt", "js", "jsx", "mjs", "cjs", "ts", "tsx", "py", "kt", "kts", "java", "go", "rs", "sh", "bash", "zsh", "json", "yaml", "yml", "xml", "html", "htm", "css", "scss", "sql", "md"]),
    mermaid: new Set(["mmd", "mermaid", "txt"]),
    ascii: new Set(["txt", "log"]),
    chart: new Set(["json"]),
    table: new Set(["json", "csv", "tsv"]),
  };
  const allowed = allowedByKind[kind] || new Set(["html", "htm", "md", "markdown", "txt", "json", "csv", "tsv"]);
  return allowed.has(ext) ? clean : "";
}

function workspaceSafeNodeOutputRelPath(value) {
  const text = String(value || "").trim().replace(/^["']|["']$/g, "");
  if (!text || text.length > 260) return "";
  if (/[\r\n<>]/.test(text)) return "";
  if (/^(?:https?:|data:|blob:|file:|javascript:|mailto:|tel:)/i.test(text)) return "";
  const clean = text.replace(/^\/+/, "");
  if (clean.includes("..") || clean.startsWith(".") || path.isAbsolute(clean)) return "";
  if (!clean.startsWith("outputs/")) return "";
  return clean;
}

function workspaceResolveOutputChild(rootDir, relativePath = "") {
  const root = path.resolve(rootDir || "");
  if (!rootDir || !root) return "";
  const parts = String(relativePath || "").split("/").filter(Boolean);
  const abs = path.resolve(root, ...parts);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  return abs === root || abs.startsWith(rootWithSep) ? abs : "";
}

function workspaceNodeOutputSuffix(relPath) {
  const clean = workspaceSafeNodeOutputRelPath(relPath);
  return clean ? clean.slice("outputs/".length).replace(/^\/+/, "") : "";
}

function workspaceNodeOutputWritePath(runPackage, relPath) {
  const clean = workspaceSafeNodeOutputRelPath(relPath);
  if (!clean) return "";
  const suffix = workspaceNodeOutputSuffix(clean);
  if (runPackage?.directWorkspaceOutputs && runPackage?.outputsDir) {
    return workspaceResolveOutputChild(runPackage.outputsDir, suffix);
  }
  return workspaceResolveOutputChild(runPackage?.nodeRunDir, clean);
}

function workspaceNodeOutputCandidates(runPackage, relPath) {
  const clean = workspaceSafeNodeOutputRelPath(relPath);
  if (!clean) return [];
  const suffix = workspaceNodeOutputSuffix(clean);
  const direct = runPackage?.outputsDir
    ? workspaceResolveOutputChild(runPackage.outputsDir, suffix)
    : "";
  const legacy = runPackage?.nodeRunDir
    ? workspaceResolveOutputChild(runPackage.nodeRunDir, clean)
    : "";
  const ordered = runPackage?.directWorkspaceOutputs ? [direct, legacy] : [legacy, direct];
  return ordered.filter((candidate, index, list) => candidate && list.indexOf(candidate) === index);
}

function workspaceDescribeNodeOutputsDir(runPackage, maxEntries = 30) {
  const outputDirs = [
    runPackage?.outputsDir,
    runPackage?.nodeRunDir ? path.resolve(runPackage.nodeRunDir, "outputs") : "",
  ].filter((dir, index, list) => dir && list.indexOf(dir) === index && fs.existsSync(dir));
  if (!outputDirs.length) return "Current node outputs directory is missing.";
  const entries = [];
  const walk = (dir, rel = "") => {
    if (entries.length >= maxEntries) return;
    let children = [];
    try {
      children = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const child of children) {
      if (entries.length >= maxEntries) break;
      const childRel = rel ? path.posix.join(rel, child.name) : child.name;
      entries.push(child.isDirectory() ? `${childRel}/` : childRel);
      if (child.isDirectory()) walk(path.join(dir, child.name), childRel);
    }
  };
  for (const outputDir of outputDirs) walk(outputDir);
  if (!entries.length) return "Current node outputs directory is empty.";
  const suffix = entries.length >= maxEntries ? `\n...showing first ${maxEntries} entries` : "";
  return `Current node outputs entries:\n${entries.map((entry) => `- outputs/${entry}`).join("\n")}${suffix}`;
}

function workspacePublishNodeOutputFile(runPackage, relPath) {
  if (!String(relPath || "").trim()) return "";
  const clean = workspaceSafeNodeOutputRelPath(relPath);
  if (!clean) throw new Error(`Agent returned an invalid output file path: ${String(relPath || "").trim()}`);
  const nodeRunDir = path.resolve(runPackage?.nodeRunDir || "");
  const workspaceOutputsDir = path.resolve(runPackage?.workspaceOutputsDir || "");
  if (!nodeRunDir || !workspaceOutputsDir) return clean;
  const src = workspaceNodeOutputCandidates(runPackage, clean)
    .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!src) {
    throw new Error(
      `Agent returned resultFile but did not create it under this node's outputs: ${clean}\n` +
      `Expected file: ${workspaceNodeOutputWritePath(runPackage, clean)}\n` +
      `${workspaceDescribeNodeOutputsDir(runPackage)}\n` +
      `Write downloadable files to the absolute AGENTFLOW_OUTPUTS_DIR path.`
    );
  }
  const nodePart = workspaceSanitizeTmpSegment(runPackage?.nodeId || "node", "node");
  const destRel = workspaceNodeOutputSuffix(clean);
  const publishedBase = String(runPackage?.outputsRel || "").trim() || path.posix.join("outputs", nodePart);
  const publishedRel = path.posix.join(publishedBase, ...destRel.split("/").filter(Boolean));
  const dest = runPackage?.directWorkspaceOutputs && runPackage?.outputsDir
    ? workspaceResolveOutputChild(runPackage.outputsDir, destRel)
    : path.resolve(workspaceOutputsDir, nodePart, ...destRel.split("/").filter(Boolean));
  const workspaceOutputsWithSep = workspaceOutputsDir.endsWith(path.sep) ? workspaceOutputsDir : `${workspaceOutputsDir}${path.sep}`;
  if (dest !== workspaceOutputsDir && !dest.startsWith(workspaceOutputsWithSep)) {
    throw new Error(`Invalid workspace output path: ${clean}`);
  }
  if (src !== dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
  return publishedRel;
}

export function workspaceMaterializeAgentResultFile(structured, runPackage) {
  if (!structured || !runPackage) return structured;
  const configured = workspaceSafeNodeOutputRelPath(runPackage.resultFileRel || "") || "outputs/result.txt";
  const rawDeclared = String(structured.resultFile || "").trim();
  const declared = workspaceSafeNodeOutputRelPath(rawDeclared);
  if (rawDeclared && !declared) return structured;
  const relPath = declared || configured;
  const abs = workspaceNodeOutputWritePath(runPackage, relPath);
  if (!abs) return structured;

  const explicitInlineResult = structured.parsed && typeof structured.parsed === "object"
    ? String(structured.parsed.result ?? "")
    : "";
  const content = declared ? explicitInlineResult : String(structured.result ?? "");
  let primaryReady = workspaceNodeOutputCandidates(runPackage, relPath)
    .some((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!primaryReady && content.trim()) {
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    const tmp = path.join(path.dirname(abs), `.${path.basename(abs)}.${process.pid}.${Date.now()}.tmp`);
    try {
      fs.writeFileSync(tmp, content, "utf-8");
      fs.renameSync(tmp, abs);
      primaryReady = true;
    } finally {
      try {
        if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
      } catch {
        // Best-effort cleanup; the node run directory is removed after the run.
      }
    }
  }
  const outParams = { ...(structured.outParams || {}) };
  let outParamsChanged = false;
  for (const [name, configuredRel] of Object.entries(runPackage.outParamFiles || {})) {
    const fileKey = `${name}File`;
    if (String(outParams[fileKey] || "").trim()) continue;
    const outputContent = String(outParams[name] ?? "");
    if (!outputContent.trim()) continue;
    const outputRel = workspaceSafeNodeOutputRelPath(configuredRel);
    if (!outputRel) continue;
    const outputAbs = workspaceNodeOutputWritePath(runPackage, outputRel);
    if (!outputAbs) continue;
    fs.mkdirSync(path.dirname(outputAbs), { recursive: true });
    fs.writeFileSync(outputAbs, outputContent, "utf-8");
    delete outParams[name];
    outParams[fileKey] = outputRel;
    outParamsChanged = true;
  }
  if (!primaryReady && !outParamsChanged) return structured;
  return {
    ...structured,
    result: primaryReady ? relPath : structured.result,
    resultFile: primaryReady ? relPath : structured.resultFile,
    outParams,
    structured: true,
  };
}

function workspaceCollectNodeOutputFiles(runPackage, maxFiles = 500) {
  const roots = [
    runPackage?.outputsDir,
    runPackage?.nodeRunDir ? path.resolve(runPackage.nodeRunDir, "outputs") : "",
  ].filter((dir, index, list) => dir && list.indexOf(dir) === index && fs.existsSync(dir));
  const relativeFiles = new Set();
  const walk = (root, dir, depth = 0) => {
    if (depth > 12 || relativeFiles.size >= maxFiles) return;
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (relativeFiles.size >= maxFiles) break;
      if (entry.isSymbolicLink()) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(root, abs, depth + 1);
      } else if (entry.isFile()) {
        relativeFiles.add(path.relative(root, abs).replace(/\\/g, "/"));
      }
    }
  };
  for (const root of roots) walk(root, root);

  const outputFiles = [];
  for (const relativePath of relativeFiles) {
    const publishedPath = workspacePublishNodeOutputFile(runPackage, `outputs/${relativePath}`);
    if (!publishedPath) continue;
    const publishedAbs = workspaceResolveOutputChild(
      runPackage.workspaceOutputsDir,
      publishedPath.slice("outputs/".length),
    );
    let size = 0;
    try {
      size = publishedAbs ? fs.statSync(publishedAbs).size : 0;
    } catch {}
    outputFiles.push({ path: publishedPath, name: path.posix.basename(publishedPath), size });
  }
  outputFiles.sort((a, b) => a.path.localeCompare(b.path));
  return outputFiles;
}

export function workspacePublishAgentOutputFiles(structured, runPackage) {
  if (!runPackage) return structured;
  const base = structured && typeof structured === "object" ? structured : {};
  const resultFile = base.structured
    ? workspacePublishNodeOutputFile(runPackage, base.resultFile)
    : "";
  const outParams = { ...(base.outParams || {}) };
  for (const [key, value] of Object.entries(outParams)) {
    if (!String(key || "").endsWith("File")) continue;
    const published = workspacePublishNodeOutputFile(runPackage, value);
    if (published) outParams[key] = published;
  }
  const outputFiles = workspaceCollectNodeOutputFiles(runPackage);
  return resultFile || Object.keys(outParams).length || outputFiles.length
    ? {
        ...base,
        result: resultFile || base.result,
        resultFile: resultFile || base.resultFile,
        outParams,
        outputFiles,
      }
    : base;
}

/**
 * Node package outputs use files as a transport contract, not as the semantic
 * value of every slot. Text/json/bool slots receive the file contents; only
 * file/image slots intentionally expose a published artifact path.
 */
export function workspaceMaterializeNodePackageOutputValues(structured, runPackage, instance) {
  if (!structured || !runPackage || !instance) return structured;
  const slots = (Array.isArray(instance.output) ? instance.output : [])
    .filter((slot) => !isWorkspaceSemanticOutputSlot(slot));
  if (!slots.length) return structured;
  const outParams = { ...(structured.outParams || {}) };
  let result = structured.result;
  let resultFile = structured.resultFile;
  let changed = false;
  for (const slot of slots) {
    const name = String(slot?.name || "").trim();
    if (!name) continue;
    const type = String(slot?.type || "text").trim().toLowerCase();
    if (type === "file" || type === "image") continue;
    const primary = workspaceIsPrimaryOutputSlot(slot, instance.output);
    const fileKey = `${name}File`;
    const relPath = primary ? resultFile : outParams[fileKey];
    const clean = workspaceSafeNodeOutputRelPath(relPath);
    if (!clean) continue;
    const source = workspaceNodeOutputCandidates(runPackage, clean)
      .find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
    if (!source) continue;
    const value = fs.readFileSync(source, "utf8");
    if (primary) {
      result = value;
      resultFile = "";
    } else {
      outParams[name] = value;
      delete outParams[fileKey];
    }
    changed = true;
  }
  return changed ? { ...structured, result, resultFile, outParams } : structured;
}

function workspaceOutputFieldForSlot(slot, slots = null) {
  const name = String(slot?.name || "").trim();
  if (!name || workspaceIsPrimaryOutputSlot(slot, slots)) return "result";
  return `outParams.${name}`;
}

function workspaceDisplayKindExample(kind, field) {
  if (kind === "table") return { columns: ["列名1", "列名2"], rows: [["值1", "值2"]] };
  if (kind === "chart") return { type: "chart", version: "1.0", renderer: "echarts", option: { xAxis: { type: "category", data: [] }, yAxis: { type: "value" }, series: [{ type: "bar", data: [] }] } };
  if (kind === "html") return "<可直接渲染的 HTML>";
  if (kind === "react") return { title: "React App", entry: "src/App.jsx", files: { "src/App.jsx": "export default function App() { return <main>...</main>; }", "src/styles.css": "body { margin: 0; }" }, inputs: {} };
  if (kind === "mermaid") return "flowchart TD\n  A[开始] --> B[结束]";
  if (kind === "ascii") return "+---+\n|   |\n+---+";
  if (kind === "image") return "<图片 URL 或 data URL>";
  if (kind === "markdown") return field === "result" ? "<给用户看的完整 Markdown 正文>" : "<Markdown 正文>";
  return `<${field} 的值>`;
}

function workspaceDownstreamOutputDisplayBindings(graph, nodeId) {
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const source = instances[String(nodeId || "")] || {};
  const output = Array.isArray(source.output) ? source.output : [];
  const bindings = [];
  for (const edge of edges) {
    if (String(edge?.source || "") !== String(nodeId)) continue;
    if (isWorkspaceSemanticInputSlot(workspaceTargetSlotForEdge(graph, edge))) continue;
    const target = instances[String(edge?.target || "")];
    const kind = workspaceDisplayKind(target?.definitionId);
    if (!kind) continue;
    const index = workspaceHandleIndex(edge?.sourceHandle, "output");
    const slot = output[index] || null;
    if (isWorkspaceSemanticOutputSlot(slot)) continue;
    const name = String(slot?.name || "").trim()
      || (workspaceIsPrimaryOutputSlot(slot, output) ? "result" : `output-${index}`);
    bindings.push({
      kind,
      index,
      name,
      field: workspaceOutputFieldForSlot(slot, output),
    });
  }
  return bindings;
}

function normalizeHtmlDisplayContent(content) {
  let text = String(content || "").trim();
  if (!text) return "";
  const fenced = text.match(/```(?:html|HTML)?\s*\n?([\s\S]*?)```/);
  if (fenced && fenced[1]) text = fenced[1].trim();
  else {
    const openFence = text.match(/```(?:html|HTML)?\s*\n?([\s\S]*)$/);
    if (openFence && openFence[1]) text = openFence[1].trim();
  }
  text = text.replace(/^html\s*\n/i, "").replace(/```\s*$/g, "").trim();
  const markerPatterns = [
    /<!doctype\b/i,
    /<html\b/i,
    /<head\b/i,
    /<body\b/i,
    /<style\b/i,
    /<script\b/i,
    /<main\b/i,
    /<section\b/i,
    /<article\b/i,
    /<div\b/i,
    /<svg\b/i,
    /<canvas\b/i,
  ];
  const firstHtmlIndex = markerPatterns.reduce((best, pattern) => {
    const match = pattern.exec(text);
    if (!match) return best;
    return best < 0 ? match.index : Math.min(best, match.index);
  }, -1);
  if (firstHtmlIndex > 0) text = text.slice(firstHtmlIndex).trim();
  return text;
}

export function workspaceBodyPlaceholderNames(body) {
  const names = new Set();
  const raw = String(body || "");
  raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_-]*)\}/g, (_match, name) => {
    if (name) names.add(String(name));
    return _match;
  });
  return names;
}

export function workspaceRelevantInputValues(body, inputValues = {}) {
  const placeholders = workspaceBodyPlaceholderNames(body);
  if (!placeholders.size) return { values: inputValues || {}, placeholders };
  const values = {};
  for (const [name, value] of Object.entries(inputValues || {})) {
    if (placeholders.has(name)) values[name] = value;
  }
  return { values, placeholders };
}

export function workspaceAssertRequiredInputs(body, inputValues = {}, nodeId = "") {
  const placeholders = workspaceBodyPlaceholderNames(body);
  const missing = [...placeholders].filter((name) => (
    !Object.prototype.hasOwnProperty.call(inputValues || {}, name) ||
    !String(inputValues[name] ?? "").trim()
  ));
  if (!missing.length) return;
  const label = nodeId ? `Workspace node ${nodeId}` : "Workspace node";
  throw new Error(`${label} 缺少必需输入：${missing.join(", ")}。请连接对应输入槽或提供非空值。`);
}

function workspaceDownstreamSlotKind(slot) {
  const name = String(slot?.name || "").trim().toLowerCase();
  const type = String(slot?.type || "").trim().toLowerCase();
  if (type === "markdown" || name === "markdown" || name.endsWith("markdown")) return "markdown";
  if (type === "code" || name === "code" || name.endsWith("code")) return "code";
  if (type === "html" || name === "html" || name.endsWith("html")) return "html";
  if (type === "mermaid" || name === "mermaid" || name.endsWith("mermaid")) return "mermaid";
  if (type === "ascii" || name === "ascii") return "ascii";
  if (type === "chart" || name === "chart" || name.endsWith("chart")) return "chart";
  if (type === "table" || name === "table" || name.endsWith("table")) return "table";
  return "";
}

function workspaceDownstreamOutputKindForField(graph, nodeId, field) {
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const source = instances[String(nodeId || "")] || {};
  const outputSlots = Array.isArray(source.output) ? source.output : [];
  for (const edge of edges) {
    if (String(edge?.source || "") !== String(nodeId)) continue;
    const sourceIndex = workspaceHandleIndex(edge?.sourceHandle, "output");
    const sourceSlot = outputSlots[sourceIndex] || null;
    if (workspaceOutputFieldForSlot(sourceSlot, sourceIndex) !== field) continue;
    const targetSlot = workspaceTargetSlotForEdge(graph, edge);
    if (!targetSlot || isWorkspaceSemanticInputSlot(targetSlot)) continue;
    const kind = workspaceDownstreamSlotKind(targetSlot);
    if (kind) return kind;
  }
  return "";
}

function workspaceResultOutputSpec(graph, nodeId) {
  const instance = graph?.instances?.[nodeId] || {};
  const displayBindings = workspaceDownstreamOutputDisplayBindings(graph, nodeId);
  const displayByField = new Map();
  for (const binding of displayBindings) {
    if (!displayByField.has(binding.field)) displayByField.set(binding.field, binding.kind);
  }
  const configuredResultKind = isWorkspaceOneClickTaskDefinitionId(instance.definitionId)
    ? workspaceContextRunDisplayKind(instance)
    : "";
  const kind = displayByField.get("result") || workspaceDownstreamOutputKindForField(graph, nodeId, "result") || configuredResultKind || "";
  const extByKind = {
    html: "html",
    react: "json",
    markdown: "md",
    code: "txt",
    mermaid: "mmd",
    ascii: "txt",
    chart: "json",
    table: "json",
  };
  return {
    kind,
    extByKind,
    resultFile: `outputs/result.${extByKind[kind] || "txt"}`,
  };
}

function workspaceOutParamFileSpecs(graph, nodeId) {
  const instance = graph?.instances?.[nodeId] || {};
  const outputSlots = Array.isArray(instance.output) ? instance.output : [];
  const displayBindings = workspaceDownstreamOutputDisplayBindings(graph, nodeId);
  const displayByField = new Map();
  for (const binding of displayBindings) {
    if (!displayByField.has(binding.field)) displayByField.set(binding.field, binding.kind);
  }
  const extByKind = workspaceResultOutputSpec(graph, nodeId).extByKind;
  const specs = {};
  for (let index = 0; index < outputSlots.length; index += 1) {
    const slot = outputSlots[index];
    const name = String(slot?.name || "").trim();
    const type = String(slot?.type || "").trim().toLowerCase();
    if (!name || isWorkspaceSemanticOutputSlot(slot) || workspaceIsPrimaryOutputSlot(slot, outputSlots)) continue;
    const kind = displayByField.get(`outParams.${name}`) || "";
    const fileLike = ["file", "image", "audio", "video", "binary"].includes(type);
    if (!fileLike && !kind) continue;
    const safeName = workspaceSanitizeTmpSegment(name, `output-${index}`);
    const existingExt = path.posix.extname(safeName).replace(/^\./, "");
    const ext = existingExt || extByKind[kind] || "txt";
    const fileName = existingExt ? safeName : `${safeName}.${ext}`;
    specs[name] = `outputs/${fileName}`;
  }
  return specs;
}

function workspaceDownstreamInputDescription(target, slot) {
  const description = String(slot?.description || "").trim();
  if (description) return description;
  return "";
}

function workspaceOutputProtocolRequirements(graph, nodeId) {
  const instance = graph?.instances?.[nodeId] || {};
  const outputSlots = Array.isArray(instance.output) ? instance.output : [];
  const displayBindings = workspaceDownstreamOutputDisplayBindings(graph, nodeId);
  const downstreamInputRequirements = workspaceDownstreamInputRequirements(graph, nodeId);
  const displayByField = new Map();
  for (const binding of displayBindings) {
    if (!displayByField.has(binding.field)) displayByField.set(binding.field, binding.kind);
  }
  const slots = outputSlots
    .filter((slot) => {
      const name = String(slot?.name || "").trim();
      const type = String(slot?.type || "");
      return name && type !== "node" && name !== "next" && name !== "result" && name !== "content" && name !== "displayType";
    })
    .map((slot) => ({
      name: String(slot.name).trim(),
      type: String(slot.type || "").trim().toLowerCase(),
    }));
  const resultSpec = workspaceResultOutputSpec(graph, nodeId);
  const resultKind = resultSpec.kind;
  const resultFile = resultSpec.resultFile;
  const resultKindText = resultKind ? ` ${resultKind}` : "";
  const resultGuidance = {
    html: "内容必须是可直接放入 iframe 渲染的 HTML；不要使用 Markdown 代码围栏。",
    react: "内容必须是 React 工程 JSON，包含 title、entry、files；files 至少包含 src/App.jsx，可包含 CSS 文件。",
    markdown: "内容必须是 Markdown 正文；除非正文确实需要代码块，否则不要额外包裹代码围栏。",
    code: "内容必须是原始代码文本；不要使用 Markdown 代码围栏，也不要附加解释。",
    mermaid: "内容必须是 Mermaid 图表代码，例如 flowchart/sequenceDiagram；不要使用 Markdown 代码围栏。",
    ascii: "内容必须是纯文本/ASCII 图或表格；不要输出 HTML 或 Markdown 装饰。",
    image: "内容必须是可作为 img src 使用的图片地址、data URL 或 base64 data URL；不要输出 Markdown 图片语法。",
    chart: "内容必须是 ChartSpec JSON 对象，包含 type/version/renderer/option；不要输出 HTML、script、iframe 或 JS 函数。",
    table: "内容必须是表格数据，推荐 JSON：{\"columns\":[...],\"rows\":[...]}；不要输出 HTML。",
  }[resultKind] || "内容应满足任务要求。";
  const envelopeExample = [
    "---agentflow",
    "result: |",
    `  <完整${resultKindText || "结果"}正文，每行缩进两个空格>`,
    "outParams:",
    ...slots.slice(0, 3).map((slot) => {
      const kind = displayByField.get(`outParams.${slot.name}`) || "";
      const fileLike = ["file", "image", "audio", "video", "binary"].includes(slot.type);
      return kind || fileLike
        ? `  ${slot.name}: |\n    <完整${kind ? ` ${kind}` : ""}正文，每行缩进四个空格>`
        : `  ${slot.name}: <${slot.name} 的短值>`;
    }),
    "---end",
  ].join("\n");
  const finalInstructions = slots.length
    ? [
        `AgentFlow 会自动把 \`result\` 正文写入 \`${resultFile}\`；不要自行创建该文件，也不要返回 \`resultFile\`。`,
        `额外输出：${slots.map((slot) => `\`${slot.name}\``).join("、")}。文件型或展示型内容也直接内联，AgentFlow 负责落盘和传递。`,
        "最终只输出下面的 agentflow envelope，不要输出解释、进度或其它文字：",
        "",
        envelopeExample,
      ]
    : [
        `AgentFlow 会自动把最终回复写入 \`${resultFile}\`；不要自行创建该文件，不要返回路径或 agentflow envelope。`,
        "最终回复只输出完整结果正文，不要附加解释、进度或其它文字。",
      ];
  return [
    "## 输出",
    "",
    `请返回完整${resultKindText}结果。${resultGuidance}`,
    downstreamInputRequirements ? `\n${downstreamInputRequirements}` : "",
    ...finalInstructions,
  ].join("\n");
}

function workspaceDownstreamInputRequirements(graph, nodeId) {
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const source = instances[String(nodeId || "")] || {};
  const outputSlots = Array.isArray(source.output) ? source.output : [];
  const rows = [];
  const seen = new Set();
  for (const edge of edges) {
    if (String(edge?.source || "") !== String(nodeId)) continue;
    const target = instances[String(edge?.target || "")];
    if (!target) continue;
    const targetSlot = workspaceTargetSlotForEdge(graph, edge);
    if (!targetSlot || isWorkspaceSemanticInputSlot(targetSlot)) continue;
    const targetName = String(targetSlot.name || "").trim();
    const targetType = String(targetSlot.type || "text").trim();
    const description = workspaceDownstreamInputDescription(target, targetSlot);
    if (!targetName && !description) continue;
    const sourceIndex = workspaceHandleIndex(edge?.sourceHandle, "output");
    const sourceSlot = outputSlots[sourceIndex] || null;
    const sourceField = workspaceOutputFieldForSlot(sourceSlot, sourceIndex);
    const targetLabel = String(target.label || target.definitionId || edge.target || "").trim();
    const key = `${sourceField}->${edge.target}:${targetName}:${description}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push([
      `- 输出 \`${sourceField}\` 会连接到下游 \`${targetLabel}\` 的输入 \`${targetName || "input"}\`（type=${targetType}）。`,
      description ? `  要求：${description}` : "",
    ].filter(Boolean).join("\n"));
  }
  if (!rows.length) return "";
  return [
    "下游输入格式要求：",
    ...rows,
  ].join("\n");
}

/**
 * @param {object} [opts]
 * @param {Iterable<string>} [opts.forceNodeIds] 这些节点不吃缓存，一定重跑
 * @param {boolean} [opts.ignoreCache] 整张图都不吃缓存。不能用「forceNodeIds 填上所有节点」
 *   代替：能填进去的只有计划里已经有的节点，而被缓存挡掉的那些恰恰不在计划里
 */
export function workspaceRunPlan(graph, runNodeId, scopedRoot = "", opts = {}) {
  // 一次运行计划里同一个节点的指纹会被问很多遍，算一次就够
  const cacheOpts = {
    fingerprintMemo: new Map(),
    ignoreCache: opts.ignoreCache === true,
    forceNodeIds: new Set(Array.from(opts.forceNodeIds || [], (id) => String(id || "")).filter(Boolean)),
  };
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const target = String(runNodeId || "").trim();
  if (!target || !instances[target]) throw new Error("Missing workspace run node");
  const incoming = new Map();
  const controlDownstream = new Map();
  const validEdges = [];
  for (const edge of edges) {
    const source = String(edge?.source || "");
    const dest = String(edge?.target || "");
    if (!source || !dest || !instances[source] || !instances[dest]) continue;
    validEdges.push(edge);
    if (!incoming.has(dest)) incoming.set(dest, []);
    incoming.get(dest).push(edge);
    if (workspaceIsControlEdge(graph, edge)) {
      if (!controlDownstream.has(source)) controlDownstream.set(source, []);
      controlDownstream.get(source).push(dest);
    }
  }
  const needed = new Set();
  const pauseNodeIds = new Set();
  // Downstream execution is selected only by control edges. Data/context edges
  // are used later to pull in upstream dependencies for selected nodes.
  const addNeeded = (id) => {
    if (!id || needed.has(id)) return;
    const defId = String(instances[id]?.definitionId || "");
    if (id !== target && (defId === "workspace_run" || defId === "workspace_scheduled_run")) {
      pauseNodeIds.add(id);
      return;
    }
    needed.add(id);
  };
  const visitControlDownstream = (id) => {
    for (const next of controlDownstream.get(id) || []) {
      const before = needed.size;
      addNeeded(next);
      if (needed.size !== before) visitControlDownstream(next);
    }
  };
  const targetDefId = String(instances[target]?.definitionId || "");
  const targetIsRunController = targetDefId === "workspace_run" || targetDefId === "workspace_scheduled_run";
  if (!targetIsRunController) needed.add(target);
  visitControlDownstream(target);
  if (targetIsRunController) needed.delete(target);
  const dependencyQueue = Array.from(needed);
  for (let i = 0; i < dependencyQueue.length; i++) {
    const id = dependencyQueue[i];
    for (const edge of incoming.get(id) || []) {
      const source = String(edge?.source || "");
      if (!source || source === target || needed.has(source)) continue;
      if (!workspaceNeedsUpstreamExecutionForEdge(graph, edge, scopedRoot, cacheOpts)) continue;
      addNeeded(source);
      if (needed.has(source)) dependencyQueue.push(source);
    }
  }
  const indegree = new Map(Array.from(needed).map((id) => [id, 0]));
  const dependents = new Map(Array.from(needed).map((id) => [id, []]));
  for (const edge of validEdges) {
    const source = String(edge?.source || "");
    const dest = String(edge?.target || "");
    if (!needed.has(source) || !needed.has(dest)) continue;
    indegree.set(dest, (indegree.get(dest) || 0) + 1);
    dependents.get(source)?.push(dest);
  }
  const ready = Array.from(needed).filter((id) => (indegree.get(id) || 0) === 0);
  const ordered = [];
  while (ready.length) {
    const id = ready.shift();
    ordered.push(id);
    for (const next of dependents.get(id) || []) {
      const n = (indegree.get(next) || 0) - 1;
      indegree.set(next, n);
      if (n === 0) ready.push(next);
    }
  }
  if (ordered.length !== needed.size) {
    throw new Error("Workspace run graph contains a cycle");
  }
  return { order: ordered, pauseNodeIds: Array.from(pauseNodeIds) };
}

function workspaceIsControlInputSlot(slot) {
  const name = String(slot?.name || "");
  const type = String(slot?.type || "");
  return type === "node" || name === "prev" || name === "next";
}

function workspaceIsControlOutputSlot(slot) {
  const name = String(slot?.name || "");
  const type = String(slot?.type || "");
  return type === "node" || name === "prev" || name === "next";
}

function workspaceIsControlEdge(graph, edge) {
  return workspaceIsControlOutputSlot(workspaceSourceSlotForEdge(graph, edge)) ||
    workspaceIsControlInputSlot(workspaceTargetSlotForEdge(graph, edge));
}

function workspaceControlIfBranchToSourceHandle(branch) {
  const text = String(branch || "").trim().toLowerCase();
  if (text === "true" || text === "next1") return "output-0";
  if (text === "false" || text === "next2") return "output-1";
  return null;
}

/**
 * 节点的输入指纹——Merkle 式，传递性自带。
 *
 * 只哈希「决定这次该不该重跑」的东西：节点自身的定义（类型、正文、脚本、包版本）+ 每个
 * 输入槽的来源。来源是上游节点时取**上游的指纹**而不是上游的值：一来省掉读大文件，二来
 * 上游一变，这里自动跟着变，不必再单独做一遍脏传播。
 *
 * 不进指纹的三样东西，各有理由：
 *
 * - **输出槽的值**。指纹描述输入，不描述产出。agent 节点同样输入重跑本来就给不同结果，
 *   把产出算进去等于永远不命中。
 * - **`marketplaceRef` 推导出来的 `script`**。那串里带着本机绝对路径，算进去就换台机器
 *   全部失效。改用 `marketplaceRef` 本身，包版本一升照样失效。
 * - **run 级别的 model**。它是一次运行的旋钮，不是节点的属性；算进去等于换个模型就把
 *   整张图的缓存全推倒。节点自己写死的 model 覆盖仍然计入。
 *
 * 读不到上游（缺节点、成环）时返回空串，调用方按「没有指纹」处理——也就是重跑。
 *
 * @returns {string} 24 位十六进制；节点不存在时为空串
 */
// 分隔符必须是正文不可能出现的字符，否则 `a=x` + `b=y` 会和一个正文里带空格的槽撞出同一个
// 指纹。写成转义而不是直接敲一个 NUL 进源码——裸控制字符会让 grep 把整个文件当二进制，
// 从此对它的搜索全部静默返回空。
const FINGERPRINT_SEP = "\u0000";

function workspaceSubflowFingerprintDescriptor(graph, subflowId, stack = new Set()) {
  const id = String(subflowId || "").trim();
  const subflow = graph?.subflows?.[id];
  if (!id || !subflow) return { id, missing: true };
  if (stack.has(id)) return { id, recursive: true };

  const nextStack = new Set(stack);
  nextStack.add(id);
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  const memberSet = new Set(Array.isArray(subflow.nodeIds) ? subflow.nodeIds.map(String) : []);
  const memberShape = [...memberSet].sort().map((memberId) => {
    const member = instances[memberId] || {};
    return [
      memberId,
      String(member.definitionId || ""),
      String(member.body || ""),
      String(member.script || ""),
      String(member.scriptRef || ""),
      String(member.subflowId || ""),
      String(member.conditionSubflowId || ""),
      String(member.bodySubflowId || ""),
      (member.input || []).map((slot) => [String(slot?.name || ""), String(slot?.type || ""), workspaceSlotValue(slot)]),
    ];
  });
  const internalEdges = (graph?.edges || []).filter((edge) => (
    memberSet.has(String(edge?.source || "")) && memberSet.has(String(edge?.target || ""))
  ));
  const nestedIds = new Set();
  for (const memberId of memberSet) {
    const member = instances[memberId] || {};
    if (String(member.definitionId || "") === "control_subflow_call" && member.subflowId) {
      nestedIds.add(String(member.subflowId));
    }
    if (String(member.definitionId || "") === "control_while") {
      if (member.conditionSubflowId) nestedIds.add(String(member.conditionSubflowId));
      if (member.bodySubflowId) nestedIds.add(String(member.bodySubflowId));
    }
  }
  const nested = [...nestedIds].sort().map((nestedId) => (
    workspaceSubflowFingerprintDescriptor(graph, nestedId, nextStack)
  ));
  return { id, subflow, memberShape, internalEdges, nested };
}

export function workspaceNodeInputFingerprint(graph, nodeId, memo = new Map(), stack = new Set()) {
  const id = String(nodeId || "");
  if (memo.has(id)) return memo.get(id);
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  const instance = instances[id];
  if (!instance || stack.has(id)) return "";
  stack.add(id);

  const marketplaceRef = String(instance.marketplaceRef || "").trim();
  const parts = [
    String(instance.definitionId || ""),
    String(instance.body || ""),
    String(instance.scriptRef || ""),
    marketplaceRef,
    // 包节点的 script 是推导出来的，含本机路径；只有手写的 script 才算数
    marketplaceRef ? "" : String(instance.script || ""),
    String(instance.model || ""),
  ];
  if (String(instance.definitionId || "") === "control_subflow_call") {
    const subflowId = String(instance.subflowId || "");
    parts.push(`subflow=${JSON.stringify(workspaceSubflowFingerprintDescriptor(graph, subflowId))}`);
  }
  if (String(instance.definitionId || "") === "control_while") {
    const conditionSubflowId = String(instance.conditionSubflowId || "");
    const bodySubflowId = String(instance.bodySubflowId || "");
    if (conditionSubflowId || bodySubflowId) {
      parts.push(`whileSubflows=${JSON.stringify({
        condition: workspaceSubflowFingerprintDescriptor(graph, conditionSubflowId),
        body: workspaceSubflowFingerprintDescriptor(graph, bodySubflowId),
      })}`);
    }
  }

  const incoming = new Map();
  for (const edge of Array.isArray(graph?.edges) ? graph.edges : []) {
    if (String(edge?.target || "") !== id) continue;
    if (workspaceIsControlEdge(graph, edge)) continue;
    const slot = workspaceTargetSlotForEdge(graph, edge);
    const name = String(slot?.name || "").trim();
    if (name && !incoming.has(name)) incoming.set(name, edge);
  }

  for (const slot of Array.isArray(instance.input) ? instance.input : []) {
    const name = String(slot?.name || "").trim();
    if (!name || workspaceIsControlInputSlot(slot)) continue;
    const edge = incoming.get(name);
    if (edge) {
      const sourceSlot = workspaceSourceSlotForEdge(graph, edge);
      const upstream = workspaceNodeInputFingerprint(graph, edge.source, memo, stack);
      parts.push(`${name}<=${edge.source}.${String(sourceSlot?.name || "")}:${upstream}`);
    } else {
      parts.push(`${name}=${workspaceSlotValue(slot)}`);
    }
  }

  // provide.* 的值挂在输出槽上，没有输入槽可走
  if (String(instance.definitionId || "").startsWith("provide_")) {
    parts.push(`value=${workspaceInstanceText(instance)}`);
  }

  stack.delete(id);
  const fp = crypto.createHash("sha256").update(parts.join(FINGERPRINT_SEP)).digest("hex").slice(0, 24);
  memo.set(id, fp);
  return fp;
}

function workspaceNeedsUpstreamExecutionForEdge(graph, edge, scopedRoot = "", opts = {}) {
  if (workspaceIsControlEdge(graph, edge)) return true;
  if (opts.ignoreCache) return true;
  if (opts.forceNodeIds?.has(String(edge?.source || ""))) return true;
  return !workspaceEdgeHasCachedOutput(graph, edge, scopedRoot, opts);
}

function workspaceEdgeHasCachedOutput(graph, edge, scopedRoot = "", opts = {}) {
  const sourceId = String(edge?.source || "");
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  const source = instances[sourceId];
  if (!source) return false;
  const defId = String(source.definitionId || "");
  // provide.* 不执行，它的值就是作者填的；没有「上次跑出来的」这回事，也就无从失效
  if (defId === "provide_str" || defId === "provide_json" || defId === "provide_bool" || defId === "provide_file" || defId === "provide_password") {
    return Boolean(String(workspaceInstanceText(source) || "").trim());
  }
  // 有值还不够，得是**这套输入**跑出来的值。指纹对不上说明上游或节点自身改过，重跑
  const memo = opts.fingerprintMemo || new Map();
  if (String(source.runFingerprint || "") !== workspaceNodeInputFingerprint(graph, sourceId, memo)) return false;
  const slot = workspaceSourceSlotForEdge(graph, edge);
  if (!isWorkspaceSemanticOutputSlot(slot) && slot && String(slot?.type || "") !== "node") {
    const value = workspaceSlotValue(slot);
    if (workspaceCachedOutputValueExists(value, scopedRoot)) return true;
  }
  if (workspaceDisplayKind(defId) && String(source.body || "").trim()) return true;
  return false;
}

function workspaceCachedOutputValueExists(value, scopedRoot = "") {
  const text = String(value || "").trim();
  if (!text) return false;
  const outputRel = workspaceSafeNodeOutputRelPath(text);
  if (!outputRel) return true;
  const root = path.resolve(scopedRoot || "");
  if (!root) return false;
  const abs = path.resolve(root, outputRel);
  const rootWithSep = root.endsWith(path.sep) ? root : `${root}${path.sep}`;
  if (abs !== root && !abs.startsWith(rootWithSep)) return false;
  return fs.existsSync(abs) && fs.statSync(abs).isFile();
}

function workspaceUpstreamText(graph, nodeId, outputs, scopedRoot = "") {
  const contentEdge = workspaceContentInputEdge(graph, nodeId);
  if (!contentEdge) return "";
  return workspaceOutputSlotValueForEdge(graph, outputs, contentEdge, scopedRoot);
}

function workspaceContentInputEdge(graph, nodeId) {
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const incoming = edges
    .filter((edge) => String(edge?.target || "") === String(nodeId))
    .filter((edge) => !isWorkspaceSemanticInputSlot(workspaceTargetSlotForEdge(graph, edge)));
  return incoming.find((edge) => String(edge?.targetHandle || "") === "input-1") || incoming[0] || null;
}

function workspaceHandleIndex(handle, prefix) {
  const match = String(handle || "").match(new RegExp(`^${prefix}-(\\d+)$`));
  return match ? Number(match[1]) : 0;
}

function workspaceTargetSlotForEdge(graph, edge) {
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  const target = instances[String(edge?.target || "")];
  const input = Array.isArray(target?.input) ? target.input : [];
  return input[workspaceHandleIndex(edge?.targetHandle, "input")] || null;
}

function isWorkspaceSemanticInputSlot(slot) {
  const name = String(slot?.name || "");
  const type = String(slot?.type || "");
  return type === "node" || type === "context" || name === "prev" || name === "next" || name === "context" || name === "skillsContext" || name === "mcpContext" || name === "knowledgeContext" || name === "workspaceContext" || name === "gitContext";
}

function workspaceAgentInputBlock(inputValues = {}, inputMounts = {}) {
  const entries = Object.entries(inputValues || {}).filter(([name, value]) => String(name || "").trim() && String(value || "").trim());
  if (!entries.length) return "## 输入\n\n无。";
  const lines = entries.map(([name, value]) => {
    const text = String(value || "");
    const clipped = text.length > 6000 ? `${text.slice(0, 6000)}\n...[已截断 ${text.length - 6000} 字]` : text;
    const mount = inputMounts?.[name];
    const mountNote = mount?.mounted
      ? `\n\n> 源文件：\`${mount.source}\`\n> 已挂载为当前任务可读文件：\`${mount.mounted}\`。请读取挂载路径，不要修改源文件。`
      : "";
    return `### ${name}\n\n${clipped}${mountNote}`;
  });
  return ["## 输入", "", ...lines].join("\n");
}

function workspaceNodeFileBoundaryBlock(runPackage = {}) {
  const nodeRunDir = String(runPackage?.nodeRunDir || "").trim();
  const nodeTmpDir = String(runPackage?.nodeTmpDir || "").trim();
  const outputsDir = String(runPackage?.outputsDir || "").trim();
  const outputsRel = String(runPackage?.outputsRel || "outputs").trim() || "outputs";
  if (!nodeRunDir && !nodeTmpDir) return "";
  return [
    "## 文件边界",
    "",
    nodeRunDir ? `- 当前执行目录：\`${nodeRunDir}\`。` : "",
    nodeTmpDir ? `- 临时文件只能写入：\`${nodeTmpDir}\`，也可通过环境变量 \`AGENTFLOW_NODE_TMP_DIR\` 获取。` : "",
    Object.keys(runPackage?.inputMounts || {}).length ? "- 已挂载的输入文件位于本任务 `inputs/`；`inputs/` 只用于读取，正式产物仍写入 `outputs/`。" : "",
    "- 主文本结果和内联额外输出由 AgentFlow 在任务结束后自动写入、发布和清理，无需自行创建结果文件。",
    outputsDir ? `- 可供用户下载的最终产物目录：\`${outputsDir}\`。这不是临时目录，环境变量 \`AGENTFLOW_OUTPUTS_DIR\` 指向这里。` : "",
    outputsDir ? `- CSV、图片、压缩包、工程文件等下载产物必须直接写入 \`AGENTFLOW_OUTPUTS_DIR\`，不要写入当前执行目录中的相对 \`outputs/\`。` : "",
    outputsDir ? `- 该目录中的文件会自动出现在 Workspace Files，对应相对路径为 \`${outputsRel}/\`；回复中引用下载文件时使用这个相对路径。` : "",
    "- 不要在执行目录根部创建 `temp_*`、`_out.json`、`tmp.html` 等临时产物。",
    "- 不要自行删除 run package；AgentFlow 会在运行结束后统一清理。",
  ].filter(Boolean).join("\n");
}

function workspaceTaskUpstreamText(graph, nodeId, outputs, relevantInputNames = null, scopedRoot = "") {
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  const incoming = edges.filter((edge) => String(edge?.target || "") === String(nodeId));
  let contentEdges = incoming.filter((edge) => !isWorkspaceSemanticInputSlot(workspaceTargetSlotForEdge(graph, edge)));
  if (relevantInputNames && relevantInputNames.size) {
    contentEdges = contentEdges.filter((edge) => {
      const slot = workspaceTargetSlotForEdge(graph, edge);
      return relevantInputNames.has(String(slot?.name || "").trim());
    });
  }
  const contentEdge = contentEdges.find((edge) => String(edge?.targetHandle || "") === "input-1") || contentEdges[0];
  if (!contentEdge) return "";
  return workspaceOutputSlotValueForEdge(graph, outputs, contentEdge, scopedRoot);
}

function workspaceInputValues(graph, nodeId, outputs, scopedRoot = "", options = {}) {
  const values = {};
  const includeContext = options?.includeContext === true;
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  const target = instances[String(nodeId || "")] || {};
  const inputSlots = Array.isArray(target.input) ? target.input : [];
  for (const edge of edges) {
    if (String(edge?.target || "") !== String(nodeId)) continue;
    const index = workspaceHandleIndex(edge?.targetHandle, "input");
    const slot = inputSlots[index] || null;
    const name = String(slot?.name || "").trim();
    if (!name || (isWorkspaceSemanticInputSlot(slot) && !(includeContext && name === "context"))) continue;
    const value = workspaceOutputSlotValueForEdge(graph, outputs, edge, scopedRoot);
    if (String(value || "").trim()) values[name] = String(value);
  }
  for (const slot of inputSlots) {
    const name = String(slot?.name || "").trim();
    if (!name || (isWorkspaceSemanticInputSlot(slot) && !(includeContext && name === "context")) || Object.prototype.hasOwnProperty.call(values, name)) continue;
    const value = workspaceSlotValue(slot);
    if (String(value || "").trim()) values[name] = String(value);
  }
  return values;
}

function workspaceResolveBodyPlaceholders(body, inputValues = {}) {
  const raw = String(body || "");
  if (!raw.includes("${")) return raw;
  return raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_-]*)\}/g, (match, name) => {
    if (!Object.prototype.hasOwnProperty.call(inputValues, name)) return match;
    return String(inputValues[name] ?? "");
  });
}

function workspacePromptUpstreamText(upstreamText, runPackage = {}) {
  const raw = String(upstreamText || "").trim();
  if (!raw) return "";
  for (const [name, mount] of Object.entries(runPackage?.inputMounts || {})) {
    if (!mount?.mounted) continue;
    if (raw === String(mount.source || "").trim() || raw === String(mount.mounted || "").trim()) {
      return `输入 \`${name}\` 已挂载为 \`${mount.mounted}\`。源文件：\`${mount.source}\`。`;
    }
  }
  return upstreamText;
}

function workspaceImplementationInlineText(instance) {
  const candidates = [instance?.implementation, instance?.implementationPlan];
  for (const item of candidates) {
    if (item == null) continue;
    if (typeof item === "string" && item.trim()) return item.trim();
    if (typeof item === "object" && !Array.isArray(item)) {
      const content = item.content ?? item.body ?? item.notes ?? "";
      if (String(content || "").trim()) return String(content).trim();
    }
  }
  return "";
}

function workspaceMaterializeImplementationReference(instance, scopedRoot, runPackage = {}) {
  const implementationRef = String(instance?.implementationRef || "").trim();
  if (!implementationRef) return null;
  const abs = workspaceResolveFlowFile(scopedRoot, implementationRef, "implementationRef");
  const exists = fs.existsSync(abs) && fs.statSync(abs).isFile();
  const nodeRunDir = String(runPackage?.nodeRunDir || "").trim();
  let mounted = "";
  if (exists && nodeRunDir) {
    try {
      const mountedRel = path.join("references", "implementation.md");
      const dest = path.resolve(nodeRunDir, mountedRel);
      const nodeRunWithSep = nodeRunDir.endsWith(path.sep) ? nodeRunDir : `${nodeRunDir}${path.sep}`;
      if (dest === nodeRunDir || dest.startsWith(nodeRunWithSep)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(abs, dest);
        mounted = mountedRel.split(path.sep).join(path.posix.sep);
      }
    } catch {
      mounted = "";
    }
  }
  return { implementationRef, exists, mounted };
}

function workspaceImplementationBlock(instance, scopedRoot, runPackage = {}) {
  if (!WORKSPACE_IMPLEMENTATION_REFERENCE_ENABLED) return "";
  const ref = workspaceMaterializeImplementationReference(instance, scopedRoot, runPackage);
  const inline = workspaceImplementationInlineText(instance);
  if (!ref && !inline) return "";
  const mode = String(instance?.implementationMode || "").trim();
  return [
    "## 参考实现方案",
    "",
    mode ? `mode: ${mode}` : "",
    ref ? `- 实现方案文件：\`${ref.mounted || ref.implementationRef}\`` : "",
    ref?.mounted ? `- 原始流水线路径：\`${ref.implementationRef}\`` : "",
    ref && !ref.exists ? "- 当前实现方案文件不存在，本次不要依赖旧方案。" : "",
    inline ? "- 节点存在内联实现方案字段，但本提示不会内联其内容；如需复用，请优先参考实现方案文件。" : "",
    "",
    "该文件只作为可选参考，用于了解上次执行的实现路径。不要把旧方案当成硬约束；如果与当前任务、输入或输出要求冲突，以当前任务为准。",
    "只有在需要复用细节或确认历史约定时才读取该文件；不要在最终回复中复述参考方案内容。",
  ].filter((line) => line !== "").join("\n");
}

function workspaceSafeNodeFileName(nodeId) {
  const text = String(nodeId || "").trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "");
  return text || "node";
}

function workspaceDefaultImplementationRef(nodeId) {
  return `nodes/${workspaceSafeNodeFileName(nodeId)}/implementation.md`;
}

function workspaceDefaultHistoryRef(nodeId) {
  return `nodes/${workspaceSafeNodeFileName(nodeId)}/history.md`;
}

function workspaceMaterializeNodeHistoryReference(nodeId, scopedRoot, runPackage = {}) {
  const historyRef = workspaceDefaultHistoryRef(nodeId);
  const abs = workspaceResolveFlowFile(scopedRoot, historyRef, "historyRef");
  const exists = fs.existsSync(abs) && fs.statSync(abs).isFile();
  const nodeRunDir = String(runPackage?.nodeRunDir || "").trim();
  let mounted = "";
  if (exists && nodeRunDir) {
    try {
      const mountedRel = path.join("references", "history.md");
      const dest = path.resolve(nodeRunDir, mountedRel);
      const nodeRunWithSep = nodeRunDir.endsWith(path.sep) ? nodeRunDir : `${nodeRunDir}${path.sep}`;
      if (dest === nodeRunDir || dest.startsWith(nodeRunWithSep)) {
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(abs, dest);
        mounted = mountedRel.split(path.sep).join(path.posix.sep);
      }
    } catch {
      mounted = "";
    }
  }
  return { historyRef, exists, mounted };
}

function workspaceNodeHistoryBlock(nodeId, scopedRoot, runPackage = {}) {
  const ref = workspaceMaterializeNodeHistoryReference(nodeId, scopedRoot, runPackage);
  if (!ref?.exists) return "";
  return [
    "## 历史参考",
    "",
    `- 历史记录文件：\`${ref.mounted || ref.historyRef}\``,
    ref.mounted ? `- 原始流水线路径：\`${ref.historyRef}\`` : "",
    "",
    "该文件只记录之前运行时的 thinking 摘要与最终结论，用作轻量参考；不要把历史当成硬约束。若历史与当前任务、输入或输出要求冲突，以当前任务为准。",
  ].filter((line) => line !== "").join("\n");
}

function workspaceImplementationModeForInstance(instance) {
  const explicit = String(instance?.implementationMode || "").trim();
  if (explicit) return explicit;
  return String(instance?.definitionId || "") === "tool_nodejs" ? "script" : "steps";
}

function workspaceClipImplementationText(value, maxChars = 2400) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n...[truncated ${text.length - maxChars} chars]` : text;
}

function workspaceUniqueImplementationList(items = [], maxItems = 12) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const text = String(item || "").trim();
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function workspaceImplementationArtifactCandidates(structured = {}, result = "") {
  const candidates = [
    structured.resultFile,
    structured.result,
    result,
    ...Object.values(structured.outParams || {}),
  ];
  return workspaceUniqueImplementationList(candidates, 10)
    .filter((item) => /^(?:outputs|nodes|artifacts)\//.test(item) && !/[\r\n]/.test(item));
}

function workspaceReadImplementationArtifact(scopedRoot, structured = {}, result = "") {
  const root = String(scopedRoot || "").trim();
  if (!root) return null;
  for (const rel of workspaceImplementationArtifactCandidates(structured, result)) {
    let abs = "";
    try {
      abs = workspaceResolveFlowFile(root, rel, "resultFile");
    } catch {
      continue;
    }
    if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    const ext = path.extname(abs).toLowerCase();
    const content = workspaceReadTextFileIfExists(abs, 120000);
    if (!content.trim()) continue;
    return { rel, abs, ext, content };
  }
  return null;
}

function workspaceImplementationArtifactContext(scopedRoot, structured = {}, result = "") {
  const artifact = workspaceReadImplementationArtifact(scopedRoot, structured, result);
  if (!artifact) return "无可读取产物文件。";
  return [
    `产物路径：${artifact.rel}`,
    `文件类型：${artifact.ext || "(unknown)"}`,
    "",
    "产物内容：",
    "```",
    workspaceClipImplementationText(artifact.content, 50000),
    "```",
  ].join("\n");
}

function workspaceBuildImplementationPrompt(instance, nodeId, opts = {}) {
  const defId = String(instance?.definitionId || "").trim();
  const label = String(instance?.label || nodeId || "node").trim();
  const mode = workspaceImplementationModeForInstance(instance);
  const inputValues = opts.inputValues || {};
  const structured = opts.structured && typeof opts.structured === "object" ? opts.structured : {};
  const result = String(opts.resultContent || structured.result || "").trim();
  const task = workspaceResolveBodyPlaceholders(instance?.body || "", inputValues).trim();
  const scriptRef = String(instance?.scriptRef || "").trim();
  const inlineScript = String(instance?.script || "").trim();
  const previousImplementation = opts.previousImplementation
    ? workspaceClipImplementationText(opts.previousImplementation, 12000)
    : "";
  return [
    "你要为 AgentFlow 的一个节点写“实现方案”Markdown。这个文件会在下次运行同一个节点前作为上下文给模型参考。",
    "",
    "要求：",
    "- 必须基于实际任务、输入和产物内容自己总结，不要写流水账，不要写“使用 Agent 生成输出”这类空话。",
    "- 写清楚这次结果到底是如何实现的：核心思路、产物结构、关键文件/路径、关键样式/函数/数据结构、可复用约定。",
    "- 写清楚下次如果要继续迭代，应该从哪里改、哪些约定不能破坏。",
    "- 如果产物是 HTML/UI，必须总结页面模块、视觉风格、关键 class/token、交互点和下游展示契约。",
    "- 如果产物是脚本，必须总结脚本入口、环境变量、输入输出协议和错误处理方式。",
    "- 只输出 Markdown 正文，不要输出代码围栏包裹整篇，不要解释你在总结。",
    "",
    "## 节点信息",
    "",
    `nodeId: ${nodeId}`,
    `label: ${label}`,
    `definitionId: ${defId || "(unknown)"}`,
    `mode: ${mode}`,
    scriptRef ? `scriptRef: ${scriptRef}` : "",
    inlineScript ? `inlineScript: ${workspaceClipImplementationText(inlineScript, 1200)}` : "",
    "",
    "## 当前任务",
    "",
    workspaceClipImplementationText(task || instance?.body || scriptRef || inlineScript || "(无显式任务)", 6000),
    "",
    "## 输入",
    "",
    JSON.stringify(inputValues || {}, null, 2),
    "",
    "## 输出",
    "",
    JSON.stringify({
      result: structured.result || result,
      resultFile: structured.resultFile || "",
      outParams: structured.outParams || {},
    }, null, 2),
    "",
    previousImplementation ? "## 上一版实现方案" : "",
    previousImplementation || "",
    previousImplementation ? "" : "",
    "## 实际产物上下文",
    "",
    workspaceImplementationArtifactContext(opts.scopedRoot, structured, result),
  ].filter((line) => line !== "").join("\n");
}

function workspaceImplementationPlanNeighbors(graph, nodeId) {
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const incoming = [];
  const outgoing = [];
  for (const edge of edges) {
    if (String(edge?.target || "") === String(nodeId)) {
      const sourceId = String(edge?.source || "");
      if (sourceId) incoming.push(`${sourceId} (${instances[sourceId]?.label || instances[sourceId]?.definitionId || "node"})`);
    }
    if (String(edge?.source || "") === String(nodeId)) {
      const targetId = String(edge?.target || "");
      if (targetId) outgoing.push(`${targetId} (${instances[targetId]?.label || instances[targetId]?.definitionId || "node"})`);
    }
  }
  return {
    incoming: workspaceUniqueImplementationList(incoming, 20),
    outgoing: workspaceUniqueImplementationList(outgoing, 20),
  };
}

function workspaceBuildPlannedImplementationPrompt(graph, nodeId, opts = {}) {
  const instance = graph?.instances?.[nodeId] || {};
  const defId = String(instance?.definitionId || "").trim();
  const label = String(instance?.label || nodeId || "node").trim();
  const mode = workspaceImplementationModeForInstance(instance);
  const inputValues = opts.inputValues || {};
  const task = workspaceResolveBodyPlaceholders(instance?.body || "", inputValues).trim();
  const scriptRef = String(instance?.scriptRef || "").trim();
  const inlineScript = String(instance?.script || "").trim();
  const previousImplementation = opts.previousImplementation
    ? workspaceClipImplementationText(opts.previousImplementation, 12000)
    : "";
  const neighbors = workspaceImplementationPlanNeighbors(graph, nodeId);
  return [
    "你要为 AgentFlow Workspace 的一个重复执行节点提前写“实现方案”Markdown。",
    "这个 implementation.md 会在后续 Scheduled Run 执行同一节点前作为参考上下文，目标是减少重复推理、提前固定执行路径和脚本约定。",
    "",
    "要求：",
    "- 基于当前节点任务、输入槽、上下游关系，写一份可复用的执行方案。",
    "- 写清楚下次运行应优先采用的步骤、文件路径、输入输出协议、错误处理和可复用约定。",
    "- 如果是脚本类节点，重点写清楚脚本入口、环境变量、输入 JSON/输出文件协议、幂等性和失败重试策略。",
    "- 不要假装已经执行过；这是执行前优化计划，不要引用不存在的实际结果。",
    "- 只输出 Markdown 正文，不要输出代码围栏包裹整篇。",
    "",
    "## 节点信息",
    "",
    `nodeId: ${nodeId}`,
    `label: ${label}`,
    `definitionId: ${defId || "(unknown)"}`,
    `mode: ${mode}`,
    scriptRef ? `scriptRef: ${scriptRef}` : "",
    inlineScript ? `inlineScript: ${workspaceClipImplementationText(inlineScript, 2400)}` : "",
    "",
    "## 当前任务",
    "",
    workspaceClipImplementationText(task || instance?.body || scriptRef || inlineScript || "(无显式任务)", 8000),
    "",
    "## 可见输入",
    "",
    JSON.stringify(inputValues || {}, null, 2),
    "",
    "## 上下游",
    "",
    `incoming: ${neighbors.incoming.length ? neighbors.incoming.join(", ") : "(none)"}`,
    `outgoing: ${neighbors.outgoing.length ? neighbors.outgoing.join(", ") : "(none)"}`,
    "",
    previousImplementation ? "## 上一版实现方案" : "",
    previousImplementation || "",
  ].filter((line) => line !== "").join("\n");
}

async function workspaceGeneratePlannedImplementationMarkdown({
  scopedRoot,
  graph,
  nodeId,
  inputValues,
  implementationPath,
  previousImplementation,
  runPackage,
  modelKey,
  userCtx,
  emit,
  onActiveChild,
}) {
  const prompt = workspaceBuildPlannedImplementationPrompt(graph, nodeId, {
    inputValues,
    previousImplementation,
  });
  let content = "";
  let lastAssistant = "";
  let resultText = "";
  emit?.({ type: "status", nodeId, line: `Generate implementation plan: ${nodeId}` });
  const handle = startComposerAgent({
    uiWorkspaceRoot: scopedRoot,
    cliWorkspace: runPackage?.nodeRunDir || scopedRoot,
    prompt,
    modelKey,
    agentflowUserId: userCtx?.userId || "",
    detached: process.platform !== "win32",
    onChild: onActiveChild,
    extraEnv: runtimeEnvForUser(userCtx, {
      AGENTFLOW_IMPLEMENTATION_REF: implementationPath || "",
      AGENTFLOW_NODE_RUN_DIR: runPackage?.nodeRunDir || "",
      AGENTFLOW_NODE_TMP_DIR: runPackage?.nodeTmpDir || "",
      AGENTFLOW_OUTPUTS_DIR: runPackage?.outputsDir || "",
    }),
    onStreamEvent: (ev) => {
      if (ev?.type === "natural" && ev.kind === "assistant" && typeof ev.text === "string") {
        lastAssistant = ev.text;
        content += (content ? "\n" : "") + ev.text;
      } else if (ev?.type === "natural" && ev.kind === "result" && typeof ev.text === "string") {
        resultText = ev.text;
      }
    },
    onToolCall: (subtype, toolName) => {
      const sub = subtype ? String(subtype) : "";
      const tool = toolName ? String(toolName) : "";
      emit?.({ type: "status", nodeId, line: `优化工具 ${tool || "thinking"}${sub ? ` (${sub})` : ""}` });
    },
  });
  try {
    await handle.finished;
  } finally {
    if (typeof onActiveChild === "function") onActiveChild(null);
  }
  const markdown = String(resultText || lastAssistant || content || "").trim();
  return markdown.replace(/^```(?:markdown|md)?\s*/i, "").replace(/```\s*$/i, "").trim();
}

async function workspaceGenerateImplementationMarkdown({
  scopedRoot,
  nodeId,
  instance,
  inputValues,
  resultContent,
  structured,
  implementationPath,
  previousImplementation,
  runPackage,
  modelKey,
  userCtx,
  emit,
  onActiveChild,
}) {
  const prompt = workspaceBuildImplementationPrompt(instance, nodeId, {
    scopedRoot,
    inputValues,
    resultContent,
    structured,
    previousImplementation,
  });
  let content = "";
  let lastAssistant = "";
  let resultText = "";
  emit?.({ type: "status", line: "Summarize implementation plan with model" });
  const handle = startComposerAgent({
    uiWorkspaceRoot: scopedRoot,
    cliWorkspace: runPackage?.nodeRunDir || scopedRoot,
    prompt,
    modelKey,
    agentflowUserId: userCtx?.userId || "",
    detached: process.platform !== "win32",
    onChild: onActiveChild,
    extraEnv: runtimeEnvForUser(userCtx, {
      AGENTFLOW_IMPLEMENTATION_REF: implementationPath || "",
      AGENTFLOW_NODE_RUN_DIR: runPackage?.nodeRunDir || "",
      AGENTFLOW_NODE_TMP_DIR: runPackage?.nodeTmpDir || "",
      AGENTFLOW_OUTPUTS_DIR: runPackage?.outputsDir || "",
    }),
    onStreamEvent: (ev) => {
      if (ev?.type === "natural" && ev.kind === "assistant" && typeof ev.text === "string") {
        lastAssistant = ev.text;
        content += (content ? "\n" : "") + ev.text;
      } else if (ev?.type === "natural" && ev.kind === "result" && typeof ev.text === "string") {
        resultText = ev.text;
      }
    },
    onToolCall: (subtype, toolName) => {
      const sub = subtype ? String(subtype) : "";
      const tool = toolName ? String(toolName) : "";
      emit?.({ type: "status", line: `总结方案工具 ${tool || "thinking"}${sub ? ` (${sub})` : ""}` });
    },
  });
  try {
    await handle.finished;
  } finally {
    if (typeof onActiveChild === "function") onActiveChild(null);
  }
  const markdown = String(resultText || lastAssistant || content || "").trim();
  return markdown.replace(/^```(?:markdown|md)?\s*/i, "").replace(/```\s*$/i, "").trim();
}

function workspaceHistoryTextFromEvents(events = [], kind, maxItems = 24, maxChars = 12000) {
  const parts = [];
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || ev.kind !== kind) continue;
    const text = String(ev.text || "").trim();
    if (!text) continue;
    parts.push(text);
    if (parts.length >= maxItems) break;
  }
  return workspaceClipImplementationText(parts.join("\n"), maxChars);
}

function workspaceBuildNodeHistoryEntry(instance, nodeId, opts = {}) {
  const inputValues = opts.inputValues || {};
  const structured = opts.structured && typeof opts.structured === "object" ? opts.structured : {};
  const result = String(opts.resultContent || structured.result || "").trim();
  const task = workspaceResolveBodyPlaceholders(instance?.body || "", inputValues).trim();
  const thinking = workspaceHistoryTextFromEvents(opts.historyEvents || [], "thinking", 40, 16000);
  const assistant = workspaceHistoryTextFromEvents(opts.historyEvents || [], "assistant", 8, 8000);
  const resultEvent = workspaceHistoryTextFromEvents(opts.historyEvents || [], "result", 4, 12000);
  const conclusion = workspaceClipImplementationText(resultEvent || result || assistant, 20000);
  return [
    `## ${new Date().toISOString()} · ${nodeId}`,
    "",
    `label: ${String(instance?.label || nodeId || "node")}`,
    `definitionId: ${String(instance?.definitionId || "(unknown)")}`,
    "",
    "### 任务",
    "",
    workspaceClipImplementationText(task || instance?.body || instance?.scriptRef || instance?.script || "(无显式任务)", 6000),
    "",
    Object.keys(inputValues || {}).length ? "### 输入摘要" : "",
    Object.keys(inputValues || {}).length ? "" : "",
    Object.keys(inputValues || {}).length ? workspaceClipImplementationText(JSON.stringify(inputValues, null, 2), 8000) : "",
    Object.keys(inputValues || {}).length ? "" : "",
    thinking ? "### Thinking 摘要" : "",
    thinking ? "" : "",
    thinking || "",
    thinking ? "" : "",
    "### 结论",
    "",
    conclusion || "(无结论内容)",
    "",
    "### 输出协议",
    "",
    JSON.stringify({
      result: workspaceClipImplementationText(structured.result || result, 4000),
      resultFile: structured.resultFile || "",
      outParams: structured.outParams || {},
    }, null, 2),
  ].filter((line) => line !== "").join("\n");
}

function workspaceClipNodeHistory(value, maxChars = WORKSPACE_NODE_HISTORY_MAX_CHARS) {
  const text = String(value || "").trim();
  if (text.length <= maxChars) return text;
  return [
    "# Workspace Node History",
    "",
    "> Older history was truncated to keep this reference lightweight.",
    "",
    text.slice(-maxChars),
  ].join("\n").trim();
}

function workspacePersistNodeHistory(scopedRoot, graph, nodeId, opts = {}) {
  const current = graph?.instances?.[nodeId];
  if (!current || String(current.definitionId || "") === "workspace_run" || String(current.definitionId || "") === "workspace_scheduled_run") {
    return { changed: false, wrote: false, instance: current };
  }
  const historyRef = workspaceDefaultHistoryRef(nodeId);
  const abs = workspaceResolveFlowFile(scopedRoot, historyRef, "historyRef");
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const previous = fs.existsSync(abs) && fs.statSync(abs).isFile()
    ? workspaceReadTextFileIfExists(abs, WORKSPACE_NODE_HISTORY_MAX_CHARS + 20000)
    : "# Workspace Node History\n";
  const entry = workspaceBuildNodeHistoryEntry(current, nodeId, opts);
  const nextText = workspaceClipNodeHistory(`${previous.trimEnd()}\n\n${entry}\n`);
  fs.writeFileSync(abs, `${nextText.trimEnd()}\n`, "utf-8");
  return { changed: false, wrote: true, instance: current, historyRef };
}

async function workspacePersistNodeImplementation(scopedRoot, graph, nodeId, opts = {}) {
  const current = graph?.instances?.[nodeId];
  if (!current || String(current.definitionId || "") === "workspace_run" || String(current.definitionId || "") === "workspace_scheduled_run") {
    return { changed: false, wrote: false, instance: current };
  }
  if (!WORKSPACE_IMPLEMENTATION_SUMMARY_ENABLED) {
    return workspacePersistNodeHistory(scopedRoot, graph, nodeId, opts);
  }
  const existingRef = String(current.implementationRef || "").trim();
  const implementationRef = existingRef || workspaceDefaultImplementationRef(nodeId);
  const abs = workspaceResolveFlowFile(scopedRoot, implementationRef, "implementationRef");
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const previousImplementation = fs.existsSync(abs) && fs.statSync(abs).isFile()
    ? workspaceReadTextFileIfExists(abs, 60000)
    : "";
  const markdown = await workspaceGenerateImplementationMarkdown({
    scopedRoot,
    nodeId,
    instance: current,
    inputValues: opts.inputValues || {},
    resultContent: opts.resultContent || "",
    structured: opts.structured || {},
    implementationPath: implementationRef,
    previousImplementation,
    runPackage: opts.runPackage,
    modelKey: opts.modelKey || "",
    userCtx: opts.userCtx || {},
    emit: opts.emit,
    onActiveChild: opts.onActiveChild,
  });
  if (!markdown.trim()) throw new Error(`Implementation summary is empty for node ${nodeId}`);
  fs.writeFileSync(abs, markdown.trimEnd() + "\n", "utf-8");
  const explicitMode = String(current.implementationMode || "").trim();
  const next = {
    ...current,
    implementationRef,
    ...(explicitMode ? { implementationMode: explicitMode } : {}),
  };
  const changed = String(current.implementationRef || "") !== implementationRef;
  return { changed, wrote: true, instance: next, implementationRef };
}

async function workspaceTryPersistNodeImplementation(scopedRoot, graph, nodeId, opts = {}) {
  try {
    return await workspacePersistNodeImplementation(scopedRoot, graph, nodeId, opts);
  } catch (e) {
    opts.emit?.({
      type: "natural",
      kind: "warning",
      text: WORKSPACE_IMPLEMENTATION_SUMMARY_ENABLED
        ? `实现方案未更新：${e?.message || String(e)}`
        : `历史记录未更新：${e?.message || String(e)}`,
    });
    return { changed: false, wrote: false, instance: graph?.instances?.[nodeId] };
  }
}

function workspaceShouldOptimizeNodeImplementation(instance) {
  const defId = String(instance?.definitionId || "").trim();
  if (!defId) return false;
  if (defId === "workspace_run" || defId === "workspace_scheduled_run") return false;
  if (defId.startsWith("display_") || defId.startsWith("provide_") || defId.startsWith("control_")) return false;
  return defId === "agent_subAgent" || defId === "tool_nodejs" || defId.startsWith("tool_");
}

async function workspaceOptimizeNodeImplementation(scopedRoot, graph, nodeId, opts = {}) {
  const current = graph?.instances?.[nodeId];
  if (!current || !workspaceShouldOptimizeNodeImplementation(current)) {
    return { optimized: false, skipped: true, nodeId, reason: "not optimizable" };
  }
  const implementationRef = String(current.implementationRef || "").trim() || workspaceDefaultImplementationRef(nodeId);
  const abs = workspaceResolveFlowFile(scopedRoot, implementationRef, "implementationRef");
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  const previousImplementation = fs.existsSync(abs) && fs.statSync(abs).isFile()
    ? workspaceReadTextFileIfExists(abs, 60000)
    : "";
  const inputValues = workspaceInputValues(graph, nodeId, new Map(), scopedRoot);
  const runPackage = workspaceCreateNodeRunPackage(opts.runTmpRoot || workspaceCreateRunTmpRoot(scopedRoot, "optimize"), nodeId, {
    scopedRoot,
    cwd: scopedRoot,
    task: workspaceResolveBodyPlaceholders(current.body || current.script || current.scriptRef || "", inputValues),
    inputValues,
  });
  const markdown = await workspaceGeneratePlannedImplementationMarkdown({
    scopedRoot,
    graph,
    nodeId,
    inputValues: { ...inputValues, ...(runPackage.inputValues || {}) },
    implementationPath: implementationRef,
    previousImplementation,
    runPackage,
    modelKey: opts.modelKey || "",
    userCtx: opts.userCtx || {},
    emit: opts.emit,
    onActiveChild: opts.onActiveChild,
  });
  if (!markdown.trim()) throw new Error(`Implementation plan is empty for node ${nodeId}`);
  fs.writeFileSync(abs, markdown.trimEnd() + "\n", "utf-8");
  const explicitMode = String(current.implementationMode || "").trim();
  graph.instances[nodeId] = {
    ...current,
    implementationRef,
    implementationMode: explicitMode || workspaceImplementationModeForInstance(current),
  };
  return { optimized: true, nodeId, implementationRef };
}

export async function workspaceOptimizeRunImplementations(root, scopedRoot, payload, userCtx = {}, opts = {}) {
  const graph = hydrateWorkspaceGraphForRuntime(root, {
    root: scopedRoot,
    flowId: payload.flowId || "",
    flowSource: payload.flowSource || "user",
    archived: payload.archived === true || payload.flowArchived === true,
  }, payload.graph || {}, userCtx);
  const runNodeId = String(payload?.runNodeId || "").trim();
  const plan = workspaceRunPlan(graph, runNodeId, scopedRoot);
  const runTmpRoot = workspaceCreateRunTmpRoot(scopedRoot, `${runNodeId || "run"}-optimize`);
  const optimized = [];
  const skipped = [];
  for (const nodeId of plan.order) {
    const instance = graph.instances?.[nodeId];
    if (!workspaceShouldOptimizeNodeImplementation(instance)) {
      skipped.push({ nodeId, reason: "not optimizable" });
      continue;
    }
    opts.emit?.({ type: "node-start", nodeId, definitionId: instance.definitionId, phase: "optimize" });
    const result = await workspaceOptimizeNodeImplementation(scopedRoot, graph, nodeId, {
      runTmpRoot,
      modelKey: payload.model || "",
      userCtx,
      emit: opts.emit,
      onActiveChild: opts.onActiveChild,
    });
    optimized.push(result);
    opts.emit?.({ type: "node-done", nodeId, definitionId: instance.definitionId, phase: "optimize", implementationRef: result.implementationRef });
  }
  return { ok: true, graph, order: plan.order, optimized, skipped };
}

function parseWorkspaceSkillKeys(raw) {
  const text = String(raw || "").trim();
  if (!text) return [];
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed.map((item) => String(item || "").trim()).filter(Boolean);
  } catch {
    /* plain list fallback */
  }
  return text.split(/[\n,]+/).map((item) => item.trim()).filter(Boolean);
}

function selectedSkillKeysFromInstance(instance) {
  const bodyKeys = parseWorkspaceSkillKeys(instance?.body || "");
  if (bodyKeys.length > 0) return bodyKeys;
  return selectedSkillKeysFromConfigSlots(instance);
}

function selectedSkillKeysFromConfigSlots(instance) {
  const slots = [...(Array.isArray(instance?.input) ? instance.input : []), ...(Array.isArray(instance?.output) ? instance.output : [])];
  const slot = slots.find((item) => item?.name === "skills") ||
    slots.find((item) => item?.name === "skillsContext") ||
    slots.find((item) => item?.name === "skillKeys");
  return parseWorkspaceSkillKeys(workspaceSlotValue(slot) || "");
}

function selectedMcpServerNamesFromInstance(instance) {
  const bodyNames = parseWorkspaceSkillKeys(instance?.body || "");
  if (bodyNames.length > 0) return bodyNames;
  const slots = [...(Array.isArray(instance?.input) ? instance.input : []), ...(Array.isArray(instance?.output) ? instance.output : [])];
  const slot = slots.find((item) => item?.name === "mcpContext") || slots.find((item) => item?.name === "serverNames");
  return parseWorkspaceSkillKeys(workspaceSlotValue(slot) || "");
}

function workspaceUpstreamSkillBlocks(graph, nodeId, outputs) {
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const blocks = edges
    .filter((edge) => String(edge?.target || "") === String(nodeId))
    .filter((edge) => {
      const slot = workspaceTargetSlotForEdge(graph, edge);
      return String(slot?.name || "") === "skillsContext";
    })
    .map((edge) => workspaceOutputSlotValueForEdge(graph, outputs, edge))
    .flatMap((text) => text.split(/\n\s*---\s*\n/g))
    .map((text) => text.trim())
    .filter(Boolean);
  return Array.from(new Set(blocks)).join("\n\n---\n\n");
}

function workspaceUpstreamMcpBlocks(graph, nodeId, outputs) {
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const blocks = edges
    .filter((edge) => String(edge?.target || "") === String(nodeId))
    .filter((edge) => {
      const slot = workspaceTargetSlotForEdge(graph, edge);
      return String(slot?.name || "") === "mcpContext";
    })
    .map((edge) => workspaceOutputSlotValueForEdge(graph, outputs, edge))
    .flatMap((text) => text.split(/\n\s*---\s*\n/g))
    .map((text) => text.trim())
    .filter(Boolean);
  return Array.from(new Set(blocks)).join("\n\n---\n\n");
}

function workspaceSemanticInputText(graph, nodeId, outputs, name, scopedRoot = "") {
  const targetName = String(name || "").trim();
  if (!targetName) return "";
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const edge = edges
    .filter((item) => String(item?.target || "") === String(nodeId))
    .find((item) => String(workspaceTargetSlotForEdge(graph, item)?.name || "") === targetName);
  if (edge) return workspaceOutputSlotValueForEdge(graph, outputs, edge, scopedRoot);
  const instance = graph?.instances && typeof graph.instances === "object" ? graph.instances[String(nodeId || "")] : null;
  return workspaceSlotValue(workspaceSlotByName(instance, targetName));
}

function workspaceContextBundleFromText(text) {
  const parsed = parseJsonText(String(text || "").trim(), null);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  if (Number(parsed.version || 1) !== 1) return {};
  const out = {};
  for (const name of ["knowledgeContext", "skillsContext", "workspaceContext", "mcpContext"]) {
    if (parsed[name] !== undefined && parsed[name] !== null) {
      out[name] = typeof parsed[name] === "string" ? parsed[name] : JSON.stringify(parsed[name]);
    }
  }
  return out;
}

function workspaceNodeContextBundle(graph, nodeId, outputs, scopedRoot = "") {
  return workspaceContextBundleFromText(
    workspaceSemanticInputText(graph, nodeId, outputs, "context", scopedRoot),
  );
}

function workspaceContextObjectFromText(text, baseCwd, scopedRoot) {
  const raw = String(text || "").trim();
  if (!raw) return null;
  const parsed = parseJsonText(raw, null);
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
  const resolved = workspaceResolvePath(baseCwd || scopedRoot, raw) || raw;
  return {
    version: 1,
    label: "workspace",
    cwd: resolved,
    workspaceRoot: resolved,
    pipelineWorkspace: scopedRoot ? path.resolve(scopedRoot) : "",
    previous: null,
  };
}

function workspaceLooksLikeKnowledgePath(value) {
  const raw = String(value || "").trim();
  return Boolean(raw) &&
    raw.length <= 4096 &&
    !/[\r\n<>]/.test(raw) &&
    !/^```/.test(raw) &&
    !/^<!doctype/i.test(raw);
}

function workspaceKnowledgeSourceFromObject(source = {}, baseCwd = "", scopedRoot = "") {
  if (typeof source === "string") {
    const ref = source.trim();
    if (!ref) return null;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref)) {
      return { id: ref, label: ref, kind: "binding", type: "", path: "", repoPath: "", mountPath: "", repoUrl: "", branch: "", ref, readonly: true };
    }
    source = { path: ref };
  }
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const ref = String(source.ref || source.binding || "").trim();
  const rawPath = String(source.path || source.repoPath || source.cwd || source.workspaceRoot || "").trim();
  if (!workspaceLooksLikeKnowledgePath(rawPath) && !ref) return null;
  const resolvedPath = rawPath ? (workspaceResolvePath(baseCwd || scopedRoot, rawPath) || rawPath) : "";
  return {
    id: String(source.id || source.mountPath || source.label || path.basename(resolvedPath) || ref || "").trim(),
    label: String(source.label || source.id || source.mountPath || path.basename(resolvedPath) || ref || "知识库").trim(),
    kind: String(source.kind || (source.repoUrl ? "git" : (ref ? "binding" : "local"))).trim() || "local",
    type: String(source.type || "").trim(),
    path: resolvedPath,
    repoPath: resolvedPath,
    mountPath: String(source.mountPath || "").trim(),
    repoUrl: String(source.repoUrl || "").trim(),
    branch: String(source.branch || "").trim(),
    ref,
    readonly: source.readonly !== false,
  };
}

export function workspaceKnowledgeSourcesFromText(text, baseCwd = "", scopedRoot = "") {
  const raw = String(text || "").trim();
  if (!raw) return [];
  const parsed = parseJsonText(raw, null);
  const candidates = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === "object" && Array.isArray(parsed.sources)
      ? parsed.sources
      : (parsed && typeof parsed === "object" && (parsed.path || parsed.repoPath || parsed.cwd || parsed.workspaceRoot) ? [parsed] : []));
  if (candidates.length) {
    return candidates
      .map((source) => workspaceKnowledgeSourceFromObject(source, baseCwd, scopedRoot))
      .filter(Boolean);
  }
  if (!workspaceLooksLikeKnowledgePath(raw)) return [];
  const resolved = workspaceResolvePath(baseCwd || scopedRoot, raw) || raw;
  return [{
    id: path.basename(resolved) || "knowledge",
    label: path.basename(resolved) || "知识库",
    kind: "local",
    type: "",
    path: resolved,
    repoPath: resolved,
    mountPath: "",
    repoUrl: "",
    branch: "",
    readonly: true,
  }];
}

function workspaceKnowledgeContextBlockFromSources(sources = []) {
  const valid = Array.isArray(sources) ? sources.filter((source) => source?.path || source?.repoPath || source?.ref) : [];
  if (!valid.length) return "";
  const lines = [
    "## 知识库上下文",
    "",
    "这些路径是只读知识库/上下文源，用于检索、阅读和分析；它们不代表当前执行 cwd。需要修改代码时，请先创建或使用可写工作区。",
    "",
  ];
  valid.forEach((source, index) => {
    const label = String(source.label || source.id || source.mountPath || `知识库 ${index + 1}`).trim();
    const sourcePath = String(source.path || source.repoPath || "").trim();
    lines.push(`${index + 1}. ${label}`);
    if (source.kind) lines.push(`   - 类型：${source.kind}${source.type ? `/${source.type}` : ""}`);
    if (sourcePath) lines.push(`   - 路径：\`${sourcePath}\``);
    if (source.ref) lines.push(`   - 绑定：\`${source.ref}\``);
    if (source.mountPath) lines.push(`   - 挂载目录：${source.mountPath}`);
    if (source.repoUrl) lines.push(`   - Git URL：${source.repoUrl}`);
    if (source.branch) lines.push(`   - 分支：${source.branch}`);
  });
  return lines.join("\n");
}

function workspaceDedupeKnowledgeSources(sources = []) {
  const seen = new Set();
  const out = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    if (!source || typeof source !== "object") continue;
    const key = [
      source.path || source.repoPath ? path.resolve(String(source.path || source.repoPath)) : "",
      String(source.mountPath || ""),
      String(source.repoUrl || ""),
      String(source.branch || ""),
      String(source.ref || ""),
    ].join("\n");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(source);
  }
  return out;
}

function workspaceGlobalKnowledgeNodeIds(graph) {
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  return Object.entries(instances)
    .filter(([id, instance]) => {
      if (String(instance?.definitionId || "") !== "control_cd_workspace") return false;
      if (String(id || "") === "background_knowledge") return true;
      if (instance?.globalContext === true || instance?.globalKnowledge === true) return true;
      const scope = String(instance?.scope || workspaceSlotValue(workspaceSlotByName(instance, "scope")) || "").trim().toLowerCase();
      return scope === "global" || scope === "workspace";
    })
    .map(([id]) => id);
}

function workspaceKnowledgeSourcesFromInstance(instance, baseCwd = "", scopedRoot = "") {
  const knowledgeText = workspaceSlotValue(workspaceSlotByName(instance, "knowledgeContext"));
  let sources = workspaceKnowledgeSourcesFromText(knowledgeText, baseCwd || scopedRoot, scopedRoot);
  if (sources.length) return sources;
  const pathText = workspaceSlotValue(workspaceSlotByName(instance, "path")) ||
    workspaceSlotValue(workspaceSlotByName(instance, "target")) ||
    workspaceInstanceText(instance);
  sources = workspaceKnowledgeSourcesFromText(pathText, baseCwd || scopedRoot, scopedRoot);
  const label = workspaceSlotValue(workspaceSlotByName(instance, "label"));
  if (!label) return sources;
  return sources.map((source) => ({ ...source, label }));
}

function workspaceGlobalKnowledgeSources(graph, scopedRoot = "", logicalCwd = "", excludeNodeId = "") {
  const root = scopedRoot ? path.resolve(scopedRoot) : "";
  const cwd = logicalCwd ? path.resolve(logicalCwd) : root;
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  return workspaceDedupeKnowledgeSources(
    workspaceGlobalKnowledgeNodeIds(graph)
      .filter((id) => String(id) !== String(excludeNodeId || ""))
      .flatMap((id) => workspaceKnowledgeSourcesFromInstance(instances[id], cwd || root, root))
  );
}

function workspaceNodeWorkspaceContextBlock(graph, nodeId, outputs, scopedRoot = "", logicalCwd = "", contextBundle = {}) {
  const root = scopedRoot ? path.resolve(scopedRoot) : "";
  const cwd = logicalCwd ? path.resolve(logicalCwd) : root;
  const knowledgeText = workspaceSemanticInputText(graph, nodeId, outputs, "knowledgeContext", scopedRoot)
    || String(contextBundle?.knowledgeContext || "");
  let knowledgeSources = workspaceKnowledgeSourcesFromText(knowledgeText, cwd || root, scopedRoot);
  knowledgeSources = workspaceDedupeKnowledgeSources([
    ...workspaceGlobalKnowledgeSources(graph, scopedRoot, logicalCwd, nodeId),
    ...knowledgeSources,
  ]);
  const workspaceText = workspaceSemanticInputText(graph, nodeId, outputs, "workspaceContext", scopedRoot)
    || String(contextBundle?.workspaceContext || "");
  let workspaceContext = workspaceContextObjectFromText(workspaceText, cwd || root, scopedRoot);
  if (!knowledgeSources.length && workspaceContext?.cwd) {
    knowledgeSources = workspaceKnowledgeSourcesFromText(JSON.stringify([workspaceContext]), cwd || root, scopedRoot);
  }
  if (!workspaceContext && cwd && root && cwd !== root) {
    workspaceContext = {
      version: 1,
      label: "workspace",
      cwd,
      workspaceRoot: cwd,
      pipelineWorkspace: root,
      previous: null,
    };
  }
  const gitContext = normalizeGitContext(workspaceSemanticInputText(graph, nodeId, outputs, "gitContext", scopedRoot));
  const knowledgeBlock = workspaceKnowledgeContextBlockFromSources(knowledgeSources);
  if (!workspaceContext && !gitContext) return knowledgeBlock;

  const contextCwd = workspaceContext?.cwd ? path.resolve(String(workspaceContext.cwd)) : "";
  const workspaceRoot = workspaceContext?.workspaceRoot ? path.resolve(String(workspaceContext.workspaceRoot)) : contextCwd;
  const pipelineWorkspace = workspaceContext?.pipelineWorkspace ? path.resolve(String(workspaceContext.pipelineWorkspace)) : root;
  const label = String(workspaceContext?.label || "").trim();
  const lines = [
    "## Workspace 上下文",
    "",
    "当前 Agent 仍在独立节点目录中运行，文件边界以“文件边界”章节为准。",
    label ? `- 名称：${label}` : "",
    contextCwd ? `- 当前工作目录上下文：\`${contextCwd}\`` : "",
    workspaceRoot && workspaceRoot !== contextCwd ? `- workspaceRoot：\`${workspaceRoot}\`` : "",
    pipelineWorkspace ? `- 流程目录：\`${pipelineWorkspace}\`` : "",
    gitContext?.repoPath ? `- Git repoPath：\`${gitContext.repoPath}\`` : "",
    gitContext?.worktreePath ? `- Git worktreePath：\`${gitContext.worktreePath}\`` : "",
    gitContext?.branch ? `- Git branch：\`${gitContext.branch}\`` : "",
    gitContext?.commit ? `- Git commit：\`${gitContext.commit}\`` : "",
    "",
    "使用要求：",
    "- 读取、搜索、分析当前项目或资料时，优先从“当前工作目录上下文”开始；不要把节点的“当前执行目录”误认为项目根目录。",
    "- 临时文件和正式产物仍必须按“文件边界”写入本节点的 `tmp/` 与 `outputs/`。",
  ].filter((line) => line !== "");
  return [knowledgeBlock, lines.join("\n")].filter(Boolean).join("\n\n");
}

function workspaceDefaultWorkspaceContextBlock(scopedRoot = "", logicalCwd = "") {
  const root = scopedRoot ? path.resolve(scopedRoot) : "";
  const cwd = logicalCwd ? path.resolve(logicalCwd) : root;
  if (!root && !cwd) return "";
  return [
    "## Workspace 上下文",
    "",
    "当前 Agent 仍在独立节点目录中运行，文件边界以“文件边界”章节为准。",
    cwd ? `- 当前工作目录上下文：\`${cwd}\`` : "",
    root ? `- 流程目录：\`${root}\`` : "",
    "",
    "使用要求：",
    "- 读取、搜索、分析当前项目或资料时，优先从“当前工作目录上下文”开始；不要把节点的“当前执行目录”误认为项目根目录。",
    "- 临时文件和正式产物仍必须按“文件边界”写入本节点的 `tmp/` 与 `outputs/`。",
  ].filter((line) => line !== "").join("\n");
}

function isWorkspaceOneClickTaskDefinitionId(definitionId) {
  const id = String(definitionId || "");
  return id === "workspace_one_click_task" || id === "workspace_context_run";
}

function workspaceContextRunDisplayKind(instance) {
  const raw = workspaceSlotValue(workspaceSlotByName(instance, "displayType")).trim().toLowerCase();
  if (["markdown", "code", "html", "react", "table", "chart", "ascii", "mermaid"].includes(raw)) return raw;
  return "markdown";
}

function mergeWorkspaceSkillBlocks(...values) {
  const blocks = values
    .map((value) => String(value || ""))
    .filter(Boolean)
    .flatMap((text) => text.split(/\n\s*---\s*\n/g))
    .map((text) => text.trim())
    .filter(Boolean);
  return Array.from(new Set(blocks)).join("\n\n---\n\n");
}

function buildWorkspaceSkillManifestBlock(skills, selectedKeys = []) {
  const normalizedKeys = Array.from(new Set((selectedKeys || []).map((x) => String(x || "").trim()).filter(Boolean)));
  const rows = (Array.isArray(skills) ? skills : []).map((skill) => {
    const id = String(skill?.id || "").trim();
    const absPath = String(skill?.absPath || "").trim();
    if (!id && !absPath) return "";
    return `- \`${id || path.basename(absPath)}\`${absPath ? `: ${absPath}` : ""}`;
  }).filter(Boolean);
  if (!rows.length && !normalizedKeys.length) return "";
  return [
    "### 已加载 Skills",
    "",
    "这些 skills 来自当前 Workspace 中已连接的 Load Skills 节点。只有节点任务需要对应能力时，才按路径 Read 对应 SKILL.md；不要展开未连接或未加载的 skills。",
    "",
    ...(
      rows.length
        ? rows
        : normalizedKeys.map((key) => `- \`${key}\``)
    ),
  ].join("\n");
}

function buildWorkspaceMcpManifestBlock(results, servers = [], selectedNames = []) {
  const serverByName = new Map((Array.isArray(servers) ? servers : []).map((server) => [String(server?.name || ""), server]));
  const normalizedNames = Array.from(new Set((selectedNames || []).map((x) => String(x || "").trim()).filter(Boolean)));
  const targets = (Array.isArray(results) ? results : []).filter((item) => !normalizedNames.length || normalizedNames.includes(String(item?.name || "")));
  const rows = [];
  for (const result of targets) {
    const name = String(result?.name || "").trim();
    if (!name) continue;
    const server = serverByName.get(name) || {};
    const description = String(server?.description || "").trim();
    if (!result?.ok) {
      rows.push(`- MCP server \`${name}\`: unavailable${result?.error ? ` (${String(result.error)})` : ""}`);
      continue;
    }
    rows.push(`- MCP server \`${name}\`${description ? `: ${description}` : ""}`);
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    if (!tools.length) {
      rows.push("  - no tools reported");
      continue;
    }
    for (const tool of tools.slice(0, 80)) {
      const toolName = String(tool?.name || "").trim();
      if (!toolName) continue;
      const toolDescription = String(tool?.description || "").trim();
      rows.push(`  - tool \`${toolName}\`${toolDescription ? `: ${toolDescription}` : ""}`);
    }
  }
  if (!rows.length && !normalizedNames.length) return "";
  return [
    "### Workspace MCP Manifest",
    "",
    "这些 MCP servers/tools 已在当前 Agent 运行器中可用。需要外部工具能力时，优先使用下列 MCP 工具；不要声称调用了工具，除非实际工具调用成功。",
    "",
    ...(rows.length ? rows : normalizedNames.map((name) => `- MCP server \`${name}\``)),
  ].join("\n");
}

export function workspaceWriteDisplayContent(instance, content) {
  const next = { ...(instance || {}) };
  const kind = workspaceDisplayKind(next.definitionId);
  const unwrapped = workspaceUnwrapOutputEnvelopeForDisplay(content);
  const text = kind === "html" ? normalizeHtmlDisplayContent(unwrapped) : String(unwrapped || "");
  const primaryName = kind === "image" ? "src" : "content";
  next.displayReloadKey = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
  next.body = text;
  next.input = (Array.isArray(next.input) ? next.input : []).map((slot) => (
    String(slot?.name || "") === primaryName
      ? { ...slot, default: text, value: text }
      : slot
  ));
  next.output = (Array.isArray(next.output) ? next.output : []).map((slot) => (
    String(slot?.name || "") === primaryName
      ? { ...slot, default: text, value: text }
      : slot
  ));
  return next;
}

export function workspaceUnwrapOutputEnvelopeForDisplay(content) {
  const raw = String(content || "").trim();
  if (!raw) return "";
  if (!/---agentflow\b|["']result["']\s*:|["']outParams["']\s*:|["']resultFile["']\s*:/i.test(raw)) return raw;
  const structured = workspaceStructuredAgentOutput(raw);
  return structured.structured ? String(structured.result || "") : raw;
}

/**
 * 把刚产出的内容顺手回填到直接下游的展示节点。
 *
 * `selfRunningIds` 里的展示节点跳过——它们自己就在执行计划里，轮到自己时会写一遍
 * （见运行循环里 `workspaceDisplayKind(defId)` 那一段），这里再写一遍是重复的，而且**会写错**：
 * 上游完成的时刻分支还没判，`control_if` 未选中的那一支上的展示节点也会被灌上新内容，
 * 然后才被标记跳过。结果是画布和 `workspace.state.json` 里，没走的那条分支显示着新鲜内容，
 * 和真跑过的分支看不出区别。
 *
 * 留着这条回填是因为还有一类展示节点**不在**计划里：只连了数据边、没有 `prev` 控制边的那些
 * 从来不会轮到自己执行，只能靠上游推过来。
 */
function workspaceUpdateDirectDisplays(graph, sourceId, content, outputs = null, scopedRoot = "", selfRunningIds = null) {
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const updated = [];
  for (const edge of edges) {
    if (String(edge?.source || "") !== String(sourceId)) continue;
    if (isWorkspaceSemanticInputSlot(workspaceTargetSlotForEdge(graph, edge))) continue;
    const targetId = String(edge?.target || "");
    const target = instances[targetId];
    if (!target || !workspaceDisplayKind(target.definitionId)) continue;
    if (selfRunningIds?.has(targetId)) continue;
    const value = outputs ? workspaceOutputSlotValueForEdge(graph, outputs, edge, scopedRoot) : String(content || "");
    instances[targetId] = workspaceWriteDisplayContent(target, value || content);
    updated.push(targetId);
  }
  return updated;
}

function workspaceNodePrompt(graph, nodeId, upstreamText, skillsBlock, mcpBlock = "", inputValues = {}, nodeTmpDir = "", implementationBlock = "", workspaceContextBlock = "") {
  const instance = graph.instances[nodeId] || {};
  const body = workspaceResolveBodyPlaceholders(instance.body || "", inputValues).trim();
  const { values: relevantInputValues, placeholders } = workspaceRelevantInputValues(instance.body || "", inputValues);
  const runPackage = typeof nodeTmpDir === "object" && nodeTmpDir ? nodeTmpDir : { nodeTmpDir: String(nodeTmpDir || "") };
  const inputBlock = workspaceAgentInputBlock(relevantInputValues, runPackage.inputMounts || {});
  const fileBoundary = workspaceNodeFileBoundaryBlock(runPackage);
  const outputProtocolRequirements = workspaceOutputProtocolRequirements(graph, nodeId);
  return [
    "你正在执行一个独立任务。只使用本提示中的任务、输入、可用能力和文件边界。",
    fileBoundary ? `\n${fileBoundary}` : "",
    workspaceContextBlock ? `\n${workspaceContextBlock}` : "",
    inputBlock ? `\n${inputBlock}` : "",
    placeholders.size ? "\n任务只显式引用了上面的输入槽；其它未被 `${...}` 引用的已连接业务输入不要作为分析依据。" : "",
    implementationBlock ? `\n${implementationBlock}` : "",
    skillsBlock ? `\n## 可用能力\n\n${skillsBlock}` : "",
    mcpBlock ? `\n## 可用 MCP\n\n${mcpBlock}` : "",
    upstreamText ? `\n## 上游正文\n\n${upstreamText}` : "",
    outputProtocolRequirements ? `\n${outputProtocolRequirements}` : "",
    `\n## 任务\n\n${body || upstreamText}`,
  ].filter(Boolean).join("\n");
}

function workspaceDefaultGitRepoRoot(scopedRoot, _userCtx = {}) {
  return path.join(path.resolve(scopedRoot), ".workspace", "agentflow", "git-repos");
}

function workspaceDefaultWorktreePath(scopedRoot, runId, nodeId, repoPath, branch = "") {
  const repoRoot = path.resolve(repoPath);
  const repoName = sanitizeWorktreeName(path.basename(repoRoot));
  const branchName = String(branch || "").trim();
  let refLabel = branchName;
  if (!refLabel) {
    const currentBranch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot);
    if (currentBranch.status === 0 && currentBranch.stdout.trim() && currentBranch.stdout.trim() !== "HEAD") {
      refLabel = currentBranch.stdout.trim();
    }
  }
  if (!refLabel) {
    const currentCommit = runGit(["rev-parse", "HEAD"], repoRoot);
    refLabel = currentCommit.status === 0 && currentCommit.stdout.trim()
      ? currentCommit.stdout.trim().slice(0, 12)
      : "HEAD";
  }
  return path.join(
    path.resolve(scopedRoot),
    ".workspace",
    "agentflow",
    "run-workspaces",
    workspaceSanitizeTmpSegment(nodeId, "node"),
    workspaceSanitizeTmpSegment(runId, "run"),
    repoName,
    sanitizeWorktreeName(refLabel),
  );
}

function workspaceShouldAutoCleanupWorktree(result, scopedRoot = "") {
  const worktreePath = String(result?.worktreePath || "").trim();
  if (!worktreePath) return false;
  if (result.created === true) return true;
  return scopedRoot ? workspacePathInside(scopedRoot, worktreePath) : false;
}

function workspaceTrackAutoCleanupWorktree(list, item) {
  const rawTarget = String(item?.worktreePath || "").trim();
  if (!rawTarget) return;
  const target = path.resolve(rawTarget);
  if (list.some((entry) => path.resolve(entry.worktreePath) === target)) return;
  list.push({ ...item, worktreePath: target });
}

function workspaceUntrackAutoCleanupWorktree(list, worktreePath) {
  const rawTarget = String(worktreePath || "").trim();
  if (!rawTarget) return;
  const target = path.resolve(rawTarget);
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (path.resolve(list[i].worktreePath) === target) list.splice(i, 1);
  }
}

function workspaceMarkAutoWorktreeCleaned(graph, entry) {
  const instance = graph?.instances?.[entry.nodeId];
  if (!instance) return false;
  let nextInstance = workspaceSetOutputSlot(instance, "worktreePath", "");
  nextInstance = workspaceSetOutputSlot(nextInstance, "gitContext", "");
  nextInstance = workspaceSetOutputSlot(nextInstance, "workspaceContext", "");
  graph.instances[entry.nodeId] = nextInstance;
  return true;
}

function workspaceCleanupAutoWorktrees(list, graph, emit, { force = false } = {}) {
  const cleaned = [];
  const preserved = [];
  for (const entry of [...list].reverse()) {
    try {
      const result = unloadGitWorktree({
        repoPath: entry.repoPath,
        worktreePath: entry.worktreePath,
        force,
        prune: true,
      });
      cleaned.push(result.worktreePath);
      emit({
        type: "natural",
        kind: "status",
        nodeId: entry.nodeId,
        text: `已清理临时 worktree：${result.worktreePath}`,
      });
      if (workspaceMarkAutoWorktreeCleaned(graph, entry)) {
        emit({ type: "graph", nodeId: entry.nodeId, graph });
      }
    } catch (e) {
      preserved.push({ ...entry, reason: e?.message || String(e) });
      emit({
        type: "natural",
        kind: "warning",
        nodeId: entry.nodeId,
        text: `运行 worktree 已保留：${entry.worktreePath}\n原因：${e?.message || String(e)}`,
      });
    }
  }
  list.splice(0, list.length);
  return { cleaned, preserved };
}

function workspaceRunManifestPath(scopedRoot, runId) {
  const id = workspaceSanitizeTmpSegment(runId, "run");
  return path.join(path.resolve(scopedRoot), ".workspace", "agentflow", "run-manifests", `${id}.json`);
}

function workspaceWriteRunManifest(scopedRoot, runId, value = {}) {
  const filePath = workspaceRunManifestPath(scopedRoot, runId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const previous = (() => {
    try {
      return fs.existsSync(filePath) ? JSON.parse(fs.readFileSync(filePath, "utf-8")) : {};
    } catch {
      return {};
    }
  })();
  const next = {
    version: 1,
    ...previous,
    ...value,
    runId: String(runId || previous.runId || ""),
    updatedAt: new Date().toISOString(),
  };
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(next, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tempPath, filePath);
  return next;
}

export function cleanupWorkspaceRunResources(scopedRoot, runId, { force = false, status = "stopped", emit = () => {} } = {}) {
  const filePath = workspaceRunManifestPath(scopedRoot, runId);
  if (!fs.existsSync(filePath)) return { cleaned: [], preserved: [], manifestPath: filePath };
  let manifest = {};
  try {
    manifest = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return { cleaned: [], preserved: [], manifestPath: filePath };
  }
  const resources = Array.isArray(manifest.worktrees) ? manifest.worktrees : [];
  const pending = resources.filter((entry) => entry?.repoPath && entry?.worktreePath && entry.removed !== true);
  const result = workspaceCleanupAutoWorktrees(pending.map((entry) => ({ ...entry })), null, emit, { force });
  const cleanedSet = new Set(result.cleaned.map((item) => path.resolve(item)));
  const preservedByPath = new Map(result.preserved.map((item) => [path.resolve(item.worktreePath), item]));
  const worktrees = resources.map((entry) => {
    const target = entry?.worktreePath ? path.resolve(entry.worktreePath) : "";
    if (target && cleanedSet.has(target)) return { ...entry, removed: true, removedAt: new Date().toISOString(), reason: "" };
    if (target && preservedByPath.has(target)) return { ...entry, removed: false, reason: preservedByPath.get(target).reason };
    return entry;
  });
  workspaceWriteRunManifest(scopedRoot, runId, {
    ...manifest,
    status: result.preserved.length ? `${status}:resources-preserved` : status,
    worktrees,
    finishedAt: new Date().toISOString(),
  });
  return { ...result, manifestPath: filePath };
}

function workspaceSanitizeTmpSegment(value, fallback = "node") {
  return String(value || fallback)
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || fallback;
}

function workspaceCreateRunTmpRoot(scopedRoot, runNodeId) {
  const runPart = workspaceSanitizeTmpSegment(runNodeId || "run", "run");
  const id = typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const dir = path.join(path.resolve(scopedRoot), ".workspace", "agentflow", "tmp", `workspace-run-${Date.now()}-${runPart}-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function workspaceCreateNodeTmpDir(runTmpRoot, nodeId) {
  const dir = path.join(path.resolve(runTmpRoot), workspaceSanitizeTmpSegment(nodeId, "node"));
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function workspaceCreateNodeRunPackage(runTmpRoot, nodeId, { scopedRoot, sourceRoot = "", cwd = "", task = "", inputValues = {}, skillsBlock = "", mcpBlock = "", resultFile = "", outParamFiles = {}, durableOutputs = false } = {}) {
  const nodeRunDir = workspaceCreateNodeTmpDir(runTmpRoot, nodeId);
  const nodeTmpDir = path.join(nodeRunDir, "tmp");
  const legacyOutputsDir = path.join(nodeRunDir, "outputs");
  const workspaceRoot = path.resolve(sourceRoot || scopedRoot);
  const outputWorkspaceRoot = path.resolve(scopedRoot);
  const workspaceOutputsDir = path.join(outputWorkspaceRoot, "outputs");
  const nodePart = workspaceSanitizeTmpSegment(nodeId || "node", "node");
  const outputsRel = durableOutputs ? path.posix.join("outputs", nodePart) : "outputs";
  const outputsDir = durableOutputs ? path.join(workspaceOutputsDir, nodePart) : legacyOutputsDir;
  const resultFileRel = workspaceSafeNodeOutputRelPath(resultFile) || "";
  const resultFileSuffix = workspaceNodeOutputSuffix(resultFileRel);
  const resultFileAbs = resultFileRel
    ? workspaceResolveOutputChild(outputsDir, resultFileSuffix)
    : "";
  const safeOutParamFiles = {};
  for (const [name, rel] of Object.entries(outParamFiles || {})) {
    const cleanName = String(name || "").trim();
    const cleanRel = workspaceSafeNodeOutputRelPath(rel);
    if (cleanName && cleanRel) safeOutParamFiles[cleanName] = cleanRel;
  }
  fs.mkdirSync(nodeTmpDir, { recursive: true });
  fs.mkdirSync(legacyOutputsDir, { recursive: true });
  if (durableOutputs) fs.rmSync(outputsDir, { recursive: true, force: true });
  fs.mkdirSync(outputsDir, { recursive: true });
  fs.mkdirSync(workspaceOutputsDir, { recursive: true });
  const manifest = {
    version: 1,
    nodeId: String(nodeId || ""),
    nodeRunDir,
    nodeTmpDir,
    outputsDir,
    legacyOutputsDir,
    outputsRel,
    directWorkspaceOutputs: durableOutputs,
    workspaceRoot,
    outputWorkspaceRoot,
    workspaceOutputsDir,
    executionCwd: cwd ? path.resolve(cwd) : workspaceRoot,
    resultFileRel,
    resultFileAbs,
    outParamFiles: safeOutParamFiles,
    createdAt: new Date().toISOString(),
  };
  const materializedInputs = workspaceMaterializeNodeInputFiles(nodeRunDir, workspaceRoot, inputValues);
  const runtimeInputValues = { ...(inputValues || {}), ...(materializedInputs.values || {}) };
  try {
    fs.writeFileSync(path.join(nodeRunDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf-8");
    fs.writeFileSync(path.join(nodeRunDir, "task.md"), String(task || "").trimEnd() + "\n", "utf-8");
    if (Object.keys(runtimeInputValues || {}).length) {
      fs.writeFileSync(path.join(nodeRunDir, "inputs.json"), JSON.stringify(runtimeInputValues, null, 2) + "\n", "utf-8");
    }
    if (Object.keys(materializedInputs.mounts || {}).length) {
      fs.writeFileSync(path.join(nodeRunDir, "inputs.manifest.json"), JSON.stringify(materializedInputs.mounts, null, 2) + "\n", "utf-8");
    }
    if (skillsBlock) fs.writeFileSync(path.join(nodeRunDir, "skills.md"), String(skillsBlock).trimEnd() + "\n", "utf-8");
    if (mcpBlock) fs.writeFileSync(path.join(nodeRunDir, "mcp.md"), String(mcpBlock).trimEnd() + "\n", "utf-8");
  } catch {
    // Runtime metadata is best-effort and should not block node execution.
  }
  return {
    ...manifest,
    inputValues: runtimeInputValues,
    inputMounts: materializedInputs.mounts,
  };
}

const WORKSPACE_INLINE_INPUT_FILE_THRESHOLD = 4096;

function workspaceInlineInputExtension(value) {
  const text = String(value || "").trim();
  if (/^(?:<!doctype\s+html|<html\b)/i.test(text)) return ".html";
  if (/^[\[{]/.test(text)) {
    try {
      JSON.parse(text);
      return ".json";
    } catch {}
  }
  if (/^(?:#{1,6}\s|---\s*$)/m.test(text)) return ".md";
  return ".txt";
}

export function workspaceMaterializeNodeInputFiles(nodeRunDir, workspaceRoot, inputValues = {}) {
  const values = {};
  const mounts = {};
  for (const [name, value] of Object.entries(inputValues || {})) {
    const slotName = String(name || "").trim();
    if (!slotName) continue;
    const rel = workspaceInputFileRelPath(value);
    const inlineText = String(value ?? "");
    if (!rel && inlineText.length >= WORKSPACE_INLINE_INPUT_FILE_THRESHOLD) {
      const extension = workspaceInlineInputExtension(inlineText);
      const fileName = `${workspaceSanitizeTmpSegment(slotName, "input")}${extension}`;
      const mountedRel = path.join("inputs", workspaceSanitizeTmpSegment(slotName, "input"), fileName);
      const dest = path.resolve(nodeRunDir, mountedRel);
      const nodeRunWithSep = nodeRunDir.endsWith(path.sep) ? nodeRunDir : `${nodeRunDir}${path.sep}`;
      if (dest !== nodeRunDir && !dest.startsWith(nodeRunWithSep)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, inlineText, "utf-8");
      const mounted = mountedRel.split(path.sep).join(path.posix.sep);
      values[slotName] = mounted;
      mounts[slotName] = {
        source: `inline:${slotName}`,
        mounted,
        bytes: Buffer.byteLength(inlineText, "utf-8"),
        sha256: crypto.createHash("sha256").update(inlineText, "utf-8").digest("hex"),
        inline: true,
      };
      continue;
    }
    if (!rel) continue;
    const src = path.resolve(workspaceRoot, rel);
    const rootWithSep = workspaceRoot.endsWith(path.sep) ? workspaceRoot : `${workspaceRoot}${path.sep}`;
    if (src !== workspaceRoot && !src.startsWith(rootWithSep)) continue;
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) continue;
    const stat = fs.statSync(src);
    const mountedRel = path.join("inputs", workspaceSanitizeTmpSegment(slotName, "input"), path.basename(rel));
    const dest = path.resolve(nodeRunDir, mountedRel);
    const nodeRunWithSep = nodeRunDir.endsWith(path.sep) ? nodeRunDir : `${nodeRunDir}${path.sep}`;
    if (dest !== nodeRunDir && !dest.startsWith(nodeRunWithSep)) continue;
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    workspaceCopyInputFile(src, dest);
    const mounted = mountedRel.split(path.sep).join(path.posix.sep);
    values[slotName] = mounted;
    mounts[slotName] = {
      source: rel,
      mounted,
      bytes: stat.size,
    };
  }
  return { values, mounts };
}

function workspaceCopyInputFile(src, dest) {
  try {
    fs.copyFileSync(src, dest, fs.constants.COPYFILE_FICLONE);
  } catch {
    fs.copyFileSync(src, dest);
  }
}

function workspaceInputFileRelPath(value) {
  const text = String(value || "").trim().replace(/^["']|["']$/g, "");
  if (!text || text.length > 260) return "";
  if (/[\r\n<>]/.test(text)) return "";
  if (/^(?:https?:|data:|blob:|file:|javascript:|mailto:|tel:)/i.test(text)) return "";
  const clean = text.replace(/^\/+/, "");
  if (clean.includes("..") || clean.startsWith(".") || path.isAbsolute(clean)) return "";
  return clean;
}

function workspaceShouldKeepTmp(userCtx = {}) {
  const env = { ...process.env, ...readMergedEnvObject(userCtx.userId) };
  const value = String(env.AGENTFLOW_KEEP_TMP || env.AGENTFLOW_KEEP_WORKSPACE_TMP || "").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(value);
}

function workspaceCleanupTmpRoot(runTmpRoot, userCtx = {}, emit = () => {}) {
  const dir = String(runTmpRoot || "").trim();
  if (!dir) return;
  if (workspaceShouldKeepTmp(userCtx)) {
    emit({ type: "status", line: `Workspace tmp kept: ${dir}` });
    return;
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    emit({ type: "natural", kind: "warning", text: `Workspace tmp cleanup failed: ${dir}\n原因：${e?.message || String(e)}` });
  }
}

function workspaceOutputFileRefsForNode(instance) {
  const refs = {};
  const slots = Array.isArray(instance?.output) ? instance.output : [];
  for (let index = 0; index < slots.length; index += 1) {
    const slot = slots[index];
    const name = String(slot?.name || "").trim();
    if (!name || isWorkspaceSemanticOutputSlot(slot)) continue;
    // 键必须是**声明的槽名**：代码节点包的 run(inputs, outputs) 和脚本里的 ${slotName}
    // 占位符都按槽名取。谁是主输出留给信封那一层判断，这里别改名。
    refs[name] = `outputs/${workspaceSanitizeTmpSegment(name, "result")}.txt`;
  }
  if (!refs.result) refs.result = "outputs/result.txt";
  return refs;
}

function workspaceResolveScriptCommandText(script, values = {}) {
  return String(script || "").replace(/\$\{([^}]+)\}/g, (_, key) => {
    const name = String(key || "").trim();
    return workspaceShellQuote(Object.prototype.hasOwnProperty.call(values, name) ? values[name] : "");
  });
}

function workspaceDefaultScriptCommand(scriptAbs) {
  const ext = path.extname(scriptAbs).toLowerCase();
  if (ext === ".js" || ext === ".mjs" || ext === ".cjs") return `node ${workspaceShellQuote(scriptAbs)}`;
  if (ext === ".sh" || ext === ".bash") return `bash ${workspaceShellQuote(scriptAbs)}`;
  if (ext === ".py") return `python3 ${workspaceShellQuote(scriptAbs)}`;
  return workspaceShellQuote(scriptAbs);
}

/**
 * 把节点写出来的输出文件转成输出信封。
 *
 * `outputRefs` 的键是声明的槽名。哪个槽是「结果正文」由 `primaryName` 指定——不能像
 * 以前那样「找不到叫 result 的就拿第一个顶上」，那个兜底会把 `total` 之类的自定义槽
 * 当成 result，于是它自己那个槽反而永远收不到值。
 *
 * `result` 是 stdout，只在主输出槽**没有**写出文件时才当结果正文。写文件是作者的明确
 * 动作，`console.log` 常常只是进度——文档里的范例就是「写 outputs.total + 打印一行」，
 * 让打印盖掉写入是反直觉的。
 *
 * @param {{ primaryName?: string, result?: string }} [opts]
 */
function workspaceEnvelopeFromOutputFiles(outputRefs, nodeRunDir, opts = {}) {
  const entries = Object.entries(outputRefs || {})
    .map(([name, rel]) => {
      const abs = path.resolve(nodeRunDir, rel);
      const nodeRootWithSep = nodeRunDir.endsWith(path.sep) ? nodeRunDir : `${nodeRunDir}${path.sep}`;
      if (abs !== nodeRunDir && !abs.startsWith(nodeRootWithSep)) return null;
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
      return { name, rel };
    })
    .filter(Boolean);
  const resultText = String(opts.result || "");
  const primaryName = String(opts.primaryName || "").trim() || "result";
  const resultEntry = entries.find((entry) => entry.name === primaryName)
    || entries.find((entry) => entry.name === "result")
    || null;
  const outParams = entries.filter((entry) => entry !== resultEntry);
  if (!resultText && !resultEntry && !outParams.length) return "";
  return [
    "---agentflow",
    resultEntry
      ? `resultFile: ${resultEntry.rel}`
      : `result: |\n${resultText.split("\n").map((line) => `  ${line}`).join("\n")}`,
    outParams.length ? "outParams:" : "",
    ...outParams.map((entry) => `  ${entry.name}File: ${entry.rel}`),
    "---end",
  ].filter(Boolean).join("\n");
}

async function workspaceRunToolNodejsScript({
  scopedRoot,
  cwd,
  instance,
  inputValues,
  runPackage,
  userCtx,
  envOverlay = {},
  emit,
  signal,
  onActiveChild,
  stderrAsStatus = false,
  maxStdoutBytes = Infinity,
  maxStderrBytes = Infinity,
}) {
  const scriptRef = String(instance?.scriptRef || "").trim();
  const scriptAbs = scriptRef ? workspaceResolveFlowFile(scopedRoot, scriptRef, "scriptRef") : "";
  if (scriptAbs && (!fs.existsSync(scriptAbs) || !fs.statSync(scriptAbs).isFile())) {
    throw new Error(`scriptRef not found: ${scriptRef}`);
  }
  const outputRefs = workspaceOutputFileRefsForNode(instance);
  const outputAbs = Object.fromEntries(
    Object.entries(outputRefs).map(([key, rel]) => [key, path.resolve(runPackage.nodeRunDir, rel)]),
  );
  for (const abs of Object.values(outputAbs)) fs.mkdirSync(path.dirname(abs), { recursive: true });
  const constants = {
    workspaceRoot: path.resolve(scopedRoot),
    pipelineWorkspace: path.resolve(scopedRoot),
    flowDir: path.resolve(scopedRoot),
    cwd: path.resolve(cwd || scopedRoot),
    nodeRunDir: runPackage.nodeRunDir,
    nodeTmpDir: runPackage.nodeTmpDir,
    outputsDir: runPackage.outputsDir,
    scriptRef: scriptAbs,
    ...inputValues,
    ...outputRefs,
  };
  const inlineScript = String(instance?.script || "").trim();
  const command = inlineScript
    ? workspaceResolveScriptCommandText(inlineScript, constants)
    : scriptAbs
      ? workspaceDefaultScriptCommand(scriptAbs)
      : "";
  if (!command) throw new Error("tool_nodejs requires script or scriptRef");

  emit?.({ type: "status", line: `Run script: ${scriptRef || command.slice(0, 120)}` });

  const env = runtimeEnvForUser(userCtx, {
    ...envOverlay,
    AGENTFLOW_WORKSPACE_ROOT: path.resolve(scopedRoot),
    AGENTFLOW_NODE_RUN_DIR: runPackage.nodeRunDir,
    AGENTFLOW_NODE_TMP_DIR: runPackage.nodeTmpDir,
    AGENTFLOW_OUTPUTS_DIR: runPackage.outputsDir,
    AGENTFLOW_SCRIPT_REF: scriptAbs,
    AGENTFLOW_INPUTS_JSON: JSON.stringify(inputValues || {}),
    AGENTFLOW_OUTPUTS_JSON: JSON.stringify(outputRefs),
    AGENTFLOW_OUTPUTS_ABS_JSON: JSON.stringify(outputAbs),
  });

  const started = Date.now();
  return await new Promise((resolve, reject) => {
    const processGroup = process.platform !== "win32";
    const child = spawn(command, [], {
      cwd: runPackage.nodeRunDir,
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env,
      detached: processGroup,
    });
    if (typeof onActiveChild === "function") onActiveChild(child, { processGroup });
    let stdout = "";
    let stderr = "";
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputLimitError = null;
    let settled = false;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      if (typeof onActiveChild === "function") onActiveChild(null);
      callback();
    };
    child.stdout.setEncoding("utf-8");
    child.stderr.setEncoding("utf-8");
    child.stdout.on("data", (chunk) => {
      if (outputLimitError) return;
      const text = String(chunk);
      stdoutBytes += Buffer.byteLength(text, "utf-8");
      if (stdoutBytes > maxStdoutBytes) {
        outputLimitError = new Error(`script stdout exceeded ${maxStdoutBytes} bytes`);
        terminateWorkspaceChild(child, { processGroup });
        return;
      }
      stdout += text;
    });
    child.stderr.on("data", (chunk) => {
      if (outputLimitError) return;
      const text = String(chunk);
      stderrBytes += Buffer.byteLength(text, "utf-8");
      if (stderrBytes > maxStderrBytes) {
        outputLimitError = new Error(`script stderr exceeded ${maxStderrBytes} bytes`);
        terminateWorkspaceChild(child, { processGroup });
        return;
      }
      stderr += text;
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => {
      if (outputLimitError) {
        finish(() => reject(outputLimitError));
        return;
      }
      if (signal?.aborted) {
        finish(() => {
          const error = new Error("Workspace run stopped");
          error.code = "WORKSPACE_RUN_ABORTED";
          reject(error);
        });
        return;
      }
      if (stderr.trim()) {
        if (stderrAsStatus) emit?.({ type: "status", line: `[step stderr] ${stderr.trim().slice(-4000)}` });
        else emit?.({ type: "natural", kind: "warning", text: `[script stderr]\n${stderr.trim().slice(-4000)}` });
      }
      if (code !== 0) {
        finish(() => reject(new Error(`tool_nodejs script exited ${code}${stderr.trim() ? `: ${stderr.trim().slice(-800)}` : ""}`)));
        return;
      }
      const elapsedMs = Math.max(0, Date.now() - started);
      emit?.({ type: "status", line: `Timing script: ${elapsedMs}ms`, timing: { label: "script", elapsedMs } });
      // stdout 和输出文件不是二选一：文档里的代码节点范例就是「写 outputs.total + 打印
      // 一行进度」，旧写法 `stdout || 信封` 会让那一行 console.log 把所有输出文件全吃掉。
      // 规则改成：信封照给，stdout 非空时它就是 result（覆盖 result 文件，不动其它槽）。
      const envelope = workspaceEnvelopeFromOutputFiles(outputRefs, runPackage.nodeRunDir, {
        primaryName: workspacePrimaryOutputSlotName(instance),
        result: stdout.trim(),
      });
      finish(() => resolve(envelope || stdout.trim()));
    });
  });
}

function workspaceNodeModelKey(instance, fallback = "") {
  const own = String(instance?.model || "").trim();
  if (own && own !== "default") return own;
  return String(fallback || "").trim();
}

function workspaceAssertWhileSubflowContract(graph, nodeId, conditionSubflowId, bodySubflowId) {
  const conditionId = String(conditionSubflowId || "").trim();
  const bodyId = String(bodySubflowId || "").trim();
  if (!conditionId || !bodyId) {
    throw new Error(`control.while ${nodeId} requires both conditionSubflowId and bodySubflowId`);
  }
  if (conditionId === bodyId) {
    throw new Error(`control.while ${nodeId} condition and body must be different subflows`);
  }
  const condition = graph?.subflows?.[conditionId];
  const body = graph?.subflows?.[bodyId];
  if (!condition) throw new Error(`control.while ${nodeId} references missing condition subflow ${conditionId}`);
  if (!body) throw new Error(`control.while ${nodeId} references missing body subflow ${bodyId}`);
  for (const name of ["state", "iteration"]) {
    if (!condition.inputs?.[name]) throw new Error(`control.while ${nodeId} condition subflow ${conditionId} requires input ${name}`);
  }
  if (!condition.outputs?.decision) {
    throw new Error(`control.while ${nodeId} condition subflow ${conditionId} requires output decision`);
  }
  for (const name of ["state", "iteration", "idempotencyKey"]) {
    if (!body.inputs?.[name]) throw new Error(`control.while ${nodeId} body subflow ${bodyId} requires input ${name}`);
  }
  if (!body.outputs?.state) {
    throw new Error(`control.while ${nodeId} body subflow ${bodyId} requires output state`);
  }
  return { conditionId, bodyId, condition, body };
}

async function workspaceRunSubflowFrame({
  root,
  scopedRoot,
  payload,
  userCtx,
  opts,
  graph,
  parentNodeId,
  parentDefinitionId,
  subflowId,
  inputValues = {},
  signal = null,
  emit,
  eventContext = {},
}) {
  const id = String(subflowId || "").trim();
  const subflow = graph?.subflows?.[id];
  if (!subflow) throw new Error(`Subflow ${id || "(empty)"} does not exist`);
  const callStack = Array.isArray(opts?.subflowCallStack) ? opts.subflowCallStack : [];
  if (callStack.includes(id)) {
    throw new Error(`Recursive subflow call is not allowed: ${[...callStack, id].join(" -> ")}`);
  }

  const memberSet = new Set((subflow.nodeIds || []).map(String));
  if (!memberSet.size) throw new Error(`Subflow ${id} has no member nodes`);
  const callFrameId = `${parentNodeId}:${String(eventContext?.whileRole || "call")}:${String(eventContext?.iteration || "0")}:${crypto.randomBytes(6).toString("hex")}`;
  const childGraph = typeof structuredClone === "function"
    ? structuredClone(graph)
    : JSON.parse(JSON.stringify(graph));
  const syntheticRunId = `__subflow_run_${crypto.randomBytes(6).toString("hex")}`;
  childGraph.instances[syntheticRunId] = {
    definitionId: "workspace_run",
    label: `${subflow.label || id} · call frame`,
    input: [{ type: "node", name: "prev", value: "" }],
    output: [{ type: "node", name: "next", value: "" }],
  };
  childGraph.edges = (childGraph.edges || []).filter((edge) => (
    memberSet.has(String(edge?.source || "")) && memberSet.has(String(edge?.target || ""))
  ));
  for (const rootId of subflow.roots || []) {
    const rootInstance = childGraph.instances?.[rootId];
    const prevIndex = (rootInstance?.input || []).findIndex((slot) => String(slot?.name || "") === "prev");
    if (prevIndex < 0) throw new Error(`Subflow ${id} root ${rootId} has no prev input`);
    childGraph.edges.push({
      source: syntheticRunId,
      target: rootId,
      sourceHandle: "output-0",
      targetHandle: `input-${prevIndex}`,
    });
  }
  for (const [name, binding] of Object.entries(subflow.inputs || {})) {
    const proxy = childGraph.instances?.[binding.nodeId];
    if (!proxy) throw new Error(`Subflow ${id} input ${name} references missing proxy ${binding.nodeId}`);
    childGraph.instances[binding.nodeId] = workspaceSetOutputSlot(proxy, binding.slot || "value", inputValues[name] ?? "");
  }

  const frameContext = {
    ...eventContext,
    parentNodeId,
    subflowId: id,
    callFrameId,
  };
  emit({
    type: "subflow-start",
    nodeId: parentNodeId,
    definitionId: parentDefinitionId,
    inputs: Object.keys(subflow.inputs || {}),
    ...frameContext,
  });
  const childResult = await runWorkspaceGraph(root, scopedRoot, {
    ...payload,
    graph: childGraph,
    runNodeId: syntheticRunId,
    ignoreCache: true,
    forceNodeIds: [],
  }, userCtx, {
    ...opts,
    signal: signal || opts?.signal || null,
    subflowCallStack: [...callStack, id],
    onEvent: (event) => {
      if (event?.type === "graph") return;
      emit({ ...event, ...frameContext });
    },
  });
  if (childResult.deferred || childResult.pauseNodeIds?.length) {
    throw new Error(`Subflow ${id} paused or deferred; resumable subflow call frames are not supported yet`);
  }
  for (const memberId of memberSet) {
    if (childResult.graph.instances?.[memberId]) graph.instances[memberId] = childResult.graph.instances[memberId];
  }
  const resultValues = {};
  for (const [name, binding] of Object.entries(subflow.outputs || {})) {
    const source = childResult.graph.instances?.[binding.nodeId];
    const slot = (source?.output || []).find((item) => String(item?.name || "") === String(binding.slot || ""));
    resultValues[name] = workspaceSlotValue(slot);
  }
  emit({
    type: "subflow-done",
    nodeId: parentNodeId,
    definitionId: parentDefinitionId,
    outputs: Object.keys(resultValues),
    ...frameContext,
  });
  return { resultValues, callFrameId };
}

export async function runWorkspaceGraph(root, scopedRoot, payload, userCtx = {}, opts = {}) {
  const graph = hydrateWorkspaceGraphForRuntime(root, {
    root: scopedRoot,
    flowId: payload.flowId || "",
    flowSource: payload.flowSource || "user",
    archived: payload.archived === true || payload.flowArchived === true,
  }, payload.graph || {}, userCtx);
  const runNodeId = String(payload?.runNodeId || "").trim();
  const forceNodeIds = new Set((Array.isArray(payload?.forceNodeIds) ? payload.forceNodeIds : [])
    .map((nodeId) => String(nodeId || "").trim())
    .filter(Boolean));
  const { order, pauseNodeIds } = workspaceRunPlan(graph, runNodeId, scopedRoot, {
    forceNodeIds,
    ignoreCache: payload?.ignoreCache === true,
  });
  // 指纹只由「节点定义 + 上游指纹 + 没接线的槽位值」决定，运行过程中这些都不变，所以
  // 开跑前算一次就够。跑完盖回去的是这一份，不是执行后重算的——执行会改输出值，重算等于
  // 把产出算进了输入指纹。
  const plannedFingerprints = new Map();
  {
    const memo = new Map();
    for (const nodeId of order) plannedFingerprints.set(nodeId, workspaceNodeInputFingerprint(graph, nodeId, memo));
  }
  const signal = opts.signal || null;
  const throwIfAborted = () => {
    if (signal?.aborted) {
      const err = new Error("Workspace run stopped");
      err.code = "WORKSPACE_RUN_ABORTED";
      throw err;
    }
  };
  const skillsBlockCache = new Map();
  const loadSkillsBlockForKeys = (keys) => {
    const normalized = Array.from(new Set((keys || []).map((x) => String(x || "").trim()).filter(Boolean)));
    const cacheKey = normalized.join("\n");
    if (skillsBlockCache.has(cacheKey)) return skillsBlockCache.get(cacheKey);
    const selectedSkillResources = normalized.length > 0
      ? loadResourcesForSkillKeys(normalized, PACKAGE_ROOT, scopedRoot)
      : { skills: [], references: [] };
    const block = normalized.length > 0
      ? buildWorkspaceSkillManifestBlock(selectedSkillResources.skills, normalized)
      : "";
    skillsBlockCache.set(cacheKey, block);
    return block;
  };
  const mcpBlockCache = new Map();
  const loadMcpBlockForNames = async (names) => {
    const normalized = Array.from(new Set((names || []).map((x) => String(x || "").trim()).filter(Boolean)));
    if (!normalized.length) return "";
    const cacheKey = normalized.join("\n");
    if (mcpBlockCache.has(cacheKey)) return mcpBlockCache.get(cacheKey);
    const { servers } = readCursorMcpServers(userCtx);
    const results = [];
    for (const name of normalized) {
      const checked = await checkCursorMcpServers(name, userCtx);
      results.push(...(Array.isArray(checked.results) ? checked.results : []));
    }
    const block = buildWorkspaceMcpManifestBlock(results, servers, normalized);
    mcpBlockCache.set(cacheKey, block);
    return block;
  };
  const outputs = new Map();
  const events = [];
  const runStartedAt = Date.now();
  const emit = (event) => {
    // 一个节点成功跑完，就把它这次的输入指纹盖到实例上——下一次运行靠它判断缓存还算不算数。
    // 挂在 node-done 上是因为执行路径有 21 个出口，每个都盖一遍迟早会漏掉一个；跳过的节点
    // 不盖，它压根没产出。
    if (event?.type === "node-done" && !event.skipped) {
      const nodeId = String(event.nodeId || "");
      const instance = graph.instances?.[nodeId];
      if (instance && plannedFingerprints.has(nodeId)) instance.runFingerprint = plannedFingerprints.get(nodeId);
    }
    const now = Date.now();
    const enriched = {
      ...event,
      ts: Number(event?.ts) || now,
      runElapsedMs: Number.isFinite(event?.runElapsedMs) ? event.runElapsedMs : Math.max(0, now - runStartedAt),
    };
    events.push(enriched);
    if (typeof opts.onEvent === "function") opts.onEvent(enriched);
  };
  const emitTiming = (nodeId, label, startedAt, extra = {}) => {
    const elapsedMs = Math.max(0, Date.now() - startedAt);
    emit({ type: "status", nodeId, line: `Timing ${label}: ${elapsedMs}ms`, timing: { label, elapsedMs, ...extra } });
  };
  let cwd = scopedRoot;
  const runtimeStorageRoot = path.resolve(opts.runtimeRoot || scopedRoot);
  const modelKey = typeof payload?.model === "string" ? payload.model.trim() : "";
  const runEnv = {};
  const runtimeEnv = (extra = {}) => runtimeEnvForUser(userCtx, { ...runEnv, ...(extra || {}) });
  const autoCleanupWorktrees = [];
  const runTmpRoot = workspaceCreateRunTmpRoot(runtimeStorageRoot, runNodeId);
  const runtimeRunId = String(opts.runId || payload?.runId || "").trim() || runLedgerId("workspace-execution");
  const ownsRunManifest = !(Array.isArray(opts?.subflowCallStack) && opts.subflowCallStack.length);
  const persistRunManifest = (status, extra = {}) => {
    if (!ownsRunManifest) return null;
    return workspaceWriteRunManifest(runtimeStorageRoot, runtimeRunId, {
      flowId: String(payload?.flowId || ""),
      flowSource: String(payload?.flowSource || "user"),
      runNodeId,
      status,
      runtimeRoot: runTmpRoot,
      artifactRoot: path.join(runtimeStorageRoot, "outputs"),
      worktrees: autoCleanupWorktrees.map((entry) => ({ ...entry, removed: false })),
      ...extra,
    });
  };
  persistRunManifest("running", { startedAt: new Date().toISOString() });
  const controlBranches = new Map();
  const skippedNodes = new Set();
  const runtimePauseNodeIds = [];
  let deferred = null;
  let runFailure = null;
  const incomingControlEdgesByTarget = new Map();
  for (const edge of Array.isArray(graph?.edges) ? graph.edges : []) {
    const target = String(edge?.target || "");
    if (!target || !workspaceIsControlEdge(graph, edge)) continue;
    if (!incomingControlEdgesByTarget.has(target)) incomingControlEdgesByTarget.set(target, []);
    incomingControlEdgesByTarget.get(target).push(edge);
  }
  const skipReasonForNode = (nodeId) => {
    for (const edge of incomingControlEdgesByTarget.get(nodeId) || []) {
      const sourceId = String(edge?.source || "");
      if (!sourceId) continue;
      if (skippedNodes.has(sourceId)) return `上游 ${sourceId} 已被分支跳过`;
      const sourceDefId = String(graph.instances?.[sourceId]?.definitionId || "");
      if (sourceDefId !== "control_if" || !controlBranches.has(sourceId)) continue;
      const expectedHandle = workspaceControlIfBranchToSourceHandle(controlBranches.get(sourceId));
      const actualHandle = String(edge?.sourceHandle || "output-0");
      if (expectedHandle && actualHandle !== expectedHandle) {
        return `control_if ${sourceId} 分支为 ${controlBranches.get(sourceId)}，跳过 ${actualHandle}`;
      }
    }
    return "";
  };
  const recordNodeOutput = (nodeId, content) => {
    outputs.set(nodeId, content);
  };
  // 计划里的展示节点由它们自己那一轮负责写内容；被 control_if 跳过的那一支因此什么都不写
  const plannedDisplayIds = new Set(order.filter((id) => workspaceDisplayKind(graph.instances?.[id]?.definitionId)));
  const propagateNodeOutputDisplays = (nodeId, content, { emitGraph = false } = {}) => {
    const updatedDisplays = workspaceUpdateDirectDisplays(graph, nodeId, content, outputs, scopedRoot, plannedDisplayIds);
    if (emitGraph && updatedDisplays.length) emit({ type: "graph", nodeId, displayNodeIds: updatedDisplays, graph });
    return updatedDisplays;
  };
  const publishNodeOutput = (nodeId, content, options = {}) => {
    recordNodeOutput(nodeId, content);
    return propagateNodeOutputDisplays(nodeId, content, options);
  };

  try {
  for (const nodeId of order) {
    throwIfAborted();
    const instance = graph.instances[nodeId];
    if (!instance) continue;
    const defId = String(instance.definitionId || "");
    const skipReason = skipReasonForNode(nodeId);
    if (skipReason) {
      skippedNodes.add(nodeId);
      emit({ type: "status", nodeId, line: `Skipped: ${skipReason}` });
      emit({ type: "node-done", nodeId, definitionId: defId, skipped: true });
      continue;
    }
    emit({ type: "node-start", nodeId, definitionId: defId });

    if (defId === "workspace_run" || defId === "workspace_scheduled_run") {
      continue;
    }

    if (defId === "workspace_subflow_input") {
      const value = workspaceSlotValue((instance.output || []).find((slot) => String(slot?.name || "") === "value"));
      publishNodeOutput(nodeId, value, { emitGraph: true });
      emit({ type: "node-done", nodeId, definitionId: defId });
      continue;
    }

    if (defId === "context_knowledge") {
      const inputValues = workspaceInputValues(graph, nodeId, outputs, scopedRoot);
      const workspaceIds = parseWorkspaceSkillKeys(inputValues.workspaceIds || "[]");
      if (!workspaceIds.length) throw new Error(`context.knowledge ${nodeId} requires at least one Workspace ID`);
      const catalog = new Map(listConfiguredWorkspaces(root, scopedRoot, userCtx).map((entry) => [String(entry.id || ""), entry]));
      const missing = workspaceIds.filter((id) => !catalog.has(id));
      if (missing.length) throw new Error(`context.knowledge ${nodeId} cannot resolve Workspace IDs: ${missing.join(", ")}`);
      const unavailable = workspaceIds.filter((id) => catalog.get(id)?.exists === false);
      if (unavailable.length) throw new Error(`context.knowledge ${nodeId} Workspace paths are not ready: ${unavailable.join(", ")}`);
      const sources = workspaceIds
        .map((id, index) => workspaceKnowledgeSourceFromObject({ ...catalog.get(id), role: index === 0 ? "primary" : "context" }, cwd || scopedRoot, scopedRoot))
        .filter(Boolean);
      const value = JSON.stringify({ version: 1, sources });
      graph.instances[nodeId] = workspaceSetOutputSlot(instance, "knowledgeContext", value);
      publishNodeOutput(nodeId, value, { emitGraph: true });
      emit({ type: "node-done", nodeId, definitionId: defId, sourceCount: sources.length, workspaceIds });
      continue;
    }

    if (defId === "context_skills") {
      const keys = selectedSkillKeysFromConfigSlots(instance);
      if (!keys.length) throw new Error(`context.skills ${nodeId} requires at least one skill`);
      const value = loadSkillsBlockForKeys(keys);
      graph.instances[nodeId] = workspaceSetOutputSlot(instance, "skillsContext", value);
      publishNodeOutput(nodeId, value, { emitGraph: true });
      emit({ type: "node-done", nodeId, definitionId: defId, skillCount: keys.length });
      continue;
    }

    if (defId === "context_workspace") {
      const inputValues = workspaceInputValues(graph, nodeId, outputs, scopedRoot);
      const workspaceId = String(inputValues.workspaceId || "current").trim();
      const access = String(inputValues.access || "read-write").trim().toLowerCase();
      if (!["read-only", "read-write"].includes(access)) {
        throw new Error(`context.workspace ${nodeId} access must be read-only or read-write`);
      }
      const catalog = new Map(listConfiguredWorkspaces(root, scopedRoot, userCtx).map((entry) => [String(entry.id || ""), entry]));
      const selected = catalog.get(workspaceId);
      if (!selected) throw new Error(`context.workspace ${nodeId} cannot resolve Workspace ID ${workspaceId || "(empty)"}`);
      if (selected.exists === false) throw new Error(`context.workspace ${nodeId} Workspace path is not ready: ${workspaceId}`);
      const workspaceRoot = path.resolve(selected.path);
      const value = JSON.stringify({
        version: 1,
        workspaceId,
        access,
        label: String(selected.label || selected.id || path.basename(workspaceRoot)),
        cwd: workspaceRoot,
        workspaceRoot,
        pipelineWorkspace: path.resolve(scopedRoot),
        previous: null,
      });
      let nextInstance = workspaceSetOutputSlot(instance, "workspaceContext", value);
      graph.instances[nodeId] = nextInstance;
      publishNodeOutput(nodeId, value, { emitGraph: true });
      emit({ type: "node-done", nodeId, definitionId: defId, workspaceId, access });
      continue;
    }

    if (defId === "context_bundle") {
      const bundle = {
        version: 1,
        knowledgeContext: workspaceSemanticInputText(graph, nodeId, outputs, "knowledgeContext", scopedRoot),
        skillsContext: workspaceSemanticInputText(graph, nodeId, outputs, "skillsContext", scopedRoot),
        workspaceContext: workspaceSemanticInputText(graph, nodeId, outputs, "workspaceContext", scopedRoot),
        mcpContext: workspaceSemanticInputText(graph, nodeId, outputs, "mcpContext", scopedRoot),
      };
      if (![bundle.knowledgeContext, bundle.skillsContext, bundle.workspaceContext, bundle.mcpContext].some((item) => String(item || "").trim())) {
        throw new Error(`context.bundle ${nodeId} requires at least one connected Context resource`);
      }
      const value = JSON.stringify(bundle);
      graph.instances[nodeId] = workspaceSetOutputSlot(instance, "context", value);
      publishNodeOutput(nodeId, value, { emitGraph: true });
      emit({ type: "node-done", nodeId, definitionId: defId });
      continue;
    }

    if (defId === "control_subflow_call") {
      const subflowId = String(instance.subflowId || "").trim();
      const subflow = graph?.subflows?.[subflowId];
      if (!subflow) throw new Error(`flow.call ${nodeId} references missing subflow ${subflowId || "(empty)"}`);
      const inputValues = workspaceInputValues(graph, nodeId, outputs, scopedRoot, { includeContext: true });
      const { resultValues, callFrameId } = await workspaceRunSubflowFrame({
        root,
        scopedRoot,
        payload,
        userCtx,
        opts,
        graph,
        parentNodeId: nodeId,
        parentDefinitionId: defId,
        subflowId,
        inputValues,
        signal,
        emit,
      });
      let nextInstance = instance;
      for (const [name, value] of Object.entries(resultValues)) {
        nextInstance = workspaceSetOutputSlot(nextInstance, name, value);
      }
      graph.instances[nodeId] = nextInstance;
      const primaryName = Object.keys(subflow.outputs || {})[0] || "";
      const primaryValue = primaryName ? resultValues[primaryName] : "";
      const updatedDisplays = publishNodeOutput(nodeId, primaryValue);
      emit({ type: "graph", nodeId, displayNodeIds: updatedDisplays, graph });
      emit({ type: "node-done", nodeId, definitionId: defId, subflowId, callFrameId });
      continue;
    }

    if (defId === "control_load_skills") {
      const skillStartedAt = Date.now();
      const nodeSkillKeys = selectedSkillKeysFromInstance(instance);
      const skillsBlock = loadSkillsBlockForKeys(nodeSkillKeys);
      emitTiming(nodeId, "load-skills", skillStartedAt, { skillCount: nodeSkillKeys.length, charCount: skillsBlock.length });
      graph.instances[nodeId] = {
        ...instance,
        output: (Array.isArray(instance.output) ? instance.output : []).map((slot) => (
          String(slot?.name || "") === "skillsContext" || String(slot?.type || "") === "text"
            ? { ...slot, default: skillsBlock, value: skillsBlock }
            : slot
        )),
      };
      const updatedDisplays = publishNodeOutput(nodeId, skillsBlock);
      emit({ type: "graph", nodeId, displayNodeIds: updatedDisplays, graph });
      emit({ type: "node-done", nodeId, definitionId: defId });
      continue;
    }

    if (defId === "control_load_mcp") {
      const mcpStartedAt = Date.now();
      const serverNames = selectedMcpServerNamesFromInstance(instance);
      const mcpBlock = await loadMcpBlockForNames(serverNames);
      emitTiming(nodeId, "load-mcp", mcpStartedAt, { serverCount: serverNames.length, charCount: mcpBlock.length });
      graph.instances[nodeId] = {
        ...instance,
        output: (Array.isArray(instance.output) ? instance.output : []).map((slot) => (
          String(slot?.name || "") === "mcpContext" || String(slot?.type || "") === "text"
            ? { ...slot, default: mcpBlock, value: mcpBlock }
            : slot
        )),
      };
      const updatedDisplays = publishNodeOutput(nodeId, mcpBlock);
      emit({ type: "graph", nodeId, displayNodeIds: updatedDisplays, graph });
      emit({ type: "node-done", nodeId, definitionId: defId });
      continue;
    }

    if (workspaceDisplayKind(defId)) {
      if (!workspaceContentInputEdge(graph, nodeId)) {
        emit({ type: "status", nodeId, line: "Display unchanged: no content input edge" });
        emit({ type: "node-done", nodeId, definitionId: defId, unchanged: true });
        continue;
      }
      const content = workspaceUpstreamText(graph, nodeId, outputs, scopedRoot);
      graph.instances[nodeId] = workspaceWriteDisplayContent(instance, content);
      const updatedDisplays = publishNodeOutput(nodeId, content);
      emit({ type: "graph", nodeId, displayNodeIds: updatedDisplays, graph });
      emit({ type: "node-done", nodeId, definitionId: defId });
      continue;
    }

    if (defId === "control_if") {
      const inputValues = workspaceInputValues(graph, nodeId, outputs, scopedRoot);
      const boolSlot = (Array.isArray(instance.input) ? instance.input : [])
        .find((slot) => String(slot?.type || "").trim().toLowerCase() === "bool");
      const boolSlotName = String(boolSlot?.name || "").trim();
      const rawValue = boolSlotName && Object.prototype.hasOwnProperty.call(inputValues, boolSlotName)
        ? inputValues[boolSlotName]
        : workspaceSlotValue(boolSlot);
      const boolValue = parseBool(rawValue);
      const branch = boolValue ? "true" : "false";
      controlBranches.set(nodeId, branch);
      publishNodeOutput(nodeId, branch, { emitGraph: true });
      emit({ type: "status", nodeId, line: `control_if branch: ${branch}` });
      emit({ type: "node-done", nodeId, definitionId: defId, branch });
      continue;
    }

    if (defId === "control_parse_json") {
      const inputValues = workspaceInputValues(graph, nodeId, outputs, scopedRoot);
      const raw = String(inputValues.value ?? "").trim();
      if (!raw) throw new Error(`control.parseJson ${nodeId} requires a non-empty value`);
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        throw new Error(`control.parseJson ${nodeId} received invalid JSON: ${error.message}`);
      }
      const content = JSON.stringify(parsed);
      graph.instances[nodeId] = workspaceSetOutputSlot(instance, "result", content);
      publishNodeOutput(nodeId, content, { emitGraph: true });
      emit({ type: "node-done", nodeId, definitionId: defId });
      continue;
    }

    if (defId === "control_while") {
      const inputValues = workspaceInputValues(graph, nodeId, outputs, scopedRoot);
      const loopContext = workspaceSemanticInputText(graph, nodeId, outputs, "context", scopedRoot);
      const config = normalizeControlWhileConfig(inputValues);
      const stepScript = String(instance.script || instance.body || "").trim();
      const stepScriptRef = String(instance.scriptRef || "").trim();
      const conditionSubflowId = String(instance.conditionSubflowId || "").trim();
      const bodySubflowId = String(instance.bodySubflowId || "").trim();
      const usesSubflows = Boolean(conditionSubflowId || bodySubflowId);
      const whileSubflows = usesSubflows
        ? workspaceAssertWhileSubflowContract(graph, nodeId, conditionSubflowId, bodySubflowId)
        : null;
      if (!usesSubflows && !stepScript && !stepScriptRef) {
        throw new Error(`control.while ${nodeId} requires condition/body subflows or a step command/scriptRef`);
      }
      const previousDecision = workspaceSlotValue(workspaceSlotByName(instance, "decision")).trim().toLowerCase();
      const checkpointState = workspaceSlotValue(
        (Array.isArray(instance.output) ? instance.output : []).find((slot) => String(slot?.name || "") === "state"),
      );
      const checkpointFingerprint = workspaceSlotValue(
        (Array.isArray(instance.output) ? instance.output : []).find((slot) => String(slot?.name || "") === "checkpointFingerprint"),
      );
      const inputState = normalizeControlWhileInitialState(inputValues.state);
      const expectedCheckpointFingerprint = controlWhileCheckpointFingerprint({
        inputFingerprint: plannedFingerprints.get(nodeId) || "",
        initialState: inputState,
      });
      const checkpoint = resolveControlWhileCheckpoint({
        previousDecision,
        state: checkpointState,
        history: workspaceSlotValue(workspaceSlotByName(instance, "history")),
        iterations: workspaceSlotValue(workspaceSlotByName(instance, "iterations")),
        fingerprint: checkpointFingerprint,
        expectedFingerprint: expectedCheckpointFingerprint,
        allowResume: payload?.ignoreCache !== true && !forceNodeIds.has(nodeId),
      });
      const initialState = checkpoint.resumable ? checkpoint.state : inputState;
      if (checkpoint.resumable) {
        emit({ type: "status", nodeId, line: "control.while resume from waiting checkpoint" });
      } else if (previousDecision === "wait") {
        emit({ type: "status", nodeId, line: `control.while reset waiting checkpoint: ${checkpoint.reason}` });
      }
      const loop = await runControlWhile({
        initialState,
        initialHistory: checkpoint.resumable ? checkpoint.history : [],
        initialElapsedMs: checkpoint.resumable ? checkpoint.elapsedMs : 0,
        startIteration: checkpoint.resumable ? checkpoint.nextIteration : 1,
        ...config,
        signal,
        idempotencyKeyForIteration: ({ iteration }) => controlWhileIdempotencyKey({
          checkpointFingerprint: expectedCheckpointFingerprint,
          nodeId,
          iteration,
        }),
        onIterationStart: ({ iteration, remainingMs, idempotencyKey }) => {
          emit({
            type: "while-iteration-start",
            nodeId,
            definitionId: defId,
            iteration,
            maxIterations: config.maxIterations,
            remainingMs,
            idempotencyKey,
          });
          emit({ type: "status", nodeId, line: `control.while iteration ${iteration}/${config.maxIterations}` });
        },
        onIterationDone: ({ iteration, decision, summary, elapsedMs, idempotencyKey }) => {
          emit({
            type: "while-iteration-done",
            nodeId,
            definitionId: defId,
            iteration,
            decision,
            summary,
            elapsedMs,
            idempotencyKey,
          });
          emit({ type: "status", nodeId, line: `control.while iteration ${iteration}: ${decision}${summary ? ` · ${summary}` : ""}` });
        },
        executeStep: async ({ iteration, state, signal: stepSignal, idempotencyKey }) => {
          const stateText = serializeControlWhileState(state);
          const iterationInputs = {
            ...inputValues,
            state: stateText,
            iteration: String(iteration),
          };
          if (whileSubflows) {
            const conditionFrame = await workspaceRunSubflowFrame({
              root,
              scopedRoot,
              payload,
              userCtx,
              opts,
              graph,
              parentNodeId: nodeId,
              parentDefinitionId: defId,
              subflowId: whileSubflows.conditionId,
              inputValues: {
                ...(loopContext && whileSubflows.condition.inputs?.context ? { context: loopContext } : {}),
                state: stateText,
                iteration: String(iteration),
                idempotencyKey,
              },
              signal: stepSignal,
              emit,
              eventContext: { iteration, whileRole: "condition" },
            });
            const conditionStep = parseControlWhileStepResult(JSON.stringify({
              decision: String(conditionFrame.resultValues.decision || "").trim().toLowerCase(),
              summary: String(conditionFrame.resultValues.summary || ""),
            }), state);
            if (conditionStep.decision !== "continue") return JSON.stringify(conditionStep);

            const bodyFrame = await workspaceRunSubflowFrame({
              root,
              scopedRoot,
              payload,
              userCtx,
              opts,
              graph,
              parentNodeId: nodeId,
              parentDefinitionId: defId,
              subflowId: whileSubflows.bodyId,
              inputValues: {
                ...(loopContext && whileSubflows.body.inputs?.context ? { context: loopContext } : {}),
                state: stateText,
                iteration: String(iteration),
                idempotencyKey,
              },
              signal: stepSignal,
              emit,
              eventContext: { iteration, whileRole: "body" },
            });
            const nextStateText = String(bodyFrame.resultValues.state || "").trim();
            if (!nextStateText) {
              throw new Error(`control.while ${nodeId} body subflow ${whileSubflows.bodyId} returned an empty state`);
            }
            const nextState = normalizeControlWhileInitialState(nextStateText);
            return JSON.stringify({
              decision: "continue",
              state: nextState,
              summary: String(bodyFrame.resultValues.summary || conditionStep.summary || ""),
            });
          }
          const runPackage = workspaceCreateNodeRunPackage(runTmpRoot, `${nodeId}-iteration-${iteration}`, {
            scopedRoot: runtimeStorageRoot,
            sourceRoot: scopedRoot,
            cwd,
            task: stepScript || stepScriptRef,
            inputValues: iterationInputs,
          });
          const runtimeInputValues = { ...iterationInputs, ...(runPackage.inputValues || {}) };
          let activeStepChild = null;
          let activeStepChildOptions = {};
          const terminateStep = () => terminateWorkspaceChild(activeStepChild, activeStepChildOptions);
          stepSignal?.addEventListener("abort", terminateStep, { once: true });
          try {
            const content = await workspaceRunToolNodejsScript({
              scopedRoot,
              cwd,
              instance: { ...instance, script: stepScript, scriptRef: stepScript ? "" : stepScriptRef },
              inputValues: runtimeInputValues,
              runPackage,
              userCtx,
              envOverlay: {
                ...runEnv,
                AGENTFLOW_WHILE_STATE: stateText,
                AGENTFLOW_WHILE_ITERATION: String(iteration),
                AGENTFLOW_WHILE_MAX_ITERATIONS: String(config.maxIterations),
                AGENTFLOW_WHILE_TIMEOUT_MS: String(config.timeoutMs),
                AGENTFLOW_WHILE_IDEMPOTENCY_KEY: idempotencyKey,
              },
              emit: (event) => emit({ ...event, nodeId, iteration }),
              signal: stepSignal,
              stderrAsStatus: true,
              maxStdoutBytes: MAX_CONTROL_WHILE_STEP_STDOUT_BYTES,
              maxStderrBytes: MAX_CONTROL_WHILE_STEP_STDERR_BYTES,
              onActiveChild: (child, childOptions = {}) => {
                activeStepChild = child || null;
                activeStepChildOptions = childOptions;
                if (stepSignal?.aborted && child) terminateStep();
                if (typeof opts.onActiveChild === "function") opts.onActiveChild(child, childOptions);
              },
            });
            return workspaceStructuredAgentOutput(content).result || content;
          } finally {
            stepSignal?.removeEventListener("abort", terminateStep);
          }
        },
      });
      const resultContent = JSON.stringify({
        decision: loop.decision,
        iterations: loop.iterations,
        state: loop.state,
        summary: loop.summary,
        history: loop.history,
      });
      let nextInstance = workspaceSetOutputSlot(instance, "result", resultContent);
      nextInstance = workspaceSetOutputSlot(nextInstance, "state", serializeControlWhileState(loop.state));
      nextInstance = workspaceSetOutputSlot(nextInstance, "decision", loop.decision);
      nextInstance = workspaceSetOutputSlot(nextInstance, "iterations", String(loop.iterations));
      nextInstance = workspaceSetOutputSlot(nextInstance, "summary", loop.summary);
      nextInstance = workspaceSetOutputSlot(nextInstance, "history", JSON.stringify(loop.history));
      nextInstance = workspaceSetOutputSlot(nextInstance, "checkpointFingerprint", expectedCheckpointFingerprint);
      graph.instances[nodeId] = nextInstance;
      const updatedDisplays = publishNodeOutput(nodeId, resultContent);
      emit({ type: "graph", nodeId, displayNodeIds: updatedDisplays, graph });
      if (loop.decision === "fail") {
        emit({
          type: "node-failed",
          nodeId,
          definitionId: defId,
          decision: loop.decision,
          iterations: loop.iterations,
          summary: loop.summary,
        });
        throw new Error(loop.summary || "control.while step failed");
      }
      emit({
        type: "node-done",
        nodeId,
        definitionId: defId,
        decision: loop.decision,
        iterations: loop.iterations,
        summary: loop.summary,
      });
      if (loop.decision === "wait") {
        runtimePauseNodeIds.push(nodeId);
        break;
      }
      continue;
    }

    if (defId === "provide_str" || defId === "provide_password") {
      const content = workspaceInstanceText(instance);
      publishNodeOutput(nodeId, content, { emitGraph: true });
      emit({ type: "node-done", nodeId, definitionId: defId });
      continue;
    }

    if (defId === "provide_json") {
      const raw = workspaceSlotValue(Array.isArray(instance.output) ? instance.output[0] : null) || workspaceInstanceText(instance);
      let parsed;
      try {
        parsed = JSON.parse(String(raw || "").trim());
      } catch (error) {
        throw new Error(`provide.json ${nodeId} received invalid JSON: ${error.message}`);
      }
      const content = JSON.stringify(parsed);
      graph.instances[nodeId] = workspaceSetOutputSlot(instance, "value", content);
      publishNodeOutput(nodeId, content, { emitGraph: true });
      emit({ type: "node-done", nodeId, definitionId: defId });
      continue;
    }

    if (defId === "provide_bool") {
      const raw = workspaceSlotValue(Array.isArray(instance.output) ? instance.output[0] : null) || workspaceInstanceText(instance);
      const content = ["true", "1", "yes", "on"].includes(String(raw || "").trim().toLowerCase()) ? "true" : "false";
      publishNodeOutput(nodeId, content, { emitGraph: true });
      emit({ type: "node-done", nodeId, definitionId: defId });
      continue;
    }

    if (defId === "provide_file") {
      const fileValue = workspaceSlotValue(Array.isArray(instance.output) ? instance.output[0] : null) || workspaceInstanceText(instance);
      const abs = path.resolve(scopedRoot, fileValue);
      if (!abs.startsWith(path.resolve(scopedRoot) + path.sep) && abs !== path.resolve(scopedRoot)) {
        throw new Error(`Workspace file is outside root: ${fileValue}`);
      }
      const content = fs.existsSync(abs) && fs.statSync(abs).isFile() ? fs.readFileSync(abs, "utf-8") : fileValue;
      publishNodeOutput(nodeId, content, { emitGraph: true });
      emit({ type: "node-done", nodeId, definitionId: defId });
      continue;
    }

    if (defId === "tool_set_run_env") {
      const inputValues = workspaceInputValues(graph, nodeId, outputs, scopedRoot);
      const assignments = {
        ...parseRunEnvAssignments(inputValues.variables || workspaceSlotValue(workspaceSlotByName(instance, "variables"))),
      };
      const key = normalizeRunEnvKey(inputValues.key || workspaceSlotValue(workspaceSlotByName(instance, "key")));
      if (key) assignments[key] = String(inputValues.value ?? workspaceSlotValue(workspaceSlotByName(instance, "value")) ?? "");
      const keys = Object.keys(assignments);
      if (!keys.length) throw new Error("Set Run Env requires key/value or variables");
      Object.assign(runEnv, assignments);
      let nextInstance = workspaceSetOutputSlot(instance, "keys", keys.join(", "));
      nextInstance = workspaceSetOutputSlot(nextInstance, "count", String(keys.length));
      graph.instances[nodeId] = nextInstance;
      const updatedDisplays = publishNodeOutput(nodeId, keys.join(", "));
      emit({ type: "status", nodeId, line: `Set run env: ${keys.join(", ")}`, envKeys: keys });
      emit({ type: "graph", nodeId, displayNodeIds: updatedDisplays, graph });
      emit({ type: "node-done", nodeId, definitionId: defId });
      continue;
    }

    if (defId === "control_cd_workspace") {
      const inputText = workspaceUpstreamText(graph, nodeId, outputs, scopedRoot);
      const inputSlots = Array.isArray(instance.input) ? instance.input : [];
      const pathSlot = inputSlots.find((slot) => String(slot?.name || "") === "path") ||
        inputSlots.find((slot) => String(slot?.name || "") === "target");
      const labelSlot = inputSlots.find((slot) => String(slot?.name || "") === "label");
      const knowledgeSlot = inputSlots.find((slot) => String(slot?.name || "") === "knowledgeContext");
      const contextSlot = inputSlots.find((slot) => String(slot?.name || "") === "workspaceContext");
      const knowledgeText = workspaceSlotValue(knowledgeSlot);
      let knowledgeSources = workspaceKnowledgeSourcesFromText(knowledgeText, cwd || scopedRoot, scopedRoot);
      const candidate = workspaceSlotValue(pathSlot) || workspaceInstanceText(instance) || inputText;
      if (!knowledgeSources.length && candidate) {
        const abs = path.resolve(scopedRoot, candidate);
        if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
          throw new Error(`Load Knowledge path does not exist or is not a directory: ${abs}`);
        }
        knowledgeSources = [{
          id: path.basename(abs) || "knowledge",
          label: workspaceSlotValue(labelSlot) || path.basename(abs) || "知识库",
          kind: "local",
          type: "",
          path: abs,
          repoPath: abs,
          mountPath: "",
          repoUrl: "",
          branch: "",
          readonly: true,
        }];
      }
      const parsedContext = parseJsonText(workspaceSlotValue(contextSlot), {});
      const configuredContext = parsedContext && typeof parsedContext === "object" && !Array.isArray(parsedContext) ? parsedContext : {};
      const primarySource = knowledgeSources[0] || null;
      const primaryPath = primarySource?.path ? path.resolve(String(primarySource.path)) : "";
      const knowledgeContext = {
        version: 1,
        sources: knowledgeSources,
      };
      const workspaceContext = primarySource ? {
        ...configuredContext,
        version: 1,
        label: primarySource.label || workspaceSlotValue(labelSlot) || path.basename(primaryPath) || "知识库",
        cwd: primaryPath,
        workspaceRoot: primaryPath,
        pipelineWorkspace: path.resolve(scopedRoot),
        previous: null,
      } : null;
      let nextInstance = workspaceSetOutputSlot(instance, "knowledgeContext", JSON.stringify(knowledgeContext));
      nextInstance = workspaceSetOutputSlot(nextInstance, "workspaceContext", workspaceContext ? JSON.stringify(workspaceContext) : "");
      nextInstance = workspaceSetOutputSlot(nextInstance, "cwd", primaryPath);
      graph.instances[nodeId] = nextInstance;
      publishNodeOutput(nodeId, JSON.stringify(knowledgeContext), { emitGraph: true });
      emit({ type: "graph", nodeId, graph });
      emit({ type: "node-done", nodeId, definitionId: defId });
      continue;
    }

    if (defId === "control_user_workspace") {
      cwd = path.resolve(os.homedir());
      const workspaceContext = {
        version: 1,
        label: "home",
        cwd,
        workspaceRoot: cwd,
        pipelineWorkspace: path.resolve(scopedRoot),
        previous: null,
      };
      let nextInstance = workspaceSetOutputSlot(instance, "workspaceContext", JSON.stringify(workspaceContext));
      nextInstance = workspaceSetOutputSlot(nextInstance, "cwd", cwd);
      graph.instances[nodeId] = nextInstance;
      publishNodeOutput(nodeId, JSON.stringify(workspaceContext), { emitGraph: true });
      emit({ type: "graph", nodeId, graph });
      emit({ type: "node-done", nodeId, definitionId: defId });
      continue;
    }

    if (defId === "tool_jenkins_build") {
      const inputValues = workspaceInputValues(graph, nodeId, outputs, scopedRoot);
      const config = normalizeJenkinsBuildConfig({
        job: inputValues.job || workspaceSlotValue(workspaceSlotByName(instance, "job")),
        parameters: inputValues.parameters || workspaceSlotValue(workspaceSlotByName(instance, "parameters")),
        credentialRef: inputValues.credentialRef || workspaceSlotValue(workspaceSlotByName(instance, "credentialRef")),
        pollInterval: inputValues.pollInterval || workspaceSlotValue(workspaceSlotByName(instance, "pollInterval")),
        timeout: inputValues.timeout || workspaceSlotValue(workspaceSlotByName(instance, "timeout")),
      });
      const statePath = jenkinsBuildStatePath(scopedRoot, nodeId);
      let state = readJenkinsBuildState(statePath);
      // A completed checkpoint belongs to an earlier execution. An unfinished one is always
      // resumed, even when the server restarted and the browser created a new run id.
      if (state?.phase === "complete") state = null;
      const invoke = createJenkinsHttpInvoker({
        credentialRef: config.credentialRef,
        env: runtimeEnv(),
        fetchImpl: opts.jenkinsFetch || globalThis.fetch,
        signal,
      });
      throwIfAborted();
      const result = await advanceJenkinsBuild({
        state,
        config,
        invoke,
        persistState: (checkpoint) => writeJenkinsBuildState(statePath, checkpoint),
        cancelled: signal?.aborted === true,
        runId: opts.runId || payload.runId || payload.runSessionId || "",
      });
      throwIfAborted();
      state = result.state;
      writeJenkinsBuildState(statePath, state);
      let nextInstance = workspaceSetOutputSlot(graph.instances[nodeId], "status", result.outputs?.status || state.status || "");
      nextInstance = workspaceSetOutputSlot(nextInstance, "url", result.outputs?.url || state.url || state.buildUrl || "");
      nextInstance = workspaceSetOutputSlot(nextInstance, "qrUrl", result.outputs?.qrUrl || state.qrUrl || "");
      graph.instances[nodeId] = nextInstance;
      emit({
        type: "status",
        nodeId,
        line: result.message || state.message || "Jenkins Build",
        phase: state.phase || "",
        jenkinsStatus: state.status || "",
        buildNumber: state.buildNumber || "",
        url: state.url || state.buildUrl || "",
        qrUrl: state.qrUrl || "",
        wakeAt: state.wakeAt || "",
      });
      emit({ type: "graph", nodeId, graph });
      if (result.kind === "waiting") {
        deferred = {
          kind: "jenkins",
          nodeId,
          phase: String(state.phase || ""),
          status: String(state.status || ""),
          message: String(result.message || state.message || "Jenkins Build"),
          buildNumber: String(state.buildNumber || ""),
          url: String(state.url || state.buildUrl || ""),
          qrUrl: String(state.qrUrl || ""),
          wakeAt: String(result.wakeAt || state.wakeAt || new Date(Date.now() + config.pollIntervalMs).toISOString()),
        };
        emit({ type: "node-waiting", nodeId, definitionId: defId, ...deferred });
        break;
      }
      if (result.kind === "failed") throw new Error(result.message || "Jenkins build node failed");
      const finalStatus = result.outputs?.status || state.status || "ERROR";
      const updatedDisplays = publishNodeOutput(nodeId, finalStatus);
      emit({ type: "graph", nodeId, displayNodeIds: updatedDisplays, graph });
      emit({ type: "node-done", nodeId, definitionId: defId, jenkinsStatus: finalStatus });
      continue;
    }

    if (defId === "tool_git_checkout") {
      const repoUrl = workspaceSlotValue(workspaceSlotByName(instance, "repoUrl")).trim();
      if (!repoUrl) throw new Error("Git Checkout requires repoUrl");
      const branch = workspaceSlotValue(workspaceSlotByName(instance, "branch")).trim();
      const targetRaw = workspaceSlotValue(workspaceSlotByName(instance, "targetDir")).trim();
      const targetDir = targetRaw
        ? workspaceResolvePath(cwd, targetRaw)
        : path.join(workspaceDefaultGitRepoRoot(scopedRoot, userCtx), workspaceSanitizeRepoDirName(repoUrl));
      const pullIfExists = workspaceBoolSlot(instance, "pullIfExists", true);
      const includeSubmodules = workspaceBoolSlot(instance, "includeSubmodules", false);
      fs.mkdirSync(path.dirname(targetDir), { recursive: true });
      let changed = false;
      if (fs.existsSync(path.join(targetDir, ".git"))) {
        if (pullIfExists) {
          const fetch = runGit(["fetch", "--all", "--prune"], targetDir);
          if (fetch.status !== 0) throw new Error(`git fetch failed: ${fetch.stderr || fetch.stdout}`);
          if (branch) {
            const checkout = runGit(["checkout", branch], targetDir);
            if (checkout.status !== 0) throw new Error(`git checkout failed: ${checkout.stderr || checkout.stdout}`);
          }
          const before = runGit(["rev-parse", "HEAD"], targetDir).stdout.trim();
          const pull = runGit(["pull", "--ff-only"], targetDir);
          if (pull.status !== 0) throw new Error(`git pull failed: ${pull.stderr || pull.stdout}`);
          const after = runGit(["rev-parse", "HEAD"], targetDir).stdout.trim();
          changed = before !== after;
        }
      } else {
        const args = ["clone"];
        if (includeSubmodules) args.push("--recurse-submodules");
        if (branch) args.push("--branch", branch);
        args.push(repoUrl, targetDir);
        const clone = runGit(args, cwd);
        if (clone.status !== 0) throw new Error(`git clone failed: ${clone.stderr || clone.stdout}`);
        changed = true;
      }
      if (includeSubmodules) {
        const submodule = runGit(["submodule", "update", "--init", "--recursive"], targetDir);
        if (submodule.status !== 0) throw new Error(`git submodule update failed: ${submodule.stderr || submodule.stdout}`);
      }
      const currentBranch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], targetDir).stdout.trim();
      const commit = runGit(["rev-parse", "HEAD"], targetDir).stdout.trim();
      const remote = workspaceSlotValue(workspaceSlotByName(instance, "remote")).trim() || "origin";
      const gitContext = buildGitContext({
        repoPath: targetDir,
        branch: currentBranch === "HEAD" ? "DETACHED" : currentBranch,
        commit,
        remote,
      });
      const previousCwd = cwd;
      cwd = path.resolve(targetDir);
      let nextInstance = workspaceSetOutputSlot(instance, "repoPath", targetDir);
      nextInstance = workspaceSetOutputSlot(nextInstance, "branch", gitContext.branch);
      nextInstance = workspaceSetOutputSlot(nextInstance, "commit", commit);
      nextInstance = workspaceSetOutputSlot(nextInstance, "changed", changed ? "true" : "false");
      nextInstance = workspaceSetOutputSlot(nextInstance, "gitContext", JSON.stringify(gitContext));
      nextInstance = workspaceSetOutputSlot(nextInstance, "workspaceContext", JSON.stringify({
        version: 1,
        label: workspaceSanitizeRepoDirName(repoUrl),
        cwd,
        workspaceRoot: cwd,
        pipelineWorkspace: scopedRoot,
        previous: { version: 1, label: "workspace", cwd: previousCwd, workspaceRoot: previousCwd, pipelineWorkspace: scopedRoot, previous: null },
      }));
      graph.instances[nodeId] = nextInstance;
      const updatedDisplays = publishNodeOutput(nodeId, targetDir);
      emit({ type: "graph", nodeId, displayNodeIds: updatedDisplays, graph });
      emit({ type: "node-done", nodeId, definitionId: defId });
      continue;
    }

    if (defId === "tool_git_worktree_load") {
      const gitContext = normalizeGitContext(workspaceSlotValue(workspaceSlotByName(instance, "gitContext")));
      const repoPath = workspaceResolvePath(cwd, workspaceSlotValue(workspaceSlotByName(instance, "repoPath"))) ||
        (gitContext?.repoPath ? path.resolve(gitContext.repoPath) : "");
      if (!repoPath) throw new Error("Load Worktree requires repoPath");
      const branch = workspaceSlotValue(workspaceSlotByName(instance, "branch")).trim();
      const worktreeInputSlot = (Array.isArray(instance.input) ? instance.input : [])
        .find((slot) => String(slot?.name || "") === "worktreePath") || null;
      const rawWorktreePath = workspaceSlotValue(worktreeInputSlot || workspaceSlotByName(instance, "worktreePath")).trim();
      const retainedWorktreePath = workspaceSlotValue(
        (Array.isArray(instance.output) ? instance.output : [])
          .find((slot) => String(slot?.name || "") === "worktreePath"),
      ).trim();
      const worktreePath = rawWorktreePath
        ? workspaceResolvePath(cwd, rawWorktreePath)
        : (gitContext?.worktreePath
            ? path.resolve(gitContext.worktreePath)
            : (retainedWorktreePath
                ? path.resolve(retainedWorktreePath)
                : workspaceDefaultWorktreePath(scopedRoot, runtimeRunId, nodeId, repoPath, branch)));
      const previousCwd = cwd;
      const force = ["true", "1", "yes", "on"].includes(workspaceSlotValue(workspaceSlotByName(instance, "force")).trim().toLowerCase());
      const pruneMissingRaw = workspaceSlotValue(workspaceSlotByName(instance, "pruneMissing")).trim().toLowerCase();
      const pruneMissing = pruneMissingRaw !== "false";
      const result = loadGitWorktree({ repoPath, branch, worktreePath, pipelineWorkspace: scopedRoot, force, pruneMissing });
      if (workspaceShouldAutoCleanupWorktree(result, scopedRoot)) {
        workspaceTrackAutoCleanupWorktree(autoCleanupWorktrees, {
          nodeId,
          repoPath: result.repoRoot,
          worktreePath: result.worktreePath,
        });
        persistRunManifest("running");
      }
      const outGitContext = buildGitContext({
        repoPath: result.repoRoot,
        worktreePath: result.worktreePath,
        branch: result.branch,
        commit: result.commit,
        remote: gitContext?.remote || "origin",
        remoteUrl: gitContext?.remoteUrl || "",
      });
      cwd = result.worktreePath;
      let nextInstance = workspaceSetOutputSlot(instance, "worktreePath", result.worktreePath);
      nextInstance = workspaceSetOutputSlot(nextInstance, "branch", result.branch);
      nextInstance = workspaceSetOutputSlot(nextInstance, "commit", result.commit);
      nextInstance = workspaceSetOutputSlot(nextInstance, "gitContext", JSON.stringify(outGitContext));
      nextInstance = workspaceSetOutputSlot(nextInstance, "workspaceContext", JSON.stringify({
        version: 1,
        label: result.branch === "DETACHED" ? `worktree:${result.commit.slice(0, 8)}` : `worktree:${result.branch}`,
        cwd: result.worktreePath,
        workspaceRoot: result.worktreePath,
        pipelineWorkspace: scopedRoot,
        previous: { version: 1, label: "workspace", cwd: previousCwd, workspaceRoot: previousCwd, pipelineWorkspace: scopedRoot, previous: null },
      }));
      graph.instances[nodeId] = nextInstance;
      const updatedDisplays = publishNodeOutput(nodeId, result.worktreePath);
      emit({ type: "graph", nodeId, displayNodeIds: updatedDisplays, graph });
      emit({ type: "node-done", nodeId, definitionId: defId });
      continue;
    }

    if (defId === "tool_git_worktree_unload") {
      const gitContext = normalizeGitContext(workspaceSlotValue(workspaceSlotByName(instance, "gitContext")));
      const workspaceContext = parseJsonText(workspaceSlotValue(workspaceSlotByName(instance, "workspaceContext")), null);
      const contextCwd = workspaceContext?.cwd ? path.resolve(String(workspaceContext.cwd)) : cwd;
      const worktreePath = workspaceResolvePath(contextCwd, workspaceSlotValue(workspaceSlotByName(instance, "worktreePath"))) ||
        (gitContext?.worktreePath ? path.resolve(gitContext.worktreePath) : "") ||
        contextCwd;
      const repoPath = workspaceResolvePath(contextCwd, workspaceSlotValue(workspaceSlotByName(instance, "repoPath"))) ||
        (gitContext?.repoPath ? path.resolve(gitContext.repoPath) : "") ||
        inferGitRepoRootFromWorktree(worktreePath);
      const force = ["true", "1", "yes", "on"].includes(workspaceSlotValue(workspaceSlotByName(instance, "force")).trim().toLowerCase());
      const pruneRaw = workspaceSlotValue(workspaceSlotByName(instance, "prune")).trim().toLowerCase();
      const prune = pruneRaw !== "false";
      const result = unloadGitWorktree({ repoPath, worktreePath, force, prune });
      workspaceUntrackAutoCleanupWorktree(autoCleanupWorktrees, result.worktreePath);
      const previousContext = workspaceContext?.previous && typeof workspaceContext.previous === "object" ? workspaceContext.previous : null;
      cwd = previousContext?.cwd ? path.resolve(String(previousContext.cwd)) : scopedRoot;
      let nextInstance = workspaceSetOutputSlot(instance, "removed", "true");
      nextInstance = workspaceSetOutputSlot(nextInstance, "message", result.message);
      nextInstance = workspaceSetOutputSlot(nextInstance, "workspaceContext", JSON.stringify(previousContext || {
        version: 1,
        label: "workspace",
        cwd,
        workspaceRoot: cwd,
        pipelineWorkspace: scopedRoot,
        previous: null,
      }));
      graph.instances[nodeId] = nextInstance;
      const updatedDisplays = publishNodeOutput(nodeId, result.message);
      emit({ type: "graph", nodeId, displayNodeIds: updatedDisplays, graph });
      emit({ type: "node-done", nodeId, definitionId: defId });
      continue;
    }

    if (defId === "tool_gitlab_create_mr") {
      const gitContext = normalizeGitContext(workspaceSlotValue(workspaceSlotByName(instance, "gitContext")));
      const repoPath = workspaceResolvePath(cwd, workspaceSlotValue(workspaceSlotByName(instance, "repoPath")));
      const result = await createGitLabMergeRequest({
        gitContext,
        workspaceCwd: cwd,
        repoPath,
        sourceBranch: workspaceSlotValue(workspaceSlotByName(instance, "sourceBranch")),
        targetBranch: workspaceSlotValue(workspaceSlotByName(instance, "targetBranch")),
        title: workspaceSlotValue(workspaceSlotByName(instance, "title")),
        description: workspaceSlotValue(workspaceSlotByName(instance, "description")),
        draft: workspaceSlotValue(workspaceSlotByName(instance, "draft")),
        labels: workspaceSlotValue(workspaceSlotByName(instance, "labels")),
        push: workspaceSlotValue(workspaceSlotByName(instance, "push")),
        remote: workspaceSlotValue(workspaceSlotByName(instance, "remote")),
        tokenEnv: workspaceSlotValue(workspaceSlotByName(instance, "tokenEnv")),
        gitlabApiBase: workspaceSlotValue(workspaceSlotByName(instance, "gitlabApiBase")),
        removeSourceBranch: workspaceSlotValue(workspaceSlotByName(instance, "removeSourceBranch")),
        squash: workspaceSlotValue(workspaceSlotByName(instance, "squash")),
      }, runtimeEnv());
      let nextInstance = workspaceSetOutputSlot(instance, "mrUrl", result.mrUrl);
      nextInstance = workspaceSetOutputSlot(nextInstance, "created", result.created ? "true" : "false");
      nextInstance = workspaceSetOutputSlot(nextInstance, "mrIid", result.mrIid ?? "");
      nextInstance = workspaceSetOutputSlot(nextInstance, "projectId", result.projectId ?? "");
      nextInstance = workspaceSetOutputSlot(nextInstance, "sourceBranch", result.sourceBranch ?? "");
      nextInstance = workspaceSetOutputSlot(nextInstance, "targetBranch", result.targetBranch ?? "");
      nextInstance = workspaceSetOutputSlot(nextInstance, "title", result.title ?? "");
      nextInstance = workspaceSetOutputSlot(nextInstance, "message", result.message ?? "");
      graph.instances[nodeId] = nextInstance;
      const updatedDisplays = publishNodeOutput(nodeId, result.mrUrl);
      emit({ type: "graph", nodeId, displayNodeIds: updatedDisplays, graph });
      emit({ type: "node-done", nodeId, definitionId: defId });
      continue;
    }

    if (defId === "tool_wecom_send_group_markdown" || defId === "tool_wecom_send_app_markdown") {
      const inputValues = workspaceInputValues(graph, nodeId, outputs, scopedRoot);
      const markdown = String(inputValues.markdown || inputValues.content || workspaceSlotValue(workspaceSlotByName(instance, "markdown")) || workspaceUpstreamText(graph, nodeId, outputs, scopedRoot) || "");
      const result = defId === "tool_wecom_send_app_markdown"
        ? await sendWecomAppMarkdown({
            markdown,
            toUser: inputValues.toUser || workspaceSlotValue(workspaceSlotByName(instance, "toUser")),
            corpId: inputValues.corpId || workspaceSlotValue(workspaceSlotByName(instance, "corpId")),
            corpSecret: inputValues.corpSecret || workspaceSlotValue(workspaceSlotByName(instance, "corpSecret")),
            agentId: inputValues.agentId || workspaceSlotValue(workspaceSlotByName(instance, "agentId")),
            accessToken: inputValues.accessToken || workspaceSlotValue(workspaceSlotByName(instance, "accessToken")),
          }, runtimeEnv())
        : await sendWecomGroupMarkdown({
            markdown,
            webhookUrl: inputValues.webhookUrl || workspaceSlotValue(workspaceSlotByName(instance, "webhookUrl")),
            webhookKey: inputValues.webhookKey || workspaceSlotValue(workspaceSlotByName(instance, "webhookKey")),
          }, runtimeEnv());
      let nextInstance = workspaceSetOutputSlot(instance, "sent", "true");
      nextInstance = workspaceSetOutputSlot(nextInstance, "message", result.message);
      nextInstance = workspaceSetOutputSlot(nextInstance, "response", JSON.stringify(result.response || {}));
      graph.instances[nodeId] = nextInstance;
      const updatedDisplays = publishNodeOutput(nodeId, result.message);
      emit({ type: "graph", nodeId, displayNodeIds: updatedDisplays, graph });
      emit({ type: "node-done", nodeId, definitionId: defId });
      continue;
    }

    if (defId === "tool_display_share_link") {
      const inputValues = workspaceInputValues(graph, nodeId, outputs, scopedRoot);
      const explicitNodeIds = parseDisplayShareNodeIdInput(inputValues.nodeIds || workspaceSlotValue(workspaceSlotByName(instance, "nodeIds")));
      const inferredNodeIds = explicitNodeIds.length ? explicitNodeIds : inferUpstreamDisplayNodeIds(graph, nodeId);
      const nodeIds = normalizeDisplayShareNodeIds(inferredNodeIds, graph);
      if (nodeIds.length === 0) throw new Error("Display Share Link requires at least one connected display node or nodeIds input");

      const layout = normalizeDisplayShareLayout(inputValues.layout || workspaceSlotValue(workspaceSlotByName(instance, "layout")), "single");
      const title = inputValues.title || workspaceSlotValue(workspaceSlotByName(instance, "title"));
      const env = runtimeEnv();
      const baseUrl = inputValues.baseUrl ||
        workspaceSlotValue(workspaceSlotByName(instance, "baseUrl")) ||
        env.AGENTFLOW_PUBLIC_BASE_URL ||
        env.AGENTFLOW_BASE_URL ||
        env.PUBLIC_BASE_URL ||
        payload.requestBaseUrl ||
        payload.requestOrigin ||
        "";

      try {
        const currentGraph = readWorkspaceGraph(scopedRoot, root).graph;
        const mergedGraph = mergeWorkspaceRunGraph(currentGraph, graph, new Set([nodeId, ...nodeIds]));
        writeWorkspaceGraph(scopedRoot, mergedGraph, root);
      } catch (e) {
        emit({ type: "natural", kind: "warning", text: `保存分享展示内容失败：${(e && e.message) || String(e)}` });
      }

      const share = createDisplayShareRecord({
        userId: userCtx.userId,
        flowId: payload.flowId || "",
        flowSource: payload.flowSource || "user",
        archived: payload.archived === true || payload.flowArchived === true,
        title,
        layout,
        nodeIds,
        expiresMode: payload.expiresMode,
        expiresInDays: payload.expiresInDays,
        permanent: payload.permanent,
        expiresAt: payload.expiresAt,
      });
      const url = displayShareOutputUrl(share.id, baseUrl);
      let nextInstance = workspaceSetOutputSlot(instance, "url", url);
      nextInstance = workspaceSetOutputSlot(nextInstance, "shareId", share.id);
      nextInstance = workspaceSetOutputSlot(nextInstance, "expiresAt", share.expiresAt);
      graph.instances[nodeId] = nextInstance;
      const updatedDisplays = publishNodeOutput(nodeId, url);
      emit({ type: "graph", nodeId, graph, displayNodeIds: [...nodeIds, ...updatedDisplays] });
      emit({ type: "node-done", nodeId, definitionId: defId });
      continue;
    }

    if (defId === "tool_nodejs") {
      const nodeModelKey = workspaceNodeModelKey(instance, modelKey);
      const prepareStartedAt = Date.now();
      const inputValues = workspaceInputValues(graph, nodeId, outputs, scopedRoot);
      const runPackage = workspaceCreateNodeRunPackage(runTmpRoot, nodeId, {
        scopedRoot: runtimeStorageRoot,
        sourceRoot: scopedRoot,
        cwd,
        task: String(instance.script || instance.scriptRef || instance.body || "").trim(),
        inputValues,
        durableOutputs: true,
      });
      const runtimeInputValues = { ...inputValues, ...(runPackage.inputValues || {}) };
      emitTiming(nodeId, "prepare-script", prepareStartedAt, {
        inputCount: Object.keys(runtimeInputValues || {}).length,
        nodeRunDir: runPackage.nodeRunDir,
      });
      const content = await workspaceRunToolNodejsScript({
        scopedRoot,
        cwd,
        instance,
        inputValues: runtimeInputValues,
        runPackage,
        userCtx,
        envOverlay: runEnv,
        emit: (event) => emit({ ...event, nodeId }),
        signal,
        onActiveChild: opts.onActiveChild,
      });
      const structuredAgentOutput = workspaceStructuredAgentOutput(content);
      const nodeOutput = String(instance.marketplaceRef || "").trim()
        ? workspaceMaterializeNodePackageOutputValues(structuredAgentOutput, runPackage, instance)
        : structuredAgentOutput;
      const normalizedAgentOutput = workspacePublishAgentOutputFiles(nodeOutput, runPackage);
      const resultContent = normalizedAgentOutput.result || content;
      recordNodeOutput(nodeId, resultContent);
      const slotUpdate = workspaceApplyAgentOutputSlots(instance, normalizedAgentOutput);
      if (slotUpdate.changed) graph.instances[nodeId] = slotUpdate.instance;
      const implementationUpdate = await workspaceTryPersistNodeImplementation(scopedRoot, graph, nodeId, {
        inputValues: runtimeInputValues,
        resultContent,
        structured: normalizedAgentOutput,
        runPackage,
        modelKey: nodeModelKey,
        userCtx,
        emit: (event) => emit({ ...event, nodeId }),
        onActiveChild: opts.onActiveChild,
      });
      if (implementationUpdate.changed) graph.instances[nodeId] = implementationUpdate.instance;
      const updatedDisplays = propagateNodeOutputDisplays(nodeId, resultContent);
      if (slotUpdate.changed || implementationUpdate.changed || updatedDisplays.length) emit({ type: "graph", nodeId, displayNodeIds: updatedDisplays, graph });
      emit({
        type: "node-done",
        nodeId,
        definitionId: defId,
        outputFiles: normalizedAgentOutput.outputFiles || [],
      });
      continue;
    }

    const isContextRunNode = isWorkspaceOneClickTaskDefinitionId(defId);
    const nodeModelKey = workspaceNodeModelKey(instance, modelKey);
    const prepareStartedAt = Date.now();
    const inputValues = workspaceInputValues(graph, nodeId, outputs, scopedRoot);
    const relevantInputs = workspaceRelevantInputValues(instance.body || "", inputValues);
    workspaceAssertRequiredInputs(instance.body || "", inputValues, nodeId);
    const upstreamText = workspaceTaskUpstreamText(graph, nodeId, outputs, relevantInputs.placeholders, scopedRoot);
    const contextBundle = workspaceNodeContextBundle(graph, nodeId, outputs, scopedRoot);
    const upstreamSkillBlocks = mergeWorkspaceSkillBlocks(
      workspaceUpstreamSkillBlocks(graph, nodeId, outputs),
      String(contextBundle.skillsContext || ""),
    );
    const ownSkillBlock = isContextRunNode ? loadSkillsBlockForKeys(selectedSkillKeysFromConfigSlots(instance)) : "";
    const promptSkillsBlock = mergeWorkspaceSkillBlocks(ownSkillBlock, upstreamSkillBlocks);
    const promptMcpBlock = mergeWorkspaceSkillBlocks(
      workspaceUpstreamMcpBlocks(graph, nodeId, outputs),
      String(contextBundle.mcpContext || ""),
    );
    const resultOutputSpec = workspaceResultOutputSpec(graph, nodeId);
    const runPackage = workspaceCreateNodeRunPackage(runTmpRoot, nodeId, {
      scopedRoot: runtimeStorageRoot,
      sourceRoot: scopedRoot,
      cwd,
      task: workspaceResolveBodyPlaceholders(instance.body || "", inputValues).trim() || upstreamText,
      inputValues: relevantInputs.values,
      skillsBlock: promptSkillsBlock,
      mcpBlock: promptMcpBlock,
      resultFile: resultOutputSpec.resultFile,
      outParamFiles: workspaceOutParamFileSpecs(graph, nodeId),
      durableOutputs: true,
    });
    const runtimeInputValues = { ...inputValues, ...(runPackage.inputValues || {}) };
    const body = workspaceResolveBodyPlaceholders(instance.body || "", runtimeInputValues).trim();
    const promptUpstreamText = workspacePromptUpstreamText(upstreamText, runPackage);
    if (defId === "agent_subAgent" && !body && !String(promptUpstreamText || "").trim()) {
      throw new Error(`Workspace node ${nodeId} has no task. Fill the node body or connect upstream text.`);
    }
    try {
      fs.writeFileSync(path.join(runPackage.nodeRunDir, "task.md"), String(body || promptUpstreamText || "").trimEnd() + "\n", "utf-8");
    } catch {
      // Best-effort debug artifact only.
    }
    const historyBlock = workspaceNodeHistoryBlock(nodeId, scopedRoot, runPackage);
    let workspaceContextBlock = workspaceNodeWorkspaceContextBlock(graph, nodeId, outputs, scopedRoot, cwd, contextBundle);
    if (!isContextRunNode && workspaceBoolSlot(instance, "includeWorkspaceContext", true)) {
      const defaultWorkspaceBlock = workspaceDefaultWorkspaceContextBlock(scopedRoot, cwd);
      if (!workspaceContextBlock) {
        workspaceContextBlock = defaultWorkspaceBlock;
      } else if (defaultWorkspaceBlock && !workspaceContextBlock.includes("## Workspace 上下文")) {
        workspaceContextBlock = [workspaceContextBlock, defaultWorkspaceBlock].filter(Boolean).join("\n\n");
      }
    }
    const prompt = workspaceNodePrompt(graph, nodeId, promptUpstreamText, promptSkillsBlock, promptMcpBlock, runtimeInputValues, runPackage, historyBlock, workspaceContextBlock);
    try {
      fs.writeFileSync(path.join(runPackage.nodeRunDir, "prompt.md"), prompt.trimEnd() + "\n", "utf-8");
    } catch {
      // Best-effort debug artifact only.
    }
    emitTiming(nodeId, "prepare-agent-prompt", prepareStartedAt, {
      promptChars: prompt.length,
      upstreamChars: String(upstreamText || "").length,
      skillsChars: promptSkillsBlock.length,
      mcpChars: promptMcpBlock.length,
      nodeRunDir: runPackage.nodeRunDir,
    });
    emit({ type: "natural", kind: "prompt", nodeId, text: prompt });
    emit({ type: "status", nodeId, line: `Model: ${nodeModelKey || "default"}` });
    let content = "";
    const runHistoryEvents = [];
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let attemptContent = "";
      try {
        const spawnStartedAt = Date.now();
        let firstAgentEventSeen = false;
        let attemptResultContent = "";
        let attemptLastAssistantContent = "";
        const handle = startComposerAgent({
          uiWorkspaceRoot: scopedRoot,
          cliWorkspace: runPackage.nodeRunDir,
          writableDirs: [runPackage.outputsDir],
          prompt,
          modelKey: nodeModelKey,
          agentflowUserId: userCtx.userId || "",
          detached: process.platform !== "win32",
          onChild: opts.onActiveChild,
          extraEnv: runtimeEnv({
            AGENTFLOW_WORKSPACE_TMP_ROOT: runTmpRoot,
            AGENTFLOW_NODE_RUN_DIR: runPackage.nodeRunDir,
            AGENTFLOW_NODE_TMP_DIR: runPackage.nodeTmpDir,
            AGENTFLOW_OUTPUTS_DIR: runPackage.outputsDir,
            AGENTFLOW_RESULT_FILE: runPackage.resultFileAbs,
            AGENTFLOW_OUTPUT_FILES_JSON: JSON.stringify(runPackage.outParamFiles || {}),
          }),
          onStreamEvent: (ev) => {
            if (!firstAgentEventSeen) {
              firstAgentEventSeen = true;
              emitTiming(nodeId, "agent-first-event", spawnStartedAt, { attempt, firstType: ev?.type || "" });
            }
            const eventToEmit = (ev?.type === "natural" && (ev.kind === "result" || ev.kind === "assistant") && typeof ev.text === "string")
              ? { ...ev, text: workspaceCanonicalAgentOutput(ev.text), nodeId }
              : { ...ev, nodeId };
            emit(eventToEmit);
            if (ev?.type === "natural" && typeof ev.text === "string") {
              const kind = String(ev.kind || "");
              if (kind === "thinking" || kind === "assistant" || kind === "result") {
                runHistoryEvents.push({ kind, text: ev.text });
              }
            }
            if (ev?.type === "natural" && ev.kind === "assistant" && typeof ev.text === "string") {
              attemptLastAssistantContent = ev.text;
              attemptContent += (attemptContent ? "\n" : "") + ev.text;
            } else if (ev?.type === "natural" && ev.kind === "result" && typeof ev.text === "string") {
              attemptResultContent = ev.text;
            }
          },
          onToolCall: (subtype, toolName) => {
            const sub = subtype ? String(subtype) : "";
            const tool = toolName ? String(toolName) : "";
            emit({ type: "status", nodeId, line: `工具 ${tool || "thinking"}${sub ? ` (${sub})` : ""}` });
          },
        });
        emitTiming(nodeId, "spawn-agent", spawnStartedAt, { attempt });
        try {
          await handle.finished;
        } finally {
          if (typeof opts.onActiveChild === "function") opts.onActiveChild(null);
        }
        throwIfAborted();
        const resultStructured = attemptResultContent ? workspaceStructuredAgentOutput(attemptResultContent) : null;
        const assistantStructured = attemptLastAssistantContent ? workspaceStructuredAgentOutput(attemptLastAssistantContent) : null;
        if (resultStructured?.structured) content = workspaceCanonicalAgentOutput(attemptResultContent);
        else if (assistantStructured?.structured) content = workspaceCanonicalAgentOutput(attemptLastAssistantContent);
        else content = workspaceCanonicalAgentOutput(attemptLastAssistantContent || attemptContent);
        break;
      } catch (e) {
        if (signal?.aborted || e?.code === "WORKSPACE_RUN_ABORTED") throwIfAborted();
        if (attempt < maxAttempts && isTransientAgentNetworkError(e)) {
          emit({ type: "status", nodeId, line: `Workspace node retry ${attempt + 1}/${maxAttempts} after network error` });
          await sleepMs(Math.min(1500 * attempt, 5000), signal);
          continue;
        }
        throw e;
      }
    }
    const materializedAgentOutput = workspaceMaterializeAgentResultFile(workspaceStructuredAgentOutput(content), runPackage);
    const normalizedAgentOutput = workspacePublishAgentOutputFiles(materializedAgentOutput, runPackage);
    const resultContent = normalizedAgentOutput.result || content;
    recordNodeOutput(nodeId, resultContent);
    const slotUpdate = workspaceApplyAgentOutputSlots(instance, normalizedAgentOutput);
    if (slotUpdate.changed) graph.instances[nodeId] = slotUpdate.instance;
    const implementationUpdate = await workspaceTryPersistNodeImplementation(scopedRoot, graph, nodeId, {
      inputValues: runtimeInputValues,
      resultContent,
      structured: normalizedAgentOutput,
      runPackage,
      modelKey: nodeModelKey,
      userCtx,
      historyEvents: runHistoryEvents,
      emit: (event) => emit({ ...event, nodeId }),
      onActiveChild: opts.onActiveChild,
    });
    if (implementationUpdate.changed) graph.instances[nodeId] = implementationUpdate.instance;
    let contextRunOutputChanged = false;
    if (isContextRunNode) {
      graph.instances[nodeId] = workspaceSetOutputSlot(graph.instances[nodeId] || instance, "displayType", workspaceContextRunDisplayKind(instance));
      contextRunOutputChanged = true;
    }
    const updatedDisplays = propagateNodeOutputDisplays(nodeId, resultContent);
    if (slotUpdate.changed || implementationUpdate.changed || contextRunOutputChanged || updatedDisplays.length) emit({ type: "graph", nodeId, displayNodeIds: updatedDisplays, graph });
    emit({
      type: "node-done",
      nodeId,
      definitionId: defId,
      outputFiles: normalizedAgentOutput.outputFiles || [],
    });
  }
  } catch (error) {
    runFailure = error;
    throw error;
  } finally {
    const retainForResume = Boolean(deferred || runtimePauseNodeIds.length);
    const trackedWorktrees = autoCleanupWorktrees.map((entry) => ({ ...entry }));
    let cleanup = { cleaned: [], preserved: [] };
    if (retainForResume) {
      emit({
        type: "status",
        line: `Run workspace retained for resume${trackedWorktrees.length ? ` (${trackedWorktrees.length} worktree)` : ""}`,
        runId: runtimeRunId,
      });
      persistRunManifest("waiting", {
        worktrees: trackedWorktrees.map((entry) => ({ ...entry, removed: false })),
        waitingAt: new Date().toISOString(),
      });
      autoCleanupWorktrees.splice(0, autoCleanupWorktrees.length);
    } else {
      cleanup = workspaceCleanupAutoWorktrees(autoCleanupWorktrees, graph, emit, { force: false });
      const cleanedSet = new Set(cleanup.cleaned.map((item) => path.resolve(item)));
      const preservedByPath = new Map(cleanup.preserved.map((item) => [path.resolve(item.worktreePath), item]));
      persistRunManifest(runFailure ? "failed" : "completed", {
        worktrees: trackedWorktrees.map((entry) => {
          const target = path.resolve(entry.worktreePath);
          if (cleanedSet.has(target)) return { ...entry, removed: true, removedAt: new Date().toISOString(), reason: "" };
          if (preservedByPath.has(target)) return { ...entry, removed: false, reason: preservedByPath.get(target).reason };
          return entry;
        }),
        finishedAt: new Date().toISOString(),
        error: runFailure ? (runFailure?.message || String(runFailure)) : "",
        resourcesPreserved: cleanup.preserved.length > 0,
      });
    }
    const protectedWorktrees = retainForResume ? trackedWorktrees : cleanup.preserved;
    const protectsRunTmpRoot = protectedWorktrees.some((entry) => workspacePathInside(runTmpRoot, entry.worktreePath));
    if (protectsRunTmpRoot) {
      emit({ type: "status", line: `Workspace tmp kept because it contains a retained worktree: ${runTmpRoot}` });
    } else {
      workspaceCleanupTmpRoot(runTmpRoot, userCtx, emit);
    }
  }
  const finalPauseNodeIds = Array.from(new Set([...pauseNodeIds, ...runtimePauseNodeIds]));
  if (!deferred && finalPauseNodeIds.length > 0) {
    emit({ type: "paused", nodeIds: finalPauseNodeIds, message: `Workspace run paused at ${finalPauseNodeIds.join(", ")}` });
  }
  graph.updatedAt = new Date().toISOString();
  return { graph, events, order, pauseNodeIds: finalPauseNodeIds, deferred };
}

export function isWorkspaceRunAbortError(err) {
  return err?.code === "WORKSPACE_RUN_ABORTED" || /Workspace run stopped/i.test(String(err?.message || ""));
}

export function isTransientAgentNetworkError(err) {
  const text = [
    err?.message,
    err?.cursorStderrTail,
    err?.stderr,
    err?.stack,
  ].filter(Boolean).join("\n");
  return /Client network socket disconnected before secure TLS connection was established/i.test(text) ||
    /secure TLS connection was established/i.test(text) ||
    /\bECONNRESET\b/i.test(text) ||
    /\bETIMEDOUT\b/i.test(text) ||
    /\bEAI_AGAIN\b/i.test(text) ||
    /network socket disconnected/i.test(text) ||
    /socket hang up/i.test(text);
}

export function sleepMs(ms, signal = null) {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener("abort", () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    }
  });
}

/** GET 读 flow / nodes / SSE 等 */
export function isValidFlowSourceRead(s) {
  return s === "builtin" || s === "admin" || s === "user" || s === "workspace";
}

export function isReadonlyBuiltinFlowSource(s) {
  return s === "builtin" || s === "admin";
}

/** 正在执行的 Workspace 临时 run（runId/sessionId → { controller, child, runNodeId, startedAt, plannedNodeIds }） */
export const activeWorkspaceRuns = new Map();

export const workspaceCollaborationSubscribers = new Map();

export const workspaceCollaborationSequences = new Map();

function emitWorkspaceCollaborationEvent(userCtx, flowSource, flowId, archived, event = {}) {
  const key = workspaceCollaborationEventKey(userCtx, flowSource, flowId, archived);
  const seq = (workspaceCollaborationSequences.get(key) || 0) + 1;
  workspaceCollaborationSequences.set(key, seq);
  const payload = JSON.stringify({ seq, at: new Date().toISOString(), ...event });
  const subscribers = workspaceCollaborationSubscribers.get(key);
  if (!subscribers?.size) return seq;
  const chunk = `id: ${seq}\ndata: ${payload}\n\n`;
  for (const clientRes of subscribers) {
    try { clientRes.write(chunk); } catch (_) {}
  }
  return seq;
}

const WORKSPACE_SCHEDULES_FILENAME = "workspace-schedules.json";

const WORKSPACE_DEFERRED_RUNS_FILENAME = "workspace-deferred-runs.json";

export const WORKSPACE_SCHEDULE_POLL_MS = 30_000;

export const WORKSPACE_DEFERRED_RUN_POLL_MS = 1_000;

const WORKSPACE_DEFERRED_LEASE_MS = 60_000;

const workspaceDeferredLeaseOwner = `${process.pid}-${crypto.randomBytes(8).toString("hex")}`;

const activeWorkspaceDeferredRuns = new Set();

const WORKSPACE_IMPLEMENTATION_REFERENCE_ENABLED = true;

const WORKSPACE_IMPLEMENTATION_SUMMARY_ENABLED = false;

const WORKSPACE_NODE_HISTORY_MAX_CHARS = 80000;

function workspaceIntervalMinutesToCron(intervalMinutes) {
  const n = Number(intervalMinutes);
  if (!Number.isFinite(n) || n <= 0) return "0 9 * * *";
  const minutes = Math.max(1, Math.min(1440, Math.round(n)));
  if (minutes < 60) return `*/${minutes} * * * *`;
  if (minutes === 60) return "0 * * * *";
  if (minutes < 1440 && minutes % 60 === 0) return `0 */${minutes / 60} * * *`;
  return "0 9 * * *";
}

export function workspaceRunKey(userCtx, flowSource, flowId) {
  const source = flowSource || "user";
  const collaboration = listWorkspaceCollaborationsForUser(userCtx?.userId).find((record) => (
    record.flowId === flowId
    && record.archived !== true
    && (record.projectSource || record.flowSource || "workspace") === source
  ));
  if (collaboration?.id) return `shared:${collaboration.id}`;
  const actorScope = source === "workspace" ? "shared" : userCtx?.userId || "";
  return `${actorScope}:${source}:${flowId}`;
}

export function workspaceCollaborationEventKey(userCtx, flowSource, flowId, archived = false) {
  const source = flowSource || "user";
  const collaboration = listWorkspaceCollaborationsForUser(userCtx?.userId).find((record) => (
    record.flowId === flowId
    && record.archived === (archived === true)
    && (record.projectSource || record.flowSource || "workspace") === source
  ));
  if (collaboration?.id) return `shared:${collaboration.id}:${archived ? "1" : "0"}`;
  const actorScope = source === "workspace" ? "shared" : userCtx?.userId || "";
  return `${actorScope}:${source}:${flowId}:${archived ? "1" : "0"}`;
}

export function workspaceRunEntryKey(scopeKey, runId) {
  return `${scopeKey}:${String(runId || "").trim() || runLedgerId("workspace")}`;
}

export function workspaceRunControl(abortController) {
  return createWorkspaceRunController({
    abortController,
    gracefulTimeoutMs: 3_000,
    forceTimeoutMs: 1_500,
  });
}

export function workspaceRuntimeNodeLabel(graph, nodeId, fallback = "Workspace Run") {
  const id = String(nodeId || "").trim();
  const instance = graph?.instances && typeof graph.instances === "object" ? graph.instances[id] : null;
  const label = String(instance?.label || "").trim();
  return label || id || fallback;
}

export function workspaceActiveRunsForScope(scopeKey) {
  const key = String(scopeKey || "");
  return Array.from(activeWorkspaceRuns.entries())
    .filter(([, entry]) => String(entry?.scopeKey || "") === key);
}

function workspaceDeferredRunsPath() {
  return path.join(getAgentflowDataRoot(), WORKSPACE_DEFERRED_RUNS_FILENAME);
}

export function readWorkspaceDeferredRunRegistry() {
  const filePath = workspaceDeferredRunsPath();
  if (!fs.existsSync(filePath)) return { version: 1, runs: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return {
      version: 1,
      runs: parsed?.runs && typeof parsed.runs === "object" && !Array.isArray(parsed.runs)
        ? parsed.runs
        : {},
    };
  } catch {
    return { version: 1, runs: {} };
  }
}

function writeWorkspaceDeferredRunRegistry(registry) {
  const filePath = workspaceDeferredRunsPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    runs: registry?.runs && typeof registry.runs === "object" ? registry.runs : {},
  }, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  fs.renameSync(tempPath, filePath);
}

function workspaceDeferredRunKey(meta = {}, deferred = {}) {
  return crypto.createHash("sha256").update([
    String(meta.scopeKey || ""),
    String(meta.runId || ""),
    String(deferred.nodeId || meta.nodeId || ""),
  ].join("\n")).digest("hex").slice(0, 32);
}

export function upsertWorkspaceDeferredRun(meta = {}, deferred = {}) {
  const registry = readWorkspaceDeferredRunRegistry();
  const key = String(meta.deferredKey || "").trim() || workspaceDeferredRunKey(meta, deferred);
  const previous = registry.runs?.[key] && typeof registry.runs[key] === "object" ? registry.runs[key] : {};
  const now = Date.now();
  const next = {
    ...previous,
    key,
    kind: String(deferred.kind || previous.kind || "jenkins"),
    status: "waiting",
    scopeKey: String(meta.scopeKey || previous.scopeKey || ""),
    runId: String(meta.runId || previous.runId || ""),
    userId: String(meta.userId || previous.userId || ""),
    username: String(meta.username || previous.username || meta.userId || ""),
    flowId: String(meta.flowId || previous.flowId || ""),
    flowSource: String(meta.flowSource || previous.flowSource || "user"),
    archived: meta.archived === true || previous.archived === true,
    runNodeId: String(meta.runNodeId || previous.runNodeId || ""),
    nodeId: String(deferred.nodeId || meta.nodeId || previous.nodeId || ""),
    label: String(meta.label || previous.label || "Workspace Run"),
    plannedNodeIds: Array.isArray(meta.plannedNodeIds) ? meta.plannedNodeIds.map(String) : (previous.plannedNodeIds || []),
    workspaceRoot: String(meta.workspaceRoot || previous.workspaceRoot || ""),
    executionRoot: String(meta.executionRoot || previous.executionRoot || ""),
    releaseId: String(meta.releaseId || previous.releaseId || ""),
    designRevision: String(meta.designRevision || previous.designRevision || ""),
    marketplaceResources: Array.isArray(meta.marketplaceResources)
      ? meta.marketplaceResources.map((item) => ({
          kind: String(item?.kind || ""),
          id: String(item?.id || ""),
          version: String(item?.version || ""),
        })).filter((item) => item.kind && item.id && item.version)
      : (previous.marketplaceResources || []),
    startedAt: Number(meta.startedAt || previous.startedAt || now),
    scheduled: meta.scheduled === true || previous.scheduled === true,
    scheduleKey: String(meta.scheduleKey || previous.scheduleKey || ""),
    scheduleNodeId: String(meta.scheduleNodeId || previous.scheduleNodeId || ""),
    wakeAt: String(deferred.wakeAt || previous.wakeAt || new Date(now + WORKSPACE_DEFERRED_RUN_POLL_MS).toISOString()),
    phase: String(deferred.phase || previous.phase || ""),
    jenkinsStatus: String(deferred.status || previous.jenkinsStatus || ""),
    message: String(deferred.message || previous.message || ""),
    buildNumber: String(deferred.buildNumber || previous.buildNumber || ""),
    url: String(deferred.url || previous.url || ""),
    qrUrl: String(deferred.qrUrl || previous.qrUrl || ""),
    createdAt: String(previous.createdAt || new Date(now).toISOString()),
    updatedAt: new Date(now).toISOString(),
    leaseOwner: "",
    leaseUntil: 0,
  };
  registry.runs[key] = next;
  writeWorkspaceDeferredRunRegistry(registry);
  return next;
}

export function removeWorkspaceDeferredRun(key) {
  const id = String(key || "").trim();
  if (!id) return null;
  const registry = readWorkspaceDeferredRunRegistry();
  const current = registry.runs?.[id] || null;
  if (!current) return null;
  delete registry.runs[id];
  writeWorkspaceDeferredRunRegistry(registry);
  return current;
}

export function workspaceDeferredRunsForScope(scopeKey) {
  const key = String(scopeKey || "");
  return Object.values(readWorkspaceDeferredRunRegistry().runs || {})
    .filter((entry) => String(entry?.scopeKey || "") === key);
}

function claimWorkspaceDeferredRun(key, now = Date.now()) {
  const registry = readWorkspaceDeferredRunRegistry();
  const entry = registry.runs?.[key];
  if (!entry) return null;
  const leaseUntil = Number(entry.leaseUntil || 0);
  if (leaseUntil > now && String(entry.leaseOwner || "") !== workspaceDeferredLeaseOwner) return null;
  const claimed = {
    ...entry,
    status: "polling",
    leaseOwner: workspaceDeferredLeaseOwner,
    leaseUntil: now + WORKSPACE_DEFERRED_LEASE_MS,
    updatedAt: new Date(now).toISOString(),
  };
  registry.runs[key] = claimed;
  writeWorkspaceDeferredRunRegistry(registry);
  return claimed;
}

export function workspaceRunPlanNodeIds(runNodeId, plan) {
  return Array.from(new Set([
    String(runNodeId || "").trim(),
    ...(Array.isArray(plan?.order) ? plan.order : []),
    ...(Array.isArray(plan?.pauseNodeIds) ? plan.pauseNodeIds : []),
  ].map((id) => String(id || "").trim()).filter(Boolean)));
}

export function workspaceFindActiveRunConflict(scopeKey, plannedNodeIds) {
  const planned = new Set((plannedNodeIds || []).map((id) => String(id || "").trim()).filter(Boolean));
  for (const [key, entry] of workspaceActiveRunsForScope(scopeKey)) {
    const activeIds = Array.isArray(entry?.plannedNodeIds) ? entry.plannedNodeIds : [];
    if (!activeIds.length) {
      return { key, entry, conflictNodeIds: [] };
    }
    const conflictNodeIds = activeIds
      .map((id) => String(id || "").trim())
      .filter((id) => id && planned.has(id));
    if (conflictNodeIds.length) return { key, entry, conflictNodeIds };
  }
  for (const entry of workspaceDeferredRunsForScope(scopeKey)) {
    const waitingIds = Array.isArray(entry?.plannedNodeIds) ? entry.plannedNodeIds : [];
    if (!waitingIds.length) return { key: entry.key, entry, conflictNodeIds: [] };
    const conflictNodeIds = waitingIds
      .map((id) => String(id || "").trim())
      .filter((id) => id && planned.has(id));
    if (conflictNodeIds.length) return { key: entry.key, entry, conflictNodeIds };
  }
  return null;
}

export function normalizeWorkspaceScheduledRunConfig(raw) {
  let parsed = {};
  const text = String(raw || "").trim();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = {};
    }
  }
  const intervalMinutes = Number(parsed.intervalMinutes);
  const migratedCron = workspaceIntervalMinutesToCron(intervalMinutes);
  const cron = typeof parsed.cron === "string" && parsed.cron.trim()
    ? parsed.cron.trim()
    : migratedCron;
  const timezone = typeof parsed.timezone === "string" && parsed.timezone.trim()
    ? parsed.timezone.trim()
    : "Asia/Shanghai";
  const targetRunNodeId = typeof parsed.targetRunNodeId === "string" ? parsed.targetRunNodeId.trim() : "";
  const overlapPolicy = parsed.overlapPolicy === "skip" ? "skip" : "skip";
  return {
    enabled: parsed.enabled === true,
    cron,
    timezone,
    targetRunNodeId,
    overlapPolicy,
  };
}

export function workspaceScheduleNextRunAt(config, fromDate = new Date()) {
  if (!config?.enabled || !config?.cron) return null;
  return Date.parse(computeNextRunAt(config.cron, config.timezone || "Asia/Shanghai", fromDate));
}

function workspaceSchedulesPath() {
  return path.join(getAgentflowDataRoot(), WORKSPACE_SCHEDULES_FILENAME);
}

export function readWorkspaceScheduleRegistry() {
  const filePath = workspaceSchedulesPath();
  if (!fs.existsSync(filePath)) return { version: 1, schedules: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return {
      version: 1,
      schedules: parsed?.schedules && typeof parsed.schedules === "object" && !Array.isArray(parsed.schedules)
        ? parsed.schedules
        : {},
    };
  } catch {
    return { version: 1, schedules: {} };
  }
}

function writeWorkspaceScheduleRegistry(registry) {
  const filePath = workspaceSchedulesPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    version: 1,
    updatedAt: new Date().toISOString(),
    schedules: registry?.schedules && typeof registry.schedules === "object" ? registry.schedules : {},
  }, null, 2) + "\n", "utf-8");
}

function workspaceScheduleKey(userId, flowSource, flowId, scheduleNodeId) {
  return [
    String(userId || ""),
    String(flowSource || "user"),
    String(flowId || ""),
    String(scheduleNodeId || ""),
  ].join(":");
}

function workspaceScheduleOwnerUserId(userCtx = {}, flowSource = "user", flowId = "") {
  const collaboration = listWorkspaceCollaborationsForUser(userCtx.userId).find((record) => (
    record.flowId === flowId
    && record.archived !== true
    && (record.projectSource || record.flowSource || "workspace") === flowSource
  ));
  if (collaboration?.ownerId) return String(collaboration.ownerId);
  return String(userCtx.userId || "");
}

export function listWorkspaceScheduleStatusesForFlow(userCtx = {}, flowSource = "user", flowId = "") {
  const registry = readWorkspaceScheduleRegistry();
  const userId = workspaceScheduleOwnerUserId(userCtx, flowSource, flowId);
  return Object.values(registry.schedules || {})
    .filter((entry) => (
      String(entry?.userId || "") === userId &&
      String(entry?.flowSource || "user") === String(flowSource || "user") &&
      String(entry?.flowId || "") === String(flowId || "")
    ))
    .sort((a, b) => String(a.scheduleNodeId || a.runNodeId || "").localeCompare(String(b.scheduleNodeId || b.runNodeId || "")));
}

export function listWorkspaceScheduleStatuses(root, userCtx = {}) {
  const registry = readWorkspaceScheduleRegistry();
  const flows = listFlowsJson(root, { ...userCtx, includeWorkspaceFlows: true })
    .filter((flow) => !flow.archived && !isReadonlyBuiltinFlowSource(flow.source || "user"));
  const rows = [];
  for (const flow of flows) {
    const flowId = String(flow.id || "");
    const flowSource = String(flow.source || "user");
    const scheduleUserId = workspaceScheduleOwnerUserId(userCtx, flowSource, flowId);
    const scoped = resolveWorkspaceScopeRoot(root, { flowId, flowSource }, userCtx);
    if (scoped.error || !scoped.root) continue;
    let graph;
    try {
      graph = readWorkspaceStableRelease(scoped.root, root)?.graph
        || readWorkspaceGraph(scoped.root, root).graph;
    } catch {
      continue;
    }
    const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
    for (const [scheduleNodeId, instance] of Object.entries(instances)) {
      if (String(instance?.definitionId || "") !== "workspace_scheduled_run") continue;
      const config = normalizeWorkspaceScheduledRunConfig(instance.body || "");
      const key = workspaceScheduleKey(scheduleUserId, flowSource, flowId, scheduleNodeId);
      const current = registry.schedules?.[key] && typeof registry.schedules[key] === "object" ? registry.schedules[key] : {};
      const targetRunNodeId = workspaceScheduleInferTargetRunNodeId(graph, scheduleNodeId, config);
      const scopeKey = workspaceRunKey(userCtx, flowSource, flowId);
      const running = workspaceActiveRunsForScope(scopeKey).some(([, active]) => (
        active?.scheduled === true &&
        String(active?.runNodeId || "") === String(targetRunNodeId || scheduleNodeId)
      ));
      let nextRunAt = current.nextRunAt || null;
      let lastStatus = current.lastStatus || (config.enabled ? "armed" : "disabled");
      let lastError = current.lastError || "";
      if (config.enabled && !nextRunAt) {
        try {
          nextRunAt = workspaceScheduleNextRunAt(config, new Date());
        } catch (e) {
          lastStatus = "invalid";
          lastError = (e && e.message) || String(e);
        }
      }
      rows.push({
        kind: "workspace",
        key,
        registered: Boolean(registry.schedules?.[key]),
        ownerUserId: scheduleUserId,
        ownerUsername: String(current.username || scheduleUserId),
        flowId,
        flowSource,
        workspaceId: String(flow.collaboration?.id || scoped.workspaceId || ""),
        scheduleNodeId,
        runNodeId: targetRunNodeId,
        label: String(instance.label || "Scheduled Run"),
        enabled: config.enabled,
        cron: config.cron,
        timezone: config.timezone,
        preset: "",
        nextRunAt,
        lastTriggeredAt: current.lastTriggeredAt || null,
        lastFinishedAt: current.lastFinishedAt || null,
        lastRunId: current.lastRunId || "",
        lastStatus,
        lastError,
        running,
        waiting: 0,
      });
    }
  }
  rows.sort((a, b) => {
    const ea = a.enabled ? 0 : 1;
    const eb = b.enabled ? 0 : 1;
    return ea - eb || String(a.nextRunAt || "").localeCompare(String(b.nextRunAt || "")) || a.flowId.localeCompare(b.flowId);
  });
  return rows;
}

function workspaceScheduleInferTargetRunNodeId(graph, scheduleNodeId, config = {}) {
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  return String(instances[scheduleNodeId]?.definitionId || "") === "workspace_scheduled_run"
    ? String(scheduleNodeId || "")
    : "";
}

export function syncWorkspaceSchedulesForGraph(root, scoped, graph, authUser, userCtx = {}) {
  const flowId = String(scoped?.flowId || "").trim();
  const flowSource = String(scoped?.flowSource || "user");
  const userId = workspaceScheduleOwnerUserId(
    { userId: userCtx.userId || authUser?.userId || "" },
    flowSource,
    flowId,
  );
  if (!flowId || !userId) return [];
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const registry = readWorkspaceScheduleRegistry();
  const schedules = { ...(registry.schedules || {}) };
  const prefix = `${userId}:${flowSource}:${flowId}:`;
  for (const [key, entry] of Object.entries(schedules)) {
    const sameSharedFlow = (
      flowSource === "workspace"
      && scoped?.collaboration
      && String(entry?.flowSource || "") === flowSource
      && String(entry?.flowId || "") === flowId
    );
    if (sameSharedFlow || key.startsWith(prefix)) delete schedules[key];
  }
  if (isWorkspaceDraftDir(scoped?.root || "")) {
    writeWorkspaceScheduleRegistry({ version: 1, schedules });
    return [];
  }
  const effectiveGraph = readWorkspaceStableRelease(scoped?.root || "", root)?.graph || graph;
  const instances = effectiveGraph?.instances && typeof effectiveGraph.instances === "object" ? effectiveGraph.instances : {};
  for (const [scheduleNodeId, instance] of Object.entries(instances)) {
    if (String(instance?.definitionId || "") !== "workspace_scheduled_run") continue;
    const config = normalizeWorkspaceScheduledRunConfig(instance.body || "");
    const targetRunNodeId = workspaceScheduleInferTargetRunNodeId(effectiveGraph, scheduleNodeId, config);
    const key = workspaceScheduleKey(userId, flowSource, flowId, scheduleNodeId);
    const previous = registry.schedules?.[key] && typeof registry.schedules[key] === "object" ? registry.schedules[key] : {};
    const previousNext = Number(previous.nextRunAt || 0);
    const previousMatches = (
      String(previous.cron || "") === config.cron &&
      String(previous.timezone || "") === config.timezone &&
      String(previous.targetRunNodeId || previous.runNodeId || "") === targetRunNodeId
    );
    let nextRunAt = null;
    let lastStatus = previous.lastStatus || "armed";
    let lastError = previous.lastError || "";
    try {
      nextRunAt = !config.enabled
        ? null
        : previousMatches && Number.isFinite(previousNext) && previousNext > now
        ? previousNext
        : workspaceScheduleNextRunAt(config, new Date(now));
      if (!config.enabled) {
        lastStatus = "disabled";
        lastError = "";
      }
      if (!targetRunNodeId) {
        lastStatus = "invalid";
        lastError = "Scheduled Run node is missing";
      }
    } catch (e) {
      lastStatus = "invalid";
      lastError = (e && e.message) || String(e);
      nextRunAt = null;
    }
    schedules[key] = {
      ...previous,
      key,
      enabled: config.enabled,
      userId,
      username: String(authUser?.username || previous.username || userId),
      flowId,
      flowSource,
      scheduleNodeId,
      runNodeId: targetRunNodeId,
      targetRunNodeId,
      label: String(instance.label || "Scheduled Run"),
      cron: config.cron,
      timezone: config.timezone,
      overlapPolicy: config.overlapPolicy,
      nextRunAt,
      lastStatus,
      lastError,
      updatedAt: nowIso,
    };
  }
  const nextRegistry = { version: 1, schedules };
  writeWorkspaceScheduleRegistry(nextRegistry);
  return listWorkspaceScheduleStatusesForFlow(userCtx, flowSource, flowId);
}

export function updateWorkspaceScheduleEntry(key, patch) {
  const registry = readWorkspaceScheduleRegistry();
  const current = registry.schedules?.[key];
  if (!current) return null;
  const next = {
    ...current,
    ...(patch && typeof patch === "object" ? patch : {}),
    updatedAt: new Date().toISOString(),
  };
  registry.schedules[key] = next;
  writeWorkspaceScheduleRegistry(registry);
  return next;
}

export async function runWorkspaceScheduledEntry(root, entry) {
  const userCtx = { userId: String(entry.userId || "") };
  const scopeKey = workspaceRunKey(userCtx, entry.flowSource || "user", entry.flowId || "");
  const authUsers = readAuthUsers();
  const authUser = authUsers[userCtx.userId] || {};
  const runId = runLedgerId("workspace");
  const runLog = createWorkspaceRunLogSession({
    runId,
    userId: userCtx.userId,
    username: String(authUser.username || entry.username || userCtx.userId),
    flowId: String(entry.flowId || ""),
    flowSource: String(entry.flowSource || "user"),
    scheduleNodeId: String(entry.scheduleNodeId || entry.key?.split(":").pop() || ""),
    runNodeId: String(entry.targetRunNodeId || entry.runNodeId || ""),
    scheduled: true,
    trigger: "scheduled",
    label: String(entry.label || "Scheduled Run"),
  });
  const fallbackConfig = {
    enabled: true,
    cron: String(entry.cron || "0 9 * * *"),
    timezone: String(entry.timezone || "Asia/Shanghai"),
    targetRunNodeId: String(entry.targetRunNodeId || entry.runNodeId || ""),
    overlapPolicy: "skip",
  };
  const computeNext = (config = fallbackConfig) => {
    try {
      return workspaceScheduleNextRunAt(config, new Date());
    } catch {
      return null;
    }
  };
  let nextRunAt = computeNext(fallbackConfig);
  const scoped = resolveWorkspaceScopeRoot(root, {
    flowId: entry.flowId || "",
    flowSource: entry.flowSource || "user",
  }, userCtx);
  if (scoped.error || scoped.archived || isReadonlyBuiltinFlowSource(scoped.flowSource)) {
    const error = scoped.error || "Workspace schedule target is not writable";
    appendWorkspaceRunLogEvent(runLog.runId, { type: "error", error });
    finishWorkspaceRunLogSession(runLog.runId, "failed", { error });
    updateWorkspaceScheduleEntry(entry.key, {
      nextRunAt,
      lastStatus: "error",
      lastRunId: runLog.runId,
      lastError: error,
      lastErrorAt: Date.now(),
    });
    return;
  }
  const stableRelease = readWorkspaceStableRelease(scoped.root, root);
  const executionRoot = stableRelease?.root || scoped.root;
  const executionScoped = stableRelease ? { ...scoped, root: executionRoot } : scoped;
  const graph = hydrateWorkspaceGraphForRuntime(
    root,
    executionScoped,
    stableRelease?.graph || readWorkspaceGraph(scoped.root, root).graph,
    userCtx,
  );
  const scheduleNodeId = String(entry.scheduleNodeId || entry.key?.split(":").pop() || "");
  const instance = graph.instances?.[scheduleNodeId];
  const config = normalizeWorkspaceScheduledRunConfig(instance?.body || "");
  nextRunAt = computeNext(config);
  if (!instance || String(instance.definitionId || "") !== "workspace_scheduled_run" || !config.enabled) {
    appendWorkspaceRunLogEvent(runLog.runId, { type: "disabled", scheduleNodeId });
    finishWorkspaceRunLogSession(runLog.runId, "disabled");
    updateWorkspaceScheduleEntry(entry.key, {
      enabled: false,
      nextRunAt: null,
      lastStatus: "disabled",
      lastRunId: runLog.runId,
    });
    return;
  }
  const targetRunNodeId = workspaceScheduleInferTargetRunNodeId(graph, scheduleNodeId, config);
  const scheduleAlias = workspaceRuntimeNodeLabel(graph, scheduleNodeId, String(entry.label || "Scheduled Run"));
  if (!targetRunNodeId) {
    const error = "Scheduled Run node is missing";
    appendWorkspaceRunLogEvent(runLog.runId, { type: "invalid", error, scheduleNodeId });
    finishWorkspaceRunLogSession(runLog.runId, "failed", { error });
    updateWorkspaceScheduleEntry(entry.key, {
      nextRunAt,
      lastStatus: "invalid",
      lastRunId: runLog.runId,
      lastError: error,
      lastErrorAt: Date.now(),
    });
    return;
  }
  appendWorkspaceRunLogEvent(runLog.runId, { type: "scheduler-triggered", scheduleNodeId, runNodeId: targetRunNodeId, cron: config.cron, timezone: config.timezone });
  let plan;
  try {
    plan = workspaceRunPlan(graph, targetRunNodeId, executionRoot);
  } catch (e) {
    const error = (e && e.message) || String(e);
    appendWorkspaceRunLogEvent(runLog.runId, { type: "error", error });
    finishWorkspaceRunLogSession(runLog.runId, "failed", { error, runNodeId: targetRunNodeId });
    updateWorkspaceScheduleEntry(entry.key, {
      nextRunAt,
      lastStatus: "failed",
      lastRunId: runLog.runId,
      lastError: error,
      lastErrorAt: Date.now(),
    });
    return;
  }
  const plannedNodeIds = workspaceRunPlanNodeIds(targetRunNodeId, plan);
  const conflict = workspaceFindActiveRunConflict(scopeKey, plannedNodeIds);
  if (conflict) {
    appendWorkspaceRunLogEvent(runLog.runId, {
      type: "skipped",
      reason: "busy",
      runNodeId: targetRunNodeId,
      conflictRunId: conflict.entry?.runId || "",
      conflictNodeIds: conflict.conflictNodeIds,
    });
    finishWorkspaceRunLogSession(runLog.runId, "skipped", { runNodeId: targetRunNodeId, error: "" });
    updateWorkspaceScheduleEntry(entry.key, {
      nextRunAt,
      lastSkippedAt: Date.now(),
      lastStatus: "skipped: busy",
      lastRunId: runLog.runId,
      lastError: "",
    });
    return;
  }

  const controller = new AbortController();
  const runControl = workspaceRunControl(controller);
  const runKey = workspaceRunEntryKey(scopeKey, runId);
  const runEntry = {
    scopeKey,
    controller,
    runControl,
    runId,
    userId: userCtx.userId,
    username: String(authUser.username || entry.username || userCtx.userId),
    runNodeId: targetRunNodeId,
    flowId: String(entry.flowId || ""),
    flowSource: String(entry.flowSource || "user"),
    label: scheduleAlias,
    plannedNodeIds,
    startedAt: Date.now(),
    scheduled: true,
    workspaceRoot: root,
    executionRoot,
    releaseId: stableRelease?.release?.id || "",
    designRevision: stableRelease?.release?.designRevision || workspaceDesignRevision(graph),
    marketplaceResources: marketplaceResourcesForRun(executionRoot, graph, plannedNodeIds),
  };
  appendWorkspaceRunLogEvent(runLog.runId, {
    type: "release-resolved",
    releaseId: runEntry.releaseId || "legacy-current",
    revision: runEntry.designRevision,
    source: stableRelease ? "stable" : "legacy-current",
  });
  activeWorkspaceRuns.set(runKey, runEntry);
  appendWorkspaceRunStarted(runEntry);
  updateWorkspaceScheduleEntry(entry.key, {
    lastStatus: "running",
    lastTriggeredAt: runEntry.startedAt,
    lastRunId: runEntry.runId,
    runNodeId: targetRunNodeId,
    targetRunNodeId,
    cron: config.cron,
    timezone: config.timezone,
    lastError: "",
  });
  const setActiveChild = (child, childOptions = {}) => {
    runControl.setChild(child, childOptions);
  };
  try {
    const result = await runWorkspaceGraph(root, executionRoot, {
      flowId: entry.flowId,
      flowSource: entry.flowSource || "user",
      runNodeId: targetRunNodeId,
      graph,
    }, userCtx, {
      runtimeRoot: scoped.root,
      signal: controller.signal,
      onActiveChild: setActiveChild,
      onEvent: (event) => appendWorkspaceRunLogEvent(runLog.runId, event),
      runId,
    });
    const currentGraph = readWorkspaceGraph(scoped.root, root).graph;
    const touchedIds = workspaceRunTouchedNodeIds(result);
    if (stableRelease?.release?.id) {
      writeWorkspaceReleaseRuntimeState(scoped.root, stableRelease.release.id, result.graph);
    }
    const mergedGraph = stableRelease
      ? mergeWorkspaceRunState(currentGraph, result.graph, touchedIds)
      : mergeWorkspaceRunGraph(currentGraph, result.graph, touchedIds);
    writeWorkspaceGraph(scoped.root, mergedGraph, root);
    if (result.deferred) {
      const waiting = upsertWorkspaceDeferredRun({
        ...runEntry,
        scheduleKey: entry.key,
        scheduleNodeId,
      }, result.deferred);
      appendWorkspaceRunLogEvent(runLog.runId, {
        type: "run-waiting",
        nodeId: waiting.nodeId,
        wakeAt: waiting.wakeAt,
        phase: waiting.phase,
        jenkinsStatus: waiting.jenkinsStatus,
        ts: Date.now(),
      });
      updateWorkspaceScheduleEntry(entry.key, {
        nextRunAt: computeNext(config),
        lastStatus: "waiting",
        lastError: "",
      });
      return;
    }
    const endedAt = Date.now();
    appendWorkspaceRunFinished({
      ...runEntry,
      endedAt,
      durationMs: endedAt - runEntry.startedAt,
      marketplaceResources: marketplaceResourcesForRun(executionRoot, graph, result.order || Array.from(touchedIds)),
    }, "success");
    finishWorkspaceRunLogSession(runLog.runId, "success", {
      endedAt,
      durationMs: endedAt - runEntry.startedAt,
      runNodeId: targetRunNodeId,
      releaseId: runEntry.releaseId,
      designRevision: runEntry.designRevision,
    });
    updateWorkspaceScheduleEntry(entry.key, {
      nextRunAt: computeNext(config),
      lastFinishedAt: endedAt,
      lastStatus: "success",
      lastError: "",
    });
  } catch (e) {
    const endedAt = Date.now();
    const error = (e && e.message) || String(e);
    const stopped = isWorkspaceRunAbortError(e) || controller.signal.aborted;
    const finalStatus = stopped ? "stopped" : "failed";
    appendWorkspaceRunFinished({ ...runEntry, endedAt, durationMs: endedAt - runEntry.startedAt }, finalStatus);
    appendWorkspaceRunLogEvent(runLog.runId, stopped
      ? { type: "stopped", message: "Workspace run stopped", ts: endedAt }
      : { type: "error", error, ts: endedAt });
    finishWorkspaceRunLogSession(runLog.runId, finalStatus, {
      endedAt,
      durationMs: endedAt - runEntry.startedAt,
      runNodeId: targetRunNodeId,
      releaseId: runEntry.releaseId,
      designRevision: runEntry.designRevision,
      error: stopped ? "" : error,
    });
    updateWorkspaceScheduleEntry(entry.key, {
      nextRunAt: computeNext(config),
      lastFinishedAt: endedAt,
      lastStatus: finalStatus,
      lastError: stopped ? "" : error,
      ...(stopped ? {} : { lastErrorAt: endedAt }),
    });
    if (!stopped) log.info(`[workspace-scheduler] failed ${entry.flowId}/${targetRunNodeId}: ${error}`);
  } finally {
    runControl.finish(controller.signal.aborted ? "stopped" : "finished");
    if (activeWorkspaceRuns.get(runKey) === runEntry) activeWorkspaceRuns.delete(runKey);
  }
}

function finishWorkspaceDeferredRun(entry, status, patch = {}) {
  const endedAt = Number(patch.endedAt || Date.now());
  appendWorkspaceRunFinished({
    ...entry,
    endedAt,
    durationMs: Math.max(0, endedAt - Number(entry.startedAt || endedAt)),
  }, status);
  finishWorkspaceRunLogSession(entry.runId, status, {
    endedAt,
    durationMs: Math.max(0, endedAt - Number(entry.startedAt || endedAt)),
    runNodeId: entry.runNodeId || "",
    releaseId: entry.releaseId || "",
    designRevision: entry.designRevision || "",
    error: String(patch.error || ""),
  });
  if (entry.scheduleKey) {
    updateWorkspaceScheduleEntry(entry.scheduleKey, {
      lastFinishedAt: endedAt,
      lastStatus: status,
      lastError: String(patch.error || ""),
      ...(patch.error ? { lastErrorAt: endedAt } : {}),
    });
  }
}

async function runWorkspaceDeferredEntry(root, claimed) {
  const userCtx = { userId: String(claimed.userId || "") };
  const scoped = resolveWorkspaceScopeRoot(root, {
    flowId: claimed.flowId || "",
    flowSource: claimed.flowSource || "user",
    archived: claimed.archived === true,
  }, userCtx);
  if (scoped.error || scoped.archived || isReadonlyBuiltinFlowSource(scoped.flowSource)) {
    const error = scoped.error || "Deferred Workspace target is not writable";
    removeWorkspaceDeferredRun(claimed.key);
    appendWorkspaceRunLogEvent(claimed.runId, { type: "error", error, ts: Date.now() });
    finishWorkspaceDeferredRun(claimed, "failed", { error });
    return;
  }

  const controller = new AbortController();
  const runControl = workspaceRunControl(controller);
  const runKey = workspaceRunEntryKey(claimed.scopeKey, claimed.runId);
  const runEntry = {
    ...claimed,
    controller,
    runControl,
    plannedNodeIds: Array.isArray(claimed.plannedNodeIds) ? claimed.plannedNodeIds : [],
  };
  activeWorkspaceRuns.set(runKey, runEntry);
  let activeReleased = false;
  const releaseActive = (status = "finished") => {
    if (activeReleased) return;
    activeReleased = true;
    runControl.finish(status);
    if (activeWorkspaceRuns.get(runKey) === runEntry) activeWorkspaceRuns.delete(runKey);
  };
  try {
    const executionRoot = String(claimed.executionRoot || "").trim() || scoped.root;
    const executionScoped = executionRoot === scoped.root ? scoped : { ...scoped, root: executionRoot };
    const graph = hydrateWorkspaceGraphForRuntime(root, executionScoped, readWorkspaceGraph(executionRoot, root).graph, userCtx);
    const result = await runWorkspaceGraph(root, executionRoot, {
      flowId: claimed.flowId,
      flowSource: claimed.flowSource || "user",
      runNodeId: claimed.runNodeId,
      graph,
    }, userCtx, {
      runtimeRoot: scoped.root,
      signal: controller.signal,
      onActiveChild: (child, options = {}) => runControl.setChild(child, options),
      onEvent: (event) => appendWorkspaceRunLogEvent(claimed.runId, event),
      runId: claimed.runId,
    });
    const currentGraph = readWorkspaceGraph(scoped.root, root).graph;
    const touchedIds = workspaceRunTouchedNodeIds(result);
    if (claimed.releaseId) {
      writeWorkspaceReleaseRuntimeState(scoped.root, claimed.releaseId, result.graph);
    }
    const mergedGraph = claimed.releaseId
      ? mergeWorkspaceRunState(currentGraph, result.graph, touchedIds)
      : mergeWorkspaceRunGraph(currentGraph, result.graph, touchedIds);
    writeWorkspaceGraph(scoped.root, mergedGraph, root);
    if (result.deferred) {
      const waiting = upsertWorkspaceDeferredRun({ ...claimed, deferredKey: claimed.key }, result.deferred);
      appendWorkspaceRunLogEvent(claimed.runId, {
        type: "run-waiting",
        nodeId: waiting.nodeId,
        wakeAt: waiting.wakeAt,
        phase: waiting.phase,
        jenkinsStatus: waiting.jenkinsStatus,
        ts: Date.now(),
      });
      if (claimed.scheduleKey) updateWorkspaceScheduleEntry(claimed.scheduleKey, { lastStatus: "waiting" });
      releaseActive("waiting");
      emitWorkspaceCollaborationEvent(userCtx, scoped.flowSource, scoped.flowId, scoped.archived, {
        type: "runtime.committed",
        runId: claimed.runId,
        runNodeId: claimed.runNodeId,
        actorId: userCtx.userId || "",
        source: "deferred-run",
      });
      emitWorkspaceCollaborationEvent(userCtx, scoped.flowSource, scoped.flowId, scoped.archived, {
        type: "run.waiting",
        status: "waiting",
        runId: claimed.runId,
        runNodeId: claimed.runNodeId,
        actorId: userCtx.userId || "",
      });
      return;
    }

    removeWorkspaceDeferredRun(claimed.key);
    finishWorkspaceDeferredRun(claimed, "success");
    releaseActive("finished");
    emitWorkspaceCollaborationEvent(userCtx, scoped.flowSource, scoped.flowId, scoped.archived, {
      type: "runtime.committed",
      runId: claimed.runId,
      runNodeId: claimed.runNodeId,
      actorId: userCtx.userId || "",
      source: "deferred-run",
    });
    emitWorkspaceCollaborationEvent(userCtx, scoped.flowSource, scoped.flowId, scoped.archived, {
      type: "run.finished",
      status: "success",
      runId: claimed.runId,
      runNodeId: claimed.runNodeId,
      actorId: userCtx.userId || "",
    });
  } catch (e) {
    const error = (e && e.message) || String(e);
    const stopped = isWorkspaceRunAbortError(e) || controller.signal.aborted;
    removeWorkspaceDeferredRun(claimed.key);
    appendWorkspaceRunLogEvent(claimed.runId, stopped
      ? { type: "stopped", message: "Workspace run stopped", ts: Date.now() }
      : { type: "error", error, ts: Date.now() });
    finishWorkspaceDeferredRun(claimed, stopped ? "stopped" : "failed", { error: stopped ? "" : error });
    releaseActive(stopped ? "stopped" : "failed");
    emitWorkspaceCollaborationEvent(userCtx, scoped.flowSource, scoped.flowId, scoped.archived, {
      type: "run.finished",
      status: stopped ? "stopped" : "failed",
      runId: claimed.runId,
      runNodeId: claimed.runNodeId,
      actorId: userCtx.userId || "",
    });
    if (!stopped) log.info(`[workspace-deferred] failed ${claimed.flowId}/${claimed.runNodeId}: ${error}`);
  } finally {
    releaseActive(controller.signal.aborted ? "stopped" : "finished");
  }
}

export function pollWorkspaceDeferredRuns(root, now = Date.now()) {
  const registry = readWorkspaceDeferredRunRegistry();
  for (const entry of Object.values(registry.runs || {})) {
    const key = String(entry?.key || "").trim();
    if (!key || activeWorkspaceDeferredRuns.has(key)) continue;
    const wakeAt = Date.parse(String(entry.wakeAt || ""));
    if (Number.isFinite(wakeAt) && wakeAt > now) continue;
    const claimed = claimWorkspaceDeferredRun(key, now);
    if (!claimed) continue;
    activeWorkspaceDeferredRuns.add(key);
    void runWorkspaceDeferredEntry(root, claimed).finally(() => activeWorkspaceDeferredRuns.delete(key));
  }
}
