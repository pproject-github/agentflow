/**
 * 本地 HTTP：静态 UI + /api/flows（GET/POST/HEAD）、/api/flows/import（POST multipart 导入 .yaml/.zip）、/api/flow/archive（POST）、/api/flow/delete（POST 永久删除）、/api/model-lists、/api/ui-context、/api/pipeline-recent-runs、/api/run-node-statuses（GET 某次 run 各节点磁盘状态）、/api/workspace-tree（GET 工作区目录树）、/api/nodes、/api/flow（GET/POST）、
 * /api/flow-editor-sync（POST 通知画布刷新）、/api/flow-editor-sync-events（GET SSE）、/api/workspace/run（POST NDJSON 流式执行 Workspace 图）、/api/workspace/run/stop（POST 终止 Workspace 临时运行）、
 * /api/composer-agent（POST NDJSON；有 flow 时结束后 validate-flow，失败则自动 agent 修复至多 5 次）、
 * /api/agentflow-config（GET/POST 读写 ~/agentflow/config.json 的 opencodeProvider；POST 后执行 update-model-lists）、/api/update-model-lists（POST 可选 JSON body.opencodeProvider 覆盖本次拉取用的 Provider，未保存 config 也可用）；
 * listen 后后台 updateModelLists
 */
import fs from "fs";
import http from "http";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFile, spawn } from "child_process";
import busboy from "busboy";
import { log } from "./log.mjs";
import { resolveFlowDirAbs, listFlowsJson, readFlowJson } from "./catalog-flows.mjs";
import {
  archiveFlowPipeline,
  createEmptyFlow,
  deleteFlowPipeline,
  moveFlowDirectory,
  resolveFlowDirForWrite,
  restoreArchivedFlowPipeline,
  validateUserPipelineId,
  writeFlowYaml,
} from "./flow-write.mjs";
import { updateModelLists } from "./model-lists.mjs";
import { t } from "./i18n.mjs";
import {
  PACKAGE_ROOT,
  ARCHIVED_PIPELINES_DIR_NAME,
  PIPELINES_DIR,
  getAgentflowDataRoot,
  getAgentflowSkillsRoot,
  getAgentflowUserConfigAbs,
  getAgentflowUserDataRoot,
  getUserPipelinesRoot,
  listAgentflowUserIds,
  getModelListsAbs,
  getRunDir,
  isFlowDir,
} from "./paths.mjs";
import { listComposerSkills, readComposerSkillDetail } from "./composer-skill-router.mjs";
import { clearSkillRegistryCache } from "./skill-registry.mjs";
import { listRecentRunsFromDisk } from "./recent-runs.mjs";
import {
  unzipAndNormalizePipelineZip,
  validateImportedFlowSource,
  writePipelineTree,
} from "./flow-import.mjs";
import { packageResolverFor, scanAvailableNodePackages } from "./flow-dsl/packages.mjs";
import { runStartupStorageMigrations } from "./startup-storage-migrations.mjs";
import { getPipelineFiles } from "./workspace-tree.mjs";
import { listExpiredWorkspacePreviews } from "./workspace-preview.mjs";
import { listExpiredWorkspaceDrafts } from "./workspace-draft.mjs";
import { LEGACY_FLOW_EXECUTION_DISABLED, LEGACY_FLOW_EXECUTION_MESSAGE } from "./legacy-flow-execution.mjs";
import {
  listRecentComposerSessions,
  parseComposerLogFile,
  readComposerSessionMeta,
} from "./composer-log.mjs";
import {
  deleteMarketplaceFlowSnippetPackage,
  deleteMarketplaceNodePackage,
  listMarketplaceFlowSnippets,
  listMarketplacePackages,
  publishFlowSnippet,
  publishNodeFromInstance,
} from "./marketplace.mjs";
import { runGit } from "./git-worktree.mjs";
import {
  authSetupRequired,
  buildClearSessionCookie,
  buildSessionCookie,
  createCliAuthorization,
  decideCliAuthorization,
  exchangeCliAuthorization,
  getAuthUserFromRequest,
  getCliAuthorization,
  getSessionTokenFromRequest,
  isAuthUserAllowed,
  listAuthUsers,
  loginOrCreateUser,
  logoutRequest,
  readAuthUsers,
  readUserAllowlist,
  resetAuthUserPassword,
  revokeSessionToken,
  writeUserAllowlist,
} from "./auth.mjs";
import {
  renderCliAuthorizationPage,
  renderCliAuthorizationResult,
} from "./cli-auth-page.mjs";
import { readGlobalEnvRows, readUserEnvRows, writeGlobalEnvRows, writeUserEnvRows } from "./user-env.mjs";
import {
  readAdminBuiltinPipelineConfig,
  updateAdminBuiltinPipelineConfig,
} from "./admin-builtin-pipelines.mjs";
import { readAdminStorageConfig, writeAdminStorageConfig } from "./admin-storage-config.mjs";
import { readAdminRunDetail } from "./admin-run-detail.mjs";
import {
  deleteWorkspaceCollaborationById,
  deleteWorkspaceCollaborationForFlow,
  ensureWorkspaceCollaboration,
  getWorkspaceCollaborationByFlow,
  getWorkspaceCollaborationForProject,
  listWorkspaceCollaborationsForUser,
  removeWorkspaceCollaborationMember,
  updateWorkspaceCollaborationFlow,
  workspaceCollaborationAccess,
} from "./workspace-collaboration.mjs";
import {
  getPrdWorkflowCollaborationByShareToken,
  getPrdWorkflowCollaborationByTapdId,
  getPrdWorkflowCollaborationForUser,
  prdWorkflowCollaborationAccess,
} from "./prd-workflow-collaboration.mjs";
import { createTeam, deleteTeam, getTeamForUser, listTeams, setTeamMembers, updateTeam } from "./teams.mjs";
import {
} from "./workflow-report.mjs";

// 从 ui-server 拆出去的 PRD workflow 子系统；路由仍在下面的 startUiServer 里
import {
  workflowKnowledgeSummary,
  workflowRepositoryRef,
} from "./prd-workflow-server.mjs";
import { handlePrdWorkflowRoutes } from "./prd-workflow-routes.mjs";
import { json, readBody } from "./http-util.mjs";

// 从 ui-server 拆出去的 Workspace 子系统；路由仍在下面的 startUiServer 里
import {
  WORKSPACE_DEFERRED_RUN_POLL_MS,
  WORKSPACE_SCHEDULE_POLL_MS,
  activeWorkspaceRunUsageRecords,
  adminWorkspaceOwnerSummary,
  checkCursorMcpServers,
  createDisplayShareRecord,
  cursorMcpConfigPath,
  displayShareOutputUrl,
  isReadonlyBuiltinFlowSource,
  isValidFlowSourceRead,
  listConfiguredWorkspaces,
  listWorkspaceScheduleStatuses,
  normalizeDisplayShareExpiry,
  normalizeDisplayShareNodeIds,
  normalizeMcpServerConfig,
  normalizeWorkspaceScheduledRunConfig,
  parseJsonText,
  pollWorkspaceDeferredRuns,
  readCursorMcpConfig,
  readCursorMcpServers,
  readDisplayShares,
  readUserWorkspaces,
  readUserMcpPrivate,
  readWorkspaceGraph,
  readWorkspaceRunUsageRecords,
  readWorkspaceScheduleRegistry,
  resolveWorkspaceFilePath,
  resolveWorkspaceScopeRoot,
  runStatusBucket,
  runWorkspaceScheduledEntry,
  syncWorkspaceSchedulesForGraph,
  updateWorkspaceScheduleEntry,
  userMcpPrivatePath,
  workspaceCollaborationEventKey,
  workspaceCollaborationSequences,
  workspaceCollaborationSubscribers,
  workspaceCollaborationSummaryWithUsers,
  workspaceDisplayContentFromInstance,
  workspaceDisplayKindFromInstance,
  workspaceDisplayTextFilePath,
  workspaceDownloadContentDisposition,
  workspaceFlowCollaborationGuard,
  workspaceScheduleNextRunAt,
  writeDisplayShares,
  writeWorkspaceGraph,
} from "./workspace-server.mjs";
import { handleWorkspaceRoutes, workspaceGraphWithScheduleMode } from "./workspace-routes.mjs";
import {
  createSpace,
  deleteSpacePage,
  getSpaceById,
  getSpaceByRoute,
  listSpacesForUser,
  readSpaces,
  normalizeSpacePagePath,
  normalizeSpaceVisibility,
  updateSpace,
  upsertSpacePage,
} from "./spaces.mjs";

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

const SKILL_COLLECTIONS_FILENAME = "skill-collections.json";
const BUILTIN_SKILL_COLLECTIONS = [
  {
    id: "pipeline",
    name: "Pipeline",
    defaultKeys: [
      "agentflow-flow-dsl",
      "agentflow-flow-recipes",
      "agentflow-node-reference",
      "agentflow-placeholder-reference",
      "agentflow-runtime-reference",
    ],
  },
  {
    id: "workspace",
    name: "Workspace",
    defaultKeys: [
      "agentflow-flow-dsl",
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
      [
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

const DISPLAY_SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
function workflowBindableWorkspaces(userCtx = {}) {
  return readUserWorkspaces(userCtx)
    .filter((entry) => entry.enabled !== false && entry.exists)
    .map((entry) => ({ ...entry, builtin: false }));
}

function prepareWorkflowKnowledgeWorktrees(snapshot, bindings, userCtx = {}) {
  const configured = new Map(workflowBindableWorkspaces(userCtx).map((entry) => [entry.id, entry]));
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "agentflow-workflow-query-"));
  const sourcesRoot = path.join(tempRoot, "sources");
  fs.mkdirSync(sourcesRoot, { recursive: true });
  const sources = [];
  const cleanups = [];
  for (const binding of Array.isArray(bindings) ? bindings : []) {
    const workspace = configured.get(String(binding.workspaceId || ""));
    if (!workspace) {
      sources.push({ ...binding, available: false, reason: "知识工作区不存在、未同步或已停用" });
      continue;
    }
    if (workspace.kind !== "git" || !fs.existsSync(path.join(workspace.path, ".git"))) {
      sources.push({ ...workflowKnowledgeSummary(workspace), available: false, reason: "当前仅对 Git 知识工作区提供隔离代码分析" });
      continue;
    }
    const requestedRef = workflowRepositoryRef(snapshot, workspace);
    let commitResult = runGit(["rev-parse", "--verify", `${requestedRef}^{commit}`], workspace.path);
    let selectedRef = requestedRef;
    if (commitResult.status !== 0) {
      selectedRef = "HEAD";
      commitResult = runGit(["rev-parse", "--verify", "HEAD^{commit}"], workspace.path);
    }
    const commit = String(commitResult.stdout || "").trim();
    if (!commit) {
      sources.push({ ...workflowKnowledgeSummary(workspace), available: false, reason: `无法解析代码版本 ${requestedRef}` });
      continue;
    }
    const target = path.join(sourcesRoot, String(workspace.id).replace(/[^a-zA-Z0-9_-]+/g, "_"));
    const added = runGit(["worktree", "add", "--detach", target, commit], workspace.path);
    if (added.status !== 0) {
      sources.push({ ...workflowKnowledgeSummary(workspace), available: false, reason: String(added.stderr || "创建只读代码快照失败").trim() });
      continue;
    }
    cleanups.push(() => runGit(["worktree", "remove", "--force", target], workspace.path));
    sources.push({
      ...workflowKnowledgeSummary(workspace),
      available: true,
      path: path.relative(tempRoot, target).replace(/\\/g, "/"),
      requestedRef,
      selectedRef,
      commit,
    });
  }
  return {
    tempRoot,
    sources,
    cleanup() {
      for (const cleanup of cleanups.reverse()) {
        try { cleanup(); } catch (_) {}
      }
      try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch (_) {}
    },
  };
}

function countFlowYamlDirs(root) {
  try {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return 0;
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => entry.name !== ARCHIVED_PIPELINES_DIR_NAME)
      .filter((entry) => isFlowDir(path.join(root, entry.name)))
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

function displayShareExpiresAt(now = new Date()) {
  return normalizeDisplayShareExpiry({ expiresInDays: 30 }, now).expiresAt;
}

function isDisplayShareExpired(share) {
  const expiresAt = Date.parse(String(share?.expiresAt || ""));
  return Number.isFinite(expiresAt) && expiresAt <= Date.now();
}

function canReadDisplayShare(share, userCtx = {}) {
  if (!share) return false;
  if (String(share.visibility || "public") !== "private") return true;
  return userCtx?.isAdmin === true || String(share.userId || "") === String(userCtx?.userId || "");
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
    visibility: String(share?.visibility || "public") === "private" ? "private" : "public",
    url: displayShareOutputUrl(share?.id || "", baseUrl),
  };
}

function spacePublicSummary(space = {}, baseUrl = "") {
  const ownerId = String(space.ownerId || "");
  const slug = String(space.slug || "");
  const rootPath = `/s/${encodeURIComponent(ownerId)}/${encodeURIComponent(slug)}`;
  const base = normalizePublicBaseUrl(baseUrl);
  const absoluteRoot = base ? new URL(rootPath, base.endsWith("/") ? base : `${base}/`).href : rootPath;
  return {
    id: String(space.id || ""),
    ownerId,
    slug,
    title: String(space.title || slug),
    description: String(space.description || ""),
    visibility: normalizeSpaceVisibility(space.visibility),
    status: String(space.status || "active"),
    pages: (Array.isArray(space.pages) ? space.pages : []).map((page) => ({
      id: String(page.id || ""),
      title: String(page.title || ""),
      path: normalizeSpacePagePath(page.path || "/"),
      shareId: String(page.shareId || ""),
      hidden: page.hidden === true,
      order: Number(page.order || 0),
    })),
    url: absoluteRoot,
    createdAt: String(space.createdAt || ""),
    updatedAt: String(space.updatedAt || ""),
  };
}

function canManageSpace(space, userCtx = {}) {
  return Boolean(space) && (userCtx?.isAdmin === true || String(space.ownerId || "") === String(userCtx?.userId || ""));
}

function displayShareSpaceReferences(shareId = "") {
  const wanted = String(shareId || "").trim();
  if (!wanted) return [];
  const refs = [];
  for (const space of readSpaces()) {
    for (const page of Array.isArray(space.pages) ? space.pages : []) {
      if (String(page.shareId || "") !== wanted) continue;
      refs.push({ spaceId: space.id, ownerId: space.ownerId, slug: space.slug, pageId: page.id, path: page.path });
    }
  }
  return refs;
}

function syncSpaceShareVisibility(space) {
  if (!space) return;
  const shares = readDisplayShares();
  let changed = false;
  for (const page of Array.isArray(space.pages) ? space.pages : []) {
    const share = shares[String(page.shareId || "")];
    if (!share || String(share.userId || "") !== String(space.ownerId || "")) continue;
    const visibility = normalizeSpaceVisibility(space.visibility);
    if (share.visibility === visibility && !share.expiresAt) continue;
    shares[page.shareId] = {
      ...share,
      visibility,
      expiresAt: "",
      expiresMode: "permanent",
      expiresInDays: null,
      updatedAt: new Date().toISOString(),
    };
    changed = true;
  }
  if (changed) writeDisplayShares(shares);
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
  if (displayShareSpaceReferences(id).length > 0 && expiry.expiresMode !== "permanent") {
    return { status: 409, error: "Space 页面使用中的展示内容必须永久有效；请先从空间移除页面" };
  }
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
  if (displayShareSpaceReferences(id).length > 0) {
    return { status: 409, error: "展示内容仍被 Space 页面引用；请先从空间移除页面" };
  }
  delete shares[id];
  writeDisplayShares(shares);
  return { status: 200 };
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

function html(res, status, content, headers = {}) {
  const body = String(content || "");
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store, max-age=0",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    ...headers,
  });
  res.end(body);
}

async function readUrlEncodedBody(req) {
  const body = await readBody(req);
  return new URLSearchParams(String(body || ""));
}

function publicDisplayPayloadFromShare(root, share) {
  const scoped = resolveWorkspaceScopeRoot(root, {
    flowId: share.flowId || "",
    flowSource: share.flowSource || "user",
    archived: share.archived === true,
  }, { userId: share.userId || "" });
  if (scoped.error) return { error: scoped.error };
  const { graph } = readWorkspaceGraph(scoped.root, root);
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
      hasConnections: (Array.isArray(graph.edges) ? graph.edges : []).some((edge) => edge?.source === id || edge?.target === id),
      size: displayPageSizes[id] || workspaceSizes[id] || null,
      position: displayPagePositions[id] || workspacePositions[id] || null,
    };
  });
  const groups = (Array.isArray(graph.ui?.groups) ? graph.ui.groups : [])
    .map((group, index) => {
      const declaredMemberIds = Array.from(new Set((Array.isArray(group?.nodeIds) ? group.nodeIds : [])
        .map((id) => String(id || "").trim())
        .filter((id) => nodeIds.includes(id))));
      const groupX = Number(group?.x);
      const groupY = Number(group?.y);
      const groupWidth = Number(group?.width);
      const groupHeight = Number(group?.height);
      const inferredMemberIds = declaredMemberIds.length > 0 || ![groupX, groupY, groupWidth, groupHeight].every(Number.isFinite)
        ? []
        : nodeIds.filter((id) => {
            const position = workspacePositions[id];
            if (!position) return false;
            const size = workspaceSizes[id] || { width: 320, height: 96 };
            const centerX = Number(position.x || 0) + Math.max(1, Number(size.width) || 320) / 2;
            const centerY = Number(position.y || 0) + Math.max(1, Number(size.height) || 96) / 2;
            return centerX >= groupX && centerX <= groupX + groupWidth && centerY >= groupY && centerY <= groupY + groupHeight;
          });
      const memberIds = declaredMemberIds.length > 0 ? declaredMemberIds : inferredMemberIds;
      if (memberIds.length === 0) return null;
      const bounds = memberIds.reduce((acc, id) => {
        const position = displayPagePositions[id] || workspacePositions[id] || { x: 0, y: 0 };
        const size = displayPageSizes[id] || workspaceSizes[id] || { width: 520, height: 320 };
        const x = Number(position.x) || 0;
        const y = Number(position.y) || 0;
        const width = Math.max(1, Number(size.width) || 520);
        const height = Math.max(1, Number(size.height) || 320);
        return {
          minX: Math.min(acc.minX, x),
          minY: Math.min(acc.minY, y),
          maxX: Math.max(acc.maxX, x + width),
          maxY: Math.max(acc.maxY, y + height),
        };
      }, { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity });
      const padding = 52;
      return {
        id: String(group?.id || `group_${index + 1}`),
        title: String(group?.title || `Group ${index + 1}`),
        color: String(group?.color || "purple"),
        nodeIds: memberIds,
        position: { x: bounds.minX - padding, y: bounds.minY - padding },
        size: {
          width: Math.max(240, bounds.maxX - bounds.minX + padding * 2),
          height: Math.max(160, bounds.maxY - bounds.minY + padding * 2),
        },
      };
    })
    .filter(Boolean);
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
    groups,
  };
}

function adminWorkspaceRequestedUserContext(userCtx = {}) {
  const ownerId = String(userCtx.adminOwnerId || "").trim();
  if (!ownerId) return { userCtx };
  if (userCtx.isAdmin !== true) {
    return { error: "Admin permission required", status: 403 };
  }
  const owner = adminWorkspaceOwnerSummary(ownerId);
  if (!owner) return { error: "Workspace owner not found", status: 404 };
  return {
    owner,
    userCtx: {
      ...userCtx,
      userId: owner.userId,
      adminOwnerId: "",
    },
  };
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

function teamSummaryWithUsers(team) {
  if (!team) return null;
  const users = readAuthUsers();
  return {
    ...team,
    members: (team.members || []).map((userId) => ({
      userId,
      username: String(users[userId]?.username || userId),
      isAdmin: Boolean(users[userId]?.isAdmin),
    })),
  };
}

function listAccessibleProjectFlows(root, userCtx = {}) {
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
  return flows;
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
 * @returns {Promise<{ targetSpace: string, flowIdField: string, scheduleMode: string, file: Buffer, filename: string, gotFile: boolean }>}
 */
function parseFlowsImportForm(req) {
  return new Promise((resolve, reject) => {
    const bb = busboy({
      headers: req.headers,
      limits: { files: 1, fileSize: 10 * 1024 * 1024, parts: 32 },
    });
    let targetSpace = "user";
    let flowIdField = "";
    let scheduleMode = "disabled";
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
      if (name === "scheduleMode" && typeof val === "string") {
        scheduleMode = val.trim().toLowerCase();
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
        scheduleMode,
        file: Buffer.concat(chunks),
        filename,
        gotFile,
      });
    });
    bb.on("error", reject);
    req.pipe(bb);
  });
}

/** POST 写 flow */
function isValidFlowSourceWrite(s) {
  return s === "user" || s === "workspace";
}

function cleanupExpiredWorkspacePreviews(workspaceRoot = "") {
  const roots = new Set(listAgentflowUserIds().map((id) => getUserPipelinesRoot(id)));
  roots.add(getUserPipelinesRoot(""));
  if (workspaceRoot) {
    roots.add(path.join(path.resolve(workspaceRoot), PIPELINES_DIR, ARCHIVED_PIPELINES_DIR_NAME));
  }
  let removed = 0;
  for (const pipelinesRoot of roots) {
    const expired = [
      ...listExpiredWorkspacePreviews(pipelinesRoot),
      ...listExpiredWorkspaceDrafts(pipelinesRoot),
    ];
    for (const item of expired) {
      try {
        fs.rmSync(item.flowDir, { recursive: true, force: true });
        removed += 1;
      } catch (e) {
        log.debug(`[workspace-temporary] cleanup failed: ${(e && e.message) || String(e)}`);
      }
    }
  }
  return removed;
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

function resolvePrdWorkflowScope(workspaceRoot, params = {}, userCtx = {}, capability = "read") {
  const tapdId = String(params.tapdId || params.tapd_id || "").trim();
  const flowId = String(params.flowId || "").trim();
  const flowSource = String(params.flowSource || "user").trim() || "user";
  const archived = params.archived === true || params.archived === "1" || params.flowArchived === true;
  const adminOwnerId = String(params.adminOwnerId || userCtx.adminOwnerId || "").trim();
  if (adminOwnerId && userCtx.isAdmin !== true) {
    return { error: "Admin permission required", status: 403 };
  }
  const adminOwner = adminOwnerId ? adminWorkspaceOwnerSummary(adminOwnerId) : null;
  const adminVersionRepair = capability === "admin-version-repair";
  if (adminVersionRepair && userCtx.isAdmin !== true) {
    return { error: "Admin permission required", status: 403 };
  }
  if (adminOwnerId && !adminOwner) {
    return { error: "Workspace owner not found", status: 404 };
  }
  if (adminOwner && capability !== "read") {
    return { error: "Admin Workspace review is read-only", status: 403 };
  }
  const shareToken = String(params.workflowShare || params.workflow_share || "").trim();
  const linkCollaboration = shareToken ? getPrdWorkflowCollaborationByShareToken(shareToken) : null;
  if (shareToken && (!linkCollaboration || linkCollaboration.tapdId !== tapdId)) {
    return { error: "Workflow share link is invalid or has been revoked", status: 404 };
  }
  const memberCollaboration = tapdId
    ? getPrdWorkflowCollaborationForUser(tapdId, userCtx?.userId)
    : null;
  const existingCollaboration = tapdId ? getPrdWorkflowCollaborationByTapdId(tapdId) : null;
  if (!adminOwner && !linkCollaboration && existingCollaboration && !memberCollaboration && !adminVersionRepair) {
    return { error: "PRD Workflow collaboration permission denied", status: 403 };
  }
  if (adminVersionRepair && !existingCollaboration) {
    return { error: "PRD Workflow collaboration not found", status: 404 };
  }
  const collaboration = adminOwner ? null : (adminVersionRepair ? existingCollaboration : (linkCollaboration || memberCollaboration));
  const access = adminOwner
    ? { allowed: true, writable: false, role: "admin-viewer", via: "admin-review" }
    : adminVersionRepair
    ? { allowed: true, writable: true, role: "admin-version-repair", via: "admin-version-repair" }
    : linkCollaboration
    ? { allowed: true, writable: false, role: "viewer", via: "share-link" }
    : prdWorkflowCollaborationAccess(collaboration, userCtx?.userId);
  if (collaboration && !access.allowed) {
    return { error: "PRD Workflow collaboration permission denied", status: 403 };
  }
  if ((capability === "write" || adminVersionRepair) && (linkCollaboration || (collaboration && !access.writable))) {
    return { error: "PRD Workflow collaboration edit permission denied", status: 403 };
  }
  const ownerId = String(adminOwner?.userId || collaboration?.ownerId || userCtx?.userId || "").trim();
  const stateOwnerId = String(adminOwner?.userId || collaboration?.stateOwnerId || collaboration?.ownerId || userCtx?.userId || "").trim();
  const stateRoot = path.resolve(getAgentflowUserDataRoot(stateOwnerId));
  let executionRoot = path.resolve(workspaceRoot);
  if (flowId) {
    const projectScope = resolveWorkspaceScopeRoot(workspaceRoot, {
      flowId,
      flowSource,
      workspaceId: params.workspaceId || "",
      adminOwnerId,
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
    stateOwnerId,
    collaboration,
    collaborationAccess: access,
    shareToken,
    sharedByLink: Boolean(linkCollaboration),
    adminReadonly: Boolean(adminOwner),
    adminVersionRepair,
    flowId,
    flowSource,
    archived,
  };
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
  const { graph } = readWorkspaceGraph(scoped.root, root);
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
  writeWorkspaceGraph(scoped.root, graph, root);
  const workspaceSchedules = syncWorkspaceSchedulesForGraph(root, scoped, graph, authUser, userCtx);
  return { success: true, workspaceSchedules };
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
    "- 像普通 agent 请求一样处理用户说明：可能只是问问题，也可能要求编辑文件。不要因为存在 flowId 就默认修改流程。",
    "- 按需使用当前环境可用的 skills；如果用户点名某个 skill，遵循该 skill 的 SKILL.md。",
    "- 如果你判断需要编辑 AgentFlow 流程，可按需读取这些本地 skills：",
    "  - `skills/agentflow-flow-dsl/SKILL.md`：新建或修改 workspace.flow.js、节点、字段、连线、子流程与受控循环",
    "  - `skills/agentflow-node-dsl/SKILL.md`：仅在需要确定性自定义代码节点时使用",
    "  - `skills/agentflow-author-flow/SKILL.md`：需要 Draft、试运行、动态修改、发布或定时时使用完整生命周期",
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
  // 必须在监听请求和启动 scheduler 之前迁移。否则用户打开一个仅有 flow.yaml 的空画布后
  // 保存，可能反过来覆盖刚迁好的图。服务端直接使用实际数据根，不需要用户 Token。
  const startupMigration = runStartupStorageMigrations({ workspaceRoot: root });
  for (const attempted of startupMigration.attempted) {
    const summary = attempted.summary;
    log.info(
      `[storage-migration] ${attempted.kind}: migrated=${summary.migrated}, `
      + `needsDecision=${summary.needsDecision.length}, failed=${summary.failed.length}`,
    );
    for (const item of summary.needsDecision) log.warn(`[storage-migration] needs decision: ${item}`);
    for (const item of summary.failed) log.warn(`[storage-migration] failed: ${item}`);
  }
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

    if (url.pathname === "/api/auth/cli/device" && req.method === "POST") {
      let payload = {};
      try {
        const raw = await readBody(req);
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const authorization = createCliAuthorization({
        publicBaseUrl: serverPublicBaseUrl(req, host, uiPort),
        clientName: payload?.clientName,
      });
      json(res, 201, {
        requestId: authorization.requestId,
        deviceCode: authorization.deviceCode,
        userCode: authorization.userCode,
        verificationUrl: authorization.verificationUrl,
        expiresAt: authorization.expiresAt,
        pollInterval: authorization.pollInterval,
      });
      return;
    }

    if (url.pathname === "/api/auth/cli/token" && req.method === "POST") {
      let payload = {};
      try {
        const raw = await readBody(req);
        payload = raw ? JSON.parse(raw) : {};
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const result = exchangeCliAuthorization(payload?.deviceCode);
      if (!result.ok) {
        json(res, result.status || 400, {
          error: result.error,
          code: result.code || "invalid_request",
          authorization: result.authorization || undefined,
        });
        return;
      }
      json(res, 200, result);
      return;
    }

    if (url.pathname === "/api/auth/cli/revoke" && req.method === "POST") {
      const token = getSessionTokenFromRequest(req);
      if (!token || !getAuthUserFromRequest(req)) {
        json(res, 401, { error: "Unauthorized" });
        return;
      }
      revokeSessionToken(token);
      json(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/cli/authorize" && req.method === "GET") {
      const requestId = String(url.searchParams.get("request") || "").trim();
      const user = getAuthUserFromRequest(req);
      const result = getCliAuthorization(requestId, { includeApprovalNonce: Boolean(user) });
      if (result.ok && result.authorization.status !== "pending") {
        html(res, 200, renderCliAuthorizationResult({
          approved: result.authorization.status === "approved",
          clientName: result.authorization.clientName,
        }));
        return;
      }
      html(res, result.ok ? 200 : result.status || 404, renderCliAuthorizationPage({
        authorization: result.authorization || null,
        approvalNonce: result.approvalNonce || "",
        user,
        error: result.ok ? "" : result.error,
      }));
      return;
    }

    if (url.pathname === "/cli/authorize/login" && req.method === "POST") {
      const form = await readUrlEncodedBody(req);
      const requestId = String(form.get("request") || "").trim();
      const pending = getCliAuthorization(requestId);
      if (!pending.ok) {
        html(res, pending.status || 404, renderCliAuthorizationPage({ error: pending.error }));
        return;
      }
      const result = loginOrCreateUser(form.get("username"), form.get("password"));
      if (!result.ok) {
        html(res, result.forbidden ? 403 : 401, renderCliAuthorizationPage({
          authorization: pending.authorization,
          error: result.error || "Login failed",
        }));
        return;
      }
      res.writeHead(303, {
        Location: `/cli/authorize?request=${encodeURIComponent(requestId)}`,
        "Set-Cookie": buildSessionCookie(result.token),
        "Cache-Control": "no-store, max-age=0",
      });
      res.end();
      return;
    }

    if (url.pathname === "/cli/authorize/decision" && req.method === "POST") {
      const user = getAuthUserFromRequest(req);
      if (!user) {
        html(res, 401, renderCliAuthorizationResult({ error: "登录状态已失效，请重新打开授权链接。" }));
        return;
      }
      const form = await readUrlEncodedBody(req);
      const requestId = String(form.get("request") || "").trim();
      const current = getCliAuthorization(requestId);
      const approved = form.get("decision") === "approve";
      const result = decideCliAuthorization({
        requestId,
        approvalNonce: form.get("approvalNonce"),
        userId: user.userId,
        approved,
      });
      html(res, result.ok ? 200 : result.status || 400, renderCliAuthorizationResult({
        approved,
        clientName: current.authorization?.clientName,
        error: result.ok ? "" : result.error,
      }));
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
    const userCtx = authUser ? {
      userId: authUser.userId,
      isAdmin: Boolean(authUser.isAdmin),
      adminOwnerId: String(url.searchParams.get("adminOwnerId") || "").trim(),
    } : {};
    const legacyFlowManagementPath = new Set([
      "/api/flow/run-config",
      "/api/flow/schedule",
      "/api/flow/schedules",
      "/api/flow/schedule/disable",
      "/api/flow/run",
      "/api/flow/run/stop",
    ]);
    if (LEGACY_FLOW_EXECUTION_DISABLED && legacyFlowManagementPath.has(url.pathname)) {
      json(res, 410, { error: LEGACY_FLOW_EXECUTION_MESSAGE, code: "legacy_flow_execution_disabled" });
      return;
    }
    // PRD workflow 的路由整体搬去 prd-workflow-routes.mjs；这里只留一处派发
    if (await handlePrdWorkflowRoutes(req, res, {
      url, authUser, userCtx, root, host, uiPort,
      resolveWorkspaceScopeRoot, listAccessibleProjectFlows, findWorkspaceShareUser, teamSummaryWithUsers, readUserWorkspaces, adminWorkspaceOwnerSummary, normalizePublicBaseUrl, requestPublicBaseUrl, serverPublicBaseUrl, resolvePrdWorkflowScope, workflowBindableWorkspaces, prepareWorkflowKnowledgeWorktrees,
    })) return;

    if (req.method === "GET" && url.pathname === "/api/auth/session-token") {
      if (!authUser?.userId) {
        json(res, 401, { error: "Unauthorized" });
        return;
      }
      json(res, 200, { token: getSessionTokenFromRequest(req) || "" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/spaces/public") {
      try {
        const ownerId = String(url.searchParams.get("owner") || "").trim();
        const slug = String(url.searchParams.get("slug") || "").trim();
        const space = getSpaceByRoute(ownerId, slug);
        if (!space || (!canManageSpace(space, userCtx) && normalizeSpaceVisibility(space.visibility) === "private")) {
          json(res, 404, { error: "Space not found" });
          return;
        }
        if (space.status === "paused" && !canManageSpace(space, userCtx)) {
          json(res, 410, { error: "Space is paused" });
          return;
        }
        json(res, 200, {
          space: spacePublicSummary(space, requestPublicBaseUrl(req)),
          manageable: canManageSpace(space, userCtx),
        });
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/spaces") {
      if (!authUser?.userId) {
        json(res, 401, { error: "Unauthorized" });
        return;
      }
      const spaces = listSpacesForUser(userCtx.userId, userCtx.isAdmin)
        .map((space) => spacePublicSummary(space, requestPublicBaseUrl(req)));
      json(res, 200, { spaces });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/spaces") {
      if (!authUser?.userId) {
        json(res, 401, { error: "Unauthorized" });
        return;
      }
      try {
        const payload = JSON.parse(await readBody(req));
        const result = createSpace({
          ownerId: userCtx.userId,
          slug: payload.slug,
          title: payload.title,
          description: payload.description,
          visibility: payload.visibility,
        });
        if (result.error) {
          json(res, 400, { error: result.error });
          return;
        }
        json(res, 200, { ok: true, space: spacePublicSummary(result.space, requestPublicBaseUrl(req)) });
      } catch (e) {
        json(res, 400, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "PATCH" && url.pathname === "/api/spaces") {
      if (!authUser?.userId) {
        json(res, 401, { error: "Unauthorized" });
        return;
      }
      try {
        const payload = JSON.parse(await readBody(req));
        const current = getSpaceById(payload.id);
        if (!canManageSpace(current, userCtx)) {
          json(res, current ? 403 : 404, { error: current ? "Forbidden" : "Space not found" });
          return;
        }
        const result = updateSpace(payload.id, payload);
        if (result.error) {
          json(res, 400, { error: result.error });
          return;
        }
        syncSpaceShareVisibility(result.space);
        json(res, 200, { ok: true, space: spacePublicSummary(result.space, requestPublicBaseUrl(req)) });
      } catch (e) {
        json(res, 400, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/spaces/page") {
      if (!authUser?.userId) {
        json(res, 401, { error: "Unauthorized" });
        return;
      }
      try {
        const payload = JSON.parse(await readBody(req));
        const space = getSpaceById(payload.spaceId);
        if (!canManageSpace(space, userCtx)) {
          json(res, space ? 403 : 404, { error: space ? "Forbidden" : "Space not found" });
          return;
        }
        const { share } = getDisplayShareOrExpired(String(payload.shareId || "").trim());
        if (!share || (userCtx.isAdmin !== true && String(share.userId || "") !== String(userCtx.userId || ""))) {
          json(res, 400, { error: "Display share not found or not owned by current user" });
          return;
        }
        const foreignSpaceRef = displayShareSpaceReferences(share.id).find((ref) => ref.spaceId !== space.id);
        if (foreignSpaceRef) {
          json(res, 409, { error: "同一展示内容不能绑定到多个空间；请从 Workspace 重新生成一次展示" });
          return;
        }
        const result = upsertSpacePage(space.id, {
          title: payload.title,
          path: payload.path,
          shareId: share.id,
          hidden: payload.hidden === true,
        });
        if (result.error) {
          json(res, 400, { error: result.error });
          return;
        }
        syncSpaceShareVisibility(result.space);
        json(res, 200, {
          ok: true,
          page: result.page,
          space: spacePublicSummary(result.space, requestPublicBaseUrl(req)),
        });
      } catch (e) {
        json(res, 400, { error: (e && e.message) || String(e) });
      }
      return;
    }

    if (req.method === "DELETE" && url.pathname === "/api/spaces/page") {
      if (!authUser?.userId) {
        json(res, 401, { error: "Unauthorized" });
        return;
      }
      const space = getSpaceById(url.searchParams.get("spaceId") || "");
      if (!canManageSpace(space, userCtx)) {
        json(res, space ? 403 : 404, { error: space ? "Forbidden" : "Space not found" });
        return;
      }
      const result = deleteSpacePage(space.id, url.searchParams.get("pageId") || "");
      if (result.error) {
        json(res, 404, { error: result.error });
        return;
      }
      json(res, 200, { ok: true, space: spacePublicSummary(result.space, requestPublicBaseUrl(req)) });
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
        if (!canReadDisplayShare(share, userCtx)) {
          json(res, 404, { error: "Display share not found" });
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
        if (!canReadDisplayShare(share, userCtx)) {
          json(res, 404, { error: "Display share not found" });
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

    if (req.method === "GET" && url.pathname === "/api/teams/me") {
      const team = getTeamForUser(userCtx.userId);
      json(res, 200, { team: teamSummaryWithUsers(team) });
      return;
    }

    if (url.pathname === "/api/admin/teams") {
      if (!authUser?.isAdmin) {
        json(res, 403, { error: "Admin permission required" });
        return;
      }
      if (req.method === "GET") {
        const assigned = new Set(listTeams().flatMap((team) => team.members || []));
        const users = Object.entries(readAuthUsers()).map(([userId, user]) => ({
          userId,
          username: String(user?.username || userId),
          isAdmin: Boolean(user?.isAdmin),
          assigned: assigned.has(userId),
          teamId: getTeamForUser(userId, { includeInactive: true })?.id || "",
        }));
        json(res, 200, { teams: listTeams().map(teamSummaryWithUsers), users });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      let result;
      if (req.method === "POST") {
        result = createTeam(payload || {});
      } else if (req.method === "PATCH") {
        result = updateTeam(payload?.teamId, payload || {});
      } else if (req.method === "PUT") {
        const users = readAuthUsers();
        const memberIds = Array.isArray(payload?.members) ? payload.members.map((value) => String(value || "").trim().toLowerCase()) : [];
        const unknown = memberIds.find((userId) => !users[userId]);
        result = unknown
          ? { error: `用户不存在：${unknown}`, status: 404 }
          : setTeamMembers(payload?.teamId, memberIds);
      } else if (req.method === "DELETE") {
        result = deleteTeam(payload?.teamId);
      } else {
        json(res, 405, { error: "Method not allowed" });
        return;
      }
      if (result?.error) {
        json(res, result.status || 400, { error: result.error });
        return;
      }
      json(res, 200, { ok: true, ...result, teams: listTeams().map(teamSummaryWithUsers) });
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

    if (req.method === "GET" && url.pathname === "/api/admin/user-workspaces") {
      if (!authUser?.isAdmin) {
        json(res, 403, { error: "Admin permission required" });
        return;
      }
      const owner = adminWorkspaceOwnerSummary(url.searchParams.get("userId") || "");
      if (!owner) {
        json(res, 404, { error: "Workspace owner not found" });
        return;
      }
      try {
        const workspaces = listFlowsJson(root, { userId: owner.userId })
          .filter((flow) => (flow.source || "user") === "user")
          .map((flow) => ({
            id: String(flow.id || ""),
            source: "user",
            archived: flow.archived === true,
            description: String(flow.description || ""),
            ownerUserId: owner.userId,
            ownerUsername: owner.username,
            adminReadonly: true,
          }))
          .sort((a, b) => Number(a.archived) - Number(b.archived) || a.id.localeCompare(b.id));
        json(res, 200, { owner, workspaces });
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

    if (url.pathname === "/api/admin/users" || url.pathname === "/api/admin/users/reset-password") {
      if (!authUser?.isAdmin) {
        json(res, 403, { error: "Admin permission required" });
        return;
      }
      if (req.method === "GET" && url.pathname === "/api/admin/users") {
        json(res, 200, { users: listAuthUsers() });
        return;
      }
      if (req.method === "POST" && url.pathname === "/api/admin/users/reset-password") {
        let payload;
        try {
          payload = JSON.parse(await readBody(req));
        } catch {
          json(res, 400, { error: "Invalid JSON body" });
          return;
        }
        const targetUserId = String(payload?.userId || "").trim();
        if (targetUserId === userCtx.userId) {
          json(res, 400, { error: "不能在当前会话中重置自己的密码" });
          return;
        }
        const result = resetAuthUserPassword(targetUserId, payload?.password);
        if (!result.ok) {
          json(res, result.status || 400, { error: result.error || "Password reset failed" });
          return;
        }
        json(res, 200, result);
        return;
      }
      json(res, 405, { error: "Method not allowed" });
      return;
    }

    if (url.pathname === "/api/flows") {
      if (req.method === "GET") {
        try {
          const projectView = String(url.searchParams.get("view") || "all").trim().toLowerCase();
          const currentTeam = getTeamForUser(userCtx.userId);
          const flows = listAccessibleProjectFlows(root, userCtx);
          const visibleFlows = projectView === "team"
            ? flows.filter((flow) => (
                currentTeam
                && Array.isArray(flow.collaboration?.teamShares)
                && flow.collaboration.teamShares.some((share) => share.teamId === currentTeam.id)
              ))
            : projectView === "personal"
              ? flows.filter((flow) => (
                  !flow.collaboration
                  || flow.collaboration.ownerId === userCtx.userId
                  || flow.collaboration.members?.some((member) => member.userId === userCtx.userId)
                  || flow.source === "builtin"
                  || flow.source === "admin"
                ))
              : flows;
          json(res, 200, visibleFlows);
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
        const result = createEmptyFlow(root, flowId, targetSpace, { ...userCtx, description: desc });
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
      if (!["enabled", "disabled", "preserve"].includes(parsed.scheduleMode)) {
        json(res, 400, { error: "scheduleMode must be enabled, disabled, or preserve" });
        return;
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
        const v = validateImportedFlowSource(text, parsed.filename || "", {
          resolvePackage: packageResolverFor(scanAvailableNodePackages("", root)),
        });
        if (!v.ok) {
          json(res, 400, { error: v.error });
          return;
        }
        filesMap = new Map([[v.entryName, Buffer.from(text, "utf8")]]);
      }

      const w = writePipelineTree(root, flowId, targetSpace, filesMap, userCtx);
      if (!w.success) {
        json(res, 400, { error: w.error });
        return;
      }
      const targetDir = targetSpace === "workspace"
        ? path.join(path.resolve(root), PIPELINES_DIR, flowId)
        : path.join(getUserPipelinesRoot(userCtx.userId), flowId);
      let collaborationCreated = false;
      try {
        if (targetSpace === "workspace") {
          ensureWorkspaceCollaboration({ flowId, userId: userCtx.userId });
          collaborationCreated = true;
        }
        const scoped = resolveWorkspaceScopeRoot(root, { flowId, flowSource: targetSpace }, userCtx);
        if (scoped.error) throw new Error(scoped.error);
        const importedGraph = readWorkspaceGraph(scoped.root, root).graph;
        const graph = workspaceGraphWithScheduleMode(importedGraph, parsed.scheduleMode);
        if (graph !== importedGraph) writeWorkspaceGraph(scoped.root, graph, root);
        const persisted = readWorkspaceGraph(scoped.root, root).graph;
        const workspaceSchedules = syncWorkspaceSchedulesForGraph(root, scoped, persisted, authUser, userCtx);
        json(res, 200, {
          success: true,
          flowId,
          flowSource: targetSpace,
          scheduleMode: parsed.scheduleMode,
          workspaceSchedules,
        });
      } catch (e) {
        try { fs.rmSync(targetDir, { recursive: true, force: true }); } catch (_) {}
        if (collaborationCreated) deleteWorkspaceCollaborationForFlow(flowId, false);
        json(res, 500, {
          error: `Flow publication rolled back: ${(e && e.message) || String(e)}`,
          rolledBack: true,
        });
      }
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

    // Workspace 的路由整体搬去 workspace-routes.mjs；这里只留一处派发（必须在鉴权闸门之后）
    if (await handleWorkspaceRoutes(req, res, {
      url, authUser, userCtx, root, host,
      MIME, adminWorkspaceRequestedUserContext, broadcastWorkspaceCollaborationEvent, findWorkspaceShareUser, isValidFlowSourceRead, readUserWorkspaces, requestPublicBaseUrl, resolveWorkspaceScopeRoot, teamSummaryWithUsers, listConfiguredWorkspaces,
    })) return;

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
          adminOwnerId: payload.adminOwnerId || "",
          archived: payload.archived === true || payload.flowArchived === true,
        }, userCtx);
        if (scoped.error) {
          json(res, 400, { error: scoped.error });
          return;
        }
        if (scoped.adminReadonly) {
          json(res, 403, { error: "Admin Workspace review is read-only" });
          return;
        }
        const { graph } = readWorkspaceGraph(scoped.root, root);
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
          visibility: payload.visibility,
        });
        json(res, 200, { ok: true, share, url: `/display/${encodeURIComponent(share.id)}` });
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
      const requestedContext = adminWorkspaceRequestedUserContext(userCtx);
      if (requestedContext.error) {
        json(res, requestedContext.status || 403, { error: requestedContext.error });
        return;
      }
      const result = readFlowJson(root, flowId, flowSource, { archived: flowArchived, ...requestedContext.userCtx });
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
      const dirRes = resolveFlowDirAbs(root, flowId, flowSource, { archived: false, ...userCtx });
      if (dirRes.error || !dirRes.dir) {
        json(res, 404, { error: dirRes.error || "找不到流水线" });
        return;
      }
      const fromDir = dirRes.dir;
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

    if (req.method === "POST" && url.pathname === "/api/flow/restore") {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return;
      }
      const flowId = typeof payload.flowId === "string" ? payload.flowId.trim() : "";
      const flowSource = payload.flowSource || "user";
      if (!flowId) {
        json(res, 400, { error: "Missing or invalid flowId" });
        return;
      }
      if (flowSource !== "user" && flowSource !== "workspace") {
        json(res, 400, { error: "仅支持恢复用户目录或工作区流水线" });
        return;
      }
      const collaborationDenied = workspaceFlowCollaborationGuard(flowId, flowSource, true, userCtx, "owner");
      if (collaborationDenied) {
        json(res, collaborationDenied.status, { error: collaborationDenied.error });
        return;
      }
      const result = restoreArchivedFlowPipeline(root, flowId, flowSource, userCtx);
      if (!result.success) {
        json(res, 400, { error: result.error || "恢复失败" });
        return;
      }
      updateWorkspaceCollaborationFlow({
        previousFlowId: flowId,
        previousArchived: true,
        flowSource,
        ownerId: userCtx.userId,
        flowId,
        archived: false,
      });
      json(res, 200, { success: true, flowId, flowSource, archived: false });
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

    if (req.method === "GET" && url.pathname === "/api/schedules") {
      try {
        // 旧 Pipeline schedule 随 Start/End 执行一并下线：它们只会驱动已废弃的
        // `agentflow apply`，列出来只会给用户永远不会触发的条目。
        const workspaceSchedules = listWorkspaceScheduleStatuses(root, userCtx);
        json(res, 200, {
          schedules: [...workspaceSchedules].sort((a, b) => {
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
        json(res, 410, { error: LEGACY_FLOW_EXECUTION_MESSAGE, code: "legacy_flow_execution_disabled" });
        return;
      }
      json(res, 400, { error: "Invalid schedule kind" });
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

    const workspaceDeferredRunTimer = setInterval(() => {
      try {
        pollWorkspaceDeferredRuns(root);
      } catch (e) {
        log.debug(`[workspace-deferred] poll failed: ${(e && e.message) || String(e)}`);
      }
    }, WORKSPACE_DEFERRED_RUN_POLL_MS);
    try {
      workspaceDeferredRunTimer.unref?.();
    } catch (_) {}
    server.on("close", () => clearInterval(workspaceDeferredRunTimer));
    setTimeout(() => {
      try {
        pollWorkspaceDeferredRuns(root);
      } catch (e) {
        log.debug(`[workspace-deferred] initial poll failed: ${(e && e.message) || String(e)}`);
      }
    }, 500).unref?.();
  }

  const workspacePreviewCleanupTimer = setInterval(() => {
    try {
      const removed = cleanupExpiredWorkspacePreviews(root);
      if (removed > 0) log.debug(`[workspace-preview] removed ${removed} expired preview project(s)`);
    } catch (e) {
      log.debug(`[workspace-preview] cleanup poll failed: ${(e && e.message) || String(e)}`);
    }
  }, 60_000);
  try {
    workspacePreviewCleanupTimer.unref?.();
  } catch (_) {}
  server.on("close", () => clearInterval(workspacePreviewCleanupTimer));
  try {
    cleanupExpiredWorkspacePreviews(root);
  } catch (_) {}

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      log.debug(`[ui] server listening on ${host}:${port}, workspace=${root}, static=${staticDir}`);
      updateModelLists(root).catch(() => {});
      resolve(server);
    });
  });
}
