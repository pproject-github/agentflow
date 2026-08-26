import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function emptyStore() {
  return { version: 1, profiles: {}, pending: {} };
}

export function authFile() {
  const configured = String(process.env.AGENTFLOW_AUTH_FILE || "").trim();
  return path.resolve(configured || path.join(os.homedir(), ".agentflow", "auth.json"));
}

export function readStore() {
  try {
    const data = JSON.parse(fs.readFileSync(authFile(), "utf8"));
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

function writeStore(store) {
  const file = authFile();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temporary, file);
  try { fs.chmodSync(file, 0o600); } catch {}
  return file;
}

function key(baseUrl) {
  return String(baseUrl || "").replace(/\/+$/, "");
}

export function savedProfile(baseUrl) {
  const profile = readStore().profiles[key(baseUrl)];
  if (!profile || typeof profile !== "object") return null;
  if (Number(profile.expiresAt) > 0 && Number(profile.expiresAt) <= Date.now()) return null;
  return String(profile.token || "").trim() ? profile : null;
}

export function savedPending(baseUrl) {
  const pending = readStore().pending[key(baseUrl)];
  if (!pending || typeof pending !== "object") return null;
  if (Number(pending.expiresAt) > 0 && Number(pending.expiresAt) <= Date.now()) return null;
  return pending;
}

export function savePending(baseUrl, input) {
  const store = readStore();
  store.pending[key(baseUrl)] = {
    requestId: String(input.requestId || ""),
    deviceCode: String(input.deviceCode || ""),
    userCode: String(input.userCode || ""),
    verificationUrl: String(input.verificationUrl || ""),
    expiresAt: Number(input.expiresAt) || 0,
    pollInterval: Number(input.pollInterval) || 3,
    createdAt: Date.now(),
  };
  writeStore(store);
  return { ...store.pending[key(baseUrl)], deviceCode: undefined };
}

export function saveProfile(baseUrl, input) {
  const store = readStore();
  store.profiles[key(baseUrl)] = {
    token: String(input.token || ""),
    tokenType: String(input.tokenType || "Bearer"),
    expiresAt: Number(input.expiresAt) || 0,
    user: input.user && typeof input.user === "object" ? input.user : null,
    scopes: Array.isArray(input.scopes) ? input.scopes.map(String) : [],
    updatedAt: Date.now(),
  };
  delete store.pending[key(baseUrl)];
  const file = writeStore(store);
  return { file, profile: { ...store.profiles[key(baseUrl)], token: undefined } };
}

export function clearPending(baseUrl) {
  const store = readStore();
  if (!store.pending[key(baseUrl)]) return false;
  delete store.pending[key(baseUrl)];
  writeStore(store);
  return true;
}

export function clearProfile(baseUrl) {
  const store = readStore();
  const existed = Boolean(store.profiles[key(baseUrl)] || store.pending[key(baseUrl)]);
  delete store.profiles[key(baseUrl)];
  delete store.pending[key(baseUrl)];
  if (existed) writeStore(store);
  return existed;
}
