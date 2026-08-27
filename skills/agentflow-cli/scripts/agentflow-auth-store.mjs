import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function emptyStore() {
  return { version: 1, profiles: {}, pending: {} };
}

export function agentFlowAuthFile() {
  const configured = String(process.env.AGENTFLOW_AUTH_FILE || "").trim();
  return path.resolve(configured || path.join(os.homedir(), ".agentflow", "auth.json"));
}

export function readAgentFlowAuthStore() {
  const file = agentFlowAuthFile();
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) return emptyStore();
    return {
      version: 1,
      profiles: data.profiles && typeof data.profiles === "object" && !Array.isArray(data.profiles) ? data.profiles : {},
      pending: data.pending && typeof data.pending === "object" && !Array.isArray(data.pending) ? data.pending : {},
    };
  } catch {
    return emptyStore();
  }
}

export function writeAgentFlowAuthStore(store) {
  const file = agentFlowAuthFile();
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(dir, 0o700); } catch {}
  const temp = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  try { fs.chmodSync(temp, 0o600); } catch {}
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
  return file;
}

function profileKey(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "");
}

export function savedAgentFlowProfile(baseUrl) {
  const key = profileKey(baseUrl);
  const profile = readAgentFlowAuthStore().profiles[key];
  if (!profile || typeof profile !== "object") return null;
  if (Number(profile.expiresAt) > 0 && Number(profile.expiresAt) <= Date.now()) return null;
  const token = String(profile.token || "").trim();
  return token ? { ...profile, token } : null;
}

export function savedAgentFlowPendingAuthorization(baseUrl) {
  const key = profileKey(baseUrl);
  const pending = readAgentFlowAuthStore().pending[key];
  if (!pending || typeof pending !== "object") return null;
  if (Number(pending.expiresAt) > 0 && Number(pending.expiresAt) <= Date.now()) return null;
  return { ...pending };
}

export function saveAgentFlowPendingAuthorization(baseUrl, pending) {
  const key = profileKey(baseUrl);
  const store = readAgentFlowAuthStore();
  store.pending[key] = {
    requestId: String(pending.requestId || ""),
    deviceCode: String(pending.deviceCode || ""),
    userCode: String(pending.userCode || ""),
    verificationUrl: String(pending.verificationUrl || ""),
    expiresAt: Number(pending.expiresAt) || 0,
    pollInterval: Number(pending.pollInterval) || 3,
    createdAt: Date.now(),
  };
  writeAgentFlowAuthStore(store);
  return { ...store.pending[key], deviceCode: undefined };
}

export function saveAgentFlowProfile(baseUrl, profile) {
  const key = profileKey(baseUrl);
  const store = readAgentFlowAuthStore();
  store.profiles[key] = {
    token: String(profile.token || ""),
    tokenType: String(profile.tokenType || "Bearer"),
    expiresAt: Number(profile.expiresAt) || 0,
    user: profile.user && typeof profile.user === "object" ? profile.user : null,
    scopes: Array.isArray(profile.scopes) ? profile.scopes.map(String) : [],
    updatedAt: Date.now(),
  };
  delete store.pending[key];
  const file = writeAgentFlowAuthStore(store);
  return { file, profile: { ...store.profiles[key], token: undefined } };
}

export function clearAgentFlowPendingAuthorization(baseUrl) {
  const key = profileKey(baseUrl);
  const store = readAgentFlowAuthStore();
  if (!store.pending[key]) return false;
  delete store.pending[key];
  writeAgentFlowAuthStore(store);
  return true;
}

export function clearAgentFlowProfile(baseUrl) {
  const key = profileKey(baseUrl);
  const store = readAgentFlowAuthStore();
  const existed = Boolean(store.profiles[key] || store.pending[key]);
  delete store.profiles[key];
  delete store.pending[key];
  if (existed) writeAgentFlowAuthStore(store);
  return existed;
}
