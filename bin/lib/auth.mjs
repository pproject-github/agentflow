import crypto from "crypto";
import fs from "fs";
import path from "path";
import {
  ARCHIVED_PIPELINES_DIR_NAME,
  getAgentflowDataRoot,
  getUserPipelinesRoot,
  sanitizeAgentflowUserId,
} from "./paths.mjs";

const SESSION_COOKIE = "af_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

function authRoot() {
  return path.join(getAgentflowDataRoot(), "auth");
}

function usersPath() {
  return path.join(authRoot(), "users.json");
}

function sessionsPath() {
  return path.join(authRoot(), "sessions.json");
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

export function readAuthUsers() {
  return readJsonObject(usersPath());
}

export function authSetupRequired() {
  return Object.keys(readAuthUsers()).length === 0;
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
      .filter((entry) => fs.existsSync(path.join(root, entry.name, "flow.yaml")))
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

export function buildSessionCookie(token) {
  const attrs = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`,
  ];
  return attrs.join("; ");
}

export function buildClearSessionCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}

export function getAuthUserFromRequest(req) {
  const token = parseCookies(req.headers.cookie || "")[SESSION_COOKIE];
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
  };
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

  const token = crypto.randomBytes(32).toString("base64url");
  const sessions = readJsonObject(sessionsPath());
  sessions[hashToken(token)] = {
    userId,
    createdAt: Date.now(),
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  writeJsonObject(sessionsPath(), sessions);
  return {
    ok: true,
    token,
    user: { userId, username: user.username || userId, isAdmin: Boolean(user.isAdmin) },
    migration,
  };
}

export function logoutRequest(req) {
  const token = parseCookies(req.headers.cookie || "")[SESSION_COOKIE];
  if (!token) return;
  const sessions = readJsonObject(sessionsPath());
  delete sessions[hashToken(token)];
  writeJsonObject(sessionsPath(), sessions);
}
