/**
 * 本地 HTTP：静态 UI + /api/flows（GET/POST/HEAD）、/api/flows/import（POST multipart 导入 .yaml/.zip）、/api/flow/archive（POST）、/api/flow/delete（POST 永久删除）、/api/model-lists、/api/ui-context、/api/pipeline-recent-runs、/api/run-node-statuses（GET 某次 run 各节点磁盘状态）、/api/workspace-tree（GET 工作区目录树）、/api/nodes、/api/flow（GET/POST）、
 * /api/flow-editor-sync（POST 通知画布刷新）、/api/flow-editor-sync-events（GET SSE）、/api/flow/run（POST NDJSON 流式执行 agentflow apply --machine-readable）、/api/flow/run/stop（POST 终止运行）、/api/workspace/run/stop（POST 终止 Workspace 临时运行）、
 * /api/composer-agent（POST NDJSON；有 flow 时结束后 validate-flow，失败则自动 agent 修复至多 5 次）、
 * /api/agentflow-config（GET/POST 读写 ~/agentflow/config.json 的 opencodeProvider；POST 后执行 update-model-lists）、/api/update-model-lists（POST 可选 JSON body.opencodeProvider 覆盖本次拉取用的 Provider，未保存 config 也可用）；
 * listen 后后台 updateModelLists
 */
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import crypto from "crypto";
import { pathToFileURL } from "url";
import { execFile, spawn } from "child_process";
import busboy from "busboy";
import sharp from "sharp";
import { log } from "./log.mjs";
import {
  getFlowYamlAbs,
  listFlowsJson,
  listNodesJson,
  readFlowJson,
  readNodeDetailJson,
  readNodeFilePreview,
} from "./catalog-flows.mjs";
import {
  FLOW_YAML_FILENAME,
  archiveFlowPipeline,
  buildEmptyUserFlowYaml,
  deleteFlowPipeline,
  moveFlowDirectory,
  resolveFlowDirForWrite,
  validateUserPipelineId,
  writeFlowYaml,
} from "./flow-write.mjs";
import { updateModelLists } from "./model-lists.mjs";
import {
  startComposerAgent,
  startComposerMultiStep,
  runComposerPostFlowValidationAndRepair,
  buildScriptContentBlockForInstances,
} from "./composer-agent.mjs";
import { t } from "./i18n.mjs";
import {
  PACKAGE_ROOT,
  getAgentflowDataRoot,
  getAgentflowUserConfigAbs,
  getAgentflowUserDataRoot,
  getModelListsAbs,
  getRunDir,
} from "./paths.mjs";
import { RUN_INTERRUPTED_FILENAME } from "./recent-runs.mjs";
import {
  detectIntents,
  loadResourcesForIntents,
  loadResourcesForSkillKeys,
  listComposerSkills,
  readComposerSkillDetail,
  buildSkillInjectionBlock,
  buildSkillCompactInjectionBlock,
} from "./composer-skill-router.mjs";
import { COMPOSER_NODE_SPEC_FILENAME } from "./composer-planner.mjs";
import { listRecentRunsFromDisk } from "./recent-runs.mjs";
import {
  unzipAndNormalizePipelineZip,
  validateImportedFlowYaml,
  writePipelineTree,
} from "./flow-import.mjs";
import { getWorkspaceTree, getPipelineFiles } from "./workspace-tree.mjs";
import {
  createComposerSession,
  logComposerEvent,
  truncateForLog,
  listRecentComposerSessions,
  parseComposerLogFile,
  readComposerSessionMeta,
} from "./composer-log.mjs";
import { runNodeScript } from "./pipeline-scripts.mjs";
import { readFlowSchedule, writeFlowSchedule } from "./schedule-config.mjs";
import { listScheduleStatuses } from "./scheduler.mjs";
import {
  deleteMarketplaceFlowSnippetPackage,
  deleteMarketplaceNodePackage,
  installFlowDependency,
  listMarketplaceFlowSnippets,
  listMarketplacePackages,
  publishFlowSnippet,
  publishNodeFromInstance,
} from "./marketplace.mjs";
import { buildGitContext, inferGitRepoRootFromWorktree, loadGitWorktree, normalizeGitContext, runGit, unloadGitWorktree } from "./git-worktree.mjs";
import { createGitLabMergeRequest } from "./gitlab-mr.mjs";
import {
  authSetupRequired,
  buildClearSessionCookie,
  buildSessionCookie,
  getAuthUserFromRequest,
  isAuthUserAllowed,
  loginOrCreateUser,
  logoutRequest,
  readAuthUsers,
  readUserAllowlist,
  writeUserAllowlist,
} from "./auth.mjs";
import { readGlobalEnvRows, readMergedEnvObject, readUserEnvRows, writeGlobalEnvRows, writeUserEnvRows } from "./user-env.mjs";
import {
  readAdminBuiltinPipelineConfig,
  updateAdminBuiltinPipelineConfig,
} from "./admin-builtin-pipelines.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function execFileBuffered(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      timeout: Number(options.timeout || 30000),
      maxBuffer: Number(options.maxBuffer || 2 * 1024 * 1024),
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
    }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

const RUN_CONFIG_FILENAME = "run-config.json";
const SKILL_COLLECTIONS_FILENAME = "skill-collections.json";
const BUILTIN_SKILL_COLLECTIONS = [
  {
    id: "pipeline",
    name: "Pipeline",
    defaultKeys: [
      "agentflow-flow-add-instances",
      "agentflow-flow-edit-node-fields",
      "agentflow-flow-recipes",
      "agentflow-flow-sync-ui",
      "agentflow-node-reference",
      "agentflow-placeholder-reference",
      "agentflow-runtime-reference",
    ],
  },
  {
    id: "workspace",
    name: "Workspace",
    defaultKeys: [
      "agentflow-workspace-graph",
      "agentflow-workspace-markdown",
      "agentflow-workspace-mermaid",
      "agentflow-workspace-ascii",
      "agentflow-workspace-chart",
      "agentflow-workspace-table",
      "agentflow-workspace-html",
      "agentflow-workspace-image",
      "agentflow-node-reference",
      "agentflow-placeholder-reference",
      "agentflow-runtime-reference",
    ],
    legacyDefaultKeys: [
      [
        "agentflow-workspace-graph",
        "agentflow-workspace-markdown",
        "agentflow-workspace-mermaid",
        "agentflow-workspace-ascii",
        "agentflow-workspace-chart",
        "agentflow-workspace-table",
        "agentflow-node-reference",
        "agentflow-placeholder-reference",
        "agentflow-runtime-reference",
      ],
      [
        "agentflow-workspace-graph",
        "agentflow-workspace-markdown",
        "agentflow-workspace-mermaid",
        "agentflow-workspace-ascii",
        "agentflow-node-reference",
        "agentflow-placeholder-reference",
        "agentflow-runtime-reference",
      ],
      [
        "agentflow-flow-add-instances",
        "agentflow-flow-edit-node-fields",
        "agentflow-node-reference",
        "agentflow-placeholder-reference",
        "agentflow-runtime-reference",
      ],
      [
        "agentflow-node-reference",
        "agentflow-placeholder-reference",
        "agentflow-runtime-reference",
      ],
    ],
  },
];

function json(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function feedbackStorePath() {
  return path.join(getAgentflowDataRoot(), "feedback", "feedback.json");
}

function readFeedbackItems() {
  try {
    const p = feedbackStorePath();
    if (!fs.existsSync(p)) return [];
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    return Array.isArray(data) ? data.filter((item) => item && typeof item === "object") : [];
  } catch {
    return [];
  }
}

function writeFeedbackItems(items) {
  const p = feedbackStorePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(Array.isArray(items) ? items : [], null, 2) + "\n", "utf-8");
}

function createFeedbackItem(payload, user) {
  const title = String(payload?.title || "").trim().slice(0, 120);
  const content = String(payload?.content || "").trim().slice(0, 5000);
  const pageUrl = String(payload?.pageUrl || "").trim().slice(0, 500);
  if (!title) return { error: "Missing feedback title" };
  if (!content) return { error: "Missing feedback content" };
  return {
    item: {
      id: `fb_${Date.now().toString(36)}_${crypto.randomBytes(5).toString("hex")}`,
      title,
      content,
      pageUrl,
      userId: String(user?.userId || ""),
      username: String(user?.username || user?.userId || ""),
      createdAt: new Date().toISOString(),
    },
  };
}

function skillCollectionsAbs() {
  return path.join(getAgentflowDataRoot(), "admin", SKILL_COLLECTIONS_FILENAME);
}

function legacyAdminSkillCollectionPaths() {
  const users = readAuthUsers();
  return Object.entries(users || {})
    .filter(([, user]) => user?.isAdmin)
    .map(([userId, user]) => path.join(getAgentflowUserDataRoot(user.userId || userId), SKILL_COLLECTIONS_FILENAME));
}

function readSkillCollectionFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function mergeSkillCollectionConfigs(configs = []) {
  const merged = [];
  const seen = new Set();
  for (const config of configs) {
    for (const collection of normalizeSkillCollectionConfig(config).collections) {
      if (!collection.id || seen.has(collection.id)) continue;
      seen.add(collection.id);
      merged.push(collection);
    }
  }
  return { version: 1, collections: merged };
}

function slugifySkillCollectionId(name, fallback = "collection") {
  const raw = String(name || "").trim().toLowerCase();
  const id = raw
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return id || fallback;
}

function isBuiltinSkillCollectionId(id) {
  return BUILTIN_SKILL_COLLECTIONS.some((collection) => collection.id === id);
}

function resolveSkillKeys(skillNamesOrKeys = [], availableSkills = []) {
  const byToken = buildSkillKeyLookup(availableSkills);
  return skillNamesOrKeys.map((key) => byToken.get(key)).filter(Boolean);
}

function buildSkillKeyLookup(availableSkills = []) {
  const byToken = new Map();
  for (const skill of availableSkills) {
    const key = String(skill?.key || "").trim();
    if (!key) continue;
    for (const token of [skill.key, skill.name, skill.id]) {
      const normalized = String(token || "").trim();
      if (normalized && !byToken.has(normalized)) byToken.set(normalized, key);
    }
  }
  return byToken;
}

function defaultSkillKeysForCollection(def, availableSkills = []) {
  const exact = resolveSkillKeys(def.defaultKeys, availableSkills);
  if (exact.length > 0) return exact;
  return availableSkills
    .filter((skill) => String(skill?.name || skill?.id || skill?.key || "").includes("agentflow-"))
    .map((skill) => String(skill.key || "").trim())
    .filter(Boolean);
}

function sameSkillKeySet(a = [], b = []) {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((key) => set.has(key));
}

function normalizeSkillCollectionConfig(value) {
  const now = Date.now();
  const seenIds = new Set();
  const collections = [];
  const input = Array.isArray(value?.collections) ? value.collections : [];
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const name = String(item.name || item.id || "").trim().slice(0, 80);
    if (!name) continue;
    let id = slugifySkillCollectionId(item.id || name);
    let suffix = 2;
    while (seenIds.has(id)) {
      id = `${slugifySkillCollectionId(item.id || name)}-${suffix++}`;
    }
    seenIds.add(id);
    const skillSeen = new Set();
    const skillKeys = [];
    for (const key of Array.isArray(item.skillKeys) ? item.skillKeys : []) {
      const normalized = String(key || "").trim();
      if (!normalized || skillSeen.has(normalized)) continue;
      skillSeen.add(normalized);
      skillKeys.push(normalized);
    }
    collections.push({
      id,
      name,
      skillKeys,
      builtin: Boolean(item.builtin) || isBuiltinSkillCollectionId(id),
      createdAt: Number.isFinite(item.createdAt) ? Number(item.createdAt) : now,
      updatedAt: Number.isFinite(item.updatedAt) ? Number(item.updatedAt) : now,
    });
  }
  return { version: 1, collections };
}

function withBuiltinSkillCollections(config, availableSkills = []) {
  const normalized = normalizeSkillCollectionConfig(config);
  const byId = new Map(normalized.collections.map((collection) => [collection.id, collection]));
  const out = [];
  const now = Date.now();
  for (const def of BUILTIN_SKILL_COLLECTIONS) {
    const existing = byId.get(def.id);
    if (existing) {
      const nextDefaultKeys = defaultSkillKeysForCollection(def, availableSkills);
      const legacyDefaultSets = (Array.isArray(def.legacyDefaultKeys) ? def.legacyDefaultKeys : [])
        .map((keys) => Array.isArray(keys) ? resolveSkillKeys(keys, availableSkills) : [])
        .filter((keys) => keys.length > 0);
      const shouldMigrateLegacyDefault =
        existing.skillKeys.length > 0 &&
        legacyDefaultSets.some((keys) => sameSkillKeySet(existing.skillKeys, keys));
      out.push({
        ...existing,
        name: def.name,
        builtin: true,
        skillKeys: existing.skillKeys.length > 0 && !shouldMigrateLegacyDefault ? existing.skillKeys : nextDefaultKeys,
      });
      byId.delete(def.id);
    } else {
      out.push({
        id: def.id,
        name: def.name,
        builtin: true,
        skillKeys: defaultSkillKeysForCollection(def, availableSkills),
        createdAt: now,
        updatedAt: now,
      });
    }
  }
  out.push(...Array.from(byId.values()).map((collection) => ({ ...collection, builtin: false })));
  return { version: 1, collections: out };
}

function readSkillCollectionConfig(userCtx = {}, availableSkills = []) {
  const p = skillCollectionsAbs(userCtx);
  try {
    const globalConfig = readSkillCollectionFile(p);
    if (globalConfig) return withBuiltinSkillCollections(globalConfig, availableSkills);
    const legacyConfigs = legacyAdminSkillCollectionPaths()
      .map((legacyPath) => readSkillCollectionFile(legacyPath))
      .filter(Boolean);
    return withBuiltinSkillCollections(mergeSkillCollectionConfigs(legacyConfigs), availableSkills);
  } catch {
    return withBuiltinSkillCollections({}, availableSkills);
  }
}

function writeSkillCollectionConfig(userCtx = {}, payload = {}, availableSkills = []) {
  const p = skillCollectionsAbs(userCtx);
  const config = withBuiltinSkillCollections(payload, availableSkills);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(config, null, 2) + "\n", "utf-8");
  return config;
}

function upsertSkillhubCollectionGroup(userCtx = {}, collectionId = "", beforeSkills = [], afterSkills = [], collectionName = "") {
  const rawCollectionId = String(collectionId || "").trim();
  if (!rawCollectionId) return null;
  const beforeKeys = new Set((Array.isArray(beforeSkills) ? beforeSkills : []).map((skill) => String(skill?.key || "")).filter(Boolean));
  const addedKeys = (Array.isArray(afterSkills) ? afterSkills : [])
    .map((skill) => String(skill?.key || "").trim())
    .filter((key) => key && !beforeKeys.has(key));
  const config = readSkillCollectionConfig(userCtx, afterSkills);
  const groupId = slugifySkillCollectionId(`skillhub-collection-${rawCollectionId}`, "skillhub-collection");
  const now = Date.now();
  const existing = config.collections.find((collection) => collection.id === groupId);
  const existingKeys = Array.isArray(existing?.skillKeys) ? existing.skillKeys : [];
  const mergedKeys = Array.from(new Set([...existingKeys, ...addedKeys]));
  const nextCollections = config.collections.filter((collection) => collection.id !== groupId);
  nextCollections.push({
    id: groupId,
    name: String(collectionName || "").trim() || `SkillHub Collection ${rawCollectionId}`,
    skillKeys: mergedKeys,
    builtin: false,
    createdAt: Number.isFinite(existing?.createdAt) ? existing.createdAt : now,
    updatedAt: now,
  });
  return writeSkillCollectionConfig(userCtx, { version: 1, collections: nextCollections }, afterSkills);
}

function removeSkillhubCollectionGroup(userCtx = {}, collectionId = "", root = process.cwd()) {
  const rawCollectionId = String(collectionId || "").trim();
  if (!rawCollectionId) return null;
  const availableSkills = listComposerSkills(PACKAGE_ROOT, root);
  const config = readSkillCollectionConfig(userCtx, availableSkills);
  const groupId = slugifySkillCollectionId(`skillhub-collection-${rawCollectionId}`, "skillhub-collection");
  if (!config.collections.some((collection) => collection.id === groupId)) return config;
  return writeSkillCollectionConfig(
    userCtx,
    { version: 1, collections: config.collections.filter((collection) => collection.id !== groupId) },
    availableSkills,
  );
}

function runtimeEnvForUser(userCtx = {}, extra = {}) {
  return {
    ...process.env,
    ...readMergedEnvObject(userCtx.userId),
    ...extra,
    AGENTFLOW_USER_ID: userCtx.userId || "",
  };
}

function readAgentflowUserConfigObject() {
  const p = getAgentflowUserConfigAbs();
  try {
    if (!fs.existsSync(p)) return {};
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function cursorMcpConfigPath() {
  return path.join(os.homedir(), ".cursor", "mcp.json");
}

function readCursorMcpConfig() {
  const p = cursorMcpConfigPath();
  try {
    if (!fs.existsSync(p)) return { mcpServers: {} };
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : { mcpServers: {} };
  } catch {
    return { mcpServers: {} };
  }
}

function userMcpPrivatePath(userCtx = {}) {
  return path.join(getAgentflowUserDataRoot(userCtx.userId), "mcp-private.json");
}

function readUserMcpPrivate(userCtx = {}) {
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

function writeUserMcpPrivate(userCtx = {}, data = {}) {
  const p = userMcpPrivatePath(userCtx);
  const servers = data?.servers && typeof data.servers === "object" && !Array.isArray(data.servers) ? data.servers : {};
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ version: 1, servers }, null, 2) + "\n", "utf-8");
  return { version: 1, servers };
}

function normalizeMcpPrivateKeys(keys) {
  return new Set((Array.isArray(keys) ? keys : []).map((key) => String(key || "").trim()).filter(Boolean));
}

function pickObjectKeys(obj, keys) {
  const out = {};
  for (const key of keys) {
    if (obj && Object.prototype.hasOwnProperty.call(obj, key)) out[key] = String(obj[key] ?? "");
  }
  return out;
}

function omitObjectKeys(obj, keys) {
  const out = {};
  for (const [key, value] of Object.entries(obj && typeof obj === "object" ? obj : {})) {
    if (!keys.has(key)) out[key] = value;
  }
  return out;
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

function normalizeMcpServerConfig(value) {
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

function readCursorMcpServers(userCtx = {}) {
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
  }).sort((a, b) => a.name.localeCompare(b.name));
  return { path: cursorMcpConfigPath(), servers };
}

function writeCursorMcpServer(payload = {}, userCtx = {}) {
  const name = String(payload?.name || "").trim();
  const nextName = String(payload?.nextName || payload?.name || "").trim();
  if (!/^[A-Za-z0-9_.-]+$/.test(nextName)) throw new Error("Invalid MCP name");
  const server = normalizeMcpServerConfig(payload?.server);
  if (!server.url && !server.command) throw new Error("MCP server requires url or command");
  const privateEnvKeys = normalizeMcpPrivateKeys(payload?.privateEnvKeys);
  const privateHeaderKeys = normalizeMcpPrivateKeys(payload?.privateHeaderKeys);
  const privateEnv = pickObjectKeys(server.env || {}, privateEnvKeys);
  const privateHeaders = pickObjectKeys(server.headers || {}, privateHeaderKeys);
  const publicServer = {
    ...server,
    env: omitObjectKeys(server.env || {}, privateEnvKeys),
    headers: omitObjectKeys(server.headers || {}, privateHeaderKeys),
  };
  if (privateEnvKeys.size || privateHeaderKeys.size) {
    publicServer.__agentflowPrivateKeys = {
      ...(privateEnvKeys.size ? { env: Array.from(privateEnvKeys) } : {}),
      ...(privateHeaderKeys.size ? { headers: Array.from(privateHeaderKeys) } : {}),
    };
  } else {
    delete publicServer.__agentflowPrivateKeys;
  }
  if (!Object.keys(publicServer.env).length) delete publicServer.env;
  if (!Object.keys(publicServer.headers).length) delete publicServer.headers;
  const p = cursorMcpConfigPath();
  const config = readCursorMcpConfig();
  const mcpServers = config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)
    ? { ...config.mcpServers }
    : {};
  if (name && name !== nextName) delete mcpServers[name];
  mcpServers[nextName] = publicServer;
  const next = { ...config, mcpServers };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(next, null, 2) + "\n", "utf-8");
  const privateConfig = readUserMcpPrivate(userCtx);
  const privateServers = { ...(privateConfig.servers || {}) };
  if (name && name !== nextName) delete privateServers[name];
  if (Object.keys(privateEnv).length || Object.keys(privateHeaders).length) {
    privateServers[nextName] = {
      ...(Object.keys(privateEnv).length ? { env: privateEnv } : {}),
      ...(Object.keys(privateHeaders).length ? { headers: privateHeaders } : {}),
    };
  } else {
    delete privateServers[nextName];
  }
  writeUserMcpPrivate(userCtx, { servers: privateServers });
  return readCursorMcpServers(userCtx);
}

function deleteCursorMcpServer(name, userCtx = {}) {
  const key = String(name || "").trim();
  if (!key) throw new Error("Missing MCP name");
  const p = cursorMcpConfigPath();
  const config = readCursorMcpConfig();
  const mcpServers = config.mcpServers && typeof config.mcpServers === "object" && !Array.isArray(config.mcpServers)
    ? { ...config.mcpServers }
    : {};
  delete mcpServers[key];
  const next = { ...config, mcpServers };
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(next, null, 2) + "\n", "utf-8");
  const privateConfig = readUserMcpPrivate(userCtx);
  const privateServers = { ...(privateConfig.servers || {}) };
  delete privateServers[key];
  writeUserMcpPrivate(userCtx, { servers: privateServers });
  return readCursorMcpServers(userCtx);
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

async function checkCursorMcpServers(name = "", userCtx = {}) {
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

function readModelListsFromDisk(workspaceRoot) {
  const p = getModelListsAbs();
  const empty = {
    cursor: [],
    opencode: [],
    claudeCode: [],
    cursorFetchedAt: null,
    opencodeFetchedAt: null,
    claudeCodeFetchedAt: null,
  };
  try {
    if (!fs.existsSync(p)) return empty;
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    return {
      cursor: Array.isArray(data.cursor) ? data.cursor.map(String) : [],
      opencode: Array.isArray(data.opencode) ? data.opencode.map(String) : [],
      claudeCode: Array.isArray(data.claudeCode) ? data.claudeCode.map(String) : [],
      cursorFetchedAt: data.cursorFetchedAt ?? null,
      opencodeFetchedAt: data.opencodeFetchedAt ?? null,
      claudeCodeFetchedAt: data.claudeCodeFetchedAt ?? null,
    };
  } catch {
    return empty;
  }
}

const SKILLHUB_TIMEOUT_MS = 60_000;
const SKILLHUB_API_BASE = String(process.env.SKILLHUB_API_BASE || "https://skillhub.bigo.sg/api/v1").replace(/\/+$/, "");
const skillhubCollectionInfoCache = new Map();

function runSkillhub(args, opts = {}) {
  return new Promise((resolve) => {
    execFile("skillhub", args, {
      cwd: opts.cwd || process.cwd(),
      timeout: opts.timeoutMs || SKILLHUB_TIMEOUT_MS,
      maxBuffer: opts.maxBuffer || 2 * 1024 * 1024,
      env: {
        ...process.env,
        FORCE_COLOR: "0",
      },
    }, (error, stdout, stderr) => {
      const out = String(stdout || "");
      const err = String(stderr || "");
      resolve({
        ok: !error,
        code: error && typeof error.code === "number" ? error.code : 0,
        error: error ? (err.trim() || error.message || "skillhub failed") : "",
        stdout: out,
        stderr: err,
      });
    });
  });
}

function readSkillhubAuthToken() {
  try {
    const p = path.join(os.homedir(), ".skillhub", "auth.json");
    if (!fs.existsSync(p)) return "";
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    return String(data?.token || data?.accessToken || data?.access_token || "").trim();
  } catch {
    return "";
  }
}

function normalizeSkillhubCollectionInfo(raw, collectionId) {
  const data = raw?.data && typeof raw.data === "object"
    ? raw.data
    : raw?.collection && typeof raw.collection === "object"
      ? raw.collection
      : raw?.item && typeof raw.item === "object"
        ? raw.item
        : raw && typeof raw === "object"
          ? raw
          : {};
  const id = String(data.id ?? collectionId ?? "").trim();
  const name = String(data.name ?? data.displayName ?? data.display_name ?? data.title ?? "").trim();
  const summary = String(data.description ?? data.summary ?? data.subtitle ?? "").trim();
  const version = String(data.version ?? data.latestVersion ?? data.latest_version ?? "").trim();
  const tags = Array.isArray(data.tags) ? data.tags.map(String).filter(Boolean) : [];
  if (!id && !name) return null;
  return {
    id: id || String(collectionId || ""),
    collection: id || String(collectionId || ""),
    kind: "collection",
    slug: "",
    name: name || `Collection ${collectionId}`,
    summary: summary || "按 Collection ID 安装该合集中的全部 Skills。",
    version,
    tags,
  };
}

async function fetchSkillhubCollectionInfo(collectionId) {
  const id = String(collectionId || "").trim();
  if (!id) return null;
  const cached = skillhubCollectionInfoCache.get(id);
  if (cached) return cached;
  if (typeof fetch !== "function") return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const token = readSkillhubAuthToken();
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const r = await fetch(`${SKILLHUB_API_BASE}/collections/${encodeURIComponent(id)}`, {
      headers,
      signal: controller.signal,
    });
    if (!r.ok) return null;
    const raw = await r.json().catch(() => null);
    const info = normalizeSkillhubCollectionInfo(raw, id);
    if (info) skillhubCollectionInfoCache.set(id, info);
    return info;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function parseJsonText(text, fallback = null) {
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

function normalizeSkillhubSearchPayload(raw) {
  const data = raw && typeof raw === "object" ? raw : {};
  const items = Array.isArray(data.items) ? data.items : Array.isArray(data.results) ? data.results : [];
  return {
    total: Number(data.total) || items.length,
    mode: typeof data.mode === "string" ? data.mode : "",
    degraded: Boolean(data.degraded),
    items: items.map((item) => {
      const x = item && typeof item === "object" ? item : {};
      const id = x.id ?? x.skillId ?? x.skill_id ?? "";
      const slug = String(x.slug ?? x.name ?? x.displayName ?? x.display_name ?? id ?? "").trim();
      return {
        id: String(id || slug),
        skillId: String(id || ""),
        slug,
        name: String(x.displayName ?? x.display_name ?? x.name ?? slug),
        summary: String(x.summary ?? x.description ?? ""),
        version: String(x.version ?? x.latestVersion ?? x.latest_version ?? ""),
        tags: Array.isArray(x.tags) ? x.tags.map(String) : [],
        kind: "skill",
      };
    }).filter((x) => x.slug || x.name),
  };
}

function normalizeSkillhubListPayload(raw) {
  const arr = Array.isArray(raw) ? raw : [];
  return arr.map((x) => {
    const pathValue = String(x?.path ?? "");
    const targetPath = String(x?.targetPath ?? x?.target ?? "");
    const metaPaths = [
      pathValue ? path.join(pathValue, "_meta.json") : "",
      targetPath ? path.join(targetPath, "_meta.json") : "",
    ];
    try {
      if (pathValue) metaPaths.push(path.join(fs.realpathSync(pathValue), "_meta.json"));
    } catch {}
    let meta = {};
    for (const metaPath of metaPaths) {
      if (!metaPath || !fs.existsSync(metaPath)) continue;
      try {
        meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
        break;
      } catch {}
    }
    return {
      name: String(x?.name ?? meta?.slug ?? ""),
      displayName: String(meta?.displayName ?? ""),
      summary: String(meta?.summary ?? ""),
      version: String(meta?.version ?? ""),
      baseDir: String(x?.baseDir ?? ""),
      path: pathValue,
      targetPath,
      kind: String(x?.kind ?? ""),
      agent: String(x?.agent ?? ""),
      userName: String(meta?.userName ?? ""),
      generatedAt: String(meta?.generatedAt ?? ""),
    };
  }).filter((x) => x.name);
}

function skillhubInstallArgs(payload, { uninstall = false } = {}) {
  const slug = String(payload?.slug || payload?.name || "").trim();
  if (!slug && !payload?.collection) return null;
  const args = [uninstall ? "uninstall" : "install"];
  if (payload?.collection) {
    args.push("--collection", String(payload.collection).trim());
  } else {
    args.push(slug);
  }
  if (payload?.skillId) args.push("--skill-id", String(payload.skillId).trim());
  const target = String(payload?.target || "project").trim();
  const agent = String(payload?.agent || "codex").trim();
  if (target === "global") {
    args.push("--global", "--agent", agent);
  } else if (payload?.dir) {
    args.push("--dir", String(payload.dir).trim());
  }
  if (payload?.force) args.push("--force");
  return args;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
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

const WORKSPACE_FILE_SKIP_FILES = new Set([
  "flow.yaml",
  "workspace.graph.json",
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

function resolveWorkspaceFilePath(workspaceRoot, relPath) {
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

function sanitizeWorkspaceUploadName(filename) {
  const parsed = path.parse(String(filename || "image").replace(/\\/g, "/").split("/").pop() || "image");
  const stem = (parsed.name || "image")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "image";
  const ext = String(parsed.ext || "").toLowerCase();
  return `${stem}${WORKSPACE_IMAGE_EXTS.has(ext) ? ext : ".png"}`;
}

function uniqueWorkspaceRelPath(workspaceRoot, relPath) {
  let { abs, rel } = resolveWorkspaceFilePath(workspaceRoot, relPath);
  if (!fs.existsSync(abs)) return { abs, rel };
  const parsed = path.parse(rel);
  for (let i = 1; i < 1000; i += 1) {
    const candidate = path.posix.join(parsed.dir, `${parsed.name}-${i}${parsed.ext}`);
    const resolved = resolveWorkspaceFilePath(workspaceRoot, candidate);
    if (!fs.existsSync(resolved.abs)) return resolved;
  }
  return { abs, rel };
}

function workspaceDownloadContentDisposition(relPath) {
  const fallbackName = path.basename(String(relPath || "download")) || "download";
  const quotedName = fallbackName.replace(/[\r\n"\\]/g, "_");
  return `attachment; filename="${quotedName}"; filename*=UTF-8''${encodeURIComponent(fallbackName)}`;
}

function htmlEscapeAttribute(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fileUrlFromPath(absPath) {
  return pathToFileURL(path.resolve(absPath)).href;
}

function injectHtmlBaseHref(html, baseHref) {
  const raw = String(html || "");
  const base = `<base href="${htmlEscapeAttribute(baseHref)}">`;
  if (/<base\b/i.test(raw)) return raw;
  if (/<head\b[^>]*>/i.test(raw)) return raw.replace(/<head\b([^>]*)>/i, `<head$1>${base}`);
  if (/<html\b[^>]*>/i.test(raw)) return raw.replace(/<html\b([^>]*)>/i, `<html$1><head>${base}</head>`);
  return `<!doctype html><html><head>${base}</head><body>${raw}</body></html>`;
}

function chromeScreenshotCandidates() {
  const candidates = [];
  if (process.env.AGENTFLOW_CHROME_PATH) candidates.push(process.env.AGENTFLOW_CHROME_PATH);
  if (process.platform === "darwin") {
    candidates.push(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    );
  } else if (process.platform === "win32") {
    candidates.push(
      path.join(process.env.PROGRAMFILES || "C:\\Program Files", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env["PROGRAMFILES(X86)"] || "C:\\Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
      path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "Application", "chrome.exe"),
    );
  }
  candidates.push("google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome", "msedge");
  return candidates.filter(Boolean);
}

async function renderHtmlScreenshotWithChrome({ html, workspaceRoot, baseDir, width, height }) {
  const w = Math.max(240, Math.min(4096, Math.round(Number(width) || 390)));
  const h = Math.max(240, Math.min(12000, Math.round(Number(height) || 844)));
  const debug = {
    requestedWidth: Number(width) || null,
    requestedHeight: Number(height) || null,
    viewportWidth: w,
    viewportHeight: h,
    htmlChars: String(html || "").length,
    baseDir: path.resolve(baseDir || workspaceRoot),
    tried: [],
    usedCommand: "",
    pngBytes: 0,
    pngWidth: null,
    pngHeight: null,
  };
  const tmpDir = path.join(path.resolve(workspaceRoot), ".workspace", "agentflow", "tmp", `html-screenshot-${Date.now()}-${crypto.randomBytes(4).toString("hex")}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  const htmlPath = path.join(tmpDir, "snapshot.html");
  const pngPath = path.join(tmpDir, "snapshot.png");
  const baseHref = `${fileUrlFromPath(baseDir || workspaceRoot).replace(/\/?$/, "/")}`;
  fs.writeFileSync(htmlPath, injectHtmlBaseHref(html, baseHref), "utf-8");
  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--disable-dev-shm-usage",
    "--no-first-run",
    "--no-default-browser-check",
    "--allow-file-access-from-files",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    `--window-size=${w},${h}`,
    `--screenshot=${pngPath}`,
    fileUrlFromPath(htmlPath),
  ];
  let lastError = null;
  try {
    for (const command of chromeScreenshotCandidates()) {
      if (path.isAbsolute(command) && !fs.existsSync(command)) continue;
      debug.tried.push(command);
      try {
        await execFileBuffered(command, args, { timeout: 45000, cwd: workspaceRoot });
        if (fs.existsSync(pngPath) && fs.statSync(pngPath).size > 0) {
          const png = fs.readFileSync(pngPath);
          debug.usedCommand = command;
          debug.pngBytes = png.length;
          try {
            const meta = await sharp(png).metadata();
            debug.pngWidth = meta.width || null;
            debug.pngHeight = meta.height || null;
          } catch (_) {}
          return { png, debug };
        }
        lastError = new Error(`${command} did not produce a screenshot`);
      } catch (error) {
        lastError = error;
        debug.lastError = String(error?.message || error);
      }
    }
    throw new Error(`无法使用 Chrome 生成截图${lastError?.message ? `：${lastError.message}` : ""}`);
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  }
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

function readWorkspaceFilesRecursive(dir, root, depth = 0, maxDepth = 3, budget = { count: 0 }) {
  if (depth > maxDepth || budget.count > 500) return [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const entry of entries) {
    if (budget.count > 500) break;
    if (entry.name.startsWith(".") && entry.name !== ".agents" && entry.name !== ".codex") continue;
    const abs = path.join(dir, entry.name);
    const rel = path.relative(root, abs).replace(/\\/g, "/");
    if (shouldSkipWorkspaceFileRelPath(rel)) continue;
    if (entry.isDirectory()) {
      if (WORKSPACE_FILE_SKIP_DIRS.has(entry.name)) continue;
      budget.count++;
      out.push({
        type: "directory",
        name: entry.name,
        path: rel,
        icon: workspaceFileIcon(entry.name, true),
        children: readWorkspaceFilesRecursive(abs, root, depth + 1, maxDepth, budget),
      });
    } else if (entry.isFile()) {
      if (WORKSPACE_FILE_SKIP_FILES.has(entry.name)) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (!WORKSPACE_TEXT_EXTS.has(ext) && !WORKSPACE_IMAGE_EXTS.has(ext)) continue;
      let size = 0;
      try { size = fs.statSync(abs).size; } catch {}
      budget.count++;
      out.push({ type: "file", name: entry.name, path: rel, icon: workspaceFileIcon(entry.name), size });
    }
  }
  out.sort((a, b) => {
    if (a.type !== b.type) return a.type === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

function readWorkspaceFiles(workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  return { root, files: readWorkspaceFilesRecursive(root, root) };
}

const WORKSPACE_GRAPH_FILENAME = "workspace.graph.json";

function workspaceGraphPath(workspaceRoot) {
  return path.join(path.resolve(workspaceRoot), WORKSPACE_GRAPH_FILENAME);
}

function emptyWorkspaceGraph() {
  return { version: 1, instances: {}, edges: [], ui: { nodePositions: {} } };
}

function readWorkspaceGraph(workspaceRoot) {
  const graphPath = workspaceGraphPath(workspaceRoot);
  if (!fs.existsSync(graphPath)) return { path: graphPath, graph: emptyWorkspaceGraph() };
  const raw = fs.readFileSync(graphPath, "utf-8");
  if (!raw.trim()) return { path: graphPath, graph: emptyWorkspaceGraph() };
  const parsed = JSON.parse(raw);
  const graph = parsed && typeof parsed === "object" ? parsed : {};
  return {
    path: graphPath,
    graph: {
      version: Number(graph.version) || 1,
      instances: graph.instances && typeof graph.instances === "object" && !Array.isArray(graph.instances) ? graph.instances : {},
      edges: Array.isArray(graph.edges) ? graph.edges : [],
      ui: graph.ui && typeof graph.ui === "object" ? graph.ui : { nodePositions: {} },
    },
  };
}

const DISPLAY_SHARE_FILENAME = "display-shares.json";
const DISPLAY_SHARE_TTL_MS = 24 * 60 * 60 * 1000;

function displaySharesPath() {
  return path.join(getAgentflowDataRoot(), DISPLAY_SHARE_FILENAME);
}

function readDisplayShares() {
  const file = displaySharesPath();
  if (!fs.existsSync(file)) return {};
  const raw = fs.readFileSync(file, "utf-8");
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
}

function writeDisplayShares(shares) {
  const file = displaySharesPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(shares && typeof shares === "object" ? shares : {}, null, 2) + "\n", "utf-8");
}

function createDisplayShareId() {
  return crypto.randomBytes(12).toString("base64url");
}

function displayShareExpiresAt(now = new Date()) {
  const time = now instanceof Date ? now.getTime() : Date.now();
  return new Date(time + DISPLAY_SHARE_TTL_MS).toISOString();
}

function isDisplayShareExpired(share) {
  const expiresAt = Date.parse(String(share?.expiresAt || ""));
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function getDisplayShareOrExpired(id) {
  const shares = readDisplayShares();
  const share = shares[id];
  if (!share) return { shares, share: null, expired: false };
  if (!isDisplayShareExpired(share)) return { shares, share, expired: false };
  delete shares[id];
  writeDisplayShares(shares);
  return { shares, share: null, expired: true };
}

function normalizeDisplayShareNodeIds(ids, graph) {
  const out = [];
  const seen = new Set();
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  for (const rawId of Array.isArray(ids) ? ids : []) {
    const id = String(rawId || "").trim();
    if (!id || seen.has(id)) continue;
    const instance = instances[id];
    if (!workspaceDisplayKind(instance?.definitionId)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function publicDisplayPayloadFromShare(root, share) {
  const scoped = resolveWorkspaceScopeRoot(root, {
    flowId: share.flowId || "",
    flowSource: share.flowSource || "user",
    archived: share.archived === true,
  }, { userId: share.userId || "" });
  if (scoped.error) return { error: scoped.error };
  const { graph } = readWorkspaceGraph(scoped.root);
  const instances = graph.instances || {};
  const displayPage = graph.ui && typeof graph.ui === "object" && graph.ui.displayPage && typeof graph.ui.displayPage === "object"
    ? graph.ui.displayPage
    : {};
  const sharedNodeIds = normalizeDisplayShareNodeIds(share.nodeIds, graph);
  const hasDisplayPageNodeIds = Array.isArray(displayPage.nodeIds);
  const displayPageNodeIds = normalizeDisplayShareNodeIds(displayPage.nodeIds, graph);
  const nodeIds = share.layout === "canvas" && hasDisplayPageNodeIds
    ? displayPageNodeIds
    : sharedNodeIds;
  const displayPageSizes = displayPage.nodeSizes && typeof displayPage.nodeSizes === "object" ? displayPage.nodeSizes : {};
  const displayPagePositions = displayPage.nodePositions && typeof displayPage.nodePositions === "object" ? displayPage.nodePositions : {};
  const displayPageViewport = displayPage.viewport && typeof displayPage.viewport === "object"
    ? displayPage.viewport
    : null;
  const workspaceSizes = graph.ui && typeof graph.ui === "object" && graph.ui.nodeSizes && typeof graph.ui.nodeSizes === "object"
    ? graph.ui.nodeSizes
    : {};
  const workspacePositions = graph.ui && typeof graph.ui === "object" && graph.ui.nodePositions && typeof graph.ui.nodePositions === "object"
    ? graph.ui.nodePositions
    : {};
  const nodes = nodeIds.map((id) => {
    const instance = instances[id] || {};
    const definitionId = String(instance.definitionId || "");
    const kind = workspaceDisplayKind(definitionId);
    const rawBody = String(instance.body || "");
    const filePath = workspaceDisplayTextFilePath(rawBody, kind);
    let body = rawBody;
    if (filePath) {
      const resolved = resolveWorkspaceFilePath(scoped.root, filePath);
      if (resolved.rel && fs.existsSync(resolved.abs) && fs.statSync(resolved.abs).isFile()) {
        body = fs.readFileSync(resolved.abs, "utf-8");
      }
    }
    return {
      id,
      definitionId,
      kind,
      label: String(instance.label || instance.displayName || id),
      body,
      inputs: Array.isArray(instance.input) ? instance.input : [],
      outputs: Array.isArray(instance.output) ? instance.output : [],
      size: displayPageSizes[id] || workspaceSizes[id] || null,
      position: displayPagePositions[id] || workspacePositions[id] || null,
    };
  });
  return {
    ok: true,
    share: {
      id: share.id,
      title: share.title || "AgentFlow Display",
      layout: share.layout || "gallery",
      flowId: share.flowId || "",
      flowSource: share.flowSource || "user",
      archived: share.archived === true,
      nodeIds,
      viewport: displayPageViewport &&
        Number.isFinite(Number(displayPageViewport.x)) &&
        Number.isFinite(Number(displayPageViewport.y)) &&
        Number.isFinite(Number(displayPageViewport.zoom))
        ? { x: Number(displayPageViewport.x), y: Number(displayPageViewport.y), zoom: Number(displayPageViewport.zoom) }
        : null,
      createdAt: share.createdAt || "",
      updatedAt: share.updatedAt || "",
      expiresAt: share.expiresAt || "",
    },
    nodes,
  };
}

function normalizeWorkspaceGraphPayload(payload) {
  const graph = payload?.graph && typeof payload.graph === "object" ? payload.graph : payload;
  return {
    version: 1,
    instances: graph?.instances && typeof graph.instances === "object" && !Array.isArray(graph.instances) ? graph.instances : {},
    edges: Array.isArray(graph?.edges) ? graph.edges : [],
    ui: graph?.ui && typeof graph.ui === "object" ? graph.ui : { nodePositions: {} },
    updatedAt: new Date().toISOString(),
  };
}

function workspaceRunTouchedNodeIds(result) {
  const ids = new Set();
  for (const id of Array.isArray(result?.order) ? result.order : []) {
    const text = String(id || "").trim();
    if (text) ids.add(text);
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

function mergeWorkspaceRunGraph(currentGraph, runGraph, touchedIds) {
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

function resolveWorkspaceScopeRoot(workspaceRoot, params = {}, opts = {}) {
  const flowId = params.flowId != null ? String(params.flowId).trim() : "";
  if (!flowId) return { root: path.resolve(workspaceRoot), flowId: "", flowSource: "", archived: false };
  const flowSource = params.flowSource != null && String(params.flowSource).trim()
    ? String(params.flowSource).trim()
    : "user";
  const archived = params.archived === true || params.archived === "1" || params.flowArchived === true;
  if (!isValidFlowSourceRead(flowSource)) {
    return { root: "", error: "Invalid flowSource" };
  }
  const result = getPipelineFiles(workspaceRoot, flowId, flowSource, archived, opts);
  if (result.error || !result.path) {
    return { root: "", error: result.error || "Pipeline workspace not found" };
  }
  return { root: path.resolve(result.path), flowId, flowSource, archived };
}

function workspaceSearchGuardrailsBlock() {
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

function buildWorkspaceGeneratePrompt(payload) {
  const userPrompt = String(payload?.prompt || "").trim();
  const outputKind = String(payload?.outputKind || payload?.kind || "markdown").trim().toLowerCase();
  const allowFlowYaml = payload?.allowFlowYaml === true || payload?.allowFlowYaml === "1";
  const workspaceGraph = payload?.workspaceGraph && typeof payload.workspaceGraph === "object" ? payload.workspaceGraph : null;
  const selectedNodeIds = Array.isArray(payload?.selectedNodeIds)
    ? payload.selectedNodeIds.map((id) => String(id || "").trim()).filter(Boolean)
    : [];
  const skillsBlock = typeof payload?.skillsBlock === "string" ? payload.skillsBlock.trim() : "";
  const contexts = Array.isArray(payload?.contexts) ? payload.contexts : [];
  const contextBlocks = contexts
    .map((ctx, idx) => {
      const title = String(ctx?.title || ctx?.path || `context-${idx + 1}`).trim();
      const kind = String(ctx?.kind || "text").trim();
      const content = String(ctx?.content || "").trim();
      if (!content) return "";
      return `### ${title} (${kind})\n\n${content}`;
    })
    .filter(Boolean)
    .join("\n\n---\n\n");
  const kindInstruction =
    outputKind === "mermaid"
      ? [
          "你是 workspace Mermaid 图节点的内容生成器。",
          "请根据用户 prompt 和上游节点/文件上下文生成 Mermaid flowchart 源码。",
          "只输出 Mermaid 源码，不要解释，不要包裹 Markdown 代码围栏。",
          "优先使用 `flowchart TD` 或 `graph TD`，节点 ID 使用简单英文/数字/下划线，节点 label 使用清晰短文本。",
        ].join("\n")
      : outputKind === "ascii"
        ? [
            "你是 workspace ASCII 图节点的内容生成器。",
            "请根据用户 prompt 和上游节点/文件上下文生成等宽字体下可读的 ASCII 图。",
            "只输出 ASCII 图正文，不要解释，不要包裹 Markdown 代码围栏。",
            "使用 +-|/\\<> 等字符表达结构，尽量保持对齐。",
          ].join("\n")
        : [
            "你是 AgentFlow Workspace Composer。",
            "默认以用户当前选择的 workspace 节点作为上下文范围；选中节点不是让你重建整张画布的授权。",
            "默认不要修改 workspace.graph.json，不要新增/删除/重连画布节点；只有当用户明确要求“更新画布、加节点、改连线、展示成节点、生成流程”时，才编辑 workspace.graph.json。",
            "如果用户请求生成或恢复文档/文件，可以直接在 workspace 文件系统中完成，最终只输出简短结果：改了什么、路径在哪里、是否需要下一步。",
            "不要在最终回答中列出过程性步骤，例如“先查看结构”“继续检索”“正在生成”；这些属于执行过程，不属于最终结果。",
          ].join("\n");
  return [
    "你正在 AgentFlow 的 Workspace 工作画布中执行任务。",
    "Workspace 是当前 pipeline 的临时工作区，用于分析、试验、生成中间文件和展示结果。",
    "Workspace 与 Pipeline 各自有独立的 Skill collection；此处只使用当前 Workspace Composer 选择的 collections / skills 作为本次行为规则与编辑依据。",
    "当 Skills 提到修改 flow.yaml / instances / edges / ui 时，在 Workspace 视图下应映射为修改当前工作区的 workspace.graph.json，除非用户显式勾选并要求修改正式 flow.yaml。",
    "workspace.graph.json 使用 JSON：{ version, instances, edges, ui: { nodePositions, nodeSizes } }。instances 的结构与 flow.yaml instances 一致；edges 使用 source/target/sourceHandle/targetHandle；ui.nodePositions 记录节点坐标，ui.nodeSizes 记录用户调整过的节点宽高。",
    allowFlowYaml
      ? "用户已允许你考虑正式 flow.yaml；如需修改仍必须明确说明影响。"
      : "默认不要修改正式 flow.yaml；优先在 workspace 文件、workspace.graph.json 或回复内容中完成任务。",
    workspaceSearchGuardrailsBlock(),
    workspaceGraph ? `\n## 当前 workspace graph\n\n${JSON.stringify(workspaceGraph, null, 2)}` : "",
    selectedNodeIds.length > 0 ? `\n## 当前用户选中的 workspace 节点\n\n${selectedNodeIds.map((id) => `- ${id}`).join("\n")}` : "",
    skillsBlock ? `\n## Selected Skills\n\n${skillsBlock}` : "",
    kindInstruction,
    contextBlocks ? `\n## 上下文\n\n${contextBlocks}` : "",
    `\n## 用户 prompt\n\n${userPrompt}`,
  ].filter(Boolean).join("\n");
}

function buildWorkspaceNodeChatPrompt(payload) {
  const node = payload?.node && typeof payload.node === "object" ? payload.node : {};
  const userMessage = String(payload?.message || "").trim();
  const currentContent = String(payload?.currentContent || "").trim();
  const nodeKind = String(payload?.nodeKind || payload?.kind || "markdown").trim().toLowerCase();
  const sourceContext = String(payload?.sourceContext || "").trim();
  const targetFilePath = String(payload?.targetFilePath || "").trim();
  const directFileEdit = Boolean(targetFilePath);
  const history = Array.isArray(payload?.messages) ? payload.messages : [];
  const historyBlock = history
    .slice(-8)
    .map((msg) => {
      const role = String(msg?.role || "user").trim() === "assistant" ? "assistant" : "user";
      const text = String(msg?.text || "").trim();
      return text ? `${role}: ${text}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
  const outputRule = directFileEdit
    ? [
        `直接修改当前 workspace 内的文件：${targetFilePath}`,
        "必须使用可用的文件编辑工具实际写入该文件；不要只描述改法。",
        "不要把完整文件内容输出到聊天回复。",
        "完成后只输出一句简短中文确认；如果无法完成，只输出原因，且说明文件未修改。",
      ].join("\n")
    : nodeKind === "html"
      ? "只输出完整或片段 HTML，不要解释，不要包裹 Markdown 代码围栏。"
      : nodeKind === "image"
        ? "只输出新的图片 src，可以是 URL、data URL 或文件路径，不要解释。"
        : nodeKind === "mermaid"
          ? "只输出 Mermaid 源码，不要解释，不要包裹 Markdown 代码围栏。"
          : nodeKind === "ascii"
            ? "只输出 ASCII 正文，不要解释，不要包裹 Markdown 代码围栏。"
            : "只输出新的 Markdown 正文，不要解释，不要包裹 Markdown 代码围栏。";
  return [
    "你正在微调 AgentFlow Workspace 画布中的单个展示节点。",
    directFileEdit
      ? "根据用户 follow-up 直接编辑该展示节点引用的 artifact 文件。"
      : "根据用户 follow-up 和当前节点内容，生成一个可直接替换当前节点展示内容的候选版本。",
    "上下文只来自当前展示内容、直接上游节点任务和本节点对话历史；不要引用或复述 thinking、运行日志、下游展示内容。",
    outputRule,
    "",
    "## 当前节点",
    `- id: ${String(node.id || "").trim() || "(unknown)"}`,
    `- label: ${String(node.label || "").trim() || "(unnamed)"}`,
    `- definitionId: ${String(node.definitionId || "").trim() || "(unknown)"}`,
    `- kind: ${nodeKind}`,
    targetFilePath ? `- artifactFile: ${targetFilePath}` : "",
    sourceContext ? `\n## 生成该展示的直接上游上下文（不含 thinking/log）\n\n${sourceContext}` : "",
    !directFileEdit && currentContent ? `\n## 当前展示内容\n\n${currentContent}` : "",
    historyBlock ? `\n## 本节点对话历史\n\n${historyBlock}` : "",
    `\n## 用户 follow-up\n\n${userMessage}`,
  ].filter(Boolean).join("\n");
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

function workspaceOutputSlotValueForEdge(graph, outputs, edge) {
  const sourceId = String(edge?.source || "");
  const slot = workspaceSourceSlotForEdge(graph, edge);
  if (isWorkspaceSemanticOutputSlot(slot)) return "";
  const out = outputs.get(sourceId);
  const sourceIndex = workspaceHandleIndex(edge?.sourceHandle, "output");
  const slotName = String(slot?.name || "").trim();
  const isPrimaryOutput = !slot || slotName === "result" || slotName === "content" || sourceIndex === 0;
  if (isPrimaryOutput && out != null && String(out).trim()) return String(out);
  if (slot && String(slot?.type || "") !== "node") {
    const value = workspaceSlotValue(slot);
    if (value.trim()) return value;
  }
  if (out != null && String(out).trim()) return String(out);
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  return workspaceInstanceText(instances[sourceId]);
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

function workspaceStructuredAgentOutput(content) {
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
      if (name === "result" || name === "content" || index === 0) {
        value = text;
      } else if (Object.prototype.hasOwnProperty.call(structured.outParams, name)) {
        value = structured.outParams[name];
      } else if (Object.prototype.hasOwnProperty.call(structured.outParams, `${name}File`)) {
        value = structured.outParams[`${name}File`];
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
  if (id === "display_mermaid") return "mermaid";
  if (id === "display_ascii") return "ascii";
  if (id === "display_html") return "html";
  if (id === "display_image") return "image";
  if (id === "display_chart") return "chart";
  if (id === "display_table") return "table";
  return "";
}

function workspaceDisplayTextFilePath(value, kind = "") {
  const text = String(value || "").trim();
  if (!text || text.length > 260) return "";
  if (/[\r\n<>]/.test(text)) return "";
  if (/^(?:https?:|data:|blob:|file:|javascript:|mailto:|tel:)/i.test(text)) return "";
  const clean = text.replace(/^\/+/, "");
  if (clean.includes("..") || clean.startsWith(".")) return "";
  const ext = clean.split("?")[0].split("#")[0].toLowerCase().split(".").pop() || "";
  const allowedByKind = {
    html: new Set(["html", "htm"]),
    markdown: new Set(["md", "markdown", "txt"]),
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

function workspacePublishNodeOutputFile(runPackage, relPath) {
  if (!String(relPath || "").trim()) return "";
  const clean = workspaceSafeNodeOutputRelPath(relPath);
  if (!clean) throw new Error(`Agent returned an invalid output file path: ${String(relPath || "").trim()}`);
  const nodeRunDir = path.resolve(runPackage?.nodeRunDir || "");
  const workspaceOutputsDir = path.resolve(runPackage?.workspaceOutputsDir || "");
  if (!nodeRunDir || !workspaceOutputsDir) return clean;
  const src = path.resolve(nodeRunDir, clean);
  const nodeRootWithSep = nodeRunDir.endsWith(path.sep) ? nodeRunDir : `${nodeRunDir}${path.sep}`;
  if (src !== nodeRunDir && !src.startsWith(nodeRootWithSep)) {
    throw new Error(`Invalid node output path: ${clean}`);
  }
  if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
    throw new Error(`Agent returned resultFile but did not create it under node outputs: ${clean}`);
  }
  const nodePart = workspaceSanitizeTmpSegment(runPackage?.nodeId || "node", "node");
  const destRel = clean.slice("outputs/".length).replace(/^\/+/, "");
  const publishedRel = path.posix.join("outputs", nodePart, ...destRel.split("/").filter(Boolean));
  const dest = path.resolve(workspaceOutputsDir, nodePart, ...destRel.split("/").filter(Boolean));
  const workspaceOutputsWithSep = workspaceOutputsDir.endsWith(path.sep) ? workspaceOutputsDir : `${workspaceOutputsDir}${path.sep}`;
  if (dest !== workspaceOutputsDir && !dest.startsWith(workspaceOutputsWithSep)) {
    throw new Error(`Invalid workspace output path: ${clean}`);
  }
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  return publishedRel;
}

function workspacePublishAgentOutputFiles(structured, runPackage) {
  if (!structured?.structured || !runPackage) return structured;
  const resultFile = workspacePublishNodeOutputFile(runPackage, structured.resultFile);
  const outParams = { ...(structured.outParams || {}) };
  for (const [key, value] of Object.entries(outParams)) {
    if (!String(key || "").endsWith("File")) continue;
    const published = workspacePublishNodeOutputFile(runPackage, value);
    if (published) outParams[key] = published;
  }
  return resultFile || Object.keys(outParams).length
    ? { ...structured, result: resultFile || structured.result, resultFile: resultFile || structured.resultFile, outParams }
    : structured;
}

function workspaceOutputFieldForSlot(slot, index = 0) {
  const name = String(slot?.name || "").trim();
  if (!name || name === "result" || name === "content" || index === 0) return "result";
  return `outParams.${name}`;
}

function workspaceDisplayKindExample(kind, field) {
  if (kind === "table") return { columns: ["列名1", "列名2"], rows: [["值1", "值2"]] };
  if (kind === "chart") return { type: "chart", version: "1.0", renderer: "echarts", option: { xAxis: { type: "category", data: [] }, yAxis: { type: "value" }, series: [{ type: "bar", data: [] }] } };
  if (kind === "html") return "<可直接渲染的 HTML>";
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
    const name = String(slot?.name || "").trim() || (index === 0 ? "result" : `output-${index}`);
    bindings.push({
      kind,
      index,
      name,
      field: workspaceOutputFieldForSlot(slot, index),
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

function workspaceBodyPlaceholderNames(body) {
  const names = new Set();
  const raw = String(body || "");
  raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_-]*)\}/g, (_match, name) => {
    if (name) names.add(String(name));
    return _match;
  });
  return names;
}

function workspaceRelevantInputValues(body, inputValues = {}) {
  const placeholders = workspaceBodyPlaceholderNames(body);
  if (!placeholders.size) return { values: inputValues || {}, placeholders };
  const values = {};
  for (const [name, value] of Object.entries(inputValues || {})) {
    if (placeholders.has(name)) values[name] = value;
  }
  return { values, placeholders };
}

function workspaceOutputProtocolRequirements(graph, nodeId) {
  const instance = graph?.instances?.[nodeId] || {};
  const outputSlots = Array.isArray(instance.output) ? instance.output : [];
  const displayBindings = workspaceDownstreamOutputDisplayBindings(graph, nodeId);
  const displayByField = new Map();
  for (const binding of displayBindings) {
    if (!displayByField.has(binding.field)) displayByField.set(binding.field, binding.kind);
  }
  const slots = outputSlots
    .filter((slot) => {
      const name = String(slot?.name || "").trim();
      const type = String(slot?.type || "");
      return name && type !== "node" && name !== "next" && name !== "result" && name !== "content";
    })
    .map((slot) => String(slot.name).trim());
  const resultKind = displayByField.get("result") || "";
  const resultExtByKind = {
    html: "html",
    markdown: "md",
    mermaid: "mmd",
    ascii: "txt",
    chart: "json",
    table: "json",
  };
  const resultExt = resultExtByKind[resultKind] || "txt";
  const resultFile = `outputs/result.${resultExt}`;
  const resultKindText = resultKind ? ` ${resultKind}` : "";
  const resultGuidance = {
    html: "内容必须是可直接放入 iframe 渲染的 HTML；不要使用 Markdown 代码围栏。",
    markdown: "内容必须是 Markdown 正文；除非正文确实需要代码块，否则不要额外包裹代码围栏。",
    mermaid: "内容必须是 Mermaid 图表代码，例如 flowchart/sequenceDiagram；不要使用 Markdown 代码围栏。",
    ascii: "内容必须是纯文本/ASCII 图或表格；不要输出 HTML 或 Markdown 装饰。",
    image: "内容必须是可作为 img src 使用的图片地址、data URL 或 base64 data URL；不要输出 Markdown 图片语法。",
    chart: "内容必须是 ChartSpec JSON 对象，包含 type/version/renderer/option；不要输出 HTML、script、iframe 或 JS 函数。",
    table: "内容必须是表格数据，推荐 JSON：{\"columns\":[...],\"rows\":[...]}；不要输出 HTML。",
  }[resultKind] || "内容应满足任务要求。";
  const envelopeExample = [
    "---agentflow",
    `resultFile: ${resultFile}`,
    slots.length ? "outParams:" : "",
    ...slots.slice(0, 3).map((name) => {
      const kind = displayByField.get(`outParams.${name}`) || "";
      const ext = resultExtByKind[kind] || "txt";
      return kind ? `  ${name}File: outputs/${name}.${ext}` : `  ${name}: <${name} 的短值>`;
    }),
    "---end",
  ].filter(Boolean).join("\n");
  return [
    "## 输出",
    "",
    `请把${resultKindText}结果写入 \`${resultFile}\`。${resultGuidance}`,
    ...(slots.length ? [`额外输出：${slots.map((name) => `\`${name}\``).join("、")}。短值可写在 \`outParams\`，文件值写成 \`outParams.<name>File\`。`] : []),
    "最终只输出下面的 agentflow envelope，不要输出解释、进度或其它文字：",
    "",
    envelopeExample,
  ].join("\n");
}

function workspaceRunPlan(graph, runNodeId, scopedRoot = "") {
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
    if (id !== target && defId === "workspace_run") {
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
  visitControlDownstream(target);
  needed.delete(target);
  const dependencyQueue = Array.from(needed);
  for (let i = 0; i < dependencyQueue.length; i++) {
    const id = dependencyQueue[i];
    for (const edge of incoming.get(id) || []) {
      const source = String(edge?.source || "");
      if (!source || source === target || needed.has(source)) continue;
      if (!workspaceNeedsUpstreamExecutionForEdge(graph, edge, scopedRoot)) continue;
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

function workspaceNeedsUpstreamExecutionForEdge(graph, edge, scopedRoot = "") {
  if (workspaceIsControlEdge(graph, edge)) return true;
  return !workspaceEdgeHasCachedOutput(graph, edge, scopedRoot);
}

function workspaceEdgeHasCachedOutput(graph, edge, scopedRoot = "") {
  const sourceId = String(edge?.source || "");
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  const source = instances[sourceId];
  if (!source) return false;
  const slot = workspaceSourceSlotForEdge(graph, edge);
  if (!isWorkspaceSemanticOutputSlot(slot) && slot && String(slot?.type || "") !== "node") {
    const value = workspaceSlotValue(slot);
    if (workspaceCachedOutputValueExists(value, scopedRoot)) return true;
  }
  const defId = String(source.definitionId || "");
  if (workspaceDisplayKind(defId) && String(source.body || "").trim()) return true;
  if (defId === "provide_str" || defId === "provide_bool" || defId === "provide_file") {
    return Boolean(String(workspaceInstanceText(source) || "").trim());
  }
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

function workspaceUpstreamText(graph, nodeId, outputs) {
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const incoming = edges
    .filter((edge) => String(edge?.target || "") === String(nodeId))
    .filter((edge) => !isWorkspaceSemanticInputSlot(workspaceTargetSlotForEdge(graph, edge)));
  const contentEdge = incoming.find((edge) => String(edge?.targetHandle || "") === "input-1") || incoming[0];
  if (!contentEdge) return "";
  return workspaceOutputSlotValueForEdge(graph, outputs, contentEdge);
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
  return type === "node" || name === "prev" || name === "next" || name === "skillsContext" || name === "mcpContext" || name === "workspaceContext" || name === "gitContext";
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
  const outputsRel = String(runPackage?.outputsRel || "outputs").trim() || "outputs";
  if (!nodeRunDir && !nodeTmpDir) return "";
  return [
    "## 文件边界",
    "",
    nodeRunDir ? `- 当前执行目录：\`${nodeRunDir}\`。` : "",
    nodeTmpDir ? `- 临时文件只能写入：\`${nodeTmpDir}\`，也可通过环境变量 \`AGENTFLOW_NODE_TMP_DIR\` 获取。` : "",
    Object.keys(runPackage?.inputMounts || {}).length ? "- 已挂载的输入文件位于本任务 `inputs/`；`inputs/` 只用于读取，正式产物仍写入 `outputs/`。" : "",
    `- 正式产物写入本任务 \`${outputsRel}/\`，例如 \`${outputsRel}/result.html\`、\`${outputsRel}/result.md\`；返回时仍使用 \`${outputsRel}/...\` 相对路径。`,
    "- 不要在执行目录根部创建 `temp_*`、`_out.json`、`tmp.html` 等临时产物。",
    "- 不要自行删除 run package；AgentFlow 会在运行结束后统一清理。",
  ].filter(Boolean).join("\n");
}

function workspaceTaskUpstreamText(graph, nodeId, outputs, relevantInputNames = null) {
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
  return workspaceOutputSlotValueForEdge(graph, outputs, contentEdge);
}

function workspaceInputValues(graph, nodeId, outputs) {
  const values = {};
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  const target = instances[String(nodeId || "")] || {};
  const inputSlots = Array.isArray(target.input) ? target.input : [];
  for (const edge of edges) {
    if (String(edge?.target || "") !== String(nodeId)) continue;
    const index = workspaceHandleIndex(edge?.targetHandle, "input");
    const slot = inputSlots[index] || null;
    const name = String(slot?.name || "").trim();
    if (!name || isWorkspaceSemanticInputSlot(slot)) continue;
    const value = workspaceOutputSlotValueForEdge(graph, outputs, edge);
    if (String(value || "").trim()) values[name] = String(value);
  }
  for (const slot of inputSlots) {
    const name = String(slot?.name || "").trim();
    if (!name || isWorkspaceSemanticInputSlot(slot) || Object.prototype.hasOwnProperty.call(values, name)) continue;
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
  const slots = [...(Array.isArray(instance?.input) ? instance.input : []), ...(Array.isArray(instance?.output) ? instance.output : [])];
  const slot = slots.find((item) => item?.name === "skillsContext") || slots.find((item) => item?.name === "skillKeys");
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

function workspaceWriteDisplayContent(instance, content) {
  const next = { ...(instance || {}) };
  const kind = workspaceDisplayKind(next.definitionId);
  const unwrapped = workspaceUnwrapOutputEnvelopeForDisplay(content);
  const text = kind === "html" ? normalizeHtmlDisplayContent(unwrapped) : String(unwrapped || "");
  const primaryName = kind === "image" ? "src" : "content";
  next.body = text;
  next.input = (Array.isArray(next.input) ? next.input : []).map((slot) => (
    String(slot?.name || "") === primaryName || String(slot?.type || "") === "text"
      ? { ...slot, default: text, value: text }
      : slot
  ));
  next.output = (Array.isArray(next.output) ? next.output : []).map((slot) => (
    String(slot?.name || "") === primaryName || String(slot?.type || "") === "text"
      ? { ...slot, default: text, value: text }
      : slot
  ));
  return next;
}

function workspaceUnwrapOutputEnvelopeForDisplay(content) {
  const raw = String(content || "").trim();
  if (!raw) return "";
  if (!/---agentflow\b|["']result["']\s*:|["']outParams["']\s*:|["']resultFile["']\s*:/i.test(raw)) return raw;
  const structured = workspaceStructuredAgentOutput(raw);
  return structured.structured ? String(structured.result || "") : raw;
}

function workspaceUpdateDirectDisplays(graph, sourceId, content, outputs = null) {
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const updated = [];
  for (const edge of edges) {
    if (String(edge?.source || "") !== String(sourceId)) continue;
    if (isWorkspaceSemanticInputSlot(workspaceTargetSlotForEdge(graph, edge))) continue;
    const targetId = String(edge?.target || "");
    const target = instances[targetId];
    if (!target || !workspaceDisplayKind(target.definitionId)) continue;
    const value = outputs ? workspaceOutputSlotValueForEdge(graph, outputs, edge) : String(content || "");
    instances[targetId] = workspaceWriteDisplayContent(target, value || content);
    updated.push(targetId);
  }
  return updated;
}

function workspaceNodePrompt(graph, nodeId, upstreamText, skillsBlock, mcpBlock = "", inputValues = {}, nodeTmpDir = "") {
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
    inputBlock ? `\n${inputBlock}` : "",
    placeholders.size ? "\n任务只显式引用了上面的输入槽；其它未被 `${...}` 引用的已连接业务输入不要作为分析依据。" : "",
    skillsBlock ? `\n## 可用能力\n\n${skillsBlock}` : "",
    mcpBlock ? `\n## 可用 MCP\n\n${mcpBlock}` : "",
    upstreamText ? `\n## 上游正文\n\n${upstreamText}` : "",
    outputProtocolRequirements ? `\n${outputProtocolRequirements}` : "",
    `\n## 任务\n\n${body || upstreamText}`,
  ].filter(Boolean).join("\n");
}

function workspaceDefaultWorktreeRoot(scopedRoot) {
  return path.join(path.resolve(scopedRoot), ".workspace", "agentflow", "worktrees");
}

function workspaceShouldAutoCleanupWorktree(scopedRoot, worktreePath, hasExplicitWorktreePath) {
  if (hasExplicitWorktreePath || !worktreePath) return false;
  return workspacePathInside(workspaceDefaultWorktreeRoot(scopedRoot), worktreePath);
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

function workspaceCleanupAutoWorktrees(list, graph, emit) {
  for (const entry of [...list].reverse()) {
    try {
      const result = unloadGitWorktree({
        repoPath: entry.repoPath,
        worktreePath: entry.worktreePath,
        force: false,
        prune: true,
      });
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
      emit({
        type: "natural",
        kind: "warning",
        nodeId: entry.nodeId,
        text: `临时 worktree 未自动清理：${entry.worktreePath}\n原因：${e?.message || String(e)}`,
      });
    }
  }
  list.splice(0, list.length);
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

function workspaceCreateNodeRunPackage(runTmpRoot, nodeId, { scopedRoot, task = "", inputValues = {}, skillsBlock = "", mcpBlock = "" } = {}) {
  const nodeRunDir = workspaceCreateNodeTmpDir(runTmpRoot, nodeId);
  const nodeTmpDir = path.join(nodeRunDir, "tmp");
  const outputsDir = path.join(nodeRunDir, "outputs");
  const workspaceRoot = path.resolve(scopedRoot);
  const workspaceOutputsDir = path.join(workspaceRoot, "outputs");
  fs.mkdirSync(nodeTmpDir, { recursive: true });
  fs.mkdirSync(outputsDir, { recursive: true });
  fs.mkdirSync(workspaceOutputsDir, { recursive: true });
  const manifest = {
    version: 1,
    nodeId: String(nodeId || ""),
    nodeRunDir,
    nodeTmpDir,
    outputsDir,
    workspaceRoot,
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
    workspaceOutputsDir,
    outputsRel: "outputs",
    inputValues: runtimeInputValues,
    inputMounts: materializedInputs.mounts,
  };
}

function workspaceMaterializeNodeInputFiles(nodeRunDir, workspaceRoot, inputValues = {}) {
  const values = {};
  const mounts = {};
  for (const [name, value] of Object.entries(inputValues || {})) {
    const slotName = String(name || "").trim();
    if (!slotName) continue;
    const rel = workspaceInputFileRelPath(value);
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

async function runWorkspaceGraph(root, scopedRoot, payload, userCtx = {}, opts = {}) {
  const graph = normalizeWorkspaceGraphPayload(payload.graph || {});
  const runNodeId = String(payload?.runNodeId || "").trim();
  const { order, pauseNodeIds } = workspaceRunPlan(graph, runNodeId, scopedRoot);
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
  const modelKey = typeof payload?.model === "string" ? payload.model.trim() : "";
  const autoCleanupWorktrees = [];
  const runTmpRoot = workspaceCreateRunTmpRoot(scopedRoot, runNodeId);

  try {
  for (const nodeId of order) {
    throwIfAborted();
    const instance = graph.instances[nodeId];
    if (!instance) continue;
    const defId = String(instance.definitionId || "");
    emit({ type: "node-start", nodeId, definitionId: defId });

    if (defId === "workspace_run") {
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
      outputs.set(nodeId, skillsBlock);
      workspaceUpdateDirectDisplays(graph, nodeId, skillsBlock, outputs);
      emit({ type: "graph", nodeId, graph });
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
      outputs.set(nodeId, mcpBlock);
      workspaceUpdateDirectDisplays(graph, nodeId, mcpBlock, outputs);
      emit({ type: "graph", nodeId, graph });
      emit({ type: "node-done", nodeId, definitionId: defId });
      continue;
    }

    if (workspaceDisplayKind(defId)) {
      const content = workspaceUpstreamText(graph, nodeId, outputs);
      graph.instances[nodeId] = workspaceWriteDisplayContent(instance, content);
      outputs.set(nodeId, content);
      emit({ type: "graph", nodeId, graph });
      emit({ type: "node-done", nodeId, definitionId: defId });
      continue;
    }

    if (defId === "provide_str") {
      const content = workspaceInstanceText(instance);
      outputs.set(nodeId, content);
      emit({ type: "node-done", nodeId, definitionId: defId });
      continue;
    }

    if (defId === "provide_bool") {
      const raw = workspaceSlotValue(Array.isArray(instance.output) ? instance.output[0] : null) || workspaceInstanceText(instance);
      const content = ["true", "1", "yes", "on"].includes(String(raw || "").trim().toLowerCase()) ? "true" : "false";
      outputs.set(nodeId, content);
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
      outputs.set(nodeId, content);
      emit({ type: "node-done", nodeId, definitionId: defId });
      continue;
    }

    if (defId === "control_cd_workspace") {
      const inputText = workspaceUpstreamText(graph, nodeId, outputs);
      const inputSlots = Array.isArray(instance.input) ? instance.input : [];
      const pathSlot = inputSlots.find((slot) => String(slot?.name || "") === "path") ||
        inputSlots.find((slot) => String(slot?.name || "") === "target");
      const candidate = workspaceSlotValue(pathSlot) || workspaceInstanceText(instance) || inputText;
      const abs = candidate ? path.resolve(scopedRoot, candidate) : scopedRoot;
      if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) cwd = abs;
      outputs.set(nodeId, cwd);
      emit({ type: "node-done", nodeId, definitionId: defId });
      continue;
    }

    if (defId === "control_user_workspace") {
      cwd = path.resolve(os.homedir());
      outputs.set(nodeId, cwd);
      emit({ type: "node-done", nodeId, definitionId: defId });
      continue;
    }

    if (defId === "tool_git_checkout") {
      const repoUrl = workspaceSlotValue(workspaceSlotByName(instance, "repoUrl")).trim();
      if (!repoUrl) throw new Error("Git Checkout requires repoUrl");
      const branch = workspaceSlotValue(workspaceSlotByName(instance, "branch")).trim();
      const targetRaw = workspaceSlotValue(workspaceSlotByName(instance, "targetDir")).trim();
      const targetDir = targetRaw
        ? workspaceResolvePath(cwd, targetRaw)
        : path.join(scopedRoot, ".workspace", "agentflow", "git-repos", workspaceSanitizeRepoDirName(repoUrl));
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
      outputs.set(nodeId, targetDir);
      emit({ type: "graph", nodeId, graph });
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
      const worktreePath = rawWorktreePath ? workspaceResolvePath(cwd, rawWorktreePath) : (gitContext?.worktreePath ? path.resolve(gitContext.worktreePath) : "");
      const hasExplicitWorktreePath = Boolean(rawWorktreePath) || Boolean(gitContext?.worktreePath);
      const previousCwd = cwd;
      const force = ["true", "1", "yes", "on"].includes(workspaceSlotValue(workspaceSlotByName(instance, "force")).trim().toLowerCase());
      const pruneMissingRaw = workspaceSlotValue(workspaceSlotByName(instance, "pruneMissing")).trim().toLowerCase();
      const pruneMissing = pruneMissingRaw !== "false";
      const result = loadGitWorktree({ repoPath, branch, worktreePath, pipelineWorkspace: scopedRoot, force, pruneMissing });
      if (workspaceShouldAutoCleanupWorktree(scopedRoot, result.worktreePath, hasExplicitWorktreePath)) {
        workspaceTrackAutoCleanupWorktree(autoCleanupWorktrees, {
          nodeId,
          repoPath: result.repoRoot,
          worktreePath: result.worktreePath,
        });
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
      outputs.set(nodeId, result.worktreePath);
      emit({ type: "graph", nodeId, graph });
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
      outputs.set(nodeId, result.message);
      emit({ type: "graph", nodeId, graph });
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
      }, runtimeEnvForUser(userCtx));
      let nextInstance = workspaceSetOutputSlot(instance, "mrUrl", result.mrUrl);
      nextInstance = workspaceSetOutputSlot(nextInstance, "created", result.created ? "true" : "false");
      nextInstance = workspaceSetOutputSlot(nextInstance, "mrIid", result.mrIid ?? "");
      nextInstance = workspaceSetOutputSlot(nextInstance, "projectId", result.projectId ?? "");
      nextInstance = workspaceSetOutputSlot(nextInstance, "sourceBranch", result.sourceBranch ?? "");
      nextInstance = workspaceSetOutputSlot(nextInstance, "targetBranch", result.targetBranch ?? "");
      nextInstance = workspaceSetOutputSlot(nextInstance, "title", result.title ?? "");
      nextInstance = workspaceSetOutputSlot(nextInstance, "message", result.message ?? "");
      graph.instances[nodeId] = nextInstance;
      outputs.set(nodeId, result.mrUrl);
      emit({ type: "graph", nodeId, graph });
      emit({ type: "node-done", nodeId, definitionId: defId });
      continue;
    }

    const prepareStartedAt = Date.now();
    const inputValues = workspaceInputValues(graph, nodeId, outputs);
    const relevantInputs = workspaceRelevantInputValues(instance.body || "", inputValues);
    const upstreamText = workspaceTaskUpstreamText(graph, nodeId, outputs, relevantInputs.placeholders);
    const upstreamSkillBlocks = workspaceUpstreamSkillBlocks(graph, nodeId, outputs);
    const promptSkillsBlock = mergeWorkspaceSkillBlocks(upstreamSkillBlocks);
    const promptMcpBlock = workspaceUpstreamMcpBlocks(graph, nodeId, outputs);
    const runPackage = workspaceCreateNodeRunPackage(runTmpRoot, nodeId, {
      scopedRoot,
      cwd,
      task: workspaceResolveBodyPlaceholders(instance.body || "", inputValues).trim() || upstreamText,
      inputValues: relevantInputs.values,
      skillsBlock: promptSkillsBlock,
      mcpBlock: promptMcpBlock,
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
    const prompt = workspaceNodePrompt(graph, nodeId, promptUpstreamText, promptSkillsBlock, promptMcpBlock, runtimeInputValues, runPackage);
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
    let content = "";
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
          prompt,
          modelKey,
          agentflowUserId: userCtx.userId || "",
          extraEnv: {
            AGENTFLOW_WORKSPACE_TMP_ROOT: runTmpRoot,
            AGENTFLOW_NODE_RUN_DIR: runPackage.nodeRunDir,
            AGENTFLOW_NODE_TMP_DIR: runPackage.nodeTmpDir,
            AGENTFLOW_OUTPUTS_DIR: runPackage.outputsDir,
          },
          onStreamEvent: (ev) => {
            if (!firstAgentEventSeen) {
              firstAgentEventSeen = true;
              emitTiming(nodeId, "agent-first-event", spawnStartedAt, { attempt, firstType: ev?.type || "" });
            }
            const eventToEmit = (ev?.type === "natural" && (ev.kind === "result" || ev.kind === "assistant") && typeof ev.text === "string")
              ? { ...ev, text: workspaceCanonicalAgentOutput(ev.text), nodeId }
              : { ...ev, nodeId };
            emit(eventToEmit);
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
        if (typeof opts.onActiveChild === "function") opts.onActiveChild(handle.child || null);
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
    const normalizedAgentOutput = workspacePublishAgentOutputFiles(workspaceStructuredAgentOutput(content), runPackage);
    const resultContent = normalizedAgentOutput.result || content;
    outputs.set(nodeId, resultContent);
    const slotUpdate = workspaceApplyAgentOutputSlots(instance, normalizedAgentOutput);
    if (slotUpdate.changed) graph.instances[nodeId] = slotUpdate.instance;
    const updatedDisplays = workspaceUpdateDirectDisplays(graph, nodeId, resultContent, outputs);
    if (slotUpdate.changed || updatedDisplays.length) emit({ type: "graph", nodeId, displayNodeIds: updatedDisplays, graph });
    emit({ type: "node-done", nodeId, definitionId: defId });
  }
  } finally {
    workspaceCleanupAutoWorktrees(autoCleanupWorktrees, graph, emit);
    workspaceCleanupTmpRoot(runTmpRoot, userCtx, emit);
  }
  if (pauseNodeIds.length > 0) {
    emit({ type: "paused", nodeIds: pauseNodeIds, message: `Workspace run paused at ${pauseNodeIds.join(", ")}` });
  }
  graph.updatedAt = new Date().toISOString();
  return { graph, events, order, pauseNodeIds };
}

function isWorkspaceRunAbortError(err) {
  return err?.code === "WORKSPACE_RUN_ABORTED" || /Workspace run stopped/i.test(String(err?.message || ""));
}

function isTransientAgentNetworkError(err) {
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

function sleepMs(ms, signal = null) {
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

/** ZIP 本地头：PK\x03\x04 / \x05\x06 / \x07\x08 */
function bufferLooksLikeZip(buf) {
  return (
    buf.length >= 4 &&
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07) &&
    (buf[3] === 0x04 || buf[3] === 0x06 || buf[3] === 0x08)
  );
}

/**
 * @param {import('http').IncomingMessage} req
 * @returns {Promise<{ targetSpace: string, flowIdField: string, file: Buffer, filename: string, gotFile: boolean }>}
 */
function parseFlowsImportForm(req) {
  return new Promise((resolve, reject) => {
    const bb = busboy({
      headers: req.headers,
      limits: { files: 1, fileSize: 10 * 1024 * 1024, parts: 32 },
    });
    let targetSpace = "user";
    let flowIdField = "";
    /** @type {Buffer[]} */
    const chunks = [];
    let filename = "";
    let gotFile = false;

    bb.on("field", (name, val) => {
      if (name === "targetSpace" && (val === "workspace" || val === "user")) {
        targetSpace = val;
      }
      if (name === "flowId" && typeof val === "string") {
        flowIdField = val;
      }
    });

    bb.on("file", (name, file, info) => {
      if (name !== "file") {
        file.resume();
        return;
      }
      gotFile = true;
      filename = info.filename || "";
      file.on("data", (d) => chunks.push(d));
      file.on("limit", () => {
        reject(new Error("FILE_TOO_LARGE"));
      });
    });

    bb.on("finish", () => {
      resolve({
        targetSpace,
        flowIdField: flowIdField.trim(),
        file: Buffer.concat(chunks),
        filename,
        gotFile,
      });
    });
    bb.on("error", reject);
    req.pipe(bb);
  });
}

function parseWorkspaceUploadForm(req) {
  return new Promise((resolve, reject) => {
    const bb = busboy({
      headers: req.headers,
      limits: { files: 1, fileSize: 10 * 1024 * 1024, parts: 32 },
    });
    const fields = {};
    const chunks = [];
    let filename = "";
    let mimeType = "";
    let gotFile = false;
    bb.on("field", (name, val) => {
      fields[String(name || "")] = String(val || "");
    });
    bb.on("file", (name, file, info) => {
      if (name !== "file") {
        file.resume();
        return;
      }
      gotFile = true;
      filename = info.filename || "";
      mimeType = info.mimeType || "";
      file.on("data", (d) => chunks.push(d));
      file.on("limit", () => {
        reject(new Error("FILE_TOO_LARGE"));
      });
    });
    bb.on("finish", () => {
      resolve({
        fields,
        file: Buffer.concat(chunks),
        filename,
        mimeType,
        gotFile,
      });
    });
    bb.on("error", reject);
    req.pipe(bb);
  });
}

/** GET 读 flow / nodes / SSE 等 */
function isValidFlowSourceRead(s) {
  return s === "builtin" || s === "admin" || s === "user" || s === "workspace";
}

function isReadonlyBuiltinFlowSource(s) {
  return s === "builtin" || s === "admin";
}

/** POST 写 flow */
function isValidFlowSourceWrite(s) {
  return s === "user" || s === "workspace";
}

/** Composer 打开的画布通过 SSE 订阅；POST /api/flow-editor-sync 向对应 flow 推送刷新 */
const flowEditorSyncSubscribers = new Map();
/** 每次 broadcastFlowEditorSync 时递增，供轮询端点 /api/flow-editor-sync-poll 使用 */
const flowEditorSyncVersions = new Map();

function flowEditorSyncKey(flowId, flowSource, flowArchived, userId = "") {
  return `${String(userId || "")}\t${String(flowId)}\t${String(flowSource)}\t${flowArchived ? "1" : "0"}`;
}

function broadcastFlowEditorSync(flowId, flowSource, flowArchived = false, userId = "") {
  const key = flowEditorSyncKey(flowId, flowSource, flowArchived, userId);

  /* 递增轮询版本号 */
  flowEditorSyncVersions.set(key, (flowEditorSyncVersions.get(key) ?? 0) + 1);

  const set = flowEditorSyncSubscribers.get(key);
  if (!set || set.size === 0) return;
  const payload = JSON.stringify({ type: "refresh" });
  const chunk = `data: ${payload}\n\n`;
  for (const clientRes of set) {
    try {
      clientRes.write(chunk);
    } catch (_) {}
  }
}

/** 正在执行的 flow run（flowId → { child, runUuid }）；同一 flow 只允许一个 run */
const activeFlowRuns = new Map();
/** 正在执行的 Workspace 临时 run（flowId → { controller, child, runNodeId, startedAt }）；同一 flow 只允许一个 run */
const activeWorkspaceRuns = new Map();

function workspaceRunKey(userCtx, flowSource, flowId) {
  return `${userCtx?.userId || ""}:${flowSource || "user"}:${flowId}`;
}

/** Cursor/OpenCode 执行目录统一使用当前 UI 启动 workspace。 */
function composerCliWorkspaceForFlowDir(workspaceRoot, _flowDir) {
  return path.resolve(workspaceRoot);
}

/**
 * @param {object} p
 * @param {string} p.flowYamlAbs
 * @param {string} p.flowId
 * @param {"builtin" | "admin" | "user" | "workspace"} p.flowSource
 * @param {string} [p.workspaceWriteDirAbs] 内置来源的可写副本根目录（…/pipelines/<flowId>）
 * @param {"user" | "workspace"} [p.editorSyncFlowSource] flow-editor-sync 使用的 flowSource（内置来源时为 workspace）
 * @param {string[]} p.instanceIds
 * @param {string} p.userPrompt
 * @param {number} p.uiPort 本地 Web UI 端口（用于 flow 保存后通知浏览器刷新）
 * @param {boolean} [p.flowArchived]
 */
const THREAD_HISTORY_MAX_CHARS = 8000;
const THREAD_HISTORY_MAX_TURNS = 20;

function formatThreadHistory(thread) {
  if (!thread || thread.length === 0) return "";
  const recent = thread.slice(-THREAD_HISTORY_MAX_TURNS);
  const lines = [];
  let chars = 0;
  for (let i = recent.length - 1; i >= 0; i--) {
    const m = recent[i];
    const label = m.role === "user" ? "用户" : "助手";
    const text = m.text.length > 1500 ? m.text.slice(0, 1500) + "…(截断)" : m.text;
    const line = `${label}：${text}`;
    if (chars + line.length > THREAD_HISTORY_MAX_CHARS) break;
    lines.unshift(line);
    chars += line.length;
  }
  if (lines.length === 0) return "";
  return "## 对话历史\n\n" + lines.join("\n\n");
}

function buildComposerPromptWithFlowContext(p) {
  const flowDirAbs = path.dirname(p.flowYamlAbs);
  const idsLine =
    p.instanceIds.length > 0 ? p.instanceIds.map(String).join(", ") : "（无，可能为全局修改或新增节点）";
  const builtinExtra =
    isReadonlyBuiltinFlowSource(p.flowSource) && p.workspaceWriteDirAbs
      ? [
          `- 内置模板为只读；若保存修改请写入工作区副本目录：${p.workspaceWriteDirAbs}（flow.yaml 与同 id）`,
          "- 保存后刷新 Web 画布时，flow-editor-sync 的 JSON 须使用 flowSource: workspace（与上方 curl 一致）。",
        ]
      : [];

  const prefix = [
    "## AgentFlow Composer 上下文",
    `- 流水线目录（flowId=${p.flowId}）：${flowDirAbs}`,
    `- 图定义文件：${p.flowYamlAbs}`,
    `- flowId：${p.flowId}`,
    `- flowSource：${p.flowSource}`,
    ...builtinExtra,
    `- 当前关联的节点实例 ID（顺序：画布选中优先，再输入框 @提及）：${idsLine}`,
    "- 像普通 agent 请求一样处理用户说明：可能只是问问题，也可能要求编辑文件。不要因为存在 flowId 就默认修改 flow.yaml。",
    "- 按需使用当前环境可用的 skills；如果用户点名某个 skill，遵循该 skill 的 SKILL.md。",
    "- 如果你判断需要编辑 AgentFlow 流程，可按需读取这些本地 skills：",
    "  - `skills/agentflow-flow-add-instances/SKILL.md`：新增实例、边和布局",
    "  - `skills/agentflow-flow-edit-node-fields/SKILL.md`：只改已有节点字段",
    "  - `skills/agentflow-flow-sync-ui/SKILL.md`：保存 flow.yaml 后刷新画布",
    "- 如果只是回答问题，不要修改文件。",
    "",
    ...(p.selectedSkillBlock ? [p.selectedSkillBlock, ""] : []),
    ...(p.thread && p.thread.length > 0
      ? [formatThreadHistory(p.thread), ""]
      : []),
    ...(p.scriptContentBlock ? [p.scriptContentBlock, ""] : []),
    "## 用户说明",
    "",
    p.userPrompt.trim(),
  ].join("\n");
  return prefix;
}

function flowYamlChangedSince(flowYamlAbs, beforeText) {
  if (!flowYamlAbs || beforeText == null) return false;
  try {
    return fs.readFileSync(flowYamlAbs, "utf-8") !== beforeText;
  } catch {
    return false;
  }
}

function normalizeContextInstanceIds(raw) {
  if (raw == null) return [];
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const x of raw) {
    const s = typeof x === "string" ? x.trim() : String(x ?? "").trim();
    if (!s || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

/**
 * @param {object} opts
 * @param {string} opts.workspaceRoot
 * @param {number} opts.port
 * @param {boolean} [opts.hideCommunityLinks]
 * @param {string} [opts.staticDir] 默认 PACKAGE_ROOT/builtin/web-ui/dist（npm run build 产出）
 * @returns {Promise<import('http').Server>}
 */
export function startUiServer({
  workspaceRoot,
  port,
  host = "127.0.0.1",
  hideCommunityLinks = false,
  staticDir = path.join(PACKAGE_ROOT, "builtin", "web-ui", "dist"),
}) {
  const root = path.resolve(workspaceRoot);
  const uiPort = port;
  const uiConfig = { hideCommunityLinks: Boolean(hideCommunityLinks) };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    const reqStart = Date.now();
    log.debug(`[ui] ${req.method} ${url.pathname}${url.search || ""}`);

    const origEnd = res.end.bind(res);
    res.end = function (...args) {
      log.debug(`[ui] ${req.method} ${url.pathname} → ${res.statusCode} (${Date.now() - reqStart}ms)`);
      return origEnd(...args);
    };

    if (url.pathname === "/api/auth/me" && req.method === "GET") {
      const user = getAuthUserFromRequest(req);
      const allowed = user ? isAuthUserAllowed(user) : true;
      const allowlist = readUserAllowlist();
      json(res, 200, {
        authenticated: Boolean(user && allowed),
        user: user && allowed ? user : null,
        setupRequired: authSetupRequired(),
        allowlistEnabled: allowlist.enabled,
        forbidden: Boolean(user && !allowed),
        error: user && !allowed ? "用户不在白名单中，请联系管理员开通访问权限" : "",
      });
      return;
    }

    if (url.pathname === "/api/auth/login" && req.method === "POST") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const result = loginOrCreateUser(payload?.username, payload?.password);
      if (!result.ok) {
        json(res, result.forbidden ? 403 : 401, { error: result.error || "Login failed", setupRequired: authSetupRequired() });
        return;
      }
      const body = JSON.stringify({ authenticated: true, user: result.user, setupRequired: false, migration: result.migration || null });
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Set-Cookie": buildSessionCookie(result.token),
      });
      res.end(body);
      return;
    }

    if (url.pathname === "/api/auth/logout" && req.method === "POST") {
      logoutRequest(req);
      const body = JSON.stringify({ ok: true });
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Length": Buffer.byteLength(body),
        "Set-Cookie": buildClearSessionCookie(),
      });
      res.end(body);
      return;
    }

    const authUser = getAuthUserFromRequest(req);
    const userCtx = authUser ? { userId: authUser.userId, isAdmin: Boolean(authUser.isAdmin) } : {};
    if (req.method === "GET" && url.pathname === "/api/display/share") {
      try {
        const id = String(url.searchParams.get("id") || "").trim();
        if (!id) {
          json(res, 400, { error: "Missing display share id" });
          return;
        }
        const { share, expired } = getDisplayShareOrExpired(id);
        if (!share) {
          json(res, expired ? 410 : 404, { error: expired ? "Display share has expired" : "Display share not found" });
          return;
        }
        const payload = publicDisplayPayloadFromShare(root, share);
        if (payload.error) {
          json(res, 404, { error: payload.error });
          return;
        }
        json(res, 200, payload);
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/display/file/raw") {
      try {
        const id = String(url.searchParams.get("id") || "").trim();
        if (!id) {
          json(res, 400, { error: "Missing display share id" });
          return;
        }
        const { share, expired } = getDisplayShareOrExpired(id);
        if (!share) {
          json(res, expired ? 410 : 404, { error: expired ? "Display share has expired" : "Display share not found" });
          return;
        }
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: share.flowId || "",
          flowSource: share.flowSource || "user",
          archived: share.archived === true,
        }, { userId: share.userId || "" });
        if (scoped.error) {
          json(res, 404, { error: scoped.error });
          return;
        }
        const { abs, rel } = resolveWorkspaceFilePath(scoped.root, url.searchParams.get("path") || "");
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
          json(res, 404, { error: "File not found" });
          return;
        }
        const ext = path.extname(abs).toLowerCase();
        const type = MIME[ext] || "application/octet-stream";
        const data = fs.readFileSync(abs);
        const headers = {
          "Content-Type": type,
          "Content-Length": data.length,
          "Cache-Control": "public, max-age=300",
        };
        if (url.searchParams.get("download") === "1") {
          headers["Content-Disposition"] = workspaceDownloadContentDisposition(rel);
        }
        res.writeHead(200, headers);
        res.end(data);
      } catch (e) {
        json(res, /traversal/i.test(String(e.message || e)) ? 403 : 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (url.pathname.startsWith("/api/") && !authUser) {
      json(res, 401, { error: "Authentication required", setupRequired: authSetupRequired() });
      return;
    }
    if (url.pathname.startsWith("/api/") && authUser && !isAuthUserAllowed(authUser)) {
      json(res, 403, { error: "用户不在白名单中，请联系管理员开通访问权限" });
      return;
    }

    if (url.pathname === "/api/feedback") {
      if (req.method === "POST") {
        let payload;
        try {
          payload = JSON.parse(await readBody(req));
        } catch {
          json(res, 400, { error: "Invalid JSON body" });
          return;
        }
        const created = createFeedbackItem(payload, authUser);
        if (created.error) {
          json(res, 400, { error: created.error });
          return;
        }
        const items = readFeedbackItems();
        items.unshift(created.item);
        writeFeedbackItems(items.slice(0, 1000));
        json(res, 200, { ok: true, feedback: created.item });
        return;
      }
      if (req.method === "GET") {
        if (!authUser?.isAdmin) {
          json(res, 403, { error: "Admin permission required" });
          return;
        }
        json(res, 200, { feedback: readFeedbackItems() });
        return;
      }
    }

    if (url.pathname === "/api/admin/builtin-flows") {
      if (!authUser?.isAdmin) {
        json(res, 403, { error: "Admin permission required" });
        return;
      }
      if (req.method === "GET") {
        json(res, 200, { config: readAdminBuiltinPipelineConfig() });
        return;
      }
      if (req.method === "POST") {
        let payload;
        try {
          payload = JSON.parse(await readBody(req));
        } catch {
          json(res, 400, { error: "Invalid JSON body" });
          return;
        }
        const result = updateAdminBuiltinPipelineConfig(payload?.action, payload, authUser);
        if (!result.ok) {
          json(res, 400, { error: result.error || "Update failed" });
          return;
        }
        json(res, 200, { ok: true, config: result.config });
        return;
      }
    }

    if (url.pathname === "/api/admin/user-allowlist") {
      if (!authUser?.isAdmin) {
        json(res, 403, { error: "Admin permission required" });
        return;
      }
      if (req.method === "GET") {
        json(res, 200, { allowlist: readUserAllowlist() });
        return;
      }
      if (req.method === "POST") {
        let payload;
        try {
          payload = JSON.parse(await readBody(req));
        } catch {
          json(res, 400, { error: "Invalid JSON body" });
          return;
        }
        try {
          const allowlist = writeUserAllowlist(payload?.users || payload?.fileUsers || []);
          json(res, 200, { ok: true, allowlist });
        } catch (e) {
          json(res, 400, { error: (e && e.message) || String(e) });
        }
        return;
      }
    }

    if (url.pathname === "/api/flows") {
      if (req.method === "GET") {
        try {
          json(res, 200, listFlowsJson(root, userCtx));
        } catch (e) {
          json(res, 500, { error: (e && e.message) || String(e) });
        }
        return;
      }
      if (req.method === "HEAD") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end();
        return;
      }
      if (req.method === "POST") {
        let payload;
        try {
          payload = JSON.parse(await readBody(req));
        } catch {
          json(res, 400, { error: "Invalid JSON body" });
          return;
        }
        const idCheck = validateUserPipelineId(payload.flowId);
        if (!idCheck.ok) {
          json(res, 400, { error: idCheck.error });
          return;
        }
        const flowId = idCheck.flowId;
        const desc =
          payload.description != null && typeof payload.description === "string"
            ? payload.description
            : "";
        let targetSpace = "user";
        const ts = payload.targetSpace;
        if (ts === "workspace" || ts === "user") {
          targetSpace = ts;
        }
        const existing = listFlowsJson(root, {
          ...userCtx,
          includeWorkspaceFlows: targetSpace === "workspace",
        });
        if (
          existing.some(
            (f) => f.id === flowId && (f.source ?? "user") === targetSpace && !f.archived,
          )
        ) {
          json(res, 409, { error: "已存在同名流水线，请换一个名称" });
          return;
        }
        const flowYaml = buildEmptyUserFlowYaml({ description: desc });
        const result = writeFlowYaml(root, flowId, targetSpace, flowYaml, userCtx);
        if (!result.success) {
          json(res, 400, result);
          return;
        }
        json(res, 200, { success: true, flowId, flowSource: targetSpace });
        return;
      }
      const body405 = JSON.stringify({ error: "Method not allowed" });
      res.writeHead(405, {
        "Content-Type": "application/json; charset=utf-8",
        Allow: "GET, POST, HEAD",
        "Content-Length": Buffer.byteLength(body405),
      });
      res.end(body405);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/flows/import") {
      const ct = req.headers["content-type"] || "";
      if (!ct.toLowerCase().startsWith("multipart/form-data")) {
        json(res, 415, { error: "需要 multipart/form-data" });
        return;
      }
      let parsed;
      try {
        parsed = await parseFlowsImportForm(req);
      } catch (e) {
        if (e && e.message === "FILE_TOO_LARGE") {
          json(res, 400, { error: "文件过大（最大 10MB）" });
          return;
        }
        json(res, 400, { error: (e && e.message) || String(e) });
        return;
      }
      if (!parsed.gotFile || !parsed.file.length) {
        json(res, 400, { error: "请上传文件（字段名 file）" });
        return;
      }
      const idCheck = validateUserPipelineId(parsed.flowIdField);
      if (!idCheck.ok) {
        json(res, 400, { error: idCheck.error });
        return;
      }
      const flowId = idCheck.flowId;
      const targetSpace = parsed.targetSpace === "workspace" ? "workspace" : "user";
      const existing = listFlowsJson(root, {
        ...userCtx,
        includeWorkspaceFlows: targetSpace === "workspace",
      });
      if (
        existing.some(
          (f) => f.id === flowId && (f.source ?? "user") === targetSpace && !f.archived,
        )
      ) {
        json(res, 409, { error: "已存在同名流水线，请换一个名称" });
        return;
      }

      const buf = parsed.file;
      /** @type {Map<string, Buffer> | null} */
      let filesMap = null;

      if (bufferLooksLikeZip(buf)) {
        const norm = unzipAndNormalizePipelineZip(buf);
        if (!norm.ok) {
          json(res, 400, { error: norm.error });
          return;
        }
        filesMap = norm.files;
      } else {
        const text = buf.toString("utf8");
        const v = validateImportedFlowYaml(text);
        if (!v.ok) {
          json(res, 400, { error: v.error });
          return;
        }
        filesMap = new Map([["flow.yaml", Buffer.from(text, "utf8")]]);
      }

      const w = writePipelineTree(root, flowId, targetSpace, filesMap, userCtx);
      if (!w.success) {
        json(res, 400, { error: w.error });
        return;
      }
      json(res, 200, { success: true, flowId, flowSource: targetSpace });
      return;
    }

    // ── Node execution context (run-mode sidebar) ──
    if (req.method === "GET" && url.pathname === "/api/node-exec-context") {
      try {
        const flowId = url.searchParams.get("flowId") || "";
        const instanceId = url.searchParams.get("instanceId") || "";
        const runId = url.searchParams.get("runId") || "";
        if (!flowId || !instanceId) {
          json(res, 400, { error: "Missing flowId or instanceId" });
          return;
        }
        const { getNodeExecContext } = await import("./node-exec-context.mjs");
        json(res, 200, getNodeExecContext(root, flowId, instanceId, runId, userCtx));
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/pipeline-recent-runs") {
      try {
        json(res, 200, { runs: listRecentRunsFromDisk(root, userCtx) });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/run-node-statuses") {
      try {
        const flowId = url.searchParams.get("flowId") || "";
        const runId = url.searchParams.get("runId") || "";
        if (!flowId || !runId) {
          json(res, 400, { error: "Missing flowId or runId" });
          return;
        }
        const { getRunNodeStatusesFromDisk } = await import("./run-node-statuses-from-disk.mjs");
        json(res, 200, { statuses: getRunNodeStatusesFromDisk(root, flowId, runId, userCtx) });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/run-log") {
      try {
        const flowId = url.searchParams.get("flowId") || "";
        const runId = url.searchParams.get("runId") || "";
        const sinceBytes = Math.max(0, parseInt(url.searchParams.get("sinceBytes") || "0", 10) || 0);
        // tailBytes: 仅返回文件末尾 N 字节。用于初次打开长跑 run 时避免拉取整份日志。
        const tailBytesRaw = url.searchParams.get("tailBytes");
        const tailBytes = tailBytesRaw != null ? Math.max(0, parseInt(tailBytesRaw, 10) || 0) : 0;
        if (!flowId || !runId) {
          json(res, 400, { error: "Missing flowId or runId" });
          return;
        }
        const { getRunDir } = await import("./workspace.mjs");
        const { RUN_LOG_REL } = await import("./paths.mjs");
        const { default: fsMod } = await import("node:fs");
        const logPath = path.join(getRunDir(root, flowId, runId, userCtx), RUN_LOG_REL);
        if (!fsMod.existsSync(logPath)) {
          json(res, 200, { bytes: 0, text: "" });
          return;
        }
        const stat = fsMod.statSync(logPath);
        const size = stat.size;
        const startOffset = tailBytes > 0 ? Math.max(sinceBytes, size - tailBytes) : sinceBytes;
        if (startOffset >= size) {
          json(res, 200, { bytes: size, text: "" });
          return;
        }
        const fd = fsMod.openSync(logPath, "r");
        try {
          const len = size - startOffset;
          const buf = Buffer.alloc(len);
          fsMod.readSync(fd, buf, 0, len, startOffset);
          let text = buf.toString("utf-8");
          // 截断点可能落在一行中间，扔掉残行的前缀，保证解析端按行起步。
          if (tailBytes > 0 && startOffset > 0) {
            const nl = text.indexOf("\n");
            if (nl >= 0) text = text.slice(nl + 1);
          }
          json(res, 200, { bytes: size, text });
        } finally {
          fsMod.closeSync(fd);
        }
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/workspace-tree") {
      try {
        json(res, 200, getWorkspaceTree(root));
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/workspace/files") {
      try {
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: url.searchParams.get("flowId") || "",
          flowSource: url.searchParams.get("flowSource") || "user",
          archived: url.searchParams.get("archived") === "1",
        }, userCtx);
        if (scoped.error) {
          json(res, 400, { error: scoped.error });
          return;
        }
        json(res, 200, { ...readWorkspaceFiles(scoped.root), flowId: scoped.flowId, flowSource: scoped.flowSource, archived: scoped.archived });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/workspace/graph") {
      try {
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: url.searchParams.get("flowId") || "",
          flowSource: url.searchParams.get("flowSource") || "user",
          archived: url.searchParams.get("archived") === "1",
        }, userCtx);
        if (scoped.error) {
          json(res, 400, { error: scoped.error });
          return;
        }
        const { path: graphPath, graph } = readWorkspaceGraph(scoped.root);
        json(res, 200, {
          ok: true,
          graph,
          path: graphPath,
          root: scoped.root,
          flowId: scoped.flowId,
          flowSource: scoped.flowSource,
          archived: scoped.archived,
          writable: !(scoped.archived || isReadonlyBuiltinFlowSource(scoped.flowSource)),
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/display/share") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      try {
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: payload.flowId || "",
          flowSource: payload.flowSource || "user",
          archived: payload.archived === true || payload.flowArchived === true,
        }, userCtx);
        if (scoped.error) {
          json(res, 400, { error: scoped.error });
          return;
        }
        const { graph } = readWorkspaceGraph(scoped.root);
        const nodeIds = normalizeDisplayShareNodeIds(payload.nodeIds, graph);
        if (nodeIds.length === 0) {
          json(res, 400, { error: "请选择至少一个 display 节点" });
          return;
        }
        const shares = readDisplayShares();
        let id = createDisplayShareId();
        while (shares[id]) id = createDisplayShareId();
        const nowDate = new Date();
        const now = nowDate.toISOString();
        const share = {
          id,
          userId: authUser.userId,
          flowId: scoped.flowId || "",
          flowSource: scoped.flowSource || "user",
          archived: scoped.archived === true,
          title: String(payload.title || "").trim() || "AgentFlow Display",
          layout: ["canvas", "gallery", "slides", "document", "single"].includes(String(payload.layout || "")) ? String(payload.layout) : "canvas",
          nodeIds,
          createdAt: now,
          updatedAt: now,
          expiresAt: displayShareExpiresAt(nowDate),
        };
        shares[id] = share;
        writeDisplayShares(shares);
        json(res, 200, { ok: true, share, url: `/display/${encodeURIComponent(id)}` });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspace/graph") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      try {
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: payload.flowId || "",
          flowSource: payload.flowSource || "user",
          archived: payload.archived === true || payload.flowArchived === true,
        }, userCtx);
        if (scoped.error) {
          json(res, 400, { error: scoped.error });
          return;
        }
        if (scoped.archived || isReadonlyBuiltinFlowSource(scoped.flowSource)) {
          json(res, 400, { error: "Cannot write workspace graph for builtin or archived pipeline" });
          return;
        }
        const graph = normalizeWorkspaceGraphPayload(payload.graph || payload);
        const graphPath = workspaceGraphPath(scoped.root);
        fs.writeFileSync(graphPath, JSON.stringify(graph, null, 2) + "\n", "utf-8");
        json(res, 200, { ok: true, path: graphPath, graph });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspace/run") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      try {
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: payload.flowId || "",
          flowSource: payload.flowSource || "user",
          archived: payload.archived === true || payload.flowArchived === true,
        }, userCtx);
        if (scoped.error) {
          json(res, 400, { error: scoped.error });
          return;
        }
        if (scoped.archived || isReadonlyBuiltinFlowSource(scoped.flowSource)) {
          json(res, 400, { error: "Cannot run workspace graph for builtin or archived pipeline" });
          return;
        }
        const wantsStream = /\bapplication\/x-ndjson\b/i.test(req.headers.accept || "") || payload.stream === true;
        const flowId = String(payload.flowId || "").trim();
        if (!flowId) {
          json(res, 400, { error: "Missing flowId" });
          return;
        }
        const runKey = workspaceRunKey(userCtx, scoped.flowSource || payload.flowSource || "user", flowId);
        if (activeWorkspaceRuns.has(runKey)) {
          json(res, 409, { error: "该 Workspace 正在运行" });
          return;
        }
        const controller = new AbortController();
        const runEntry = {
          controller,
          child: null,
          runNodeId: String(payload.runNodeId || "").trim(),
          flowId,
          flowSource: scoped.flowSource || payload.flowSource || "user",
          startedAt: Date.now(),
          stopChild() {
            if (this.child && !this.child.killed) {
              try { this.child.kill("SIGTERM"); } catch (_) {}
            }
          },
        };
        activeWorkspaceRuns.set(runKey, runEntry);
        const setActiveChild = (child) => {
          runEntry.child = child || null;
          if (controller.signal.aborted) runEntry.stopChild();
        };
        const clearActiveRun = () => {
          if (activeWorkspaceRuns.get(runKey) === runEntry) activeWorkspaceRuns.delete(runKey);
        };
        if (wantsStream) {
          const graphPath = workspaceGraphPath(scoped.root);
          res.writeHead(200, {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
          });
          const writeEvent = (event) => {
            try { res.write(JSON.stringify(event) + "\n"); } catch (_) {}
          };
          try {
            const result = await runWorkspaceGraph(root, scoped.root, payload, userCtx, {
              onEvent: writeEvent,
              signal: controller.signal,
              onActiveChild: setActiveChild,
            });
            const currentGraph = readWorkspaceGraph(scoped.root).graph;
            const touchedIds = workspaceRunTouchedNodeIds(result);
            const mergedGraph = mergeWorkspaceRunGraph(currentGraph, result.graph, touchedIds);
            fs.writeFileSync(graphPath, JSON.stringify(mergedGraph, null, 2) + "\n", "utf-8");
            writeEvent({ type: "done", ok: true, path: graphPath, graph: mergedGraph, order: result.order, touchedNodeIds: Array.from(touchedIds), pauseNodeIds: result.pauseNodeIds || [] });
            res.end();
          } catch (e) {
            if (isWorkspaceRunAbortError(e) || controller.signal.aborted) {
              writeEvent({ type: "stopped", ok: false, stopped: true, message: "Workspace run stopped" });
            } else {
              writeEvent({ type: "error", error: (e && e.message) || String(e) });
            }
            res.end();
          } finally {
            clearActiveRun();
          }
          return;
        }
        try {
          const result = await runWorkspaceGraph(root, scoped.root, payload, userCtx, {
            signal: controller.signal,
            onActiveChild: setActiveChild,
          });
          const graphPath = workspaceGraphPath(scoped.root);
          const currentGraph = readWorkspaceGraph(scoped.root).graph;
          const touchedIds = workspaceRunTouchedNodeIds(result);
          const mergedGraph = mergeWorkspaceRunGraph(currentGraph, result.graph, touchedIds);
          fs.writeFileSync(graphPath, JSON.stringify(mergedGraph, null, 2) + "\n", "utf-8");
          json(res, 200, { ok: true, path: graphPath, ...result, graph: mergedGraph, touchedNodeIds: Array.from(touchedIds) });
        } catch (e) {
          if (isWorkspaceRunAbortError(e) || controller.signal.aborted) {
            json(res, 200, { ok: false, stopped: true, message: "Workspace run stopped" });
          } else {
            throw e;
          }
        } finally {
          clearActiveRun();
        }
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/workspace/run/status") {
      const flowId = typeof url.searchParams.get("flowId") === "string" ? url.searchParams.get("flowId").trim() : "";
      if (!flowId) {
        json(res, 400, { error: "Missing flowId" });
        return;
      }
      const flowSource = url.searchParams.get("flowSource") || "user";
      const runKey = workspaceRunKey(userCtx, flowSource, flowId);
      const entry = activeWorkspaceRuns.get(runKey);
      json(res, 200, {
        running: Boolean(entry),
        flowId,
        flowSource,
        runNodeId: entry?.runNodeId || "",
        startedAt: entry?.startedAt || null,
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspace/run/stop") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const flowId = typeof payload.flowId === "string" ? payload.flowId.trim() : "";
      if (!flowId) {
        json(res, 400, { error: "Missing flowId" });
        return;
      }
      const runKey = workspaceRunKey(userCtx, payload.flowSource || "user", flowId);
      const entry = activeWorkspaceRuns.get(runKey);
      if (!entry) {
        json(res, 404, { error: "该 Workspace 未在运行" });
        return;
      }
      try { entry.controller?.abort(); } catch (_) {}
      try { entry.stopChild?.(); } catch (_) {}
      json(res, 200, { ok: true, stopped: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/workspace/file") {
      try {
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: url.searchParams.get("flowId") || "",
          flowSource: url.searchParams.get("flowSource") || "user",
          archived: url.searchParams.get("archived") === "1",
        }, userCtx);
        if (scoped.error) {
          json(res, 400, { error: scoped.error });
          return;
        }
        const { abs, rel } = resolveWorkspaceFilePath(scoped.root, url.searchParams.get("path") || "");
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
          json(res, 404, { error: "File not found" });
          return;
        }
        const stat = fs.statSync(abs);
        if (stat.size > 2 * 1024 * 1024) {
          json(res, 413, { error: "File too large" });
          return;
        }
        json(res, 200, { path: rel, content: fs.readFileSync(abs, "utf-8"), size: stat.size });
      } catch (e) {
        json(res, /traversal/i.test(String(e.message || e)) ? 403 : 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/workspace/file/raw") {
      try {
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: url.searchParams.get("flowId") || "",
          flowSource: url.searchParams.get("flowSource") || "user",
          archived: url.searchParams.get("archived") === "1",
        }, userCtx);
        if (scoped.error) {
          json(res, 400, { error: scoped.error });
          return;
        }
        const { abs, rel } = resolveWorkspaceFilePath(scoped.root, url.searchParams.get("path") || "");
        if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
          json(res, 404, { error: "File not found" });
          return;
        }
        const ext = path.extname(abs).toLowerCase();
        const type = MIME[ext] || "application/octet-stream";
        const data = fs.readFileSync(abs);
        const headers = {
          "Content-Type": type,
          "Content-Length": data.length,
          "Cache-Control": "no-store",
        };
        if (url.searchParams.get("download") === "1") {
          headers["Content-Disposition"] = workspaceDownloadContentDisposition(rel);
        }
        res.writeHead(200, headers);
        res.end(data);
      } catch (e) {
        json(res, /traversal/i.test(String(e.message || e)) ? 403 : 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspace/html-screenshot") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      try {
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: payload.flowId || "",
          flowSource: payload.flowSource || "user",
          archived: payload.archived === true || payload.flowArchived === true,
        }, userCtx);
        if (scoped.error) {
          json(res, 400, { error: scoped.error });
          return;
        }
        const sourceFilePath = String(payload.sourceFilePath || payload.path || "").trim();
        let html = String(payload.content || "");
        let baseDir = scoped.root;
        if (sourceFilePath) {
          const { abs } = resolveWorkspaceFilePath(scoped.root, sourceFilePath);
          if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
            json(res, 404, { error: "HTML file not found" });
            return;
          }
          const stat = fs.statSync(abs);
          if (stat.size > 5 * 1024 * 1024) {
            json(res, 413, { error: "HTML file too large" });
            return;
          }
          if (!html.trim()) html = fs.readFileSync(abs, "utf-8");
          baseDir = path.dirname(abs);
        }
        if (!html.trim()) {
          json(res, 400, { error: "Missing HTML content" });
          return;
        }
        const screenshot = await renderHtmlScreenshotWithChrome({
          html,
          workspaceRoot: scoped.root,
          baseDir,
          width: payload.width,
          height: payload.height,
        });
        const png = screenshot.png;
        const filename = sanitizeWorkspaceUploadName(payload.filename || "html-render.png").replace(/\.[^.]+$/i, ".png");
        res.writeHead(200, {
          "Content-Type": "image/png",
          "Content-Length": png.length,
          "Cache-Control": "no-store",
          "Content-Disposition": workspaceDownloadContentDisposition(filename),
        });
        res.end(png);
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspace/file") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      try {
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: payload.flowId || "",
          flowSource: payload.flowSource || "user",
          archived: payload.archived === true || payload.flowArchived === true,
        }, userCtx);
        if (scoped.error) {
          json(res, 400, { error: scoped.error });
          return;
        }
        if (scoped.archived || isReadonlyBuiltinFlowSource(scoped.flowSource)) {
          json(res, 400, { error: "Cannot write to builtin or archived pipeline workspace" });
          return;
        }
        const { abs, rel } = resolveWorkspaceFilePath(scoped.root, payload.path || "");
        if (!rel) {
          json(res, 400, { error: "Missing path" });
          return;
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        fs.writeFileSync(abs, String(payload.content ?? ""), "utf-8");
        json(res, 200, { ok: true, path: rel });
      } catch (e) {
        json(res, /traversal/i.test(String(e.message || e)) ? 403 : 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspace/upload") {
      let parsed;
      try {
        parsed = await parseWorkspaceUploadForm(req);
      } catch (e) {
        json(res, /FILE_TOO_LARGE/.test(String(e.message || e)) ? 413 : 400, { error: (e && e.message) || String(e) });
        return;
      }
      try {
        if (!parsed.gotFile || !parsed.file.length) {
          json(res, 400, { error: "Missing upload file" });
          return;
        }
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: parsed.fields.flowId || "",
          flowSource: parsed.fields.flowSource || "user",
          archived: parsed.fields.archived === "1" || parsed.fields.archived === "true" || parsed.fields.flowArchived === "true",
        }, userCtx);
        if (scoped.error) {
          json(res, 400, { error: scoped.error });
          return;
        }
        if (scoped.archived || isReadonlyBuiltinFlowSource(scoped.flowSource)) {
          json(res, 400, { error: "Cannot write to builtin or archived pipeline workspace" });
          return;
        }
        const safeName = sanitizeWorkspaceUploadName(parsed.filename);
        const ext = path.extname(safeName).toLowerCase();
        if (!WORKSPACE_IMAGE_EXTS.has(ext) || (parsed.mimeType && !/^image\//i.test(parsed.mimeType))) {
          json(res, 400, { error: "Only image uploads are supported" });
          return;
        }
        const targetDir = String(parsed.fields.dir || "img").trim().replace(/^[/\\]+/, "") || "img";
        const target = uniqueWorkspaceRelPath(scoped.root, path.posix.join(targetDir.replace(/\\/g, "/"), safeName));
        fs.mkdirSync(path.dirname(target.abs), { recursive: true });
        fs.writeFileSync(target.abs, parsed.file);
        json(res, 200, {
          ok: true,
          path: target.rel,
          size: parsed.file.length,
          mimeType: parsed.mimeType,
        });
      } catch (e) {
        json(res, /traversal/i.test(String(e.message || e)) ? 403 : 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspace/folder") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      try {
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: payload.flowId || "",
          flowSource: payload.flowSource || "user",
          archived: payload.archived === true || payload.flowArchived === true,
        }, userCtx);
        if (scoped.error) {
          json(res, 400, { error: scoped.error });
          return;
        }
        if (scoped.archived || isReadonlyBuiltinFlowSource(scoped.flowSource)) {
          json(res, 400, { error: "Cannot write to builtin or archived pipeline workspace" });
          return;
        }
        const { abs, rel } = resolveWorkspaceFilePath(scoped.root, payload.path || "");
        if (!rel) {
          json(res, 400, { error: "Missing path" });
          return;
        }
        fs.mkdirSync(abs, { recursive: true });
        json(res, 200, { ok: true, path: rel });
      } catch (e) {
        json(res, /traversal/i.test(String(e.message || e)) ? 403 : 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspace/delete") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      try {
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: payload.flowId || "",
          flowSource: payload.flowSource || "user",
          archived: payload.archived === true || payload.flowArchived === true,
        }, userCtx);
        if (scoped.error) {
          json(res, 400, { error: scoped.error });
          return;
        }
        if (scoped.archived || isReadonlyBuiltinFlowSource(scoped.flowSource)) {
          json(res, 400, { error: "Cannot write to builtin or archived pipeline workspace" });
          return;
        }
        const { abs, rel } = resolveWorkspaceFilePath(scoped.root, payload.path || "");
        if (!rel) {
          json(res, 400, { error: "Missing path" });
          return;
        }
        if (!fs.existsSync(abs)) {
          json(res, 404, { error: "Path not found" });
          return;
        }
        fs.rmSync(abs, { recursive: true, force: true });
        json(res, 200, { ok: true, path: rel });
      } catch (e) {
        json(res, /traversal/i.test(String(e.message || e)) ? 403 : 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspace/generate") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const prompt = String(payload?.prompt || "").trim();
      if (!prompt) {
        json(res, 400, { error: "Missing prompt" });
        return;
      }
      try {
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: payload.flowId || "",
          flowSource: payload.flowSource || "user",
          archived: payload.archived === true || payload.flowArchived === true,
        }, userCtx);
        if (scoped.error) {
          json(res, 400, { error: scoped.error });
          return;
        }
        const selectedSkillKeys = Array.isArray(payload?.selectedSkills)
          ? payload.selectedSkills.map((x) => String(x || "").trim()).filter(Boolean)
          : [];
        const selectedSkillResources = selectedSkillKeys.length > 0
          ? loadResourcesForSkillKeys(selectedSkillKeys, PACKAGE_ROOT, scoped.root)
          : { skills: [], references: [] };
        const skillsBlock = selectedSkillKeys.length > 0
          ? buildSkillCompactInjectionBlock(selectedSkillResources.skills, selectedSkillResources.references)
          : "";
        let content = "";
        const events = [];
        const maxAttempts = 3;
        const promptText = buildWorkspaceGeneratePrompt({ ...payload, skillsBlock });
        const modelKey = typeof payload?.model === "string" ? payload.model.trim() : "";
        for (let attempt = 1; attempt <= maxAttempts; attempt++) {
          let attemptResult = "";
          const assistantSegments = [];
          try {
            if (attempt > 1) {
              events.push({
                type: "status",
                line: `Workspace agent retry ${attempt}/${maxAttempts} after transient network failure...`,
              });
              await sleepMs(Math.min(1500 * attempt, 5000));
            }
            const handle = startComposerAgent({
              uiWorkspaceRoot: scoped.root,
              cliWorkspace: scoped.root,
              prompt: promptText,
              modelKey,
              agentflowUserId: userCtx.userId || "",
              onStreamEvent: (ev) => {
                events.push(ev);
                if (ev?.type === "natural" && ev.kind === "assistant" && typeof ev.text === "string") {
                  const text = ev.text.trim();
                  if (text) assistantSegments.push(text);
                } else if (ev?.type === "natural" && ev.kind === "result" && typeof ev.text === "string") {
                  const text = ev.text.trim();
                  if (text) attemptResult = text;
                }
              },
            });
            await handle.finished;
            content = attemptResult || assistantSegments.at(-1) || "";
            break;
          } catch (e) {
            if (attempt < maxAttempts && isTransientAgentNetworkError(e)) {
              events.push({
                type: "status",
                line: `Workspace agent transient network error: ${String(e.message || e).slice(0, 220)}`,
              });
              continue;
            }
            throw e;
          }
        }
        json(res, 200, { ok: true, content: content.trim(), events });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspace/node-chat") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const message = String(payload?.message || "").trim();
      if (!message) {
        json(res, 400, { error: "Missing message" });
        return;
      }
      try {
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: payload.flowId || "",
          flowSource: payload.flowSource || "user",
          archived: payload.archived === true || payload.flowArchived === true,
        }, userCtx);
        if (scoped.error) {
          json(res, 400, { error: scoped.error });
          return;
        }
        const targetFilePath = String(payload?.targetFilePath || "").trim();
        let targetFile = null;
        if (targetFilePath) {
          if (scoped.archived || isReadonlyBuiltinFlowSource(scoped.flowSource)) {
            json(res, 400, { error: "Cannot edit builtin or archived pipeline workspace" });
            return;
          }
          targetFile = resolveWorkspaceFilePath(scoped.root, targetFilePath);
          if (!targetFile.rel) {
            json(res, 400, { error: "Missing artifact file path" });
            return;
          }
        }
        const beforeTargetContent = targetFile && fs.existsSync(targetFile.abs) && fs.statSync(targetFile.abs).isFile()
          ? fs.readFileSync(targetFile.abs, "utf-8")
          : null;
        const promptText = buildWorkspaceNodeChatPrompt(payload);
        const modelKey = typeof payload?.model === "string" ? payload.model.trim() : "";
        let content = "";
        const events = [];
        const handle = startComposerAgent({
          uiWorkspaceRoot: scoped.root,
          cliWorkspace: scoped.root,
          prompt: promptText,
          modelKey,
          agentflowUserId: userCtx.userId || "",
          onStreamEvent: (ev) => {
            events.push(ev);
            if (ev?.type === "natural" && ev.kind === "assistant" && typeof ev.text === "string") {
              content += (content ? "\n" : "") + ev.text;
            }
          },
        });
        await handle.finished;
        let candidateContent = targetFile
          ? (fs.existsSync(targetFile.abs) && fs.statSync(targetFile.abs).isFile()
              ? fs.readFileSync(targetFile.abs, "utf-8")
              : "")
          : content.trim();
        if (targetFile) {
          const unwrappedTargetContent = workspaceUnwrapOutputEnvelopeForDisplay(candidateContent);
          if (unwrappedTargetContent && unwrappedTargetContent !== candidateContent) {
            fs.writeFileSync(targetFile.abs, unwrappedTargetContent, "utf-8");
            candidateContent = unwrappedTargetContent;
          }
        }
        if (targetFile && beforeTargetContent != null && candidateContent === beforeTargetContent) {
          json(res, 500, { error: "Agent 未修改目标展示文件，请换一种更明确的描述后重试。" });
          return;
        }
        json(res, 200, {
          ok: true,
          sessionId: String(payload?.sessionId || "") || `nodechat_${Date.now()}`,
          reply: targetFile ? content.trim() : candidateContent,
          candidateContent,
          directFileEdit: Boolean(targetFile),
          artifactPath: targetFile?.rel || "",
          events,
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/pipeline-files") {
      const flowId = url.searchParams.get("flowId");
      const flowSource = url.searchParams.get("flowSource") || "user";
      const archived = url.searchParams.get("archived") === "1";
      if (!flowId) {
        json(res, 400, { error: "Missing flowId" });
        return;
      }
      try {
        const result = getPipelineFiles(root, flowId, flowSource, archived, userCtx);
        json(res, 200, result);
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/pipeline-file-content") {
      const flowId = url.searchParams.get("flowId");
      const flowSource = url.searchParams.get("flowSource") || "user";
      const archived = url.searchParams.get("archived") === "1";
      const filePath = url.searchParams.get("path");
      if (!flowId || !filePath) {
        json(res, 400, { error: "Missing flowId or path" });
        return;
      }
      try {
        const result = getPipelineFiles(root, flowId, flowSource, archived, userCtx);
        if (result.error) {
          json(res, 404, { error: result.error });
          return;
        }
        const absPath = path.join(result.path, filePath);
        if (!absPath.startsWith(result.path)) {
          json(res, 403, { error: "Path traversal not allowed" });
          return;
        }
        if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
          json(res, 404, { error: "File not found" });
          return;
        }
        const content = fs.readFileSync(absPath, "utf-8");
        json(res, 200, { content, path: absPath });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/pipeline-file-save") {
      const flowId = url.searchParams.get("flowId");
      const flowSource = url.searchParams.get("flowSource") || "user";
      const archived = url.searchParams.get("archived") === "1";
      const filePath = url.searchParams.get("path");
      if (!flowId || !filePath) {
        json(res, 400, { error: "Missing flowId or path" });
        return;
      }
      let body;
      try {
        body = await readBody(req);
      } catch {
        json(res, 400, { error: "Invalid request body" });
        return;
      }
      let content;
      try {
        const parsed = JSON.parse(body);
        content = typeof parsed.content === "string" ? parsed.content : "";
      } catch {
        content = String(body);
      }
      try {
        const result = getPipelineFiles(root, flowId, flowSource, archived, userCtx);
        if (result.error) {
          json(res, 404, { error: result.error });
          return;
        }
        const absPath = path.join(result.path, filePath);
        if (!absPath.startsWith(result.path)) {
          json(res, 403, { error: "Path traversal not allowed" });
          return;
        }
        if (!fs.existsSync(absPath)) {
          json(res, 404, { error: "File not found" });
          return;
        }
        fs.writeFileSync(absPath, content, "utf-8");
        json(res, 200, { success: true, path: absPath, size: content.length });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/model-lists") {
      try {
        json(res, 200, readModelListsFromDisk(root));
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/ui-context") {
      try {
        json(res, 200, { workspaceRoot: root, ...uiConfig });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/dev-info") {
      const isDev = process.env.AGENTFLOW_DEV === "1";
      json(res, 200, { isDev });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/composer-logs") {
      try {
        const flowIdFilter = url.searchParams.get("flowId") || "";
        const limit = Math.max(1, Math.min(200, Number(url.searchParams.get("limit")) || 50));
        const sessions = listRecentComposerSessions(root, 200);
        const enriched = sessions.map((s) => {
          const meta = readComposerSessionMeta(s.logPath);
          return {
            sessionId: s.sessionId,
            monthDir: s.monthDir,
            size: s.size,
            mtime: s.mtime,
            flowId: meta.flowId,
            flowSource: meta.flowSource,
            model: meta.model,
            promptPreview: meta.prompt ? meta.prompt.slice(0, 200) : null,
          };
        });
        const filtered = flowIdFilter ? enriched.filter((e) => e.flowId === flowIdFilter) : enriched;
        json(res, 200, { sessions: filtered.slice(0, limit) });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/composer-logs/")) {
      try {
        const sessionId = decodeURIComponent(url.pathname.slice("/api/composer-logs/".length));
        if (!sessionId || sessionId.includes("..") || sessionId.includes("/")) {
          json(res, 400, { error: "Invalid sessionId" });
          return;
        }
        const all = listRecentComposerSessions(root, 1000);
        const found = all.find((s) => s.sessionId === sessionId);
        if (!found) {
          json(res, 404, { error: "Session not found" });
          return;
        }
        const events = parseComposerLogFile(found.logPath);
        const meta = readComposerSessionMeta(found.logPath);
        json(res, 200, {
          sessionId: found.sessionId,
          logPath: found.logPath,
          monthDir: found.monthDir,
          size: found.size,
          mtime: found.mtime,
          meta,
          events,
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/agentflow-config") {
      try {
        const cfg = readAgentflowUserConfigObject();
        const opencodeProvider = typeof cfg.opencodeProvider === "string" ? cfg.opencodeProvider : "";
        json(res, 200, { opencodeProvider });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/agentflow-config") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const raw = payload.opencodeProvider;
      const opencodeProvider = typeof raw === "string" ? raw.trim() : "";
      try {
        const cfgPath = getAgentflowUserConfigAbs();
        const prev = readAgentflowUserConfigObject();
        const next = { ...prev };
        if (opencodeProvider) next.opencodeProvider = opencodeProvider;
        else delete next.opencodeProvider;
        fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
        fs.writeFileSync(cfgPath, JSON.stringify(next, null, 2), "utf-8");
        await updateModelLists(root);
        json(res, 200, {
          success: true,
          opencodeProvider: opencodeProvider || "",
          modelLists: readModelListsFromDisk(root),
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/mcps") {
      try {
        json(res, 200, readCursorMcpServers(userCtx));
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/mcps") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      try {
        json(res, 200, writeCursorMcpServer(payload, userCtx));
      } catch (e) {
        json(res, 400, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/mcps/delete") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      try {
        json(res, 200, deleteCursorMcpServer(payload?.name, userCtx));
      } catch (e) {
        json(res, 400, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/mcps/check") {
      let payload;
      try {
        const raw = await readBody(req);
        payload = raw && String(raw).trim() ? JSON.parse(raw) : {};
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      try {
        json(res, 200, await checkCursorMcpServers(payload?.name || "", userCtx));
      } catch (e) {
        json(res, 400, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/user-env") {
      try {
        json(res, 200, {
          env: readUserEnvRows(userCtx.userId),
          globalEnv: authUser?.isAdmin ? readGlobalEnvRows() : [],
          canEditGlobalEnv: Boolean(authUser?.isAdmin),
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/user-env") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      try {
        if (Object.prototype.hasOwnProperty.call(payload || {}, "globalEnv") && !authUser?.isAdmin) {
          json(res, 403, { error: "Admin permission required" });
          return;
        }
        const envRows = writeUserEnvRows(userCtx.userId, payload?.env || []);
        const globalEnvRows = authUser?.isAdmin && Object.prototype.hasOwnProperty.call(payload || {}, "globalEnv")
          ? writeGlobalEnvRows(payload?.globalEnv || [])
          : readGlobalEnvRows();
        json(res, 200, {
          success: true,
          env: envRows,
          globalEnv: authUser?.isAdmin ? globalEnvRows : [],
          canEditGlobalEnv: Boolean(authUser?.isAdmin),
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/update-model-lists") {
      try {
        let opencodeProviderOverride = "";
        const raw = await readBody(req);
        if (raw && String(raw).trim()) {
          try {
            const payload = JSON.parse(raw);
            const o = payload?.opencodeProvider;
            if (typeof o === "string") opencodeProviderOverride = o.trim();
          } catch {
            /* 忽略非 JSON body，仍按 config 拉取 */
          }
        }
        await updateModelLists(root, { opencodeProviderOverride });
        json(res, 200, { success: true, modelLists: readModelListsFromDisk(root) });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/skillhub/status") {
      const versionRes = await runSkillhub(["version"], { cwd: root, timeoutMs: 15_000 });
      const whoRes = await runSkillhub(["whoami"], { cwd: root, timeoutMs: 15_000 });
      json(res, 200, {
        available: versionRes.ok,
        version: versionRes.ok ? versionRes.stdout.trim() : "",
        loggedIn: whoRes.ok,
        user: whoRes.ok ? whoRes.stdout.trim() : "",
        error: versionRes.ok ? "" : versionRes.error,
      });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/skillhub/list") {
      const target = url.searchParams.get("target") || "global";
      const agent = url.searchParams.get("agent") || "codex";
      const args = ["list", "--json"];
      if (target === "all") args.push("--all");
      else if (target === "global") args.push("--global", "--agent", agent);
      const result = await runSkillhub(args, { cwd: root });
      if (!result.ok) {
        json(res, 500, { error: result.error, stdout: result.stdout });
        return;
      }
      json(res, 200, { skills: normalizeSkillhubListPayload(parseJsonText(result.stdout, [])) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/skillhub/search") {
      const q = (url.searchParams.get("q") || "").trim();
      const mode = (url.searchParams.get("mode") || "keyword").trim();
      if (!q) {
        json(res, 200, { total: 0, items: [] });
        return;
      }
      if (mode === "collectionId") {
        const info = await fetchSkillhubCollectionInfo(q);
        json(res, 200, {
          total: 1,
          mode,
          items: [info || {
            id: `collection:${q}`,
            collection: q,
            kind: "collection",
            slug: "",
            name: `Collection ${q}`,
            summary: "按 Collection ID 安装该合集中的全部 Skills。",
            version: "",
            tags: [],
          }],
        });
        return;
      }
      const result = await runSkillhub(["search", "-q", q], { cwd: root });
      if (!result.ok) {
        json(res, 500, { error: result.error, stdout: result.stdout });
        return;
      }
      const payload = normalizeSkillhubSearchPayload(parseJsonText(result.stdout, {}));
      if (mode === "skillId") {
        const filtered = payload.items.filter((item) => item.skillId === q || item.id === q);
        json(res, 200, { ...payload, mode, total: filtered.length, items: filtered });
        return;
      }
      json(res, 200, { ...payload, mode });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/skillhub/install") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const args = skillhubInstallArgs(payload);
      if (!args) {
        json(res, 400, { error: "Missing skill slug or collection" });
        return;
      }
      if (payload?.collection && !authUser?.isAdmin) {
        json(res, 403, { error: "Admin required" });
        return;
      }
      const beforeSkills = payload?.collection ? listComposerSkills(PACKAGE_ROOT, root) : [];
      const result = await runSkillhub(args, { cwd: root, timeoutMs: 180_000, maxBuffer: 4 * 1024 * 1024 });
      if (!result.ok) {
        json(res, 500, { error: result.error, stdout: result.stdout });
        return;
      }
      let skillCollections = null;
      if (payload?.collection) {
        const afterSkills = listComposerSkills(PACKAGE_ROOT, root);
        const collectionName = String(payload.collectionName || payload.name || "").trim();
        skillCollections = upsertSkillhubCollectionGroup(userCtx, payload.collection, beforeSkills, afterSkills, collectionName);
      }
      json(res, 200, { ok: true, stdout: result.stdout, skillCollections });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/skillhub/uninstall") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const args = skillhubInstallArgs(payload, { uninstall: true });
      if (!args) {
        json(res, 400, { error: "Missing skill slug or collection" });
        return;
      }
      if (payload?.collection && !authUser?.isAdmin) {
        json(res, 403, { error: "Admin required" });
        return;
      }
      const result = await runSkillhub(args, { cwd: root, timeoutMs: 120_000, maxBuffer: 4 * 1024 * 1024 });
      if (!result.ok) {
        json(res, 500, { error: result.error, stdout: result.stdout });
        return;
      }
      const skillCollections = payload?.collection ? removeSkillhubCollectionGroup(userCtx, payload.collection, root) : null;
      json(res, 200, { ok: true, stdout: result.stdout, skillCollections });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/skillhub/update") {
      const result = await runSkillhub(["update"], { cwd: root, timeoutMs: 180_000, maxBuffer: 4 * 1024 * 1024 });
      if (!result.ok) {
        json(res, 500, { error: result.error, stdout: result.stdout });
        return;
      }
      json(res, 200, { ok: true, stdout: result.stdout });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/nodes") {
      const flowId = url.searchParams.get("flowId");
      const flowSource = url.searchParams.get("flowSource") || "user";
      const lang = url.searchParams.get("lang") || "en";
      const marketplaceScope = url.searchParams.get("scope") === "owned" ? "owned" : "all";
      if (flowId && !isValidFlowSourceRead(flowSource)) {
        json(res, 400, { error: "Invalid flowSource" });
        return;
      }
      const nodesArchived = url.searchParams.get("archived") === "1";
      try {
        const { setLanguage } = await import("./i18n.mjs");
        setLanguage(lang);
        json(res, 200, listNodesJson(root, flowId || "", flowId ? flowSource : "", { archived: nodesArchived, ...userCtx, marketplaceScope }));
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/nodes/detail") {
      const nodeId = url.searchParams.get("id") || "";
      const flowId = url.searchParams.get("flowId") || "";
      const flowSource = url.searchParams.get("flowSource") || "";
      if (!nodeId) {
        json(res, 400, { error: "Missing node id" });
        return;
      }
      if (flowId && !isValidFlowSourceRead(flowSource || "user")) {
        json(res, 400, { error: "Invalid flowSource" });
        return;
      }
      const archived = url.searchParams.get("archived") === "1";
      try {
        const detail = readNodeDetailJson(root, nodeId, flowId, flowId ? (flowSource || "user") : "", { archived, ...userCtx });
        if (detail.error) {
          json(res, 404, { error: detail.error });
          return;
        }
        json(res, 200, detail);
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/nodes/file") {
      const nodeId = url.searchParams.get("id") || "";
      const relPath = url.searchParams.get("path") || "";
      const flowId = url.searchParams.get("flowId") || "";
      const flowSource = url.searchParams.get("flowSource") || "";
      if (!nodeId || !relPath) {
        json(res, 400, { error: "Missing node id or path" });
        return;
      }
      if (flowId && !isValidFlowSourceRead(flowSource || "user")) {
        json(res, 400, { error: "Invalid flowSource" });
        return;
      }
      const archived = url.searchParams.get("archived") === "1";
      try {
        const file = readNodeFilePreview(root, nodeId, relPath, flowId, flowId ? (flowSource || "user") : "", { archived, ...userCtx });
        if (file.error) {
          json(res, 404, { error: file.error });
          return;
        }
        json(res, 200, file);
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/marketplace/nodes") {
      try {
        const marketplaceScope = url.searchParams.get("scope") === "owned" ? "owned" : "all";
        json(res, 200, listMarketplacePackages(root, { ...userCtx, marketplaceScope }));
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/marketplace/flow-snippets") {
      try {
        const marketplaceScope = url.searchParams.get("scope") === "owned" ? "owned" : "all";
        json(res, 200, listMarketplaceFlowSnippets(root, { ...userCtx, marketplaceScope }));
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "DELETE" && url.pathname === "/api/marketplace/node") {
      const id = url.searchParams.get("id") || "";
      const version = url.searchParams.get("version") || "";
      if (!id || !version) {
        json(res, 400, { ok: false, error: "Missing marketplace node id or version" });
        return;
      }
      try {
        const result = deleteMarketplaceNodePackage(root, id, version, userCtx);
        json(res, result.ok ? 200 : 400, result);
      } catch (e) {
        json(res, 500, { ok: false, error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "DELETE" && url.pathname === "/api/marketplace/flow-snippet") {
      const id = url.searchParams.get("id") || "";
      const version = url.searchParams.get("version") || "";
      if (!id || !version) {
        json(res, 400, { ok: false, error: "Missing flow snippet id or version" });
        return;
      }
      try {
        const result = deleteMarketplaceFlowSnippetPackage(root, id, version, userCtx);
        json(res, result.ok ? 200 : 400, result);
      } catch (e) {
        json(res, 500, { ok: false, error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/marketplace/install-node") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const flowId = payload?.flowId;
      const flowSource = payload?.flowSource || "user";
      const flowArchived = payload?.archived === true;
      const nodeSpec = payload?.nodeSpec || payload?.definitionId || payload?.id;
      if (!flowId) {
        json(res, 400, { error: "Missing flowId" });
        return;
      }
      if (!nodeSpec) {
        json(res, 400, { error: "Missing nodeSpec" });
        return;
      }
      if (flowArchived || !isValidFlowSourceWrite(flowSource)) {
        json(res, 400, { error: "Cannot install marketplace nodes into builtin or archived flow" });
        return;
      }
      try {
        const resolved = resolveFlowDirForWrite(root, flowId, flowSource, userCtx);
        if (resolved.error || !resolved.flowDir) {
          json(res, 400, { error: resolved.error || "Could not resolve flow directory" });
          return;
        }
        const result = installFlowDependency(root, resolved.flowDir, nodeSpec, userCtx);
        json(res, result.ok ? 200 : 400, result);
      } catch (e) {
        json(res, 500, { ok: false, error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/marketplace/publish-node-from-instance") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      try {
        const flowId = payload?.flowId;
        const flowSource = payload?.flowSource || "user";
        let flowDir = "";
        if (flowId && isValidFlowSourceWrite(flowSource)) {
          const resolved = resolveFlowDirForWrite(root, flowId, flowSource, userCtx);
          if (!resolved.error && resolved.flowDir) flowDir = resolved.flowDir;
        }
        const result = publishNodeFromInstance(root, payload || {}, { flowDir, ...userCtx });
        json(res, result.ok ? 200 : 400, result);
      } catch (e) {
        json(res, 500, { ok: false, error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/marketplace/publish-flow-snippet") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      try {
        const result = publishFlowSnippet(root, payload || {}, userCtx);
        json(res, result.ok ? 200 : 400, result);
      } catch (e) {
        json(res, 500, { ok: false, error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/flow") {
      const flowId = url.searchParams.get("flowId");
      const flowSource = url.searchParams.get("flowSource") || "user";
      if (!flowId) {
        json(res, 400, { error: "Missing flowId" });
        return;
      }
      if (!isValidFlowSourceRead(flowSource)) {
        json(res, 400, { error: "Invalid flowSource" });
        return;
      }
      const flowArchived = url.searchParams.get("archived") === "1";
      const result = readFlowJson(root, flowId, flowSource, { archived: flowArchived, ...userCtx });
      if (result.error) {
        json(res, 404, result);
        return;
      }
      json(res, 200, result);
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/flow") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }

      if (payload.action === "save-user-check-content") {
        const runUuid = payload.runUuid;
        const instanceId = payload.instanceId;
        const content = payload.content;
        if (!runUuid || !instanceId || typeof content !== "string") {
          json(res, 400, { error: "Missing runUuid, instanceId, or content" });
          return;
        }
        const runDir = path.join(getRunDir(root, payload.flowId || "unknown", runUuid, userCtx));
        const outputPath = path.join(runDir, `output/${instanceId}/node_${instanceId}_content.md`);
        try {
          fs.mkdirSync(path.dirname(outputPath), { recursive: true });
          fs.writeFileSync(outputPath, content, "utf-8");
          json(res, 200, { ok: true, savedPath: outputPath });
        } catch (e) {
          json(res, 500, { ok: false, error: e.message });
        }
        return;
      }

      if (payload.action === "ai-edit-user-check-content") {
        const runUuid = payload.runUuid;
        const instanceId = payload.instanceId;
        const content = payload.content;
        const aiPrompt = payload.prompt;
        if (!runUuid || !instanceId || typeof content !== "string" || typeof aiPrompt !== "string") {
          json(res, 400, { error: "Missing runUuid, instanceId, content, or prompt" });
          return;
        }

        const fullPrompt = `请根据以下指令修改内容。直接输出修改后的完整内容，不要解释。

原始内容：
---
${content}
---

修改指令：${aiPrompt}

请直接输出修改后的完整内容（保持原有格式）：`;

        const opencodeCmd = process.env.OPENCODE_CMD || "opencode";
        const tmpPromptFile = path.join(
          getRunDir(root, payload.flowId || "unknown", runUuid, userCtx),
          "intermediate",
          `${instanceId}_ai_edit_prompt.txt`,
        );
        try {
          fs.mkdirSync(path.dirname(tmpPromptFile), { recursive: true });
          fs.writeFileSync(tmpPromptFile, fullPrompt, "utf-8");
        } catch (e) {
          json(res, 500, { ok: false, error: `Failed to write prompt file: ${e.message}` });
          return;
        }

        const child = spawn(opencodeCmd, ["--prompt-file", tmpPromptFile, "--print"], {
          cwd: root,
          env: { ...process.env, OPENCODE_NON_INTERACTIVE: "1" },
          stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => { stdout += String(d); });
        child.stderr.on("data", (d) => { stderr += String(d); });
        child.on("close", (code) => {
          try { fs.unlinkSync(tmpPromptFile); } catch (_) {}
          if (code === 0 && stdout.trim()) {
            json(res, 200, { ok: true, content: stdout.trim() });
          } else {
            json(res, 500, { ok: false, error: stderr.trim() || `OpenCode exited with code ${code}` });
          }
        });
        child.on("error", (err) => {
          try { fs.unlinkSync(tmpPromptFile); } catch (_) {}
          json(res, 500, { ok: false, error: `Failed to run OpenCode: ${err.message}` });
        });
        return;
      }

      if (payload.action === "confirm-user-check") {
        const runUuid = payload.runUuid;
        const instanceId = payload.instanceId;
        const execId = payload.execId ?? 1;
        if (!runUuid || !instanceId) {
          json(res, 400, { error: "Missing runUuid or instanceId" });
          return;
        }
        const runDir = path.join(getRunDir(root, payload.flowId || "unknown", runUuid, userCtx));
        const resultPath = path.join(runDir, `intermediate/${instanceId}/${instanceId}.result.md`);
        try {
          fs.mkdirSync(path.dirname(resultPath), { recursive: true });
          const resultContent = `---
status: "success"
execId: "${execId}"
message: "用户确认通过"
finishedAt: "${new Date().toISOString()}"
---
`;
          fs.writeFileSync(resultPath, resultContent, "utf-8");
          json(res, 200, { ok: true, resultPath });
        } catch (e) {
          json(res, 500, { ok: false, error: e.message });
        }
        return;
      }

      if (payload.action === "confirm-user-ask") {
        const runUuid = payload.runUuid;
        const instanceId = payload.instanceId;
        const execId = payload.execId ?? 1;
        const branch = payload.branch;
        const selectedIndex = payload.selectedIndex;
        const selectedLabel = payload.selectedLabel;
        if (!runUuid || !instanceId || !branch) {
          json(res, 400, { error: "Missing runUuid, instanceId, or branch" });
          return;
        }
        const runDir = path.join(getRunDir(root, payload.flowId || "unknown", runUuid, userCtx));
        const resultPath = path.join(runDir, `intermediate/${instanceId}/${instanceId}.result.md`);
        try {
          fs.mkdirSync(path.dirname(resultPath), { recursive: true });
          const escapeYaml = (v) => {
            const s = String(v ?? "");
            if (/[\n"\\:]/.test(s)) return '"' + s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n") + '"';
            return '"' + s + '"';
          };
          const lines = [
            "---",
            `status: "success"`,
            `execId: "${execId}"`,
            `branch: ${escapeYaml(branch)}`,
            `message: ${escapeYaml(selectedLabel ? `用户选择 ${branch} (${selectedLabel})` : `用户选择 ${branch}`)}`,
            `finishedAt: "${new Date().toISOString()}"`,
          ];
          if (selectedIndex != null && Number.isFinite(Number(selectedIndex))) {
            lines.push(`selectedIndex: ${Number(selectedIndex)}`);
          }
          if (selectedLabel != null && String(selectedLabel).trim() !== "") {
            lines.push(`selectedLabel: ${escapeYaml(selectedLabel)}`);
          }
          lines.push("---", "");
          fs.writeFileSync(resultPath, lines.join("\n"), "utf-8");
          json(res, 200, { ok: true, resultPath });
        } catch (e) {
          json(res, 500, { ok: false, error: e.message });
        }
        return;
      }

      const flowId = payload.flowId;
      const flowSource = payload.flowSource || "user";
      const flowYaml = payload.flowYaml;
      if (!flowId || typeof flowId !== "string") {
        json(res, 400, { error: "Missing or invalid flowId" });
        return;
      }
      if (!isValidFlowSourceWrite(flowSource)) {
        json(res, 400, { error: "Invalid flowSource (use user or workspace; builtin is read-only)" });
        return;
      }
      if (typeof flowYaml !== "string") {
        json(res, 400, { error: "Missing or invalid flowYaml" });
        return;
      }
      const flowArchived = Boolean(payload.flowArchived);
      const result = writeFlowYaml(root, flowId, flowSource, flowYaml, { archived: flowArchived, ...userCtx });
      if (!result.success) {
        json(res, 400, result);
        return;
      }
      json(res, 200, { success: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/flow-editor-sync") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const flowId = payload.flowId;
      const flowSource = payload.flowSource || "user";
      if (!flowId || typeof flowId !== "string") {
        json(res, 400, { error: "Missing or invalid flowId" });
        return;
      }
      if (!isValidFlowSourceRead(flowSource)) {
        json(res, 400, { error: "Invalid flowSource" });
        return;
      }
      const flowArchived = Boolean(payload.flowArchived);
      broadcastFlowEditorSync(flowId, flowSource, flowArchived, userCtx.userId);
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/flow-editor-sync-events") {
      const flowId = url.searchParams.get("flowId");
      const flowSource = url.searchParams.get("flowSource") || "user";
      if (!flowId) {
        json(res, 400, { error: "Missing flowId" });
        return;
      }
      if (!isValidFlowSourceRead(flowSource)) {
        json(res, 400, { error: "Invalid flowSource" });
        return;
      }
      const flowArchived = url.searchParams.get("archived") === "1";
      const key = flowEditorSyncKey(flowId, flowSource, flowArchived, userCtx.userId);
      let set = flowEditorSyncSubscribers.get(key);
      if (!set) {
        set = new Set();
        flowEditorSyncSubscribers.set(key, set);
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Content-Type-Options": "nosniff",
      });
      res.write(": connected\n\n");
      set.add(res);
      const detach = () => {
        try {
          set.delete(res);
          if (set.size === 0) flowEditorSyncSubscribers.delete(key);
        } catch (_) {}
      };
      req.on("close", detach);
      res.on("close", detach);
      return;
    }

    /* 轮询替代 SSE：客户端传上次已知的 version，若服务端 version 更大则返回 changed:true */
    if (req.method === "GET" && url.pathname === "/api/flow-editor-sync-poll") {
      const flowId = url.searchParams.get("flowId");
      const flowSource = url.searchParams.get("flowSource") || "user";
      if (!flowId) {
        json(res, 400, { error: "Missing flowId" });
        return;
      }
      const flowArchived = url.searchParams.get("archived") === "1";
      const key = flowEditorSyncKey(flowId, flowSource, flowArchived, userCtx.userId);
      const serverVer = flowEditorSyncVersions.get(key) ?? 0;
      const clientVer = parseInt(url.searchParams.get("v") ?? "0", 10) || 0;
      json(res, 200, { version: serverVer, changed: serverVer > clientVer });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/flow/move") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const flowId = payload.flowId;
      const fromSource = payload.fromSource;
      const toSource = payload.toSource;
      if (!flowId || typeof flowId !== "string") {
        json(res, 400, { error: "Missing or invalid flowId" });
        return;
      }
      if (fromSource !== "user" && fromSource !== "workspace") {
        json(res, 400, { error: "Invalid fromSource" });
        return;
      }
      if (toSource !== "user" && toSource !== "workspace") {
        json(res, 400, { error: "Invalid toSource" });
        return;
      }
      const result = moveFlowDirectory(root, flowId.trim(), fromSource, toSource, userCtx);
      if (!result.success) {
        json(res, 400, { error: result.error || "Move failed" });
        return;
      }
      json(res, 200, { success: true, flowId: flowId.trim(), flowSource: result.flowSource });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/flow/rename") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const flowId = typeof payload.flowId === "string" ? payload.flowId.trim() : "";
      const flowSource = payload.flowSource || "user";
      const newFlowId = typeof payload.newFlowId === "string" ? payload.newFlowId.trim() : "";
      if (!flowId || !newFlowId) {
        json(res, 400, { error: "Missing flowId or newFlowId" });
        return;
      }
      if (flowSource !== "user" && flowSource !== "workspace") {
        json(res, 400, { error: "仅支持重命名用户目录或工作区流水线" });
        return;
      }
      const validation = validateUserPipelineId(newFlowId);
      if (!validation.ok) {
        json(res, 400, { error: validation.error });
        return;
      }
      if (flowId === validation.flowId) {
        json(res, 200, { success: true, flowId, flowSource });
        return;
      }
      const yamlRes = getFlowYamlAbs(root, flowId, flowSource, { archived: false, ...userCtx });
      if (yamlRes.error || !yamlRes.path) {
        json(res, 404, { error: yamlRes.error || "找不到流水线" });
        return;
      }
      const fromDir = path.dirname(yamlRes.path);
      const toDir = path.join(path.dirname(fromDir), validation.flowId);
      if (fs.existsSync(toDir)) {
        json(res, 409, { error: "目标名称已存在" });
        return;
      }
      try {
        fs.renameSync(fromDir, toDir);
        json(res, 200, { success: true, flowId: validation.flowId, flowSource });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/flow/archive") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const flowId = typeof payload.flowId === "string" ? payload.flowId.trim() : "";
      const flowSource = payload.flowSource || "user";
      const confirm = typeof payload.confirmFlowId === "string" ? payload.confirmFlowId.trim() : "";
      if (!flowId) {
        json(res, 400, { error: "Missing or invalid flowId" });
        return;
      }
      if (confirm !== flowId) {
        json(res, 400, { error: "确认名称与流水线 ID 不一致" });
        return;
      }
      if (flowSource !== "user" && flowSource !== "workspace") {
        json(res, 400, { error: "仅支持归档用户目录或工作区流水线" });
        return;
      }
      const result = archiveFlowPipeline(root, flowId, flowSource, userCtx);
      if (!result.success) {
        json(res, 400, { error: result.error || "归档失败" });
        return;
      }
      json(res, 200, { success: true, flowId, flowSource, archived: true });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/flow/delete") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const flowId = typeof payload.flowId === "string" ? payload.flowId.trim() : "";
      const flowSource = payload.flowSource || "user";
      const confirm = typeof payload.confirmFlowId === "string" ? payload.confirmFlowId.trim() : "";
      const flowArchived = Boolean(payload.flowArchived);
      if (!flowId) {
        json(res, 400, { error: "Missing or invalid flowId" });
        return;
      }
      if (confirm !== flowId) {
        json(res, 400, { error: "确认名称与流水线 ID 不一致" });
        return;
      }
      if (flowSource !== "user" && flowSource !== "workspace") {
        json(res, 400, { error: "仅支持删除用户目录或工作区流水线" });
        return;
      }
      const result = deleteFlowPipeline(root, flowId, flowSource, { archived: flowArchived, ...userCtx });
      if (!result.success) {
        json(res, 400, { error: result.error || "删除失败" });
        return;
      }
      json(res, 200, { success: true, flowId, flowSource, deleted: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/flow/run-config") {
      const flowId = url.searchParams.get("flowId");
      const flowSource = url.searchParams.get("flowSource") || "user";
      const flowArchived = url.searchParams.get("archived") === "1";
      if (!flowId) {
        json(res, 400, { error: "Missing flowId" });
        return;
      }
      if (!isValidFlowSourceRead(flowSource)) {
        json(res, 400, { error: "Invalid flowSource" });
        return;
      }
      const yamlRes = getFlowYamlAbs(root, flowId, flowSource, { archived: flowArchived, ...userCtx });
      if (yamlRes.error) {
        json(res, 404, { error: yamlRes.error });
        return;
      }
      const configPath = path.join(path.dirname(yamlRes.path), RUN_CONFIG_FILENAME);
      try {
        if (!fs.existsSync(configPath)) {
          json(res, 200, { presets: {}, activePreset: null });
          return;
        }
        const data = JSON.parse(fs.readFileSync(configPath, "utf-8"));
        json(res, 200, {
          presets: data.presets && typeof data.presets === "object" ? data.presets : {},
          activePreset: typeof data.activePreset === "string" ? data.activePreset : null,
        });
      } catch (e) {
        json(res, 500, { error: e.message });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/flow/run-config") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const flowId = payload.flowId;
      const flowSource = payload.flowSource || "user";
      const flowArchived = payload.archived === true;
      if (!flowId) {
        json(res, 400, { error: "Missing flowId" });
        return;
      }
      if (!isValidFlowSourceWrite(flowSource)) {
        json(res, 400, { error: "Cannot save config to builtin or archived flow" });
        return;
      }
      const yamlRes = getFlowYamlAbs(root, flowId, flowSource, { archived: flowArchived, ...userCtx });
      if (yamlRes.error) {
        json(res, 404, { error: yamlRes.error });
        return;
      }
      const configPath = path.join(path.dirname(yamlRes.path), RUN_CONFIG_FILENAME);
      try {
        const presets = payload.presets && typeof payload.presets === "object" ? payload.presets : {};
        const activePreset = typeof payload.activePreset === "string" ? payload.activePreset : null;
        const data = { presets, activePreset };
        fs.writeFileSync(configPath, JSON.stringify(data, null, 2), "utf-8");
        json(res, 200, { success: true });
      } catch (e) {
        json(res, 500, { error: e.message });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/flow/schedule") {
      const flowId = url.searchParams.get("flowId");
      const flowSource = url.searchParams.get("flowSource") || "user";
      const flowArchived = url.searchParams.get("archived") === "1";
      if (!flowId) {
        json(res, 400, { error: "Missing flowId" });
        return;
      }
      if (!isValidFlowSourceRead(flowSource)) {
        json(res, 400, { error: "Invalid flowSource" });
        return;
      }
      const result = readFlowSchedule(root, flowId, flowSource, { archived: flowArchived, ...userCtx });
      if (!result.success) {
        json(res, 400, { error: result.error || "Could not read schedule" });
        return;
      }
      const status = listScheduleStatuses(root, userCtx).find(
        (s) => s.flowId === flowId && (s.flowSource || "user") === (flowSource || "user"),
      );
      json(res, 200, { schedule: result.schedule, state: result.state || {}, status: status || null });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/flow/schedule") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const flowId = payload.flowId;
      const flowSource = payload.flowSource || "user";
      const flowArchived = payload.archived === true;
      if (!flowId) {
        json(res, 400, { error: "Missing flowId" });
        return;
      }
      if (flowArchived || !isValidFlowSourceWrite(flowSource)) {
        json(res, 400, { error: "Cannot save schedule to builtin or archived flow" });
        return;
      }
      const result = writeFlowSchedule(root, flowId, flowSource, payload.schedule || {}, userCtx);
      if (!result.success) {
        json(res, 400, { error: result.error || "Could not save schedule" });
        return;
      }
      json(res, 200, { success: true, schedule: result.schedule });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/flow/run") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const flowId = typeof payload.flowId === "string" ? payload.flowId.trim() : "";
      if (!flowId) {
        json(res, 400, { error: "Missing flowId" });
        return;
      }
      const runUuid = typeof payload.uuid === "string" ? payload.uuid.trim() : "";
      const runKey = `${userCtx.userId || ""}:${payload.flowSource || "user"}:${flowId}`;
      if (activeFlowRuns.has(runKey)) {
        json(res, 409, { error: "该流水线已在运行中" });
        return;
      }

      // resume: 清除上次 Pause 写入的中断标记，否则 inferRunStatusFromRunDir 仍返回 "stopped"，
      // UI 轮询会把 runMode 翻回 stopped，即便 CLI 正在运行也显示 PAUSED。
      if (runUuid) {
        try {
          const runDir = getRunDir(root, flowId, runUuid, userCtx);
          const interruptedPath = path.join(runDir, RUN_INTERRUPTED_FILENAME);
          if (fs.existsSync(interruptedPath)) fs.unlinkSync(interruptedPath);
        } catch (e) {
          log.debug(`[ui] flow/run: could not clear ${RUN_INTERRUPTED_FILENAME}: ${e && e.message}`);
        }
      }

      const agentflowBin = path.join(PACKAGE_ROOT, "bin", "agentflow.mjs");
      const args = [agentflowBin, runUuid ? "resume" : "apply", flowId];
      if (runUuid) args.push(runUuid);
      args.push("--machine-readable", "--workspace-root", root);
      if (payload.force !== false) args.push("--force");

      if (payload.cliInputs && typeof payload.cliInputs === "object") {
        for (const [name, val] of Object.entries(payload.cliInputs)) {
          if (!name || typeof name !== "string") continue;
          if (!val || typeof val !== "object") continue;
          const type = val.type;
          if (type === "file" && typeof val.path === "string") {
            args.push("--input", `${name}=file:${val.path}`);
          } else if (type === "str" && typeof val.value === "string") {
            args.push("--input", `${name}=${val.value}`);
          }
        }
      }

      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Content-Type-Options": "nosniff",
      });
      try {
        res.socket?.setNoDelay?.(true);
      } catch (_) {}

      let responseEnded = false;
      let clientDisconnected = false;
      const endSafe = () => {
        if (responseEnded) return;
        responseEnded = true;
        activeFlowRuns.delete(runKey);
        try {
          res.end();
        } catch (_) {}
      };
      const writeLine = (obj) => {
        if (responseEnded || clientDisconnected) return;
        try { res.write(JSON.stringify(obj) + "\n"); } catch (_) { clientDisconnected = true; }
      };

      let child;
      try {
        child = spawn(process.execPath, args, {
          cwd: root,
          stdio: ["ignore", "pipe", "pipe"],
          env: runtimeEnvForUser(userCtx, { FORCE_COLOR: "0" }),
          // detached: true 使 child 成为新进程组 leader，/api/flow/run/stop 时
          // 用 process.kill(-pid) 可以一次性 SIGTERM 整棵进程树（含 cursor-agent 等孙进程）
          detached: true,
        });
      } catch (e) {
        writeLine({ type: "error", message: `启动失败: ${e.message}` });
        endSafe();
        return;
      }

      /** @type {{ child: import("child_process").ChildProcess, runUuid: string | null }} */
      const runEntry = { child, runUuid: runUuid || null };
      activeFlowRuns.set(runKey, runEntry);
      log.debug(`[ui] flow/run: spawned pid=${child.pid} flowId=${flowId}${runUuid ? ` uuid=${runUuid}` : ""}`);

      let stdoutBuf = "";
      child.stdout.on("data", (chunk) => {
        stdoutBuf += chunk.toString("utf8");
        const lines = stdoutBuf.split("\n");
        stdoutBuf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line);
            if (evt && evt.event === "apply-start" && typeof evt.uuid === "string" && evt.uuid.trim()) {
              runEntry.runUuid = evt.uuid.trim();
            }
            writeLine({ type: "event", ...evt });
          } catch {
            writeLine({ type: "log", text: line });
          }
        }
      });

      let stderrBuf = "";
      child.stderr.on("data", (chunk) => {
        stderrBuf += chunk.toString("utf8");
        const lines = stderrBuf.split("\n");
        stderrBuf = lines.pop();
        for (const line of lines) {
          if (!line.trim()) continue;
          writeLine({ type: "log", text: line });
        }
      });

      child.on("close", (code) => {
        if (stderrBuf.trim()) writeLine({ type: "log", text: stderrBuf.trim() });
        if (stdoutBuf.trim()) {
          try {
            const evt = JSON.parse(stdoutBuf.trim());
            writeLine({ type: "event", ...evt });
          } catch {
            writeLine({ type: "log", text: stdoutBuf.trim() });
          }
        }
        writeLine({ type: "done", exitCode: code ?? 0 });
        endSafe();
      });

      child.on("error", (e) => {
        writeLine({ type: "error", message: e.message });
        endSafe();
      });

      req.on("close", () => {
        // 浏览器断开（刷新/关闭 tab）时不再杀子进程，让 flow 自然跑完。
        // 用户需显式停止请走 /api/flow/run/stop。
        clientDisconnected = true;
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/flow/run/stop") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const flowId = typeof payload.flowId === "string" ? payload.flowId.trim() : "";
      if (!flowId) {
        json(res, 400, { error: "Missing flowId" });
        return;
      }
      const runKey = `${userCtx.userId || ""}:${payload.flowSource || "user"}:${flowId}`;
      const entry = activeFlowRuns.get(runKey);
      if (!entry || !entry.child) {
        json(res, 404, { error: "该流水线未在运行" });
        return;
      }
      // 先尝试杀整个进程组（涵盖 cursor-agent / opencode 等孙进程）
      const pid = entry.child.pid;
      let killedGroup = false;
      if (pid && pid > 0) {
        try {
          process.kill(-pid, "SIGTERM");
          killedGroup = true;
        } catch (_) { /* 组不存在则降级 */ }
      }
      if (!killedGroup) {
        try { entry.child.kill("SIGTERM"); } catch (_) {}
      }
      const uuid = entry.runUuid;
      activeFlowRuns.delete(runKey);
      if (uuid) {
        try {
          const runDir = getRunDir(root, flowId, uuid, userCtx);
          fs.mkdirSync(runDir, { recursive: true });
          fs.writeFileSync(
            path.join(runDir, RUN_INTERRUPTED_FILENAME),
            JSON.stringify({ reason: "user_stop", at: Date.now() }, null, 2),
            "utf-8",
          );
        } catch (e) {
          log.debug(`[ui] flow/run/stop: could not write ${RUN_INTERRUPTED_FILENAME}: ${e && e.message}`);
        }
      }
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/skills") {
      json(res, 200, { skills: listComposerSkills(PACKAGE_ROOT, root) });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/skill-collections") {
      json(res, 200, readSkillCollectionConfig(userCtx, listComposerSkills(PACKAGE_ROOT, root)));
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/skill-collections") {
      if (!authUser?.isAdmin) {
        json(res, 403, { error: "Admin required" });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      try {
        json(res, 200, writeSkillCollectionConfig(userCtx, payload, listComposerSkills(PACKAGE_ROOT, root)));
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/skills/detail") {
      const key = url.searchParams.get("key") || url.searchParams.get("name") || "";
      const detail = readComposerSkillDetail(PACKAGE_ROOT, root, key);
      if (!detail) {
        json(res, 404, { error: "Skill not found" });
        return;
      }
      json(res, 200, { skill: detail });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/composer-agent") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const prompt = payload.prompt;
      const model = payload.model;
      const phaseRole = typeof payload.phaseRole === "string" ? payload.phaseRole.trim() : "";
      if (typeof prompt !== "string" || !prompt.trim()) {
        json(res, 400, { error: "Missing or empty prompt" });
        return;
      }
      if (typeof model !== "string" && model != null) {
        json(res, 400, { error: "Invalid model" });
        return;
      }
      const selectedSkillKeys = Array.isArray(payload.selectedSkills)
        ? payload.selectedSkills.map((x) => String(x || "").trim()).filter(Boolean).slice(0, 20)
        : [];

      const flowIdRaw = payload.flowId;
      const flowSourceRaw = payload.flowSource;
      const hasFlowId = flowIdRaw != null && String(flowIdRaw).trim() !== "";
      const hasFlowSource = flowSourceRaw != null && String(flowSourceRaw).trim() !== "";
      if (hasFlowId !== hasFlowSource) {
        json(res, 400, { error: "flowId and flowSource must both be set or both omitted" });
        return;
      }

      const threadRaw = Array.isArray(payload.thread) ? payload.thread : [];
      const thread = threadRaw
        .filter((m) => m && typeof m.text === "string" && m.text.trim() && (m.role === "user" || m.role === "assistant"))
        .map((m) => ({ role: m.role, text: String(m.text) }));

      let finalPrompt = prompt.trim();
      let cliWorkspace = root;
      let flowYamlAbs = null;
      let flowId = null;
      let flowSource = null;
      let instanceIds = [];
      let flowContextForMultiStep = null;
      let flowYamlBefore = null;
      const hasPhaseContext = payload.phaseContext && typeof payload.phaseContext === "object" && typeof payload.phaseContext.phaseIndex === "number";

      if (hasFlowId) {
        flowId = String(flowIdRaw).trim();
        flowSource = String(flowSourceRaw).trim();
        if (!isValidFlowSourceRead(flowSource)) {
          json(res, 400, { error: "Invalid flowSource" });
          return;
        }
        const flowArchived = Boolean(payload.flowArchived);
        const yamlRes = getFlowYamlAbs(root, flowId, flowSource, { archived: flowArchived, ...userCtx });
        if (yamlRes.error || !yamlRes.path) {
          json(res, 400, { error: yamlRes.error || "Could not resolve flow.yaml" });
          return;
        }
        flowYamlAbs = yamlRes.path;
        try { flowYamlBefore = fs.readFileSync(flowYamlAbs, "utf-8"); } catch { flowYamlBefore = null; }
        let workspaceWriteDirAbs;
        let editorSyncFlowSource = flowSource;
        let flowDirForCli = path.dirname(flowYamlAbs);
        if (isReadonlyBuiltinFlowSource(flowSource)) {
          const w = resolveFlowDirForWrite(root, flowId, "workspace", userCtx);
          if (w.error || !w.flowDir) {
            json(res, 400, { error: w.error || "Could not resolve workspace flow directory" });
            return;
          }
          workspaceWriteDirAbs = w.flowDir;
          editorSyncFlowSource = "workspace";
          flowDirForCli = w.flowDir;
        }
        instanceIds = normalizeContextInstanceIds(payload.contextInstanceIds);

        const syncFs = editorSyncFlowSource ?? flowSource;
        const syncBody = { flowId, flowSource: syncFs };
        if (flowArchived) syncBody.flowArchived = true;
        const syncJsonArg = JSON.stringify(JSON.stringify(syncBody));

        // 多步分阶段仍需要技能上下文；普通 Composer 请求直接交给 agent + skills 自行判断。
        const multiStepIntents = detectIntents(prompt);
        const selectedSkillResources = selectedSkillKeys.length > 0
          ? loadResourcesForSkillKeys(selectedSkillKeys, PACKAGE_ROOT, root)
          : { skills: [], references: [], skillsHint: "", hasContext: false };
        const multiStepResources = selectedSkillResources.hasContext
          ? selectedSkillResources
          : loadResourcesForIntents(multiStepIntents, PACKAGE_ROOT);
        const flowPipelineDir = flowYamlAbs ? path.dirname(flowYamlAbs) : "";
        const selectedSkillBlock = selectedSkillResources.hasContext
          ? buildSkillInjectionBlock(selectedSkillResources.skills, selectedSkillResources.references)
          : "";

        flowContextForMultiStep = {
          flowYamlAbs,
          flowId,
          flowSource,
          userId: userCtx.userId || "",
          intents: multiStepIntents,
          canvasInstanceIds: instanceIds,
          skillsHint: multiStepResources.skillsHint,
          skillInjectionBlock: multiStepResources.hasContext
            ? buildSkillCompactInjectionBlock(multiStepResources.skills, multiStepResources.references)
            : "",
          syncCurlHint: `curl -sS -X POST http://127.0.0.1:${uiPort}/api/flow-editor-sync -H 'Content-Type: application/json' -d ${syncJsonArg}`,
          composerSpecAbs: flowPipelineDir ? path.join(flowPipelineDir, COMPOSER_NODE_SPEC_FILENAME) : "",
          pipelineScriptsDirAbs: flowPipelineDir ? path.join(flowPipelineDir, "scripts") : "",
        };

        const scriptContentBlock = buildScriptContentBlockForInstances(flowYamlAbs, instanceIds);
        finalPrompt = buildComposerPromptWithFlowContext({
          flowYamlAbs,
          flowId,
          flowSource,
          workspaceWriteDirAbs,
          editorSyncFlowSource,
          instanceIds,
          userPrompt: prompt,
          uiPort,
          flowArchived,
          thread,
          scriptContentBlock,
          selectedSkillBlock,
        });
        cliWorkspace = composerCliWorkspaceForFlowDir(root, flowDirForCli);
      }

      if (!hasFlowId && thread.length > 0) {
        finalPrompt = formatThreadHistory(thread) + "\n\n## 用户说明\n\n" + finalPrompt;
      }

      let child = null;
      let multiStepAbort = null;
      let responseEnded = false;
      let clientDisconnected = false;
      
      const composerSession = createComposerSession(root);
      const composerLogPath = composerSession.logPath;
      
      const endSafe = () => {
        if (responseEnded) return;
        responseEnded = true;
        try {
          res.end();
        } catch (_) {}
      };
      const killChild = () => {
        if (multiStepAbort) {
          multiStepAbort();
          return;
        }
        if (child && !child.killed) {
          try {
            child.kill("SIGTERM");
          } catch (_) {}
        }
      };

      // 先发送响应头，建立 NDJSON 流连接，避免后续分类阻塞导致前端超时
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Content-Type-Options": "nosniff",
      });

      const onStreamEvent = (ev) => {
        if (responseEnded) return;

        // ai-log：full prompt/response 全文落盘，不写入 NDJSON 流（前端通过 /api/composer-logs 拉）
        if (ev && ev.type === "ai-log") {
          logComposerEvent(composerLogPath, ev.tag || "ai-log", {
            text: typeof ev.text === "string" ? ev.text : "",
            meta: ev.meta || {},
          });
          return;
        }

        // CLI natural 事件按 kind 拆 tag，便于日志按 AI 类别过滤；error kind 单独成 error tag
        let logTag = ev.type || "event";
        if (ev && ev.type === "natural" && ev.kind) {
          if (ev.kind === "error") logTag = "error";
          else logTag = `ai-${ev.kind}`; // ai-thinking | ai-assistant | ai-result | ai-tool
        }

        // 其他事件：全文落盘（不再截断），同时写入 NDJSON 流
        logComposerEvent(composerLogPath, logTag, ev);

        try {
          res.write(JSON.stringify(ev) + "\n");
        } catch (_) {
          killChild();
        }
      };

      req.on("close", () => {
        clientDisconnected = true;
        if (!responseEnded) killChild();
      });

      logComposerEvent(composerLogPath, "composer-start", {
        sessionId: composerSession.sessionId,
        flowId: flowId || null,
        flowSource: flowSource || null,
        model: model || null,
        prompt: truncateForLog(prompt.trim(), 1000),
        hasFlowId,
        threadLength: thread.length,
        instanceIds: instanceIds.slice(0, 10),
      });

      onStreamEvent({ type: "status", line: t("composer.analyzing_task") });
      log.debug(`[ui] composer-agent: flowId=${flowId || "(none)"} model=${model || "default"} promptLen=${finalPrompt.length}`);

      let useMultiStep;
      try {
        useMultiStep = hasPhaseContext && !payload.singleStep;
      } catch (classifyErr) {
        log.debug(`[ui] composer classify error: ${classifyErr.message}`);
        logComposerEvent(composerLogPath, "composer-done", {
          status: "failed",
          error: truncateForLog(classifyErr?.message || String(classifyErr), 500),
          code: "CLASSIFY_FAIL",
        });
        onStreamEvent({ type: "error", message: t("composer.classify_failed", { message: classifyErr.message }), code: "CLASSIFY_FAIL" });
        endSafe();
        return;
      }

      log.debug(`[ui] composer mode: ${useMultiStep ? "multi-step" : "single-step"}`);

      logComposerEvent(composerLogPath, "classify", {
        mode: useMultiStep ? "multi-step" : "single-step",
        hasPhaseContext,
      });

      if (useMultiStep) {
        try {
          onStreamEvent({ type: "status", line: t("composer.multi_step_starting") });
          const phaseContext = payload.phaseContext && typeof payload.phaseContext === "object" ? payload.phaseContext : undefined;
          const handle = startComposerMultiStep({
            uiWorkspaceRoot: root,
            cliWorkspace,
            userPrompt: prompt.trim(),
            fullPrompt: finalPrompt,
            modelKey: typeof model === "string" ? model.trim() : "",
            flowYamlAbs,
            flowId,
            flowSource,
            instanceIds,
            flowContext: flowContextForMultiStep,
            thread,
            phaseContext,
            phaseRole: phaseRole || undefined,
            agentflowUserId: userCtx.userId || "",
            force: true,
            onStreamEvent,
          });
          multiStepAbort = handle.abort;
          handle.finished
            .then(() => {
              if (!responseEnded) {
                logComposerEvent(composerLogPath, "composer-done", {
                  status: "success",
                  flowId: flowId || null,
                  flowSource: flowSource || null,
                });
                if (flowId && flowSource) {
                  broadcastFlowEditorSync(flowId, flowSource, Boolean(payload.flowArchived), userCtx.userId);
                }
                try { res.write(JSON.stringify({ type: "done" }) + "\n"); } catch (_) {}
              }
              endSafe();
            })
            .catch((e) => {
              if (!responseEnded) {
                logComposerEvent(composerLogPath, "composer-done", {
                  status: "failed",
                  error: truncateForLog(e?.message || String(e), 500),
                  code: "MULTI_STEP_FAIL",
                });
                try {
                  res.write(JSON.stringify({ type: "error", message: (e && e.message) || String(e), code: "MULTI_STEP_FAIL" }) + "\n");
                } catch (_) {}
              }
              endSafe();
            });
        } catch (e) {
          logComposerEvent(composerLogPath, "composer-done", {
            status: "failed",
            error: truncateForLog(e?.message || String(e), 500),
            code: "MULTI_STEP_INIT_FAIL",
          });
          try {
            res.write(JSON.stringify({ type: "error", message: (e && e.message) || String(e), code: "MULTI_STEP_INIT_FAIL" }) + "\n");
          } catch (_) {}
          endSafe();
        }
      } else {
        try {
          const handle = startComposerAgent({
            uiWorkspaceRoot: root,
            cliWorkspace,
            prompt: finalPrompt,
            modelKey: typeof model === "string" ? model.trim() : "",
            agentflowUserId: userCtx.userId || "",
            onStreamEvent,
          });
          child = handle.child;
          handle.finished
            .then(async () => {
              if (responseEnded) {
                endSafe();
                return;
              }
              const flowYamlChanged = flowYamlChangedSince(flowYamlAbs, flowYamlBefore);
              if (flowYamlChanged && flowYamlAbs && flowContextForMultiStep) {
                try {
                  await runComposerPostFlowValidationAndRepair({
                    uiWorkspaceRoot: root,
                    cliWorkspace,
                    flowYamlAbs,
                    flowContext: flowContextForMultiStep,
                    modelKey: typeof model === "string" ? model.trim() : "",
                    agentflowUserId: userCtx.userId || "",
                    force: true,
                    onStreamEvent,
                    getAborted: () => clientDisconnected || responseEnded,
                    setCurrentChild: (c) => {
                      child = c;
                    },
                  });
                } catch (e) {
                  onStreamEvent({
                    type: "natural",
                    kind: "error",
                    text: `校验修复异常: ${(e && e.message) || String(e)}`,
                  });
                }
              }
              if (!responseEnded) {
                logComposerEvent(composerLogPath, "composer-done", {
                  status: "success",
                  flowId: flowId || null,
                  flowSource: flowSource || null,
                });
                if (flowYamlChanged && flowId && flowSource) {
                  broadcastFlowEditorSync(flowId, flowSource, Boolean(payload.flowArchived), userCtx.userId);
                }
                try { res.write(JSON.stringify({ type: "done" }) + "\n"); } catch (_) {}
              }
              endSafe();
            })
            .catch((e) => {
              if (!responseEnded) {
                logComposerEvent(composerLogPath, "composer-done", {
                  status: "failed",
                  error: truncateForLog(e?.message || String(e), 500),
                  code: "SINGLE_STEP_FAIL",
                });
                try {
                  res.write(JSON.stringify({ type: "error", message: (e && e.message) || String(e), code: "SINGLE_STEP_FAIL" }) + "\n");
                } catch (_) {}
              }
              endSafe();
            });
} catch (e) {
          logComposerEvent(composerLogPath, "composer-done", {
            status: "failed",
            error: truncateForLog(e?.message || String(e), 500),
            code: "SINGLE_STEP_INIT_FAIL",
          });
          try {
            res.write(JSON.stringify({ type: "error", message: (e && e.message) || String(e), code: "SINGLE_STEP_INIT_FAIL" }) + "\n");
          } catch (_) {}
          endSafe();
        }
      }
      return;
    }

    if (req.method !== "GET") {
      res.writeHead(405, { Allow: "GET, POST" });
      res.end();
      return;
    }

    const safeRoot = path.resolve(staticDir);
    let rel = url.pathname.replace(/^\/+/, "") || "index.html";
    if (rel.includes("..") || path.isAbsolute(rel)) {
      res.writeHead(403);
      res.end();
      return;
    }
    let filePath = path.resolve(safeRoot, rel);
    if (filePath !== safeRoot && !filePath.startsWith(safeRoot + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, "index.html");
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      // 避免 /agentflow-icon.svg 缺失时回退成 index.html（浏览器当图片解析会破图）
      if (rel === "agentflow-icon.svg") {
        const pkgIcon = path.join(PACKAGE_ROOT, "builtin", "web-ui", "src", "assets", "agentflow-icon.svg");
        if (fs.existsSync(pkgIcon) && fs.statSync(pkgIcon).isFile()) {
          filePath = pkgIcon;
        }
      }
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      const fallback = path.join(staticDir, "index.html");
      if (fs.existsSync(fallback)) {
        filePath = fallback;
      } else {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
    }
    const ext = path.extname(filePath).toLowerCase();
    const type = MIME[ext] || "application/octet-stream";
    const data = fs.readFileSync(filePath);
    res.writeHead(200, { "Content-Type": type, "Content-Length": data.length });
    res.end(data);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      log.debug(`[ui] server listening on ${host}:${port}, workspace=${root}, static=${staticDir}`);
      updateModelLists(root).catch(() => {});
      resolve(server);
    });
  });
}
