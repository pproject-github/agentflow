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
  ARCHIVED_PIPELINES_DIR_NAME,
  getAgentflowDataRoot,
  getAgentflowSkillsRoot,
  getAgentflowUserConfigAbs,
  getAgentflowUserDataRoot,
  getUserPipelinesRoot,
  listAgentflowUserIds,
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
import { clearSkillRegistryCache } from "./skill-registry.mjs";
import { COMPOSER_NODE_SPEC_FILENAME } from "./composer-planner.mjs";
import { listRecentRunsFromDisk } from "./recent-runs.mjs";
import { parseBool } from "../pipeline/parse-bool.mjs";
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
import { computeNextRunAt, readFlowSchedule, writeFlowSchedule } from "./schedule-config.mjs";
import { listScheduleStatuses } from "./scheduler.mjs";
import {
  mergeWorkspaceGraphs,
  workspaceDesignRevision,
  workspaceRuntimeRevision,
} from "./workspace-graph-merge.mjs";
import {
  deleteMarketplaceFlowSnippetPackage,
  deleteMarketplaceNodePackage,
  installFlowDependency,
  listMarketplaceFlowSnippets,
  listMarketplacePackages,
  publishFlowSnippet,
  publishNodeFromInstance,
  resolveMarketplaceNodePackage,
} from "./marketplace.mjs";
import { buildGitContext, inferGitRepoRootFromWorktree, loadGitWorktree, normalizeGitContext, runGit, sanitizeWorktreeName, unloadGitWorktree } from "./git-worktree.mjs";
import { createGitLabMergeRequest } from "./gitlab-mr.mjs";
import { sendWecomAppMarkdown, sendWecomGroupMarkdown } from "./wecom.mjs";
import {
  authSetupRequired,
  buildClearSessionCookie,
  buildSessionCookie,
  getAuthUserFromRequest,
  getSessionTokenFromRequest,
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
import { readAdminStorageConfig, writeAdminStorageConfig } from "./admin-storage-config.mjs";
import {
  appendRunLedgerEvent,
  readRunLedgerEvents,
  runLedgerId,
} from "./run-ledger.mjs";
import { readAdminRunDetail } from "./admin-run-detail.mjs";
import {
  appendWorkspaceRunLogEvent,
  createWorkspaceRunLogSession,
  finishWorkspaceRunLogSession,
  listWorkspaceRunLogs,
  readWorkspaceRunLogEvents,
} from "./workspace-run-logs.mjs";
import { createWorkspaceRunController } from "./workspace-run-controller.mjs";
import {
  acceptWorkspaceCollaborationInvite,
  addWorkspaceCollaborationMember,
  deleteWorkspaceCollaborationById,
  deleteWorkspaceCollaborationForFlow,
  ensureWorkspaceCollaboration,
  getWorkspaceCollaborationByFlow,
  getWorkspaceCollaborationForProject,
  listWorkspaceCollaborationsForUser,
  removeWorkspaceCollaborationMember,
  updateWorkspaceCollaborationFlow,
  workspaceCollaborationAccess,
  workspaceCollaborationSummary,
} from "./workspace-collaboration.mjs";
import {
  addPrdWorkflowCollaborationMember,
  ensurePrdWorkflowCollaboration,
  getPrdWorkflowCollaborationById,
  getPrdWorkflowCollaborationByShareToken,
  getPrdWorkflowCollaborationForUser,
  ensurePrdWorkflowShareLink,
  prdWorkflowCollaborationAccess,
  prdWorkflowCollaborationSummary,
  removePrdWorkflowCollaborationMember,
  revokePrdWorkflowShareLink,
} from "./prd-workflow-collaboration.mjs";
import {
  legacyOverallToGlobalState,
  materializeWorkflowGlobalState,
  mergeWorkflowArtifactLists,
  mergeWorkflowArtifacts,
  mergeWorkflowGlobalState,
  normalizeWorkflowReference,
  normalizeWorkflowReport,
  workflowRuntimeRevision,
} from "./workflow-report.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".markdown": "text/markdown; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};
const ADMIN_ONLY_USER_ENV_KEYS = new Set([
  "CURSOR_API_KEYS",
  "AGENTFLOW_CURSOR_API_KEY_COOLDOWN_MINUTES",
  "CURSOR_API_KEY_COOLDOWN_MINUTES",
]);

const UI_SERVER_STARTED_AT = new Date().toISOString();
const UI_SERVER_APP_VERSION = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf-8"));
    return String(pkg?.version || "0.0.0").trim() || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

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
  }).map(withMcpBackendCompatibility).sort((a, b) => a.name.localeCompare(b.name));
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

const MODEL_LIST_KEYS = ["cursor", "opencode", "claudeCode", "codex"];

function emptyModelLists() {
  return {
    cursor: [],
    opencode: [],
    claudeCode: [],
    codex: [],
    cursorFetchedAt: null,
    opencodeFetchedAt: null,
    claudeCodeFetchedAt: null,
    codexFetchedAt: null,
  };
}

function modelListEntryId(entry) {
  const text = String(entry || "").trim();
  const idx = text.indexOf(" - ");
  return idx >= 0 ? text.slice(0, idx).trim() : text;
}

function normalizeHiddenModelConfig(raw) {
  const src = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const out = {};
  for (const key of MODEL_LIST_KEYS) {
    out[key] = Array.isArray(src[key])
      ? [...new Set(src[key].map(modelListEntryId).filter(Boolean))]
      : [];
  }
  return out;
}

function readHiddenModelConfig() {
  const cfg = readAgentflowUserConfigObject();
  const visibility = cfg.modelVisibility && typeof cfg.modelVisibility === "object" && !Array.isArray(cfg.modelVisibility)
    ? cfg.modelVisibility
    : {};
  return normalizeHiddenModelConfig(visibility.hiddenModels);
}

function writeHiddenModelConfig(hiddenModels) {
  const cfgPath = getAgentflowUserConfigAbs();
  const prev = readAgentflowUserConfigObject();
  const next = {
    ...prev,
    modelVisibility: {
      ...(prev.modelVisibility && typeof prev.modelVisibility === "object" && !Array.isArray(prev.modelVisibility) ? prev.modelVisibility : {}),
      hiddenModels: normalizeHiddenModelConfig(hiddenModels),
    },
  };
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(next, null, 2) + "\n", "utf-8");
  return next.modelVisibility.hiddenModels;
}

function applyModelVisibility(modelLists, hiddenModels) {
  const hidden = normalizeHiddenModelConfig(hiddenModels);
  const out = { ...modelLists };
  for (const key of MODEL_LIST_KEYS) {
    const hiddenIds = new Set(hidden[key]);
    out[key] = (Array.isArray(modelLists[key]) ? modelLists[key] : [])
      .filter((entry) => !hiddenIds.has(modelListEntryId(entry)));
  }
  return out;
}

function readRawModelListsFromDisk() {
  const p = getModelListsAbs();
  const empty = emptyModelLists();
  try {
    if (!fs.existsSync(p)) return empty;
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    return {
      cursor: Array.isArray(data.cursor) ? data.cursor.map(String) : [],
      opencode: Array.isArray(data.opencode) ? data.opencode.map(String) : [],
      claudeCode: Array.isArray(data.claudeCode) ? data.claudeCode.map(String) : [],
      codex: Array.isArray(data.codex) ? data.codex.map(String) : [],
      cursorFetchedAt: data.cursorFetchedAt ?? null,
      opencodeFetchedAt: data.opencodeFetchedAt ?? null,
      claudeCodeFetchedAt: data.claudeCodeFetchedAt ?? null,
      codexFetchedAt: data.codexFetchedAt ?? null,
    };
  } catch {
    return empty;
  }
}

function readModelListsFromDisk(_workspaceRoot, opts = {}) {
  const raw = readRawModelListsFromDisk();
  if (opts.raw) return raw;
  return applyModelVisibility(raw, readHiddenModelConfig());
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

function skillhubManagedSkillsDir() {
  const dir = getAgentflowSkillsRoot();
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function skillhubListArgs(target, agent) {
  const normalizedTarget = String(target || "agentflow").trim();
  const normalizedAgent = String(agent || "codex").trim();
  const args = ["list", "--json"];
  if (normalizedTarget === "all") args.push("--all");
  else if (normalizedTarget === "legacy-global") args.push("--global", "--agent", normalizedAgent);
  else args.push("--dir", skillhubManagedSkillsDir());
  return args;
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
  const target = String(payload?.target || "agentflow").trim();
  const agent = String(payload?.agent || "codex").trim();
  if (target === "global" || target === "legacy-global") {
    args.push("--global", "--agent", agent);
  } else if (target === "agentflow") {
    args.push("--dir", skillhubManagedSkillsDir());
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
  const ext = String(parsed.ext || "")
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "")
    .slice(0, 24);
  return `${stem}${ext}`;
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

function prdWorkflowReviewNormalizeText(value) {
  return String(value || "")
    .replace(/&quot;/g, '"')
    .replace(/&#34;/g, '"')
    .replace(/&#x22;/gi, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
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

function readWorkspaceFiles(workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  return { root, files: readWorkspaceFilesRecursive(root, root) };
}

const WORKSPACE_GRAPH_FILENAME = "workspace.graph.json";

function workspaceGraphPath(workspaceRoot) {
  return path.join(path.resolve(workspaceRoot), WORKSPACE_GRAPH_FILENAME);
}

function writeWorkspaceGraphAtomic(graphPath, graph) {
  fs.mkdirSync(path.dirname(graphPath), { recursive: true });
  const tmp = `${graphPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(graph, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, graphPath);
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
const DISPLAY_SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const DISPLAY_SHARE_ALLOWED_EXPIRY_DAYS = new Set([1, 7, 30, 90, 365]);
const NODE_STUDIO_DRAFTS_DIRNAME = "node-studio/drafts";
const USER_WORKSPACES_FILENAME = "workspaces.json";

function workspacesPath() {
  return path.join(getAgentflowDataRoot(), USER_WORKSPACES_FILENAME);
}

function legacyUserWorkspacesPath(userCtx = {}) {
  return path.join(getAgentflowUserDataRoot(userCtx.userId || ""), USER_WORKSPACES_FILENAME);
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

function normalizeWorkspaceEntry(entry = {}, index = 0, userCtx = {}) {
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

function readWorkspacesFromPath(p, userCtx = {}) {
  if (!fs.existsSync(p)) return [];
  try {
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    const list = Array.isArray(data?.workspaces) ? data.workspaces : Array.isArray(data) ? data : [];
    return list.map((entry, index) => normalizeWorkspaceEntry(entry, index, userCtx)).filter(Boolean);
  } catch {
    return [];
  }
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

function readUserWorkspaces(userCtx = {}) {
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

function writeUserWorkspaces(userCtx = {}, entries = []) {
  const seen = new Set();
  const workspaces = (Array.isArray(entries) ? entries : [])
    .map((entry, index) => normalizeWorkspaceEntry(entry, index, userCtx))
    .filter(Boolean)
    .filter((entry) => {
      const key = entry.id || entry.path;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  const p = workspacesPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ version: 1, workspaces }, null, 2) + "\n", "utf-8");
  return workspaces;
}

function redactWorkspaceSecret(text = "", secret = "") {
  let out = String(text || "");
  const raw = String(secret || "");
  if (!raw) return out;
  out = out.split(raw).join("<redacted>");
  try {
    out = out.split(encodeURIComponent(raw)).join("<redacted>");
  } catch {
    // ignore invalid encoding edge cases
  }
  return out;
}

function workspaceRepoUrlWithCredential(repoUrl = "", credential = "") {
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

function gitWorkspaceCommandOrThrow(args, cwd, label, secret = "") {
  const result = runGit(args, cwd);
  if (result.status !== 0) {
    const message = redactWorkspaceSecret(result.stderr || result.stdout || result.error?.message || "unknown error", secret);
    throw new Error(`${label} failed: ${message}`);
  }
  return {
    stdout: redactWorkspaceSecret(result.stdout || "", secret),
    stderr: redactWorkspaceSecret(result.stderr || "", secret),
  };
}

function syncGitWorkspace(entry = {}, userCtx = {}) {
  const workspace = normalizeWorkspaceEntry(entry, 0, userCtx);
  if (!workspace || workspace.kind !== "git") throw new Error("只能拉取 Git 工作区");
  if (!workspace.repoUrl) throw new Error("Git 工作区缺少 repoUrl");
  const env = readMergedEnvObject(userCtx.userId || "");
  const token = workspace.credentialRef ? String(env[workspace.credentialRef] || "").trim() : "";
  const repoUrl = workspaceRepoUrlWithCredential(workspace.repoUrl, token);
  const targetDir = path.resolve(workspace.path);
  const parentDir = path.dirname(targetDir);
  fs.mkdirSync(parentDir, { recursive: true });

  const lines = [];
  let changed = false;
  if (fs.existsSync(path.join(targetDir, ".git"))) {
    const originalRemote = runGit(["remote", "get-url", "origin"], targetDir).stdout.trim();
    try {
      if (token) gitWorkspaceCommandOrThrow(["remote", "set-url", "origin", repoUrl], targetDir, "git remote set-url", token);
      const before = runGit(["rev-parse", "HEAD"], targetDir).stdout.trim();
      gitWorkspaceCommandOrThrow(["fetch", "origin", "--prune"], targetDir, "git fetch", token);
      if (workspace.branch) {
        const checkout = runGit(["checkout", workspace.branch], targetDir);
        if (checkout.status !== 0) {
          gitWorkspaceCommandOrThrow(["checkout", "-b", workspace.branch, `origin/${workspace.branch}`], targetDir, "git checkout", token);
        }
        gitWorkspaceCommandOrThrow(["pull", "--ff-only", "origin", workspace.branch], targetDir, "git pull", token);
      } else {
        gitWorkspaceCommandOrThrow(["pull", "--ff-only"], targetDir, "git pull", token);
      }
      const after = runGit(["rev-parse", "HEAD"], targetDir).stdout.trim();
      changed = before !== after;
      lines.push(changed ? `updated ${before.slice(0, 8)} -> ${after.slice(0, 8)}` : `already up to date ${after.slice(0, 8)}`);
    } finally {
      if (token && originalRemote) runGit(["remote", "set-url", "origin", originalRemote], targetDir);
    }
  } else {
    if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
      throw new Error(`目标路径已存在但不是 Git 仓库：${targetDir}`);
    }
    const args = ["clone"];
    if (workspace.branch) args.push("--branch", workspace.branch);
    args.push(repoUrl, targetDir);
    gitWorkspaceCommandOrThrow(args, parentDir, "git clone", token);
    const commit = runGit(["rev-parse", "HEAD"], targetDir).stdout.trim();
    changed = true;
    lines.push(`cloned ${commit.slice(0, 8)}`);
    if (token) runGit(["remote", "set-url", "origin", workspace.repoUrl], targetDir);
  }
  const branch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], targetDir).stdout.trim();
  const commit = runGit(["rev-parse", "HEAD"], targetDir).stdout.trim();
  return {
    workspace: normalizeWorkspaceEntry({ ...workspace, path: targetDir }, 0, userCtx),
    changed,
    branch,
    commit,
    message: lines.join("\n"),
  };
}

function listConfiguredWorkspaces(root, scopedRoot, userCtx = {}) {
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

function nodeStudioDraftsRoot(userCtx = {}) {
  return path.join(getAgentflowUserDataRoot(userCtx.userId || ""), NODE_STUDIO_DRAFTS_DIRNAME);
}

function normalizeNodeStudioDraftId(value) {
  const raw = String(value || "").trim().toLowerCase();
  const safe = raw.replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 64);
  return safe || `draft_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
}

function nodeStudioDraftPath(userCtx = {}, draftId = "") {
  return path.join(nodeStudioDraftsRoot(userCtx), normalizeNodeStudioDraftId(draftId), "draft.json");
}

function emptyNodeStudioDraft(userCtx = {}, draftId = "") {
  const now = new Date().toISOString();
  const id = normalizeNodeStudioDraftId(draftId || "untitled_node");
  return {
    id,
    title: "Untitled Node",
    definitionId: "",
    createdAt: now,
    updatedAt: now,
    ownerUserId: String(userCtx.userId || ""),
    agentMessages: [],
    promptDraft: "",
    manifest: {
      id,
      version: "1.0.0",
      name: "Untitled Node",
      description: "",
      baseDefinitionId: "agent_subAgent",
      runtime: { type: "agent_subAgent" },
      inputs: [],
      outputs: [],
      configSchema: { fields: [] },
      ui: { card: { icon: "extension", variant: "default", actions: [] } },
    },
    config: {},
    test: { inputs: {}, log: [], status: "not run" },
    files: {},
  };
}

function isLegacyNodeStudioDemoDraft(draft) {
  return (
    String(draft?.id || "") === "daily_report_demo" &&
    String(draft?.definitionId || "") === "marketplace:daily_report@1.0.0"
  );
}

function readNodeStudioDraft(userCtx = {}, draftId = "") {
  const id = normalizeNodeStudioDraftId(draftId || "");
  const filePath = nodeStudioDraftPath(userCtx, id);
  if (!fs.existsSync(filePath)) return null;
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return parsed && typeof parsed === "object" ? parsed : null;
}

function writeNodeStudioDraft(userCtx = {}, draft = {}) {
  const id = normalizeNodeStudioDraftId(draft.id || "untitled_node");
  const filePath = nodeStudioDraftPath(userCtx, id);
  const previous = fs.existsSync(filePath)
    ? JSON.parse(fs.readFileSync(filePath, "utf-8"))
    : {};
  const now = new Date().toISOString();
  const next = {
    ...previous,
    ...draft,
    id,
    createdAt: previous.createdAt || draft.createdAt || now,
    updatedAt: now,
    ownerUserId: String(userCtx.userId || draft.ownerUserId || ""),
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2) + "\n", "utf-8");
  return next;
}

function listNodeStudioDrafts(userCtx = {}) {
  const rootDir = nodeStudioDraftsRoot(userCtx);
  if (!fs.existsSync(rootDir)) return [];
  const rows = [];
  for (const entry of fs.readdirSync(rootDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const filePath = path.join(rootDir, entry.name, "draft.json");
    if (!fs.existsSync(filePath)) continue;
    try {
      const draft = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (isLegacyNodeStudioDemoDraft(draft)) continue;
      rows.push({
        id: String(draft.id || entry.name),
        title: String(draft.title || draft.manifest?.name || entry.name),
        definitionId: String(draft.definitionId || `marketplace:${draft.manifest?.id || entry.name}@${draft.manifest?.version || "1.0.0"}`),
        updatedAt: String(draft.updatedAt || ""),
      });
    } catch {
      /* ignore corrupt drafts */
    }
  }
  rows.sort((a, b) => String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")) || a.id.localeCompare(b.id));
  return rows;
}

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

function countFlowYamlDirs(root) {
  try {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return 0;
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => entry.name !== ARCHIVED_PIPELINES_DIR_NAME)
      .filter((entry) => fs.existsSync(path.join(root, entry.name, FLOW_YAML_FILENAME)))
      .length;
  } catch {
    return 0;
  }
}

function pipelineCountsForUser(userId) {
  const pipelinesRoot = getUserPipelinesRoot(userId);
  const active = countFlowYamlDirs(pipelinesRoot);
  const archived = countFlowYamlDirs(path.join(pipelinesRoot, ARCHIVED_PIPELINES_DIR_NAME));
  return {
    active,
    archived,
    total: active + archived,
  };
}

const USAGE_DAY_MS = 24 * 60 * 60 * 1000;
const RUN_LEDGER_STALE_MS = 6 * 60 * 60 * 1000;

function startOfLocalDayMs(timeMs) {
  const d = new Date(Number(timeMs) || Date.now());
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function localDayKey(timeMs) {
  const d = new Date(Number(timeMs) || Date.now());
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function runStatusBucket(status) {
  const s = String(status || "unknown");
  if (s === "success" || s === "failed" || s === "running" || s === "stopped" || s === "interrupted") return s;
  return "unknown";
}

function buildUsageDailyTrend(runs, days = 14, nowMs = Date.now()) {
  const startMs = startOfLocalDayMs(nowMs) - (Math.max(1, days) - 1) * USAGE_DAY_MS;
  const rows = [];
  const byDate = new Map();
  for (let i = 0; i < days; i += 1) {
    const dateMs = startMs + i * USAGE_DAY_MS;
    const date = localDayKey(dateMs);
    const row = {
      date,
      runs: 0,
      success: 0,
      failed: 0,
      running: 0,
      stopped: 0,
      interrupted: 0,
      unknown: 0,
      users: 0,
      pipelines: 0,
      totalDurationMs: 0,
      avgDurationMs: 0,
      _userIds: new Set(),
      _pipelineKeys: new Set(),
    };
    rows.push(row);
    byDate.set(date, row);
  }
  for (const run of runs) {
    const at = Number(run?.at || 0);
    if (!Number.isFinite(at) || at < startMs) continue;
    const row = byDate.get(localDayKey(at));
    if (!row) continue;
    const bucket = runStatusBucket(run.status);
    row.runs += 1;
    row[bucket] += 1;
    row.totalDurationMs += Math.max(0, Number(run.durationMs || 0));
    row._userIds.add(String(run.userId || ""));
    {
      const flowSource = String(run.flowSource || "user");
      const flowId = String(run.flowId || "");
      const userId = String(run.userId || "");
      row._pipelineKeys.add(flowSource === "workspace" ? `workspace:${flowId}` : `${userId}:${flowSource}:${flowId}`);
    }
  }
  return rows.map((row) => {
    row.users = row._userIds.size;
    row.pipelines = row._pipelineKeys.size;
    row.avgDurationMs = row.runs > 0 ? Math.round(row.totalDurationMs / row.runs) : 0;
    delete row._userIds;
    delete row._pipelineKeys;
    return row;
  });
}

function buildUsageRates(users, runs, nowMs = Date.now(), workspacePipelineCount = 0) {
  const windowDays = 7;
  const sinceMs = startOfLocalDayMs(nowMs) - (windowDays - 1) * USAGE_DAY_MS;
  const recentRuns = runs.filter((run) => Number(run?.at || 0) >= sinceMs);
  const activeUsers = new Set();
  const activePipelines = new Set();
  const statusCounts = {};
  let recentDurationMs = 0;
  for (const run of recentRuns) {
    const userId = String(run.userId || "");
    if (userId) activeUsers.add(userId);
    const flowSource = String(run.flowSource || "user");
    const flowId = String(run.flowId || "");
    activePipelines.add(flowSource === "workspace" ? `workspace:${flowId}` : `${userId}:${flowSource}:${flowId}`);
    const bucket = runStatusBucket(run.status);
    statusCounts[bucket] = (statusCounts[bucket] || 0) + 1;
    recentDurationMs += Math.max(0, Number(run.durationMs || 0));
  }
  const totalUsers = users.length;
  const totalActivePipelines = users.reduce((sum, user) => sum + Math.max(0, Number(user?.pipelines?.active || 0)), 0)
    + Math.max(0, Number(workspacePipelineCount || 0));
  const completedRuns = recentRuns.length - (statusCounts.running || 0);
  const badRuns = (statusCounts.failed || 0) + (statusCounts.stopped || 0) + (statusCounts.interrupted || 0) + (statusCounts.unknown || 0);
  return {
    windowDays,
    activeUsers: activeUsers.size,
    activeUserRate: totalUsers > 0 ? activeUsers.size / totalUsers : 0,
    activePipelines: activePipelines.size,
    activePipelineRate: totalActivePipelines > 0 ? activePipelines.size / totalActivePipelines : 0,
    runs: recentRuns.length,
    avgRunsPerDay: recentRuns.length / windowDays,
    successRuns: statusCounts.success || 0,
    badRuns,
    runningRuns: statusCounts.running || 0,
    successRate: completedRuns > 0 ? (statusCounts.success || 0) / completedRuns : 0,
    failureRate: completedRuns > 0 ? badRuns / completedRuns : 0,
    avgDurationMs: recentRuns.length > 0 ? Math.round(recentDurationMs / recentRuns.length) : 0,
  };
}

function appendWorkspaceRunStarted(record) {
  appendRunLedgerEvent({
    ...record,
    type: "run_started",
    kind: "workspace",
    at: Number(record.startedAt || record.at || Date.now()),
  });
}

function appendWorkspaceRunFinished(record, status) {
  appendRunLedgerEvent({
    ...record,
    type: "run_finished",
    kind: "workspace",
    at: Number(record.startedAt || record.at || Date.now()),
    endedAt: Number(record.endedAt || Date.now()),
    durationMs: Math.max(0, Number(record.durationMs || (Number(record.endedAt || Date.now()) - Number(record.startedAt || record.at || Date.now())))),
    status,
  });
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

function readWorkspaceRunUsageRecords(options = {}) {
  const sinceMs = Number(options?.sinceMs || 0);
  return [
    ...readLegacyWorkspaceRunUsageRecords(),
    ...readWorkspaceRunLedgerRecords(options),
  ].filter((run) => !Number.isFinite(sinceMs) || sinceMs <= 0 || Number(run?.at || 0) >= sinceMs);
}

function activeWorkspaceRunUsageRecords() {
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

function dedupeWorkspaceUsageRuns(runs = []) {
  const byKey = new Map();
  for (const run of runs) {
    const runId = String(run?.runId || "").trim();
    const key = runId || `${run?.userId || ""}:${run?.flowSource || ""}:${run?.flowId || ""}:${run?.at || ""}:${run?.status || ""}`;
    if (!key) continue;
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, run);
      continue;
    }
    const runScore = (item) => {
      if (item?.source === "workspace-run-active") return 3;
      if (item?.status && item.status !== "running") return 2;
      return 1;
    };
    if (runScore(run) >= runScore(existing)) byKey.set(key, run);
  }
  return Array.from(byKey.values());
}

function buildAdminUsageDashboard(workspaceRoot) {
  const authUsers = readAuthUsers();
  const usageSinceMs = startOfLocalDayMs(Date.now()) - 13 * USAGE_DAY_MS;
  const workspacePipelineCount = listFlowsJson(workspaceRoot, { includeWorkspaceFlows: true })
    .filter((flow) => flow?.source === "workspace" && !flow?.archived)
    .length;
  const workspaceUsageRuns = dedupeWorkspaceUsageRuns([
    ...readWorkspaceRunUsageRecords({ sinceMs: usageSinceMs }),
    ...activeWorkspaceRunUsageRecords(),
  ]);
  const userIds = Array.from(new Set([
    ...Object.keys(authUsers || {}),
    ...listAgentflowUserIds(),
    ...workspaceUsageRuns.map((run) => run.userId),
  ].map((id) => String(id || "").trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b));
  const allRuns = [];
  const workspaceUsageByUser = new Map();
  for (const run of workspaceUsageRuns) {
    const userId = String(run.userId || "");
    if (!workspaceUsageByUser.has(userId)) workspaceUsageByUser.set(userId, []);
    workspaceUsageByUser.get(userId).push(run);
  }
  const users = userIds.map((userId) => {
    const user = authUsers[userId] || {};
    const pipelineCounts = pipelineCountsForUser(userId);
    const pipelineRuns = listRecentRunsFromDisk(workspaceRoot, {
      userId,
      includeWorkspaceRuns: false,
      includeLegacyUserRuns: false,
    });
    const runs = [...pipelineRuns, ...(workspaceUsageByUser.get(userId) || [])]
      .sort((a, b) => Number(b.at || 0) - Number(a.at || 0));
    const statusCounts = {};
    let totalDurationMs = 0;
    for (const run of runs) {
      allRuns.push({ ...run, userId, username: user.username || userId });
      const status = String(run.status || "unknown");
      statusCounts[status] = (statusCounts[status] || 0) + 1;
      totalDurationMs += Math.max(0, Number(run.durationMs || 0));
    }
    const lastRun = runs[0] || null;
    return {
      userId,
      username: user.username || userId,
      isAdmin: Boolean(user.isAdmin),
      pipelines: pipelineCounts,
      runs: {
        total: runs.length,
        running: statusCounts.running || 0,
        success: statusCounts.success || 0,
        failed: statusCounts.failed || 0,
        stopped: statusCounts.stopped || 0,
        interrupted: statusCounts.interrupted || 0,
        unknown: statusCounts.unknown || 0,
        totalDurationMs,
        avgDurationMs: runs.length > 0 ? Math.round(totalDurationMs / runs.length) : 0,
        lastRunAt: lastRun?.at || null,
        lastRunFlowId: lastRun?.flowId || "",
        lastRunStatus: lastRun?.status || "",
        recent: runs.slice(0, 5).map((run) => ({
          flowId: run.flowId,
          flowSource: run.flowSource,
          runId: run.runId,
          at: run.at,
          endedAt: run.endedAt,
          durationMs: run.durationMs,
          status: run.status,
        })),
      },
    };
  });
  const totals = users.reduce((acc, user) => {
    acc.users += 1;
    acc.admins += user.isAdmin ? 1 : 0;
    acc.pipelines += user.pipelines.total;
    acc.activePipelines += user.pipelines.active;
    acc.archivedPipelines += user.pipelines.archived;
    acc.runs += user.runs.total;
    acc.runningRuns += user.runs.running;
    acc.successRuns += user.runs.success;
    acc.failedRuns += user.runs.failed;
    acc.stoppedRuns += user.runs.stopped;
    acc.interruptedRuns += user.runs.interrupted;
    acc.unknownRuns += user.runs.unknown;
    acc.totalDurationMs += user.runs.totalDurationMs;
    return acc;
  }, {
    users: 0,
    admins: 0,
    pipelines: 0,
    activePipelines: 0,
    archivedPipelines: 0,
    runs: 0,
    runningRuns: 0,
    successRuns: 0,
    failedRuns: 0,
    stoppedRuns: 0,
    interruptedRuns: 0,
    unknownRuns: 0,
    totalDurationMs: 0,
  });
  totals.avgDurationMs = totals.runs > 0 ? Math.round(totals.totalDurationMs / totals.runs) : 0;
  const recentRuns = allRuns
    .slice()
    .sort((a, b) => Number(b.at || 0) - Number(a.at || 0))
    .slice(0, 50)
    .map((run) => ({
      userId: String(run.userId || ""),
      username: String(run.username || run.userId || ""),
      flowId: String(run.flowId || ""),
      flowSource: String(run.flowSource || "user"),
      runId: String(run.runId || ""),
      at: Number(run.at || 0),
      endedAt: run.endedAt == null ? null : Number(run.endedAt),
      durationMs: Math.max(0, Number(run.durationMs || 0)),
      status: runStatusBucket(run.status),
      runType: String(run.source || "").startsWith("workspace-run") ? "workspace" : "pipeline",
    }));
  return {
    generatedAt: new Date().toISOString(),
    totals,
    usage: buildUsageRates(users, allRuns, Date.now(), workspacePipelineCount),
    dailyTrend: buildUsageDailyTrend(allRuns, 14),
    recentRuns,
    users,
  };
}

function createDisplayShareId() {
  return crypto.randomBytes(12).toString("base64url");
}

function normalizeDisplayShareExpiry(input = {}, now = new Date()) {
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

function displayShareExpiresAt(now = new Date()) {
  return normalizeDisplayShareExpiry({ expiresInDays: 30 }, now).expiresAt;
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
    if (!workspaceDisplayKindFromInstance(instance)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function workspaceDisplayContentFromInstance(instance, kind = "") {
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

function createDisplayShareRecord({ userId, flowId, flowSource, archived, title, layout, nodeIds, expiresMode, expiresInDays, permanent, expiresAt }) {
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

function displayShareSummary(share, baseUrl = "") {
  return {
    id: String(share?.id || ""),
    userId: String(share?.userId || ""),
    flowId: String(share?.flowId || ""),
    flowSource: String(share?.flowSource || "user"),
    archived: share?.archived === true,
    title: String(share?.title || "AgentFlow Display"),
    layout: String(share?.layout || "gallery"),
    nodeIds: Array.isArray(share?.nodeIds) ? share.nodeIds : [],
    createdAt: String(share?.createdAt || ""),
    updatedAt: String(share?.updatedAt || ""),
    expiresAt: String(share?.expiresAt || ""),
    expiresMode: String(share?.expiresMode || (share?.expiresAt ? "days" : "permanent")),
    expiresInDays: share?.expiresInDays == null ? null : Number(share.expiresInDays),
    url: displayShareOutputUrl(share?.id || "", baseUrl),
  };
}

function listDisplaySharesForUser(userCtx = {}, baseUrl = "") {
  const userId = String(userCtx?.userId || "");
  const isAdmin = userCtx?.isAdmin === true;
  const shares = readDisplayShares();
  let changed = false;
  const rows = [];
  for (const [id, share] of Object.entries(shares)) {
    if (isDisplayShareExpired(share)) {
      delete shares[id];
      changed = true;
      continue;
    }
    if (!isAdmin && String(share?.userId || "") !== userId) continue;
    rows.push(displayShareSummary(share, baseUrl));
  }
  if (changed) writeDisplayShares(shares);
  rows.sort((a, b) => Date.parse(b.createdAt || "") - Date.parse(a.createdAt || ""));
  return rows;
}

function updateDisplayShareExpiryForUser(id, userCtx = {}, patch = {}) {
  const shares = readDisplayShares();
  const share = shares[id];
  if (!share) return { status: 404, error: "Display share not found" };
  const userId = String(userCtx?.userId || "");
  if (userCtx?.isAdmin !== true && String(share.userId || "") !== userId) return { status: 403, error: "Forbidden" };
  const expiry = normalizeDisplayShareExpiry(patch, new Date());
  const updated = {
    ...share,
    expiresAt: expiry.expiresAt,
    expiresMode: expiry.expiresMode,
    expiresInDays: expiry.expiresInDays,
    updatedAt: new Date().toISOString(),
  };
  shares[id] = updated;
  writeDisplayShares(shares);
  return { status: 200, share: updated };
}

function deleteDisplayShareForUser(id, userCtx = {}) {
  const shares = readDisplayShares();
  const share = shares[id];
  if (!share) return { status: 404, error: "Display share not found" };
  const userId = String(userCtx?.userId || "");
  if (userCtx?.isAdmin !== true && String(share.userId || "") !== userId) return { status: 403, error: "Forbidden" };
  delete shares[id];
  writeDisplayShares(shares);
  return { status: 200 };
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

function displayShareOutputUrl(shareId, baseUrl = "") {
  const pathPart = `/display/${encodeURIComponent(String(shareId || ""))}`;
  const base = String(baseUrl || "").trim();
  if (!base) return pathPart;
  try {
    return new URL(pathPart, base.endsWith("/") ? base : `${base}/`).href;
  } catch {
    return pathPart;
  }
}

function normalizePublicBaseUrl(baseUrl = "") {
  const raw = String(baseUrl || "").trim();
  if (!raw) return "";
  try {
    const url = new URL(raw);
    if (url.hostname === "0.0.0.0" || url.hostname === "::" || url.hostname === "[::]") {
      url.hostname = "127.0.0.1";
    }
    return url.origin;
  } catch {
    return "";
  }
}

function requestPublicBaseUrl(req) {
  const origin = String(req?.headers?.origin || "").trim();
  if (/^https?:\/\//i.test(origin)) return normalizePublicBaseUrl(origin);
  const forwardedHost = String(req?.headers?.["x-forwarded-host"] || "").split(",")[0].trim();
  const host = forwardedHost || String(req?.headers?.host || "").trim();
  if (!host) return "";
  const forwardedProto = String(req?.headers?.["x-forwarded-proto"] || "").split(",")[0].trim();
  const proto = /^https?$/i.test(forwardedProto) ? forwardedProto.toLowerCase() : "http";
  return normalizePublicBaseUrl(`${proto}://${host}`);
}

function configuredPublicBaseUrl(payload = null) {
  const envBase = normalizePublicBaseUrl(process.env.AGENTFLOW_PUBLIC_BASE_URL || process.env.AGENTFLOW_SHARE_BASE_URL || "");
  if (envBase) return envBase;
  const payloadBase = payload && typeof payload === "object" && !Array.isArray(payload)
    ? normalizePublicBaseUrl(payload.publicBaseUrl || payload.public_base_url || payload.reviewBaseUrl || payload.review_base_url || "")
    : "";
  return payloadBase;
}

function serverPublicBaseUrl(req, host, port, payload = null) {
  return configuredPublicBaseUrl(payload) || requestPublicBaseUrl(req) || normalizePublicBaseUrl(`http://${host}:${port}`);
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
    const kind = workspaceDisplayKindFromInstance(instance);
    const rawBody = workspaceDisplayContentFromInstance(instance, kind);
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
      expiresMode: share.expiresMode || (share.expiresAt ? "days" : "permanent"),
      expiresInDays: share.expiresInDays == null ? null : Number(share.expiresInDays),
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

function mergeWorkspacePersistentNodeRefs(incomingGraph, currentGraph) {
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

function workspaceMarketplaceRuntimeCommand(resolved) {
  const runtime = resolved?.runtime && typeof resolved.runtime === "object" ? resolved.runtime : {};
  const entry = String(runtime.entry || "").trim().replace(/^\/+/, "");
  if (entry && resolved?.packageDir) {
    const entryAbs = path.resolve(resolved.packageDir, ...entry.split(/[\\/]+/).filter(Boolean));
    const packageRoot = path.resolve(resolved.packageDir);
    const packageRootWithSep = packageRoot.endsWith(path.sep) ? packageRoot : `${packageRoot}${path.sep}`;
    if (entryAbs === packageRoot || !entryAbs.startsWith(packageRootWithSep)) return "";
    const args = Array.isArray(runtime.args) ? runtime.args.map(workspaceRuntimeArgForMarketplace).filter(Boolean) : [];
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

function hydrateWorkspaceGraphForRuntime(workspaceRoot, scoped = {}, graph = {}, userCtx = {}) {
  const withRefs = hydrateWorkspaceNodeRefsFromFiles(scoped.root || scoped.scopedRoot || workspaceRoot, graph);
  const withMarketplaceRuntime = hydrateWorkspaceMarketplaceToolNodejsRuntime(workspaceRoot, scoped, withRefs, userCtx);
  return hydrateWorkspaceSlotMetaFromDefinitions(workspaceRoot, scoped, withMarketplaceRuntime, userCtx);
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
    collaboration,
    collaborationAccess: workspaceCollaborationAccess(collaboration, opts.userId),
  };
}

function workspaceFlowCollaborationGuard(flowId, flowSource, archived, userCtx = {}, capability = "read") {
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

function findWorkspaceShareUser(username) {
  const query = String(username || "").trim().toLowerCase();
  if (!query) return null;
  const users = readAuthUsers();
  for (const [userId, user] of Object.entries(users)) {
    const storedUsername = String(user?.username || userId).trim();
    if (String(userId).toLowerCase() === query || storedUsername.toLowerCase() === query) {
      return { userId: String(userId), username: storedUsername };
    }
  }
  return null;
}

function workspaceCollaborationSummaryWithUsers(record, userId) {
  const summary = workspaceCollaborationSummary(record, userId);
  if (!summary) return null;
  const users = readAuthUsers();
  return {
    ...summary,
    ownerUsername: String(users[summary.ownerId]?.username || summary.ownerId),
    members: (summary.members || []).map((member) => ({
      ...member,
      username: String(users[member.userId]?.username || member.userId),
    })),
  };
}

function prdWorkflowCollaborationSummaryWithUsers(record, userId) {
  const summary = prdWorkflowCollaborationSummary(record, userId);
  if (!summary) return null;
  const users = readAuthUsers();
  return {
    ...summary,
    ownerUsername: String(users[summary.ownerId]?.username || summary.ownerId),
    members: (summary.members || []).map((member) => ({
      ...member,
      username: String(users[member.userId]?.username || member.userId),
    })),
  };
}

function prdWorkflowShareLinkSummary(record, shareToken, publicBaseUrl, userId = "") {
  const token = String(shareToken || record?.shareToken || "").trim();
  if (!record || !token) return null;
  const query = new URLSearchParams({
    view: "workflow",
    tapdId: String(record.tapdId || ""),
    workflowShare: token,
  });
  const base = String(publicBaseUrl || "").replace(/\/+$/, "");
  return {
    tapdId: String(record.tapdId || ""),
    url: `${base}/workspace?${query.toString()}`,
    active: true,
    readOnly: true,
    createdAt: record.shareCreatedAt || "",
    canManage: String(record.ownerId || "") === String(userId || "").trim().toLowerCase(),
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

function readWorkspaceConversations(scopedRoot) {
  const filePath = workspaceConversationsPath(scopedRoot);
  if (!fs.existsSync(filePath)) return normalizeWorkspaceConversations({});
  try {
    return normalizeWorkspaceConversations(JSON.parse(fs.readFileSync(filePath, "utf-8")));
  } catch {
    return normalizeWorkspaceConversations({});
  }
}

function writeWorkspaceConversations(scopedRoot, raw) {
  const filePath = workspaceConversationsPath(scopedRoot);
  const conversations = normalizeWorkspaceConversations(raw);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(conversations, null, 2) + "\n", "utf-8");
  return conversations;
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
  const history = Array.isArray(payload?.messages) ? payload.messages : [];
  const historyBlock = history
    .slice(-16)
    .map((msg) => {
      const text = String(msg?.text || "").trim();
      if (!text) return "";
      const kind = String(msg?.kind || "").trim();
      if (kind === "raw" || kind === "prompt" || kind === "thinking") return "";
      const role = msg?.role === "user" ? "user" : (msg?.error ? "error" : "assistant");
      if (kind === "run-summary" || kind === "activity") return `context: ${text}`;
      return `${role}: ${text}`;
    })
    .filter(Boolean)
    .join("\n\n");
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
        : outputKind === "react"
          ? [
              "你是 workspace React 工程节点的内容生成器。",
              "请根据用户 prompt 和上游节点/文件上下文生成一个可预览的小型 React 工程 JSON。",
              "只输出 JSON，不要解释，不要包裹 Markdown 代码围栏。",
              "JSON 必须包含 title、entry、files；files 至少包含 src/App.jsx，可包含 src/styles.css。",
              "src/App.jsx 里定义或 export default 一个 App 组件；不要依赖未声明的外部包。",
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
    historyBlock ? `\n## 对话历史\n\n${historyBlock}` : "",
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
      : nodeKind === "react"
        ? "只输出 React 工程 JSON，不要解释，不要包裹 Markdown 代码围栏。JSON 必须包含 title、entry、files；files 至少包含 src/App.jsx。"
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

function workspaceLinkedOutputShouldStayPath(slot) {
  const rawName = String(slot?.name || "").trim();
  const name = rawName.toLowerCase();
  const type = String(slot?.type || "").trim().toLowerCase();
  if (["file", "image", "audio", "video", "binary", "directory", "dir"].includes(type)) return true;
  if (["file", "filepath", "file_path", "path", "url", "uri", "ref"].includes(name)) return true;
  return /(?:^|[_-])(file|path|url|uri|ref)$/i.test(rawName) || /(?:File|Path|Url|URL|Uri|URI|Ref)$/.test(rawName);
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
  const slotName = String(slot?.name || "").trim();
  const isPrimaryOutput = !slot || slotName === "result" || slotName === "content" || sourceIndex === 0;
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
  if (id === "display_mermaid") return "mermaid";
  if (id === "display_ascii") return "ascii";
  if (id === "display_html") return "html";
  if (id === "display_react_app") return "react";
  if (id === "display_image") return "image";
  if (id === "display_chart") return "chart";
  if (id === "display_table") return "table";
  return "";
}

function workspaceDisplayKindFromInstance(instance) {
  const direct = workspaceDisplayKind(instance?.definitionId);
  if (direct) return direct;
  if (!isWorkspaceOneClickTaskDefinitionId(instance?.definitionId)) return "";
  if (!workspaceDisplayContentFromInstance(instance, workspaceContextRunDisplayKind(instance)).trim()) return "";
  return workspaceContextRunDisplayKind(instance);
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
    react: new Set(["json", "jsx", "tsx", "js", "txt"]),
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

function workspaceOutputFieldForSlot(slot, index = 0) {
  const name = String(slot?.name || "").trim();
  if (!name || name === "result" || name === "content" || index === 0) return "result";
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
    if (!name || isWorkspaceSemanticOutputSlot(slot) || name === "result" || name === "content" || index === 0) continue;
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

function workspaceControlIfBranchToSourceHandle(branch) {
  const text = String(branch || "").trim().toLowerCase();
  if (text === "true" || text === "next1") return "output-0";
  if (text === "false" || text === "next2") return "output-1";
  return null;
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
  if (defId === "provide_str" || defId === "provide_bool" || defId === "provide_file" || defId === "provide_password") {
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
  return type === "node" || name === "prev" || name === "next" || name === "skillsContext" || name === "mcpContext" || name === "knowledgeContext" || name === "workspaceContext" || name === "gitContext";
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

function workspaceInputValues(graph, nodeId, outputs, scopedRoot = "") {
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
    const value = workspaceOutputSlotValueForEdge(graph, outputs, edge, scopedRoot);
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

async function workspaceOptimizeRunImplementations(root, scopedRoot, payload, userCtx = {}, opts = {}) {
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
  if (!source || typeof source !== "object" || Array.isArray(source)) return null;
  const rawPath = String(source.path || source.repoPath || source.cwd || source.workspaceRoot || "").trim();
  if (!workspaceLooksLikeKnowledgePath(rawPath)) return null;
  const resolvedPath = workspaceResolvePath(baseCwd || scopedRoot, rawPath) || rawPath;
  return {
    id: String(source.id || source.mountPath || source.label || path.basename(resolvedPath) || "").trim(),
    label: String(source.label || source.id || source.mountPath || path.basename(resolvedPath) || "知识库").trim(),
    kind: String(source.kind || (source.repoUrl ? "git" : "local")).trim() || "local",
    type: String(source.type || "").trim(),
    path: resolvedPath,
    repoPath: resolvedPath,
    mountPath: String(source.mountPath || "").trim(),
    repoUrl: String(source.repoUrl || "").trim(),
    branch: String(source.branch || "").trim(),
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
  const valid = Array.isArray(sources) ? sources.filter((source) => source?.path || source?.repoPath) : [];
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
      path.resolve(String(source.path || source.repoPath || "")),
      String(source.mountPath || ""),
      String(source.repoUrl || ""),
      String(source.branch || ""),
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

function workspaceNodeWorkspaceContextBlock(graph, nodeId, outputs, scopedRoot = "", logicalCwd = "") {
  const root = scopedRoot ? path.resolve(scopedRoot) : "";
  const cwd = logicalCwd ? path.resolve(logicalCwd) : root;
  const knowledgeText = workspaceSemanticInputText(graph, nodeId, outputs, "knowledgeContext", scopedRoot);
  let knowledgeSources = workspaceKnowledgeSourcesFromText(knowledgeText, cwd || root, scopedRoot);
  knowledgeSources = workspaceDedupeKnowledgeSources([
    ...workspaceGlobalKnowledgeSources(graph, scopedRoot, logicalCwd, nodeId),
    ...knowledgeSources,
  ]);
  const workspaceText = workspaceSemanticInputText(graph, nodeId, outputs, "workspaceContext", scopedRoot);
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
  if (["markdown", "html", "react", "table", "chart", "ascii", "mermaid"].includes(raw)) return raw;
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

function workspaceWriteDisplayContent(instance, content) {
  const next = { ...(instance || {}) };
  const kind = workspaceDisplayKind(next.definitionId);
  const unwrapped = workspaceUnwrapOutputEnvelopeForDisplay(content);
  const text = kind === "html" ? normalizeHtmlDisplayContent(unwrapped) : String(unwrapped || "");
  const primaryName = kind === "image" ? "src" : "content";
  next.displayReloadKey = `${Date.now()}-${crypto.randomBytes(4).toString("hex")}`;
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

function workspaceUpdateDirectDisplays(graph, sourceId, content, outputs = null, scopedRoot = "") {
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const updated = [];
  for (const edge of edges) {
    if (String(edge?.source || "") !== String(sourceId)) continue;
    if (isWorkspaceSemanticInputSlot(workspaceTargetSlotForEdge(graph, edge))) continue;
    const targetId = String(edge?.target || "");
    const target = instances[targetId];
    if (!target || !workspaceDisplayKind(target.definitionId)) continue;
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

function workspaceDefaultWorktreePath(runTmpRoot, nodeId, repoPath, branch = "") {
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
    path.resolve(runTmpRoot),
    "worktrees",
    workspaceSanitizeTmpSegment(nodeId, "node"),
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

function workspaceCleanupAutoWorktrees(list, graph, emit) {
  for (const entry of [...list].reverse()) {
    try {
      const result = unloadGitWorktree({
        repoPath: entry.repoPath,
        worktreePath: entry.worktreePath,
        force: true,
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

function workspaceCreateNodeRunPackage(runTmpRoot, nodeId, { scopedRoot, cwd = "", task = "", inputValues = {}, skillsBlock = "", mcpBlock = "", resultFile = "", outParamFiles = {}, durableOutputs = false } = {}) {
  const nodeRunDir = workspaceCreateNodeTmpDir(runTmpRoot, nodeId);
  const nodeTmpDir = path.join(nodeRunDir, "tmp");
  const legacyOutputsDir = path.join(nodeRunDir, "outputs");
  const workspaceRoot = path.resolve(scopedRoot);
  const workspaceOutputsDir = path.join(workspaceRoot, "outputs");
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
    const type = String(slot?.type || "");
    if (!name || type === "node" || name === "next" || name === "prev") continue;
    const key = name === "content" || index === 0 ? "result" : name;
    const safe = workspaceSanitizeTmpSegment(key, "result");
    refs[key] = `outputs/${safe}.txt`;
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

function workspaceEnvelopeFromOutputFiles(outputRefs, nodeRunDir) {
  const entries = Object.entries(outputRefs || {})
    .map(([name, rel]) => {
      const abs = path.resolve(nodeRunDir, rel);
      const nodeRootWithSep = nodeRunDir.endsWith(path.sep) ? nodeRunDir : `${nodeRunDir}${path.sep}`;
      if (abs !== nodeRunDir && !abs.startsWith(nodeRootWithSep)) return null;
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) return null;
      return { name, rel };
    })
    .filter(Boolean);
  if (entries.length === 0) return "";
  const result = entries.find((entry) => entry.name === "result") || entries[0];
  const outParams = entries.filter((entry) => entry !== result);
  return [
    "---agentflow",
    `resultFile: ${result.rel}`,
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
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (error) => finish(() => reject(error)));
    child.on("close", (code) => {
      if (signal?.aborted) {
        finish(() => {
          const error = new Error("Workspace run stopped");
          error.code = "WORKSPACE_RUN_ABORTED";
          reject(error);
        });
        return;
      }
      if (stderr.trim()) {
        emit?.({ type: "natural", kind: "warning", text: `[script stderr]\n${stderr.trim().slice(-4000)}` });
      }
      if (code !== 0) {
        finish(() => reject(new Error(`tool_nodejs script exited ${code}${stderr.trim() ? `: ${stderr.trim().slice(-800)}` : ""}`)));
        return;
      }
      const elapsedMs = Math.max(0, Date.now() - started);
      emit?.({ type: "status", line: `Timing script: ${elapsedMs}ms`, timing: { label: "script", elapsedMs } });
      const content = stdout.trim() || workspaceEnvelopeFromOutputFiles(outputRefs, runPackage.nodeRunDir);
      finish(() => resolve(content));
    });
  });
}

function workspaceNodeModelKey(instance, fallback = "") {
  const own = String(instance?.model || "").trim();
  if (own && own !== "default") return own;
  return String(fallback || "").trim();
}

async function runWorkspaceGraph(root, scopedRoot, payload, userCtx = {}, opts = {}) {
  const graph = hydrateWorkspaceGraphForRuntime(root, {
    root: scopedRoot,
    flowId: payload.flowId || "",
    flowSource: payload.flowSource || "user",
    archived: payload.archived === true || payload.flowArchived === true,
  }, payload.graph || {}, userCtx);
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
  const runEnv = {};
  const runtimeEnv = (extra = {}) => runtimeEnvForUser(userCtx, { ...runEnv, ...(extra || {}) });
  const autoCleanupWorktrees = [];
  const runTmpRoot = workspaceCreateRunTmpRoot(scopedRoot, runNodeId);
  const controlBranches = new Map();
  const skippedNodes = new Set();
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
  const propagateNodeOutputDisplays = (nodeId, content, { emitGraph = false } = {}) => {
    const updatedDisplays = workspaceUpdateDirectDisplays(graph, nodeId, content, outputs, scopedRoot);
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

    if (defId === "provide_str" || defId === "provide_password") {
      const content = workspaceInstanceText(instance);
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
      const worktreePath = rawWorktreePath
        ? workspaceResolvePath(cwd, rawWorktreePath)
        : (gitContext?.worktreePath ? path.resolve(gitContext.worktreePath) : workspaceDefaultWorktreePath(runTmpRoot, nodeId, repoPath, branch));
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

      const graphPath = workspaceGraphPath(scopedRoot);
      try {
        const currentGraph = readWorkspaceGraph(scopedRoot).graph;
        const mergedGraph = mergeWorkspaceRunGraph(currentGraph, graph, new Set([nodeId, ...nodeIds]));
        fs.writeFileSync(graphPath, JSON.stringify(mergedGraph, null, 2) + "\n", "utf-8");
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
        scopedRoot,
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
      const normalizedAgentOutput = workspacePublishAgentOutputFiles(workspaceStructuredAgentOutput(content), runPackage);
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
    const upstreamSkillBlocks = workspaceUpstreamSkillBlocks(graph, nodeId, outputs);
    const ownSkillBlock = isContextRunNode ? loadSkillsBlockForKeys(selectedSkillKeysFromConfigSlots(instance)) : "";
    const promptSkillsBlock = mergeWorkspaceSkillBlocks(ownSkillBlock, upstreamSkillBlocks);
    const promptMcpBlock = workspaceUpstreamMcpBlocks(graph, nodeId, outputs);
    const resultOutputSpec = workspaceResultOutputSpec(graph, nodeId);
    const runPackage = workspaceCreateNodeRunPackage(runTmpRoot, nodeId, {
      scopedRoot,
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
    let workspaceContextBlock = workspaceNodeWorkspaceContextBlock(graph, nodeId, outputs, scopedRoot, cwd);
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
  const actorScope = flowSource === "workspace" ? "" : String(userId || "");
  return `${actorScope}\t${String(flowId)}\t${String(flowSource)}\t${flowArchived ? "1" : "0"}`;
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
/** 正在执行的 Workspace 临时 run（runId/sessionId → { controller, child, runNodeId, startedAt, plannedNodeIds }） */
const activeWorkspaceRuns = new Map();
const workspaceCollaborationSubscribers = new Map();
const workspaceCollaborationSequences = new Map();
const prdWorkflowSubscribers = new Map();
const prdWorkflowIdempotency = new Map();
const prdWorkflowActionLocks = new Map();
const PRD_WORKFLOW_IDEMPOTENCY_MAX = 1000;
const PRD_WORKFLOW_RUNTIME_EVENTS_MAX = 1000;
const WORKSPACE_SCHEDULES_FILENAME = "workspace-schedules.json";
const WORKSPACE_SCHEDULE_POLL_MS = 30_000;
const WORKSPACE_IMPLEMENTATION_REFERENCE_ENABLED = true;
const WORKSPACE_IMPLEMENTATION_SUMMARY_ENABLED = false;
const WORKSPACE_NODE_HISTORY_MAX_CHARS = 80000;

function resolvePrdWorkflowScope(workspaceRoot, params = {}, userCtx = {}, capability = "read") {
  const tapdId = String(params.tapdId || params.tapd_id || "").trim();
  const flowId = String(params.flowId || "").trim();
  const flowSource = String(params.flowSource || "user").trim() || "user";
  const archived = params.archived === true || params.archived === "1" || params.flowArchived === true;
  const shareToken = String(params.workflowShare || params.workflow_share || "").trim();
  const linkCollaboration = shareToken ? getPrdWorkflowCollaborationByShareToken(shareToken) : null;
  if (shareToken && (!linkCollaboration || linkCollaboration.tapdId !== tapdId)) {
    return { error: "Workflow share link is invalid or has been revoked", status: 404 };
  }
  const memberCollaboration = tapdId
    ? getPrdWorkflowCollaborationForUser(tapdId, userCtx?.userId)
    : null;
  const collaboration = linkCollaboration || memberCollaboration;
  const access = linkCollaboration
    ? { allowed: true, writable: false, role: "viewer", via: "share-link" }
    : prdWorkflowCollaborationAccess(collaboration, userCtx?.userId);
  if (collaboration && !access.allowed) {
    return { error: "PRD Workflow collaboration permission denied", status: 403 };
  }
  if (capability === "write" && (linkCollaboration || (collaboration && !access.writable))) {
    return { error: "PRD Workflow collaboration edit permission denied", status: 403 };
  }
  const ownerId = String(collaboration?.ownerId || userCtx?.userId || "").trim();
  const stateRoot = path.resolve(getAgentflowUserDataRoot(ownerId));
  let executionRoot = path.resolve(workspaceRoot);
  if (flowId) {
    const projectScope = resolveWorkspaceScopeRoot(workspaceRoot, {
      flowId,
      flowSource,
      workspaceId: params.workspaceId || "",
      archived,
    }, userCtx);
    if (projectScope.error) {
      if (!collaboration || capability !== "read") return projectScope;
      executionRoot = stateRoot;
    } else {
      executionRoot = projectScope.root;
    }
  }
  return {
    tapdId,
    executionRoot,
    stateRoot,
    ownerId,
    collaboration,
    collaborationAccess: access,
    shareToken,
    sharedByLink: Boolean(linkCollaboration),
    flowId,
    flowSource,
    archived,
  };
}

function prdWorkflowKey(userCtx = {}, flowSource = "user", flowId = "", tapdId = "", shareToken = "") {
  const id = String(tapdId || "").trim();
  const collaboration = getPrdWorkflowCollaborationByShareToken(shareToken)
    || getPrdWorkflowCollaborationForUser(id, userCtx?.userId);
  const actorScope = `user:${String(collaboration?.ownerId || userCtx?.userId || "")}`;
  return [actorScope, id].join("\t");
}

function prdWorkflowBroadcast(key, event = {}) {
  const set = prdWorkflowSubscribers.get(String(key || ""));
  if (!set || set.size === 0) return;
  const chunk = `data: ${JSON.stringify({ ...event, ts: Date.now() })}\n\n`;
  for (const clientRes of set) {
    try {
      clientRes.write(chunk);
    } catch (_) {}
  }
}

function prdWorkflowCollaborationState(userCtx = {}, flowSource = "user", flowId = "", tapdId = "") {
  const key = prdWorkflowKey(userCtx, flowSource, flowId, tapdId);
  const active = prdWorkflowActionLocks.get(key) || null;
  const subscribers = prdWorkflowSubscribers.get(key);
  const workflowCollaboration = getPrdWorkflowCollaborationForUser(tapdId, userCtx?.userId);
  return {
    subscribers: subscribers ? subscribers.size : 0,
    workflow: prdWorkflowCollaborationSummaryWithUsers(workflowCollaboration, userCtx?.userId),
    activeAction: active ? {
      action: String(active.action || ""),
      tapdId: String(active.tapdId || tapdId || ""),
      title: String(active.title || active.action || ""),
      stage: String(active.stage || ""),
      issueKey: String(active.issueKey || ""),
      startedAt: active.startedAt || 0,
      startedAtIso: active.startedAt ? new Date(active.startedAt).toISOString() : "",
      id: String(active.id || ""),
      userId: String(active.userId || userCtx?.userId || ""),
    } : null,
  };
}

function prdWorkflowCliCandidates(root, scopedRoot) {
  const fromEnv = String(process.env.PRD_FLOW_CLI || "").trim();
  return [
    fromEnv,
    scopedRoot ? path.join(scopedRoot, ".workspace", "prd-flow", "bin", "prd-flow") : "",
    root ? path.join(root, ".workspace", "prd-flow", "bin", "prd-flow") : "",
    scopedRoot ? path.join(scopedRoot, ".agents", "skills", "prd-flow", "bin", "prd-flow") : "",
    root ? path.join(root, ".agents", "skills", "prd-flow", "bin", "prd-flow") : "",
    "prd-flow",
  ].filter(Boolean);
}

function prdWorkflowResolveCli(root, scopedRoot) {
  const candidates = prdWorkflowCliCandidates(root, scopedRoot);
  for (const candidate of candidates) {
    if (candidate === "prd-flow") return { command: candidate, source: "PATH" };
    try {
      if (fs.existsSync(candidate)) return { command: candidate, source: candidate };
    } catch (_) {}
  }
  return { command: "prd-flow", source: "PATH" };
}

function prdWorkflowFallbackSnapshot(tapdId, phase, message, patch = {}) {
  const now = new Date().toISOString();
  return {
    tapdId: String(tapdId || ""),
    phase: String(phase || "unavailable"),
    pointer: String(message || "PRD workflow unavailable"),
    revision: "",
    nextAction: null,
    actions: [],
    milestones: [],
    issues: [],
    artifacts: [],
    optionalGaps: [{ severity: "warn", text: String(message || "PRD workflow unavailable") }],
    sources: { checkedAt: now },
    ...patch,
  };
}

function prdWorkflowStableValue(value) {
  if (Array.isArray(value)) return value.map((item) => prdWorkflowStableValue(item));
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if ([
        "checkedAt",
        "updatedAt",
        "createdAt",
        "clientReportedAt",
        "cacheUpdatedAt",
        "runtimeEventsUpdatedAt",
        "collaboration",
        "sources",
        "rawOutput",
      ].includes(key)) continue;
      out[key] = prdWorkflowStableValue(value[key]);
    }
    return out;
  }
  return value;
}

function prdWorkflowRevisionHash(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(prdWorkflowStableValue(value)))
    .digest("hex")
    .slice(0, 24);
}

function prdWorkflowSnapshotRevision(snapshot = {}) {
  const explicit = String(snapshot?.revision || snapshot?.prd?.revision || snapshot?.next?.revision || "").trim();
  if (explicit) return explicit;
  return `snap:${prdWorkflowRevisionHash({
    tapdId: snapshot?.tapdId || snapshot?.tapd_id || snapshot?.prd?.tapd_id || "",
    phase: snapshot?.phase || snapshot?.workflow_stage || snapshot?.next?.code || "",
    pointer: snapshot?.pointer || snapshot?.current || snapshot?.status || snapshot?.next?.title || "",
    next: snapshot?.nextAction || snapshot?.next || null,
    actions: snapshot?.actions || snapshot?.workflowActions || snapshot?.workflow_actions || [],
    milestones: snapshot?.milestones || [],
    epics: snapshot?.epics || snapshot?.epicGroups || snapshot?.prd?.epics || [],
    issues: snapshot?.issues || snapshot?.issueGroups || snapshot?.prd?.issues || [],
    artifacts: snapshot?.artifacts || snapshot?.outputs || [],
    prd: snapshot?.prd || null,
  })}`;
}

function prdWorkflowSafeStateId(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 128) || "unknown";
}

function prdWorkflowReviewIdFromRequest(tapdId, payload = {}, durability = "temporary") {
  if (durability === "temporary") return `r-${crypto.randomBytes(5).toString("hex")}`;
  const requested = String(payload.reviewId || payload.review_id || "").trim();
  if (!requested) return `review_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
  const safeRequested = prdWorkflowSafeStateId(requested);
  if (safeRequested.length <= 48) return safeRequested;
  const stage = String(payload.stage || payload.stageKey || payload.stage_key || "review").trim();
  const action = String(payload.action || payload.actionId || payload.action_id || "").trim();
  const issueKey = String(payload.issueKey || payload.issue_key || payload.issue || "").trim();
  const stageHead = prdWorkflowSafeStateId(stage.split(":")[0] || stage || "review").slice(0, 20);
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify({ tapdId: String(tapdId || ""), requested, stage, action, issueKey }))
    .digest("hex")
    .slice(0, 10);
  return prdWorkflowSafeStateId(["review", tapdId, stageHead, digest].filter(Boolean).join("-")).slice(0, 64);
}

function prdWorkflowStatePath(scopedRoot, tapdId) {
  const rootDir = scopedRoot || process.cwd();
  return path.join(rootDir, ".workspace", "prd-flow", "workflow-state", `${prdWorkflowSafeStateId(tapdId)}.json`);
}

function prdWorkflowCachePath(scopedRoot, tapdId) {
  const rootDir = scopedRoot || process.cwd();
  return path.join(rootDir, ".workspace", "prd-flow", "workflow-state", `${prdWorkflowSafeStateId(tapdId)}.cache.json`);
}

function prdWorkflowProjectPath(scopedRoot, tapdId) {
  const rootDir = scopedRoot || process.cwd();
  return path.join(rootDir, ".workspace", "prd-flow", "workflow-state", `${prdWorkflowSafeStateId(tapdId)}.project.json`);
}

function prdWorkflowClientsPath(scopedRoot, tapdId) {
  const rootDir = scopedRoot || process.cwd();
  return path.join(rootDir, ".workspace", "prd-flow", "workflow-state", `${prdWorkflowSafeStateId(tapdId)}.clients.json`);
}

function prdWorkflowEventsPath(scopedRoot, tapdId) {
  const rootDir = scopedRoot || process.cwd();
  return path.join(rootDir, ".workspace", "prd-flow", "workflow-state", `${prdWorkflowSafeStateId(tapdId)}.events.json`);
}

function prdWorkflowAuditPath(scopedRoot, tapdId) {
  const rootDir = scopedRoot || process.cwd();
  return path.join(rootDir, ".workspace", "prd-flow", "workflow-state", `${prdWorkflowSafeStateId(tapdId)}.audit.jsonl`);
}

function prdWorkflowReviewDir(scopedRoot, tapdId) {
  const rootDir = path.resolve(scopedRoot || process.cwd());
  return path.join(rootDir, ".workspace", "prd-flow", "reviews", prdWorkflowSafeStateId(tapdId));
}

function prdWorkflowReviewPaths(scopedRoot, tapdId, reviewId) {
  const dir = prdWorkflowReviewDir(scopedRoot, tapdId);
  const safeId = prdWorkflowSafeStateId(reviewId);
  return {
    dir,
    id: safeId,
    markdownPath: path.join(dir, `${safeId}.md`),
    metaPath: path.join(dir, `${safeId}.json`),
  };
}

function prdWorkflowReviewIndexPath(tapdId, reviewId) {
  return path.join(
    getAgentflowDataRoot(),
    "prd-workflow-review-index",
    prdWorkflowSafeStateId(tapdId),
    `${prdWorkflowSafeStateId(reviewId)}.json`,
  );
}

function prdWorkflowWriteReviewIndex(ownerId, tapdId, reviewId) {
  const indexPath = prdWorkflowReviewIndexPath(tapdId, reviewId);
  const tempPath = `${indexPath}.${process.pid}.${Date.now()}.tmp`;
  fs.mkdirSync(path.dirname(indexPath), { recursive: true });
  fs.writeFileSync(tempPath, JSON.stringify({
    version: 1,
    tapdId: String(tapdId || ""),
    reviewId: prdWorkflowSafeStateId(reviewId),
    ownerId: String(ownerId || "").trim(),
    updatedAt: new Date().toISOString(),
  }, null, 2) + "\n", "utf-8");
  fs.renameSync(tempPath, indexPath);
}

function prdWorkflowReadReviewIndex(tapdId, reviewId) {
  try {
    const parsed = JSON.parse(fs.readFileSync(prdWorkflowReviewIndexPath(tapdId, reviewId), "utf-8"));
    if (
      String(parsed?.tapdId || "") !== String(tapdId || "")
      || prdWorkflowSafeStateId(parsed?.reviewId) !== prdWorkflowSafeStateId(reviewId)
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function prdWorkflowReviewFileExists(paths) {
  try {
    return fs.existsSync(paths.markdownPath) && fs.statSync(paths.markdownPath).isFile();
  } catch {
    return false;
  }
}

function prdWorkflowResolveReviewPaths(scopedRoot, tapdId, reviewId) {
  const direct = prdWorkflowReviewPaths(scopedRoot, tapdId, reviewId);
  if (prdWorkflowReviewFileExists(direct)) return direct;

  const indexed = prdWorkflowReadReviewIndex(tapdId, reviewId);
  if (indexed) {
    const indexedPaths = prdWorkflowReviewPaths(
      getAgentflowUserDataRoot(indexed.ownerId || ""),
      tapdId,
      reviewId,
    );
    if (prdWorkflowReviewFileExists(indexedPaths)) return indexedPaths;
  }

  const candidateOwners = ["", ...listAgentflowUserIds()];
  for (const ownerId of candidateOwners) {
    const candidate = prdWorkflowReviewPaths(getAgentflowUserDataRoot(ownerId), tapdId, reviewId);
    if (!prdWorkflowReviewFileExists(candidate)) continue;
    try {
      prdWorkflowWriteReviewIndex(ownerId, tapdId, reviewId);
    } catch (_) {}
    return candidate;
  }
  return direct;
}

function prdWorkflowMigrateLegacyState(legacyRoot, stateRoot, tapdId) {
  const sourceRoot = path.resolve(legacyRoot || "");
  const destinationRoot = path.resolve(stateRoot || "");
  if (!tapdId || sourceRoot === destinationRoot) return;
  const pairs = [
    [prdWorkflowStatePath(sourceRoot, tapdId), prdWorkflowStatePath(destinationRoot, tapdId)],
    [prdWorkflowCachePath(sourceRoot, tapdId), prdWorkflowCachePath(destinationRoot, tapdId)],
    [prdWorkflowProjectPath(sourceRoot, tapdId), prdWorkflowProjectPath(destinationRoot, tapdId)],
    [prdWorkflowClientsPath(sourceRoot, tapdId), prdWorkflowClientsPath(destinationRoot, tapdId)],
    [prdWorkflowEventsPath(sourceRoot, tapdId), prdWorkflowEventsPath(destinationRoot, tapdId)],
    [prdWorkflowAuditPath(sourceRoot, tapdId), prdWorkflowAuditPath(destinationRoot, tapdId)],
  ];
  for (const [source, destination] of pairs) {
    try {
      if (!fs.existsSync(source) || fs.existsSync(destination)) continue;
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    } catch (_) {}
  }
  try {
    const sourceReviews = prdWorkflowReviewDir(sourceRoot, tapdId);
    const destinationReviews = prdWorkflowReviewDir(destinationRoot, tapdId);
    if (fs.existsSync(sourceReviews) && !fs.existsSync(destinationReviews)) {
      fs.mkdirSync(path.dirname(destinationReviews), { recursive: true });
      fs.cpSync(sourceReviews, destinationReviews, { recursive: true, errorOnExist: false });
    }
  } catch (_) {}
}

function prdWorkflowReviewShortLinkDir(root) {
  return path.join(path.resolve(root || process.cwd()), ".workspace", "prd-flow", "review-short-links");
}

function prdWorkflowReviewShortLinkPath(root, shortCode) {
  return path.join(
    prdWorkflowReviewShortLinkDir(root),
    `${String(shortCode || "").trim()}.json`,
  );
}

function prdWorkflowReadReviewShortLink(root, shortCode) {
  const code = String(shortCode || "").trim();
  if (!/^[A-Za-z0-9_-]{8,32}$/.test(code)) return null;
  try {
    const filePath = prdWorkflowReviewShortLinkPath(root, code);
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
    const link = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const targetPath = String(link?.targetPath || "").trim();
    if (!targetPath.startsWith("/api/prd-workflow/review/") || /[\r\n]/.test(targetPath)) return null;
    return {
      ...link,
      shortCode: code,
      targetPath,
      filePath,
    };
  } catch {
    return null;
  }
}

function prdWorkflowCreateReviewShortLink(root, reviewUrl, review = {}) {
  let parsed;
  try {
    parsed = new URL(String(reviewUrl || ""));
  } catch {
    return null;
  }
  const targetPath = `${parsed.pathname}${parsed.search}`;
  if (!targetPath.startsWith("/api/prd-workflow/review/")) return null;
  const digest = crypto.createHash("sha256").update(targetPath).digest("base64url");
  const dir = prdWorkflowReviewShortLinkDir(root);
  fs.mkdirSync(dir, { recursive: true });
  for (let length = 8; length <= 24; length += 2) {
    const shortCode = digest.slice(0, length);
    const existing = prdWorkflowReadReviewShortLink(root, shortCode);
    if (existing && existing.targetPath !== targetPath) continue;
    const link = {
      shortCode,
      targetPath,
      tapdId: String(review?.tapdId || ""),
      reviewId: String(review?.id || ""),
      durability: String(review?.durability || "temporary"),
      expiresAt: String(review?.expiresAt || ""),
      createdAt: String(review?.createdAt || new Date().toISOString()),
    };
    fs.writeFileSync(
      prdWorkflowReviewShortLinkPath(root, shortCode),
      JSON.stringify(link, null, 2) + "\n",
      "utf-8",
    );
    return {
      ...link,
      shortUrl: `${parsed.origin}/r/${shortCode}`,
    };
  }
  throw new Error("Unable to allocate a unique review short code");
}

function prdWorkflowPruneReviews(scopedRoot, tapdId, maxReviews = 200) {
  try {
    const dir = prdWorkflowReviewDir(scopedRoot, tapdId);
    if (!fs.existsSync(dir)) return;
    const now = Date.now();
    const entries = fs.readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const abs = path.join(dir, name);
        let mtimeMs = 0;
        try { mtimeMs = fs.statSync(abs).mtimeMs; } catch (_) {}
        let meta = {};
        try { meta = JSON.parse(fs.readFileSync(abs, "utf-8")); } catch (_) {}
        const expiresMs = Date.parse(meta?.expiresAt || "");
        return { name, abs, id: name.replace(/\.json$/i, ""), mtimeMs, expiresMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
    for (const entry of entries.filter((item) => Number.isFinite(item.expiresMs) && item.expiresMs < now)) {
      try { fs.unlinkSync(entry.abs); } catch (_) {}
      try { fs.unlinkSync(path.join(dir, `${entry.id}.md`)); } catch (_) {}
      try { fs.unlinkSync(prdWorkflowReviewIndexPath(tapdId, entry.id)); } catch (_) {}
    }
    for (const entry of entries.filter((item) => !(Number.isFinite(item.expiresMs) && item.expiresMs < now)).slice(maxReviews)) {
      try { fs.unlinkSync(entry.abs); } catch (_) {}
      try { fs.unlinkSync(path.join(dir, `${entry.id}.md`)); } catch (_) {}
      try { fs.unlinkSync(prdWorkflowReviewIndexPath(tapdId, entry.id)); } catch (_) {}
    }
  } catch (_) {}
}

function prdWorkflowReviewInlineMarkdown(text) {
  const codeSpans = [];
  let escaped = htmlEscapeAttribute(prdWorkflowReviewNormalizeText(text || "")).replace(/`([^`]+)`/g, (_m, code) => {
    const token = `@@CODE${codeSpans.length}@@`;
    codeSpans.push(`<code>${htmlEscapeAttribute(prdWorkflowReviewNormalizeText(code))}</code>`);
    return token;
  });
  escaped = escaped
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]+|file:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
  codeSpans.forEach((html, index) => {
    escaped = escaped.replaceAll(`@@CODE${index}@@`, html);
  });
  return escaped;
}

function prdWorkflowReviewSplitFrontmatter(markdown) {
  const text = String(markdown || "");
  const match = text.match(/^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/);
  if (!match) return { frontmatter: "", body: text };
  return { frontmatter: match[1].trim(), body: text.slice(match[0].length) };
}

function prdWorkflowReviewStripLegacyMetadata(body) {
  const lines = String(body || "").replace(/\r\n/g, "\n").split("\n");
  const visible = [];
  let fenced = false;
  let hidden = false;
  for (const line of lines) {
    if (!hidden && /^\s*```/.test(line)) {
      fenced = !fenced;
      visible.push(line);
      continue;
    }
    if (!fenced && !hidden && /<!--\s*prd-flow-start\b/.test(line)) {
      hidden = !/prd-flow-end\s*-->/.test(line);
      continue;
    }
    if (hidden) {
      if (/prd-flow-end\s*-->/.test(line)) hidden = false;
      continue;
    }
    visible.push(line);
  }
  return visible.join("\n");
}

function prdWorkflowReviewRenderFrontmatter(frontmatter) {
  if (!String(frontmatter || "").trim()) return "";
  const rows = [];
  const lines = String(frontmatter || "").split(/\r?\n/);
  let current = null;
  const flush = () => {
    if (!current) return;
    let valueHtml = "";
    if (current.items.length) {
      valueHtml = `<ul class="frontmatter-list">${current.items.map((item) => `<li>${prdWorkflowReviewInlineMarkdown(item)}</li>`).join("")}</ul>`;
    } else {
      valueHtml = prdWorkflowReviewInlineMarkdown(current.value);
    }
    rows.push(`<tr><th>${htmlEscapeAttribute(current.key)}</th><td>${valueHtml}</td></tr>`);
    current = null;
  };
  for (const rawLine of lines) {
    const line = String(rawLine || "");
    const keyValue = line.match(/^([^:\s][^:]*):\s*(.*)$/);
    if (keyValue) {
      flush();
      const key = keyValue[1].trim();
      const value = keyValue[2].trim();
      const inlineList = value.match(/^\[(.*)\]$/);
      current = {
        key,
        value: inlineList ? "" : value,
        items: inlineList
          ? inlineList[1].split(",").map((item) => item.trim()).filter(Boolean)
          : [],
      };
      continue;
    }
    const listItem = line.match(/^\s*-\s+(.+)$/);
    if (listItem && current) {
      current.items.push(listItem[1].trim());
      continue;
    }
    if (line.trim()) {
      flush();
      rows.push(`<tr><td colspan="2">${prdWorkflowReviewInlineMarkdown(line.trim())}</td></tr>`);
    }
  }
  flush();
  return `<details class="frontmatter" open><summary>文档元数据</summary><table>${rows}</table></details>`;
}

function prdWorkflowReviewRenderTable(lines) {
  const splitRow = (line) => String(line || "")
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
  const headers = splitRow(lines[0]);
  const body = lines.slice(2).map(splitRow);
  return [
    '<div class="table-wrap"><table>',
    `<thead><tr>${headers.map((cell) => `<th>${prdWorkflowReviewInlineMarkdown(cell)}</th>`).join("")}</tr></thead>`,
    `<tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${prdWorkflowReviewInlineMarkdown(cell)}</td>`).join("")}</tr>`).join("")}</tbody>`,
    "</table></div>",
  ].join("");
}

function prdWorkflowReviewMarkdownLinesToHtml(lines) {
  const html = [];
  let paragraph = [];
  let list = [];
  let code = null;
  const flushParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${prdWorkflowReviewInlineMarkdown(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    html.push(`<ul>${list.map((item) => `<li>${item}</li>`).join("")}</ul>`);
    list = [];
  };
  const flushBlocks = () => {
    flushParagraph();
    flushList();
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    const fence = trimmed.match(/^```(\w+)?\s*$/);
    if (code) {
      if (fence) {
        html.push(`<pre><code>${htmlEscapeAttribute(prdWorkflowReviewNormalizeText(code.lines.join("\n")))}</code></pre>`);
        code = null;
      } else {
        code.lines.push(line);
      }
      continue;
    }
    if (fence) {
      flushBlocks();
      code = { lang: fence[1] || "", lines: [] };
      continue;
    }
    if (!trimmed) {
      flushBlocks();
      continue;
    }
    if (/^\|.+\|\s*$/.test(trimmed) && i + 1 < lines.length && /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1].trim())) {
      flushBlocks();
      const tableLines = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && /^\|.+\|\s*$/.test(lines[i].trim())) {
        tableLines.push(lines[i]);
        i += 1;
      }
      i -= 1;
      html.push(prdWorkflowReviewRenderTable(tableLines));
      continue;
    }
    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushBlocks();
      const level = Math.min(6, heading[1].length);
      html.push(`<h${level}>${prdWorkflowReviewInlineMarkdown(heading[2].trim())}</h${level}>`);
      continue;
    }
    const quote = trimmed.match(/^>\s+(.+)$/);
    if (quote) {
      flushBlocks();
      html.push(`<blockquote>${prdWorkflowReviewInlineMarkdown(quote[1])}</blockquote>`);
      continue;
    }
    const bullet = trimmed.match(/^[-*]\s+(?:\[( |x|X)\]\s+)?(.+)$/);
    if (bullet) {
      flushParagraph();
      const checked = bullet[1] ? `<input type="checkbox" disabled${bullet[1].toLowerCase() === "x" ? " checked" : ""}> ` : "";
      list.push(`${checked}${prdWorkflowReviewInlineMarkdown(bullet[2])}`);
      continue;
    }
    paragraph.push(trimmed);
  }
  if (code) html.push(`<pre><code>${htmlEscapeAttribute(prdWorkflowReviewNormalizeText(code.lines.join("\n")))}</code></pre>`);
  flushBlocks();
  return html.join("\n");
}

function prdWorkflowReviewActionLine(line) {
  const match = String(line || "").match(/^\s*[-*]\s+(?:\[( |x|X)\]\s+)?(A\d+|Action\s*\d+)(?=\s|[（(：:.-]|$)(.*)$/i);
  if (!match) return null;
  return {
    checked: match[1] ? match[1].toLowerCase() === "x" : null,
    label: match[2].replace(/\s+/g, " ").toUpperCase(),
    title: String(match[3] || "").replace(/^\s*[-:：]\s*/, "").trim(),
  };
}

function prdWorkflowReviewIsActionsHeading(line) {
  const heading = String(line || "").trim().match(/^(#{1,6})\s+(.+)$/);
  if (!heading) return null;
  const title = heading[2].replace(/[*_`]/g, "").trim();
  if (!/(?:\bTODO\s+Actions?\b|\bActions?\b|待办(?:事项|行动)?|行动项)/i.test(title)) return null;
  return { level: heading[1].length };
}

function prdWorkflowReviewRenderActionSection(lines, sectionIndex) {
  const actionStarts = [];
  lines.forEach((line, index) => {
    const action = prdWorkflowReviewActionLine(line);
    if (action) actionStarts.push({ index, action });
  });
  if (!actionStarts.length) return prdWorkflowReviewMarkdownLinesToHtml(lines);

  const ids = new Map();
  const actions = actionStarts.map(({ index, action }, actionIndex) => {
    const nextStart = actionStarts[actionIndex + 1]?.index ?? lines.length;
    let bodyStart = index + 1;
    const titleParts = [action.title].filter(Boolean);
    while (bodyStart < nextStart) {
      const continuation = String(lines[bodyStart] || "");
      if (!/^\s{2,}\S/.test(continuation) || /^\s*[-*]\s+/.test(continuation) || /^\s*```/.test(continuation)) break;
      titleParts.push(continuation.trim());
      bodyStart += 1;
    }
    const labelId = action.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || actionIndex + 1;
    const baseId = `action-${labelId}${sectionIndex ? `-${sectionIndex + 1}` : ""}`;
    const duplicate = ids.get(baseId) || 0;
    ids.set(baseId, duplicate + 1);
    return {
      ...action,
      id: duplicate ? `${baseId}-${sectionIndex + 1}-${duplicate + 1}` : baseId,
      title: titleParts.join(" ") || action.label,
      body: lines.slice(bodyStart, nextStart),
    };
  });

  const intro = prdWorkflowReviewMarkdownLinesToHtml(lines.slice(0, actionStarts[0].index));
  const navigation = actions.length > 1
    ? `<nav class="action-index" aria-label="Action 快速跳转"><span class="action-index__label">快速跳转</span>${actions.map((action) => `<a href="#${htmlEscapeAttribute(action.id)}">${htmlEscapeAttribute(action.label)}</a>`).join("")}</nav>`
    : "";
  const cards = actions.map((action) => {
    const status = action.checked === null
      ? ""
      : `<span class="action-card__status${action.checked ? " is-complete" : ""}">${action.checked ? "已完成" : "待完成"}</span>`;
    const body = prdWorkflowReviewMarkdownLinesToHtml(action.body);
    return `<section class="action-card${action.checked ? " is-complete" : ""}" id="${htmlEscapeAttribute(action.id)}">
  <div class="action-card__header">
    <span class="action-card__index">${htmlEscapeAttribute(action.label)}</span>
    <h3 class="action-card__title">${prdWorkflowReviewInlineMarkdown(action.title)}</h3>
    ${status}
  </div>
  <div class="action-card__body">${body}</div>
</section>`;
  }).join("\n");
  return [intro, navigation, cards].filter(Boolean).join("\n");
}

function prdWorkflowReviewBodyToHtml(body) {
  const lines = String(body || "").replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let cursor = 0;
  let sectionIndex = 0;
  while (cursor < lines.length) {
    const actionsHeading = prdWorkflowReviewIsActionsHeading(lines[cursor]);
    if (!actionsHeading) {
      const nextHeading = lines.findIndex((line, index) => index > cursor && prdWorkflowReviewIsActionsHeading(line));
      const end = nextHeading >= 0 ? nextHeading : lines.length;
      html.push(prdWorkflowReviewMarkdownLinesToHtml(lines.slice(cursor, end)));
      cursor = end;
      continue;
    }
    let end = cursor + 1;
    while (end < lines.length) {
      const heading = String(lines[end] || "").trim().match(/^(#{1,6})\s+/);
      if (heading && heading[1].length <= actionsHeading.level) break;
      end += 1;
    }
    html.push(prdWorkflowReviewMarkdownLinesToHtml([lines[cursor]]));
    html.push(prdWorkflowReviewRenderActionSection(lines.slice(cursor + 1, end), sectionIndex));
    sectionIndex += 1;
    cursor = end;
  }
  return html.filter(Boolean).join("\n");
}

export function prdWorkflowReviewMarkdownToHtml(markdown) {
  const { frontmatter, body } = prdWorkflowReviewSplitFrontmatter(markdown);
  return [
    prdWorkflowReviewRenderFrontmatter(frontmatter),
    prdWorkflowReviewBodyToHtml(prdWorkflowReviewStripLegacyMetadata(body)),
  ].filter(Boolean).join("\n");
}

function prdWorkflowReviewExtractPageTitle(markdown, fallbackTitle) {
  const { frontmatter, body } = prdWorkflowReviewSplitFrontmatter(markdown);
  const visibleBody = prdWorkflowReviewStripLegacyMetadata(body);
  const lines = String(visibleBody || "").replace(/\r\n/g, "\n").split("\n");
  const firstContentIndex = lines.findIndex((line) => String(line || "").trim());
  const heading = firstContentIndex >= 0
    ? String(lines[firstContentIndex] || "").trim().match(/^#\s+(.+)$/)
    : null;
  if (!heading) {
    return {
      markdown: [
        frontmatter ? `---\n${frontmatter}\n---` : "",
        visibleBody,
      ].filter(Boolean).join("\n\n"),
      title: String(fallbackTitle || "PRD Workflow Review"),
    };
  }

  lines.splice(firstContentIndex, 1);
  const markdownTitle = prdWorkflowReviewNormalizeText(heading[1])
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .trim();
  const bodyWithoutTitle = lines.join("\n").replace(/^\n+/, "");
  return {
    markdown: [
      frontmatter ? `---\n${frontmatter}\n---` : "",
      bodyWithoutTitle,
    ].filter(Boolean).join("\n\n"),
    title: markdownTitle || String(fallbackTitle || "PRD Workflow Review"),
  };
}

export function prdWorkflowReviewHtml(title, markdown, meta = {}) {
  const page = prdWorkflowReviewExtractPageTitle(markdown, title);
  const escapedTitle = htmlEscapeAttribute(page.title);
  const escapedMeta = htmlEscapeAttribute([
    meta.tapdId ? `TAPD ${meta.tapdId}` : "",
    meta.stage ? `stage ${meta.stage}` : "",
    meta.issueKey ? `issue ${meta.issueKey}` : "",
    meta.createdAt || "",
  ].filter(Boolean).join(" · "));
  const durability = String(meta.durability || "").trim().toLowerCase();
  const lifecycle = [
    durability === "temporary" ? "Temporary review link" : durability === "durable" ? "Durable preview" : "",
    meta.expiresAt ? `Expires ${meta.expiresAt}` : "",
    meta.persistence ? `persistence ${meta.persistence}` : "",
  ].filter(Boolean).join(" · ");
  const escapedLifecycle = htmlEscapeAttribute(lifecycle);
  const renderedMarkdown = prdWorkflowReviewMarkdownToHtml(page.markdown);
  const rawHref = htmlEscapeAttribute(meta.rawHref || "?raw=1");
  return `<!doctype html>
<html lang="zh-CN" data-theme="dark">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapedTitle}</title>
  <style>
    :root {
      color-scheme: dark;
      font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      --bg: #1a1b26;
      --panel: #1f2335;
      --panel-strong: #24283b;
      --panel-soft: #292e42;
      --border: #3b4261;
      --border-soft: #30364f;
      --text: #e5e7eb;
      --heading: #f4f4f5;
      --muted: #8b90a0;
      --body: #d4d4d8;
      --link: #7dcfff;
      --interactive: #7aa2f7;
      --purple: #bb9af7;
      --button: #24283b;
      --button-text: #cbd0da;
      --code-bg: #292e42;
      --code-inline: #7dcfff;
      --code-block: #16161e;
      --code-block-text: #e5e7eb;
      --action-bg: #1f2335;
      --action-header: #24283b;
      --pending-bg: rgba(224,175,104,.10);
      --pending-border: rgba(224,175,104,.34);
      --pending-text: #e0af68;
      --complete-bg: rgba(158,206,106,.10);
      --complete-border: rgba(158,206,106,.34);
      --complete-text: #9ece6a;
      --shadow: rgba(9,10,15,.28);
      background: var(--bg);
    }
    :root[data-theme="light"] {
      color-scheme: light;
      --bg: #e1e2e7;
      --panel: #f3f3f5;
      --panel-strong: #e9e9ed;
      --panel-soft: #dcdfe7;
      --border: #c8cad4;
      --border-soft: #d5d7df;
      --text: #4c505e;
      --heading: #343b58;
      --muted: #7f849c;
      --body: #4c505e;
      --link: #007197;
      --interactive: #2e7de9;
      --purple: #7847bd;
      --button: #e7e8ed;
      --button-text: #4c505e;
      --code-bg: #dcdfe7;
      --code-inline: #007197;
      --code-block: #d5d8e1;
      --code-block-text: #343b58;
      --action-bg: #f3f3f5;
      --action-header: #e9e9ed;
      --pending-bg: rgba(177,92,0,.08);
      --pending-border: rgba(177,92,0,.28);
      --pending-text: #9a5200;
      --complete-bg: rgba(88,117,57,.10);
      --complete-border: rgba(88,117,57,.28);
      --complete-text: #587539;
      --shadow: rgba(52,59,88,.10);
    }
    *, *::before, *::after { box-sizing: border-box; }
    html, body { overflow-x: hidden; }
    body { margin: 0; min-height: 100vh; background: var(--bg); color: var(--text); }
    main { width: min(100%, 1180px); margin: 0 auto; padding: 40px 24px 72px; min-width: 0; }
    header { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; margin-bottom: 22px; }
    h1 { margin: 0 0 10px; font-size: clamp(28px, 4vw, 44px); line-height: 1.12; letter-spacing: -.015em; }
    .meta { margin: 0; color: var(--muted); font-size: 14px; }
    .toolbar { flex: 0 0 auto; display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 10px; }
    .raw, .theme-toggle { border: 1px solid var(--border); border-radius: 999px; color: var(--button-text); background: var(--button); padding: 9px 14px; text-decoration: none; font-size: 13px; font-weight: 800; line-height: 1.2; }
    .raw:hover, .theme-toggle:hover { border-color: var(--interactive); color: var(--link); }
    .theme-toggle { cursor: pointer; font-family: inherit; }
    .lifecycle { margin-top: 10px; display: inline-flex; max-width: 100%; border: 1px solid var(--border); border-radius: 999px; background: var(--button); color: var(--muted); padding: 6px 10px; font-size: 12px; font-weight: 800; line-height: 1.35; overflow-wrap: anywhere; }
    article { min-width: 0; border: 1px solid var(--border); border-radius: 14px; background: var(--panel); box-shadow: 0 18px 50px var(--shadow); padding: clamp(20px, 4vw, 34px); }
    article > *:first-child { margin-top: 0; }
    article > *:last-child { margin-bottom: 0; }
    h2, h3, h4, h5, h6 { margin: 1.7em 0 .65em; line-height: 1.25; letter-spacing: 0; color: var(--heading); overflow-wrap: anywhere; }
    h2 { padding-bottom: .4rem; border-bottom: 1px solid var(--border-soft); font-size: 1.5rem; }
    h3 { font-size: 1.2rem; }
    p, li, td, th, blockquote { font-size: 15px; line-height: 1.8; overflow-wrap: anywhere; word-break: break-word; }
    p { margin: .75rem 0; color: var(--body); }
    ul { margin: .65rem 0 1rem; padding-left: 1.35rem; }
    li { margin: .28rem 0; color: var(--body); }
    li input { margin-right: .38rem; transform: translateY(1px); }
    code { display: inline; max-width: 100%; border: 1px solid var(--border-soft); border-radius: 6px; background: var(--code-bg); color: var(--code-inline); padding: .1rem .34rem; font-family: "SFMono-Regular", Consolas, monospace; font-size: .92em; white-space: normal; overflow-wrap: anywhere; word-break: break-word; }
    pre { max-width: 100%; overflow: auto; border: 1px solid var(--border); border-radius: 10px; background: var(--code-block); padding: 16px; line-height: 1.65; }
    pre code { border: 0; background: transparent; color: var(--code-block-text); padding: 0; white-space: pre; overflow-wrap: normal; word-break: normal; }
    blockquote { margin: 1rem 0; border-left: 3px solid var(--purple); background: var(--panel-soft); padding: .75rem 1rem; color: var(--body); }
    a { color: var(--link); text-decoration-thickness: .08em; text-underline-offset: .16em; overflow-wrap: anywhere; }
    .table-wrap { max-width: 100%; overflow-x: auto; margin: 1rem 0 1.25rem; border: 1px solid var(--border-soft); border-radius: 10px; background: var(--panel-strong); }
    table { width: 100%; max-width: 100%; border-collapse: collapse; table-layout: fixed; }
    th, td { min-width: 0; border-bottom: 1px solid var(--border-soft); padding: .65rem .8rem; text-align: left; vertical-align: top; }
    th { background: var(--panel-soft); color: var(--heading); font-weight: 800; }
    tr:last-child td { border-bottom: 0; }
    .frontmatter { margin: 0 0 1.35rem; border: 1px solid var(--border-soft); border-radius: 10px; background: var(--panel-strong); padding: .75rem .9rem; }
    .frontmatter summary { cursor: pointer; color: var(--body); font-weight: 800; }
    .frontmatter table { min-width: 0; margin-top: .7rem; }
    .frontmatter th { width: min(34%, 12rem); background: var(--panel-soft); color: var(--body); }
    .frontmatter-list { margin: 0; padding-left: 1.1rem; }
    .action-index { position: sticky; top: 10px; z-index: 4; display: flex; align-items: center; flex-wrap: wrap; gap: 8px; margin: 1rem 0 1.25rem; border: 1px solid var(--border); border-radius: 12px; background: var(--panel-strong); box-shadow: 0 8px 22px var(--shadow); padding: 10px 12px; }
    .action-index__label { margin-right: 2px; color: var(--muted); font-size: 12px; font-weight: 800; }
    .action-index a { min-width: 38px; border: 1px solid color-mix(in srgb, var(--interactive) 38%, var(--border)); border-radius: 999px; background: color-mix(in srgb, var(--interactive) 10%, var(--button)); color: var(--interactive); padding: 5px 10px; text-align: center; text-decoration: none; font-size: 12px; font-weight: 900; }
    .action-index a:hover { border-color: var(--link); background: color-mix(in srgb, var(--interactive) 18%, var(--button)); color: var(--link); }
    .action-card { scroll-margin-top: 78px; margin: 0 0 20px; overflow: hidden; border: 1px solid var(--border); border-radius: 12px; background: var(--action-bg); box-shadow: 0 8px 24px var(--shadow); }
    .action-card:target { border-color: var(--interactive); box-shadow: 0 0 0 2px color-mix(in srgb, var(--interactive) 18%, transparent), 0 8px 24px var(--shadow); }
    .action-card__header { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: start; gap: 12px; border-bottom: 1px solid var(--border-soft); background: var(--action-header); padding: 16px 18px; }
    .action-card__index { display: inline-grid; place-items: center; min-width: 42px; min-height: 30px; border: 1px solid color-mix(in srgb, var(--interactive) 34%, var(--border)); border-radius: 8px; background: color-mix(in srgb, var(--interactive) 10%, var(--panel-soft)); color: var(--interactive); font: 900 13px/1 "SFMono-Regular", Consolas, monospace; }
    .action-card__title { margin: 3px 0 0; font-size: 16px; line-height: 1.55; letter-spacing: 0; color: var(--heading); }
    .action-card__status { margin-top: 2px; border: 1px solid var(--pending-border); border-radius: 999px; background: var(--pending-bg); color: var(--pending-text); padding: 5px 9px; font-size: 11px; font-weight: 900; white-space: nowrap; }
    .action-card__status.is-complete { border-color: var(--complete-border); background: var(--complete-bg); color: var(--complete-text); }
    .action-card__body { padding: 15px 20px 20px; }
    .action-card__body > *:first-child { margin-top: 0; }
    .action-card__body > *:last-child { margin-bottom: 0; }
    .action-card__body > ul { margin: 0 0 1rem; padding-left: 1.3rem; }
    .action-card__body > ul > li { margin: .55rem 0; padding-left: .15rem; }
    .action-card__body pre { margin: .9rem 0 1.1rem; }
    @media (max-width: 720px) {
      main { padding: 28px 14px 48px; }
      header { display: block; }
      .toolbar { justify-content: flex-start; margin-top: 14px; }
      article { padding: 18px; }
      th, td { padding: .58rem .65rem; }
      .action-index { top: 6px; }
      .action-card__header { grid-template-columns: auto minmax(0, 1fr); padding: 14px; }
      .action-card__status { grid-column: 2; justify-self: start; }
      .action-card__body { padding: 14px 16px 18px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <h1>${escapedTitle}</h1>
        ${escapedMeta ? `<p class="meta">${escapedMeta}</p>` : ""}
        ${escapedLifecycle ? `<p class="lifecycle">${escapedLifecycle}</p>` : ""}
      </div>
      <div class="toolbar">
        <button class="theme-toggle" type="button" data-theme-toggle>明亮模式</button>
        <a class="raw" href="${rawHref}">Raw Markdown</a>
      </div>
    </header>
    <article>${renderedMarkdown}</article>
  </main>
  <script>
    (() => {
      const key = "prd-workflow-review-theme";
      const root = document.documentElement;
      const button = document.querySelector("[data-theme-toggle]");
      const apply = (theme) => {
        root.dataset.theme = theme;
        if (button) button.textContent = theme === "light" ? "暗黑模式" : "明亮模式";
        try { window.localStorage.setItem(key, theme); } catch (_) {}
      };
      let saved = "dark";
      try { saved = window.localStorage.getItem(key) || "dark"; } catch (_) {}
      apply(saved === "light" ? "light" : "dark");
      if (button) button.addEventListener("click", () => apply(root.dataset.theme === "light" ? "dark" : "light"));
    })();
  </script>
</body>
</html>`;
}

function prdWorkflowCreateReview(scopedRoot, tapdId, payload = {}, urlBase = "", ownerId = "") {
  const content = String(payload.markdown || payload.content || payload.rawOutput || "").slice(0, 500000);
  if (!content.trim()) throw new Error("Missing review markdown");
  const title = String(payload.title || payload.label || "PRD Workflow Review").trim().slice(0, 160) || "PRD Workflow Review";
  const durability = String(payload.durability || (payload.durable === true || payload.permanent === true ? "durable" : "temporary")).trim().toLowerCase() || "temporary";
  const reviewId = prdWorkflowReviewIdFromRequest(tapdId, payload, durability);
  const paths = prdWorkflowReviewPaths(scopedRoot, tapdId, reviewId);
  const ttlDaysRaw = Number(payload.ttlDays || payload.ttl_days || (durability === "temporary" ? 7 : 0));
  const ttlDays = Number.isFinite(ttlDaysRaw) && ttlDaysRaw > 0 ? ttlDaysRaw : 0;
  const createdAt = new Date();
  const explicitExpiresAt = String(payload.expiresAt || payload.expires_at || "").trim();
  const expiresAt = durability === "temporary"
    ? (explicitExpiresAt || new Date(createdAt.getTime() + ttlDays * 86400000).toISOString())
    : "";
  const meta = {
    id: paths.id,
    tapdId: String(tapdId || ""),
    title,
    stage: String(payload.stage || payload.stageKey || payload.stage_key || "").trim(),
    action: String(payload.action || payload.actionId || payload.action_id || "").trim(),
    issueKey: String(payload.issueKey || payload.issue_key || payload.issue || "").trim(),
    durability,
    persistence: "runtime",
    source: payload.source && typeof payload.source === "object" && !Array.isArray(payload.source)
      ? payload.source
      : {
          kind: durability === "durable" ? "ai-doc" : "local-draft",
          durability,
        },
    ttlDays,
    expiresAt,
    createdAt: createdAt.toISOString(),
  };
  fs.mkdirSync(paths.dir, { recursive: true });
  fs.writeFileSync(paths.markdownPath, content.trimEnd() + "\n", "utf-8");
  fs.writeFileSync(paths.metaPath, JSON.stringify(meta, null, 2) + "\n", "utf-8");
  prdWorkflowWriteReviewIndex(ownerId, tapdId, paths.id);
  prdWorkflowPruneReviews(scopedRoot, tapdId);
  prdWorkflowAppendAudit(scopedRoot, tapdId, {
    type: "review-created",
    reviewId: paths.id,
    title,
    stage: meta.stage,
    action: meta.action,
    issueKey: meta.issueKey,
    durability,
    persistence: "runtime",
    sourceKind: String(meta.source?.kind || ""),
    expiresAt,
    contentBytes: Buffer.byteLength(content, "utf-8"),
  });
  const url = `${String(urlBase || "").replace(/\/+$/, "")}/api/prd-workflow/review/${encodeURIComponent(prdWorkflowSafeStateId(tapdId))}/${encodeURIComponent(paths.id)}`;
  return { ...meta, url, markdownPath: paths.markdownPath };
}

function prdWorkflowReadCachedSnapshotFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function prdWorkflowReadCachedSnapshot(scopedRoot, tapdId) {
  const cache = prdWorkflowReadCachedSnapshotFile(prdWorkflowCachePath(scopedRoot, tapdId));
  if (cache) return { ...cache, cacheKind: "projection-cache" };
  const legacy = prdWorkflowReadCachedSnapshotFile(prdWorkflowStatePath(scopedRoot, tapdId));
  return legacy ? { ...legacy, cacheKind: "legacy-projection-cache" } : null;
}

function prdWorkflowReadCachedSnapshotWithFallback(root, scopedRoot, tapdId) {
  const scoped = prdWorkflowReadCachedSnapshot(scopedRoot, tapdId);
  if (scoped) return { ...scoped, cacheScope: "scoped", cacheRoot: scopedRoot };
  if (root && path.resolve(root) !== path.resolve(scopedRoot || root)) {
    const global = prdWorkflowReadCachedSnapshot(root, tapdId);
    if (global) return { ...global, cacheScope: "global", cacheRoot: root };
  }
  return null;
}

function prdWorkflowReadJsonFile(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : fallback;
  } catch {
    return fallback;
  }
}

function prdWorkflowWriteJsonFile(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, filePath);
  return data;
}

function prdWorkflowAppendAudit(scopedRoot, tapdId, event = {}) {
  try {
    const p = prdWorkflowAuditPath(scopedRoot, tapdId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const entry = {
      at: new Date().toISOString(),
      tapdId: String(tapdId || ""),
      ...event,
    };
    fs.appendFileSync(p, JSON.stringify(entry) + "\n", "utf-8");
  } catch (_) {}
}

function prdWorkflowReadProjectState(scopedRoot, tapdId) {
  return prdWorkflowReadJsonFile(prdWorkflowProjectPath(scopedRoot, tapdId), {
    version: 1,
    tapdId: String(tapdId || ""),
    updatedAt: "",
    snapshot: null,
    conflicts: [],
  });
}

function prdWorkflowReadProjectStateWithFallback(root, scopedRoot, tapdId) {
  const scoped = prdWorkflowReadProjectState(scopedRoot, tapdId);
  if (scoped?.snapshot) return { ...scoped, cacheScope: "scoped", cacheRoot: scopedRoot };
  if (root && path.resolve(root) !== path.resolve(scopedRoot || root)) {
    const global = prdWorkflowReadProjectState(root, tapdId);
    if (global?.snapshot) return { ...global, cacheScope: "global", cacheRoot: root };
  }
  return scoped?.snapshot ? scoped : null;
}

function prdWorkflowWriteProjectState(scopedRoot, tapdId, snapshot, patch = {}) {
  const prev = prdWorkflowReadProjectState(scopedRoot, tapdId);
  return prdWorkflowWriteJsonFile(prdWorkflowProjectPath(scopedRoot, tapdId), {
    version: 1,
    tapdId: String(tapdId || ""),
    updatedAt: new Date().toISOString(),
    snapshot,
    conflicts: Array.isArray(patch.conflicts) ? patch.conflicts : Array.isArray(prev.conflicts) ? prev.conflicts : [],
    sources: patch.sources && typeof patch.sources === "object" ? patch.sources : prev.sources || {},
  });
}

function prdWorkflowReadClientState(scopedRoot, tapdId) {
  const data = prdWorkflowReadJsonFile(prdWorkflowClientsPath(scopedRoot, tapdId), null);
  if (!data) return { version: 1, tapdId: String(tapdId || ""), updatedAt: "", clients: {} };
  const clients = data.clients && typeof data.clients === "object" && !Array.isArray(data.clients)
    ? data.clients
    : {};
  return { ...data, clients };
}

function prdWorkflowReadClientStateWithFallback(root, scopedRoot, tapdId) {
  const merged = { version: 1, tapdId: String(tapdId || ""), updatedAt: "", clients: {} };
  const add = (state, cacheScope) => {
    if (!state?.clients) return;
    if (state.updatedAt && (!merged.updatedAt || Date.parse(state.updatedAt) > Date.parse(merged.updatedAt))) {
      merged.updatedAt = state.updatedAt;
    }
    for (const [clientId, item] of Object.entries(state.clients)) {
      if (!item || typeof item !== "object" || Array.isArray(item)) continue;
      const prev = merged.clients[clientId];
      const itemTime = Date.parse(item.reportedAt || item.observedAt || "");
      const prevTime = Date.parse(prev?.reportedAt || prev?.observedAt || "");
      if (!prev || !Number.isFinite(prevTime) || (Number.isFinite(itemTime) && itemTime >= prevTime)) {
        merged.clients[clientId] = { ...item, cacheScope };
      }
    }
  };
  if (root && path.resolve(root) !== path.resolve(scopedRoot || root)) {
    add(prdWorkflowReadClientState(root, tapdId), "global");
  }
  add(prdWorkflowReadClientState(scopedRoot, tapdId), "scoped");
  return merged;
}

function prdWorkflowWriteClientObservation(scopedRoot, tapdId, meta, snapshot) {
  const state = prdWorkflowReadClientState(scopedRoot, tapdId);
  const clientId = prdWorkflowSafeStateId(meta.clientId || "anonymous");
  const nextClients = {
    ...state.clients,
    [clientId]: {
      clientId: String(meta.clientId || clientId),
      userId: String(meta.userId || ""),
      observedAt: String(meta.observedAt || ""),
      reportedAt: String(meta.reportedAt || new Date().toISOString()),
      revision: String(snapshot?.revision || ""),
      phase: String(snapshot?.phase || ""),
      pointer: String(snapshot?.pointer || ""),
      nextAction: snapshot?.nextAction || null,
      issues: Array.isArray(snapshot?.issues) ? snapshot.issues : [],
      artifacts: Array.isArray(snapshot?.artifacts) ? snapshot.artifacts : [],
      snapshot,
    },
  };
  return prdWorkflowWriteJsonFile(prdWorkflowClientsPath(scopedRoot, tapdId), {
    version: 1,
    tapdId: String(tapdId || ""),
    updatedAt: new Date().toISOString(),
    clients: nextClients,
  });
}

const PRD_WORKFLOW_PROJECTION_SOURCE_KEYS = new Set([
  "projectionMode",
  "projectCacheScope",
  "legacyCacheScope",
  "clientsUpdatedAt",
  "runtimeEventsUpdatedAt",
]);

function prdWorkflowStoredObservationSources(...sourcesList) {
  const out = {};
  for (const sources of sourcesList) {
    if (!sources || typeof sources !== "object" || Array.isArray(sources)) continue;
    for (const [key, value] of Object.entries(sources)) {
      if (PRD_WORKFLOW_PROJECTION_SOURCE_KEYS.has(key)) continue;
      out[key] = value;
    }
  }
  return out;
}

function prdWorkflowStoredObservationSnapshot(snapshot, sourcePatch = {}) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return snapshot;
  const clean = { ...snapshot };
  delete clean.events;
  delete clean.runtimeEvents;
  delete clean.runtime_events;
  delete clean.collaboration;
  delete clean.clientObservations;
  delete clean.clients;
  clean.sources = prdWorkflowStoredObservationSources(snapshot.sources, sourcePatch);
  return clean;
}

function prdWorkflowProjectFactSource(payload = {}, rawSnapshot = {}) {
  const sources = rawSnapshot?.sources && typeof rawSnapshot.sources === "object" && !Array.isArray(rawSnapshot.sources)
    ? rawSnapshot.sources
    : {};
  const truth = String(payload.truth || rawSnapshot.truth || sources.truth || "").trim().toLowerCase();
  if (!["durable_fact", "project_fact"].includes(truth)) return null;
  return {
    truth,
    authority: String(payload.authority || rawSnapshot.authority || sources.authority || "ai-doc").trim() || "ai-doc",
    persistence: String(payload.persistence || rawSnapshot.persistence || sources.persistence || "ai-doc").trim() || "ai-doc",
  };
}

function prdWorkflowSnapshotMetaFromReport(payload = {}, rawSnapshot = {}, req = null, userCtx = {}) {
  const sources = rawSnapshot.sources && typeof rawSnapshot.sources === "object" && !Array.isArray(rawSnapshot.sources)
    ? rawSnapshot.sources
    : {};
  const headerClientId = req?.headers?.["x-agentflow-client-id"];
  const headerObservedAt = req?.headers?.["x-agentflow-observed-at"];
  const reportedAt = new Date().toISOString();
  return {
    reportedAt,
    observedAt: String(payload.observedAt || payload.observed_at || rawSnapshot.observedAt || rawSnapshot.observed_at || sources.observedAt || sources.checkedAt || headerObservedAt || reportedAt),
    clientId: String(payload.clientId || payload.client_id || sources.clientId || headerClientId || userCtx?.userId || "anonymous").slice(0, 160),
    userId: String(userCtx?.userId || payload.userId || payload.user_id || "").slice(0, 160),
    baseRevision: String(payload.baseRevision || payload.base_revision || payload.expectedRevision || payload.expected_revision || rawSnapshot.baseRevision || sources.baseRevision || "").trim(),
    scope: String(payload.scope || rawSnapshot.scope || rawSnapshot.next?.scope || sources.scope || "client").trim().toLowerCase() || "client",
    platform: String(payload.platform || rawSnapshot.platform || rawSnapshot.next?.platform || sources.platform || "").trim(),
    issueKey: String(payload.issueKey || payload.issue_key || rawSnapshot.issueKey || rawSnapshot.issue_key || rawSnapshot.next?.issue || rawSnapshot.next?.issueKey || "").trim(),
    stageKey: String(payload.stageKey || payload.stage_key || rawSnapshot.stageKey || rawSnapshot.stage_key || rawSnapshot.next?.code || "").trim(),
    force: payload.force === true || payload.force === "1",
  };
}

function prdWorkflowSnapshotReportConflict(existingRecord, incomingSnapshot, meta) {
  if (!existingRecord?.snapshot || meta.force) return null;
  const current = existingRecord.snapshot;
  const currentRevision = String(current.revision || "").trim();
  const incomingRevision = String(incomingSnapshot?.revision || "").trim();
  if (meta.baseRevision && currentRevision && meta.baseRevision !== currentRevision) {
    return {
      reason: "base-revision-mismatch",
      message: `snapshot base revision ${meta.baseRevision} is stale; current revision is ${currentRevision}`,
      expectedRevision: meta.baseRevision,
      currentRevision,
      incomingRevision,
    };
  }
  const incomingObservedAt = Date.parse(meta.observedAt || "");
  const currentObservedAt = Date.parse(
    current?.sources?.clientObservedAt ||
    current?.sources?.clientReportedAt ||
    existingRecord.updatedAt ||
    "",
  );
  if (
    Number.isFinite(incomingObservedAt) &&
    Number.isFinite(currentObservedAt) &&
    incomingObservedAt + 1000 < currentObservedAt &&
    incomingRevision !== currentRevision
  ) {
    return {
      reason: "older-observation",
      message: "snapshot was observed before the current cached workflow state",
      currentRevision,
      incomingRevision,
      currentObservedAt: new Date(currentObservedAt).toISOString(),
      incomingObservedAt: new Date(incomingObservedAt).toISOString(),
    };
  }
  return null;
}

function prdWorkflowClientObservationRows(root, scopedRoot, tapdId) {
  const state = prdWorkflowReadClientStateWithFallback(root, scopedRoot, tapdId);
  return Object.values(state.clients || {})
    .filter((item) => item && typeof item === "object" && !Array.isArray(item))
    .sort((a, b) => Date.parse(b.reportedAt || b.observedAt || "") - Date.parse(a.reportedAt || a.observedAt || ""));
}

function prdWorkflowLatestClientSnapshot(root, scopedRoot, tapdId) {
  const latest = prdWorkflowClientObservationRows(root, scopedRoot, tapdId)[0];
  return latest?.snapshot && typeof latest.snapshot === "object" && !Array.isArray(latest.snapshot)
    ? latest.snapshot
    : null;
}

function prdWorkflowMergedClientIssues(clientRows = []) {
  const out = [];
  const seen = new Map();
  for (const client of clientRows) {
    const issues = Array.isArray(client.snapshot?.issues) ? client.snapshot.issues : Array.isArray(client.issues) ? client.issues : [];
    for (const issue of issues) {
      if (!issue || typeof issue !== "object" || Array.isArray(issue)) continue;
      const key = String(issue.key || issue.issueKey || issue.issue_key || issue.id || issue.title || "").trim();
      const platform = String(issue.platform || "").trim();
      const mergeKey = [key || "issue", platform || "all"].join("|");
      const prevIndex = seen.get(mergeKey);
      const next = {
        ...issue,
        key: key || issue.key,
        platform: platform || issue.platform,
        observedBy: client.clientId || "",
        observedAt: client.observedAt || client.reportedAt || "",
      };
      if (prevIndex != null) out[prevIndex] = { ...out[prevIndex], ...next };
      else {
        seen.set(mergeKey, out.length);
        out.push(next);
      }
    }
  }
  return out;
}

function prdWorkflowArrayCount(value) {
  return Array.isArray(value) ? value.length : 0;
}

function prdWorkflowSnapshotActionCount(snapshot = {}) {
  return prdWorkflowArrayCount(snapshot?.actions) +
    prdWorkflowArrayCount(snapshot?.workflowActions) +
    prdWorkflowArrayCount(snapshot?.workflow_actions) +
    prdWorkflowArrayCount(snapshot?.timeline) +
    prdWorkflowArrayCount(snapshot?.history);
}

function prdWorkflowMaterializeSnapshot(root, scopedRoot, tapdId, userCtx = {}, opts = {}) {
  const flowSource = String(opts.flowSource || "user").trim() || "user";
  const flowId = String(opts.flowId || "").trim();
  const project = prdWorkflowReadProjectStateWithFallback(root, scopedRoot, tapdId);
  const legacy = prdWorkflowReadCachedSnapshotWithFallback(root, scopedRoot, tapdId);
  const latestClient = prdWorkflowLatestClientSnapshot(root, scopedRoot, tapdId);
  const baseSource = project?.snapshot ? "project" : latestClient ? "client-observations" : legacy?.snapshot ? "legacy-cache" : "empty";
  const base = (
    project?.snapshot ||
    latestClient ||
    legacy?.snapshot ||
    prdWorkflowFallbackSnapshot(tapdId, "client_snapshot_required", "等待客户端 prd-flow skill 上报 Workflow snapshot", {
      optionalGaps: [{
        severity: "warn",
        text: "Workflow 服务端不会执行客户端 workspace 里的 prd-flow。请在客户端运行 prd-flow current <tapd_id>，并用 AGENTFLOW_BASE_URL + AGENTFLOW_TOKEN 上报到 /api/prd-workflow/snapshot。",
      }],
      sources: { executionMode: "client-report" },
    })
  );
  const clientObservations = prdWorkflowClientObservationRows(root, scopedRoot, tapdId).map((item) => ({
    clientId: item.clientId,
    userId: item.userId || "",
    phase: item.phase || "",
    pointer: item.pointer || "",
    revision: item.revision || "",
    observedAt: item.observedAt || "",
    reportedAt: item.reportedAt || "",
    nextAction: item.nextAction || null,
    cacheScope: item.cacheScope || "",
  }));
  const clientRows = prdWorkflowClientObservationRows(root, scopedRoot, tapdId);
  const clientIssues = prdWorkflowMergedClientIssues(clientRows);
  const runtimeState = prdWorkflowReadRuntimeEvents(scopedRoot, tapdId);
  const projectionAudit = [
    {
      step: "select-base",
      source: baseSource,
      reason: project?.snapshot
        ? "project materialized snapshot is available"
        : latestClient
          ? "no project snapshot; latest client current observation is used as display base"
          : legacy?.snapshot
            ? "no project/client snapshot; legacy projection cache is used"
            : "no stored workflow projection exists",
      projectSnapshot: Boolean(project?.snapshot),
      latestClientSnapshot: Boolean(latestClient),
      legacySnapshot: Boolean(legacy?.snapshot),
      clientObservationCount: clientRows.length,
      runtimeEventCount: runtimeState.events.length,
      baseActionCount: prdWorkflowSnapshotActionCount(base),
      latestClientRevision: String(latestClient?.revision || ""),
      projectRevision: String(project?.snapshot?.revision || ""),
    },
    {
      step: "merge-client-issues",
      source: "clients",
      applied: !project?.snapshot && clientIssues.length > 0,
      issueCount: clientIssues.length,
      reason: project?.snapshot
        ? "project snapshot owns issue projection"
        : clientIssues.length
          ? "merged issue views from client observations"
          : "no client issue projection available",
    },
    {
      step: "merge-runtime-events",
      source: "runtime-events",
      eventCount: runtimeState.events.length,
      reason: "runtime events are merged after base selection and must not replace durable facts",
    },
  ];
  const materialized = prdWorkflowMergeRuntimeEvents(scopedRoot, tapdId, {
    ...base,
    issues: project?.snapshot ? base.issues : clientIssues.length ? clientIssues : base.issues,
    issueGroups: project?.snapshot ? base.issueGroups : clientIssues.length ? clientIssues : base.issueGroups,
    collaboration: prdWorkflowCollaborationState(userCtx, flowSource, flowId, tapdId),
    clientObservations,
    clients: clientObservations,
    sources: {
      ...(base.sources && typeof base.sources === "object" ? base.sources : {}),
      projectionMode: project?.snapshot ? "project" : latestClient ? "client-observations" : legacy?.snapshot ? "legacy-cache" : "empty",
      projectCacheScope: project?.cacheScope || "",
      legacyCacheScope: legacy?.cacheScope || "",
      clientsUpdatedAt: prdWorkflowReadClientStateWithFallback(root, scopedRoot, tapdId).updatedAt || "",
      checkedAt: new Date().toISOString(),
    },
    projectionAudit,
  });
  materialized.projectionAudit = [
    ...projectionAudit,
    {
      step: "result",
      source: "materialized",
      phase: String(materialized.phase || ""),
      pointer: String(materialized.pointer || ""),
      actionCount: prdWorkflowSnapshotActionCount(materialized) + prdWorkflowArrayCount(materialized.runtimeEvents) + prdWorkflowArrayCount(materialized.runtime_events),
      revision: String(materialized.revision || ""),
    },
  ];
  prdWorkflowAppendAudit(scopedRoot, tapdId, {
    type: "projection-materialized",
    flowSource,
    flowId,
    baseSource,
    projectSnapshot: Boolean(project?.snapshot),
    latestClientSnapshot: Boolean(latestClient),
    legacySnapshot: Boolean(legacy?.snapshot),
    clientObservationCount: clientRows.length,
    runtimeEventCount: runtimeState.events.length,
    baseActionCount: prdWorkflowSnapshotActionCount(base),
    resultActionCount: prdWorkflowSnapshotActionCount(materialized) + prdWorkflowArrayCount(materialized.runtimeEvents) + prdWorkflowArrayCount(materialized.runtime_events),
    revision: String(materialized.revision || ""),
  });
  if (!project?.snapshot && latestClient) {
    materialized.optionalGaps = [
      ...(Array.isArray(materialized.optionalGaps) ? materialized.optionalGaps : []),
      { severity: "info", text: "当前展示来自最新客户端观察；尚未形成独立 project materialized view。" },
    ];
  }
  return materialized;
}

function prdWorkflowNormalizeStoredRuntimeEvent(tapdId, event = {}) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return null;
  const out = { ...event };
  const type = String(out.type || out.kind || "").trim();
  const source = String(out.source || "").trim();
  const idem = String(out.idempotencyKey || out.idempotency_key || "").trim();
  const status = String(out.status || "").trim().toLowerCase();
  const isSnapshotObservation =
    idem.startsWith("snapshot-action:") ||
    (!out.truth && source === "prd-flow-client" && type === "workflow-action");
  if (isSnapshotObservation) {
    out.truth = out.truth || "observation";
    out.persistence = out.persistence || "runtime";
    out.authority = out.authority || "client";
    if (["done", "success", "completed", "passed"].includes(status)) out.status = "observed";
  } else {
    out.truth = out.truth || (type === "review-link" ? "runtime_event" : "runtime_event");
    out.persistence = out.persistence || "runtime";
    out.authority = out.authority || source || "agentflow";
  }
  if (type === "review-link") {
    const durability = String(out.durability || "").trim().toLowerCase();
    const sourceArtifact = out.sourceArtifact && typeof out.sourceArtifact === "object" && !Array.isArray(out.sourceArtifact)
      ? out.sourceArtifact
      : {
          kind: durability === "durable" ? "ai-doc" : "local-draft",
          durability: durability || "temporary",
        };
    out.truth = out.truth || "runtime_event";
    out.persistence = "runtime";
    out.sourceArtifact = sourceArtifact;
    const normalizeReviewRef = (item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return item;
      const kind = String(item.kind || "").trim();
      const hasReviewUrl = /\/api\/prd-workflow\/review\//.test(String(item.url || item.href || ""));
      if (!kind && !hasReviewUrl) return item;
      return {
        ...item,
        persistence: item.persistence || "runtime",
        source: item.source && typeof item.source === "object" && !Array.isArray(item.source) ? item.source : sourceArtifact,
      };
    };
    if (Array.isArray(out.artifacts)) out.artifacts = out.artifacts.map(normalizeReviewRef);
    if (Array.isArray(out.links)) out.links = out.links.map(normalizeReviewRef);
  }
  out.tapdId = String(out.tapdId || out.tapd_id || tapdId || "");
  return out;
}

function prdWorkflowReadRuntimeEvents(scopedRoot, tapdId) {
  try {
    const p = prdWorkflowEventsPath(scopedRoot, tapdId);
    if (!fs.existsSync(p)) return { version: 1, tapdId: String(tapdId || ""), events: [] };
    const data = JSON.parse(fs.readFileSync(p, "utf-8"));
    const events = Array.isArray(data?.events)
      ? data.events
          .map((item) => prdWorkflowNormalizeStoredRuntimeEvent(data?.tapdId || tapdId, item))
          .filter((item) => item && typeof item === "object")
      : [];
    return {
      version: 1,
      tapdId: String(data?.tapdId || tapdId || ""),
      updatedAt: data?.updatedAt || "",
      events,
    };
  } catch {
    return { version: 1, tapdId: String(tapdId || ""), events: [] };
  }
}

function prdWorkflowWriteRuntimeEvents(scopedRoot, tapdId, events) {
  const p = prdWorkflowEventsPath(scopedRoot, tapdId);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const data = {
    version: 1,
    tapdId: String(tapdId || ""),
    updatedAt: new Date().toISOString(),
    events: Array.isArray(events) ? events.slice(-PRD_WORKFLOW_RUNTIME_EVENTS_MAX) : [],
  };
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  fs.renameSync(tmp, p);
  return data;
}

function prdWorkflowRuntimeEventStatus(type, status) {
  const s = String(status || "").trim().toLowerCase();
  if (s) return s;
  const t = String(type || "").trim().toLowerCase();
  if (t.includes("done") || t.includes("success") || t.includes("completed")) return "done";
  if (t.includes("error") || t.includes("failed") || t.includes("conflict")) return "error";
  if (t.includes("start") || t.includes("running")) return "running";
  return "pending";
}

function prdWorkflowRuntimeEventCanonicalStage(event = {}) {
  const issue = String(event.issueKey || event.issue_key || event.issue || "").trim();
  const action = String(event.action || event.actionId || event.action_id || "").trim();
  const rawStage = String(event.stage || event.stageKey || event.stage_key || event.phase || event.code || action || "").trim();
  const text = [rawStage, action, event.code, event.type, event.title].map((value) => String(value || "")).join(" ").toLowerCase();
  if (issue) {
    if (/plan_draft_local|submit-plan|plan-doc/.test(text)) return `issue-plan:${issue}`;
    if (/gitlab_issue_missing|ensure-gitlab-issue/.test(text)) return `issue-gitlab:${issue}`;
  }
  return rawStage || action;
}

function prdWorkflowRuntimeEventId(event = {}) {
  const stage = prdWorkflowRuntimeEventCanonicalStage(event);
  const action = String(event.action || event.actionId || event.action_id || "").trim();
  const scope = String(event.scope || "").trim();
  const platform = String(event.platform || "").trim();
  const aggregateByStage = event.aggregateByStage !== false && event.aggregate_by_stage !== false;
  if ((stage || action) && aggregateByStage) {
    const issue = String(event.issueKey || event.issue_key || event.issue || "").trim();
    const key = [scope, issue, platform, stage || action].filter(Boolean).join(":");
    return `stage_${prdWorkflowSafeStateId(key)}`;
  }
  const existing = String(event.id || event.eventId || event.event_id || "").trim();
  if (existing) return existing.slice(0, 160);
  if (stage || action) {
    const issue = String(event.issueKey || event.issue_key || event.issue || "").trim();
    const key = [scope, issue, platform, stage || action].filter(Boolean).join(":");
    return `stage_${prdWorkflowSafeStateId(key)}`;
  }
  return `evt_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

function prdWorkflowCompactRuntimeValue(value, maxChars = 24000) {
  if (value == null) return value;
  try {
    const text = JSON.stringify(value);
    if (!text || text.length <= maxChars) return value;
    return { truncated: true, preview: text.slice(0, maxChars) };
  } catch {
    const text = String(value || "");
    return text.length <= maxChars ? text : { truncated: true, preview: text.slice(0, maxChars) };
  }
}

function prdWorkflowNormalizeRuntimeEvent(tapdId, event = {}) {
  const now = new Date().toISOString();
  const type = String(event.type || event.kind || "workflow-event").trim().slice(0, 120);
  const action = String(event.action || event.actionId || event.action_id || "").trim().slice(0, 160);
  const stage = String(event.stage || event.stageKey || event.stage_key || event.phase || action || "").trim().slice(0, 160);
  const scope = String(event.scope || "").trim().slice(0, 80);
  const platform = String(event.platform || "").trim().slice(0, 80);
  const status = prdWorkflowRuntimeEventStatus(type, event.status);
  const source = String(event.source || "agentflow").trim().slice(0, 80) || "agentflow";
  const truth = String(
    event.truth ||
    event.stateTruth ||
    event.state_truth ||
    (type === "review-link" ? "runtime_event" : source === "prd-flow-client" && type === "workflow-action" ? "observation" : "runtime_event"),
  ).trim();
  const persistence = String(event.persistence || event.storage || "runtime").trim();
  const authority = String(event.authority || (truth === "observation" ? "client" : source)).trim();
  const entry = {
    ...event,
    id: prdWorkflowRuntimeEventId(event),
    source,
    runtime: event.runtime !== false,
    type,
    tapdId: String(event.tapdId || event.tapd_id || tapdId || ""),
    status,
    truth,
    persistence,
    authority,
    updatedAt: now,
  };
  const sourceEventId = String(event.id || event.eventId || event.event_id || "").trim();
  if (sourceEventId && sourceEventId !== entry.id) entry.sourceEventId = sourceEventId.slice(0, 160);
  if (action) {
    entry.action = action;
    entry.actionId = String(event.actionId || event.action_id || action);
  }
  if (stage) {
    entry.stage = stage;
    entry.stageKey = String(event.stageKey || event.stage_key || stage);
  }
  if (scope) entry.scope = scope;
  if (platform) entry.platform = platform;
  if (!entry.createdAt) entry.createdAt = event.startedAt || now;
  if (!entry.title && (stage || action)) entry.title = stage || action;
  if (!entry.detail && event.message) entry.detail = String(event.message || "").slice(0, 4000);
  if (entry.rawOutput) entry.rawOutput = String(entry.rawOutput).slice(0, 12000);
  if (entry.error) entry.error = String(entry.error).slice(0, 4000);
  if (entry.output != null) entry.output = prdWorkflowCompactRuntimeValue(entry.output);
  if (entry.result != null) entry.result = prdWorkflowCompactRuntimeValue(entry.result);
  const history = Array.isArray(event.idempotencyHistory) ? event.idempotencyHistory : [];
  const idem = String(event.idempotencyKey || "").trim();
  if (idem && !history.includes(idem)) entry.idempotencyHistory = [...history, idem].slice(-50);
  return entry;
}

function prdWorkflowMergeRuntimeEventArrays(left, right) {
  const out = [];
  const seen = new Set();
  for (const value of [...(Array.isArray(left) ? left : []), ...(Array.isArray(right) ? right : [])]) {
    if (value == null) continue;
    let key = "";
    try {
      key = typeof value === "string" ? value : JSON.stringify(value);
    } catch {
      key = String(value);
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function prdWorkflowRuntimeEventArtifactSignature(event = {}) {
  const explicit = String(event.artifactHash || event.artifact_hash || event.hash || "").trim();
  if (explicit) return explicit;
  const parts = [
    event.artifact,
    event.artifactUrl || event.artifact_url,
    event.url,
    event.reviewUrl || event.review_url,
    event.planDoc || event.plan_doc,
  ].map((value) => String(value || "").trim()).filter(Boolean);
  if (parts.length) return parts.join("|");
  const artifacts = Array.isArray(event.artifacts) ? event.artifacts : [];
  const urls = artifacts
    .map((item) => String(item?.url || item?.href || item?.path || item?.label || "").trim())
    .filter(Boolean);
  return urls.length ? urls.join("|") : "";
}

function prdWorkflowRuntimeEventShouldConflictOnArtifact(event = {}) {
  if (event.conflictOnArtifact === true || event.conflict_on_artifact === true) return true;
  if (event.conflictOnArtifact === false || event.conflict_on_artifact === false) return false;
  if (String(event.type || "") === "review-link") return false;
  if ((Array.isArray(event.artifacts) ? event.artifacts : []).some((item) => String(item?.kind || "") === "temporary-review")) return false;
  const stage = String(event.stage || event.stageKey || event.stage_key || event.action || "").toLowerCase();
  return /submit-plan|project-plan|tech-design|plan/.test(stage);
}

function prdWorkflowAppendRuntimeEvent(scopedRoot, tapdId, event = {}) {
  try {
    const current = prdWorkflowReadRuntimeEvents(scopedRoot, tapdId);
    const entry = prdWorkflowNormalizeRuntimeEvent(tapdId, event);
    const entryIdem = String(entry.idempotencyKey || "").trim();
    const index = current.events.findIndex((item) => {
      if (String(item?.id || "") === entry.id) return true;
      if (!entryIdem) return false;
      if (String(item?.idempotencyKey || "").trim() === entryIdem) return true;
      return Array.isArray(item?.idempotencyHistory) && item.idempotencyHistory.includes(entryIdem);
    });
    const updatedExisting = index >= 0;
    let artifactConflict = false;
    const events = [...current.events];
    if (index >= 0) {
      const previousImplementationMetadata =
        events[index]?.implementationMetadata || events[index]?.implementation_metadata;
      const incomingImplementationMetadata =
        entry?.implementationMetadata || entry?.implementation_metadata;
      const mergedImplementationMetadata =
        incomingImplementationMetadata && typeof incomingImplementationMetadata === "object" && !Array.isArray(incomingImplementationMetadata)
          ? prdWorkflowOverallMerge(
              previousImplementationMetadata && typeof previousImplementationMetadata === "object" && !Array.isArray(previousImplementationMetadata)
                ? previousImplementationMetadata
                : {},
              incomingImplementationMetadata,
            )
          : previousImplementationMetadata;
      const previousGlobalStatePatch =
        events[index]?.globalStatePatch || events[index]?.global_state_patch;
      const incomingGlobalStatePatch =
        entry?.globalStatePatch || entry?.global_state_patch;
      const mergedGlobalStatePatch =
        incomingGlobalStatePatch && typeof incomingGlobalStatePatch === "object" && !Array.isArray(incomingGlobalStatePatch)
          ? mergeWorkflowGlobalState(
              previousGlobalStatePatch && typeof previousGlobalStatePatch === "object" && !Array.isArray(previousGlobalStatePatch)
                ? previousGlobalStatePatch
                : {},
              incomingGlobalStatePatch,
            )
          : previousGlobalStatePatch;
      const prevArtifact = prdWorkflowRuntimeEventArtifactSignature(events[index]);
      const nextArtifact = prdWorkflowRuntimeEventArtifactSignature(entry);
      artifactConflict = Boolean(prevArtifact && nextArtifact && prevArtifact !== nextArtifact &&
        prdWorkflowRuntimeEventShouldConflictOnArtifact(events[index]) &&
        prdWorkflowRuntimeEventShouldConflictOnArtifact(entry));
      const idempotencyHistory = [
        ...(events[index].idempotencyKey ? [events[index].idempotencyKey] : []),
        ...(entry.idempotencyKey ? [entry.idempotencyKey] : []),
        ...(Array.isArray(events[index].idempotencyHistory) ? events[index].idempotencyHistory : []),
        ...(Array.isArray(entry.idempotencyHistory) ? entry.idempotencyHistory : []),
      ];
      events[index] = {
        ...events[index],
        ...entry,
        links: prdWorkflowMergeRuntimeEventArrays(events[index].links, entry.links),
        artifacts: mergeWorkflowArtifactLists(events[index].artifacts, entry.artifacts, entry.artifactScope || "action"),
        outputs: prdWorkflowMergeRuntimeEventArrays(events[index].outputs, entry.outputs),
        results: prdWorkflowMergeRuntimeEventArrays(events[index].results, entry.results),
        actionModel: mergeWorkflowGlobalState(events[index].actionModel, entry.actionModel),
        globalStateRemove: prdWorkflowMergeRuntimeEventArrays(
          events[index].globalStateRemove || events[index].global_state_remove,
          entry.globalStateRemove || entry.global_state_remove,
        ),
        createdAt: events[index].createdAt || entry.createdAt,
        startedAt: events[index].startedAt || entry.startedAt,
        idempotencyHistory: [...new Set(idempotencyHistory)].slice(-50),
      };
      if (mergedImplementationMetadata && typeof mergedImplementationMetadata === "object" && !Array.isArray(mergedImplementationMetadata)) {
        events[index].implementationMetadata = mergedImplementationMetadata;
      }
      if (mergedGlobalStatePatch && typeof mergedGlobalStatePatch === "object" && !Array.isArray(mergedGlobalStatePatch)) {
        events[index].globalStatePatch = mergedGlobalStatePatch;
      }
      if (artifactConflict) {
        events[index] = {
          ...events[index],
          type: "same-platform-stage-conflict",
          status: "conflict",
          conflict: {
            type: "same-platform-stage-conflict",
            previousArtifact: prevArtifact,
            incomingArtifact: nextArtifact,
            message: "同一 issue/platform/stage 上报了不同产物，需要本地 agent 拉取后 review。",
          },
        };
      }
    } else {
      events.push(entry);
    }
    prdWorkflowWriteRuntimeEvents(scopedRoot, tapdId, events);
    prdWorkflowAppendAudit(scopedRoot, tapdId, {
      type: "runtime-event-stored",
      eventId: entry.id,
      eventType: entry.type,
      source: entry.source,
      scope: entry.scope || "",
      issueKey: entry.issueKey || entry.issue_key || entry.issue || "",
      platform: entry.platform || "",
      stage: entry.stage || entry.stageKey || entry.stage_key || "",
      action: entry.action || entry.actionId || entry.action_id || "",
      status: entry.status || "",
      truth: entry.truth || "",
      authority: entry.authority || "",
      persistence: entry.persistence || "",
      idempotencyKey: entry.idempotencyKey || "",
      updatedExisting,
      artifactConflict,
      eventCount: events.length,
      note: "runtime event stored as append-only workflow event; projection may merge it into the visible timeline",
    });
    return entry;
  } catch {
    return null;
  }
}

function prdWorkflowFindCompletedIdempotencyEvent(scopedRoot, tapdId, idempotencyKey) {
  const key = String(idempotencyKey || "").trim();
  if (!key) return null;
  const events = prdWorkflowReadRuntimeEvents(scopedRoot, tapdId).events;
  return [...events].reverse().find((event) => (
    (String(event?.idempotencyKey || "") === key || (Array.isArray(event?.idempotencyHistory) && event.idempotencyHistory.includes(key))) &&
    ["done", "success", "completed"].includes(String(event?.status || "").toLowerCase())
  )) || null;
}

function prdWorkflowRuntimeEventDedupeKey(event = {}, index = 0) {
  const stage = prdWorkflowRuntimeEventCanonicalStage(event);
  const aggregateByStage = event.aggregateByStage !== false && event.aggregate_by_stage !== false;
  if (stage) {
    const issue = event?.issueKey || event?.issue_key || event?.issue;
    const platform = event?.platform;
    if (aggregateByStage || issue || platform) {
      return ["stage", event?.scope, issue, platform, stage]
        .map((value) => String(value || "").trim())
        .join(":");
    }
  }
  const id = String(event?.id || event?.eventId || event?.event_id || "").trim();
  if (id) return `id:${id}`;
  if (stage) {
    return ["stage", event?.scope, event?.issueKey || event?.issue_key || event?.issue, event?.platform, stage]
      .map((value) => String(value || "").trim())
      .join(":");
  }
  return `idx:${index}`;
}

function prdWorkflowMergeRuntimeEventList(snapshotEvents = [], runtimeEvents = []) {
  const out = [];
  const seen = new Map();
  for (const event of [...(Array.isArray(snapshotEvents) ? snapshotEvents : []), ...(Array.isArray(runtimeEvents) ? runtimeEvents : [])]) {
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const key = prdWorkflowRuntimeEventDedupeKey(event, out.length);
    const index = seen.get(key);
    if (index == null) {
      seen.set(key, out.length);
      out.push(event);
    } else {
      out[index] = {
        ...out[index],
        ...event,
        links: prdWorkflowMergeRuntimeEventArrays(out[index].links, event.links),
        artifacts: mergeWorkflowArtifactLists(out[index].artifacts, event.artifacts, event.artifactScope || "action"),
        outputs: prdWorkflowMergeRuntimeEventArrays(out[index].outputs, event.outputs),
        results: prdWorkflowMergeRuntimeEventArrays(out[index].results, event.results),
      };
    }
  }
  return out;
}

function prdWorkflowOverallPlainObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function prdWorkflowOverallMerge(base, patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return base;
  const out = { ...prdWorkflowOverallPlainObject(base) };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) {
      delete out[key];
      continue;
    }
    if (value && typeof value === "object" && !Array.isArray(value)) {
      out[key] = prdWorkflowOverallMerge(out[key], value);
      continue;
    }
    out[key] = value;
  }
  return out;
}

function prdWorkflowOverallDeletePath(value, rawPath) {
  const pathParts = String(rawPath || "").split(".").map((part) => part.trim()).filter(Boolean);
  if (!pathParts.length) return value;
  const root = prdWorkflowOverallPlainObject(value);
  let cursor = root;
  for (const part of pathParts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== "object" || Array.isArray(cursor[part])) return root;
    cursor = cursor[part];
  }
  delete cursor[pathParts[pathParts.length - 1]];
  return root;
}

function prdWorkflowOverallValueKey(value) {
  if (typeof value === "string") return value.trim().toLowerCase();
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function prdWorkflowOverallUnique(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    if (value == null || value === "") continue;
    const key = prdWorkflowOverallValueKey(value);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function prdWorkflowOverallFilterValues(filters, key) {
  if (!filters || typeof filters !== "object" || Array.isArray(filters)) return [];
  const aliases = {
    countries: ["countries", "country", "countryFilters", "country_filters"],
    users: ["users", "user", "uids", "uid", "userFilters", "user_filters"],
    versions: ["versions", "version", "versionFilters", "version_filters"],
  };
  for (const alias of aliases[key] || [key]) {
    const value = filters[alias];
    if (Array.isArray(value)) return value;
    if (value != null && value !== "") return [value];
  }
  return [];
}

function prdWorkflowFinalizeOverall(tapdId, value) {
  const overall = prdWorkflowOverallPlainObject(value);
  const requirement = {
    ...prdWorkflowOverallPlainObject(overall.requirement),
    tapdId: String(overall?.requirement?.tapdId || overall?.requirement?.tapd_id || tapdId || ""),
  };
  const platforms = {};
  for (const [rawPlatform, rawValue] of Object.entries(prdWorkflowOverallPlainObject(overall.platforms))) {
    const platform = String(rawPlatform || "").trim().toLowerCase();
    if (!platform) continue;
    const platformValue = prdWorkflowOverallPlainObject(rawValue);
    const issues = prdWorkflowOverallPlainObject(platformValue.issues);
    const implementations = Object.values(issues)
      .map((issue) => prdWorkflowOverallPlainObject(issue).implementation)
      .filter((item) => item && typeof item === "object" && !Array.isArray(item));
    const filters = implementations.map((item) => prdWorkflowOverallPlainObject(item.filters));
    platforms[platform] = {
      ...platformValue,
      tags: prdWorkflowOverallUnique([
        ...(Array.isArray(platformValue.tags) ? platformValue.tags : []),
        ...implementations.flatMap((item) => Array.isArray(item.tags) ? item.tags : []),
      ]),
      experiments: prdWorkflowOverallUnique([
        ...(Array.isArray(platformValue.experiments) ? platformValue.experiments : []),
        ...implementations.flatMap((item) => Array.isArray(item.experiments) ? item.experiments : []),
      ]),
      settings: prdWorkflowOverallUnique([
        ...(Array.isArray(platformValue.settings) ? platformValue.settings : []),
        ...implementations.flatMap((item) => Array.isArray(item.settings) ? item.settings : []),
      ]),
      filters: {
        ...prdWorkflowOverallPlainObject(platformValue.filters),
        countries: prdWorkflowOverallUnique([
          ...prdWorkflowOverallFilterValues(platformValue.filters, "countries"),
          ...filters.flatMap((item) => prdWorkflowOverallFilterValues(item, "countries")),
        ]),
        users: prdWorkflowOverallUnique([
          ...prdWorkflowOverallFilterValues(platformValue.filters, "users"),
          ...filters.flatMap((item) => prdWorkflowOverallFilterValues(item, "users")),
        ]),
        versions: prdWorkflowOverallUnique([
          ...prdWorkflowOverallFilterValues(platformValue.filters, "versions"),
          ...filters.flatMap((item) => prdWorkflowOverallFilterValues(item, "versions")),
        ]),
      },
      rules: prdWorkflowOverallUnique([
        ...(Array.isArray(platformValue.rules) ? platformValue.rules : []),
        ...implementations.flatMap((item) => Array.isArray(item.rules) ? item.rules : []),
      ]),
      issues,
    };
  }
  return {
    ...overall,
    requirement,
    platforms,
  };
}

function prdWorkflowOverallFromEvents(tapdId, snapshot = {}, runtimeEvents = []) {
  const rawOverall =
    snapshot?.overall ||
    snapshot?.prdOverall ||
    snapshot?.prd_overall ||
    snapshot?.raw?.overall ||
    snapshot?.raw?.prdOverall ||
    snapshot?.raw?.prd_overall ||
    snapshot?.raw?.prd?.overall ||
    {};
  let overall = prdWorkflowOverallMerge({}, rawOverall);
  const events = [...(Array.isArray(runtimeEvents) ? runtimeEvents : [])].sort((left, right) => {
    const leftAt = Date.parse(left?.updatedAt || left?.completedAt || left?.createdAt || left?.observedAt || "");
    const rightAt = Date.parse(right?.updatedAt || right?.completedAt || right?.createdAt || right?.observedAt || "");
    if (!Number.isFinite(leftAt) && !Number.isFinite(rightAt)) return 0;
    if (!Number.isFinite(leftAt)) return -1;
    if (!Number.isFinite(rightAt)) return 1;
    return leftAt - rightAt;
  });
  for (const event of events) {
    if (!event || typeof event !== "object" || Array.isArray(event)) continue;
    const patch = event.overallPatch || event.overall_patch;
    if (patch && typeof patch === "object" && !Array.isArray(patch)) {
      overall = prdWorkflowOverallMerge(overall, patch);
    }
    const platform = String(event.platform || "").trim().toLowerCase();
    const issueKey = String(event.issueKey || event.issue_key || event.issue || "").trim();
    const actor = prdWorkflowOverallPlainObject(event.actor);
    if ((event.overallOwnerFromActor === true || event.overall_owner_from_actor === true) && platform && (actor.userId || actor.username)) {
      overall = prdWorkflowOverallMerge(overall, {
        platforms: {
          [platform]: {
            owner: {
              userId: String(actor.userId || ""),
              username: String(actor.username || actor.userId || ""),
              source: "latest-confirmed-plan",
              planVersion: event.planVersion || event.plan_version || "",
              updatedAt: event.updatedAt || event.completedAt || "",
            },
          },
        },
      });
    }
    const implementation = event.implementationMetadata || event.implementation_metadata;
    if (platform && issueKey && implementation && typeof implementation === "object" && !Array.isArray(implementation)) {
      overall = prdWorkflowOverallMerge(overall, {
        platforms: {
          [platform]: {
            issues: {
              [issueKey]: {
                title: String(event.issueTitle || event.issue_title || event.title || ""),
                implementation,
                mr: String(event?.changes?.impl_mr || event?.implMr || event?.impl_mr || ""),
                updatedAt: event.updatedAt || event.completedAt || "",
              },
            },
          },
        },
      });
    }
    const removePaths = event.overallRemove || event.overall_remove;
    for (const removePath of Array.isArray(removePaths) ? removePaths : []) {
      overall = prdWorkflowOverallDeletePath(overall, removePath);
    }
  }
  return prdWorkflowFinalizeOverall(tapdId, overall);
}

function prdWorkflowEventUpdatesOverall(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  return Boolean(
    event.overallPatch ||
    event.overall_patch ||
    event.overallOwnerFromActor === true ||
    event.overall_owner_from_actor === true ||
    event.implementationMetadata ||
    event.implementation_metadata ||
    (Array.isArray(event.overallRemove) && event.overallRemove.length) ||
    (Array.isArray(event.overall_remove) && event.overall_remove.length)
  );
}

function prdWorkflowGlobalStateFromEvents(tapdId, snapshot = {}, runtimeEvents = []) {
  let legacyOverall = prdWorkflowOverallFromEvents(tapdId, snapshot, []);
  let state = materializeWorkflowGlobalState(tapdId, snapshot, [], legacyOverall);
  const events = [...(Array.isArray(runtimeEvents) ? runtimeEvents : [])].sort((left, right) => {
    const leftAt = Date.parse(left?.updatedAt || left?.occurredAt || left?.completedAt || left?.createdAt || left?.observedAt || "");
    const rightAt = Date.parse(right?.updatedAt || right?.occurredAt || right?.completedAt || right?.createdAt || right?.observedAt || "");
    if (!Number.isFinite(leftAt) && !Number.isFinite(rightAt)) return 0;
    if (!Number.isFinite(leftAt)) return -1;
    if (!Number.isFinite(rightAt)) return 1;
    return leftAt - rightAt;
  });
  for (const event of events) {
    if (prdWorkflowEventUpdatesOverall(event)) {
      legacyOverall = prdWorkflowOverallFromEvents(tapdId, { overall: legacyOverall }, [event]);
      state = mergeWorkflowGlobalState(state, legacyOverallToGlobalState(tapdId, legacyOverall));
    }
    state = materializeWorkflowGlobalState(tapdId, { globalState: state }, [event], {});
  }
  return state;
}

function prdWorkflowMergeRuntimeEvents(scopedRoot, tapdId, snapshot) {
  const runtime = prdWorkflowReadRuntimeEvents(scopedRoot, tapdId);
  const runtimeEvents = runtime.events;
  const events = prdWorkflowMergeRuntimeEventList(snapshot?.events, runtimeEvents);
  const overall = prdWorkflowOverallFromEvents(tapdId, snapshot, runtimeEvents);
  const globalState = prdWorkflowGlobalStateFromEvents(tapdId, snapshot, runtimeEvents);
  const artifacts = mergeWorkflowArtifacts(snapshot?.artifacts, runtimeEvents);
  return {
    ...snapshot,
    workflow: globalState.workflow,
    overall,
    globalState,
    artifacts,
    runtimeRevision: workflowRuntimeRevision(globalState, artifacts, runtimeEvents),
    runtimeEvents,
    events,
    sources: {
      ...(snapshot?.sources && typeof snapshot.sources === "object" ? snapshot.sources : {}),
      runtimeEventsUpdatedAt: runtime.updatedAt || "",
    },
  };
}

function prdWorkflowMockSnapshot(scopedRoot, tapdId = "mock-prd") {
  const id = String(tapdId || "mock-prd");
  const now = new Date().toISOString();
  return prdWorkflowMergeRuntimeEvents(scopedRoot, id, {
    tapdId: id,
    phase: "implementing",
    pointer: "实现中：Tunnel ConfigV3 支持",
    revision: "mock:tapd-ai-doc-gitlab-runtime",
    actions: [
      {
        id: "stage_tech_design",
        stage: "tech_design",
        action: "submit-tech-design",
        title: "确认技术方案",
        detail: "tech_design.md 与 TAPD baseline 已归档",
        status: "done",
        updatedAt: now,
        artifacts: [{ label: "技术方案", url: "https://example.com/ai-doc/stories/mock/tech_design.md" }],
      },
      {
        id: "stage_plan_android",
        stage: "submit-plan",
        action: "submit-plan",
        issueKey: "tunnel-config-v3",
        title: "提交 Android 实施计划",
        detail: "计划已确认，GitLab Issue 已绑定",
        status: "done",
        updatedAt: now,
        artifacts: [{ label: "Android Plan", url: "https://example.com/ai-doc/stories/mock/android-plan.md" }],
      },
      {
        id: "stage_implementation_tunnel-config-v3",
        stage: "implementation",
        action: "mark",
        issueKey: "tunnel-config-v3",
        title: "实现 Tunnel ConfigV3",
        detail: "Android MR 已创建，iOS 待处理",
        status: "current",
        updatedAt: now,
        dryRunSupported: true,
      },
    ],
    nextAction: {
      action: "mark",
      actionId: "mark-impl-mr",
      stage: "implementation",
      issueKey: "tunnel-config-v3",
      title: "记录实现 MR",
      detail: "验证 GitLab Issue/MR 关联后写入 Workflow runtime",
      dryRunSupported: true,
    },
    epics: [
      {
        key: "network-governance",
        title: "网络治理",
        issues: [
          {
            key: "tunnel-config-v3",
            title: "Tunnel ConfigV3 URI 云控支持",
            platform: "all",
            status: "implementing",
            issueUrl: "https://example.com/gitlab/issues/101",
            planDocUrl: "https://example.com/ai-doc/stories/mock/android-plan.md",
            mrs: [
              { label: "Android MR", platform: "android", url: "https://example.com/gitlab/mr/1", status: "opened" },
              { label: "iOS MR", platform: "ios", url: "https://example.com/gitlab/mr/2", status: "todo" },
            ],
          },
          {
            key: "self-test-package",
            parentKey: "tunnel-config-v3",
            title: "自测包与验证记录",
            platform: "all",
            status: "pending",
            links: [{ label: "临时 review", url: "https://example.com/review/mock" }],
          },
        ],
      },
    ],
    issues: [
      {
        key: "tunnel-config-v3",
        epicKey: "network-governance",
        title: "Tunnel ConfigV3 URI 云控支持",
        platform: "all",
        status: "implementing",
      },
    ],
    artifacts: [
      { label: "TAPD 需求", kind: "tapd", url: "https://example.com/tapd/mock" },
      { label: "技术方案", kind: "ai-doc", url: "https://example.com/ai-doc/stories/mock/tech_design.md" },
    ],
    optionalGaps: [{ severity: "info", text: "Mock snapshot: 用于验证 Workflow 阶段、Epic/Issue 层级和 MR 归类。" }],
    sources: { checkedAt: now, mock: true },
  });
}

function prdWorkflowWriteCachedSnapshot(scopedRoot, tapdId, snapshot) {
  try {
    const p = prdWorkflowCachePath(scopedRoot, tapdId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const data = {
      version: 1,
      tapdId: String(tapdId || ""),
      updatedAt: new Date().toISOString(),
      snapshot,
      sources: {
        truth: "projection",
        authority: "agentflow-runtime",
        persistence: "cache",
      },
    };
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
    fs.renameSync(tmp, p);
    return data;
  } catch {
    return null;
  }
}

function prdWorkflowFallbackWithCache(scopedRoot, tapdId, fallback, userCtx = {}, flowSource = "user", flowId = "") {
  const cached = prdWorkflowReadCachedSnapshot(scopedRoot, tapdId);
  const snapshot = cached?.snapshot && typeof cached.snapshot === "object" && !Array.isArray(cached.snapshot)
    ? cached.snapshot
    : null;
  if (!snapshot) {
    return {
      ...fallback,
      collaboration: prdWorkflowCollaborationState(userCtx, flowSource, flowId, tapdId),
    };
  }
  const optionalGaps = [
    ...(Array.isArray(fallback?.optionalGaps) ? fallback.optionalGaps : []),
    ...(Array.isArray(snapshot.optionalGaps) ? snapshot.optionalGaps : []),
  ];
  return prdWorkflowMergeRuntimeEvents(scopedRoot, tapdId, {
    ...snapshot,
    stale: true,
    runtimeStatus: fallback?.phase || "unavailable",
    runtimeMessage: fallback?.pointer || fallback?.error || "",
    optionalGaps,
    collaboration: prdWorkflowCollaborationState(userCtx, flowSource, flowId, tapdId),
    sources: {
      ...(snapshot.sources && typeof snapshot.sources === "object" ? snapshot.sources : {}),
      cacheUpdatedAt: cached.updatedAt || "",
      checkedAt: new Date().toISOString(),
    },
  });
}

function prdWorkflowWithAgentflowTokenDiagnostic(snapshot, sessionToken = "") {
  const current = snapshot && typeof snapshot === "object" && !Array.isArray(snapshot) ? snapshot : {};
  const tokenPresent = Boolean(String(sessionToken || "").trim());
  const optionalGaps = Array.isArray(current.optionalGaps) ? [...current.optionalGaps] : [];
  const hasTokenHint = optionalGaps.some((gap) => /AgentFlow runtime token|AGENTFLOW_BASE_URL|AGENTFLOW_TOKEN|session token/i.test(String(gap?.text || gap || "")));
  if (!hasTokenHint) {
    optionalGaps.push({
      severity: "info",
      text: tokenPresent
        ? "当前浏览器会话已有 AgentFlow token。客户端 prd-flow skill/CLI 同步 Workflow 时还需要 AGENTFLOW_BASE_URL，并使用 AGENTFLOW_TOKEN 或 PRD_FLOW_RUNTIME_EVENT_TOKEN 上报 snapshot/event；不要把 token 写入 ai-doc 或 prd-flow config。"
        : "当前请求没有 AgentFlow session token。客户端 prd-flow skill/CLI 要同步 Workflow 时，需要在客户端 .env 配置 AGENTFLOW_BASE_URL 和 AGENTFLOW_TOKEN，或配置 PRD_FLOW_RUNTIME_BASE_URL 和 PRD_FLOW_RUNTIME_EVENT_TOKEN。",
    });
  }
  return {
    ...current,
    optionalGaps,
    sources: {
      ...(current.sources && typeof current.sources === "object" ? current.sources : {}),
      agentflowRuntimeToken: tokenPresent ? "session" : "not-required-for-local-ui",
    },
  };
}

function prdWorkflowAllowServerExec() {
  return parseBool(process.env.AGENTFLOW_PRD_WORKFLOW_SERVER_EXEC, false);
}

function prdWorkflowParseJson(stdout) {
  const text = String(stdout || "").trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (_) {}
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1));
    } catch (_) {}
  }
  return null;
}

function prdWorkflowFirstArray(...values) {
  const value = values.find((item) => Array.isArray(item));
  return value ? [...value] : [];
}

function prdWorkflowSplitCommand(command) {
  const text = String(command || "").trim();
  if (!text || /[\0\r\n]/.test(text) || text.length > 4000) return [];
  const tokens = [];
  let current = "";
  let quote = "";
  let escaping = false;
  for (const ch of text) {
    if (escaping) {
      current += ch;
      escaping = false;
      continue;
    }
    if (ch === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = "";
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (escaping) current += "\\";
  if (quote) return [];
  if (current) tokens.push(current);
  return tokens.filter(Boolean);
}

function prdWorkflowCommandArgs(command) {
  const tokens = prdWorkflowSplitCommand(command);
  if (!tokens.length) return [];
  const first = tokens[0] || "";
  const start = path.basename(first) === "prd-flow" ? 1 : 0;
  const args = tokens.slice(start);
  const action = String(args[0] || "");
  if (!action || action.startsWith("-") || /[\/\\]/.test(action)) return [];
  return args;
}

function prdWorkflowCommandTapdId(args = []) {
  for (const arg of args.slice(1)) {
    const value = String(arg || "").trim();
    if (!value || value.startsWith("-")) continue;
    return value;
  }
  return "";
}

function prdWorkflowNormalizeNextAction(parsed = {}, fallbackTapdId = "") {
  const raw = parsed.nextAction || parsed.next_action || parsed.currentAction || parsed.current_action || parsed.next || null;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const command = String(raw.command || raw.nextCommand || raw.next_command || "").trim();
  const args = prdWorkflowCommandArgs(command);
  const action = String(raw.action || raw.actionId || raw.action_id || args[0] || raw.code || raw.id || "").trim();
  const issue = raw.issue && typeof raw.issue === "object" && !Array.isArray(raw.issue)
    ? String(raw.issue.key || raw.issue.id || raw.issue.title || "").trim()
    : String(raw.issue || raw.issueKey || raw.issue_key || "").trim();
  const title = String(raw.title || raw.label || raw.name || raw.code || action || "下一步").trim();
  return {
    ...raw,
    id: String(raw.id || raw.code || action || "next"),
    action,
    actionId: String(raw.actionId || raw.action_id || action),
    command,
    label: String(raw.label || title),
    title,
    detail: String(raw.detail || raw.description || raw.user_hint || raw.userHint || ""),
    issueKey: issue,
    tapdId: String(raw.tapdId || raw.tapd_id || prdWorkflowCommandTapdId(args) || fallbackTapdId || ""),
    dryRunSupported: raw.dryRunSupported !== false && raw.dry_run_supported !== false,
    dryRunMode: command ? "preview" : raw.dryRunMode || raw.dry_run_mode || "",
  };
}

async function runPrdWorkflowCommand(root, scopedRoot, args = [], userCtx = {}, options = {}) {
  const cli = prdWorkflowResolveCli(root, scopedRoot);
  const cwd = scopedRoot || root || process.cwd();
  const env = runtimeEnvForUser(userCtx, {
    PRD_FLOW_WORKSPACE: path.join(cwd, ".workspace", "prd-flow"),
    ...(options.env && typeof options.env === "object" && !Array.isArray(options.env) ? options.env : {}),
  });
  const result = await execFileBuffered(cli.command, args, {
    cwd,
    env,
    timeout: Number(options.timeout || 120000),
    maxBuffer: Number(options.maxBuffer || 4 * 1024 * 1024),
  });
  return { ...result, cli };
}

function prdWorkflowSnapshotFromParsed(scopedRoot, tapdId, parsed = {}, userCtx = {}, opts = {}) {
  const id = String(tapdId || parsed?.tapdId || parsed?.tapd_id || parsed?.prd?.tapd_id || parsed?.prd?.tapdId || "").trim();
  const flowSource = String(opts.flowSource || "user").trim() || "user";
  const flowId = String(opts.flowId || "").trim();
  const nextAction = prdWorkflowNormalizeNextAction(parsed, id);
  const prd = parsed.prd && typeof parsed.prd === "object" && !Array.isArray(parsed.prd) ? parsed.prd : {};
  const actions = prdWorkflowFirstArray(parsed.actions, parsed.workflowActions, parsed.workflow_actions);
  const epics = prdWorkflowFirstArray(parsed.epics, parsed.epicGroups, parsed.epic_groups, prd.epics, prd.epicGroups, prd.epic_groups);
  const issues = prdWorkflowFirstArray(parsed.issues, parsed.issueGroups, parsed.issue_groups, prd.issues, prd.issueGroups, prd.issue_groups);
  const optionalGaps = prdWorkflowFirstArray(parsed.optionalGaps, parsed.optional_gaps);
  if (!actions.length && !nextAction) {
    optionalGaps.push({ severity: "warn", text: "prd-flow current --json 未返回 actions/nextAction，Workflow 时间线只能显示 runtime 或空状态。" });
  }
  if (!epics.length && !issues.length) {
    optionalGaps.push({ severity: "info", text: "prd-flow current --json 未返回 epics/issues，Issue 整合区暂为空。" });
  }
  const snapshot = {
    tapdId: String(parsed.tapdId || parsed.tapd_id || prd.tapd_id || prd.tapdId || id),
    phase: String(parsed.phase || parsed.workflow_stage || nextAction?.id || parsed.next?.code || "unknown"),
    pointer: String(parsed.pointer || parsed.current || parsed.status || nextAction?.title || ""),
    revision: String(parsed.revision || prd.revision || parsed.next?.revision || ""),
    nextAction,
    actions,
    workflowActions: actions,
    timeline: prdWorkflowFirstArray(parsed.timeline),
    events: prdWorkflowFirstArray(parsed.events),
    history: prdWorkflowFirstArray(parsed.history),
    milestones: prdWorkflowFirstArray(parsed.milestones),
    epics,
    epicGroups: epics,
    issues,
    issueGroups: issues,
    artifacts: prdWorkflowFirstArray(parsed.artifacts, parsed.outputs),
    dependencies: prdWorkflowFirstArray(parsed.dependencies),
    optionalGaps,
    sources: parsed.sources && typeof parsed.sources === "object" ? parsed.sources : {},
    overall: prdWorkflowOverallFromEvents(id, {
      overall: parsed.overall || parsed.prdOverall || parsed.prd_overall || prd.overall || {},
    }, []),
    raw: parsed,
    collaboration: prdWorkflowCollaborationState(userCtx, flowSource, flowId, id),
  };
  snapshot.revision = prdWorkflowSnapshotRevision(snapshot);
  return snapshot;
}

async function prdWorkflowSnapshot(root, scopedRoot, tapdId, userCtx = {}, opts = {}) {
  const id = String(tapdId || "").trim();
  const flowSource = String(opts.flowSource || "user").trim() || "user";
  const flowId = String(opts.flowId || "").trim();
  if (!id) {
    return {
      ...prdWorkflowFallbackSnapshot("", "unselected", "输入 TAPD ID 后读取 Workflow 状态"),
      collaboration: prdWorkflowCollaborationState(userCtx, flowSource, flowId, ""),
    };
  }
  if (!prdWorkflowAllowServerExec()) {
    return prdWorkflowMaterializeSnapshot(root, scopedRoot, id, userCtx, { flowSource, flowId });
  }
  try {
    const result = await runPrdWorkflowCommand(root, scopedRoot, ["current", id, "--json"], userCtx, { timeout: 120000 });
    const parsed = prdWorkflowParseJson(result.stdout);
    if (!parsed) {
      return prdWorkflowFallbackWithCache(scopedRoot, id, prdWorkflowFallbackSnapshot(id, "json_unsupported", "prd-flow current --json 暂不可用或未返回 JSON", {
        rawOutput: String(result.stdout || result.stderr || "").slice(0, 8000),
        cli: result.cli,
      }), userCtx, flowSource, flowId);
    }
    const snapshot = {
      ...prdWorkflowSnapshotFromParsed(scopedRoot, id, parsed, userCtx, opts),
      cli: result.cli,
    };
    const mergedSnapshot = prdWorkflowMergeRuntimeEvents(scopedRoot, id, snapshot);
    prdWorkflowWriteCachedSnapshot(scopedRoot, id, mergedSnapshot);
    return mergedSnapshot;
  } catch (e) {
    const code = e?.code || "";
    const stdout = String(e?.stdout || "");
    const stderr = String(e?.stderr || "");
    const missing = code === "ENOENT";
    return prdWorkflowFallbackWithCache(scopedRoot, id, prdWorkflowFallbackSnapshot(
      id,
      missing ? "unavailable" : "command_failed",
      missing ? "未找到 prd-flow CLI，请先在 workspace 配置 .workspace/prd-flow/bin/prd-flow 或设置 PRD_FLOW_CLI" : `prd-flow current --json 执行失败：${String(e?.message || e)}`,
      {
        rawOutput: `${stdout}${stdout && stderr ? "\n" : ""}${stderr}`.slice(0, 8000),
        error: String(e?.message || e),
      },
    ), userCtx, flowSource, flowId);
  }
}

function normalizePrdWorkflowActionArgs(payload = {}) {
  const command = String(payload.command || payload.nextCommand || payload.next_command || "").trim();
  const commandArgs = prdWorkflowCommandArgs(command);
  const action = String(payload.action || payload.actionId || commandArgs[0] || "").trim();
  if (!action || action.startsWith("-") || /[\0\r\n]/.test(action) || action.length > 160) {
    return { error: "Invalid prd-flow action" };
  }
  const tapdId = String(payload.tapdId || payload.tapd_id || prdWorkflowCommandTapdId(commandArgs)).trim();
  if (!tapdId) return { error: "Missing tapdId" };
  if (commandArgs.length) {
    const expectedRevision = String(payload.expectedRevision || "").trim();
    const idempotencyKey = String(payload.idempotencyKey || "").trim();
    const args = [...commandArgs];
    if (expectedRevision && !args.includes("--expected-revision")) args.push("--expected-revision", expectedRevision);
    if (idempotencyKey && !args.includes("--idempotency-key")) args.push("--idempotency-key", idempotencyKey);
    return {
      action,
      tapdId,
      args,
      idempotencyKey,
      command,
      previewOnly: payload.dryRun === true || payload.dry_run === true,
      fromCommand: true,
    };
  }
  const args = [action, tapdId];
  const issue = String(payload.issueKey || payload.issue || "").trim();
  if (issue) args.push("--issue", issue);
  const summary = String(payload.summary || "").trim();
  if (summary && action === "start-fix") args.push("--summary", summary);
  const testEnv = String(payload.testEnv || payload.test_environment || "").trim();
  if (testEnv && action === "submit-test") args.push("--test-env", testEnv);
  const mr = String(payload.mr || payload.url || "").trim();
  if (mr && action === "submit-test") args.push("--mr", mr);
  if (payload.confirm === true) args.push("--confirm");
  if (payload.dryRun === true || payload.dry_run === true) args.push("--dry-run");
  if (payload.allowMissingImplementation === true) args.push("--allow-missing-implementation");
  const expectedRevision = String(payload.expectedRevision || "").trim();
  if (expectedRevision) args.push("--expected-revision", expectedRevision);
  const idempotencyKey = String(payload.idempotencyKey || "").trim();
  if (idempotencyKey) args.push("--idempotency-key", idempotencyKey);
  args.push("--json");
  return { action, tapdId, args, idempotencyKey };
}

function prdWorkflowActionText(payload = {}, normalized = {}) {
  return [
    normalized?.action,
    payload.action,
    payload.actionId,
    payload.action_id,
    payload.command,
    payload.marker,
    payload.flag,
    payload.stage,
    payload.stageKey,
    payload.stage_key,
    payload.title,
    payload.label,
  ].map((value) => String(value || "").trim()).filter(Boolean).join(" ");
}

function prdWorkflowFirstString(...values) {
  for (const value of values) {
    const text = String(value || "").trim();
    if (text) return text;
  }
  return "";
}

function prdWorkflowMarkerEventSpec(payload = {}, normalized = {}) {
  const text = prdWorkflowActionText(payload, normalized).toLowerCase().replace(/[_\s]+/g, "-");
  const explicitRuntimeOnly = payload.runtimeOnly === true || payload.runtime_only === true ||
    payload.markerOnly === true || payload.marker_only === true;
  const specs = [
    { re: /(^|-)mark-impl-mr($|-)|(^|-)record-impl-mr($|-)|--impl-mr\b/, stage: "implementation", title: "记录实现 MR", kind: "impl-mr" },
    { re: /(^|-)mark-fix-mr($|-)|(^|-)record-fix-mr($|-)|--fix-mr\b/, stage: "bugfix", title: "记录修复 MR", kind: "fix-mr" },
    { re: /(^|-)mark-impl-done($|-)|--impl-done\b/, stage: "implementation", title: "实现完成标记", kind: "impl-done" },
    { re: /(^|-)mark-impl-merged($|-)|--impl-merged\b/, stage: "implementation", title: "实现 MR 合并标记", kind: "impl-merged" },
    { re: /(^|-)mark-integration-mr($|-)|(^|-)record-integration-mr($|-)|--integration-mr\b/, stage: "submit-test", title: "记录集成 MR", kind: "integration-mr" },
    { re: /(^|-)mark-integrated($|-)|--integrated\b/, stage: "submit-test", title: "集成完成标记", kind: "integrated" },
    { re: /(^|-)retry-jenkins($|-)|(^|-)retry-jenkins-build($|-)|(^|-)record-jenkins($|-)/, stage: "self-test", title: "Jenkins 构建记录", kind: "jenkins" },
    { re: /(^|-)record-test-mr($|-)|(^|-)test-mr($|-)/, stage: "submit-test", title: "记录提测 MR", kind: "test-mr" },
  ];
  let matched = specs.find((spec) => spec.re.test(text));
  if (!matched && explicitRuntimeOnly) {
    matched = {
      stage: prdWorkflowFirstString(payload.stageKey, payload.stage_key, payload.stage, normalized.action, payload.action, "workflow"),
      title: prdWorkflowFirstString(payload.title, payload.label, normalized.action, payload.action, "Workflow runtime action"),
      kind: "runtime",
    };
  }
  if (!matched) return null;
  const issueKey = prdWorkflowFirstString(payload.issueKey, payload.issue_key, payload.issue);
  const url = prdWorkflowFirstString(payload.url, payload.href, payload.mr, payload.mrUrl, payload.mr_url, payload.mergeRequestUrl, payload.merge_request_url);
  const links = Array.isArray(payload.links) ? payload.links : [];
  const artifacts = Array.isArray(payload.artifacts) ? payload.artifacts : [];
  const title = prdWorkflowFirstString(payload.title, payload.label, matched.title);
  const stage = prdWorkflowFirstString(payload.stageKey, payload.stage_key, payload.stage, matched.stage);
  const linkArtifacts = url ? [{ kind: matched.kind, label: title, url }] : [];
  return {
    runtimeOnly: true,
    kind: matched.kind,
    stage,
    title,
    issueKey,
    detail: prdWorkflowFirstString(payload.detail, payload.description, payload.summary, url ? "记录外部系统事实，不写 ai-doc marker" : "记录运行态事实，不写 ai-doc marker"),
    links,
    artifacts: [...artifacts, ...linkArtifacts],
  };
}

function prunePrdWorkflowIdempotency() {
  if (prdWorkflowIdempotency.size <= PRD_WORKFLOW_IDEMPOTENCY_MAX) return;
  const entries = Array.from(prdWorkflowIdempotency.entries())
    .sort((a, b) => Number(a[1]?.at || 0) - Number(b[1]?.at || 0));
  for (const [key] of entries.slice(0, Math.max(1, entries.length - PRD_WORKFLOW_IDEMPOTENCY_MAX))) {
    prdWorkflowIdempotency.delete(key);
  }
}

function workspaceIntervalMinutesToCron(intervalMinutes) {
  const n = Number(intervalMinutes);
  if (!Number.isFinite(n) || n <= 0) return "0 9 * * *";
  const minutes = Math.max(1, Math.min(1440, Math.round(n)));
  if (minutes < 60) return `*/${minutes} * * * *`;
  if (minutes === 60) return "0 * * * *";
  if (minutes < 1440 && minutes % 60 === 0) return `0 */${minutes / 60} * * *`;
  return "0 9 * * *";
}

function workspaceRunKey(userCtx, flowSource, flowId) {
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

function workspaceCollaborationEventKey(userCtx, flowSource, flowId, archived = false) {
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

function broadcastWorkspaceCollaborationEvent(userCtx, flowSource, flowId, archived, event = {}) {
  const key = workspaceCollaborationEventKey(userCtx, flowSource, flowId, archived);
  const seq = (workspaceCollaborationSequences.get(key) || 0) + 1;
  workspaceCollaborationSequences.set(key, seq);
  const payload = JSON.stringify({
    seq,
    at: new Date().toISOString(),
    ...event,
  });
  const subscribers = workspaceCollaborationSubscribers.get(key);
  if (!subscribers?.size) return seq;
  const chunk = `id: ${seq}\ndata: ${payload}\n\n`;
  for (const clientRes of subscribers) {
    try { clientRes.write(chunk); } catch (_) {}
  }
  return seq;
}

function workspaceRunEntryKey(scopeKey, runId) {
  return `${scopeKey}:${String(runId || "").trim() || runLedgerId("workspace")}`;
}

function workspaceRunControl(abortController) {
  return createWorkspaceRunController({
    abortController,
    gracefulTimeoutMs: 3_000,
    forceTimeoutMs: 1_500,
  });
}

function workspaceRuntimeNodeLabel(graph, nodeId, fallback = "Workspace Run") {
  const id = String(nodeId || "").trim();
  const instance = graph?.instances && typeof graph.instances === "object" ? graph.instances[id] : null;
  const label = String(instance?.label || "").trim();
  return label || id || fallback;
}

function workspaceActiveRunsForScope(scopeKey) {
  const key = String(scopeKey || "");
  return Array.from(activeWorkspaceRuns.entries())
    .filter(([, entry]) => String(entry?.scopeKey || "") === key);
}

function workspaceRunPlanNodeIds(runNodeId, plan) {
  return Array.from(new Set([
    String(runNodeId || "").trim(),
    ...(Array.isArray(plan?.order) ? plan.order : []),
    ...(Array.isArray(plan?.pauseNodeIds) ? plan.pauseNodeIds : []),
  ].map((id) => String(id || "").trim()).filter(Boolean)));
}

function workspaceFindActiveRunConflict(scopeKey, plannedNodeIds) {
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
  return null;
}

function normalizeWorkspaceScheduledRunConfig(raw) {
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

function workspaceScheduleNextRunAt(config, fromDate = new Date()) {
  if (!config?.enabled || !config?.cron) return null;
  return Date.parse(computeNextRunAt(config.cron, config.timezone || "Asia/Shanghai", fromDate));
}

function workspaceSchedulesPath() {
  return path.join(getAgentflowDataRoot(), WORKSPACE_SCHEDULES_FILENAME);
}

function readWorkspaceScheduleRegistry() {
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

function listWorkspaceScheduleStatusesForFlow(userCtx = {}, flowSource = "user", flowId = "") {
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

function listWorkspaceScheduleStatuses(root, userCtx = {}) {
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
      graph = readWorkspaceGraph(scoped.root).graph;
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

function setWorkspaceScheduleEnabled(root, payload = {}, authUser = {}, userCtx = {}) {
  const flowId = String(payload.flowId || "").trim();
  const flowSource = String(payload.flowSource || "user").trim() || "user";
  const scheduleNodeId = String(payload.scheduleNodeId || "").trim();
  if (!flowId) return { success: false, error: "Missing flowId" };
  if (!scheduleNodeId) return { success: false, error: "Missing scheduleNodeId" };
  if (!isValidFlowSourceWrite(flowSource)) return { success: false, error: "Cannot update readonly workspace schedule" };
  const scoped = resolveWorkspaceScopeRoot(root, { flowId, flowSource }, userCtx);
  if (scoped.error) return { success: false, error: scoped.error };
  if (scoped.archived || isReadonlyBuiltinFlowSource(scoped.flowSource)) {
    return { success: false, error: "Cannot update schedule for builtin or archived workspace" };
  }
  const { graph } = readWorkspaceGraph(scoped.root);
  const instance = graph.instances?.[scheduleNodeId];
  if (!instance || String(instance.definitionId || "") !== "workspace_scheduled_run") {
    return { success: false, error: "Workspace schedule node not found" };
  }
  const config = normalizeWorkspaceScheduledRunConfig(instance.body || "");
  const nextConfig = { ...config, enabled: payload.enabled === true };
  graph.instances = { ...(graph.instances || {}) };
  graph.instances[scheduleNodeId] = {
    ...instance,
    body: JSON.stringify(nextConfig),
  };
  fs.writeFileSync(workspaceGraphPath(scoped.root), JSON.stringify(graph, null, 2) + "\n", "utf-8");
  const workspaceSchedules = syncWorkspaceSchedulesForGraph(root, scoped, graph, authUser, userCtx);
  return { success: true, workspaceSchedules };
}

function syncWorkspaceSchedulesForGraph(root, scoped, graph, authUser, userCtx = {}) {
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
  const instances = graph?.instances && typeof graph.instances === "object" ? graph.instances : {};
  for (const [scheduleNodeId, instance] of Object.entries(instances)) {
    if (String(instance?.definitionId || "") !== "workspace_scheduled_run") continue;
    const config = normalizeWorkspaceScheduledRunConfig(instance.body || "");
    const targetRunNodeId = workspaceScheduleInferTargetRunNodeId(graph, scheduleNodeId, config);
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

function updateWorkspaceScheduleEntry(key, patch) {
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

async function runWorkspaceScheduledEntry(root, entry) {
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
  const graphPath = workspaceGraphPath(scoped.root);
  const graph = hydrateWorkspaceGraphForRuntime(root, scoped, readWorkspaceGraph(scoped.root).graph, userCtx);
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
    plan = workspaceRunPlan(graph, targetRunNodeId, scoped.root);
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
  };
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
    const result = await runWorkspaceGraph(root, scoped.root, {
      flowId: entry.flowId,
      flowSource: entry.flowSource || "user",
      runNodeId: targetRunNodeId,
      graph,
    }, userCtx, {
      signal: controller.signal,
      onActiveChild: setActiveChild,
      onEvent: (event) => appendWorkspaceRunLogEvent(runLog.runId, event),
    });
    const currentGraph = readWorkspaceGraph(scoped.root).graph;
    const touchedIds = workspaceRunTouchedNodeIds(result);
    const mergedGraph = mergeWorkspaceRunGraph(currentGraph, result.graph, touchedIds);
    fs.writeFileSync(graphPath, JSON.stringify(mergedGraph, null, 2) + "\n", "utf-8");
    const endedAt = Date.now();
    appendWorkspaceRunFinished({ ...runEntry, endedAt, durationMs: endedAt - runEntry.startedAt }, "success");
    finishWorkspaceRunLogSession(runLog.runId, "success", {
      endedAt,
      durationMs: endedAt - runEntry.startedAt,
      runNodeId: targetRunNodeId,
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

function pollWorkspaceSchedules(root) {
  const now = Date.now();
  const registry = readWorkspaceScheduleRegistry();
  for (const entry of Object.values(registry.schedules || {})) {
    if (!entry || entry.enabled !== true) continue;
    const nextRunAt = Number(entry.nextRunAt || 0);
    if (!Number.isFinite(nextRunAt) || nextRunAt <= 0) {
      const config = {
        enabled: true,
        cron: String(entry.cron || "0 9 * * *"),
        timezone: String(entry.timezone || "Asia/Shanghai"),
      };
      let computedNext = null;
      try {
        computedNext = workspaceScheduleNextRunAt(config, new Date(now));
      } catch (e) {
        updateWorkspaceScheduleEntry(entry.key, {
          nextRunAt: null,
          lastStatus: "invalid",
          lastError: (e && e.message) || String(e),
          lastErrorAt: now,
        });
        continue;
      }
      updateWorkspaceScheduleEntry(entry.key, {
        nextRunAt: computedNext,
        lastStatus: entry.lastStatus || "armed",
      });
      continue;
    }
    if (nextRunAt > now) continue;
    void runWorkspaceScheduledEntry(root, entry);
  }
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
 * @param {boolean} [opts.enableWorkspaceScheduler]
 * @param {string} [opts.staticDir] 默认 PACKAGE_ROOT/builtin/web-ui/dist（npm run build 产出）
 * @returns {Promise<import('http').Server>}
 */
export function startUiServer({
  workspaceRoot,
  port,
  host = "127.0.0.1",
  hideCommunityLinks = false,
  enableWorkspaceScheduler = true,
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

    if (url.pathname === "/api/app-version" && req.method === "GET") {
      res.setHeader("Cache-Control", "no-store, max-age=0");
      json(res, 200, {
        version: UI_SERVER_APP_VERSION,
        startedAt: UI_SERVER_STARTED_AT,
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
    if (req.method === "GET" && url.pathname === "/api/auth/session-token") {
      if (!authUser?.userId) {
        json(res, 401, { error: "Unauthorized" });
        return;
      }
      json(res, 200, { token: getSessionTokenFromRequest(req) || "" });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/prd-workflow/share") {
      const tapdId = String(url.searchParams.get("tapdId") || "").trim();
      const shareToken = String(url.searchParams.get("workflowShare") || "").trim();
      if (shareToken) {
        const record = getPrdWorkflowCollaborationByShareToken(shareToken);
        if (!record || (tapdId && record.tapdId !== tapdId)) {
          json(res, 404, { error: "Workflow share link is invalid or has been revoked" });
          return;
        }
        json(res, 200, {
          ok: true,
          share: prdWorkflowShareLinkSummary(
            record,
            shareToken,
            serverPublicBaseUrl(req, host, uiPort),
            userCtx.userId,
          ),
        });
        return;
      }
      if (!authUser?.userId) {
        json(res, 401, { error: "Unauthorized" });
        return;
      }
      if (!tapdId) {
        json(res, 400, { error: "Missing tapdId" });
        return;
      }
      const record = getPrdWorkflowCollaborationForUser(tapdId, userCtx.userId);
      const role = prdWorkflowCollaborationAccess(record, userCtx.userId).role;
      json(res, 200, {
        ok: true,
        canCreate: !record || role === "owner",
        share: record?.shareToken
          ? prdWorkflowShareLinkSummary(
              record,
              record.shareToken,
              serverPublicBaseUrl(req, host, uiPort),
              userCtx.userId,
            )
          : null,
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/prd-workflow/share") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      if (!authUser?.userId) {
        json(res, 401, { error: "Unauthorized" });
        return;
      }
      const tapdId = String(payload?.tapdId || payload?.tapd_id || "").trim();
      if (!tapdId) {
        json(res, 400, { error: "Missing tapdId" });
        return;
      }
      const existing = getPrdWorkflowCollaborationForUser(tapdId, userCtx.userId);
      if (existing && prdWorkflowCollaborationAccess(existing, userCtx.userId).role !== "owner") {
        json(res, 403, { error: "仅 Workflow 所有者可以创建分享链接" });
        return;
      }
      const result = ensurePrdWorkflowShareLink({ tapdId, userId: userCtx.userId });
      if (result.error) {
        json(res, result.status || 400, { error: result.error });
        return;
      }
      const scope = resolvePrdWorkflowScope(root, { ...payload, tapdId }, userCtx, "write");
      if (!scope.error) prdWorkflowMigrateLegacyState(scope.executionRoot, scope.stateRoot, tapdId);
      json(res, 200, {
        ok: true,
        created: result.created === true,
        share: prdWorkflowShareLinkSummary(
          result.record,
          result.shareToken,
          serverPublicBaseUrl(req, host, uiPort, payload),
          userCtx.userId,
        ),
      });
      return;
    }
    if (req.method === "DELETE" && url.pathname === "/api/prd-workflow/share") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      if (!authUser?.userId) {
        json(res, 401, { error: "Unauthorized" });
        return;
      }
      const tapdId = String(payload?.tapdId || payload?.tapd_id || "").trim();
      if (!tapdId) {
        json(res, 400, { error: "Missing tapdId" });
        return;
      }
      const result = revokePrdWorkflowShareLink({ tapdId, userId: userCtx.userId });
      if (result.error) {
        json(res, result.status || 400, { error: result.error });
        return;
      }
      json(res, 200, { ok: true, revoked: result.revoked === true, share: null });
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/prd-workflow/collaboration") {
      const tapdId = String(url.searchParams.get("tapdId") || "").trim();
      if (!tapdId) {
        json(res, 400, { error: "Missing tapdId" });
        return;
      }
      const record = getPrdWorkflowCollaborationForUser(tapdId, userCtx.userId);
      json(res, 200, {
        ok: true,
        collaboration: prdWorkflowCollaborationSummaryWithUsers(record, userCtx.userId),
      });
      return;
    }
    if (req.method === "POST" && url.pathname === "/api/prd-workflow/collaboration/share") {
      try {
        const payload = JSON.parse(await readBody(req));
        const tapdId = String(payload?.tapdId || payload?.tapd_id || "").trim();
        if (!tapdId) {
          json(res, 400, { error: "Missing tapdId" });
          return;
        }
        const existing = getPrdWorkflowCollaborationForUser(tapdId, userCtx.userId);
        if (existing && prdWorkflowCollaborationAccess(existing, userCtx.userId).role !== "owner") {
          json(res, 403, { error: "仅 Workflow 所有者可以添加成员" });
          return;
        }
        const ensured = ensurePrdWorkflowCollaboration({ tapdId, userId: userCtx.userId });
        if (ensured.error) {
          json(res, ensured.status || 400, { error: ensured.error });
          return;
        }
        const targetUser = findWorkspaceShareUser(payload?.username || payload?.userId);
        if (!targetUser) {
          json(res, 404, { error: "未找到该用户名，请确认对方已经登录或注册 AgentFlow" });
          return;
        }
        if (targetUser.userId === userCtx.userId) {
          json(res, 400, { error: "无需将 Workflow 分享给自己" });
          return;
        }
        const added = addPrdWorkflowCollaborationMember({
          workflowId: ensured.workflow.id,
          userId: userCtx.userId,
          memberUserId: targetUser.userId,
          role: payload?.role,
        });
        if (added.error) {
          json(res, added.status || 400, { error: added.error });
          return;
        }
        const scope = resolvePrdWorkflowScope(root, { ...payload, tapdId }, userCtx, "write");
        if (!scope.error) prdWorkflowMigrateLegacyState(scope.executionRoot, scope.stateRoot, tapdId);
        const record = getPrdWorkflowCollaborationById(ensured.workflow.id);
        prdWorkflowBroadcast(prdWorkflowKey(userCtx, "", "", tapdId), {
          type: "member.added",
          tapdId,
          memberUserId: targetUser.userId,
        });
        json(res, 200, {
          ok: true,
          collaboration: prdWorkflowCollaborationSummaryWithUsers(record, userCtx.userId),
          member: { userId: targetUser.userId, username: targetUser.username, role: "editor" },
        });
      } catch (error) {
        json(res, 400, { error: (error && error.message) || String(error) });
      }
      return;
    }
    if (req.method === "DELETE" && url.pathname === "/api/prd-workflow/collaboration/share") {
      try {
        const payload = JSON.parse(await readBody(req));
        const tapdId = String(payload?.tapdId || payload?.tapd_id || "").trim();
        const record = getPrdWorkflowCollaborationForUser(tapdId, userCtx.userId);
        if (!record) {
          json(res, 404, { error: "PRD Workflow collaboration not found" });
          return;
        }
        const requestedUser = String(payload?.username || payload?.memberUserId || "").trim();
        const targetUser = requestedUser ? findWorkspaceShareUser(requestedUser) : null;
        if (requestedUser && !targetUser) {
          json(res, 404, { error: "未找到该用户" });
          return;
        }
        const removed = removePrdWorkflowCollaborationMember({
          workflowId: record.id,
          userId: userCtx.userId,
          memberUserId: targetUser?.userId || userCtx.userId,
        });
        if (removed.error) {
          json(res, removed.status || 400, { error: removed.error });
          return;
        }
        const nextRecord = getPrdWorkflowCollaborationById(record.id);
        prdWorkflowBroadcast(prdWorkflowKey(userCtx, "", "", tapdId), {
          type: removed.left ? "member.left" : "member.removed",
          tapdId,
          memberUserId: removed.removedUserId || "",
        });
        json(res, 200, {
          ok: true,
          left: removed.left === true,
          removedUserId: removed.removedUserId || "",
          collaboration: removed.left
            ? null
            : prdWorkflowCollaborationSummaryWithUsers(nextRecord, userCtx.userId),
        });
      } catch (error) {
        json(res, 400, { error: (error && error.message) || String(error) });
      }
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/workflows/state") {
      try {
        const workflow = normalizeWorkflowReference({
          workflow: {
            key: url.searchParams.get("workflow") || "",
            namespace: url.searchParams.get("namespace") || "",
            id: url.searchParams.get("id") || "",
          },
        });
        if (workflow.error) {
          json(res, 400, { error: workflow.error });
          return;
        }
        if (workflow.namespace !== "tapd") {
          json(res, 400, { error: `Unsupported workflow namespace: ${workflow.namespace}` });
          return;
        }
        const flowId = String(url.searchParams.get("flowId") || "").trim();
        const flowSource = String(url.searchParams.get("flowSource") || "user").trim() || "user";
        const workflowScope = resolvePrdWorkflowScope(root, {
          tapdId: workflow.id,
          flowId,
          flowSource,
          archived: url.searchParams.get("archived") === "1",
          workspaceId: url.searchParams.get("workspaceId") || "",
          workflowShare: url.searchParams.get("workflowShare") || "",
        }, userCtx);
        if (workflowScope.error) {
          json(res, workflowScope.status || 400, { error: workflowScope.error });
          return;
        }
        const scopedRoot = workflowScope.stateRoot;
        prdWorkflowMigrateLegacyState(workflowScope.executionRoot, scopedRoot, workflow.id);
        const runtimeOnly = url.searchParams.get("runtimeOnly") === "1" ||
          url.searchParams.get("runtime_only") === "1" ||
          url.searchParams.get("cached") === "1";
        const baseSnapshot = runtimeOnly
          ? prdWorkflowMaterializeSnapshot(workflowScope.executionRoot, scopedRoot, workflow.id, userCtx, { flowSource, flowId })
          : await prdWorkflowSnapshot(workflowScope.executionRoot, scopedRoot, workflow.id, userCtx, { flowSource, flowId });
        const snapshot = prdWorkflowWithAgentflowTokenDiagnostic(
          baseSnapshot,
          getSessionTokenFromRequest(req) || "",
        );
        json(res, 200, { ok: true, workflow, snapshot });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/prd-workflow/snapshot") {
      try {
        const tapdId = String(url.searchParams.get("tapdId") || "").trim();
        const flowId = String(url.searchParams.get("flowId") || "").trim();
        const flowSource = String(url.searchParams.get("flowSource") || "user").trim() || "user";
        const archived = url.searchParams.get("archived") === "1";
        const workflowScope = resolvePrdWorkflowScope(root, {
          tapdId,
          flowId,
          flowSource,
          archived,
          workspaceId: url.searchParams.get("workspaceId") || "",
          workflowShare: url.searchParams.get("workflowShare") || "",
        }, userCtx);
        if (workflowScope.error) {
          json(res, workflowScope.status || 400, { error: workflowScope.error });
          return;
        }
        const scopedRoot = workflowScope.stateRoot;
        prdWorkflowMigrateLegacyState(workflowScope.executionRoot, scopedRoot, tapdId);
        const useMock = url.searchParams.get("mock") === "1" || parseBool(process.env.AGENTFLOW_PRD_WORKFLOW_MOCK, false);
        const runtimeOnly = url.searchParams.get("runtimeOnly") === "1" ||
          url.searchParams.get("runtime_only") === "1" ||
          url.searchParams.get("cached") === "1";
        const baseSnapshot = useMock
          ? prdWorkflowMockSnapshot(scopedRoot, tapdId || "mock-prd")
          : runtimeOnly
            ? prdWorkflowMaterializeSnapshot(workflowScope.executionRoot, scopedRoot, tapdId, userCtx, { flowSource, flowId })
            : await prdWorkflowSnapshot(workflowScope.executionRoot, scopedRoot, tapdId, userCtx, { flowSource, flowId });
        const snapshot = prdWorkflowWithAgentflowTokenDiagnostic(
          baseSnapshot,
          getSessionTokenFromRequest(req) || "",
        );
        const workflowShare = workflowScope.collaboration?.shareToken
          ? prdWorkflowShareLinkSummary(
              workflowScope.collaboration,
              workflowScope.collaboration.shareToken,
              serverPublicBaseUrl(req, host, uiPort),
              userCtx.userId,
            )
          : null;
        json(res, 200, {
          ok: true,
          snapshot,
          ...(workflowShare ? { workflowShare, shareUrl: workflowShare.url } : {}),
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/prd-workflow/snapshot") {
      if (!authUser?.userId) {
        json(res, 401, { error: "Authentication required" });
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
        const tapdId = String(payload.tapdId || payload.tapd_id || payload?.snapshot?.tapdId || payload?.snapshot?.tapd_id || payload?.snapshot?.prd?.tapd_id || "").trim();
        if (!tapdId) {
          json(res, 400, { error: "Missing tapdId" });
          return;
        }
        const rawSnapshot = payload.snapshot && typeof payload.snapshot === "object" && !Array.isArray(payload.snapshot)
          ? payload.snapshot
          : payload.prd || payload.next ? payload : null;
        if (!rawSnapshot) {
          json(res, 400, { error: "Missing snapshot" });
          return;
        }
        const existingCollaboration = getPrdWorkflowCollaborationForUser(tapdId, userCtx.userId);
        const existingAccess = prdWorkflowCollaborationAccess(existingCollaboration, userCtx.userId);
        const shareResult = existingCollaboration && existingAccess.role !== "owner"
          ? { record: existingCollaboration, created: false }
          : ensurePrdWorkflowShareLink({ tapdId, userId: userCtx.userId });
        if (shareResult.error) {
          json(res, shareResult.status || 400, { error: shareResult.error });
          return;
        }
        const flowId = String(payload.flowId || "").trim();
        const flowSource = String(payload.flowSource || "user").trim() || "user";
        const archived = payload.archived === true || payload.flowArchived === true;
        const workflowScope = resolvePrdWorkflowScope(root, {
          ...payload,
          tapdId,
          flowId,
          flowSource,
          archived,
        }, userCtx, "write");
        if (workflowScope.error) {
          json(res, workflowScope.status || 400, { error: workflowScope.error });
          return;
        }
        const scopedRoot = workflowScope.stateRoot;
        prdWorkflowMigrateLegacyState(workflowScope.executionRoot, scopedRoot, tapdId);
        const normalizedSnapshot = {
          ...prdWorkflowSnapshotFromParsed(scopedRoot, tapdId, rawSnapshot, userCtx, { flowSource, flowId }),
          clientReportedAt: new Date().toISOString(),
          sources: {
            ...(rawSnapshot.sources && typeof rawSnapshot.sources === "object" ? rawSnapshot.sources : {}),
            executionMode: "client-report",
          },
        };
        const reportMeta = prdWorkflowSnapshotMetaFromReport(payload, rawSnapshot, req, userCtx);
        const reportSource = {
          ...(normalizedSnapshot.sources && typeof normalizedSnapshot.sources === "object" ? normalizedSnapshot.sources : {}),
          executionMode: "client-report",
          truth: "observation",
          authority: "client",
          persistence: "runtime",
          clientId: reportMeta.clientId,
          clientUserId: reportMeta.userId,
          clientReportedAt: reportMeta.reportedAt,
          clientObservedAt: reportMeta.observedAt,
          baseRevision: reportMeta.baseRevision,
          scope: reportMeta.scope,
          platform: reportMeta.platform,
          issueKey: reportMeta.issueKey,
          stageKey: reportMeta.stageKey,
        };
        const storedObservationSnapshot = prdWorkflowStoredObservationSnapshot(normalizedSnapshot, reportSource);
        prdWorkflowWriteClientObservation(scopedRoot, tapdId, reportMeta, storedObservationSnapshot);
        prdWorkflowAppendAudit(scopedRoot, tapdId, {
          type: "client-observation-stored",
          flowSource,
          flowId,
          clientId: reportMeta.clientId,
          userId: reportMeta.userId,
          observedAt: reportMeta.observedAt,
          reportedAt: reportMeta.reportedAt,
          phase: String(storedObservationSnapshot?.phase || ""),
          pointer: String(storedObservationSnapshot?.pointer || ""),
          revision: String(storedObservationSnapshot?.revision || ""),
          actionCount: prdWorkflowSnapshotActionCount(storedObservationSnapshot),
          truth: "observation",
          authority: "client",
          persistence: "runtime",
          note: "ordinary current snapshot stored as client observation; it must not overwrite project state",
        });

        const projectFactSource = reportMeta.scope === "project"
          ? prdWorkflowProjectFactSource(payload, rawSnapshot)
          : null;
        const projectFactSnapshot = projectFactSource
          ? prdWorkflowStoredObservationSnapshot(normalizedSnapshot, {
              ...reportSource,
              ...projectFactSource,
            })
          : null;
        const projectRecord = prdWorkflowReadProjectStateWithFallback(root, scopedRoot, tapdId);
        const projectConflict = projectFactSnapshot
          ? prdWorkflowSnapshotReportConflict(projectRecord, projectFactSnapshot, reportMeta)
          : null;
        if (projectConflict) {
          prdWorkflowAppendRuntimeEvent(scopedRoot, tapdId, {
            id: "stage_project_plan_conflict",
            type: "project-plan-conflict",
            scope: "project",
            stage: reportMeta.stageKey || "project-plan",
            title: "主 Project Plan 冲突",
            detail: projectConflict.message,
            status: "conflict",
            source: "agentflow",
            expectedRevision: projectConflict.expectedRevision || reportMeta.baseRevision || "",
            currentRevision: projectConflict.currentRevision || "",
            incomingRevision: projectConflict.incomingRevision || projectFactSnapshot.revision || "",
            clientId: reportMeta.clientId,
            observedAt: reportMeta.observedAt,
            currentSnapshot: prdWorkflowCompactRuntimeValue(projectRecord?.snapshot || null, 12000),
            incomingSnapshot: prdWorkflowCompactRuntimeValue(projectFactSnapshot, 12000),
          });
          const currentSnapshot = prdWorkflowWithAgentflowTokenDiagnostic(
            prdWorkflowMaterializeSnapshot(workflowScope.executionRoot, scopedRoot, tapdId, userCtx, { flowSource, flowId }),
            getSessionTokenFromRequest(req) || "",
          );
          json(res, 409, {
            ok: false,
            error: projectConflict.message,
            conflict: {
              ...projectConflict,
              tapdId,
              type: "project-plan-conflict",
              currentPhase: String(currentSnapshot?.phase || ""),
              currentPointer: String(currentSnapshot?.pointer || ""),
            },
            snapshot: currentSnapshot,
          });
          return;
        }
        if (projectFactSnapshot) {
          prdWorkflowWriteProjectState(scopedRoot, tapdId, projectFactSnapshot, {
            sources: {
              ...projectFactSource,
              clientId: reportMeta.clientId,
              observedAt: reportMeta.observedAt,
            },
          });
          prdWorkflowAppendAudit(scopedRoot, tapdId, {
            type: "project-fact-stored",
            flowSource,
            flowId,
            clientId: reportMeta.clientId,
            observedAt: reportMeta.observedAt,
            phase: String(projectFactSnapshot?.phase || ""),
            pointer: String(projectFactSnapshot?.pointer || ""),
            revision: String(projectFactSnapshot?.revision || ""),
            actionCount: prdWorkflowSnapshotActionCount(projectFactSnapshot),
            truth: projectFactSource.truth,
            authority: projectFactSource.authority,
            persistence: projectFactSource.persistence,
          });
        }
        const materialized = prdWorkflowMaterializeSnapshot(workflowScope.executionRoot, scopedRoot, tapdId, userCtx, { flowSource, flowId });
        const withDiagnostic = prdWorkflowWithAgentflowTokenDiagnostic(materialized, getSessionTokenFromRequest(req) || "");
        const workflowShare = shareResult.record?.shareToken
          ? prdWorkflowShareLinkSummary(
              shareResult.record,
              shareResult.record.shareToken,
              serverPublicBaseUrl(req, host, uiPort, payload),
              userCtx.userId,
            )
          : null;
        prdWorkflowBroadcast(prdWorkflowKey(userCtx, flowSource, flowId, tapdId), { type: "snapshot-report", tapdId, snapshot: withDiagnostic });
        json(res, 200, {
          ok: true,
          snapshot: withDiagnostic,
          ...(workflowShare ? { workflowShare, shareUrl: workflowShare.url } : {}),
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/prd-workflow/action") {
      if (!authUser?.userId) {
        json(res, 401, { error: "Authentication required" });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      let actionScopedRoot = root;
      let actionExecutionRoot = root;
      let normalizedForCatch = null;
      let actionRunId = "";
      try {
        const flowId = String(payload.flowId || "").trim();
        const flowSource = String(payload.flowSource || "user").trim() || "user";
        const archived = payload.archived === true || payload.flowArchived === true;
        const normalized = normalizePrdWorkflowActionArgs(payload);
        normalizedForCatch = normalized;
        if (normalized.error) {
          json(res, 400, { error: normalized.error });
          return;
        }
        const workflowScope = resolvePrdWorkflowScope(root, {
          ...payload,
          tapdId: normalized.tapdId,
          flowId,
          flowSource,
          archived,
        }, userCtx, "write");
        if (workflowScope.error) {
          json(res, workflowScope.status || 400, { error: workflowScope.error });
          return;
        }
        const scopedRoot = workflowScope.stateRoot;
        actionScopedRoot = scopedRoot;
        actionExecutionRoot = workflowScope.executionRoot;
        prdWorkflowMigrateLegacyState(actionExecutionRoot, scopedRoot, normalized.tapdId);
        const idem = String(normalized.idempotencyKey || "").trim();
        const idemKey = idem ? `${prdWorkflowKey(userCtx, flowSource, flowId, normalized.tapdId)}\t${idem}` : "";
        if (idemKey && prdWorkflowIdempotency.has(idemKey)) {
          json(res, 200, { ok: true, alreadyApplied: true, ...prdWorkflowIdempotency.get(idemKey)?.result });
          return;
        }
        const completedEvent = prdWorkflowFindCompletedIdempotencyEvent(scopedRoot, normalized.tapdId, idem);
        if (completedEvent) {
          const snapshot = prdWorkflowWithAgentflowTokenDiagnostic(
            await prdWorkflowSnapshot(actionExecutionRoot, scopedRoot, normalized.tapdId, userCtx, { flowSource, flowId }),
            getSessionTokenFromRequest(req) || "",
          );
          const result = {
            ok: true,
            alreadyApplied: true,
            action: normalized.action,
            tapdId: normalized.tapdId,
            output: completedEvent.output || null,
            rawOutput: completedEvent.rawOutput || "",
            snapshot,
          };
          if (idemKey) {
            prdWorkflowIdempotency.set(idemKey, { at: Date.now(), result });
            prunePrdWorkflowIdempotency();
          }
          json(res, 200, result);
          return;
        }
        const eventKey = prdWorkflowKey(userCtx, flowSource, flowId, normalized.tapdId);
        if (prdWorkflowActionLocks.has(eventKey)) {
          json(res, 409, { error: "Another workflow action is already running for this TAPD ID" });
          return;
        }
        const startedAtMs = Date.now();
        const startedAt = new Date(startedAtMs).toISOString();
        const issueKey = String(payload?.issueKey || payload?.issue_key || payload?.issue || "").trim();
        const dryRun = payload?.dryRun === true || payload?.dry_run === true;
        const stageKey = String(payload?.stageKey || payload?.stage_key || payload?.stage || payload?.phase || normalized.action || "").trim();
        const actionTitle = String(payload?.title || payload?.label || payload?.actionLabel || payload?.action_label || stageKey || normalized.action).trim();
        actionRunId = `stage_${prdWorkflowSafeStateId([stageKey || normalized.action, issueKey].filter(Boolean).join(":"))}`;
        prdWorkflowActionLocks.set(eventKey, {
          action: normalized.action,
          tapdId: normalized.tapdId,
          title: actionTitle,
          stage: stageKey || normalized.action,
          issueKey,
          startedAt: startedAtMs,
          id: actionRunId,
          userId: String(userCtx?.userId || ""),
        });
        let result;
        try {
          const forceRuntimeMarker = payload?.runtimeOnly === true || payload?.runtime_only === true ||
            payload?.markerOnly === true || payload?.marker_only === true;
          const markerEvent = (!normalized.fromCommand || forceRuntimeMarker)
            ? prdWorkflowMarkerEventSpec(payload, normalized)
            : null;
          if (!dryRun && (markerEvent || normalized.fromCommand)) {
            const expectedRevision = String(payload?.expectedRevision || "").trim();
            if (expectedRevision) {
            const latestForMarker = prdWorkflowWithAgentflowTokenDiagnostic(
              await prdWorkflowSnapshot(actionExecutionRoot, scopedRoot, normalized.tapdId, userCtx, { flowSource, flowId }),
              getSessionTokenFromRequest(req) || "",
            );
              const latestRevision = String(latestForMarker?.revision || "").trim();
              if (latestRevision && latestRevision !== expectedRevision) {
                const err = new Error(`expected revision ${expectedRevision} but current revision is ${latestRevision}`);
                err.latestSnapshot = latestForMarker;
                throw err;
              }
            }
          }
          const startEvent = prdWorkflowAppendRuntimeEvent(scopedRoot, normalized.tapdId, {
            id: actionRunId,
            type: "action-start",
            action: normalized.action,
            stage: markerEvent?.stage || stageKey || normalized.action,
            title: markerEvent?.title || actionTitle,
            detail: dryRun ? "预演中" : "执行中",
            status: "running",
            startedAt,
            dryRun,
            issueKey: markerEvent?.issueKey || issueKey,
            expectedRevision: payload?.expectedRevision || "",
            idempotencyKey: idem,
          });
          prdWorkflowBroadcast(eventKey, startEvent || { type: "action-start", action: normalized.action, tapdId: normalized.tapdId });
          if (markerEvent) {
            const output = {
              runtimeOnly: true,
              kind: markerEvent.kind,
              message: dryRun
                ? "该动作将记录为 Workflow runtime event，不会写 ai-doc marker commit。"
                : "已记录为 Workflow runtime event，未写 ai-doc marker commit。",
              stage: markerEvent.stage,
              issueKey: markerEvent.issueKey || issueKey,
              artifacts: markerEvent.artifacts,
              links: markerEvent.links,
            };
            prdWorkflowAppendRuntimeEvent(scopedRoot, normalized.tapdId, {
              id: actionRunId,
              type: dryRun ? "action-preview" : "action-done",
              source: "agentflow",
              action: normalized.action,
              stage: markerEvent.stage || stageKey || normalized.action,
              title: markerEvent.title || actionTitle,
              detail: markerEvent.detail,
              status: dryRun ? "current" : "done",
              startedAt,
              completedAt: new Date().toISOString(),
              dryRun,
              issueKey: markerEvent.issueKey || issueKey,
              expectedRevision: payload?.expectedRevision || "",
              idempotencyKey: idem,
              output,
              artifacts: markerEvent.artifacts,
              links: markerEvent.links,
            });
            const snapshot = prdWorkflowWithAgentflowTokenDiagnostic(
              await prdWorkflowSnapshot(actionExecutionRoot, scopedRoot, normalized.tapdId, userCtx, { flowSource, flowId }),
              getSessionTokenFromRequest(req) || "",
            );
            result = {
              ok: true,
              runtimeOnly: true,
              action: normalized.action,
              tapdId: normalized.tapdId,
              output,
              rawOutput: "",
              snapshot,
            };
            if (idemKey) {
              prdWorkflowIdempotency.set(idemKey, { at: Date.now(), result });
              prunePrdWorkflowIdempotency();
            }
            prdWorkflowBroadcast(eventKey, { type: "action-done", action: normalized.action, tapdId: normalized.tapdId, snapshot });
            json(res, 200, result);
            return;
          }
          if (normalized.fromCommand && dryRun) {
            const output = {
              preview: true,
              command: normalized.command || `prd-flow ${normalized.args.join(" ")}`,
              message: "预演模式只展示将执行的客户端 prd-flow 命令；确认后会登记 action request，等待客户端 skill 执行并上报结果。",
              args: normalized.args,
            };
            prdWorkflowAppendRuntimeEvent(scopedRoot, normalized.tapdId, {
              id: actionRunId,
              type: "action-preview",
              source: "agentflow",
              action: normalized.action,
              stage: stageKey || normalized.action,
              title: actionTitle,
              detail: output.message,
              status: "current",
              startedAt,
              completedAt: new Date().toISOString(),
              dryRun,
              issueKey,
              expectedRevision: payload?.expectedRevision || "",
              idempotencyKey: idem,
              output,
            });
            const snapshot = prdWorkflowWithAgentflowTokenDiagnostic(
              await prdWorkflowSnapshot(actionExecutionRoot, scopedRoot, normalized.tapdId, userCtx, { flowSource, flowId }),
              getSessionTokenFromRequest(req) || "",
            );
            result = {
              ok: true,
              preview: true,
              action: normalized.action,
              tapdId: normalized.tapdId,
              output,
              rawOutput: "",
              snapshot,
            };
            prdWorkflowBroadcast(eventKey, { type: "action-preview", action: normalized.action, tapdId: normalized.tapdId, snapshot });
            json(res, 200, result);
            return;
          }
          if (normalized.fromCommand && !prdWorkflowAllowServerExec()) {
            const output = {
              clientExecutionRequired: true,
              command: normalized.command || `prd-flow ${normalized.args.join(" ")}`,
              message: "已登记 Workflow action request；服务端不会执行客户端 prd-flow。请客户端 skill 使用 AGENTFLOW_BASE_URL + AGENTFLOW_TOKEN 执行该命令并上报 snapshot/event。",
              args: normalized.args,
            };
            prdWorkflowAppendRuntimeEvent(scopedRoot, normalized.tapdId, {
              id: actionRunId,
              type: "action-request",
              source: "agentflow",
              action: normalized.action,
              stage: stageKey || normalized.action,
              title: actionTitle,
              detail: output.message,
              status: "current",
              startedAt,
              completedAt: new Date().toISOString(),
              dryRun: false,
              issueKey,
              expectedRevision: payload?.expectedRevision || "",
              idempotencyKey: idem,
              output,
              command: output.command,
            });
            const snapshot = prdWorkflowWithAgentflowTokenDiagnostic(
              await prdWorkflowSnapshot(actionExecutionRoot, scopedRoot, normalized.tapdId, userCtx, { flowSource, flowId }),
              getSessionTokenFromRequest(req) || "",
            );
            result = {
              ok: true,
              actionRequested: true,
              action: normalized.action,
              tapdId: normalized.tapdId,
              output,
              rawOutput: "",
              snapshot,
            };
            if (idemKey) {
              prdWorkflowIdempotency.set(idemKey, { at: Date.now(), result });
              prunePrdWorkflowIdempotency();
            }
            prdWorkflowBroadcast(eventKey, { type: "action-request", action: normalized.action, tapdId: normalized.tapdId, snapshot });
            json(res, 200, result);
            return;
          }
          const runtimeEventUrl = `${serverPublicBaseUrl(req, host, uiPort)}/api/prd-workflow/event`;
          const commandResult = await runPrdWorkflowCommand(actionExecutionRoot, scopedRoot, normalized.args, userCtx, {
            timeout: 300000,
            env: {
              PRD_FLOW_RUNTIME_EVENT_URL: runtimeEventUrl,
              PRD_FLOW_RUNTIME_EVENT_TOKEN: getSessionTokenFromRequest(req) || "",
              PRD_FLOW_RUNTIME_TAPD_ID: normalized.tapdId,
              PRD_FLOW_RUNTIME_STAGE_KEY: stageKey || normalized.action,
              PRD_FLOW_RUNTIME_ISSUE_KEY: issueKey,
              PRD_FLOW_RUNTIME_FLOW_ID: flowId,
              PRD_FLOW_RUNTIME_FLOW_SOURCE: flowSource,
              PRD_FLOW_MARKER_POLICY: "runtime-only",
              PRD_FLOW_SUPPRESS_AI_DOC_MARKERS: "1",
            },
          });
          const parsed = prdWorkflowParseJson(commandResult.stdout);
          const rawOutput = parsed ? "" : String(commandResult.stdout || commandResult.stderr || "").slice(0, 12000);
          prdWorkflowAppendRuntimeEvent(scopedRoot, normalized.tapdId, {
            id: actionRunId,
            type: "action-done",
            action: normalized.action,
            stage: stageKey || normalized.action,
            title: actionTitle,
            detail: parsed?.message || parsed?.summary || (dryRun ? "预演完成，等待确认" : "阶段完成"),
            status: dryRun ? "current" : "done",
            startedAt,
            completedAt: new Date().toISOString(),
            dryRun,
            issueKey,
            expectedRevision: payload?.expectedRevision || "",
            idempotencyKey: idem,
            output: parsed || null,
            rawOutput,
            artifacts: Array.isArray(parsed?.artifacts) ? parsed.artifacts : [],
            links: Array.isArray(parsed?.links) ? parsed.links : [],
          });
          const snapshot = prdWorkflowWithAgentflowTokenDiagnostic(
            await prdWorkflowSnapshot(actionExecutionRoot, scopedRoot, normalized.tapdId, userCtx, { flowSource, flowId }),
            getSessionTokenFromRequest(req) || "",
          );
          result = {
            ok: true,
            action: normalized.action,
            tapdId: normalized.tapdId,
            output: parsed || null,
            rawOutput,
            snapshot,
          };
          if (idemKey) {
            prdWorkflowIdempotency.set(idemKey, { at: Date.now(), result });
            prunePrdWorkflowIdempotency();
          }
          prdWorkflowBroadcast(eventKey, { type: "action-done", action: normalized.action, tapdId: normalized.tapdId, snapshot });
        } finally {
          prdWorkflowActionLocks.delete(eventKey);
        }
        json(res, 200, result);
      } catch (e) {
        const status = /expected revision|stale|conflict|not allow|precondition/i.test(String(e?.message || e)) ? 409 : 500;
        const tapdId = String(normalizedForCatch?.tapdId || payload?.tapdId || payload?.tapd_id || "").trim();
        const flowId = String(payload?.flowId || "").trim();
        const flowSource = String(payload?.flowSource || "user").trim() || "user";
        const errorText = (e && e.message) || String(e);
        if (tapdId) {
          const issueKey = String(payload?.issueKey || payload?.issue_key || payload?.issue || "").trim();
          const stageKey = String(payload?.stageKey || payload?.stage_key || payload?.stage || payload?.phase || normalizedForCatch?.action || payload?.action || payload?.actionId || "").trim();
          prdWorkflowAppendRuntimeEvent(actionScopedRoot, tapdId, {
            id: actionRunId || `stage_${prdWorkflowSafeStateId([stageKey || payload?.action || payload?.actionId || "workflow-action", issueKey].filter(Boolean).join(":"))}`,
            type: status === 409 ? "action-conflict" : "action-error",
            action: String(normalizedForCatch?.action || payload?.action || payload?.actionId || ""),
            stage: stageKey || String(normalizedForCatch?.action || payload?.action || payload?.actionId || ""),
            title: String(payload?.title || payload?.label || normalizedForCatch?.action || payload?.action || payload?.actionId || "workflow action"),
            detail: errorText,
            status: status === 409 ? "conflict" : "error",
            completedAt: new Date().toISOString(),
            dryRun: payload?.dryRun === true || payload?.dry_run === true,
            issueKey,
            expectedRevision: payload?.expectedRevision || "",
            idempotencyKey: payload?.idempotencyKey || "",
            error: errorText,
            rawOutput: `${String(e?.stdout || "")}${String(e?.stderr || "")}`.slice(0, 12000),
          });
        }
        prdWorkflowBroadcast(prdWorkflowKey(userCtx, flowSource, flowId, tapdId), {
          type: "action-error",
          action: String(payload?.action || payload?.actionId || ""),
          tapdId,
          error: errorText,
        });
        let latestSnapshot = null;
        if (status === 409 && tapdId) {
          try {
            latestSnapshot = prdWorkflowWithAgentflowTokenDiagnostic(
              await prdWorkflowSnapshot(actionExecutionRoot, actionScopedRoot, tapdId, userCtx, { flowSource, flowId }),
              getSessionTokenFromRequest(req) || "",
            );
          } catch (_) {}
        }
        const conflict = status === 409 ? {
          action: String(normalizedForCatch?.action || payload?.action || payload?.actionId || ""),
          tapdId,
          expectedRevision: String(payload?.expectedRevision || ""),
          currentRevision: String(latestSnapshot?.revision || ""),
          currentPhase: String(latestSnapshot?.phase || ""),
          currentPointer: String(latestSnapshot?.pointer || ""),
          message: errorText,
        } : null;
        json(res, status, {
          error: errorText,
          rawOutput: `${String(e?.stdout || "")}${String(e?.stderr || "")}`.slice(0, 12000),
          snapshot: latestSnapshot,
          conflict,
        });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/prd-workflow/idempotency") {
      try {
        const tapdId = String(url.searchParams.get("tapdId") || url.searchParams.get("tapd_id") || "").trim();
        const idempotencyKey = String(url.searchParams.get("key") || url.searchParams.get("idempotencyKey") || "").trim();
        if (!tapdId) {
          json(res, 400, { error: "Missing tapdId" });
          return;
        }
        if (!idempotencyKey) {
          json(res, 400, { error: "Missing idempotency key" });
          return;
        }
        const flowId = String(url.searchParams.get("flowId") || "").trim();
        const flowSource = String(url.searchParams.get("flowSource") || "user").trim() || "user";
        const archived = url.searchParams.get("archived") === "1";
        const workflowScope = resolvePrdWorkflowScope(root, {
          tapdId,
          flowId,
          flowSource,
          archived,
          workspaceId: url.searchParams.get("workspaceId") || "",
        }, userCtx);
        if (workflowScope.error) {
          json(res, workflowScope.status || 400, { error: workflowScope.error });
          return;
        }
        const scopedRoot = workflowScope.stateRoot;
        prdWorkflowMigrateLegacyState(workflowScope.executionRoot, scopedRoot, tapdId);
        const event = prdWorkflowFindCompletedIdempotencyEvent(scopedRoot, tapdId, idempotencyKey);
        json(res, 200, {
          ok: true,
          found: !!event,
          result: event?.output || event?.result || null,
          rawOutput: event?.rawOutput || "",
          event: event || null,
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/prd-workflow/idempotency") {
      if (!authUser?.userId) {
        json(res, 401, { error: "Authentication required" });
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
        const tapdId = String(payload.tapdId || payload.tapd_id || "").trim();
        const idempotencyKey = String(payload.key || payload.idempotencyKey || payload.idempotency_key || "").trim();
        if (!tapdId) {
          json(res, 400, { error: "Missing tapdId" });
          return;
        }
        if (!idempotencyKey) {
          json(res, 400, { error: "Missing idempotency key" });
          return;
        }
        const flowId = String(payload.flowId || "").trim();
        const flowSource = String(payload.flowSource || "user").trim() || "user";
        const archived = payload.archived === true || payload.flowArchived === true;
        const workflowScope = resolvePrdWorkflowScope(root, {
          ...payload,
          tapdId,
          flowId,
          flowSource,
          archived,
        }, userCtx, "write");
        if (workflowScope.error) {
          json(res, workflowScope.status || 400, { error: workflowScope.error });
          return;
        }
        const scopedRoot = workflowScope.stateRoot;
        prdWorkflowMigrateLegacyState(workflowScope.executionRoot, scopedRoot, tapdId);
        const existing = prdWorkflowFindCompletedIdempotencyEvent(scopedRoot, tapdId, idempotencyKey);
        if (existing) {
          json(res, 200, { ok: true, found: true, event: existing, result: existing.output || existing.result || null });
          return;
        }
        const command = String(payload.command || "").slice(0, 1000);
        const result = payload.result && typeof payload.result === "object" && !Array.isArray(payload.result)
          ? payload.result
          : { message: String(payload.message || "already completed") };
        const event = prdWorkflowAppendRuntimeEvent(scopedRoot, tapdId, {
          type: "idempotent-command-completed",
          source: "prd-flow-client",
          auxiliary: true,
          aggregateByStage: false,
          conflictOnArtifact: false,
          action: payload.action || "",
          stage: payload.stage || payload.stageKey || payload.stage_key || "idempotency",
          title: payload.title || "prd-flow command completed",
          detail: command ? `Command completed: ${command}` : "Command completed",
          status: "done",
          completedAt: new Date().toISOString(),
          idempotencyKey,
          command,
          output: result,
          result,
        });
        json(res, 200, { ok: true, found: true, event, result });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workflows/report") {
      if (!authUser?.userId) {
        json(res, 401, { error: "Authentication required" });
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
        const report = normalizeWorkflowReport(payload);
        if (report.error) {
          json(res, 400, { error: report.error });
          return;
        }
        if (report.workflow.namespace !== "tapd") {
          json(res, 400, { error: `Unsupported workflow namespace: ${report.workflow.namespace}` });
          return;
        }
        const tapdId = report.workflow.id;
        const flowId = report.flowId;
        const flowSource = report.flowSource || "user";
        const archived = payload.archived === true || payload.flowArchived === true;
        const workflowScope = resolvePrdWorkflowScope(root, {
          ...payload,
          tapdId,
          flowId,
          flowSource,
          archived,
        }, userCtx, "write");
        if (workflowScope.error) {
          json(res, workflowScope.status || 400, { error: workflowScope.error });
          return;
        }
        const scopedRoot = workflowScope.stateRoot;
        prdWorkflowMigrateLegacyState(workflowScope.executionRoot, scopedRoot, tapdId);
        const currentSnapshot = prdWorkflowMaterializeSnapshot(
          workflowScope.executionRoot,
          scopedRoot,
          tapdId,
          userCtx,
          { flowSource, flowId },
        );
        const acceptedRevisions = new Set([
          String(currentSnapshot.runtimeRevision || "").trim(),
          String(currentSnapshot.revision || "").trim(),
        ].filter(Boolean));
        if (report.expectedRevision && acceptedRevisions.size && !acceptedRevisions.has(report.expectedRevision)) {
          json(res, 409, {
            error: "Workflow state changed; refresh before reporting",
            conflict: {
              type: "workflow-revision-conflict",
              expectedRevision: report.expectedRevision,
              currentRevision: currentSnapshot.runtimeRevision || currentSnapshot.revision || "",
              workflow: report.workflow,
            },
            snapshot: currentSnapshot,
          });
          return;
        }
        if (report.idempotencyKey) {
          const existing = prdWorkflowFindCompletedIdempotencyEvent(scopedRoot, tapdId, report.idempotencyKey);
          if (existing) {
            json(res, 200, {
              ok: true,
              alreadyApplied: true,
              report,
              event: existing,
              snapshot: currentSnapshot,
            });
            return;
          }
        }
        const event = prdWorkflowAppendRuntimeEvent(scopedRoot, tapdId, {
          ...report.event,
          tapdId,
          actor: {
            userId: String(userCtx.userId || ""),
            username: String(authUser.username || userCtx.userId || ""),
          },
        });
        if (!event) throw new Error("Failed to store workflow report");
        const snapshot = prdWorkflowWithAgentflowTokenDiagnostic(
          prdWorkflowMaterializeSnapshot(
            workflowScope.executionRoot,
            scopedRoot,
            tapdId,
            userCtx,
            { flowSource, flowId },
          ),
          getSessionTokenFromRequest(req) || "",
        );
        prdWorkflowBroadcast(
          prdWorkflowKey(userCtx, flowSource, flowId, tapdId),
          { type: "workflow-report", tapdId, workflow: report.workflow, event, snapshot },
        );
        json(res, 200, { ok: true, report, event, snapshot });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/prd-workflow/event") {
      if (!authUser?.userId) {
        json(res, 401, { error: "Authentication required" });
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
        const tapdId = String(payload.tapdId || payload.tapd_id || "").trim();
        if (!tapdId) {
          json(res, 400, { error: "Missing tapdId" });
          return;
        }
        const flowId = String(payload.flowId || "").trim();
        const flowSource = String(payload.flowSource || "user").trim() || "user";
        const archived = payload.archived === true || payload.flowArchived === true;
        const workflowScope = resolvePrdWorkflowScope(root, {
          ...payload,
          tapdId,
          flowId,
          flowSource,
          archived,
        }, userCtx, "write");
        if (workflowScope.error) {
          json(res, workflowScope.status || 400, { error: workflowScope.error });
          return;
        }
        const scopedRoot = workflowScope.stateRoot;
        prdWorkflowMigrateLegacyState(workflowScope.executionRoot, scopedRoot, tapdId);
        const eventPayload = payload.event && typeof payload.event === "object" && !Array.isArray(payload.event)
          ? payload.event
          : payload;
        const event = prdWorkflowAppendRuntimeEvent(scopedRoot, tapdId, {
          ...eventPayload,
          tapdId,
          type: eventPayload.type || "workflow-event",
          actor: {
            userId: String(userCtx?.userId || ""),
            username: String(authUser?.username || userCtx?.userId || ""),
          },
        });
        const snapshot = prdWorkflowWithAgentflowTokenDiagnostic(
          prdWorkflowMaterializeSnapshot(workflowScope.executionRoot, scopedRoot, tapdId, userCtx, { flowSource, flowId }),
          getSessionTokenFromRequest(req) || "",
        );
        prdWorkflowBroadcast(prdWorkflowKey(userCtx, flowSource, flowId, tapdId), { type: "runtime-event", tapdId, event, snapshot });
        json(res, 200, { ok: true, event, snapshot });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/prd-workflow/review-link") {
      if (!authUser?.userId) {
        json(res, 401, { error: "Authentication required" });
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
        const tapdId = String(payload.tapdId || payload.tapd_id || "").trim();
        if (!tapdId) {
          json(res, 400, { error: "Missing tapdId" });
          return;
        }
        const flowId = String(payload.flowId || "").trim();
        const flowSource = String(payload.flowSource || "user").trim() || "user";
        const archived = payload.archived === true || payload.flowArchived === true;
        const workflowScope = resolvePrdWorkflowScope(root, {
          ...payload,
          tapdId,
          flowId,
          flowSource,
          archived,
        }, userCtx, "write");
        if (workflowScope.error) {
          json(res, workflowScope.status || 400, { error: workflowScope.error });
          return;
        }
        const scopedRoot = workflowScope.stateRoot;
        prdWorkflowMigrateLegacyState(workflowScope.executionRoot, scopedRoot, tapdId);
        const review = prdWorkflowCreateReview(
          scopedRoot,
          tapdId,
          payload,
          serverPublicBaseUrl(req, host, uiPort, payload),
          workflowScope.ownerId,
        );
        const query = new URLSearchParams();
        if (flowId) query.set("flowId", flowId);
        if (flowId && flowSource && flowSource !== "user") query.set("flowSource", flowSource);
        if (archived) query.set("archived", "1");
        const reviewUrl = query.toString() ? `${review.url}?${query.toString()}` : review.url;
        let shortLink = null;
        try {
          shortLink = prdWorkflowCreateReviewShortLink(root, reviewUrl, review);
        } catch (e) {
          log.debug(`[prd-workflow] review short link failed: ${(e && e.message) || String(e)}`);
        }
        const shortUrl = shortLink?.shortUrl || "";
        const displayUrl = shortUrl || reviewUrl;
        const durability = review.durability || "temporary";
        const reviewSource = review.source && typeof review.source === "object" && !Array.isArray(review.source)
          ? review.source
          : { kind: durability === "durable" ? "ai-doc" : "local-draft", durability };
        const artifact = {
          label: payload.artifactLabel || "Markdown Review",
          kind: durability === "temporary" ? "temporary-review" : "review",
          persistence: "runtime",
          durability,
          source: reviewSource,
          confirmed: payload.confirmed === true || payload.confirmed === "1",
          url: displayUrl,
          canonicalUrl: reviewUrl,
          shortUrl,
          expiresAt: review.expiresAt || "",
        };
        const event = prdWorkflowAppendRuntimeEvent(scopedRoot, tapdId, {
          type: "review-link",
          auxiliary: true,
          conflictOnArtifact: false,
          truth: "runtime_event",
          persistence: "runtime",
          action: payload.action || payload.actionId || "",
          stage: payload.stage || payload.stageKey || payload.stage_key || "review",
          title: payload.title || "临时 Markdown Review",
          detail: "已生成临时 Markdown review 链接",
          status: "current",
          issueKey: payload.issueKey || payload.issue_key || "",
          durability,
          sourceArtifact: reviewSource,
          expiresAt: review.expiresAt || "",
          artifacts: [artifact],
          links: [{
            label: "Markdown Review",
            url: displayUrl,
            canonicalUrl: reviewUrl,
            shortUrl,
            persistence: "runtime",
            durability,
            source: reviewSource,
            expiresAt: review.expiresAt || "",
          }],
          reviewId: review.id,
          reviewShortCode: shortLink?.shortCode || "",
        });
        const snapshot = prdWorkflowWithAgentflowTokenDiagnostic(
          await prdWorkflowSnapshot(workflowScope.executionRoot, scopedRoot, tapdId, userCtx, { flowSource, flowId }),
          getSessionTokenFromRequest(req) || "",
        );
        prdWorkflowBroadcast(prdWorkflowKey(userCtx, flowSource, flowId, tapdId), { type: "review-link", tapdId, event, snapshot });
        json(res, 200, {
          ok: true,
          review: {
            ...review,
            url: reviewUrl,
            shortUrl,
            shortCode: shortLink?.shortCode || "",
          },
          event,
          snapshot,
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/prd-workflow/events") {
      const tapdId = String(url.searchParams.get("tapdId") || "").trim();
      const flowId = String(url.searchParams.get("flowId") || "").trim();
      const flowSource = String(url.searchParams.get("flowSource") || "user").trim() || "user";
      const workflowShare = String(url.searchParams.get("workflowShare") || "").trim();
      const workflowScope = resolvePrdWorkflowScope(root, {
        tapdId,
        flowId,
        flowSource,
        workflowShare,
      }, userCtx);
      if (workflowScope.error) {
        json(res, workflowScope.status || 400, { error: workflowScope.error });
        return;
      }
      const key = prdWorkflowKey(userCtx, flowSource, flowId, tapdId, workflowShare);
      let set = prdWorkflowSubscribers.get(key);
      if (!set) {
        set = new Set();
        prdWorkflowSubscribers.set(key, set);
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
          if (set.size === 0) prdWorkflowSubscribers.delete(key);
        } catch (_) {}
      };
      req.on("close", detach);
      res.on("close", detach);
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/r/")) {
      try {
        const parts = url.pathname.split("/").filter(Boolean);
        const shortCode = decodeURIComponent(parts[1] || "");
        if (parts.length !== 2) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        const link = prdWorkflowReadReviewShortLink(root, shortCode);
        if (!link) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        const expiresMs = Date.parse(link.expiresAt || "");
        if (Number.isFinite(expiresMs) && expiresMs < Date.now()) {
          try { fs.unlinkSync(link.filePath); } catch (_) {}
          res.writeHead(410, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Review link expired");
          return;
        }
        res.writeHead(302, {
          Location: link.targetPath,
          "Cache-Control": "no-store",
          "Referrer-Policy": "no-referrer",
        });
        res.end();
      } catch {
        res.writeHead(404);
        res.end("Not found");
      }
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/prd-workflow/review/")) {
      try {
        const parts = url.pathname.split("/").filter(Boolean);
        const tapdId = decodeURIComponent(parts[3] || "");
        const reviewId = decodeURIComponent(parts[4] || "");
        if (!tapdId || !reviewId) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        const flowId = String(url.searchParams.get("flowId") || "").trim();
        const flowSource = String(url.searchParams.get("flowSource") || "user").trim() || "user";
        const archived = url.searchParams.get("archived") === "1";
        const workflowScope = resolvePrdWorkflowScope(root, {
          tapdId,
          flowId,
          flowSource,
          archived,
          workspaceId: url.searchParams.get("workspaceId") || "",
          workflowShare: url.searchParams.get("workflowShare") || "",
        }, userCtx);
        if (workflowScope.error) {
          res.writeHead(workflowScope.status || 400, { "Content-Type": "text/plain; charset=utf-8" });
          res.end(workflowScope.error);
          return;
        }
        const scopedRoot = workflowScope.stateRoot;
        prdWorkflowMigrateLegacyState(workflowScope.executionRoot, scopedRoot, tapdId);
        const paths = prdWorkflowResolveReviewPaths(scopedRoot, tapdId, reviewId);
        if (!prdWorkflowReviewFileExists(paths)) {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        const markdown = fs.readFileSync(paths.markdownPath, "utf-8");
        let meta = {};
        try {
          if (fs.existsSync(paths.metaPath)) meta = JSON.parse(fs.readFileSync(paths.metaPath, "utf-8"));
        } catch (_) {}
        const expiresMs = Date.parse(meta?.expiresAt || "");
        if (Number.isFinite(expiresMs) && expiresMs < Date.now()) {
          res.writeHead(410, { "Content-Type": "text/plain; charset=utf-8" });
          res.end("Review link expired");
          return;
        }
        const rawParams = new URLSearchParams(url.searchParams);
        rawParams.set("raw", "1");
        meta = { ...(meta && typeof meta === "object" && !Array.isArray(meta) ? meta : {}), rawHref: `${url.pathname}?${rawParams.toString()}` };
        if (url.searchParams.get("raw") === "1") {
          const data = Buffer.from(markdown, "utf-8");
          res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Content-Length": data.length });
          res.end(data);
          return;
        }
        const html = Buffer.from(prdWorkflowReviewHtml(meta.title || "PRD Workflow Review", markdown, meta), "utf-8");
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Length": html.length });
        res.end(html);
      } catch (e) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end((e && e.message) || String(e));
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/display/shares") {
      try {
        if (!authUser?.userId) {
          json(res, 401, { error: "Unauthorized" });
          return;
        }
        json(res, 200, {
          shares: listDisplaySharesForUser(userCtx, requestPublicBaseUrl(req)),
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

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

    if (req.method === "PATCH" && url.pathname === "/api/display/share") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      try {
        if (!authUser?.userId) {
          json(res, 401, { error: "Unauthorized" });
          return;
        }
        const id = String(payload?.id || url.searchParams.get("id") || "").trim();
        if (!id) {
          json(res, 400, { error: "Missing display share id" });
          return;
        }
        const result = updateDisplayShareExpiryForUser(id, userCtx, payload);
        if (result.error) {
          json(res, result.status || 400, { error: result.error });
          return;
        }
        json(res, 200, {
          ok: true,
          share: displayShareSummary(result.share, requestPublicBaseUrl(req)),
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "DELETE" && url.pathname === "/api/display/share") {
      try {
        if (!authUser?.userId) {
          json(res, 401, { error: "Unauthorized" });
          return;
        }
        const id = String(url.searchParams.get("id") || "").trim();
        if (!id) {
          json(res, 400, { error: "Missing display share id" });
          return;
        }
        const result = deleteDisplayShareForUser(id, userCtx);
        if (result.error) {
          json(res, result.status || 400, { error: result.error });
          return;
        }
        json(res, 200, { ok: true });
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

    if (url.pathname === "/api/admin/storage-config") {
      if (!authUser?.isAdmin) {
        json(res, 403, { error: "Admin permission required" });
        return;
      }
      if (req.method === "GET") {
        json(res, 200, { config: readAdminStorageConfig() });
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
          const config = writeAdminStorageConfig(payload?.config || payload || {});
          clearSkillRegistryCache();
          json(res, 200, { ok: true, config });
        } catch (e) {
          json(res, 400, { error: (e && e.message) || String(e) });
        }
        return;
      }
    }

    if (req.method === "GET" && url.pathname === "/api/admin/usage-dashboard") {
      if (!authUser?.isAdmin) {
        json(res, 403, { error: "Admin permission required" });
        return;
      }
      try {
        json(res, 200, buildAdminUsageDashboard(root));
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/admin/run-detail") {
      if (!authUser?.isAdmin) {
        json(res, 403, { error: "Admin permission required" });
        return;
      }
      const input = {
        runType: url.searchParams.get("runType") || "pipeline",
        userId: url.searchParams.get("userId") || "",
        flowId: url.searchParams.get("flowId") || "",
        flowSource: url.searchParams.get("flowSource") || "user",
        runId: url.searchParams.get("runId") || "",
      };
      if (!input.userId || !input.flowId || !input.runId) {
        json(res, 400, { error: "Missing userId, flowId or runId" });
        return;
      }
      try {
        const detail = readAdminRunDetail(root, input);
        if (!detail) {
          json(res, 404, { error: "Run detail not found" });
          return;
        }
        json(res, 200, detail);
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
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
          const flows = listFlowsJson(root, { ...userCtx, includeWorkspaceFlows: true })
            .filter((flow) => (
              !workspaceFlowCollaborationGuard(
                flow.id,
                flow.source || "user",
                flow.archived === true,
                userCtx,
                "read",
              )
            ))
            .map((flow) => {
              const source = flow.source || "user";
              const collaboration = source === "workspace"
                ? getWorkspaceCollaborationByFlow(flow.id, flow.archived === true)
                : getWorkspaceCollaborationForProject({
                  flowId: flow.id,
                  flowSource: source,
                  archived: flow.archived === true,
                  ownerId: userCtx.userId,
                });
              return collaboration
                ? { ...flow, collaboration: workspaceCollaborationSummaryWithUsers(collaboration, userCtx.userId) }
                : flow;
            });
          const existingCollaborationIds = new Set(flows.map((flow) => flow.collaboration?.id).filter(Boolean));
          for (const record of listWorkspaceCollaborationsForUser(userCtx.userId)) {
            const source = record.projectSource || record.flowSource || "workspace";
            if (source !== "user" || record.ownerId === userCtx.userId) continue;
            if (existingCollaborationIds.has(record.id)) continue;
            const ownerFlow = listFlowsJson(root, { userId: record.ownerId })
              .find((flow) => (
                flow.id === record.flowId
                && (flow.source || "user") === "user"
                && Boolean(flow.archived) === Boolean(record.archived)
              ));
            if (!ownerFlow) continue;
            flows.push({
              ...ownerFlow,
              collaboration: workspaceCollaborationSummaryWithUsers(record, userCtx.userId),
            });
            existingCollaborationIds.add(record.id);
          }
          json(res, 200, flows);
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
        if (targetSpace === "workspace") {
          ensureWorkspaceCollaboration({ flowId, userId: userCtx.userId });
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
      if (targetSpace === "workspace") {
        ensureWorkspaceCollaboration({ flowId, userId: userCtx.userId });
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

    if (req.method === "POST" && url.pathname === "/api/workspace/collaboration/accept") {
      try {
        const payload = JSON.parse(await readBody(req));
        const accepted = acceptWorkspaceCollaborationInvite({
          token: payload?.token,
          userId: userCtx.userId,
        });
        if (accepted.error) {
          json(res, accepted.status || 400, { error: accepted.error });
          return;
        }
        json(res, 200, { ok: true, workspace: accepted.workspace });
      } catch (e) {
        json(res, 400, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspace/collaboration/share") {
      try {
        const payload = JSON.parse(await readBody(req));
        const flowId = String(payload?.flowId || "").trim();
        const flowSource = String(payload?.flowSource || "user").trim();
        const archived = payload?.archived === true || payload?.flowArchived === true;
        if (flowSource !== "workspace" && flowSource !== "user") {
          json(res, 400, { error: "当前 Project 不支持协作分享" });
          return;
        }
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId,
          flowSource,
          workspaceId: payload.workspaceId || "",
          archived,
        }, userCtx);
        if (scoped.error) {
          json(res, scoped.status || 400, { error: scoped.error });
          return;
        }
        const ensured = ensureWorkspaceCollaboration({
          flowId,
          flowSource,
          archived,
          userId: userCtx.userId,
        });
        if (ensured.error) {
          json(res, ensured.status || 400, { error: ensured.error });
          return;
        }
        const targetUser = findWorkspaceShareUser(payload?.username || payload?.userId);
        if (!targetUser) {
          json(res, 404, { error: "未找到该用户名，请确认对方已经登录或注册 AgentFlow" });
          return;
        }
        const added = addWorkspaceCollaborationMember({
          workspaceId: ensured.workspace.id,
          userId: userCtx.userId,
          memberUserId: targetUser.userId,
          role: payload?.role,
        });
        if (added.error) {
          json(res, added.status || 400, { error: added.error });
          return;
        }
        const record = getWorkspaceCollaborationForProject({ workspaceId: ensured.workspace.id });
        broadcastWorkspaceCollaborationEvent(userCtx, flowSource, flowId, archived, {
          type: "member.added",
          actorId: userCtx.userId || "",
          memberUserId: targetUser.userId,
        });
        json(res, 200, {
          ok: true,
          workspace: workspaceCollaborationSummaryWithUsers(record, userCtx.userId),
          member: { userId: targetUser.userId, username: targetUser.username, role: "editor" },
        });
      } catch (e) {
        json(res, 400, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "DELETE" && url.pathname === "/api/workspace/collaboration/share") {
      try {
        const payload = JSON.parse(await readBody(req));
        const flowId = String(payload?.flowId || "").trim();
        const flowSource = String(payload?.flowSource || "user").trim();
        const archived = payload?.archived === true || payload?.flowArchived === true;
        if (!flowId || (flowSource !== "workspace" && flowSource !== "user")) {
          json(res, 400, { error: "Missing shared project" });
          return;
        }
        const record = getWorkspaceCollaborationForProject({
          workspaceId: payload.workspaceId || "",
          flowId,
          flowSource,
          archived,
          ownerId: userCtx.userId,
        }) || listWorkspaceCollaborationsForUser(userCtx.userId).find((item) => (
          item.flowId === flowId
          && (item.projectSource || item.flowSource || "workspace") === flowSource
          && item.archived === archived
        ));
        if (!record) {
          json(res, 404, { error: "Workspace collaboration not found" });
          return;
        }
        const requestedUser = String(payload?.username || payload?.memberUserId || "").trim();
        const targetUser = requestedUser ? findWorkspaceShareUser(requestedUser) : null;
        if (requestedUser && !targetUser) {
          json(res, 404, { error: "未找到该用户" });
          return;
        }
        const removed = removeWorkspaceCollaborationMember({
          workspaceId: record.id,
          userId: userCtx.userId,
          memberUserId: targetUser?.userId || userCtx.userId,
        });
        if (removed.error) {
          json(res, removed.status || 400, { error: removed.error });
          return;
        }
        broadcastWorkspaceCollaborationEvent(userCtx, flowSource, flowId, archived, {
          type: removed.left ? "member.left" : "member.removed",
          actorId: userCtx.userId || "",
          memberUserId: removed.removedUserId || "",
        });
        const nextRecord = getWorkspaceCollaborationForProject({ workspaceId: record.id });
        json(res, 200, {
          ok: true,
          left: removed.left === true,
          removedUserId: removed.removedUserId || "",
          workspace: removed.left ? null : workspaceCollaborationSummaryWithUsers(nextRecord, userCtx.userId),
        });
      } catch (e) {
        json(res, 400, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/workspace/events") {
      const scoped = resolveWorkspaceScopeRoot(root, {
        flowId: url.searchParams.get("flowId") || "",
        flowSource: url.searchParams.get("flowSource") || "user",
        workspaceId: url.searchParams.get("workspaceId") || "",
        archived: url.searchParams.get("archived") === "1",
      }, userCtx);
      if (scoped.error) {
        json(res, scoped.status || 400, { error: scoped.error });
        return;
      }
      const key = workspaceCollaborationEventKey(userCtx, scoped.flowSource, scoped.flowId, scoped.archived);
      let subscribers = workspaceCollaborationSubscribers.get(key);
      if (!subscribers) {
        subscribers = new Set();
        workspaceCollaborationSubscribers.set(key, subscribers);
      }
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`event: connected\ndata: ${JSON.stringify({ seq: workspaceCollaborationSequences.get(key) || 0 })}\n\n`);
      subscribers.add(res);
      const heartbeat = setInterval(() => {
        try { res.write(`: heartbeat ${Date.now()}\n\n`); } catch (_) {}
      }, 15_000);
      const detach = () => {
        clearInterval(heartbeat);
        subscribers.delete(res);
        if (subscribers.size === 0) workspaceCollaborationSubscribers.delete(key);
      };
      req.on("close", detach);
      res.on("close", detach);
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/workspace/files") {
      try {
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: url.searchParams.get("flowId") || "",
          flowSource: url.searchParams.get("flowSource") || "user",
          workspaceId: url.searchParams.get("workspaceId") || "",
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

    if (req.method === "GET" && url.pathname === "/api/workspaces") {
      try {
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: url.searchParams.get("flowId") || "",
          flowSource: url.searchParams.get("flowSource") || "user",
          workspaceId: url.searchParams.get("workspaceId") || "",
          archived: url.searchParams.get("archived") === "1",
        }, userCtx);
        const scopedRoot = scoped.error ? root : scoped.root;
        json(res, 200, {
          path: workspacesPath(),
          workspaces: listConfiguredWorkspaces(root, scopedRoot, userCtx),
          customWorkspaces: readUserWorkspaces(userCtx),
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspaces") {
      try {
        const payload = JSON.parse(await readBody(req));
        const customWorkspaces = writeUserWorkspaces(userCtx, payload?.workspaces || payload?.customWorkspaces || []);
        json(res, 200, {
          path: workspacesPath(),
          workspaces: listConfiguredWorkspaces(root, root, userCtx),
          customWorkspaces,
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspaces/sync") {
      try {
        const payload = JSON.parse(await readBody(req));
        const id = String(payload?.id || "").trim();
        const workspaces = readUserWorkspaces(userCtx);
        const workspace = workspaces.find((entry) => String(entry.id || "") === id);
        if (!workspace) {
          json(res, 404, { error: "工作区不存在" });
          return;
        }
        const result = syncGitWorkspace(workspace, userCtx);
        json(res, 200, {
          ok: true,
          ...result,
          workspaces: listConfiguredWorkspaces(root, root, userCtx),
          customWorkspaces: readUserWorkspaces(userCtx),
        });
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
          workspaceId: url.searchParams.get("workspaceId") || "",
          archived: url.searchParams.get("archived") === "1",
        }, userCtx);
        if (scoped.error) {
          json(res, scoped.status || 400, { error: scoped.error });
          return;
        }
        const { path: graphPath, graph } = readWorkspaceGraph(scoped.root);
        const hydratedGraph = hydrateWorkspaceGraphForRuntime(root, scoped, graph, userCtx);
        const collaborationAccess = scoped.collaborationAccess || workspaceCollaborationAccess(null, userCtx.userId);
        json(res, 200, {
          ok: true,
          graph: hydratedGraph,
          revision: workspaceDesignRevision(hydratedGraph),
          designRevision: workspaceDesignRevision(hydratedGraph),
          runtimeRevision: workspaceRuntimeRevision(hydratedGraph),
          path: graphPath,
          root: scoped.root,
          flowId: scoped.flowId,
          flowSource: scoped.flowSource,
          archived: scoped.archived,
          writable: !(scoped.archived || isReadonlyBuiltinFlowSource(scoped.flowSource))
            && collaborationAccess.writable !== false,
          collaboration: workspaceCollaborationSummaryWithUsers(scoped.collaboration, userCtx.userId),
          workspaceSchedules: listWorkspaceScheduleStatusesForFlow(userCtx, scoped.flowSource || "user", scoped.flowId || ""),
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
          workspaceId: payload.workspaceId || "",
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
        const share = createDisplayShareRecord({
          userId: authUser.userId,
          flowId: scoped.flowId || "",
          flowSource: scoped.flowSource || "user",
          archived: scoped.archived === true,
          title: payload.title,
          layout: payload.layout,
          nodeIds,
          expiresMode: payload.expiresMode,
          expiresInDays: payload.expiresInDays,
          permanent: payload.permanent,
          expiresAt: payload.expiresAt,
        });
        json(res, 200, { ok: true, share, url: `/display/${encodeURIComponent(share.id)}` });
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
          workspaceId: payload.workspaceId || "",
          archived: payload.archived === true || payload.flowArchived === true,
        }, userCtx);
        if (scoped.error) {
          json(res, scoped.status || 400, { error: scoped.error });
          return;
        }
        if (
          scoped.archived
          || isReadonlyBuiltinFlowSource(scoped.flowSource)
          || scoped.collaborationAccess?.writable === false
        ) {
          json(res, 400, { error: "Cannot write workspace graph for builtin or archived pipeline" });
          return;
        }
        const submittedGraph = hydrateWorkspaceGraphForRuntime(root, scoped, payload.graph || payload, userCtx);
        const graphPath = workspaceGraphPath(scoped.root);
        const currentStoredGraph = readWorkspaceGraph(scoped.root).graph;
        const currentGraph = hydrateWorkspaceGraphForRuntime(root, scoped, currentStoredGraph, userCtx);
        const currentRevision = workspaceDesignRevision(currentGraph);
        const baseRevision = String(payload.baseRevision || "").trim();
        if (scoped.collaboration && !baseRevision) {
          json(res, 428, {
            error: "Shared workspace save requires baseRevision",
            currentRevision,
          });
          return;
        }
        let nextGraph = submittedGraph;
        let merged = false;
        const baseGraph = payload.baseGraph;
        if (baseRevision && baseGraph && typeof baseGraph === "object") {
          const actualBaseRevision = workspaceDesignRevision(baseGraph);
          if (actualBaseRevision !== baseRevision) {
            json(res, 400, {
              error: "Workspace 合并基线与 baseRevision 不匹配",
              conflict: "invalid-merge-base",
              expectedRevision: baseRevision,
              actualBaseRevision,
              currentRevision,
            });
            return;
          }
          const mergeResult = mergeWorkspaceGraphs({
            baseGraph,
            currentGraph,
            incomingGraph: submittedGraph,
          });
          if (mergeResult.conflicts.length) {
            json(res, 409, {
              error: `Workspace 存在 ${mergeResult.conflicts.length} 处同字段冲突`,
              conflict: "field-conflict",
              expectedRevision: baseRevision,
              currentRevision,
              conflictPaths: mergeResult.conflicts.map((item) => item.path),
              conflictItems: mergeResult.conflicts,
              mergeGraph: mergeResult.graph,
              currentGraph,
            });
            return;
          }
          nextGraph = mergeResult.graph;
          merged = baseRevision !== currentRevision
            || workspaceRuntimeRevision(baseGraph) !== workspaceRuntimeRevision(currentGraph);
        } else if (baseRevision && baseRevision !== currentRevision) {
          json(res, 409, {
            error: "Workspace 已被其他成员更新，当前客户端缺少合并基线，请刷新后重试",
            conflict: "missing-merge-base",
            expectedRevision: baseRevision,
            currentRevision,
          });
          return;
        }
        const graph = mergeWorkspacePersistentNodeRefs(nextGraph, currentGraph);
        writeWorkspaceGraphAtomic(graphPath, graph);
        const revision = workspaceDesignRevision(graph);
        const runtimeRevision = workspaceRuntimeRevision(graph);
        const workspaceSchedules = syncWorkspaceSchedulesForGraph(root, scoped, graph, authUser, userCtx);
        broadcastWorkspaceCollaborationEvent(
          userCtx,
          scoped.flowSource,
          scoped.flowId,
          scoped.archived,
          {
            type: "graph.committed",
            revision,
            actorId: userCtx.userId || "",
            clientId: String(payload.clientId || ""),
          },
        );
        json(res, 200, {
          ok: true,
          path: graphPath,
          graph,
          revision,
          designRevision: revision,
          runtimeRevision,
          merged,
          workspaceSchedules,
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/workspace/schedules") {
      try {
        const flowId = url.searchParams.get("flowId") || "";
        const flowSource = url.searchParams.get("flowSource") || "user";
        if (!flowId) {
          json(res, 400, { error: "Missing flowId" });
          return;
        }
        json(res, 200, {
          schedules: listWorkspaceScheduleStatusesForFlow(userCtx, flowSource, flowId),
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspace/run/plan") {
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
          workspaceId: payload.workspaceId || "",
          archived: payload.archived === true || payload.flowArchived === true,
        }, userCtx);
        if (scoped.error) {
          json(res, 400, { error: scoped.error });
          return;
        }
        const flowId = String(payload.flowId || "").trim();
        if (!flowId) {
          json(res, 400, { error: "Missing flowId" });
          return;
        }
        const graph = hydrateWorkspaceGraphForRuntime(root, scoped, payload.graph || {}, userCtx);
        const runNodeId = String(payload.runNodeId || "").trim();
        const plan = workspaceRunPlan(graph, runNodeId, scoped.root);
        const plannedNodeIds = workspaceRunPlanNodeIds(runNodeId, plan);
        const scopeKey = workspaceRunKey(userCtx, scoped.flowSource || payload.flowSource || "user", flowId);
        const conflict = workspaceFindActiveRunConflict(scopeKey, plannedNodeIds);
        json(res, 200, {
          ok: true,
          runNodeId,
          order: plan.order,
          pauseNodeIds: plan.pauseNodeIds,
          plannedNodeIds,
          conflict: conflict ? {
            runId: conflict.entry?.runId || "",
            runNodeId: conflict.entry?.runNodeId || "",
            conflictNodeIds: conflict.conflictNodeIds,
          } : null,
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/workspace/run/optimize") {
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
          workspaceId: payload.workspaceId || "",
          archived: payload.archived === true || payload.flowArchived === true,
        }, userCtx);
        if (scoped.error) {
          json(res, 400, { error: scoped.error });
          return;
        }
        if (
          scoped.archived
          || isReadonlyBuiltinFlowSource(scoped.flowSource)
          || scoped.collaborationAccess?.writable === false
        ) {
          json(res, 400, { error: "Cannot optimize workspace graph for builtin or archived pipeline" });
          return;
        }
        const flowId = String(payload.flowId || "").trim();
        if (!flowId) {
          json(res, 400, { error: "Missing flowId" });
          return;
        }
        const graphPath = workspaceGraphPath(scoped.root);
        const result = await workspaceOptimizeRunImplementations(root, scoped.root, payload, userCtx, {
          emit: () => {},
        });
        const currentGraph = readWorkspaceGraph(scoped.root).graph;
        const touchedIds = new Set((result.optimized || []).map((item) => item.nodeId).filter(Boolean));
        const mergedGraph = mergeWorkspaceRunGraph(currentGraph, result.graph, touchedIds);
        writeWorkspaceGraphAtomic(graphPath, mergedGraph);
        const revision = workspaceDesignRevision(mergedGraph);
        const workspaceSchedules = syncWorkspaceSchedulesForGraph(root, scoped, mergedGraph, authUser, userCtx);
        broadcastWorkspaceCollaborationEvent(userCtx, scoped.flowSource, scoped.flowId, scoped.archived, {
          type: "graph.committed",
          revision,
          actorId: userCtx.userId || "",
          clientId: String(payload.clientId || ""),
        });
        json(res, 200, {
          ok: true,
          path: graphPath,
          graph: mergedGraph,
          revision,
          order: result.order,
          optimized: result.optimized,
          skipped: result.skipped,
          workspaceSchedules,
        });
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
          workspaceId: payload.workspaceId || "",
          archived: payload.archived === true || payload.flowArchived === true,
        }, userCtx);
        if (scoped.error) {
          json(res, 400, { error: scoped.error });
          return;
        }
        if (
          scoped.archived
          || isReadonlyBuiltinFlowSource(scoped.flowSource)
          || scoped.collaborationAccess?.runnable === false
        ) {
          json(res, 400, { error: "Cannot run workspace graph for builtin or archived pipeline" });
          return;
        }
        const wantsStream = /\bapplication\/x-ndjson\b/i.test(req.headers.accept || "") || payload.stream === true;
        const flowId = String(payload.flowId || "").trim();
        if (!flowId) {
          json(res, 400, { error: "Missing flowId" });
          return;
        }
        const canonicalStoredGraph = readWorkspaceGraph(scoped.root).graph;
        const canonicalGraph = hydrateWorkspaceGraphForRuntime(
          root,
          scoped,
          canonicalStoredGraph,
          userCtx,
        );
        const canonicalRevision = workspaceDesignRevision(canonicalGraph);
        const expectedRevision = String(payload.expectedRevision || payload.baseRevision || "").trim();
        if (scoped.collaboration && expectedRevision && expectedRevision !== canonicalRevision) {
          json(res, 409, {
            error: "Workspace 已更新，请刷新后再运行",
            conflict: "revision-mismatch",
            expectedRevision,
            currentRevision: canonicalRevision,
          });
          return;
        }
        const runtimeGraph = scoped.collaboration
          ? canonicalGraph
          : hydrateWorkspaceGraphForRuntime(root, scoped, payload.graph || canonicalGraph, userCtx);
        const runNodeId = String(payload.runNodeId || "").trim();
        const plan = workspaceRunPlan(runtimeGraph, runNodeId, scoped.root);
        const plannedNodeIds = workspaceRunPlanNodeIds(runNodeId, plan);
        const scopeKey = workspaceRunKey(userCtx, scoped.flowSource || payload.flowSource || "user", flowId);
        const conflict = workspaceFindActiveRunConflict(scopeKey, plannedNodeIds);
        if (conflict) {
          json(res, 409, {
            error: "该 Run 与正在执行的 Run 共享节点",
            runNodeId: conflict.entry?.runNodeId || "",
            runId: conflict.entry?.runId || "",
            conflictNodeIds: conflict.conflictNodeIds,
          });
          return;
        }
        const controller = new AbortController();
        const runControl = workspaceRunControl(controller);
        const runId = String(payload.runSessionId || payload.runId || "").trim() || runLedgerId("workspace");
        const runKey = workspaceRunEntryKey(scopeKey, runId);
        const runAlias = String(payload.runAlias || "").trim() || workspaceRuntimeNodeLabel(runtimeGraph, runNodeId, "Workspace Run");
        const runEntry = {
          scopeKey,
          controller,
          runControl,
          runId,
          userId: String(userCtx.userId || ""),
          username: String(authUser?.username || userCtx.userId || ""),
          runNodeId,
          label: runAlias,
          flowId,
          flowSource: scoped.flowSource || payload.flowSource || "user",
          plannedNodeIds,
          startedAt: Date.now(),
        };
        const runLog = createWorkspaceRunLogSession({
          runId,
          userId: runEntry.userId,
          username: runEntry.username,
          flowId: runEntry.flowId,
          flowSource: runEntry.flowSource,
          scheduleNodeId: String(runtimeGraph.instances?.[runNodeId]?.definitionId || "") === "workspace_scheduled_run" ? runNodeId : "",
          runNodeId,
          scheduled: false,
          trigger: "manual",
          label: runAlias,
          startedAt: runEntry.startedAt,
        });
        activeWorkspaceRuns.set(runKey, runEntry);
        appendWorkspaceRunStarted(runEntry);
        broadcastWorkspaceCollaborationEvent(userCtx, scoped.flowSource, scoped.flowId, scoped.archived, {
          type: "run.started",
          runId,
          runNodeId,
          plannedNodeIds,
          revision: canonicalRevision,
          actorId: userCtx.userId || "",
        });
        const setActiveChild = (child, childOptions = {}) => {
          runControl.setChild(child, childOptions);
        };
        const clearActiveRun = (status = "finished") => {
          runControl.finish(status);
          if (activeWorkspaceRuns.get(runKey) === runEntry) activeWorkspaceRuns.delete(runKey);
          broadcastWorkspaceCollaborationEvent(userCtx, scoped.flowSource, scoped.flowId, scoped.archived, {
            type: "run.finished",
            status,
            runId,
            runNodeId,
            actorId: userCtx.userId || "",
          });
        };
        if (wantsStream) {
          const graphPath = workspaceGraphPath(scoped.root);
          const runPayload = { ...payload, requestBaseUrl: requestPublicBaseUrl(req) };
          res.writeHead(200, {
            "Content-Type": "application/x-ndjson; charset=utf-8",
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
          });
          const writeEvent = (event) => {
            appendWorkspaceRunLogEvent(runLog.runId, event);
            try { res.write(JSON.stringify(event) + "\n"); } catch (_) {}
          };
          try {
            const result = await runWorkspaceGraph(root, scoped.root, runPayload, userCtx, {
              onEvent: writeEvent,
              signal: controller.signal,
              onActiveChild: setActiveChild,
            });
            const currentGraph = readWorkspaceGraph(scoped.root).graph;
            const touchedIds = workspaceRunTouchedNodeIds(result);
            const mergedGraph = mergeWorkspaceRunGraph(currentGraph, result.graph, touchedIds);
            writeWorkspaceGraphAtomic(graphPath, mergedGraph);
            const revision = workspaceDesignRevision(mergedGraph);
            const runtimeRevision = workspaceRuntimeRevision(mergedGraph);
            const collaborationEventType = revision === workspaceDesignRevision(currentGraph)
              ? "runtime.committed"
              : "graph.committed";
            const endedAt = Date.now();
            appendWorkspaceRunFinished({
              ...runEntry,
              endedAt,
              durationMs: endedAt - runEntry.startedAt,
            }, "success");
            finishWorkspaceRunLogSession(runLog.runId, "success", {
              endedAt,
              durationMs: endedAt - runEntry.startedAt,
              runNodeId,
            });
            broadcastWorkspaceCollaborationEvent(userCtx, scoped.flowSource, scoped.flowId, scoped.archived, {
              type: collaborationEventType,
              revision,
              runtimeRevision,
              actorId: userCtx.userId || "",
              source: "run",
            });
            writeEvent({ type: "done", ok: true, path: graphPath, graph: mergedGraph, revision, runtimeRevision, order: result.order, touchedNodeIds: Array.from(touchedIds), pauseNodeIds: result.pauseNodeIds || [] });
            res.end();
          } catch (e) {
            const endedAt = Date.now();
            if (isWorkspaceRunAbortError(e) || controller.signal.aborted) {
              appendWorkspaceRunFinished({
                ...runEntry,
                endedAt,
                durationMs: endedAt - runEntry.startedAt,
              }, "stopped");
              finishWorkspaceRunLogSession(runLog.runId, "stopped", {
                endedAt,
                durationMs: endedAt - runEntry.startedAt,
                runNodeId,
              });
              writeEvent({ type: "stopped", ok: false, stopped: true, message: "Workspace run stopped" });
            } else {
              const error = (e && e.message) || String(e);
              appendWorkspaceRunFinished({
                ...runEntry,
                endedAt,
                durationMs: endedAt - runEntry.startedAt,
              }, "failed");
              finishWorkspaceRunLogSession(runLog.runId, "failed", {
                endedAt,
                durationMs: endedAt - runEntry.startedAt,
                runNodeId,
                error,
              });
              writeEvent({ type: "error", error });
            }
            res.end();
          } finally {
            clearActiveRun(controller.signal.aborted ? "stopped" : "finished");
          }
          return;
        }
        try {
          const result = await runWorkspaceGraph(root, scoped.root, { ...payload, requestBaseUrl: requestPublicBaseUrl(req) }, userCtx, {
            signal: controller.signal,
            onActiveChild: setActiveChild,
            onEvent: (event) => appendWorkspaceRunLogEvent(runLog.runId, event),
          });
          const graphPath = workspaceGraphPath(scoped.root);
          const currentGraph = readWorkspaceGraph(scoped.root).graph;
          const touchedIds = workspaceRunTouchedNodeIds(result);
          const mergedGraph = mergeWorkspaceRunGraph(currentGraph, result.graph, touchedIds);
          writeWorkspaceGraphAtomic(graphPath, mergedGraph);
          const revision = workspaceDesignRevision(mergedGraph);
          const runtimeRevision = workspaceRuntimeRevision(mergedGraph);
          const collaborationEventType = revision === workspaceDesignRevision(currentGraph)
            ? "runtime.committed"
            : "graph.committed";
          const endedAt = Date.now();
          appendWorkspaceRunFinished({
            ...runEntry,
            endedAt,
            durationMs: endedAt - runEntry.startedAt,
          }, "success");
          finishWorkspaceRunLogSession(runLog.runId, "success", {
            endedAt,
            durationMs: endedAt - runEntry.startedAt,
            runNodeId,
          });
          broadcastWorkspaceCollaborationEvent(userCtx, scoped.flowSource, scoped.flowId, scoped.archived, {
            type: collaborationEventType,
            revision,
            runtimeRevision,
            actorId: userCtx.userId || "",
            source: "run",
          });
          json(res, 200, { ok: true, path: graphPath, ...result, graph: mergedGraph, revision, runtimeRevision, touchedNodeIds: Array.from(touchedIds) });
        } catch (e) {
          const endedAt = Date.now();
          if (isWorkspaceRunAbortError(e) || controller.signal.aborted) {
            appendWorkspaceRunFinished({
              ...runEntry,
              endedAt,
              durationMs: endedAt - runEntry.startedAt,
            }, "stopped");
            finishWorkspaceRunLogSession(runLog.runId, "stopped", {
              endedAt,
              durationMs: endedAt - runEntry.startedAt,
              runNodeId,
            });
            json(res, 200, { ok: false, stopped: true, message: "Workspace run stopped" });
          } else {
            const error = (e && e.message) || String(e);
            appendWorkspaceRunFinished({
              ...runEntry,
              endedAt,
              durationMs: endedAt - runEntry.startedAt,
            }, "failed");
            appendWorkspaceRunLogEvent(runLog.runId, { type: "error", error, ts: endedAt });
            finishWorkspaceRunLogSession(runLog.runId, "failed", {
              endedAt,
              durationMs: endedAt - runEntry.startedAt,
              runNodeId,
              error,
            });
            throw e;
          }
        } finally {
          clearActiveRun(controller.signal.aborted ? "stopped" : "finished");
        }
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/workspace/run-logs") {
      try {
        const flowId = url.searchParams.get("flowId") || "";
        const flowSource = url.searchParams.get("flowSource") || "";
        const scheduleNodeId = url.searchParams.get("scheduleNodeId") || "";
        const runNodeId = url.searchParams.get("runNodeId") || "";
        const limit = Number(url.searchParams.get("limit") || 50);
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId,
          flowSource: flowSource || "user",
          archived: url.searchParams.get("archived") === "1",
        }, userCtx);
        if (scoped.error) {
          json(res, scoped.status || 400, { error: scoped.error });
          return;
        }
        json(res, 200, {
          runs: listWorkspaceRunLogs({
            userId: flowSource === "workspace" ? "" : userCtx.userId || "",
            flowId,
            flowSource,
            scheduleNodeId,
            runNodeId,
            limit,
          }),
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/workspace/run-logs/")) {
      try {
        const runId = decodeURIComponent(url.pathname.slice("/api/workspace/run-logs/".length));
        if (!runId) {
          json(res, 400, { error: "Missing runId" });
          return;
        }
        const flowId = url.searchParams.get("flowId") || "";
        const flowSource = url.searchParams.get("flowSource") || "user";
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId,
          flowSource,
          archived: url.searchParams.get("archived") === "1",
        }, userCtx);
        if (scoped.error) {
          json(res, scoped.status || 400, { error: scoped.error });
          return;
        }
        const run = listWorkspaceRunLogs({
          userId: flowSource === "workspace" ? "" : userCtx.userId || "",
          flowId,
          flowSource,
          limit: 200,
        })
          .find((item) => String(item.runId || "") === runId);
        if (!run) {
          json(res, 404, { error: "Run log not found" });
          return;
        }
        json(res, 200, {
          run,
          events: readWorkspaceRunLogEvents(runId),
        });
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
      const scoped = resolveWorkspaceScopeRoot(root, {
        flowId,
        flowSource,
        archived: url.searchParams.get("archived") === "1",
      }, userCtx);
      if (scoped.error) {
        json(res, scoped.status || 400, { error: scoped.error });
        return;
      }
      const scopeKey = workspaceRunKey(userCtx, flowSource, flowId);
      const entries = workspaceActiveRunsForScope(scopeKey).map(([, entry]) => entry);
      const entry = entries[0] || null;
      json(res, 200, {
        running: entries.length > 0,
        state: entry?.runControl?.state || (entries.length > 0 ? "running" : "idle"),
        flowId,
        flowSource,
        runNodeId: entry?.runNodeId || "",
        label: entry?.label || "",
        startedAt: entry?.startedAt || null,
        runs: entries.map((item) => ({
          runId: item?.runId || "",
          runNodeId: item?.runNodeId || "",
          label: item?.label || "",
          startedAt: item?.startedAt || null,
          plannedNodeIds: Array.isArray(item?.plannedNodeIds) ? item.plannedNodeIds : [],
          scheduled: item?.scheduled === true,
          state: item?.runControl?.state || "running",
        })),
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
      const flowSource = payload.flowSource || "user";
      const scoped = resolveWorkspaceScopeRoot(root, {
        flowId,
        flowSource,
        archived: payload.archived === true || payload.flowArchived === true,
      }, userCtx);
      if (scoped.error) {
        json(res, scoped.status || 400, { error: scoped.error });
        return;
      }
      if (scoped.collaborationAccess?.runnable === false) {
        json(res, 403, { error: "Workspace collaboration run permission denied" });
        return;
      }
      const scopeKey = workspaceRunKey(userCtx, flowSource, flowId);
      const runId = String(payload.runId || payload.runSessionId || "").trim();
      const runNodeId = String(payload.runNodeId || "").trim();
      const entries = workspaceActiveRunsForScope(scopeKey);
      const match = entries.find(([, item]) => runId && String(item?.runId || "") === runId)
        || entries.find(([, item]) => runNodeId && String(item?.runNodeId || "") === runNodeId)
        || (!runId && !runNodeId && entries.length === 1 ? entries[0] : null);
      const entry = match?.[1] || null;
      if (!entry) {
        json(res, 404, { error: "该 Workspace 未在运行" });
        return;
      }
      appendWorkspaceRunLogEvent(entry.runId, {
        type: "stop-requested",
        runNodeId: entry.runNodeId || "",
        ts: Date.now(),
      });
      broadcastWorkspaceCollaborationEvent(userCtx, scoped.flowSource, scoped.flowId, scoped.archived, {
        type: "run.stop-requested",
        runId: entry.runId,
        runNodeId: entry.runNodeId || "",
        actorId: userCtx.userId || "",
      });
      const result = await entry.runControl.stop();
      if (!result.stopped) {
        appendWorkspaceRunLogEvent(entry.runId, {
          type: "stop-failed",
          runNodeId: entry.runNodeId || "",
          reason: result.timedOut ? "timeout" : "unknown",
          ts: Date.now(),
        });
        json(res, 409, {
          error: "停止请求已发送，但运行进程未能退出",
          ok: false,
          stopped: false,
          state: entry.runControl.state,
        });
        return;
      }
      appendWorkspaceRunLogEvent(entry.runId, {
        type: "stop-completed",
        runNodeId: entry.runNodeId || "",
        forced: result.forced === true,
        ts: Date.now(),
      });
      json(res, 200, {
        ok: true,
        stopped: true,
        forced: result.forced === true,
      });
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
        const content = fs.readFileSync(abs, "utf-8");
        json(res, 200, {
          path: rel,
          content,
          size: stat.size,
          revision: crypto.createHash("sha256").update(content).digest("hex"),
        });
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
        if (
          scoped.archived
          || isReadonlyBuiltinFlowSource(scoped.flowSource)
          || scoped.collaborationAccess?.writable === false
        ) {
          json(res, 400, { error: "Cannot write to builtin or archived pipeline workspace" });
          return;
        }
        const { abs, rel } = resolveWorkspaceFilePath(scoped.root, payload.path || "");
        if (!rel) {
          json(res, 400, { error: "Missing path" });
          return;
        }
        const content = String(payload.content ?? "");
        const baseRevision = String(payload.baseRevision || "").trim();
        if (baseRevision && fs.existsSync(abs) && fs.statSync(abs).isFile()) {
          const currentContent = fs.readFileSync(abs, "utf-8");
          const currentRevision = crypto.createHash("sha256").update(currentContent).digest("hex");
          if (currentRevision !== baseRevision) {
            json(res, 409, {
              error: "文件已被其他成员更新，请处理冲突后重试",
              conflict: "revision-mismatch",
              currentRevision,
            });
            return;
          }
        }
        fs.mkdirSync(path.dirname(abs), { recursive: true });
        const tmp = `${abs}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmp, content, "utf-8");
        fs.renameSync(tmp, abs);
        const revision = crypto.createHash("sha256").update(content).digest("hex");
        broadcastWorkspaceCollaborationEvent(
          userCtx,
          scoped.flowSource,
          scoped.flowId,
          scoped.archived,
          {
            type: "file.committed",
            path: rel,
            revision,
            actorId: userCtx.userId || "",
            clientId: String(payload.clientId || ""),
          },
        );
        json(res, 200, { ok: true, path: rel, revision });
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
        if (scoped.archived || isReadonlyBuiltinFlowSource(scoped.flowSource) || scoped.collaborationAccess?.writable === false) {
          json(res, 400, { error: "Cannot write to builtin or archived pipeline workspace" });
          return;
        }
        const safeName = sanitizeWorkspaceUploadName(parsed.filename);
        const targetDir = String(parsed.fields.dir ?? "").trim().replace(/^[/\\]+/, "").replace(/\\/g, "/");
        const targetRel = targetDir ? path.posix.join(targetDir, safeName) : safeName;
        const target = uniqueWorkspaceRelPath(scoped.root, targetRel);
        fs.mkdirSync(path.dirname(target.abs), { recursive: true });
        fs.writeFileSync(target.abs, parsed.file);
        broadcastWorkspaceCollaborationEvent(userCtx, scoped.flowSource, scoped.flowId, scoped.archived, {
          type: "file.committed",
          path: target.rel,
          actorId: userCtx.userId || "",
        });
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
        if (scoped.archived || isReadonlyBuiltinFlowSource(scoped.flowSource) || scoped.collaborationAccess?.writable === false) {
          json(res, 400, { error: "Cannot write to builtin or archived pipeline workspace" });
          return;
        }
        const { abs, rel } = resolveWorkspaceFilePath(scoped.root, payload.path || "");
        if (!rel) {
          json(res, 400, { error: "Missing path" });
          return;
        }
        fs.mkdirSync(abs, { recursive: true });
        broadcastWorkspaceCollaborationEvent(userCtx, scoped.flowSource, scoped.flowId, scoped.archived, {
          type: "file.tree-changed",
          path: rel,
          actorId: userCtx.userId || "",
        });
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
        if (scoped.archived || isReadonlyBuiltinFlowSource(scoped.flowSource) || scoped.collaborationAccess?.writable === false) {
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
        broadcastWorkspaceCollaborationEvent(userCtx, scoped.flowSource, scoped.flowId, scoped.archived, {
          type: "file.tree-changed",
          path: rel,
          deleted: true,
          actorId: userCtx.userId || "",
        });
        json(res, 200, { ok: true, path: rel });
      } catch (e) {
        json(res, /traversal/i.test(String(e.message || e)) ? 403 : 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (url.pathname === "/api/workspace/conversations") {
      let payload = {};
      if (req.method === "POST") {
        try {
          payload = JSON.parse(await readBody(req));
        } catch {
          json(res, 400, { error: "Invalid JSON body" });
          return;
        }
      } else if (req.method !== "GET") {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      try {
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId: req.method === "POST" ? (payload.flowId || "") : (url.searchParams.get("flowId") || ""),
          flowSource: req.method === "POST" ? (payload.flowSource || "user") : (url.searchParams.get("flowSource") || "user"),
          archived: req.method === "POST"
            ? (payload.archived === true || payload.flowArchived === true)
            : (url.searchParams.get("archived") === "1" || url.searchParams.get("flowArchived") === "1"),
        }, userCtx);
        if (scoped.error) {
          json(res, 400, { error: scoped.error });
          return;
        }
        if (req.method === "GET") {
          json(res, 200, { ok: true, conversations: readWorkspaceConversations(scoped.root) });
          return;
        }
        if (scoped.archived || isReadonlyBuiltinFlowSource(scoped.flowSource) || scoped.collaborationAccess?.writable === false) {
          json(res, 400, { error: "Cannot write conversations for builtin or archived pipeline workspace" });
          return;
        }
        const conversations = writeWorkspaceConversations(scoped.root, payload.conversations || payload);
        json(res, 200, { ok: true, conversations });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
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
        if (scoped.collaborationAccess?.writable === false) {
          json(res, 403, { error: "Workspace collaboration edit permission denied" });
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
        if (scoped.collaborationAccess?.writable === false) {
          json(res, 403, { error: "Workspace collaboration edit permission denied" });
          return;
        }
        const targetFilePath = String(payload?.targetFilePath || "").trim();
        let targetFile = null;
        if (targetFilePath) {
          if (scoped.archived || isReadonlyBuiltinFlowSource(scoped.flowSource) || scoped.collaborationAccess?.writable === false) {
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

    if (req.method === "GET" && url.pathname === "/api/model-visibility") {
      if (!authUser?.isAdmin) {
        json(res, 403, { error: "Admin permission required" });
        return;
      }
      try {
        const allModelLists = readModelListsFromDisk(root, { raw: true });
        const hiddenModels = readHiddenModelConfig();
        json(res, 200, {
          allModelLists,
          modelLists: applyModelVisibility(allModelLists, hiddenModels),
          hiddenModels,
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/model-visibility") {
      if (!authUser?.isAdmin) {
        json(res, 403, { error: "Admin permission required" });
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
        const hiddenModels = writeHiddenModelConfig(payload?.hiddenModels || {});
        const allModelLists = readModelListsFromDisk(root, { raw: true });
        json(res, 200, {
          success: true,
          allModelLists,
          modelLists: applyModelVisibility(allModelLists, hiddenModels),
          hiddenModels,
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/ui-context") {
      try {
        json(res, 200, {
          ...uiConfig,
          ...(authUser?.isAdmin ? { workspaceRoot: root } : {}),
        });
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
      if (!authUser?.isAdmin) {
        json(res, 403, { error: "Admin permission required" });
        return;
      }
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
      if (!authUser?.isAdmin) {
        json(res, 403, { error: "Admin permission required" });
        return;
      }
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
        const userEnvRows = readUserEnvRows(userCtx.userId);
        json(res, 200, {
          env: authUser?.isAdmin
            ? userEnvRows
            : userEnvRows.filter((row) => !ADMIN_ONLY_USER_ENV_KEYS.has(String(row?.key || "").trim())),
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
        const requestedEnvRows = Array.isArray(payload?.env) ? payload.env : [];
        if (!authUser?.isAdmin && requestedEnvRows.some((row) => ADMIN_ONLY_USER_ENV_KEYS.has(String(row?.key || "").trim()))) {
          json(res, 403, { error: "Admin permission required for infrastructure environment keys" });
          return;
        }
        const preservedAdminRows = authUser?.isAdmin
          ? []
          : readUserEnvRows(userCtx.userId).filter((row) => ADMIN_ONLY_USER_ENV_KEYS.has(String(row?.key || "").trim()));
        const envRows = writeUserEnvRows(userCtx.userId, [...preservedAdminRows, ...requestedEnvRows]);
        const globalEnvRows = authUser?.isAdmin && Object.prototype.hasOwnProperty.call(payload || {}, "globalEnv")
          ? writeGlobalEnvRows(payload?.globalEnv || [])
          : readGlobalEnvRows();
        json(res, 200, {
          success: true,
          env: authUser?.isAdmin
            ? envRows
            : envRows.filter((row) => !ADMIN_ONLY_USER_ENV_KEYS.has(String(row?.key || "").trim())),
          globalEnv: authUser?.isAdmin ? globalEnvRows : [],
          canEditGlobalEnv: Boolean(authUser?.isAdmin),
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/update-model-lists") {
      if (!authUser?.isAdmin) {
        json(res, 403, { error: "Admin permission required" });
        return;
      }
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
      const target = url.searchParams.get("target") || "agentflow";
      const agent = url.searchParams.get("agent") || "codex";
      const args = skillhubListArgs(target, agent);
      const result = await runSkillhub(args, { cwd: root });
      if (!result.ok) {
        json(res, 500, { error: result.error, stdout: result.stdout });
        return;
      }
      json(res, 200, {
        skills: normalizeSkillhubListPayload(parseJsonText(result.stdout, [])),
        target,
        skillsRoot: target === "agentflow" ? getAgentflowSkillsRoot() : "",
      });
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
      const args = skillhubInstallArgs(payload);
      if (!args) {
        json(res, 400, { error: "Missing skill slug or collection" });
        return;
      }
      const beforeSkills = payload?.collection ? listComposerSkills(PACKAGE_ROOT, root) : [];
      const result = await runSkillhub(args, { cwd: root, timeoutMs: 180_000, maxBuffer: 4 * 1024 * 1024 });
      if (!result.ok) {
        json(res, 500, { error: result.error, stdout: result.stdout });
        return;
      }
      clearSkillRegistryCache();
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
      const args = skillhubInstallArgs(payload, { uninstall: true });
      if (!args) {
        json(res, 400, { error: "Missing skill slug or collection" });
        return;
      }
      const result = await runSkillhub(args, { cwd: root, timeoutMs: 120_000, maxBuffer: 4 * 1024 * 1024 });
      if (!result.ok) {
        json(res, 500, { error: result.error, stdout: result.stdout });
        return;
      }
      clearSkillRegistryCache();
      const skillCollections = payload?.collection ? removeSkillhubCollectionGroup(userCtx, payload.collection, root) : null;
      json(res, 200, { ok: true, stdout: result.stdout, skillCollections });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/skillhub/update") {
      if (!authUser?.isAdmin) {
        json(res, 403, { error: "Admin required" });
        return;
      }
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

    if (req.method === "GET" && url.pathname === "/api/node-studio/drafts") {
      try {
        json(res, 200, { drafts: listNodeStudioDrafts(userCtx) });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/node-studio/draft") {
      try {
        const id = url.searchParams.get("id") || "";
        if (!id) {
          json(res, 200, { draft: null });
          return;
        }
        const draft = readNodeStudioDraft(userCtx, id);
        json(res, 200, { draft: draft && !isLegacyNodeStudioDemoDraft(draft) ? draft : null });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/node-studio/draft") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      try {
        const current = readNodeStudioDraft(userCtx, payload.id || "") || emptyNodeStudioDraft(userCtx, payload.id || "untitled_node");
        const promptDraft = payload.promptDraft != null ? String(payload.promptDraft) : current.promptDraft || "";
        const agentMessages = Array.isArray(current.agentMessages) ? [...current.agentMessages] : [];
        if (payload.appendUserMessage === true && promptDraft.trim()) {
          const at = new Date().toISOString();
          agentMessages.push({ role: "user", text: promptDraft.trim(), at });
          agentMessages.push({ role: "assistant", text: "已记录需求，下一步会由节点 Agent 更新 manifest、脚本和 UI schema。", at });
        }
        const draft = writeNodeStudioDraft(userCtx, {
          ...current,
          ...(payload.config && typeof payload.config === "object" ? { config: { ...(current.config || {}), ...payload.config } } : {}),
          promptDraft,
          agentMessages,
        });
        json(res, 200, { ok: true, draft });
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
      const collaborationDenied = workspaceFlowCollaborationGuard(
        flowId,
        flowSource,
        flowArchived,
        userCtx,
        "read",
      );
      if (collaborationDenied) {
        json(res, collaborationDenied.status, { error: collaborationDenied.error });
        return;
      }
      const result = readFlowJson(root, flowId, flowSource, { archived: flowArchived, ...userCtx });
      if (result.error) {
        json(res, 404, result);
        return;
      }
      json(res, 200, {
        ...result,
        revision: crypto.createHash("sha256").update(String(result.flowYaml || "")).digest("hex").slice(0, 24),
      });
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
      const collaborationDenied = workspaceFlowCollaborationGuard(
        flowId,
        flowSource,
        flowArchived,
        userCtx,
        "write",
      );
      if (collaborationDenied) {
        json(res, collaborationDenied.status, { error: collaborationDenied.error });
        return;
      }
      if (flowSource === "workspace" && getWorkspaceCollaborationByFlow(flowId, flowArchived)) {
        const current = readFlowJson(root, flowId, flowSource, { archived: flowArchived, ...userCtx });
        if (current.error) {
          json(res, 404, current);
          return;
        }
        const currentRevision = crypto.createHash("sha256")
          .update(String(current.flowYaml || ""))
          .digest("hex")
          .slice(0, 24);
        const baseRevision = String(payload.baseRevision || "").trim();
        if (!baseRevision) {
          json(res, 428, { error: "Shared workspace save requires baseRevision", currentRevision });
          return;
        }
        if (baseRevision !== currentRevision) {
          json(res, 409, {
            error: "Workflow 已被其他成员更新，请处理冲突后重试",
            conflict: "revision-mismatch",
            expectedRevision: baseRevision,
            currentRevision,
          });
          return;
        }
      }
      const result = writeFlowYaml(root, flowId, flowSource, flowYaml, { archived: flowArchived, ...userCtx });
      if (!result.success) {
        json(res, 400, result);
        return;
      }
      broadcastFlowEditorSync(flowId, flowSource, flowArchived, userCtx.userId);
      const saved = readFlowJson(root, flowId, flowSource, { archived: flowArchived, ...userCtx });
      json(res, 200, {
        success: true,
        revision: crypto.createHash("sha256").update(String(saved.flowYaml || "")).digest("hex").slice(0, 24),
      });
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
      const collaborationDenied = workspaceFlowCollaborationGuard(
        flowId,
        flowSource,
        flowArchived,
        userCtx,
        "read",
      );
      if (collaborationDenied) {
        json(res, collaborationDenied.status, { error: collaborationDenied.error });
        return;
      }
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
      const collaborationDenied = workspaceFlowCollaborationGuard(
        flowId,
        flowSource,
        flowArchived,
        userCtx,
        "read",
      );
      if (collaborationDenied) {
        json(res, collaborationDenied.status, { error: collaborationDenied.error });
        return;
      }
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
      const collaborationDenied = workspaceFlowCollaborationGuard(
        flowId,
        flowSource,
        flowArchived,
        userCtx,
        "read",
      );
      if (collaborationDenied) {
        json(res, collaborationDenied.status, { error: collaborationDenied.error });
        return;
      }
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
      const collaborationDenied = workspaceFlowCollaborationGuard(flowId, fromSource, false, userCtx, "owner");
      if (collaborationDenied) {
        json(res, collaborationDenied.status, { error: collaborationDenied.error });
        return;
      }
      const result = moveFlowDirectory(root, flowId.trim(), fromSource, toSource, userCtx);
      if (!result.success) {
        json(res, 400, { error: result.error || "Move failed" });
        return;
      }
      if (fromSource === "workspace" && toSource !== "workspace") {
        deleteWorkspaceCollaborationForFlow(flowId.trim(), false);
      } else if (fromSource !== "workspace" && toSource === "workspace") {
        ensureWorkspaceCollaboration({ flowId: flowId.trim(), userId: userCtx.userId });
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
      const collaborationDenied = workspaceFlowCollaborationGuard(flowId, flowSource, false, userCtx, "owner");
      if (collaborationDenied) {
        json(res, collaborationDenied.status, { error: collaborationDenied.error });
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
        updateWorkspaceCollaborationFlow({
          previousFlowId: flowId,
          flowSource,
          ownerId: userCtx.userId,
          flowId: validation.flowId,
        });
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
      const collaborationDenied = workspaceFlowCollaborationGuard(flowId, flowSource, false, userCtx, "owner");
      if (collaborationDenied) {
        json(res, collaborationDenied.status, { error: collaborationDenied.error });
        return;
      }
      const result = archiveFlowPipeline(root, flowId, flowSource, userCtx);
      if (!result.success) {
        json(res, 400, { error: result.error || "归档失败" });
        return;
      }
      updateWorkspaceCollaborationFlow({
        previousFlowId: flowId,
        previousArchived: false,
        flowSource,
        ownerId: userCtx.userId,
        flowId,
        archived: true,
      });
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
      const collaboration = getWorkspaceCollaborationForProject({
        workspaceId: payload.workspaceId || "",
        flowId,
        flowSource,
        archived: flowArchived,
        ownerId: userCtx.userId,
      }) || listWorkspaceCollaborationsForUser(userCtx.userId).find((record) => (
        record.flowId === flowId
        && record.archived === flowArchived
        && (record.projectSource || record.flowSource || "workspace") === flowSource
      )) || null;
      const collaborationAccess = workspaceCollaborationAccess(collaboration, userCtx.userId);
      if (collaboration && collaborationAccess.allowed && collaborationAccess.role !== "owner") {
        const left = removeWorkspaceCollaborationMember({
          workspaceId: collaboration.id,
          userId: userCtx.userId,
        });
        if (left.error) {
          json(res, left.status || 400, { error: left.error });
          return;
        }
        broadcastWorkspaceCollaborationEvent(userCtx, flowSource, flowId, flowArchived, {
          type: "member.left",
          actorId: userCtx.userId || "",
          memberUserId: userCtx.userId || "",
        });
        json(res, 200, {
          success: true,
          flowId,
          flowSource,
          deleted: false,
          left: true,
        });
        return;
      }
      const collaborationDenied = workspaceFlowCollaborationGuard(flowId, flowSource, flowArchived, userCtx, "owner");
      if (collaborationDenied) {
        json(res, collaborationDenied.status, { error: collaborationDenied.error });
        return;
      }
      const result = deleteFlowPipeline(root, flowId, flowSource, { archived: flowArchived, ...userCtx });
      if (!result.success) {
        json(res, 400, { error: result.error || "删除失败" });
        return;
      }
      if (collaboration?.id) deleteWorkspaceCollaborationById(collaboration.id);
      else deleteWorkspaceCollaborationForFlow(flowId, flowArchived);
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

    if (req.method === "GET" && url.pathname === "/api/flow/schedules") {
      try {
        json(res, 200, { schedules: listScheduleStatuses(root, userCtx) });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/schedules") {
      try {
        const pipelineSchedules = listScheduleStatuses(root, userCtx)
          .filter((schedule) => (
            schedule.enabled ||
            schedule.cron ||
            schedule.nextRunAt ||
            schedule.lastTriggeredAt ||
            schedule.lastRunUuid ||
            schedule.lastError ||
            schedule.running ||
            schedule.waiting
          ))
          .map((schedule) => ({
            kind: "pipeline",
            ...schedule,
          }));
        const workspaceSchedules = listWorkspaceScheduleStatuses(root, userCtx);
        json(res, 200, {
          schedules: [...workspaceSchedules, ...pipelineSchedules].sort((a, b) => {
            const ea = a.enabled ? 0 : 1;
            const eb = b.enabled ? 0 : 1;
            return ea - eb || String(a.nextRunAt || "").localeCompare(String(b.nextRunAt || "")) || String(a.flowId || "").localeCompare(String(b.flowId || ""));
          }),
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/schedule/toggle") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const kind = String(payload.kind || "").trim();
      if (kind === "workspace") {
        try {
          const result = setWorkspaceScheduleEnabled(root, payload, authUser, userCtx);
          if (!result.success) {
            json(res, 400, { error: result.error || "Could not update workspace schedule" });
            return;
          }
          json(res, 200, { success: true });
        } catch (e) {
          json(res, 500, { error: (e && e.message) || String(e) });
        }
        return;
      }
      if (kind === "pipeline") {
        const flowId = String(payload.flowId || "").trim();
        const flowSource = String(payload.flowSource || "user").trim() || "user";
        if (!flowId) {
          json(res, 400, { error: "Missing flowId" });
          return;
        }
        if (!isValidFlowSourceWrite(flowSource)) {
          json(res, 400, { error: "Cannot update schedule for builtin or readonly flow" });
          return;
        }
        const current = readFlowSchedule(root, flowId, flowSource, userCtx);
        if (!current.success) {
          json(res, 400, { error: current.error || "Could not read schedule" });
          return;
        }
        const result = writeFlowSchedule(root, flowId, flowSource, { ...current.schedule, enabled: payload.enabled === true }, userCtx);
        if (!result.success) {
          json(res, 400, { error: result.error || "Could not update schedule" });
          return;
        }
        json(res, 200, { success: true, schedule: result.schedule });
        return;
      }
      json(res, 400, { error: "Invalid schedule kind" });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/flow/schedule/disable") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const flowId = String(payload.flowId || "").trim();
      const flowSource = String(payload.flowSource || "user").trim() || "user";
      if (!flowId) {
        json(res, 400, { error: "Missing flowId" });
        return;
      }
      if (!isValidFlowSourceWrite(flowSource)) {
        json(res, 400, { error: "Cannot disable schedule for builtin or readonly flow" });
        return;
      }
      const current = readFlowSchedule(root, flowId, flowSource, userCtx);
      if (!current.success) {
        json(res, 400, { error: current.error || "Could not read schedule" });
        return;
      }
      const result = writeFlowSchedule(root, flowId, flowSource, { ...current.schedule, enabled: false }, userCtx);
      if (!result.success) {
        json(res, 400, { error: result.error || "Could not disable schedule" });
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
      const flowSource = payload.flowSource || "user";
      const collaborationDenied = workspaceFlowCollaborationGuard(
        flowId,
        flowSource,
        false,
        userCtx,
        "run",
      );
      if (collaborationDenied) {
        json(res, collaborationDenied.status, { error: collaborationDenied.error });
        return;
      }
      const runUuid = typeof payload.uuid === "string" ? payload.uuid.trim() : "";
      const runKey = workspaceRunKey(userCtx, flowSource, flowId);
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
      const runEntry = { child, runUuid: runUuid || null, userId: userCtx.userId || "" };
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
      const flowSource = payload.flowSource || "user";
      const collaborationDenied = workspaceFlowCollaborationGuard(
        flowId,
        flowSource,
        false,
        userCtx,
        "run",
      );
      if (collaborationDenied) {
        json(res, collaborationDenied.status, { error: collaborationDenied.error });
        return;
      }
      const runKey = workspaceRunKey(userCtx, flowSource, flowId);
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
          const runDir = getRunDir(root, flowId, uuid, { userId: entry.userId || userCtx.userId || "" });
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

  if (enableWorkspaceScheduler) {
    const workspaceScheduleTimer = setInterval(() => {
      try {
        pollWorkspaceSchedules(root);
      } catch (e) {
        log.debug(`[workspace-scheduler] poll failed: ${(e && e.message) || String(e)}`);
      }
    }, WORKSPACE_SCHEDULE_POLL_MS);
    try {
      workspaceScheduleTimer.unref?.();
    } catch (_) {}
    server.on("close", () => clearInterval(workspaceScheduleTimer));
    setTimeout(() => {
      try {
        pollWorkspaceSchedules(root);
      } catch (e) {
        log.debug(`[workspace-scheduler] initial poll failed: ${(e && e.message) || String(e)}`);
      }
    }, 1000).unref?.();
  }

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      log.debug(`[ui] server listening on ${host}:${port}, workspace=${root}, static=${staticDir}`);
      updateModelLists(root).catch(() => {});
      resolve(server);
    });
  });
}
