import fs from "fs";
import os from "os";
import path from "path";

import { getAgentflowDataRoot, getAgentflowUserEnvAbs, sanitizeAgentflowUserId } from "./paths.mjs";
import { readWecomBinding } from "./wecom-directory.mjs";

function normalizeEnvKey(key) {
  return String(key || "").trim();
}

function isValidEnvKey(key) {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key);
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

function getFromConfig(config, keyStr) {
  if (!config || typeof config !== "object" || !keyStr) return undefined;
  const parts = String(keyStr).trim().split(".");
  let cur = config;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur != null ? String(cur) : undefined;
}

export function normalizeUserEnvRows(rawRows) {
  const rows = Array.isArray(rawRows) ? rawRows : [];
  const byKey = new Map();
  for (const item of rows) {
    if (!item || typeof item !== "object") continue;
    const key = normalizeEnvKey(item.key);
    if (!key || !isValidEnvKey(key)) continue;
    byKey.set(key, String(item.value ?? ""));
  }
  return Array.from(byKey.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({ key, value }));
}

export function readUserEnvRows(userId) {
  const data = readJsonObject(getAgentflowUserEnvAbs(userId));
  return normalizeUserEnvRows(Array.isArray(data.env) ? data.env : []);
}

export function readUserEnvObject(userId) {
  const out = {};
  for (const row of readUserEnvRows(userId)) {
    out[row.key] = row.value;
  }
  return out;
}

function getGlobalEnvAbs() {
  return path.join(getAgentflowDataRoot(), "admin", "env.json");
}

export function readGlobalEnvRows() {
  const data = readJsonObject(getGlobalEnvAbs());
  return normalizeUserEnvRows(Array.isArray(data.env) ? data.env : []);
}

export function readGlobalEnvObject() {
  const out = {};
  for (const row of readGlobalEnvRows()) {
    out[row.key] = row.value;
  }
  return out;
}

export function writeGlobalEnvRows(rows) {
  const normalized = normalizeUserEnvRows(rows);
  const filePath = getGlobalEnvAbs();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, env: normalized }, null, 2) + "\n", "utf-8");
  return normalized;
}

export function readMergedEnvObject(userId) {
  return { ...readGlobalEnvObject(), ...readUserEnvObject(userId) };
}

export function writeUserEnvRows(userId, rows) {
  const normalized = normalizeUserEnvRows(rows);
  const safeUserId = sanitizeAgentflowUserId(userId);
  const filePath = getAgentflowUserEnvAbs(safeUserId);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ version: 1, env: normalized }, null, 2) + "\n", "utf-8");
  return normalized;
}

export function resolveUserEnvValue(key, userId) {
  const keyStr = normalizeEnvKey(key);
  if (!keyStr) return "";
  const userEnv = readUserEnvObject(userId);
  if (Object.prototype.hasOwnProperty.call(userEnv, keyStr)) return String(userEnv[keyStr] ?? "");
  const globalEnv = readGlobalEnvObject();
  if (Object.prototype.hasOwnProperty.call(globalEnv, keyStr)) return String(globalEnv[keyStr] ?? "");
  const processValue = process.env[keyStr];
  if (processValue != null && processValue !== "") return String(processValue);
  const configPath = path.join(os.homedir(), ".cursor", "config.json");
  const fromConfig = getFromConfig(readJsonObject(configPath), keyStr);
  return fromConfig !== undefined ? fromConfig : "";
}

/**
 * 子进程环境：进程自身的 env + 该用户配置的 env + 调用方补的 extra。
 *
 * `AGENTFLOW_USER_ID` 放最后，防止用户在自己的 env 里把它改成别人。
 *
 * `WECOM_TO_USER` 放在用户 env **之前**：平台把「你的企微是谁」当默认值给出去，
 * 流程不用再各自去查（以前每条流程都得自己拼一遍，或者手填一个填错的名字）；
 * 但要发给别人时，用户自己配的那份仍然盖得住这个默认值。
 * @param {{ userId?: string }} [userCtx]
 * @param {Record<string, string>} [extra]
 */
export function runtimeEnvForUser(userCtx = {}, extra = {}) {
  const binding = readWecomBinding(userCtx.userId);
  return {
    ...process.env,
    ...(binding?.wecomUserId
      ? { WECOM_TO_USER: binding.wecomUserId, AGENTFLOW_WECOM_USER_ID: binding.wecomUserId }
      : {}),
    ...readMergedEnvObject(userCtx.userId),
    ...extra,
    AGENTFLOW_USER_ID: userCtx.userId || "",
  };
}
