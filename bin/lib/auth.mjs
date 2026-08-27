import crypto from "crypto";
import fs from "fs";
import path from "path";
import {
  ARCHIVED_PIPELINES_DIR_NAME,
  getAgentflowDataRoot,
  getUserPipelinesRoot,
  sanitizeAgentflowUserId,
  isFlowDir,
} from "./paths.mjs";

const SESSION_COOKIE = "af_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CLI_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CAS_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const CLI_AUTHORIZATION_TTL_MS = 10 * 60 * 1000;
const CLI_AUTHORIZATION_SCOPES = [
  "workspace:read",
  "workspace:write",
  "workspace:run",
  "flow:publish",
  "schedule:manage",
  "node-package:manage",
  "workflow:manage",
];

function authRoot() {
  return path.join(getAgentflowDataRoot(), "auth");
}

function usersPath() {
  return path.join(authRoot(), "users.json");
}

function sessionsPath() {
  return path.join(authRoot(), "sessions.json");
}

function cliAuthorizationsPath() {
  return path.join(authRoot(), "cli-authorizations.json");
}

function userAllowlistPath() {
  return path.join(authRoot(), "user-allowlist.json");
}

function readJsonObject(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return data && typeof data === "object" && !Array.isArray(data) ? data : {};
  } catch {
    return {};
  }
}

function writeJsonObject(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data && typeof data === "object" ? data : {}, null, 2) + "\n", "utf-8");
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password, record) {
  if (!record || typeof record.salt !== "string" || typeof record.hash !== "string") return false;
  const next = hashPassword(password, record.salt).hash;
  try {
    return crypto.timingSafeEqual(Buffer.from(next, "hex"), Buffer.from(record.hash, "hex"));
  } catch {
    return false;
  }
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function createSessionForUser(userId, options = {}) {
  const users = readAuthUsers();
  const user = users[userId];
  if (!user) return { ok: false, error: "用户不存在" };
  const now = Date.now();
  const token = crypto.randomBytes(32).toString("base64url");
  const sessions = readJsonObject(sessionsPath());
  sessions[hashToken(token)] = {
    userId,
    kind: String(options.kind || "web"),
    clientName: String(options.clientName || "").trim(),
    scopes: Array.isArray(options.scopes) ? options.scopes.map(String).filter(Boolean) : [],
    createdAt: now,
    expiresAt: now + (Number(options.ttlMs) || SESSION_TTL_MS),
  };
  writeJsonObject(sessionsPath(), sessions);
  return {
    ok: true,
    token,
    expiresAt: sessions[hashToken(token)].expiresAt,
    user: {
      userId,
      username: user.username || userId,
      isAdmin: Boolean(user.isAdmin),
      authProvider: String(user.authProvider || (user.salt && user.hash ? "password" : "cas")),
    },
  };
}

function purgeExpiredCliAuthorizations(authorizations, now = Date.now()) {
  let changed = false;
  for (const [requestId, record] of Object.entries(authorizations)) {
    if (Number(record?.expiresAt) > now && record?.status !== "consumed") continue;
    delete authorizations[requestId];
    changed = true;
  }
  return changed;
}

function normalizedCliClientName(value) {
  const text = String(value || "AgentFlow CLI").trim().slice(0, 80);
  return text || "AgentFlow CLI";
}

function cliAuthorizationSummary(requestId, record) {
  if (!record) return null;
  return {
    requestId,
    userCode: String(record.userCode || ""),
    clientName: String(record.clientName || "AgentFlow CLI"),
    scopes: Array.isArray(record.scopes) ? record.scopes.map(String) : [],
    status: String(record.status || "pending"),
    createdAt: Number(record.createdAt) || 0,
    expiresAt: Number(record.expiresAt) || 0,
    approvedUserId: String(record.approvedUserId || ""),
  };
}

function randomUserCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i += 1) out += alphabet[bytes[i] % alphabet.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || "").split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function bearerTokenFromAuthHeader(header) {
  const raw = String(header || "").trim();
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : "";
}

export function readAuthUsers() {
  return readJsonObject(usersPath());
}

export function listAuthUsers() {
  return Object.entries(readAuthUsers())
    .map(([userId, user]) => ({
      userId,
      username: String(user?.username || userId),
      isAdmin: Boolean(user?.isAdmin),
      authProvider: String(user?.authProvider || (user?.salt && user?.hash ? "password" : "cas")),
      casUsername: String(user?.casUsername || ""),
      createdAt: String(user?.createdAt || ""),
      updatedAt: String(user?.updatedAt || user?.createdAt || ""),
    }))
    .sort((left, right) => left.username.localeCompare(right.username));
}

export function resetAuthUserPassword(userId, password) {
  const normalizedUserId = sanitizeAgentflowUserId(userId);
  if (!normalizedUserId) return { ok: false, status: 400, error: "用户名无效" };
  const nextPassword = String(password || "");
  if (nextPassword.length < 4) return { ok: false, status: 400, error: "密码至少 4 位" };

  const users = readAuthUsers();
  const user = users[normalizedUserId];
  if (!user) return { ok: false, status: 404, error: "用户不存在" };
  if (String(user.authProvider || "") === "cas" && !user.isAdmin) {
    return { ok: false, status: 409, error: "CAS 用户不使用 AgentFlow 本地密码" };
  }

  const nextCredential = hashPassword(nextPassword);
  users[normalizedUserId] = {
    ...user,
    salt: nextCredential.salt,
    hash: nextCredential.hash,
    updatedAt: new Date().toISOString(),
  };
  writeJsonObject(usersPath(), users);

  const sessions = readJsonObject(sessionsPath());
  let revokedSessions = 0;
  for (const [sessionKey, session] of Object.entries(sessions)) {
    if (session?.userId !== normalizedUserId) continue;
    delete sessions[sessionKey];
    revokedSessions += 1;
  }
  writeJsonObject(sessionsPath(), sessions);

  return {
    ok: true,
    user: {
      userId: normalizedUserId,
      username: String(user.username || normalizedUserId),
      isAdmin: Boolean(user.isAdmin),
      updatedAt: users[normalizedUserId].updatedAt,
    },
    revokedSessions,
  };
}

export function authSetupRequired() {
  return !Object.values(readAuthUsers()).some((user) => user?.isAdmin === true);
}

function normalizeUserAllowlistInput(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  if (typeof value === "string") {
    return value
      .split(/[\s,;]+/g)
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}

function readUserAllowlistEnvUsers() {
  return normalizeUserAllowlistInput(process.env.AGENTFLOW_USER_WHITELIST || process.env.AGENTFLOW_ALLOWED_USERS || "");
}

function readUserAllowlistFileUsers() {
  let fromFile = [];
  try {
    const p = userAllowlistPath();
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, "utf-8"));
      fromFile = normalizeUserAllowlistInput(Array.isArray(data) ? data : data?.users);
    }
  } catch {
    fromFile = [];
  }
  return fromFile;
}

export function readUserAllowlist() {
  const fromEnv = readUserAllowlistEnvUsers();
  const fromFile = readUserAllowlistFileUsers();
  const users = Array.from(new Set([...fromFile, ...fromEnv].map((item) => String(item || "").trim()).filter(Boolean)));
  return { enabled: users.length > 0, users, fileUsers: fromFile, envUsers: fromEnv, path: userAllowlistPath() };
}

export function writeUserAllowlist(users) {
  const normalized = [];
  const seen = new Set();
  for (const item of normalizeUserAllowlistInput(users)) {
    const user = String(item || "").trim();
    const safe = sanitizeAgentflowUserId(user);
    if (!safe) {
      throw new Error(`invalid username: ${user}`);
    }
    const key = safe.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(user);
  }
  writeJsonObject(userAllowlistPath(), { users: normalized, updatedAt: new Date().toISOString() });
  return readUserAllowlist();
}

function userAllowlistMatchSet(users) {
  const out = new Set();
  for (const user of users) {
    const raw = String(user || "").trim().toLowerCase();
    if (raw) out.add(raw);
    const safe = sanitizeAgentflowUserId(user);
    if (safe) out.add(safe);
  }
  return out;
}

export function isAuthUserAllowed(user) {
  if (user?.isAdmin) return true;
  const allowlist = readUserAllowlist();
  if (!allowlist.enabled) return true;
  const allowed = userAllowlistMatchSet(allowlist.users);
  const candidates = [
    String(user?.userId || "").trim().toLowerCase(),
    String(user?.username || "").trim().toLowerCase(),
    sanitizeAgentflowUserId(user?.userId),
    sanitizeAgentflowUserId(user?.username),
  ].filter(Boolean);
  return candidates.some((candidate) => allowed.has(candidate));
}

function listFlowDirs(root) {
  try {
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) return [];
    return fs.readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => entry.name !== ARCHIVED_PIPELINES_DIR_NAME)
      .filter((entry) => isFlowDir(path.join(root, entry.name)))
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function copyMissingFlowDirs(sourceRoot, targetRoot, relativeRoot = "") {
  const fromRoot = path.join(sourceRoot, relativeRoot);
  const toRoot = path.join(targetRoot, relativeRoot);
  const copied = [];
  const skipped = [];
  for (const name of listFlowDirs(fromRoot)) {
    const fromDir = path.join(fromRoot, name);
    const toDir = path.join(toRoot, name);
    if (fs.existsSync(toDir)) {
      skipped.push(path.join(relativeRoot, name).replace(/\\/g, "/"));
      continue;
    }
    fs.mkdirSync(path.dirname(toDir), { recursive: true });
    fs.cpSync(fromDir, toDir, { recursive: true });
    copied.push(path.join(relativeRoot, name).replace(/\\/g, "/"));
  }
  return { copied, skipped };
}

export function migrateLegacyPipelinesToAdminUser(userId) {
  const safeUserId = sanitizeAgentflowUserId(userId);
  if (!safeUserId) return { copied: [], skipped: [], source: "", target: "", error: "invalid userId" };

  const source = getUserPipelinesRoot("");
  const target = getUserPipelinesRoot(safeUserId);
  if (path.resolve(source) === path.resolve(target)) {
    return { copied: [], skipped: [], source, target };
  }
  if (!fs.existsSync(source)) {
    return { copied: [], skipped: [], source, target };
  }

  const active = copyMissingFlowDirs(source, target);
  const archived = copyMissingFlowDirs(source, target, ARCHIVED_PIPELINES_DIR_NAME);
  return {
    copied: [...active.copied, ...archived.copied],
    skipped: [...active.skipped, ...archived.skipped],
    source,
    target,
  };
}

export function getSessionCookieName() {
  return SESSION_COOKIE;
}

export function buildSessionCookie(token, { secure = false } = {}) {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    secure ? "Secure" : "",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  return attrs.filter(Boolean).join("; ");
}

export function buildClearSessionCookie({ secure = false } = {}) {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax${secure ? "; Secure" : ""}; Max-Age=0`;
}

export function getSessionTokenFromRequest(req) {
  return parseCookies(req.headers.cookie || "")[SESSION_COOKIE] || bearerTokenFromAuthHeader(req.headers.authorization);
}

export function getAuthUserFromRequest(req) {
  const token = getSessionTokenFromRequest(req);
  if (!token) return null;
  const sessions = readJsonObject(sessionsPath());
  const key = hashToken(token);
  const session = sessions[key];
  if (!session || typeof session.userId !== "string") return null;
  if (Number(session.expiresAt) <= Date.now()) {
    delete sessions[key];
    writeJsonObject(sessionsPath(), sessions);
    return null;
  }
  const users = readAuthUsers();
  const user = users[session.userId];
  if (!user) return null;
  return {
    userId: session.userId,
    username: user.username || session.userId,
    isAdmin: Boolean(user.isAdmin),
    authProvider: String(user.authProvider || (user.salt && user.hash ? "password" : "cas")),
    sessionKind: String(session.kind || "web"),
    clientName: String(session.clientName || ""),
    scopes: Array.isArray(session.scopes) ? session.scopes.map(String) : [],
    sessionExpiresAt: Number(session.expiresAt) || 0,
  };
}

export function createCliAuthorization({ publicBaseUrl, clientName } = {}) {
  const now = Date.now();
  const requestId = crypto.randomBytes(18).toString("base64url");
  const deviceCode = crypto.randomBytes(32).toString("base64url");
  const approvalNonce = crypto.randomBytes(24).toString("base64url");
  const authorizations = readJsonObject(cliAuthorizationsPath());
  purgeExpiredCliAuthorizations(authorizations, now);
  const active = Object.entries(authorizations)
    .sort((left, right) => Number(left[1]?.createdAt) - Number(right[1]?.createdAt));
  while (active.length >= 256) {
    const [oldestId] = active.shift();
    delete authorizations[oldestId];
  }
  authorizations[requestId] = {
    deviceCodeHash: hashToken(deviceCode),
    approvalNonceHash: hashToken(approvalNonce),
    approvalNonce,
    userCode: randomUserCode(),
    clientName: normalizedCliClientName(clientName),
    scopes: [...CLI_AUTHORIZATION_SCOPES],
    status: "pending",
    createdAt: now,
    expiresAt: now + CLI_AUTHORIZATION_TTL_MS,
  };
  writeJsonObject(cliAuthorizationsPath(), authorizations);
  const base = String(publicBaseUrl || "").replace(/\/+$/, "");
  return {
    ...cliAuthorizationSummary(requestId, authorizations[requestId]),
    deviceCode,
    approvalNonce,
    verificationUrl: `${base}/cli/authorize?request=${encodeURIComponent(requestId)}`,
    pollInterval: 3,
  };
}

export function getCliAuthorization(requestId, { includeApprovalNonce = false } = {}) {
  const id = String(requestId || "").trim();
  if (!id) return { ok: false, status: 400, error: "缺少授权请求" };
  const authorizations = readJsonObject(cliAuthorizationsPath());
  const changed = purgeExpiredCliAuthorizations(authorizations);
  if (changed) writeJsonObject(cliAuthorizationsPath(), authorizations);
  const record = authorizations[id];
  if (!record) return { ok: false, status: 404, error: "授权请求不存在或已过期" };
  return {
    ok: true,
    authorization: cliAuthorizationSummary(id, record),
    ...(includeApprovalNonce ? { approvalNonce: String(record.approvalNonce || "") } : {}),
  };
}

export function decideCliAuthorization({ requestId, approvalNonce, userId, approved }) {
  const id = String(requestId || "").trim();
  const normalizedUserId = sanitizeAgentflowUserId(userId);
  if (!id || !normalizedUserId) return { ok: false, status: 400, error: "授权请求无效" };
  const authorizations = readJsonObject(cliAuthorizationsPath());
  purgeExpiredCliAuthorizations(authorizations);
  const record = authorizations[id];
  if (!record) {
    writeJsonObject(cliAuthorizationsPath(), authorizations);
    return { ok: false, status: 404, error: "授权请求不存在或已过期" };
  }
  if (record.status !== "pending") {
    return { ok: false, status: 409, error: "授权请求已经处理" };
  }
  const suppliedNonce = String(approvalNonce || "");
  if (!suppliedNonce || hashToken(suppliedNonce) !== String(record.approvalNonceHash || "")) {
    return { ok: false, status: 403, error: "授权确认已失效，请刷新页面" };
  }
  record.status = approved ? "approved" : "denied";
  record.approvedUserId = normalizedUserId;
  record.decidedAt = Date.now();
  authorizations[id] = record;
  writeJsonObject(cliAuthorizationsPath(), authorizations);
  return { ok: true, authorization: cliAuthorizationSummary(id, record) };
}

export function exchangeCliAuthorization(deviceCode) {
  const codeHash = hashToken(String(deviceCode || ""));
  if (!String(deviceCode || "").trim()) return { ok: false, status: 400, error: "缺少 deviceCode" };
  const now = Date.now();
  const authorizations = readJsonObject(cliAuthorizationsPath());
  purgeExpiredCliAuthorizations(authorizations, now);
  const entry = Object.entries(authorizations).find(([, record]) => record?.deviceCodeHash === codeHash);
  if (!entry) {
    writeJsonObject(cliAuthorizationsPath(), authorizations);
    return { ok: false, status: 410, error: "授权请求不存在或已过期", code: "expired_token" };
  }
  const [requestId, record] = entry;
  if (record.status === "pending") {
    if (Number(record.lastPolledAt) > 0 && now - Number(record.lastPolledAt) < 1000) {
      return {
        ok: false,
        status: 429,
        error: "轮询过于频繁",
        code: "slow_down",
        authorization: cliAuthorizationSummary(requestId, record),
      };
    }
    record.lastPolledAt = now;
    authorizations[requestId] = record;
    writeJsonObject(cliAuthorizationsPath(), authorizations);
    return {
      ok: false,
      status: 202,
      error: "等待用户授权",
      code: "authorization_pending",
      authorization: cliAuthorizationSummary(requestId, record),
    };
  }
  if (record.status === "denied") {
    delete authorizations[requestId];
    writeJsonObject(cliAuthorizationsPath(), authorizations);
    return { ok: false, status: 403, error: "用户拒绝了授权", code: "access_denied" };
  }
  if (record.status !== "approved" || !record.approvedUserId) {
    return { ok: false, status: 409, error: "授权状态无效", code: "invalid_grant" };
  }
  const session = createSessionForUser(record.approvedUserId, {
    kind: "cli",
    clientName: record.clientName,
    scopes: record.scopes,
    ttlMs: CLI_SESSION_TTL_MS,
  });
  if (!session.ok) return { ok: false, status: 401, error: session.error || "无法创建 CLI Session" };
  delete authorizations[requestId];
  writeJsonObject(cliAuthorizationsPath(), authorizations);
  return {
    ok: true,
    token: session.token,
    tokenType: "Bearer",
    expiresAt: session.expiresAt,
    user: session.user,
    scopes: Array.isArray(record.scopes) ? record.scopes.map(String) : [],
  };
}

export function revokeSessionToken(token) {
  const raw = String(token || "").trim();
  if (!raw) return false;
  const sessions = readJsonObject(sessionsPath());
  const key = hashToken(raw);
  if (!sessions[key]) return false;
  delete sessions[key];
  writeJsonObject(sessionsPath(), sessions);
  return true;
}

export function loginOrCreateUser(username, password) {
  const userId = sanitizeAgentflowUserId(username);
  if (!userId) {
    return { ok: false, error: "用户名须以字母开头，仅可使用字母、数字、下划线与连字符，最多 64 字符" };
  }
  const pwd = String(password || "");
  if (pwd.length < 4) return { ok: false, error: "密码至少 4 位" };

  const users = readAuthUsers();
  const firstUser = Object.keys(users).length === 0;
  let user = users[userId];
  if (!isAuthUserAllowed({ userId, username: String(username || "").trim(), isAdmin: Boolean(user?.isAdmin) })) {
    return { ok: false, forbidden: true, error: "用户不在白名单中，请联系管理员开通访问权限" };
  }
  if (!user) {
    const hashed = hashPassword(pwd);
    user = {
      userId,
      username: String(username).trim(),
      salt: hashed.salt,
      hash: hashed.hash,
      isAdmin: firstUser,
      authProvider: "password",
      createdAt: new Date().toISOString(),
    };
    users[userId] = user;
    writeJsonObject(usersPath(), users);
  } else if (!verifyPassword(pwd, user)) {
    return { ok: false, error: "用户名或密码错误" };
  }

  let migration = null;
  if (Boolean(user.isAdmin)) {
    try {
      migration = migrateLegacyPipelinesToAdminUser(userId);
    } catch (e) {
      migration = { copied: [], skipped: [], error: (e && e.message) || String(e) };
    }
  }

  const session = createSessionForUser(userId, { kind: "web" });
  return {
    ok: true,
    token: session.token,
    user: {
      userId,
      username: user.username || userId,
      isAdmin: Boolean(user.isAdmin),
      authProvider: String(user.authProvider || "password"),
    },
    migration,
  };
}

export function loginAdminUser(username, password) {
  const userId = sanitizeAgentflowUserId(username);
  if (!userId) return { ok: false, error: "管理员用户名无效" };
  const pwd = String(password || "");
  if (pwd.length < 4) return { ok: false, error: "密码至少 4 位" };

  const users = readAuthUsers();
  const hasAdmin = Object.values(users).some((user) => user?.isAdmin === true);
  let user = users[userId];
  if (!hasAdmin) {
    if (user && !user.isAdmin) return { ok: false, error: "该用户名已属于普通用户，请使用其他管理员用户名" };
    const credential = hashPassword(pwd);
    user = {
      ...(user || {}),
      userId,
      username: String(username || "").trim(),
      salt: credential.salt,
      hash: credential.hash,
      isAdmin: true,
      authProvider: "password",
      createdAt: user?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    users[userId] = user;
    writeJsonObject(usersPath(), users);
  } else if (!user?.isAdmin || !verifyPassword(pwd, user)) {
    return { ok: false, error: "管理员用户名或密码错误" };
  }

  let migration = null;
  try {
    migration = migrateLegacyPipelinesToAdminUser(userId);
  } catch (e) {
    migration = { copied: [], skipped: [], error: (e && e.message) || String(e) };
  }
  const session = createSessionForUser(userId, { kind: "admin-web" });
  return {
    ok: true,
    token: session.token,
    user: { userId, username: user.username || userId, isAdmin: true, authProvider: "password" },
    migration,
  };
}

export function loginCasUser(identity = {}) {
  const casUsername = String(identity?.username || "").trim().toLowerCase();
  const userId = sanitizeAgentflowUserId(casUsername);
  if (!userId) return { ok: false, status: 400, error: "CAS 用户名无法映射为 AgentFlow 用户 ID" };
  const users = readAuthUsers();
  const existing = users[userId];
  if (existing?.isAdmin) {
    return { ok: false, status: 403, error: "管理员账号请从 /admin/login 使用密码登录" };
  }
  const candidate = { userId, username: casUsername, isAdmin: false };
  if (!isAuthUserAllowed(candidate)) {
    return { ok: false, status: 403, forbidden: true, error: "用户不在白名单中，请联系管理员开通访问权限" };
  }
  const attributes = identity?.attributes && typeof identity.attributes === "object" ? identity.attributes : {};
  const displayName = String(attributes.displayName || attributes.name || attributes.cn || casUsername).trim().slice(0, 128) || casUsername;
  const now = new Date().toISOString();
  users[userId] = {
    ...(existing || {}),
    userId,
    username: displayName,
    isAdmin: false,
    authProvider: "cas",
    casUsername,
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  writeJsonObject(usersPath(), users);
  const session = createSessionForUser(userId, { kind: "cas-web", ttlMs: CAS_SESSION_TTL_MS });
  return {
    ok: true,
    token: session.token,
    user: { userId, username: displayName, isAdmin: false, authProvider: "cas", casUsername },
    linkedLegacyAccount: Boolean(existing?.salt && existing?.hash),
  };
}

export function logoutRequest(req) {
  const token = getSessionTokenFromRequest(req);
  revokeSessionToken(token);
}
