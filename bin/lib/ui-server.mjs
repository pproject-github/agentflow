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
import { pathToFileURL } from "url";
import { execFile, spawn } from "child_process";
import busboy from "busboy";
import sharp from "sharp";
import { log } from "./log.mjs";
import {
  resolveFlowDirAbs,
  listFlowsJson,
  listNodesJson,
  readFlowJson,
  readNodeDetailJson,
  readNodeFilePreview,
} from "./catalog-flows.mjs";
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
import { startComposerAgent } from "./composer-agent.mjs";
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
  isFlowDir,
} from "./paths.mjs";
import {
  loadResourcesForSkillKeys,
  listComposerSkills,
  readComposerSkillDetail,
  buildSkillCompactInjectionBlock,
} from "./composer-skill-router.mjs";
import { clearSkillRegistryCache } from "./skill-registry.mjs";
import { listRecentRunsFromDisk } from "./recent-runs.mjs";
import {
  unzipAndNormalizePipelineZip,
  validateImportedFlowYaml,
  writePipelineTree,
} from "./flow-import.mjs";
import { getWorkspaceTree, getPipelineFiles } from "./workspace-tree.mjs";
import {
  DEFAULT_WORKSPACE_PREVIEW_TTL_MS,
  createWorkspacePreviewId,
  listExpiredWorkspacePreviews,
  normalizeWorkspacePreviewTtlMs,
  readWorkspacePreviewMetadata,
  workspacePreviewFlowDir,
  writeWorkspacePreviewMetadata,
} from "./workspace-preview.mjs";
import { LEGACY_FLOW_EXECUTION_DISABLED, LEGACY_FLOW_EXECUTION_MESSAGE } from "./legacy-flow-execution.mjs";
import {
  listRecentComposerSessions,
  parseComposerLogFile,
  readComposerSessionMeta,
} from "./composer-log.mjs";
import {
  mergeWorkspaceGraphs,
  workspaceDesignRevision,
  workspaceRuntimeRevision,
} from "./workspace-graph-merge.mjs";
import {
  WorkspaceFlowParseError,
} from "./workspace-flow-store.mjs";
import {
  deleteMarketplaceFlowSnippetPackage,
  deleteMarketplaceNodePackage,
  installFlowDependency,
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
  getAuthUserFromRequest,
  getSessionTokenFromRequest,
  isAuthUserAllowed,
  listAuthUsers,
  loginOrCreateUser,
  logoutRequest,
  readAuthUsers,
  readUserAllowlist,
  resetAuthUserPassword,
  writeUserAllowlist,
} from "./auth.mjs";
import { readGlobalEnvRows, readMergedEnvObject, readUserEnvRows, writeGlobalEnvRows, writeUserEnvRows } from "./user-env.mjs";
import {
  readAdminBuiltinPipelineConfig,
  updateAdminBuiltinPipelineConfig,
} from "./admin-builtin-pipelines.mjs";
import { readAdminStorageConfig, writeAdminStorageConfig } from "./admin-storage-config.mjs";
import {
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
  removeWorkspaceCollaborationTeamShare,
  setWorkspaceCollaborationTeamShare,
  updateWorkspaceCollaborationFlow,
  workspaceCollaborationAccess,
} from "./workspace-collaboration.mjs";
import {
  getPrdWorkflowCollaborationByShareToken,
  getPrdWorkflowCollaborationByTapdId,
  getPrdWorkflowCollaborationForUser,
  prdWorkflowCollaborationAccess,
} from "./prd-workflow-collaboration.mjs";
import {
  createTeam,
  deleteTeam,
  getTeamById,
  getTeamForUser,
  listTeams,
  setTeamMembers,
  updateTeam,
} from "./teams.mjs";
import {
} from "./workflow-report.mjs";

// 从 ui-server 拆出去的 PRD workflow 子系统；路由仍在下面的 startUiServer 里
import {
  workflowKnowledgeSummary,
  workflowRepositoryRef,
} from "./prd-workflow-server.mjs";
import { execFileBuffered } from "./exec-buffered.mjs";
import { htmlEscapeAttribute } from "./html-escape.mjs";
import { handlePrdWorkflowRoutes } from "./prd-workflow-routes.mjs";
import { json, readBody } from "./http-util.mjs";

// 从 ui-server 拆出去的 Workspace 子系统；路由仍在下面的 startUiServer 里
import {
  USER_WORKSPACES_FILENAME,
  WORKSPACE_SCHEDULE_POLL_MS,
  activeWorkspaceRunUsageRecords,
  activeWorkspaceRuns,
  adminWorkspaceOwnerSummary,
  appendWorkspaceRunFinished,
  appendWorkspaceRunStarted,
  checkCursorMcpServers,
  createDisplayShareRecord,
  cursorMcpConfigPath,
  displayShareOutputUrl,
  hydrateWorkspaceGraphForRuntime,
  isReadonlyBuiltinFlowSource,
  isTransientAgentNetworkError,
  isValidFlowSourceRead,
  isWorkspaceRunAbortError,
  listWorkspaceScheduleStatuses,
  listWorkspaceScheduleStatusesForFlow,
  mergeWorkspacePersistentNodeRefs,
  mergeWorkspaceRunGraph,
  normalizeDisplayShareExpiry,
  normalizeDisplayShareNodeIds,
  normalizeMcpServerConfig,
  normalizeWorkspaceEntry,
  normalizeWorkspaceScheduledRunConfig,
  parseJsonText,
  readCursorMcpConfig,
  readCursorMcpServers,
  readDisplayShares,
  readUserMcpPrivate,
  readWorkspaceConversations,
  readWorkspaceFiles,
  readWorkspaceGraph,
  readWorkspaceRunUsageRecords,
  readWorkspaceScheduleRegistry,
  readWorkspacesFromPath,
  resolveWorkspaceFilePath,
  resolveWorkspaceScopeRoot,
  runStatusBucket,
  runWorkspaceGraph,
  runWorkspaceScheduledEntry,
  sleepMs,
  syncWorkspaceSchedulesForGraph,
  updateWorkspaceScheduleEntry,
  userMcpPrivatePath,
  workspaceActiveRunsForScope,
  workspaceCollaborationEventKey,
  workspaceCollaborationSequences,
  workspaceCollaborationSubscribers,
  workspaceCollaborationSummaryWithUsers,
  workspaceDesignPath,
  workspaceDisplayContentFromInstance,
  workspaceDisplayKindFromInstance,
  workspaceDisplayTextFilePath,
  workspaceDownloadContentDisposition,
  workspaceFindActiveRunConflict,
  workspaceFlowCollaborationGuard,
  workspaceGraphAsSource,
  workspaceOptimizeRunImplementations,
  workspaceRepoUrlWithCredential,
  workspaceRunControl,
  workspaceRunEntryKey,
  workspaceRunKey,
  workspaceRunPlan,
  workspaceRunPlanNodeIds,
  workspaceRunTouchedNodeIds,
  workspaceRuntimeNodeLabel,
  workspaceScheduleNextRunAt,
  workspaceScopedUserContext,
  workspaceSearchGuardrailsBlock,
  workspaceUnwrapOutputEnvelopeForDisplay,
  workspacesPath,
  writeDisplayShares,
  writeWorkspaceConversations,
  writeWorkspaceGraph,
} from "./workspace-server.mjs";

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

/**
 * 落盘并给出**磁盘上那张图**的版本号。
 *
 * 存图必须走这里，不能自己 `writeWorkspaceGraph` 完拿手里那张图去算 revision：代码化会
 * 做规范化，两者对不上，客户端就会攥着一个磁盘上不存在的版本号，下一次保存直接被判成
 * 「基线不匹配」。协作场景里这意味着谁都存不进去。
 *
 * @returns {{ graph: object, path: string, revision: string, runtimeRevision: string, result: object }}
 */
function commitWorkspaceGraph(workspaceRoot, scoped, graph, userCtx) {
  const result = writeWorkspaceGraph(scoped.root, graph);
  const persisted = hydrateWorkspaceGraphForRuntime(workspaceRoot, scoped, result.graph, userCtx);
  return {
    graph: persisted,
    path: workspaceDesignPath(scoped.root),
    revision: workspaceDesignRevision(persisted),
    runtimeRevision: workspaceRuntimeRevision(persisted),
    result,
  };
}

const DISPLAY_SHARE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NODE_STUDIO_DRAFTS_DIRNAME = "node-studio/drafts";
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

function buildWorkspaceGeneratePrompt(payload) {
  const userPrompt = String(payload?.prompt || "").trim();
  const outputKind = String(payload?.outputKind || payload?.kind || "markdown").trim().toLowerCase();
  const allowFlowYaml = payload?.allowFlowYaml === true || payload?.allowFlowYaml === "1";
  const workspaceGraph = payload?.workspaceGraph && typeof payload.workspaceGraph === "object" ? payload.workspaceGraph : null;
  // 图以代码形态给模型看：同一张图 JSON 要几万 token，代码几千，而且 `output-1 -> input-2`
  // 这种下标边模型根本读不出连的是什么槽。生成失败就退回 JSON——上下文缺失比报错更糟。
  const workspaceGraphBlock = workspaceGraph ? workspaceGraphAsSource(workspaceGraph) : "";
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
            "默认不要修改 workspace.flow.js，不要新增/删除/重连画布节点；只有当用户明确要求“更新画布、加节点、改连线、展示成节点、生成流程”时，才编辑 workspace.flow.js。",
            "如果用户请求生成或恢复文档/文件，可以直接在 workspace 文件系统中完成，最终只输出简短结果：改了什么、路径在哪里、是否需要下一步。",
            "不要在最终回答中列出过程性步骤，例如“先查看结构”“继续检索”“正在生成”；这些属于执行过程，不属于最终结果。",
          ].join("\n");
  return [
    "你正在 AgentFlow 的 Workspace 工作画布中执行任务。",
    "Workspace 是当前 pipeline 的临时工作区，用于分析、试验、生成中间文件和展示结果。",
    "Workspace 与 Pipeline 各自有独立的 Skill collection；此处只使用当前 Workspace Composer 选择的 collections / skills 作为本次行为规则与编辑依据。",
    "当 Skills 提到修改 flow.yaml / instances / edges / ui 时，在 Workspace 视图下应映射为修改当前工作区的 workspace.flow.js，除非用户显式勾选并要求修改正式 flow.yaml。",
    "画布就是代码：workspace.flow.js 是受限 ESM——`flow()` 是入口，一个节点是一次 `const 变量名 = 类型(\"显示名\", { 引脚 }, 正文)`，引用上游变量的引脚就是一条数据线。它永不执行，只被静态解析，所以里面禁止一切控制流（if / for / await / .map / 箭头函数 / 动态属性）。要写逻辑就建代码节点 nodes/<name>/index.mjs，那里是普通 JS。",
    "workspace.layout.json（坐标）、workspace.nodes.json（图片等机器属性）、workspace.state.json（运行产出）都由平台维护，不要手改。",
    "改完必须跑 `agentflow flow dsl lint <flowDir>` 自查；语法或引脚写错会让整张画布打不开。完整语法见 agentflow-flow-dsl skill。",
    allowFlowYaml
      ? "用户已允许你考虑正式 flow.yaml；如需修改仍必须明确说明影响。"
      : "默认不要修改正式 flow.yaml；优先在 workspace 文件、workspace.flow.js 或回复内容中完成任务。",
    workspaceSearchGuardrailsBlock(),
    workspaceGraphBlock,
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

/** POST 写 flow */
function isValidFlowSourceWrite(s) {
  return s === "user" || s === "workspace";
}

function cleanupExpiredWorkspacePreviews() {
  const roots = new Set(listAgentflowUserIds().map((id) => getUserPipelinesRoot(id)));
  roots.add(getUserPipelinesRoot(""));
  let removed = 0;
  for (const pipelinesRoot of roots) {
    for (const item of listExpiredWorkspacePreviews(pipelinesRoot)) {
      try {
        fs.rmSync(item.flowDir, { recursive: true, force: true });
        removed += 1;
      } catch (e) {
        log.debug(`[workspace-preview] cleanup failed: ${(e && e.message) || String(e)}`);
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
  writeWorkspaceGraph(scoped.root, graph);
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
          adminOwnerId: payload.adminOwnerId || "",
          archived,
        }, userCtx);
        if (scoped.error) {
          json(res, scoped.status || 400, { error: scoped.error });
          return;
        }
        if (scoped.adminReadonly) {
          json(res, 403, { error: "Admin Workspace review is read-only" });
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

    if (url.pathname === "/api/workspace/collaboration/team-share" && (req.method === "POST" || req.method === "DELETE")) {
      try {
        const payload = JSON.parse(await readBody(req));
        const flowId = String(payload?.flowId || "").trim();
        const flowSource = String(payload?.flowSource || "user").trim();
        const archived = payload?.archived === true || payload?.flowArchived === true;
        if (!flowId || (flowSource !== "workspace" && flowSource !== "user")) {
          json(res, 400, { error: "当前 Project 不支持团队分享" });
          return;
        }
        const targetTeam = getTeamById(payload?.teamId);
        const actorTeam = getTeamForUser(userCtx.userId);
        if (!targetTeam || targetTeam.status !== "active") {
          json(res, 404, { error: "团队不存在或已停用" });
          return;
        }
        if (!authUser?.isAdmin && actorTeam?.id !== targetTeam.id) {
          json(res, 403, { error: "只能分享给自己所在的团队" });
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
        const result = req.method === "POST"
          ? setWorkspaceCollaborationTeamShare({
              workspaceId: ensured.workspace.id,
              userId: userCtx.userId,
              teamId: targetTeam.id,
              role: payload?.role,
            })
          : removeWorkspaceCollaborationTeamShare({
              workspaceId: ensured.workspace.id,
              userId: userCtx.userId,
              teamId: targetTeam.id,
            });
        if (result.error) {
          json(res, result.status || 400, { error: result.error });
          return;
        }
        const record = getWorkspaceCollaborationForProject({ workspaceId: ensured.workspace.id });
        json(res, 200, {
          ok: true,
          workspace: workspaceCollaborationSummaryWithUsers(record, userCtx.userId),
          team: teamSummaryWithUsers(targetTeam),
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
      const key = workspaceCollaborationEventKey(
        workspaceScopedUserContext(scoped, userCtx),
        scoped.flowSource,
        scoped.flowId,
        scoped.archived,
      );
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

    if (req.method === "POST" && url.pathname === "/api/workspace/preview") {
      if (!authUser?.userId) {
        json(res, 401, { error: "Authentication required" });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(await readBody(req, 4 * 1024 * 1024));
      } catch {
        json(res, 400, { error: "Invalid JSON" });
        return;
      }
      const graph = payload?.graph;
      if (!graph || typeof graph !== "object" || Array.isArray(graph)) {
        json(res, 400, { error: "graph must be an object" });
        return;
      }
      const instances = graph.instances && typeof graph.instances === "object" && !Array.isArray(graph.instances)
        ? graph.instances
        : {};
      if (Object.values(instances).some((item) => String(item?.definitionId || "") === "workspace_scheduled_run")) {
        json(res, 400, { error: "Temporary Workspace preview cannot contain scheduled-run nodes" });
        return;
      }
      const rawRequestedId = String(payload.previewId || "").trim();
      const flowId = rawRequestedId || createWorkspacePreviewId();
      const flowDir = workspacePreviewFlowDir(flowId, authUser.userId);
      if (!flowDir) {
        json(res, 400, { error: "Invalid previewId" });
        return;
      }
      const existing = readWorkspacePreviewMetadata(flowDir);
      if (existing && existing.ownerId !== authUser.userId) {
        json(res, 403, { error: "Preview ownership denied" });
        return;
      }
      if (rawRequestedId && !existing && fs.existsSync(flowDir)) {
        json(res, 409, { error: "Preview project already exists but is not a preview" });
        return;
      }
      const now = Date.now();
      const ttlInput = payload.ttlMs != null
        ? Number(payload.ttlMs)
        : payload.ttlSeconds != null
          ? Number(payload.ttlSeconds) * 1000
          : DEFAULT_WORKSPACE_PREVIEW_TTL_MS;
      const ttlMs = normalizeWorkspacePreviewTtlMs(ttlInput);
      const metadata = {
        version: 1,
        flowId,
        ownerId: authUser.userId,
        title: String(payload.title || "Workspace Preview").trim().slice(0, 200),
        createdAt: existing?.createdAt || new Date(now).toISOString(),
        updatedAt: new Date(now).toISOString(),
        expiresAt: new Date(now + ttlMs).toISOString(),
      };
      try {
        fs.mkdirSync(flowDir, { recursive: true });
        writeWorkspaceGraph(flowDir, graph);
        writeWorkspacePreviewMetadata(flowDir, metadata);
      } catch (e) {
        json(res, 500, { error: (e && e.message) || String(e) });
        return;
      }
      const baseUrl = `${url.protocol}//${url.host}`;
      const workspaceUrl = `${baseUrl}/workspace?flowId=${encodeURIComponent(flowId)}&flowSource=user`;
      json(res, 200, { ok: true, flowId, flowSource: "user", preview: true, expiresAt: metadata.expiresAt, url: workspaceUrl });
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
        const scopedUserCtx = workspaceScopedUserContext(scoped, userCtx);
        const hydratedGraph = hydrateWorkspaceGraphForRuntime(root, scoped, graph, scopedUserCtx);
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
            && scoped.adminReadonly !== true
            && collaborationAccess.writable !== false,
          collaboration: workspaceCollaborationSummaryWithUsers(scoped.collaboration, userCtx.userId),
          adminReview: scoped.adminReadonly ? {
            readonly: true,
            ownerUserId: scoped.ownerUserId,
            ownerUsername: scoped.ownerUsername,
          } : null,
          workspaceSchedules: listWorkspaceScheduleStatusesForFlow(scopedUserCtx, scoped.flowSource || "user", scoped.flowId || ""),
        });
      } catch (e) {
        // 流程文件语法错时给出可修的定位，而不是一句 500——这条路径就是手改 / AI 改
        // workspace.flow.js 之后最常撞上的
        if (e instanceof WorkspaceFlowParseError) {
          json(res, 422, { error: e.message, path: e.filePath, kind: "flow_source_parse_error" });
          return;
        }
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
          adminOwnerId: payload.adminOwnerId || "",
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
        const committed = commitWorkspaceGraph(root, scoped, graph, userCtx);
        const { path: graphPath, revision, runtimeRevision } = committed;
        const workspaceSchedules = syncWorkspaceSchedulesForGraph(root, scoped, committed.graph, authUser, userCtx);
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
          graph: committed.graph,
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
        const scoped = resolveWorkspaceScopeRoot(root, {
          flowId,
          flowSource,
          archived: url.searchParams.get("archived") === "1",
        }, userCtx);
        if (scoped.error) {
          json(res, scoped.status || 400, { error: scoped.error });
          return;
        }
        json(res, 200, {
          schedules: listWorkspaceScheduleStatusesForFlow(
            workspaceScopedUserContext(scoped, userCtx),
            flowSource,
            flowId,
          ),
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
          adminOwnerId: payload.adminOwnerId || "",
          archived: payload.archived === true || payload.flowArchived === true,
        }, userCtx);
        if (scoped.error) {
          json(res, 400, { error: scoped.error });
          return;
        }
        if (scoped.collaborationAccess?.runnable === false) {
          json(res, 403, { error: "Workspace run permission denied" });
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
          adminOwnerId: payload.adminOwnerId || "",
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
        const result = await workspaceOptimizeRunImplementations(root, scoped.root, payload, userCtx, {
          emit: () => {},
        });
        const currentGraph = readWorkspaceGraph(scoped.root).graph;
        const touchedIds = new Set((result.optimized || []).map((item) => item.nodeId).filter(Boolean));
        const mergedGraph = mergeWorkspaceRunGraph(currentGraph, result.graph, touchedIds);
        const committed = commitWorkspaceGraph(root, scoped, mergedGraph, userCtx);
        const { path: graphPath, revision } = committed;
        const workspaceSchedules = syncWorkspaceSchedulesForGraph(root, scoped, committed.graph, authUser, userCtx);
        broadcastWorkspaceCollaborationEvent(userCtx, scoped.flowSource, scoped.flowId, scoped.archived, {
          type: "graph.committed",
          revision,
          actorId: userCtx.userId || "",
          clientId: String(payload.clientId || ""),
        });
        json(res, 200, {
          ok: true,
          path: graphPath,
          graph: committed.graph,
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
          adminOwnerId: payload.adminOwnerId || "",
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
            const committed = commitWorkspaceGraph(root, scoped, mergedGraph, userCtx);
            const { path: graphPath, revision, runtimeRevision } = committed;
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
            writeEvent({ type: "done", ok: true, path: graphPath, graph: committed.graph, revision, runtimeRevision, order: result.order, touchedNodeIds: Array.from(touchedIds), pauseNodeIds: result.pauseNodeIds || [] });
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
          const currentGraph = readWorkspaceGraph(scoped.root).graph;
          const touchedIds = workspaceRunTouchedNodeIds(result);
          const mergedGraph = mergeWorkspaceRunGraph(currentGraph, result.graph, touchedIds);
          const committed = commitWorkspaceGraph(root, scoped, mergedGraph, userCtx);
          const { path: graphPath, revision, runtimeRevision } = committed;
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
          json(res, 200, { ok: true, path: graphPath, ...result, graph: committed.graph, revision, runtimeRevision, touchedNodeIds: Array.from(touchedIds) });
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
        const scopedUserCtx = workspaceScopedUserContext(scoped, userCtx);
        json(res, 200, {
          runs: listWorkspaceRunLogs({
            userId: flowSource === "workspace" ? "" : scopedUserCtx.userId || "",
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
        const scopedUserCtx = workspaceScopedUserContext(scoped, userCtx);
        const run = listWorkspaceRunLogs({
          userId: flowSource === "workspace" ? "" : scopedUserCtx.userId || "",
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
      const scopeKey = workspaceRunKey(workspaceScopedUserContext(scoped, userCtx), flowSource, flowId);
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
        adminOwnerId: payload.adminOwnerId || "",
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
          adminOwnerId: payload.adminOwnerId || "",
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
          adminOwnerId: payload.adminOwnerId || "",
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
          adminOwnerId: parsed.fields.adminOwnerId || "",
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
          adminOwnerId: payload.adminOwnerId || "",
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
          adminOwnerId: payload.adminOwnerId || "",
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
          adminOwnerId: req.method === "POST" ? (payload.adminOwnerId || "") : "",
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
          adminOwnerId: payload.adminOwnerId || "",
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
          adminOwnerId: payload.adminOwnerId || "",
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
        const requestedContext = adminWorkspaceRequestedUserContext(userCtx);
        if (requestedContext.error) {
          json(res, requestedContext.status || 403, { error: requestedContext.error });
          return;
        }
        const { setLanguage } = await import("./i18n.mjs");
        setLanguage(lang);
        json(res, 200, listNodesJson(root, flowId || "", flowId ? flowSource : "", {
          archived: nodesArchived,
          ...requestedContext.userCtx,
          marketplaceScope,
        }));
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
        const requestedContext = adminWorkspaceRequestedUserContext(userCtx);
        if (requestedContext.error) {
          json(res, requestedContext.status || 403, { error: requestedContext.error });
          return;
        }
        const detail = readNodeDetailJson(root, nodeId, flowId, flowId ? (flowSource || "user") : "", {
          archived,
          ...requestedContext.userCtx,
        });
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
  }

  const workspacePreviewCleanupTimer = setInterval(() => {
    try {
      const removed = cleanupExpiredWorkspacePreviews();
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
    cleanupExpiredWorkspacePreviews();
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
